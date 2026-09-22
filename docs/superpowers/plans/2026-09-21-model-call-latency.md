# Recursion Model-call Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the recommended native execution, or superpowers:subagent-driven-development if the user selects that method. Steps use checkbox syntax for tracking.

**Goal:** Reduce measured preprocessing and reply latency while preserving grounded cards, authored priority, cancellation, and turn freshness.

**Architecture:** Improve the existing queue, provider normalization, and durable scheduler in place. Preserve dependency ordering but overlap independent requests, retain valid Fused work, and bound recovery. Use existing inspection surfaces for effective mode and measured timing.

**Tech stack:** Browser JavaScript ES modules, Node.js offline scripts, SillyTavern Connection Manager, existing Playwright live harness. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-model-call-latency-design.md` (approved).

**Execution recommendation:** Native implementation in this thread, followed by one final independent review. Queue, scheduler, and runtime changes share ownership state, making many independent implementers unnecessary.

## Global constraints

- Pre-alpha: update contracts in place; do not introduce legacy compatibility shims.
- Preserve source grounding, required constraints, authored instructions, turn/source/settings invalidation, and same-turn reuse.
- No unsafe cross-turn cache and no automatic primary generation outside the native host seam.
- Concurrency is bounded from one to three per Connection Profile; shared lanes share a limit.
- Keep UI SillyTavern-native, compact, graphite-dark, and operational; use existing inspectors.
- Preserve concurrent changes in cards, authored-deck handling, prompt composition, runtime, and runtime tests.
- Follow the user's instruction not to get bogged down in tests: one focused failure-boundary check per meaningful change, one integration gate, and a small live comparison. Repeat only for new changes or failures.
- Use the GitHub CLI with network permission enabled if GitHub access becomes necessary. No publication is part of this plan's default execution.

## Review focus

1. A transport ignores abort: do not free its queue slot while it still runs (Task 1).
2. Utility and Reasoner share one profile but have different limits or changed settings: enforce one conservative queue and invalidate stale qualification (Tasks 1 and 4).
3. A malformed or duplicate Fused item sits next to a valid required card: retain trusted work without admitting conflicting evidence (Task 2).
4. Concurrent retries or Resume race to spend the last recovery allowance: persist atomic ownership and prevent overspend (Task 3).
5. A swipe or source edit occurs after prompt installation but before a primary streaming event: bind metrics and commits to the correct attempt (Tasks 3 and 6).

## Task 1: Measure and bound profile requests

**Files:** Modify `src/providers/profile-request-queue.mjs`, `src/providers.mjs`, `src/hosts/sillytavern/host.mjs`, `src/settings.mjs`, `src/provider-capability.mjs`, `src/providers/profile-certification.mjs`, and `src/extension/index.js`. Extend `tools/scripts/test-profile-request-queue.mjs` and `tools/scripts/test-provider-client-profile-only.mjs`. Document fields in `schemas/README.md` and `docs/technical/HOST_INTEGRATION_MANUAL.md`.

**Interfaces:** Extend `createProfileRequestQueue` with `setConcurrency(profileId, limit)` and `cooldown(profileId, milliseconds)`. `run(profileId, task, {signal, onDispatch})` continues returning the task result. Its dispatch callback receives `{queuedAt, dispatchedAt, queueWaitMs, active, concurrency}`. `stats` adds peak concurrency and cooldown remaining. Provider results/errors carry a sanitized `timings` object and successful usage fields.

- [ ] Add a deferred-promise check that demonstrates two active tasks, a third waiting, and no early slot release after an aborted wrapper. Use explicit settlement, not wall-clock sleeps:

```js
const queue = createProfileRequestQueue();
queue.setConcurrency('same-profile', 2);
let release;
const held = new Promise(resolve => { release = resolve; });
const running = [queue.run('same-profile', () => held), queue.run('same-profile', () => held)];
await Promise.resolve();
assertEqual(queue.stats('same-profile').active, 2, 'two requests own slots');
queue.setConcurrency('same-profile', 1);
assertEqual(queue.stats('same-profile').active, 2, 'lowering limit does not evict transports');
release();
await Promise.all(running);
```

- [ ] Run `node tools/scripts/test-profile-request-queue.mjs` and confirm the new contract fails before implementation.
- [ ] Replace the global immutable queue limit with per-profile state. Keep occupied slots until the underlying task settles; recheck abort immediately before invoking the task. Ensure cooldown survives an empty queue until expiry, clears its timer once, and does not leak profile state.
- [ ] Normalize `maxConcurrentRequests` to 1–3 with default 2 as a requested limit; effective concurrency remains 1 without verified concurrency qualification. Persist certified `safeConcurrency` and a concurrency probe check instead of hard-coding one. For a shared profile, use the minimum effective limit across configured lanes. Keep certification requests themselves under an explicit bounded probe override; otherwise qualification could never exercise concurrency greater than one.
- [ ] Extend explicit profile testing with simultaneous short, independently identifiable responses at the requested level. Persist the exercised level only after both correctness and actual overlap are demonstrated. Never run qualification automatically during an ordinary turn. Changing profile generation configuration invalidates its qualification; raising the requested level above the qualified level requires another probe.
- [ ] Record dispatch timing inside the queue task, host preparation/transport timing around `service.sendRequest`, and normalization timing after response. Preserve timing metadata on exceptions. Record actual token/reasoning usage from the normalized raw envelope in the successful router path, which currently loses those fields before journaling.
- [ ] Normalize a bounded retry-after delay when supplied; apply profile cooldown for 429 before draining more pending work. Retry policy consumes that delay instead of repeatedly ignoring provider backpressure.
- [ ] Run the two changed-module scripts once and inspect peak-active, FIFO, shared-profile, failed-probe, cooldown, queued-abort, and abort-ignoring transport assertions. Record results and commit only Task 1 files after reviewing the scoped diff.

## Task 2: Preserve Fused siblings and stop useless retries

**Files:** Modify `src/providers.mjs`, `src/providers/provider-response-normalizer.mjs`, `src/providers/provider-errors.mjs`, `src/cards.mjs`, `src/runtime/preprocess-graph.mjs`, `src/runtime.mjs`, and `src/execution/attempt-policy.mjs`. Extend `tools/scripts/test-provider-response-parser.mjs`, `tools/scripts/test-preprocess-graph.mjs`, and the existing Fused runtime cases in `tools/scripts/test-runtime.mjs`. Update `schemas/README.md`.

**Interfaces:** Fused router success retains a valid `{items: [...]}` envelope with per-item rejection summaries; only item-valid entries reach `cardsFromFusedProviderResult`. `validateFusedProviderResult` produces accepted families and unresolved-family reasons. Add explicit refusal/content-filter error codes with `retryable: false` and no fallback request for that refused work.

- [ ] Reproduce the full provider-boundary failure using the real router, not a mocked successful runtime result:

```js
const router = createGenerationRouter({ client: { generate: async () => ({
  text: JSON.stringify({items: [
    {family: 'Scene Frame', promptText: 'Track the objective.', evidenceRefs: ['message:0']},
    {family: 'Active Cast', promptText: [], evidenceRefs: ['message:0']}
  ]})
}) }});
const result = await router.generate('fusedCardBundle', {});
assertEqual(result.ok, true, 'valid envelope survives invalid sibling');
assertEqual(result.data.items.length, 1, 'only valid sibling survives');
```

- [ ] Run `node tools/scripts/test-provider-response-parser.mjs` before the implementation and verify the targeted failure.
- [ ] Split envelope and item validation. Collect bounded rejection reasons by requested family; reject all conflicting duplicates for a family, unrequested families, invalid evidence, and wrong types. Do not coerce arrays to text. Feed surviving items through existing source-aware card validation.
- [ ] Add `buildCorrectionRequest` to the Fused stage using the current request, bounded error details, expected shape, and unresolved requested families. Preserve accepted siblings rather than regenerating them. The scheduler's generic unchanged-request correction fallback must not be used for this path.
- [ ] Extend raw-response normalization to recognize provider refusal fields and content-filter finish reasons before empty/JSON handling. Explicit refusal must win even if explanatory text exists. Ordinary narrative containing refusal words must not trigger it. Prevent the attempt policy and `settleExhausted` from turning explicit refusal into another equivalent provider request.
- [ ] Run the parser and graph scripts, then the focused runtime script once after the recovery integration. Verify valid sibling preservation, semantic evidence rejection, duplicate rejection, meaningful correction, terminal refusal, and required versus optional coverage. Commit scoped changes after diff review.

## Task 3: Bound recovery and elapsed execution across checkpoints

**Files:** Create `src/execution/operation-budget.mjs` and `tools/scripts/test-operation-budget.mjs`. Modify `src/execution/checkpoints.mjs`, `src/execution/scheduler.mjs`, `src/execution/attempt-policy.mjs`, `src/runtime.mjs`, `src/settings.mjs`, `src/runtime/diagnostics.mjs`, and `schemas/README.md`.

**Interfaces:** Export `normalizeOperationBudget(value)`, `reserveRecoveryCall(budget, {attemptId, now})`, and `remainingExecutionMs(budget, now)` from the new module. The persisted budget contains `{windowId, recoveryLimit, recoveryUsed, reservationIds, elapsedActiveMs, activeSince, deadlineMs}`. Reservations return `{ok, budget, reasonCode}`; repeated reservation IDs are idempotent. Scheduler mutations own reservation persistence.

- [ ] Add a small deterministic boundary check with explicit inputs:

```js
const budget = normalizeOperationBudget({windowId: 'w1', recoveryLimit: 1});
const first = reserveRecoveryCall(budget, {attemptId: 'a1', now: 100});
const repeated = reserveRecoveryCall(first.budget, {attemptId: 'a1', now: 100});
const denied = reserveRecoveryCall(repeated.budget, {attemptId: 'a2', now: 100});
assertEqual(repeated.budget.recoveryUsed, 1, 'one reservation is charged once');
assertEqual(denied.ok, false, 'second recovery cannot overspend');
```

- [ ] Run `node tools/scripts/test-operation-budget.mjs` and confirm failure before adding the module.
- [ ] Persist the budget in the existing run contract. Reserve additional calls under `queueMutation` before dispatch. Initial generated-card calls use the normal allowance; Fused retries and all segmented calls caused by Fused fallback share one correction-plus-family-count recovery allowance. Prioritize required coverage. Resume retains consumption; explicit Reprocess creates a new identified window without reusing stale artifacts.
- [ ] Request timeout begins at dispatch and signals transport abort; total preprocessing deadline includes active queue/retry time. Pausing records elapsed time and clears the active interval. Resume excludes time spent paused. Timer callbacks must check operation/window identity before aborting. Never release a queue slot early or permit stale commits.
- [ ] Use provisional finite settings of 180 seconds per request and 300 seconds total preprocessing, with advanced controls bounded to 30–600 and 60–1800 seconds respectively. These bounds contain the observed successful baseline; Task 6 must validate or revise shipping defaults from measured runs. Store settings in provenance so changed budgets do not silently reuse incompatible work.
- [ ] Map deadline/recovery exhaustion into precise stage outcomes. Preserve successful checkpoints; block unmet required constraints before install and record optional omissions. Do not mark user Stop as a deadline failure.
- [ ] Run `node tools/scripts/test-operation-budget.mjs`, `node tools/scripts/test-execution-attempt-policy.mjs`, and `node tools/scripts/test-execution-scheduler.mjs`. Verify the last-call race with two concurrent reservations through actual scheduler mutation ownership. Commit scoped changes.

## Task 4: Persist effective mode and expose compact controls

**Files:** Modify `src/runtime/pipeline-policy.mjs`, `src/runtime.mjs`, `src/execution/checkpoints.mjs`, `src/runtime/diagnostics.mjs`, `src/storage/last-brief.mjs`, `src/ui/view-model.mjs`, `src/ui/progress-panel.mjs`, `src/ui/provider-panel.mjs`, `src/ui.mjs`, `DESIGN.md`, `docs/design/UI_SPEC.md`, and `schemas/README.md`. Extend `tools/scripts/test-pipeline-policy.mjs` and the existing provider-panel checks.

**Interfaces:** Effective-mode decisions contain `{requestedMode, effectiveMode, selectedLane, profileIdHash, configHash, certificationState, reasonCode}`. Persist that object with the run and last-brief inspection summary; UI reads it, not the current settings label, when describing an earlier run.

- [ ] Add a policy assertion that an uncertified Utility profile remains Segmented even when Reasoner is certified:

```js
const decision = resolveEffectivePipelineMode({
  requestedMode: 'fused', selectedLane: 'utility',
  selectedCapability: {fusedEligible: false, state: 'uncertified', configHash: 'current'}
});
assertEqual(decision.effectiveMode, 'segmented', 'selected lane must qualify');
assertEqual(decision.selectedLane, 'utility', 'persist actual card lane');
```

- [ ] Run `node tools/scripts/test-pipeline-policy.mjs`, then add the decision fields and persist them through normalization, diagnostics, and last brief. Qualification must match the actual selected configuration and lane; never manufacture a pass from a setting.
- [ ] Add `Concurrent requests` with values 1–3 and measured qualification status in Provider Advanced. Add request/preprocessing deadlines in Advanced. Show effective mode and concise fallback reason in existing Progress and Last Brief details. Include queue/provider/recovery timings there without expanding the chat bar or creating notifications.
- [ ] Read the full current design files before UI edits. Use existing field helpers, native theme tokens, accessible labels, and one-column mobile layout. Update the two design contracts and schema documentation in place.
- [ ] Run changed policy/panel checks and one desktop/mobile browser inspection after the interface settles. Verify a settings change does not relabel the previous run, and an unsuccessful concurrency probe cannot claim a higher qualified level. Commit scoped files.

## Task 5: Reduce planner overhead and evaluate safe call elimination

**Files:** Create `src/runtime/preprocess-policy.mjs` and `tools/scripts/test-preprocess-policy.mjs`. Modify `src/runtime.mjs`, `src/prompt.mjs`, `docs/technical/RUNTIME_TURN_SEQUENCE.md`, and `src/runtime/prepared-generation.mjs` only if its provenance needs new fields.

**Interfaces:** Export `compactArbiterScope(scope)` and `selectPreprocessFastPath({settings, eligibility, storyForm, authoredCards})`. The latter returns `{planner: 'model'|'local', guidance: 'model'|'raw-authored', reasonCode}`. Eligibility is computed by the existing deck logic; this module does not redefine priority or quotas.

- [ ] Add a compactness check that preserves essential selection information while eliminating duplicated catalog arrays:

```js
const input = {selectedFamilies: ['Scene Frame'], availableCatalog: [{family: 'Scene Frame'}], allowedCatalog: [{family: 'Scene Frame'}]};
const compact = compactArbiterScope(input);
assertEqual(Object.hasOwn(compact, 'availableCatalog'), false, 'catalog is sent once separately');
assertDeepEqual(compact.selectedFamilies, ['Scene Frame'], 'selection survives projection');
```

- [ ] Run `node tools/scripts/test-preprocess-policy.mjs`, then integrate the projection into the actual durable arbiter request. Keep whitelists, source messages, story form, priority, and output contracts. Measure serialized prompt size before/after on the same fixture.
- [ ] Implement a local planner only for fully explicit generated-family selection with an explicit story form and no remaining model selection decision. Run the existing plan normalization, eligibility, priority reservation, and source binding on its output. Otherwise keep model planning with a recorded reason.
- [ ] Permit raw-authored guidance only when no generated evidence needs reconciliation and the authored instructions already fully determine the packet. Preserve exact authored text and required priority. Keep composition when unresolved posture, conflicts, or inferred guidance remain. Mark this as a local stage so it does not report a phantom model call.
- [ ] Evaluate both paths against the current priority work before integrating. If an input class cannot satisfy the approved contract, keep its model path and record the evidence-backed disposition. Do not expand the fast path just to improve timing.
- [ ] Run the policy and prepared-generation checks once, verifying same-turn reuse and invalidation after edits/settings changes. Use the runtime checks already needed for integration rather than creating a broad duplicate test suite. Commit scoped changes.

## Task 6: Prove end-to-end improvement and complete the audit

**Files:** Create `src/runtime/turn-timing.mjs`, `tools/scripts/benchmark-preprocess-latency.mjs`, and `tools/scripts/test-turn-timing.mjs`. Modify `src/extension/index.js`, `src/runtime.mjs`, `src/runtime/diagnostics.mjs`, and the performance report. Use existing helpers in `tools/scripts/prove-live-pipelines.mjs` and `tools/scripts/lib/sillytavern-live-harness.mjs`.

**Interfaces:** `createTurnTiming({now})` exposes `start({operationId, attemptId})`, `mark({operationId, attemptId, event})`, and `snapshot()`. Events are `preprocess-start`, `prompt-installed`, `primary-dispatched`, `primary-first-visible-token`, and `primary-completed`. Duplicate events are idempotent; stale attempt IDs are ignored. Unavailable first-token timing is explicitly null with a reason. The benchmark accepts `--live --samples 3 --output <path>` and requires the harness's existing dedicated-user environment variables.

- [ ] Add a deterministic stale-attempt check:

```js
let now = 0;
const timing = createTurnTiming({now: () => now});
timing.start({operationId: 'op', attemptId: 'new'});
now = 100;
timing.mark({operationId: 'op', attemptId: 'old', event: 'primary-first-visible-token'});
assertEqual(timing.snapshot().firstVisibleTokenMs, null, 'old swipe cannot finish new timing');
```

- [ ] Run `node tools/scripts/test-turn-timing.mjs`, then bind timing events to existing native generation/interceptor/streaming/landed hooks. Do not infer first-visible-token from a generic event unless visible text was actually received for that attempt. Capture persistence duration at the scheduler repository boundaries and preserve successful token usage from Task 1.
- [ ] Build the benchmark with the existing dedicated-user guard and exact profile selection. Refuse default-user. Save a bounded sanitized result snapshot per sample immediately so journal rotation cannot erase evidence. Use identical synthetic source and requested cards, with separate fresh turns; never alter the user's current story.
- [ ] Compare baseline Segmented concurrency one, qualified concurrency two, and qualified Fused on the same provider settings, three paired samples per selected comparison. Alternate ordering to reduce time-of-day bias. Include all failures and recoveries. Also exercise one malformed-sibling fixture through the real router locally; do not make a live provider refuse unsafe content merely to benchmark refusal handling.
- [ ] Report medians and individual sample durations for preprocessing, primary first-visible-token, total primary reply, queue/provider time, call count, token usage, and recovery. Check required coverage, evidence validity, authored text preservation, and source identity for every accepted packet. Verify actual `fusedCardBundle` calls rather than trusting the selector.
- [ ] Review successful output/reasoning usage before tuning role budgets. Keep ceilings unchanged if the data does not support a reduction. Confirm the provisional deadline defaults allow successful paired workloads; revise with stated headroom if the measurements contradict them.
- [ ] Reconcile concurrent repository changes in the isolated checkout. Run `npm.cmd run test:alpha` once after integration; run targeted UI/browser checks for the changed surfaces. Investigate failures caused by these changes, without unrelated cleanup or repeated green gates.
- [ ] Update `artifacts/performance-review-2026-09-21.md` with a requirement-by-requirement disposition and live evidence references. Review the final diff and cancellation/provenance boundaries independently once. Prepare a concrete deliverable for integration; request authorization only for deployment/external actions not already authorized.
- [ ] Mark the goal complete only after all approved requirements have evidence, actual performance improves, and no required validation remains. If live access is unavailable, retain the full goal and identify the exact remaining access dependency; synthetic results are not a completion substitute.

## Self-review result

Tasks 1/4 cover queue performance, qualification, effective mode, and UI. Task 2 covers partial results, corrections, and refusal. Task 3 covers operation-wide recovery/deadlines. Task 5 covers prompt duplication and evaluated fast paths. Task 6 covers primary timing, measured token/deadline tuning, live comparison, integration, and the full completion audit. Each review-focus failure has an owning task. The implementation preserves the user's concurrent card-priority work and avoids repeated full-suite verification.
