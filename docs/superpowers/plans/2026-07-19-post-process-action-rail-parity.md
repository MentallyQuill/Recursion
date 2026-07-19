# Post-process Action Rail Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Post-process category eyes and align editable Post-process category/card actions with Pre-process.

**Architecture:** Keep the shared deck category/card renderers authoritative. Remove the Post-process-only category state node and complete its existing fixed-width action rails with the same pre-drag spacing used by Pre-process.

**Tech Stack:** JavaScript ES modules, CSS, fake-DOM UI regression tests, SillyTavern live host.

## Global Constraints

- Preserve persisted Post-process category state and runtime semantics.
- Keep Post-process card-level visibility controls.
- Keep the shared `124px` action-rail geometry.
- Sync verified production changes to `default-user` and the public served copy.

---

### Task 1: Align Post-process category and card controls

**Files:**
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`

**Interfaces:**
- Consumes: `renderDeckCategory(options)` and `renderDeckCard(options)` from `src/ui/cards-panel.mjs`.
- Produces: Post-process categories without `data-recursion-post-process-category-toggle`; unchanged card-level `data-recursion-post-process-card-toggle`; aligned `recursion-post-process-row-actions`.

- [x] **Step 1: Write the failing UI assertions**

Assert that Post-process categories render no category toggle, card toggles remain, custom category/card action datasets retain their approved order, and CSS reserves `8px` before Post-process drag handles.

- [x] **Step 2: Run the focused test**

Run: `node tools/scripts/test-ui.mjs`

Expected: FAIL because category eyes still render and Post-process drag handles lack reserved spacing.

- [x] **Step 3: Implement the minimal UI change**

Delete the Post-process category-toggle node and the `state` argument passed to `renderDeckCategory`. Remove its dead click handler. Add:

```css
.recursion-post-process-row-actions .recursion-card-drag-region {
  margin-left: 8px;
}
```

Update the design docs to state that Post-process category headers have no state control while card rows retain binary eyes.

- [x] **Step 4: Verify focused and full tests**

Run:

```powershell
node tools/scripts/test-ui.mjs
npm.cmd test
```

Expected: UI test passes and all test scripts pass.

- [x] **Step 5: Sync and verify live**

Copy the changed production files to both installed copies, confirm SHA-256 matches, reload the live host, and verify the Post-process custom-deck action rails and absence of category eyes.
