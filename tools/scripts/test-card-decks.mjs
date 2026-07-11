import {
  CARD_DECK_SETTINGS_VERSION,
  DEFAULT_CARD_DECK_ID,
  NEW_CARD_NAME,
  cardNameWarning,
  createCategory,
  createCustomCardDeck,
  createDefaultCardDeck,
  createDraftCard,
  deleteCard,
  deleteCategory,
  deleteCategoryAndCards,
  deleteCustomCardDeck,
  duplicateCardName,
  duplicateCard,
  duplicateCardDeck,
  duplicateDeckName,
  getDeckCardStatus,
  moveCard,
  normalizeCardDeckSettings,
  normalizeCustomDeck,
  reorderCategories,
  reorderCards,
  serializeCustomCardDecksForExport
} from '../../src/card-decks.mjs';
import { normalizeSettings } from '../../src/settings.mjs';
import { CARD_SCOPE_CATALOG, defaultCardScope } from '../../src/card-scope.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const now = '2026-07-10T00:00:00.000Z';
const defaultDeck = createDefaultCardDeck({ now });
assertEqual(defaultDeck.id, DEFAULT_CARD_DECK_ID, 'Default deck id stable');
assertEqual(defaultDeck.name, 'Default', 'Default deck name stable');
assertEqual(defaultDeck.readonly, true, 'Default deck read-only');
assertEqual(defaultDeck.bundled, true, 'Default deck bundled');
assertEqual(defaultDeck.categoryOrder.length, CARD_SCOPE_CATALOG.length, 'Default deck mirrors Card Scope families');
assertEqual(
  Object.keys(defaultDeck.cards).length,
  CARD_SCOPE_CATALOG.reduce((sum, entry) => sum + entry.subItems.length, 0),
  'Default deck has one generated card per Card Scope sub-item'
);

const firstCatalog = CARD_SCOPE_CATALOG[0];
const firstCategoryId = firstCatalog.family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const firstCardId = `${firstCatalog.role}:${firstCatalog.subItems[0].key}`;
assert(defaultDeck.cards[firstCardId], 'Default generated card id uses role and sub-item');
assertEqual(defaultDeck.cards[firstCardId].categoryId, firstCategoryId, 'Default card belongs to generated category');
assertEqual(defaultDeck.cards[firstCardId].kind, 'generated', 'Default cards are generated');
assertEqual(defaultDeck.cards[firstCardId].builtinRoleId, firstCatalog.role, 'Default generated card keeps role id');
assertDeepEqual(defaultDeck.cards[firstCardId].selectedSubItems, [firstCatalog.subItems[0].key], 'Default generated card keeps selected sub-item');

const draft = {
  id: 'card-1',
  categoryId: 'cat-1',
  name: NEW_CARD_NAME,
  description: '',
  promptText: 'Keep replies grounded in the immediate scene.',
  enabled: true,
  kind: 'authored'
};
assertEqual(getDeckCardStatus(draft).runnable, false, 'New Card with prompt remains draft');
assertEqual(getDeckCardStatus(draft).reason, 'draft-name', 'draft reason names default title');
assertEqual(getDeckCardStatus({ ...draft, name: 'Scene Anchor', promptText: '' }).reason, 'needs-prompt', 'empty prompt is not runnable');
assertEqual(getDeckCardStatus({ ...draft, name: 'Scene Anchor', promptText: 'Keep scene grounded.', enabled: false }).reason, 'disabled', 'disabled card is not runnable');
assertEqual(getDeckCardStatus({ ...draft, name: 'Scene Anchor', promptText: 'Keep scene grounded.' }).runnable, true, 'named card with prompt is runnable');

