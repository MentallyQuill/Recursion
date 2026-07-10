# Recursion Card System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Recursion Card System with global Card Decks, editable categories/cards, mobile-safe interactions, Authoring Assist, zero-card runtime support, and compact visual state feedback.

**Architecture:** Add a focused Card Deck model and runtime adapter that converts the active global deck into generated-card requests, authored Card Evidence candidates, skipped-card diagnostics, and UI state. Keep the existing generated-card pipeline for Default/generated cards, route authored cards through the existing hand-selection and prompt composition paths, and keep UI editing state separate from persisted settings until explicit save.

**Tech Stack:** JavaScript ES modules, SillyTavern extension settings, Recursion runtime/prompt/provider modules, existing PowerShell-friendly Node test scripts.

## Global Constraints

- Feature name is Card System.
- Deck term is Card Decks, not Card Library.
- Active deck is global, not chat-scoped.
- Bundled deck is named Default and is read-only.
- Zero active cards is valid and skips all card-specific calls and card evidence.
- New cards start as `New Card`, remain draft until renamed and given valid prompt text, and never run while draft.
- Categories are organizational, UI-only, and never injected.
- Category descriptions, card descriptions, deck descriptions, and assist text are UI-only unless explicitly part of prompt inspection.
- Authoring Assist has Accept and Close only; no Author's Note or preset move action.
- Mobile press-hold is an enhancement; every action must have a visible or keyboard-accessible fallback.
- Diagnostics redact custom deck/card text by default.

---

Date: 2026-07-10

Status: Draft for review

Spec: `docs/superpowers/specs/2026-07-10-recursion-card-system-design.md`

## Goal

Replace the fixed Cards scope selector with a compact Card System:

- Global active Card Deck setting.
- Bundled read-only Default deck.
- Editable custom decks.
- Editable categories and cards.
- Draft/new-card validation.
- Desktop hover descriptions.
- Mobile press-hold editing and explicit move mode.
- Card Authoring Assist in the card editor.
- Runtime support for zero active cards.
- Integration with generated cards, authored card evidence, prompt inspection, Manual mode, and Enhancements.

## Non-Goals

- No Card Library terminology.
- No Author's Note or preset move action.
- No category wand.
- No per-chat active deck.
- No legacy compatibility layer for old pre-alpha settings shapes beyond direct normalization into the new shape.
- No large dashboard redesign of the Recursion bar.

## Current Integration Points

The implementation should touch these surfaces:

- `src/card-scope.mjs`
- `src/cards.mjs`
- `src/settings.mjs`
- `src/providers.mjs`
- `src/runtime.mjs`
- `src/prompt.mjs`
- `src/ui.mjs`
- `tools/scripts/test-card-scope.mjs`
- `tools/scripts/test-cards.mjs`
- `tools/scripts/test-runtime-card-packet.mjs`
- `tools/scripts/test-ui.mjs`
- `docs/design/UI_SPEC.md`
- `docs/design/CARD_SYSTEM_SPEC.md`
- `docs/architecture/PROMPT_COMPOSITION_SPEC.md`

If implementation finds that `src/ui.mjs` is too large for a safe edit, split Card System UI into:

- `src/ui/card-system-panel.mjs`
- `src/ui/card-system-editor.mjs`
- `src/ui/card-system-touch.mjs`

and import those from `src/ui.mjs`.

## Data Model

Add `src/card-decks.mjs`.

Core exports:

```js
import { CARD_SCOPE_CATALOG } from "./card-scope.mjs";

export const DEFAULT_CARD_DECK_ID = "default";
export const CARD_DECK_SETTINGS_VERSION = 1;
export const NEW_CARD_NAME = "New Card";

export function createDefaultCardDeck({ now = new Date().toISOString() } = {}) {
  const categoryOrder = CARD_SCOPE_CATALOG.map((entry) => deckIdFromLabel(entry.family));
  const categories = Object.fromEntries(CARD_SCOPE_CATALOG.map((entry) => {
    const categoryId = deckIdFromLabel(entry.family);
    return [categoryId, category(categoryId, entry.family, entry.description, now)];
  }));
  const cardOrderByCategory = Object.fromEntries(CARD_SCOPE_CATALOG.map((entry) => {
    const categoryId = deckIdFromLabel(entry.family);
    return [
      categoryId,
      entry.subItems.map((subItem) => generatedCardId(entry.role, subItem.key)),
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
          now,
        }),
      ];
    });
  }));

  return {
    id: DEFAULT_CARD_DECK_ID,
    name: "Default",
    description: "Bundled Recursion card deck.",
    bundled: true,
    readonly: true,
    categoryOrder,
    categories,
    cardOrderByCategory,
    cards,
    createdAt: now,
    updatedAt: now,
  };
}

function category(id, name, description, now) {
  return { id, name, description, createdAt: now, updatedAt: now };
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
  now,
}) {
  return {
    id,
    categoryId,
    name,
    description,
    promptText,
    enabled: true,
    kind: "generated",
    builtinFamily,
    builtinRoleId,
    selectedSubItems,
    createdAt: now,
    updatedAt: now,
  };
}

function deckIdFromLabel(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generatedCardId(roleId, subItemKey) {
  return `${roleId}:${subItemKey}`;
}
```

The Default deck is built from the current `CARD_SCOPE_CATALOG`. Do not invent role ids that do not exist in provider configuration.

Add normalization:

