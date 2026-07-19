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
  togglePostProcessCategory,
  togglePostProcessCard,
  normalizePostProcessDeck,
  normalizePostProcessDeckSettings,
  getActivePostProcessDeck,
  orderedRunnablePostProcessCategories
} from '../../src/post-process-decks.mjs';
import { assert, assertDeepEqual as deepEqual, assertEqual as equal } from '../../tests/helpers/assert.mjs';

const now = '2026-07-18T00:00:00.000Z';
const starter = createStarterPostProcessDeck({ now });

equal(starter.id, STARTER_POST_PROCESS_DECK_ID, 'starter id is stable');
equal(starter.name, 'Starter Post-process Deck', 'starter name is approved');
deepEqual(starter.categoryOrder, ['natural-prose', 'follow-through'], 'starter category order is approved');
deepEqual(starter.cardOrderByCategory['natural-prose'], ['cut-echoes', 'natural-diction', 'land-the-ending'], 'Natural Prose card order is approved');
deepEqual(starter.cardOrderByCategory['follow-through'], ['act-on-the-threat', 'close-the-distance', 'complete-the-move'], 'Follow Through card order is approved');
equal(Object.keys(starter.cards).length, 6, 'starter has exactly six cards');
assert(starter.cards['natural-diction'].promptText.includes('literal robot or android'), 'Natural Diction preserves the exact robot/android exception');
equal(starter.cards['natural-diction'].promptText, `Review dialogue and character-facing narration for over-technical or pseudo-analytical diction such as “assessing variables,” “recalibrating,” “data point,” “optimal,” “inefficient,” “statistically,” “physiologically,” “strategically,” “tactically,” and “clinical precision.”\n\nFor non-robotic characters, rewrite those expressions into direct, idiomatic phrasing that matches each character's established voice. Do not use technical language as shorthand for intelligence, emotional distance, dominance, or competence.\n\nPreserve this register only when the speaker is a literal robot or android whose canonical voice genuinely uses it. Preserve the intended meaning and do not flatten distinct character voices.`, 'Natural Diction prompt is canonical');
assert(starter.bundled && starter.readonly, 'starter is bundled and read-only');
assert(Object.values(starter.categories).every((category) => category.enabled === true), 'starter categories default On');
assert(Object.values(starter.cards).every((card) => card.enabled === true), 'starter cards default On');

const mutatedStarter = createStarterPostProcessDeck({ now });
mutatedStarter.categories['natural-prose'].name = 'Changed';
equal(createStarterPostProcessDeck({ now }).categories['natural-prose'].name, 'Natural Prose', 'starter data is deeply cloned');

let settings = createCustomPostProcessDeck({}, { name: '  Revision   Rules  ', now });
const customId = settings.activeDeckId;
equal(settings.customDecks[customId].name, 'Revision Rules', 'create custom deck normalizes name');
settings = duplicatePostProcessDeck(settings, customId, { now });
const duplicatedId = settings.activeDeckId;
assert(settings.customDecks[duplicatedId] && !settings.customDecks[duplicatedId].readonly, 'duplicate creates an editable custom deck');
settings = deleteCustomPostProcessDeck(settings, duplicatedId);
equal(settings.activeDeckId, STARTER_POST_PROCESS_DECK_ID, 'deleting active custom deck selects starter');
assert(!settings.customDecks[duplicatedId], 'custom deck delete removes deck');

let deck = settings.customDecks[customId];
deck = createPostProcessCategory(deck, { name: 'Finish', description: 'Complete the response.', now });
const finishId = deck.categoryOrder.at(-1);
equal(deck.categories[finishId].enabled, true, 'new category defaults On');
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
deck = togglePostProcessCategory(deck, secondId, false, { now });
equal(deck.categories[secondId].enabled, false, 'category toggle is binary Off');
equal(deck.cards[copyId].enabled, false, 'category Off preserves child saved state');
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
    'off-category': { id: 'off-category', categoryId: 'first', name: 'Off category', promptText: 'No', enabled: true }
  }
}, 'runnable', { now });
runnableDeck.categories.first.enabled = false;
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
const active = getActivePostProcessDeck({ ...settings, activeDeckId: customId });
active.name = 'Mutated';
assert(getActivePostProcessDeck({ ...settings, activeDeckId: customId }).name !== 'Mutated', 'custom deck reads are deeply cloned');

console.log('[pass] post-process-decks');
