import assert from 'node:assert/strict';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { hashJson } from '../../src/core.mjs';

function fixture(chat = [{ is_user: true, mes: 'Original source' }]) {
  let persisted = null;
  const context = { chatId: 'history-chat', chat, async saveChat() { persisted = structuredClone(context.chat); } };
  const host = createSillyTavernHost({ contextFactory: () => context, settingsRoot: {} });
  return { context, host, persisted: () => persisted };
}
async function complete(f, text = 'Completed response', cardId = 'card-one') {
  const source = await f.host.snapshot();
  f.context.chat.push({ is_user: false, mes: text });
  const expectedSourceIdentity = await f.host.messages.postProcessSourceIdentity();
  const request = { expectedSourceIdentity, usage: {
    turnKeyHash: 'turn-key', sourcePrefixHash: source.cardSelectionSourcePrefixHash,
    deckId: 'deck-one', generationType: 'normal', cards: [{ cardId, categoryId: 'story', reason: 'Advance the immediate request' }]
  } };
  assert.equal((await f.host.messages.saveCardSelectionUsage(request)).ok, true);
  return request;
}
const f = fixture();
assert.equal(typeof f.host.messages.saveCardSelectionUsage, 'function', 'host can persist completed-response selection usage');
const request = await complete(f);
assert.equal((await f.host.snapshot()).cardSelectionHistory[0].cards[0].cardId, 'card-one');
assert.equal((await f.host.messages.saveCardSelectionUsage(request)).skipped, true, 'duplicate completion does not write a second receipt');
const serialized = JSON.stringify(f.persisted()[1].extra.recursion.cardSelection);
assert(!serialized.includes('Original source') && !serialized.includes('Completed response'), 'receipt contains no story bodies');
const reload = fixture(f.persisted());
assert.equal((await reload.host.snapshot()).cardSelectionHistory[0].cards[0].cardId, 'card-one', 'reload keeps usage');
f.context.chat[0].mes = 'Edited source';
assert.deepEqual((await f.host.snapshot()).cardSelectionHistory[0].cards, [], 'source edits invalidate downstream use');
f.context.chat[0].mes = 'Original source';
f.context.chat[1].mes = 'Edited response';
assert.deepEqual((await f.host.snapshot()).cardSelectionHistory[0].cards, [], 'response edits invalidate use');
f.context.chat.pop();
assert.deepEqual((await f.host.snapshot()).cardSelectionHistory, [], 'deletions remove usage');

const swiped = fixture();
await complete(swiped);
const msg = swiped.context.chat[1];
msg.swipes = [msg.mes, 'Other swipe']; msg.swipe_id = 1;
msg.swipe_info = [{ extra: structuredClone(msg.extra) }, { extra: {} }]; msg.mes = 'Other swipe';
let rows = (await swiped.host.snapshot()).cardSelectionHistory;
assert.equal(rows.length, 1); assert.deepEqual(rows[0].cards, [], 'active swipe cannot inherit root receipt');
msg.swipe_id = 0; msg.mes = msg.swipes[0];
assert.equal((await swiped.host.snapshot()).cardSelectionHistory[0].cards[0].cardId, 'card-one');
assert.equal((await swiped.host.snapshot({ withoutLatestAssistant: true })).cardSelectionHistory.length, 0, 'retry basis excludes current response');
swiped.context.chat.push({ is_user: true, mes: 'Next input' }, { is_user: false, mes: 'Unmanaged completed response' });
assert.equal((await swiped.host.snapshot()).cardSelectionHistory.length, 2, 'old response without receipt ages cooldown');

