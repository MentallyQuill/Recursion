import {
  createCheckpoint,
  createPipelineRun,
  createStageRecord,
  normalizePipelineRun
} from '../../src/execution/checkpoints.mjs';
import { createExecutionScheduler } from '../../src/execution/scheduler.mjs';
import { createExecutionGraph } from '../../src/execution/stage-registry.mjs';
import { stableHash } from '../../src/execution/provenance.mjs';
import { assert, assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

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

async function flushPromises(count = 12) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function waitUntil(predicate, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function createRepository({
  failArtifact = null,
  failManifest = null
} = {}) {
  const manifests = new Map();
  const artifacts = new Map();
  const queued = new Map();
  const manifestWrites = [];
  const artifactWrites = [];
  return {
    manifests,
    artifacts,
    queued,
    manifestWrites,
    artifactWrites,
    async loadPipelineRun(chatKey) {
      return clone(manifests.get(chatKey) || null);
    },
    async savePipelineRun(chatKey, manifest) {
      if (typeof failManifest === 'function' && failManifest(manifest, manifestWrites)) {
        throw new Error('manifest write failed');
      }
      const stored = clone(manifest);
      manifests.set(chatKey, stored);
      manifestWrites.push(stored);
      return clone(stored);
    },
    async loadPipelineArtifact(chatKey, operationId, artifactId) {
      return clone(artifacts.get(`${chatKey}|${operationId}|${artifactId}`) || null);
    },
    async savePipelineArtifact(chatKey, operationId, artifactId, artifact) {
      if (typeof failArtifact === 'function' && failArtifact({ chatKey, operationId, artifactId, artifact })) {
        throw new Error('artifact write failed');
      }
      const body = clone(artifact);
      const hash = await stableHash(body);
      const key = `artifact:${chatKey}:${operationId}:${artifactId}`;
      artifacts.set(`${chatKey}|${operationId}|${artifactId}`, body);
      artifactWrites.push({ chatKey, operationId, artifactId, artifact: body, hash });
      return { kind: 'logical-storage', key, hash };
    },
    async loadQueuedReprocess(chatKey) {
      return clone(queued.get(chatKey) || null);
    },
    async saveQueuedReprocess(chatKey, intent) {
      queued.set(chatKey, clone(intent));
      return clone(intent);
    },
    async clearQueuedReprocess(chatKey) {
      queued.delete(chatKey);
      return { ok: true };
    }
  };
}

const provenance = {
  chatKey: 'chat-a',
  sourceIdentity: {
    sourceRevisionHash: 'source-a',
    latestMessageId: 'message-a',
    selectedSwipeId: 'swipe-a',
    characterHash: 'character-a',
    groupHash: ''
  },
  settingsHash: 'settings-a',
  provider: { id: 'provider-a', model: 'model-a' },
  pipelineMode: 'segmented',
  promptVersions: { scheduler: 1 }
};

function manifest({
  operationId = 'run-a',
  chatKey = 'chat-a',
  runProvenance = provenance
} = {}) {
  return createPipelineRun({
    operationId,
    chatKey,
    phase: 'preprocess',
    pipelineMode: 'segmented',
    sourceIdentity: runProvenance.sourceIdentity,
    provenance: { ...runProvenance, chatKey },
    createdAt: '2026-07-29T12:00:00.000Z'
  });
}

function stage(id, dependencies, run, {
  failurePolicy = 'blocking',
  input = id,
  kind = 'model'
} = {}) {
  return {
    id,
    version: 1,
    kind,
    executable: true,
    dependencies,
    checkpoint: 'durable',
    failurePolicy,
    buildInputFingerprint(context, dependencyArtifacts) {
      return {
        input: context.inputs?.[id] ?? input,
        dependencyHashes: Object.fromEntries(
          Object.entries(dependencyArtifacts).map(([stageId, value]) => [
            stageId,
            value.checkpoint?.outputHash || value.stateHash
          ])
        )
      };
    },
    buildRequest(context, dependencyArtifacts) {
      return { id, context, dependencyArtifacts };
    },
    run,
    validate(artifact) {
      return artifact && typeof artifact === 'object'
        ? { ok: true, value: artifact }
        : { ok: false, error: { code: 'RECURSION_TEST_ARTIFACT_INVALID' } };
    },
    summarizeArtifact(artifact) {
      return { keys: Object.keys(artifact).sort() };
    }
  };
}

function createClock() {
  let tick = 0;
  return () => `2026-07-29T12:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function createIds() {
  let id = 0;
  return (prefix = 'id') => `${prefix}-${++id}`;
}

{
  const repository = createRepository();
  const arbiter = deferred();
  const cardA = deferred();
  const cardB = deferred();
  const cardAResume = deferred();
  const cardBResume = deferred();
  let cardACalls = 0;
  let cardBCalls = 0;
  const graph = createExecutionGraph({
    stages: [
      stage('arbiter', [], () => arbiter.promise),
      stage('card.a', ['arbiter'], () => (++cardACalls === 1 ? cardA.promise : cardAResume.promise)),
      stage('card.b', ['arbiter'], () => (++cardBCalls === 1 ? cardB.promise : cardBResume.promise))
    ]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 2
  });

  const startPromise = scheduler.start({ manifest: manifest(), graph, context: {} });
  await waitUntil(
    async () => (await repository.loadPipelineRun('chat-a'))?.frontierStageIds?.[0] === 'arbiter',
    'scheduler did not persist the root frontier'
  );
  arbiter.resolve({ selected: ['a', 'b'] });
  await waitUntil(
    async () => {
      const saved = await repository.loadPipelineRun('chat-a');
      return saved?.stageRecords?.['card.a']?.state === 'running'
        && saved?.stageRecords?.['card.b']?.state === 'running';
    },
    'scheduler did not start concurrent child frontier'
  );
  await scheduler.pause({ operationId: 'run-a', reason: 'user' });
  const paused = await repository.loadPipelineRun('chat-a');
  assertEqual(paused.state, 'paused', 'pause persists operation state');
  assertDeepEqual(paused.stageRecords.arbiter.summary, { keys: ['selected'] }, 'completed stage persists only its adapter-provided safe summary');
  assertEqual(paused.stageRecords['card.a'].state, 'pending', 'pause returns interrupted child A to pending');
  assertEqual(paused.stageRecords['card.b'].state, 'pending', 'pause returns interrupted child B to pending');
  assertEqual(paused.stageRecords['card.a'].attempts.used, 1, 'interrupted attempt is recorded');
  assertEqual(paused.stageRecords['card.b'].attempts.used, 1, 'operation stop interrupts every running child');

  cardA.resolve({ value: 'late-a' });
  cardB.resolve({ value: 'late-b' });
  await startPromise;
  await flushPromises();
  const afterLate = await repository.loadPipelineRun('chat-a');
  assertEqual(afterLate.stageRecords['card.a'].checkpoint, null, 'late child A cannot commit');
  assertEqual(afterLate.stageRecords['card.b'].checkpoint, null, 'late child B cannot commit');
  assertEqual(repository.artifactWrites.length, 1, 'only the committed Arbiter artifact was stored');

  const resumed = scheduler.resume({
    operationId: 'run-a',
    graph,
    context: {},
    provenance
  });
  await waitUntil(
    async () => (await repository.loadPipelineRun('chat-a'))?.stageRecords?.['card.a']?.attempts?.window === 2,
    'resume did not open a fresh attempt window'
  );
  const resumedManifest = await repository.loadPipelineRun('chat-a');
  assertEqual(resumedManifest.stageRecords['card.a'].attempts.used, 0, 'fresh Resume window resets used attempts');
  assertEqual(resumedManifest.stageRecords['card.a'].attempts.total, 1, 'fresh Resume window preserves monotonic total');
  await scheduler.pause({ operationId: 'run-a', reason: 'test-end' });
  await resumed;
}

{
  const repository = createRepository({
    failArtifact: ({ artifactId }) => artifactId.startsWith('root.')
  });
  const graph = createExecutionGraph({
    stages: [stage('root', [], async () => ({ value: 'root' }))]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  await scheduler.start({ manifest: manifest({ operationId: 'artifact-failure' }), graph, context: {} });
  const saved = await repository.loadPipelineRun('chat-a');
  assertEqual(saved.state, 'paused', 'blocking artifact write failure pauses the operation');
  assertEqual(saved.stageRecords.root.state, 'failed', 'artifact write failure marks the stage failed');
  assertEqual(saved.stageRecords.root.checkpoint, null, 'artifact write failure never creates a checkpoint');
}

{
  const repository = createRepository();
  const actionableStage = {
    ...stage('actionable-card', [], async () => ({ invalid: true })),
    validate() {
      return {
        ok: false,
        error: {
          code: 'RECURSION_PROVIDER_SCHEMA_MISMATCH',
          category: 'provider-output',
          message: 'Active Cast provider output did not match recursion.card.v1.',
          retryable: true,
          suggestedAction: 'Retry Active Cast.'
        }
      };
    }
  };
  const graph = createExecutionGraph({ stages: [actionableStage] });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  await scheduler.start({ manifest: manifest({ operationId: 'actionable-failure' }), graph, context: {} });
  const saved = await repository.loadPipelineRun('chat-a');
  assertEqual(saved.stageRecords['actionable-card'].failure.message, 'Active Cast provider output did not match recursion.card.v1.', 'durable stage failure persists the actionable message');
  assertEqual(saved.stageRecords['actionable-card'].failure.suggestedAction, 'Retry Active Cast.', 'durable stage failure persists the suggested action');
  const normalized = normalizePipelineRun(saved);
  assertEqual(normalized.stageRecords['actionable-card'].failure.message, 'Active Cast provider output did not match recursion.card.v1.', 'pipeline normalization preserves the actionable failure message');
  assertEqual(normalized.stageRecords['actionable-card'].failure.suggestedAction, 'Retry Active Cast.', 'pipeline normalization preserves the suggested action');
}

{
  let rejectCheckpointManifest = false;
  const repository = createRepository({
    failManifest: (candidate) => (
      rejectCheckpointManifest
      && candidate.stageRecords?.root?.checkpoint
    )
  });
  const graph = createExecutionGraph({
    stages: [stage('root', [], async () => ({ value: 'new-root' }))]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  rejectCheckpointManifest = true;
  await scheduler.start({ manifest: manifest({ operationId: 'manifest-failure' }), graph, context: {} });
  const saved = await repository.loadPipelineRun('chat-a');
  assertEqual(saved.stageRecords.root.checkpoint, null, 'failed manifest commit leaves the prior checkpoint state authoritative');
  assertEqual(repository.artifactWrites.length, 1, 'unreferenced artifact may remain for later cleanup');
}

{
  const repository = createRepository();
  let rootCalls = 0;
  const graph = createExecutionGraph({
    stages: [stage('root', [], async () => {
      rootCalls += 1;
      return { value: 'cached-root' };
    })]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 2
  });
  await scheduler.start({ manifest: manifest({ operationId: 'reuse-run' }), graph, context: {} });
  const completed = await repository.loadPipelineRun('chat-a');
  assertEqual(completed.state, 'completed', 'initial operation completes');
  repository.manifests.set('chat-a', { ...completed, state: 'paused', pauseReason: 'manual' });
  await scheduler.resume({
    operationId: 'reuse-run',
    graph,
    context: {},
    provenance
  });
  assertEqual(rootCalls, 1, 'Resume reuses a valid completed checkpoint');
  assertEqual((await repository.loadPipelineRun('chat-a')).state, 'completed', 'checkpoint-only Resume completes without invocation');
}

{
  const repository = createRepository();
  const gate = deferred();
  let calls = 0;
  const graph = createExecutionGraph({
    stages: [stage('root', [], () => {
      calls += 1;
      return gate.promise;
    })]
  });
  await repository.savePipelineRun('chat-a', manifest({ operationId: 'persisted-resume' }));
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  const first = scheduler.resume({
    operationId: 'persisted-resume',
    graph,
    context: {},
    provenance
  });
  const duplicate = scheduler.resume({
    operationId: 'persisted-resume',
    graph,
    context: {},
    provenance
  });
  assertEqual(first, duplicate, 'duplicate persisted Resume calls share one transition promise');
  await waitUntil(() => calls === 1, 'persisted Resume did not start exactly one stage invocation');
  await scheduler.pause({ operationId: 'persisted-resume', reason: 'test-end' });
  await first;
  assertEqual(calls, 1, 'duplicate persisted Resume never duplicates stage execution');
}

{
  const repository = createRepository();
  let rootValue = 'same';
  let rootCalls = 0;
  let childCalls = 0;
  let siblingCalls = 0;
  const graph = createExecutionGraph({
    stages: [
      stage('root', [], async () => {
        rootCalls += 1;
        return { value: rootValue };
      }),
      stage('child', ['root'], async () => {
        childCalls += 1;
        return { value: `child-${rootValue}` };
      }),
      stage('sibling', [], async () => {
        siblingCalls += 1;
        return { value: 'sibling' };
      })
    ]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 2
  });
  await scheduler.start({ manifest: manifest({ operationId: 'dependency-run' }), graph, context: {} });
  assertDeepEqual([rootCalls, childCalls, siblingCalls], [1, 1, 1], 'initial dependency graph executes once');

  let saved = await repository.loadPipelineRun('chat-a');
  repository.manifests.set('chat-a', {
    ...saved,
    state: 'paused',
    pauseReason: 'reprocess',
    queuedStageIds: ['root']
  });
  await scheduler.resume({
    operationId: 'dependency-run',
    graph,
    context: {},
    provenance
  });
  assertDeepEqual(
    [rootCalls, childCalls, siblingCalls],
    [2, 1, 1],
    'same ancestor output hash leaves descendant and independent sibling reusable'
  );

  rootValue = 'changed';
  saved = await repository.loadPipelineRun('chat-a');
  repository.manifests.set('chat-a', {
    ...saved,
    state: 'paused',
    pauseReason: 'reprocess',
    queuedStageIds: ['root']
  });
  await scheduler.resume({
    operationId: 'dependency-run',
    graph,
    context: {},
    provenance
  });
  assertDeepEqual(
    [rootCalls, childCalls, siblingCalls],
    [3, 2, 1],
    'changed ancestor output reruns only its descendant'
  );
}

{
  const repository = createRepository();
  const freshRootGate = deferred();
  let fresh = false;
  let rootCalls = 0;
  let childCalls = 0;
  const graph = createExecutionGraph({
    stages: [
      stage('root', [], async () => {
        rootCalls += 1;
        return fresh ? freshRootGate.promise : { value: 'old-root' };
      }),
      stage('child', ['root'], async () => {
        childCalls += 1;
        return { value: `child-${rootCalls}` };
      })
    ]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  await scheduler.start({ manifest: manifest({ operationId: 'full-fresh-order' }), graph, context: {} });
  assertDeepEqual([rootCalls, childCalls], [1, 1], 'initial dependency operation completes');
  const completed = await repository.loadPipelineRun('chat-a');
  repository.manifests.set('chat-a', {
    ...completed,
    state: 'paused',
    pauseReason: 'full-fresh',
    queuedStageIds: ['root', 'child']
  });
  fresh = true;
  const rerun = scheduler.resume({
    operationId: 'full-fresh-order',
    graph,
    context: {},
    provenance
  });
  await waitUntil(
    async () => (await repository.loadPipelineRun('chat-a'))?.stageRecords?.root?.state === 'running',
    'Full Fresh root did not start'
  );
  await flushPromises();
  assertEqual(childCalls, 1, 'forced descendant waits for its forced ancestor replacement');
  freshRootGate.resolve({ value: 'new-root' });
  await rerun;
  assertDeepEqual([rootCalls, childCalls], [2, 2], 'forced descendant starts after the new ancestor checkpoint commits');
}

{
  const repository = createRepository();
  let goodCalls = 0;
  let badCalls = 0;
  const graph = createExecutionGraph({
    stages: [
      stage('root', [], async () => ({ value: 'root' })),
      stage('good', ['root'], async () => {
        goodCalls += 1;
        return { value: 'good' };
      }),
      stage('bad', ['root'], async () => {
        badCalls += 1;
        throw Object.assign(new Error('bad child'), {
          code: 'RECURSION_TEST_CHILD_FAILED',
          retryable: true
        });
      })
    ]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  await scheduler.start({ manifest: manifest({ operationId: 'sibling-run' }), graph, context: {} });
  const saved = await repository.loadPipelineRun('chat-a');
  assertEqual(saved.state, 'paused', 'blocking exhausted child pauses operation');
  assertEqual(saved.stageRecords.good.state, 'completed', 'successful concurrent sibling remains completed');
  assertEqual(saved.stageRecords.bad.state, 'failed', 'failed child remains failed');
  assertDeepEqual([goodCalls, badCalls], [1, 1], 'concurrent children each run once');

  const firstResume = scheduler.resume({
    operationId: 'sibling-run',
    graph,
    context: {},
    provenance
  });
  const duplicateResume = scheduler.resume({
    operationId: 'sibling-run',
    graph,
    context: {},
    provenance
  });
  assertEqual(firstResume, duplicateResume, 'duplicate Resume returns the active execution promise');
  await firstResume;
}

{
  const repository = createRepository();
  const originalLoad = repository.loadPipelineRun.bind(repository);
  const originalSave = repository.savePipelineRun.bind(repository);
  const siblingCommit = deferred();
  let delayedSiblingRead = false;
  repository.loadPipelineRun = async (chatKey) => {
    const snapshot = await originalLoad(chatKey);
    const siblingRecords = [
      snapshot?.stageRecords?.left,
      snapshot?.stageRecords?.right
    ];
    if (
      !delayedSiblingRead
      && repository.artifactWrites.some((entry) => (
        entry.artifactId.startsWith('left.')
        || entry.artifactId.startsWith('right.')
      ))
      && siblingRecords.every((record) => record?.state === 'running')
    ) {
      delayedSiblingRead = true;
      await siblingCommit.promise;
    }
    return snapshot;
  };
  repository.savePipelineRun = async (chatKey, nextManifest) => {
    const stored = await originalSave(chatKey, nextManifest);
    if (
      stored.stageRecords?.left?.state === 'completed'
      || stored.stageRecords?.right?.state === 'completed'
    ) {
      siblingCommit.resolve();
    }
    return stored;
  };
  const graph = createExecutionGraph({
    stages: [
      stage('root', [], async () => ({ value: 'root' })),
      stage('left', ['root'], async () => ({ value: 'left' })),
      stage('right', ['root'], async () => ({ value: 'right' }))
    ]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  await scheduler.start({
    manifest: manifest({ operationId: 'slow-storage-siblings' }),
    graph,
    context: {}
  });
  const saved = await repository.loadPipelineRun('chat-a');
  assertEqual(delayedSiblingRead, true, 'test forces one stale sibling pre-commit read');
  assertEqual(saved.state, 'completed', 'slow storage must not strand a completed sibling wave');
  assertEqual(saved.stageRecords.left.state, 'completed', 'left sibling checkpoint commits');
  assertEqual(saved.stageRecords.right.state, 'completed', 'right sibling checkpoint commits');
}

{
  const repository = createRepository();
  const graph = createExecutionGraph({
    stages: [stage('root', [], async () => ({ value: 'root' }))]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  const staleManifest = manifest({ operationId: 'stale-run' });
  await repository.savePipelineRun('chat-a', staleManifest);
  const staleResult = await scheduler.resume({
    operationId: 'stale-run',
    graph,
    context: {},
    provenance: { ...provenance, settingsHash: 'settings-b' }
  });
  assertEqual(staleResult.ok, false, 'Resume rejects changed provenance');
  assertEqual(staleResult.stale, true, 'Resume reports stale result');
  const saved = await repository.loadPipelineRun('chat-a');
  assertEqual(saved.state, 'stale', 'provenance mismatch persists stale operation');
  assertDeepEqual(saved.staleChangedFields, ['settingsHash'], 'stale manifest records only changed field names');
}

{
  const repository = createRepository();
  const rootGate = deferred();
  const graph = createExecutionGraph({
    stages: [
      stage('root', [], () => rootGate.promise),
      stage('selected-child', ['root'], async () => ({ value: 'child' }))
    ]
  });
  const queuedManifest = {
    ...manifest({ operationId: 'queued-before-start' }),
    queuedStageIds: ['selected-child']
  };
  await repository.saveQueuedReprocess('chat-a', {
    schema: 'recursion.queued-reprocess.v1',
    mode: 'stage',
    stageIds: ['selected-child']
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  const running = scheduler.start({ manifest: queuedManifest, graph, context: {} });
  await waitUntil(
    async () => (await repository.loadPipelineRun('chat-a'))?.stageRecords?.root?.state === 'running',
    'queued-intent prerequisite root did not start'
  );
  await scheduler.pause({ operationId: 'queued-before-start', reason: 'user' });
  await running;
  assert(
    await repository.loadQueuedReprocess('chat-a'),
    'Stop before the selected root begins leaves the chat-scoped intent queued'
  );
}

{
  const repository = createRepository();
  const selectedGate = deferred();
  const graph = createExecutionGraph({
    stages: [stage('selected-root', [], () => selectedGate.promise)]
  });
  const queuedManifest = {
    ...manifest({ operationId: 'queued-stage-start' }),
    queuedStageIds: ['selected-root']
  };
  await repository.saveQueuedReprocess('chat-a', {
    schema: 'recursion.queued-reprocess.v1',
    mode: 'stage',
    stageIds: ['selected-root']
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  const running = scheduler.start({ manifest: queuedManifest, graph, context: {} });
  await waitUntil(
    async () => (await repository.loadPipelineRun('chat-a'))?.stageRecords?.['selected-root']?.state === 'running',
    'selected queued root did not start'
  );
  await waitUntil(
    async () => (await repository.loadQueuedReprocess('chat-a')) === null,
    'selected root start did not consume queued intent'
  );
  await scheduler.pause({ operationId: 'queued-stage-start', reason: 'user' });
  await running;
}

{
  const repository = createRepository();
  let failSelectedRerun = false;
  const graph = createExecutionGraph({
    stages: [stage('selected-root', [], async () => {
      if (failSelectedRerun) {
        throw Object.assign(new Error('selected rerun failed'), {
          code: 'RECURSION_TEST_SELECTED_RERUN_FAILED'
        });
      }
      return { value: 'old-artifact' };
    })]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  await scheduler.start({
    manifest: manifest({ operationId: 'selected-rerun' }),
    graph,
    context: {}
  });
  const completed = await repository.loadPipelineRun('chat-a');
  const oldArtifactCount = repository.artifacts.size;
  repository.manifests.set('chat-a', {
    ...completed,
    state: 'paused',
    pauseReason: 'reprocess',
    queuedStageIds: ['selected-root']
  });
  await repository.saveQueuedReprocess('chat-a', {
    schema: 'recursion.queued-reprocess.v1',
    mode: 'stage',
    stageIds: ['selected-root']
  });
  failSelectedRerun = true;
  await scheduler.resume({
    operationId: 'selected-rerun',
    graph,
    context: {},
    provenance
  });
  const failed = await repository.loadPipelineRun('chat-a');
  assertEqual(failed.stageRecords['selected-root'].state, 'failed', 'selected rerun failure remains visible');
  assertEqual(failed.stageRecords['selected-root'].checkpoint, null, 'failed selected stage cannot fall back to its old checkpoint');
  assertEqual(repository.artifacts.size, oldArtifactCount, 'old artifact body remains stored until retention cleanup');
  assertEqual(await repository.loadQueuedReprocess('chat-a'), null, 'selected stage start consumes intent even when the rerun fails');
}

{
  const repository = createRepository();
  const gate = deferred();
  const graph = createExecutionGraph({
    stages: [stage('root', [], () => gate.promise)]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 1
  });
  const oldStart = scheduler.start({
    manifest: manifest({ operationId: 'old-run', chatKey: 'same-chat' }),
    graph,
    context: {}
  });
  await waitUntil(
    async () => (await repository.loadPipelineRun('same-chat'))?.state === 'running',
    'old operation did not start'
  );
  const newStart = scheduler.start({
    manifest: manifest({ operationId: 'new-run', chatKey: 'same-chat' }),
    graph: createExecutionGraph({
      stages: [stage('new-root', [], async () => ({ value: 'new' }))]
    }),
    context: {}
  });
  await waitUntil(
    () => repository.manifestWrites.some((entry) => (
      entry.operationId === 'old-run' && entry.state === 'abandoned'
    )),
    'new same-chat operation did not abandon the old operation first'
  );
  const oldAbandonedIndex = repository.manifestWrites.findIndex((entry) => (
    entry.operationId === 'old-run' && entry.state === 'abandoned'
  ));
  const newRunningIndex = repository.manifestWrites.findIndex((entry) => (
    entry.operationId === 'new-run' && entry.state === 'running'
  ));
  assert(oldAbandonedIndex >= 0 && oldAbandonedIndex < newRunningIndex, 'old operation is abandoned before new operation becomes active');

  const otherStart = scheduler.start({
    manifest: manifest({ operationId: 'other-run', chatKey: 'other-chat' }),
    graph: createExecutionGraph({
      stages: [stage('other-root', [], async () => ({ value: 'other' }))]
    }),
    context: {}
  });
  await Promise.all([oldStart, newStart, otherStart]);
  assertEqual((await repository.loadPipelineRun('other-chat')).state, 'completed', 'different chat may complete its own operation');
}

{
  const repository = createRepository();
  let calls = 0;
  const graph = createExecutionGraph({
    stages: [stage('root', [], async () => {
      calls += 1;
      if (calls <= 2) {
        throw Object.assign(new Error('retry me'), {
          code: 'RECURSION_TEST_RETRY',
          retryable: true
        });
      }
      return { value: 'recovered' };
    })]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 2
  });
  await scheduler.start({ manifest: manifest({ operationId: 'retry-run' }), graph, context: {} });
  let saved = await repository.loadPipelineRun('chat-a');
  assertEqual(saved.stageRecords.root.attempts.used, 2, 'failed stage exhausts its first attempt window');
  assertEqual(saved.stageRecords.root.attempts.total, 2, 'first attempt window records monotonic total');
  await scheduler.retry({
    operationId: 'retry-run',
    stageId: 'root',
    graph,
    context: {},
    provenance
  });
  saved = await repository.loadPipelineRun('chat-a');
  assertEqual(saved.state, 'completed', 'manual Retry opens a fresh window that can complete');
  assertEqual(saved.stageRecords.root.attempts.window, 2, 'manual Retry increments attempt window');
  assertEqual(saved.stageRecords.root.attempts.used, 1, 'manual Retry resets used attempts for the new window');
  assertEqual(saved.stageRecords.root.attempts.total, 3, 'manual Retry preserves monotonic total');
}

{
  const repository = createRepository();
  let deckDependencies = null;
  const graph = createExecutionGraph({
    stages: [
      stage('arbiter', [], async () => ({ selected: ['character'] })),
      stage('card.character', ['arbiter'], async () => {
        throw Object.assign(new Error('optional card failed'), {
          code: 'RECURSION_TEST_OPTIONAL_CARD_FAILED',
          retryable: false
        });
      }, { failurePolicy: 'continue' }),
      stage('deck', ['arbiter', 'card.character'], async ({ dependencies }) => {
        deckDependencies = dependencies;
        return { cardCount: 0 };
      }, { kind: 'local' })
    ]
  });
  const scheduler = createExecutionScheduler({
    repository,
    now: createClock(),
    createId: createIds(),
    attemptsPerStep: 2
  });
  await scheduler.start({
    manifest: manifest({ operationId: 'continue-dependency-run' }),
    graph,
    context: {}
  });
  const saved = await repository.loadPipelineRun('chat-a');
  assertEqual(saved.state, 'completed', 'failed optional dependency does not block local descendant');
  assertEqual(saved.stageRecords['card.character'].state, 'failed', 'optional failed stage remains visible');
  assertEqual(saved.stageRecords.deck.state, 'completed', 'local descendant runs after optional dependency settles');
  assertEqual(saved.stageRecords.deck.attempts.total, 0, 'local bookkeeping does not consume model attempts');
  assertEqual(deckDependencies['card.character'].state, 'failed', 'local descendant receives failed optional dependency state');
  assertEqual(deckDependencies['card.character'].artifact, null, 'failed optional dependency has no fabricated artifact');
}

await assertRejects(
  async () => createExecutionScheduler({ repository: {} }),
  /repository/i,
  'scheduler requires durable repository methods'
);

console.log('Execution scheduler tests passed.');
