# Readable Failure Presentation Design

**Date:** 2026-07-22
**Status:** Approved direction, documented for implementation
**Scope:** User-visible Recursion warning and failure copy, normalized activity
failure propagation, terminal progress-row identity, actionable recovery copy,
diagnostic separation, and regression proof

## Context

Recursion already has most of the intended failure architecture:

- `src/failures.mjs` owns a normalized failure descriptor and known provider
  classifications;
- `src/activity.mjs` requires warning and error activity events to contain a
  reason;
- `src/progress.mjs` gives warning and failed steps a visible `reason`;
- `src/ui.mjs` renders that reason directly below the affected progress row;
- `DESIGN.md` and `docs/design/UI_SPEC.md` require visible, sanitized reasons
  rather than hover-only explanations.

The reported failure exposed an incomplete contract migration. The runtime
settled an error using this legacy shape:

```js
{
  outcome: 'error',
  label: 'Recursion runtime failed.',
  detail: { message: safeError.message }
}
```

The activity invariant does not treat `detail.message` as a normalized failure.
It therefore added a sentinel descriptor with
`RECURSION_ACTIVITY_REASON_MISSING`, and progress displayed the sentinel text.
At the same time, every generic `settled` activity mapped to the
`recursion-prompt-ready` progress step. The result was a contradictory terminal
row:

```text
Recursion prompt ready                         failed
Unexpected internal failure
(RECURSION_ACTIVITY_REASON_MISSING).
```

This is not primarily a copywriting defect. It is a producer-contract and
terminal-stage identity defect whose fallback happens to be developer-facing.

## Design Decision

Complete the V1 normalized failure migration in place. Every warning or error
activity producer must provide one `detail.failure` descriptor. Activity,
progress, UI, journals, and diagnostics consume that descriptor without
reclassifying raw exceptions.

Do not add support for `detail.message` as a second accepted failure shape. The
extension is pre-alpha, so all producers will be updated to the current
contract rather than protected by a compatibility shim.

Do not classify failures in `src/ui.mjs`. Presentation code must not infer a
cause from a label, an exception string, or journal history.

## User Outcome

An average user should be able to answer three questions without opening
developer tools:

1. What was Recursion doing?
2. What went wrong?
3. What can I try next?

Example terminal presentation:

```text
Utility card batch                            failed
The selected model connection did not respond before the time limit.
Try: Check the selected connection profile, then try again.
```

The compact bar may shorten this to:

```text
Utility card batch: model connection timed out.
```

The Full Viewer, journal, or exported sanitized diagnostics retain the stable
failure code and technical stage:

```text
RECURSION_PROVIDER_TIMEOUT
stage: utility-card-batch
category: provider-timeout
```

The normal progress surface does not display the internal code.

## Goals

1. Make every warning and failure understandable without knowledge of Recursion
   internals, JavaScript, provider APIs, or internal error codes.
2. Preserve stable failure codes and bounded technical context for diagnosis.
3. Keep failure classification at the source boundary that understands the
   failure.
4. Keep the existing compact progress menu as the primary explanation surface.
5. Preserve the exact stage that failed instead of representing all terminal
   settlements as prompt readiness.
6. Show a next action only when the user can meaningfully perform one.
7. Prevent raw exception text, provider output, prompts, credentials, paths,
   stack traces, and secrets from entering compact UI copy.
8. Prove the contract across failure normalization, activity, runtime,
   progress, UI, and journal presentation.

## Non-Goals

- Adding a toast, modal, banner, or separate notification center.
- Redesigning the Recursion Bar or progress menu.
- Exposing stack traces or raw provider responses to make reports more
  detailed.
- Guessing whether a user's computer, network, regional load, or uptime caused
  a timeout.
- Automatically changing connection profiles, timeout settings, models, or
  credentials.
- Changing retry budgets or provider-routing behavior.
- Treating cancellation, supersession, or a deliberate skip as a failure.
- Preserving legacy warning or error activity shapes.

## Unified Failure Descriptor

Every unhealthy activity uses the existing normalized descriptor:

