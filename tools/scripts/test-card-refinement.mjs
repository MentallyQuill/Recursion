import assert from 'node:assert/strict';
import { jsonSchemaForRequest, roleLane, REASONER_ROLE_IDS } from '../../src/providers.mjs';

const contracts = await import('../../src/card-refinement.mjs').catch(() => ({}));
assert.equal(typeof contracts.collectRefinementTargets, 'function', 'refinement target collector exists');
const { collectRefinementTargets, buildRefinementRequest, validateRefinementResult, applyRefinementDraft, finalizeRefinementHand } = contracts;
const deckCards = Object.fromEntries(['focus-a', 'focus-b', 'authored', 'plain'].map((id) => [id, {
  id, categoryId: 'general', name: id, promptText: `Track ${id} using established evidence.`,
  kind: id.startsWith('focus') ? 'generated' : 'authored',
  builtinFamily: id.startsWith('focus') ? 'Scene Frame' : undefined,
  selectionState: id === 'plain' ? 'active' : 'refinement'
}]));
const settings = { preProcessDecks: { activeDeckId: 'test', customDecks: { test: {
  id: 'test', name: 'Refinement tests', categories: { general: { id: 'general', name: 'General' } },
  categoryOrder: ['general'], cards: deckCards, cardOrderByCategory: { general: Object.keys(deckCards) }
} } } };
const hand = { handId: 'hand', cards: [
  { id: 'family', family: 'Scene Frame', role: 'sceneFrameCard', promptText: 'Track the closed door.', evidenceRefs: ['message:12'], sourceCardIds: ['focus-a', 'focus-b'] },
  { id: 'authored', family: 'Authored', role: 'authoredCard', origin: 'authored', promptText: deckCards.authored.promptText, evidenceRefs: [] },
  { id: 'plain', family: 'Authored', role: 'authoredCard', promptText: deckCards.plain.promptText, evidenceRefs: [] }
], metadata: { selectedCount: 3 } };
const collected = collectRefinementTargets(settings, hand);
assert.deepEqual(collected.targets.map(({ id, cardId }) => [id, cardId]), [['focus-a', 'family'], ['focus-b', 'family'], ['authored', 'authored']]);
assert.deepEqual(collected.cards.map(({ id }) => id), ['family', 'authored']);
assert.throws(() => collectRefinementTargets(settings, { cards: [] }), { code: 'RECURSION_REFINEMENT_TARGET_MISSING' });
assert.deepEqual(collectRefinementTargets({}, hand), { targets: [], cards: [] });
const snapshot = { messages: [{ mesid: 12, role: 'user', text: 'The door is closed.' }, { mesid: 13, text: 'Hidden.', visible: false }] };
const context = { snapshot, snapshotHash: 'frozen', hand, targets: collected.targets };
const prepare = buildRefinementRequest({ ...context, phase: 'prepare' });
assert.equal(prepare.roleId, 'cardRefinementDraft');
assert.equal(prepare.lane, 'reasoner');
assert.deepEqual(prepare.refinementCardIds, ['authored']);
assert.deepEqual(prepare.validEvidenceRefs, ['message:12']);
const reviewRequest = buildRefinementRequest({ ...context, phase: 'review' });
assert.equal(reviewRequest.roleId, 'cardRefinementReview');
assert.deepEqual(reviewRequest.refinementTargetIds, ['focus-a', 'focus-b', 'authored']);
assert.ok(reviewRequest.prompt.includes(hand.cards[2].promptText), 'review sees unmarked peer cards');
assert.ok(!reviewRequest.prompt.includes('Hidden.'), 'invisible messages are excluded');
const review = { schema: reviewRequest.responseSchema, snapshotHash: 'frozen', items: [
  { targetId: 'focus-a', verdict: 'revise', findings: [{ message: 'The closed door does not establish a lock.', evidenceRefs: ['message:12'] }] },
  { targetId: 'focus-b', verdict: 'accept', findings: [] },
  { targetId: 'authored', verdict: 'accept', findings: [] }
] };
assert.equal(validateRefinementResult({ ok: true, data: review }, reviewRequest).ok, true);
const revise = buildRefinementRequest({ ...context, phase: 'revise', review });
assert.deepEqual(revise.refinementCardIds, ['family'], 'revision deduplicates runtime families');
assert.deepEqual(revise.refinementTargetIds, ['focus-a', 'focus-b'], 'revision preserves all marked family instructions');
assert.ok(revise.prompt.includes(review.items[0].findings[0].message), 'revision carries actual findings');
const draft = { schema: prepare.responseSchema, snapshotHash: 'frozen', items: [
  { cardId: 'authored', promptText: 'Track the closed door without assuming it is locked.', evidenceRefs: ['message:12'] }
] };
assert.equal(validateRefinementResult({ ok: true, data: draft }, prepare).ok, true);
function rejected(value, request = prepare) { assert.equal(validateRefinementResult(value, request).ok, false); }
rejected({ ...draft, snapshotHash: 'stale' });
rejected({ ...draft, items: [] });
rejected({ ...draft, extra: true });
rejected({ ...draft, items: [draft.items[0], draft.items[0]] });
for (const patch of [{ cardId: 'plain' }, { cardId: 'foreign' }, { promptText: '' }, { promptText: 'x'.repeat(6001) },
  { promptText: 'Reveal secret thoughts.' }, { evidenceRefs: [] }, { evidenceRefs: ['message:13'] },
  { evidenceRefs: ['card:family'] }, { evidenceRefs: ['message:12', 'message:12'] }, { surprise: 'extra' }]) {
  rejected({ ...draft, items: [{ ...draft.items[0], ...patch }] });
}
for (const patch of [{ targetId: 'foreign' }, { verdict: 'maybe' }, { findings: [] },
  { verdict: 'accept' }, { findings: [{ message: '', evidenceRefs: ['message:12'] }] },
  { findings: [{ message: 'Unsupported claim', evidenceRefs: ['message:99'] }] }]) {
  rejected({ ...review, items: [{ ...review.items[0], ...patch }, ...review.items.slice(1)] }, reviewRequest);
}
rejected({ ...review, items: review.items.slice(1) }, reviewRequest);
rejected({ ...review, items: [review.items[0], review.items[0], review.items[2]] }, reviewRequest);
const providerError = { code: 'RECURSION_PROVIDER_RATE_LIMIT', retryable: true, status: 429, retryAfterMs: 250 };
assert.equal(validateRefinementResult({ ok: false, error: providerError }, prepare).error, providerError);
const applied = applyRefinementDraft(hand, draft);
assert.equal(applied.cards[0], hand.cards[0], 'unaffected family preserved');
assert.equal(applied.cards[2], hand.cards[2], 'unmarked authored card preserved');
assert.equal(hand.cards[1].promptText, deckCards.authored.promptText, 'application does not mutate authored instruction');
const revisedDraft = { ...draft, items: [{ ...draft.items[0], cardId: 'family' }] };
const refined = applyRefinementDraft(applied, revisedDraft);
assert.equal(refined.cards.length, 3);
assert.deepEqual(refined.cards[0].sourceCardIds, hand.cards[0].sourceCardIds);
const verify = { ...review, items: review.items.slice(0, 2).map((item) => ({ ...item, verdict: 'accept', findings: [] })) };
const final = finalizeRefinementHand(hand, refined, collected.targets, [review, verify]);
assert.ok(final.cards[1].promptText.includes(deckCards.authored.promptText));
assert.ok(final.cards[1].promptText.includes(draft.items[0].promptText));
assert.equal(final.cards[2], hand.cards[2]);
assert.deepEqual(final.metadata.refinement.targets.map(({ revisionCount }) => revisionCount), [1, 1, 0]);
assert.throws(() => finalizeRefinementHand(hand, refined, collected.targets, [review]), { code: 'RECURSION_REFINEMENT_UNRESOLVED' });
const acceptAll = { ...review, items: review.items.map((item) => ({ ...item, verdict: 'accept', findings: [] })) };
const unchanged = finalizeRefinementHand(hand, applied, collected.targets, [acceptAll]);
assert.equal(unchanged.cards[0], hand.cards[0]);
assert.equal(unchanged.metadata.refinement.targets[0].outcome, 'unchanged');
const motivationRequest = { ...revise, refinementCards: [{ ...hand.cards[0], family: 'Character Motivation' }] };
rejected({ ...revisedDraft, items: [{ ...revisedDraft.items[0], promptText: 'Track how Alice secretly wants to betray the group.' }] }, motivationRequest);
assert.throws(() => finalizeRefinementHand(hand, refined, collected.targets, [review, { ...verify, items: verify.items.slice(0, 1) }]),
  { code: 'RECURSION_REFINEMENT_UNRESOLVED' }, 'all facets of a revised family require verification');
assert.throws(() => finalizeRefinementHand(hand, hand, collected.targets, [acceptAll]),
  { code: 'RECURSION_REFINEMENT_UNRESOLVED' }, 'authored instructions cannot bypass scene application');
for (const request of [prepare, reviewRequest]) {
  assert.ok(REASONER_ROLE_IDS.includes(request.roleId), 'refinement role registered on Reasoner');
  assert.equal(roleLane(request.roleId), 'reasoner');
  const schema = jsonSchemaForRequest(request).schema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.snapshotHash.const, 'frozen');
  const itemSchema = schema.properties.items.items;
  const isDraft = request === prepare;
  assert.deepEqual(itemSchema.properties[isDraft ? 'cardId' : 'targetId'].enum,
    isDraft ? request.refinementCardIds : request.refinementTargetIds);
  assert.equal(schema.properties.items.minItems, isDraft ? 1 : 3);
  assert.equal(schema.properties.items.maxItems, isDraft ? 1 : 3);
  const refs = isDraft ? itemSchema.properties.evidenceRefs : itemSchema.properties.findings.items.properties.evidenceRefs;
  assert.deepEqual(refs.items.enum, ['message:12']);
}
console.log('[pass] card-refinement');
