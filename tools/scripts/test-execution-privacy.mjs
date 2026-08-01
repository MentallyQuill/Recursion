import {
  collectResumeArtifactReferences,
  createMemoryStorageAdapter,
  createStorageRepository,
  purgeTerminalResumeArtifacts
} from '../../src/storage.mjs';
import {
  buildDiagnosticsPayload,
  summarizeExecutionForDiagnostics
} from '../../src/runtime/diagnostics.mjs';
import {
  createCheckpoint,
  createPipelineRun,
  createStageRecord
} from '../../src/execution/checkpoints.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const secrets = [
  'CANARY_ARBITER_BODY',
  'CANARY_CARD_BODY',
  'CANARY_PACKET_BODY',
  'CANARY_GUIDANCE_BODY',
  'CANARY_DRAFT_BODY'
];

const stableCodes = [
  'operation-paused-user-stop',
  'operation-paused:chat-changed',
  'operation-stale:source-changed',
  'stage-attempt-exhausted',
  'stage-checkpoint-reused',
  'stage-checkpoint-invalidated',
  'stage-reprocess-queued',
  'stage-reprocess-canceled',
  'stage-reprocess-consumed',
  'stage-reprocess-inapplicable',
  'resume-checkpoint-restored',
  'resume-artifact-missing',
  'resume-commit-already-applied',
  'fused-fallback-segmented',
  'new-user-turn',
  'same-turn-host-retry',
  'same-turn-swipe',
  'source-band-edited'
];

const adapter = createMemoryStorageAdapter();
const repository = createStorageRepository({ storage: adapter });
const chatKey = 'Execution Privacy Chat';
const operationId = 'privacy-operation';
const createdAt = '2026-07-29T12:00:00.000Z';
const stageFixtures = [
  ['preprocess.arbiter', secrets[0]],
  ['preprocess.cards.segmented.character', secrets[1]],
  ['preprocess.packet', secrets[2]],
  ['postprocess.unified.guidance', secrets[3]],
  ['postprocess.unified.rewrite', secrets[4]],
  ['postprocess.host-commit', 'SAFE_RECEIPT_BODY']
];

const stageRecords = {};
for (const [stageId, body] of stageFixtures) {
  const artifactRef = await repository.savePipelineArtifact(
    chatKey,
    operationId,
    stageId,
    { body }
  );
  stageRecords[stageId] = {
    ...createStageRecord({
      stageId,
      stageVersion: 1,
      kind: stageId === 'postprocess.host-commit' ? 'host' : 'model',
      attemptsLimit: 2,
      updatedAt: createdAt
    }),
    state: 'completed',
    attempts: { window: 1, limit: 2, used: 1, total: 1 },
    summary: {
      artifactBody: body,
      diagnosticCodes: stableCodes
    },
    checkpoint: createCheckpoint({
      operationId,
      stageId,
      stageVersion: 1,
      inputHash: `input-${stageId}`,
      outputHash: artifactRef.hash,
      dependencyHashes: stageId === 'postprocess.host-commit'
        ? { 'postprocess.unified.rewrite': stageRecords['postprocess.unified.rewrite'].checkpoint.outputHash }
        : {},
      attempts: { window: 1, limit: 2, used: 1, total: 1 },
      artifactRef,
      completedAt: createdAt
    }),
    startedAt: createdAt,
    updatedAt: '2026-07-29T12:00:01.000Z'
  };
}

const manifest = {
  ...createPipelineRun({
    operationId,
    chatKey,
    phase: 'postprocess',
    turnKeyHash: 'turn-privacy',
    sourceBandHash: 'band-privacy',
    hostOwned: true,
    nativeGenerationType: 'swipe',
    pipelineMode: 'segmented',
    sourceIdentity: {
      sourceRevisionHash: 'source-safe-hash',
      latestMessageId: 'message-safe-id',
      selectedSwipeId: 'swipe-safe-id',
      characterHash: 'character-safe-hash',
      groupHash: ''
    },
    createdAt
  }),
  state: 'completed',
  pauseReason: '',
  stageRecords
};
await repository.savePipelineRun(chatKey, manifest);
await repository.saveQueuedReprocess(chatKey, {
  schema: 'recursion.queuedReprocess.v2',
  chatKey,
  phase: 'postprocess',
  turnKeyHash: 'turn-privacy',
  queuedAt: createdAt,
  mode: 'stage',
  stageIds: ['postprocess.unified.rewrite'],
  artifactBody: secrets[4]
});
await repository.appendJournal(chatKey, {
  event: 'activity.stage_changed',
  summary: 'Execution checkpoint updated.',
  details: {
    operationId,
    stageId: 'postprocess.unified.rewrite',
    draftBody: secrets[4],
    guidanceBody: secrets[3],
    artifactHash: 'safe-hash'
  }
});