const customDeck = normalizeCustomDeck({
  id: 'My Deck!',
  name: '  My   Deck  ',
  readonly: true,
  bundled: true,
  categories: {
    catA: { id: 'catA', name: '  Category A  ', description: 'A category.' },
    dangling: { id: 'dangling', name: '' }
  },
  categoryOrder: ['missing', 'catA'],
  cards: {
    cardA: {
      id: 'cardA',
      categoryId: 'catA',
      name: 'Scene Anchor',
      description: 'UI-only note.',
      promptText: 'Keep the reply in the established scene.',
      enabled: true,
      kind: 'authored'
    },
    cardDangling: {
      id: 'cardDangling',
      categoryId: 'missing',
      name: 'Moved Card',
      promptText: 'Track the unresolved question.',
      enabled: true
    }
  },
  cardOrderByCategory: {
    catA: ['missing-card', 'cardA']
  }
}, 'fallback-id', new Set(['default']));
assertEqual(customDeck.id, 'my-deck', 'custom deck id normalized');
assertEqual(customDeck.name, 'My Deck', 'custom deck name compacted');
assertEqual(customDeck.readonly, false, 'custom deck cannot stay read-only');
assertEqual(customDeck.bundled, false, 'custom deck cannot stay bundled');
assertDeepEqual(customDeck.categoryOrder, ['cata'], 'custom deck category order drops dangling categories');
assertEqual(customDeck.cards.carda.categoryId, 'cata', 'card category id normalized');
assertEqual(customDeck.cards.carddangling.categoryId, 'cata', 'dangling card moves to fallback category');
assertDeepEqual(customDeck.cardOrderByCategory.cata, ['carda', 'carddangling'], 'card order drops dangling cards and appends missing real cards');

const normalizedDecks = normalizeCardDeckSettings({
  activeCardDeckId: customDeck.id,
  customCardDecks: {
    [customDeck.id]: customDeck
  }
});
assertEqual(normalizedDecks.version, CARD_DECK_SETTINGS_VERSION, 'card deck settings version is 1');
assertEqual(normalizedDecks.activeCardDeckId, customDeck.id, 'active custom deck preserved');
assertEqual(normalizeCardDeckSettings({ activeCardDeckId: 'missing', customCardDecks: {} }).activeCardDeckId, DEFAULT_CARD_DECK_ID, 'missing active deck falls back to Default');

assertEqual(duplicateDeckName('My Deck', { a: { name: 'My Deck' }, b: { name: 'My Deck Copy' } }), 'My Deck Copy 2', 'duplicate deck names increment');
assertEqual(duplicateCardName('Scene Anchor Copy', [{ name: 'Scene Anchor' }, { name: 'Scene Anchor Copy' }]), 'Scene Anchor Copy 2', 'duplicate card names avoid Copy Copy');
const warningDeck = {
  cards: {
    one: { id: 'one', name: 'Same', promptText: 'Keep scene grounded.', enabled: true, kind: 'authored' },
    two: { id: 'two', name: 'Same', promptText: 'Track unresolved question.', enabled: true, kind: 'authored' }
  }
};
assertEqual(cardNameWarning(warningDeck.cards.one, warningDeck), 'duplicate-card-name', 'duplicate runnable card names warn');

const exported = serializeCustomCardDecksForExport({ cardDecks: { customCardDecks: { [customDeck.id]: customDeck } } });
assertEqual(exported.version, CARD_DECK_SETTINGS_VERSION, 'export shape carries deck version');
assert(exported.decks[customDeck.id], 'custom deck exports');
assertEqual(exported.decks[DEFAULT_CARD_DECK_ID], undefined, 'Default deck is not exported as user-owned data');
JSON.parse(JSON.stringify(exported));

const legacyScope = defaultCardScope();
legacyScope.families['Open Threads'].enabled = false;
for (const key of Object.keys(legacyScope.families['Open Threads'].subItems)) {
  legacyScope.families['Open Threads'].subItems[key] = false;
}
const migrated = normalizeSettings({ cardScope: legacyScope });
assertEqual(migrated.cardScope, undefined, 'legacy cardScope removed from normalized settings');
assertEqual(migrated.cardDecks.version, CARD_DECK_SETTINGS_VERSION, 'settings normalize cardDecks version');
assertEqual(migrated.cardDecks.activeCardDeckId, DEFAULT_CARD_DECK_ID, 'settings default active deck is Default');
assert(migrated.cardDecks.defaultEnabledState, 'legacy default enabled state retained for one-time migration');

const createdDecks = createCustomCardDeck({}, { name: 'Story Rules' });
assertEqual(createdDecks.activeCardDeckId.startsWith('deck-'), true, 'creating a custom deck selects it');
assertEqual(Object.values(createdDecks.customCardDecks)[0].categoryOrder[0], 'general', 'new custom deck starts with General category');

