# Recursion Card Drag Handle Polish Design

## Goal

Refine Card System drag handles so they feel like dedicated grab regions instead of extra command buttons, and smooth the drag/drop motion so card and category organization feels deliberate rather than abrupt.

This spec covers:

- removing visible mini-button chrome from drag handles;
- using the supplied `handle-category.svg` and `handle-card.svg` assets;
- preserving the supplied SVGs' intended large/small visual relationship;
- improving drag start, hover, drop, cancel, and autoscroll animation;
- keeping mobile row press-hold edit separate from handle press-hold drag.

No runtime code changes happen in this document. It defines the target behavior, code shape, tests, and implementation plan.

## Current State

The current Card System drag implementation works:

- `cardDragHandle(...)` renders a `cardSystemIconButton('grip', ...)`.
- `src/ui.mjs` starts drag from `[data-recursion-card-drag-handle]`.
- `styles/recursion.css` gives `.recursion-card-drag-handle` grab cursor, touch isolation, and drop feedback.
- Card/category reorders persist through `moveCardToPosition(...)` and `moveCategoryToPosition(...)`.

The remaining UX problems are visual and motion-related:

- the handle still looks like another mini command button;
- category and card handles use the same inline grip icon;
- the supplied Saga-like category/card handle assets are not used;
- row displacement and drop commit feel abrupt.

## Supplied Asset Contract

The provided icons are already designed to create the large/small distinction.

`handle-category.svg`:

```xml
<svg width="800px" height="800px" viewBox="0 0 15 15" ...>
  <!-- dense 4-column dot grip -->
</svg>
```

`handle-card.svg`:

```xml
<svg width="800px" height="800px" viewBox="0 0 36 36" ...>
  <!-- smaller, simpler 2-column dot grip with transparent 36x36 box -->
</svg>
```

Implementation must not force both icons into the same `15px` inline SVG box. The handle region should define the usable target area, while the asset defines the visible handle character.

## Product Direction

Drag handles are not command buttons. Edit, duplicate, and delete are commands. Handles are grab regions.

The UI should read as:

```text
Category: [edit] [delete]    [large naked category handle region]
Card:     [edit] [copy] [delete]    [small naked card handle region]
```

The region remains keyboard-focusable and accessible, but it should not look like a mini button:

- no filled button background;
- no boxed border in the resting state;
- no button hover chrome;
- muted graphite icon at rest;
- subtle cyan tint on hover/focus;
- brighter cyan only while actively dragging;
- visible focus outline for keyboard users.

## Recommended Markup

Keep a real `button` element for accessibility and automated testing, but visually style it as a naked handle region.

```js
function cardDragHandle(kind, id, label, { disabled = false } = {}) {
  return el('button', {
    className: `recursion-card-drag-region recursion-card-drag-region-${kind}`,
    attrs: {
      type: 'button',
      title: label,
      'aria-label': label,
      disabled: disabled ? 'disabled' : undefined
    },
    dataset: {
      recursionCardDragHandle: kind,
      recursionCardDragId: id
    }
  }, [
    el('span', {
      className: `recursion-card-drag-icon recursion-card-drag-icon-${kind}`,
      attrs: { 'aria-hidden': 'true' }
    })
  ]);
}
```

The existing pointer logic can keep using:

```js
const dragHandle = closestDatasetElement(target, 'recursionCardDragHandle', cardsPanel);
```

No behavior should depend on `.recursion-mini-button` for drag handles after this change.

## Asset Placement

Copy the supplied files into repo-owned extension assets:

```text
assets/icons/card-system/handle-category.svg
assets/icons/card-system/handle-card.svg
```

Use CSS masks so color follows Recursion state styling without editing SVG fills:

```css
.recursion-card-drag-icon {
  background: currentColor;
  display: block;
  flex: 0 0 auto;
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
}

.recursion-card-drag-icon-category {
  height: 22px;
  width: 22px;
  mask-image: url("../assets/icons/card-system/handle-category.svg");
}

.recursion-card-drag-icon-card {
  height: 16px;
  width: 16px;
  mask-image: url("../assets/icons/card-system/handle-card.svg");
}
```

