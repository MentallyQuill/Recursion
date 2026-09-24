import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, 'artifacts/post-process-writer-review');
await mkdir(output, { recursive: true });
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles/recursion.css"><style>body{margin:12px;background:#202020;color:#d8d8d8;font:14px sans-serif}#chat{height:200px;overflow:auto}#chat p{height:60px}#mount{position:fixed;top:240px;left:12px;right:12px;max-width:950px}</style></head><body><div id="chat"><p>Isolated review fixture.</p><p>Quiet rain moved over the road.</p><p>The door stayed closed.</p><p>A lamp burned inside.</p></div><button id="source">Review this message</button><div id="mount"></div><script type="module">
import { mountRecursionUi } from '/src/ui.mjs';
import { normalizeSettings } from '/src/settings.mjs';
const initial = {id:'revision-1',originalSnapshot:{originalDraft:'The rain came down.\\n\\n<img src=x onerror=alert(1)> The door stayed closed.'},candidateText:'Rain fell.\\n\\n<img src=x onerror=alert(1)> The door remained closed.',targetIdentity:{messageId:'42'},writer:{mode:'profile',label:'Prose profile'},editingScope:'polish',applyMode:'as-swipe',state:'pending',eligible:true};
let records=JSON.parse(sessionStorage.getItem('records')||'null')||[initial];
let settings=normalizeSettings({postProcess:{enabled:true}});
let subscribers=new Set();
window.profiles=[{id:'prose',label:'Prose profile',model:'prose-model'}];
let delayedRead=null;
window.deferRefresh=()=>{const snapshot=structuredClone(records);delayedRead=new Promise(resolve=>{window.releaseRefresh=()=>resolve(snapshot);});for(const fn of subscribers)fn();};
window.actions=[];
window.records=()=>records;
window.settings=()=>settings;
window.setStale=()=>{records[0]={...records[0],eligible:false,state:'stale',ineligibleReason:'The source response changed.'};for(const fn of subscribers)fn();};
const runtime={view:()=>({settings}),listProviderConnectionProfiles:()=>window.profiles,updateSettings:async patch=>{settings=normalizeSettings({...settings,...patch});window.ui.update();},postProcessComparisons:async()=>{if(delayedRead){const pending=delayedRead;delayedRead=null;return pending;}return structuredClone(records);},subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn);},reviewPostProcess:async({id,action,text})=>{
window.actions.push({id,action,text});await new Promise(resolve=>setTimeout(resolve,25));
const record=records.find(r=>r.id===id);if(!record?.eligible)return{ok:false,reason:'The source response changed.'};
if(action==='edit'){record.candidateText=text;record.manualEdit=true;record.state='pending';}
if(action==='apply')record.state='applied';
if(action==='keep')record.state='rejected';
let comparison=record;
if(action==='retry'){comparison={...record,id:'revision-'+(records.length+1),candidateText:'Rain fell quietly. The door stayed closed.',state:'pending'};records.unshift(comparison);}
sessionStorage.setItem('records',JSON.stringify(records));return{ok:true,comparison:structuredClone(comparison)};
}};
window.ui=mountRecursionUi({runtime,mountPoint:document.querySelector('#mount')});
document.querySelector('#source').onclick=()=>window.ui.openPostProcessReview({id:'revision-1'});
window.ready=true;
</script></body></html>`;
const productionFixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles/recursion.css"><style>body{margin:12px;background:#202020;color:#d8d8d8;font:14px sans-serif}#mount{max-width:950px}</style></head><body><div id="chat"></div><button id="generate">Prepare revision</button><button id="source">Review response</button><div id="mount"></div><script type="module">
import {mountRecursionUi} from '/src/ui.mjs';
import {createRecursionRuntime} from '/src/runtime.mjs';
import {createSettingsStore} from '/src/settings.mjs';
import {createStorageRepository} from '/src/storage.mjs';
import {createSillyTavernHost} from '/src/hosts/sillytavern/host.mjs';
const original='The rain stopped. "We should go," Mara said.';
window.generations=[];
const context={chatId:'browser-production',chat:JSON.parse(sessionStorage.getItem('host-chat')||'null')||[
 {mesid:0,is_user:true,mes:'Continue.'},{mesid:1,is_user:false,mes:original,swipe_id:0,swipes:[original],swipe_info:[{extra:{}}]}],
 saveChat(){sessionStorage.setItem('host-chat',JSON.stringify(context.chat));},setExtensionPrompt(){},updateMessageBlock(){},swipe:{refresh(){}},
 async generate(_type,options){window.generations.push(options.quiet_prompt);return 'Rain faded. "We should go," Mara said.';}};
const host=createSillyTavernHost({contextFactory:()=>context,settingsRoot:{}});
const storage=createStorageRepository({storage:{async readJson(key){return JSON.parse(sessionStorage.getItem('repo-'+key)||'null');},async writeJson(key,value){sessionStorage.setItem('repo-'+key,JSON.stringify(value));return {ok:true};},async deleteJson(key){sessionStorage.removeItem('repo-'+key);return {ok:true};}}});
const settingsStore=createSettingsStore({root:{recursion:{postProcess:{enabled:true,reviewBeforeApplying:true}}}});
window.runtime=createRecursionRuntime({host,storage,settingsStore,generationRouter:{async generate(_role,request){return {ok:true,data:{guidanceText:'Tighten the narration.',snapshotHash:request.snapshotHash,sourceHash:request.sourceHash}};}}});
window.ui=mountRecursionUi({runtime:window.runtime,mountPoint:document.querySelector('#mount')});
window.context=context;
document.querySelector('#generate').onclick=async()=>{window.result=await window.runtime.runPostProcessForLatestAssistant();};
document.querySelector('#source').onclick=()=>window.ui.openPostProcessReview();
window.ready=true;
</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/production') { res.setHeader('Content-Type', 'text/html'); res.end(productionFixture); return; }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
    const path = resolve(root, `.${decodeURIComponent(req.url.split('?')[0])}`);
    if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', extname(path) === '.css' ? 'text/css' : 'text/javascript');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 850 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('response', response => { if (response.status() >= 400) console.error(response.status(), response.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.ready);
  await page.locator('[data-recursion-post-process-cards-button]').click();
  await page.locator('[data-recursion-post-process-writer-mode]').selectOption('profile');
  assert.equal(await page.evaluate(() => window.settings().postProcess.writer.connectionProfileId), 'prose');
  await page.evaluate(()=>{window.profiles.push({id:'new-prose',label:'New prose profile'});window.ui.update();});
  assert.equal(await page.locator('[data-recursion-post-process-writer-profile] option[value="new-prose"]').count(),1,'external profile changes refresh the selector');
  await page.locator('[data-recursion-post-process-writer-advanced] summary').click();
  await page.locator('[data-recursion-post-process-writer-limit]').fill('4096');
  await page.locator('[data-recursion-post-process-writer-limit]').press('Tab');
  await page.locator('[data-recursion-post-process-writer-sampling]').selectOption('override');
  await page.locator('[data-recursion-post-process-writer-temperature]').fill('0.8');
  await page.locator('[data-recursion-post-process-writer-temperature]').press('Tab');
  assert.equal(await page.evaluate(() => window.settings().postProcess.writer.samplerOverrides.temperature), 0.8);
  await page.locator('[data-recursion-post-process-review-before-applying]').check();
  assert.equal(await page.evaluate(() => window.settings().postProcess.reviewBeforeApplying), true);
  await page.locator('[data-recursion-post-process-style-details] summary').click();
  await page.locator('[data-recursion-post-process-style-copy]').click();
  await page.locator('[data-recursion-post-process-style-brief]').fill('Short, concrete sentences.');
  await page.locator('[data-recursion-post-process-style-sample]').fill('Rain. The door stayed closed.');
  await page.locator('[data-recursion-post-process-editing-scope]').selectOption('revise');
  assert.equal(await page.locator('[data-recursion-post-process-style-brief]').inputValue(),'Short, concrete sentences.','scope changes preserve unsaved brief');
  assert.equal(await page.locator('[data-recursion-post-process-style-sample]').inputValue(),'Rain. The door stayed closed.','scope changes preserve unsaved example');
  await page.locator('[data-recursion-post-process-style-save]').click();
  assert.equal(await page.evaluate(() => Object.values(window.settings().postProcessDecks.customDecks)[0].styleBrief), 'Short, concrete sentences.');
  await page.screenshot({ path: resolve(output, 'controls-desktop.png') });
  await page.locator('[data-recursion-post-process-style-brief]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'style-desktop.png') });
  await page.locator('[data-recursion-post-process-cards-button]').click();
  await page.evaluate(() => document.querySelector('#chat').scrollTop = 110);
  const chatScroll = await page.locator('#chat').evaluate(el => el.scrollTop);
  await page.locator('#source').click();
  const dialog = page.locator('.recursion-review-dialog');
  await dialog.waitFor();
  assert.equal(await dialog.locator('img,script').count(), 0, 'prose is inert DOM text');
  assert((await dialog.textContent()).includes('<img src=x onerror=alert(1)>'));
  assert(await dialog.locator('del,ins').count() > 0);
  await page.screenshot({ path: resolve(output, 'comparison-desktop.png') });
  await dialog.getByRole('button', { name: 'Read clean text', exact: true }).click();
  assert.equal(await dialog.locator('del,ins').count(), 0);
  await page.evaluate(()=>window.deferRefresh());
  await dialog.getByRole('button', { name: 'Edit revision', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Edit revision', exact: true }).fill('Rain fell. The door stayed closed.');
  await dialog.getByRole('button', { name: 'Save and use revision', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => window.records()[0].state === 'applied');
  assert.deepEqual(await page.evaluate(() => window.actions.map(x => x.action)), ['edit', 'apply']);
  await page.waitForFunction(()=>document.querySelector('[data-review-action="retry"]')?.disabled===false);
  await page.evaluate(()=>window.releaseRefresh());
  await page.waitForTimeout(20);
  assert.equal(await dialog.getByRole('button',{name:'Use revision',exact:true}).isDisabled(),true,'late pre-action read cannot reenable acceptance');
  await dialog.getByRole('button', { name: 'Try another revision', exact: true }).click();
  await page.waitForFunction(() => window.records().length === 2);
  await page.waitForFunction(() => document.querySelector('[data-review-action="apply"]')?.disabled === false);
  assert.equal(await page.evaluate(() => window.records()[0].state), 'pending');
  await page.setViewportSize({ width: 390, height: 740 });
  await page.screenshot({ path: resolve(output, 'comparison-mobile.png') });
  assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), 'mobile dialog does not overflow horizontally');
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Try another revision', 'focus trapped backwards');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'source', 'close restores message action focus');
  assert.equal(await page.locator('#chat').evaluate(el => el.scrollTop), chatScroll, 'chat scroll preserved');
  await page.reload(); await page.waitForFunction(() => window.ready);
  await page.evaluate(() => window.ui.openPostProcessReview());
  await page.waitForFunction(() => document.querySelector('[data-review-action="select"]')?.value === 'revision-2');
  await dialog.getByRole('button', { name: 'Keep original', exact: true }).click();
  await page.waitForFunction(() => window.records()[0].state === 'rejected');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => window.ui.openPostProcessReview({ id: 'revision-1' }));
  await page.waitForFunction(() => document.querySelector('[data-review-action="select"]')?.value === 'revision-1');
  await dialog.getByRole('button', { name: 'Keep original', exact: true }).click();
  await page.waitForFunction(() => window.records().find(r=>r.id==='revision-1').state === 'rejected');
  await page.evaluate(() => window.setStale());
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => window.ui.openPostProcessReview({ id: 'revision-2' }));
  assert.equal(await dialog.getByRole('button', { name: 'Use revision', exact: true }).isDisabled(), true);
  assert((await dialog.textContent()).includes('The source response changed.'));
  await page.screenshot({ path: resolve(output, 'comparison-stale-mobile.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-recursion-post-process-cards-button]').click();
  await page.locator('[data-recursion-post-process-writer-mode]').selectOption('profile');
  await page.locator('[data-recursion-post-process-editing-scope]').selectOption('revise');
  await page.screenshot({ path: resolve(output, 'controls-mobile.png') });
  assert(await page.locator('[data-recursion-post-process-panel]').evaluate(el => el.scrollWidth <= el.clientWidth), 'narrow writing panel does not overflow');
  // Real production components joined at the browser/host boundary; only model output is deterministic.
  await page.goto(`http://127.0.0.1:${server.address().port}/production`);
  await page.waitForFunction(()=>window.ready);
  await page.locator('#generate').click();
  await page.waitForFunction(()=>window.result);
  assert.equal(await page.evaluate(()=>window.result.reason),'awaiting-review');
  assert.equal(await page.evaluate(()=>window.context.chat[1].swipes.length),1);
  await page.reload();
  await page.waitForFunction(()=>window.ready);
  await page.locator('#source').click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Use revision',exact:true}).isEnabled(),true);
  await dialog.getByRole('button',{name:'Use revision',exact:true}).click();
  await page.waitForFunction(()=>window.context.chat[1].swipes.length===2).catch(async(error)=>{console.error(await page.evaluate(()=>({status:document.querySelector('.recursion-review-status')?.textContent,chat:window.context.chat,view:window.runtime.view().execution})));throw error;});
  await page.waitForFunction(()=>document.querySelector('[data-review-action="retry"]')?.disabled===false);
  await dialog.getByRole('button',{name:'Try another revision',exact:true}).click();
  await page.waitForFunction(()=>window.generations.length===1);
  await page.waitForFunction(()=>document.querySelector('[data-review-action="apply"]')?.disabled===false);
  assert.equal(await page.evaluate(()=>window.context.chat[1].swipes.length),2);
  assert.equal(await page.evaluate(()=>window.generations[0].endsWith('The rain stopped. "We should go," Mara said.')),true);
  await dialog.getByRole('button',{name:'Edit revision',exact:true}).click();
  await dialog.getByRole('textbox',{name:'Edit revision',exact:true}).fill('The rain fell silent. "We should go," Mara said.');
  await dialog.getByRole('button',{name:'Save and use revision',exact:true}).click();
  await page.waitForFunction(()=>window.context.chat[1].swipes.length===3);
  await page.waitForFunction(()=>document.querySelector('[data-review-action="keep"]')?.disabled===false);
  await dialog.getByRole('button',{name:'Keep original',exact:true}).click();
  await page.waitForFunction(()=>window.context.chat[1].swipe_id===0);
  assert.equal(await page.evaluate(()=>window.context.chat[1].mes),'The rain stopped. "We should go," Mara said.');
  assert.equal(await page.evaluate(()=>window.context.chat[1].swipes.length),3);
  await page.screenshot({path:resolve(output,'production-review-restored-mobile.png')});
  await writeFile(resolve(output,'production-report.json'),JSON.stringify({passed:true,fixture:'production UI + root runtime + repository + SillyTavern host adapter; deterministic model responses',checks:['pending without host mutation','recreation restores pending','guarded apply','retry from immutable original','manual edit and accept','keep original selects existing swipe']},null,2));
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, fixture: 'isolated mock runtime; real production UI', checks: ['writer-profile atomic selection', 'output and sampling', 'review toggle', 'starter copy and style save', 'inert HTML', 'highlight/clean', 'manual edit/apply', 'retry pending', 'pending after reload', 'keep pending/applied', 'stale actions disabled', 'mobile width', 'focus trap/restore', 'chat scroll'], errors }, null, 2));
  console.log('Post-process review browser proof: PASS (' + output + ')');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

