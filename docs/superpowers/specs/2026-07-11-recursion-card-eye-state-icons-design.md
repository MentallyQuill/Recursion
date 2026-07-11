# Recursion Card Eye State Icons And Bulk Deck Actions Design

## Goal

Replace the Card Deck card-state visual language with the three supplied eye icons:

- `eye-inactive.svg`: Inactive card
- `eye-active.svg`: Active card
- `eye-priority.svg`: Priority card

This resolves the check/X ambiguity created by using the same icons for card state and accept/cancel/delete-confirm actions. Check and X remain reserved for confirmation flows. Card state becomes a visibility/participation language: hidden from runtime, visible to runtime, or visible and prioritized.

The same icon language also applies to deck-level bulk actions:

- open eye: set all runnable cards to normal Active, clearing Priority
- slashed eye: set all runnable cards to Inactive

No code implementation happens as part of this spec. This document defines the implementation contract and plan for the next coding pass.

## Context

The current Card System work already establishes:

- Card Decks as the primary Cards dropdown surface.
- Read-only bundled Default deck.
- Editable duplicated/custom decks.
- Collapsed categories by default.
- Inline card/category editing.
- Press-hold editing on mobile.
- Delete confirmation via inline check/X replacement, not popups.
- Card selection state as `off | active | priority`.
- Auto state cycle: `Inactive -> Active -> Priority -> Inactive`.
- Manual state cycle: `Inactive -> Active -> Inactive`.
- Main Recursion bar status as the transient feedback channel.
- No transient yellow notice rows inside the Cards dropdown.

This spec supersedes the earlier check/X/up-arrow visual-state detail while preserving the data model and runtime behavior.

## Design Decision

Use eye icons for card participation state.

| State | Icon | Color | Row Treatment | Runtime Meaning |
| --- | --- | --- | --- | --- |
| Inactive | slashed eye | muted foreground | muted row, no cyan rail | excluded from deck runtime scope |
| Active | open eye | Recursion cyan | standard cyan left rail/card highlight | eligible for Auto backfill or Manual forcing |
| Priority | eye with plus | bright cyan | stronger cyan rail/card highlight | forced into Auto hand before Active backfill |
| Draft | compact draft metadata icon | muted warning-neutral | draft row treatment | not runnable until edited |

The eye-plus icon is intentionally not an up-arrow. Priority is still "forced first before backfill," but the visual reads as "extra-visible/boosted participation" rather than "move upward." The move button already uses movement language, and categories already use up/down arrows, so the plus-eye avoids symbol collision.

## Icon Asset Contract

The source SVGs are currently external files:

```text
C:/Users/Keptin/Downloads/eye-inactive.svg
C:/Users/Keptin/Downloads/eye-active.svg
C:/Users/Keptin/Downloads/eye-priority.svg
```

The implementation should copy them into the repo as stable assets:

```text
assets/icons/card-state/eye-inactive.svg
assets/icons/card-state/eye-active.svg
assets/icons/card-state/eye-priority.svg
```

They must be normalized before use:

- remove fixed `width="800px"` and `height="800px"`;
- keep `viewBox="0 0 24 24"`;
- replace `fill="#000000"` with `fill="currentColor"`;
- remove source comments that do not need to ship in the extension;
- keep the icons as single-color symbols so CSS owns state color.

Target normalized shape:

```svg
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <path fill="currentColor" d="..." />
</svg>
```

Runtime rendering must clamp them to the existing Card System icon size. The source art size must not leak into layout.

```css
.recursion-card-system-icon,
.recursion-card-state-icon {
  width: 15px;
  height: 15px;
  display: inline-block;
  flex: 0 0 15px;
  color: currentColor;
}
```

## UI Contract

### Card Row State

Card rows continue to own one state affordance in the status slot. Do not add a separate Priority button.