for (const [stageId, secret] of stageFixtures.slice(0, 5)) {
  const artifact = await repository.loadPipelineArtifact(chatKey, operationId, stageId);
  assertEqual(artifact.body, secret, `${stageId} body remains available only from artifact storage`);
}

const storedManifest = await repository.loadPipelineRun(chatKey);
assertEqual(storedManifest.nativeGenerationType, 'swipe', 'execution metadata retains only the bounded native generation type');
const journal = await repository.loadRunJournal(chatKey);
const queuedIntent = await repository.loadQueuedReprocess(chatKey, 'postprocess');
assertEqual(queuedIntent.turnKeyHash, 'turn-privacy', 'queued privacy fixture retains only bounded turn metadata');
const diagnostics = buildDiagnosticsPayload({
  createdAt,
  view: {
    execution: storedManifest,
    activity: {
      operationId,
      stageId: 'postprocess.unified.rewrite',
      detail: {
        arbiterBody: secrets[0],
        cardBody: secrets[1],
        packetBody: secrets[2],
        guidanceBody: secrets[3],
        draftBody: secrets[4]
      }
    },
    activityHistory: [{
      operationId,
      stageId: 'postprocess.unified.rewrite',
      detail: { draftBody: secrets[4] }
    }]
  },
  journal
});
const representations = JSON.stringify({
  manifest: storedManifest,
  queuedIntent,
  journal,
  diagnostics,
  chatMarker: {
    schema: 'recursion.postProcessMarker.v1',
    operationId,
    sourceHash: 'safe-source-hash',
    candidateHash: 'safe-candidate-hash'
  }
});
for (const secret of secrets) {
  assert(!representations.includes(secret), `${secret} is absent outside dedicated artifact storage`);
}

const summary = summarizeExecutionForDiagnostics({
  ...storedManifest,
  state: 'paused',
  pauseReason: 'user-stop',
  diagnosticCodes: stableCodes
});
assertDeepEqual(
  summary.diagnosticCodes,
  stableCodes,
  'execution diagnostics expose the complete stable bounded lifecycle vocabulary'
);
const summaryKeys = new Set([
  'operationId',
  'operationPhase',
  'operationState',
  'turnKeyHash',
  'hostOwned',
  'nativeGenerationType',
  'diagnosticCodes',
  'stages',
  'staleFields'
]);
assert(
  Object.keys(summary).every((key) => summaryKeys.has(key)),
  'execution summary is constructed from an explicit top-level allowlist'
);

const referencedBeforePurge = collectResumeArtifactReferences(storedManifest);
assertEqual(referencedBeforePurge.length, 2, 'terminal Post-process retains only final draft and commit references');
const purge = await purgeTerminalResumeArtifacts({
  repository,
  manifest: storedManifest
});
assertEqual(purge.deletedArtifactIds.length, 4, 'terminal purge deletes source and intermediate resume artifacts');
assert(
  await repository.loadPipelineArtifact(
    chatKey,
    operationId,
    stageRecords['postprocess.unified.rewrite'].checkpoint.artifactRef.artifactId
  ),
  'terminal purge retains final accepted draft'
);
assert(
  await repository.loadPipelineArtifact(
    chatKey,
    operationId,
    stageRecords['postprocess.host-commit'].checkpoint.artifactRef.artifactId
  ),
  'terminal purge retains final commit receipt'
);
assertEqual(
  await repository.loadPipelineArtifact(
    chatKey,
    operationId,
    stageRecords['postprocess.unified.guidance'].checkpoint.artifactRef.artifactId
  ),
  null,
  'terminal purge deletes Post-process guidance'
);

console.log('Execution privacy tests passed.');
