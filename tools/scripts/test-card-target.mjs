import assert from 'node:assert/strict';
import { normalizeCardBudgetSettings, normalizeSettings, createSettingsStore, resetSettingsMenuValue } from '../../src/settings.mjs';
import { runCardBudgetFixture } from '../../tests/helpers/card-budget-fixture.mjs';
import { preparedGenerationSettingsSignature } from '../../src/runtime.mjs';
import { getActiveCardDeck, activeCardDeckSourceCards } from '../../src/pre-process-decks.mjs';

assert.deepEqual(normalizeCardBudgetSettings({}), { targetCards: 6 }, 'missing operator target defaults to six');
for (const [value, targetCards] of [[0, 0], [-4, 0], [27, 20], ['4', 4], [4.6, 5], [null, 6], ['', 6], [true, 6], [[], 6], [{}, 6], ['many', 6]]) {
  assert.deepEqual(normalizeCardBudgetSettings({ cardsPerTurn: value }), { targetCards }, `target ${String(value)} normalizes`);
}
const normalized = normalizeSettings({ cardsPerTurn: 0, minCards: 19, maxCards: 20 });
assert.equal(normalized.cardsPerTurn, 0, 'persisted target preserves zero');
assert(!Object.hasOwn(normalized, 'minCards') && !Object.hasOwn(normalized, 'maxCards'), 'removed range fields do not persist');
assert.equal(normalizeSettings({ minCards: 0, maxCards: 0 }).cardsPerTurn, 6, 'removed range is not a compatibility alias');
const root = {};
const store = createSettingsStore({ root });
store.update({ cardsPerTurn: 4 });
store.update({ focus: 'scene' });
assert.equal(createSettingsStore({ root }).get().cardsPerTurn, 4, 'partial edits and reload preserve the target');
assert.equal(resetSettingsMenuValue(store.get()).cardsPerTurn, 6, 'Reset Defaults restores six');
console.log('[pass] card target normalization');

for (const pipelineMode of ['segmented', 'fused']) {
  for (const reasoningLevel of ['low', 'medium', 'high', 'ultra']) {
    const fixture = await runCardBudgetFixture({ pipelineMode, reasoningLevel, cardsPerTurn: 4, authoredCount: 0 });
    assert.equal(fixture.result.ok, true, `${pipelineMode}/${reasoningLevel} prepares`);
    assert.equal(fixture.view.lastPlan.budgets.maxCards, 4, 'routing cannot change target');
    assert.equal(fixture.installed.selectedCardRefs.length, 4, 'installed hand keeps operator target');
    assert.equal(fixture.runtime.view().settings.cardsPerTurn, 4, 'runtime settings expose target');
    assert(!Object.hasOwn(fixture.runtime.view().settings, 'maxCards'), 'runtime view removes persisted maxCards');
  }
  for (const strength of ['light', 'balanced', 'strong']) {
    for (const promptFootprint of ['compact', 'normal', 'rich']) {
      const fixture = await runCardBudgetFixture({ pipelineMode, cardsPerTurn: 4, authoredCount: 0, strength, promptFootprint });
      assert.equal(fixture.installed.selectedCardRefs.length, 4, 'guidance strength and detail cannot change target');
    }
  }
}
assert.notDeepEqual(preparedGenerationSettingsSignature({ cardsPerTurn: 0 }), preparedGenerationSettingsSignature({ cardsPerTurn: 4 }), 'target edits invalidate prepared artifacts');
console.log('[pass] independent card target across routing and pipelines');

// A family generator counts once even when several enabled source cards contribute.
// Authored entries each occupy a slot, and Refinement reserves its units first.
const configureManualDeck = deck => {
  for (const card of Object.values(deck.cards)) card.selectionState = 'off';
  const scenes = Object.values(deck.cards).filter(card => card.builtinFamily === 'Scene Frame');
  scenes[0].selectionState = 'active'; scenes[1].selectionState = 'active';
  const environment = Object.values(deck.cards).find(card => card.builtinFamily === 'Environment');
  environment.selectionState = 'refinement';
  for (const id of ['authored-0', 'authored-1']) deck.cards[id].selectionState = 'active';
  deck.cards['authored-2'].selectionState = 'refinement';
};
for (const pipelineMode of ['segmented', 'fused']) {
  const fixture = await runCardBudgetFixture({ pipelineMode, mode: 'manual', cardsPerTurn: 3, configureDeck: configureManualDeck });
  assert.equal(fixture.result.ok, true, 'bounded Manual preparation succeeds');
  assert.equal(fixture.installed.selectedCardRefs.length, 3, 'Manual installs mandatory units plus only the first ordinary unit');
  assert.deepEqual(fixture.view.lastHand.cards.filter(card => card.origin === 'authored').map(card => card.id), ['authored-2'], 'ordinary authored cards are omitted when generated unit consumes last slot');
  assert.deepEqual(fixture.view.lastPlan.cardJobs.map(job => job.family), ['Environment', 'Scene Frame'], 'mandatory job is reserved ahead of ordinary deck order');
  const sourceIds = activeCardDeckSourceCards(fixture.settingsStore.get())['Scene Frame'].map(card => card.id);
  assert.equal(sourceIds.length, 2, 'repeated family sources share one unit');
  assert.deepEqual(fixture.view.lastHand.cards.find(card => card.family === 'Scene Frame').sourceCardIds, sourceIds, 'actual hand retains all selected family source identities');
  assert.deepEqual(fixture.view.lastPlan.selection.omitted.filter(unit => unit.reason === 'cards-per-turn').map(unit => unit.cardId), ['authored-0', 'authored-1'], 'turn plan explains enabled omitted authored units');
  const before = getActiveCardDeck(fixture.settingsStore.get());
  await fixture.runtime.updateSettings({ cardsPerTurn: 0 });
  assert.deepEqual(getActiveCardDeck(fixture.settingsStore.get()), before, 'lowering target preserves saved deck states');
  const zero = await fixture.runtime.prepareForGeneration({ userMessage: { text: 'I ask what she remembers.', mesid: 2 } });
  assert.equal(zero.ok, true, 'Manual zero still prepares mandatory Refinement');
  assert.deepEqual(zero.hand.cards.map(card => card.family).sort(), ['Authored', 'Environment'], 'zero includes only mandatory Refinement units');
  assert.equal(fixture.runtime.view().lastPlan.budgets.maxCards, 2, 'mandatory overflow is visible in the internal plan budget');
  const arbiterSettings = JSON.parse(fixture.calls.find(call => call.roleId === 'utilityArbiter').request.prompt.match(/Settings: (.*)/)[1]);
  assert.equal(arbiterSettings.selectionBudget.authoredSlots, 1, 'Manual Arbiter sees mandatory authored reservations');
  assert.deepEqual(arbiterSettings.selectionBudget.mandatoryFamilies, ['Environment'], 'Manual Arbiter sees mandatory generated reservations');
  assert.equal(arbiterSettings.selectionBudget.availableSlots, 1, 'Manual Arbiter sees only the remaining ordinary capacity');
}
console.log('[pass] pure Manual per-turn selection reaches installation');
