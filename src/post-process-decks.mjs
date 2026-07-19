export const POST_PROCESS_DECK_SETTINGS_VERSION = 1;
export const STARTER_POST_PROCESS_DECK_ID = 'starter-post-process';

const STARTER_CATEGORIES = [
  ['natural-prose', 'Natural Prose', ''],
  ['follow-through', 'Follow Through', '']
];

const STARTER_CARDS = [
  ['cut-echoes', 'natural-prose', 'Cut Echoes', 'Remove parroting, redundant restatement, and repeated dialogue beats.', 'Review the draft for echoed information. Remove narration that merely restates dialogue, dialogue that paraphrases the immediately preceding line, repeated emotional labels, and repeated beats that do not change the scene. Preserve deliberate repetition used for rhythm, characterization, escalation, or clarity. Keep the strongest expression of each idea and preserve all consequential information.'],
  ['natural-diction', 'natural-prose', 'Natural Diction', 'Replace unnecessary clinical, tactical, statistical, or optimization-heavy language with direct character-appropriate wording. Preserve that register only for literal robots or androids whose canonical voice uses it.', 'Review dialogue and character-facing narration for over-technical or pseudo-analytical diction such as “assessing variables,” “recalibrating,” “data point,” “optimal,” “inefficient,” “statistically,” “physiologically,” “strategically,” “tactically,” and “clinical precision.”\n\nFor non-robotic characters, rewrite those expressions into direct, idiomatic phrasing that matches each character\'s established voice. Do not use technical language as shorthand for intelligence, emotional distance, dominance, or competence.\n\nPreserve this register only when the speaker is a literal robot or android whose canonical voice genuinely uses it. Preserve the intended meaning and do not flatten distinct character voices.'],
  ['land-the-ending', 'natural-prose', 'Land the Ending', 'End on consequential movement instead of canned questions or fake choices.', 'Review the ending. Remove canned questions, fake either-or choices, summary conclusions, and endings that hand responsibility back to the user without meaningful movement. End on the strongest concrete beat already supported by the scene: an action, consequence, revelation, sensory change, or decisive line. Do not invent a new plot turn solely to avoid a question.'],
  ['act-on-the-threat', 'follow-through', 'Act on the Threat', 'Convert repeated immediate threats into supported action or consequence.', 'Do not invent intent, override consent, force unsupported escalation, or take control of the user\'s character. Act only on intent, reciprocity, capability, and immediacy already established by the draft and frozen context.\n\nWhen a character\'s immediate violent intent is already established and the draft repeats warnings, threats, preparations, or chances to back down, replace the repetition with the supported action or its immediate consequence. Preserve hesitation when it is itself meaningful characterization or when action is not yet supported.'],
  ['close-the-distance', 'follow-through', 'Close the Distance', 'Complete supported reciprocal physical or romantic contact.', 'Do not invent intent, override consent, force unsupported escalation, or take control of the user\'s character. Act only on intent, reciprocity, capability, and immediacy already established by the draft and frozen context.\n\nWhen reciprocal physical or romantic intent is already established, replace repeated hovering, near-touching, almost-kissing, interrupted-contact, or “giving one last chance” loops with the appropriate supported contact. Preserve boundaries, consent, character voice, and the scene\'s established intensity.'],
  ['complete-the-move', 'follow-through', 'Complete the Move', 'Carry repeated preparation or implication into the concrete next step.', 'Do not invent intent, override consent, force unsupported escalation, or take control of the user\'s character. Act only on intent, reciprocity, capability, and immediacy already established by the draft and frozen context.\n\nWhen a character repeatedly prepares, hints, reaches, starts, or almost acts, carry the established intention into the concrete next step. Do not manufacture a new intention or skip a necessary decision. Prefer an observable action or consequence over another statement of intent.']
];

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));
const nowIso = () => new Date().toISOString();
export const normalizePostProcessName = (value) => String(value || '').trim().replace(/\s+/g, ' ');
export const normalizePostProcessId = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');

function idOrder(order, knownIds) {
  const known = new Set(knownIds);
  const result = [];
  for (const raw of Array.isArray(order) ? order : []) {
    const id = normalizePostProcessId(raw);
    if (known.has(id) && !result.includes(id)) result.push(id);
  }
  for (const id of knownIds) if (!result.includes(id)) result.push(id);
  return result;
}

