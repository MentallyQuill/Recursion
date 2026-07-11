# Recursion Card Drag Handles Design

## Goal

Replace Card System movement buttons with compact drag handles.

Current movement controls are too mechanical for the Cards dropdown:

- Categories expose separate up/down buttons.
- Cards expose a move-mode button.
- Move mode adds target buttons and cancel state.
- These controls consume scarce mobile action-rail space and compete with edit/delete actions.

The new design uses handle-driven drag and drop:

- Category handles reorder categories.
- Card handles reorder cards inside a category.
- Card handles can drag cards to another category.
- Dragging near the top or bottom edge auto-scrolls the Cards dropdown on desktop and mobile.

No implementation happens in this spec. It defines the feature behavior, contracts, code shape, and integration plan.

## Product Direction

Use direct manipulation for organization. Movement should feel like rearranging a compact list, not entering a separate mode.

The Cards dropdown should remove:

- category `Move up`;
- category `Move down`;
- card `Move`;
- move-target buttons;
- move-cancel slot;
- transient move-mode state.

The replacement is a dedicated drag handle rendered on editable categories and cards. Dragging starts only from that handle. The rest of the row keeps its current behavior:

- category row click expands/collapses;
- card row tap cycles Inactive/Active/Priority;
- mobile press-hold on category/card opens the editor;
- delete remains a deliberate action with inline confirm/cancel.

## Visual Contract

Use a compact grip handle. A vertical six-dot or grip-lines icon is preferred over arrows because movement can be up, down, and cross-category.

Recommended action order:

```text
Category: [edit] [delete]  [grip]
Card:     [edit] [copy] [delete]  [grip]
```

The gap between delete and grip matters. Delete is destructive enough that the movement handle must not sit directly against it.

Recommended spacing:

```css
.recursion-card-drag-handle {
  cursor: grab;
}

.recursion-card-drag-handle:active,
.recursion-card-drag-handle[aria-pressed="true"] {
  cursor: grabbing;
}

.recursion-card-deck-card-actions,
.recursion-card-deck-category-actions {
  gap: 4px;
}

.recursion-card-delete-slot + .recursion-card-drag-handle,
.recursion-mini-button.danger + .recursion-card-drag-handle {
  margin-left: 8px;
}
```

The handle should be icon-only with hover text:

```text
Drag to reorder category.
Drag to reorder card or move to another category.
```

## Interaction Contract

### Desktop

Desktop drag starts immediately on pointer down/move from the handle:

1. User presses the handle.
2. A drag ghost appears.
3. The original row leaves a placeholder at its original height.
4. Valid drop targets show insertion feedback.
5. Releasing commits the new position.
6. `Esc`, pointer cancel, or leaving the panel without drop cancels.

Cursor states:

- idle handle: `grab`;
- active drag: `grabbing`;
- invalid target: no insertion marker.

### Mobile

Mobile drag starts from the handle only, after a short hold.

Recommended values:

```js
const CARD_DRAG_HANDLE_HOLD_MS = 175;
const CARD_DRAG_HANDLE_MOVE_PX = 8;
const CARD_DRAG_AUTOSCROLL_EDGE_PX_DESKTOP = 44;
const CARD_DRAG_AUTOSCROLL_EDGE_PX_MOBILE = 64;
```

Mobile flow:

1. User touches handle.
2. If finger moves more than `CARD_DRAG_HANDLE_MOVE_PX` before hold completes, cancel drag setup and allow normal scroll.
3. If hold completes, start drag, call `cardHaptic(10)`, set pointer capture, and prevent native scroll for the active drag.
4. Drag ghost follows the pointer.
5. Edge auto-scroll moves the dropdown while the drag remains active.
6. Release commits; pointer cancel cancels.

This preserves normal mobile scrolling. Drag does not begin from normal row press-hold because row press-hold already means edit.

## Drag State Model

Keep drag state local to the mounted UI. Persist only on drop.

```ts
type CardDragState =
  | null
  | {
      deckId: string;
      kind: "category" | "card";
      id: string;
      pointerId: number;
      started: boolean;
      origin: { x: number; y: number };
      current: { x: number; y: number };
      sourceCategoryId?: string;
      placeholder: {
        categoryId?: string;
        beforeCategoryId?: string;
        beforeCardId?: string;
      };
      autoScroll: {
        frameId: number;
        velocityY: number;
      };
    };
```

Do not call `runtime.updateSettings(...)` while hovering. Drag hover is UI-only. Commit one deck mutation on drop.

