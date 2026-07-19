# Card Panel Global State and Parity Repair Design

**Date:** 2026-07-19
**Status:** Approved design
**Scope:** Recursion Bar Pre-process/Post-process icons and both card-deck dropdowns

## Goal

Make Pre-process and Post-process Cards behave and read as one compact deck-editor family while preserving their phase-specific card-state semantics. Every operator-selected card, deck, and category-disclosure state must be global extension state rather than chat-scoped or temporary panel state.

## Diagnosed Defects and Root Causes

### 1. Process-card arrows are not legible

Both toolbar buttons contain the supplied arrow geometry in their SVG markup, but the arrows read as absent at normal toolbar size.

Root causes:

- The arrow is scaled to `0.34`, producing an approximately 4-by-6-pixel mark.
- The two buttons use different wrapper rules: Pre-process renders its nominal 17-pixel SVG at 15 pixels while Post-process renders it at 17 pixels.
- Pre-process and Post-process inherit different foreground alpha.
- Post-process Off adds `opacity: 0.48` to the whole button, dimming the cards and arrow together.

### 2. Post-process category disclosure state is forgotten

The Post-process renderer can preserve a partial expanded/collapsed set across ordinary rerenders, but `setPostProcessPanelOpen(false)` explicitly resets that set to `null`. A close/reopen therefore expands every category again.

Pre-process category expansion is also temporary and is cleared when its panel closes. Neither phase currently survives extension remount, page reload, or chat changes.

### 3. Post-process New Category controls diverge from Pre-process

Pre-process uses the shared category-tools row: a compact plus icon in the left action column followed by the `Categories` label. Post-process instead renders a bespoke text-only `New Category` button in its own row.

### 4. Pre-process category descriptions are visibly expanded

Pre-process appends category descriptions as a third visible line in every category header. Post-process currently has equivalent rendering capability, although bundled Post-process categories do not visibly expose description copy in the reproduced starter deck.

The desired contract is tooltip-only category descriptions in both phases.

### 5. White blocks appear below editable Post-process categories

The apparent white block is the existing `Add Card` button. It is placed at the bottom of each expanded category and lacks the shared Recursion button skin, so SillyTavern's default light button appearance dominates.

This defect also makes the card-creation control appear missing or broken.

### 6. Post-process lacks the expected category-level create-card action

Pre-process places a compact plus action in each editable category header. Post-process places its `Add Card` control after the card list instead, which breaks action-rail parity and contributes to the white-block artifact.

### 7. Post-process category drag handles use the wrong visual

Post-process constructs text handles containing `⋮⋮` for both categories and cards. Pre-process uses the shared drag-region helper with distinct category and card handle classes. Consequently, a Post-process category receives the card-like text handle instead of the category handle visual.

### 8. Apply and Flow segments lack tooltips

`As Swipe`, `Replace`, `Unified`, and `Progressive` render without `title` text. The Post-process panel render key also omits `ui.tooltipsEnabled`, so a render-only solution would not reliably restore those tooltips after the setting is turned back on.

## Design

### Shared process-card toolbar icons

Both card buttons will use:

- The same stacked-card SVG geometry.
- The same 17-by-17-pixel wrapper and rendered SVG dimensions.
- The same normal theme-grey foreground and opacity.
- The supplied arrow path, filled with the Recursion Bar background and outlined with the SillyTavern theme body color.
- A larger, recentered arrow that remains inside the front card and is legible at normal toolbar scale.
- A 180-degree rotation for Pre-process and the supplied right-facing orientation for Post-process.

Post-process may still use cyan, warning, or error for meaningful active/runtime states, but its ordinary Off state must not globally dim the shared icon below the ordinary Pre-process icon.

### Global card-panel state

All card-panel operator state is stored in global Recursion extension settings:

- Active Pre-process deck.
- Active Post-process deck.
- Pre-process card selection: Active, Priority, or Inactive.
- Post-process card selection: On or Off. Category activity is derived from child-card state and is not stored independently.
- Per-deck Pre-process category expanded/collapsed state.
- Per-deck Post-process category expanded/collapsed state.

Category disclosure state will be added to the normalized Pre-process and Post-process deck-settings contracts. It will not use chat metadata, save-specific state, or temporary panel-only state as its authority.

Persistence requirements:

- Survives panel rerenders.
- Survives dropdown close/reopen.
- Survives switching chats.
- Survives extension remount.
- Survives page reload by round-tripping through serialized global settings.
- Maintains independent disclosure state for every deck.
- Newly created categories start expanded.
- Duplicated decks inherit the source deck's disclosure state.
- Deleted categories and decks have obsolete disclosure state pruned.
- Bundled initial defaults remain phase-appropriate until the operator changes them: Pre-process categories start collapsed and Post-process categories start expanded.

The UI may keep a pending in-memory mirror only to prevent an optimistic click from snapping back before the asynchronous settings update arrives. Serialized global settings remain authoritative.

