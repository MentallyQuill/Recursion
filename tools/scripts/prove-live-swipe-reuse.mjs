import { chromium } from 'playwright';
import {
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

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

async function main() {
  const argv = process.argv.slice(2);
  const env = process.env;
  const user = assertPreflight(argv, env);
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
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
    const proof = await page.evaluate(proofScript());
    if (!proof?.ok) fail('live-swipe-reuse-failed', 'Latest assistant swipe reuse proof failed.', proof || {});
    console.log(JSON.stringify({
      status: 'pass',
      result: 'live-swipe-reuse-pass',
      user,
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
