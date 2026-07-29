import { createExecutionGraph } from '../../src/execution/stage-registry.mjs';
import {
  bindQueuedReprocess,
  consumeQueuedStageStart,
  mergeQueuedReprocess,
  normalizeQueuedReprocess,
  planReprocess
} from '../../src/execution/queued-reprocess.mjs';
import {
  createCheckpoint,
  createPipelineRun,
  createStageRecord
} from '../../src/execution/checkpoints.mjs';
import { assert, assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

function stage(id, dependencies = []) {
  return {
    id,
    version: 1,
    kind: 'model',
    executable: true,
    dependencies,
    checkpoint: 'durable',
    failurePolicy: 'continue'
  };
}

const graph = createExecutionGraph({
  stages: [
    stage('preprocess.arbiter'),
    stage('preprocess.cards.segmented.character', ['preprocess.arbiter']),
    stage('preprocess.cards.segmented.setting', ['preprocess.arbiter']),
    stage('preprocess.compose', [
      'preprocess.cards.segmented.character',
      'preprocess.cards.segmented.setting'
    ])
  ]
});

assertDeepEqual(
  graph.topologicalStageIds,
  [
    'preprocess.arbiter',
    'preprocess.cards.segmented.character',
    'preprocess.cards.segmented.setting',
    'preprocess.compose'
  ],
  'graph builds a stable topological order'
);
assertDeepEqual(
  graph.dependentIds('preprocess.arbiter'),
  ['preprocess.cards.segmented.character', 'preprocess.cards.segmented.setting'],
  'graph builds direct reverse dependencies'
);
assertDeepEqual(
  graph.descendantIds('preprocess.arbiter'),
  [
    'preprocess.cards.segmented.character',
    'preprocess.cards.segmented.setting',
    'preprocess.compose'
  ],
  'graph resolves transitive descendants once'
);

await assertRejects(
  async () => createExecutionGraph({ stages: [stage('duplicate'), stage('duplicate')] }),
  /duplicate/i,
  'graph rejects duplicate ids'
);
await assertRejects(
  async () => createExecutionGraph({ stages: [stage('child', ['missing'])] }),
  /missing dependency/i,
  'graph rejects missing dependencies'
);
await assertRejects(
  async () => createExecutionGraph({
    stages: [
      stage('cycle.a', ['cycle.b']),
      stage('cycle.b', ['cycle.a'])
    ]
  }),
  /cycle/i,
  'graph rejects cycles'
);

const provenance = {
  chatKey: 'chat-reprocess',
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
  promptVersions: { arbiter: 1, card: 1 }
};

function completedRecord(stageId, outputHash, dependencyHashes = {}) {
  const record = createStageRecord({
    stageId,
    stageVersion: 1,
    kind: 'model',
    attemptsLimit: 2,
    updatedAt: '2026-07-29T12:00:00.000Z'
  });
  return {
    ...record,
    state: 'completed',
    checkpoint: createCheckpoint({
      operationId: 'run-reprocess',
      stageId,
      stageVersion: 1,
      inputHash: `input:${stageId}`,
      outputHash,
      dependencyHashes,
      provenance,
      attempts: { window: 1, limit: 2, used: 1, total: 1 },
      artifactRef: {
        kind: 'logical-storage',
        key: `artifact:${stageId}`,
        hash: outputHash
      },
      completedAt: '2026-07-29T12:00:01.000Z'
    })
  };
}

const manifest = {
  ...createPipelineRun({
    operationId: 'run-reprocess',
    chatKey: 'chat-reprocess',
    phase: 'preprocess',
    pipelineMode: 'segmented',
    sourceIdentity: provenance.sourceIdentity,
    provenance,
    createdAt: '2026-07-29T12:00:00.000Z'
  }),
  stageRecords: {
    'preprocess.arbiter': completedRecord('preprocess.arbiter', 'hash-arbiter'),
    'preprocess.cards.segmented.character': completedRecord(
      'preprocess.cards.segmented.character',
      'hash-character',
      { 'preprocess.arbiter': 'hash-arbiter' }
    ),
    'preprocess.cards.segmented.setting': completedRecord(
      'preprocess.cards.segmented.setting',
      'hash-setting',
      { 'preprocess.arbiter': 'hash-arbiter' }
    ),
    'preprocess.compose': completedRecord(
      'preprocess.compose',
      'hash-compose',
      {
        'preprocess.cards.segmented.character': 'hash-character',
        'preprocess.cards.segmented.setting': 'hash-setting'
      }
    )
  }
};

const merged = mergeQueuedReprocess(
  { stageIds: ['preprocess.cards.segmented.character'] },
  { stageIds: ['preprocess.arbiter'] },
  graph
);
assertDeepEqual(merged, {
  schema: 'recursion.queued-reprocess.v1',
  mode: 'stage',
  stageIds: ['preprocess.arbiter']
}, 'queued ancestor subsumes a queued descendant');

const siblingMerge = mergeQueuedReprocess(
  { stageIds: ['preprocess.cards.segmented.character'] },
  { stageIds: ['preprocess.cards.segmented.setting'] },
  graph
);
assertDeepEqual(
  siblingMerge.stageIds,
  ['preprocess.cards.segmented.character', 'preprocess.cards.segmented.setting'],
  'independent queued siblings are preserved'
);

const plan = planReprocess({
  graph,
  manifest,
  selectedStageIds: ['preprocess.cards.segmented.character'],
  fullFresh: false
});
assertDeepEqual(
  plan.forcedStageIds,
  ['preprocess.cards.segmented.character'],
  'selected stage is forced to rerun even when its checkpoint input is unchanged'
);
assert(plan.reusableStageIds.includes('preprocess.cards.segmented.setting'), 'independent sibling remains reusable');
assert(plan.reusableStageIds.includes('preprocess.compose'), 'descendant remains provisionally reusable until dependency hashes are recomputed');
assertDeepEqual(
  plan.invalidatedStageIds,
  ['preprocess.cards.segmented.character'],
  'planning does not eagerly discard descendant checkpoints'
);
assertEqual(
  manifest.stageRecords['preprocess.cards.segmented.character'].checkpoint.artifactRef.key,
  'artifact:preprocess.cards.segmented.character',
  'planning retains old artifact references until replacement commit'
);

const fullFreshPlan = planReprocess({
  graph,
  manifest,
  selectedStageIds: [],
  fullFresh: true
});
assertEqual(fullFreshPlan.bypassAllCheckpoints, true, 'full fresh bypasses every checkpoint');
assertDeepEqual(
  fullFreshPlan.invalidatedStageIds,
  graph.executableStageIds,
  'full fresh invalidates every executable stage'
);

const intent = normalizeQueuedReprocess({
  stageIds: ['preprocess.cards.segmented.character'],
  mode: 'stage'
});
const bound = bindQueuedReprocess({
  intent,
  graph,
  manifest,
  provenance
});
assertDeepEqual(
  bound.manifest.queuedStageIds,
  ['preprocess.cards.segmented.character'],
  'binding places selected roots on the manifest'
);
assertDeepEqual(bound.intent, intent, 'binding alone leaves the persisted intent queued');
assertEqual(
  bound.manifest.stageRecords['preprocess.cards.segmented.character'].checkpoint.outputHash,
  'hash-character',
  'binding alone retains the old checkpoint'
);

const unrelatedStart = consumeQueuedStageStart({
  intent: bound.intent,
  stageId: 'preprocess.arbiter'
});
assertEqual(unrelatedStart.consumed, false, 'unrelated stage start does not consume queued intent');
assertDeepEqual(unrelatedStart.intent, intent, 'unrelated stage start keeps the intent');

const selectedStart = consumeQueuedStageStart({
  intent: bound.intent,
  stageId: 'preprocess.cards.segmented.character'
});
assertEqual(selectedStart.consumed, true, 'selected root start consumes its intent once');
assertEqual(selectedStart.intent, null, 'last selected root clears the persisted intent');

const inapplicable = bindQueuedReprocess({
  intent: {
    schema: 'recursion.queued-reprocess.v1',
    mode: 'stage',
    stageIds: ['preprocess.removed-stage']
  },
  graph,
  manifest,
  provenance
});
assertEqual(inapplicable.intent, null, 'inapplicable intent is cleared');
assertDeepEqual(inapplicable.manifest.queuedStageIds, [], 'inapplicable stage is never guessed or remapped');
assertEqual(inapplicable.notices[0].code, 'stage-reprocess-inapplicable', 'inapplicable intent emits bounded notice');

const canceled = normalizeQueuedReprocess({
  schema: 'recursion.queued-reprocess.v1',
  mode: 'canceled',
  stageIds: ['preprocess.arbiter']
});
assertDeepEqual(canceled, {
  schema: 'recursion.queued-reprocess.v1',
  mode: 'canceled',
  stageIds: []
}, 'canceled intent cannot affect a later operation');
assertEqual(
  bindQueuedReprocess({ intent: canceled, graph, manifest, provenance }).intent,
  null,
  'canceled intent binds as no action'
);

console.log('Queued reprocess tests passed.');