```js
function cardDeckCardStatePresentation(card, mode = 'auto') {
  const status = getDeckCardStatus(card);
  if (!status.runnable && status.reason !== 'disabled') {
    return {
      state: 'draft',
      className: 'is-draft',
      icon: 'draft',
      title: 'Draft card needs editing before it will run.',
      label: 'Draft card needs editing',
      nextStatus: 'Draft card needs editing before it can run.'
    };
  }

  const state = cardSelectionState(card);
  if (state === 'priority' && mode === 'auto') {
    return {
      state,
      className: 'is-priority',
      icon: 'eye-priority',
      title: 'Priority: forced into Auto hand before backfill.',
      label: 'Priority card',
      nextStatus: 'Card disabled.'
    };
  }

  if (state === 'off') {
    return {
      state,
      className: 'is-inactive',
      icon: 'eye-inactive',
      title: 'Inactive. Tap to enable.',
      label: 'Inactive card',
      nextStatus: 'Card enabled.'
    };
  }

  return {
    state: 'active',
    className: 'is-active',
    icon: 'eye-active',
    title: mode === 'auto' ? 'Active. Tap to prioritize.' : 'Active. Tap to disable.',
    label: 'Active card',
    nextStatus: mode === 'auto' ? 'Card prioritized.' : 'Card disabled.'
  };
}
```

Manual still treats stored Priority as Active for behavior. In Manual, a Priority-stored row may render with the Active open-eye icon and a tooltip note:

```text
Active. Priority is used in Auto; Manual forces active cards directly.
```

### Deck Header Bulk Actions

The Cards header should replace the single check button with two icon-only controls beside the summary.

```text
Cards                 32/34 active, 2 priority   [eye] [eye-off]
```

- `[eye]`: set all runnable cards to normal Active and clear Priority.
- `[eye-off]`: set all runnable cards to Inactive.
- Draft cards are unchanged by both actions.
- Read-only Default deck disables both actions and exposes tooltip copy explaining that the deck must be duplicated before editing.

Suggested render snippet:

```js
el('span', { className: 'recursion-cards-head-actions' }, [
  el('span', { className: 'recursion-cards-summary', text: deckCardSummary(counts) }),
  cardSystemIconButton('eye-active', 'Set all runnable cards to Active.', {
    recursionCardDeckActivateAll: ''
  }, {
    disabled: activeDeck.readonly || counts.eligible === 0 || counts.allNormalActive
  }),
  cardSystemIconButton('eye-inactive', 'Set all runnable cards to Inactive.', {
    recursionCardDeckDeactivateAll: ''
  }, {
    disabled: activeDeck.readonly || counts.eligible === 0 || counts.active === 0
  })
]);
```

The previous "Enable all runnable cards" copy should be removed. The action is now explicitly "Set all runnable cards to Active" because it also clears Priority.

### Summary Copy

The Cards header summary should include Priority only when present:

```js
function deckCardSummary(counts) {
  const base = `${counts.active}/${counts.eligible} active`;
  const priority = counts.priority > 0 ? `, ${counts.priority} priority` : '';
  const draft = counts.draft > 0 ? `, ${counts.draft} draft` : '';
  return `${base}${priority}${draft}`;
}
```

`active` includes both Active and Priority because Priority cards are active participants. `priority` is a secondary count, not a separate denominator.

### Main Bar Status Copy

All committed state changes route through the main Recursion bar status area and the mobile status drawer.

```js
const CARD_SYSTEM_STATUS_COPY = {
  cardInactive: 'Card disabled.',
  cardActive: 'Card enabled.',
  cardPriority: 'Card prioritized.',
  activateAll: 'All cards set Active.',
  deactivateAll: 'All cards disabled.',
  draftBlocked: 'Draft card needs editing before it can run.'
};
```

The Cards dropdown must not reintroduce local yellow notice rows.

## Data Contract

Keep the existing explicit selection field:

```ts
type CardSelectionState = "off" | "active" | "priority";
```

Bulk action helpers should write that field directly:

```js
function activateAllRunnableDeckCards(deck) {
  if (deck?.readonly) return deck;
  let nextDeck = deck;
  for (const card of Object.values(asObject(deck?.cards))) {
    const status = getDeckCardStatus(card);
    if (status.runnable || status.reason === 'disabled') {
      nextDeck = updateCardSelectionState(nextDeck, card.id, 'active');
    }
  }
  return nextDeck;
}

function deactivateAllRunnableDeckCards(deck) {
  if (deck?.readonly) return deck;
  let nextDeck = deck;
  for (const card of Object.values(asObject(deck?.cards))) {
    const status = getDeckCardStatus(card);
    if (status.runnable || status.reason === 'disabled') {
      nextDeck = updateCardSelectionState(nextDeck, card.id, 'off');
    }
  }
  return nextDeck;
}
```

The old helper name `enableAllRunnableDeckCards` should be renamed to `activateAllRunnableDeckCards` or kept only as a local alias during the edit. The product language should not say "enable all" anymore.

## Icon Rendering Integration

The current inline `cardSystemIconSvg(kind)` helper can keep owning Card System icons. Add the three eye states as named icon kinds.

Recommended implementation direction:

```js
const CARD_STATE_ICON_PATHS = {
  'eye-active': 'M2.062,12.346C3.773,17,7.675,20,12,20s8.227-3,9.938-7.654...',
  'eye-inactive': 'M2.293,21.707a1,1,0,0,0,1.414,0l3.2-3.2...',
  'eye-priority': 'M12,7a4,4,0,1,0,4,4A4,4,0,0,0,12,7Z...'
};

function cardSystemIconSvg(kind) {
  if (CARD_STATE_ICON_PATHS[kind]) {
    return el('svg', {
      attrs: {
        width: '15',
        height: '15',
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        focusable: 'false'
      }
    }, [
      el('path', { attrs: { fill: 'currentColor', d: CARD_STATE_ICON_PATHS[kind] } })
    ]);
  }

  // Existing plus/copy/delete/move/edit/category icons remain here.
}
```

If the repo prefers file-backed SVG masks for custom icons, use masks instead, but keep the same `kind` contract:

```css
.recursion-card-state-icon[data-kind="eye-priority"] {
  mask: url("../assets/icons/card-state/eye-priority.svg") center / 15px 15px no-repeat;
  -webkit-mask: url("../assets/icons/card-state/eye-priority.svg") center / 15px 15px no-repeat;
  background: currentColor;
}
```

Inline paths are simpler for the current `src/ui.mjs` rendering style and avoid asset loading path issues inside SillyTavern extension mounts.

## CSS Contract

State color belongs to row classes and the icon inherits with `currentColor`.

```css
.recursion-card-deck-card.is-inactive {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #d8d8d8) 62%, transparent);
}

.recursion-card-deck-card.is-inactive .recursion-card-deck-card-status {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #d8d8d8) 46%, transparent);
}

.recursion-card-deck-card.is-active {
  border-left-color: var(--recursion-primary, #65d6e8);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--recursion-primary, #65d6e8) 82%, transparent);
}

.recursion-card-deck-card.is-active .recursion-card-deck-card-status {
  color: var(--recursion-primary, #65d6e8);
}

.recursion-card-deck-card.is-priority {
  border-left-color: #8eefff;
  box-shadow:
    inset 3px 0 0 #8eefff,
    inset 0 0 0 1px color-mix(in srgb, #8eefff 34%, transparent);
}

.recursion-card-deck-card.is-priority .recursion-card-deck-card-status {
  color: #8eefff;
}
```

The Priority highlight may be brighter than Active, but it should remain compact graphite UI. Do not add broad glow, animated effects, or colored row backgrounds.

## Accessibility

Icon-only controls need labels and tooltips:

```js
cardSystemIconButton('eye-active', 'Set all runnable cards to Active.', {
  recursionCardDeckActivateAll: ''
});

cardSystemIconButton('eye-inactive', 'Set all runnable cards to Inactive.', {
  recursionCardDeckDeactivateAll: ''
});
```

Card row state labels:

```text
Inactive card
Active card
Priority card
Draft card
```

Card row tooltips include the next tap action:

```text
Inactive. Tap to enable.
Active. Tap to prioritize.
Priority: forced into Auto hand before backfill. Tap to disable.
```

