# Recovered Post-process Failure Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve why the first SillyTavern Post-process rewrite attempt failed when the second attempt succeeds, while replacing the misleading generic action with cause-specific recovered copy.

**Architecture:** `rewriteWithRetry` captures the sanitized structural code for each failed host attempt. A successful retry propagates that code through the category outcome, activity failure descriptor, runtime diagnostics, and persisted Post-process marker. Progress consumes the existing descriptor contract; no new UI component or per-attempt logging system is introduced.

**Tech Stack:** Browser-native ECMAScript modules, Node script tests, existing Post-process activity/progress model.

## Global Constraints

- Preserve only stable `RECURSION_*` codes and fixed user copy; never persist raw exception messages or model output.
- A recovered retry remains warning/amber and the final category status remains `success`.
- Do not show a `Try:` action after the retry already succeeded.
- Preserve the two-attempt retry limit and identical host packets.
- Update the V1 marker contract in place because Recursion is pre-alpha.

---

### Task 1: Capture and persist the recovered host failure code

**Files:**
- Modify: `tools/scripts/test-post-process-runtime.mjs`
- Modify: `src/post-process-runtime.mjs`

**Interfaces:**
- Consumes: host rewrite results shaped as `{ ok, text, error?: { code } }`.
- Produces: successful category outcomes with optional `recoveredFailureCode`.

- [ ] Add a failing regression to Unified host recovery asserting that the result outcome, commit marker category, diagnostics category, and warning activity all retain `RECURSION_TEST_HOST_FAILED`.
- [ ] Assert the warning activity uses fixed recovered copy and omits `suggestedAction` and raw host error text.
- [ ] Run `node tools/scripts/test-post-process-runtime.mjs`; expect failure because successful retries currently discard the first failure code.
- [ ] Track the most recent failed host-attempt code inside `rewriteWithRetry` and return it only when a later attempt succeeds.
- [ ] Propagate the code through `successfulOutcome`, `diagnosticCategories`, `markerForCommit`, and `stageCategory`.
- [ ] Run `node tools/scripts/test-post-process-runtime.mjs`; expect PASS.

### Task 2: Present the recovered cause on the affected progress rows

**Files:**
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `src/progress.mjs`

**Interfaces:**
- Consumes: warning `postProcessCategory` activity with `detail.failure`.
- Produces: parent and retried child reason/code with no suggested action.

- [ ] Add a failing progress regression for a host retry recovered from `RECURSION_POST_PROCESS_WRITER_EMPTY`.
- [ ] Assert both category and `Rewriting with SillyTavern` child show the fixed empty-output explanation and omit `suggestedAction`.
- [ ] Run `node tools/scripts/test-progress.mjs`; expect the child to retain generic retry copy.
- [ ] Allow warning Post-process children to consume the event failure reason, not only failed children.
- [ ] Run progress and UI tests; expect PASS.

### Task 3: Verify, document, commit, and deploy

**Files:**
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`

- [ ] Document `recoveredFailureCode` as diagnostic metadata on successful retried Post-process categories.
- [ ] Run `npm.cmd test` and `git diff --check`; expect PASS.
- [ ] Commit the focused implementation on `backend-robustification`.
- [ ] Sync documented production surfaces to `default-user` and verify all 73 production files match.