```js
{
  code: 'RECURSION_PROVIDER_TIMEOUT',
  stage: 'utility-card-batch',
  category: 'provider-timeout',
  message: 'The selected model connection did not respond before the time limit.',
  retryable: true,
  attemptedRecovery: 'Retried the model call once.',
  suggestedAction: 'Check the selected connection profile, then try again.'
}
```

Required fields:

- `code`: stable diagnostic identifier;
- `stage`: stable normalized subsystem or operation stage;
- `category`: one existing `FAILURE_CATEGORIES` value;
- `message`: bounded, sanitized, user-facing explanation;
- `retryable`: whether the existing runtime policy considers another attempt
  safe.

Optional fields:

- `attemptedRecovery`: what Recursion actually tried;
- `suggestedAction`: one action the user can perform now.

`attemptedRecovery` must not state an intended retry that did not occur.
`suggestedAction` must be omitted when the user cannot improve the outcome.

## Plain-Language Copy Contract

### Voice

Failure copy is calm, direct, specific, and non-accusatory. It describes the
observable failure without inventing a cause.

Prefer:

```text
The selected model connection did not respond before the time limit.
```

Avoid:

```text
Provider generation timed out after 120000ms.
DeepSeek may be overloaded in China.
Your connection profile is broken.
```

### Vocabulary

Use product vocabulary a normal Recursion user can locate in the interface:

- `selected model connection` rather than `provider generation router`;
- `connection profile` when the action points to the Providers settings;
- `response` rather than `payload`;
- `required format` rather than `schema mismatch`;
- `time limit` rather than milliseconds;
- `Recursion prompt` only when prompt installation is the actual failed stage.

`Utility`, `Reasoner`, and named progress stages remain valid because they are
visible Recursion concepts. Internal module names, JavaScript types, and
`RECURSION_*` codes are diagnostic vocabulary.

### Canonical category copy

Known provider and runtime classifiers may be more specific, but their copy
must remain within these intentions:

| Category | Message intention | Action intention |
| --- | --- | --- |
| `provider-timeout` | The selected model connection did not respond before the time limit. | Check the selected connection profile, then retry. |
| `provider-account` | The model service rejected the account or sign-in details, or the account cannot fund the request. | Check credentials, account status, or choose another configured connection. |
| `provider-request` | The model service rejected this request or is temporarily limiting requests. | Check the selected model/settings or wait briefly, according to the classified cause. |
| `provider-length` | The model stopped before completing the required response. | Increase the applicable token limit or reduce request context. |
| `provider-output` | The model returned a response Recursion could not read or use. | Retry or choose a model that reliably follows structured-output requests. |
| `validation` / `model-output` | The response was readable but did not satisfy the operation's required content. | Retry or change model only when that is genuinely useful. |
| `prompt-install` | Recursion prepared guidance but could not attach it to the generation. | Retry generation. |
| `host-mutation` | SillyTavern did not confirm the requested message or swipe change. | Retry the operation without claiming the message changed. |
| `storage` | Recursion could not save a required artifact. | Retry or inspect storage diagnostics if the failure persists. |
| `stale-state` | The chat changed before the operation could finish. | Retry against the current message when appropriate. |
| `internal` | Recursion hit an unexpected internal error. | Retry; if persistent, copy the failure code from Diagnostics. |

Do not hardcode `2 minutes` unless the classifier has the effective timeout for
that exact call. The stable fallback says `before the time limit`. Diagnostics
may retain the exact `timeoutMs`.

## Activity Contract

Warning and error events must contain `detail.failure` before they reach the
activity reporter:

```js
{
  runId,
  phase: 'settled',
  logicalStage: 'utilityComposing',
  outcome: 'error',
  label: 'Recursion could not prepare the prompt.',
  detail: { failure }
}
```

`logicalStage` records the activity phase that owned the work immediately
before the generic lifecycle settlement. It is presentation routing metadata,
not a second failure stage. `failure.stage` remains the stable diagnostic stage.

The reporter keeps a defense-in-depth invariant. If an unhealthy event arrives
without a descriptor, it creates:

```js
{
  code: 'RECURSION_ACTIVITY_REASON_MISSING',
  stage: event.logicalStage || event.phase || 'activity',
  category: 'internal',
  message: 'Recursion hit an unexpected internal error.',
  retryable: false,
  suggestedAction:
    'Try again. If it keeps happening, copy the failure code from Diagnostics.'
}
```

The sentinel code proves a producer contract defect. The code is retained in
activity history and diagnostics, but its identifier is not interpolated into
the compact user message. The reporter removes a legacy top-level
`detail.message` from unhealthy normalized events so a raw exception cannot
survive beside the authoritative descriptor.

## Runtime Error Boundary

`src/runtime.mjs` may keep a bounded technical `Error` for rejection and
diagnostics. Before settling activity, it converts that error into a display-safe
failure descriptor using `src/failures.mjs`.

Provider-shaped failures are passed through `providerFailure`. Unknown runtime
exceptions become the safe internal descriptor. The UI never receives raw
exception text as its explanation.

The runtime captures the active phase before settling:

```js
const activeActivity = safeCurrentActivity(activity);
const logicalStage = activeActivity?.phase || 'runtime';
const failure = failureFromError(error, { stage: logicalStage });

settleRuntimeActivity({
  runId,
  phase: 'settled',
  logicalStage,
  outcome: 'error',
  label: 'Recursion could not prepare the prompt.',
  detail: { failure }
});
```

## Progress Identity And Data Flow

Success and failure use different generic-settlement routing:

- a successful normal `settled` event may map to `recursion-prompt-ready`;
- a warning or error `settled` event maps to its `logicalStage` when known;
- an unhealthy settlement without a known stage maps to a new
  `recursion-runtime` step labeled `Preparing Recursion response`;
- specialized post-process, Editorial, provider-test, and role-owned
  settlements retain their existing explicit mappings.

The normalized progress step carries presentation-safe failure data:

```js
{
  id: 'utility-card-batch',
  label: 'Utility card batch',
  state: 'failed',
  meta: 'failed',
  reason: 'The selected model connection did not respond before the time limit.',
  suggestedAction: 'Check the selected connection profile, then try again.',
  failureCode: 'RECURSION_PROVIDER_TIMEOUT'
}
```

`failureCode` is retained for diagnostics and test correlation. The ordinary
row renderer does not render it.

When multiple events merge into one progress step:

- the latest material warning/failure reason wins;
- a non-empty suggested action from the same failure wins;
- failed state remains dominant over warning and success;
- child failure aggregation may supply the parent reason and action only when
  the parent lacks its own descriptor.

## Visible Presentation

The progress menu remains compact and operational:

```text
R  red-dot  Utility card batch                     failed
            The selected model connection did not respond before the time limit.
            Try: Check the selected connection profile, then try again.
```

Rules:

- `reason` is visible for warning and failed rows;
- `suggestedAction` is visible as a subdued `Try:` subline when present;
- successful, cached, pending, skipped, and canceled rows do not show either
  failure subline;
- amber/red state color remains on the state label and reason;
- the action uses subdued helper color so it does not compete with the reason;
- reason and action wrap naturally and increase the row height;
- tooltip and accessibility copy repeat the same reason and action;
- tooltip is supplementary, never the only explanation;
- the compact bar uses the stage and concise reason but omits the longer action;
- internal codes remain in Full Viewer/diagnostics, not normal row text.

This extends the existing one-reason-subline design into one explanation block
with an optional action line. It does not add a new panel or alert component.

## Privacy And Safety

Primary and suggested-action copy must pass the existing bounded redaction path.
The compact UI must not contain:

- prompts or transcript excerpts;
- raw provider responses or hidden reasoning;
- API keys, authorization values, cookies, credentials, or connection secrets;
- stack traces, filesystem paths, or source line numbers;
- unbounded provider error bodies;
- inferred environmental claims that Recursion did not verify.

The raw technical error may be reduced to bounded diagnostics where the current
privacy contract permits it. The normalized message remains the only source for
compact failure presentation.

