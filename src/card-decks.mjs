import { CARD_SCOPE_CATALOG, CARD_SCOPE_VERSION } from './card-scope.mjs';

export const DEFAULT_CARD_DECK_ID = 'default';
export const CARD_DECK_SETTINGS_VERSION = 1;
export const NEW_CARD_NAME = 'New Card';
export const CARD_SELECTION_STATES = Object.freeze(['off', 'active', 'priority']);

function nowIso() {
  return new Date().toISOString();
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function category(id, name, description, now) {
  return { id, name, description, createdAt: now, updatedAt: now };
}

function deckIdFromLabel(label) {
  return normalizeId(label).replace(/:/g, '-');
}

function generatedCardId(roleId, subItemKey) {
  return `${roleId}:${subItemKey}`;
}

function generatedCard({
  id,
  categoryId,
  name,
  description,
  promptText,
  builtinFamily,
  builtinRoleId,
  selectedSubItems,
  now
}) {
  return {
    id,
    categoryId,
    name,
    description,
    promptText,
    selectionState: 'active',
    kind: 'generated',
    builtinFamily,
    builtinRoleId,
    selectedSubItems,
    createdAt: now,
    updatedAt: now
  };
}

export function cardSelectionState(card) {
  const state = String(card?.selectionState || '').trim().toLowerCase();
  if (CARD_SELECTION_STATES.includes(state)) return state;
  return card?.enabled === false ? 'off' : 'active';
}

export function nextCardSelectionState(card, mode = 'auto') {
  const current = cardSelectionState(card);
  if (mode === 'manual') return current === 'off' ? 'active' : 'off';
  if (current === 'off') return 'active';
  if (current === 'active') return 'priority';
  return 'off';
}

function normalizedCardSelectionState(raw) {
  return cardSelectionState(raw);
}

export function createDefaultCardDeck({ now = nowIso() } = {}) {
  const categoryOrder = CARD_SCOPE_CATALOG.map((entry) => deckIdFromLabel(entry.family));
  const categories = Object.fromEntries(CARD_SCOPE_CATALOG.map((entry) => {
    const categoryId = deckIdFromLabel(entry.family);
    return [categoryId, category(categoryId, entry.family, entry.description, now)];
  }));
  const cardOrderByCategory = Object.fromEntries(CARD_SCOPE_CATALOG.map((entry) => {
    const categoryId = deckIdFromLabel(entry.family);
    return [
      categoryId,
      entry.subItems.map((subItem) => generatedCardId(entry.role, subItem.key))
    ];
  }));
  const cards = Object.fromEntries(CARD_SCOPE_CATALOG.flatMap((entry) => {
    const categoryId = deckIdFromLabel(entry.family);
    return entry.subItems.map((subItem) => {
      const cardId = generatedCardId(entry.role, subItem.key);
      return [
        cardId,
        generatedCard({
          id: cardId,
          categoryId,
          name: subItem.label,
          description: subItem.description,
          promptText: subItem.description,
          builtinFamily: entry.family,
          builtinRoleId: entry.role,
          selectedSubItems: [subItem.key],
          now
        })
      ];
    });
  }));

  return {
    id: DEFAULT_CARD_DECK_ID,
    name: 'Default Deck',
    description: 'Bundled Recursion card deck.',
    bundled: true,
    readonly: true,
    categoryOrder,
    categories,
    cardOrderByCategory,
    cards,
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeDeckName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function normalizeIdOrder(order, fallbackIds) {
  const known = new Set(fallbackIds);
  const result = [];
  for (const value of Array.isArray(order) ? order : []) {
    const id = normalizeId(value);
    if (known.has(id) && !result.includes(id)) result.push(id);
  }
  for (const id of fallbackIds) {
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function normalizeCategories(value, now) {
  const entries = isObject(value) ? Object.entries(value) : [];
  const categories = {};
  for (const [fallbackId, raw] of entries) {
    const id = normalizeId(raw?.id || fallbackId);
    const name = normalizeDeckName(raw?.name);
    if (!id || !name) continue;
    categories[id] = {
      id,
      name,
      description: String(raw?.description || '').trim(),
      createdAt: String(raw?.createdAt || now),
      updatedAt: String(raw?.updatedAt || now)
    };
  }
  if (Object.keys(categories).length === 0) {
    categories.general = category('general', 'General', '', now);
  }
  return categories;
}

function normalizeCards(value, categories, now) {
  const fallbackCategoryId = Object.keys(categories)[0];
  const entries = isObject(value) ? Object.entries(value) : [];
  const cards = {};
  for (const [fallbackId, raw] of entries) {
    const id = normalizeId(raw?.id || fallbackId);
    if (!id) continue;
    const rawCategoryId = normalizeId(raw?.categoryId);
    const categoryId = categories[rawCategoryId] ? rawCategoryId : fallbackCategoryId;
    cards[id] = {
      id,
      categoryId,
      name: normalizeDeckName(raw?.name || NEW_CARD_NAME),
      description: String(raw?.description || '').trim(),
      promptText: String(raw?.promptText || '').trim(),
      selectionState: normalizedCardSelectionState(raw),
      kind: raw?.kind === 'generated' ? 'generated' : 'authored',
      builtinFamily: String(raw?.builtinFamily || '').trim() || undefined,
      builtinRoleId: String(raw?.builtinRoleId || '').trim() || undefined,
      selectedSubItems: Array.isArray(raw?.selectedSubItems) ? raw.selectedSubItems.map(String) : [],
      createdAt: String(raw?.createdAt || now),
      updatedAt: String(raw?.updatedAt || now)
    };
  }
  return cards;
}

function normalizeCardOrder(value, cards, categoryOrder) {
  const result = Object.fromEntries(categoryOrder.map((categoryId) => [categoryId, []]));
  const seen = new Set();
  if (isObject(value)) {
    for (const [categoryId, order] of Object.entries(value)) {
      const cleanCategoryId = normalizeId(categoryId);
      if (!result[cleanCategoryId]) continue;
      for (const rawCardId of Array.isArray(order) ? order : []) {
        const cardId = normalizeId(rawCardId);
        if (cards[cardId] && cards[cardId].categoryId === cleanCategoryId && !seen.has(cardId)) {
          result[cleanCategoryId].push(cardId);
          seen.add(cardId);
        }
      }
    }
  }
  for (const card of Object.values(cards)) {
    if (!seen.has(card.id)) result[card.categoryId].push(card.id);
  }
  return result;
}

export function uniqueName(baseName, existingNames) {
  const base = normalizeDeckName(baseName) || 'Untitled';
  const taken = new Set(Array.from(existingNames || [], normalizeDeckName).map((name) => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let index = 1;
  while (true) {
    const suffix = index === 1 ? ' Copy' : ` Copy ${index}`;
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    index += 1;
  }
}

export function uniqueCopyName(originalName, existingNames) {
  const base = normalizeDeckName(originalName).replace(/\s+Copy(?:\s+\d+)?$/i, '') || 'Untitled';
  const taken = new Set(Array.from(existingNames || [], normalizeDeckName).map((name) => name.toLowerCase()));
  const firstCopy = `${base} Copy`;
  if (!taken.has(firstCopy.toLowerCase())) return firstCopy;
  let index = 2;
  while (true) {
    const candidate = `${base} Copy ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    index += 1;
  }
}

export function duplicateDeckName(deckName, decks) {
  return uniqueCopyName(normalizeDeckName(deckName) || 'Custom Deck', Object.values(decks || {}).map((deck) => deck.name));
}

export function duplicateCardName(cardName, siblingCards) {
  return uniqueCopyName(normalizeDeckName(cardName) || 'Card', (siblingCards || []).map((card) => card.name));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function newTimestampedId(prefix, existing = {}) {
  let index = Object.keys(existing).length + 1;
  let id = normalizeId(`${prefix}-${Date.now()}-${index}`);
  while (existing[id]) {
    index += 1;
    id = normalizeId(`${prefix}-${Date.now()}-${index}`);
  }
  return id;
}

export function normalizeCustomDeck(input, fallbackId = '', usedNames = new Set()) {
  if (!isObject(input)) return null;
  const now = nowIso();
  const id = normalizeId(input.id || fallbackId || `deck-${Date.now()}`);
  if (!id || id === DEFAULT_CARD_DECK_ID) return null;
  const categories = normalizeCategories(input.categories, now);
  const categoryOrder = normalizeIdOrder(input.categoryOrder, Object.keys(categories));
  const cards = normalizeCards(input.cards, categories, now);
  const cardOrderByCategory = normalizeCardOrder(input.cardOrderByCategory, cards, categoryOrder);
  const rawName = normalizeDeckName(input.name || 'Custom Deck');
  const name = uniqueName(rawName, usedNames);

  return {
    id,
    name,
    description: String(input.description || '').trim(),
    bundled: false,
    readonly: false,
    categoryOrder,
    categories,
    cardOrderByCategory,
    cards,
    createdAt: String(input.createdAt || now),
    updatedAt: String(input.updatedAt || now)
  };
}

export function normalizeCustomDecks(value) {
  const entries = isObject(value) ? Object.entries(value) : [];
  const decks = {};
  const usedNames = new Set(['default']);
  for (const [rawDeckId, rawDeck] of entries) {
    const deck = normalizeCustomDeck(rawDeck, rawDeckId, usedNames);
    if (!deck) continue;
    decks[deck.id] = deck;
    usedNames.add(deck.name.toLowerCase());
  }
  return decks;
}

function resolveActiveDeckId(activeCardDeckId, customCardDecks) {
  const id = String(activeCardDeckId || '').trim();
  if (id === DEFAULT_CARD_DECK_ID) return DEFAULT_CARD_DECK_ID;
  if (customCardDecks && Object.prototype.hasOwnProperty.call(customCardDecks, id)) return id;
  return DEFAULT_CARD_DECK_ID;
}

export function normalizeCardDeckSettings(input = {}) {
  const source = isObject(input) ? input : {};
  const customCardDecks = normalizeCustomDecks(source.customCardDecks);
  return {
    version: CARD_DECK_SETTINGS_VERSION,
    activeCardDeckId: resolveActiveDeckId(source.activeCardDeckId, customCardDecks),
    customCardDecks,
    ...(isObject(source.defaultEnabledState) ? { defaultEnabledState: source.defaultEnabledState } : {})
  };
}

export function getAllCardDecks(settings = {}) {
  const normalized = normalizeCardDeckSettings(settings.cardDecks);
  return {
    [DEFAULT_CARD_DECK_ID]: createDefaultCardDeck(),
    ...normalized.customCardDecks
  };
}

export function getActiveCardDeck(settings = {}) {
  const normalized = normalizeCardDeckSettings(settings.cardDecks);
  return getAllCardDecks(settings)[normalized.activeCardDeckId] || createDefaultCardDeck();
}

export function upsertCustomCardDeck(settings = {}, deck) {
  const source = normalizeCardDeckSettings(settings.cardDecks);
  const normalized = normalizeCustomDeck(deck, deck?.id, new Set([
    'default',
    ...Object.values(source.customCardDecks)
      .filter((entry) => entry.id !== deck?.id)
      .map((entry) => entry.name.toLowerCase())
  ]));
  if (!normalized) return source;
  return normalizeCardDeckSettings({
    ...source,
    activeCardDeckId: normalized.id,
    customCardDecks: {
      ...source.customCardDecks,
      [normalized.id]: normalized
    }
  });
}

export function createCustomCardDeck(settings = {}, { name = 'New Deck', description = '' } = {}) {
  const source = normalizeCardDeckSettings(settings.cardDecks);
  const now = nowIso();
  const id = newTimestampedId('deck', source.customCardDecks);
  return upsertCustomCardDeck(settings, {
    id,
    name: uniqueName(name, Object.values(source.customCardDecks).map((deck) => deck.name)),
    description,
    categories: {
      general: category('general', 'General', '', now)
    },
    categoryOrder: ['general'],
    cardOrderByCategory: { general: [] },
    cards: {},
    createdAt: now,
    updatedAt: now
  });
}

export function duplicateCardDeck(settings = {}, deckId = '') {
  const decks = getAllCardDecks(settings);
  const sourceDeck = decks[String(deckId || '')] || getActiveCardDeck(settings);
  const source = normalizeCardDeckSettings(settings.cardDecks);
  const now = nowIso();
  const id = newTimestampedId('deck', source.customCardDecks);
  const categoryIdMap = {};
  const categories = {};
  for (const categoryEntry of Object.values(sourceDeck.categories || {})) {
    const nextId = normalizeId(categoryEntry.id || newTimestampedId('category', categories));
    categoryIdMap[categoryEntry.id] = nextId;
    categories[nextId] = {
      ...cloneJson(categoryEntry),
      id: nextId,
      createdAt: now,
      updatedAt: now
    };
  }
  const cardIdMap = {};
  const cards = {};
  for (const cardEntry of Object.values(sourceDeck.cards || {})) {
    const nextId = normalizeId(cardEntry.id || newTimestampedId('card', cards));
    cardIdMap[cardEntry.id] = nextId;
    cards[nextId] = {
      ...cloneJson(cardEntry),
      id: nextId,
      categoryId: categoryIdMap[cardEntry.categoryId] || sourceDeck.categoryOrder?.[0] || 'general',
      kind: cardEntry.kind === 'generated' ? 'generated' : 'authored',
      createdAt: now,
      updatedAt: now
    };
  }
  const cardOrderByCategory = {};
  for (const categoryId of sourceDeck.categoryOrder || []) {
    const nextCategoryId = categoryIdMap[categoryId] || categoryId;
    cardOrderByCategory[nextCategoryId] = (sourceDeck.cardOrderByCategory?.[categoryId] || [])
      .map((cardId) => cardIdMap[cardId])
      .filter(Boolean);
  }
  return upsertCustomCardDeck(settings, {
    ...cloneJson(sourceDeck),
    id,
    name: duplicateDeckName(sourceDeck.name, source.customCardDecks),
    description: sourceDeck.description || '',
    bundled: false,
    readonly: false,
    categoryOrder: (sourceDeck.categoryOrder || []).map((categoryId) => categoryIdMap[categoryId] || categoryId),
    categories,
    cardOrderByCategory,
    cards,
    createdAt: now,
    updatedAt: now
  });
}

export function deleteCustomCardDeck(settings = {}, deckId = '') {
  const source = normalizeCardDeckSettings(settings.cardDecks);
  const id = normalizeId(deckId);
  if (!id || id === DEFAULT_CARD_DECK_ID || !source.customCardDecks[id]) return source;
  const customCardDecks = { ...source.customCardDecks };
  delete customCardDecks[id];
  return normalizeCardDeckSettings({
    ...source,
    activeCardDeckId: source.activeCardDeckId === id ? DEFAULT_CARD_DECK_ID : source.activeCardDeckId,
    customCardDecks
  });
}

export function createDraftCard(deck, categoryId = '') {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const now = nowIso();
  const categories = isObject(normalized.categories) ? normalized.categories : { general: category('general', 'General', '', now) };
  const targetCategoryId = categories[normalizeId(categoryId)] ? normalizeId(categoryId) : Object.keys(categories)[0];
  const id = newTimestampedId('card', normalized.cards || {});
  const cards = {
    ...(normalized.cards || {}),
    [id]: {
      id,
      categoryId: targetCategoryId,
      name: NEW_CARD_NAME,
      description: '',
      promptText: '',
      selectionState: 'active',
      kind: 'authored',
      selectedSubItems: [],
      createdAt: now,
      updatedAt: now
    }
  };
  const cardOrderByCategory = {
    ...(normalized.cardOrderByCategory || {}),
    [targetCategoryId]: [...(normalized.cardOrderByCategory?.[targetCategoryId] || []), id]
  };
  return normalizeCustomDeck({
    ...normalized,
    cards,
    cardOrderByCategory,
    updatedAt: now
  }, normalized.id);
}

export function createCategory(deck, { name = 'New Category', description = '' } = {}) {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const now = nowIso();
  const id = newTimestampedId('category', normalized.categories || {});
  return normalizeCustomDeck({
    ...normalized,
    categories: {
      ...(normalized.categories || {}),
      [id]: category(id, uniqueName(name, Object.values(normalized.categories || {}).map((entry) => entry.name)), description, now)
    },
    categoryOrder: [...(normalized.categoryOrder || []), id],
    cardOrderByCategory: {
      ...(normalized.cardOrderByCategory || {}),
      [id]: []
    },
    updatedAt: now
  }, normalized.id);
}

export function updateCategory(deck, categoryId, patch = {}) {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const id = normalizeId(categoryId);
  const current = normalized.categories?.[id];
  if (!current) return normalized;
  const now = nowIso();
  return normalizeCustomDeck({
    ...normalized,
    categories: {
      ...normalized.categories,
      [id]: {
        ...current,
        name: normalizeDeckName(patch.name ?? current.name) || current.name,
        description: String(patch.description ?? current.description ?? '').trim(),
        updatedAt: now
      }
    },
    updatedAt: now
  }, normalized.id);
}

export function reorderCategories(deck, movingCategoryId, beforeCategoryId = '') {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const moving = normalizeId(movingCategoryId);
  const before = normalizeId(beforeCategoryId);
  if (!normalized.categories?.[moving]) return normalized;
  const order = (normalized.categoryOrder || []).filter((id) => id !== moving);
  const index = before && order.includes(before) ? order.indexOf(before) : order.length;
  order.splice(index, 0, moving);
  return normalizeCustomDeck({ ...normalized, categoryOrder: order, updatedAt: nowIso() }, normalized.id);
}

export function moveCategoryToPosition(deck, categoryId, beforeCategoryId = '') {
  return reorderCategories(deck, categoryId, beforeCategoryId);
}

export function deleteCategory(deck, categoryId) {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const id = normalizeId(categoryId);
  if (!normalized.categories?.[id] || Object.keys(normalized.categories || {}).length <= 1) return normalized;
  const now = nowIso();
  const fallbackCategoryId = (normalized.categoryOrder || []).find((entry) => entry !== id)
    || Object.keys(normalized.categories).find((entry) => entry !== id);
  const categories = { ...normalized.categories };
  delete categories[id];
  const cards = {};
  for (const [cardId, card] of Object.entries(normalized.cards || {})) {
    cards[cardId] = card.categoryId === id ? { ...card, categoryId: fallbackCategoryId, updatedAt: now } : card;
  }
  const categoryOrder = (normalized.categoryOrder || []).filter((entry) => entry !== id);
  return normalizeCustomDeck({
    ...normalized,
    categories,
    cards,
    categoryOrder,
    cardOrderByCategory: normalizeCardOrder(normalized.cardOrderByCategory, cards, categoryOrder),
    updatedAt: now
  }, normalized.id);
}

export function updateCard(deck, cardId, patch = {}) {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const id = normalizeId(cardId);
  const current = normalized.cards?.[id];
  if (!current) return normalized;
  const now = nowIso();
  return normalizeCustomDeck({
    ...normalized,
    cards: {
      ...normalized.cards,
      [id]: {
        ...current,
        name: normalizeDeckName(patch.name ?? current.name) || current.name,
        description: String(patch.description ?? current.description ?? '').trim(),
        promptText: String(patch.promptText ?? current.promptText ?? '').trim(),
        selectionState: patch.selectionState === undefined
          ? cardSelectionState(current)
          : normalizedCardSelectionState({ selectionState: patch.selectionState }),
        updatedAt: now
      }
    },
    updatedAt: now
  }, normalized.id);
}

export function updateCardSelectionState(deck, cardId, selectionState) {
  return updateCard(deck, cardId, { selectionState });
}

export function duplicateCard(deck, cardId) {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const id = normalizeId(cardId);
  const current = normalized.cards?.[id];
  if (!current) return normalized;
  const now = nowIso();
  const nextId = newTimestampedId('card', normalized.cards || {});
  const siblingCards = Object.values(normalized.cards || {}).filter((card) => card.categoryId === current.categoryId);
  const cards = {
    ...normalized.cards,
    [nextId]: {
      ...cloneJson(current),
      id: nextId,
      name: duplicateCardName(current.name, siblingCards),
      createdAt: now,
      updatedAt: now
    }
  };
  const order = normalized.cardOrderByCategory?.[current.categoryId] || [];
  const sourceIndex = order.indexOf(id);
  const nextOrder = order.slice();
  nextOrder.splice(sourceIndex >= 0 ? sourceIndex + 1 : nextOrder.length, 0, nextId);
  return normalizeCustomDeck({
    ...normalized,
    cards,
    cardOrderByCategory: {
      ...normalized.cardOrderByCategory,
      [current.categoryId]: nextOrder
    },
    updatedAt: now
  }, normalized.id);
}

export function deleteCard(deck, cardId) {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const id = normalizeId(cardId);
  if (!normalized.cards?.[id]) return normalized;
  const cards = { ...normalized.cards };
  delete cards[id];
  const cardOrderByCategory = Object.fromEntries(Object.entries(normalized.cardOrderByCategory || {}).map(([categoryId, order]) => [
    categoryId,
    (Array.isArray(order) ? order : []).filter((entry) => entry !== id)
  ]));
  return normalizeCustomDeck({ ...normalized, cards, cardOrderByCategory, updatedAt: nowIso() }, normalized.id);
}

export function deleteCategoryAndCards(deck, categoryId) {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const id = normalizeId(categoryId);
  if (!normalized.categories?.[id] || Object.keys(normalized.categories || {}).length <= 1) return normalized;
  const cards = Object.fromEntries(Object.entries(normalized.cards || {}).filter(([, card]) => card.categoryId !== id));
  const categories = { ...normalized.categories };
  delete categories[id];
  const categoryOrder = (normalized.categoryOrder || []).filter((entry) => entry !== id);
  const cardOrderByCategory = Object.fromEntries(Object.entries(normalized.cardOrderByCategory || {})
    .filter(([entry]) => entry !== id)
    .map(([entry, order]) => [
      entry,
      (Array.isArray(order) ? order : []).filter((cardId) => cards[cardId])
    ]));
  return normalizeCustomDeck({
    ...normalized,
    categories,
    cards,
    categoryOrder,
    cardOrderByCategory,
    updatedAt: nowIso()
  }, normalized.id);
}

export function moveCard(deck, cardId, targetCategoryId, targetIndex = Infinity) {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const id = normalizeId(cardId);
  const target = normalizeId(targetCategoryId);
  const card = normalized.cards?.[id];
  if (!card || !normalized.categories?.[target]) return normalized;
  const now = nowIso();
  const cards = {
    ...normalized.cards,
    [id]: {
      ...card,
      categoryId: target,
      updatedAt: now
    }
  };
  const cardOrderByCategory = Object.fromEntries((normalized.categoryOrder || []).map((categoryId) => [
    categoryId,
    (normalized.cardOrderByCategory?.[categoryId] || []).filter((entry) => entry !== id)
  ]));
  const nextOrder = cardOrderByCategory[target] || [];
  const numericIndex = Math.round(Number(targetIndex));
  const insertAt = Number.isFinite(numericIndex) ? Math.max(0, Math.min(nextOrder.length, numericIndex)) : nextOrder.length;
  nextOrder.splice(insertAt, 0, id);
  cardOrderByCategory[target] = nextOrder;
  return normalizeCustomDeck({ ...normalized, cards, cardOrderByCategory, updatedAt: now }, normalized.id);
}

export function moveCardToPosition(deck, cardId, targetCategoryId, beforeCardId = '') {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const id = normalizeId(cardId);
  const target = normalizeId(targetCategoryId);
  const before = normalizeId(beforeCardId);
  const card = normalized.cards?.[id];
  if (!card || !normalized.categories?.[target]) return normalized;

  const targetOrderWithoutMoving = (normalized.cardOrderByCategory?.[target] || []).filter((entry) => entry !== id);
  const index = before && targetOrderWithoutMoving.includes(before)
    ? targetOrderWithoutMoving.indexOf(before)
    : targetOrderWithoutMoving.length;
  return moveCard(normalized, id, target, index);
}

export function reorderCards(deck, categoryId, orderedCardIds = []) {
  const normalized = normalizeCustomDeck(deck, deck?.id) || deck;
  const category = normalizeId(categoryId);
  if (!normalized.categories?.[category]) return normalized;
  const valid = new Set(Object.values(normalized.cards || {}).filter((card) => card.categoryId === category).map((card) => card.id));
  const seen = new Set();
  const order = [];
  for (const rawId of Array.isArray(orderedCardIds) ? orderedCardIds : []) {
    const id = normalizeId(rawId);
    if (valid.has(id) && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  for (const id of normalized.cardOrderByCategory?.[category] || []) {
    if (valid.has(id) && !seen.has(id)) order.push(id);
  }
  return normalizeCustomDeck({
    ...normalized,
    cardOrderByCategory: {
      ...normalized.cardOrderByCategory,
      [category]: order
    },
    updatedAt: nowIso()
  }, normalized.id);
}

export function getDeckCardStatus(card) {
  const name = normalizeDeckName(card?.name);
  const promptText = String(card?.promptText || '').trim();
  if (!name) return { runnable: false, reason: 'needs-name' };
  if (name === NEW_CARD_NAME) return { runnable: false, reason: 'draft-name' };
  if (!promptText) return { runnable: false, reason: 'needs-prompt' };
  if (cardSelectionState(card) === 'off') return { runnable: false, reason: 'disabled' };
  return { runnable: true, reason: 'runnable' };
}

export function orderedDeckCategories(deck) {
  const categories = isObject(deck?.categories) ? deck.categories : {};
  const order = Array.isArray(deck?.categoryOrder) ? deck.categoryOrder : Object.keys(categories);
  return order.map((id) => categories[id]).filter(Boolean);
}

export function orderedDeckCards(deck, categoryId = '') {
  const cards = isObject(deck?.cards) ? deck.cards : {};
  const id = normalizeId(categoryId);
  const order = Array.isArray(deck?.cardOrderByCategory?.[id]) ? deck.cardOrderByCategory[id] : [];
  const seen = new Set();
  const result = [];
  for (const cardId of order) {
    if (cards[cardId]?.categoryId === id && !seen.has(cardId)) {
      result.push(cards[cardId]);
      seen.add(cardId);
    }
  }
  for (const card of Object.values(cards)) {
    if (card.categoryId === id && !seen.has(card.id)) result.push(card);
  }
  return result;
}

export function orderedDeckCardsAcrossCategories(deck) {
  return orderedDeckCategories(deck).flatMap((category) => orderedDeckCards(deck, category.id));
}

export function deckPriorityCardIds(deck, settings = {}) {
  const mode = settings?.mode === 'manual' ? 'manual' : 'auto';
  if (mode !== 'auto') return [];
  return orderedDeckCardsAcrossCategories(deck)
    .filter((card) => cardSelectionState(card) === 'priority')
    .filter((card) => getDeckCardStatus(card).runnable)
    .map((card) => card.id);
}

export function deckPriorityFamilies(deck, settings = {}) {
  const mode = settings?.mode === 'manual' ? 'manual' : 'auto';
  if (mode !== 'auto') return [];
  const seen = new Set();
  const families = [];
  for (const card of orderedDeckCardsAcrossCategories(deck)) {
    if (cardSelectionState(card) !== 'priority') continue;
    if (!getDeckCardStatus(card).runnable) continue;
    const family = String(card.builtinFamily || '').trim();
    if (!family || seen.has(family)) continue;
    seen.add(family);
    families.push(family);
  }
  return families;
}

export function activeCardDeckEligibility(settings = {}) {
  const deck = getActiveCardDeck(settings);
  const cards = orderedDeckCardsAcrossCategories(deck)
    .filter((card) => getDeckCardStatus(card).runnable);
  const activeCardIds = cards
    .filter((card) => cardSelectionState(card) === 'active')
    .map((card) => card.id);
  const priorityCardIds = cards
    .filter((card) => cardSelectionState(card) === 'priority')
    .map((card) => card.id);
  return {
    activeDeckId: deck.id,
    activeCardIds,
    priorityCardIds,
    allowedCardIds: [...priorityCardIds, ...activeCardIds],
    allowedFamilies: [...new Set(cards
      .filter((card) => cardSelectionState(card) === 'active' || cardSelectionState(card) === 'priority')
      .map((card) => String(card.builtinFamily || '').trim())
      .filter(Boolean))]
  };
}

function emptyCardScope() {
  return {
    version: CARD_SCOPE_VERSION,
    allowEmpty: true,
    families: Object.fromEntries(CARD_SCOPE_CATALOG.map((entry) => [
      entry.family,
      {
        enabled: false,
        subItems: Object.fromEntries(entry.subItems.map((item) => [item.key, false]))
      }
    ]))
  };
}

function enableCardScopeSubItems(scope, familyName, subItems) {
  const catalog = CARD_SCOPE_CATALOG.find((entry) => entry.family === familyName);
  if (!catalog || !scope.families[catalog.family]) return;
  const requested = new Set(Array.isArray(subItems) && subItems.length ? subItems.map(String) : catalog.subItems.map((item) => item.key));
  let enabled = false;
  for (const item of catalog.subItems) {
    if (requested.has(item.key)) {
      scope.families[catalog.family].subItems[item.key] = true;
      enabled = true;
    }
  }
  scope.families[catalog.family].enabled = enabled || Object.values(scope.families[catalog.family].subItems).some(Boolean);
}

export function activeCardDeckRuntimeScope(settings = {}) {
  if (!settings.cardDecks && settings.cardScope) return settings.cardScope;
  const deck = getActiveCardDeck(settings);
  if (deck.id === DEFAULT_CARD_DECK_ID && isObject(settings.cardDecks?.defaultEnabledState)) {
    return {
      version: CARD_SCOPE_VERSION,
      allowEmpty: true,
      families: settings.cardDecks.defaultEnabledState
    };
  }
  const scope = emptyCardScope();
  for (const card of Object.values(deck.cards || {})) {
    if (!getDeckCardStatus(card).runnable) continue;
    const family = String(card.builtinFamily || '').trim();
    if (!family) continue;
    enableCardScopeSubItems(scope, family, card.selectedSubItems);
  }
  return scope;
}

export function cardNameWarning(card, deck) {
  const name = normalizeDeckName(card?.name);
  if (!name || name === NEW_CARD_NAME) return '';
  const duplicateCount = Object.values(deck?.cards || {})
    .filter((other) => other?.id !== card?.id)
    .filter((other) => getDeckCardStatus(other).runnable)
    .filter((other) => normalizeDeckName(other.name).toLowerCase() === name.toLowerCase())
    .length;
  return duplicateCount > 0 ? 'duplicate-card-name' : '';
}

export function serializeCustomCardDeck(deck) {
  const normalized = normalizeCustomDeck(deck);
  if (!normalized) return null;
  const parsed = JSON.parse(JSON.stringify(normalized));
  return {
    ...parsed,
    readonly: false,
    bundled: false
  };
}

export function serializeCustomCardDecksForExport(settings = {}) {
  const normalized = normalizeCardDeckSettings(settings.cardDecks);
  return {
    version: normalized.version,
    exportedAt: nowIso(),
    decks: Object.fromEntries(Object.entries(normalized.customCardDecks).map(([deckId, deck]) => [
      deckId,
      serializeCustomCardDeck(deck)
    ]).filter(([, deck]) => deck))
  };
}