```js
export function normalizeCardDeckSettings(input = {}) {
  const version = CARD_DECK_SETTINGS_VERSION;
  const customCardDecks = normalizeCustomDecks(input.customCardDecks);
  const activeCardDeckId = resolveActiveDeckId(input.activeCardDeckId, customCardDecks);
  return { version, activeCardDeckId, customCardDecks };
}

export function getAllCardDecks(settings) {
  const defaults = createDefaultCardDeck();
  return {
    [DEFAULT_CARD_DECK_ID]: defaults,
    ...normalizeCardDeckSettings(settings.cardDecks).customCardDecks,
  };
}

export function getActiveCardDeck(settings) {
  const normalized = normalizeCardDeckSettings(settings.cardDecks);
  return getAllCardDecks(settings)[normalized.activeCardDeckId] || createDefaultCardDeck();
}

function resolveActiveDeckId(activeCardDeckId, customCardDecks) {
  const id = String(activeCardDeckId || "").trim();
  if (id === DEFAULT_CARD_DECK_ID) return DEFAULT_CARD_DECK_ID;
  if (customCardDecks && Object.prototype.hasOwnProperty.call(customCardDecks, id)) return id;
  return DEFAULT_CARD_DECK_ID;
}

export function normalizeCustomDecks(value) {
  const entries = value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : [];
  const decks = {};
  const usedNames = new Set(["default"]);

  for (const [rawDeckId, rawDeck] of entries) {
    const deck = normalizeCustomDeck(rawDeck, rawDeckId, usedNames);
    if (deck) {
      decks[deck.id] = deck;
      usedNames.add(deck.name.toLowerCase());
    }
  }

  return decks;
}

export function normalizeCustomDeck(input, fallbackId = "", usedNames = new Set()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const now = new Date().toISOString();
  const id = normalizeId(input.id || fallbackId || `deck-${Date.now()}`);
  if (!id || id === DEFAULT_CARD_DECK_ID) return null;

  const categories = normalizeCategories(input.categories, now);
  const categoryOrder = normalizeIdOrder(input.categoryOrder, Object.keys(categories));
  const cards = normalizeCards(input.cards, categories, now);
  const cardOrderByCategory = normalizeCardOrder(input.cardOrderByCategory, cards, categoryOrder);
  const rawName = normalizeDeckName(input.name || "Custom Deck");
  const name = uniqueName(rawName, usedNames);

  return {
    id,
    name,
    description: String(input.description || "").trim(),
    bundled: false,
    readonly: false,
    categoryOrder,
    categories,
    cardOrderByCategory,
    cards,
    createdAt: String(input.createdAt || now),
    updatedAt: String(input.updatedAt || now),
  };
}

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  const entries = value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : [];
  const categories = {};

  for (const [fallbackId, raw] of entries) {
    const id = normalizeId(raw?.id || fallbackId);
    const name = normalizeDeckName(raw?.name);
    if (!id || !name) continue;
    categories[id] = {
      id,
      name,
      description: String(raw?.description || "").trim(),
      createdAt: String(raw?.createdAt || now),
      updatedAt: String(raw?.updatedAt || now),
    };
  }

  if (Object.keys(categories).length === 0) {
    categories.general = category("general", "General", "", now);
  }

  return categories;
}

function normalizeCards(value, categories, now) {
  const categoryIds = Object.keys(categories);
  const fallbackCategoryId = categoryIds[0];
  const entries = value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : [];
  const cards = {};

  for (const [fallbackId, raw] of entries) {
    const id = normalizeId(raw?.id || fallbackId);
    if (!id) continue;
    const categoryId = categories[normalizeId(raw?.categoryId)] ? normalizeId(raw.categoryId) : fallbackCategoryId;
    cards[id] = {
      id,
      categoryId,
      name: normalizeDeckName(raw?.name || NEW_CARD_NAME),
      description: String(raw?.description || "").trim(),
      promptText: String(raw?.promptText || "").trim(),
      enabled: raw?.enabled !== false,
      kind: raw?.kind === "generated" ? "generated" : "authored",
      builtinFamily: String(raw?.builtinFamily || "").trim() || undefined,
      builtinRoleId: String(raw?.builtinRoleId || "").trim() || undefined,
      selectedSubItems: Array.isArray(raw?.selectedSubItems) ? raw.selectedSubItems.map(String) : [],
      createdAt: String(raw?.createdAt || now),
      updatedAt: String(raw?.updatedAt || now),
    };
  }

  return cards;
}

function normalizeCardOrder(value, cards, categoryOrder) {
  const result = Object.fromEntries(categoryOrder.map((categoryId) => [categoryId, []]));
  const seen = new Set();

  if (value && typeof value === "object" && !Array.isArray(value)) {
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
```

Add draft/runnable helpers:

```js
export function getDeckCardStatus(card) {
  const name = String(card?.name || "").trim();
  const promptText = String(card?.promptText || "").trim();

  if (name.length === 0) return { runnable: false, reason: "needs-name" };
  if (name === NEW_CARD_NAME) return { runnable: false, reason: "draft-name" };
  if (promptText.length === 0) return { runnable: false, reason: "needs-prompt" };
  if (!card?.enabled) return { runnable: false, reason: "disabled" };

  return { runnable: true, reason: "runnable" };
}
```

Export deck validation helpers from `src/cards.mjs`:

```js
export function assertDeckAuthoredPromptTextSafe(promptText, catalog = {}) {
  assertCardPromptTextSafe(catalog, promptText);
}

export function assertDeckGeneratedPromptTextSafe(promptText) {
  const text = String(promptText || "");
  if (!text.trim()) throw new Error("Generated deck card promptText is required.");
  for (const pattern of CARD_FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error("Generated deck card promptText contains unsafe hidden-reasoning wording.");
    }
  }
}
```

Authored prompts use the stricter injected-card validation. Generated prompts use safety validation without blocking the shipped Card Scope catalog wording.

Add name normalization and collision helpers in `src/card-decks.mjs`:

```js
export function normalizeDeckName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

export function uniqueName(baseName, existingNames) {
  const base = normalizeDeckName(baseName) || "Untitled";
  const taken = new Set(Array.from(existingNames || [], normalizeDeckName).map((name) => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;

  let index = 1;
  while (true) {
    const suffix = index === 1 ? " Copy" : ` Copy ${index}`;
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    index += 1;
  }
}

export function uniqueCopyName(originalName, existingNames) {
  const base = normalizeDeckName(originalName).replace(/\s+Copy(?:\s+\d+)?$/i, "") || "Untitled";
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
  return uniqueCopyName(normalizeDeckName(deckName) || "Custom Deck", Object.values(decks).map((deck) => deck.name));
}

export function duplicateCardName(cardName, siblingCards) {
  return uniqueCopyName(normalizeDeckName(cardName) || "Card", siblingCards.map((card) => card.name));
}

export function cardNameWarning(card, deck) {
  const name = normalizeDeckName(card?.name);
  if (!name || name === NEW_CARD_NAME) return "";
  const duplicateCount = Object.values(deck.cards || {})
    .filter((other) => other?.id !== card?.id)
    .filter((other) => getDeckCardStatus(other).runnable)
    .filter((other) => normalizeDeckName(other.name).toLowerCase() === name.toLowerCase())
    .length;
  return duplicateCount > 0 ? "duplicate-card-name" : "";
}
```

## Settings Integration

Update `src/settings.mjs`.

Add defaults:

```js
import { DEFAULT_CARD_DECK_ID } from "./card-decks.mjs";

const DEFAULT_SETTINGS = {
  // existing settings
  cardDecks: {
    version: 1,
    activeCardDeckId: DEFAULT_CARD_DECK_ID,
    customCardDecks: {},
  },
};
```

Add a one-time settings upgrade path:

```js
import {
  CARD_DECK_SETTINGS_VERSION,
  DEFAULT_CARD_DECK_ID,
  normalizeCardDeckSettings,
} from "./card-decks.mjs";

export function normalizeSettings(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const migratedCardDecks = raw.cardDecks
    ? raw.cardDecks
    : migrateLegacyCardScopeToDeckSettings(raw.cardScope);

  const normalized = {
    ...DEFAULT_SETTINGS,
    ...raw,
    cardDecks: normalizeCardDeckSettings(migratedCardDecks),
  };

  delete normalized.cardScope;
  return normalized;
}

function migrateLegacyCardScopeToDeckSettings(cardScope) {
  return {
    version: CARD_DECK_SETTINGS_VERSION,
    activeCardDeckId: DEFAULT_CARD_DECK_ID,
    customCardDecks: {},
    defaultEnabledState: extractLegacyDefaultEnabledState(cardScope),
  };
}

function extractLegacyDefaultEnabledState(cardScope) {
  const families = cardScope && typeof cardScope === "object" ? cardScope.families : {};
  return families && typeof families === "object" ? families : {};
}
```

The migration may read old `cardScope` to seed Default deck enabled state during normalization. Persisted settings should write only `cardDecks`.

## Import And Export Boundary

Do not add Card Deck import/export UI in this implementation. Keep deck records JSON-portable and add tests that prove custom decks can be serialized without functions, DOM nodes, or bundled Default data.

Add a small assertion helper to `src/card-decks.mjs` for tests and future export work:

```js
export function serializeCustomCardDeck(deck) {
  const normalized = normalizeCustomDeck(deck);
  const json = JSON.stringify(normalized);
  const parsed = JSON.parse(json);
  return {
    ...parsed,
    readonly: false,
    bundled: false,
  };
}

export function serializeCustomCardDecksForExport(settings) {
  const normalized = normalizeCardDeckSettings(settings.cardDecks);
  return {
    version: normalized.version,
    exportedAt: new Date().toISOString(),
    decks: Object.fromEntries(
      Object.entries(normalized.customCardDecks).map(([deckId, deck]) => [
        deckId,
        serializeCustomCardDeck(deck),
      ])
    ),
  };
}
```

UI direction:

- Do not render Import Deck or Export Deck actions in V1.
- Do not export the bundled Default deck unless the user duplicates it into a custom deck first.
- Keep the serialized shape deterministic so import/export can be added later without changing the deck model.

## Runtime Adapter

Add runtime conversion in `src/card-decks.mjs` or a focused `src/card-deck-runtime.mjs`.

```js
import {
  assertDeckAuthoredPromptTextSafe,
  assertDeckGeneratedPromptTextSafe,
} from "./cards.mjs";

export function buildRuntimeDeck(deck) {
  const generatedCards = [];
  const authoredCards = [];
  const inactiveCards = [];

  for (const categoryId of deck.categoryOrder) {
    const cardIds = deck.cardOrderByCategory[categoryId] || [];
    for (const cardId of cardIds) {
      const card = deck.cards[cardId];
      if (!card) continue;

      const status = getDeckCardStatus(card);
      if (!status.runnable) {
        inactiveCards.push({ cardId, categoryId, reason: status.reason });
        continue;
      }

      const promptText = card.promptText.trim();

      if (card.kind === "generated") {
        assertDeckGeneratedPromptTextSafe(promptText);
        generatedCards.push({
          cardId,
          categoryId,
          family: card.builtinFamily,
          roleId: card.builtinRoleId,
          selectedSubItems: Array.isArray(card.selectedSubItems) ? card.selectedSubItems : [],
          name: card.name.trim(),
          promptText,
        });
        continue;
      }

      assertDeckAuthoredPromptTextSafe(promptText, { family: card.builtinFamily || "User Authored" });
      authoredCards.push({
        cardId,
        categoryId,
        name: card.name.trim(),
        promptText,
      });
    }
  }

  return {
    deckId: deck.id,
    deckName: deck.name,
    generatedCards,
    authoredCards,
    inactiveCards,
  };
}
```

## Runtime Generation Changes

Update `src/runtime.mjs`.

Expected flow:

```js
const activeDeck = getActiveCardDeck(settings);
const runtimeDeck = buildRuntimeDeck(activeDeck);

const hasGeneratedCards = runtimeDeck.generatedCards.length > 0;
const hasAuthoredCards = runtimeDeck.authoredCards.length > 0;
const hasCardWork = hasGeneratedCards || hasAuthoredCards;

if (!hasCardWork) {
  journal.cardDeck = {
    deckId: runtimeDeck.deckId,
    deckName: runtimeDeck.deckName,
    runnableCount: 0,
    skippedCount: runtimeDeck.inactiveCards.length,
    reason: "no-active-cards",
  };
  return continueWithoutCardEvidence();
}
```

Generated card requests should be built from `runtimeDeck.generatedCards` instead of the old card-scope selection. Group generated cards by `roleId` so each provider role receives one request with combined deck prompt items.

```js
function groupGeneratedDeckCards(generatedCards) {
  const byRole = new Map();
  for (const card of generatedCards) {
    const roleId = String(card.roleId || "").trim();
    if (!roleId) continue;
    const entry = byRole.get(roleId) || {
      family: card.family,
      roleId,
      selectedSubItems: new Set(),
      deckPromptItems: [],
      cardIds: [],
    };
    entry.cardIds.push(card.cardId);
    for (const subItem of card.selectedSubItems || []) {
      entry.selectedSubItems.add(String(subItem));
    }
    entry.deckPromptItems.push({
      cardId: card.cardId,
      name: card.name,
      promptText: card.promptText,
      selectedSubItems: card.selectedSubItems,
    });
    byRole.set(roleId, entry);
  }

  return Array.from(byRole.values()).map((entry) => ({
    ...entry,
    selectedSubItems: Array.from(entry.selectedSubItems),
  }));
}
```

`src/cards.mjs` should update `cardScopePromptBlock(...)` or add a deck-aware prompt block builder so generated-card requests use `deckPromptItems` when present:

```js
function deckPromptBlock(catalog, deckPromptItems = []) {
  if (!deckPromptItems.length) return cardScopePromptBlock(catalog, []);
  return deckPromptItems
    .map((item) => `- ${item.name}: ${item.promptText}`)
    .join("\n");
}
```

This keeps Default deck behavior seeded from the shipped catalog while allowing duplicated/generated deck cards to edit the provider-facing prompt inside the card.

Authored cards should become card evidence:

```js
function authoredDeckCardToEvidence(card, deck) {
  return {
    id: `deck:${deck.deckId}:${card.cardId}`,
    source: "deck-authored",
    title: card.name,
    promptText: card.promptText,
    evidenceRefs: [],
    metadata: {
      deckId: deck.deckId,
      deckName: deck.deckName,
      categoryId: card.categoryId,
      cardId: card.cardId,
    },
  };
}
```

