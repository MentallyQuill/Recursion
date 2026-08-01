import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  createRunId,
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';
import { assertLifecycleProof } from './lib/lifecycle-proof-contract.mjs';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_SERVED_ROOT = '/scripts/extensions/third-party/Recursion';

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
  if (!argv.includes('--live')) fail('dry-run', 'Pass --live to run against a dedicated SillyTavern user.');
  if (!env.SILLYTAVERN_BASE_URL) fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  const userResult = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  if (!userResult.ok) {
    fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', userResult);
  }
  return userResult.user;
}

function lifecycleProofScript() {
  return async (servedRoot) => {
    const [
      runtimeModule,
      settingsModule,
      storageModule,
      activityModule,
      postProcessModule,
      schedulerModule,
      coreModule
    ] = await Promise.all([
      import(`${servedRoot}/src/runtime.mjs`),
      import(`${servedRoot}/src/settings.mjs`),
      import(`${servedRoot}/src/storage.mjs`),
      import(`${servedRoot}/src/activity.mjs`),
      import(`${servedRoot}/src/post-process-runtime.mjs`),
      import(`${servedRoot}/src/execution/scheduler.mjs`),
      import(`${servedRoot}/src/core.mjs`)
    ]);

    const clone = (value) => value === undefined ? undefined : structuredClone(value);
    const waitUntil = async (predicate, message) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await predicate()) return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      }
      throw new Error(message);
    };
    const deferred = () => {
      let resolvePromise;
      let rejectPromise;
      const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      return { promise, resolve: resolvePromise, reject: rejectPromise };
    };
    const baseSnapshot = (chatKey = 'live-lifecycle') => ({
      chatId: chatKey,
      chatKey,
      sceneKey: `${chatKey}-scene`,
      sceneFingerprint: `${chatKey}-scene-fingerprint`,
      turnFingerprint: `${chatKey}-turn-fingerprint`,
      latestMesId: 2,
      messages: [
        { mesid: 1, role: 'assistant', text: 'The archive door remains sealed.', visible: true },
        { mesid: 2, role: 'user', text: 'Ask what the seal remembers.', visible: true }
      ]
    });
    const roleCounts = (calls) => calls.reduce((counts, call) => {
      counts[call.roleId] = (counts[call.roleId] || 0) + 1;
      return counts;
    }, {});
    const arbiterResponse = (request) => ({
      ok: true,
      data: {
        schema: 'recursion.utilityArbiter.v1',
        snapshotHash: request.snapshotHash,
        action: 'compose-brief',
        sceneStatus: 'same-scene',
        promptFootprint: 'compact',
        cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Lifecycle proof.' }],
        budgets: { targetBriefTokens: 500, maxCards: 1 },
        reasonerDecision: { mode: 'skip', reason: 'Lifecycle proof.', signals: [] },
        diagnostics: []
      }
    });
    const cardResponse = (roleId, request) => {
      const evidenceMesId = request?.snapshot?.messages
        ?.filter((message) => message?.role === 'user' || message?.is_user === true)
        ?.at(-1)?.mesid ?? 2;
      return {
        ok: true,
        roleId,
        data: {
          schema: 'recursion.card.v1',
          family: 'Scene Frame',
          role: roleId,
          snapshotHash: request.snapshotHash,
          items: [{
            promptText: 'Keep the response grounded in the active turn.',
            evidenceRefs: [`message:${evidenceMesId}`],
            tokenEstimate: 10
          }]
        }
      };
    };
    const guidanceResponse = (request) => ({
      ok: true,
      data: {
        schema: 'recursion.guidanceComposer.v1',
        snapshotHash: request.snapshotHash,
        guidanceText: 'Use the selected evidence for the active turn.',
        sourceCardIds: [],
        guardrailCardIds: [],
        omittedCardIds: [],
        diagnostics: []
      }
    });
    const immediateProvider = (calls) => ({
      async generate(roleId, request = {}) {
        calls.push({ roleId, request });
        if (roleId === 'utilityArbiter') return arbiterResponse(request);
        if (roleId === 'sceneFrameCard') return cardResponse(roleId, request);
        if (roleId === 'guidanceComposer') return guidanceResponse(request);
        throw new Error(`Unexpected lifecycle role: ${roleId}`);
      }
    });
    const createHarness = ({
      chatKey = 'live-lifecycle',
      currentSnapshot = baseSnapshot(chatKey),
      providerCalls = [],
      provider = immediateProvider(providerCalls),
      generation = {},
      settings = {}
    } = {}) => {
      let activeSnapshot = clone(currentSnapshot);
      const installs = [];
      let promptClears = 0;
      const settingsStore = settingsModule.createSettingsStore({ root: {} });
      settingsStore.update({
        enabled: true,
        mode: 'auto',
        pipelineMode: 'segmented',
        modelAttemptsPerStep: 2,
        reasoningLevel: 'low',
        reasonerUse: 'off',
        minCards: 1,
        maxCards: 1,
        ...settings
      });
      const storage = storageModule.createStorageRepository({
        storage: storageModule.createMemoryStorageAdapter()
      });
      const runtime = runtimeModule.createRecursionRuntime({
        settingsStore,
        storage,
        activity: activityModule.createActivityReporter(),
        generationRouter: provider,
        host: {
          async snapshot() {
            return clone(activeSnapshot);
          },
          prompt: {
            async install(packet) {
              installs.push(clone(packet));
              return { ok: true, installed: true };
            },
            async clear() {
              promptClears += 1;
              return { ok: true, cleared: true };
            }
          },
          messages: {},
          generation
        }
      });
      return {
        runtime,
        storage,
        providerCalls,
        installs,
        promptClears: () => promptClears,
        setSnapshot(snapshot) {
          activeSnapshot = clone(snapshot);
        }
      };
    };

    const baseCalls = [];
    const base = createHarness({ providerCalls: baseCalls });
    await base.runtime.prepareForGeneration({
      userMessage: { text: 'Ask what the seal remembers.', mesid: 2 },
      hostGeneration: true,
      generationType: 'normal'
    });
    const firstManifest = await base.storage.loadPipelineRun('live-lifecycle');
    const callsBeforeSwipe = baseCalls.length;
    const installsBeforeSwipe = base.installs.length;
    const firstPacketId = base.installs.at(-1)?.packetId;
    const withAssistant = {
      ...baseSnapshot(),
      latestMesId: 3,
      messages: [
        ...baseSnapshot().messages,
        { mesid: 3, role: 'assistant', text: 'First native response.', visible: true }
      ]
    };
    base.setSnapshot(withAssistant);
    await base.runtime.handleLatestAssistantSwipeRetry({ messageId: 3 });
    const swipeResult = await base.runtime.prepareForGeneration({ hostGeneration: true, generationType: 'swipe' });
    const swipeInstallDelta = base.installs.length - installsBeforeSwipe;
    const unchangedSwipe = {
      recursionModelCalls: baseCalls.length - callsBeforeSwipe,
      packetReinstalled: swipeInstallDelta === 1 && swipeResult?.reused === true,
      installDelta: swipeInstallDelta,
      runtimeReused: swipeResult?.reused === true,
      packetIdStable: base.installs.at(-1)?.packetId === firstPacketId,
      resultReason: String(swipeResult?.reason || ''),
      preparedMatch: swipeResult?.preparedMatch === true,
      executionState: String(swipeResult?.execution?.state || ''),
      classification: String(base.runtime.getView()?.turnScope?.generationClassification || ''),
      decision: base.runtime.getView()?.lastCacheDecision || null
    };

    const callsBeforeNewTurn = roleCounts(baseCalls);
    const secondUserSnapshot = {
      ...withAssistant,
      latestMesId: 4,
      messages: [
        ...withAssistant.messages,
        { mesid: 4, role: 'user', text: 'Ask what the seal remembers.', visible: true }
      ]
    };
    base.setSnapshot(secondUserSnapshot);
    await base.runtime.prepareForGeneration({
      userMessage: { text: 'Ask what the seal remembers.', mesid: 4 },
      hostGeneration: true,
      generationType: 'normal'
    });
    const secondManifest = await base.storage.loadPipelineRun('live-lifecycle');
    const callsAfterNewTurn = roleCounts(baseCalls);
    const newTurn = {
      arbiterCalls: Number(callsAfterNewTurn.utilityArbiter || 0) - Number(callsBeforeNewTurn.utilityArbiter || 0),
      turnKeyChanged: firstManifest.turnKeyHash !== secondManifest.turnKeyHash
    };

    const bandMessages = Array.from({ length: 14 }, (_, index) => ({
      mesid: index + 1,
      role: (index + 1) % 2 === 0 ? 'user' : 'assistant',
      text: index === 13 ? 'Hold this bounded turn.' : `bounded-message-${index + 1}`,
      visible: true
    }));
    const bandSnapshot = {
      ...baseSnapshot('live-edited-band'),
      latestMesId: 14,
      messages: bandMessages
    };
    const bandCalls = [];
    const band = createHarness({
      chatKey: 'live-edited-band',
      currentSnapshot: bandSnapshot,
      providerCalls: bandCalls,
      settings: { retention: { sourceWindowMessages: 12, sourceWindowCharacters: 12000 } }
    });
    await band.runtime.prepareForGeneration({
      userMessage: { text: 'Hold this bounded turn.', mesid: 14 },
      hostGeneration: true,
      generationType: 'normal'
    });
    const bandFirstManifest = await band.storage.loadPipelineRun('live-edited-band');
    const bandAssistant = { mesid: 15, role: 'assistant', text: 'First bounded response.', visible: true };
    band.setSnapshot({ ...bandSnapshot, latestMesId: 15, messages: [...bandMessages, bandAssistant] });
    await band.runtime.queueStageReprocess({ stageId: 'preprocess.cards.segmented.scene-frame' });
    band.setSnapshot({
      ...bandSnapshot,
      latestMesId: 15,
      messages: [
        ...bandMessages.map((message) => message.mesid === 5
          ? { ...message, text: 'Edited inside the bounded band.' }
          : message),
        bandAssistant
      ]
    });
    await band.runtime.handleLatestAssistantSwipeRetry({ messageId: 15 });
    await band.runtime.prepareForGeneration({ hostGeneration: true, generationType: 'swipe' });
    const bandEditedManifest = await band.storage.loadPipelineRun('live-edited-band');
    const editedBandSwipe = {
      reuseRejected: bandEditedManifest.operationId !== bandFirstManifest.operationId
        && band.runtime.getView().turnScope.generationClassification === 'source-band-edited',
      queuedIntentCanceled: await band.storage.loadQueuedReprocess('live-edited-band', 'preprocess') === null
    };

    const queueCalls = [];
    const queued = createHarness({ chatKey: 'live-queued-swipe', providerCalls: queueCalls });
    await queued.runtime.prepareForGeneration({
      userMessage: { text: 'Ask what the seal remembers.', mesid: 2 },
      hostGeneration: true,
      generationType: 'normal'
    });
    const queuedAssistant = {
      ...baseSnapshot('live-queued-swipe'),
      latestMesId: 3,
      messages: [
        ...baseSnapshot('live-queued-swipe').messages,
        { mesid: 3, role: 'assistant', text: 'Queued proof response.', visible: true }
      ]
    };
    queued.setSnapshot(queuedAssistant);
    const countsBeforeReprocess = roleCounts(queueCalls);
    await queued.runtime.queueStageReprocess({ stageId: 'preprocess.cards.segmented.scene-frame' });
    await queued.runtime.prepareForGeneration({ hostGeneration: true, generationType: 'swipe' });
    const countsAfterReprocess = roleCounts(queueCalls);
    const reprocessSwipe = {
      selectedStageCalls: Number(countsAfterReprocess.sceneFrameCard || 0) - Number(countsBeforeReprocess.sceneFrameCard || 0),
      intentConsumed: await queued.storage.loadQueuedReprocess('live-queued-swipe', 'preprocess') === null
    };

    const countsBeforeFresh = roleCounts(queueCalls);
    await queued.runtime.queueFullFreshSwipe({ source: 'live-lifecycle-proof' });
    await queued.runtime.prepareForGeneration({ hostGeneration: true, generationType: 'swipe' });
    const countsAfterFresh = roleCounts(queueCalls);
    const fullFreshSwipe = {
      arbiterCalls: Number(countsAfterFresh.utilityArbiter || 0) - Number(countsBeforeFresh.utilityArbiter || 0),
      requestedCardCalls: Number(countsAfterFresh.sceneFrameCard || 0) - Number(countsBeforeFresh.sceneFrameCard || 0)
    };

    const stopCalls = [];
    const hostStarts = [];
    const hostStops = [];
    const cardGate = deferred();
    let gatedCardRequest = null;
    const stopProvider = {
      async generate(roleId, request = {}) {
        stopCalls.push({ roleId, request });
        if (roleId === 'utilityArbiter') return arbiterResponse(request);
        if (roleId === 'sceneFrameCard') {
          gatedCardRequest = request;
          return cardGate.promise;
        }
        if (roleId === 'guidanceComposer') return guidanceResponse(request);
        throw new Error(`Unexpected stop role: ${roleId}`);
      }
    };
    const stopped = createHarness({
      chatKey: 'live-stop-resume',
      currentSnapshot: baseSnapshot('live-stop-resume'),
      providerCalls: stopCalls,
      provider: stopProvider,
      generation: {
        async start(details = {}) {
          hostStarts.push(clone(details));
          return { ok: true, started: true };
        },
        async stop(details = {}) {
          hostStops.push(clone(details));
          return { ok: true, stopped: true, eventEmitted: false };
        }
      }
    });
    const preparing = stopped.runtime.prepareForGeneration({
      hostGeneration: true,
      generationType: 'swipe'
    });
    await waitUntil(() => gatedCardRequest !== null, 'Stop proof did not reach the gated card stage.');
    await stopped.runtime.stopGeneration({ source: 'live-lifecycle-proof' });
    const pausedManifest = await stopped.storage.loadPipelineRun('live-stop-resume');
    const stop = {
      hostStopCalls: hostStops.length,
      promptClears: stopped.promptClears(),
      state: pausedManifest?.state || ''
    };
    const providerCallsBeforeResume = stopCalls.length;
    await stopped.runtime.resumeOperation({ operationId: pausedManifest.operationId });
    const resume = {
      hostStartCalls: hostStarts.length,
      detachedProviderCalls: stopCalls.length - providerCallsBeforeResume
    };
    cardGate.resolve(cardResponse('sceneFrameCard', gatedCardRequest));
    await preparing.catch(() => {});

    const category = { id: 'natural-prose', name: 'Natural Prose', description: 'Proof category.', enabled: true };
    const postDeck = {
      id: 'live-response-identity-deck',
      name: 'Live response identity deck',
      categoryOrder: ['natural-prose'],
      categories: { 'natural-prose': category },
      cardOrderByCategory: { 'natural-prose': ['natural-prose-card'] },
      cards: {
        'natural-prose-card': {
          id: 'natural-prose-card',
          categoryId: 'natural-prose',
          name: 'Natural Prose',
          description: 'Proof card.',
          promptText: 'Improve the prose without changing events.',
          enabled: true
        }
      }
    };
    const postSettings = {
      reasoningLevel: 'medium',
      modelAttemptsPerStep: 2,
      postProcess: { enabled: true, applyMode: 'as-swipe', rewriteFlow: 'unified', contextMessages: 13 },
      postProcessDecks: { activeDeckId: postDeck.id, customDecks: {} }
    };
    const responseSnapshot = (draft, swipeId) => ({
      chatKey: 'live-response-identity',
      chatIdentityHash: 'live-response-identity-chat',
      sourceMessageId: 12,
      sourceSwipeId: swipeId,
      sourceHash: coreModule.hashJson(draft),
      snapshotHash: '',
      originalDraft: draft,
      activeCharacterHash: 'live-character',
      activeGroupHash: '',
      supportingContext: {
        latestUserMessage: 'Continue.',
        boundedPriorMessages: [],
        characterContext: '',
        preProcessPromptPacket: { packetId: 'live-response-packet' },
        storyForm: { tense: 'past', pov: 'third-person-limited' }
      }
    });
    let activeResponseSnapshot = responseSnapshot('First response.', 0);
    const postStorage = storageModule.createStorageRepository({
      storage: storageModule.createMemoryStorageAdapter()
    });
    const postScheduler = schedulerModule.createExecutionScheduler({
      repository: postStorage,
      attemptsPerStep: 2
    });
    const postRuntime = postProcessModule.createPostProcessRuntime({
      host: {
        generation: {
          async rewriteWithPostProcess(input) {
            return { ok: true, text: `${input.originalDraft} Refined.` };
          }
        }
      },
      generationRouter: {
        async generate(_roleId, request) {
          return {
            ok: true,
            data: {
              schema: 'recursion.postProcessGuidance.v1',
              snapshotHash: request.snapshotHash,
              sourceHash: request.sourceHash,
              guidanceText: 'Apply the selected proof card.'
            }
          };
        }
      },
      settingsStore: { get: () => postSettings },
      snapshotProvider: async () => activeResponseSnapshot,
      deckProvider: async () => postDeck,
      sourceGuard: async () => true,
      commitResult: async ({ commitId, finalArtifactHash }) => ({
        ok: true,
        applied: true,
        receipt: { commitId, finalArtifactHash }
      }),
      durableExecution: { scheduler: postScheduler, repository: postStorage }
    });
    postRuntime.preparePostProcessTrigger({
      preprocessTurnKeyHash: 'live-response-turn',
      generationType: 'normal',
      requireFinalTargetVerification: false
    });
    const firstPost = await postRuntime.runPostProcessForLatestAssistant();
    activeResponseSnapshot = responseSnapshot('Second response.', 1);
    postRuntime.preparePostProcessTrigger({
      preprocessTurnKeyHash: 'live-response-turn',
      generationType: 'swipe',
      requireFinalTargetVerification: false
    });
    const secondPost = await postRuntime.runPostProcessForLatestAssistant();
    const postProcess = {
      responseIdentityChanged: firstPost.execution.provenance.responseIdentityHash
        !== secondPost.execution.provenance.responseIdentityHash,
      priorRewriteReused: Number(secondPost.reusedResponseArtifactCount || 0) > 0
    };

    return {
      newTurn,
      unchangedSwipe,
      editedBandSwipe,
      reprocessSwipe,
      fullFreshSwipe,
      stop,
      resume,
      postProcess
    };
  };
}

