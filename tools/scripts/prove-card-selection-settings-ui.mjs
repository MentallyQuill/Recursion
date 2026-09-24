import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Production settings UI served locally; no running SillyTavern host is contacted.
const root = process.cwd();
const output = resolve(root, 'artifacts/card-selection-settings');
const fixture = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/recursion.css"><style>
:root { --mainFontFamily: Arial, sans-serif; --SmartThemeBodyColor: #d8d8d8; --SmartThemeBlurTintColor: #202020; --SmartThemeBorderColor: #555; }
body { margin: 0; background: #181818; color: #d8d8d8; font-family: Arial, sans-serif; }
main { max-width: 960px; margin: 40px auto; }
</style></head><body><main id="mount"></main><script type="module">
import { mountRecursionUi } from '/src/ui.mjs';
import { createSettingsStore } from '/src/settings.mjs';
const saved = JSON.parse(localStorage.getItem('selection-proof') || '{}');
const store = createSettingsStore({ root: saved, save() { localStorage.setItem('selection-proof', JSON.stringify(saved)); } });
window.proofStore = store;
window.proofUi = mountRecursionUi({ mountPoint: document.querySelector('#mount'), runtime: {
view: () => ({ settings: store.get(), activity: { phase: 'idle' } }),
updateSettings: patch => store.update(patch),
listProviderConnectionProfiles: () => []
} });
window.proofReady = true;
</script></body></html>`;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(fixture);
      return;
    }
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    const body = await readFile(path);
    response.writeHead(200, { 'Content-Type': extname(path) === '.css' ? 'text/css' : 'text/javascript' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const reports = [];
try {
  for (const viewport of [{ name: 'desktop', width: 1360, height: 820 }, { name: 'narrow', width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.proofReady);
    await page.locator('[data-recursion-actions]').click();
    const variety = page.locator('[data-recursion-setting-selection-variety]');
    const cooldown = page.locator('[data-recursion-setting-card-cooldown]');
    assert.equal(await variety.inputValue(), 'low');
    assert.equal(await cooldown.inputValue(), '0');
    await variety.selectOption('medium');
    await cooldown.fill('2');
    await cooldown.press('Tab');
    await page.waitForFunction(() => window.proofStore.get().cardSelection.cooldownTurns === 2);
    assert.deepEqual(await page.evaluate(() => window.proofStore.get().cardSelection), { variety: 'medium', cooldownTurns: 2 });
    await page.reload();
    await page.waitForFunction(() => window.proofReady);
    await page.locator('[data-recursion-actions]').click();
    assert.equal(await variety.inputValue(), 'medium');
    assert.equal(await cooldown.inputValue(), '2');
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector('[data-recursion-settings-panel]');
      const controls = [...panel.querySelectorAll('[data-recursion-setting-selection-variety], [data-recursion-setting-card-cooldown]')];
      return { width: innerWidth, panel: panel.getBoundingClientRect().toJSON(), controls: controls.map(c => ({ label: c.getAttribute('aria-label'), rect: c.getBoundingClientRect().toJSON() })), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(geometry.overflow, false, `${viewport.name}: page horizontal overflow`);
    for (const control of geometry.controls) {
      assert(control.rect.x >= 0 && control.rect.right <= geometry.width, `${viewport.name}: ${control.label} outside viewport`);
      assert(control.rect.width >= 80 && control.rect.height >= 24, `${viewport.name}: usable input geometry`);
    }
    await page.screenshot({ path: resolve(output, `${viewport.name}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    reports.push({ viewport, geometry, persisted: { variety: 'medium', cooldownTurns: 2 } });
    await context.close();
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ classification: 'isolated-production-ui-fixture', reports }, null, 2));
  console.log('[pass] card selection settings: desktop/narrow layout, interaction and reload persistence');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
