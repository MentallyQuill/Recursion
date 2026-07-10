# Recursion Card System Integration Implementation Plan

> **For <developer>:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan step-by-step.

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
  const customCardDecks = normalizeCustomDecks(input.customCardDecks);
  const activeCardDeckId = resolveActiveDeckId(input.activeCardDeckId, customCardDecks);
  return { activeCardDeckId, customCardDecks };
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

## Settings Integration

Update `src/settings.mjs`.

Add defaults:

```js
import { DEFAULT_CARD_DECK_ID } from "./card-decks.mjs";

const DEFAULT_SETTINGS = {
  // existing settings
  cardDecks: {
    activeCardDeckId: DEFAULT_CARD_DECK_ID,
    customCardDecks: {},
  },
};
```

Normalize on load/save:

```js
import { normalizeCardDeckSettings } from "./card-decks.mjs";

export function normalizeSettings(input = {}) {
  const normalized = {
    ...DEFAULT_SETTINGS,
    ...input,
  };

  normalized.cardDecks = normalizeCardDeckSettings(normalized.cardDecks);
  return normalized;
}
```

Remove the old required-active-card assumption from settings normalization. If the current `cardScope` field still exists, replace internal callers with `cardDecks`. Because Recursion is pre-alpha, do not keep a long-lived compatibility shim.

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

Manual mode must use the same runtime deck adapter. It must not create fallback cards when the active deck is empty.

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
    ...
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

Required selectors:

```css
.recursion-cardDeckHeader {}
.recursion-cardDeckSelect {}
.recursion-cardDeckName {}
.recursion-cardDeckState {}
.recursion-categoryRow {}
.recursion-cardRow {}
.recursion-cardRow.is-draft {}
.recursion-cardRow.is-disabled {}
.recursion-cardRow.is-invalid {}
.recursion-cardStateIcon {}
.recursion-cardMeta {}
.recursion-cardAssistPreview {}
.recursion-cardMoveHandle {}
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
- Custom deck normalization removes dangling order ids.
- Active deck falls back to Default when missing.
- New card is draft.
- `New Card` with prompt remains draft.
- Empty authored prompt is not runnable.
- Disabled card is not runnable.
- Valid named authored prompt is runnable.
- Zero runnable cards produces zero card work.

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
- Authored cards become Card Evidence.
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
- Assist preview checkboxes are checked by default.
- Accept applies only checked fields.
- Close applies no fields.
- Mobile press-hold opens card actions.
- Move mode toggles drag handles.

### Provider Tests

Update provider tests or add coverage where provider schemas are validated.

Cover:

- `cardAuthoringAssist` role is registered.
- Assist result schema rejects extra properties.
- Assist result normalization trims fields and caps warnings.

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

1. Add Default deck factory from current `CARD_SCOPE_CATALOG`.
2. Add custom deck normalization.
3. Add draft/runnable status helpers.
4. Add settings defaults and normalization.
5. Add focused tests.

Checkpoint:

```powershell
node tools/scripts/test-card-decks.mjs
```

### Step 2: Runtime Adapter And Zero-Card Semantics

Files:

- `src/card-decks.mjs`
- `src/runtime.mjs`
- `src/cards.mjs`
- `src/prompt.mjs`
- runtime tests

Work:

1. Build runtime deck from active settings.
2. Replace old minimum-card guard.
3. Convert authored cards into card evidence.
4. Preserve generated card route for Default deck.
5. Ensure zero active cards skips card calls and continues non-card features.

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

1. Replace card scope selector with deck selector.
2. Add deck action menu.
3. Render category and card rows.
4. Render read-only/draft/disabled/invalid states.
5. Add Default edit guard.

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

1. Add card editor.
2. Add category editor.
3. Add deck create/rename/duplicate/delete.
4. Add press-hold action helper.
5. Add explicit move mode.
6. Persist deck patches through settings.

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

1. Register Utility role.
2. Add assist prompt builder and result normalization.
3. Add editor wand action.
4. Add preview with checked fields.
5. Add accept and close behavior.
6. Ensure assist cannot mutate settings directly.

Checkpoint:

```powershell
node tools/scripts/test-ui.mjs
node tools/scripts/test-providers.mjs
```

### Step 6: Documentation And Full Verification

Files:

- `docs/design/UI_SPEC.md`
- `docs/design/CARD_SYSTEM_SPEC.md`
- `docs/architecture/PROMPT_COMPOSITION_SPEC.md`

Work:

1. Update design contract.
2. Update card runtime contract.
3. Update prompt composition contract.
4. Run focused and broad verification.
5. Run live/mobile smoke if the UI changed in a way unit tests cannot cover.

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
- Authored cards appear as Card Evidence.
- Descriptions never enter prompt-facing output.
- Mobile press-hold and move mode work.
- Authoring Assist preview accepts checked fields only.
- Tests cover model, runtime, provider, and UI behavior.
- Design docs and architecture docs match the implemented contract.
