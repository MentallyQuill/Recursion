import {
  SYSTEM_INDEX_KEY,
  createMemoryStorageAdapter,
  createStorageRepository,
  pipelineArtifactKey,
  pipelineRunKey,
  queuedReprocessKey
} from '../../src/storage.mjs';
import { createPipelineRun } from '../../src/execution/checkpoints.mjs';
import {
  assert,
  assertDeepEqual,
  assertEqual,
  assertRejects
} from '../../tests/helpers/assert.mjs';

assertEqual(
  pipelineRunKey('Chat One'),
  'recursion-pipeline-run-Chat-One.v2.json',
  'pipeline run key is chat scoped and sanitized'
);
assertEqual(
  pipelineArtifactKey('Chat One', 'Run/One', 'preprocess.arbiter'),
  'recursion-pipeline-artifact-Chat-One-Run-One-preprocess.arbiter.v2.json',
  'pipeline artifact key includes sanitized chat, operation, and artifact ids'
);
assertEqual(
  queuedReprocessKey('Chat One'),
  'recursion-queued-reprocess-Chat-One.v1.json',
  'queued reprocess key is chat scoped and sanitized'
);

const storage = createMemoryStorageAdapter();
const repository = createStorageRepository({ storage });
const artifact = {
  arbiterOutput: {
    selectedCards: ['character'],
    rationale: 'CANARY_ARBITER_ARTIFACT_BODY'
  }
};
const artifactRef = await repository.savePipelineArtifact(
  'Chat One',
  'Run One',
  'preprocess.arbiter',
  artifact
);

assertEqual(artifactRef.kind, 'logical-storage', 'artifact save returns a logical reference');
assertEqual(
  artifactRef.key,
  pipelineArtifactKey('Chat One', 'Run One', 'preprocess.arbiter'),
  'artifact reference points at the isolated body record'
);
assert(/^[a-f0-9]{64}$/.test(artifactRef.hash), 'artifact reference includes a SHA-256 body hash');
assert(artifactRef.artifactBytes > 0, 'artifact reference includes a bounded body byte count');
assertDeepEqual(
  await repository.loadPipelineArtifact('Chat One', 'Run One', 'preprocess.arbiter'),
  artifact,
  'artifact body round trips only through dedicated artifact storage'
);

const manifest = createPipelineRun({
  operationId: 'Run One',
  chatKey: 'Chat One',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  sourceIdentity: {
    sourceRevisionHash: 'source-a',
    latestMessageId: 'message-a',
    selectedSwipeId: 'swipe-a',
    characterHash: 'character-a',
    groupHash: ''
  },
  createdAt: '2026-07-29T12:00:00.000Z'
});
await repository.savePipelineRun('Chat One', {
  ...manifest,
  artifactBody: 'CANARY_ARBITER_ARTIFACT_BODY'
});

assertDeepEqual(
  await repository.loadPipelineRun('Chat One'),
  manifest,
  'pipeline manifest round trips through its strict metadata contract'
);
assert(
  !JSON.stringify(await storage.readJson(pipelineRunKey('Chat One')))
    .includes('CANARY_ARBITER_ARTIFACT_BODY'),
  'pipeline manifest storage excludes artifact bodies'
);

const queuedIntent = {
  schema: 'recursion.queued-reprocess.v1',
  mode: 'stage',
  stageIds: ['preprocess.cards.segmented.character']
};
await repository.saveQueuedReprocess('Chat One', {
  ...queuedIntent,
  artifactBody: 'CANARY_ARBITER_ARTIFACT_BODY'
});

assertDeepEqual(
  await repository.loadQueuedReprocess('Chat One'),
  queuedIntent,
  'queued reprocess intent round trips through a bounded chat-scoped record'
);
assert(
  !JSON.stringify(await storage.readJson(queuedReprocessKey('Chat One')))
    .includes('CANARY_ARBITER_ARTIFACT_BODY'),
  'queued reprocess storage excludes artifact bodies'
);

