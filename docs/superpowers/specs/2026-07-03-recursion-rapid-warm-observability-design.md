# Recursion Rapid Warm Observability Design

## Purpose

Make Rapid Pipeline behavior visible, joinable, and diagnosable without changing the prompt-quality contract. When Rapid is selected, the user should know whether Recursion is warming a deck, ready to use it, waiting on it during send, falling back to Standard, or failing because of a concrete safe reason.

This design builds on the Prompt Packet V3 and Rapid Warm V2 contract:

- Raw selected cards remain model-facing evidence.
- Provider-authored guidance remains additive direction.
- Runtime may coordinate, validate, persist operational status, and explain cache eligibility.
- Runtime must not compose semantic scene guidance, turn guidance, card meaning, or story content.

## Current Problem

Rapid can be technically working while feeling broken:

- `warmRapidScene()` uses the foreground `startRun()` slot. A user send can supersede and abort useful background warm work.
- The scene cache only shows Rapid after a successful warm. While provider calls are running, there is no durable `warming` artifact for UI or foreground code to see.
- Foreground Rapid checks the cache immediately. If an exact warm is still running, it reports a generic warm miss and escalates to Standard.
- The visible message `Rapid warm packet unavailable; using Standard.` does not distinguish no warm, still warming, source mismatch, settings mismatch, provider failure, or selected-card mismatch.
- The compact bar treats most standby text as transient, so a ready Rapid deck can disappear even though it is the main reason Rapid is safe to use on the next send.
- If the UI appears to be in Rapid but persisted settings say Standard, the user has no obvious status surface that proves which workflow runtime is actually using.

The quality problem is not that Standard fallback exists. The problem is that Rapid gives too little feedback and cannot briefly join an in-flight exact warm before spending a full Standard turn.

## Goals

- Show Rapid background work when Rapid is the selected pipeline.
- Persist `warming`, `ready`, `failed`, and `stale` warm status in the scene cache using the existing Rapid artifact area.
- Split background warm cancellation from foreground run cancellation so a normal send does not automatically abort the warm job it wanted to use.
- Let foreground Rapid wait briefly for an exact-source in-flight warm before falling back to Standard.
- Replace generic warm-miss copy with safe reason codes and user-facing labels.
- Keep the compact UI SillyTavern-native, small, and operational.
- Preserve privacy: no raw provider prompts, raw provider output, hidden reasoning, API keys, stack traces, or full transcript text in status surfaces.
- Preserve the card-packet quality contract: no local semantic composer and no summary-only fast-start path.

## Non-Goals

- No deterministic model-facing scene brief, turn brief, or card summary.
- No auto-opening popup spam for normal background work.
- No per-card management controls.
- No new provider role or prompt schema for this observability pass.
- No compatibility shim for older pre-alpha Rapid artifacts.
- No broad redesign of the Recursion bar.

## Selected Approach

Use an operational Rapid warm state machine plus a foreground join window.

Rapid warming becomes its own background run with its own abort controller, status record, activity events, and view state. Foreground generation keeps its existing `activeRunId`. A foreground Rapid send checks for a usable ready warm artifact first. If there is an exact in-flight warm for the same base source and matching contracts, it waits up to a short fixed window, default 4000 ms. If the warm finishes, foreground Rapid uses it. If it times out, fails, or becomes stale, foreground escalates to Standard with a precise reason.

This keeps quality honest:

- Warm ready: use Rapid Warm V2 plus `rapidTurnDelta.v2`.
- Warm in progress: wait briefly, then use Rapid if ready.
- Warm missing or unusable: Standard fallback.
- Mandatory delta gap: Standard fallback.

## Alternatives Considered

### Generic Status Only

Show better `Rapid missed; Standard` text but keep the current run model.

This is cheap, but it leaves the main waste intact: a send can still abort a useful warm job and then pay Standard cost.

### Wait Without UI

Foreground waits for an in-flight warm, but the bar still gives minimal feedback.

This improves latency when the warm completes quickly, but the user still cannot tell whether Rapid is doing useful work or hanging.

### Separate Warm Coordinator

Give warm work separate lifecycle, persist status, show progress, and allow foreground join.

This is the recommended approach. It fixes the user-facing confusion and the runtime coordination bug together while staying inside the existing Rapid Warm V2 quality model.

## Rapid Warm State Model

Runtime exposes a sanitized `rapidWarm` object in `runtime.view()`:

```js
{
  status: 'idle' | 'queued' | 'warming' | 'waiting' | 'ready' | 'missed' | 'stale' | 'failed',
  pipelineMode: 'standard' | 'rapid',
  runId: 'rapid-warm-...',
  warmArtifactId: 'rapid-warm-artifact-...',
  baseSourceRevisionHash: 'hash...',
  startedAt: '2026-07-03T08:17:00.000Z',
  completedAt: '2026-07-03T08:17:48.000Z',
  failedAt: '',
  selectedCardCount: 3,
  cardCount: 6,
  reasonCode: 'ready',
  reasonLabel: 'Rapid deck ready.',
  joinable: true
}
```