## Journals And Diagnostics

Warning/error terminal journal entries retain the same descriptor:

```js
details: {
  failure: {
    code,
    stage,
    category,
    message,
    retryable,
    attemptedRecovery,
    suggestedAction
  }
}
```

Provider-call journals may additionally retain sanitized effective timeout,
HTTP status, finish reason, retry count, latency, model identifier, and hashes.
The visible progress reason is not reconstructed from those fields.

## Recovery And State Semantics

- A timeout after its bounded retry policy is terminal for that attempt.
- A successful retry remains an amber warning with an explanation of the retry.
- Local fallback is a warning only when it materially changes the result; its
  reason explains which provider work failed or why fallback was used.
- Cancellation and supersession settle neutral and do not receive failure copy.
- A new generation starts a fresh progress run and does not inherit an old
  failure or suggested action.
- A prompt-install failure must not claim that the prompt is ready.
- A runtime failure after completed card rows preserves those completed rows and
  fails the actual logical stage or the runtime fallback step.

## Documentation Amendments

Implementation updates these documents in place:

- `DESIGN.md`: progress warning/failure explanation block includes an optional
  visible action line; internal codes remain diagnostic-only.
- `docs/design/UI_SPEC.md`: unhealthy generic settlement routing,
  `suggestedAction`, `failureCode`, and visible `Try:` behavior.
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`: source-owned failure
  normalization and timeout copy policy.
- `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`: normalized descriptor and
  diagnostic-only internal code policy.
- `docs/superpowers/specs/2026-07-17-recursion-layered-failure-recovery-design.md`:
  reference this focused amendment for terminal presentation behavior.

## Test Strategy

### Failure normalization

Prove known provider mappings, unknown-internal fallback, bounded copy,
redaction, actual recovery text, and meaningful suggested-action policy.

### Activity invariant

Prove valid descriptors survive unchanged and missing descriptors create a
friendly sentinel descriptor whose code remains diagnostic-only.

### Runtime propagation

Inject a provider timeout and an unknown runtime exception. Prove runtime
settles `detail.failure`, captures `logicalStage`, preserves the thrown bounded
error for callers, and never sends raw exception text as the visible reason.

### Progress routing

Reproduce the reported sequence. Prove the failed settlement does not create a
failed `Recursion prompt ready` row, the actual logical stage fails, and reason,
action, and code reach the normalized step.

### UI rendering

Prove reason and action are visible without hover, tooltips/accessibility repeat
them, success rows stay compact, and internal codes do not appear in normal row
text.

### Cross-layer oracle

Extend the strict unhealthy-state oracle to reject:

- warning/error activity without `detail.failure`;
- generic or empty warning/failure messages;
- a failure code in compact UI text;
- a failed generic settlement mapped to prompt readiness;
- a descriptor action lost before UI rendering;
- a script that reports success after observing an unhealthy state.

### Optional operational observation

Normal card-progress certification may observe readable failure presentation
when a real failure occurs, but this feature does not add a synthetic failure
hook or a mandatory live-provider failure run. Runtime, progress, and DOM tests
own the deterministic acceptance gate.

## Acceptance Criteria

1. No normal user-facing warning or failure displays a `RECURSION_*` identifier
   as its primary explanation.
2. Every warning/error activity event has `detail.failure` after normalization.
3. Runtime terminal catches emit the normalized descriptor, not
   `detail.message`.
4. A failed generic settlement never appears as `Recursion prompt ready`.
5. The affected logical stage, or `Preparing Recursion response` fallback,
   becomes the failed progress row.
6. Warning and failed rows show a visible bounded reason.
7. A meaningful suggested action appears visibly as `Try:`; absent actions do
   not leave empty spacing.
8. Tooltip and accessibility copy contain the same reason/action.
9. Full Viewer, journals, and sanitized diagnostics retain stable failure codes.
10. Cancellation, supersession, skip, success, and cached states retain their
    existing semantics.
11. Focused tests and the full `npm.cmd test` gate pass.
