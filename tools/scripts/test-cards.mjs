import { UTILITY_ROLE_IDS } from '../../src/providers.mjs';
import {
  CARD_CATALOG,
  applyCardPlan,
  buildCardRequests,
  cardsFromProviderResult,
  normalizeCard,
  selectHand
} from '../../src/cards.mjs';
import { assert, assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

const EXPECTED_CATALOG = Object.freeze([
  { family: 'Scene Frame', role: 'sceneFrameCard', priority: 100 },
  { family: 'Active Cast', role: 'activeCastCard', priority: 95 },
  { family: 'Character Motivation', role: 'characterMotivationCard', priority: 88 },
  { family: 'Dialogue/Relationship', role: 'dialogueRelationshipCard', priority: 84 },
  { family: 'Continuity Risk', role: 'continuityRiskCard', priority: 98 },
  { family: 'Environment/Items', role: 'environmentItemsCard', priority: 76 },
  { family: 'Prose/Pacing', role: 'prosePacingCard', priority: 62 },
  { family: 'Open Threads', role: 'openThreadsCard', priority: 72 }
]);

function deckCard(family, promptText, overrides = {}) {
  return normalizeCard({
    family,
    promptText,
    evidenceRefs: [`message:${family}`],
    ...overrides
  }, { sceneId: 'scene-budget', snapshotHash: 'hash-budget' });
}

assertEqual(CARD_CATALOG.length, 8, 'full V1 catalog present');
assertDeepEqual(
  CARD_CATALOG.map(({ family, role, priority }) => ({ family, role, priority })),
  EXPECTED_CATALOG,
  'catalog membership and order match V1 plan'
);
for (const entry of CARD_CATALOG) {
  assert(UTILITY_ROLE_IDS.includes(entry.role), `${entry.role} exists in provider utility roles`);
}

const card = normalizeCard({
  family: 'Character Motivation',
  promptText: 'Mara appears guarded after the accusation.',
  inspectorNotes: 'Do not inject this note.',
  evidenceRefs: ['message:4']
}, { sceneId: 'scene-1', snapshotHash: 'hash' });
assertEqual(card.status, 'active', 'card active by default');
assertEqual(card.family, 'Character Motivation', 'family preserved');
assertEqual(card.role, 'characterMotivationCard', 'role derived from family');
assertEqual(card.catalogKey, 'Character-Motivation', 'catalog key derived from family');
assertEqual(card.source.snapshotHash, 'hash', 'snapshot hash preserved in source');
assertEqual(card.freshness.sourceFingerprint, 'hash', 'snapshot hash preserved in freshness');

const roleMapped = normalizeCard({
  role: 'continuityRiskCard',
  promptText: 'The airlock is open and must be addressed.',
  detailProfile: 'bad-detail',
  emphasis: 'bad-emphasis',
  status: 'candidate'
}, { sceneId: 'scene-2', snapshotHash: 'hash-2' });
assertEqual(roleMapped.family, 'Continuity Risk', 'family derived from role');
assertEqual(roleMapped.detailProfile, 'standard', 'invalid detail profile falls back');
assertEqual(roleMapped.emphasis, 'normal', 'invalid emphasis falls back');
assertEqual(roleMapped.status, 'candidate', 'valid non-default status preserved');

await assertRejects(
  async () => normalizeCard({ family: 'Scene Frame', promptText: '   ' }, { sceneId: 'scene-1' }),
  /promptText/,
  'empty promptText rejected'
);
await assertRejects(
  async () => normalizeCard({ family: 'Scene Frame' }, { sceneId: 'scene-1' }),
  /promptText/,
  'missing promptText rejected'
);
await assertRejects(
  async () => normalizeCard({ promptText: 'No catalog identity.' }, { sceneId: 'scene-1' }),
  /family or role/,
  'missing card family or role rejected'
);
await assertRejects(
  async () => normalizeCard({ family: 'Scene Frame', role: 'continuityRiskCard', promptText: 'Mismatch.' }, { sceneId: 'scene-1' }),
  /mismatch/,
  'mismatched family and role rejected'
);

const deck = applyCardPlan([], {
  acceptedCards: [card],
  lifecycle: [{ action: 'select', cardId: card.id, reason: 'relevant' }]
});
assertEqual(deck.cards.length, 1, 'deck has card');
assertEqual(deck.cards[0].arbiter.reason, 'relevant', 'arbiter reason applied');
assertEqual(deck.cards[0].status, 'active', 'selected card is active');

const lifecycleBase = [
  deckCard('Scene Frame', 'The bridge is tense.', { id: 'scene-card' }),
  deckCard('Active Cast', 'Mara and Ilya are present.', { id: 'cast-card' }),
  deckCard('Continuity Risk', 'The door was locked.', { id: 'risk-card' }),
  deckCard('Open Threads', 'The distress signal remains unanswered.', { id: 'thread-card' }),
  deckCard('Prose/Pacing', 'Keep the reply clipped.', { id: 'pace-card' })
];
const transitioned = applyCardPlan(lifecycleBase, {
  lifecycle: [
    { action: 'stow', cardId: 'scene-card', reason: 'not immediate' },
    { action: 'discard', cardId: 'cast-card', reason: 'left scene' },
    { action: 'regenerate', cardId: 'risk-card', reason: 'needs refresh' },
    { action: 'emphasize', cardId: 'thread-card', reason: 'urgent' },
    { action: 'discard', cardId: 'risk card', reason: 'mutated id should not match' },
    { action: 'unknown', cardId: 'pace-card', reason: 'ignored action' },
    { action: 'select', cardId: 'missing-card', reason: 'ignored missing card' }
  ]
});
assertEqual(transitioned.cards.find((entry) => entry.id === 'scene-card').status, 'stowed', 'stow transition applied');
assertEqual(transitioned.cards.find((entry) => entry.id === 'cast-card').status, 'discarded', 'discard transition applied');
assertEqual(transitioned.cards.find((entry) => entry.id === 'risk-card').status, 'stale', 'regenerate transition marks stale');
assertEqual(transitioned.cards.find((entry) => entry.id === 'thread-card').status, 'active', 'emphasize transition activates');
assertEqual(transitioned.cards.find((entry) => entry.id === 'thread-card').emphasis, 'emphasized', 'emphasize transition sets emphasis');
assertEqual(transitioned.cards.find((entry) => entry.id === 'thread-card').arbiter.reason, 'urgent', 'emphasize reason recorded');
assertEqual(transitioned.cards.find((entry) => entry.id === 'pace-card').status, 'active', 'unknown action is no-op');
assertEqual(transitioned.cards.find((entry) => entry.id === 'risk-card').arbiter.reason, 'needs refresh', 'mutated action id does not retarget normalized id');

const preservedIdCard = {
  ...deckCard('Continuity Risk', 'The exact stored id includes a space.', { id: 'risk-card' }),
  id: 'risk card'
};
const wrongIdTransition = applyCardPlan([preservedIdCard], {
  lifecycle: [{ action: 'discard', cardId: 'risk-card', reason: 'should not match sanitized variant' }]
});
assertEqual(wrongIdTransition.cards[0].id, 'risk card', 'existing deck card id preserved exactly');
assertEqual(wrongIdTransition.cards[0].status, 'active', 'sanitized lifecycle id does not match exact stored id');
const exactIdTransition = applyCardPlan([preservedIdCard], {
  lifecycle: [{ action: 'discard', cardId: 'risk card', reason: 'exact id matches' }]
});
assertEqual(exactIdTransition.cards[0].id, 'risk card', 'exact id remains preserved after lifecycle');
assertEqual(exactIdTransition.cards[0].status, 'discarded', 'exact stored id lifecycle match applies');

const requests = buildCardRequests({ cardJobs: [{ role: 'sceneFrameCard' }, { role: 'continuityRiskCard' }] }, {
  runId: 'run',
  snapshotHash: 'hash'
});
assertEqual(requests.length, 2, 'card requests built');
assertDeepEqual(requests.map((request) => request.roleId), ['sceneFrameCard', 'continuityRiskCard'], 'request role ids built');
assertEqual(requests[0].runId, 'run', 'run id included');
assertEqual(requests[0].snapshotHash, 'hash', 'snapshot hash included');
assertEqual(requests[0].metadata.family, 'Scene Frame', 'request metadata includes family');
assertEqual(requests[1].metadata.reason, '', 'missing request reason defaults empty');
assert(requests[0].prompt.includes('Return one JSON object'), 'request prompt asks for JSON-only output');

const providerCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    items: [
      {
        promptText: 'The scene is boxed into a damaged shuttle.',
        inspectorNotes: 'private provider note',
        evidenceRefs: ['message:8']
      }
    ]
  }
}, { sceneId: 'scene-provider', snapshotHash: 'hash-provider' });
assertEqual(providerCards.length, 1, 'valid provider item converted');
assertEqual(providerCards[0].family, 'Scene Frame', 'provider role maps family');
assertEqual(providerCards[0].source.snapshotHash, 'hash-provider', 'provider cards inherit source context');
assertEqual(cardsFromProviderResult({ ok: false, data: { items: [{ promptText: 'ignored' }] } }).length, 0, 'non-ok provider result ignored');
assertEqual(cardsFromProviderResult({ ok: true, data: {} }).length, 0, 'provider result without items ignored');
assertEqual(cardsFromProviderResult({ ok: true, data: { items: [{ promptText: 'orphan provider item' }] } }).length, 0, 'provider item without role or family ignored');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    items: [{ family: 'Continuity Risk', promptText: 'conflicting provider item' }]
  }
}).length, 0, 'provider item with conflicting family and role ignored');

