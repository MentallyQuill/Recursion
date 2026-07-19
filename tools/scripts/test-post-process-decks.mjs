import {
  POST_PROCESS_DECK_SETTINGS_VERSION,
  STARTER_POST_PROCESS_DECK_ID,
  createStarterPostProcessDeck,
  createCustomPostProcessDeck,
  duplicatePostProcessDeck,
  deleteCustomPostProcessDeck,
  createPostProcessCategory,
  updatePostProcessCategory,
  deletePostProcessCategory,
  reorderPostProcessCategories,
  createPostProcessCard,
  updatePostProcessCard,
  duplicatePostProcessCard,
  deletePostProcessCard,
  movePostProcessCard,
  reorderPostProcessCards,
  togglePostProcessCard,
  normalizePostProcessDeck,
  normalizePostProcessDeckSettings,
  getActivePostProcessDeck,
  updateActivePostProcessDeckState,
  orderedRunnablePostProcessCategories,
  postProcessCategoryExpanded,
  setPostProcessCategoryExpanded,
  setAllPostProcessCardsEnabled
} from '../../src/post-process-decks.mjs';
import { assert, assertDeepEqual as deepEqual, assertEqual as equal } from '../../tests/helpers/assert.mjs';

const now = '2026-07-18T00:00:00.000Z';
const starter = createStarterPostProcessDeck({ now });

equal(POST_PROCESS_DECK_SETTINGS_VERSION, 3, 'expanded starter deck uses the V3 Post-process deck contract');
equal(starter.id, STARTER_POST_PROCESS_DECK_ID, 'starter id is stable');
equal(starter.name, 'Starter Post-process Deck', 'starter name is approved');
deepEqual(
  starter.categoryOrder,
  ['natural-prose', 'follow-through', 'concrete-meaning', 'character-specific-relationships'],
  'starter category order is approved'
);
deepEqual(starter.cardOrderByCategory['natural-prose'], ['cut-echoes', 'natural-diction', 'land-the-ending'], 'Natural Prose card order is approved');
deepEqual(starter.cardOrderByCategory['follow-through'], ['act-on-the-threat', 'close-the-distance', 'complete-the-move'], 'Follow Through card order is approved');
deepEqual(starter.cardOrderByCategory['concrete-meaning'], ['strip-false-weight'], 'Concrete Meaning card order is approved');
deepEqual(
  starter.cardOrderByCategory['character-specific-relationships'],
  ['earn-the-attraction', 'ground-the-deflection'],
  'Character-Specific Relationships card order is approved'
);
equal(Object.keys(starter.cards).length, 9, 'starter has exactly nine cards');
assert(starter.cards['natural-diction'].promptText.includes('literal robot or android'), 'Natural Diction preserves the exact robot/android exception');
equal(starter.cards['natural-diction'].promptText, `Review dialogue and character-facing narration for over-technical or pseudo-analytical diction such as “assessing variables,” “recalibrating,” “data point,” “optimal,” “inefficient,” “statistically,” “physiologically,” “strategically,” “tactically,” and “clinical precision.”\n\nFor non-robotic characters, rewrite those expressions into direct, idiomatic phrasing that matches each character's established voice. Do not use technical language as shorthand for intelligence, emotional distance, dominance, or competence.\n\nPreserve this register only when the speaker is a literal robot or android whose canonical voice genuinely uses it. Preserve the intended meaning and do not flatten distinct character voices.`, 'Natural Diction prompt is canonical');
assert(starter.bundled && starter.readonly, 'starter is bundled and read-only');
deepEqual(
  Object.fromEntries(Object.values(starter.categories).map((category) => [category.id, Object.hasOwn(category, 'enabled')])),
  {
    'natural-prose': false,
    'follow-through': false,
    'concrete-meaning': false,
    'character-specific-relationships': false
  },
  'Post-process categories do not store independent enabled state'
);
deepEqual(
  Object.fromEntries(Object.values(starter.cards).map((card) => [card.id, card.enabled])),
  {
    'cut-echoes': true,
    'natural-diction': true,
    'land-the-ending': true,
    'act-on-the-threat': true,
    'close-the-distance': true,
    'complete-the-move': true,
    'strip-false-weight': false,
    'earn-the-attraction': false,
    'ground-the-deflection': false
  },
  'original starter cards default On and optional expansion cards default Off'
);
deepEqual(
  orderedRunnablePostProcessCategories(starter).map((category) => category.id),
  ['natural-prose', 'follow-through'],
  'only the original two starter categories participate by default'
);
const starterWithConcreteMeaning = togglePostProcessCard(starter, 'strip-false-weight', true, { now });
deepEqual(
  orderedRunnablePostProcessCategories(starterWithConcreteMeaning).map((category) => category.id),
  ['natural-prose', 'follow-through', 'concrete-meaning'],
  'enabling any one card automatically makes its category participate'
);
assert(
  starter.cards['strip-false-weight'].promptText.includes('Do not substitute one ornamental phrase for another'),
  'Strip False Weight repairs missing narrative work instead of performing word replacement'
);
assert(
  starter.cards['earn-the-attraction'].promptText.includes('Do not merely replace stock words with softer synonyms'),
  'Earn the Attraction repairs relationship characterization instead of performing word replacement'
);
assert(
  starter.cards['ground-the-deflection'].promptText.includes('Do not replace one stock deflection with another'),
  'Ground the Deflection repairs defensive characterization instead of performing word replacement'
);

