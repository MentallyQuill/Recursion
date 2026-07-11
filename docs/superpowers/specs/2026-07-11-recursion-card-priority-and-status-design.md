# Recursion Card Priority And Status Design

## Goal

Add a third per-card selection state, `Priority`, and route Card System feedback through the main Recursion bar status area instead of local notice rows inside the Cards dropdown.

This design keeps the Card Decks surface compact while making state changes more legible:

- Inactive cards do not run.
- Active cards are eligible for normal Auto backfill or Manual forcing.
- Priority cards are forced first in Auto, then Auto backfills remaining hand slots from Active cards up to the effective `Max Cards` budget.
- Card System action feedback appears in the main Recursion bar status text and mobile status drawer.
- The two transient yellow Cards-dropdown notice rows are removed.

## Product Direction

Priority is a semi-auto steering signal, not a third top-level mode. The distinction is:

- **Manual:** only use what the user selected, capped by `Max Cards`.
- **Auto + Priority:** use these Priority cards first, then let Auto choose the rest.

This keeps Auto useful while giving users a light way to force a few important cards without opening another mode or adding more per-card buttons.

Priority must be deterministic user intent. A runnable Priority card should enter the turn hand before normal Active cards unless it is blocked by schema, freshness, token, or `Max Cards` limits.

## Interaction Contract

### Auto Mode

Clicking or tapping a runnable card cycles:

```text
Inactive -> Active -> Priority -> Inactive
```

The row status slot communicates the state and the next action:

```js
const CARD_SELECTION_NEXT_COPY = {
  off: 'Inactive. Tap to enable.',
  active: 'Active. Tap to prioritize.',
  priority: 'Priority: forced into Auto hand before backfill. Tap to disable.'
};
```

Draft cards cannot enter Active or Priority. Tapping a draft card routes a transient bar status:

```text
Draft card needs editing before it can run.
```

### Manual Mode

Clicking or tapping a runnable card cycles:

```text
Inactive -> Active -> Inactive
```

Manual treats Active cards as forced directly. Priority state is preserved in storage but does not add a second force layer while Manual is active.

When a card is Priority in storage and the UI is viewed in Manual, it may render as Active with a tooltip note:

```text
Priority is used in Auto. Manual forces active cards directly.
```

Switching back to Auto restores the Priority visual state and runtime behavior.

### All Action

The Cards header `All` action must never set cards to Priority.

- In Auto, `All` sets every runnable card in the active editable deck to Active and leaves draft cards unchanged.
- In Manual, `All` activates up to `Max Cards` by deck order.
- Default/read-only decks keep existing read-only behavior.

## Visual Language

The state icon remains in the existing card status slot. Do not add a new Priority button.

| State | Icon | Row Treatment | Tooltip |
| --- | --- | --- | --- |
| Inactive | muted X | muted row, no cyan rail | `Inactive. Tap to enable.` |
| Active | cyan check | current cyan left rail/card highlight | `Active. Tap to prioritize.` |
| Priority | bright cyan up-arrow | brighter cyan left rail/card highlight than Active | `Priority: forced into Auto hand before backfill.` |
| Draft | compact draft metadata icon | muted/draft row treatment | `Draft card needs editing before it will run.` |

Priority uses bright cyan, not amber. Amber is reserved for warnings and repairable caution; Priority is an intentional Recursion state. The state must not rely on color alone: the up-arrow icon carries the meaning for mobile, low-brightness screens, and theme variance.

Implementation sketch:

```js
function cardSelectionState(card) {
  const stored = String(card?.selectionState || '').trim().toLowerCase();
  if (stored === 'priority') return 'priority';
  if (stored === 'off' || card?.enabled === false) return 'off';
  return 'active';
}

function cardStateIconKind(card, mode = 'auto') {
  const status = getDeckCardStatus(card);
  if (!status.runnable) {
    return ['draft-name', 'needs-name', 'needs-prompt'].includes(status.reason) ? 'draft' : 'x';
  }
  const state = cardSelectionState(card);
  if (state === 'priority' && mode === 'auto') return 'arrow-up';
  if (state === 'off') return 'x';
  return 'check';
}

function cardStateClass(card, mode = 'auto') {
  const status = getDeckCardStatus(card);
  if (!status.runnable) return 'is-draft';
  const state = cardSelectionState(card);
  if (state === 'priority' && mode === 'auto') return 'is-priority';
  if (state === 'off') return 'is-inactive';
  return 'is-active';
}
```

CSS direction:

```css
.recursion-card-deck-card.is-inactive {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #d8d8d8) 64%, transparent);
}

.recursion-card-deck-card.is-active {
  border-left-color: var(--recursion-primary, #65d6e8);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--recursion-primary, #65d6e8) 82%, transparent);
}

.recursion-card-deck-card.is-priority {
  border-left-color: #8eefff;
  box-shadow:
    inset 3px 0 0 #8eefff,
    inset 0 0 0 1px color-mix(in srgb, #8eefff 32%, transparent);
}

.recursion-card-deck-card.is-priority .recursion-card-deck-card-status {
  color: #8eefff;
}

.recursion-card-deck-card.is-inactive .recursion-card-deck-card-status {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #d8d8d8) 46%, transparent);
}
```

## Data Contract

Move card selection to a single explicit field:

```ts
type CardSelectionState = "off" | "active" | "priority";

type CardDeckCard = {
  id: string;
  name: string;
  description: string;
  promptText: string;
  categoryId: string;
  selectionState: CardSelectionState;
  // deprecated after normalization: enabled?: boolean;
};
```

Pre-alpha normalization can update in place:

```js
function normalizeCardSelectionState(raw) {
  const state = String(raw?.selectionState || '').trim().toLowerCase();
  if (state === 'off' || state === 'active' || state === 'priority') return state;
  return raw?.enabled === false ? 'off' : 'active';
}

function normalizeCards(value, categories, now) {
  // Existing normalization keeps ids, names, descriptions, and prompts.
  // Add:
  card.selectionState = normalizeCardSelectionState(raw);
  delete card.enabled;
}
```

If removing `enabled` in one pass is too disruptive, the first implementation may keep writing both fields but all new logic must read `selectionState` first. Since Recursion is pre-alpha, the target contract is one coherent `selectionState`, not permanent compatibility shims.

## Runtime Contract

Priority applies only in Auto. Manual keeps its strict selected-card behavior.

Runtime should derive three sets from the active Card Deck:

```js
function deckRuntimeSelection(deck, settings) {
  const mode = settings?.mode === 'manual' ? 'manual' : 'auto';
  const cards = orderedDeckCardsAcrossCategories(deck)
    .filter((card) => getDeckCardStatus(card).runnable);

  const priorityCards = mode === 'auto'
    ? cards.filter((card) => cardSelectionState(card) === 'priority')
    : [];

  const activeCards = cards.filter((card) => {
    const state = cardSelectionState(card);
    if (mode === 'manual') return state === 'active' || state === 'priority';
    return state === 'active';
  });

  return { priorityCards, activeCards };
}
```

Hand selection should then use Priority as a forced-first list:

```js
export function selectHand(cards = [], {
  maxCards = 6,
  maxTokens = 700,
  behaviorPolicy = null,
  forcedFamilies = [],
  forcedCardIds = []
} = {}) {
  const forcedOrder = new Map(forcedCardIds.map((id, index) => [id, index]));
  const sorted = sortCardsForHand(cards).sort((a, b) => {
    const aForced = forcedOrder.has(a.id);
    const bForced = forcedOrder.has(b.id);
    if (aForced !== bForced) return aForced ? -1 : 1;
    if (aForced && bForced) return forcedOrder.get(a.id) - forcedOrder.get(b.id);
    return 0;
  });

  // Existing max-card and token checks still apply.
}
```

When Priority count exceeds the effective card budget:

- Do not block the user from setting Priority.
- Runtime includes the first `Max Cards` Priority cards by category/card order.
- Runtime does not backfill Active cards when Priority fills the budget.
- Omitted Priority cards receive `priority-over-max-cards`.
- Main bar status reports the overflow.

```js
function priorityOverflowStatus(priorityCount, maxCards) {
  if (priorityCount <= maxCards) return '';
  return `${priorityCount} priority cards, Max Cards is ${maxCards}. Top ${maxCards} will run.`;
}
```

Diagnostic shape:

```json
{
  "diagnostics": ["priority-card-cap"],
  "omitted": [
    {
      "id": "card-relationship-pressure",
      "reason": "priority-over-max-cards"
    }
  ]
}
```

## Status Feedback Contract

The Cards dropdown should stop owning transient success/warning rows. Significant Card System actions route through the main Recursion bar status text and the mobile status drawer.

Remove these local notice rows from `renderCardsPanel(...)`:

```js
const noticeNode = el('div', {
  className: 'recursion-card-scope-notice',
  text: notice,
  attrs: { role: 'status' }
});
```