The CSS dimensions above are implementation starting points, not icon normalization. They preserve the intended category-larger/card-smaller read while fitting the current row heights. If visual review shows the authored SVGs need slightly different rendered sizes, tune these two classes independently.

## Hit Region Contract

The visible icon and touch target are separate concerns.

```css
.recursion-card-drag-region {
  align-items: center;
  appearance: none;
  background: transparent;
  border: 0;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #d8d8d8) 46%, transparent);
  cursor: grab;
  display: inline-flex;
  justify-content: center;
  margin-left: 8px;
  min-height: 24px;
  padding: 0;
  touch-action: none;
}

.recursion-card-drag-region-category {
  flex: 0 0 32px;
  min-width: 32px;
  width: 32px;
}

.recursion-card-drag-region-card {
  flex: 0 0 28px;
  min-width: 28px;
  width: 28px;
}

.recursion-card-drag-region:hover,
.recursion-card-drag-region:focus-visible {
  color: color-mix(in srgb, var(--recursion-accent) 62%, var(--SmartThemeBodyColor, #d8d8d8));
  outline: 1px solid color-mix(in srgb, var(--recursion-accent) 38%, transparent);
  outline-offset: 1px;
}

.recursion-card-drag-region[aria-pressed="true"] {
  color: color-mix(in srgb, var(--recursion-accent) 86%, var(--SmartThemeBodyColor, #d8d8d8));
  cursor: grabbing;
}
```

Category/card action rails should be sized from actual controls:

```css
.recursion-card-deck-category {
  --recursion-card-action-rail-width: 124px;
}

.recursion-card-deck-card {
  --recursion-card-action-rail-width: 124px;
}
```

The final rail width should be verified visually on desktop and phone. The target is no wrapping, no delete/handle crowding, and no excessive blank space.

## Interaction Rules

### Desktop

- Pointer down on the handle starts drag immediately.
- Pointer down anywhere else on category header toggles collapse/expand.
- Pointer down anywhere else on card row does not drag.
- Hover/focus on handle gives a subtle color/outline cue.
- Active drag sets `aria-pressed="true"` on the handle region.

### Mobile

- Touch on a normal row still uses long-press edit.
- Touch on the handle uses the drag-hold path.
- Movement before drag hold cancels drag setup and allows normal scroll.
- Haptic fires only after drag actually starts.
- Handle region, not icon pixels, is the touch target.

## Animation Direction

Animations should make organization feel smoother without making the compact Cards dropdown feel playful.

Recommended timing:

```js
const CARD_DRAG_LIFT_MS = 100;
const CARD_DRAG_REFLOW_MS = 150;
const CARD_DRAG_DROP_MS = 140;
const CARD_DRAG_CANCEL_MS = 90;
```

Use restrained easing:

```css
:root {
  --recursion-card-drag-ease: cubic-bezier(.2, 0, .18, 1);
  --recursion-card-drag-settle: cubic-bezier(.22, .9, .28, 1);
}
```

Avoid bounce/spring effects.

## Drag Start Feedback

When drag starts:

- source row gets `is-dragging`;
- handle gets `aria-pressed="true"`;
- ghost appears with slight lift and shadow;
- source row dims, but its height remains stable;
- drop line fades in only when a valid target exists.

```css
.recursion-card-drag-ghost {
  opacity: 0;
  transform: translate3d(0, 0, 0) scale(.985);
  transition:
    opacity var(--recursion-card-drag-lift-ms, 100ms) var(--recursion-card-drag-ease),
    transform var(--recursion-card-drag-lift-ms, 100ms) var(--recursion-card-drag-ease);
}

.recursion-card-drag-ghost.is-visible {
  opacity: .94;
  transform: translate3d(0, 0, 0) scale(1.01);
}

.recursion-card-deck-card.is-dragging,
.recursion-card-deck-category.is-dragging > .recursion-card-deck-category-head {
  opacity: .45;
}
```

Implementation detail: because the ghost already follows pointer coordinates through `style.left/top`, avoid animating `left` and `top`. Use a nested child or additional class for lift/settle transforms if needed.

