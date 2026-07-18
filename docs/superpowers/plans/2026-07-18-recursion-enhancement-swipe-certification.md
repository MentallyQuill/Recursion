# Enhancement Swipe Certification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every enabled `As Swipe` Enhancement proof fail unless Recursion creates exactly one selected, source-bound, validated second assistant swipe.

**Architecture:** Move mutation certification into the shared live-enhancement oracle and require callers to provide concrete before/after message state plus runtime settlement. Extend the real-provider Playwright runner with a Repair scenario while retaining Redirect’s stricter verifier and effectiveness judge.

**Tech Stack:** Node.js ES modules, SillyTavern runtime bridge, Playwright, deterministic script-based tests.

## Global Constraints

- `As Swipe` success requires exactly one new selected Recursion-owned swipe.
- `Replace` remains supported and must change text without changing swipe count.
- `partial-failed`, skipped, warning, or failed Editorial settlement never certifies.
- `provider.call.completed` is not semantic acceptance.
- Live certification is restricted to `recursion-soak-*`; never mutate `default-user`.
- Keep Repair’s bounded-patch validator authoritative.

---

### Task 1: Shared mutation certification

**Files:**
- Modify: `tools/scripts/lib/live-enhancement-run-oracle.mjs`
- Modify: `tools/scripts/test-live-enhancement-run-oracle.mjs`

**Interfaces:**
- Consumes: `enhancement`, `before`, `after`, `enhancementResult`, and `editorialResult`.
- Produces: `evaluateEnhancementMutation(input)` and an apply-mode-aware `evaluateLiveEnhancementRun(input)` verdict.

- [ ] **Step 1: Write failing mutation negative controls**

Add concrete fixtures with assistant state:

```js
const before = {
  chatKey: 'proof-chat',
  messageId: 7,
  swipeCount: 1,
  swipeId: 0,
  text: 'Original response.'
};
const marker = {
  schema: 'recursion.editorialMarker.v1',
  chatKey: 'proof-chat',
  messageId: 7,
  swipeId: 0,
  mode: 'repair',
  applyMode: 'as-swipe',
  sourceHash: hashJson(before.text),
  candidateHash: hashJson('Repaired response.'),
  diagnosisHash: 'diagnosis-hash',
  outcome: 'applied'
};
const after = {
  ...before,
  swipeCount: 2,
  swipeId: 1,
  text: 'Repaired response.',
  marker
};
```

Assert healthy exactly-one swipe passes. Assert no swipe, two swipes, unselected
swipe, absent marker, stale source/message marker, candidate-hash mismatch,
`partial-failed`, skipped result, unhealthy Editorial result, and an `As Swipe`
run represented only by a trusted boolean all fail with stable reason codes.
Add healthy and invalid `Replace` cases plus Enhancement-off controls.

- [ ] **Step 2: Run the oracle test and observe RED**

Run:

```powershell
node tools/scripts/test-live-enhancement-run-oracle.mjs
```

Expected: failure because the current oracle trusts
`enhancementMutation.validated` and does not inspect before/after state.

- [ ] **Step 3: Implement concrete mutation evaluation**

In `live-enhancement-run-oracle.mjs`, import `hashJson` and add:

```js
export function evaluateEnhancementMutation({
  enhancement = {},
  before = {},
  after = {},
  enhancementResult = {},
  editorialResult = {}
} = {}) {
  // Normalize mode/apply mode, require healthy settlement, then validate:
  // as-swipe => delta === 1, selected index is the appended swipe, marker
  // identity/source/candidate hashes match.
  // replace => delta === 0, text changed, replacement marker matches.
  // off => no Recursion marker and no mutation.
}
```

Return `{ ok, kind, failures, marker }`. Remove acceptance based only on
`recursionOwned` or `validated` booleans. Merge mutation failures into
`evaluateLiveEnhancementRun`.

- [ ] **Step 4: Make browser collection accept certification evidence**

Change:

```js
collectLiveEnhancementRunOracle(page, certification)
```

The browser still collects transitions, final rows, and journal delta. The Node
side merges the caller’s serializable `enhancement`, `before`, `after`,
`enhancementResult`, and `editorialResult` into the observation before
evaluation.