const executionIndexKinds = Object.values((await repository.readIndex()).records)
  .map((record) => record.kind)
  .sort();
assertDeepEqual(
  executionIndexKinds,
  ['pipelineArtifact', 'pipelineRun', 'queuedReprocess'],
  'execution records are indexed separately by logical kind'
);

await repository.clearPipelineExecution('Chat One');
assertEqual(
  await repository.loadPipelineRun('Chat One'),
  null,
  'clearPipelineExecution removes the chat manifest'
);
assertEqual(
  await repository.loadPipelineArtifact('Chat One', 'Run One', 'preprocess.arbiter'),
  null,
  'clearPipelineExecution removes operation artifacts'
);
assertEqual(
  await repository.loadQueuedReprocess('Chat One'),
  null,
  'clearPipelineExecution removes queued intent'
);
assertDeepEqual(
  Object.values((await repository.readIndex()).records)
    .filter((record) => record.chatKey === 'Chat-One'),
  [],
  'clearPipelineExecution removes every current-chat execution index entry'
);

const repairStorage = createMemoryStorageAdapter();
const repairRepository = createStorageRepository({ storage: repairStorage });
await repairRepository.savePipelineArtifact('Repair Chat', 'Repair Run', 'arbiter', {
  value: 'artifact'
});
await repairRepository.savePipelineRun('Repair Chat', createPipelineRun({
  operationId: 'Repair Run',
  chatKey: 'Repair Chat',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  sourceIdentity: {
    sourceRevisionHash: 'source-repair',
    latestMessageId: 'message-repair',
    selectedSwipeId: 'swipe-repair',
    characterHash: 'character-repair',
    groupHash: ''
  },
  createdAt: '2026-07-29T12:00:00.000Z'
}));
await repairRepository.saveQueuedReprocess('Repair Chat', {
  schema: 'recursion.queued-reprocess.v1',
  mode: 'stage',
  stageIds: ['preprocess.arbiter']
});
await repairStorage.deleteJson(SYSTEM_INDEX_KEY);
await repairStorage.writeJson(queuedReprocessKey('Invalid Chat'), {
  recordType: 'recursion.queuedReprocess',
  schemaVersion: 1,
  chatKey: 'Invalid-Chat',
  intent: {
    mode: 'stage',
    stageIds: ['preprocess.arbiter'],
    artifactBody: 'invalid intent'
  },
  createdAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z'
});

const repaired = await repairRepository.repairIndex();
const repairedIndex = await repairRepository.readIndex();
assert(
  repaired.repaired.some((entry) => entry.kind === 'pipelineRun'),
  'repairIndex discovers an orphaned pipeline manifest'
);
assert(
  repaired.repaired.some((entry) => entry.kind === 'pipelineArtifact'),
  'repairIndex discovers an orphaned pipeline artifact'
);
assert(
  repaired.repaired.some((entry) => entry.kind === 'queuedReprocess'),
  'repairIndex discovers an orphaned queued intent'
);
assertEqual(
  repairedIndex.records[queuedReprocessKey('Invalid Chat')],
  undefined,
  'repairIndex rejects queued records without the canonical intent schema'
);

const pruneStorage = createMemoryStorageAdapter();
const pruneRepository = createStorageRepository({ storage: pruneStorage });
const abandonedManifest = createPipelineRun({
  operationId: 'abandoned-run',
  chatKey: 'Abandoned Chat',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  sourceIdentity: {
    sourceRevisionHash: 'source-abandoned',
    latestMessageId: 'message-abandoned',
    selectedSwipeId: 'swipe-abandoned',
    characterHash: 'character-abandoned',
    groupHash: ''
  },
  createdAt: '2026-07-29T12:00:00.000Z'
});
abandonedManifest.state = 'abandoned';
await pruneRepository.savePipelineArtifact('Abandoned Chat', 'abandoned-run', 'arbiter', {
  value: 'remove me'
});
await pruneRepository.savePipelineRun('Abandoned Chat', abandonedManifest);

