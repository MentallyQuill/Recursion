# Recursion Card System Mobile Interactions Design

## Goal

Make Card System mobile interactions compact, icon-only, and gesture-correct:

- Tap card row toggles active or inactive.
- Press-hold card row opens inline card edit.
- Press-hold category header opens inline category edit.
- Delete uses inline confirmation with check and x buttons.
- Card and category controls stay icon-only with hover text, accessible labels, and subtle haptics.

This document expands the Card System design after live mobile review of the icon-only pass.

## Current Issues

The current mobile Card System behavior still has interaction mismatches:

- A single card tap opens edit mode. It should toggle active/inactive.
- The card editor opens as a separate panel at the top. It should open inline at the target card.
- The enable/disable eye button adds clutter and duplicates the row tap action.
- Delete reports success but deleted cards can remain visible, likely from stale render state or incomplete order cleanup.
- Category controls show too many buttons on mobile. Visible order should be Up, Down, Delete. Category edit is a press-hold action.
- Delete needs a reversible inline confirmation step, not immediate destructive action.
- Refresh heartbeat updates can rebuild the Cards panel and close the native Card Deck selector while the user is choosing a deck.

## Interaction Contract

### Card Row

Default card row behavior:

- Single tap or click on the card row toggles active/inactive.
- Press-hold opens the inline card editor for that card.
- Duplicate, move, and delete remain explicit icon buttons.
- Enable/disable eye button is removed.
- Draft cards cannot be activated. Tapping a draft card shows a compact notice and warning haptic.

Desktop may keep click-to-edit only if it is explicitly separated from the mobile contract. Recommended V1 behavior is shared across pointer devices: primary row action toggles, long-press edits, explicit edit can remain keyboard-accessible through Enter/Space only if the row is focused and the user holds or uses a secondary action.

### Category Header

Default category header behavior:

- Press-hold category header opens inline category editor.
- Visible category buttons are Up, Down, Delete, in that order.
- The mobile UI removes the visible Edit category button.
- Desktop may keep a category edit icon only if it does not appear on mobile, but the preferred compact contract is press-hold everywhere.

### Inline Editors

Card editor:

- Opens inline in the card row being edited.
- The edited card stays in its category.
- One editor is open at a time.
- Opening an editor cancels pending delete and move states.
- Save and Cancel are icon-only check and x buttons.
- The wand recommender remains in the inline editor header.

Category editor:

- Opens inline below the category header.
- Edits category name and description.
- Save and Cancel are icon-only check and x buttons.
- Category editor does not use the card wand.

### Refresh Heartbeat Stability

The Cards panel must not replace its DOM when the only change is routine runtime heartbeat or progress state. Native `<select>` dropdowns cannot preserve their open picker state across DOM replacement, especially on mobile browsers.

Implementation direction:

```js
let cardsPanelRenderKey = '';

function cardsPanelViewKey(view, notice, editorState, categoryEditorState, moveState, deleteState) {
  return stableStringify({
    notice,
    cardScope: normalizeCardScope(view.settings?.cardScope || defaultCardScope()),
    cardDecks: normalizeCardDeckSettings(view.settings?.cardDecks),
    editorState,
    categoryEditorState,
    moveState,
    deleteState
  });
}

function renderCardsPanelForView(view, notice = cardScopeNotice) {
  const effectiveView = viewWithPendingCardScope(view);
  const nextRenderKey = cardsPanelViewKey(effectiveView, notice, cardEditorState, categoryEditorState, cardMoveState, cardDeleteConfirmState);
  if (cardsPanelRenderKey === nextRenderKey) return;
  cardsPanelRenderKey = nextRenderKey;
  renderCardsPanel(cardsPanel, effectiveView, createRecursionViewModel(effectiveView), notice, cardEditorState, categoryEditorState, cardMoveState, cardDeleteConfirmState);
}
```

Reset `cardsPanelRenderKey` when the Cards panel closes. Include all card/deck/editor/move/delete state in the key, but exclude heartbeat-only runtime state.