const duplicatedDefault = duplicateCardDeck({ cardDecks: createdDecks }, DEFAULT_CARD_DECK_ID);
const duplicatedDeck = duplicatedDefault.customCardDecks[duplicatedDefault.activeCardDeckId];
assertEqual(duplicatedDeck.name, 'Default Copy', 'duplicating Default creates an editable copy');
assertEqual(duplicatedDeck.readonly, false, 'duplicated bundled deck is editable');
assertEqual(Object.keys(duplicatedDeck.cards).length, CARD_SCOPE_CATALOG.reduce((sum, entry) => sum + entry.subItems.length, 0), 'duplicated Default retains bundled cards');

const withDraft = createDraftCard(duplicatedDeck, duplicatedDeck.categoryOrder[0]);
const draftCard = Object.values(withDraft.cards).find((card) => card.name === NEW_CARD_NAME);
assertEqual(getDeckCardStatus(draftCard).reason, 'draft-name', 'new draft card does not run until named');
assert(withDraft.cardOrderByCategory[draftCard.categoryId].includes(draftCard.id), 'draft card is ordered in its category');

const withCategory = createCategory(withDraft, { name: 'Pressure', description: 'Scene pressure cards.' });
const pressureCategory = Object.values(withCategory.categories).find((entry) => entry.name === 'Pressure');
assert(pressureCategory, 'category can be created');
assertEqual(withCategory.categoryOrder.at(-1), pressureCategory.id, 'created category appends to order');
const firstExistingCategoryId = withCategory.categoryOrder.find((id) => id !== pressureCategory.id);
const reorderedCategories = reorderCategories(withCategory, pressureCategory.id, firstExistingCategoryId);
assertEqual(reorderedCategories.categoryOrder[0], pressureCategory.id, 'category reorder moves category before target');

const duplicatedCardDeck = duplicateCard(reorderedCategories, draftCard.id);
const duplicatedCard = Object.values(duplicatedCardDeck.cards).find((card) => card.id !== draftCard.id && card.name.startsWith(NEW_CARD_NAME));
assert(duplicatedCard, 'card can be duplicated');
assert(duplicatedCardDeck.cardOrderByCategory[draftCard.categoryId].includes(duplicatedCard.id), 'duplicated card stays in source category order');

const movedCardDeck = moveCard(duplicatedCardDeck, duplicatedCard.id, pressureCategory.id, 0);
assertEqual(movedCardDeck.cards[duplicatedCard.id].categoryId, pressureCategory.id, 'card move updates category id');
assertEqual(movedCardDeck.cardOrderByCategory[pressureCategory.id][0], duplicatedCard.id, 'card move inserts at requested category position');

const reorderedCardsDeck = reorderCards(movedCardDeck, draftCard.categoryId, [draftCard.id]);
assertEqual(reorderedCardsDeck.cardOrderByCategory[draftCard.categoryId][0], draftCard.id, 'card reorder moves explicit card first');

const withoutCard = deleteCard(reorderedCardsDeck, draftCard.id);
assertEqual(withoutCard.cards[draftCard.id], undefined, 'deleteCard removes card');
assert(!withoutCard.cardOrderByCategory[draftCard.categoryId].includes(draftCard.id), 'deleteCard removes card from order');

const movedFromDeletedCategory = deleteCategory(withoutCard, pressureCategory.id);
assertEqual(movedFromDeletedCategory.cards[duplicatedCard.id].categoryId, firstExistingCategoryId, 'deleteCategory preserves legacy fallback move helper semantics');

const withoutCategory = deleteCategoryAndCards(withoutCard, pressureCategory.id);
assertEqual(withoutCategory.categories[pressureCategory.id], undefined, 'deleteCategory removes category');
assertEqual(withoutCategory.cards[duplicatedCard.id], undefined, 'deleteCategoryAndCards removes cards owned by the deleted category');
assert(!Object.values(withoutCategory.cardOrderByCategory || {}).some((order) => order.includes(duplicatedCard.id)), 'deleteCategoryAndCards removes deleted cards from all category orders');

const deleted = deleteCustomCardDeck({ cardDecks: duplicatedDefault }, duplicatedDefault.activeCardDeckId);
assertEqual(deleted.activeCardDeckId, DEFAULT_CARD_DECK_ID, 'deleting active custom deck falls back to Default');
assertEqual(deleted.customCardDecks[duplicatedDefault.activeCardDeckId], undefined, 'delete removes custom deck');

console.log('[pass] card-decks');