Authored and generated evidence must then pass through one budgeted selection step. Add this adapter near the existing hand-selection logic in `src/cards.mjs` or in the runtime adapter:

```js
import { selectHand } from "./cards.mjs";

export function buildDeckEvidenceCandidates({ runtimeDeck, generatedEvidence = [] }) {
  const generatedCandidates = generatedEvidence.map((card) => ({
    ...card,
    id: card.id || `generated:${card.family || card.title}`,
    source: card.source || "generated-card",
    status: "active",
    userAuthored: false,
    selectionPriority: Number(card.selectionPriority || 0),
  }));

  const authoredCandidates = runtimeDeck.authoredCards.map((card) => ({
    id: `deck:${runtimeDeck.deckId}:${card.cardId}`,
    family: "User Authored",
    title: card.name,
    promptText: card.promptText,
    evidenceRefs: [],
    source: "deck-authored",
    status: "active",
    userAuthored: true,
    selectionPriority: 2,
    tokenEstimate: estimateDeckTokens(card.promptText),
    metadata: {
      deckId: runtimeDeck.deckId,
      deckName: runtimeDeck.deckName,
      categoryId: card.categoryId,
      cardId: card.cardId,
    },
  }));

  return [...authoredCandidates, ...generatedCandidates];
}

export function selectDeckEvidenceHand({
  runtimeDeck,
  generatedEvidence,
  settings,
  behaviorPolicy,
}) {
  const candidates = buildDeckEvidenceCandidates({ runtimeDeck, generatedEvidence });
  if (candidates.length === 0) {
    return {
      cards: [],
      omitted: runtimeDeck.inactiveCards,
      metadata: {
        reason: "no-active-cards",
        deckId: runtimeDeck.deckId,
        deckName: runtimeDeck.deckName,
      },
    };
  }

  return selectHand(candidates, {
    maxCards: settings.maxCards,
    maxTokens: 700,
    behaviorPolicy,
  });
}

function estimateDeckTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}
```

Implementation detail: `selectHand(...)` currently sorts through `sortCardsForHand(...)`. Add `selectionPriority` support there so user-authored cards receive a mild boost without bypassing `maxCards` or token caps:

```js
function sortCardsForHand(a, b, policy) {
  const emphasisDelta = (EMPHASIS_PRIORITY[a.emphasis] ?? 1) - (EMPHASIS_PRIORITY[b.emphasis] ?? 1);
  if (emphasisDelta !== 0) return emphasisDelta;
  const boostedDelta = focusDelta(a, b, policy);
  if (boostedDelta !== 0) return boostedDelta;
  const selectionDelta = Number(b.selectionPriority || 0) - Number(a.selectionPriority || 0);
  if (selectionDelta !== 0) return selectionDelta;
  const priorityDelta = catalogPriority(b) - catalogPriority(a);
  if (priorityDelta !== 0) return priorityDelta;
  return String(a.id || "").localeCompare(String(b.id || ""));
}
```

Manual mode must use the same runtime deck adapter and `selectDeckEvidenceHand(...)`. It must not create fallback cards when the active deck is empty.

## Prompt Composition Changes

Update `src/prompt.mjs` so authored deck cards enter the same Card Evidence block as generated cards.

Required invariant:

```js
const cardEvidence = [
  ...generatedCardEvidence,
  ...authoredDeckCards.map((card) => authoredDeckCardToEvidence(card, runtimeDeck)),
];
```

Do not add category descriptions, card descriptions, or deck descriptions to prompt-facing blocks.

Prompt inspection metadata should include:

```js
cardDeck: {
  deckId: runtimeDeck.deckId,
  deckName: runtimeDeck.deckName,
  generatedCount: runtimeDeck.generatedCards.length,
  authoredCount: runtimeDeck.authoredCards.length,
  skippedCount: runtimeDeck.inactiveCards.length,
}
```

## Diagnostics And Privacy

Update `src/runtime/diagnostics.mjs` and the runtime journal payloads so Card System diagnostics expose structure by default and redact user-authored content.

Add a deck diagnostics helper in `src/card-decks.mjs`:

```js
import { hashJson, redact, truncate } from "./core.mjs";

export function cardDeckDiagnosticsSnapshot({
  deck,
  runtimeDeck,
  includeExcerpts = false,
}) {
  const cards = Object.values(deck.cards || {});
  return {
    deckId: deck.id,
    deckName: deck.name,
    readonly: deck.readonly === true,
    categoryCount: Object.keys(deck.categories || {}).length,
    cardCount: cards.length,
    generatedCount: runtimeDeck.generatedCards.length,
    authoredCount: runtimeDeck.authoredCards.length,
    skippedCount: runtimeDeck.inactiveCards.length,
    skippedReasons: countBy(runtimeDeck.inactiveCards.map((card) => card.reason)),
    cardHashes: Object.fromEntries(cards.map((card) => [
      card.id,
      hashJson({
        name: card.name,
        description: card.description,
        promptText: card.promptText,
        enabled: card.enabled,
        kind: card.kind,
      }),
    ])),
    excerpts: includeExcerpts ? cardDeckExcerptSnapshot(cards) : {},
  };
}

function cardDeckExcerptSnapshot(cards) {
  return Object.fromEntries(cards.map((card) => [
    card.id,
    {
      name: truncate(String(redact(card.name)), 80),
      description: truncate(String(redact(card.description)), 180),
      promptText: truncate(String(redact(card.promptText)), 360),
    },
  ]));
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = String(value || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
```

Runtime export direction:

```js
const cardDeckDiagnostics = cardDeckDiagnosticsSnapshot({
  deck: activeDeck,
  runtimeDeck,
  includeExcerpts: Boolean(settings?.diagnostics?.includeExcerpts),
});

diagnostics.cardDeck = cardDeckDiagnostics;
```

Authoring Assist diagnostics must never include raw assist input/output by default:

```js
function assistDiagnosticsSnapshot(assistState, { includeExcerpts = false } = {}) {
  return {
    status: assistState.status,
    stale: assistState.stale === true,
    requestId: assistState.requestId ? hashJson({ requestId: assistState.requestId }) : "",
    error: assistState.error ? truncate(String(redact(assistState.error)), 180) : "",
    suggestion: includeExcerpts && assistState.suggestion
      ? {
          name: truncate(String(redact(assistState.suggestion.name)), 80),
          description: truncate(String(redact(assistState.suggestion.description)), 180),
          promptText: truncate(String(redact(assistState.suggestion.promptText)), 360),
        }
      : null,
  };
}
```

