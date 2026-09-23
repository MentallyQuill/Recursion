import {
  PROVIDER_CONTRACT_VERSION,
  jsonSchemaForRequest
} from '../../src/providers.mjs';
import {
  cardsFromFusedProviderResult,
  cardsFromProviderResult
} from '../../src/cards.mjs';
import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(PROVIDER_CONTRACT_VERSION, 10, 'provider contract includes configured output budgets');
const schema = jsonSchemaForRequest({
  roleId: 'sceneFrameCard',
  responseSchema: 'recursion.cardPayload.v1',
  metadata: { role: 'sceneFrameCard', family: 'Scene Frame' }
});
assertDeepEqual(schema.schema.required, ['promptText', 'evidenceRefs'], 'card payload has two required fields');
assertDeepEqual(Object.keys(schema.schema.properties).sort(), ['evidenceRefs', 'promptText'], 'identity fields are absent');
assertEqual(schema.schema.additionalProperties, false, 'card payload rejects unrelated fields');

const fusedSchema = jsonSchemaForRequest({
  roleId: 'fusedCardBundle',
  responseSchema: 'recursion.cardBundlePayload.v1',
  requestedCards: [{ family: 'Scene Frame' }, { family: 'Scene Constraints' }]
});
assertDeepEqual(fusedSchema.schema.required, ['items'], 'fused payload requires only items');
assertDeepEqual(fusedSchema.schema.properties.items.items.required, ['family', 'promptText', 'evidenceRefs'], 'fused item requires only model-owned identity and content');

const cards = cardsFromProviderResult({
  ok: true,
  lane: 'utility',
  data: {
    promptText: 'Track the immediate physical objective and obstruction.',
    evidenceRefs: ['message:12']
  }
}, {
  expectedSnapshotHash: 'snapshot-abc',
  expectedRole: 'sceneFrameCard',
  expectedFamily: 'Scene Frame',
  validEvidenceRefs: ['message:12'],
  sourceCardIds: []
});
assertEqual(cards.length, 1, 'compact payload produces one internal card');
assertEqual(cards[0].schema, 'recursion.card.v1', 'Recursion attaches internal schema');
assertEqual(cards[0].snapshotHash, 'snapshot-abc', 'Recursion attaches snapshot identity');
assertEqual(cards[0].role, 'sceneFrameCard', 'Recursion attaches role');
assertEqual(cards[0].family, 'Scene Frame', 'Recursion attaches family');

const fused = cardsFromFusedProviderResult({
  ok: true,
  lane: 'utility',
  data: {
    items: [
      { family: 'Scene Frame', promptText: 'Track the immediate objective.', evidenceRefs: ['message:12'] },
      { family: 'Unknown', promptText: 'Ignore me.', evidenceRefs: ['message:12'] }
    ]
  }
}, {
  expectedSnapshotHash: 'snapshot-abc',
  validEvidenceRefs: ['message:12'],
  requestedCards: [
    { family: 'Scene Frame', role: 'sceneFrameCard', sourceCardIds: [] },
    { family: 'Scene Constraints', role: 'sceneConstraintsCard', sourceCardIds: [] }
  ]
});
assertDeepEqual(fused.acceptedFamilies, ['Scene Frame'], 'known family is accepted');
assertDeepEqual(fused.missingFamilies, ['Scene Constraints'], 'missing requested family is identified');
assertEqual(fused.cards.length, 1, 'unknown family is rejected');

console.log('[pass] compact card contract v1');
