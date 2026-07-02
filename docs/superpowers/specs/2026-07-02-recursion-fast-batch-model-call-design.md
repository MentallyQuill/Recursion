# Recursion Fast Batch Model Call Design

## Purpose

Recursion needs a faster and more honest model-call system for Utility and Reasoner work. The immediate bug is that the SillyTavern host adapter advertises a batch API but runs it sequentially. The larger design goal is a robust batch pipeline that submits independent card/model calls concurrently when the host can support it, degrades intentionally when it cannot, and records enough sanitized timing evidence to prove what happened.

This document captures the live finding first, then defines the V1 improvement contract.

## Live Finding: Story Message 919

Source inspected:

- SillyTavern user: `default-user`
- Character card: `Story`
- Chat: `Branch #790 - 2025-08-28@18h02m24s`
- Chat file: `F:/SillyTavern/SillyTavern/data/default-user/chats/Story/Branch #790 - 2025-08-28@18h02m24s.jsonl`
- Recursion run journal: `F:/SillyTavern/SillyTavern/data/default-user/user/files/recursion-run-journal-Branch-790---2025-08-28-18h02m24s.v1.json`
- Recursion scene cache: `F:/SillyTavern/SillyTavern/data/default-user/user/files/recursion-scene-Branch-790---2025-08-28-18h02m24s-Branch-790---2025-08-28-18h02m24s-d4fb3d15.v1.json`

Message indexing detail:

- JSONL line 1 is chat metadata.
- The latest assistant row is physical line 921.
- That row corresponds to visible zero-based message 919.

Observed host generation timing:

- `gen_started`: `2026-07-02T20:04:39.011Z`
- `gen_finished`: `2026-07-02T20:17:26.804Z`
- Total wall time: about 12 minutes 48 seconds.
- `time_to_first_token`: 30546 ms.
- Model: `zai-org/glm-5.2:thinking`
- API: `nanogpt`

Observed Recursion run timing for `run-mr3xo074-7uabol`:

- Cache invalidated at `2026-07-02T20:04:39.836Z` for `cardCatalogHash` and `providerContractHash` mismatch.
- Utility Arbiter started at `2026-07-02T20:04:39.885Z`.
- Utility Arbiter completed at `2026-07-02T20:05:58.504Z`, latency 78622 ms.
- Six card calls were recorded as started between `2026-07-02T20:05:58.571Z` and `2026-07-02T20:05:58.767Z`.
- Six card calls failed as timeouts around `2026-07-02T20:16:40Z`.
- `sceneFrameCard` reported `latencyMs: 240014`.
- The other five card calls reported about `latencyMs: 641700` to `642005`.
- All timed-out card calls reported `retryCount: 1`.
- Recursion then installed a prompt at `2026-07-02T20:16:40.779Z` using two fallback/local cards.
- The final Story target generation finished at `2026-07-02T20:17:26.804Z`.

Resulting scene cache:

- `latestHand.cardIds`: `card-Scene-Constraints-c1424c30`, `card-Scene-Frame-7cd2e218`
- Both cards cite `message:920`.
- Both cards were generated locally/fallback after provider card timeout, not accepted provider card output.

## Root Cause

Runtime correctly asks for a card batch:

- `src/runtime.mjs` builds card requests in `generatePlanCards(...)`.
- It calls `generationRouter.batch(signalRequests, options)` when a batch function exists.

Provider routing correctly treats host batch as a batch capability:

- `src/providers.mjs` checks `typeof host?.generation?.batch === 'function'`.
- For host-backed sources, it calls `host.generation.batch(enriched)`.
- If no host batch exists, provider client falls back to `Promise.all(normalized.map(({ roleId, request }) => generate(roleId, request)))`.

The SillyTavern host adapter is the broken boundary:

```js
async batch(requests = []) {
  const responses = [];
  for (const request of requests) responses.push(await this.generate(request));
  return responses;
}
```

That function lives in `src/hosts/sillytavern/host.mjs`. It advertises batch, so upstream logs and progress treat the operation as a batch. Internally it awaits one request before submitting the next. The live journal shape matches this: every card slot records a start time together, but the actual host calls take serial timeout-shaped wall time.