const selectedDeck = [
  deckCard('Prose/Pacing', 'Keep it brisk.', { id: 'low', tokenEstimate: 20 }),
  deckCard('Continuity Risk', 'Do not forget the cracked visor.', { id: 'risk', tokenEstimate: 220 }),
  deckCard('Open Threads', 'The signal is unanswered.', { id: 'emph', tokenEstimate: 120, emphasis: 'emphasized' }),
  deckCard('Scene Frame', 'The bay is sealed.', { id: 'scene', tokenEstimate: 80, inspectorNotes: 'private' }),
  deckCard('Active Cast', 'Mara waits outside.', { id: 'stowed', status: 'stowed', tokenEstimate: 30 })
];
const budgetHand = selectHand(selectedDeck, { maxCards: 2, maxTokens: 300 });
assertDeepEqual(budgetHand.cards.map((entry) => entry.id), ['emph', 'scene'], 'hand sorts by emphasis then catalog priority');
assertEqual(budgetHand.cards.length, 2, 'maxCards enforced');
assertEqual(budgetHand.tokenEstimate, 200, 'token estimate sums selected cards');
assert(!budgetHand.cards.some((entry) => entry.inspectorNotes), 'hand excludes inspector notes');
assert(!budgetHand.cards.some((entry) => entry.arbiter || entry.source || entry.freshness || entry.summary), 'hand uses prompt-facing allowlist shape');
assertDeepEqual(Object.keys(budgetHand.cards[0]), ['id', 'family', 'role', 'status', 'promptText', 'tokenEstimate', 'detailProfile', 'emphasis', 'evidenceRefs'], 'hand card shape is allowlisted');
assert(budgetHand.omitted.some((entry) => entry.cardId === 'risk' && entry.reason === 'max-cards'), 'full hand reports maxCards omissions first');
assert(budgetHand.omitted.some((entry) => entry.cardId === 'low' && entry.reason === 'max-cards'), 'maxCards omissions recorded');
assert(budgetHand.omitted.some((entry) => entry.cardId === 'stowed' && entry.reason === 'inactive'), 'inactive omissions recorded');
assertEqual(budgetHand.metadata.maxCards, 2, 'hand metadata includes maxCards');
assertEqual(budgetHand.metadata.maxTokens, 300, 'hand metadata includes maxTokens');

const tokenOnlyHand = selectHand([
  deckCard('Continuity Risk', 'Oversized risk.', { id: 'too-big', tokenEstimate: 301 }),
  deckCard('Scene Frame', 'Small scene.', { id: 'small', tokenEstimate: 20 })
], { maxCards: 5, maxTokens: 300 });
assert(tokenOnlyHand.omitted.some((entry) => entry.cardId === 'too-big' && entry.reason === 'token-budget'), 'token budget omissions recorded before hand is full');

const hand = selectHand(deck.cards, { maxCards: 4, maxTokens: 500 });
assertEqual(hand.cards.length, 1, 'hand selected card');
assert(!hand.cards[0].inspectorNotes, 'hand excludes inspector notes');
console.log('[pass] cards');
