import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSillyTavernHttpSession, validateSoakUserHandle } from './lib/sillytavern-live-harness.mjs';
import { productionFilePaths, runInstalledCopyVerifierCli } from './verify-installed-copy.mjs';
import { checkLoadedIdentity, parseCases, caseOutcome, safeEvidence, withDeadline, waitForNativeConnection } from './lib/post-process-live-proof.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const report = { schema: 'recursion.livePostProcessProof.v1', status:'fail', stage:'preflight', cases:[], requests:[], observations:[] };
const reportPath = resolve(process.env.RECURSION_LIVE_REPORT || resolve(repositoryRoot,'artifacts/live-post-process-proof/report.json'));
function checkpoint() {
  mkdirSync(dirname(reportPath),{recursive:true});
  writeFileSync(reportPath,JSON.stringify(report,(key,value) => ['lastFingerprint','ownsGeneration'].includes(key) ? undefined : value,2)+'\n');
}
const digest = value => createHash('sha256').update(value).digest('hex');
const wait = ms => new Promise(done => setTimeout(done, ms));
let stopping = false;
function assertActive() { if (stopping) fail('proof-canceled','The proof is stopping.'); }
function fail(result, message) { throw Object.assign(new Error(message), {result}); }
function passwordForUser(user, env) {
  return env['RECURSION_SILLYTAVERN_PASSWORD_' + user.toUpperCase().replace(/[^A-Z0-9]+/g, '_')] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}
function preflight(argv, env) {
  if (!argv.includes('--live')) fail('dry-run', 'Pass --live to mutate a dedicated SillyTavern user.');
  if (!env.SILLYTAVERN_BASE_URL) fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  const user = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  if (!user.ok) fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.');
  return user.user;
}

async function selectTargetChat(page, { characterName = '', chatFile = '', timeoutMs }) {
  await page.waitForFunction(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.();
    return Array.isArray(context?.characters) && context.characters.length > 0;
  }, null, { timeout: timeoutMs });
  const selected = await page.evaluate(async ({ requestedCharacter, requestedChatFile }) => {
    const readContext = () => globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.();
    let context = readContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    let characterIndex = requestedCharacter
      ? characters.findIndex((entry) => {
          const expected = requestedCharacter.toLowerCase();
          const name = String(entry?.name || '').trim().toLowerCase();
          const avatar = String(entry?.avatar || '').trim().toLowerCase().replace(/\.png$/i, '');
          return name === expected || avatar === expected;
        })
      : Number(context?.characterId);
    if (!Number.isInteger(characterIndex) || characterIndex < 0 || characterIndex >= characters.length) {
      if (requestedCharacter) return { ok: false, reason: 'requested-character-unavailable' };
      characterIndex = 0;
    }
    if (Number(context.characterId) !== characterIndex) {
      if (typeof context.selectCharacterById !== 'function') return { ok: false, reason: 'select-character-unavailable' };
      await context.selectCharacterById(characterIndex);
      context = readContext() || context;
    }
    const character = context.characters?.[characterIndex] || characters[characterIndex];
    const selectedChatFile = String(
      requestedChatFile || character?.chat || context.chatId || context.currentChatId || ''
    ).replace(/\.jsonl$/i, '');
    if (!selectedChatFile || typeof context.openCharacterChat !== 'function') {
      return { ok: false, reason: 'chat-reload-unavailable' };
    }
    await context.openCharacterChat(selectedChatFile);
    return {
      ok: true,
      characterName: String(character?.name || ''),
      chatFile: selectedChatFile
    };
  }, {
    requestedCharacter: String(characterName || '').trim(),
    requestedChatFile: String(chatFile || '').trim()
  });
  if (!selected?.ok) fail('target-chat-unavailable', 'A reloadable dedicated-user character chat is required.', selected);
  return selected;
}