- [ ] **Step 5: Run focused tests GREEN**

Run:

```powershell
node tools/scripts/test-live-enhancement-run-oracle.mjs
node tools/scripts/test-live-harness.mjs
```

Expected: both pass.

- [ ] **Step 6: Commit**

```powershell
git add tools/scripts/lib/live-enhancement-run-oracle.mjs tools/scripts/test-live-enhancement-run-oracle.mjs
git commit -m "test(live): require concrete Enhancement mutation"
```

### Task 2: Apply the invariant to all live callers

**Files:**
- Modify: `tools/scripts/lib/live-editorial-effectiveness.mjs`
- Modify: `tools/scripts/prove-live-card-progress.mjs`
- Modify: `tools/scripts/test-live-harness.mjs`
- Modify: `tools/scripts/test-live-enhancement-run-oracle.mjs`

**Interfaces:**
- Consumes: `collectLiveEnhancementRunOracle(page, certification)` from Task 1.
- Produces: live callers that cannot report pass without concrete mutation evidence.

- [ ] **Step 1: Write failing caller-contract assertions**

Assert source code for both live callers passes concrete certification fields:

```js
collectLiveEnhancementRunOracle(page, {
  enhancement,
  before,
  after,
  enhancementResult,
  editorialResult
})
```

Assert neither caller supplies `enhancementMutation.validated`.

- [ ] **Step 2: Run tests and observe RED**

Run:

```powershell
node tools/scripts/test-live-enhancement-run-oracle.mjs
node tools/scripts/test-live-harness.mjs
```

Expected: failure because callers currently collect the oracle without
before/after state.

- [ ] **Step 3: Pass concrete evidence from the Editorial runner**

In `live-editorial-effectiveness.mjs`, include `chatKey`, `messageId`, selected
text, swipe count, swipe index, and marker in `state()`. Pass:

```js
{
  enhancement: { enabled: true, mode, applyMode: 'as-swipe' },
  before: artifacts.before,
  after: artifacts.after,
  enhancementResult: artifacts.enhancementResult,
  editorialResult: artifacts.runtimeView?.editorialResult
}
```

- [ ] **Step 4: Pass concrete evidence from card-progress proof**

Capture the newly generated assistant message after settlement. Because this
proof sends a fresh assistant message, supply its known initial state as one
source swipe and its observed final state, marker, runtime result, and
`editorialResult`. Fail if the final assistant message cannot be identified.

- [ ] **Step 5: Run focused tests GREEN**

Run:

```powershell
node tools/scripts/test-live-enhancement-run-oracle.mjs
node tools/scripts/test-live-harness.mjs
```

Expected: both pass.

- [ ] **Step 6: Commit**

```powershell
git add tools/scripts/lib/live-editorial-effectiveness.mjs tools/scripts/prove-live-card-progress.mjs tools/scripts/test-live-harness.mjs tools/scripts/test-live-enhancement-run-oracle.mjs
git commit -m "test(live): enforce Enhancement swipe delta"
```

### Task 3: Add real-provider Repair certification

**Files:**
- Modify: `tools/scripts/prove-live-enhancements.mjs`
- Modify: `tools/scripts/lib/live-editorial-effectiveness.mjs`
- Modify: `tools/scripts/test-live-harness.mjs`
- Modify: `tools/scripts/test-live-enhancement-run-oracle.mjs`

**Interfaces:**
- Consumes: shared oracle and concrete state contract from Tasks 1-2.
- Produces: a combined real-provider Enhancement report covering Redirect and Repair.

- [ ] **Step 1: Add failing Repair evaluator tests**

Add `evaluateLiveRepairScenarioArtifacts(artifacts)` fixtures that require:

```js
{
  oracle: { verdict: { ok: true } },
  enhancementResult: {
    ok: true,
    mode: 'repair',
    partialFailed: false,
    marker: { mode: 'repair', applyMode: 'as-swipe', outcome: 'applied' },
    artifact: { kind: 'patches', patches: [/* validated patch */] }
  },
  runtimeView: { editorialResult: { mode: 'repair', status: 'success' } }
}
```

Negative controls cover full-candidate artifacts, missing swipe, failed oracle,
`partial-failed`, skipped, and red final settlement.

