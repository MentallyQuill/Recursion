import {
  createMemoryStorageAdapter,
  createStorageRepository,
  lastBriefKey,
  pipelineArtifactKey,
  pipelineRunKey
} from '../../src/storage.mjs';
import { createPipelineRun } from '../../src/execution/checkpoints.mjs';
import {
  assert,
  assertDeepEqual,
  assertEqual
} from '../../tests/helpers/assert.mjs';

const adapter = createMemoryStorageAdapter();
const repository = createStorageRepository({ storage: adapter });

assertEqual(
  lastBriefKey('Chat One'),
  'recursion-last-brief-Chat-One.v1.json',
  'Last Brief uses an isolated chat-scoped key'
);
assertEqual(
  pipelineRunKey('Chat One'),
  'recursion-pipeline-run-Chat-One.v2.json',
  'pipeline manifests use the V2 execution namespace'
);
assertEqual(
  pipelineArtifactKey('Chat One', 'Run One', 'preprocess.arbiter'),
  'recursion-pipeline-artifact-Chat-One-Run-One-preprocess.arbiter.v2.json',
  'pipeline artifacts use the V2 execution namespace'
);

await repository.saveLastBrief('Chat One', {
  turnKeyHash: 'turn-a',
  status: 'historical',
  packet: {
    packetId: 'packet-a',
    prompt: 'Display-only packet text.',
    providerResponse: 'CANARY_PROVIDER_RESPONSE',
    credentials: { apiKey: 'CANARY_API_KEY' }
  },
  hand: {
    handId: 'hand-a',
    cards: [{
      id: 'card-a',
      family: 'Scene Frame',
      promptText: 'Display-only card text.',
      hiddenReasoning: 'CANARY_HIDDEN_REASONING',
      stack: 'CANARY_STACK'
    }],
    providerResponse: 'CANARY_HAND_RESPONSE'
  },
  committedAt: '2026-08-01T12:00:00.000Z'
});

const brief = await repository.loadLastBrief('Chat One');
assertEqual(brief.schema, 'recursion.lastBrief.v1', 'Last Brief uses its inspection schema');
assertEqual(brief.turnKeyHash, 'turn-a', 'Last Brief remains associated with its source turn');
assertEqual(brief.status, 'historical', 'Last Brief preserves historical display state');
assertEqual(brief.packet.prompt, 'Display-only packet text.', 'Last Brief preserves final injected packet text');
assertEqual(brief.hand.cards[0].promptText, 'Display-only card text.', 'Last Brief preserves display card text');
const persistedBrief = JSON.stringify(await adapter.readJson(lastBriefKey('Chat One')));
for (const canary of [
  'CANARY_PROVIDER_RESPONSE',
  'CANARY_API_KEY',
  'CANARY_HIDDEN_REASONING',
  'CANARY_STACK',
  'CANARY_HAND_RESPONSE'
]) {
  assert(!persistedBrief.includes(canary), `Last Brief excludes private field ${canary}`);
}

await adapter.writeJson('recursion-scene-Chat-One-scene-a.v1.json', {
  recordType: 'recursion.sceneCache',
  schemaVersion: 1,
  chatKey: 'Chat-One',
  sceneKey: 'scene-a',
  cards: [{ promptText: 'retired generated card' }],
  createdAt: '2026-08-01T12:00:00.000Z',
  updatedAt: '2026-08-01T12:00:00.000Z'
});
const retired = await repository.pruneRetiredGeneratedRecords();
assertEqual(
  await adapter.readJson('recursion-scene-Chat-One-scene-a.v1.json'),
  null,
  'retired scene-cache records are deleted'
);
assert(retired.deletedKeys.includes('recursion-scene-Chat-One-scene-a.v1.json'), 'retired cleanup reports deleted keys');
assert(await repository.loadLastBrief('Chat One'), 'retired cleanup preserves historical Last Brief');

