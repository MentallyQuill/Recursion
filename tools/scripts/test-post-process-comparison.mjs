import assert from 'node:assert/strict';
import { hashJson } from '../../src/core.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';

const adapter = createMemoryStorageAdapter();
const repository = createStorageRepository({ storage: adapter });
const originalSnapshot = {
  chatKey: 'chat', chatIdentityHash: 'chat-identity', sourceMessageId: 2, sourceSwipeId: 0,
  originalDraft: 'Original prose.', sourceHash: hashJson('Original prose.'),
  activeCharacterHash: 'character', activeGroupHash: ''
};
const record = {
  schema: 'recursion.postProcessComparison.v1', id: 'review-a', operationId: 'operation-a',
  revisionId: 'revision-a', chatKey: 'chat', originalSnapshot,
  candidateText: 'Revised prose.', candidateHash: hashJson('Revised prose.'),
  targetIdentity: { chatIdentityHash: 'chat-identity', messageId: 2, swipeId: 0,
    sourceTextHash: hashJson('Original prose.'), activeCharacterHash: 'character', activeGroupHash: '' },
  writer: { mode: 'native', label: 'Current SillyTavern model' }, editingScope: 'polish',
  applyMode: 'as-swipe', state: 'pending', retryInputs: { guidance: 'Keep the event.' },
  createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z'
};
await repository.savePostProcessComparison('chat', record);
const reloaded = createStorageRepository({ storage: adapter });
const loaded = await reloaded.loadPostProcessComparison('chat', 'review-a');
assert.equal(loaded.originalSnapshot.originalDraft, 'Original prose.');
assert.equal(loaded.candidateText, 'Revised prose.');
assert.equal(loaded.targetIdentity.sourceTextHash, hashJson('Original prose.'));
assert.equal(loaded.state, 'pending');
assert.equal(JSON.stringify(await reloaded.readIndex()).includes('Original prose.'), false);
console.log('[pass] post-process comparison persistence');

// Completed comparisons are bounded without evicting the pending review.
for (let index = 0; index < 11; index += 1) {
  await repository.savePostProcessComparison('chat', {
    ...record, id: `complete-${index}`, revisionId: `revision-${index}`, state: 'applied',
    updatedAt: new Date(Date.UTC(2026, 8, 23, 0, index + 1)).toISOString()
  });
}
assert.equal(await repository.loadPostProcessComparison('chat', 'complete-0'), null);
assert.equal((await repository.loadPostProcessComparison('chat', 'review-a')).state, 'pending');
assert.equal((await repository.listPostProcessComparisons('chat')).length, 11);
console.log('[pass] completed comparison retention preserves pending review');
// Stale reviews retain the comparison but release evidence and guidance.
await repository.savePostProcessComparison('chat', {
  ...record, state: 'stale', updatedAt: new Date().toISOString(), originalSnapshot: { ...originalSnapshot, supportingContext: { latestUserMessage: 'PRIVATE_EVIDENCE' } }
});
const stale = await repository.loadPostProcessComparison('chat', record.id);
assert.equal(stale.retryInputs, null);
assert.equal(stale.originalSnapshot.supportingContext, undefined);
assert.equal(stale.originalSnapshot.originalDraft, 'Original prose.');
console.log('[pass] stale comparison drops retry-only evidence');
// Reset removes retained bodies and index references, never host messages.
await repository.clearPipelineExecution('chat');
assert.deepEqual(await repository.listPostProcessComparisons('chat'), []);
assert.equal(Object.keys(adapter.dump()).some((key) => key.startsWith('recursion-post-process-comparisons-')), false);
assert.equal(Object.values((await repository.readIndex()).records).some((entry) => entry.kind === 'postProcessComparisons'), false);
console.log('[pass] reset removes comparison bodies');
// A pending comparison exceeding the storage budget fails without writing/truncating text.
const hugeText = 'x'.repeat(9 * 1024 * 1024);
await assert.rejects(repository.savePostProcessComparison('chat', {
  ...record, candidateText: hugeText, candidateHash: hashJson(hugeText)
}), { code: 'RECURSION_POST_PROCESS_COMPARISON_STORAGE' });
assert.equal((await repository.listPostProcessComparisons('chat')).length, 0);
console.log('[pass] comparison size budget fails before persistence');
// A memory-only fallback cannot authorize a durable replacement.
const fallbackAdapter = createMemoryStorageAdapter();
const fallbackRepository = createStorageRepository({storage:{...fallbackAdapter,
  async writeJson(key,value) {await fallbackAdapter.writeJson(key,value);return {ok:true,fallback:'memory'};}
}});
await assert.rejects(fallbackRepository.savePostProcessComparison('chat',record), {
  code:'RECURSION_POST_PROCESS_COMPARISON_STORAGE'
});
console.log('[pass] volatile storage fallback cannot authorize a comparison');
// Repair removes corrupted raw comparison bodies instead of merely hiding them.
const corruptAdapter = createMemoryStorageAdapter();
const corruptRepository = createStorageRepository({storage:corruptAdapter});
await corruptRepository.savePostProcessComparison('chat',record);
const corruptKey = Object.keys(corruptAdapter.dump()).find((key)=>key.startsWith('recursion-post-process-comparisons-'));
const corruptBucket = await corruptAdapter.readJson(corruptKey);
corruptBucket.records[0].hash='corrupted';
await corruptAdapter.writeJson(corruptKey,corruptBucket);
await corruptRepository.repairIndex();
assert.equal(await corruptAdapter.readJson(corruptKey),null);
assert.equal(Object.values((await corruptRepository.readIndex()).records).some((entry)=>entry.kind==='postProcessComparisons'),false);
console.log('[pass] repair deletes corrupt comparison bodies');

// An adapter success receipt alone is insufficient to authorize replacement.
const lostWriteAdapter=createMemoryStorageAdapter();
const lostWriteRepository=createStorageRepository({storage:{...lostWriteAdapter,
  async writeJson(){return {ok:true};}
}});
await assert.rejects(lostWriteRepository.savePostProcessComparison('chat',record),{
  code:'RECURSION_POST_PROCESS_COMPARISON_STORAGE'
});
console.log('[pass] comparison write requires matching durable readback');