## Data Mutation Helpers

Replace offset and mode-based movement with exact insertion helpers.

```js
function moveCategoryToPosition(deck, categoryId, beforeCategoryId = '') {
  const order = Array.isArray(deck?.categoryOrder) ? [...deck.categoryOrder] : [];
  const moving = String(categoryId || '');
  if (!moving || !order.includes(moving)) return deck;

  const remaining = order.filter((id) => id !== moving);
  const before = String(beforeCategoryId || '');
  const insertIndex = before && remaining.includes(before)
    ? remaining.indexOf(before)
    : remaining.length;

  remaining.splice(insertIndex, 0, moving);
  return { ...deck, categoryOrder: remaining, updatedAt: nowIso() };
}

function moveCardToPosition(deck, cardId, targetCategoryId, beforeCardId = '') {
  const cards = asObject(deck?.cards);
  const card = cards[cardId];
  const targetCategory = String(targetCategoryId || '');
  if (!card || !targetCategory || !asObject(deck?.categories)[targetCategory]) return deck;

  const sourceCategory = String(card.categoryId || '');
  const nextOrderByCategory = { ...asObject(deck?.cardOrderByCategory) };
  const sourceOrder = Array.isArray(nextOrderByCategory[sourceCategory])
    ? nextOrderByCategory[sourceCategory].filter((id) => id !== cardId)
    : [];
  const targetBase = sourceCategory === targetCategory
    ? sourceOrder
    : Array.isArray(nextOrderByCategory[targetCategory])
      ? nextOrderByCategory[targetCategory].filter((id) => id !== cardId)
      : [];

  const before = String(beforeCardId || '');
  const insertIndex = before && targetBase.includes(before)
    ? targetBase.indexOf(before)
    : targetBase.length;
  const targetOrder = [...targetBase];
  targetOrder.splice(insertIndex, 0, cardId);

  nextOrderByCategory[sourceCategory] = sourceOrder;
  nextOrderByCategory[targetCategory] = targetOrder;

  return {
    ...deck,
    cards: {
      ...cards,
      [cardId]: { ...card, categoryId: targetCategory, updatedAt: nowIso() }
    },
    cardOrderByCategory: nextOrderByCategory,
    updatedAt: nowIso()
  };
}
```

These helpers allow exact reorder, append, and cross-category movement. They also make tests straightforward.

## DOM Contract

Add handle buttons with stable data attributes:

```js
function cardDragHandle(kind, id, label) {
  return cardSystemIconButton('grip', label, {
    recursionCardDragHandle: kind,
    recursionCardDragId: id
  }, {
    className: 'recursion-card-drag-handle'
  });
}
```

Category action row:

```js
const categoryActions = !activeDeck.readonly ? [
  cardSystemIconButton('pencil', 'Edit category', { recursionCardCategoryEdit: category.id }),
  deleteActionSlot('category', category.id, categoryDeletePending),
  cardDragHandle('category', category.id, 'Drag to reorder category')
] : [];
```

Card action row:

```js
const cardActions = !activeDeck.readonly ? [
  cardSystemIconButton('pencil', 'Edit card', { recursionCardEdit: card.id }),
  cardSystemIconButton('copy', 'Duplicate card', { recursionCardDuplicate: card.id }),
  deleteActionSlot('card', card.id, cardDeletePending),
  cardDragHandle('card', card.id, 'Drag to reorder card or move to another category')
] : [];
```

Remove old movement data markers:

```text
data-recursion-card-category-move-up
data-recursion-card-category-move-down
data-recursion-card-move
data-recursion-card-move-target
data-recursion-card-move-cancel
```

Current implementation anchors in `src/ui.mjs`:

- category movement render path: `recursionCardCategoryMoveUp` and `recursionCardCategoryMoveDown`;
- card movement render path: `recursionCardMove`;
- temporary move-mode render path: `recursionCardMoveTarget` and `recursionCardMoveCancel`;
- local state: `cardMoveState`;
- old category mutation helper: `moveCategoryByOffset(...)`;
- click handlers: category up/down, card move, move target, move cancel.

The implementation should remove these anchors rather than hiding them. Recursion is pre-alpha, so this should be one coherent Card System contract instead of a compatibility layer.

## Pointer Handling

Handle pointer events at the Cards panel level, not on each row.

```js
cardsPanel.addEventListener('pointerdown', onCardDragPointerDown);
cardsPanel.addEventListener('pointermove', onCardDragPointerMove);
cardsPanel.addEventListener('pointerup', onCardDragPointerUp);
cardsPanel.addEventListener('pointercancel', cancelCardDrag);
cardsPanel.addEventListener('keydown', onCardDragKeyDown);
```

