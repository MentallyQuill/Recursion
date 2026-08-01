import { createActivityReporter } from '../../src/activity.mjs';
import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
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
  settings = {}
} = {}) {
  const calls = { install: 0, clear: 0 };
  let hostSnapshot = clone(currentSnapshot);
  const settingsStore = createSettingsStore({ root: {} });
  settingsStore.update({
    pipelineMode: 'segmented',
    modelAttemptsPerStep: 2,
    reasoningLevel: 'low',
    reasonerUse: 'off',
    ...settings
  });
  const host = {
    async snapshot() {
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
    generation: {}
  };
  const runtime = createRecursionRuntime({
    host,
    settingsStore,
    storage,
    activity: createActivityReporter(),
    generationRouter: provider,
    durablePreprocess: true
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
  const { runtime } = createHarness();
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
  assertEqual(runtime.getView().execution, null, 'empty restore does not manufacture execution state');
  assertEqual(runtime.getView().queuedReprocess, null, 'empty restore has no queued reprocess intent');
}

{
  const firstCardGate = deferred();
  const resumedCardGate = deferred();
  const calls = [];
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
  const { runtime, storage } = createHarness({ provider });
  const preparing = runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
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
  await runtime.pauseOperation({ reason: 'user' });
  const pausedView = runtime.getView();
  assertEqual(pausedView.execution.state, 'paused', 'Stop pauses the durable operation');
  assertEqual(
    pausedView.activity.label,
    'Operation paused. Completed work was saved.',
    'Stop confirms that completed work was saved'
  );
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

  const resumed = runtime.resumeOperation({ operationId: manifest.operationId });
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
  const restoredRuntime = createHarness({
    storage,
    provider: immediateProvider(restoredCalls)
  }).runtime;
  const restored = await restoredRuntime.restoreExecutionState();
  assertEqual(restored.state, 'paused', 'restoring a running manifest exposes a paused operation');
  assertEqual(
    restored.stageRecords[stageId].state,
    'pending',
    'restore converts an interrupted running stage back to pending'
  );
  assertEqual(restoredCalls.length, 0, 'restore never starts provider work');
  const resumed = await restoredRuntime.resumeOperation({
    operationId: restored.operationId
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
  let resumeError = null;
  try {
    await restoredRuntime.resumeOperation({ operationId: restored.operationId });
  } catch (error) {
    resumeError = error;
  }
  assert(resumeError, 'stale operations do not expose a usable Resume context');
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
  const { runtime, storage } = createHarness({ provider });
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
  let guidanceCalls = 0;
  const provider = {
    async generate(roleId, request = {}) {
      providerCalls.push({ roleId, request });
      if (roleId === 'utilityArbiter') return arbiterResponse(request);
      if (roleId === 'sceneFrameCard') return cardResponse(roleId, request);
      if (roleId === 'guidanceComposer') {
        guidanceCalls += 1;
        if (guidanceCalls <= 2) {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: 'wrong-snapshot',
              guidanceText: ''
            }
          };
        }
        return guidanceResponse(request);
      }
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({
    provider,
    settings: { modelAttemptsPerStep: 2 }
  });
  const failed = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  assertEqual(failed.paused, true, 'required guidance exhaustion pauses the operation');
  let manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.pauseReason, 'stage-failed:preprocess.guidance', 'guidance is the visible blocking failure');
  assertEqual(manifest.stageRecords['preprocess.guidance'].attempts.total, 2, 'guidance owns its two-attempt window');
  const guidanceRequests = providerCalls
    .filter((call) => call.roleId === 'guidanceComposer')
    .map((call) => call.request.prompt);
  assert(
    guidanceRequests[1] !== guidanceRequests[0],
    'the second guidance attempt uses an explicit correction request'
  );

  const retried = await runtime.retryStage({
    operationId: manifest.operationId,
    stageId: 'preprocess.guidance'
  });
  assertEqual(retried.ok, true, 'Retry opens a fresh guidance attempt window and settles');
  manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.stageRecords['preprocess.guidance'].state, 'completed', 'Retry replaces the failed guidance checkpoint');
  assertEqual(
    providerCalls.filter((call) => call.roleId === 'utilityArbiter').length,
    1,
    'Retry does not rerun Arbiter'
  );
  assertEqual(
    providerCalls.filter((call) => call.roleId === 'sceneFrameCard').length,
    1,
    'Retry does not rerun completed cards'
  );
  assertEqual(guidanceCalls, 3, 'Retry targets only required guidance');
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

  assertEqual(result.ok, true, 'corrected empty refresh plan completes');
  assertEqual(arbiterAttempts, 2, 'empty refresh plan consumes the Arbiter correction attempt');
  assert(
    providerCalls[1].request.prompt.includes('refresh-cards requires at least one executable card job'),
    'correction request explains the semantic invariant'
  );
  assertEqual(
    providerCalls.filter((entry) => entry.roleId === 'fusedCardBundle').length,
    1,
    'corrected plan creates one Fused bundle call'
  );
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.stageRecords['preprocess.arbiter'].attempts.total, 2, 'Arbiter records both attempts');
  assertEqual(manifest.stageRecords['preprocess.cards.fused'].state, 'completed', 'corrected Fused stage completes');
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
    settings: { pipelineMode: 'fused' }
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
    settings: { pipelineMode: 'segmented' }
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
            schema: 'recursion.card.v1',
            role: 'sceneFrameCard',
            family: 'Scene Frame',
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'Keep Mara beside the sealed archive.',
              evidenceRefs: ['message:2']
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
    settings: {
      pipelineMode: 'segmented',
      modelAttemptsPerStep: 2
    }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  assertEqual(result.ok, true, 'Segmented semantic card exhaustion remains fail-soft');
  assertEqual(cardAttempts.get('sceneFrameCard'), 1, 'valid sibling remains checkpointed during another card exhaustion');
  assertEqual(cardAttempts.get('activeCastCard'), 2, 'invalid Active Cast card consumes its bounded attempt window');
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  const activeFailure = manifest.stageRecords['preprocess.cards.segmented.active-cast'].failure;
  assertEqual(manifest.state, 'completed', 'continuing card failure does not block downstream completion');
  assertEqual(activeFailure.code, 'RECURSION_CARD_INVALID', 'semantic card exhaustion persists the stable failure code');
  assertEqual(activeFailure.message, 'Active Cast card failed semantic validation (catalog-mismatch).', 'semantic card exhaustion persists the exact reject reason');
  assertEqual(activeFailure.suggestedAction, 'Retry Active Cast. If it repeats, inspect the card validation reason.', 'semantic card exhaustion persists a useful action');
  assertEqual(manifest.stageRecords['preprocess.deck'].summary.providerCardCount, 1, 'valid sibling alone reaches the deck');
  assertEqual(manifest.stageRecords['preprocess.install'].state, 'completed', 'partial Segmented packet still installs');
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
            items: [{
              schema: 'recursion.card.v1',
              family: 'Scene Frame',
              role: 'sceneFrameCard',
              promptText: 'Keep Mara beside the sealed archive and preserve the immediate question.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 18
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
    settings: { pipelineMode: 'fused' }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });
  assertEqual(result.ok, true, 'partially useful Fused output completes the operation');
  assertEqual(
    providerCalls.filter((roleId) => roleId === 'fusedCardBundle').length,
    1,
    'a useful Fused sibling completes the Fused attempt window'
  );
  assertEqual(
    providerCalls.some((roleId) => roleId === 'sceneFrameCard' || roleId === 'activeCastCard'),
    false,
    'partial Fused success does not start secret Segmented repair calls'
  );
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(
    manifest.stageRecords['preprocess.cards.fused'].summary.acceptedFamilies.join(','),
    'Scene Frame',
    'the valid Fused sibling survives as the durable card artifact'
  );
  assertEqual(
    Object.hasOwn(manifest.stageRecords, 'preprocess.cards.segmented.scene-frame'),
    false,
    'partial Fused success does not add Segmented fallback stages'
  );
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
  await runtime.prepareForGeneration({
    hostGeneration: true,
    generationType: 'swipe'
  });
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
  const reset = await runtime.resetSceneCache();
  assertEqual(reset.ok, true, 'Reset Scene Cache clears durable execution state');
  assertEqual(
    await storage.loadPipelineRun('chat-preprocess'),
    null,
    'Reset Scene Cache removes the current execution manifest'
  );
  assertEqual(
    await storage.loadQueuedReprocess('chat-preprocess'),
    null,
    'Reset Scene Cache removes queued reprocess state'
  );
  assertEqual(runtime.getView().execution, null, 'Reset Scene Cache clears the runtime execution view');
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
  assertEqual(result.ok, true, 'prompt-install failure settles without failing primary generation');
  assertEqual(result.continuePrimaryGeneration, true, 'prompt-install failure permits primary generation');
  assertEqual(result.recursionPromptInstalled, false, 'prompt-install failure is explicit');
  assertEqual(calls.clear, 1, 'failed installation clears partial prompt residue once');
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assert(manifest.stageRecords['preprocess.packet'].checkpoint, 'prepared packet survives install failure');
  assertEqual(manifest.stageRecords['preprocess.install'].state, 'failed', 'settled install failure remains visible');
  assert(manifest.stageRecords['preprocess.install'].checkpoint, 'settled install failure is checkpointed and not retried implicitly');
}

console.log('[pass] runtime preprocess lifecycle');
