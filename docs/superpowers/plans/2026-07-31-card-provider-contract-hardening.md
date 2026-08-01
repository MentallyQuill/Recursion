# Card Provider Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Segmented card generation reliable across weaker structured-output models and make every remaining card failure actionable and visible.

**Architecture:** Define the complete card contract at the provider boundary, then apply one narrowly guarded normalization for the live nested-envelope shape. Preserve specific failures through the durable scheduler and render completed fail-soft degradation as attention-worthy without changing the existing continue policy.

**Tech Stack:** JavaScript ES modules, JSON Schema, Node.js assertion scripts, Recursion durable execution scheduler, SillyTavern progress UI.

## Global Constraints

- Work from `refactor` through the isolated topic branch `codex-card-provider-contract-hardening`.
- Preserve the pre-alpha single V1 contract; do not add legacy compatibility shims.
- Never overwrite a nonempty provider role, family, schema, or snapshot identity that conflicts with the frozen request.
- Never persist raw provider output, prompt text, transcript text, or hidden reasoning.
- Segmented card failures remain fail-soft and do not block accepted siblings or prompt installation.
- Follow strict red-green-refactor: add one behavior test, observe its intended failure, add the minimal production change, and observe the focused suite pass before starting the next behavior.
- Merge the verified topic branch into `refactor` locally and commit the merge result there.

---

## File Map

- Modify `src/providers.mjs`: dynamic card JSON Schema, guarded nested-envelope normalization, and bounded schema-mismatch metadata.
- Modify `src/cards.mjs`: expose the stable semantic card rejection reason to the durable runtime.
- Modify `src/runtime.mjs`: preserve provider failures, name semantic failures, and append exact Segmented correction instructions.
- Modify `src/execution/attempt-policy.mjs`: retain normalized validation messages and suggested actions.
- Modify `src/execution/scheduler.mjs`: persist safe failure message and suggested action.
- Modify `src/execution/checkpoints.mjs`: preserve those fields when manifests are normalized and reloaded.
- Modify `src/progress.mjs`: surface durable failure code/action and mark completed partial runs as `Needs attention`.
- Modify `tools/scripts/test-providers.mjs`: provider-contract and normalization regressions.
- Modify `tools/scripts/test-execution-attempt-policy.mjs`: validation detail preservation regression.
- Modify `tools/scripts/test-execution-scheduler.mjs`: durable failure persistence regression.
- Modify `tools/scripts/test-runtime-preprocess.mjs`: Segmented correction and sibling-survival regression.
- Modify `tools/scripts/test-progress.mjs`: completed partial progress regression.
- Modify `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`: normative card-schema and recovery boundary.
- Modify `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`: diagnostics, correction, and partial-state behavior.

### Task 1: Complete The Card Provider Contract

**Files:**
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `src/providers.mjs`

**Interfaces:**
- Consumes: `machineJsonSchemaForRequest({ responseSchema: "recursion.card.v1", machineJson: true, roleId, snapshotHash, metadata: { role, family } })`.
- Produces: a named JSON Schema requiring the frozen role, family, snapshot hash, and exactly one card item with `promptText` and `evidenceRefs`.

- [ ] **Step 1: Add the failing machine-schema regression**

Add literal assertions that the card schema requires
`schema,snapshotHash,role,family,items`, constrains the three frozen identity
values with `const`, sets `items.minItems` and `items.maxItems` to `1`, and
requires item `promptText` and `evidenceRefs`.

- [ ] **Step 2: Run the provider suite and verify RED**

Run `node tools/scripts/test-providers.mjs`.

Expected: the existing generic fallback lacks `role`, `family`, and `items`, so
the new assertions fail for the missing properties.

- [ ] **Step 3: Add the dynamic card JSON Schema and bump the provider contract**

Implement a `recursion.card.v1` branch in `machineJsonSchemaForRequest(...)`.
Use request-owned constants, one item, required `promptText` and
`evidenceRefs`, and the current enums `compact|standard|expanded` and
`normal|emphasized|muted`. Advance `PROVIDER_CONTRACT_VERSION` from `6` to
`7` and update its literal test.

- [ ] **Step 4: Run the provider suite and verify GREEN**

Run `node tools/scripts/test-providers.mjs`.

Expected: `[pass] providers`.

### Task 2: Recover Only The Safe Nested Card Envelope

**Files:**
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `src/providers.mjs`

