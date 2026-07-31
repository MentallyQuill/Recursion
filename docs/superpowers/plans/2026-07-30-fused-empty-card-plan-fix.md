# Fused Empty Card Plan Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent zero-card Arbiter plans from entering a nonexistent Fused provider request while correcting contradictory `refresh-cards` plans at the Arbiter boundary.

**Architecture:** Add one semantic invariant to durable Arbiter validation and one empty-stage guard to durable card-graph construction. Keep provider routing, Fused bundle validation, downstream local fallback cards, and attempt-window behavior unchanged.

**Tech Stack:** JavaScript ES modules, Node.js assertion scripts, Recursion durable execution scheduler, PowerShell deployment checks, SillyTavern `default-user`.

## Global Constraints

- Work only on the existing `refactor` worktree at `F:\git\Recursion\.worktrees\resumable-pipeline-execution`.
- Do not change provider settings, provider health rules, or connection profiles.
- Do not synthesize model-owned card jobs in deterministic runtime code.
- `RECURSION_FUSED_PROVIDER_UNAVAILABLE` remains reserved for an unavailable generation router.
- A legitimate zero-card plan must consume no Fused or Segmented card-model attempt.
- Preserve Stop, Retry, checkpoints, provenance, deck, hand, guidance, packet, and installation behavior.
- Follow strict red-green-refactor: each production change needs a focused test that was observed failing for the intended reason.
- Sync only production extension files to `default-user/extensions/Recursion-refactor`; do not copy repository-only docs, tests, `.git`, `.agents`, `.codex`, or worktree metadata.

---

## File Map

- Modify `tools/scripts/test-runtime-preprocess.mjs`: add durable integration regressions that exercise correction attempts and zero-card graph behavior through `createRecursionRuntime(...)`.
- Modify `src/runtime.mjs`: enforce the empty-refresh invariant and elide card stages for plans with no executable jobs.
- Modify `docs/architecture/RUNTIME_ARCHITECTURE.md`: state the Arbiter action invariant and legitimate zero-card execution rule.
- Modify `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`: document correction behavior and reserve provider-unavailable errors for actual provider-boundary failures.

### Task 1: Reject Contradictory Empty Refresh Plans

**Files:**
- Modify: `tools/scripts/test-runtime-preprocess.mjs`
- Modify: `src/runtime.mjs` near `normalizeDurableArbiterPlan(...)`

**Interfaces:**
- Consumes: normalized durable Arbiter plan `{ action: string, cardJobs: Array }`.
- Produces: retryable validation failure `{ code: "RECURSION_ARBITER_EMPTY_REFRESH", category: "validation", retryable: true, message: string }`.
- Preserves: existing `durableArbiterStage(...).buildCorrectionRequest(...)` behavior.

- [ ] **Step 1: Add the failing durable correction regression**

Add one test block after the existing successful Fused lifecycle tests. The
provider returns a contradictory plan on its first Arbiter call, a corrected
one-card plan on its second Arbiter call, and valid Fused/guidance responses:

```js
{
  const providerCalls = [];
  let arbiterAttempts = 0;
  const provider = {
    async generate(roleId, request = {}) {
      providerCalls.push({ roleId, request });
      if (roleId === 'utilityArbiter') {
        arbiterAttempts += 1;
        if (arbiterAttempts === 1) {
          return {
            ...arbiterResponse(request, []),
            data: {
              ...arbiterResponse(request, []).data,
              action: 'refresh-cards'
            }
          };
        }
        return {
          ...arbiterResponse(request),
          data: {
            ...arbiterResponse(request).data,
            action: 'refresh-cards'
          }
        };
      }
      if (roleId === 'fusedCardBundle') {
        return {
          ok: true,
          data: {
            schema: 'recursion.cardBundle.v1',
            snapshotHash: request.snapshotHash,
            items: [{
              schema: 'recursion.card.v1',
              family: 'Scene Frame',
              role: 'sceneFrameCard',
              promptText: 'Keep Mara beside the sealed archive.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 12
            }]
          }
        };
      }
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({
    provider,
    settings: { pipelineMode: 'fused', modelAttemptsPerStep: 2 }
  });

  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });

  assertEqual(result.ok, true, 'corrected empty refresh plan completes');
  assertEqual(arbiterAttempts, 2, 'empty refresh plan consumes the Arbiter correction attempt');
  assert(
    providerCalls[1].request.prompt.includes('refresh-cards requires at least one executable card job'),
    'correction request explains the semantic invariant'
  );
  assertEqual(
    providerCalls.filter((entry) => entry.roleId === 'fusedCardBundle').length,
    1,
    'corrected plan creates one Fused bundle call'
  );
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(manifest.stageRecords['preprocess.arbiter'].attempts.total, 2, 'Arbiter records both attempts');
  assertEqual(manifest.stageRecords['preprocess.cards.fused'].state, 'completed', 'corrected Fused stage completes');
}
```