### Single Card Deck Surface

The Cards dropdown shows Card Decks as the only user-facing card management surface. The legacy Card Scope family/sub-item selector is removed from the dropdown rather than hidden behind a disclosure.

Implementation direction:

- Render the active deck categories and cards for both Default and editable custom decks.
- Gate mutating controls by `deck.readonly`, not the deck list itself.
- Keep the old runtime scope adapter only as internal compatibility while runtime code still expects a scope-shaped payload.
- Rename the visible All action to a deck action: it enables every runnable inactive card in the active editable deck and leaves draft cards unchanged.
- The header summary reports active deck state, such as `34/34 active` or `33/34 active, 1 draft`.
- Tests assert that `[data-recursion-card-scope-family]` and `[data-recursion-card-scope-sub-item-toggle]` are absent from the Cards dropdown.

### Stable Transient Action Slots

Move and delete controls must not add rows or resize action clusters when armed. Clicking a move or trash icon should not make the panel jump.

Implementation direction:

- Do not insert a move-mode notice row above the deck list.
- Do not reveal the top notice row just to arm card/category delete confirmation.
- Reserve fixed action slots for transient controls:
  - category move-target slot is always present, invisible until move mode is active.
  - card/category delete slot is always present, showing trash normally and check/x while pending.
  - move cancel slot is always present in deck tools, invisible until move mode is active.
- Hidden slot buttons use `visibility: hidden` and `pointer-events: none` inside a fixed-width slot instead of `display: none`.
- Card action rows use `flex-wrap: nowrap` so trash -> check/x cannot increase row height.
- The deck edit button uses the supplied SVG Repo `edit-[#1479]` path as a filled `currentColor` glyph.

### Active State

Active cards:

- No eye button.
- Active state is represented by row highlight and a compact status icon.
- Recommended visual: subtle cyan left inset, slightly brighter card name, check icon in the status slot.

Inactive cards:

- Muted text and no cyan inset.
- Status icon is muted.

Draft cards:

- Amber draft badge icon.
- Muted row.
- Cannot be activated.
- Tap shows `Draft cards need a name and prompt before they can run.`

## Delete Confirmation Contract

Delete is two-step and inline.

Initial state:

- Card/category shows trash icon.

Pending delete state:

- Trash icon is replaced by check and x icons.
- Row/header gets subtle red pending tint.
- Check confirms delete.
- X cancels delete.
- Any pointerdown/click/key action outside those two buttons cancels delete.
- Opening another pending delete cancels the previous one.
- Escape cancels delete.
- Long-press outside confirm/cancel cancels delete before handling the new gesture.

Category delete:

- Recommended V1: confirming category delete deletes the category and its contained cards.
- The confirmation tooltip must be explicit: `Delete category and cards`.
- If a safer behavior is preferred later, block non-empty category deletion with a notice, but do not add a modal.

Delete data cleanup:

- Card delete removes `deck.cards[cardId]`.
- Card delete removes `cardId` from every `deck.cardOrderByCategory[categoryId]`.
- Category delete removes `deck.categories[categoryId]`.
- Category delete removes `categoryId` from `deck.categoryOrder`.
- Category delete removes all cards in the category.
- Category delete removes the deleted category order entry.
- Deleting clears editor, move, long-press, and delete-confirm state for affected ids.
- Render happens only from the resolved updated runtime view after `runtime.updateSettings()` settles.

## Haptics Contract

Haptics are mobile-only and subtle.

Use `navigator.vibrate()` only when all are true:

- Touch-capable environment.
- `navigator.vibrate` exists.
- The user is not in reduced-motion mode, if we use reduced motion as a general sensory-reduction signal.

Recommended pulses:

| Interaction | Pattern |
| --- | --- |
| Long-press threshold reached on card | `8` |
| Long-press threshold reached on category | `8` |
| Card active/inactive toggle | `6` |
| Trash tapped to arm delete | `12` |
| Delete confirmed | `18` |
| Delete canceled | none or `6` |
| Move mode armed | `8` |
| Move target selected | `12` |
| Wand suggestion accepted | `8` |
| Save card/category edit | `8` |
| Invalid draft activation | `[8, 35, 8]` |

