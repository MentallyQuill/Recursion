import { chromium } from 'playwright';
import {
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';
import { runInstalledCopyVerifierCli } from './verify-installed-copy.mjs';

const DEFAULT_TIMEOUT_MS = 120000;

function fail(result, message, details = {}) {
  const error = new Error(message);
  error.result = result;
  error.details = details;
  throw error;
}

function passwordEnvKey(user) {
  return `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function passwordForUser(user, env) {
  return env[passwordEnvKey(user)] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function assertPreflight(argv, env) {
  if (!argv.includes('--live')) fail('dry-run', 'Pass --live to mutate a dedicated SillyTavern user.');
  if (!env.SILLYTAVERN_BASE_URL) fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  const userResult = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  if (!userResult.ok) {
    fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', userResult);
  }
  return userResult.user;
}

function proofScript() {
  return async () => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
    if (!context) throw new Error('SillyTavern context unavailable');
    const [
      runtimeModule,
      settingsModule,
      storageModule,
      activityModule
    ] = await Promise.all([
      import('/scripts/extensions/third-party/Recursion/src/runtime.mjs'),
      import('/scripts/extensions/third-party/Recursion/src/settings.mjs'),
      import('/scripts/extensions/third-party/Recursion/src/storage.mjs'),
      import('/scripts/extensions/third-party/Recursion/src/activity.mjs')
    ]);

    async function proveServedRuntimePipeline(pipelineMode) {
      let providerCalls = 0;
      const installs = [];
      let activeSnapshot = {
        chatId: `live-served-${pipelineMode}-chat`,
        chatKey: `live-served-${pipelineMode}-chat`,
        sceneKey: `live-served-${pipelineMode}-scene`,
        sceneFingerprint: `live-served-${pipelineMode}-scene-fp`,
        turnFingerprint: `live-served-${pipelineMode}-turn-fp`,
        latestMesId: 10,
        messages: [
          { mesid: 10, role: 'user', text: `Live served ${pipelineMode} swipe proof.`, visible: true }
        ]
      };
      const settingsStore = settingsModule.createSettingsStore({ root: {} });
      settingsStore.update({ enabled: true, mode: 'auto', pipelineMode, reasonerUse: 'off', minCards: 1, maxCards: 1 });
      const storage = storageModule.createStorageRepository({
        storage: storageModule.createMemoryStorageAdapter()
      });
      const runtime = runtimeModule.createRecursionRuntime({
        settingsStore,
        storage,
        activity: activityModule.createActivityReporter(),
        host: {
          async snapshot() {
            return JSON.parse(JSON.stringify(activeSnapshot));
          },
          prompt: {
            async install(packet) {
              installs.push(packet);
              return { ok: true, installed: true };
            },
            async clear() {
              return { ok: true, cleared: true };
            }
          },
          generation: {}
        },
        generationRouter: {
          async generate(roleId, request = {}) {
            providerCalls += 1;
            if (roleId === 'utilityArbiter') {
              return {
                ok: true,
                data: {
                  schema: 'recursion.utilityArbiter.v1',
                  snapshotHash: request.snapshotHash,
                  action: 'refresh-cards',
                  sceneStatus: 'same-scene',
                  promptFootprint: 'compact',
                  cardJobs: [{ role: 'sceneFrameCard', reason: 'served browser swipe proof' }],
                  budgets: { targetBriefTokens: 500, maxCards: 1 },
                  reasonerDecision: { mode: 'skip', reason: 'served browser swipe proof' },
                  diagnostics: ['served-browser-swipe-arbiter']
                }
              };
            }
            if (roleId === 'sceneFrameCard') {
              return {
                ok: true,
                data: {
                  schema: 'recursion.card.v1',
                  family: 'Scene Frame',
                  promptText: 'Served browser swipe proof card.',
                  summary: 'Served browser swipe proof card.',
                  evidenceRefs: ['message:10'],
                  emphasis: 'normal',
                  detailProfile: 'compact',
                  diagnostics: ['served-browser-swipe-card']
                }
              };
            }
            if (roleId === 'fusedCardBundle') {
              return {
                ok: true,
                data: {
                  schema: 'recursion.cardBundle.v1',
                  snapshotHash: request.snapshotHash,
                  items: [{
                    schema: 'recursion.card.v1',
                    family: 'Scene Frame',
                    role: 'sceneFrameCard',
                    promptText: 'Served browser swipe proof card.',
                    summary: 'Served browser swipe proof card.',
                    evidenceRefs: ['message:10'],
                    tokenEstimate: 8
                  }]
                }
              };
            }
            if (roleId === 'guidanceComposer') {
              return {
                ok: true,
                data: {
                  schema: 'recursion.guidanceComposer.v1',
                  snapshotHash: request.snapshotHash,
                  guidanceText: 'SERVED_BROWSER_SWIPE_GUIDANCE reuse this packet on latest assistant swipe.',
                  sourceCardIds: [],
                  guardrailCardIds: [],
                  omittedCardIds: [],
                  diagnostics: ['served-browser-swipe-guidance']
                }
              };
            }
            if (roleId === 'rapidTurnDelta') {
              return {
                ok: true,
                data: {
                  schema: 'recursion.rapidTurnDelta.v2',
                  snapshotHash: request.snapshotHash,
                  baseSourceRevisionHash: request.baseSourceRevisionHash,
                  turnSourceRevisionHash: request.turnSourceRevisionHash,
                  selectedCardIds: [],
                  turnGuidanceText: 'SERVED_BROWSER_SWIPE_RAPID reuse this packet.',
                  guardrailCardIds: [],
                  packetInstructions: [],
                  backgroundRefreshRequests: [],
                  mandatoryMissingCards: [],
                  escalateToStandard: false,
                  diagnostics: ['served-browser-swipe-rapid']
                }
              };
            }
            throw new Error(`unexpected role ${roleId}`);
          }
        }
      });
      const first = await runtime.prepareForGeneration({ userMessage: activeSnapshot.messages[0].text, hostGeneration: true });
      if (!first?.ok || !installs[0]?.packetId) throw new Error(`${pipelineMode} first served-runtime install failed`);
      const callsAfterFirst = providerCalls;
      const firstView = runtime.view();
      activeSnapshot = {
        ...activeSnapshot,
        latestMesId: 11,
        messages: [
          ...activeSnapshot.messages,
          {
            mesid: 11,
            role: 'assistant',
            text: 'First assistant response being swiped.',
            visible: true,
            swipeId: 1,
            swipeCount: 2,
            activeSwipeTextHash: 'served-browser-swipe-alt'
          }
        ]
      };
      const swipePayloadUserMessage = activeSnapshot.messages[0].text;
      const second = await runtime.prepareForGeneration({
        userMessage: swipePayloadUserMessage,
        hostGeneration: true,
        generationType: 'swipe'
      });
      const secondView = runtime.view();
      return {
        pipelineMode,
        swipePayloadEndedOnUser: Boolean(swipePayloadUserMessage),
        firstOk: first.ok === true,
        secondOk: second.ok === true,
        reused: second.reused === true,
        reason: second.reason || '',
        providerCallsFirst: callsAfterFirst,
        providerCallsSecond: providerCalls - callsAfterFirst,
        packetIdStable: installs[0]?.packetId === installs[1]?.packetId,
        installCount: installs.length,
        firstPacketSnapshotHash: installs[0]?.snapshotHash || '',
        secondPacketSnapshotHash: installs[1]?.snapshotHash || '',
        firstSnapshot: firstView.lastSnapshot || null,
        secondSnapshot: secondView.lastSnapshot || null,
        cacheDecision: secondView.lastCacheDecision || null
      };
    }

    const servedStandard = await proveServedRuntimePipeline('standard');
    const servedRapid = await proveServedRuntimePipeline('rapid');
    const servedFused = await proveServedRuntimePipeline('fused');
    return {
      ok: servedStandard.reused
        && servedRapid.reused
        && servedFused.reused
        && servedStandard.swipePayloadEndedOnUser
        && servedRapid.swipePayloadEndedOnUser
        && servedFused.swipePayloadEndedOnUser
        && servedStandard.providerCallsSecond === 0
        && servedRapid.providerCallsSecond === 0
        && servedFused.providerCallsSecond === 0
        && servedStandard.packetIdStable
        && servedRapid.packetIdStable
        && servedFused.packetIdStable,
      mode: 'served-runtime-playwright',
      standard: servedStandard,
      rapid: servedRapid,
      fused: servedFused
    };
  };
}

async function nativeProof(page, { timeoutMs, pipelineModes }) {
  await page.waitForFunction(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
    return Array.isArray(context?.characters) && context.characters.length > 0;
  }, null, { timeout: timeoutMs });
  const chatSetup = await page.evaluate(async () => {
    const readContext = () => globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
    let context = readContext();
    if (!context) return { ok: false, reason: 'context-unavailable' };
    const characters = Array.isArray(context.characters) ? context.characters : [];
    if (characters.length === 0) return { ok: false, reason: 'character-unavailable' };
    let characterIndex = Number(context.characterId);
    if (!Number.isInteger(characterIndex) || characterIndex < 0 || characterIndex >= characters.length) {
      characterIndex = 0;
      if (typeof context.selectCharacterById !== 'function') {
        return { ok: false, reason: 'select-character-unavailable' };
      }
      await context.selectCharacterById(characterIndex);
      context = readContext() || context;
    }
    const character = (Array.isArray(context.characters) ? context.characters : characters)[characterIndex] || characters[characterIndex];
    const chatFile = String(character?.chat || context.chatId || context.currentChatId || '').replace(/\.jsonl$/i, '');
    if (chatFile && typeof context.openCharacterChat === 'function') {
      await context.openCharacterChat(chatFile);
    }
    return {
      ok: true,
      characterIndex,
      characterName: String(character?.name || ''),
      chatFile
    };
  });
  if (!chatSetup?.ok) {
    fail('native-chat-unavailable', 'A dedicated native SillyTavern character chat is required.', chatSetup || {});
  }
  await page.waitForSelector('#send_textarea, textarea#send_textarea', { state: 'visible', timeout: timeoutMs });

  async function setPipeline(pipelineMode) {
    const result = await page.evaluate(async (mode) => {
      const runtime = globalThis.__recursionLiveHarnessRuntime;
      if (!runtime?.updateSettings) throw new Error('Recursion live runtime unavailable');
      return runtime.updateSettings({
        enabled: true,
        mode: 'auto',
        pipelineMode: mode,
        enhancements: { mode: 'off' }
      });
    }, pipelineMode);
    if (result?.ok === false) fail('native-settings-failed', `Could not select ${pipelineMode}.`, { pipelineMode });
  }

  async function sendVisible(message) {
    const input = page.locator('#send_textarea, textarea#send_textarea, [contenteditable="true"][data-testid="send-textarea"]').first();
    const button = page.locator('#send_but, button#send_but').first();
    if (!(await input.isVisible().catch(() => false)) || !(await button.isVisible().catch(() => false))) {
      fail('visible-send-unavailable', 'Visible SillyTavern send controls were not available.');
    }
    await input.fill(message, { timeout: Math.min(timeoutMs, 10000) });
    await button.click({ timeout: timeoutMs });
    await page.waitForFunction((needle) => {
      const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
      const chat = Array.isArray(context.chat) ? context.chat : [];
      const userIndex = chat.findIndex((entry) => entry?.is_user === true
        && String(entry?.mes || entry?.message || entry?.text || '').includes(needle));
      return userIndex >= 0
        && chat.slice(userIndex + 1).some((entry) => entry?.is_user === false
          && String(entry?.mes || entry?.message || entry?.text || '').trim());
    }, message, { timeout: timeoutMs });
    await page.waitForFunction(() => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      return Boolean(view.lastPreparedGeneration?.artifactHash)
        && view.hostGenerationActive !== true
        && !view.activeRunId;
    }, null, { timeout: timeoutMs });
  }

  function nativeStateScript() {
    return async () => {
      const runtime = globalThis.__recursionLiveHarnessRuntime;
      const view = runtime?.view?.() || {};
      const exported = await runtime?.exportDiagnostics?.();
      const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
      const chat = Array.isArray(context.chat) ? context.chat : [];
      const assistantIndex = chat.findLastIndex((entry) => entry?.is_user === false);
      const assistant = assistantIndex >= 0 ? chat[assistantIndex] : null;
      const hash = (value) => {
        let result = 2166136261;
        for (const character of JSON.stringify(value || [])) {
          result ^= character.charCodeAt(0);
          result = Math.imul(result, 16777619);
        }
        return (result >>> 0).toString(16).padStart(8, '0');
      };
      const journal = exported?.diagnostics?.journal || [];
      return {
        artifactHash: String(view.lastPreparedGeneration?.artifactHash || ''),
        packetId: String(view.lastPreparedGeneration?.packet?.packetId || ''),
        handId: String(view.lastPreparedGeneration?.hand?.handId || ''),
        cacheDecision: view.lastCacheDecision || null,
        journalCount: Number(exported?.diagnostics?.storage?.journalEntryCount || 0),
        providerJournalIds: journal
          .filter((entry) => /provider/i.test(String(entry?.event || entry?.phase || '')))
          .map((entry) => String(entry?.id || ''))
          .filter(Boolean),
        assistantIndex,
        assistantMesId: Number(assistant?.mesid ?? assistantIndex),
        assistantSwipeCount: Array.isArray(assistant?.swipes) ? assistant.swipes.length : 0,
        assistantSwipeId: Number(assistant?.swipe_id ?? assistant?.swipeId ?? 0),
        preAssistantShapeHash: hash(chat.slice(0, Math.max(0, assistantIndex)).map((entry, index) => ({
          index,
          mesid: Number(entry?.mesid ?? index),
          role: entry?.is_user === true ? 'user' : 'assistant',
          text: String(entry?.mes || entry?.message || entry?.text || '')
        }))),
        chatLength: chat.length,
        statusText: String(document.querySelector('[data-recursion-ribbon-label], [data-recursion-status]')?.textContent || '').trim()
      };
    };
  }

  const results = [];
  for (const pipelineMode of pipelineModes) {
    await setPipeline(pipelineMode);
    const marker = `Recursion native ${pipelineMode} swipe proof ${Date.now()}. Continue with one short sentence.`;
    await sendVisible(marker);
    const before = await page.evaluate(nativeStateScript());
    if (!before.artifactHash || !before.packetId) {
      fail('prepared-artifact-missing', `${pipelineMode} did not commit a prepared artifact.`, { pipelineMode });
    }
    const swipe = page.locator(
      `.mes[mesid="${before.assistantMesId}"] .swipe_right, .mes[data-message-id="${before.assistantMesId}"] .swipe_right, #chat .mes:last-child .swipe_right`
    ).last();
    if (!(await swipe.isVisible().catch(() => false))) {
      fail('visible-swipe-unavailable', 'The native latest-assistant swipe control was not visible.', {
        pipelineMode,
        assistantMesId: before.assistantMesId
      });
    }
    await swipe.click({ timeout: timeoutMs });
    await page.waitForFunction((sequence) => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      return Number(view.lastCacheDecision?.sequence || 0) > Number(sequence || 0)
        && view.lastCacheDecision?.kind === 'prepared-generation'
        && view.lastCacheDecision?.decision === 'hit';
    }, Number(before.cacheDecision?.sequence || 0), { timeout: timeoutMs });
    await page.waitForFunction((previous) => {
      const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
      const chat = Array.isArray(context.chat) ? context.chat : [];
      const assistant = chat[previous.assistantIndex];
      const swipeCount = Array.isArray(assistant?.swipes) ? assistant.swipes.length : 0;
      const swipeId = Number(assistant?.swipe_id ?? assistant?.swipeId ?? 0);
      const runtimeView = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      return chat.length === previous.chatLength
        && runtimeView.hostGenerationActive !== true
        && !runtimeView.activeRunId
        && (swipeCount > previous.assistantSwipeCount || swipeId !== previous.assistantSwipeId);
    }, before, { timeout: timeoutMs });
    const after = await page.evaluate(nativeStateScript());
    const providerIdsBefore = new Set(before.providerJournalIds);
    const providerJournalDelta = after.providerJournalIds.filter((id) => !providerIdsBefore.has(id));
    const result = {
      pipelineMode,
      cacheKind: after.cacheDecision?.kind || '',
      cacheDecision: after.cacheDecision?.decision || '',
      cacheReason: after.cacheDecision?.reason || '',
      basisMode: after.cacheDecision?.basisMode || '',
      artifactHashStable: after.artifactHash === before.artifactHash,
      packetIdStable: after.packetId === before.packetId,
      handIdStable: after.handId === before.handId,
      preAssistantShapeStable: after.preAssistantShapeHash === before.preAssistantShapeHash,
      assistantRowStable: after.chatLength === before.chatLength && after.assistantIndex === before.assistantIndex,
      nativeSwipeAdvanced: after.assistantSwipeCount > before.assistantSwipeCount
        || after.assistantSwipeId !== before.assistantSwipeId,
      recursionJournalWrites: after.journalCount - before.journalCount,
      recursionProviderJournalEvents: providerJournalDelta.length,
      cachedFeedbackVisible: /reused|cached/i.test(after.statusText)
    };
    if (!result.artifactHashStable
      || !result.packetIdStable
      || !result.handIdStable
      || !result.preAssistantShapeStable
      || !result.assistantRowStable
      || !result.nativeSwipeAdvanced
      || result.recursionJournalWrites !== 0
      || result.recursionProviderJournalEvents !== 0
      || result.cacheKind !== 'prepared-generation'
      || result.cacheDecision !== 'hit') {
      fail('native-swipe-reuse-failed', `${pipelineMode} native swipe reuse proof failed.`, result);
    }
    results.push(result);
  }
  return {
    ok: results.length === pipelineModes.length && results.every((entry) => entry.cacheDecision === 'hit'),
    mode: 'native-host-playwright',
    pipelines: results
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const env = process.env;
  const user = assertPreflight(argv, env);
  const synthetic = argv.includes('--synthetic');
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const verifierOutput = [];
  const verifierExit = runInstalledCopyVerifierCli(['--user', user], {
    cwd: process.cwd(),
    environment: env,
    stdout: { write: (text) => verifierOutput.push(String(text)) },
    stderr: { write: (text) => verifierOutput.push(String(text)) }
  });
  if (verifierExit !== 0) {
    fail('stale-extension', 'Repository, installed, and served Recursion copies do not match.', {
      verifier: verifierOutput.join('').trim()
    });
  }
  const session = createSillyTavernHttpSession({
    baseUrl: env.SILLYTAVERN_BASE_URL,
    user,
    password: passwordForUser(user, env)
  });
  await session.init();
  await session.login();
  const browser = await chromium.launch({ headless: env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
  try {
    const context = await browser.newContext();
    await context.addCookies(session.playwrightCookies());
    await context.addInitScript(() => {
      globalThis.__recursionLiveHarness = true;
    });
    const page = await context.newPage();
    await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
    await page.waitForFunction(() => Boolean(globalThis.__recursionLiveHarnessRuntime), null, { timeout: timeoutMs });
    const pipelineModes = String(env.RECURSION_LIVE_SWIPE_PIPELINES || 'standard,rapid,fused')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => ['standard', 'rapid', 'fused'].includes(entry));
    if (pipelineModes.length === 0) fail('missing-pipelines', 'No valid swipe proof pipelines were configured.');
    const proof = synthetic
      ? await page.evaluate(proofScript())
      : await nativeProof(page, { timeoutMs, pipelineModes });
    if (!proof?.ok) fail('live-swipe-reuse-failed', 'Latest assistant swipe reuse proof failed.', proof || {});
    console.log(JSON.stringify({
      status: 'pass',
      result: 'live-swipe-reuse-pass',
      user,
      proofClassification: synthetic ? 'synthetic-served-module' : 'strict-native-host',
      proof
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'fail',
    result: error.result || 'live-swipe-reuse-error',
    error: error.message,
    details: error.details || null
  }, null, 2));
  process.exit(1);
});