Persistent cache status remains narrower and uses the existing `variant.rapid` object:

```js
{
  pipelineVersion: 2,
  status: 'warming' | 'ready' | 'stale' | 'failed',
  warmArtifactId: 'rapid-warm-artifact-...',
  baseSourceRevisionHash: '...',
  baseSnapshotHash: '...',
  selectedCardIds: [],
  cardIds: [],
  guidance: {
    schema: 'recursion.guidanceComposer.v1',
    status: 'used' | 'missing' | 'fallback-raw-only',
    text: '',
    sourceCardIds: [],
    guardrailCardIds: [],
    omittedCardIds: [],
    diagnostics: []
  },
  storyForm: {},
  settingsHash: '...',
  providerContractHash: '...',
  cardCatalogHash: '...',
  promptContractHash: '...',
  startedAt: '...',
  builtAt: '',
  failedAt: '',
  runId: 'rapid-warm-...',
  diagnostics: ['rapid-warm-started']
}
```

`waiting` and `missed` are runtime/UI states, not durable artifact states. Durable statuses answer what exists for a source. Runtime statuses answer what foreground is doing right now.

## State Transitions

```text
idle -> warming
warming -> ready
warming -> failed
warming -> stale
ready -> stale
ready -> warming
failed -> warming
stale -> warming
warming + foreground send exact source -> waiting
waiting + warm ready before timeout -> ready -> Rapid foreground
waiting + timeout/failure/stale -> missed -> Standard fallback
```

Source edits, deletes, swipes, chat changes, provider setting changes, card scope changes, Prompt Footprint changes, Reasoning Level changes, catalog changes, and prompt contract changes make an existing warm state stale for foreground use.

## Runtime Coordination

### Background Warm

`warmRapidScene()` no longer calls the foreground `startRun()`.

It uses a Rapid-specific slot:

```js
{
  runId,
  controller,
  signal,
  promise,
  baseSourceRevisionHash,
  contract,
  startedAt
}
```

Starting a new warm aborts only the previous Rapid warm. Starting foreground generation aborts only foreground work. Global cleanup paths such as chat change, source change, settings change, dispose, and stop generation abort both foreground and warm work when the old source can no longer be trusted.

At warm start:

1. Read the stable base snapshot.
2. Compute exact base source revision and cache contract versions.
3. Save `variant.rapid.status = 'warming'` with safe metadata.
4. Emit activity phase `rapidWarming`.
5. Run Arbiter, card calls, hand selection, and `guidanceComposer`.
6. Save `variant.rapid.status = 'ready'` with selected ids, guidance, story form, hashes, and artifact hash.
7. Emit activity phase `rapidWarmReady`.

On failure:

1. Save `variant.rapid.status = 'failed'` with safe reason metadata.
2. Emit activity phase `rapidWarmFailed`.
3. Leave Standard available.

### Foreground Rapid

Foreground Rapid flow:

```text
Send -> base snapshot -> turn snapshot -> load base scene cache
  -> ready exact warm? use Rapid
  -> exact warm in flight? wait up to 4000 ms
      -> ready? reload cache and use Rapid
      -> timeout/failure/stale? Standard fallback with reason
  -> no usable warm? Standard fallback with reason
```

The wait window is deliberately short. It catches the common case where the user sends right as the warm finishes, without making Rapid feel like it stalled before doing Standard work.

## Miss Reasons

Runtime records reason codes in diagnostics and displays safe labels in UI.

| Code | User Label |
| --- | --- |
| `not-rapid-mode` | Standard Pipeline selected. |
| `provider-unavailable` | Utility provider unavailable. |
| `no-active-variant` | No Rapid deck for this source yet. |
| `warming` | Rapid deck still warming. |
| `warm-timeout` | Rapid deck still warming; Standard started. |
| `warm-failed` | Rapid warm failed; Standard started. |
| `source-mismatch` | Rapid deck belongs to a different source. |
| `settings-mismatch` | Rapid deck was built with different settings. |
| `provider-contract-mismatch` | Rapid deck was built with different provider settings. |
| `catalog-mismatch` | Rapid deck was built with a different card catalog. |
| `prompt-contract-mismatch` | Rapid deck was built with a different prompt contract. |
| `story-form-mismatch` | Rapid deck uses incompatible story-form guidance. |
| `no-candidate-cards` | Rapid deck has no usable cards. |
| `selected-card-miss` | Rapid selected cards are missing from cache. |
| `guidance-missing` | Rapid deck has no usable guidance. |
| `delta-provider-failed` | Rapid turn guidance failed. |
| `delta-invalid` | Rapid turn guidance was invalid. |
| `delta-mandatory-gap` | Rapid found a mandatory context gap. |
| `delta-empty` | Rapid turn guidance was empty. |

Diagnostic details may include truncated hashes and counts. UI copy must not include raw prompts, raw provider payloads, hidden reasoning, stack traces, or API keys.

## Progress And UI Contract

