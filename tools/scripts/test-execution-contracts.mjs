import {
  buildRunProvenance,
  compareRunProvenance,
  stableHash
} from '../../src/execution/provenance.mjs';
import {
  CHECKPOINT_SCHEMA,
  PIPELINE_RUN_SCHEMA,
  createCheckpoint,
  createPipelineRun,
  createStageRecord,
  isCheckpointReusable,
  isTerminalOperationState,
  normalizeCheckpoint,
  normalizePipelineRun,
  normalizeStageRecord
} from '../../src/execution/checkpoints.mjs';
import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(PIPELINE_RUN_SCHEMA, 'recursion.pipelineRun.v2', 'pipeline manifests use the turn-scoped V2 schema');
assertEqual(CHECKPOINT_SCHEMA, 'recursion.stageCheckpoint.v2', 'stage checkpoints use the turn-scoped V2 schema');

const left = await stableHash({ b: 2, a: 1 });
const right = await stableHash({ a: 1, b: 2 });

assertEqual(left, right, 'stableHash ignores plain-object key insertion order');

const provenance = buildRunProvenance({
  chatKey: 'chat-a',
  turnKeyHash: 'turn-a',
  sourceBandHash: 'source-band-a',
  sourceIdentity: {
    sourceRevisionHash: 'source-a',
    latestMessageId: 'message-7',
    selectedSwipeId: 'swipe-1',
    characterHash: 'character-a',
    groupHash: ''
  },
  settingsHash: 'settings-a',
  provider: { id: 'openai', model: 'model-a', apiKey: 'must-not-persist' },
  pipelineMode: 'segmented',
  promptVersions: { card: 5, arbiter: 3 },
  artifactBody: 'must-not-persist'
});

assertDeepEqual(provenance, {
  chatKey: 'chat-a',
  turnKeyHash: 'turn-a',
  sourceBandHash: 'source-band-a',
  sourceIdentity: {
    sourceRevisionHash: 'source-a',
    latestMessageId: 'message-7',
    selectedSwipeId: 'swipe-1',
    characterHash: 'character-a',
    groupHash: ''
  },
  settingsHash: 'settings-a',
  provider: { id: 'openai', model: 'model-a' },
  pipelineMode: 'segmented',
  promptVersions: { arbiter: 3, card: 5 }
}, 'buildRunProvenance keeps only bounded identity and contract fields');

const extendedProvenance = buildRunProvenance({
  ...provenance,
  providerContractHash: 'provider-contract-a',
  deckRevisionHash: 'deck-a',
  cardConfigurationHash: 'cards-a',
  promptContractHash: 'prompt-a',
  postProcessMode: 'progressive',
  postProcessDeckHash: 'post-deck-a'
});
assertDeepEqual(extendedProvenance, {
  ...provenance,
  providerContractHash: 'provider-contract-a',
  deckRevisionHash: 'deck-a',
  cardConfigurationHash: 'cards-a',
  promptContractHash: 'prompt-a',
  postProcessMode: 'progressive',
  postProcessDeckHash: 'post-deck-a'
}, 'buildRunProvenance includes every output-relevant contract hash');

assertDeepEqual(compareRunProvenance(provenance, provenance), {
  reusable: true,
  changedFields: []
}, 'equal provenance remains reusable');

const { provider: _missingProvider, ...provenanceWithoutProvider } = provenance;
assertDeepEqual(compareRunProvenance(provenance, provenanceWithoutProvider), {
  reusable: false,
  changedFields: ['provider']
}, 'missing provenance fields are reported without exposing their values');

const run = createPipelineRun({
  operationId: 'run-a',
  chatKey: 'chat-a',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  createdAt: '2026-07-29T12:00:00.000Z',
  sourceIdentity: provenance.sourceIdentity,
  provenance,
  turnKeyHash: 'turn-a',
  sourceBandHash: 'source-band-a',
  hostOwned: true,
  nativeGenerationType: 'swipe'
});

assertDeepEqual(run, {
  schema: PIPELINE_RUN_SCHEMA,
  operationId: 'run-a',
  graphVersion: 1,
  phase: 'preprocess',
  pipelineMode: 'segmented',
  chatKey: 'chat-a',
  turnKeyHash: 'turn-a',
  sourceBandHash: 'source-band-a',
  hostOwned: true,
  nativeGenerationType: 'swipe',
  sourceIdentity: provenance.sourceIdentity,
  provenance,
  revision: 0,
  state: 'paused',
  pauseReason: 'created',
  staleChangedFields: [],
  frontierStageIds: [],
  queuedStageIds: [],
  stageRecords: {},
  createdAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z'
}, 'createPipelineRun creates the canonical paused V2 manifest');

assertEqual(
  normalizePipelineRun({ ...run, schema: 'recursion.pipelineRun.v1' }),
  null,
  'normalizePipelineRun rejects V1 manifests instead of adapting them'
);

assertDeepEqual(
  normalizePipelineRun({ ...run, artifactBody: 'must-not-survive' }),
  run,
  'normalizePipelineRun drops unknown persisted fields'
);

const stageRecord = createStageRecord({
  stageId: 'preprocess.arbiter',
  stageVersion: 3,
  kind: 'model',
  attemptsLimit: 2,
  updatedAt: '2026-07-29T12:00:00.000Z'
});

