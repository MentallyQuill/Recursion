import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
const root = resolve('.');
const output = resolve('artifacts/quiet-recovery');
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles/recursion.css"><style>body{margin:12px;background:#202020;color:#d8d8d8;font:14px Arial;--SmartThemeBodyColor:#d8d8d8;--SmartThemeBlurTintColor:#202020;--SmartThemeBorderColor:#444}#mount{margin-top:100px}</style><main id="mount"></main>');
      return;
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', extname(path) === '.css' ? 'text/css' : 'text/javascript');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1180, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const { mountRecursionUi } = await import('/src/ui.mjs');
      window.execution = {
        operationId: 'quiet-recovery-browser', state: 'running',
        pipelineDecision: { requestedMode: 'fused', effectiveMode: 'fused', selectedLane: 'utility' },
        recoveryBudget: { recoveryUsed: 1, recoveryLimit: 9 },
        stageRecords: {
          fused: { stageId: 'preprocess.cards.fused', state: 'completed', summary: {
            acceptedFamilies: ['Knowledge'], unresolvedFamilies: ['Character Motivation'],
            rejections: [{ family: 'Character Motivation', code: 'hidden-content' }], fallback: 'segmented'
          } },
          repair: { stageId: 'preprocess.cards.segmented.character-motivation', state: 'completed', summary: { family: 'Character Motivation' } },
          guidance: { stageId: 'preprocess.guidance', state: 'running' }
        }
      };
      window.ui = mountRecursionUi({ runtime: { view: () => ({ settings: { enabled: true, pipelineMode: 'fused' }, execution: window.execution }) }, mountPoint: document.querySelector('#mount') });
    });
    await page.locator('[data-recursion-status-trigger]').click();
    const panel = page.locator('[data-recursion-status-popover]:visible').first();
    await panel.waitFor();
    const text = await panel.innerText();
    assert(!/recovered|original rejection|hidden-content|Recovery 1\/9/i.test(text), text);
    const child = panel.locator('[data-recursion-progress-step-id="preprocess.cards.fused.character-motivation"]');
    assert.equal(await child.locator('[data-recursion-progress-meta]').innerText(), 'done');
    assert(!(await child.getAttribute('title')).includes('rejection'));
    const bounds = await panel.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'panel fits viewport');
    await page.screenshot({ path: resolve(output, `successful-${width}.png`), fullPage: true, animations: 'disabled' });
    await page.evaluate(() => {
      window.execution.state = 'paused';
      window.execution.pauseReason = 'stage-failed:preprocess.cards.segmented.character-motivation';
      window.execution.stageRecords.repair.state = 'failed';
      window.execution.stageRecords.repair.failurePolicy = 'blocking';
      window.execution.stageRecords.repair.failure = { code: 'RECURSION_PROVIDER_TIMEOUT', message: 'The model connection timed out.', suggestedAction: 'Try again.' };
      window.execution.stageRecords.guidance.state = 'pending';
      window.ui.update();
    });
    assert.match(await panel.innerText(), /failed/);
    assert.match(await child.innerText(), /hidden-content/);
    assert.equal(await panel.locator('[data-recursion-progress-step-id="preprocess.cards.segmented.character-motivation"] button[aria-label="Retry this step"]').count(), 1);
    assert.deepEqual(errors, []);
    console.log(`[pass] quiet recovery and actionable failure at ${width}px`);
    await page.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