function uniqueName(name, names, fallback) {
  const base = normalizePostProcessName(name) || fallback;
  const taken = new Set(names.map(normalizePostProcessName).map((item) => item.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let index = 1;
  while (taken.has(`${base}${index === 1 ? ' Copy' : ` Copy ${index}`}`.toLowerCase())) index += 1;
  return `${base}${index === 1 ? ' Copy' : ` Copy ${index}`}`;
}

function generatedId(prefix, existing) {
  let index = Object.keys(existing || {}).length + 1;
  let id = normalizePostProcessId(`${prefix}-${Date.now()}-${index}`);
  while (existing[id]) id = normalizePostProcessId(`${prefix}-${Date.now()}-${++index}`);
  return id;
}

function normalizeCategories(raw, now) {
  const categories = {};
  for (const [fallback, value] of Object.entries(isObject(raw) ? raw : {})) {
    const id = normalizePostProcessId(value?.id || fallback);
    const name = normalizePostProcessName(value?.name);
    if (!id || !name) continue;
    categories[id] = { id, name, description: String(value?.description || '').trim(), enabled: value?.enabled !== false, createdAt: String(value?.createdAt || now), updatedAt: String(value?.updatedAt || now) };
  }
  if (!Object.keys(categories).length) categories.general = { id: 'general', name: 'General', description: '', enabled: true, createdAt: now, updatedAt: now };
  return categories;
}

function normalizeCards(raw, categories, now) {
  const cards = {};
  const fallbackCategoryId = Object.keys(categories)[0];
  for (const [fallback, value] of Object.entries(isObject(raw) ? raw : {})) {
    const id = normalizePostProcessId(value?.id || fallback);
    if (!id) continue;
    const categoryId = categories[normalizePostProcessId(value?.categoryId)] ? normalizePostProcessId(value.categoryId) : fallbackCategoryId;
    cards[id] = { id, categoryId, name: normalizePostProcessName(value?.name), description: String(value?.description || '').trim(), promptText: String(value?.promptText || '').trim(), enabled: value?.enabled !== false, createdAt: String(value?.createdAt || now), updatedAt: String(value?.updatedAt || now) };
  }
  return cards;
}

function normalizeCardOrder(raw, cards, categoryOrder) {
  const result = Object.fromEntries(categoryOrder.map((id) => [id, []]));
  const seen = new Set();
  for (const [categoryRaw, values] of Object.entries(isObject(raw) ? raw : {})) {
    const categoryId = normalizePostProcessId(categoryRaw);
    if (!result[categoryId]) continue;
    for (const cardRaw of Array.isArray(values) ? values : []) {
      const id = normalizePostProcessId(cardRaw);
      if (cards[id]?.categoryId === categoryId && !seen.has(id)) { result[categoryId].push(id); seen.add(id); }
    }
  }
  for (const card of Object.values(cards)) if (!seen.has(card.id)) result[card.categoryId].push(card.id);
  return result;
}

export function createStarterPostProcessDeck({ now = nowIso() } = {}) {
  const categoryOrder = STARTER_CATEGORIES.map(([id]) => id);
  const categories = Object.fromEntries(STARTER_CATEGORIES.map(([id, name, description]) => [id, { id, name, description, enabled: true, createdAt: now, updatedAt: now }]));
  const cards = Object.fromEntries(STARTER_CARDS.map(([id, categoryId, name, description, promptText]) => [id, { id, categoryId, name, description, promptText, enabled: true, createdAt: now, updatedAt: now }]));
  const cardOrderByCategory = Object.fromEntries(categoryOrder.map((categoryId) => [categoryId, STARTER_CARDS.filter(([, cardCategoryId]) => cardCategoryId === categoryId).map(([id]) => id)]));
  return { id: STARTER_POST_PROCESS_DECK_ID, name: 'Starter Post-process Deck', description: 'Bundled Recursion Post-process Deck.', bundled: true, readonly: true, categoryOrder, categories, cardOrderByCategory, cards, createdAt: now, updatedAt: now };
}

export function normalizePostProcessDeck(raw, fallbackId = '', { now = nowIso(), existingIds = new Set() } = {}) {
  if (!isObject(raw)) return null;
  const id = normalizePostProcessId(raw.id || fallbackId);
  if (!id || id === STARTER_POST_PROCESS_DECK_ID || existingIds.has(id)) return null;
  const categories = normalizeCategories(raw.categories, now);
  const categoryOrder = idOrder(raw.categoryOrder, Object.keys(categories));
  const cards = normalizeCards(raw.cards, categories, now);
  return { id, name: normalizePostProcessName(raw.name) || 'Custom Deck', description: String(raw.description || '').trim(), bundled: false, readonly: false, categoryOrder, categories, cardOrderByCategory: normalizeCardOrder(raw.cardOrderByCategory, cards, categoryOrder), cards, createdAt: String(raw.createdAt || now), updatedAt: String(raw.updatedAt || now) };
}

export function normalizePostProcessDeckSettings(raw = {}, { now = nowIso() } = {}) {
  const customDecks = {};
  for (const [fallbackId, deck] of Object.entries(isObject(raw?.customDecks) ? raw.customDecks : {})) {
    const normalized = normalizePostProcessDeck(deck, fallbackId, { now, existingIds: new Set(Object.keys(customDecks)) });
    if (normalized) customDecks[normalized.id] = normalized;
  }
  const activeDeckId = normalizePostProcessId(raw?.activeDeckId);
  return { version: POST_PROCESS_DECK_SETTINGS_VERSION, activeDeckId: customDecks[activeDeckId] ? activeDeckId : STARTER_POST_PROCESS_DECK_ID, customDecks };
}

export function getActivePostProcessDeck(settings = {}, { now = nowIso() } = {}) {
  const normalized = normalizePostProcessDeckSettings(settings, { now });
  return clone(normalized.customDecks[normalized.activeDeckId] || createStarterPostProcessDeck({ now }));
}

export function createCustomPostProcessDeck(settings = {}, { name = 'Custom Deck', description = '', now = nowIso() } = {}) {
  const normalized = normalizePostProcessDeckSettings(settings, { now });
  const id = generatedId('post-process', normalized.customDecks);
  const deck = normalizePostProcessDeck({ id, name: uniqueName(name, Object.values(normalized.customDecks).map((entry) => entry.name), 'Custom Deck'), description, categories: { general: { id: 'general', name: 'General', enabled: true } }, categoryOrder: ['general'], cardOrderByCategory: { general: [] }, cards: {}, createdAt: now, updatedAt: now }, id, { now });
  return { ...normalized, activeDeckId: id, customDecks: { ...normalized.customDecks, [id]: deck } };
}

export function duplicatePostProcessDeck(settings = {}, deckId = '', { now = nowIso() } = {}) {
  const normalized = normalizePostProcessDeckSettings(settings, { now });
  const source = normalizePostProcessId(deckId) === STARTER_POST_PROCESS_DECK_ID ? createStarterPostProcessDeck({ now }) : normalized.customDecks[normalizePostProcessId(deckId)];
  if (!source) return normalized;
  const id = generatedId('post-process', normalized.customDecks);
  const categoryIdMap = Object.fromEntries(source.categoryOrder.map((oldId) => [oldId, `${oldId}-${id.split('-').at(-1)}`]));
  const cardIdMap = Object.fromEntries(Object.keys(source.cards).map((oldId) => [oldId, `${oldId}-${id.split('-').at(-1)}`]));
  const categories = Object.fromEntries(Object.values(source.categories).map((category) => { const nextId = categoryIdMap[category.id]; return [nextId, { ...clone(category), id: nextId, createdAt: now, updatedAt: now }]; }));
  const cards = Object.fromEntries(Object.values(source.cards).map((card) => { const nextId = cardIdMap[card.id]; return [nextId, { ...clone(card), id: nextId, categoryId: categoryIdMap[card.categoryId], createdAt: now, updatedAt: now }]; }));
  const deck = normalizePostProcessDeck({ ...clone(source), id, name: uniqueName(source.name, Object.values(normalized.customDecks).map((entry) => entry.name), 'Custom Deck'), bundled: false, readonly: false, categoryOrder: source.categoryOrder.map((oldId) => categoryIdMap[oldId]), categories, cardOrderByCategory: Object.fromEntries(source.categoryOrder.map((oldId) => [categoryIdMap[oldId], (source.cardOrderByCategory[oldId] || []).map((cardId) => cardIdMap[cardId])])), cards, createdAt: now, updatedAt: now }, id, { now });
  return { ...normalized, activeDeckId: id, customDecks: { ...normalized.customDecks, [id]: deck } };
}

export function deleteCustomPostProcessDeck(settings = {}, deckId = '') {
  const normalized = normalizePostProcessDeckSettings(settings);
  const id = normalizePostProcessId(deckId);
  if (!normalized.customDecks[id]) return normalized;
  const customDecks = { ...normalized.customDecks }; delete customDecks[id];
  return { ...normalized, activeDeckId: normalized.activeDeckId === id ? STARTER_POST_PROCESS_DECK_ID : normalized.activeDeckId, customDecks };
}

function editDeck(deck, mutate, now) { const normalized = normalizePostProcessDeck(deck, deck?.id, { now }) || deck; const next = mutate(clone(normalized)); return normalizePostProcessDeck({ ...next, updatedAt: now }, normalized.id, { now }) || normalized; }
export function createPostProcessCategory(deck, { name = 'New Category', description = '', now = nowIso() } = {}) { return editDeck(deck, (next) => { const id = generatedId('category', next.categories); next.categories[id] = { id, name: uniqueName(name, Object.values(next.categories).map((category) => category.name), 'New Category'), description: String(description).trim(), enabled: true, createdAt: now, updatedAt: now }; next.categoryOrder.push(id); next.cardOrderByCategory[id] = []; return next; }, now); }
export function updatePostProcessCategory(deck, categoryId, patch = {}) { const now = patch.now || nowIso(); return editDeck(deck, (next) => { const id = normalizePostProcessId(categoryId); if (!next.categories[id]) return next; next.categories[id] = { ...next.categories[id], name: normalizePostProcessName(patch.name ?? next.categories[id].name) || next.categories[id].name, description: String(patch.description ?? next.categories[id].description).trim(), updatedAt: now }; return next; }, now); }
export function togglePostProcessCategory(deck, categoryId, enabled, { now = nowIso() } = {}) { return editDeck(deck, (next) => { const id = normalizePostProcessId(categoryId); if (next.categories[id]) next.categories[id] = { ...next.categories[id], enabled: enabled !== false, updatedAt: now }; return next; }, now); }
export function reorderPostProcessCategories(deck, movingId, beforeId = '', { now = nowIso() } = {}) { return editDeck(deck, (next) => { const moving = normalizePostProcessId(movingId); const before = normalizePostProcessId(beforeId); if (!next.categories[moving]) return next; const order = next.categoryOrder.filter((id) => id !== moving); order.splice(before && order.includes(before) ? order.indexOf(before) : order.length, 0, moving); next.categoryOrder = order; return next; }, now); }
export function deletePostProcessCategory(deck, categoryId, { now = nowIso() } = {}) { return editDeck(deck, (next) => { const id = normalizePostProcessId(categoryId); if (!next.categories[id] || next.categoryOrder.length <= 1) return next; delete next.categories[id]; delete next.cardOrderByCategory[id]; next.categoryOrder = next.categoryOrder.filter((entry) => entry !== id); for (const cardId of Object.keys(next.cards)) if (next.cards[cardId].categoryId === id) delete next.cards[cardId]; return next; }, now); }
export function createPostProcessCard(deck, categoryId, { name = 'New Card', description = '', promptText = '', now = nowIso() } = {}) { return editDeck(deck, (next) => { const category = normalizePostProcessId(categoryId); if (!next.categories[category]) return next; const id = generatedId('card', next.cards); next.cards[id] = { id, categoryId: category, name: normalizePostProcessName(name), description: String(description).trim(), promptText: String(promptText).trim(), enabled: true, createdAt: now, updatedAt: now }; next.cardOrderByCategory[category].push(id); return next; }, now); }
export function updatePostProcessCard(deck, cardId, patch = {}) { const now = patch.now || nowIso(); return editDeck(deck, (next) => { const id = normalizePostProcessId(cardId); if (!next.cards[id]) return next; next.cards[id] = { ...next.cards[id], name: normalizePostProcessName(patch.name ?? next.cards[id].name), description: String(patch.description ?? next.cards[id].description).trim(), promptText: String(patch.promptText ?? next.cards[id].promptText).trim(), updatedAt: now }; return next; }, now); }
export function togglePostProcessCard(deck, cardId, enabled, { now = nowIso() } = {}) { return editDeck(deck, (next) => { const id = normalizePostProcessId(cardId); if (next.cards[id]) next.cards[id] = { ...next.cards[id], enabled: enabled !== false, updatedAt: now }; return next; }, now); }
export function duplicatePostProcessCard(deck, cardId, { now = nowIso() } = {}) { return editDeck(deck, (next) => { const id = normalizePostProcessId(cardId); const source = next.cards[id]; if (!source) return next; const copyId = generatedId('card', next.cards); next.cards[copyId] = { ...clone(source), id: copyId, name: uniqueName(source.name, Object.values(next.cards).filter((card) => card.categoryId === source.categoryId).map((card) => card.name), 'Card'), createdAt: now, updatedAt: now }; next.cardOrderByCategory[source.categoryId].push(copyId); return next; }, now); }
export function deletePostProcessCard(deck, cardId, { now = nowIso() } = {}) { return editDeck(deck, (next) => { const id = normalizePostProcessId(cardId); const card = next.cards[id]; if (!card) return next; delete next.cards[id]; next.cardOrderByCategory[card.categoryId] = next.cardOrderByCategory[card.categoryId].filter((entry) => entry !== id); return next; }, now); }
export function movePostProcessCard(deck, cardId, categoryId, index = Infinity, { now = nowIso() } = {}) { return editDeck(deck, (next) => { const id = normalizePostProcessId(cardId); const target = normalizePostProcessId(categoryId); const card = next.cards[id]; if (!card || !next.categories[target]) return next; next.cardOrderByCategory[card.categoryId] = next.cardOrderByCategory[card.categoryId].filter((entry) => entry !== id); const order = next.cardOrderByCategory[target]; const at = Number.isFinite(Number(index)) ? Math.max(0, Math.min(order.length, Math.round(Number(index)))) : order.length; order.splice(at, 0, id); next.cards[id] = { ...card, categoryId: target, updatedAt: now }; return next; }, now); }
export function reorderPostProcessCards(deck, categoryId, order = [], { now = nowIso() } = {}) { return editDeck(deck, (next) => { const category = normalizePostProcessId(categoryId); if (!next.categories[category]) return next; const valid = new Set(Object.values(next.cards).filter((card) => card.categoryId === category).map((card) => card.id)); const reordered = []; for (const raw of Array.isArray(order) ? order : []) { const id = normalizePostProcessId(raw); if (valid.has(id) && !reordered.includes(id)) reordered.push(id); } for (const id of next.cardOrderByCategory[category]) if (valid.has(id) && !reordered.includes(id)) reordered.push(id); next.cardOrderByCategory[category] = reordered; return next; }, now); }

export function orderedPostProcessCategories(deck) { const categories = isObject(deck?.categories) ? deck.categories : {}; return idOrder(deck?.categoryOrder, Object.keys(categories)).map((id) => categories[id]); }
export function orderedPostProcessCards(deck, categoryId) { const category = normalizePostProcessId(categoryId); const cards = isObject(deck?.cards) ? deck.cards : {}; const ordered = []; const seen = new Set(); for (const raw of Array.isArray(deck?.cardOrderByCategory?.[category]) ? deck.cardOrderByCategory[category] : []) { const id = normalizePostProcessId(raw); if (cards[id]?.categoryId === category && !seen.has(id)) { ordered.push(cards[id]); seen.add(id); } } for (const card of Object.values(cards)) if (card.categoryId === category && !seen.has(card.id)) ordered.push(card); return ordered; }
export function isRunnablePostProcessCard(card, category) { return category?.enabled !== false && card?.enabled !== false && normalizePostProcessName(card?.name) !== '' && String(card?.promptText || '').trim() !== ''; }
export function orderedRunnablePostProcessCategories(deck) { return orderedPostProcessCategories(deck).map((category) => ({ ...clone(category), cards: orderedPostProcessCards(deck, category.id).filter((card) => isRunnablePostProcessCard(card, category)).map(clone) })).filter((category) => category.enabled !== false && category.cards.length > 0); }
