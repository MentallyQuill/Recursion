# Shared Process Card Drag Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make editable Pre-process and Post-process category/card dragging use one pointer-driven interaction engine and prove real mouse gestures rather than synthetic drag events.

**Architecture:** Keep the independent Pre-process and Post-process deck stores and movement helpers. Give both panel renderers the same generic drag datasets, make the existing pointer/ghost/placeholder/drop-zone engine phase-aware, and route its final commit through the correct phase store. Remove the separate Post-process native HTML drag and touch controller.

**Tech Stack:** Browser-native ES modules, pointer events, Playwright, Node assertion scripts, Recursion settings stores.

## Global Constraints

- Preserve phase-specific deck data and execution semantics.
- Drag starts only from an editable category/card handle.
- Mouse starts immediately; touch and pen retain the existing hold threshold.
- Both phases retain ghost, placeholder, drop-zone, edge-scroll, keyboard, and haptic behavior.
- A heartbeat or panel rerender cannot replace the active drag DOM.
- Browser proof must use real mouse pointer input.

---

### Task 1: Add a failing real-pointer contract

**Files:**
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `tools/scripts/prove-post-process-cards-ui.mjs`
- Modify: `tools/scripts/test-post-process-playwright-contract.mjs`

**Interfaces:**
- Produces: `pointerDragTo(page, source, target)` using `page.mouse`
- Requires: Post-process category/card rows expose generic drag datasets

- [x] Add source assertions requiring both panels to bind the shared pointer handlers and forbidding Post-process `dragstart`, `dragover`, `drop`, and phase-local pointer handlers.
- [x] Replace the successful Post-process category/card `dragTo(...)` calls with `pointerDragTo(...)` that moves the real mouse from the handle center to an explicit insertion zone while holding the primary button.
- [x] Run `node tools/scripts/test-ui.mjs` and `node tools/scripts/test-post-process-playwright-contract.mjs`.
- [x] Confirm both fail because Post-process still owns its separate native-drag controller and does not bind the shared engine.

### Task 2: Share the pointer drag engine

**Files:**
- Modify: `src/ui.mjs`
- Modify: `src/ui/cards-panel.mjs`
- Modify: `styles/recursion.css`

**Interfaces:**
- Consumes: generic `recursionCardDragHandle`, `recursionCardDragId`, `recursionCardDeckCategory`, `recursionCardCategory`, and `recursionCardId` datasets
- Produces: one `beginCardDrag`, `scheduleCardDragUpdate`, `commitCardDrag`, and `cancelCardDrag` path for both phases

- [x] Render the generic category/card/list datasets on Post-process rows while preserving all explicit Post-process selectors.
- [x] Remove `draggable="true"` from Post-process handles.
- [x] Add `phase` and `panel` to shared drag state and resolve all source, drop-zone, hit-test, placeholder, and cleanup queries through `state.panel`.
- [x] Resolve the active deck through `getActiveCardDeck(...)` for `pre` and `getActivePostProcessDeck(...)` for `post`.
- [x] Commit Pre-process moves with `moveCategoryToPosition(...)` or `moveCardToPosition(...)`.
- [x] Commit Post-process moves with `reorderPostProcessCategories(...)` or `movePostProcessCard(...)`, then persist through `applyPostProcessDeckSettings(...)`.
- [x] Bind the same pointerdown/move/up/cancel handlers to both panels.
- [x] Remove `createDeckDragController`, `postProcessDragController`, native HTML drag listeners, and the separate Post-process touch state.
- [x] Generalize drag-state CSS so shared category/card row classes hide and animate identically in both phases.

### Task 3: Verify and integrate

**Files:**
- Verify all modified source, test, proof, CSS, and planning files.

**Interfaces:**
- Consumes: Tasks 1-2
- Produces: rebased, reviewed `post-process-cards` history ready for `card-system`

- [x] Run the two focused tests from Task 1 and confirm green.
- [x] Run `node tools/scripts/test-pre-process-decks.mjs`, `node tools/scripts/test-post-process-decks.mjs`, and `npm.cmd test`.
- [x] Run `npm.cmd run prove:post-process-ui` and inspect desktop and compact pointer-drag scenarios.
- [x] Run `npm.cmd run prove:card-system-ui` to prevent Pre-process drag regression.
- [ ] Run `git diff --check`, review the complete diff, and commit the drag repair.
- [ ] Review branch history and merge the verified branch into `card-system`.
- [ ] Run the full suite on the integrated branch and verify installed copies before reporting completion.