const pausedManifest = createPipelineRun({
  operationId: 'paused-run',
  chatKey: 'Paused Chat',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  sourceIdentity: {
    sourceRevisionHash: 'source-paused',
    latestMessageId: 'message-paused',
    selectedSwipeId: 'swipe-paused',
    characterHash: 'character-paused',
    groupHash: ''
  },
  createdAt: '2026-07-29T12:00:00.000Z'
});
await pruneRepository.savePipelineArtifact('Paused Chat', 'paused-run', 'arbiter', {
  value: 'keep me'
});
await pruneRepository.savePipelineRun('Paused Chat', pausedManifest);

const staleManifest = createPipelineRun({
  operationId: 'stale-run',
  chatKey: 'Stale Chat',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  sourceIdentity: {
    sourceRevisionHash: 'source-stale',
    latestMessageId: 'message-stale',
    selectedSwipeId: 'swipe-stale',
    characterHash: 'character-stale',
    groupHash: ''
  },
  createdAt: '2026-07-29T12:00:00.000Z'
});
staleManifest.state = 'stale';
staleManifest.staleChangedFields = ['sourceRevisionHash'];
await pruneRepository.savePipelineArtifact('Stale Chat', 'stale-run', 'arbiter', {
  value: 'remove stale artifact'
});
await pruneRepository.savePipelineRun('Stale Chat', staleManifest);

await pruneRepository.prunePipelineExecution();
assertEqual(
  await pruneRepository.loadPipelineRun('Abandoned Chat'),
  null,
  'pipeline retention removes an abandoned manifest'
);
assertEqual(
  await pruneRepository.loadPipelineArtifact('Abandoned Chat', 'abandoned-run', 'arbiter'),
  null,
  'pipeline retention removes artifacts owned by an abandoned operation'
);
assert(
  await pruneRepository.loadPipelineRun('Paused Chat'),
  'pipeline retention preserves a paused manifest'
);
assert(
  await pruneRepository.loadPipelineArtifact('Paused Chat', 'paused-run', 'arbiter'),
  'pipeline retention preserves artifacts owned by a paused operation'
);
assert(
  await pruneRepository.loadPipelineRun('Stale Chat'),
  'pipeline retention preserves stale metadata for the current chat'
);
assertEqual(
  await pruneRepository.loadPipelineArtifact('Stale Chat', 'stale-run', 'arbiter'),
  null,
  'pipeline retention removes artifacts from a stale operation'
);

const maintainedManifest = createPipelineRun({
  operationId: 'maintained-abandoned-run',
  chatKey: 'Maintained Chat',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  sourceIdentity: {
    sourceRevisionHash: 'source-maintained',
    latestMessageId: 'message-maintained',
    selectedSwipeId: 'swipe-maintained',
    characterHash: 'character-maintained',
    groupHash: ''
  },
  createdAt: '2026-07-29T12:00:00.000Z'
});
maintainedManifest.state = 'abandoned';
await pruneRepository.savePipelineRun('Maintained Chat', maintainedManifest);
await pruneRepository.maintainRetention();
assertEqual(
  await pruneRepository.loadPipelineRun('Maintained Chat'),
  null,
  'ordinary retention maintenance includes abandoned pipeline cleanup'
);

const failedArtifactStorage = {
  async readJson() {
    return null;
  },
  async writeJson(key) {
    if (key.startsWith('recursion-pipeline-artifact-')) return { ok: false, key };
    return { ok: true, key };
  },
  async deleteJson(key) {
    return { ok: true, key };
  }
};
const failedArtifactRepository = createStorageRepository({ storage: failedArtifactStorage });
await assertRejects(
  () => failedArtifactRepository.savePipelineArtifact(
    'Failure Chat',
    'failure-run',
    'arbiter',
    { value: 'must not receive a reference' }
  ),
  /Pipeline artifact write failed/,
  'failed artifact storage never yields a reusable artifact reference'
);

