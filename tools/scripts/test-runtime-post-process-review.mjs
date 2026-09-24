import assert from 'node:assert/strict';
import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createStorageRepository, createMemoryStorageAdapter } from '../../src/storage.mjs';
import { hashJson } from '../../src/core.mjs';

const settingsStore = createSettingsStore({ root: {} });
settingsStore.update({ postProcess: { enabled: true, writer: { mode: 'profile', connectionProfileId: 'prose' }, editingScope: 'revise', reviewBeforeApplying: true } });
const storage = createStorageRepository({ storage: createMemoryStorageAdapter() });
let text = 'Original.';
let identity = { chatKey: 'chat-review', chatIdentityHash: 'chat-hash', messageId: 1, swipeId: 0, text, originalHash: hashJson(text), activeCharacterHash: 'character', activeGroupHash: '' };
let locks = 0, unlocks = 0, commits = 0;
const host = {
  snapshot: async () => ({ chatKey: 'chat-review', chatId: 'chat-review', chatIdentityHash: 'chat-hash', messages: [{ role: 'assistant', mesid: 1, text }], character: {}, activeCharacterHash: 'character' }),
  messages: { postProcessSourceIdentity: async () => ({ ...identity }) },
  generation: { lockControls: async () => { locks++; return { ok: true }; }, unlockControls: async () => { unlocks++; return { ok: true }; } },
  prompt: { clear: async () => ({ ok: true }) },
  commitPostProcessResult: async input => {
    assert.equal(locks, unlocks + 1, 'host mutation occurs only while generation controls are locked');
    commits++; text = input.text;
    identity = { ...identity, text, originalHash: hashJson(text), swipeId: 1 };
    return { ok: true, applied: true, receipt: { targetMessageId: 1, targetSwipeId: 1 } };
  }
};
const runtime = createRecursionRuntime({ host, storage, settingsStore });
assert.equal(runtime.view().settings.postProcess.writer.connectionProfileId, 'prose', 'production safe settings view retains writer');
assert.equal(runtime.view().settings.postProcess.editingScope, 'revise');
assert.equal(runtime.view().settings.postProcess.reviewBeforeApplying, true);
assert.equal(typeof runtime.postProcessComparisons, 'function');
assert.equal(typeof runtime.reviewPostProcess, 'function');
let changes = 0;
const unsubscribe = runtime.subscribe(() => changes++);
const originalSnapshot = { chatKey: 'chat-review', chatIdentityHash: identity.chatIdentityHash, sourceMessageId: identity.messageId, sourceSwipeId: identity.swipeId, sourceHash: identity.originalHash, originalDraft: text, activeCharacterHash: identity.activeCharacterHash, activeGroupHash: '' };
const record = { schema: 'recursion.postProcessComparison.v1', id: 'review-root', revisionId: 'revision-root', operationId: 'operation-root', chatKey: 'chat-review', originalSnapshot, candidateText: 'Revised.', candidateHash: hashJson('Revised.'), targetIdentity: { chatIdentityHash: identity.chatIdentityHash, messageId: identity.messageId, swipeId: identity.swipeId, sourceTextHash: identity.originalHash, activeCharacterHash: identity.activeCharacterHash, activeGroupHash: '' }, writer: { mode: 'native', label: 'Current model' }, editingScope: 'polish', applyMode: 'as-swipe', state: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
await storage.savePostProcessComparison('chat-review', record);
assert.equal((await runtime.postProcessComparisons())[0].eligible, true);
assert.equal((await runtime.reviewPostProcess({ id: record.id, action: 'edit', text: 'Manual revision.' })).ok, true);
assert(changes > 0, 'controller changes reach real runtime subscribers');
const applied = await Promise.all([runtime.reviewPostProcess({ id: record.id, action: 'apply' }), runtime.reviewPostProcess({ id: record.id, action: 'apply' })]);
assert(applied.every(result => result.ok));
assert.equal(commits, 1, 'double acceptance commits once through real root runtime');
assert.equal(locks, unlocks, 'review action releases generation controls');
assert.equal(JSON.stringify(runtime.view()).includes('Manual revision.'), false, 'ordinary runtime view excludes candidate prose');
await runtime.invalidatePostProcessComparisons({ reason: 'source-edited' });
assert.equal((await runtime.postProcessComparisons())[0].eligible, false);
assert.equal((await runtime.reviewPostProcess({ id: record.id, action: 'apply' })).ok, false);
await runtime.resetTurnCache();
assert.equal((await runtime.postProcessComparisons()).length, 0, 'reset removes comparison bodies');
assert.equal(text, 'Manual revision.', 'reset never deletes or restores host prose');
await storage.savePostProcessComparison('chat-review', { ...record, id: 'queued-review', targetIdentity: { ...record.targetIdentity, swipeId: 1, sourceTextHash: identity.originalHash } });
let releaseLock, lockStarted;
const locked = new Promise(resolve => { lockStarted = resolve; });
host.generation.lockControls = () => { locks++; lockStarted(); return new Promise(resolve => { releaseLock = resolve; }); };
const firstQueued = runtime.reviewPostProcess({ id: 'queued-review', action: 'apply' });
const secondQueued = runtime.reviewPostProcess({ id: 'queued-review', action: 'apply' });
await locked;
runtime.cancelPostProcess('host-generation-stopped');
releaseLock({ ok: true });
assert.equal((await firstQueued).ok, false, 'Stop cancels a review waiting for the host lock');
assert.equal((await secondQueued).ok, false, 'Stop cancels queued review actions before they start');
assert.equal(commits, 1);
assert.equal(locks, unlocks);
identity = { ...identity, chatKey: 'another-chat', chatIdentityHash: 'another-hash' };
await runtime.handleChatChanged();
assert.equal((await storage.loadPostProcessComparison('chat-review', 'queued-review')).state, 'stale', 'chat switch invalidates the prior chat bucket');
unsubscribe();
await runtime.dispose();
console.log('Production root Post-process review integration: PASS');
