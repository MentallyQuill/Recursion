import assert from 'node:assert/strict';
import { reconcileAutoPriorityPlan, cardSelectionSettingsForTurn } from '../../src/runtime.mjs';
import { createDefaultCardDeck, getActiveCardDeck, activeCardDeckSourceCards } from '../../src/pre-process-decks.mjs';
import { normalizeSettings } from '../../src/settings.mjs';
import { CARD_CATALOG, buildCardRequests, buildFusedCardBundleRequest, selectHand } from '../../src/cards.mjs';

const deck = createDefaultCardDeck();
deck.id = 'coverage'; deck.name = 'Coverage'; deck.bundled = false; deck.readonly = false;
for (const card of Object.values(deck.cards)) card.selectionState = card.builtinFamily === 'Realism' ? 'priority' : 'active';
const settings = normalizeSettings({ mode: 'auto', reasoningLevel: 'medium', minCards: 8, maxCards: 8,
  cardSelection: { variety: 'off', cooldownTurns: 0 },
  preProcessDecks: { activeDeckId: deck.id, customDecks: { [deck.id]: deck } } });
const families = ['Realism', 'Knowledge', 'Character Motivation', 'Relationship', 'Active Cast', 'Open Threads', 'Scene Constraints', 'Social Subtext'];
const sourceFor = (family) => Object.values(getActiveCardDeck(settings).cards).find(card => card.builtinFamily === family);
const input = { action: 'refresh-cards', budgets: { maxCards: 8 }, cardJobs: families.map(family => ({
  family, cardId: sourceFor(family).id, reason: 'Distinct next-turn contribution.'
})) };
const plan = reconcileAutoPriorityPlan(input, settings);
assert.deepEqual(plan.cardJobs.map(job => job.family), families, 'built-in card IDs remain executable generation jobs');
assert.deepEqual(plan.selection.selectedAuthoredCardIds, [], 'built-in sources never occupy authored slots');
const requestContext = { snapshot: { messages: [] }, sourceCardsByFamily: activeCardDeckSourceCards(settings) };
assert.deepEqual(buildCardRequests(plan, requestContext).map(request => CARD_CATALOG.find(card => card.role === request.roleId).family), families);
assert.deepEqual(buildFusedCardBundleRequest(plan, requestContext).requestedCards.map(request => request.family), families);
console.log('[pass] built-in card ID planning coverage');

// Deck identity controls family routing, even when the model supplies no family or the wrong one.
for (const familyHint of [undefined, 'Environment']) {
  const idPlan = reconcileAutoPriorityPlan({ ...input, cardJobs: [
    { cardId: sourceFor('Knowledge').id, family: familyHint }
  ] }, settings);
  assert.equal(idPlan.cardJobs[1].family, 'Knowledge', 'built-in ID resolves its real family before filling spare capacity');
  assert.deepEqual(idPlan.cardJobs[1].sourceCardIds, [sourceFor('Knowledge').id]);
}
console.log('[pass] authoritative deck identity');

// Unknown IDs cannot borrow an eligible (especially mandatory) family as a fallback.
const unknown = reconcileAutoPriorityPlan({ ...input, cardJobs: [
  { cardId: 'missing-card', family: 'Realism', reason: 'UNKNOWN_SENTINEL' }
] }, settings);
assert(unknown.selection.omitted.some(entry => entry.cardId === 'missing-card' && entry.reason === 'ineligible-card'));
assert(!unknown.cardJobs.some(job => job.reason === 'UNKNOWN_SENTINEL'));
console.log('[pass] unknown card identity rejected');

// Multiple source selections in the same generated family retain their combined coverage.
const knowledgeSources = activeCardDeckSourceCards(settings).Knowledge;
const repeated = reconcileAutoPriorityPlan({ ...input, cardJobs: knowledgeSources.slice(0, 2).map(card => ({ cardId: card.id })) }, settings);
assert.deepEqual(repeated.cardJobs.find(job => job.family === 'Knowledge').sourceCardIds, knowledgeSources.slice(0, 2).map(card => card.id));
console.log('[pass] repeated family source coverage');