**Interfaces:**
- Consumes: parsed card-role data shaped as `{ envelope: object, items: [object] }` plus the frozen request.
- Produces: canonical `recursion.card.v1` data and success diagnostic `semanticNormalization: "nested-card-envelope"`, or the existing schema mismatch failure when any guard fails.

- [ ] **Step 1: Add the failing live-shape recovery regression**

Create a router whose `activeCastCard` response contains a nested envelope and
one valid item. Assert `ok === true`, canonical top-level schema/role/family/
snapshot identity, and the semantic-normalization diagnostic.

- [ ] **Step 2: Run the provider suite and verify RED**

Run `node tools/scripts/test-providers.mjs`.

Expected: `RECURSION_PROVIDER_SCHEMA_MISMATCH` with returned fields
`envelope,items`.

- [ ] **Step 3: Implement guarded normalization**

Add a card-role normalizer that requires request-owned role/family/snapshot,
one object item, and no conflicting identity in the top level, nested envelope,
or item. Return canonical identity from the request and omit the provider's
nested `envelope` field.

- [ ] **Step 4: Run the provider suite and verify GREEN**

Run `node tools/scripts/test-providers.mjs`.

Expected: `[pass] providers`.

- [ ] **Step 5: Add one failing table of conflict regressions**

Cover wrong nested schema, wrong nested role, wrong nested family, wrong nested
snapshot, wrong item role, multiple items, missing request metadata, and
missing frozen snapshot. Each result must remain
`RECURSION_PROVIDER_SCHEMA_MISMATCH` and must not be canonicalized.

- [ ] **Step 6: Run the provider suite and verify the conflict cases GREEN**

Run `node tools/scripts/test-providers.mjs`.

Expected: every conflict is rejected and the suite prints `[pass] providers`.

### Task 3: Preserve Actionable Provider Diagnostics

**Files:**
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `src/providers.mjs`

**Interfaces:**
- Produces on mismatch: safe `roleId`, `expectedSchema`, `actualSchema`, sorted `responseFields`, bounded `responseShape`, provider source/model, and `failure.category === "provider-output"`.

- [ ] **Step 1: Add the failing diagnostic regression**

For a rejected `activeCastCard` nested envelope, assert the exact expected
schema and role, structural entries for `envelope` and `items`, the fake model,
and provider-output category. Assert the serialized error and diagnostics do
not contain an item prompt marker or secret marker.

- [ ] **Step 2: Run the provider suite and verify RED**

Run `node tools/scripts/test-providers.mjs`.

Expected: current diagnostics omit expected role/schema, response structure,
and model at the post-response schema-validation boundary.

- [ ] **Step 3: Implement bounded structural diagnostics**

Describe only top-level types/counts and nested field names. Add safe mismatch
metadata in `validateRoleResponseSchema(...)`, allowlist it through
`sanitizedError(...)`, and merge already-available response metadata into the
failure diagnostics in both single and batch paths.

- [ ] **Step 4: Run the provider suite and verify GREEN**

Run `node tools/scripts/test-providers.mjs`.

Expected: `[pass] providers` with no raw response marker in diagnostics.

### Task 4: Preserve Exact Card Failure And Correction Details

**Files:**
- Modify: `tools/scripts/test-execution-attempt-policy.mjs`
- Modify: `tools/scripts/test-execution-scheduler.mjs`
- Modify: `tools/scripts/test-runtime-preprocess.mjs`
- Modify: `src/cards.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/execution/attempt-policy.mjs`
- Modify: `src/execution/scheduler.mjs`
- Modify: `src/execution/checkpoints.mjs`

**Interfaces:**
- Consumes: provider failure or stable `providerCardRejectReason(...)` from a Segmented card attempt.
- Produces: a durable failure with exact code, safe message, category, retryability, and suggested action; a second card attempt whose prompt contains the exact rejection.

- [ ] **Step 1: Add and run the failing attempt-policy regression**

Assert a validation error with message `Active Cast provider output did not
match recursion.card.v1.` and suggested action `Retry Active Cast.` survives
`runModelStageAttempts(...)`. Run
`node tools/scripts/test-execution-attempt-policy.mjs`; expect the generic
validation message to fail the assertion.

- [ ] **Step 2: Preserve normalized validation failure details and verify GREEN**

Normalize validation failures through `failureFrom(...)` while retaining
`kind: "validation"`. Re-run the attempt-policy suite and expect its pass
marker.

- [ ] **Step 3: Add and run the failing scheduler persistence regression**

Assert an exhausted model stage persists `failure.message` and
`failure.suggestedAction`, and that `normalizePipelineRun(...)` preserves both.
Run `node tools/scripts/test-execution-scheduler.mjs`; expect the fields to be
missing before implementation.