The Cards dropdown may still render persistent workflow instructions where the control itself needs them, such as the typed-delete field:

```text
Type delete to confirm Card Deck deletion.
```

But action outcomes and transient warnings belong in the bar.

### Status Helper

Extend the existing UI transient status pattern. The repo already has `createUiActionStatus()` for failures. Add a success/info path or a dedicated Card System wrapper:

```js
function createCardSystemStatus(uiActionStatus) {
  return {
    show(label, severity = 'info') {
      uiActionStatus.set({ severity, label: cleanText(label, 'Card System updated.') });
    },
    clear() {
      uiActionStatus.clear();
    }
  };
}
```

If `createUiActionStatus()` remains the shared helper, expand it:

```js
export function createUiActionStatus() {
  let current = null;
  return {
    set(label, severity = 'info') {
      current = {
        severity: ['info', 'success', 'warning'].includes(severity) ? severity : 'info',
        label: safeMessage(label || 'Action complete.')
      };
      return current;
    },
    setFailure(error, fallback) {
      current = normalizeUiActionFailure(error, fallback);
      return current;
    },
    clear() {
      current = null;
    },
    current() {
      return current ? { ...current } : null;
    }
  };
}
```

The main bar rendering should prefer transient UI action status over idle standby copy, but never over active runtime work:

```js
function currentStepTextForRender(view, model, uiActionStatus) {
  if (model.currentStepText) return model.currentStepText;
  const actionStatus = uiActionStatus.current();
  if (actionStatus?.label) return actionStatus.label;
  return model.standbyStatusText || 'Ready for Recursion.';
}
```

The mobile status drawer must use the same selected text so mobile gets identical feedback.

### Status Copy

Use short committed-action copy:

```js
const CARD_SYSTEM_STATUS_COPY = {
  cardInactive: 'Card disabled.',
  cardActive: 'Card enabled.',
  cardPriority: 'Card prioritized.',
  cardPriorityCleared: 'Priority removed.',
  draftBlocked: 'Draft card needs editing before it can run.',
  priorityOverflow: ({ priorityCount, maxCards }) =>
    `${priorityCount} priority cards, Max Cards is ${maxCards}. Top ${maxCards} will run.`,
  cardSaved: 'Card saved.',
  cardEditCanceled: 'Card edit canceled.',
  cardDuplicated: 'Card duplicated.',
  cardDeleted: 'Card deleted.',
  cardMoved: 'Card moved.',
  categorySaved: 'Category saved.',
  categoryMovedUp: 'Category moved up.',
  categoryMovedDown: 'Category moved down.',
  categoryDeleted: 'Category deleted.',
  deckSelected: 'Card Deck selected.',
  deckCreated: 'New Card Deck created.',
  deckDuplicated: 'Card Deck duplicated.',
  deckSaved: 'Card Deck saved.',
  deckDeleteArmed: 'Type delete to confirm Card Deck deletion.',
  deckDeleted: 'Card Deck deleted.',
  defaultReadonly: 'Default Card Deck is read-only. Duplicate it to edit.'
};
```

Do not emit status for navigation-only events:

- expanding/collapsing categories;
- hovering controls;
- focusing fields;
- typing before save;
- opening/closing dropdowns.

Emit status for committed state changes:

- card Active/Inactive/Priority state changes;
- card/category/deck create, duplicate, save, delete, move;
- typed delete armed/canceled/confirmed;
- wand suggestion accepted or closed;
- priority overflow caused by state change or `Max Cards` change.

## Priority Overflow UX

Overflow is allowed. Blocking Priority toggles would make mobile editing brittle and force the user to resolve ordering before finishing intent capture.

When Priority count exceeds effective `Max Cards`:

1. Show main bar status: `7 priority cards, Max Cards is 5. Top 5 will run.`
2. Keep all Priority rows visually marked as Priority.
3. Add tooltip to overflow rows: `Priority overflow. Reorder cards or raise Max Cards.`
4. Runtime includes the first `Max Cards` Priority cards by category order and card order.
5. Runtime omits the rest with `priority-over-max-cards`.

This makes drag/reorder meaningful: the user can decide which Priority cards win by moving them higher.

## Accessibility

- The status slot keeps `role="status"` and `aria-live="polite"`.
- Card state icons must have explicit `aria-label` copy:
  - `Inactive card`
  - `Active card`
  - `Priority card`
  - `Draft card`