When `pipelineMode === 'rapid'`, the compact bar and progress menu show Rapid warm state as real runtime state, not as a transient setting acknowledgement.

Visible labels:

- `Rapid warming scene deck...`
- `Rapid deck ready.`
- `Waiting for Rapid deck...`
- `Rapid warm missed; Standard started.`
- `Rapid warm failed.`
- `Rapid deck stale.`

Progress phases:

- `rapidWarming`
- `rapidWarmWaiting`
- `rapidWarmReady`
- `rapidWarmMissStandard`
- `rapidWarmFailed`
- `rapidWarmStale`
- `rapidDeltaRunning`

The Hero Pixel Array can show background warm work when Rapid is selected because that work directly affects the next send. The progress menu shows warm rows and provider child rows where available. If the progress menu is already open, it updates in place. Recursion should not auto-open the progress popover for normal background warm work.

Ready state persists until source or settings change. This is a deliberate exception to the current four-second standby convention because `Rapid deck ready.` is not a temporary click acknowledgement; it is the active readiness state for the selected workflow.

If persisted settings and visible runtime disagree, the UI must display the normalized runtime setting. The Pipeline icon, tooltip, `runtime.view().settings.pipelineMode`, and settings persistence path should be testable from the same source of truth.

## Activity And Journal

Activity events stay sanitized and bounded:

```js
{
  runId: 'rapid-warm-...',
  phase: 'rapidWarming',
  label: 'Rapid warming scene deck...',
  chips: ['Rapid'],
  detail: {
    baseSourceRevisionHash: 'a2b42f15',
    reasonCode: 'warming'
  }
}
```

Journal entries record:

- run id;
- phase;
- source revision hash;
- warm artifact id;
- status;
- reason code;
- selected card count;
- card count;
- contract hash prefixes where useful;
- latency.

Journal entries never store raw provider request bodies, raw responses, hidden reasoning, session keys, or full transcript text.

## Testing Contract

Deterministic tests must prove:

- `warmRapidScene()` uses a separate warm run and is not aborted by normal foreground `prepareForGeneration()`.
- Warm start persists `status: 'warming'` before provider calls.
- Warm success persists `status: 'ready'` with Rapid Warm V2 guidance and selected card ids.
- Warm failure persists `status: 'failed'` with safe reason metadata.
- Foreground Rapid joins an exact in-flight warm and uses Rapid when it completes inside the wait window.
- Foreground Rapid times out after the wait window and escalates to Standard with `warm-timeout`.
- Foreground Rapid reports distinct miss reasons for source, settings, provider contract, catalog, prompt contract, selected-card, candidate-card, and guidance failures.
- Progress model renders Rapid warming, waiting, ready, missed, failed, and stale states.
- UI standby shows persistent `Rapid deck ready.` while Rapid remains ready for the active source.
- Settings view, pipeline icon, and runtime `settings.pipelineMode` agree.
- `node tools/scripts/run-alpha-gate.mjs` passes.

Live proof must show:

- Served extension copy contains the new Rapid warm coordination code.
- With Rapid selected, assistant landing starts a visible Rapid warm sequence.
- During a long warm, the progress menu reports provider work in progress.
- If the user sends while exact warm is running, foreground shows `Waiting for Rapid deck...`.
- If warm completes inside the wait window, the turn uses `rapidPath: warm-v2`.
- If warm is unavailable, the UI reports a specific miss reason and Standard starts.
- No local semantic Rapid guidance or summary-only fast-start appears in prompt packet evidence.

## Documentation Updates

Update in place after implementation:

- `DESIGN.md`: Rapid ready persistence and Rapid warm progress state exception.
- `docs/design/UI_SPEC.md`: progress phases, labels, and readiness behavior.
- `docs/architecture/RUNTIME_ARCHITECTURE.md`: separate warm coordinator and foreground join.
- `docs/technical/RUNTIME_TURN_SEQUENCE.md`: Rapid warm/wait/fallback sequence.
- `docs/user/RECURSION_OPERATOR_MANUAL.md`: user-facing meaning of Rapid warming, ready, missed, and failed states.
- Existing Rapid and card-packet specs only where the observability contract touches their current behavior.

## Acceptance Criteria

- Rapid no longer feels like a silent Standard fallback when it is selected.
- User can see whether Rapid is warming, ready, waiting, missed, stale, or failed.
- Foreground send does not abort an exact useful warm job.
- Foreground Rapid briefly joins exact in-flight warm work before falling back.
- Warm misses explain why Standard ran.
- No model-facing semantic content is composed locally.
- All status and diagnostics remain privacy-safe.

## Self-Review

- Open-item scan: no unresolved markers remain.
- Scope check: this is one implementation slice covering Rapid warm coordination and UI feedback only.
- Consistency check: Standard fallback remains the quality-preserving miss path; Rapid Warm V2 card-packet contract remains unchanged.
- Ambiguity check: popover auto-open is explicitly out of scope for normal warm work; visible progress is through bar state and the existing progress menu.