Do not vibrate for dropdown open/close, normal scroll, hover help, passive rerenders, or every ordinary button tap.

## Implementation Sketches

### UI State

Add explicit UI state near the existing card editor and move state variables in `src/ui.mjs`:

```js
let cardEditorState = null;
let categoryEditorState = null;
let cardMoveState = null;
let cardDeleteConfirmState = null;
let cardLongPressTimer = null;
let cardLongPressPointer = null;
```

Use one pending delete shape for cards and categories:

```js
function deleteConfirmFor(kind, id, deckId) {
  return {
    kind: String(kind || ''),
    id: String(id || ''),
    deckId: String(deckId || ''),
    armedAt: Date.now()
  };
}

function isDeleteConfirm(kind, id, deckId) {
  return cardDeleteConfirmState?.kind === kind
    && cardDeleteConfirmState?.id === id
    && cardDeleteConfirmState?.deckId === deckId;
}

function clearCardTransientState({ editor = false, move = false, deleteConfirm = false } = {}) {
  if (editor) {
    cardEditorState = null;
    categoryEditorState = null;
  }
  if (move) cardMoveState = null;
  if (deleteConfirm) cardDeleteConfirmState = null;
}
```

### Haptics Helper

```js
function canUseCardHaptics() {
  if (typeof globalThis.navigator?.vibrate !== 'function') return false;
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return false;
  return globalThis.navigator.maxTouchPoints > 0
    || globalThis.matchMedia?.('(pointer: coarse)')?.matches === true;
}

function cardHaptic(pattern) {
  if (!canUseCardHaptics()) return;
  try {
    globalThis.navigator.vibrate(pattern);
  } catch {
    // Haptics are advisory.
  }
}
```

### Long-Press Handling

Replace the current press-hold implementation with movement-aware pointer state:

```js
const CARD_LONG_PRESS_MS = 575;
const CARD_LONG_PRESS_MOVE_PX = 9;

function beginCardLongPress(event, target) {
  if (!target || event.button > 0) return;
  clearCardLongPress();
  cardLongPressPointer = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    target
  };
  cardLongPressTimer = setTimeout(() => {
    const state = cardLongPressPointer;
    cardLongPressTimer = null;
    cardLongPressPointer = null;
    if (!state?.target?.isConnected) return;
    armCardSystemLongPress(state.target);
  }, CARD_LONG_PRESS_MS);
}

function updateCardLongPress(event) {
  const state = cardLongPressPointer;
  if (!state || state.pointerId !== event.pointerId) return;
  const dx = Math.abs(event.clientX - state.x);
  const dy = Math.abs(event.clientY - state.y);
  if (dx > CARD_LONG_PRESS_MOVE_PX || dy > CARD_LONG_PRESS_MOVE_PX) clearCardLongPress();
}

function clearCardLongPress() {
  if (cardLongPressTimer) clearTimeout(cardLongPressTimer);
  cardLongPressTimer = null;
  cardLongPressPointer = null;
}
```

Long-press action:

```js
function armCardSystemLongPress(target) {
  const cardNode = closestDatasetElement(target, 'recursionCardId', cardsPanel);
  if (cardNode) {
    const cardId = cardNode.dataset.recursionCardId;
    const view = currentView();
    const deck = getActiveCardDeck(view.settings);
    const card = asObject(deck.cards)[cardId];
    if (!card || deck.readonly) return;
    clearCardTransientState({ move: true, deleteConfirm: true });
    cardEditorState = { deckId: deck.id, cardId, draft: card };
    categoryEditorState = null;
    cardHaptic(8);
    renderCardsPanelForView(currentView());
    return;
  }

  const categoryNode = closestDatasetElement(target, 'recursionCardCategory', cardsPanel);
  if (categoryNode) {
    const categoryId = categoryNode.dataset.recursionCardCategory;
    const view = currentView();
    const deck = getActiveCardDeck(view.settings);
    const category = asObject(deck.categories)[categoryId];
    if (!category || deck.readonly) return;
    clearCardTransientState({ editor: true, move: true, deleteConfirm: true });
    categoryEditorState = { deckId: deck.id, categoryId, draft: category };
    cardHaptic(8);
    renderCardsPanelForView(currentView());
  }
}
```

