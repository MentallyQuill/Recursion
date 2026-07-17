# Redirect Reasoner Routing and Status Severity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Medium+ Redirect prose through exactly two Reasoner attempts and make warning/error status messages visibly use Recursion's existing severity colors.

**Architecture:** `src/runtime.mjs` selects a Redirect-specific writer lane and owns its two-attempt correction loop. `src/providers.mjs` exposes an explicit one-attempt option so the runtime ceiling reflects actual model calls. The view model derives one visible status severity, while `src/ui.mjs` and `styles/recursion.css` project it onto existing status surfaces.

**Tech Stack:** JavaScript ESM, CSS, Node test scripts, SillyTavern extension runtime.

## Global Constraints

- Low Redirect transformation uses Utility.
- Medium, High, and Ultra Redirect transformation use Reasoner.
- Medium+ makes exactly two Reasoner writer attempts before terminal failure and never falls back to Utility.
- Error text uses `--recursion-error`; warning text uses `--recursion-warning`.
- No new ribbon, toast, or chat-prose styling.
- Update code, docs, tests, and installed extension copies in place.

---

### Task 1: Redirect Writer Routing

**Files:**
- Modify: `tools/scripts/test-editorial-runtime.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/providers.mjs`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`

**Interfaces:**
- Consumes: `reasoningPolicyForSettings(settings)`, `generationRouter.generate(roleId, request, options)`
- Produces: Redirect-specific transformer lane selection and `options.maxAttempts`

- [ ] Add assertions for Low Utility, Medium+ Reasoner, two failed Reasoner calls, correction context, no Utility fallback, no swipe, and original preservation.
- [ ] Add a provider-router assertion that `maxAttempts: 1` suppresses provider-internal retry.
- [ ] Run `node tools/scripts/test-editorial-runtime.mjs` and `node tools/scripts/test-providers.mjs`; confirm the new assertions fail for current routing/retry behavior.
- [ ] Implement Redirect writer lane selection, the bounded writer correction loop, and explicit provider `maxAttempts`.
- [ ] Run both focused scripts and confirm they pass.

### Task 2: Severity-Colored Status Messages

**Files:**
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `src/ui/view-model.mjs`
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`

**Interfaces:**
- Consumes: normalized activity severity and `progressRun.steps[]`
- Produces: `model.statusSeverity` and `data-recursion-severity`

- [ ] Add assertions for warning/error severity projection on desktop status, mobile drawer, progress header/subtitle, and warning/failed row text.
- [ ] Run `node tools/scripts/test-ui.mjs`; confirm the new assertions fail.
- [ ] Derive status severity from activity and nested progress state, with failure taking precedence over warning.
- [ ] Apply severity attributes and existing color tokens to the approved status surfaces.
- [ ] Run `node tools/scripts/test-ui.mjs`; confirm it passes.

### Task 3: Regression and Deployment

**Files:**
- Deploy repository production files to the `default-user` Recursion installation.

- [ ] Run `npm.cmd test` and require all scripts to pass.
- [ ] Synchronize the tested source to `default-user` without touching chats or settings.
- [ ] Compare hashes for all production files under `src`, `styles`, `assets`, and `manifest.json` against both installed and served copies.