const long = fixture();
await complete(long);
for (let i = 0; i < 160; i++) long.context.chat.push({ is_user: i % 2 === 0, mes: `Long message ${i}` });
const longSnapshot = await long.host.snapshot();
assert.equal(longSnapshot.cardSelectionHistory.length, 10, 'history exposes only maximum cooldown window');
assert.deepEqual(longSnapshot.cardSelectionHistory.map(row => row.messageId), [143, 145, 147, 149, 151, 153, 155, 157, 159, 161], 'history retains the most recent completed response positions');
long.context.chat[0].mes = 'Changed outside provider window';
assert.notEqual((await long.host.snapshot()).cardSelectionSourcePrefixHash, longSnapshot.cardSelectionSourcePrefixHash, 'edits before retained history still change full branch prefix');

const failed = fixture();
const basis = await failed.host.snapshot();
failed.context.chat.push({ is_user: false, mes: 'Response' });
const identity = await failed.host.messages.postProcessSourceIdentity();
const failRequest = { expectedSourceIdentity: identity, usage: { ...request.usage, sourcePrefixHash: basis.cardSelectionSourcePrefixHash } };
failed.context.saveChat = async () => { throw new Error('disk full'); };
assert.equal((await failed.host.messages.saveCardSelectionUsage(failRequest)).ok, false);
assert.equal(failed.context.chat[1].extra, undefined, 'failed save rolls back metadata');
failed.context.saveChat = async () => {};
for (const processor of [
  { messageId: 1, isStopped: true, isFinished: true },
  { messageId: 1, isFinished: true, abortController: { signal: { aborted: true } } },
  { messageId: 1, isFinished: false }
]) {
  failed.context.streamingProcessor = processor;
  assert.equal(failed.host.messages.cardSelectionCompletionStatus().completed, false);
  assert.equal((await failed.host.messages.saveCardSelectionUsage(failRequest)).ok, false, 'partial streaming does not persist usage');
}
failed.context.streamingProcessor = null;
assert.equal((await failed.host.messages.saveCardSelectionUsage({ ...failRequest, usage: { ...failRequest.usage, sourcePrefixHash: 'wrong' } })).ok, false, 'stale prefix rejects write');
assert.equal((await failed.host.messages.saveCardSelectionUsage({ ...failRequest, expectedSourceIdentity: { ...identity, originalHash: 'wrong' } })).ok, false, 'stale target rejects write');