Installed SillyTavern copies confirm the same relevant implementation:

- `F:/SillyTavern/SillyTavern/public/scripts/extensions/third-party/Recursion/src/hosts/sillytavern/host.mjs`
- `F:/SillyTavern/SillyTavern/data/default-user/extensions/Recursion/src/hosts/sillytavern/host.mjs`

## V1 Requirements

1. Host batch must not mean "sequential loop with batch-shaped logs."
2. Batch execution must have explicit capability metadata: true concurrent, emulated concurrent, sequential fallback, or unavailable.
3. Independent card jobs should start together when concurrency is allowed.
4. Per-slot diagnostics must show actual submit time, settle time, latency, retry count, timeout, provider source, role id, lane, and batch id.
5. Batch-level diagnostics must show requested count, submitted count, succeeded count, failed count, fallback mode, concurrency limit, batch duration, and slowest slot.
6. Timeouts must apply per slot, not only to the whole batch wrapper.
7. Retry policy must avoid multiplying slow calls. For a batch timeout, retry only slots that are retryable and still current.
8. Abort signals must cancel pending and in-flight work where the host API accepts a signal.
9. Progress UI must distinguish "queued", "submitted", "running", "retrying", "timed out", "fallback", and "installed" states.
10. The target Story generation should not wait on every optional card call when a bounded card deadline has expired.

## Speed Strategy

### Fast Path 1: Concurrent Host Batch

The immediate SillyTavern adapter fix is to make `generation.batch()` submit all requests before awaiting any one result:

```js
async batch(requests = []) {
  return Promise.all(requests.map((request) => this.generate(request)));
}
```

This is the minimal correctness fix, but it is not the whole design. It creates real concurrent submission only when the underlying host services can handle parallel calls. It also preserves the current all-or-nothing behavior where one rejected Promise rejects the whole host batch unless wrapped higher up.

### Fast Path 2: Slot-Isolated Concurrent Batch

The preferred adapter behavior is slot-isolated concurrency:

```js
async batch(requests = []) {
  return Promise.all(requests.map(async (request, index) => {
    try {
      return await this.generate(request);
    } catch (error) {
      return { error, index };
    }
  }));
}
```

Provider/router code should normalize each failed slot into the existing `ok: false` result shape. One bad card should not erase successful sibling cards.

### Fast Path 3: Bounded Parallel Scheduler

Some providers and host APIs may rate-limit or internally serialize. Recursion should support a small bounded scheduler:

- Default Utility card concurrency: 4.
- Default Reasoner card concurrency: 2.
- Default target generation concurrency: 1.
- Provider test calls: 1.
- User-configurable hard caps can come later; V1 should use constants and diagnostics first.

The scheduler should submit up to the lane cap immediately, then launch the next request when one settles. This preserves speed without hammering a weak host/profile service.

### Deadline-Aware Cards

Card generation is useful but not allowed to block the player for many minutes.

Proposed deadlines:

- Arbiter deadline: keep current provider timeout unless settings later split this.
- Card batch soft deadline: 45 seconds for normal/high reasoning.
- Card batch hard deadline: 75 seconds.
- Per-slot provider timeout: 120 seconds remains a low-level safety net.

When the soft deadline hits, Recursion should compose from successful provider cards plus cache cards. When the hard deadline hits, Recursion should abort remaining card work, use fallback cards if needed, install the prompt, and let target generation proceed.

This keeps slow cards from consuming the whole turn while still using any fast cards that finished.

## Proposed Architecture

### 1. Host Capability Contract

Add a capability method or metadata object to SillyTavern host generation:

```js
generation.capabilities = {
  batch: {
    mode: 'concurrent',
    maxConcurrency: 4,
    slotIsolation: true,
    supportsAbortSignal: true,
    source: 'sillytavern-host-adapter'
  }
};
```

Allowed `mode` values:

- `native`: host/provider has a real multi-request API.
- `concurrent`: Recursion adapter submits independent host calls in parallel.
- `bounded`: Recursion adapter uses a concurrency cap.
- `sequential`: adapter can only run one at a time.
- `unavailable`: no batch path.