Prompt inspection is separate from Export Diagnostics. Prompt inspection may show full prompt-facing Card Evidence locally; Export Diagnostics defaults to redacted structure and hashes.

## Provider Integration For Authoring Assist

Update `src/providers.mjs`.

Add a Utility role id:

```js
export const PROVIDER_ROLE_IDS = {
  // existing roles
  cardAuthoringAssist: "cardAuthoringAssist",
};
```

Schema:

```js
export const CARD_AUTHORING_ASSIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "promptText", "warnings"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    description: { type: "string", maxLength: 240 },
    promptText: { type: "string", minLength: 1, maxLength: 2000 },
    warnings: {
      type: "array",
      maxItems: 4,
      items: { type: "string", maxLength: 180 },
    },
  },
};
```

Add `src/card-authoring-assist.mjs`.

```js
export function buildCardAuthoringAssistPrompt({ card, deckName, categoryName }) {
  return [
    "You are improving a Recursion card for runtime guidance.",
    "Return concise field suggestions only.",
    "Do not recommend moving content to Author's Note or presets.",
    "Improve specificity, operational value, and instruction shape.",
    "",
    `Deck: ${deckName}`,
    `Category: ${categoryName}`,
    `Current name: ${card.name || ""}`,
    `Current description: ${card.description || ""}`,
    "Current prompt:",
    card.promptText || "",
  ].join("\n");
}

export function normalizeCardAuthoringAssistResult(result) {
  return {
    name: String(result?.name || "").trim().slice(0, 80),
    description: String(result?.description || "").trim().slice(0, 240),
    promptText: String(result?.promptText || "").trim().slice(0, 2000),
    warnings: Array.isArray(result?.warnings)
      ? result.warnings.map((warning) => String(warning).trim()).filter(Boolean).slice(0, 4)
      : [],
  };
}
```

The UI preview controls acceptance. The provider result does not directly mutate settings.

## UI Integration

Refactor `renderCardsPanel(...)` in `src/ui.mjs` or move the Card System into focused UI modules.

Expected high-level render call:

```js
renderCardSystemPanel({
  settings,
  activeDeck: getActiveCardDeck(settings),
  decks: getAllCardDecks(settings),
  lastBrief,
  onSelectDeck,
  onDeckAction,
  onCategoryAction,
  onCardAction,
  onRunAssist,
});
```

### Deck Header

Render:

```html
<div class="recursion-cardDeckHeader">
  <button class="recursion-cardDeckSelect" type="button" aria-haspopup="listbox">
    <span class="recursion-cardDeckName">Default</span>
    <span class="recursion-cardDeckState">Read-only</span>
  </button>
  <button class="recursion-iconButton" type="button" aria-label="Card deck actions">
    <span class="recursion-kebabIcon" aria-hidden="true"></span>
  </button>
</div>
```

Deck selector opens a compact list. Deck actions open a compact menu.

### Default Deck Edit Guard

Every edit entry point should route through:

```js
function requireEditableDeck(deck, action) {
  if (!deck.readonly) return { allowed: true };
  return {
    allowed: false,
    reason: "readonly-default",
    choices: [
      { id: "duplicate", label: "Duplicate to edit" },
      { id: "new", label: "New deck" },
    ],
    action,
  };
}
```

The UI should show a compact prompt when `allowed` is false. It should not silently create a duplicate.

### Card Row

Render state compactly:

```html
<button class="recursion-cardRow is-draft" type="button" data-card-id="card_123">
  <span class="recursion-cardStateIcon" aria-label="Draft card"></span>
  <span class="recursion-cardTitle">New Card</span>
  <span class="recursion-cardMeta">Needs name</span>
  <span class="recursion-cardDescriptionIcon" aria-label="Description"></span>
</button>
```

Use classes:

- `is-enabled`
- `is-disabled`
- `is-draft`
- `is-invalid`
- `is-readonly`
- `is-moving`
- `is-dragTarget`

### Card Editor

Editor fields:

- Name.
- Description.
- Prompt.
- Enabled toggle.

Actions:

- Save.
- Duplicate.
- Delete.
- Wand.
- Close.

The wand opens the assist running state and then the preview.

Editor state should be explicit and unsaved until `Save`:

```js
function createCardEditorState(card) {
  return {
    original: structuredClone(card),
    draft: structuredClone(card),
    dirty: false,
    saving: false,
    saveError: "",
    assist: {
      status: "idle",
      requestId: "",
      sourceHash: "",
      suggestion: null,
      error: "",
      stale: false,
    },
  };
}

function updateCardEditorDraft(state, patch) {
  const draft = { ...state.draft, ...patch, updatedAt: new Date().toISOString() };
  return {
    ...state,
    draft,
    dirty: JSON.stringify(draft) !== JSON.stringify(state.original),
  };
}

function closeCardEditor(state) {
  if (!state.dirty) return { close: true, prompt: null };
  return {
    close: false,
    prompt: {
      title: "Unsaved card changes",
      actions: ["save", "discard", "cancel"],
    },
  };
}

async function saveCardEditor(state, saveDeckPatch) {
  const nextState = { ...state, saving: true, saveError: "" };
  try {
    await saveDeckPatch({ card: nextState.draft });
    return {
      ...nextState,
      original: structuredClone(nextState.draft),
      dirty: false,
      saving: false,
    };
  } catch (error) {
    return {
      ...nextState,
      saving: false,
      saveError: String(error?.message || "Save failed"),
    };
  }
}
```

Deck selection saves immediately. Reorder saves when move mode exits:

```js
async function exitMoveMode({ previousDeck, draftDeck, saveDeck }) {
  try {
    await saveDeck(draftDeck);
    return { deck: draftDeck, moveMode: false, saveError: "" };
  } catch (error) {
    return {
      deck: previousDeck,
      moveMode: false,
      saveError: String(error?.message || "Save failed"),
    };
  }
}
```

Keyboard and focus handling:

```js
const FOCUSABLE_CARD_SYSTEM_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function trapFocus(container, event) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(container.querySelectorAll(FOCUSABLE_CARD_SYSTEM_SELECTOR));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function handleCardSystemKeydown(event, handlers) {
  if (event.key === "Escape") {
    event.preventDefault();
    handlers.closeTopLayer();
  } else if (event.key === "Enter") {
    handlers.activateFocused(event);
  }
}
```

Move mode must expose keyboard movement actions:

```js
function moveCardByKeyboard(deck, cardId, direction) {
  const card = deck.cards[cardId];
  if (!card) return deck;
  const order = deck.cardOrderByCategory[card.categoryId] || [];
  const index = order.indexOf(cardId);
  if (index < 0) return deck;
  const targetIndex = direction === "up" ? Math.max(0, index - 1) : Math.min(order.length - 1, index + 1);
  if (targetIndex === index) return deck;

  const next = structuredClone(deck);
  const nextOrder = next.cardOrderByCategory[card.categoryId];
  nextOrder.splice(index, 1);
  nextOrder.splice(targetIndex, 0, cardId);
  next.updatedAt = new Date().toISOString();
  return next;
}
```

