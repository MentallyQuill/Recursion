# Card Panel Global State and Parity Repair Implementation Plan

> **For Codex:** Use the executing-plans skill to implement this plan task-by-task, with a red/green test cycle for every behavior change.

**Goal:** Make the Pre-process and Post-process card controls visually consistent, move all deck/card/category disclosure choices into global Recursion settings, and preserve the existing phase-specific behavior.

**Architecture:** Extend both normalized deck-settings schemas with a per-deck category-expansion map. The deck modules own normalization, defaults, duplication, and pruning; the UI renders directly from normalized global settings and writes disclosure clicks back through `runtime.updateSettings`. Shared UI helpers provide the category header, drag handles, toolbar icon wrapper, and tooltip behavior.

**Tech Stack:** Browser-native ES modules, DOM rendering helpers, Recursion settings store, CSS, Node assertion scripts, Playwright visual-contract scripts.

---

## Task 1: Persist Pre-process category disclosure globally

**Files:**
- Modify: `src/pre-process-decks.mjs`
- Modify: `src/settings.mjs`
- Test: `tools/scripts/test-pre-process-decks.mjs`
- Test: `tools/scripts/test-settings.mjs`

1. Add failing tests proving:
   - Missing expansion state defaults to collapsed.
   - A category can be expanded and survives JSON serialization plus normalization.
   - Duplicated decks inherit source expansion.
   - Deleted categories and decks prune stale expansion.
   - Default Recursion settings contain the current expansion shape.
2. Run:
   - `node tools/scripts/test-pre-process-decks.mjs`
   - `node tools/scripts/test-settings.mjs`
   Confirm the new assertions fail for missing expansion support.
3. Add `categoryExpansion` to the normalized Pre-process settings schema and export query/update helpers.
4. Normalize expansion entries only for existing deck/category IDs, copy expansion during deck duplication, and let normalization prune deleted entries.
5. Add `categoryExpansion: {}` to the default settings contract and bump the deck-settings schema version in place.
6. Re-run both focused tests and confirm green.

## Task 2: Persist Post-process category disclosure globally

**Files:**
- Modify: `src/post-process-decks.mjs`
- Modify: `src/settings.mjs`
- Test: `tools/scripts/test-post-process-decks.mjs`
- Test: `tools/scripts/test-settings.mjs`

1. Add failing tests proving:
   - Missing expansion state defaults to expanded.
   - A category can be collapsed and survives JSON serialization plus normalization.
   - Duplicated decks inherit source expansion under remapped category IDs.
   - Deleted categories and decks prune stale expansion.
2. Run:
   - `node tools/scripts/test-post-process-decks.mjs`
   - `node tools/scripts/test-settings.mjs`
   Confirm the new assertions fail.
3. Add the matching normalized expansion schema and exported helpers to Post-process deck settings.
4. Copy source disclosure values to remapped duplicate-category IDs and normalize deletion results to prune stale state.
5. Re-run both focused tests and confirm green.

## Task 3: Render category disclosure from global settings

**Files:**
- Modify: `src/ui.mjs`
- Test: `tools/scripts/test-ui.mjs`

1. Replace tests that assert local expansion-set authority with failing tests that require:
   - Pre-process and Post-process disclosure clicks to call `runtime.updateSettings`.
   - State to survive panel close/reopen.
   - State to survive a fresh UI mount using serialized settings.
   - New categories to be stored expanded.
2. Run `node tools/scripts/test-ui.mjs` and confirm the new persistence assertions fail.
3. Remove close-time expansion resets and render expansion through the deck-module helpers.
4. On disclosure clicks, update global deck settings and use only a short-lived pending settings mirror for optimistic rendering.
5. Store newly created categories as expanded.
6. Include normalized deck settings in each panel render key so external/global changes rerender correctly.
7. Re-run `node tools/scripts/test-ui.mjs` and confirm green.

## Task 4: Unify process-card toolbar icons

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Test: `tools/scripts/test-ui.mjs`