## Drop Target Feedback

Drop target feedback should be layered:

- insertion line: exact drop position;
- category outline: valid category drop zone;
- subtle target header tint when dropping onto a collapsed category.

```css
.recursion-card-drop-line {
  background: color-mix(in srgb, var(--recursion-accent) 72%, transparent);
  border-radius: 999px;
  height: 2px;
  margin: 2px 0;
  opacity: 0;
  transform: scaleX(.72);
  transform-origin: center;
  transition:
    opacity 90ms var(--recursion-card-drag-ease),
    transform 120ms var(--recursion-card-drag-ease);
}

.recursion-card-drop-line.is-visible {
  opacity: 1;
  transform: scaleX(1);
}

.recursion-card-deck-category.is-drop-target {
  outline: 1px solid color-mix(in srgb, var(--recursion-accent) 30%, transparent);
  outline-offset: -1px;
}
```

The current implementation creates/removes the drop line. The polished version should create it once during drag and toggle `is-visible` so it can fade instead of popping.

## Reflow Animation

Use a FLIP-style row movement animation when the drop placeholder changes.

Concept:

```js
function animateCardDragReflow(mutator) {
  const rows = dragAnimatedRows();
  const before = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));

  mutator();

  for (const row of rows) {
    const start = before.get(row);
    const end = row.getBoundingClientRect();
    if (!start || !end) continue;
    const dx = start.left - end.left;
    const dy = start.top - end.top;
    if (!dx && !dy) continue;

    row.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: 'translate(0, 0)' }
    ], {
      duration: CARD_DRAG_REFLOW_MS,
      easing: 'cubic-bezier(.2, 0, .18, 1)'
    });
  }
}
```

Rows eligible for reflow:

```js
function dragAnimatedRows() {
  return [
    ...cardsPanel.querySelectorAll('[data-recursion-card-deck-category]'),
    ...cardsPanel.querySelectorAll('[data-recursion-card-id]')
  ];
}
```

Important constraint: do not run FLIP on every pointermove. Run it only when the computed placeholder target changes.

```js
function setCardDragPlaceholder(state, nextPlaceholder) {
  const previous = stableStringify(state.placeholder || {});
  const next = stableStringify(nextPlaceholder || {});
  if (previous === next) return;
  animateCardDragReflow(() => {
    state.placeholder = nextPlaceholder;
    renderDropLineForPlaceholder(state);
  });
}
```

## Drop Commit Animation

On pointer up:

1. Capture ghost rectangle.
2. Capture final target rectangle if visible.
3. Animate ghost to final target for about `140ms`.
4. Hide ghost.
5. Let settings/render reconcile to final deck state.

