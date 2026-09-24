import assert from 'node:assert/strict';
import { hashJson } from '../../src/core.mjs';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
function fixture(mode = 'as-swipe') {
  let saves = 0;
  const context = { chatId: 'restore-chat', chat: [{ mesid: 0, is_user: false, mes: 'Revised prose', swipe_id: mode === 'replace' ? 0 : 1, swipes: mode === 'replace' ? ['Revised prose'] : ['Original prose', 'Revised prose'], swipe_info: [{ extra: {} }, { extra: {} }] }], async saveChat() { saves++; } };
  const host = createSillyTavernHost({ contextFactory: () => context, settingsRoot: {} });
  return { context, host, saves: () => saves };
}
async function input(f, mode = 'as-swipe') {
  return { mode, originalSnapshot: { sourceMessageId: 0, sourceSwipeId: 0, sourceHash: hashJson('Original prose'), originalDraft: 'Original prose' }, expectedSourceIdentity: await f.host.messages.postProcessSourceIdentity(), operationId: 'op', revisionId: 'revision' };
}
for (const mode of ['as-swipe', 'replace']) {
  const f = fixture(mode);
  const args = await input(f, mode);
  const results = await Promise.all([f.host.messages.restorePostProcessOriginal(args), f.host.messages.restorePostProcessOriginal(args)]);
  assert.ok(results.every(x => x.ok));
  assert.equal(results[1].restored, false);
  assert.equal(f.context.chat[0].mes, 'Original prose');
  assert.equal(f.context.chat[0].swipe_id, 0);
  assert.equal(f.context.chat[0].swipes.length, mode === 'replace' ? 1 : 2);
  assert.equal(f.saves(), 1);
  const recovered = await f.host.messages.findPostProcessRestore(args);
  assert.equal(recovered.identity.originalHash,hashJson('Original prose'));
  assert.equal(await f.host.messages.findPostProcessRestore({...args,revisionId:'wrong'}),null);
}
for (const mutate of [
  f => { f.context.chat[0].mes = 'User edit'; f.context.chat[0].swipes[1] = 'User edit'; },
  f => { f.context.chat[0].swipes[0] = 'Changed original'; },
  f => { f.context.chatId = 'other-chat'; },
  f => { f.context.chat.push({ mesid: 1, is_user: true, mes: 'A new turn' }); }
]) {
  const f = fixture(); const args = await input(f); mutate(f);
  const before = structuredClone(f.context.chat);
  assert.equal((await f.host.messages.restorePostProcessOriginal(args)).ok, false);
  assert.deepEqual(f.context.chat, before);
  assert.equal(f.saves(), 0);
}
{
  const f = fixture('replace'); const args = await input(f, 'replace');
  const before = structuredClone(f.context.chat);
  f.context.saveChat = async () => { throw new Error('Disk full'); };
  assert.equal((await f.host.messages.restorePostProcessOriginal(args)).ok, false);
  assert.deepEqual(f.context.chat, before);
}
{
  const f = fixture('replace'); const args = await input(f, 'replace');
  const before = structuredClone(f.context.chat);
  const controller = new AbortController();
  let saves = 0;
  f.context.saveChat = async () => { if (++saves === 1) controller.abort(); };
  assert.equal((await f.host.messages.restorePostProcessOriginal({ ...args, signal: controller.signal })).ok, false);
  assert.deepEqual(f.context.chat, before);
  assert.equal(saves, 2, 'canceled restore persists rollback');
}
{
  const f = fixture(); const args = await input(f);
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.host.messages.restorePostProcessOriginal({ ...args, signal: controller.signal })).ok, false);
  assert.equal(f.saves(), 0);
}
console.log('[pass] post-process host restore');