### Assist Preview

Preview markup:

```html
<section class="recursion-cardAssistPreview" role="dialog" aria-label="Card suggestion preview">
  <label>
    <input type="checkbox" checked data-field="name">
    <span>Name</span>
  </label>
  <div class="recursion-previewField" data-field="name">Sharper card name</div>

  <label>
    <input type="checkbox" checked data-field="description">
    <span>Description</span>
  </label>
  <div class="recursion-previewField" data-field="description">Short UI-only description.</div>

  <label>
    <input type="checkbox" checked data-field="promptText">
    <span>Prompt</span>
  </label>
  <div class="recursion-previewField" data-field="promptText">Instruction-shaped card prompt.</div>

  <button type="button" data-action="accept-assist">Accept</button>
  <button type="button" data-action="close-assist">Close</button>
</section>
```

Accept logic:

```js
function applyAssistPreview(editorState, suggestion, checkedFields) {
  return {
    ...editorState,
    name: checkedFields.has("name") ? suggestion.name : editorState.name,
    description: checkedFields.has("description") ? suggestion.description : editorState.description,
    promptText: checkedFields.has("promptText") ? suggestion.promptText : editorState.promptText,
  };
}
```

Assist requests are side-effect-free until preview Accept:

```js
function hashAssistSource(draft) {
  return JSON.stringify({
    name: draft.name || "",
    description: draft.description || "",
    promptText: draft.promptText || "",
  });
}

function startAssist(state) {
  const requestId = `assist-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    ...state,
    assist: {
      status: "running",
      requestId,
      sourceHash: hashAssistSource(state.draft),
      suggestion: null,
      error: "",
      stale: false,
    },
  };
}

function receiveAssistResult(state, requestId, suggestion) {
  if (state.assist.requestId !== requestId) return state;
  return {
    ...state,
    assist: {
      ...state.assist,
      status: "preview",
      suggestion,
      stale: state.assist.sourceHash !== hashAssistSource(state.draft),
    },
  };
}

function failAssist(state, requestId, error) {
  if (state.assist.requestId !== requestId) return state;
  return {
    ...state,
    assist: {
      ...state.assist,
      status: "failed",
      error: String(error?.message || "Assist failed"),
    },
  };
}

function closeAssistPreview(state) {
  return {
    ...state,
    assist: {
      status: "idle",
      requestId: "",
      sourceHash: "",
      suggestion: null,
      error: "",
      stale: false,
    },
  };
}