const manifest = createPipelineRun({
  operationId: 'Run One',
  chatKey: 'Chat One',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  turnKeyHash: 'turn-a',
  sourceBandHash: 'band-a',
  hostOwned: true,
  nativeGenerationType: 'normal',
  sourceIdentity: {
    sourceRevisionHash: 'source-a',
    latestMessageId: 'message-a',
    selectedSwipeId: '',
    characterHash: 'character-a',
    groupHash: ''
  },
  createdAt: '2026-08-01T12:00:00.000Z'
});
await repository.savePipelineArtifact('Chat One', 'Run One', 'preprocess.arbiter', {
  body: 'CANARY_ARTIFACT_BODY'
});
await repository.savePipelineRun('Chat One', manifest);
await repository.saveQueuedReprocess('Chat One', {
  schema: 'recursion.queued-reprocess.v1',
  mode: 'stage',
  stageIds: ['preprocess.arbiter']
});

const mismatch = await repository.revokeTurnExecution('Chat One', {
  operationId: 'Run Two',
  reason: 'new-user-turn'
});
assertEqual(mismatch.revoked, false, 'revocation rejects a nonmatching operation');
assert(await repository.loadPipelineRun('Chat One'), 'nonmatching revocation preserves current manifest');

const revoked = await repository.revokeTurnExecution('Chat One', {
  operationId: 'Run One',
  reason: 'new-user-turn'
});
assertEqual(revoked.revoked, true, 'matching turn execution is made ineligible');
assertEqual(revoked.eligibilityRevoked, true, 'revocation reports eligibility before cleanup');
assertEqual(revoked.ok, true, 'successful revocation reports complete cleanup');
assertDeepEqual(revoked.cleanupFailures, [], 'successful revocation has no cleanup failures');
assertEqual(await repository.loadPipelineRun('Chat One'), null, 'matching manifest is cleared');
assertEqual(
  await repository.loadPipelineArtifact('Chat One', 'Run One', 'preprocess.arbiter'),
  null,
  'matching operation artifacts are cleared'
);
assertEqual(await repository.loadQueuedReprocess('Chat One'), null, 'queued intent is cleared');
assert(await repository.loadLastBrief('Chat One'), 'turn revocation preserves Last Brief inspection data');
assert(!JSON.stringify(revoked).includes('CANARY_ARTIFACT_BODY'), 'revocation result excludes artifact bodies');

const failingBacking = createMemoryStorageAdapter();
let rejectDeletes = false;
const failingAdapter = {
  ...failingBacking,
  async deleteJson(key) {
    if (rejectDeletes && (
      key.startsWith('recursion-pipeline-run-')
      || key.startsWith('recursion-pipeline-artifact-')
      || key.startsWith('recursion-queued-reprocess-')
    )) {
      return { ok: false, key };
    }
    return failingBacking.deleteJson(key);
  }
};
const failingRepository = createStorageRepository({ storage: failingAdapter });
const failingManifest = createPipelineRun({
  operationId: 'Run Failure',
  chatKey: 'Failure Chat',
  phase: 'preprocess',
  pipelineMode: 'segmented',
  turnKeyHash: 'turn-failure',
  sourceBandHash: 'band-failure',
  sourceIdentity: {
    sourceRevisionHash: 'source-failure',
    latestMessageId: 'message-failure',
    selectedSwipeId: '',
    characterHash: 'character-failure',
    groupHash: ''
  },
  createdAt: '2026-08-01T12:00:00.000Z'
});
await failingRepository.savePipelineArtifact('Failure Chat', 'Run Failure', 'arbiter', { value: 'artifact' });
await failingRepository.savePipelineRun('Failure Chat', failingManifest);
await failingRepository.saveQueuedReprocess('Failure Chat', {
  schema: 'recursion.queued-reprocess.v1',
  mode: 'stage',
  stageIds: ['preprocess.arbiter']
});
rejectDeletes = true;
const partial = await failingRepository.revokeTurnExecution('Failure Chat', {
  operationId: 'Run Failure',
  reason: 'new-user-turn'
});
assertEqual(partial.eligibilityRevoked, true, 'cleanup failure does not restore execution eligibility');
assertEqual(partial.ok, false, 'cleanup failure is reported without throwing');
assert(partial.cleanupFailures.length > 0, 'cleanup failures are returned as bounded metadata');
assert(partial.cleanupFailures.length <= 3, 'cleanup failure metadata remains bounded');
assertEqual(
  (await failingRepository.loadPipelineRun('Failure Chat')).state,
  'abandoned',
  'failed cleanup leaves the durable manifest abandoned'
);

await repository.clearLastBrief('Chat One');
assertEqual(await repository.loadLastBrief('Chat One'), null, 'Last Brief can be cleared independently');

console.log('last brief storage tests passed');