const manifestBackingStorage = createMemoryStorageAdapter();
let rejectManifestWrites = false;
const failedManifestStorage = {
  readJson: (key) => manifestBackingStorage.readJson(key),
  deleteJson: (key) => manifestBackingStorage.deleteJson(key),
  dump: () => manifestBackingStorage.dump(),
  async writeJson(key, value) {
    if (rejectManifestWrites && key.startsWith('recursion-pipeline-run-')) {
      return { ok: false, key };
    }
    return manifestBackingStorage.writeJson(key, value);
  }
};
const failedManifestRepository = createStorageRepository({ storage: failedManifestStorage });
const safeManifest = createPipelineRun({
  operationId: 'safe-run',
  chatKey: 'Manifest Failure Chat',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  sourceIdentity: {
    sourceRevisionHash: 'source-safe',
    latestMessageId: 'message-safe',
    selectedSwipeId: 'swipe-safe',
    characterHash: 'character-safe',
    groupHash: ''
  },
  createdAt: '2026-07-29T12:00:00.000Z'
});
await failedManifestRepository.savePipelineRun('Manifest Failure Chat', safeManifest);
rejectManifestWrites = true;
await assertRejects(
  () => failedManifestRepository.savePipelineRun('Manifest Failure Chat', {
    ...safeManifest,
    state: 'running'
  }),
  /Pipeline manifest write failed/,
  'failed manifest writes report failure'
);
assertEqual(
  (await failedManifestRepository.loadPipelineRun('Manifest Failure Chat')).state,
  'paused',
  'failed manifest writes leave the previous manifest authoritative'
);

const failedQueuedStorage = {
  async readJson() {
    return null;
  },
  async writeJson(key) {
    if (key.startsWith('recursion-queued-reprocess-')) return { ok: false, key };
    return { ok: true, key };
  },
  async deleteJson(key) {
    return { ok: true, key };
  }
};
const failedQueuedRepository = createStorageRepository({ storage: failedQueuedStorage });
await assertRejects(
  () => failedQueuedRepository.saveQueuedReprocess('Queue Failure Chat', {
    schema: 'recursion.queued-reprocess.v1',
    mode: 'stage',
    stageIds: ['preprocess.arbiter']
  }),
  /Queued reprocess write failed/,
  'failed queued-intent storage never reports a durable queue'
);

const indexFailureBackingStorage = createMemoryStorageAdapter();
const indexFailureStorage = {
  readJson: (key) => indexFailureBackingStorage.readJson(key),
  deleteJson: (key) => indexFailureBackingStorage.deleteJson(key),
  dump: () => indexFailureBackingStorage.dump(),
  async writeJson(key, value) {
    if (key === SYSTEM_INDEX_KEY) return { ok: false, key };
    return indexFailureBackingStorage.writeJson(key, value);
  }
};
const indexFailureRepository = createStorageRepository({ storage: indexFailureStorage });
const indexFailureManifest = createPipelineRun({
  operationId: 'index-failure-run',
  chatKey: 'Index Failure Chat',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  sourceIdentity: {
    sourceRevisionHash: 'source-index',
    latestMessageId: 'message-index',
    selectedSwipeId: 'swipe-index',
    characterHash: 'character-index',
    groupHash: ''
  },
  createdAt: '2026-07-29T12:00:00.000Z'
});
await indexFailureRepository.savePipelineRun('Index Failure Chat', indexFailureManifest);
assertDeepEqual(
  await indexFailureRepository.loadPipelineRun('Index Failure Chat'),
  indexFailureManifest,
  'auxiliary index failure does not negate an atomically verified manifest write'
);

console.log('Execution storage tests passed.');