for (const kind of ['editorial', 'postProcess']) {
  const edit = fixture(); await complete(edit);
  const sourceIdentity = await edit.host.messages.postProcessSourceIdentity();
  const options = kind === 'postProcess' ? { markerNamespace: 'postProcess', expectedSourceIdentity: sourceIdentity, marker: { schema: 'recursion.postProcessMarker.v1', candidateHash: hashJson('Rewritten text') } } : {};
  assert.equal((await edit.host.messages.replaceAssistantMessageText(1, 'Rewritten text', options)).ok, true);
  assert.equal((await edit.host.snapshot()).cardSelectionHistory[0].cards[0].cardId, 'card-one', 'rewrites preserve original usage');
  const appendOptions = kind === 'postProcess' ? { markerNamespace: 'postProcess', expectedSourceIdentity: await edit.host.messages.postProcessSourceIdentity(), marker: { schema: 'recursion.postProcessMarker.v1', candidateHash: hashJson('Editorial swipe') } } : {};
  assert.equal((await edit.host.messages.appendAssistantMessageSwipe(1, 'Editorial swipe', appendOptions)).ok, true);
  rows = (await edit.host.snapshot()).cardSelectionHistory;
  assert.equal(rows.length, 1); assert.equal(rows[0].cards[0].cardId, 'card-one', 'editorial swipe preserves one usage position');
}
// Switching chats while the async identity lookup is in flight cannot mutate the old chat.
{
  const oldContext = { chatId: 'before-switch', chat: [{ is_user: true, mes: 'Input' }], saveChat: async () => {} };
  let activeContext = oldContext;
  const host = createSillyTavernHost({ contextFactory: () => activeContext, settingsRoot: {} });
  const prefix = (await host.snapshot()).cardSelectionSourcePrefixHash;
  oldContext.chat.push({ is_user: false, mes: 'Response' });
  const target = await host.messages.postProcessSourceIdentity();
  delete oldContext.chatId;
  oldContext.getCurrentChatId = async () => {
    activeContext = { chatId: 'after-switch', chat: [], saveChat: async () => {} };
    return 'before-switch';
  };
  const result = await host.messages.saveCardSelectionUsage({ expectedSourceIdentity: target, usage: { ...request.usage, sourcePrefixHash: prefix } });
  assert.equal(result.ok, false, 'chat switch during validation must reject stale write');
  assert.equal(oldContext.chat[1].extra, undefined);
}
{
  const previous = Array.from({ length: 160 }, (_, index) => ({ is_user: index % 2 === 0, mes: 'Earlier source ' + index }));
  const deep = fixture(previous);
  await complete(deep);
  assert.equal((await deep.host.snapshot()).cardSelectionHistory.at(-1).cards[0].cardId, 'card-one');
  deep.context.chat[0].mes = 'Edited far before retained window';
  assert.deepEqual((await deep.host.snapshot()).cardSelectionHistory.at(-1).cards, [], 'distant edit invalidates latest receipt');
}
{
  const active = fixture();
  const source = await active.host.snapshot();
  active.context.chat.push({ is_user: false, mes: 'Active response', swipe_id: 1, swipes: ['Old response', 'Active response'], swipe_info: [{ extra: {} }, { extra: {} }] });
  const usage = { ...request.usage, sourcePrefixHash: source.cardSelectionSourcePrefixHash };
  const expectedSourceIdentity = await active.host.messages.postProcessSourceIdentity();
  const results = await Promise.all([active.host.messages.saveCardSelectionUsage({ expectedSourceIdentity, usage }), active.host.messages.saveCardSelectionUsage({ expectedSourceIdentity, usage })]);
  assert.equal(results[0].ok, true); assert.equal(results[1].skipped, true, 'concurrent duplicate events remain idempotent');
  const saved = active.persisted()[1];
  assert.deepEqual(saved.extra.recursion.cardSelection, saved.swipe_info[1].extra.recursion.cardSelection);
  assert.equal(saved.swipe_info[0].extra.recursion, undefined, 'writing current swipe does not credit older swipe');
  assert.equal((await fixture(active.persisted()).host.snapshot()).cardSelectionHistory[0].cards[0].cardId, 'card-one');
  active.context.streamingProcessor = { messageId: 1, isStopped: true };
  assert.equal((await active.host.snapshot()).cardSelectionHistory.length, 0, 'live stopped response cannot age cooldown');
}
{
  const stopped = fixture();
  const prefix = (await stopped.host.snapshot()).cardSelectionSourcePrefixHash;
  stopped.context.chat.push({ is_user: false, mes: 'Partial response', swipes: ['Prior complete response', 'Partial response'], swipe_id: 1, swipe_info: [{ extra: {} }, { extra: {} }] });
  const expectedSourceIdentity = await stopped.host.messages.postProcessSourceIdentity();
  assert.equal(typeof stopped.host.messages.markCardSelectionIncomplete, 'function', 'incomplete responses can persist their completion state');
  assert.equal((await stopped.host.messages.markCardSelectionIncomplete({ expectedSourceIdentity, sourcePrefixHash: 'stale' })).ok, false);
  assert.equal((await stopped.host.messages.markCardSelectionIncomplete({ expectedSourceIdentity, sourcePrefixHash: prefix })).ok, true);
  const persisted = stopped.persisted();
  const reloaded = fixture(persisted);
  assert.equal((await reloaded.host.snapshot()).cardSelectionHistory.length, 0, 'incomplete response cannot age cooldown after reload');
  reloaded.context.chat[1].swipe_id = 0; reloaded.context.chat[1].mes = 'Prior complete response';
  assert.equal((await reloaded.host.snapshot()).cardSelectionHistory.length, 1, 'other complete swipe still counts');
  const success = await stopped.host.messages.saveCardSelectionUsage({ expectedSourceIdentity, usage: { ...request.usage, sourcePrefixHash: prefix } });
  assert.equal(success.ok, true);
  assert.equal((await stopped.host.snapshot()).cardSelectionHistory.length, 1, 'successful completion supersedes incomplete marker');
  assert.equal(stopped.context.chat[1].extra.recursion.cardSelectionIncomplete, undefined);
  stopped.context.saveChat = async () => { throw new Error('disk unavailable'); };
  assert.equal((await stopped.host.messages.markCardSelectionIncomplete({ expectedSourceIdentity, sourcePrefixHash: prefix })).ok, false);
  assert.equal((await stopped.host.snapshot()).cardSelectionHistory.length, 1, 'failed incomplete save rolls back');
}
// Native Stop emits completion before onFinishStreaming cleans the partial text
// and reconstructs swipe metadata by cloning the root extra.
for (const withSwipes of [false, true]) {
  const stopped = fixture();
  const sourcePrefixHash = (await stopped.host.snapshot()).cardSelectionSourcePrefixHash;
  const started = new Date('2026-09-24T10:00:00.000Z');
  const message = { is_user: false, mes: 'Partial *unfinished', gen_started: started, gen_finished: new Date('2026-09-24T10:00:01.000Z') };
  if (withSwipes) Object.assign(message, { swipe_id: 0, swipes: [message.mes], swipe_info: [{ gen_started: started, extra: {} }] });
  stopped.context.chat.push(message);
  const expectedSourceIdentity = await stopped.host.messages.postProcessSourceIdentity();
  assert.equal((await stopped.host.messages.markCardSelectionIncomplete({ expectedSourceIdentity, sourcePrefixHash })).ok, true);
  message.mes = 'Partial *unfinished*';
  message.gen_finished = new Date('2026-09-24T10:00:02.000Z');
  if (withSwipes) {
    message.swipes[0] = message.mes;
    message.swipe_info[0] = { gen_started: message.gen_started, gen_finished: message.gen_finished, extra: structuredClone(message.extra) };
  }
  const reloaded = fixture(JSON.parse(JSON.stringify(stopped.context.chat)));
  assert.equal((await reloaded.host.snapshot()).cardSelectionHistory.length, 0, 'final native cleanup must not age cooldown after reload');
  reloaded.context.chat[1].gen_started = '2026-09-24T11:00:00.000Z';
  if (withSwipes) reloaded.context.chat[1].swipe_info[0].gen_started = reloaded.context.chat[1].gen_started;
  assert.equal((await reloaded.host.snapshot()).cardSelectionHistory.length, 1, 'new generation with identical text must not inherit old incomplete state');
}
{
  const pending = fixture();
  const empty = fixture([]);
  const emptyPrefix = (await empty.host.snapshot()).cardSelectionSourcePrefixHash;
  const before = await pending.host.snapshot();
  assert.equal(before.cardSelectionPreviousPrefixHash, emptyPrefix, 'previous prefix excludes existing latest user input');
  assert.equal((await pending.host.snapshot()).cardSelectionPreviousPrefixHash, before.cardSelectionPreviousPrefixHash, 'unchanged source keeps previous prefix stable');
  pending.context.chat.push({ is_user: true, mes: 'Pending input appended by native host' });
  const appended = await pending.host.snapshot();
  assert.equal(appended.cardSelectionPreviousPrefixHash, before.cardSelectionSourcePrefixHash, 'one appended user input binds to original full prefix');
  pending.context.chat.push({ is_system: true, mes: 'Invisible system text' }, { is_user: true, mes: '   ' });
  assert.equal((await pending.host.snapshot()).cardSelectionPreviousPrefixHash, appended.cardSelectionPreviousPrefixHash, 'ignored messages do not change last visible prefix');
  pending.context.chat[0].mes = 'Changed earlier input';
  assert.notEqual((await pending.host.snapshot()).cardSelectionPreviousPrefixHash, before.cardSelectionSourcePrefixHash, 'older branch edits cannot masquerade as a pending input append');
}
console.log('card selection history tests passed');