- Card row `aria-pressed` can be avoided because the row has three states. Prefer `aria-label` or `aria-describedby` that names state and next action.
- Tooltips mirror the action/state copy.
- Keyboard interaction should use the same state cycle as click/tap when the row receives Enter/Space.

Example:

```js
function cardStateAria(card, mode) {
  const state = cardSelectionState(card);
  if (state === 'priority' && mode === 'auto') {
    return 'Priority card. Forced into Auto hand before backfill. Press to disable.';
  }
  if (state === 'active') return mode === 'auto'
    ? 'Active card. Press to prioritize.'
    : 'Active card. Press to disable.';
  return 'Inactive card. Press to enable.';
}
```

## Testing And Validation

Deterministic tests:

- Card normalization migrates `enabled: false` to `selectionState: "off"` and missing/true enabled to `"active"`.
- Card state cycle is `off -> active -> priority -> off` in Auto.
- Card state cycle is `off -> active -> off` in Manual.
- Draft cards cannot become Active or Priority.
- `All` activates runnable cards but does not prioritize them.
- Priority overflow produces `priority-card-cap` and `priority-over-max-cards`.
- `selectHand(...)` includes forced Priority card ids before normal Active cards.
- Runtime does not backfill Active cards when Priority count fills `Max Cards`.

UI/static tests:

- Cards dropdown no longer renders `.recursion-card-scope-notice` transient notice rows.
- Card rows render `is-inactive`, `is-active`, and `is-priority` classes.
- Priority rows render up-arrow SVG in the status slot.
- Status copy routes to `[data-recursion-status]` and `[data-recursion-mobile-status-text]`.
- Category expand/collapse does not emit status.
- Card state toggles emit the expected bar status copy.

Playwright/live checks:

- Desktop: open Cards, expand a category, click card row through Inactive, Active, Priority, and back; verify icon, class, tooltip, and main bar status each step.
- Mobile viewport: tap uses the same cycle, long-press still opens edit, and Priority visual remains compact.
- Manual mode: card tap cycles only Inactive/Active and Priority tooltip explains Auto-only behavior.
- Priority overflow: set `Max Cards` low, prioritize more cards than cap, verify main bar overflow copy and final hand contains only top ordered Priority cards.
- Refresh heartbeat does not close the deck selector or erase the transient bar status before timeout/next real status.

## Implementation Plan

1. **Update card data model**
   - Add `selectionState` normalization to `src/card-decks.mjs`.
   - Keep `enabled` only as a migration input; new writes use `selectionState`.
   - Add helpers: `cardSelectionState`, `isCardActiveForMode`, `isCardPriorityForMode`, and `nextCardSelectionState`.

2. **Update Card Deck UI state rendering**
   - Replace enabled/runnable-only status logic in `src/ui.mjs` with three-state rendering.
   - Add up-arrow icon support to `cardSystemIconSvg(...)` if not already present.
   - Add inactive/active/priority classes and tooltips.
   - Update keyboard row handling to use the same state cycle.

3. **Route Card System feedback to main bar**
   - Expand `src/ui/action-status.mjs` to support success/info statuses.
   - Add a `showCardSystemStatus(...)` helper inside UI mount code.
   - Remove transient card notice rows from `renderCardsPanel(...)`.
   - Replace `applyCardDeckSettings(..., notice)` paths with `applyCardDeckSettings(...); showCardSystemStatus(copy)`.
   - Ensure mobile status drawer receives the same transient status text.

4. **Implement Priority runtime selection**
   - Derive Priority card ids from the active deck in Auto.
   - Pass `forcedCardIds` into `selectHand(...)`.
   - Keep Manual forced behavior separate.
   - Add overflow diagnostics and omitted reasons.

5. **Update docs**
   - Update `docs/design/CARD_SYSTEM_SPEC.md` with `selectionState` and Priority semantics.
   - Update `docs/design/UI_SPEC.md` to remove local Cards notice behavior and document main-bar Card System feedback.
   - Update technical card/hand docs for Priority-first Auto selection and overflow diagnostics.

6. **Add tests and live proof**
   - Add deterministic card-deck/model tests.
   - Add UI static and fake-DOM tests.
   - Extend Card System Playwright proof for desktop and mobile Priority state cycle.
   - Run full repo tests.
   - Sync served SillyTavern extension copy and run live Card System proof.

## Open Decisions

No design blockers remain. The implementation should use:

- three-state card row instead of a separate Priority button;
- bright cyan Priority visual language;
- allowed Priority overflow with deterministic order and status feedback;
- main Recursion bar status as the only transient action feedback surface.
