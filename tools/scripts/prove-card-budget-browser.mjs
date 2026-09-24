import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Isolated browser proof: real runtime and UI, deterministic provider, no live host.
const root = resolve('.');
const output = resolve('artifacts/card-budget-browser');
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles/recursion.css"><style>body{margin:16px;background:#191b1f;color:#ddd;font:14px Arial;--SmartThemeBodyColor:#ddd;--SmartThemeBlurTintColor:#23262b;--SmartThemeBorderColor:#444}#mount{width:100%;margin-top:50px}</style><main id="mount"></main>');
      return;
    }
    const file = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', ['.mjs', '.js'].includes(extname(file)) ? 'text/javascript' : extname(file) === '.css' ? 'text/css' : 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1280, 390]) for (const pipelineMode of ['segmented', 'fused']) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    const data = await page.evaluate(async pipelineMode => {
      const { runCardBudgetFixture } = await import('/tests/helpers/card-budget-fixture.mjs');
      const { mountRecursionUi } = await import('/src/ui.mjs');
      const fixture = await runCardBudgetFixture({ pipelineMode });
      window.fixture = fixture;
      window.ui = mountRecursionUi({ runtime: fixture.runtime, mountPoint: document.querySelector('#mount') });
      const saved = await fixture.storage.loadPipelineRun('budget');
      sessionStorage.setItem('restored', JSON.stringify({ ...fixture.view, execution: saved }));
      return { ok: fixture.result.ok, ids: fixture.view.lastHand.cards.map(card => card.id), count: fixture.view.lastHand.cards.length };
    }, pipelineMode);
    assert.equal(data.ok, true);
    assert.equal(data.count, 10);
    await page.locator('[data-recursion-status-trigger]').click();
    const panel = page.locator('[data-recursion-status-popover]:visible, [data-recursion-mobile-status-drawer]:visible').first();
    await panel.waitFor();
    const hand = panel.locator('[data-recursion-progress-step-id="preprocess.hand"]');
    assert.match(await hand.innerText(), /10 cards included.*3 authored.*7 generated/s);
    const group = panel.locator(`[data-recursion-progress-parent-step="preprocess.cards.${pipelineMode}"]`);
    assert.equal(await group.locator('[data-recursion-progress-step-id]').count(), 7);
    const box = await panel.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width + 1, 'progress panel fits viewport');
    await page.screenshot({ path: resolve(output, `${pipelineMode}-${width}.png`), fullPage: true, animations: 'disabled' });
    await page.reload();
    await page.evaluate(async () => {
      const { mountRecursionUi } = await import('/src/ui.mjs');
      const restored = JSON.parse(sessionStorage.getItem('restored'));
      // Stale restored manifests deliberately have no executable in-memory graph.
      restored.execution.state = 'stale';
      window.ui = mountRecursionUi({ runtime: { view: () => restored }, mountPoint: document.querySelector('#mount') });
    });
    await page.locator('[data-recursion-status-trigger]').click();
    const restoredPanel = page.locator('[data-recursion-status-popover]:visible, [data-recursion-mobile-status-drawer]:visible').first();
    assert.match(await restoredPanel.locator('[data-recursion-progress-step-id="preprocess.hand"]').innerText(), /10 cards included/);
    assert.equal(await restoredPanel.locator(`[data-recursion-progress-parent-step="preprocess.cards.${pipelineMode}"] [data-recursion-progress-step-id]`).count(), 7);
    await page.reload();
    await page.evaluate(async pipelineMode => {
      const { runCardBudgetFixture } = await import('/tests/helpers/card-budget-fixture.mjs');
      const { mountRecursionUi } = await import('/src/ui.mjs');
      const fixture = await runCardBudgetFixture({ pipelineMode, allowedFamilies: ['Knowledge'], authoredCount: 1 });
      window.ui = mountRecursionUi({ runtime: fixture.runtime, mountPoint: document.querySelector('#mount') });
    }, pipelineMode);
    await page.locator('[data-recursion-status-trigger]').click();
    const shortfallPanel = page.locator('[data-recursion-status-popover]:visible, [data-recursion-mobile-status-drawer]:visible').first();
    assert.match(await shortfallPanel.locator('[data-recursion-progress-step-id="preprocess.hand"]').innerText(), /2 cards included.*8 below target: not enough eligible cards/s);
    assert.deepEqual(errors, []);
    results.push({ pipelineMode, width, ...data, restoredRows: 7, visibleShortfall: true });
    await page.close();
  }
  assert.deepEqual(results[0].ids, results[1].ids, 'browser workflows deliver identical identities');
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ classification: 'isolated-runtime-ui-deterministic-provider', results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, output }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