### Card Tap Toggle

Card row main action becomes active toggle:

```js
function toggleCardActive(deck, cardId) {
  const card = asObject(deck.cards)[cardId];
  if (!card) return null;
  const status = getDeckCardStatus(card);
  if (!status.runnable) {
    cardScopeNotice = 'Draft cards need a name and prompt before they can run.';
    cardHaptic([8, 35, 8]);
    return null;
  }
  cardHaptic(6);
  return upsertCustomCardDeck(currentView().settings, updateCard(deck, cardId, {
    enabled: card.enabled === false
  }));
}
```

Click handler:

```js
if (control('recursionCardToggleRow')) {
  consumeClickEvent(event);
  clearCardTransientState({ editor: true, move: true, deleteConfirm: true });
  const view = currentView();
  const deck = getActiveCardDeck(view.settings);
  if (!deck.readonly) {
    const nextDecks = toggleCardActive(deck, cardToggleRow.dataset.recursionCardToggleRow);
    if (nextDecks) applyCardDeckSettings(nextDecks, 'Card state updated.');
    else renderCardsPanelForView(currentView());
  }
}
```

### Inline Card Editor Placement

Render inline editor immediately after the card row:

```js
function renderCardEditorInline(activeDeck, card, editorState) {
  if (editorState?.deckId !== activeDeck.id || editorState?.cardId !== card.id) return null;
  const draft = asObject(editorState.draft);
  const suggestion = asObject(editorState.suggestion);
  const hasSuggestion = Boolean(suggestion.name || suggestion.description || suggestion.promptText);
  return el('div', { className: 'recursion-card-editor recursion-card-editor-inline', dataset: { recursionCardEditor: '' } }, [
    el('div', { className: 'recursion-card-editor-head' }, [
      el('strong', { text: draft.name || NEW_CARD_NAME }),
      cardSystemIconButton('wand', 'Suggest a stronger Recursion card', { recursionCardWand: '' })
    ]),
    el('input', { className: 'recursion-input', attrs: { type: 'text', value: draft.name || NEW_CARD_NAME, placeholder: 'Card name', 'aria-label': 'Card name' }, dataset: { recursionCardEditorName: '' } }),
    el('input', { className: 'recursion-input', attrs: { type: 'text', value: draft.description || '', placeholder: 'Description', 'aria-label': 'Card description' }, dataset: { recursionCardEditorDescription: '' } }),
    el('textarea', { className: 'recursion-input recursion-card-editor-prompt', text: draft.promptText || '', attrs: { placeholder: 'Prompt', 'aria-label': 'Card prompt' }, dataset: { recursionCardEditorPrompt: '' } }),
    ...(hasSuggestion ? renderSuggestionPreview(editorState) : []),
    el('div', { className: 'recursion-card-editor-actions' }, [
      cardSystemIconButton('check', 'Save card', { recursionCardEditorSave: '' }),
      cardSystemIconButton('x', 'Cancel card edit', { recursionCardEditorCancel: '' })
    ])
  ]);
}
```

Append after each card:

```js
section.appendChild(cardRow);
const inlineEditor = renderCardEditorInline(activeDeck, card, editorState);
if (inlineEditor) section.appendChild(inlineEditor);
```

Remove the current top-of-panel card editor block once inline rendering exists.

### Inline Category Editor