1. Add failing source/DOM assertions for:
   - A shared 17-by-17 wrapper class on both buttons.
   - The same ordinary theme-grey base color and opacity.
   - No whole-button dimming for normal Post-process Off.
   - A larger centered arrow transform with opposite Pre/Post directions.
2. Run `node tools/scripts/test-ui.mjs` and confirm failure against the current wrappers/transform.
3. Apply one shared toolbar-icon wrapper and base-state class to both buttons.
4. Recenter and enlarge the supplied arrow inside the cards SVG; retain bar-background fill and theme-body outline.
5. Keep runtime warning/error/active state colors without dimming the normal Off icon.
6. Re-run the focused UI test.

## Task 5: Unify category headers, creation controls, and drag handles

**Files:**
- Modify: `src/ui.mjs`
- Modify: `src/ui/cards-panel.mjs`
- Modify: `styles/recursion.css`
- Test: `tools/scripts/test-ui.mjs`
- Test: `tools/scripts/test-post-process-playwright-contract.mjs`

1. Add failing assertions proving:
   - Editable Post-process decks use the shared `recursion-card-deck-tools` row and `Categories` label.
   - Each editable Post-process category has a header plus button wired to its category.
   - No bottom `Add Card` control remains.
   - Category/card handles use distinct shared visual classes while keeping phase-specific datasets.
2. Run the focused UI and Playwright-contract tests and observe red.
3. Extend the shared drag-handle helper to accept phase-specific dataset attributes.
4. Replace bespoke Post-process category/card handles with the shared helper.
5. Replace the Post-process `New Category` row with the shared category-tools geometry.
6. Move create-card into each editable category action rail and remove the bottom control and obsolete CSS.
7. Re-run both focused tests.

## Task 6: Make category descriptions tooltip-only and wire segment tooltips

**Files:**
- Modify: `src/ui.mjs`
- Modify: `src/ui/cards-panel.mjs`
- Test: `tools/scripts/test-ui.mjs`

1. Add failing tests proving:
   - Neither phase renders category descriptions as visible header children.
   - Category descriptions appear as `title` only when global tooltips are enabled.
   - Category disclosure keeps an accessible ARIA label when hover titles are disabled.
   - All four Apply/Flow segments use the approved tooltip copy.
   - Turning tooltips off removes titles and turning them back on restores them without remount.
2. Run `node tools/scripts/test-ui.mjs` and confirm red.
3. Separate `headerTitle` from `headerAriaLabel` in the shared category renderer.
4. Remove visible category-description elements from both panel renderers and pass conditional hover titles.
5. Add exact conditional titles to `As Swipe`, `Replace`, `Unified`, and `Progressive`.
6. Add `ui.tooltipsEnabled` to the Post-process render key.
7. Re-run the UI test.

## Task 7: Update the visual contract documentation

**Files:**
- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`

1. Document shared process-card icon geometry, tooltip-only category descriptions, shared category creation/actions, and global per-deck disclosure persistence.
2. Preserve the distinction between visible card descriptions and hidden category descriptions.
3. Review the diff for terminology consistency with Pre-process/Post-process and global extension settings.

## Task 8: Full verification and live sync

**Files:**
- Verify all changed production/test/doc files.
- Sync production files to:
  - `F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion`
  - `F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion`

1. Run the focused deck, settings, UI, and Playwright-contract scripts.
2. Run `npm.cmd test`.
3. Run the Post-process visual proof workflow and inspect the generated screenshots for all eight diagnosed defects.
4. Sync only the verified production extension files, excluding repository/test/tooling folders.
5. Run `node tools/scripts/verify-installed-copy.mjs --user default-user`.
6. Use the live browser to verify:
   - equal icons and legible arrows;
   - global card/deck/disclosure state after close/reopen and reload;
   - tooltip enable/disable/restore;
   - category creation rail, header plus buttons, correct handles, and no white blocks.
7. Restore any temporary live test state and report each requirement with its verification evidence.