function acceptAssistPreview(state, checkedFields) {
  if (state.assist.status !== "preview" || !state.assist.suggestion) return state;
  const draft = applyAssistPreview(state.draft, state.assist.suggestion, checkedFields);
  return closeAssistPreview(updateCardEditorDraft(state, draft));
}
```

Closing the editor should ignore any later assist response:

```js
function closeEditorAndInvalidateAssist(state) {
  return {
    ...state,
    assist: {
      status: "idle",
      requestId: "",
      sourceHash: "",
      suggestion: null,
      error: "",
      stale: false,
    },
  };
}
```

### Mobile Press-Hold

Use a focused helper:

```js
export function bindPressHoldAction(element, onHold, {
  delayMs = 520,
  moveTolerancePx = 8,
} = {}) {
  let timer = null;
  let startX = 0;
  let startY = 0;

  element.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") return;
    startX = event.clientX;
    startY = event.clientY;
    timer = window.setTimeout(() => {
      timer = null;
      if (navigator.vibrate) navigator.vibrate(10);
      onHold(event);
    }, delayMs);
  });

  element.addEventListener("pointermove", (event) => {
    if (!timer) return;
    const moved = Math.hypot(event.clientX - startX, event.clientY - startY);
    if (moved > moveTolerancePx) {
      window.clearTimeout(timer);
      timer = null;
    }
  });

  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    element.addEventListener(type, () => {
      if (timer) window.clearTimeout(timer);
      timer = null;
    });
  }
}
```

This mirrors the Saga Lorecards pattern: tap remains primary, press-hold opens actions, movement cancels the hold.

### Move Mode

Move mode should be represented by UI state rather than always-on draggable rows:

```js
function setCardMoveMode(enabled) {
  panel.classList.toggle("is-cardMoveMode", enabled);
  panel.querySelectorAll("[data-card-id]").forEach((row) => {
    row.draggable = enabled;
  });
}
```

Persist reorder through a single deck patch:

```js
function moveCard(deck, cardId, targetCategoryId, targetIndex) {
  const next = structuredClone(deck);
  for (const ids of Object.values(next.cardOrderByCategory)) {
    const index = ids.indexOf(cardId);
    if (index >= 0) ids.splice(index, 1);
  }
  next.cards[cardId].categoryId = targetCategoryId;
  next.cardOrderByCategory[targetCategoryId].splice(targetIndex, 0, cardId);
  next.updatedAt = new Date().toISOString();
  return next;
}
```

## Styling

Update Recursion styles near the existing Cards panel rules.

Baseline styling:

```css
.recursion-cardDeckHeader {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  padding: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.recursion-cardDeckSelect,
.recursion-cardRow,
.recursion-categoryRow {
  min-width: 0;
  min-height: 34px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(18, 20, 24, 0.92);
  color: var(--SmartThemeBodyColor, #d8dde5);
}

.recursion-cardDeckSelect {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  padding: 5px 8px;
  text-align: left;
}

.recursion-cardDeckName,
.recursion-cardTitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recursion-cardDeckState,
.recursion-cardMeta {
  color: rgba(216, 221, 229, 0.68);
  font-size: 0.78rem;
}

.recursion-cardRow {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto auto;
  gap: 6px;
  align-items: center;
  padding: 5px 7px;
}

.recursion-cardRow.is-draft .recursion-cardStateIcon {
  background: #d6a84f;
}

.recursion-cardRow.is-disabled {
  opacity: 0.58;
}

.recursion-cardRow.is-invalid {
  border-color: rgba(236, 112, 99, 0.8);
}

.recursion-cardStateIcon {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #6fa97a;
}

.recursion-kebabIcon::before {
  content: "\\22EE";
  font-size: 1rem;
  line-height: 1;
}

.recursion-cardAssistPreview {
  display: grid;
  gap: 8px;
  max-height: min(70vh, 520px);
  overflow: auto;
  padding: 8px;
}

.recursion-cardMoveHandle {
  inline-size: 28px;
  block-size: 28px;
  display: inline-grid;
  place-items: center;
  cursor: grab;
}

@media (max-width: 640px) {
  .recursion-cardRow {
    grid-template-columns: 18px minmax(0, 1fr) auto;
  }

  .recursion-cardMeta {
    display: none;
  }
}
```

Style constraints:

- Compact row height.
- No nested cards.
- No marketing hero elements.
- No decorative gradient orbs.
- Mobile row text must not overflow.
- Touch targets must remain usable without making the panel visually heavy.
- Desktop hover descriptions must have mobile alternatives.

## Tests

### Data Model Tests

Add `tools/scripts/test-card-decks.mjs`.

Cover:

- Default deck is read-only.
- Default deck id is stable.
- Card deck settings version is `1`.
- Custom deck normalization removes dangling order ids.
- Active deck falls back to Default when missing.
- Old `cardScope` is removed after settings normalization.
- New card is draft.
- `New Card` with prompt remains draft.
- Empty authored prompt is not runnable.
- Disabled card is not runnable.
- Valid named authored prompt is runnable.
- Zero runnable cards produces zero card work.
- Duplicate deck names become `Name Copy`, then `Name Copy 2`.
- Duplicate runnable card names produce `duplicate-card-name` warning.
- Custom decks serialize as plain JSON without bundled Default deck data.

Example assertion:

```js
const card = {
  id: "card_1",
  categoryId: "cat_1",
  name: "New Card",
  description: "",
  promptText: "Keep replies grounded in the immediate scene.",
  enabled: true,
  kind: "authored",
};

assert.equal(getDeckCardStatus(card).runnable, false);
assert.equal(getDeckCardStatus(card).reason, "draft-name");
```

### Runtime Tests

Update:

- `tools/scripts/test-cards.mjs`
- `tools/scripts/test-runtime-card-packet.mjs`
- `tools/scripts/test-runtime.mjs` if runtime packet coverage lives there.

Cover:

- Empty active deck skips card provider calls.
- Empty active deck still allows Enhancements path.
- Authored cards become Card Evidence candidates.
- Authored cards pass through `selectHand(...)` and respect `maxCards`.
- Authored cards receive mild `selectionPriority` without bypassing token caps.
- Omitted authored cards record `max-cards` or `token-budget`.
- Descriptions do not appear in prompt text.
- Generated Default deck cards still route to existing generated-card calls.
- Manual mode does not synthesize fallback cards.

Example test shape:

```js
assert.equal(packet.cardEvidence.length, 0);
assert.equal(packet.metadata.cardDeck.reason, "no-active-cards");
assert.equal(packet.postGeneration.enhancements.enabled, true);
```

### UI Tests

Update `tools/scripts/test-ui.mjs`.

Cover:

- Cards panel renders deck selector.
- Default deck shows read-only state.
- Default deck edit action shows duplicate/new prompt.
- Custom deck renders card/category edit controls.
- Draft card shows compact draft state.
- Dirty editor close shows Save, Discard, Cancel.
- Save failure preserves editor draft and shows `Save failed`.
- Reorder save failure restores previous persisted order.
- Deck selector saves active deck immediately.
- Assist preview checkboxes are checked by default.
- Accept applies only checked fields.
- Close applies no fields.
- Closing editor invalidates pending assist result.
- Stale assist result is marked when editor fields changed while running.
- Failed assist preserves editor state and retries with current fields.
- Mobile press-hold opens card actions.
- Move mode toggles drag handles.
- Keyboard Enter activates focused row or menu item.
- Keyboard Escape closes the topmost Card System layer.
- Editor and assist preview trap focus.
- Keyboard move actions reorder a card up/down.

### Provider Tests

Update provider tests or add coverage where provider schemas are validated.

Cover:

- `cardAuthoringAssist` role is registered.
- Assist result schema rejects extra properties.
- Assist result normalization trims fields and caps warnings.

### Diagnostics Tests

Update `tools/scripts/test-runtime.mjs`, `tools/scripts/test-storage.mjs`, or a focused diagnostics script.

Cover:

- Export Diagnostics includes active deck id/name and counts.
- Export Diagnostics redacts custom card `promptText` by default.
- Export Diagnostics redacts category and card descriptions by default.
- Export Diagnostics redacts assist input/output by default.
- Excerpt mode includes truncated redacted excerpts.
- Prompt inspection can still show full prompt-facing Card Evidence locally.

Example assertion:

```js
const diagnostics = cardDeckDiagnosticsSnapshot({
  deck: customDeckWithSecretPrompt,
  runtimeDeck,
  includeExcerpts: false,
});

const serialized = JSON.stringify(diagnostics);
assert(!serialized.includes("private card prompt"), "default diagnostics redact custom card prompt");
assert(serialized.includes("cardHashes"), "default diagnostics include card hashes");
```

## Documentation Updates

Update `docs/design/UI_SPEC.md`:

- Cards dropdown becomes Card System panel.
- Global deck selector.
- Mobile press-hold and move mode.
- Compact visual states.

Update `docs/design/CARD_SYSTEM_SPEC.md`:

- Card Deck model.
- Default deck read-only.
- Authored versus generated cards.
- Zero active cards.
- Draft cards.
- Runtime adapter.

Update `docs/architecture/PROMPT_COMPOSITION_SPEC.md`:

- Authored card evidence source.
- Descriptions never injected.
- Empty deck has no Card Evidence block.
- Enhancements are independent of cards.

## Verification Commands

Run focused tests first:

```powershell
node tools/scripts/test-card-decks.mjs
node tools/scripts/test-card-scope.mjs
node tools/scripts/test-cards.mjs
node tools/scripts/test-runtime-card-packet.mjs
node tools/scripts/test-ui.mjs
```

Then run the broader repo gate used by Recursion:

```powershell
npm.cmd test
```

If PowerShell blocks npm shims, use `npm.cmd` rather than `npm`.

For UI behavior that cannot be proven by unit tests, run the local SillyTavern extension and verify:

- Desktop deck selector.
- Default duplicate-to-edit guard.
- Custom deck editing.
- Mobile viewport press-hold.
- Move mode drag handles.
- Assist preview accept/close behavior.
- Empty deck generation with Enhancements enabled.

## Implementation Order

### Step 1: Add Card Deck Data Model

Files:

- `src/card-decks.mjs`
- `tools/scripts/test-card-decks.mjs`
- `src/settings.mjs`

Work:

- [ ] Add Default deck factory from current `CARD_SCOPE_CATALOG`.
- [ ] Add `CARD_DECK_SETTINGS_VERSION = 1`.
- [ ] Add custom deck normalization, id repair, order repair, and JSON serialization helpers.
- [ ] Add draft/runnable status helpers.
- [ ] Add unique deck/card name helpers and duplicate-name warning helpers.
- [ ] Add settings defaults, one-time `cardScope` normalization, and removal of persisted `cardScope`.
- [ ] Add focused data-model tests.

Checkpoint:

```powershell
node tools/scripts/test-card-decks.mjs
node tools/scripts/test-settings.mjs
```

### Step 2: Runtime Adapter And Zero-Card Semantics

Files:

- `src/card-decks.mjs`
- `src/runtime.mjs`
- `src/cards.mjs`
- `src/prompt.mjs`
- runtime tests

Work:

- [ ] Build runtime deck from active settings.
- [ ] Replace old minimum-card guard.
- [ ] Group generated deck cards by role and pass deck prompt items into generated-card requests.
- [ ] Convert authored cards into Card Evidence candidates.
- [ ] Route authored and generated evidence through `selectDeckEvidenceHand(...)`.
- [ ] Add `selectionPriority` support to `sortCardsForHand(...)`.
- [ ] Preserve generated card route for Default deck.
- [ ] Ensure zero active cards skips card calls and continues non-card features.

Checkpoint:

```powershell
node tools/scripts/test-cards.mjs
node tools/scripts/test-runtime-card-packet.mjs
```

### Step 3: Card System UI Shell

Files:

- `src/ui.mjs`
- optional `src/ui/card-system-panel.mjs`
- optional `src/ui/card-system-touch.mjs`
- `tools/scripts/test-ui.mjs`

Work:

- [ ] Replace card scope selector with deck selector.
- [ ] Add deck action menu.
- [ ] Render category and card rows.
- [ ] Render read-only/draft/disabled/invalid states.
- [ ] Add duplicate-card-name warning state.
- [ ] Add Default edit guard.

Checkpoint:

```powershell
node tools/scripts/test-ui.mjs
```

### Step 4: Editing, Reorder, And Mobile Actions

Files:

- UI files from Step 3
- `src/card-decks.mjs`
- `tools/scripts/test-ui.mjs`

Work:

- [ ] Add card editor with explicit Save and dirty close prompt.
- [ ] Add category editor with explicit Save and dirty close prompt.
- [ ] Add deck create/rename/duplicate/delete.
- [ ] Add deck selector immediate-save behavior.
- [ ] Add press-hold action helper.
- [ ] Add explicit move mode.
- [ ] Add keyboard move actions.
- [ ] Add focus trapping and Escape/Enter behavior.
- [ ] Persist reorder patches when move mode exits.
- [ ] Restore previous persisted order after reorder save failure.

Checkpoint:

```powershell
node tools/scripts/test-card-decks.mjs
node tools/scripts/test-ui.mjs
```

### Step 5: Authoring Assist

Files:

- `src/providers.mjs`
- `src/card-authoring-assist.mjs`
- UI editor files
- provider tests
- UI tests

Work:

- [ ] Register Utility role.
- [ ] Add assist prompt builder and result normalization.
- [ ] Add editor wand action.
- [ ] Add preview with checked fields.
- [ ] Add accept and close behavior.
- [ ] Add stale-result detection when editor fields change during assist.
- [ ] Add retry behavior that uses current editor fields.
- [ ] Invalidate pending assist results when the editor closes.
- [ ] Ensure assist cannot mutate settings directly.

Checkpoint:

```powershell
node tools/scripts/test-ui.mjs
node tools/scripts/test-providers.mjs
```

### Step 6: Diagnostics, Privacy, And Import/Export Boundary

Files:

- `src/card-decks.mjs`
- `src/runtime/diagnostics.mjs`
- `src/runtime.mjs`
- `tools/scripts/test-runtime.mjs`
- `tools/scripts/test-storage.mjs`
- `tools/scripts/test-ui.mjs`

Work:

- [ ] Add `cardDeckDiagnosticsSnapshot(...)`.
- [ ] Add `assistDiagnosticsSnapshot(...)`.
- [ ] Wire Card System diagnostics into Export Diagnostics.
- [ ] Redact card prompts, card descriptions, category descriptions, and assist input/output by default.
- [ ] Allow redacted truncated excerpts only when `settings.diagnostics.includeExcerpts === true`.
- [ ] Prove prompt inspection still shows prompt-facing Card Evidence locally.
- [ ] Keep Import Deck and Export Deck controls out of the V1 UI.
- [ ] Add JSON portability tests for custom deck serialization.

Checkpoint:

```powershell
node tools/scripts/test-runtime.mjs
node tools/scripts/test-storage.mjs
node tools/scripts/test-ui.mjs
```

### Step 7: Documentation And Full Verification

Files:

- `docs/design/UI_SPEC.md`
- `docs/design/CARD_SYSTEM_SPEC.md`
- `docs/architecture/PROMPT_COMPOSITION_SPEC.md`

Work:

- [ ] Update design contract.
- [ ] Update card runtime contract.
- [ ] Update prompt composition contract.
- [ ] Run focused and broad verification.
- [ ] Run live/mobile smoke if the UI changed in a way unit tests cannot cover.

Checkpoint:

```powershell
npm.cmd test
```

## Completion Criteria

The feature is complete when:

- Default deck is read-only and selectable.
- Custom decks can be created, renamed, duplicated, deleted, and selected.
- Categories can be created, renamed, described, reordered, and deleted.
- Cards can be created, renamed, described, prompted, moved, reordered, duplicated, deleted, enabled, and disabled.
- Draft cards never run.
- `New Card` with prompt still does not run until renamed.
- Zero active cards skips card calls and preserves non-card features.
- Authored cards appear as Card Evidence candidates and respect `maxCards`/token selection.
- Generated deck cards preserve the Default provider route and use editable deck prompt items in duplicated decks.
- Descriptions never enter prompt-facing output.
- Export Diagnostics redacts custom deck/card text by default.
- Import/export UI is absent in V1 while custom decks remain JSON-portable.
- Old `cardScope` settings are normalized into `cardDecks.version === 1` and removed on save.
- Duplicate deck names are made unique and duplicate runnable card names show a compact warning.
- Mobile press-hold and move mode work.
- Keyboard action, focus trap, Escape, Enter, and keyboard movement behavior work.
- Editor dirty close, save failure, reorder failure, and deck-selector immediate save behavior work.
- Authoring Assist preview accepts checked fields only.
- Authoring Assist cancellation, stale-result, failure, and retry behavior work.
- Tests cover model, runtime, provider, and UI behavior.
- Tests cover diagnostics redaction and custom-deck JSON portability.
- Design docs and architecture docs match the implemented contract.
