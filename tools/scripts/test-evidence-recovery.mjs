import { cardsFromProviderResult } from '../../src/cards.mjs';
import { assertEqual, assertDeepEqual } from '../../tests/helpers/assert.mjs';

const context = { expectedFamily: 'Scene Frame', expectedRole: 'sceneFrameCard', firstMesId: 8, lastMesId: 9 };
const card = { promptText: 'Keep the doorway visible.', evidenceRefs: ['message:8'] };
assertEqual(cardsFromProviderResult({ ok: true, data: { ...card, evidenceRefs: ['message:99'] } }, context).length, 0,
  'out-of-window evidence is rejected rather than replaced by the latest message');
assertDeepEqual(cardsFromProviderResult({ ok: true, data: card }, context)[0].evidenceRefs, ['message:8'], 'valid message identity is preserved');
for (const evidenceRefs of [[], ['message:8', 'message:99'], ['source:8'], ['message:8 trailing text'], ['message:8', 'message:9007199254740992']]) {
  assertEqual(cardsFromProviderResult({ ok: true, data: { ...card, evidenceRefs } }, context).length, 0,
    'missing, mixed invalid, and malformed references cannot silently become valid evidence');
}
console.log('Evidence recovery tests passed.');