Start logic:

```js
function onCardDragPointerDown(event) {
  const handle = event.target?.closest?.('[data-recursion-card-drag-handle]');
  if (!handle) return;
  if (event.button !== undefined && event.button !== 0) return;

  const kind = handle.dataset.recursionCardDragHandle;
  const id = handle.dataset.recursionCardDragId;
  const view = currentView();
  const deck = getActiveCardDeck(view.settings);
  if (deck.readonly || !id) return;

  const holdMs = isCoarsePointer(event) ? CARD_DRAG_HANDLE_HOLD_MS : 0;
  cardDragState = {
    deckId: deck.id,
    kind,
    id,
    pointerId: event.pointerId,
    started: false,
    origin: { x: event.clientX, y: event.clientY },
    current: { x: event.clientX, y: event.clientY },
    placeholder: {},
    autoScroll: { frameId: 0, velocityY: 0 }
  };

  if (holdMs > 0) {
    cardDragHoldTimer = setTimeout(() => startCardDrag(event.pointerId), holdMs);
  } else {
    startCardDrag(event.pointerId);
  }
}
```

Movement logic:

```js
function onCardDragPointerMove(event) {
  const state = cardDragState;
  if (!state || state.pointerId !== event.pointerId) return;

  const dx = Math.abs(event.clientX - state.origin.x);
  const dy = Math.abs(event.clientY - state.origin.y);

  if (!state.started && (dx > CARD_DRAG_HANDLE_MOVE_PX || dy > CARD_DRAG_HANDLE_MOVE_PX)) {
    cancelCardDrag();
    return;
  }

  if (!state.started) return;
  event.preventDefault();
  state.current = { x: event.clientX, y: event.clientY };
  updateDragGhost(state);
  updateDropPlaceholder(state, event.clientX, event.clientY);
  updateCardDragAutoScroll(state, event.clientY);
}
```

Drop logic:

```js
function onCardDragPointerUp(event) {
  const state = cardDragState;
  if (!state || state.pointerId !== event.pointerId) return;
  if (!state.started) {
    cancelCardDrag();
    return;
  }

  const view = currentView();
  const deck = getActiveCardDeck(view.settings);
  const nextDeck = state.kind === 'category'
    ? moveCategoryToPosition(deck, state.id, state.placeholder.beforeCategoryId)
    : moveCardToPosition(deck, state.id, state.placeholder.categoryId, state.placeholder.beforeCardId);

  cancelCardDrag({ keepStatus: true });
  applyCardDeckSettings(
    upsertCustomCardDeck(view.settings, nextDeck),
    state.kind === 'category' ? 'Category moved.' : 'Card moved.'
  );
}
```

## Drop Target Rules

### Categories

Category drag only targets category positions. The insertion marker appears before another category or at the end of the category list.

Rules:

- Dragging a category over its own placeholder is a no-op.
- Dropping at the same computed position cancels without status.
- Collapsed/expanded state follows the category id and should not reset.

### Cards

Card drag targets:

- before another card in an expanded category;
- after the last visible card in an expanded category;
- into a category header, appending to that category;
- into a collapsed category header, with optional hover-to-expand.

Recommended collapsed-category behavior:

```js
const CARD_DRAG_EXPAND_CATEGORY_MS = 500;

function maybeExpandDropCategory(deckId, categoryId) {
  if (!categoryId || isCategoryExpanded(deckId, categoryId)) return;
  clearTimeout(cardDragExpandTimer);
  cardDragExpandTimer = setTimeout(() => {
    expandCardCategory(deckId, categoryId);
    cardHaptic(6);
  }, CARD_DRAG_EXPAND_CATEGORY_MS);
}
```

Do not require categories to be expanded before a card can be dropped into them. Dropping on the header appends.

## Auto-Scroll Contract

Auto-scroll should operate on `.recursion-card-deck-list` or the nearest Cards panel scroll surface. It must not scroll the whole SillyTavern page unless the Cards panel itself is not scrollable.