### Shared category creation row

Editable Post-process decks will use the same category-tools geometry as Pre-process:

- A shared compact plus icon button in the left column.
- Tooltip and accessible label: `Create a new Category`.
- The visible label `Categories`.
- The same action-rail width and spacing.

The bespoke Post-process `New Category` text row will be removed.

### Tooltip-only category descriptions

Neither phase will render category descriptions as visible category-header children.

When tooltips are enabled:

- Hovering the category disclosure header exposes the category description.
- Category descriptions remain available as accessible descriptive text.

When tooltips are disabled:

- Category-description `title` attributes are absent.
- Disclosure controls keep meaningful ARIA labels and continue working.

The shared category renderer will separate its accessible label from its optional hover title so hiding tooltips never removes the control's accessible name.

### Category header card creation

Every editable Post-process category receives the same compact plus button used by Pre-process:

- It appears in the category header action rail.
- It opens the new-card editor already wired to that category.
- It exposes `Create a new Card in category` through tooltip and ARIA labeling.

The bottom `Add Card` button is removed. Removing that bespoke control also removes the white-block artifact.

### Shared drag-handle visuals

Post-process category and card handles will use the existing shared drag-region renderer:

- Category handles use the category handle class and visual.
- Card handles use the card handle class and visual.
- Existing Post-process drag, keyboard movement, dataset selectors, and focus behavior remain wired.

The shared helper may accept phase-specific dataset attributes so behavior selectors remain explicit without duplicating markup or icon construction.

### Apply and Flow tooltip contract

The four segment tooltips are:

- **As Swipe:** `Add the rewritten response as a new swipe while preserving the current response.`
- **Replace:** `Replace the current response with the rewritten result.`
- **Unified:** `Rewrite once using all enabled Post-process cards together.`
- **Progressive:** `Apply enabled Post-process categories in order, carrying each result forward.`

The Post-process panel render key includes `ui.tooltipsEnabled`.

- Tooltips enabled: all four titles are present.
- Tooltips disabled: all four titles are absent.
- Re-enabling tooltips restores all four titles without requiring a page reload.
- ARIA group labels and pressed states remain available regardless of tooltip setting.

## Data and Compatibility

Recursion is pre-alpha, so the normalized settings schemas will be updated in place without a legacy compatibility layer.

The deck normalizers will accept missing disclosure state as the phase's initial default, then produce one coherent current settings shape. Serialization, duplication, deletion, reset behavior, tests, docs, and examples will use that shape.

Card prompts, Post-process Apply/Flow runtime behavior, card execution order, and provider routing are outside this repair and must remain unchanged.

## Testing Strategy

Automated regression coverage will prove:

1. Both process-card buttons use identical rendered-size and base-color contracts.
2. Both arrows retain fill/outline layers, use opposite directions, and use the enlarged transform.
3. Pre-process and Post-process disclosure state survives normalization and serialized-settings round trips.
4. Disclosure state persists through dropdown close/reopen and a fresh UI mount.
5. Active decks and all existing card/category selection states remain global during those round trips.
6. Newly created categories start expanded.
7. Duplicated decks inherit disclosure state.
8. Deleted categories/decks prune disclosure state.
9. Both category renderers omit visible descriptions and expose tooltip-only copy when enabled.
10. Editable Post-process decks use the shared category-tools row.
11. Each editable Post-process category has a header plus action for card creation.
12. No bottom `Add Card` control or white default block remains.
13. Post-process category and card drag handles use their correct shared visual classes while retaining explicit behavior selectors.
14. Apply/Flow tooltips appear, disappear, and return with the global tooltip setting.
15. Existing card state cycles, bulk eyes, editing, deletion, drag/drop, Apply mode, and Flow mode still pass.

## Live Acceptance Checklist

After repository verification and syncing both served copies to `default-user`:

1. Visually compare the two toolbar icons at normal scale and confirm equal card size/color with legible left/right arrows.
2. Toggle representative Pre-process and Post-process card states, switch chats or remount, and confirm they remain unchanged.
3. Select non-default Pre-process and Post-process decks, remount, and confirm both selections remain active.
4. Collapse different categories in both phases, close/reopen each dropdown, reload the page, and confirm every per-deck state remains.
5. Confirm category descriptions are absent from the visible layout and present on hover while tooltips are enabled.
6. Disable tooltips and confirm category and Apply/Flow hover titles disappear; re-enable and confirm they return.
7. Open an editable Post-process deck and confirm the category-tools row matches Pre-process.
8. Confirm every editable Post-process category has a header plus action that opens a card editor for that category.
9. Confirm there are no white blocks below Post-process categories.
10. Confirm category handles use the category visual and card handles use the card visual.
11. Restore any temporary test deck, card, category, expansion, and selection changes so the human tester receives a clean global state.