async function main() {
  const env = process.env;
  const user = assertPreflight(process.argv.slice(2), env);
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const servedRoot = String(env.RECURSION_SERVED_EXTENSION_PATH || DEFAULT_SERVED_ROOT).replace(/\/$/, '');
  const runId = createRunId('resumable-pipeline-proof');
  const artifactDir = resolve('artifacts', 'live-resumable-pipeline', runId);
  mkdirSync(artifactDir, { recursive: true });

  const session = createSillyTavernHttpSession({
    baseUrl: env.SILLYTAVERN_BASE_URL,
    user,
    password: passwordForUser(user, env)
  });
  await session.init();
  await session.login();

  const browser = await chromium.launch({ headless: env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
    await context.addCookies(session.playwrightCookies());
    const page = await context.newPage();
    await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const proof = await page.evaluate(lifecycleProofScript(), servedRoot);
    try {
      assertLifecycleProof(proof);
    } catch (error) {
      fail('live-lifecycle-contract-failed', error.message, { proof });
    }
    const report = {
      status: 'pass',
      result: 'live-resumable-pipeline-pass',
      user,
      runId,
      servedRoot,
      provider: 'deterministic served-module fixture; no external model calls',
      proof
    };
    const reportPath = resolve(artifactDir, 'report.json');
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'fail',
    result: error.result || 'live-resumable-pipeline-error',
    error: error.message,
    details: error.details || null
  }, null, 2));
  process.exit(1);
});