const normalizedStarterStates = normalizePostProcessDeckSettings({
  activeDeckId: STARTER_POST_PROCESS_DECK_ID,
  starterCategoryStates: {
    'natural-prose': false,
    missing: false
  },
  starterCardStates: {
    'cut-echoes': false,
    missing: false
  }
}, { now });
equal(normalizedStarterStates.starterCategoryStates, undefined, 'independent starter category state is removed from V3');
deepEqual(normalizedStarterStates.starterCardStates, { 'cut-echoes': false }, 'starter card overrides keep only known cards');
const overlaidStarter = getActivePostProcessDeck(normalizedStarterStates, { now });
equal(overlaidStarter.cards['cut-echoes'].enabled, false, 'starter card overrides apply to the active deck');
assert(overlaidStarter.readonly, 'starter state overrides do not make bundled content structurally editable');
equal(
  postProcessCategoryExpanded(normalizedStarterStates, STARTER_POST_PROCESS_DECK_ID, 'natural-prose'),
  true,
  'Post-process categories default expanded when no operator override exists'
);
const collapsedStarterSettings = setPostProcessCategoryExpanded(
  normalizedStarterStates,
  STARTER_POST_PROCESS_DECK_ID,
  'natural-prose',
  false,
  { now }
);
equal(
  postProcessCategoryExpanded(
    normalizePostProcessDeckSettings(JSON.parse(JSON.stringify(collapsedStarterSettings)), { now }),
    STARTER_POST_PROCESS_DECK_ID,
    'natural-prose'
  ),
  false,
  'Post-process category collapse survives serialized settings normalization'
);

const starterOff = setAllPostProcessCardsEnabled(
  { activeDeckId: STARTER_POST_PROCESS_DECK_ID, customDecks: {} },
  false,
  { now }
);
assert(Object.values(starterOff.starterCardStates).every((state) => state === false), 'starter bulk Off persists every card state');
assert(Object.values(getActivePostProcessDeck(starterOff, { now }).cards).every((card) => card.enabled === false), 'starter bulk Off disables every card');
deepEqual(
  orderedRunnablePostProcessCategories(getActivePostProcessDeck(starterOff, { now })),
  [],
  'disabling every card automatically leaves every category inactive'
);
const starterOn = setAllPostProcessCardsEnabled(starterOff, true, { now });
assert(Object.values(starterOn.starterCardStates).every((state) => state === true), 'starter bulk On persists every card state');
assert(Object.values(getActivePostProcessDeck(starterOn, { now }).cards).every((card) => card.enabled === true), 'starter bulk On enables every card');

const mutatedStarter = createStarterPostProcessDeck({ now });
mutatedStarter.categories['natural-prose'].name = 'Changed';
equal(createStarterPostProcessDeck({ now }).categories['natural-prose'].name, 'Natural Prose', 'starter data is deeply cloned');

const starterWithOptionalCardSettings = updateActivePostProcessDeckState(
  {},
  togglePostProcessCard(createStarterPostProcessDeck({ now }), 'strip-false-weight', true, { now }),
  { now }
);
const duplicatedStarterSettings = duplicatePostProcessDeck(
  starterWithOptionalCardSettings,
  STARTER_POST_PROCESS_DECK_ID,
  { now }
);
const duplicatedStarter = duplicatedStarterSettings.customDecks[duplicatedStarterSettings.activeDeckId];
equal(
  Object.values(duplicatedStarter.cards).find((card) => card.name === 'Strip False Weight')?.enabled,
  true,
  'duplicating the starter preserves current card-state overlays'
);

let settings = createCustomPostProcessDeck({}, { name: '  Revision   Rules  ', now });
const customId = settings.activeDeckId;
equal(settings.customDecks[customId].name, 'Revision Rules', 'create custom deck normalizes name');
settings = setPostProcessCategoryExpanded(settings, customId, 'general', false, { now });
settings = duplicatePostProcessDeck(settings, customId, { now });
const duplicatedId = settings.activeDeckId;
assert(settings.customDecks[duplicatedId] && !settings.customDecks[duplicatedId].readonly, 'duplicate creates an editable custom deck');
equal(
  postProcessCategoryExpanded(settings, duplicatedId, settings.customDecks[duplicatedId].categoryOrder[0]),
  false,
  'duplicated Post-process decks inherit source category expansion under remapped ids'
);
settings = deleteCustomPostProcessDeck(settings, duplicatedId);
equal(settings.activeDeckId, STARTER_POST_PROCESS_DECK_ID, 'deleting active custom deck selects starter');
assert(!settings.customDecks[duplicatedId], 'custom deck delete removes deck');
equal(settings.categoryExpansion[duplicatedId], undefined, 'deleting a Post-process deck prunes its category expansion');