// Mandatory authored cards must appear in the same coverage ledger as generated jobs.
const authoredDeck = structuredClone(getActiveCardDeck(settings));
authoredDeck.cards.authored = { id: 'authored', name: 'Authored', categoryId: authoredDeck.categoryOrder[0], promptText: 'Keep the promise.', selectionState: 'priority', kind: 'authored' };
authoredDeck.cardOrderByCategory[authoredDeck.categoryOrder[0]].push('authored');
const authoredSettings = normalizeSettings({ ...settings, preProcessDecks: { activeDeckId: authoredDeck.id, customDecks: { [authoredDeck.id]: authoredDeck } } });
const authoredPlan = reconcileAutoPriorityPlan(input, authoredSettings);
assert(authoredPlan.selection.retained.some(job => job.cardId === 'authored' && job.mandatory));
assert.equal(authoredPlan.selection.retained.length, authoredPlan.selection.plannedCount);
console.log('[pass] mandatory authored coverage ledger');

// Missing planned work is distinct from having too few eligible candidates.
const missingHand = selectHand([], { maxCards: 8, selectionDiagnostics: authoredPlan.selection });
assert(missingHand.metadata.selection.missingPlannedCards.some(job => job.cardId === 'authored'));
assert(missingHand.metadata.selection.shortfallReasons.includes('planned-card-missing'));
const generated = plan.cardJobs.map(job => ({ id: 'generated-' + job.role, family: job.family, role: job.role,
  sourceCardIds: job.sourceCardIds, status: 'active', origin: 'generated', promptText: 'Apply the selected instructions.' }));
const completeHand = selectHand(generated, { maxCards: 8, selectionDiagnostics: plan.selection });
assert.deepEqual(completeHand.metadata.selection.missingPlannedCards, []);
assert.deepEqual(completeHand.metadata.selection.shortfallReasons, []);
console.log('[pass] planned hand omissions');

// Verify actual generation, Guidance, installation and cached reuse in both pipelines.
const { runCardBudgetFixture } = await import('../../tests/helpers/card-budget-fixture.mjs');
for (const pipelineMode of ['fused', 'segmented']) {
  const fixture = await runCardBudgetFixture({ pipelineMode, minCards: 8, maxCards: 8, authoredCount: 0,
    priorityFamily: 'Realism', proposed: input.cardJobs });
  assert.equal(fixture.result.ok, true);
  assert.deepEqual(fixture.view.lastHand.cards.map(card => card.family), families);
  assert.equal(fixture.installed.selectedCardRefs.length, 8);
  const guidance = fixture.calls.find(call => call.roleId === 'guidanceComposer');
  for (const card of fixture.view.lastHand.cards) assert(guidance.request.prompt.includes(card.promptText));
  const count = fixture.calls.length;
  const reused = await fixture.runtime.prepareForGeneration({ userMessage: { text: 'I ask what she remembers.', mesid: 2 } });
  assert.equal(reused.ok, true);
  assert.equal(fixture.calls.length, count, 'complete hand remains reusable');
}
console.log('[pass] built-in ID hand reaches Guidance and installation in both pipelines');

// An otherwise valid family hint must not revive Off or cooldown-excluded IDs.
for (const exclusion of ['off', 'cooldown']) {
  const excludedDeck = structuredClone(getActiveCardDeck(settings));
  const excludedId = sourceFor('Knowledge').id;
  if (exclusion === 'off') excludedDeck.cards[excludedId].selectionState = 'off';
  let excludedSettings = normalizeSettings({ ...settings, cardSelection: { variety: 'off', cooldownTurns: 1 },
    preProcessDecks: { activeDeckId: excludedDeck.id, customDecks: { [excludedDeck.id]: excludedDeck } } });
  if (exclusion === 'cooldown') excludedSettings = cardSelectionSettingsForTurn(excludedSettings, {
    cardSelectionHistory: [{ deckId: excludedDeck.id, cards: [{ cardId: excludedId }] }]
  });
  const excludedPlan = reconcileAutoPriorityPlan({ ...input, cardJobs: [{ cardId: excludedId, family: 'Knowledge' }] }, excludedSettings);
  assert(excludedPlan.selection.omitted.some(entry => entry.cardId === excludedId && entry.reason === 'ineligible-card'));
  assert(!excludedPlan.cardJobs.some(job => job.sourceCardIds.includes(excludedId)));
  assert(!excludedPlan.selection.selectedAuthoredCardIds.includes(excludedId));
}
// Coverage checks source identities, not just the number of cards or their family labels.
const reduced = generated.map(card => card.family === 'Knowledge' ? { ...card, sourceCardIds: [] } : card);
assert.equal(selectHand(reduced, { maxCards: 8, selectionDiagnostics: plan.selection }).metadata.selection.missingPlannedCards[0].family, 'Knowledge');
console.log('[pass] exclusion and source coverage boundaries');
