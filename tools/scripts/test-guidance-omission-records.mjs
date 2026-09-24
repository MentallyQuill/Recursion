import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { buildDiagnosticsPayload } from '../../src/runtime/diagnostics.mjs';
import { validateGuidanceStageResult } from '../../src/prompt.mjs';
import { hashJson } from '../../src/core.mjs';
import { assertDeepEqual, assert, assertEqual } from '../../tests/helpers/assert.mjs';

const omissions = [{ id: 'card-a', reason: 'duplicate' }, { id: 'card-b', reason: 'lower-priority' }];
const composed = validateGuidanceStageResult({ ok: true, data: {
  schema: 'recursion.guidanceComposer.v1', snapshotHash: hashJson({}), guidanceText: 'Grounded guidance',
  omittedCardIds: omissions
} }, { cards: omissions.map(({ id }) => ({ id, family: 'Scene Frame', promptText: 'Known scene evidence.' })) });
assert(composed.ok, 'real Guidance validator accepts valid omission records');
assertDeepEqual(composed.value.omittedCardIds, omissions, 'composition preserves omission records');
const repository = createStorageRepository({ storage: createMemoryStorageAdapter() });
await repository.saveLastBrief('Omissions', {
  turnKeyHash: 'turn-omissions',
  packet: { guidance: { ...composed.value, omittedCardIds: [...omissions,
    { id: {}, reason: 'duplicate' }, { id: 'invalid-reason', reason: 'CANARY_PRIVATE_REASON' },
    { id: 'card-a', reason: 'duplicate', prose: 'CANARY_PRIVATE_PROSE' }, '[object Object]'] } },
  hand: { handId: 'hand-omissions', cards: [], omitted: [{ id: 'card-c', reason: 'max-cards' }] }
});
const loaded = await repository.loadLastBrief('Omissions');
assertDeepEqual(loaded.packet.guidance.omittedCardIds, omissions, 'Guidance omission identities and reasons survive save/reload');
const payload = buildDiagnosticsPayload({ view: { lastHand: loaded.hand, lastPacket: {
  diagnostics: { guidanceOmittedCardIds: loaded.packet.guidance.omittedCardIds }
} } });
assertDeepEqual(payload.runtime.packet.diagnostics.guidanceOmittedCardIds, omissions, 'diagnostic export preserves typed Guidance omissions');
assertEqual(payload.runtime.hand.omittedCount, 1, 'hand omissions remain separate from the two Guidance omissions');
assert(!JSON.stringify(payload).includes('[object Object]'), 'export contains no fabricated object IDs');
assert(!JSON.stringify(loaded).includes('CANARY_PRIVATE'), 'invalid fields and reasons are not persisted');
console.log('[pass] Guidance omission records');