let deck = settings.customDecks[customId];
deck = createPostProcessCategory(deck, { name: 'Finish', description: 'Complete the response.', now });
const finishId = deck.categoryOrder.at(-1);
equal(Object.hasOwn(deck.categories[finishId], 'enabled'), false, 'new categories do not store enabled state');
deck = updatePostProcessCategory(deck, finishId, { name: '  Finish Strong  ', description: '  Land it.  ', now });
equal(deck.categories[finishId].name, 'Finish Strong', 'category update normalizes name');
deck = reorderPostProcessCategories(deck, finishId, 'general');
equal(deck.categoryOrder[0], finishId, 'category reorder respects requested order');
deck = deletePostProcessCategory(deck, finishId, { now });
assert(!deck.categories[finishId], 'category delete removes category');

deck = createPostProcessCard(deck, 'general', { name: 'First', promptText: 'First prompt.', now });
const firstId = deck.cardOrderByCategory.general.at(-1);
equal(deck.cards[firstId].enabled, true, 'new card defaults On');
deck = updatePostProcessCard(deck, firstId, { name: ' First Card ', promptText: ' First prompt. ', now });
equal(deck.cards[firstId].name, 'First Card', 'card update normalizes name');
deck = duplicatePostProcessCard(deck, firstId, { now });
const copyId = deck.cardOrderByCategory.general.at(-1);
assert(deck.cards[copyId].name.startsWith('First Card Copy'), 'card duplicate uses a unique copy name');
deck = createPostProcessCategory(deck, { name: 'Second', now });
const secondId = deck.categoryOrder.at(-1);
deck = movePostProcessCard(deck, copyId, secondId, 0, { now });
equal(deck.cards[copyId].categoryId, secondId, 'card move updates category');
deck = reorderPostProcessCards(deck, secondId, [copyId]);
equal(deck.cardOrderByCategory[secondId][0], copyId, 'card reorder respects requested order');
deck = togglePostProcessCard(deck, copyId, false, { now });
equal(deck.cards[copyId].enabled, false, 'card toggle is binary Off');
deck = deletePostProcessCard(deck, copyId, { now });
assert(!deck.cards[copyId], 'card delete removes card');

const runnableDeck = normalizePostProcessDeck({
  id: 'runnable', name: 'Runnable', categoryOrder: ['second', 'first'],
  categories: { first: { id: 'first', name: 'First', enabled: true }, second: { id: 'second', name: 'Second', enabled: true } },
  cardOrderByCategory: { second: ['disabled', 'valid'], first: ['blank-name', 'blank-prompt', 'off-category'] },
  cards: {
    valid: { id: 'valid', categoryId: 'second', name: 'Valid', promptText: 'Run', enabled: true },
    disabled: { id: 'disabled', categoryId: 'second', name: 'Disabled', promptText: 'No', enabled: false },
    'blank-name': { id: 'blank-name', categoryId: 'first', name: ' ', promptText: 'No', enabled: true },
    'blank-prompt': { id: 'blank-prompt', categoryId: 'first', name: 'Blank', promptText: ' ', enabled: true },
    'off-category': { id: 'off-category', categoryId: 'first', name: 'Off card', promptText: 'No', enabled: false }
  }
}, 'runnable', { now });
deepEqual(orderedRunnablePostProcessCategories(runnableDeck).map((category) => [category.id, category.cards.map((card) => card.id)]), [['second', ['valid']]], 'runnable selection obeys deck order and binary states');

const normalized = normalizePostProcessDeckSettings({
  version: 999,
  activeDeckId: 'missing',
  enhancements: { enabled: true },
  customDecks: { 'Bad Deck!': { id: 'Bad Deck!', name: ' Bad   Deck ', readonly: true, bundled: true, categories: {}, cards: {} } }
}, { now });
equal(normalized.version, POST_PROCESS_DECK_SETTINGS_VERSION, 'settings normalize to V1');
equal(normalized.activeDeckId, STARTER_POST_PROCESS_DECK_ID, 'unknown active deck falls back to starter');
assert(!('enhancements' in normalized), 'old enhancement settings are ignored');
deepEqual(
  normalizePostProcessDeckSettings({
    activeDeckId: customId,
    customDecks: { [customId]: settings.customDecks[customId] },
    categoryExpansion: {
      [customId]: { general: false, missing: false },
      missingDeck: { missing: false }
    }
  }, { now }).categoryExpansion,
  { [customId]: { general: false } },
  'Post-process normalization prunes deleted category and deck expansion entries'
);
const active = getActivePostProcessDeck({ ...settings, activeDeckId: customId });
active.name = 'Mutated';
assert(getActivePostProcessDeck({ ...settings, activeDeckId: customId }).name !== 'Mutated', 'custom deck reads are deeply cloned');

console.log('[pass] post-process-decks');