Provider code must not infer speed semantics from `typeof batch === 'function'`. It should read capability metadata and emit diagnostics from it.

### 2. Batch Runner

Create a shared batch runner in `src/providers.mjs` or a new focused module such as `src/provider-batch.mjs`.

Responsibilities:

- Normalize requests.
- Assign `batchId` and per-slot `slotId`.
- Mark each slot `queued`.
- Submit all allowed slots quickly.
- Record actual `submittedAt`.
- Apply per-slot timeout.
- Apply batch soft and hard deadlines.
- Preserve result order.
- Normalize slot failure without losing sibling success.
- Emit sanitized journal/activity events.

The runner should be used by:

- Provider client host-backed batch.
- Router batch.
- Runtime card generation.
- Future evaluation harness real-call traversal.

### 3. Per-Slot Result Shape

Internal batch results should carry more timing metadata before redaction:

```js
{
  ok: true,
  roleId: 'sceneFrameCard',
  lane: 'utility',
  batchId: 'batch-...',
  slotId: 'slot-...',
  batchIndex: 0,
  data: { schema: 'recursion.card.v1' },
  diagnostics: {
    batchMode: 'concurrent',
    concurrencyLimit: 4,
    queuedAt: '...',
    submittedAt: '...',
    settledAt: '...',
    queueMs: 2,
    latencyMs: 18342,
    retryCount: 0,
    timeoutMs: 120000
  }
}
```

Failures use the same structure with `ok: false`, sanitized `error`, and `status`.

### 4. Retry Contract

Retry should move from "retry whole batch once" toward "retry failed retryable slots once."

Rules:

- Retry only slots with retryable transport, timeout, or parse/schema failures that the structured retry prompt can repair.
- Before retry, call the existing freshness guard.
- Do not retry slots after the card hard deadline.
- Do not retry if the run is no longer current.
- Do not retry all sibling slots when only one slot failed.
- Record `retrySkippedReason` per slot.

This is faster and avoids doubling cost/latency for good slots.

### 5. Progress And Journal Evidence

Existing progress already has `utility-card-batch` and child rows. The improvement is to make progress truthful about execution:

- Parent row: `Utility card batch`, state from aggregate child states.
- Child states: queued, submitted, running, done, warning, timeout, fallback, skipped.
- Parent detail: `batchMode`, `concurrencyLimit`, `requested`, `submitted`, `succeeded`, `failed`, `durationMs`.
- Child detail: role id, family, lane, queue ms, latency ms, retry count, timeout status.

Run journal events should be enough to answer:

- Did Recursion submit requests together?
- Did host/provider serialize them anyway?
- Which slot blocked the turn?
- Did deadline fallback happen?
- Did target generation wait for cards or proceed after deadline?

### 6. Runtime Card Policy

Runtime should treat provider cards as opportunistic input, not mandatory turn gate.

Selection order after deadline:

1. Current exact-source cache cards.
2. Provider cards that completed before soft/hard deadline.
3. Local fallback cards.
4. No card, if behavior policy says prompt can be safely compact.

For high/ultra reasoning, Recursion may request more cards, but the deadline still protects the user. More card jobs should increase chance of useful early cards, not guarantee longer wait.

### 7. Provider Profile Safety

Connection profiles may share one backend queue. Recursion cannot assume external parallelism works just because calls were submitted together.

Diagnostics should compare:

- Recursion submit spread: difference between first and last `submittedAt`.
- Provider settle spread.
- Per-slot latency.
- Batch wall time.

If submit spread is small but all slots settle one by one at provider-like intervals, Recursion can flag `provider-serialized-suspected`. That is not a failure by itself; it tells the operator the external provider/profile is the bottleneck.

## Implementation Slices

### Slice 1: Truthful Concurrent Host Batch

Files:

- `src/hosts/sillytavern/host.mjs`
- `tools/scripts/test-host.mjs`

Change:

- Replace serial `batch()` loop with concurrent slot-isolated submission.
- Add a host test that delays first request and proves the second request is submitted before first settles.
- Preserve result ordering.
- Preserve request `signal`.

### Slice 2: Capability Metadata

Files:

- `src/hosts/sillytavern/host.mjs`
- `src/providers.mjs`
- `tools/scripts/test-providers.mjs`
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`

Change:

- Add `generation.capabilities.batch`.
- Update provider routing to record `batchMode` and `concurrencyLimit`.
- Stop treating `batch()` existence as proof of true concurrent behavior.

### Slice 3: Slot-Isolated Router Batch

Files:

- `src/providers.mjs` or new `src/provider-batch.mjs`
- `tools/scripts/test-providers.mjs`

Change:

- Preserve successful sibling slots when one slot fails.
- Retry only failed retryable slots.
- Record per-slot timing fields.
- Keep raw prompts and raw provider output out of activity/journal.

### Slice 4: Deadline-Aware Runtime Cards

Files:

- `src/runtime.mjs`
- `src/progress.mjs`
- `tools/scripts/test-runtime.mjs`
- `tools/scripts/test-progress.mjs`
- `docs/technical/RUNTIME_TURN_SEQUENCE.md`

Change:

- Add card soft/hard deadlines.
- Compose prompt from completed cards plus cache/fallback after deadline.
- Abort still-pending card slots at hard deadline.
- Show deadline fallback in progress.

### Slice 5: Live Proof Harness

Files:

- `tools/scripts/smoke-sillytavern-live.mjs`
- `tools/scripts/lib/sillytavern-live-harness.mjs`
- `docs/testing/LIVE_SMOKE_TEST_PLAN.md`

Change:

- Add optional live batch proof that records Recursion submit spread and batch mode.
- Use dedicated configured live user when available.
- Do not run real model-call proof in default `npm.cmd test`.

## Acceptance Criteria

Deterministic:

- `tools/scripts/test-host.mjs` proves SillyTavern host batch submits sibling calls concurrently.
- `tools/scripts/test-providers.mjs` proves provider batch preserves sibling successes, slot failures, result order, retry metadata, and redaction.
- `tools/scripts/test-runtime.mjs` proves slow card slots cannot block prompt install beyond the card hard deadline.
- `tools/scripts/test-progress.mjs` proves batch parent/child progress states report queued/submitted/running/timeout/fallback truthfully.
- `npm.cmd test` passes on Windows PowerShell.
- `node tools/scripts/run-alpha-gate.mjs` passes after the implementation slices land.

Live:

- Installed Recursion copy contains the fixed host adapter.
- A live SillyTavern run records card-slot `submittedAt` values close together for concurrent mode.
- The run journal records `batchMode`, `concurrencyLimit`, submit spread, and slot latencies.
- A slow provider-card batch falls back by deadline instead of delaying target Story generation for many minutes.

## Non-Goals

- Do not add legacy compatibility shims for the old serial batch behavior.
- Do not expose raw prompts, raw provider responses, API keys, or hidden reasoning in diagnostics.
- Do not require every provider to support real parallelism before Recursion improves its own submission path.
- Do not make live real-model proof part of the default deterministic test suite.
- Do not solve provider pricing/rate-limit tuning with a full UI in this pass.

## Implementation Decisions

These decisions are part of the V1 design and should be carried into the implementation plan:

1. Create `src/provider-batch.mjs` for the shared batch runner. `src/providers.mjs` is already large and should delegate batch orchestration instead of absorbing more scheduler logic.
2. Use constants for V1 deadlines and concurrency caps. Do not add settings UI until diagnostics prove which controls operators actually need.
3. Emit suspected provider serialization as diagnostics-only at first. It should not alarm the operator unless Recursion missed its own deadline or failed to install a prompt.
4. Reserve `native` batch mode for future provider APIs that accept multiple prompts in one provider request. The SillyTavern adapter should report `concurrent` or `bounded`, not `native`.
5. Keep target Story generation single-flight. Recursion can speed up preparatory Utility/Reasoner work, but it must not try to generate multiple final chat replies.

## Recommended Path

Implement Slice 1 first because it fixes the confirmed live bug with narrow blast radius. Then implement Slice 2 and Slice 3 so Recursion can prove the difference between real, emulated, bounded, and sequential batch modes. Slice 4 is the speed multiplier that prevents future slow card batches from blocking the player. Slice 5 closes the live-proof loop without making normal tests expensive or flaky.