- [ ] **Step 2: Run harness tests and observe RED**

Run:

```powershell
node tools/scripts/test-live-harness.mjs
node tools/scripts/test-live-enhancement-run-oracle.mjs
```

Expected: failure because no Repair evaluator/scenario exists.

- [ ] **Step 3: Generalize scenario execution by Enhancement mode**

In `executeScenarioInPage`, derive:

```js
const enhancementMode = scenario.enhancementMode === 'repair' ? 'repair' : 'redirect';
```

Use the corresponding scenario oracle source text, configure
`enhancements: { mode: enhancementMode, applyMode: 'as-swipe' }`, and preserve
the existing Redirect-only verifier/judge behavior.

- [ ] **Step 4: Add the Repair scenario**

In `prove-live-enhancements.mjs`, add one Repair scenario per selected pipeline.
Use a source with deterministic prose and dialogue targets, a bounded user turn,
and frozen context. Do not fabricate provider responses.

Route Repair artifacts through `evaluateLiveRepairScenarioArtifacts`; route
Redirect artifacts through the existing Redirect evaluator. The combined
command exits nonzero if either mode fails.

- [ ] **Step 5: Run focused tests GREEN**

Run:

```powershell
node tools/scripts/test-live-harness.mjs
node tools/scripts/test-live-enhancement-run-oracle.mjs
```

Expected: both pass.

- [ ] **Step 6: Commit**

```powershell
git add tools/scripts/prove-live-enhancements.mjs tools/scripts/lib/live-editorial-effectiveness.mjs tools/scripts/test-live-harness.mjs tools/scripts/test-live-enhancement-run-oracle.mjs
git commit -m "test(live): certify Repair swipe creation"
```

### Task 4: Documentation, full verification, and deployment

**Files:**
- Modify: `docs/testing/TESTING_STRATEGY.md`
- Modify: `docs/testing/SILLYTAVERN_PLAYWRIGHT_HARNESS.md`
- Verify: all production files under `src`, `styles`, `assets/icons`, plus root `manifest.json` and `package.json`

**Interfaces:**
- Consumes: completed shared oracle and combined live proof.
- Produces: documented command contract and installed-copy parity.

- [ ] **Step 1: Update testing documentation**

Document that `npm.cmd test` is deterministic and does not certify a provider.
Document that `npm.cmd run prove:enhancements-live` requires exactly one
validated second swipe for every enabled `As Swipe` Repair/Redirect scenario
and exits nonzero on a parse-success/semantic-failure sequence.

- [ ] **Step 2: Run focused and full deterministic gates**

Run:

```powershell
node tools/scripts/test-live-enhancement-run-oracle.mjs
node tools/scripts/test-live-harness.mjs
npm.cmd test
node tools/scripts/run-alpha-gate.mjs
```

Expected: all 37 scripts and Playwright readiness pass.

- [ ] **Step 3: Review and commit**

Review `git diff --check`, request independent code review, resolve all Critical
and Important findings, then commit documentation or remaining test changes.

- [ ] **Step 4: Sync production files**

Copy only changed production modules to:

- `F:\SillyTavern\SillyTavern\data\recursion-soak-a\extensions\Recursion`
- `F:\SillyTavern\SillyTavern\data\recursion-soak-b\extensions\Recursion`
- `F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion`

Do not copy to `default-user` until live soak certification passes.

- [ ] **Step 5: Verify installed-copy parity**

Run:

```powershell
node tools/scripts/verify-installed-copy.mjs --user recursion-soak-a --sillytavern-root F:\SillyTavern\SillyTavern
node tools/scripts/verify-installed-copy.mjs --user recursion-soak-b --sillytavern-root F:\SillyTavern\SillyTavern
```

Expected: both report all production files match.

- [ ] **Step 6: Run real-provider certification**

Run:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
npm.cmd run prove:enhancements-live
```

Expected: every selected Standard/Rapid/Fused Repair and Redirect scenario
creates exactly one validated second swipe and the report status is `pass`.

- [ ] **Step 7: Sync `default-user` only after certification**

After the live report passes, sync changed production modules to
`F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion`, rerun the
installed-copy verifier for `default-user`, and retain the live report artifact
path in the completion summary.
