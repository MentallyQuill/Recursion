import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { recoveredFusedExecution } from './test-fused-progress.mjs';

// Isolated browser fixture: real UI and styles, no SillyTavern or provider traffic.
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, 'artifacts/fused-recovery-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'recursion.test') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><link rel="stylesheet" href="/styles/recursion.css"><style>body{background:#202020;color:#d8d8d8;font:13px Arial;margin:32px}#mount{max-width:900px}</style></head><body><div id="mount"></div></body></html>` });
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return route.abort();
    try { await route.fulfill({ contentType: extname(path) === '.css' ? 'text/css' : 'text/javascript', body: await readFile(path) }); }
    catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://recursion.test/');
  await page.evaluate(async (execution) => {
    const { mountRecursionUi } = await import('/src/ui.mjs');
    const { DEFAULT_RECURSION_SETTINGS } = await import('/src/settings.mjs');
    window.fixtureView = { settings: { ...DEFAULT_RECURSION_SETTINGS, enabled: true, pipelineMode: 'fused' }, execution };
    window.fixtureUi = mountRecursionUi({ runtime: { view: () => window.fixtureView }, mountPoint: document.querySelector('#mount') });
  }, recoveredFusedExecution('running'));
  await page.locator('[data-recursion-status-trigger]').click();
  const child = page.locator('[data-recursion-progress-step-id="preprocess.cards.fused.character-motivation"]');
  assert.equal(await child.getAttribute('data-recursion-progress-state'), 'running');
  assert.equal(await child.locator('[data-recursion-progress-meta]').textContent(), 'repairing');
  await page.screenshot({ path: resolve(output, 'repairing.png') });
  for (const graph of [true, false]) {
    await page.evaluate((execution) => { window.fixtureView.execution = execution; window.fixtureUi.update(); }, recoveredFusedExecution('completed', { graph }));
    assert.equal(await child.getAttribute('data-recursion-progress-state'), 'done');
    assert.equal(await child.locator('[data-recursion-progress-meta]').textContent(), 'recovered');
    const reason = child.locator('[data-recursion-progress-reason]');
    assert.ok((await reason.textContent()).includes('private-claim'), 'original rejection visible in recovered child details');
    assert.ok(await reason.isVisible(), 'recovery explanation remains inspectable without hover');
    const bundle = page.locator('[data-recursion-progress-step-id="preprocess.cards.fused"]').first();
    assert.equal(await bundle.getAttribute('data-recursion-progress-state'), 'done');
    await page.screenshot({ path: resolve(output, graph ? 'recovered.png' : 'recovered-reloaded.png') });
  }
  assert.deepEqual(errors, []);
  console.log(`[pass] rendered Fused recovery and reload; screenshots: ${output}`);
} finally { await browser.close(); }
