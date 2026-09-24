import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Production UI and styles in an isolated fixture; no live host or provider work.
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, 'artifacts/rate-limit-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 760 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'recursion.test') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/styles/recursion.css"><style>body{background:#202020;color:#d8d8d8;font:13px Arial;margin:32px}#mount{max-width:900px}</style></head><body><div id="mount"></div></body></html>' });
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return route.abort();
    try { await route.fulfill({ contentType: extname(path) === '.css' ? 'text/css' : 'text/javascript', body: await readFile(path) }); }
    catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://recursion.test/');
  await page.evaluate(async () => {
    const { mountRecursionUi } = await import('/src/ui.mjs');
    const { DEFAULT_RECURSION_SETTINGS } = await import('/src/settings.mjs');
    window.fixtureView = { settings: { ...DEFAULT_RECURSION_SETTINGS, enabled: true, pipelineMode: 'fused' },
      execution: { operationId: 'rate-limited', state: 'paused', stageRecords: {
        fused: { stageId: 'preprocess.cards.fused', state: 'failed',
          failure: { code: 'RECURSION_PROVIDER_RATE_LIMIT', failureClass: 'capacity', retryable: true,
            message: 'The selected profile is rate limited.' },
          outcomeChildren: [{ id: 'preprocess.cards.fused.realism', family: 'Realism' }] }
      } } };
    window.fixtureUi = mountRecursionUi({ runtime: { view: () => window.fixtureView }, mountPoint: document.querySelector('#mount') });
  });
  await page.locator('[data-recursion-status-trigger]').click();
  const bundle = page.locator('[data-recursion-progress-step-id="preprocess.cards.fused"]').first();
  assert.match(await bundle.textContent(), /rate limited/i);
  assert.ok(!(await bundle.textContent()).includes('invalid-card'));
  assert.equal(await bundle.getAttribute('data-recursion-progress-state'), 'failed');
  await page.screenshot({ path: resolve(output, 'rate-limited.png'), animations: 'disabled' });
  await page.evaluate(() => {
    window.fixtureView.execution.state = 'running';
    window.fixtureView.execution.stageRecords.fused.state = 'running';
    window.fixtureView.execution.stageRecords.fused.lastAttemptAction = 'retry-same';
    window.fixtureUi.update();
  });
  assert.equal(await bundle.getAttribute('data-recursion-progress-state'), 'running');
  assert.ok(!(await bundle.textContent()).includes('invalid-card'));
  await page.screenshot({ path: resolve(output, 'retrying.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log(`[pass] rendered provider failure and retrying states; screenshots: ${output}`);
} finally { await browser.close(); }