async function assistantState(page, messageId = null) {
  return page.evaluate(async expectedMessageId => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const chat = context.chat || [];
    const index = expectedMessageId === null ? chat.findLastIndex(entry => entry?.is_user === false)
      : chat.findIndex((entry, row) => Number(entry?.mesid ?? row) === expectedMessageId);
    const assistant = chat[index];
    const swipeId = Number(assistant?.swipe_id ?? 0);
    const swipes = assistant?.swipes || [];
    const swipeInfo = assistant?.swipe_info || [];
    const marker = swipeInfo[swipeId]?.extra?.recursion?.postProcess;
    const { hashJson } = await import('/scripts/extensions/third-party/Recursion/src/core.mjs');
    const view = runtime.view();
    const comparisons = await runtime.postProcessComparisons();
    const diagnostic = runtime.postProcessDiagnostics();
    const stop = document.querySelector('#mes_stop');
    return {
      messageId: Number(assistant?.mesid ?? index), index, messageCount: chat.length,
      swipeId, swipeCount: swipes.length, swipeInfoLength: swipeInfo.length,
      markerSchema: marker?.schema, markerSourceHash: marker?.sourceHash, markerCandidateHash: marker?.candidateHash,
      markerValid: marker?.schema === 'recursion.postProcessMarker.v1' && swipeId > 0
        && marker.sourceHash === hashJson(String(swipes[swipeId - 1] ?? ''))
        && marker.candidateHash === hashJson(String(swipes[swipeId] ?? ''))
        && String(assistant?.mes ?? '') === String(swipes[swipeId] ?? ''),
      postProcessPending: runtime.postProcessPending(), postProcessRunning: runtime.postProcessRunning(),
      hostGenerationActive: view.hostGenerationActive,
      nativeStopVisible: Boolean(stop && getComputedStyle(stop).display !== 'none' && stop.getClientRects().length),
      diagnostics: diagnostic,
      execution: view.execution,
      pendingComparisons: comparisons.filter(item => item.state === 'pending' && item.operationId === diagnostic.operationId)
        .map(item => ({id:item.id,state:item.state,eligible:item.eligible === true}))
    };
  }, messageId).then(safeEvidence);
}

// Only secret metadata is inspected. Credential values are never read or returned.
async function providerReadiness(page) {
  return page.evaluate(async () => {
    const context = globalThis.SillyTavern.getContext();
    const settings = globalThis.__recursionLiveHarnessRuntime.view().settings;
    const service = context.ConnectionManagerRequestService;
    const token = value => /^[A-Za-z0-9_.:/-]{1,100}$/.test(String(value || '')) ? String(value) : '';
    const [secrets, chat, text, host] = await Promise.all([
      import('/scripts/secrets.js'), import('/scripts/openai.js'), import('/scripts/textgen-settings.js'), import('/script.js')
    ]);
    const credentialReady = (source, mode, secretId = '') => {
      const types = mode === 'openai' ? chat.chat_completion_sources : text.textgen_types;
      const entry = Object.entries(types || {}).find(([, value]) => value === source);
      const key = entry && secrets.SECRET_KEYS[entry[0]];
      const records = key && secrets.secret_state[key];
      return Array.isArray(records) && records.some(item => item.active === true || (secretId && item.id === secretId));
    };
    const lanes = [['utility', settings.providers?.utility]];
    if (settings.reasoningLevel !== 'low') lanes.push(['reasoner', settings.providers?.reasoner]);
    if (settings.postProcess?.writer?.mode === 'profile') lanes.push(['writer',settings.postProcess.writer]);
    const profiles = lanes.map(([lane, config]) => {
      const id = config?.connectionProfileId;
      const profile = id && service?.getProfile?.(id);
      let api;
      try { api = profile && service.validateProfile(profile); } catch { api = null; }
      const completion = api?.selected === 'openai' ? context.ChatCompletionService : context.TextCompletionService;
      const preset = profile && completion && context.getPresetManager?.(completion.TYPE)?.getCompletionPresetByName?.(profile.preset);
      const source = api?.source || api?.type;
      return { lane, profileSelected: Boolean(id), profileAvailable: Boolean(profile),
        api: token(api?.selected), source:token(source), model:token(profile?.model),
        presetAvailable: Boolean(preset), credentialAvailable: credentialReady(source, api?.selected, profile?.['secret-id']),
        outputTokenCeiling: Number(config?.outputTokenCeiling || config?.maxOutputTokens || 0),
        presetMode:token(config?.generationPolicy?.presetMode), samplerMode:token(config?.generationPolicy?.samplerMode || config?.samplerMode) };
    });
    const nativeSource = host.main_api === 'openai' ? chat.oai_settings.chat_completion_source : text.textgen_settings.type;
    const nativeModel = host.main_api === 'openai' ? chat.getChatCompletionModel() : text.textgen_settings.model;
    const nativeCompletion = host.main_api === 'openai' ? context.ChatCompletionService : context.TextCompletionService;
    const nativePresets = context.getPresetManager?.(nativeCompletion?.TYPE);
    const nativePreset = nativePresets?.getCompletionPresetByName?.(nativePresets?.getSelectedPresetName?.());
    const native = {presetAvailable:Boolean(nativePreset),api:token(host.main_api),source:token(nativeSource),model:token(nativeModel),
      credentialAvailable:credentialReady(nativeSource,host.main_api), connected:host.online_status !== 'no_connection'};
    return {ok: profiles.every(item => item.profileAvailable && item.presetAvailable && item.credentialAvailable && item.model)
      && native.presetAvailable && native.credentialAvailable && native.connected && Boolean(native.model), profiles, native,
      pipelineMode:token(settings.pipelineMode), reasoningLevel:token(settings.reasoningLevel),
      writerMode:token(settings.postProcess?.writer?.mode), deckSelected:Boolean(settings.postProcessDecks?.activeDeckId)};
  });
}