```js
function renderCategoryEditorInline(activeDeck, category, editorState) {
  if (editorState?.deckId !== activeDeck.id || editorState?.categoryId !== category.id) return null;
  const draft = asObject(editorState.draft);
  return el('div', { className: 'recursion-card-editor recursion-category-editor-inline', dataset: { recursionCategoryEditor: '' } }, [
    el('input', { className: 'recursion-input', attrs: { type: 'text', value: draft.name || '', placeholder: 'Category name', 'aria-label': 'Category name' }, dataset: { recursionCategoryEditorName: '' } }),
    el('input', { className: 'recursion-input', attrs: { type: 'text', value: draft.description || '', placeholder: 'Description', 'aria-label': 'Category description' }, dataset: { recursionCategoryEditorDescription: '' } }),
    el('div', { className: 'recursion-card-editor-actions' }, [
      cardSystemIconButton('check', 'Save category', { recursionCategoryEditorSave: '' }),
      cardSystemIconButton('x', 'Cancel category edit', { recursionCategoryEditorCancel: '' })
    ])
  ]);
}
```

Save:

```js
function saveCategoryEditorDraft() {
  if (!categoryEditorState) return;
  const view = currentView();
  const deck = getActiveCardDeck(view.settings);
  if (deck.readonly) return;
  const categoryId = categoryEditorState.categoryId;
  const nextName = cleanText(root.querySelector('[data-recursion-category-editor-name]')?.value, categoryEditorState.draft?.name || '');
  const nextDescription = cleanText(root.querySelector('[data-recursion-category-editor-description]')?.value, categoryEditorState.draft?.description || '');
  categoryEditorState = null;
  cardHaptic(8);
  applyCardDeckSettings(upsertCustomCardDeck(view.settings, updateCategory(deck, categoryId, {
    name: nextName,
    description: nextDescription
  })), 'Category saved.');
}
```

### Delete Confirmation Rendering

Card actions:

```js
const pendingCardDelete = isDeleteConfirm('card', card.id, activeDeck.id);
el('span', { className: 'recursion-card-deck-card-actions' }, [
  cardSystemIconButton('copy', 'Duplicate card', { recursionCardDuplicate: card.id }),
  cardSystemIconButton('move', moveState?.cardId === card.id ? 'Moving card' : 'Move card', { recursionCardMove: card.id }, { active: moveState?.cardId === card.id, pressed: moveState?.cardId === card.id }),
  ...(pendingCardDelete
    ? [
      cardSystemIconButton('check', 'Confirm delete card', { recursionCardDeleteConfirm: card.id }, { danger: true }),
      cardSystemIconButton('x', 'Cancel delete card', { recursionCardDeleteCancel: card.id })
    ]
    : [cardSystemIconButton('trash', 'Delete card', { recursionCardDeleteArm: card.id }, { danger: true })])
])
```

Category actions:

```js
const pendingCategoryDelete = isDeleteConfirm('category', category.id, activeDeck.id);
const categoryDeleteButtons = pendingCategoryDelete
  ? [
    cardSystemIconButton('check', 'Confirm delete category and cards', { recursionCardCategoryDeleteConfirm: category.id }, { danger: true }),
    cardSystemIconButton('x', 'Cancel delete category', { recursionCardCategoryDeleteCancel: category.id })
  ]
  : [cardSystemIconButton('trash', 'Delete category', { recursionCardCategoryDeleteArm: category.id }, { danger: true })];
```

### Delete Confirmation Click Handling

```js
function clickIsDeleteResolution(target) {
  return Boolean(
    closestDatasetElement(target, 'recursionCardDeleteConfirm', cardsPanel)
      || closestDatasetElement(target, 'recursionCardDeleteCancel', cardsPanel)
      || closestDatasetElement(target, 'recursionCardCategoryDeleteConfirm', cardsPanel)
      || closestDatasetElement(target, 'recursionCardCategoryDeleteCancel', cardsPanel)
  );
}

function cancelDeleteOnOutsideInteraction(event) {
  if (!cardDeleteConfirmState) return;
  if (clickIsDeleteResolution(event?.target)) return;
  cardDeleteConfirmState = null;
  renderCardsPanelForView(currentView());
}
```

Arm delete:

```js
if (control('recursionCardDeleteArm')) {
  consumeClickEvent(event);
  cardDeleteConfirmState = deleteConfirmFor('card', cardDeleteArm.dataset.recursionCardDeleteArm, getActiveCardDeck(currentView().settings).id);
  cardEditorState = null;
  categoryEditorState = null;
  cardMoveState = null;
  cardHaptic(12);
  renderCardsPanelForView(currentView());
}
```

Confirm card delete:

```js
if (control('recursionCardDeleteConfirm')) {
  consumeClickEvent(event);
  const view = currentView();
  const deck = getActiveCardDeck(view.settings);
  const cardId = cardDeleteConfirm.dataset.recursionCardDeleteConfirm;
  cardDeleteConfirmState = null;
  cardEditorState = cardEditorState?.cardId === cardId ? null : cardEditorState;
  cardMoveState = cardMoveState?.cardId === cardId ? null : cardMoveState;
  cardHaptic(18);
  applyCardDeckSettings(upsertCustomCardDeck(view.settings, deleteCard(deck, cardId)), 'Card deleted.');
}
```

Confirm category delete:

```js
function deleteCategoryAndCards(deck, categoryId) {
  let nextDeck = deck;
  for (const card of Object.values(asObject(deck.cards))) {
    if (card.categoryId === categoryId) nextDeck = deleteCard(nextDeck, card.id);
  }
  return deleteCategory(nextDeck, categoryId);
}

if (control('recursionCardCategoryDeleteConfirm')) {
  consumeClickEvent(event);
  const view = currentView();
  const deck = getActiveCardDeck(view.settings);
  const categoryId = cardCategoryDeleteConfirm.dataset.recursionCardCategoryDeleteConfirm;
  cardDeleteConfirmState = null;
  if (categoryEditorState?.categoryId === categoryId) categoryEditorState = null;
  if (cardMoveState && asObject(deck.cards)[cardMoveState.cardId]?.categoryId === categoryId) cardMoveState = null;
  cardHaptic(18);
  applyCardDeckSettings(upsertCustomCardDeck(view.settings, deleteCategoryAndCards(deck, categoryId)), 'Category deleted.');
}
```

## CSS Sketch

```css
.recursion-card-deck-card.is-active {
  border-color: color-mix(in srgb, var(--recursion-accent) 28%, var(--recursion-border));
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--recursion-accent) 58%, transparent);
}

.recursion-card-deck-card.is-inactive {
  opacity: .68;
}

.recursion-card-deck-card.is-delete-pending,
.recursion-card-deck-category.is-delete-pending {
  background: color-mix(in srgb, var(--recursion-error) 7%, var(--recursion-panel));
  border-color: color-mix(in srgb, var(--recursion-error) 26%, var(--recursion-border));
}

.recursion-card-editor-inline,
.recursion-category-editor-inline {
  margin-top: 4px;
  border: 1px solid color-mix(in srgb, var(--recursion-accent) 18%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--SmartThemeBodyColor, #d8d8d8) 3%, var(--recursion-panel));
}
```

## Testing And Validation Plan

### Task 1: Gesture Contract Tests

Files:

- Modify `tools/scripts/test-ui.mjs`
- Modify `src/ui.mjs`

Test first:

```js
assert(/CARD_LONG_PRESS_MS/.test(recursionUi), 'Card System defines explicit long-press threshold');
assert(/pointermove/.test(recursionUi) && /CARD_LONG_PRESS_MOVE_PX/.test(recursionUi), 'Card System cancels long-press when mobile scroll movement starts');
assert(/recursionCardToggleRow/.test(recursionUi), 'Card row tap toggles active state instead of opening edit');
assert(!/dataset:\s*\{\s*recursionCardEdit:\s*card\.id\s*\}/.test(recursionUi), 'Card row main button no longer opens edit on tap');
```

Expected red failure before implementation:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: fails on missing `recursionCardToggleRow` or movement-aware long-press constants.

Implementation:

- Add `CARD_LONG_PRESS_MS`.
- Add `CARD_LONG_PRESS_MOVE_PX`.
- Add `pointermove` listener.
- Change card row main dataset from `recursionCardEdit` to `recursionCardToggleRow`.
- Move edit opening into `armCardSystemLongPress()`.

Verification:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: `[pass] ui`.

### Task 2: Inline Editors

Files:

- Modify `tools/scripts/test-ui.mjs`
- Modify `src/ui.mjs`
- Modify `styles/recursion.css`

Test first:

```js
assert(/function renderCardEditorInline/.test(recursionUi), 'Card System renders card editor inline at the card row');
assert(/function renderCategoryEditorInline/.test(recursionUi), 'Card System renders category editor inline under the category header');
assert(/recursionCategoryEditorSave/.test(recursionUi), 'Category editor has icon-only save action');
assert(/recursion-category-editor-inline/.test(recursionCss), 'Category inline editor has compact graphite styling');
```

Expected red failure before implementation:

```powershell
node tools\scripts\test-ui.mjs
```

Implementation:

- Add `categoryEditorState`.
- Move card editor rendering into `renderCardEditorInline()`.
- Add `renderCategoryEditorInline()`.
- Remove top-of-panel card editor render block.
- Save/cancel actions use existing `cardSystemIconButton()`.

Verification:

```powershell
node tools\scripts\test-ui.mjs
```

### Task 3: Delete Confirmation

Files:

- Modify `tools/scripts/test-card-decks.mjs`
- Modify `tools/scripts/test-ui.mjs`
- Modify `src/card-decks.mjs`
- Modify `src/ui.mjs`
- Modify `styles/recursion.css`

Test first:

```js
assert(/recursionCardDeleteArm/.test(recursionUi), 'Card delete first arms inline confirmation');
assert(/recursionCardDeleteConfirm/.test(recursionUi), 'Card delete has inline confirm action');
assert(/recursionCardDeleteCancel/.test(recursionUi), 'Card delete has inline cancel action');
assert(/recursionCardCategoryDeleteArm/.test(recursionUi), 'Category delete first arms inline confirmation');
assert(/is-delete-pending/.test(recursionCss), 'Pending delete state has visible warning styling');
```

Add data cleanup test to `tools/scripts/test-card-decks.mjs`:

```js
{
  const settings = duplicateCardDeck(DEFAULT_RECURSION_SETTINGS, DEFAULT_CARD_DECK_ID);
  const deck = getActiveCardDeck(settings);
  const cardId = Object.keys(deck.cards)[0];
  const categoryId = deck.cards[cardId].categoryId;
  const nextDeck = deleteCard(deck, cardId);
  assert(!nextDeck.cards[cardId], 'deleteCard removes card object');
  assert(!Object.values(nextDeck.cardOrderByCategory || {}).flat().includes(cardId), 'deleteCard removes card id from all category orders');
  assert(nextDeck.cardOrderByCategory[categoryId], 'deleteCard preserves remaining category order list');
}
```

Expected red failure before implementation:

```powershell
node tools\scripts\test-card-decks.mjs
node tools\scripts\test-ui.mjs
```

Implementation:

- Ensure `deleteCard()` removes ids from all category orders.
- Add `cardDeleteConfirmState`.
- Replace immediate delete handlers with arm, confirm, cancel handlers.
- Add outside-click cancel.
- Add Escape cancel.

Verification:

```powershell
node tools\scripts\test-card-decks.mjs
node tools\scripts\test-ui.mjs
```

### Task 4: Active State And Haptics

Files:

- Modify `tools/scripts/test-ui.mjs`
- Modify `src/ui.mjs`
- Modify `styles/recursion.css`

Test first:

```js
assert(/function cardHaptic/.test(recursionUi), 'Card System centralizes mobile haptic feedback');
assert(/navigator\.vibrate/.test(recursionUi), 'Card System uses navigator.vibrate for mobile haptics');
assert(/prefers-reduced-motion:\s*reduce/.test(recursionUi), 'Card haptics respect reduced motion');
assert(!/recursionCardToggle:\s*card\.id/.test(recursionUi), 'Card System removes visible eye enable-disable button');
assert(/is-active/.test(recursionCss) && /is-inactive/.test(recursionCss), 'Card System styles active and inactive cards without eye button');
```

