# Recursion Bar And Settings Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the V1 Recursion bar mockup into the actual SillyTavern extension UI, add the integrated settings popover with complete provider controls, and verify visual/function behavior.

**Architecture:** Keep `src/progress.mjs` as the normalized progress model. Render the compact bar, Hero Pixel Array, progress popover, mode menu, Last Brief dropdown, options/settings menu, and viewer from `src/ui.mjs`; style them through `styles/recursion.css`; keep docs/tests aligned with `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md` and `docs/design/UI_SPEC.md`.

**Tech Stack:** JavaScript ES modules, DOM APIs, SillyTavern theme variables, Node test scripts, Playwright live smoke where available.

---

## File Structure

- `src/settings.mjs` - add user-facing `reasoningLevel` normalization and persistence.
- `src/runtime.mjs` - surface `reasoningLevel` safely to runtime/arbiter views.
- `src/ui.mjs` - render the compact mockup-derived UI and settings tabs.
- `styles/recursion.css` - SillyTavern-native layout, popovers, Hero Pixel Array, reasoning chain, settings menu, provider cards.
- `tools/scripts/test-settings.mjs` - setting normalization and partial update coverage.
- `tools/scripts/test-ui.mjs` - fake DOM coverage for compact bar, progress/menu controls, settings tabs, provider actions, and secrets.
- `docs/design/UI_SPEC.md` - document the integrated settings menu and reasoning level contract.

---

### Task 1: Reasoning Level Setting Contract

**Files:**
- Modify: `src/settings.mjs`
- Modify: `src/runtime.mjs`
- Test: `tools/scripts/test-settings.mjs`

- [x] Add failing tests for `reasoningLevel: low|medium|high|ultra`, default `high`, invalid fallback, and partial update preservation.
- [x] Add `reasoningLevel` to normalized/default settings.
- [x] Expose `reasoningLevel` in safe settings views and Arbiter-safe settings.
- [x] Run `npm.cmd run test:settings` and `npm.cmd run test:runtime`.

### Task 2: Actual Compact Bar UI

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Test: `tools/scripts/test-ui.mjs`

- [x] Add failing fake-DOM assertions for `RECURSION`, mode icon button/menu, Hero Pixel Array, progress popover, dropdown arrow Last Brief, ellipsis options, and right-side reasoning chain.
- [x] Replace chip-heavy bar DOM with compact mockup-derived zones.
- [x] Render progress rows and Hero Pixel Array from `createProgressRunModel()` and `createHeroPixelBlocks()`.
- [x] Preserve settings, provider, prompt-packet copy, and viewer behavior through current compact paths.
- [x] Run `npm.cmd run test:ui`.

### Task 3: Integrated Settings Popover

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Test: `tools/scripts/test-ui.mjs`

- [x] Add failing fake-DOM assertions for Play, Providers, and Advanced tabs.
- [x] Make Play default: Mode, Reasoning Level, Strength, Focus, Prompt Footprint.
- [x] Put complete Utility/Reasoner provider cards in Providers tab.
- [x] Put progress row limits and diagnostics actions in Advanced tab.
- [x] Position settings popover to align right edge with the bar and sit beside the progress popover on desktop.
- [x] Run `npm.cmd run test:ui`.

### Task 4: Docs And Mockup Sync

**Files:**
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md` only if implementation contract changes.
- Modify: `tools/scripts/build-recursion-bar-preview.mjs` only if preview generation needs updates.

- [x] Document `reasoningLevel` as the authoritative user-facing control with derived internal routing.
- [x] Document desktop settings popover geometry beside the progress menu.
- [x] Rebuild preview with `node tools/scripts/build-recursion-bar-preview.mjs`.
- [x] Run `npm.cmd run test:ui`.

### Task 5: Review And Verification

**Files:**
- No planned edits unless review finds defects.

- [x] Run `npm.cmd test`.
- [x] Dispatch focused reviewer for UI/settings diff.
- [x] Fix actionable review findings.
- [x] Verify mockup in browser.
- [x] Run SillyTavern Playwright smoke or document exact blocker and strongest available local proof.