async function verifyBrowserIdentity(context, loadedUrls, loadedBodies, baseUrl) {
  const identity = checkLoadedIdentity([...loadedUrls], baseUrl);
  report.identity = {entrypoint:identity.entrypoint,runtime:identity.runtime,unexpected:identity.unexpected};
  if (!identity.ok) fail('wrong-loaded-extension','The browser must load only the current Recursion entrypoint and runtime. Disable obsolete copies and reload.');
  const files = productionFilePaths(repositoryRoot);
  const expected = new Map(files.map(file => [file,digest(readFileSync(resolve(repositoryRoot,file)))]));
  const mismatches = [];
  for (const [url, hash] of loadedBodies) {
    if (!url.startsWith(identity.root)) continue;
    const file = new URL(url).pathname.slice(new URL(identity.root).pathname.length);
    if (expected.has(file) && expected.get(file) !== hash) mismatches.push({file,kind:'loaded-content-mismatch'});
  }
  for (const url of loadedUrls) {
    if (url.startsWith(identity.root) && !loadedBodies.has(url.split('?')[0])) mismatches.push({file:new URL(url).pathname,kind:'loaded-response-unavailable'});
  }
  for (const file of files) {
    const response = await context.request.get(new URL(file,identity.root).href, {headers:{'Cache-Control':'no-cache'},timeout:15000});
    if (!response.ok() || digest(await response.body()) !== expected.get(file)) mismatches.push({file,kind:'served-content-mismatch',status:response.status()});
    await response.dispose();
  }
  report.identity.filesCompared = files.length;
  report.identity.mismatches = mismatches.slice(0,64);
  if (mismatches.length) fail('stale-served-extension','Loaded or served production files do not match this checkout.');
}