Expected red failure before implementation:

```powershell
node tools\scripts\test-ui.mjs
```

Implementation:

- Add `canUseCardHaptics()`.
- Add `cardHaptic()`.
- Call haptics on long-press armed, active toggle, delete arm, delete confirm, move arm, move target, save, suggestion accept, blocked draft activation.
- Remove visible eye button.
- Add active/inactive CSS.

Verification:

```powershell
node tools\scripts\test-ui.mjs
```

### Task 5: Live Mobile Proof

Files:

- Modify `tools/scripts/prove-card-system-ui.mjs`
- Modify `docs/testing/ARTIFACT_CONTRACT.md`

Proof additions:

- Tap a runnable card and assert active state toggles without editor opening.
- Long-press a card and assert inline editor opens at that card row.
- Tap category delete and assert check/x replace trash.
- Tap outside and assert delete confirmation cancels.
- Tap card delete, confirm, and assert the card disappears from DOM and active deck data.
- Long-press category and assert inline category editor opens.
- Capture mobile screenshot after icon-only compact state.

### Task 6: Heartbeat Dropdown Stability

Files:

- Modify `tools/scripts/test-ui.mjs`
- Modify `src/ui.mjs`

Test first:

```js
assert(/let cardsPanelRenderKey = ''/.test(recursionUi), 'Cards panel tracks render keys so heartbeat refreshes do not close the deck selector');
assert(/function cardsPanelViewKey/.test(recursionUi), 'Cards panel computes a focused render key for card/deck state');
assert(/if \(cardsPanelRenderKey === nextRenderKey\) return/.test(recursionUi), 'Cards panel skips unchanged heartbeat renders while the deck selector is open');
```

Implementation:

- Add a render key scoped to Cards panel content.
- Include `cardScope`, normalized `cardDecks`, notice, editor state, category editor state, move state, and delete confirmation state.
- Exclude heartbeat/progress/status-only view fields.
- Skip `renderCardsPanel()` when the key is unchanged.
- Clear the key when the Cards panel closes.

Verification:

```powershell
node tools\scripts\test-ui.mjs
```

Command:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
$env:RECURSION_SOAK_ST_USERS='recursion-soak-a'
$env:RECURSION_SILLYTAVERN_PASSWORD=''
npm.cmd run prove:card-system-ui -- --live --write-artifacts
```

Expected:

- `status: "pass"`
- Mobile screenshot shows no visible command words on Card System buttons.
- Report includes evidence for tap toggle, long-press edit, delete confirm/cancel, and delete disappearance.

## Final Verification Commands

Run focused checks:

```powershell
node tools\scripts\test-card-decks.mjs
node tools\scripts\test-ui.mjs
npm.cmd run prove:card-system-ui -- --write-artifacts
```

Run full repo gate:

```powershell
npm.cmd test
npm.cmd run check:playwright
```

Run live proof:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
$env:RECURSION_SOAK_ST_USERS='recursion-soak-a'
$env:RECURSION_SILLYTAVERN_PASSWORD=''
npm.cmd run check:soak-users -- --live --write-artifacts
npm.cmd run prove:card-system-ui -- --live --write-artifacts
```

## Acceptance Criteria

- No single tap opens card edit on mobile.
- Card single tap toggles active/inactive.
- Active/inactive is visible from row styling, not an eye button.
- Card press-hold opens inline card editor at the card.
- Category press-hold opens inline category editor.
- Mobile category buttons are Up, Down, Delete only.
- Delete arms check/x confirmation inline.
- Outside interactions cancel pending delete.
- Confirmed card delete removes the card from DOM and active deck data.
- Confirmed category delete removes category, contained cards, order entries, and stale UI state.
- Haptics fire only for meaningful mobile gestures and state changes.
- All Card System command controls remain icon-only with `title` and `aria-label`.
