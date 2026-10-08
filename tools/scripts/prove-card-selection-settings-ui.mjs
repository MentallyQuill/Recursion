import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

// Production settings UI served locally; no running SillyTavern host is contacted.
const root = process.cwd();
const output = resolve(root, 'artifacts/card-selection-settings');
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles/recursion.css"><style>
:root { --mainFontFamily: Arial, sans-serif; --SmartThemeBodyColor: #d8d8d8; --SmartThemeBlurTintColor: #202020; --SmartThemeBorderColor: #555; }
body { margin: 0; background: #181818; color: #d8d8d8; font-family: Arial, sans-serif; }
main { max-width: 960px; margin: 40px auto; }
</style></head><body><main id="mount"></main><script type="module">
import { mountRecursionUi } from '/src/ui.mjs';
import { createSettingsStore } from '/src/settings.mjs';
import { resolveProviderCapability } from '/src/provider-capability.mjs';
const saved = JSON.parse(localStorage.getItem('selection-proof') || '{}');
const store = createSettingsStore({ root: saved, save() { localStorage.setItem('selection-proof', JSON.stringify(saved)); } });
window.proofStore = store;
window.proofState = {};
const capability = (lane, operation = 'prompt-packet') => resolveProviderCapability({ settings: store.get(), lane, operation, host: { connectionProfiles: [] } });
window.proofUi = mountRecursionUi({ mountPoint: document.querySelector('#mount'), runtime: {
view: () => ({ settings: { ...store.get(), providerCapabilities: { utility: { promptPacket: capability('utility') }, reasoner: { promptPacket: capability('reasoner') } } }, activity: { phase: 'idle' }, ...window.proofState }),
providerCapability: capability,
updateSettings: patch => store.update(patch),
updateProviderConfig: (lane, patch, options) => store.updateProviderConfig(lane, patch, options),
listProviderConnectionProfiles: () => [],
resumeOperation:async()=>({ok:true})
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
    const target = page.locator('[data-recursion-setting-cards-per-turn]');
    assert.equal(await target.inputValue(), '6');
    assert.equal(await target.getAttribute('min'), '0');
    assert.equal(await target.getAttribute('max'), '20');
    assert.equal(await page.locator('[data-recursion-setting-min-cards], [data-recursion-setting-max-cards]').count(), 0);
    await target.fill('0');
    await target.press('Tab');
    await page.waitForFunction(() => window.proofStore.get().cardsPerTurn === 0);
    await target.fill('9');
    await target.press('Tab');
    await page.waitForFunction(() => window.proofStore.get().cardsPerTurn === 9);
    await page.locator('[data-recursion-reasoning-level-ultra]').click();
    if (!(await page.locator('[data-recursion-settings-panel]').isVisible())) await page.locator('[data-recursion-actions]').click();
    assert.equal(await target.inputValue(), '9');
    assert.equal(await page.locator('[data-recursion-card-cost-help]').innerText(),
      'More cards can enlarge model requests and add individual repairs. Required cards may exceed this target.');
    assert.equal(await page.locator('[data-recursion-routing-cost-help]').innerText(),
      'Always routes eligible work through the Reasoner. Auto follows the selected reasoning level and provider checks.');
    await page.waitForFunction(() => document.querySelector('[data-recursion-card-target-summary]').textContent.includes('Target: 9 cards per turn.'));
    assert((await page.locator('[data-recursion-settings-play]').innerText()).includes('Mandatory cards can exceed the target'));
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
    assert.equal(await target.inputValue(), '9');
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector('[data-recursion-settings-panel]');
      const controls = [...panel.querySelectorAll('[data-recursion-setting-cards-per-turn], [data-recursion-setting-selection-variety], [data-recursion-setting-card-cooldown]')];
      return { width: innerWidth, panel: panel.getBoundingClientRect().toJSON(), controls: controls.map(c => ({ label: c.getAttribute('aria-label'), rect: c.getBoundingClientRect().toJSON() })), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(geometry.overflow, false, `${viewport.name}: page horizontal overflow`);
    for (const control of geometry.controls) {
      assert(control.rect.x >= 0 && control.rect.right <= geometry.width, `${viewport.name}: ${control.label} outside viewport`);
      assert(control.rect.width >= 80 && control.rect.height >= 24, `${viewport.name}: usable input geometry`);
    }
    await page.screenshot({ path: resolve(output, `${viewport.name}.png`), fullPage: true });
    await page.locator('[data-recursion-settings-tab-providers]').click();
    const tuning = page.locator('[data-recursion-settings-section-body-compatibility-utility]');
    assert.equal(await tuning.isVisible(), false);
    assert((await page.locator('[data-recursion-provider-checks-utility]').innerText()).includes('Single cards: Not checked'));
    assert((await page.locator('[data-recursion-provider-checks-utility]').innerText()).includes('Combined cards: Not checked'));
    const tuningToggle = page.locator('[data-recursion-settings-section-toggle-compatibility-utility]');
    await tuningToggle.focus();
    await tuningToggle.press('Space');
    assert.equal(await tuning.isVisible(), true);
    await page.locator('[data-recursion-provider-sampler-mode-utility]').selectOption('recursion');
    const draft=page.locator('[data-recursion-provider-temperature-utility]');
    await draft.fill('0.37'); // Leave this value uncommitted during status updates.
    await page.evaluate(()=>{
      window.proofState={providerOperations:{queues:{utility:{available:true,active:0,pending:1,concurrency:1,cooldownRemainingMs:1001}}}};
      window.proofUi.update();
    });
    assert.equal(await page.locator('[data-recursion-provider-queue-utility]').innerText(),'Waiting for provider · retry in 2s');
    await page.evaluate(()=>{window.proofState.providerOperations.queues.utility.cooldownRemainingMs=500;window.proofUi.update();});
    assert.equal(await page.locator('[data-recursion-provider-queue-utility]').innerText(),'Waiting for provider · retry in 1s');
    assert.equal(await draft.inputValue(),'0.37');
    assert.equal(await tuning.isVisible(),true);
    await draft.press('Tab');
    await page.waitForFunction(()=>window.proofStore.get().providers.utility.samplerOverrides.temperature === 0.37);
    await page.locator('[data-recursion-provider-output-token-ceiling-utility]').fill('4096');
    await page.locator('[data-recursion-provider-output-token-ceiling-utility]').press('Tab');
    await page.waitForFunction(() => window.proofStore.get().providers.utility.outputTokenCeiling === 4096);
    assert.equal(await tuning.isVisible(), true);
    await page.locator('[data-recursion-settings-tab-advanced]').click();
    const injection = page.locator('[data-recursion-settings-section-body-injection]');
    await page.locator('[data-recursion-settings-section-toggle-injection]').click();
    assert.equal(await injection.isVisible(), false);
    await page.locator('[data-recursion-settings-tab-play]').click();
    await page.locator('[data-recursion-settings-tab-advanced]').click();
    assert.equal(await injection.isVisible(), false);
    if (!(await page.locator('[data-recursion-settings-section-body-execution]').isVisible())) await page.locator('[data-recursion-settings-section-toggle-execution]').click();
    const executionText = await page.locator('[data-recursion-settings-section-execution]').innerText();
    assert(executionText.includes('The first call counts toward Attempts per step.'));
    assert(executionText.includes('Capacity retries are separately bounded'));
    assert(executionText.includes('Resume keeps the current budget'));
    await page.locator('[data-recursion-setting-tooltips-enabled]').uncheck();
    await page.waitForFunction(() => window.proofStore.get().ui.tooltipsEnabled === false);
    assert((await page.locator('[data-recursion-settings-section-execution]').innerText()).includes('Retry or Reprocess opens a new window'));
    assert.equal(await page.locator('[data-recursion-recovery-cost-help]').innerText(),
      'Corrections and capacity retries add calls within the displayed recovery allowance.');
    await page.screenshot({ path: resolve(output, `${viewport.name}-advanced.png`), fullPage: true });
    await page.locator('[data-recursion-settings-tab-providers]').click();
    assert.equal(await tuning.isVisible(), true);
    await page.screenshot({ path: resolve(output, `${viewport.name}-providers.png`), fullPage: true });
    await page.locator('[data-recursion-settings-tab-play]').click();
    assert((await page.locator('[data-recursion-settings-play]').innerText()).includes('Required cards may exceed this target.'));
    await page.screenshot({path:resolve(output,`${viewport.name}-tooltips-off.png`),fullPage:true});
    await page.evaluate(()=>{
      window.proofState.execution={operationId:'synthetic-interrupted',phase:'preprocess',state:'paused',pauseReason:'restored-after-reload',
        pipelineMode:'segmented',recoveryBudget:{recoveryLimit:3,recoveryUsed:2},frontierStageIds:['preprocess.guidance'],
        stageRecords:{'preprocess.guidance':{stageId:'preprocess.guidance',state:'pending',kind:'model',executable:true,
          label:'Guidance',attempts:{total:1},failure:null}}};
      window.proofUi.update();
    });
    await page.locator('[data-recursion-status-trigger]').click();
    assert.equal(await page.locator('[data-recursion-progress-title]').innerText(),'Interrupted');
    assert.equal(await page.locator('[data-recursion-progress-subtitle]').innerText(),'Resume available');
    assert.equal(await page.locator('[data-recursion-progress-recovery]').innerText(),'Recovery allowance · 1 of 3 additional calls remaining');
    const resume=page.locator('[aria-label="Resume from saved checkpoint"]');
    await resume.focus();
    assert(await resume.evaluate(node=>node === document.activeElement),'Resume is keyboard reachable');
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-recursion-progress-row]')]
      .every(node=>Number(getComputedStyle(node).opacity)>=0.98));
    const progressGeometry=await page.locator('[data-recursion-status-popover]').evaluate(node=>({width:node.clientWidth,scrollWidth:node.scrollWidth}));
    assert(progressGeometry.scrollWidth<=progressGeometry.width,`${viewport.name}: progress horizontal overflow`);
    await page.screenshot({path:resolve(output,`${viewport.name}-interrupted.png`),fullPage:true});
    assert.deepEqual(errors, []);
    reports.push({ viewport, geometry, progressGeometry, persisted: { cardsPerTurn: 9, variety: 'medium', cooldownTurns: 2 },
      disclosures: 'keyboard, autosave and tab changes preserved',unsavedDraftPreserved:true,queueCountdown:true,interruptedResume:true,tooltipsOffHelp: true });
    await context.close();
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ classification: 'isolated-production-ui-fixture', reports }, null, 2));
  console.log('[pass] settings: desktop/narrow target persistence, routing, disclosures, keyboard and visible help');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