async function runCase(page, scenario, target, timeoutMs) {
  report.stage = scenario;
  const result = {scenario,status:'running',reloads:0};
  report.cases.push(result);
  checkpoint(); console.log(JSON.stringify({event:'case-start',scenario}));
  const current = await assistantState(page);
  assertActive();
  if (current.postProcessPending || current.postProcessRunning || current.hostGenerationActive) fail('host-busy','Wait for the dedicated account to become idle before starting proof.');
  if (current.pendingComparisons.length) fail('review-already-pending','Resolve the existing review before starting a new proof case.');
  const configured = await page.evaluate(async review => {
    const result = await globalThis.__recursionLiveHarnessRuntime.updateSettings({enabled:true,postProcess:{enabled:true,applyMode:'as-swipe',rewriteFlow:'unified',reviewBeforeApplying:review}});
    return result?.ok !== false;
  },scenario.endsWith('-review'));
  assertActive();
  if (!configured) fail('settings-failed','Post-process proof settings could not be saved.');
  const before = await assistantState(page);
  assertActive();
  result.before = before;
  if (scenario.startsWith('swipe-') && (before.index < 0 || before.swipeCount < 1 || before.swipeId !== before.swipeCount - 1)) fail('native-swipe-unavailable','The target needs its latest native assistant swipe selected.');
  const baseline = {...before,diagnosticOperationId:before.diagnostics.operationId,executionOperationId:before.execution.operationId};
  const started = Date.now();
  let acceptedReview = false;
  result.stopObserved = false;
  // Set ownership before the click, since generation may dispatch even if click later times out.
  report.ownsGeneration = true;
  if (scenario.startsWith('generation-')) {
    await page.locator('#send_textarea').fill(process.env.RECURSION_LIVE_PROMPT || 'Continue the scene with one short exchange, leaving my next action open.');
    assertActive();
    await page.locator('#send_but').click({timeout:10000});
  } else {
    await page.locator(`.mes[mesid="${before.messageId}"] .swipe_right, .mes[data-message-id="${before.messageId}"] .swipe_right`).last().click({timeout:10000});
  }
  while (Date.now() - started < timeoutMs) {
    const after = await assistantState(page,scenario.startsWith('swipe-') ? before.messageId : null);
    assertActive();
    result.after = after;
    result.stopObserved ||= (after.postProcessPending || after.postProcessRunning) && after.nativeStopVisible;
    const fingerprint = JSON.stringify([after.diagnostics,after.execution,after.swipeCount,after.postProcessRunning]);
    if (fingerprint !== result.lastFingerprint) {
      result.lastFingerprint = fingerprint;
      report.observations.push({scenario,elapsedMs:Date.now()-started,...after});
      report.observations = report.observations.slice(-32);
      checkpoint();
      console.log(JSON.stringify({event:'case-progress',scenario,elapsedMs:Date.now()-started,outcome:after.diagnostics.status,phase:after.execution.phase,executionState:after.execution.state}));
    }
    let outcome = caseOutcome({before:baseline,after,scenario});
    if (acceptedReview && after.markerValid && after.swipeCount === result.expectedSwipeCount) {
      outcome=caseOutcome({before:baseline,after:{...after,diagnostics:{...after.diagnostics,status:'applied'}},scenario});
    }
    if (outcome.status === 'review') {
      if (acceptedReview) {await wait(250);continue;}
      const sourceCount = scenario.startsWith('swipe-') ? before.swipeCount + 1 : 1;
      if (after.swipeCount !== sourceCount || after.markerValid) fail('review-applied-early','Review must leave the native source selected until Use revision.');
      result.reviewAwaitingObserved = true;
      result.expectedSwipeCount = sourceCount + 1;
      const message=page.locator('.mes[mesid="'+after.messageId+'"]');
      await message.scrollIntoViewIfNeeded(); await message.hover();
      await message.locator('[data-recursion-message-review]').click();
      await page.locator('[data-review-action="select"]').selectOption(after.pendingComparisons[0].id);
      assertActive();
      await page.getByRole('button',{name:'Use revision',exact:true}).click();
      acceptedReview = true;
      continue;
    }
    if (outcome.status === 'fail') fail(outcome.reason,'The live case ended without the required new Post-process swipe.');
    if (outcome.status === 'pass') {
      if (scenario.endsWith('-review') && !acceptedReview) fail('review-not-observed','Review was required but no pending revision was accepted.');
      if (!result.stopObserved) fail('post-process-stop-not-observed','Native Stop was not observed during Post-process.');
      report.ownsGeneration = false;
      if (acceptedReview) await page.locator('[data-review-action="close"]').click();
      for (let reload = 0; reload < 2; reload++) {
        assertActive();
        await page.evaluate(async chatFile => {const context=globalThis.SillyTavern.getContext();await context.saveChat();await context.openCharacterChat(chatFile);},target.chatFile);
        const persisted = await assistantState(page,after.messageId);
        result.reloads++;
        result.persisted = persisted;
        if (persisted.swipeCount !== after.swipeCount || persisted.swipeId !== after.swipeId || persisted.swipeInfoLength !== after.swipeInfoLength
          || !persisted.markerValid || persisted.markerSourceHash !== after.markerSourceHash || persisted.markerCandidateHash !== after.markerCandidateHash) fail('persisted-swipe-invalid','Reload changed the swipe count, selection, or marker integrity.');
      }
      result.status='pass';
      result.elapsedMs=Date.now()-started;
      delete result.lastFingerprint;
      checkpoint();console.log(JSON.stringify({event:'case-end',scenario,status:result.status,elapsedMs:result.elapsedMs}));
      return;
    }
    await wait(250);
  }
  fail('case-deadline','Live proof reached its per-case deadline.');
}