Keyboard Enter/Space on the card row uses the same state cycle as click/tap. Press-hold mobile editing remains separate from the single-tap state cycle.

## Testing And Validation

Deterministic tests:

- Card state presentation maps `off -> eye-inactive`, `active -> eye-active`, and Auto `priority -> eye-priority`.
- Manual renders stored Priority as Active behavior, with Active tooltip language.
- The Cards header renders both `recursionCardDeckActivateAll` and `recursionCardDeckDeactivateAll`.
- The activate-all action sets every runnable/disabled card to `selectionState: "active"` and clears all Priority states.
- The deactivate-all action sets every runnable/disabled card to `selectionState: "off"`.
- Draft cards are unchanged by both bulk actions.
- Check/X icons are not used for card state presentation.
- Check/X remain used for confirm/cancel actions.
- Header summary includes Priority count only when `priority > 0`.
- Main bar status receives `All cards set Active.` and `All cards disabled.`

Playwright/live validation:

- Desktop Cards dropdown: card row state cycles through slashed eye, open eye, eye-plus, slashed eye.
- Mobile Cards dropdown: tap cycles state; press-hold still opens the inline editor and does not toggle state.
- Card icons match Recursion color states: muted inactive, cyan active, bright cyan priority.
- All card-state icons render at the same visual scale as copy/move/delete/edit buttons.
- Header open-eye bulk action clears Priority and leaves all runnable cards Active.
- Header slashed-eye bulk action makes all runnable cards Inactive.
- Confirm/cancel flows still use check/X, proving icon meanings are separated.
- Refresh heartbeat does not close the deck selector or erase the open Cards dropdown state.

## Integration Plan

1. **Add icon assets or inline paths**
   - Copy the three supplied SVGs into `assets/icons/card-state/`.
   - Normalize them to `currentColor`, `viewBox="0 0 24 24"`, and no fixed pixel dimensions.
   - Add `eye-active`, `eye-inactive`, and `eye-priority` cases to `cardSystemIconSvg(kind)`.

2. **Update card-state presentation**
   - Replace `x`, `check`, and `arrow-up` state icons in `cardDeckCardStatePresentation(...)`.
   - Keep the existing `is-inactive`, `is-active`, `is-priority`, and `is-draft` classes.
   - Preserve current state-cycle behavior and main-bar status routing.

3. **Replace deck header bulk action**
   - Replace the single `recursionCardDeckAll` check action with `recursionCardDeckActivateAll` and `recursionCardDeckDeactivateAll`.
   - Rename UI copy from "Enable all runnable cards" to "Set all runnable cards to Active."
   - Add `deactivateAllRunnableDeckCards(deck)`.
   - Make activate-all clear Priority by writing `selectionState: "active"`.

4. **Update CSS**
   - Ensure card-state icons inherit row status color.
   - Confirm state icons are 15px and do not stretch from source SVG dimensions.
   - Keep delete-button spacing compact and unchanged by state icon rendering.

5. **Update docs**
   - Update `docs/design/UI_SPEC.md`.
   - Update `docs/design/CARD_SYSTEM_SPEC.md`.
   - Update `docs/technical/CARD_DECK_AND_HAND.md`.
   - Mark this spec as superseding the older check/X/up-arrow visual-state contract.

6. **Update tests**
   - Update `tools/scripts/test-ui.mjs` static assertions.
   - Update `tools/scripts/prove-card-system-ui.mjs` Playwright selectors and visual checks.
   - Keep existing card-deck and runtime Priority tests; add bulk deactivate and activate-clears-priority coverage.

7. **Verify**
   - Run focused UI/card tests.
   - Run full `npm.cmd test`.
   - Sync the served SillyTavern extension copy.
   - Run live Card System Playwright proof against the served host.

## Open Decisions

No product blockers remain.

Chosen direction:

- eye icons represent card participation state;
- check/X are reserved for accept/cancel/confirm flows;
- eye-plus represents Priority;
- deck header gets open-eye and slashed-eye bulk actions;
- activating all cards clears Priority;
- deactivating all cards sets runnable cards Off;
- all transient action feedback stays in the main Recursion bar.