```js
async function animateCardDragDropCommit(state, nextDeck) {
  const ghost = cardDragGhost;
  const finalTarget = projectedDropTargetNode(state);
  if (!ghost || !finalTarget) return;

  const from = ghost.getBoundingClientRect();
  const to = finalTarget.getBoundingClientRect();
  await ghost.animate([
    { transform: `translate(0, 0) scale(1.01)`, opacity: .94 },
    { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(1)`, opacity: .75 }
  ], {
    duration: CARD_DRAG_DROP_MS,
    easing: 'cubic-bezier(.22, .9, .28, 1)'
  }).finished.catch(() => {});
}
```

This should be best-effort. If the final target is not visible, commit immediately and clear the ghost.

## Cancel Animation

Cancel should be quiet:

```css
.recursion-card-drag-ghost.is-canceling {
  opacity: 0;
  transform: scale(.985);
  transition:
    opacity 90ms var(--recursion-card-drag-ease),
    transform 90ms var(--recursion-card-drag-ease);
}
```

Do not haptic on cancel.

## Autoscroll Polish

The current autoscroll uses velocity bands. Keep the same structure but smooth the velocity change.

```js
function scrollVelocity(distanceIntoEdge, edge) {
  const ratio = Math.max(0, Math.min(1, distanceIntoEdge / edge));
  const eased = ratio * ratio;
  return Math.ceil(CARD_DRAG_MAX_SCROLL_PX * eased);
}
```

This makes edge entry less jumpy on mobile.

## Reduced Motion

Respect `prefers-reduced-motion`.

```js
function cardDragReducedMotion() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}
```

If reduced motion is active:

- no FLIP row travel;
- no ghost snap animation;
- keep opacity/color/focus changes;
- preserve immediate drop commit.

## Error Handling

Settings failure:

- if `applyCardDeckSettings(...)` fails, show main-bar warning through existing `runAction` failure handling;
- clear ghost and drop line;
- rerender from current view;
- do not leave `is-dragging`, `is-drop-target`, or `aria-pressed` behind.

Panel close/deck switch/heartbeat:

- active drag should still prevent unchanged heartbeat rerender;
- explicit panel close or deck switch cancels drag and clears animations;
- cancel all pending animation handles on teardown.

## Testing And Validation

Static tests:

- drag handles no longer use `cardSystemIconButton('grip', ...)`;
- `cardDragHandle(...)` renders `recursion-card-drag-region`;
- category and card handles use distinct icon classes;
- SVG assets exist under `assets/icons/card-system/`;
- old inline `kind === 'grip'` branch is removed after assets are wired;
- `.recursion-card-drag-region` has transparent/no-border resting style;
- category/card icon sizes differ;
- reduced-motion CSS or JS guard exists.

Unit/helper tests:

- placeholder update animation is skipped when placeholder target does not change;
- reduced-motion disables FLIP/drop travel;
- autoscroll velocity ramps from low to high as pointer moves deeper into edge zone.

Live Playwright checks:

- desktop category handle is visually naked, not a boxed mini button;
- desktop card handle is visually smaller than category handle;
- drag start shows lifted ghost and dimmed source;
- drop line appears with transition class;
- card cross-category drop still persists `categoryId`;
- category reorder still persists `categoryOrder`;
- phone screenshot shows handles aligned without wrapping or delete crowding;
- mobile drag still starts only from handle region, not row body.

Visual review:

- no excessive empty space after delete;
- category handle reads larger/structural;
- card handle reads smaller/quiet;
- focus state is visible but not button-like;
- animations are smooth but restrained.

## Implementation Plan

1. **Add assets**
   - Copy `handle-category.svg` and `handle-card.svg` into `assets/icons/card-system/`.
   - Keep original SVG viewBox data intact.

2. **Replace handle markup**
   - Update `cardDragHandle(...)` to return a naked region button with `recursion-card-drag-region-*` and `recursion-card-drag-icon-*`.
   - Keep the existing data attributes for pointer handlers and tests.

3. **Remove inline grip icon path**
   - Delete the `kind === 'grip'` inline icon branch once no callers use it.
   - Keep `cardSystemIconButton(...)` for real command buttons only.

4. **Update CSS**
   - Add region/icon mask styles.
   - Remove `.recursion-card-drag-handle` mini-button assumptions.
   - Tune action rail width after visual inspection.
   - Add drag ghost/drop line transition classes.

5. **Smooth drag feedback**
   - Add `is-visible` toggling for ghost/drop line.
   - Add placeholder target change detection.
   - Add FLIP reflow only when target changes.
   - Guard all travel animations with reduced-motion checks.

6. **Smooth drop/cancel**
   - Add best-effort drop snap animation.
   - Add quiet cancel fade.
   - Ensure cleanup runs on every exit path.

7. **Autoscroll ramp**
   - Change scroll velocity to eased quadratic ramp.
   - Verify mobile edge scroll remains controllable.

8. **Tests and proof**
   - Update `tools/scripts/test-ui.mjs` static assertions.
   - Extend `tools/scripts/prove-card-system-ui.mjs` to inspect naked handles and size distinction.
   - Run focused tests, full `npm.cmd test`, and live Card System proof with artifacts.

## Recommendation

Implement the visual handle-region conversion first, then animation polish. The handle-region work is mostly deterministic CSS/markup and will immediately reduce visual clutter. FLIP/drop animation should follow as a second patch inside the same feature branch if the first visual pass proves aligned on desktop and phone.