async function main() {
  const user = preflight(process.argv.slice(2),process.env);
  const timeoutMs = Number(process.env.RECURSION_LIVE_TIMEOUT_MS || 240000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10000 || timeoutMs > 900000) fail('invalid-timeout','RECURSION_LIVE_TIMEOUT_MS must be between 10000 and 900000.');
  const cases = parseCases(process.env.RECURSION_LIVE_CASES);
  if (!process.env.SILLYTAVERN_ROOT) fail('missing-host-root','SILLYTAVERN_ROOT is required for account-installed file verification.');
  if (runInstalledCopyVerifierCli(['--user',user,'--repo-root',repositoryRoot,'--account-only'], {environment:process.env,stdout:{write(){}},stderr:{write(){}}}) !== 0) fail('stale-installed-extension','The dedicated account installation must match this checkout.');
  const session = createSillyTavernHttpSession({baseUrl:process.env.SILLYTAVERN_BASE_URL,user,password:passwordForUser(user,process.env)});
  await session.init(); await session.login();
  const browser = await chromium.launch({headless:process.env.RECURSION_SILLYTAVERN_HEADLESS !== '0'});
  let page;
  try {
    const context = await browser.newContext();
    await context.addCookies(session.playwrightCookies());
    await context.addInitScript(() => {globalThis.__recursionLiveHarness=true;});
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const cdp = await context.newCDPSession(page);
    const loadedUrls = new Set();
    const loadedBodies = new Map();
    const pendingBodies = new Set();
    cdp.on('Debugger.scriptParsed',event => {if (/\/extensions\/third-party\/[^/]*recursion[^/]*\//i.test(event.url)) loadedUrls.add(event.url.split('?')[0]);});
    await cdp.send('Debugger.enable');
    page.on('response',response => {
      const url = response.url();
      if (/\/extensions\/third-party\/[^/]*recursion[^/]*\//i.test(url)) {
        const pending = response.body().then(body => loadedBodies.set(url.split('?')[0],digest(body))).catch(() => {});
        pendingBodies.add(pending); void pending.finally(() => pendingBodies.delete(pending));
      }
      if (/\/generate(?:\/|$)/.test(new URL(url).pathname)) {
        report.requests.push({status:response.status(),elapsedMs:Date.now()-report.startedAt});
        report.requests=report.requests.slice(-64);
      }
    });
    report.stage='loaded-identity';
    await page.goto(process.env.SILLYTAVERN_BASE_URL,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(() => Boolean(globalThis.__recursionLiveHarnessRuntime),null,{timeout:60000});
    await Promise.all([...pendingBodies]);
    await withDeadline(verifyBrowserIdentity(context,loadedUrls,loadedBodies,process.env.SILLYTAVERN_BASE_URL),60000);
    const actualUser = await page.evaluate(async () => (await import('/scripts/user.js')).getCurrentUserHandle());
    if (actualUser !== user) fail('wrong-authenticated-user','The loaded browser account is not the requested dedicated user.');
    report.stage='provider-preflight';
    report.providers=await withDeadline(waitForNativeConnection(() => providerReadiness(page)),30000);
    if (!report.providers.ok) fail('provider-preflight-failed','Selected profile, model, preset, or credential metadata is unavailable. Configure this dedicated account; credentials are never copied by the harness.');
    const target = await selectTargetChat(page,{characterName:process.env.RECURSION_LIVE_CHARACTER,chatFile:process.env.RECURSION_LIVE_CHAT_FILE,timeoutMs:30000});
    for (const scenario of cases) await withDeadline(runCase(page,scenario,target,timeoutMs),timeoutMs + 1000);
    report.status='pass'; report.stage='complete'; report.result='live-post-process-as-swipe-pass';
  } finally {
    stopping = true;
    if (page && report.ownsGeneration) {
      report.cleanup={attempted:true,settled:false};
      try {
        await withDeadline(page.evaluate(() => {void globalThis.__recursionLiveHarnessRuntime.stopGeneration({reason:'live-proof-deadline'});}),3000);
        const deadline=Date.now()+10000;
        while (Date.now()<deadline) {
          const state=await withDeadline(assistantState(page),3000);
          if (!state.postProcessPending && !state.postProcessRunning && !state.hostGenerationActive && !state.nativeStopVisible) {report.cleanup.settled=true;break;}
          await wait(250);
        }
      } catch { report.cleanup.error='cleanup-unavailable'; }
    }
    await browser.close();
  }
}

report.startedAt=Date.now();
main().catch(error => {
  report.status='fail'; report.result=error.result || 'live-proof-error';
  // Unexpected browser/provider messages can contain requests or story text; omit them.
  report.error=error.result ? error.message : 'Unexpected harness failure; inspect the failing stage and sanitized evidence.';
  const current=report.cases.at(-1);if(current?.status==='running') {current.status='fail';delete current.lastFingerprint;console.log(JSON.stringify({event:'case-end',scenario:current.scenario,status:'fail',result:report.result}));}
  process.exitCode=1;
}).finally(() => {
  report.elapsedMs=Date.now()-report.startedAt;delete report.ownsGeneration;
  checkpoint();
  console.log(JSON.stringify({status:report.status,result:report.result,stage:report.stage,report:reportPath,cases:report.cases.map(({scenario,status,reloads})=>({scenario,status,reloads}))},null,2));
});