- [ ] **Step 4: Persist bounded failure details and verify GREEN**

Extend scheduler `failureRecord(...)` and checkpoint normalization with bounded
message and suggested-action fields. Re-run the scheduler suite and expect its
pass marker.

- [ ] **Step 5: Add and run the failing Segmented runtime regression**

Create a three-card Segmented run in which one card first returns a provider
schema mismatch and then a valid card, while siblings succeed once. Assert the
second request contains the exact mismatch correction, accepted siblings are
not repeated, and the run installs all three accepted cards. Add a second
exhaustion case asserting an invalid card's stable semantic reject reason is
persisted while its valid sibling reaches the packet. Run
`node tools/scripts/test-runtime-preprocess.mjs`; expect correction/failure
detail assertions to fail.

- [ ] **Step 6: Implement precise card validation and correction prompts**

Export `providerCardRejectReason(...)`. In `durableSegmentedStages(...)`, pass
provider failures through with the family name and safe provider details;
otherwise use the stable semantic rejection reason. Add
`buildCorrectionRequest(...)` that appends the exact code/message and canonical
card-envelope requirements without changing frozen request identity.

- [ ] **Step 7: Run the runtime and nearby execution suites**

Run:

```powershell
node tools/scripts/test-runtime-preprocess.mjs
node tools/scripts/test-runtime.mjs
node tools/scripts/test-cards.mjs
node tools/scripts/test-execution-attempt-policy.mjs
node tools/scripts/test-execution-scheduler.mjs
```

Expected: each exits `0` with its pass marker.

### Task 5: Show Completed Partial Runs As Attention-Worthy

**Files:**
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `src/progress.mjs`

**Interfaces:**
- Consumes: completed execution manifest containing a failed continuing stage.
- Produces: progress title `Needs attention`, a red failed child, exact reason, failure code, and suggested action.

- [ ] **Step 1: Add the failing completed-partial progress regression**

Construct a completed Segmented execution with one completed card and one
failed card carrying a precise durable failure. Assert title, row state,
reason, code, and suggested action.

- [ ] **Step 2: Run the progress suite and verify RED**

Run `node tools/scripts/test-progress.mjs`.

Expected: current title is `Ready` and the stage omits code/action.

- [ ] **Step 3: Implement truthful partial progress**

Map durable failure code/action in `executionProgressStep(...)`. For completed
operations, select `Needs attention` when any top-level or child stage is
failed; keep fully successful completion as `Ready`.

- [ ] **Step 4: Run progress and UI suites and verify GREEN**

Run:

```powershell
node tools/scripts/test-progress.mjs
node tools/scripts/test-ui.mjs
node tools/scripts/test-ui-view-model.mjs
```

Expected: every command exits `0`.

### Task 6: Align Documentation And Integrate

**Files:**
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`

**Interfaces:**
- Documents the complete provider/card contract, guarded recovery authority,
  diagnostics privacy boundary, exact correction behavior, and completed
  partial-state presentation.

- [ ] **Step 1: Update the normative documentation**

Document that the machine schema carries the complete card envelope; nested
recovery requires request-owned identity with no conflict; raw provider text is
never persisted; retry correction names the exact failed contract; and
completed fail-soft card omissions remain visible as `Needs attention`.

- [ ] **Step 2: Run focused and full verification on the topic branch**

Run:

```powershell
node tools/scripts/test-providers.mjs
node tools/scripts/test-runtime-preprocess.mjs
node tools/scripts/test-progress.mjs
npm.cmd test
npm.cmd run test:alpha
git diff --check
```

Expected: every command exits `0`, both aggregate gates report no failures,
and the diff check prints no output.

- [ ] **Step 3: Review and commit the topic branch**

Inspect `git diff --stat`, `git diff`, and `git status --short`; confirm only
the planned production, test, spec, and plan files changed. Commit with:

```powershell
git add docs src tools/scripts
git commit -m "fix(provider): harden card output contract"
```

- [ ] **Step 4: Merge into `refactor` and verify the merged result**

Switch the isolated worktree to `refactor`, merge
`codex-card-provider-contract-hardening` without rewriting history, then run:

```powershell
npm.cmd test
npm.cmd run test:alpha
git diff --check HEAD^ HEAD
git status -sb
```

Expected: the merge succeeds, every verification command exits `0`, and
`refactor` is clean with the new commit(s) ahead of `origin/refactor`.
