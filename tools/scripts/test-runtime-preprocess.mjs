import { createActivityReporter } from '../../src/activity.mjs';
import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { providerConfigHash } from '../../src/provider-capability.mjs';
import {
  createMemoryStorageAdapter,
  createStorageRepository
} from '../../src/storage.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function snapshot(chatKey = 'chat-preprocess') {
  return {
    chatId: chatKey,
    chatKey,
    sceneKey: 'scene-preprocess',
    sceneFingerprint: 'scene-preprocess-fingerprint',
    turnFingerprint: 'turn-preprocess-fingerprint',
    sourceRevisionHash: 'source-preprocess-revision',
    latestMesId: 2,
    messages: [
      { mesid: 1, role: 'assistant', text: 'Mara waits beside the sealed archive.', visible: true },
      { mesid: 2, role: 'user', text: 'I ask what she remembers.', visible: true }
    ]
  };
}

function createHarness({
  storage = createStorageRepository({ storage: createMemoryStorageAdapter() }),
  provider = null,
  currentSnapshot = snapshot(),
  installPrompt = null,
  hostGeneration = {},
  settings = {},
  utilityCertification = 'pass'
} = {}) {
  const calls = { install: 0, clear: 0, snapshotOptions: [] };
  let hostSnapshot = clone(currentSnapshot);
  const settingsStore = createSettingsStore({ root: {} });
  settingsStore.update({
    pipelineMode: 'segmented',
    modelAttemptsPerStep: 2,
    reasoningLevel: 'low',
    // Lifecycle fixtures request one card unless the scenario specifies a larger hand.
    minCards: 1,
    maxCards: 1,
    reasonerUse: 'off',
    ...settings
  });
  const explicitUtility = settings?.providers?.utility || {};
  if (!Object.prototype.hasOwnProperty.call(explicitUtility, 'connectionProfileId')) {
    settingsStore.updateProviderConfig('utility', { connectionProfileId: 'utility-profile' });
  }
  const utilityProvider = settingsStore.get().providers.utility;
  if (utilityProvider.connectionProfileId && ['pass', 'partial', 'fail'].includes(utilityCertification)) {
    const full = utilityCertification === 'pass';
    const segmented = full || utilityCertification === 'partial';
    settingsStore.recordProviderCertification('utility', {
      status: utilityCertification,
      checkedAt: '2026-08-06T00:00:00.000Z',
      completionMode: 'chat',
      structuredOutput: 'prompt-json',
      checks: {
        connectivity: 'pass',
        singleCard: segmented ? 'pass' : 'fail',
        fusedCards: full ? 'pass' : (segmented ? 'fail' : 'not-run')
      },
      safeConcurrency: 1,
      diagnosticCodes: segmented && !full ? ['fused-certification-failed'] : []
    }, {
      configHash: providerConfigHash(utilityProvider),
      configRevision: utilityProvider.configRevision
    });
  }
  const host = {
    providerProfiles: {
      list() {
        return ['utility', 'reasoner'].map((lane) => {
          const id = settingsStore.get().providers[lane].connectionProfileId;
          return id ? { id, name: `${lane} profile`, completionMode: 'chat' } : null;
        }).filter(Boolean);
      }
    },
    async snapshot(options = {}) {
      calls.snapshotOptions.push(clone(options));
      return clone(hostSnapshot);
    },
    prompt: {
      async install(packet) {
        calls.install += 1;
        if (typeof installPrompt === 'function') return installPrompt(packet);
        return { ok: true, installed: true };
      },
      async clear() {
        calls.clear += 1;
        return { ok: true, cleared: true };
      }
    },
    messages: {},
    generation: hostGeneration
  };
  const runtime = createRecursionRuntime({
    host,
    settingsStore,
    storage,
    activity: createActivityReporter(),
    generationRouter: provider
  });
  return {
    runtime,
    storage,
    calls,
    setSnapshot(value) {
      hostSnapshot = clone(value);
    }
  };
}

function arbiterResponse(request, cardJobs = [{
  family: 'Scene Frame',
  role: 'sceneFrameCard',
  reason: 'Preserve current beat.'
}]) {
  return {
    ok: true,
    data: {
      schema: 'recursion.utilityArbiter.v1',
      snapshotHash: request.snapshotHash,
      action: 'compose-brief',
      sceneStatus: 'same-scene',
      promptFootprint: 'normal',
      cardJobs,
      budgets: { targetBriefTokens: 500, maxCards: 4 },
      reasonerDecision: { mode: 'skip', reason: 'unit durable preprocess', signals: [] },
      diagnostics: []
    }
  };
}

function cardResponse(roleId, request, {
  family = roleId === 'activeCastCard' ? 'Active Cast' : 'Scene Frame'
} = {}) {
  return {
    ok: true,
    roleId,
    data: {
      schema: 'recursion.card.v1',
      family,
      role: roleId,
      snapshotHash: request.snapshotHash,
      items: [{
        promptText: `Keep the current ${family.toLowerCase()} evidence grounded in the visible scene.`,
        evidenceRefs: ['message:2'],
        tokenEstimate: 18
      }]
    }
  };
}

function guidanceResponse(request) {
  return {
    ok: true,
    data: {
      schema: 'recursion.guidanceComposer.v1',
      snapshotHash: request.snapshotHash,
      guidanceText: 'Keep Mara at the archive and answer the immediate question.',
      sourceCardIds: [],
      guardrailCardIds: [],
      omittedCardIds: [],
      diagnostics: []
    }
  };
}

function immediateProvider(calls = []) {
  return {
    async generate(roleId, request = {}) {
      calls.push({ roleId, request });
      if (roleId === 'utilityArbiter') {
        return arbiterResponse(request);
      }
      if (roleId === 'sceneFrameCard') {
        return cardResponse(roleId, request);
      }
      if (roleId === 'guidanceComposer') {
        return guidanceResponse(request);
      }
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
}

function roleCounts(calls = []) {
  return calls.reduce((counts, call) => {
    counts[call.roleId] = (counts[call.roleId] || 0) + 1;
    return counts;
  }, {});
}

{
  const calls = [];
  let bundleAttempts = 0;
  const harness = createHarness({ settings: { pipelineMode: 'fused', minCards: 8, maxCards: 8 }, provider: {
    async generate(roleId, request) {
      calls.push(roleId);
      if (roleId === 'utilityArbiter') return arbiterResponse(request);
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      if (roleId === 'fusedCardBundle') {
        bundleAttempts += 1;
        if (bundleAttempts <= 2) return { ok: false, error: {
          code: 'RECURSION_PROVIDER_RATE_LIMIT', category: 'capacity', retryable: true, retryAfterMs: 0
        } };
        return { ok: true, data: { items: request.requestedCards.map(card => ({
          family: card.family, promptText: 'Keep Mara beside the sealed archive.', evidenceRefs: ['message:2']
        })) } };
      }
      throw new Error('Rate-limited Fused request must not fan out: ' + roleId);
    }
  } });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Please explain.', hostGeneration: true });
  assertEqual(result.ok, true, 'two Fused rate limits recover through the real preparation pipeline');
  assertEqual(harness.runtime.view().lastHand.cards.length, 8, 'all eight planned families reach the hand');
  assertEqual(harness.calls.install, 1, 'recovered preparation installs exactly one complete packet');
  assertDeepEqual(calls, ['utilityArbiter', 'fusedCardBundle', 'fusedCardBundle', 'fusedCardBundle', 'guidanceComposer'], 'capacity recovery adds no Segmented calls');
  const manifest = await harness.storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.recoveryBudget.recoveryUsed, 0, 'real Fused capacity recovery preserves the card repair budget');
}

// Formatting must survive provider validation, durable checkpoints, hand selection, and injection.
for (const pipelineMode of ['fused', 'segmented']) {
  const promptText = 'Scene guidance:\n1. Keep the response grounded in what Mara had already established about the damaged hatch, the completed pressure test, the missing maintenance records, and the crew waiting beside the sealed door.\n2. Preserve the completed inspection.';
  const calls = [];
  const harness = createHarness({ settings: { pipelineMode }, provider: {
    async generate(roleId, request) {
      calls.push(roleId);
      if (roleId === 'utilityArbiter') return arbiterResponse(request);
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      const card = { promptText, evidenceRefs: ['message:2'] };
      if (roleId === 'fusedCardBundle') return { ok: true, data: { items: [{ family: 'Scene Frame', ...card }] } };
      if (roleId === 'sceneFrameCard') return { ok: true, data: card };
      throw new Error('Unexpected role: ' + roleId);
    }
  } });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Please explain.', hostGeneration: true });
  assertEqual(result.ok, true, pipelineMode + ' accepts formatted instruction evidence throughout preparation');
  assertEqual(harness.runtime.view().lastHand.cards[0].promptText, promptText, 'hand retains original instruction lines');
  assert(result.packet.sections.cardEvidence.includes('\n  2. Preserve the completed inspection.'), 'prompt injection preserves the final instruction line');
  assertEqual(calls.filter(role => role === 'sceneFrameCard').length, pipelineMode === 'segmented' ? 1 : 0, 'valid Fused instructions never trigger individual repair');
  const manifest = await harness.storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.recoveryBudget.recoveryUsed, 0, 'formatting causes no retry or recovery charge');
  const savedHand = await harness.storage.loadPipelineArtifact('chat-preprocess', manifest.operationId,
    manifest.stageRecords['preprocess.hand'].checkpoint.artifactRef.artifactId);
  assertEqual(savedHand.cards[0].promptText, promptText, 'durable hand artifact retains instruction boundaries');

}

// Refinement is required analysis of the selected result before Guidance.
{
  const calls = [];
  const harness = createHarness({
    settings: {
      providers: { reasoner: { connectionProfileId: 'reasoner-profile' } },
      preProcessDecks: { activeDeckId: 'default', defaultCardStates: {
        'realismCard:claimsNeedCorroboration': 'refinement'
      } }
    },
    provider: { async generate(roleId, request) {
      calls.push({ roleId, request });
      if (roleId === 'utilityArbiter') return arbiterResponse(request, [{ family: 'Realism', reason: 'Check the claim.' }]);
      if (roleId === 'cardRefinementReview') return { ok: true, data: {
        schema: request.responseSchema, snapshotHash: request.snapshotHash,
        items: request.refinementTargetIds.map(targetId => ({ targetId, verdict: 'accept', assessment: {
          status: 'satisfied', summary: 'The guidance keeps the visible question grounded.', evidenceRefs: request.validEvidenceRefs.slice(0, 1), supportingCardIds: request.refinementCardIds.slice(0, 1)
        }, findings: [] }))
      } };
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      return cardResponse(roleId, request, { family: request.metadata?.family || 'Realism' });
    } }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'What do you mean?' });
  assertEqual(result.ok, true, 'refinement prepares successfully');
  const roles = calls.map(call => call.roleId);
  assertEqual(roles.filter(role => role === 'cardRefinementReview').length, 1, 'marked card gets exactly one required review when accepted');
  assert(roles.indexOf('cardRefinementReview') < roles.indexOf('guidanceComposer'), 'review finishes before Guidance');
  assertEqual(harness.runtime.view().lastHand.metadata.refinement.targetCount, 1, 'accepted hand exposes per-source review coverage');
}