assertDeepEqual(stageRecord, {
  stageId: 'preprocess.arbiter',
  stageVersion: 3,
  kind: 'model',
  state: 'pending',
  checkpoint: null,
  summary: null,
  failure: null,
  attempts: { window: 0, limit: 2, used: 0, total: 0 },
  executionToken: null,
  startedAt: null,
  updatedAt: '2026-07-29T12:00:00.000Z'
}, 'createStageRecord creates bounded pending state');

assertDeepEqual(
  normalizeStageRecord({ ...stageRecord, responseText: 'must-not-survive' }),
  stageRecord,
  'normalizeStageRecord drops unknown response fields'
);

const checkpoint = createCheckpoint({
  operationId: 'run-a',
  stageId: 'preprocess.arbiter',
  stageVersion: 3,
  inputHash: 'input-a',
  dependencyHashes: { 'preprocess.snapshot': 'snapshot-a' },
  outputHash: 'artifact-hash-a',
  provenance,
  attempts: { window: 1, limit: 2, used: 1, total: 1 },
  artifactRef: {
    kind: 'logical-storage',
    key: 'artifact-a',
    hash: 'artifact-hash-a'
  },
  completedAt: '2026-07-29T12:00:01.000Z'
});

assertDeepEqual(checkpoint, {
  schema: CHECKPOINT_SCHEMA,
  operationId: 'run-a',
  stageId: 'preprocess.arbiter',
  stageVersion: 3,
  state: 'completed',
  inputHash: 'input-a',
  outputHash: 'artifact-hash-a',
  dependencyHashes: { 'preprocess.snapshot': 'snapshot-a' },
  provenance,
  attempts: { window: 1, limit: 2, used: 1, total: 1 },
  artifactRef: {
    kind: 'logical-storage',
    key: 'artifact-a',
    hash: 'artifact-hash-a'
  },
  completedAt: '2026-07-29T12:00:01.000Z'
}, 'createCheckpoint creates the canonical completed checkpoint');

assertDeepEqual(
  normalizeCheckpoint({ ...checkpoint, artifactBody: 'must-not-survive' }),
  checkpoint,
  'normalizeCheckpoint drops unknown artifact fields'
);

assertEqual(
  normalizeCheckpoint({ ...checkpoint, schema: 'recursion.stageCheckpoint.v1' }),
  null,
  'normalizeCheckpoint rejects V1 checkpoints instead of adapting them'
);

assertDeepEqual(
  normalizeCheckpoint({
    ...checkpoint,
    provenance: {
      ...provenance,
      artifactBody: 'must-not-survive'
    }
  }).provenance,
  provenance,
  'normalizeCheckpoint allowlists provenance instead of copying persisted bodies'
);

const completedStageRecord = {
  ...stageRecord,
  state: 'completed',
  checkpoint
};
assertDeepEqual(
  normalizeStageRecord(completedStageRecord),
  completedStageRecord,
  'normalizeStageRecord preserves a valid bounded checkpoint'
);

assertDeepEqual(
  normalizePipelineRun({
    ...run,
    stageRecords: {
      'preprocess.arbiter': {
        ...completedStageRecord,
        artifactBody: 'must-not-survive'
      }
    }
  }).stageRecords,
  { 'preprocess.arbiter': completedStageRecord },
  'normalizePipelineRun normalizes stage records instead of spreading bodies'
);

assertEqual(isTerminalOperationState('completed'), true, 'completed is terminal');
assertEqual(isTerminalOperationState('abandoned'), true, 'abandoned is terminal');
assertEqual(isTerminalOperationState('paused'), false, 'paused remains resumable');

assertEqual(isCheckpointReusable({
  checkpoint,
  stage: {
    id: 'preprocess.arbiter',
    version: 3,
    inputHash: 'input-a',
    provenance
  },
  dependencyCheckpoints: {
    'preprocess.snapshot': { outputHash: 'snapshot-a' }
  },
  artifactHash: 'artifact-hash-a',
  expectedProvenance: provenance
}), true, 'checkpoint is reusable only when every declared fingerprint matches');

assertEqual(isCheckpointReusable({
  checkpoint,
  stage: {
    id: 'preprocess.arbiter',
    version: 3,
    inputHash: 'input-a',
    provenance
  },
  dependencyCheckpoints: {
    'preprocess.snapshot': { outputHash: 'snapshot-a' },
    'preprocess.settings': { outputHash: 'settings-a' }
  },
  artifactHash: 'artifact-hash-a',
  expectedProvenance: provenance
}), false, 'checkpoint reuse rejects a newly declared dependency');

const versionOneCheckpoint = {
  ...checkpoint,
  stageVersion: 1
};
assertEqual(isCheckpointReusable({
  checkpoint: versionOneCheckpoint,
  stage: {
    id: 'preprocess.arbiter',
    version: 0,
    inputHash: 'input-a',
    provenance
  },
  dependencyCheckpoints: {
    'preprocess.snapshot': { outputHash: 'snapshot-a' }
  },
  artifactHash: 'artifact-hash-a',
  expectedProvenance: provenance
}), false, 'checkpoint reuse rejects an invalid stage contract version');

console.log('Execution contracts tests passed.');