```js
function updateCardDragAutoScroll(state, pointerY) {
  const scrollHost = cardsPanel?.querySelector?.('[data-recursion-card-deck-list]') || cardsPanel;
  const rect = scrollHost.getBoundingClientRect();
  const edge = isMobileViewport() ? CARD_DRAG_AUTOSCROLL_EDGE_PX_MOBILE : CARD_DRAG_AUTOSCROLL_EDGE_PX_DESKTOP;
  const topDistance = pointerY - rect.top;
  const bottomDistance = rect.bottom - pointerY;
  let velocity = 0;

  if (topDistance < edge) velocity = -scrollVelocity(edge - topDistance, edge);
  else if (bottomDistance < edge) velocity = scrollVelocity(edge - bottomDistance, edge);

  state.autoScroll.velocityY = velocity;
  if (velocity && !state.autoScroll.frameId) {
    state.autoScroll.frameId = requestAnimationFrame(() => tickCardDragAutoScroll(state, scrollHost));
  }
}

function scrollVelocity(distanceIntoEdge, edge) {
  const ratio = Math.max(0, Math.min(1, distanceIntoEdge / edge));
  return Math.ceil(18 * ratio);
}

function tickCardDragAutoScroll(state, scrollHost) {
  state.autoScroll.frameId = 0;
  if (!state.started || !state.autoScroll.velocityY) return;
  scrollHost.scrollTop += state.autoScroll.velocityY;
  state.autoScroll.frameId = requestAnimationFrame(() => tickCardDragAutoScroll(state, scrollHost));
}
```

Auto-scroll must stop on drop, cancel, Escape, panel close, deck switch, or extension teardown.

## Visual Feedback

During active drag:

- dragged row gets `is-dragging`;
- original row placeholder keeps row height stable;
- floating ghost follows pointer;
- insertion line shows exact drop position;
- valid category drop zone gets subtle cyan outline;
- invalid zones show no marker.

CSS sketch:

```css
.recursion-card-drag-ghost {
  pointer-events: none;
  position: fixed;
  z-index: 120;
  opacity: .92;
  transform: translate3d(var(--drag-x), var(--drag-y), 0);
}

.recursion-card-drag-placeholder {
  border: 1px dashed color-mix(in srgb, var(--recursion-accent) 48%, transparent);
  border-radius: 5px;
  min-height: var(--drag-placeholder-height);
}

.recursion-card-drop-line {
  height: 2px;
  background: color-mix(in srgb, var(--recursion-accent) 72%, transparent);
}

.recursion-card-drop-category.is-drop-target {
  outline: 1px solid color-mix(in srgb, var(--recursion-accent) 36%, transparent);
  outline-offset: -1px;
}
```

## Haptics

Use haptics sparingly:

- drag starts: `cardHaptic(10)`;
- valid cross-category target changes: `cardHaptic(6)`;
- drop commits: `cardHaptic(8)`;
- cancel: no haptic.

Respect the existing reduced-motion haptic guard in `cardHaptic(...)`.

## Status Feedback

Do not emit status on drag start, hover, placeholder changes, auto-scroll, or cancel.

Emit status only on committed reorder:

```js
const CARD_DRAG_STATUS = {
  categoryMoved: 'Category moved.',
  cardMoved: 'Card moved.',
  cardMovedCategory: 'Card moved to category.'
};
```

The status still routes through the main Recursion bar and mobile status drawer.

## Accessibility

The pointer version should ship first, but the handle must be keyboard reachable from the start.

Minimum accessibility:

- handle is a button;
- has clear `aria-label`;
- has hover title;
- `Esc` cancels active drag;
- focus outline remains visible.

Recommended keyboard follow-up:

```text
Focus handle -> Space lifts row
ArrowUp/ArrowDown moves placeholder
ArrowLeft/ArrowRight changes category for cards when possible
Enter drops
Esc cancels
```

If keyboard reorder is included in the first pass, it should reuse the same `moveCategoryToPosition(...)` and `moveCardToPosition(...)` helpers rather than creating a separate movement path.

## Error And Edge Cases

Read-only deck:

- no handles render.

Draft cards:

- draggable like other cards. Draft status controls runtime eligibility, not deck organization.

Deleted while dragging:

- if row disappears or deck changes, cancel drag with no status.

Deck selection changes while dragging:

- cancel drag.

Cards panel closes while dragging:

- cancel drag and stop auto-scroll.

Heartbeat rerender:

- while `cardDragState.started` is true, skip unchanged panel rerenders or cancel drag before rerender. Do not let heartbeat close the panel or lose pointer capture mid-drag.

Collapsed categories:

- category drag can reorder collapsed or expanded categories.
- card drag can drop onto collapsed category header as append.
- optional hover-to-expand helps precise placement.

Delete proximity:

- handle sits after delete with extra gap.
- delete confirm state replaces only delete slot, not the handle.
- if delete is pending, dragging should either be disabled for that row or cancel the pending delete first. Recommended: disable dragging on pending-delete rows.

## Testing And Validation

Deterministic helper tests:

- `moveCategoryToPosition(...)` moves category before another category.
- moving category to its current position is a no-op.
- `moveCardToPosition(...)` reorders within the same category.
- `moveCardToPosition(...)` moves card to another category before a target card.
- moving card to a collapsed category header appends.
- invalid card/category ids are no-ops.

UI/static tests:

- Category up/down buttons no longer render.
- Card move button no longer renders.
- Move target and cancel controls no longer render.
- Category/card handles render only on editable decks.
- Handles have tooltip and `aria-label`.
- Delete and handle have a spacer/gap.
- Existing category row click still toggles expansion.
- Existing card row tap still cycles selection state.
- Press-hold editor path still works when not starting from handle.

Playwright/live checks:

- Desktop: drag a category below another category and verify `categoryOrder`.
- Desktop: drag a card within a category and verify `cardOrderByCategory`.
- Desktop: drag a card to another category and verify `categoryId` and target order.
- Mobile: drag handle starts only after short hold and fires haptic-compatible path.
- Mobile: normal vertical movement on handle before hold cancels drag and allows panel scroll.
- Mobile: auto-scroll triggers near top and bottom edge during drag.
- Desktop/mobile: drop emits main bar status.
- Desktop/mobile: cancel with `Esc` leaves deck unchanged.
- Refresh heartbeat does not close Cards dropdown during drag.

Documentation updates:

- `docs/design/UI_SPEC.md` should describe handle-based movement as the Card System movement contract.
- `docs/design/CARD_SYSTEM_SPEC.md` should replace old move-button language with drag-handle organization.
- `docs/technical/CARD_DECK_AND_HAND.md` should state that runtime scope derives from active deck state; handle movement only changes deck organization and category/card order.
- Any UI proof notes should remove references to move-mode buttons or target buttons.

## Integration Plan

1. **Add movement helpers**
   - Add exact insertion helpers near existing card deck mutation helpers.
   - Keep old helpers only until all callers are replaced.
   - Add deterministic tests first.

2. **Render handles and remove old controls**
   - Add `grip` icon support to `cardSystemIconSvg(...)`.
   - Add `cardDragHandle(...)`.
   - Replace category up/down controls and card move controls with handles.
   - Remove move target and move cancel UI.

3. **Add drag state and pointer handlers**
   - Add local `cardDragState`, hold timer, expansion timer, and auto-scroll frame tracking.
   - Wire pointer events at Cards panel level.
   - Start drag from handles only.
   - Preserve row click and press-hold edit behavior.

4. **Implement drop target calculation**
   - Use `elementFromPoint(...)` plus closest category/card data attributes.
   - Compute `beforeCategoryId`, `categoryId`, and `beforeCardId`.
   - Render placeholder/insertion feedback from local drag state.

5. **Implement auto-scroll**
   - Scroll Cards panel/list near top/bottom edge.
   - Use larger edge band on mobile.
   - Stop animation on every drag exit path.

6. **Commit on drop**
   - Use `moveCategoryToPosition(...)` or `moveCardToPosition(...)`.
   - Call one `applyCardDeckSettings(...)`.
   - Route committed status through main bar.

7. **Remove old move state**
   - Delete `cardMoveState`, `recursionCardMoveTarget`, `recursionCardMoveCancel`, and category offset handlers after replacement.
   - Update tests and docs to reflect handle movement.

8. **Live proof**
   - Extend `tools/scripts/prove-card-system-ui.mjs`.
   - Prove desktop reorder, cross-category card move, mobile drag, and edge auto-scroll.
   - Sync served `recursion-soak-a` copy and run live proof.

9. **Documentation alignment**
   - Update `docs/design/UI_SPEC.md`, `docs/design/CARD_SYSTEM_SPEC.md`, and `docs/technical/CARD_DECK_AND_HAND.md`.
   - Confirm no docs still describe up/down category buttons, card move mode, or visible move targets as current UI.

## Recommendation

Implement pointer/touch drag handles first, with keyboard handles focusable but keyboard reorder as a follow-up unless we want to expand the scope. The high-risk part is mobile drag versus scroll behavior, so the first implementation should put most validation effort there.

Do not use a drag-and-drop library for this pass. The surface is small, the data model is custom, SillyTavern panels are constrained, and native pointer events give better control over mobile scroll, haptics, and heartbeat rerender behavior.