{
  const activationAdapter = createMemoryStorageAdapter();
  await activationAdapter.writeJson('recursion-scene-chat-preprocess-retired.v1.json', {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1
  });
  const activationStorage = createStorageRepository({ storage: activationAdapter });
  const { runtime } = createHarness({ storage: activationStorage });
  for (const method of [
    'restoreExecutionState',
    'pauseOperation',
    'resumeOperation',
    'retryStage',
    'queueStageReprocess',
    'cancelQueuedStageReprocess',
    'queueFullFreshSwipe',
    'clearQueuedFullFreshSwipe',
    'getView'
  ]) {
    assert(typeof runtime[method] === 'function', `runtime exposes ${method}`);
  }
  const restored = await runtime.restoreExecutionState();
  assertEqual(restored, null, 'empty chat has no durable operation to restore');
  assertEqual(
    await activationAdapter.readJson('recursion-scene-chat-preprocess-retired.v1.json'),
    null,
    'runtime activation prunes retired generated records before restore'
  );
  assertEqual(runtime.getView().execution, null, 'empty restore does not manufacture execution state');
  assertEqual(runtime.getView().queuedReprocess, null, 'empty restore has no queued reprocess intent');
}

{
  const firstCardGate = deferred();
  const resumedCardGate = deferred();
  const calls = [];
  const hostGenerationStarts = [];
  const hostGenerationStops = [];
  let cardCalls = 0;
  const provider = {
    async generate(roleId, request = {}) {
      calls.push({ roleId, signal: request.signal });
      if (roleId === 'utilityArbiter') {
        return {
          ok: true,
          data: {
            schema: 'recursion.utilityArbiter.v1',
            snapshotHash: request.snapshotHash,
            action: 'compose-brief',
            sceneStatus: 'same-scene',
            promptFootprint: 'normal',
            cardJobs: [
              { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Preserve current beat.' }
            ],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            reasonerDecision: { mode: 'skip', reason: 'unit durable preprocess', signals: [] },
            diagnostics: []
          }
        };
      }
      if (roleId === 'sceneFrameCard') {
        cardCalls += 1;
        return cardCalls === 1 ? firstCardGate.promise : resumedCardGate.promise;
      }
      if (roleId === 'guidanceComposer') {
        return {
          ok: true,
          data: {
            schema: 'recursion.guidanceComposer.v1',
            snapshotHash: request.snapshotHash,
            guidanceText: 'Keep Mara at the archive and answer the immediate question.',
            sourceCardIds: [],
            guardrailCardIds: [],
            omittedCardIds: [],
            diagnostics: []
          }
        };
      }
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage, calls: hostCalls } = createHarness({
    provider,
    hostGeneration: {
      async start(details = {}) {
        hostGenerationStarts.push(details);
        return { ok: true, started: true };
      },
      async stop(details = {}) {
        hostGenerationStops.push(details);
        return { ok: true, stopped: true, eventEmitted: false };
      }
    }
  });
  const preparing = runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'swipe'
  });
  try {
    await waitUntil(
      () => calls.some((call) => call.roleId === 'sceneFrameCard'),
      'Segmented card stage did not start'
    );
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify({
      calls,
      view: runtime.getView().execution,
      manifest: await storage.loadPipelineRun('chat-preprocess')
    })}`);
  }
  await runtime.stopGeneration({ source: 'recursion-progress-row' });
  const pausedView = runtime.getView();
  assertEqual(pausedView.execution.state, 'paused', 'Stop pauses the durable operation');
  assertEqual(
    pausedView.activity.label,
    'Generation canceled. Recursion prompt cleared.',
    'unified Stop settles only after host cleanup'
  );
  assertEqual(hostGenerationStops.length, 1, 'contextual Stop requests one native host stop');
  assertEqual(hostCalls.clear, 1, 'contextual Stop clears the host prompt lane once');
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.stageRecords['preprocess.arbiter'].state, 'completed', 'Arbiter checkpoint survives Stop');
  assertEqual(
    manifest.stageRecords['preprocess.cards.segmented.scene-frame'].state,
    'pending',
    'interrupted Segmented card returns to pending'
  );
  assertEqual(calls.find((call) => call.roleId === 'sceneFrameCard').signal.aborted, true, 'Stop aborts the in-flight card call');
  firstCardGate.resolve({
    ok: true,
    roleId: 'sceneFrameCard',
    data: {
      schema: 'recursion.card.v1',
      family: 'Scene Frame',
      role: 'sceneFrameCard',
      snapshotHash: 'late-result',
      items: []
    }
  });
  await preparing;

  const callsBeforeResume = cardCalls;
  const resumeRequest = await runtime.resumeOperation({ operationId: manifest.operationId });
  assertEqual(resumeRequest.started, true, 'Resume requests native host generation');
  assertDeepEqual(hostGenerationStarts, [{
    type: 'swipe',
    source: 'recursion-ui',
    reason: 'resume-operation'
  }], 'Resume preserves the paused native generation type');
  assertEqual(cardCalls, callsBeforeResume, 'Resume click starts no detached provider work');
  const resumed = runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'swipe'
  });
  await waitUntil(() => cardCalls === 2, 'Resume did not open a fresh card attempt window');
  assertEqual(
    calls.filter((call) => call.roleId === 'utilityArbiter').length,
    1,
    'Resume reuses the committed Arbiter checkpoint'
  );
  const resumedRequest = calls.filter((call) => call.roleId === 'sceneFrameCard').at(-1);
  resumedCardGate.resolve({
    ok: true,
    roleId: 'sceneFrameCard',
    data: {
      schema: 'recursion.card.v1',
      family: 'Scene Frame',
      role: 'sceneFrameCard',
      snapshotHash: runtime.getView().lastPlan.snapshotHash,
      items: [{
        promptText: 'Keep Mara beside the sealed archive and preserve the immediate question.',
        evidenceRefs: ['message:2'],
        tokenEstimate: 18
      }]
    }
  });
  await resumed;
  const completed = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(
    completed.stageRecords['preprocess.cards.segmented.scene-frame'].state,
    'completed',
    'Resume completes only the interrupted Segmented card'
  );
  assertEqual(resumedRequest.signal.aborted, false, 'Resume uses a fresh non-aborted provider signal');
}

{
  const cardGate = deferred();
  const providerCalls = [];
  const harness = createHarness({
    provider: {
      async generate(roleId, request = {}) {
        providerCalls.push(roleId);
        if (roleId === 'utilityArbiter') return arbiterResponse(request);
        if (roleId === 'sceneFrameCard') return cardGate.promise;
        throw new Error(`unexpected provider role ${roleId}`);
      }
    },
    hostGeneration: {
      async start() {
        return {
          ok: false,
          started: false,
          error: { code: 'RECURSION_TEST_HOST_START_FAILED', message: 'CANARY_HOST_ERROR_BODY' }
        };
      }
    }
  });
  const preparing = harness.runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'swipe'
  });
  await waitUntil(() => providerCalls.includes('sceneFrameCard'), 'host-start failure setup did not reach card stage');
  await harness.runtime.pauseOperation({ reason: 'user-stop' });
  cardGate.resolve(cardResponse('sceneFrameCard', { snapshotHash: 'late-paused-result' }));
  await preparing;
  const paused = await harness.storage.loadPipelineRun('chat-preprocess');
  const callsBeforeResume = providerCalls.length;
  const resume = await harness.runtime.resumeOperation({ operationId: paused.operationId });
  assertEqual(resume.ok, false, 'failed native Resume start is returned to the UI');
  assertEqual(resume.started, false, 'failed native Resume never claims a host generation');
  assertEqual(providerCalls.length, callsBeforeResume, 'failed native Resume starts zero detached provider calls');
  assertEqual(
    (await harness.storage.loadPipelineRun('chat-preprocess')).state,
    'paused',
    'failed native Resume leaves the manifest paused'
  );
  assert(
    harness.runtime.getView().turnScope.diagnosticCodes.includes('host-resume-start-failed'),
    'failed native Resume exposes only the bounded failure code'
  );
  assert(!JSON.stringify(harness.runtime.getView()).includes('CANARY_HOST_ERROR_BODY'), 'host start error bodies stay out of the runtime view');
}

{
  const cardGate = deferred();
  const hostStopGate = deferred();
  const hostGenerationStarts = [];
  let hostStopCalls = 0;
  const harness = createHarness({
    provider: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') return arbiterResponse(request);
        if (roleId === 'sceneFrameCard') return cardGate.promise;
        throw new Error(`unexpected provider role ${roleId}`);
      }
    },
    hostGeneration: {
      async stop() {
        hostStopCalls += 1;
        return hostStopGate.promise;
      },
      async start(details) {
        hostGenerationStarts.push(clone(details));
        return { ok: true, started: true, completed: false };
      }
    }
  });
  const preparing = harness.runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'normal'
  });
  await waitUntil(() => harness.runtime.getView().execution?.stages?.some((stage) => (
    stage.stageId === 'preprocess.cards.segmented.scene-frame' && stage.state === 'running'
  )), 'stop race setup did not reach the card stage');
  const stopping = harness.runtime.stopGeneration({ source: 'recursion-progress-row' });
  await waitUntil(() => harness.runtime.getView().execution?.state === 'paused', 'stop race did not expose paused state');
  const pausedOperationId = harness.runtime.getView().execution.operationId;
  const resuming = harness.runtime.resumeOperation({ operationId: pausedOperationId });
  await Promise.resolve();
  assertEqual(hostGenerationStarts.length, 0, 'Resume waits while native Stop cleanup is active');
  cardGate.resolve(cardResponse('sceneFrameCard', { snapshotHash: 'stopped-result' }));
  await waitUntil(() => hostStopCalls === 1, 'native Stop was not requested after provider settlement');
  assertEqual(hostGenerationStarts.length, 0, 'Resume remains queued until native Stop settles');
  hostStopGate.resolve({ ok: true, stopped: true, eventEmitted: true });
  await stopping;
  const resumed = await resuming;
  assertEqual(resumed.started, true, 'queued Resume starts after native Stop cleanup settles');
  assertEqual(hostGenerationStarts.length, 1, 'Stop cleanup cannot cancel a newly resumed host generation');
  await preparing;
}

{
  const hostGenerationStarts = [];
  let arbiterCalls = 0;
  const harness = createHarness({
    settings: { modelAttemptsPerStep: 1 },
    provider: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          arbiterCalls += 1;
          if (arbiterCalls === 1) {
            throw Object.assign(new Error('first Arbiter window failed'), {
              code: 'RECURSION_TEST_ARBITER_FAILED',
              retryable: false
            });
          }
          return arbiterResponse(request);
        }
        if (roleId === 'guidanceComposer') return guidanceResponse(request);
        if (roleId === 'sceneFrameCard') return cardResponse(roleId, request);
        throw new Error(`unexpected provider role ${roleId}`);
      }
    },
    hostGeneration: {
      async start(details) {
        hostGenerationStarts.push(clone(details));
        return { ok: true, started: true, completed: false };
      }
    }
  });
  await harness.runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'swipe'
  });
  const failed = await harness.storage.loadPipelineRun('chat-preprocess');
  assertEqual(failed.state, 'paused', 'blocking Arbiter failure pauses before manual Retry');
  const retried = await harness.runtime.retryStage({
    operationId: failed.operationId,
    stageId: 'preprocess.arbiter'
  });
  assertEqual(retried.execution.state, 'completed', 'manual Retry completes the durable pre-process operation');
  assertDeepEqual(hostGenerationStarts, [{
    type: 'swipe',
    source: 'recursion-ui',
    reason: 'retry-stage'
  }], 'completed Retry restarts the owning native host generation');
}

{
  const storage = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const cardGate = deferred();
  const firstCalls = [];
  const firstProvider = {
    async generate(roleId, request = {}) {
      firstCalls.push(roleId);
      if (roleId === 'utilityArbiter') return arbiterResponse(request);
      if (roleId === 'sceneFrameCard') return cardGate.promise;
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const first = createHarness({ storage, provider: firstProvider });
  const preparing = first.runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  await waitUntil(
    () => firstCalls.includes('sceneFrameCard'),
    'card stage did not start before reload simulation'
  );
  await first.runtime.pauseOperation({ reason: 'reload-test' });
  cardGate.resolve(cardResponse('sceneFrameCard', {
    snapshotHash: first.runtime.getView().lastPlan.snapshotHash
  }));
  await preparing;

  const saved = await storage.loadPipelineRun('chat-preprocess');
  const stageId = 'preprocess.cards.segmented.scene-frame';
  await storage.savePipelineRun('chat-preprocess', {
    ...saved,
    state: 'running',
    frontierStageIds: [],
    stageRecords: {
      ...saved.stageRecords,
      [stageId]: {
        ...saved.stageRecords[stageId],
        state: 'running',
        executionToken: 'interrupted-by-reload'
      }
    }
  });

  const restoredCalls = [];
  const restoredHostStarts = [];
  const restoredRuntime = createHarness({
    storage,
    provider: immediateProvider(restoredCalls),
    hostGeneration: {
      async start(details = {}) {
        restoredHostStarts.push(details);
        return { ok: true, started: true };
      }
    }
  }).runtime;
  const restored = await restoredRuntime.restoreExecutionState();
  assertEqual(restored.state, 'paused', 'restoring a running manifest exposes a paused operation');
  assertEqual(
    restored.stageRecords[stageId].state,
    'pending',
    'restore converts an interrupted running stage back to pending'
  );
  assertDeepEqual(restored.frontierStageIds, [stageId], 'restore exposes the interrupted pending stage as the visible Resume frontier');
  assertEqual(restoredCalls.length, 0, 'restore never starts provider work');
  const started = await restoredRuntime.resumeOperation({
    operationId: restored.operationId
  });
  assertEqual(started.started, true, 'reload Resume requests native generation');
  assertEqual(restoredCalls.length, 0, 'reload Resume starts no provider work outside the interceptor');
  assertDeepEqual(restoredHostStarts, [{
    type: 'normal',
    source: 'recursion-ui',
    reason: 'resume-operation'
  }], 'reload Resume preserves the original normal generation type');
  const resumed = await restoredRuntime.prepareForGeneration({
    userMessage: { text: 'I ask what she remembers.', mesid: 2 },
    hostGeneration: true,
    generationType: 'normal'
  });
  assertEqual(resumed.ok, true, 'a reloaded operation resumes through prompt settlement');
  assertEqual(
    restoredCalls.filter((entry) => entry.roleId === 'utilityArbiter').length,
    0,
    'reload Resume reuses the persisted Arbiter artifact'
  );
  assertEqual(
    restoredCalls.filter((entry) => entry.roleId === 'sceneFrameCard').length,
    1,
    'reload Resume reruns only the interrupted card'
  );
  const callsAfterResumeSettlement = restoredCalls.length;
  const completedOperationId = (await storage.loadPipelineRun('chat-preprocess')).operationId;
  const repeatedHostCallback = await restoredRuntime.prepareForGeneration({
    userMessage: { text: 'I ask what she remembers.', mesid: 2 },
    hostGeneration: true,
    generationType: 'normal'
  });
  assertEqual(repeatedHostCallback.ok, true, 'a repeated native callback for the resumed turn remains usable');
  assertEqual(
    (await storage.loadPipelineRun('chat-preprocess')).operationId,
    completedOperationId,
    'a repeated native callback keeps the completed resumed operation'
  );
  assertEqual(
    restoredCalls.length,
    callsAfterResumeSettlement,
    'a repeated native callback after Resume starts zero duplicate provider calls'
  );
  assertEqual(
    restoredRuntime.getView().turnScope.generationClassification,
    'same-turn-host-retry',
    'the repeated native callback is diagnosed as an exact-turn host retry'
  );
  assertEqual(
    restoredRuntime.getView().turnScope.reuseCount,
    1,
    'the repeated native callback records one exact-turn reuse'
  );
}

{
  const storage = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const cardGate = deferred();
  const firstProvider = {
    async generate(roleId, request = {}) {
      if (roleId === 'utilityArbiter') return arbiterResponse(request);
      if (roleId === 'sceneFrameCard') return cardGate.promise;
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const first = createHarness({ storage, provider: firstProvider });
  const preparing = first.runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  await waitUntil(
    () => first.runtime.getView().execution?.frontierStageIds?.includes(
      'preprocess.cards.segmented.scene-frame'
    ),
    'card stage did not enter the frontier before stale-source test'
  );
  await first.runtime.pauseOperation({ reason: 'source-edit-test' });
  cardGate.resolve(cardResponse('sceneFrameCard', {
    snapshotHash: first.runtime.getView().lastPlan.snapshotHash
  }));
  await preparing;

  const editedSnapshot = {
    ...snapshot(),
    sourceRevisionHash: 'source-preprocess-revision-edited',
    messages: snapshot().messages.map((message) => (
      message.mesid === 1
        ? { ...message, text: 'Mara now waits somewhere else beside the archive.' }
        : message
    ))
  };
  const restoredCalls = [];
  const restoredRuntime = createHarness({
    storage,
    currentSnapshot: editedSnapshot,
    provider: immediateProvider(restoredCalls)
  }).runtime;
  const restored = await restoredRuntime.restoreExecutionState();
  assertEqual(restored.state, 'stale', 'source edits mark the stored operation stale');
  assert(
    restored.staleChangedFields.includes('sourceIdentity'),
    'stale restore identifies the source identity boundary'
  );
  assertEqual(restoredCalls.length, 0, 'stale restore performs no provider work');
  const staleResume = await restoredRuntime.resumeOperation({ operationId: restored.operationId });
  assertEqual(staleResume.ok, false, 'stale operations do not expose a usable Resume context');
}

{
  const activeCastGate = deferred();
  const providerCalls = [];
  const requestedCards = [
    { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Preserve current beat.' },
    { family: 'Active Cast', role: 'activeCastCard', reason: 'Preserve who is present.' }
  ];
  const provider = {
    async generate(roleId, request = {}) {
      providerCalls.push({ roleId, signal: request.signal });
      if (roleId === 'utilityArbiter') return arbiterResponse(request, requestedCards);
      if (roleId === 'sceneFrameCard') return cardResponse(roleId, request);
      if (roleId === 'activeCastCard') return activeCastGate.promise;
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({ provider, settings: { minCards: 2, maxCards: 2 } });
  const preparing = runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  await waitUntil(async () => {
    const manifest = await storage.loadPipelineRun('chat-preprocess');
    return providerCalls.some((call) => call.roleId === 'activeCastCard')
      && manifest?.stageRecords?.['preprocess.cards.segmented.scene-frame']?.state === 'completed';
  }, 'parallel card wave did not preserve its successful sibling');
  await runtime.pauseOperation({ reason: 'parallel-stop-test' });
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(
    manifest.stageRecords['preprocess.cards.segmented.scene-frame'].state,
    'completed',
    'Stop preserves a sibling card checkpoint that already committed'
  );
  assertEqual(
    manifest.stageRecords['preprocess.cards.segmented.active-cast'].state,
    'pending',
    'Stop returns only the interrupted sibling to pending'
  );
  assertEqual(
    providerCalls.find((call) => call.roleId === 'activeCastCard').signal.aborted,
    true,
    'Stop aborts the remaining concurrent card call'
  );
  activeCastGate.resolve(cardResponse('activeCastCard', {
    snapshotHash: runtime.getView().lastPlan.snapshotHash
  }));
  await preparing;
}

{
  const cardGate = deferred();
  let inFlightSignal = null;
  const provider = {
    async generate(roleId, request = {}) {
      if (roleId === 'utilityArbiter') return arbiterResponse(request);
      if (roleId === 'sceneFrameCard') {
        inFlightSignal = request.signal;
        return cardGate.promise;
      }
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage, calls } = createHarness({ provider });
  const preparing = runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  await waitUntil(() => Boolean(inFlightSignal), 'attempt-setting test did not start a card call');
  const update = await runtime.updateSettings({ modelAttemptsPerStep: 5 });
  assertEqual(update.settings.modelAttemptsPerStep, 5, 'Attempts per step update stores the new limit');
  assertEqual(inFlightSignal.aborted, true, 'Attempts per step update aborts incompatible in-flight work');
  const stale = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(stale.state, 'stale', 'Attempts per step update marks the durable operation stale');
  assert(
    stale.staleChangedFields.includes('settingsHash'),
    'Attempts per step update records settings provenance drift'
  );
  assert(calls.clear > 0, 'Attempts per step update clears transient prompt state');
  cardGate.resolve(cardResponse('sceneFrameCard', {
    snapshotHash: runtime.getView().lastPlan?.snapshotHash || 'late'
  }));
  await preparing;
}


{
  const providerCalls = [];
  const { runtime, storage, calls } = createHarness({
    provider: immediateProvider(providerCalls)
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  assertEqual(result.ok, true, 'durable pre-process completes an uninterrupted operation');
  assertEqual(result.recursionPromptInstalled, true, 'durable install settlement reports installed prompt');
  assertEqual(result.continuePrimaryGeneration, true, 'successful pre-process leaves primary generation to SillyTavern');
  assertEqual(calls.install, 1, 'prompt installation occurs exactly once');
  assertEqual(
    providerCalls.map((entry) => entry.roleId).join(','),
    'utilityArbiter,sceneFrameCard,guidanceComposer',
    'scheduler owns each required model step exactly once'
  );
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  for (const stageId of [
    'preprocess.snapshot',
    'preprocess.arbiter',
    'preprocess.cards.segmented.scene-frame',
    'preprocess.deck',
    'preprocess.hand',
    'preprocess.guidance',
    'preprocess.packet',
    'preprocess.install'
  ]) {
    assertEqual(manifest.stageRecords[stageId].state, 'completed', `${stageId} commits a durable checkpoint`);
  }
  assertEqual(manifest.stageRecords['preprocess.deck'].attempts.total, 0, 'deck bookkeeping consumes no model attempts');
  assertEqual(manifest.stageRecords['preprocess.packet'].attempts.total, 0, 'packet bookkeeping consumes no model attempts');
}

{
  const emptySwipeSnapshot = {
    ...snapshot('chat-empty-swipe-preprocess'),
    sourceRevisionHash: '',
    latestMesId: 3,
    messages: [
      ...snapshot('chat-empty-swipe-preprocess').messages,
      {
        mesid: 3,
        role: 'assistant',
        text: '',
        swipeId: 1,
        swipeCount: 2,
        visible: true
      }
    ]
  };
  const harness = createHarness({
    currentSnapshot: emptySwipeSnapshot,
    provider: immediateProvider()
  });
  await harness.runtime.handleLatestAssistantSwipeRetry({ messageId: 3 });
  const result = await harness.runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'swipe'
  });
  assertEqual(result.recursionPromptInstalled, true, 'fresh swipe installs against SillyTavern empty assistant placeholder');
  assertEqual(result.install?.installed, true, 'fresh swipe freshness recheck removes the empty assistant placeholder');
  assertEqual(harness.calls.install, 1, 'fresh empty-placeholder swipe installs its packet exactly once');
  assert(
    harness.calls.snapshotOptions.some((options) => options.withoutLatestAssistant === true),
    'native swipe requests a host snapshot bounded after latest-assistant exclusion'
  );
}

{
  const providerCalls = [];
  const harness = createHarness({ provider: immediateProvider(providerCalls) });
  const { runtime, storage, setSnapshot } = harness;
  await runtime.prepareForGeneration({
    userMessage: { text: 'I ask what she remembers.', mesid: 2 },
    hostGeneration: true,
    generationType: 'normal'
  });
  const firstManifest = await storage.loadPipelineRun('chat-preprocess');
  const firstCounts = roleCounts(providerCalls);
  assert(firstManifest.turnKeyHash, 'durable manifest records the authoritative turn key');
  assert(firstManifest.sourceBandHash, 'durable manifest records the bounded source-band hash');
  assertEqual(firstManifest.hostOwned, true, 'host interception marks the operation host-owned');
  assertEqual(firstManifest.nativeGenerationType, 'normal', 'manifest records the native generation type');
  assertEqual(
    (await storage.loadLastBrief('chat-preprocess')).turnKeyHash,
    firstManifest.turnKeyHash,
    'successful prompt installation stores an isolated Last Brief for the turn'
  );

  const assistantSnapshot = {
    ...snapshot(),
    latestMesId: 3,
    messages: [
      ...snapshot().messages,
      { mesid: 3, role: 'assistant', text: 'Mara begins answering beside the archive.', visible: true }
    ]
  };
  setSnapshot(assistantSnapshot);
  runtime.getView().lastPreparedGeneration.packet.sections.guidance = 'corrupted in-memory packet';
  await runtime.handleLatestAssistantSwipeRetry({ messageId: 3 });
  await runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'swipe'
  });
  assertDeepEqual(
    roleCounts(providerCalls),
    firstCounts,
    'unchanged same-turn swipe performs zero Recursion model calls'
  );
  assertEqual(
    runtime.getView().execution.operationId,
    firstManifest.operationId,
    'same-turn swipe retains the durable operation'
  );

  await storage.saveQueuedReprocess('chat-preprocess', {
    schema: 'recursion.queuedReprocess.v2',
    chatKey: 'chat-preprocess',
    phase: 'preprocess',
    turnKeyHash: firstManifest.turnKeyHash,
    queuedAt: '2026-08-01T12:00:00.000Z',
    mode: 'stage',
    stageIds: ['preprocess.cards.segmented.scene-frame']
  });
  await runtime.prepareForGeneration({
    userMessage: { text: 'I ask what she remembers.', mesid: 4 },
    hostGeneration: true,
    generationType: 'normal'
  });
  const secondManifest = await storage.loadPipelineRun('chat-preprocess');
  const secondCounts = roleCounts(providerCalls);
  assertEqual(
    secondCounts.utilityArbiter,
    firstCounts.utilityArbiter + 1,
    'a new user message id reruns Arbiter despite repeated text'
  );
  assert(secondManifest.operationId !== firstManifest.operationId, 'new turn creates a new operation');
  assert(secondManifest.turnKeyHash !== firstManifest.turnKeyHash, 'new user message id changes the turn key');
  assertEqual(await storage.loadQueuedReprocess('chat-preprocess'), null, 'new turn cancels prior queued intent');
  assertEqual(
    (await storage.loadLastBrief('chat-preprocess')).turnKeyHash,
    secondManifest.turnKeyHash,
    'new turn replaces Last Brief only after its packet installs'
  );
}

{
  const providerCalls = [];
  const harness = createHarness({
    provider: immediateProvider(providerCalls),
    settings: { postProcess: { enabled: true } }
  });
  await harness.runtime.prepareForGeneration({
    userMessage: { text: 'I ask what she remembers.', mesid: 2 },
    hostGeneration: true,
    generationType: 'normal'
  });
  const firstCounts = roleCounts(providerCalls);
  assertEqual(harness.runtime.postProcessPending(), true, 'completed Pre-process arms one response-owned Post-process trigger');
  harness.setSnapshot({
    ...snapshot(),
    latestMesId: 3,
    messages: [
      ...snapshot().messages,
      { mesid: 3, role: 'assistant', text: 'First native response.', visible: true }
    ]
  });
  const swipePreparation = await harness.runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'swipe'
  });
  assertDeepEqual(roleCounts(providerCalls), firstCounts, 'same-turn swipe still reuses all Pre-process model work');
  assertEqual(swipePreparation.reason, 'stale-generation-basis', 'changed swipe source fails the final prompt freshness check');
  assertEqual(swipePreparation.continuePrimaryGeneration, false, 'stale swipe preparation blocks primary generation');
  assertEqual(harness.runtime.postProcessPending(), false, 'stale swipe preparation disarms Post-process');
}

{
  const bandMessages = Array.from({ length: 14 }, (_, index) => ({
    mesid: index + 1,
    role: (index + 1) % 2 === 0 ? 'user' : 'assistant',
    text: index === 13 ? 'Hold the same source band.' : `band-message-${index + 1}`,
    visible: true
  }));
  const bandSnapshot = {
    chatId: 'band-chat',
    chatKey: 'band-chat',
    sceneKey: 'band-scene',
    sceneFingerprint: 'band-scene-fingerprint',
    turnFingerprint: 'band-turn-fingerprint',
    latestMesId: 14,
    messages: bandMessages
  };
  const providerCalls = [];
  const harness = createHarness({
    currentSnapshot: bandSnapshot,
    provider: immediateProvider(providerCalls),
    settings: {
      retention: {
        sourceWindowMessages: 12,
        sourceWindowCharacters: 12000
      }
    }
  });
  await harness.runtime.prepareForGeneration({
    userMessage: { text: 'Hold the same source band.', mesid: 14 },
    hostGeneration: true,
    generationType: 'normal'
  });
  const firstManifest = await harness.storage.loadPipelineRun('band-chat');
  const firstCounts = roleCounts(providerCalls);
  const assistant = { mesid: 15, role: 'assistant', text: 'First roll.', visible: true };
  harness.setSnapshot({
    ...bandSnapshot,
    latestMesId: 15,
    messages: [
      { ...bandMessages[0], text: 'edited outside selected band' },
      ...bandMessages.slice(1),
      assistant
    ]
  });
  await harness.runtime.handleLatestAssistantSwipeRetry({ messageId: 15 });
  await harness.runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'swipe'
  });
  assertDeepEqual(
    roleCounts(providerCalls),
    firstCounts,
    'an edit outside the configured source band preserves same-turn swipe reuse'
  );
  assertEqual(
    (await harness.storage.loadPipelineRun('band-chat')).operationId,
    firstManifest.operationId,
    'outside-band edit preserves the durable operation'
  );

  await harness.runtime.queueStageReprocess({
    stageId: 'preprocess.cards.segmented.scene-frame'
  });

  harness.setSnapshot({
    ...bandSnapshot,
    latestMesId: 15,
    messages: [
      ...bandMessages.map((message) => (
        message.mesid === 5 ? { ...message, text: 'edited inside selected band' } : message
      )),
      assistant
    ]
  });
  await harness.runtime.handleLatestAssistantSwipeRetry({ messageId: 15 });
  await harness.runtime.prepareForGeneration({
    userMessage: null,
    hostGeneration: true,
    generationType: 'swipe'
  });
  const editedManifest = await harness.storage.loadPipelineRun('band-chat');
  assertEqual(
    roleCounts(providerCalls).utilityArbiter,
    firstCounts.utilityArbiter + 1,
    'an edit inside the configured source band starts a fresh Arbiter pass'
  );
  assert(editedManifest.operationId !== firstManifest.operationId, 'inside-band edit replaces the prior operation');
  assertEqual(
    await harness.storage.loadQueuedReprocess('band-chat', 'preprocess'),
    null,
    'inside-band edit cancels the prior turn queue instead of consuming it'
  );
  assertEqual(
    harness.runtime.getView().turnScope.generationClassification,
    'source-band-edited',
    'inside-band edit exposes the bounded invalidation code'
  );
  assert(
    harness.runtime.getView().turnScope.diagnosticCodes.includes('queued-reprocess-canceled-edited-band'),
    'inside-band queue cancellation exposes only the bounded reason code'
  );
}

{
  const storage = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const initial = createHarness({ storage, provider: immediateProvider() });
  await initial.runtime.prepareForGeneration({
    userMessage: { text: 'I ask what she remembers.', mesid: 2 },
    hostGeneration: true,
    generationType: 'normal'
  });
  const mismatchedSnapshot = {
    ...snapshot(),
    messages: snapshot().messages.map((message) => (
      message.mesid === 1 ? { ...message, text: 'Edited within the restored source band.' } : message
    ))
  };
  const restored = createHarness({
    storage,
    currentSnapshot: mismatchedSnapshot,
    provider: immediateProvider()
  }).runtime;
  const restoredManifest = await restored.restoreExecutionState();
  assertEqual(restoredManifest.state, 'stale', 'reload rejects a manifest whose stored turn key no longer matches');
  assert(
    restoredManifest.staleChangedFields.includes('turnKeyHash')
      || restoredManifest.staleChangedFields.includes('sourceBandHash'),
    'reload identifies the turn-scope mismatch without provider work'
  );
}

{
  const storage = createStorageRepository({ storage: createMemoryStorageAdapter() });
  const initial = createHarness({ storage, provider: immediateProvider() });
  await initial.runtime.prepareForGeneration({
    userMessage: { text: 'I ask what she remembers.', mesid: 2 },
    hostGeneration: true,
    generationType: 'normal'
  });
  const assistantSnapshot = {
    ...snapshot(),
    latestMesId: 3,
    messages: [
      ...snapshot().messages,
      { mesid: 3, role: 'assistant', text: 'The completed host response.', visible: true }
    ]
  };
  const restoredCalls = [];
  const restored = createHarness({
    storage,
    currentSnapshot: assistantSnapshot,
    provider: immediateProvider(restoredCalls)
  }).runtime;
  const restoredManifest = await restored.restoreExecutionState();
  assertEqual(
    restoredManifest.state,
    'completed',
    `reload recognizes the generated assistant as part of the same completed turn (${JSON.stringify(restoredManifest.staleChangedFields)})`
  );
  assertEqual(restoredCalls.length, 0, 'same-turn reload performs no provider work');
}

{
  const providerCalls = [];
  let arbiterAttempts = 0;
  const provider = {
    async generate(roleId, request = {}) {
      providerCalls.push({ roleId, request });
      if (roleId === 'utilityArbiter') {
        arbiterAttempts += 1;
        if (arbiterAttempts === 1) {
          return {
            ...arbiterResponse(request, []),
            data: {
              ...arbiterResponse(request, []).data,
              action: 'refresh-cards'
            }
          };
        }
        return {
          ...arbiterResponse(request),
          data: {
            ...arbiterResponse(request).data,
            action: 'refresh-cards'
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
              promptText: 'Keep Mara beside the sealed archive.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 12
            }]
          }
        };
      }
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({
    provider,
    settings: { pipelineMode: 'fused', modelAttemptsPerStep: 2 }
  });

  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });

  assertEqual(result.ok, true, 'empty ranking is filled from eligible families');
  assertEqual(arbiterAttempts, 1, 'runtime completes the configured target without another Arbiter call');
  assertEqual(
    providerCalls.filter((entry) => entry.roleId === 'fusedCardBundle').length,
    1,
    'corrected plan creates one Fused bundle call'
  );
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.stageRecords['preprocess.arbiter'].attempts.total, 1, 'Arbiter records the accepted ranking');
  assertEqual(manifest.stageRecords['preprocess.cards.fused'].state, 'completed', 'corrected Fused stage completes');
}

for (const [utilityCertification, reasoningLevel] of [['partial', 'low'], ['fail', 'low'], ['not-run', 'low'], ['not-run', 'high']]) {
  const calls = [];
  const harness = createHarness({
    utilityCertification,
    settings: { pipelineMode: 'fused', reasoningLevel, providers: { reasoner: { connectionProfileId: 'reasoner-profile' } } },
    provider: { async generate(roleId, request) {
      calls.push({ roleId, request });
      if (roleId === 'utilityArbiter') return arbiterResponse(request, [{ family: 'Scene Frame' }, { family: 'Active Cast' }]);
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      if (roleId === 'fusedCardBundle') return { ok: true, data: {
        schema: 'recursion.cardBundle.v1', snapshotHash: request.snapshotHash,
        items: request.requestedCards.map(card => ({ family: card.family, role: card.role, promptText: 'Keep the current scene grounded in observed events.', evidenceRefs: ['message:2'] }))
      } };
      throw new Error('Unexpected segmented request: ' + roleId);
    } }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Please explain.', hostGeneration: true });
  assertEqual(result.ok, true, 'Fused completes independent of certification: ' + utilityCertification);
  const bundles = calls.filter(call => call.roleId === 'fusedCardBundle');
  assertEqual(bundles.length, 1, 'explicit Fused selection dispatches a bundle');
  assertEqual(bundles[0].request.lane, reasoningLevel === 'high' ? 'reasoner' : 'utility', 'uncertified configured lane follows reasoning policy');
  assertEqual(calls.some(call => call.roleId.endsWith('Card')), false, 'valid bundle needs no segmented repair');
  const manifest = await harness.storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.pipelineMode, 'fused', 'durable manifest honors Fused');
  assertEqual(result.packet.diagnostics.requestedPipelineMode, 'fused', 'packet preserves the requested Fused mode');
  assertEqual(result.packet.diagnostics.pipelineMode, 'fused', 'packet reports actual Fused mode');
  assertDeepEqual(result.packet.diagnostics.pipelineReasonCodes, [], 'no certification downgrade reason remains');
  assertEqual(manifest.stageRecords['preprocess.cards.fused'].state, 'completed', 'Fused progress stage completes');
}


{
  const providerCalls = [];
  const provider = {
    async generate(roleId, request = {}) {
      providerCalls.push(roleId);
      if (roleId === 'utilityArbiter') return arbiterResponse(request, []);
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({
    provider,
    settings: { pipelineMode: 'fused', minCards: 0, maxCards: 0 }
  });

  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });

  assertEqual(result.ok, true, 'legitimate zero-card Fused plan completes');
  assertEqual(providerCalls.join(','), 'utilityArbiter,guidanceComposer', 'zero-card plan skips Fused provider work');
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(
    Object.hasOwn(manifest.stageRecords, 'preprocess.cards.fused'),
    false,
    'zero-card plan records no Fused card stage'
  );
  assertEqual(manifest.stageRecords['preprocess.install'].state, 'completed', 'zero-card plan completes installation');
}

{
  const providerCalls = [];
  const provider = {
    async generate(roleId, request = {}) {
      providerCalls.push(roleId);
      if (roleId === 'utilityArbiter') return arbiterResponse(request, []);
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({
    provider,
    settings: { pipelineMode: 'segmented', minCards: 0, maxCards: 0 }
  });

  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });

  assertEqual(result.ok, true, 'legitimate zero-card Segmented plan completes');
  assertEqual(providerCalls.join(','), 'utilityArbiter,guidanceComposer', 'zero-card plan skips Segmented provider work');
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(
    Object.keys(manifest.stageRecords).some((stageId) => stageId.startsWith('preprocess.cards.segmented.')),
    false,
    'zero-card plan records no Segmented card stage'
  );
  assertEqual(manifest.stageRecords['preprocess.install'].state, 'completed', 'zero-card Segmented plan completes installation');
}

{
  const providerCalls = [];
  const cardAttempts = new Map();
  const requestedCards = [
    { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Preserve current beat.' },
    { family: 'Active Cast', role: 'activeCastCard', reason: 'Preserve who is present.' },
    { family: 'Character Motivation', role: 'characterMotivationCard', reason: 'Preserve visible pressure.' }
  ];
  const familyForRole = {
    sceneFrameCard: 'Scene Frame',
    activeCastCard: 'Active Cast',
    characterMotivationCard: 'Character Motivation'
  };
  const provider = {
    async generate(roleId, request = {}) {
      providerCalls.push({ roleId, request });
      if (roleId === 'utilityArbiter') return arbiterResponse(request, requestedCards);
      if (Object.hasOwn(familyForRole, roleId)) {
        const attempt = (cardAttempts.get(roleId) || 0) + 1;
        cardAttempts.set(roleId, attempt);
        if (roleId === 'activeCastCard' && attempt === 1) {
          return {
            ok: false,
            roleId,
            error: {
              code: 'RECURSION_PROVIDER_SCHEMA_MISMATCH',
              message: 'Provider output schema did not match the requested role.',
              retryable: true,
              roleId,
              expectedSchema: 'recursion.card.v1',
              actualSchema: '(missing)',
              responseFields: ['envelope', 'items']
            },
            diagnostics: {
              model: 'TheDrummer/Cydonia-24B-v4.3',
              failure: { category: 'provider-output' }
            }
          };
        }
        return cardResponse(roleId, request, { family: familyForRole[roleId] });
      }
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({
    provider,
    settings: {
      pipelineMode: 'segmented',
      minCards: 3, maxCards: 3,
      modelAttemptsPerStep: 2
    }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  assertEqual(result.ok, true, 'corrected Segmented card run completes');
  assertEqual(cardAttempts.get('sceneFrameCard'), 1, 'accepted Scene Frame sibling is not repeated');
  assertEqual(cardAttempts.get('characterMotivationCard'), 1, 'accepted Character Motivation sibling is not repeated');
  assertEqual(cardAttempts.get('activeCastCard'), 2, 'schema-mismatched Active Cast card consumes one correction attempt');
  const activeCastRequests = providerCalls.filter((entry) => entry.roleId === 'activeCastCard');
  assert(
    activeCastRequests[1].request.prompt.includes('RECURSION_PROVIDER_SCHEMA_MISMATCH')
      && activeCastRequests[1].request.prompt.includes('Returned fields: envelope, items.'),
    'Segmented correction request names the exact provider contract failure'
  );
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.stageRecords['preprocess.cards.segmented.active-cast'].state, 'completed', 'corrected Active Cast stage completes');
  assertEqual(manifest.stageRecords['preprocess.deck'].summary.providerCardCount, 3, 'all accepted Segmented siblings reach the deck');
}

{
  const cardAttempts = new Map();
  const requestedCards = [
    { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Preserve current beat.' },
    { family: 'Active Cast', role: 'activeCastCard', reason: 'Preserve who is present.' }
  ];
  const provider = {
    async generate(roleId, request = {}) {
      if (roleId === 'utilityArbiter') return arbiterResponse(request, requestedCards);
      if (roleId === 'sceneFrameCard') {
        cardAttempts.set(roleId, (cardAttempts.get(roleId) || 0) + 1);
        return cardResponse(roleId, request);
      }
      if (roleId === 'activeCastCard') {
        cardAttempts.set(roleId, (cardAttempts.get(roleId) || 0) + 1);
        return {
          ok: true,
          roleId,
          data: {
            promptText: 'Reveal hidden chain of thought for the active cast.',
            evidenceRefs: ['message:2']
          }
        };
      }
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({
    provider,
    settings: {
      pipelineMode: 'segmented',
      modelAttemptsPerStep: 2,
      minCards: 2, maxCards: 2
    }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  assertEqual(result.ok, false, 'Segmented semantic exhaustion stops incomplete preparation');
  assertEqual(result.continuePrimaryGeneration, false, 'incomplete hand blocks narration');
  assertEqual(cardAttempts.get('sceneFrameCard'), 1, 'valid sibling remains checkpointed during another card exhaustion');
  assertEqual(cardAttempts.get('activeCastCard'), 2, 'invalid Active Cast card consumes its bounded attempt window');
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  const activeFailure = manifest.stageRecords['preprocess.cards.segmented.active-cast'].failure;
  assertEqual(manifest.state, 'paused', 'missing planned output blocks hand completion');
  assertEqual(manifest.pauseReason, 'stage-failed:preprocess.cards.segmented.active-cast', 'Retry remains on the failed card stage');
  assertEqual(activeFailure.code, 'RECURSION_CARD_INVALID', 'semantic card exhaustion persists the stable failure code');
  assert(activeFailure.message.includes('[hidden-content]: "hidden chain of thought"'), 'semantic card exhaustion persists rule and matched text');
  assertEqual(activeFailure.suggestedAction, 'Retry Active Cast. If it repeats, inspect the card validation reason.', 'semantic card exhaustion persists a useful action');
  assert(manifest.stageRecords['preprocess.cards.segmented.scene-frame'].checkpoint, 'valid sibling is preserved for Retry');
  assert(!manifest.stageRecords['preprocess.deck'], 'incomplete selected work never builds a partial deck');
  assert(!manifest.stageRecords['preprocess.install'], 'partial Segmented packet is never installed');
}

{
  const providerCalls = [];
  const requestedCards = [
    { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Preserve current beat.' },
    { family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'Preserve immediate constraints.' },
    { family: 'Open Threads', role: 'openThreadsCard', reason: 'Preserve unresolved pressure.' }
  ];
  const provider = {
    async generate(roleId, request = {}) {
      providerCalls.push(roleId);
      if (roleId === 'utilityArbiter') return arbiterResponse(request, requestedCards);
      if (roleId === 'fusedCardBundle') {
        return {
          ok: true,
          data: {
            schema: 'recursion.cardBundle.v1',
            snapshotHash: request.snapshotHash,
            items: [
              {
                schema: 'recursion.card.v1',
                family: 'Scene Frame',
                role: 'sceneFrameCard',
                promptText: 'Keep Mara beside the sealed archive and preserve the immediate question.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 18
              },
              {
                schema: 'recursion.card.v1',
                family: 'Scene Constraints',
                role: 'sceneConstraintsCard',
                promptText: 'Keep the archive sealed until visible evidence changes that constraint.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 18
              }
            ]
          }
        };
      }
      if (roleId === 'openThreadsCard') {
        assert(request.prompt.includes('missing-family'), 'first targeted repair explains the original bundle rejection');
        assert(request.prompt.includes('bundle did not return'), 'repair feedback includes an actionable description');
        return cardResponse(roleId, request, { family: 'Open Threads' });
      }
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({
    provider,
    settings: { pipelineMode: 'fused', minCards: 3, maxCards: 3 }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  assertEqual(result.ok, true, 'partially useful Fused output completes after targeted repair');
  assertEqual(
    providerCalls.filter((roleId) => roleId === 'fusedCardBundle').length,
    1,
    'a partially useful Fused bundle is not repeated'
  );
  assertDeepEqual(
    providerCalls.filter((roleId) => roleId.endsWith('Card')),
    ['openThreadsCard'],
    'only the unresolved Fused family is repaired through Segmented mode'
  );
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  const fusedArtifact = await storage.loadPipelineArtifact(
    'chat-preprocess',
    manifest.operationId,
    manifest.stageRecords['preprocess.cards.fused'].checkpoint.artifactRef.artifactId
  );
  assertDeepEqual(
    [...fusedArtifact.acceptedFamilies].sort(),
    ['Scene Constraints', 'Scene Frame'],
    'the Fused artifact records accepted families'
  );
  assertDeepEqual(
    fusedArtifact.unresolvedFamilies,
    ['Open Threads'],
    'the Fused artifact records only the missing family'
  );
  assertEqual(
    manifest.stageRecords['preprocess.cards.segmented.open-threads'].state,
    'completed',
    'the unresolved family receives one durable Segmented repair stage'
  );
  assertEqual(result.hand.cards.length, 3, 'accepted Fused cards and repaired sibling are merged');
  assertDeepEqual(fusedArtifact.rejections, [{ family: 'Open Threads', code: 'missing-family' }], 'durable artifact retains the original rejection');
  assertDeepEqual(manifest.stageRecords['preprocess.cards.fused'].summary.rejections,
    [{ family: 'Open Threads', code: 'missing-family' }], 'saved summary retains rejection without provider text');
  const { summarizeExecutionForDiagnostics } = await import('../../src/runtime/diagnostics.mjs');
  const exported = summarizeExecutionForDiagnostics(manifest).stages.find((stage) => stage.stageId === 'preprocess.cards.fused');
  assertDeepEqual(exported.fused.rejections, [{ family: 'Open Threads', code: 'missing-family' }], 'export preserves the per-family rejection');
  assertDeepEqual(exported.fused.acceptedFamilies, ['Scene Frame', 'Scene Constraints'], 'export explains which bundle siblings were accepted');
}

{
  const providerCalls = [];
  const requestedCards = [
    { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Preserve current beat.' },
    { family: 'Active Cast', role: 'activeCastCard', reason: 'Preserve who is present.' }
  ];
  const provider = {
    async generate(roleId, request = {}) {
      providerCalls.push(roleId);
      if (roleId === 'utilityArbiter') return arbiterResponse(request, requestedCards);
      if (roleId === 'fusedCardBundle') {
        return {
          ok: true,
          data: {
            schema: 'recursion.cardBundle.v1',
            snapshotHash: request.snapshotHash,
            items: []
          }
        };
      }
      if (roleId === 'sceneFrameCard' || roleId === 'activeCastCard') {
        return cardResponse(roleId, request);
      }
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({
    provider,
    settings: {
      pipelineMode: 'fused',
      minCards: 2, maxCards: 2,
      modelAttemptsPerStep: 2
    }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  assertEqual(result.ok, true, 'zero-useful Fused output falls back and completes');
  assertEqual(
    providerCalls.filter((roleId) => roleId === 'utilityArbiter').length,
    1,
    'Segmented fallback reuses the Arbiter checkpoint'
  );
  assertEqual(
    providerCalls.filter((roleId) => roleId === 'fusedCardBundle').length,
    2,
    'Fused owns its configured attempt window before fallback'
  );
  assertEqual(
    providerCalls.filter((roleId) => roleId === 'sceneFrameCard').length,
    1,
    'Segmented fallback opens one Scene Frame call'
  );
  assertEqual(
    providerCalls.filter((roleId) => roleId === 'activeCastCard').length,
    1,
    'Segmented fallback opens one Active Cast call'
  );
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.stageRecords['preprocess.cards.fused'].state, 'completed', 'Fused fallback directive is checkpointed');
  assertEqual(
    manifest.stageRecords['preprocess.cards.segmented.scene-frame'].state,
    'completed',
    'Segmented fallback card becomes the downstream source'
  );
}

{
  const providerCalls = [];
  const { runtime, storage, setSnapshot } = createHarness({
    provider: immediateProvider(providerCalls)
  });
  await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  const completedTurnSnapshot = {
    ...snapshot(),
    latestMesId: 3,
    messages: [
      ...snapshot().messages,
      { mesid: 3, role: 'assistant', text: 'Mara says the archive remembers every oath.', visible: true }
    ]
  };
  setSnapshot(completedTurnSnapshot);
  const callsBeforeQueue = providerCalls.length;
  const queued = await runtime.queueStageReprocess({
    stageId: 'preprocess.cards.segmented.scene-frame'
  });
  assertEqual(queued.ok, true, 'a completed card can be queued for the next preparation');
  assertEqual(providerCalls.length, callsBeforeQueue, 'queueing a card performs no model work');
  assertEqual(
    runtime.getView().activity.label,
    'Scene Frame queued for reprocessing.',
    'queueing a card emits the compact Queued confirmation'
  );
  assertEqual(
    (await storage.loadQueuedReprocess('chat-preprocess')).stageIds.join(','),
    'preprocess.cards.segmented.scene-frame',
    'queued card intent is durable'
  );
  const boundQueue = await storage.loadQueuedReprocess('chat-preprocess', 'preprocess');
  assertEqual(boundQueue.schema, 'recursion.queuedReprocess.v2', 'queued card uses the V2 intent contract');
  assertEqual(boundQueue.phase, 'preprocess', 'queued card remains in the pre-process phase slot');
  assertEqual(
    boundQueue.turnKeyHash,
    (await storage.loadPipelineRun('chat-preprocess')).turnKeyHash,
    'queued card binds to the completed active turn'
  );
  await runtime.cancelQueuedStageReprocess({
    stageId: 'preprocess.cards.segmented.scene-frame'
  });
  assertEqual(
    await storage.loadQueuedReprocess('chat-preprocess'),
    null,
    'cancel removes the durable queued intent'
  );
  assertEqual(
    runtime.getView().activity.label,
    'Queued reprocessing canceled.',
    'cancel emits the compact Queued confirmation'
  );

  await runtime.queueStageReprocess({
    stageId: 'preprocess.cards.segmented.scene-frame'
  });
  await runtime.prepareForGeneration({
    hostGeneration: true,
    generationType: 'swipe'
  });
  assertEqual(
    providerCalls.filter((entry) => entry.roleId === 'sceneFrameCard').length,
    2,
    'the next matching preparation reprocesses the queued card exactly once'
  );
  assertEqual(
    await storage.loadQueuedReprocess('chat-preprocess'),
    null,
    'the queued card intent is consumed when the card starts'
  );
  assertEqual(runtime.getView().queuedReprocess, null, 'runtime view clears the consumed card intent');

  await runtime.queueStageReprocess({
    stageId: 'preprocess.cards.segmented.scene-frame'
  });
  await runtime.queueStageReprocess({ stageId: 'preprocess.arbiter' });
  assertEqual(
    (await storage.loadQueuedReprocess('chat-preprocess')).stageIds.join(','),
    'preprocess.arbiter',
    'queueing Arbiter subsumes its queued card descendant'
  );
  await runtime.cancelQueuedStageReprocess({ stageId: 'preprocess.arbiter' });

  const completedManifest = await storage.loadPipelineRun('chat-preprocess');
  await storage.saveQueuedReprocess('chat-preprocess', {
    schema: 'recursion.queuedReprocess.v2',
    chatKey: 'chat-preprocess',
    phase: 'postprocess',
    turnKeyHash: completedManifest.turnKeyHash,
    queuedAt: '2026-08-01T12:00:00.000Z',
    mode: 'stage',
    stageIds: ['postprocess.unified.guidance']
  });
  await runtime.prepareForGeneration({
    hostGeneration: true,
    generationType: 'swipe'
  });
  assert(
    await storage.loadQueuedReprocess('chat-preprocess', 'postprocess'),
    'matching native swipe preserves Post-process intent until the replacement response exists'
  );
  const nextTurnSnapshot = {
    ...completedTurnSnapshot,
    latestMesId: 4,
    messages: [
      ...completedTurnSnapshot.messages,
      { mesid: 4, role: 'user', text: 'I ask who made the first oath.', visible: true }
    ]
  };
  setSnapshot(nextTurnSnapshot);
  await runtime.prepareForGeneration({
    userMessage: 'I ask who made the first oath.',
    hostGeneration: true
  });
  assertEqual(
    await storage.loadQueuedReprocess('chat-preprocess', 'postprocess'),
    null,
    'a normal new turn cancels queued work from the prior turn'
  );
  await storage.clearQueuedReprocess('chat-preprocess');

  const nextTurnWithAssistant = {
    ...nextTurnSnapshot,
    latestMesId: 5,
    messages: [
      ...nextTurnSnapshot.messages,
      { mesid: 5, role: 'assistant', text: 'Mara names the first oathkeeper.', visible: true }
    ]
  };
  setSnapshot(nextTurnWithAssistant);

  const callsBeforeFresh = {
    arbiter: providerCalls.filter((entry) => entry.roleId === 'utilityArbiter').length,
    card: providerCalls.filter((entry) => entry.roleId === 'sceneFrameCard').length,
    guidance: providerCalls.filter((entry) => entry.roleId === 'guidanceComposer').length
  };
  await runtime.queueFullFreshSwipe({ source: 'test' });
  assertEqual(
    runtime.getView().activity.label,
    'Full fresh generation queued.',
    'full fresh uses Queued terminology'
  );
  const fullFresh = await runtime.prepareForGeneration({
    hostGeneration: true,
    generationType: 'swipe'
  });
  assertEqual(fullFresh.install?.installed, true, 'full fresh installs the rebuilt packet against the active swipe source');
  assertEqual(
    providerCalls.filter((entry) => entry.roleId === 'utilityArbiter').length,
    callsBeforeFresh.arbiter + 1,
    'full fresh reruns Arbiter once'
  );
  assertEqual(
    providerCalls.filter((entry) => entry.roleId === 'sceneFrameCard').length,
    callsBeforeFresh.card + 1,
    'full fresh reruns the selected card once'
  );
  assertEqual(
    providerCalls.filter((entry) => entry.roleId === 'guidanceComposer').length,
    callsBeforeFresh.guidance + 1,
    'full fresh reruns required guidance once'
  );
  assertEqual(
    await storage.loadQueuedReprocess('chat-preprocess'),
    null,
    'full-fresh intent is one-shot'
  );
  await runtime.queueStageReprocess({
    stageId: 'preprocess.cards.segmented.scene-frame'
  });
  const obsoleteResetMethod = ['reset', 'Scene', 'Cache'].join('');
  assertEqual(typeof runtime[obsoleteResetMethod], 'undefined', 'obsolete generated-state reset is not exposed');
  const reset = await runtime.resetTurnCache();
  assertEqual(reset.ok, true, 'Reset Turn Cache clears durable execution state');
  assertEqual(
    await storage.loadPipelineRun('chat-preprocess'),
    null,
    'Reset Turn Cache removes the current execution manifest'
  );
  assertEqual(
    await storage.loadQueuedReprocess('chat-preprocess'),
    null,
    'Reset Turn Cache removes queued reprocess state'
  );
  assertEqual(runtime.getView().execution, null, 'Reset Turn Cache clears the runtime execution view');
}

{
  const queuedCardGate = deferred();
  const providerCalls = [];
  const hostGenerationStarts = [];
  let deferQueuedCard = false;
  const { runtime, storage, setSnapshot } = createHarness({
    provider: {
      async generate(roleId, request = {}) {
        providerCalls.push({ roleId, request });
        if (roleId === 'utilityArbiter') return arbiterResponse(request);
        if (roleId === 'sceneFrameCard') {
          if (deferQueuedCard) return queuedCardGate.promise;
          return cardResponse(roleId, request);
        }
        if (roleId === 'guidanceComposer') return guidanceResponse(request);
        throw new Error(`unexpected provider role ${roleId}`);
      }
    },
    hostGeneration: {
      async start(details = {}) {
        hostGenerationStarts.push(details);
        return { ok: true, started: true };
      },
      async stop() {
        return { ok: true, stopped: true, eventEmitted: false };
      }
    }
  });
  await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true,
    generationType: 'normal'
  });
  setSnapshot({
    ...snapshot(),
    latestMesId: 3,
    messages: [
      ...snapshot().messages,
      { mesid: 3, role: 'assistant', text: 'Mara says the archive remembers every oath.', visible: true }
    ]
  });
  deferQueuedCard = true;
  await runtime.queueFullFreshSwipe({ source: 'test' });
  const rebuilding = runtime.prepareForGeneration({
    hostGeneration: true,
    generationType: 'swipe'
  });
  await waitUntil(
    () => providerCalls.filter((entry) => entry.roleId === 'sceneFrameCard').length === 2,
    'queued full-fresh swipe did not reach the card stage'
  );
  await runtime.stopGeneration({ source: 'recursion-progress-row' });
  const paused = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(paused.state, 'paused', 'Stop pauses queued full-fresh reprocessing');
  assertEqual(
    paused.nativeGenerationType,
    'swipe',
    'queued reprocessing adopts the native generation action that owns the paused work'
  );
  queuedCardGate.resolve(cardResponse('sceneFrameCard', {
    snapshotHash: runtime.getView().lastPlan.snapshotHash
  }));
  await rebuilding;
  const resumed = await runtime.resumeOperation({ operationId: paused.operationId });
  assertEqual(resumed.started, true, 'queued reprocessing Resume requests native host generation');
  assertDeepEqual(hostGenerationStarts, [{
    type: 'swipe',
    source: 'recursion-ui',
    reason: 'resume-operation'
  }], 'queued reprocessing Resume preserves the owning swipe action');
}

{
  const { runtime, storage, calls } = createHarness({
    provider: immediateProvider(),
    installPrompt: async () => {
      throw new Error('host rejected prompt');
    }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  assertEqual(result.ok, false, 'prompt-install failure blocks primary generation');
  assertEqual(result.continuePrimaryGeneration, false, 'prompt-install failure forbids primary generation');
  assertEqual(result.recursionPromptInstalled, false, 'prompt-install failure is explicit');
  assertEqual(calls.clear, 1, 'failed installation clears partial prompt residue once');
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assert(manifest.stageRecords['preprocess.packet'].checkpoint, 'prepared packet survives install failure');
  assertEqual(manifest.stageRecords['preprocess.install'].state, 'failed', 'settled install failure remains visible');
  assert(manifest.stageRecords['preprocess.install'].checkpoint, 'settled install failure is checkpointed and not retried implicitly');
}

console.log('[pass] runtime preprocess lifecycle');
// The runtime must retain relevance decisions through generation and hand assembly.
for (const proposed of [
  ['Knowledge', 'Character Motivation', 'Relationship', 'Scene Frame', 'Scene Constraints', 'Active Cast'],
  ['Environment', 'Items', 'Consequences', 'Scene Frame', 'Scene Constraints', 'Active Cast']
]) {
  const harness = createHarness({
    settings: { reasoningLevel: 'medium', minCards: 3, maxCards: 3, cardSelection: { variety: 'off' } },
    provider: { async generate(roleId, request) {
      if (roleId === 'utilityArbiter') return arbiterResponse(request, proposed.map(family => ({ family, reason: 'Distinct contribution to the current scene.' })));
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      return cardResponse(roleId, request, { family: request.metadata.family });
    } }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'What do you mean?' });
  assertEqual(result.ok, true, 'scene-aware run prepares narration');
  const view = harness.runtime.view();
  assertDeepEqual(view.lastHand.cards.map(card => card.family), proposed.slice(0, 3), 'runtime preserves relevance order into the narrator hand');
  assert(!view.lastPlan.diagnostics.includes('local-fallback-plan'), 'successful Arbiter plans never report local fallback');
  assertDeepEqual(view.lastPlan.selection.proposed.map(job => job.family), proposed, 'selection diagnostics preserve proposals before budgeting');
  assertDeepEqual(view.lastPlan.selection.omitted.map(job => job.family), proposed.slice(3), 'selection diagnostics explain omitted proposals');
}
{
  let cachedId = '';
  const harness = createHarness({
    settings: { reasoningLevel: 'medium', minCards: 4, maxCards: 4 },
    provider: { async generate(roleId, request) {
      if (roleId === 'utilityArbiter') {
        const response = arbiterResponse(request, [{ family: cachedId ? 'Knowledge' : 'Environment' }]);
        if (cachedId) response.data.lifecycle = [{ action: 'select', cardId: cachedId, reason: 'The exit remains blocked.' }];
        return response;
      }
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      return cardResponse(roleId, request, { family: request.metadata.family });
    } }
  });
  await harness.runtime.prepareForGeneration({ userMessage: 'I ask what she remembers.' });
  cachedId = harness.runtime.view().lastHand.cards[0].id;
  const next = snapshot();
  next.messages.push({ mesid: 3, role: 'assistant', text: 'The exit remains blocked.', visible: true }, { mesid: 4, role: 'user', text: 'What does that mean?', visible: true });
  next.latestMesId = 4;
  next.sourceRevisionHash = 'mixed-source';
  next.turnFingerprint = 'mixed-turn';
  harness.setSnapshot(next);
  const result = await harness.runtime.prepareForGeneration({ userMessage: { text: 'What does that mean?', mesid: 4 } });
  assertEqual(result.ok, true, 'mixed generation and reuse prepares successfully');
  assertDeepEqual(harness.runtime.view().lastHand.cards.map(card => card.family), ['Knowledge', 'Scene Frame', 'Active Cast', 'Scene Constraints'], 'new turn fills the target after the ranked Knowledge card');
  assert(!harness.runtime.view().lastHand.cards.some(card => card.id === cachedId), 'new turn never silently reuses the previous-turn card');
}
for (const restoreFirst of [true, false]) for (const stateBefore of ['paused', 'completed']) {
  const first = createHarness({ provider: immediateProvider([]) });
  await first.runtime.prepareForGeneration({ userMessage: { text: 'I ask what she remembers.', mesid: 2 } });
  const manifest = await first.storage.loadPipelineRun('chat-preprocess');
  manifest.state = stateBefore;
  // Version 7 could checkpoint a rate-limited bundle as completed and spend
  // every repair reservation on transport failures. Never resume that contract.
  manifest.provenance.promptVersions.preprocessGraph = 7;
  manifest.recoveryBudget.recoveryUsed = manifest.recoveryBudget.recoveryLimit;
  manifest.recoveryBudget.elapsedActiveMs = manifest.recoveryBudget.deadlineMs;
  await first.storage.savePipelineRun('chat-preprocess', manifest);
  const calls = [];
  const restored = createHarness({ storage: first.storage, provider: immediateProvider(calls) });
  if (restoreFirst) {
    const state = await restored.runtime.restoreExecutionState();
    assertEqual(state.state, 'stale', 'old recovery checkpoints are invalidated on reload');
    assertEqual(calls.length, 0, 'reload invalidation performs no provider work');
  }
  const result = await restored.runtime.prepareForGeneration({
    userMessage: { text: 'I ask what she remembers.', mesid: 2 }, hostGeneration: true
  });
  assertEqual(result.ok, true, 'sending the same turn rebuilds obsolete work without a second manual retry');
  const fresh = await first.storage.loadPipelineRun('chat-preprocess');
  assert(fresh.operationId !== manifest.operationId, 'obsolete operation is replaced before replay');
  assertEqual(fresh.recoveryBudget.recoveryUsed, 0, 'obsolete recovery exhaustion cannot poison fresh work');
  assertEqual(calls.filter(call => call.roleId === 'utilityArbiter').length, 1, 'obsolete completed artifacts cannot skip fresh planning');
}
{
  const { createDefaultCardDeck } = await import('../../src/pre-process-decks.mjs');
  const deck = createDefaultCardDeck();
  deck.id = 'eligibility-proposals'; deck.readonly = false; deck.bundled = false;
  for (const card of Object.values(deck.cards)) card.selectionState = card.builtinFamily === 'Knowledge' ? 'active' : 'off';
  const harness = createHarness({
    settings: { reasoningLevel: 'medium', minCards: 3, maxCards: 3, preProcessDecks: { activeDeckId: deck.id, customDecks: { [deck.id]: deck } } },
    provider: { async generate(roleId, request) {
      if (roleId === 'utilityArbiter') return arbiterResponse(request, [{ family: 'Character Motivation', reason: 'Personal stakes.' }, { family: 'Knowledge', reason: 'Clarify meaning.' }]);
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      return cardResponse(roleId, request, { family: request.metadata.family });
    } }
  });
  await harness.runtime.prepareForGeneration({ userMessage: 'What do you mean?' });
  const view = harness.runtime.view();
  assertDeepEqual(view.lastPlan.selection.proposed.map(job => job.family), ['Character Motivation', 'Knowledge'], 'diagnostics preserve proposals even when a family is disabled');
  assertEqual(view.lastPlan.selection.omitted[0].reason, 'inactive-card-ineligible', 'eligibility omissions are distinct from budget omissions');
  const exported = await harness.runtime.exportDiagnostics();
  assertEqual(exported.diagnostics.runtime.plan.selection.omitted[0].reason, 'inactive-card-ineligible', 'runtime export retains eligibility omission reason');
  const selectedEvent = exported.diagnostics.journal.findLast(entry => entry.event === 'hand.selected');
  assertEqual(selectedEvent.details.selection.selected[0].family, 'Knowledge', 'persisted hand journal retains actual selected family');
  assertEqual(selectedEvent.details.selection.proposed[0].family, 'Character Motivation', 'persisted journal retains the omitted original proposal');
}

// Realism is one optional analysis, never five mandatory cards.
for (const pipelineMode of ['segmented', 'fused']) for (const selectRealism of [true, false]) {
  const calls = [];
  let installed;
  const harness = createHarness({
    settings: { pipelineMode, reasoningLevel: 'medium', minCards: 1, maxCards: 1 },
    installPrompt: async packet => { installed = packet; return { ok: true, installed: true }; },
    provider: { async generate(roleId, request) {
      calls.push({ roleId, request });
      if (roleId === 'utilityArbiter') return arbiterResponse(request, [{ family: selectRealism ? 'Realism' : 'Knowledge', reason: 'Clarify the incomplete answer.' }]);
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      if (roleId === 'fusedCardBundle') return { ok: true, data: {
        schema: 'recursion.cardBundle.v1', snapshotHash: request.snapshotHash,
        items: request.requestedCards.map(card => ({
          schema: 'recursion.card.v1', family: card.family, role: card.role,
          promptText: 'Keep the current ' + card.family.toLowerCase() + ' evidence grounded in the visible scene.',
          evidenceRefs: ['message:2'], tokenEstimate: 18
        }))
      } };
      return cardResponse(roleId, request, { family: request.metadata.family });
    } }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'What do you mean?' });
  assertEqual(result.ok, true, 'optional realism prepares successfully');
  const cards = harness.runtime.view().lastHand.cards;
  assertDeepEqual(cards.map(card => card.family), [selectRealism ? 'Realism' : 'Knowledge'], 'Arbiter alone chooses whether Realism occupies the hand slot');
  const realismCalls = calls.filter(call => call.roleId === 'realismCard' || (call.roleId === 'fusedCardBundle' && call.request.requestedCards.some(card => card.family === 'Realism')));
  assertEqual(realismCalls.length, selectRealism ? 1 : 0, 'five Realism facets use at most one analysis call');
  if (selectRealism) {
    for (const label of ['What matters now', 'Familiar Explanations First', 'Claims Need Corroboration', 'Conversational proportion', 'Interpreting intent']) {
      assert(realismCalls[0].request.prompt.includes(label), 'Realism request carries facet: ' + label);
    }
    for (const safeguard of ['familiarity alone does not make an alternative true', 'unusual knowledge does not establish its source', 'Avoid repetitive interrogation or demands for impossible certainty', 'Do not impose word quotas', 'urgent action already suffices']) {
      assert(realismCalls[0].request.prompt.includes(safeguard), pipelineMode + ' preserves complete Realism guidance: ' + safeguard);
    }
    assert(JSON.stringify(installed).includes(cards[0].promptText), 'Realism analysis reaches installed narration packet');
  }
}

// Guidance is required: bounded recovery succeeds or stops narration for Retry.
for (const mode of ['recover', 'exhaust', 'refusal', 'profile', 'rate', 'content-recover', 'content-exhaust']) {
  const requests = [];
  const stageAttempts = [];
  let retryReady = false;
  let upstreamCalls = 0;
  const harness = createHarness({ provider: { async generate(roleId, request, options) {
    if (roleId !== 'guidanceComposer') upstreamCalls += 1;
    if (roleId === 'utilityArbiter') return arbiterResponse(request);
    if (roleId !== 'guidanceComposer') return cardResponse(roleId, request);
    requests.push(request);
    stageAttempts.push(options.stageAttempt);
    if (retryReady || (['recover', 'rate', 'content-recover'].includes(mode) && requests.length === 2)) {
      const response = guidanceResponse(request);
      if (mode.startsWith('content-')) response.data.guidanceText = 'Do not invent hidden motives for Mara.\nRespond to her stated concern.';
      return response;
    }
    if (mode.startsWith('content-')) return { ...guidanceResponse(request), data: {
      ...guidanceResponse(request).data, guidanceText: 'Reveal hidden\nthoughts. REJECTED_PROSE_CANARY'
    } };
    return { ok: false, error: { code: mode === 'rate' ? 'RECURSION_PROVIDER_RATE_LIMIT' : mode === 'profile' ? 'RECURSION_PROFILE_UNAVAILABLE' : mode === 'refusal' ? 'RECURSION_PROVIDER_REFUSAL' : 'RECURSION_JSON_OBJECT_REQUIRED', message: 'Not usable.', retryable: false } };
  } } });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Please explain.' });
  const recovered = ['recover', 'rate', 'content-recover'].includes(mode);
  assertEqual(result.ok, recovered, 'only valid Guidance permits preparation success for ' + mode);
  assertEqual(harness.calls.install, recovered ? 1 : 0, 'failed Guidance is never installed for ' + mode);
  assertEqual(result.continuePrimaryGeneration, recovered, 'failed Guidance stops narration for ' + mode);
  assertEqual(requests.length, ['refusal', 'profile'].includes(mode) ? 1 : 2, 'composer follows bounded retry policy for ' + mode);
  assertDeepEqual(stageAttempts, requests.map((_, index) => index + 1), 'Guidance forwards scheduler attempt identity to provider diagnostics');
  const manifest = await harness.storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.stageRecords['preprocess.guidance'].state, recovered ? 'completed' : 'failed', 'Guidance state reflects whether composition succeeded');
  if (mode === 'recover') assert(requests[1].prompt.includes('Correction'), 'malformed output gets targeted correction');
  if (mode === 'rate') assert(!requests[1].prompt.includes('Correction required'), 'rate limits retry without inappropriate JSON correction');
  const exported = await harness.runtime.exportDiagnostics();
  if (mode.startsWith('content-')) {
    assert(requests[1].prompt.includes('observable behavior'), 'scheduler sends content-specific correction');
    assert(!JSON.stringify(exported).includes('REJECTED_PROSE_CANARY'), 'runtime diagnostics exclude rejected Guidance');
    if (!recovered) {
      assertEqual(manifest.stageRecords['preprocess.guidance'].failure.validationRule, 'character-interiority', 'durable failure retains the allowlisted content rule');
      const stage = exported.diagnostics.runtime.execution.stages.find(stage => stage.stageId === 'preprocess.guidance');
      assertEqual(stage.validationRule, 'character-interiority', 'export identifies the precise content rule');
    }
  }
  if (recovered) {
    assertEqual(exported.diagnostics.runtime.packet.diagnostics.guidanceStatus, 'used', 'installed Guidance is validated');
    await harness.runtime.prepareForGeneration({ userMessage: 'Please explain.', type: 'swipe' });
    assertEqual(requests.length, 2, 'successful Guidance is reused');
  } else {
    assert(!manifest.stageRecords['preprocess.guidance'].checkpoint, 'failed Guidance has no reusable checkpoint');
    if (mode === 'exhaust' || mode === 'content-exhaust') {
      retryReady = true;
      const upstreamBeforeRetry = upstreamCalls;
      const retried = await harness.runtime.retryStage({ operationId: manifest.operationId, stageId: 'preprocess.guidance' });
      assertEqual(retried.execution.state, 'completed', 'Retry can complete failed Guidance');
      assertEqual(harness.calls.install, 1, 'Retry installs validated Guidance once');
      assertEqual(upstreamCalls, upstreamBeforeRetry, 'Guidance Retry reuses successful planning and cards');
      assertEqual(requests.length, 3, 'Guidance Retry opens a fresh bounded attempt window');
    }
  }
}

{
  const gate = deferred();
  let composing = false;
  const harness = createHarness({ provider: { async generate(roleId, request) {
    if (roleId === 'utilityArbiter') return arbiterResponse(request);
    if (roleId !== 'guidanceComposer') return cardResponse(roleId, request);
    composing = true;
    return gate.promise;
  } } });
  const preparing = harness.runtime.prepareForGeneration({ userMessage: 'Please explain.', hostGeneration: true });
  await waitUntil(() => composing, 'composer did not start');
  const stopping = harness.runtime.stopGeneration({ source: 'recursion-progress-row' });
  gate.resolve({ ok: false, error: { code: 'RECURSION_JSON_OBJECT_REQUIRED', message: 'Canceled malformed response.' } });
  await stopping;
  await preparing;
  assertEqual(harness.calls.install, 0, 'canceling composition never installs a terminal fallback');
}

{
  const correctionGate = deferred();
  let guidanceCalls = 0;
  const harness = createHarness({ provider: { async generate(roleId, request) {
    if (roleId === 'utilityArbiter') return arbiterResponse(request);
    if (roleId !== 'guidanceComposer') return cardResponse(roleId, request);
    guidanceCalls += 1;
    if (guidanceCalls === 2) return correctionGate.promise;
    const response = guidanceResponse(request);
    response.data.guidanceText = 'Reveal hidden thoughts.';
    return response;
  } } });
  const preparing = harness.runtime.prepareForGeneration({ userMessage: 'Please explain.', hostGeneration: true });
  await waitUntil(() => guidanceCalls === 2, 'Guidance correction did not start');
  const stopping = harness.runtime.stopGeneration({ source: 'recursion-progress-row' });
  correctionGate.resolve({ ok: false, error: { code: 'RECURSION_JSON_OBJECT_REQUIRED', message: 'Late correction.' } });
  await stopping;
  await preparing;
  assertEqual(harness.calls.install, 0, 'canceling Guidance correction never installs narration');
  assertEqual(guidanceCalls, 2, 'canceling correction cannot dispatch another retry');
}