The production mutation this test catches is removal of the semantic
`refresh-cards`/empty-jobs validation branch.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node tools/scripts/test-runtime-preprocess.mjs
```

Expected: FAIL because the current runtime accepts the first empty
`refresh-cards` plan and pauses at `preprocess.cards.fused` without issuing an
Arbiter correction attempt.

- [ ] **Step 3: Add the minimal semantic validation**

In `normalizeDurableArbiterPlan(...)`, after scope and budget processing and
before returning `{ ok: true, value: plan }`, add:

```js
if (planAction(plan) === 'refresh-cards' && plan.cardJobs.length === 0) {
  return {
    ok: false,
    error: {
      code: 'RECURSION_ARBITER_EMPTY_REFRESH',
      category: 'validation',
      retryable: true,
      message: 'refresh-cards requires at least one executable card job.'
    }
  };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node tools/scripts/test-runtime-preprocess.mjs
```

Expected: PASS with `[pass] runtime preprocess lifecycle`.

- [ ] **Step 5: Commit the invariant**

```powershell
git add src/runtime.mjs tools/scripts/test-runtime-preprocess.mjs
git commit -m "fix: reject empty card refresh plans"
```

### Task 2: Elide Provider Card Stages For Legitimate Zero-Card Plans

**Files:**
- Modify: `tools/scripts/test-runtime-preprocess.mjs`
- Modify: `src/runtime.mjs` near `durableCardStageSet(...)`

**Interfaces:**
- Consumes: validated plan with `cardJobs: []`.
- Produces: `{ stages: [], resultStageIds: [], segmentedFallback: false }`.
- Preserves: `durableDeckStage(context, plan, [])` and all downstream stages.

- [ ] **Step 1: Add the failing Fused zero-card regression**

Add a test block whose Arbiter returns a valid `compose-brief` plan with no
card jobs:

```js
{
  const providerCalls = [];
  const provider = {
    async generate(roleId, request = {}) {
      providerCalls.push(roleId);
      if (roleId === 'utilityArbiter') return arbiterResponse(request, []);
      if (roleId === 'guidanceComposer') return guidanceResponse(request);
      throw new Error(`unexpected provider role ${roleId}`);
    }
  };
  const { runtime, storage } = createHarness({
    provider,
    settings: { pipelineMode: 'fused' }
  });

  const result = await runtime.prepareForGeneration({
    userMessage: 'I ask what she remembers.',
    hostGeneration: true
  });

  assertEqual(result.ok, true, 'legitimate zero-card Fused plan completes');
  assertEqual(providerCalls.join(','), 'utilityArbiter,guidanceComposer', 'zero-card plan skips Fused provider work');
  const manifest = await storage.loadPipelineRun('chat-preprocess');
  assertEqual(
    Object.hasOwn(manifest.stageRecords, 'preprocess.cards.fused'),
    false,
    'zero-card plan records no Fused card stage'
  );
  assertEqual(manifest.stageRecords['preprocess.install'].state, 'completed', 'zero-card plan completes installation');
}
```

The production mutation this test catches is removal of the empty-stage guard,
which would recreate the live false provider-unavailable failure.

- [ ] **Step 2: Add the Segmented zero-card regression**

Add the same behavior check with `pipelineMode: 'segmented'`. Assert the only
provider roles are `utilityArbiter,guidanceComposer`, no stage id starts with
`preprocess.cards.segmented.`, and `preprocess.install` is completed.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
node tools/scripts/test-runtime-preprocess.mjs
```

Expected: FAIL in the Fused case because current graph construction schedules
`preprocess.cards.fused` and passes a null bundle request to provider
execution.

- [ ] **Step 4: Add the minimal empty-stage guard**

At the start of `durableCardStageSet(...)`, add:

```js
const cardJobs = Array.isArray(plan?.cardJobs) ? plan.cardJobs : [];
if (cardJobs.length === 0) {
  return {
    stages: [],
    resultStageIds: [],
    segmentedFallback: false
  };
}
```

Do not change `durableFusedStages(...)`, provider routing, or deck fallback
logic.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```powershell
node tools/scripts/test-runtime-preprocess.mjs
```

Expected: PASS with `[pass] runtime preprocess lifecycle`.

- [ ] **Step 6: Run nearby execution-contract tests**

Run:

```powershell
node tools/scripts/test-preprocess-graph.mjs
node tools/scripts/test-execution-scheduler.mjs
node tools/scripts/test-runtime.mjs
```

Expected: each command exits `0` and prints its pass marker.

- [ ] **Step 7: Commit the zero-card graph behavior**

```powershell
git add src/runtime.mjs tools/scripts/test-runtime-preprocess.mjs
git commit -m "fix: skip empty provider card stages"
```

### Task 3: Align Architecture Documentation

**Files:**
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`

**Interfaces:**
- Documents the production invariant and error boundary introduced by Tasks 1
  and 2.
- Introduces no new runtime API.

- [ ] **Step 1: Update the Arbiter and Fused contracts**

Add concise normative text stating:

```text
refresh-cards requires at least one executable card job after runtime scope and
budget enforcement. An empty refresh is a retryable Arbiter validation failure.
A valid zero-card plan schedules no provider card stage and proceeds directly
to deck, hand, guidance, packet, and installation. Provider-unavailable errors
describe an unavailable provider boundary, not an absent card request.
```

- [ ] **Step 2: Check documentation formatting**

Run:

```powershell
git diff --check
```

Expected: exit `0` with no output.

- [ ] **Step 3: Commit the documentation**

```powershell
git add docs/architecture/RUNTIME_ARCHITECTURE.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md
git commit -m "docs: define zero-card plan behavior"
```

### Task 4: Verify, Sync, And Recheck The Live Failure Boundary

**Files:**
- No repository file changes expected.
- Sync target: `F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion-refactor`

**Interfaces:**
- Consumes: tested production tree from the `refactor` worktree.
- Produces: hash-identical installed production files and a live Writer retry
  that no longer reports false provider unavailability.

- [ ] **Step 1: Run the focused and full repository gates**

Run:

```powershell
node tools/scripts/test-runtime-preprocess.mjs
npm.cmd test
npm.cmd run test:alpha
git diff --check
```

Expected: every command exits `0`; both test suites report no failures; diff
check prints no output.

- [ ] **Step 2: Inspect the final repository diff and status**

Run:

```powershell
git status --short
git diff HEAD~3 -- src/runtime.mjs tools/scripts/test-runtime-preprocess.mjs docs/architecture/RUNTIME_ARCHITECTURE.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md
```

Expected: no unrelated files and only the approved invariant, graph guard,
tests, and documentation changes.

- [ ] **Step 3: Sync the production extension surface**

Copy only:

```text
manifest.json
package.json
src/
styles/
assets/icons/
```

from the `refactor` worktree to:

```text
F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion-refactor
```

Preserve `default-user` settings, chats, run manifests, scene artifacts, and
all other user data.

- [ ] **Step 4: Verify installed file parity**

Compare the SHA-256 hashes and relative paths of the five production surfaces
between the worktree and installed copy. Expected: no missing, extra, or
content-mismatched production file.

- [ ] **Step 5: Reload SillyTavern and retry the paused Writer stage**

Open the existing Writer Branch #1 chat in `default-user`, reload the extension
code, and use the contextual Retry action on the paused operation.

Expected live outcomes:

- the operation does not report `RECURSION_FUSED_PROVIDER_UNAVAILABLE`;
- a corrected non-empty plan proceeds to one Fused provider call; or
- two repeated contradictory Arbiter responses pause at
  `preprocess.arbiter` with `RECURSION_ARBITER_EMPTY_REFRESH`;
- a legitimate zero-card plan records no `preprocess.cards.fused` stage and
  continues through installation.

- [ ] **Step 6: Inspect persisted proof**

Read the updated Writer `recursion-pipeline-run-*.v1.json` and referenced stage
artifacts. Confirm the persisted stage records and attempts match one of the
expected outcomes above. Do not infer success from the progress popup alone.

- [ ] **Step 7: Record final status**

Run:

```powershell
git status --short
git log -5 --oneline
```

Report repository tests, installed-copy parity, and live artifact evidence
separately.

