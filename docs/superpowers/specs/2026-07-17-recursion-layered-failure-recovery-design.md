# Recursion Layered Failure Recovery Design

**Date:** 2026-07-17
**Status:** Approved design, pending implementation plan
**Scope:** Provider output recovery, Redirect diagnosis resilience, terminal
failure reporting, progress presentation, diagnostics, and regression proof

## Problem

Recursion currently treats unrelated failure classes as equivalent terminal
contract violations:

- provider transport and account failures;
- malformed structured output;
- structurally incomplete model output;
- incorrect evidence-reference bookkeeping;
- unsupported semantic claims;
- stale host state;
- failed SillyTavern mutation.

This makes recoverable model defects abort expensive operations and then hides
the useful reason from the user.

The latest `default-user` SG-1 Redirect runs exposed both sides of the problem.
One provider response contained malformed JSON because one `role` property was
missing its opening quote. The correction parsed, but the Redirect diagnosis
then cited an evidence identifier outside the frozen registry. The run journal
preserved `RECURSION_JSON_PARSE_FAILED` and
`RECURSION_EDITORIAL_REDIRECT_EVIDENCE_INVALID`, while the progress surface
reported only that Editorial failed.

There is also a contract contradiction. Redirect prompts state that the
independent Verifier decides whether evidence supports the diagnosis, but the
pre-transform validator currently terminates the run when citation bookkeeping
is imperfect. The verifier never receives the proposal.

## Goals

1. Recover protocol and bookkeeping defects without weakening semantic review.
2. Keep the healthy-path model-call count unchanged.
3. Bound every recovery path so Recursion cannot loop or spend indefinitely.
4. Keep frozen runtime identity, source freshness, and host mutation safety
   authoritative.
5. Make the existing Reasoner verifier authoritative for Redirect semantics.
6. Require every user-visible warning or failure to explain why it occurred.
7. Prove the behavior through captured provider fixtures, fault injection,
   Playwright observation, and a real SillyTavern provider run.

## Non-Goals

- Accepting unsupported Redirect prose to improve apparent success rate.
- Adding an unbounded model repair loop.
- Adding a new model call to a healthy Redirect.
- Displaying raw prompts, model responses, hidden reasoning, stack traces,
  filesystem paths, secrets, or unbounded provider text.
- Treating cancellation or supersession as a failure.
- Preserving legacy event shapes during this pre-alpha contract replacement.

## Design Principles

### Separate protocol safety from semantic truth

Runtime code owns parsing, bounded shape, frozen identity, source freshness,
operation limits, and mutation safety. Models own narrative diagnosis,
replacement intent, character pressure, and evidence relevance. The production
Verifier judges whether the proposed Redirect and final candidate are supported.

Deterministic code may establish that a reference is or is not present in the
frozen registry. It must not treat citation placement as proof of narrative
truth. An unknown reference is recoverable bookkeeping unless no usable
diagnosis remains.

### Preserve the authoritative semantic boundary

Recovery may normalize transport and reference defects, but it must not invent
support, rewrite narrative claims, or convert a verifier rejection into success.
Every Redirect candidate still requires an accepting production Verifier before
host mutation.

### Explain terminal state at the source

The subsystem that settles a warning or failure must provide its normalized
reason. UI presenters must not reconstruct causes from labels, journal history,
or error codes.

## Unified Failure Descriptor

All runtime, provider, storage, prompt, cache, enhancement, and host-mutation
failures settle with one sanitized descriptor:

```js
{
  code: 'RECURSION_EDITORIAL_REDIRECT_EVIDENCE_INVALID',
  stage: 'editorial-diagnosis',
  category: 'model-output',
  message: 'Redirect diagnosis cited evidence that was not in the frozen packet.',
  retryable: true,
  attemptedRecovery: 'Removed 1 unknown reference and continued to verification.',
  suggestedAction: 'Retry Redirect or choose a provider with reliable structured output.'
}
```

Required fields are `code`, `stage`, `category`, and `message`. Optional fields
are omitted when they would not help the user. `message` is a single bounded
sentence. `attemptedRecovery` states what Recursion actually did, never what it
intended to do. `suggestedAction` is present only when the user can take a
meaningful action.

Canonical categories:

```js
export const FAILURE_CATEGORIES = Object.freeze([
  'provider-account',
  'provider-request',
  'provider-timeout',
  'provider-length',
  'provider-output',
  'model-output',
  'validation',
  'stale-state',
  'host-mutation',
  'prompt-install',
  'storage',
  'internal'
]);
```

`src/failures.mjs` will own construction, sanitization, known provider-error
mapping, and fallback handling. A fallback may say
`Unexpected internal failure (RECURSION_...).` It may not settle as only
`Failed`, `Action failed`, or `Needs attention`.

## Runtime-Owned Structured Envelopes

Model prompts continue to freeze identity for context, but provider normalization
replaces returned identity fields with request-owned values before semantic
validation:

```js
function normalizeEditorialDiagnosisEnvelope(data, request) {
  return {
    ...data,
    schema: EDITORIAL_DIAGNOSIS_SCHEMA,
    mode: request.mode,
    sourceHash: request.sourceHash,
    snapshotHash: request.snapshotHash,
    decision: request.mode === 'redirect' ? 'proceed' : data.decision
  };
}
```

The model cannot make a run stale by misspelling a hash it was asked to echo.
Runtime still performs source-freshness checks immediately before host mutation.
Repair and Recompose retain their mode-specific semantic fields.

Provider JSON Schema remains strict where the provider honors it. Runtime must
not assume that remote schema enforcement succeeded.

## Layered Provider Output Recovery

Structured output passes through these layers in order:

1. Strict JSON parse.
2. Bounded syntax repair for mechanical JSON defects only.
3. Machine-schema normalization and validation.
4. One provider correction call if the output remains unusable.
5. Role-specific semantic handling.

The syntax repair layer may repair quoting, commas, delimiters, and surrounding
fences. It may not add semantic fields, fabricate values, choose decisions, or
rewrite prose. It returns diagnostics describing whether repair occurred.

Recursion will use the pinned ISC-licensed browser ESM distribution from
`jsonrepair@3.15.0` for this layer rather than maintaining ad hoc
regular-expression repairs. Because the extension is served directly without a
bundler, the audited distribution and its license notice will be vendored under
`src/vendor/`. Production code imports that relative module; tests must prove
that the vendored artifact is the only tolerant parser used.

```js
{
  structuredOutputRecovery: 'local-json-repair',
  repairedSyntax: ['unquoted-object-key'],
  originalResponseHash,
  repairedResponseHash
}
```

If local repair cannot produce a bounded object, the existing single provider
correction call receives the rejected response, parser error, exact schema, and
frozen identity. It repairs that artifact rather than generating an unrelated
diagnosis from scratch.

## Redirect Evidence Reference Recovery

`validateRedirectBrief` will return normalized data plus path-specific reference
diagnostics instead of failing immediately on unknown IDs:

```js
{
  ok: true,
  value: normalizedBrief,
  diagnostics: [{
    code: 'RECURSION_EDITORIAL_REDIRECT_REFERENCE_DROPPED',
    path: 'characterPressure[2].wantEvidenceRefs[0]',
    reference: 'message:missing'
  }]
}
```

Normalization rules:

- Preserve every request-known reference unchanged.
- Remove unknown references from citation arrays.
- Never substitute a different evidence ID.
- Never rewrite the associated claim.
- Preserve empty optional citation arrays.
- Mark required evidence collections unresolved when all references are removed.
- Continue when the diagnosis still has a usable source failure, replacement
  objective, required beats, forbidden beats, scene characters, and pressure
  rows.
- Normalize a blank `characterPressure[N].sourcePressureEffect` to `unclear`
  with a path-specific structure diagnostic. This is an explicit unknown, not
  an inferred pressure direction; preserve the row's immediate want, citations,
  and pressure reason unchanged.

Unresolved semantic support is passed to the transformer and verifier as an
explicit diagnostic. The transformer receives the complete frozen evidence and
is instructed to treat the diagnosis as a proposal, not established truth.
The verifier judges `diagnosis-evidence-grounded`,
`replacement-objective-fulfilled`, `required-beats-satisfied`,
`character-pressure-coherent`, and the other existing Redirect checks.

If normalization leaves no usable replacement objective or no required beat,
diagnosis fails with an exact reason naming the missing usable field. This is a
structural failure, not a semantic evidence judgment.

## Bounded Redirect State Machine

Healthy Medium-or-higher Redirect remains:

```text
Diagnosis -> Reasoner writer 1 -> Reasoner verifier 1 -> host mutation
```

Recovery behavior:

```text
Diagnosis malformed
  -> local syntax repair
  -> one focused diagnosis correction only if still unusable

Diagnosis has unknown references
  -> normalize references
  -> writer 1
  -> verifier 1

Verifier rejects writer 1
  -> Reasoner writer 2 receives failed checks and verifier reason
  -> Reasoner verifier 2
  -> accept and mutate, or fail
```

Low retains Utility for diagnosis and final writing under its existing routing
policy. Medium and above use Reasoner for both writer attempts. There is no
Utility fallback after a Medium-or-higher Reasoner writer failure.

Call budgets:

| Condition | Additional calls over healthy path |
| --- | ---: |
| Locally repairable JSON | 0 |
| Unrepairable diagnosis JSON | 1 |
| Unknown evidence references | 0 |
| First candidate rejected by verifier | 2 |
| Provider account/request hard failure | 0 |

The second verifier is required because an unverified replacement cannot be
committed. Failure after writer attempt two preserves the original response.

## Terminal Versus Recoverable Conditions

Recoverable:

- malformed JSON that bounded repair can parse;
- one unrepairable structured response eligible for focused correction;
- unknown evidence references;
- a first Redirect candidate rejected by the verifier;
- a transient provider failure explicitly classified retryable within the
  existing bounded provider policy.

Terminal:

- authentication, insufficient funds, unsupported request parameters, or
  non-retryable provider rejection;
- provider timeout or length failure after its bounded retry policy;
- structurally unusable output after one correction;
- stale source, chat, message, or swipe identity;
- cancellation or supersession, which settles neutral rather than failed;
- verifier rejection after the second Reasoner writer;
- failed prompt installation;
- failed or unconfirmed SillyTavern swipe/replacement mutation;
- storage failure that prevents a required durable contract.

## Progress And UI Contract

`progressRun.steps[]` gains a required `reason` for `warning` and `failed` states:

```js
{
  id: 'editorial-diagnosis',
  label: 'Editorial diagnosis',
  state: 'failed',
  meta: 'failed',
  reason: 'Provider returned malformed JSON after one correction.',
  failureCode: 'RECURSION_JSON_PARSE_FAILED'
}
```

Presentation:

- Failed and warning row labels retain the existing red and amber state colors.
- The sanitized reason appears directly below the affected row label.
- The compact top status shows `Stage: reason`, clamped to one concise line.
- Tooltip and accessibility text include the same reason plus a safe suggested
  action when available.
- The Full Viewer and journal retain the normalized descriptor.
- A reason is never available only on hover.
- Normal successful, cached, waiting, and canceled rows do not gain explanatory
  sublines.

This amends the current UI rule that places warning and failure explanations
only in tooltip text. `DESIGN.md`, `docs/design/UI_SPEC.md`, production CSS, and
UI tests must be updated together.

## Journal Contract

Every warning/error terminal journal entry includes:

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

Provider call entries may additionally retain sanitized status, model, latency,
token usage, finish reason, and response hashes. They must not retain raw
provider output in the normal journal.

An extension-wide journal invariant rejects:

- warning/error entries without a failure descriptor;
- `provider.call.failed` without a normalized provider reason;
- terminal progress failures with no matching reason;
- unmatched provider-call starts after settlement.

## Implementation Boundaries

Expected production changes:

- Add `src/failures.mjs`.
- Update `src/providers.mjs` for local structured repair, focused correction,
  and normalized provider failures.
- Update `src/editorial-transform.mjs` for runtime-owned envelopes and
  recoverable Redirect reference diagnostics.
- Update `src/runtime.mjs` for bounded Redirect writer/verifier recovery and
  failure propagation.
- Update `src/progress.mjs` to require and aggregate reasons.
- Update `src/ui.mjs` and `styles/recursion.css` for visible reason sublines.
- Update provider, storage, prompt, cache, enhancement, and host adapters that
  currently emit generic terminal labels.
- Update `DESIGN.md`, `docs/design/UI_SPEC.md`, provider/runtime architecture,
  and diagnostics documentation.

No compatibility adapter will preserve old terminal activity shapes.

## Test Strategy

### Captured regressions

Add sanitized fixtures from the latest SG-1 failures:

- malformed Redirect diagnosis with the unquoted `role` key;
- parsed Redirect diagnosis containing an unknown evidence reference;
- corrected diagnosis that preserves valid claims while dropping only the
  unknown reference.

Assertions:

- local syntax repair recovers the malformed response without a model call;
- unknown references do not terminate before the verifier;
- diagnostics identify the exact invalid path and value;
- no unsupported candidate reaches host mutation without verifier acceptance.

### Fault-injection matrix

Cover each role and provider lane where applicable:

- HTTP authentication failure;
- insufficient funds;
- unsupported reasoning effort;
- timeout;
- token/context length;
- blank content;
- whitespace-only content;
- malformed JSON;
- schema-invalid JSON;
- stale frozen identity in model output;
- unknown evidence references;
- first verifier rejection;
- repeated verifier rejection;
- stale active swipe;
- prompt-install failure;
- append-swipe failure;
- replace-message failure;
- storage write/verification failure.

Each case asserts the retry count, terminal state, unchanged host content where
required, journal descriptor, progress reason, and suggested action policy.

### Global failure-reason oracle

One shared test helper consumes activity, progress, and journal records:

```js
assertEveryUnhealthyStateExplainsWhy({
  observedTransitions,
  progressRun,
  journalDelta
});
```

It fails when:

- any observed warning/caution/failed row has no non-generic reason;
- a row was replaced or removed after briefly lacking a reason;
- an error journal entry lacks `details.failure.message`;
- the UI renders only `failed`, `caution`, `warning`, `needs attention`, or
  `action failed`;
- a script reports success while an unhealthy observation remains.

### Playwright proof

The strict live oracle installs its `MutationObserver` before generation and
records every row transition, including replaced and removed nodes. A live
failure-negative-control run must prove:

- the failed row is red;
- its reason is visible without hover;
- compact status contains the concise reason;
- the journal contains the same code and message;
- the process exits nonzero.

A successful Redirect proof must show no warning, caution, or failed transition,
one new Recursion-owned swipe, accepted diagnosis/candidate/prompt-ready nodes,
and no unmatched provider calls.

### Real-provider certification

Use a dedicated `recursion-soak-*` account, never `default-user`, for automated
generation. Replay the SG-1-shaped Redirect scenario through the real
SillyTavern provider and host path. Inspect the rendered progress tree,
installed extension hash, run journal, selected swipe, and final prose.

Only after focused tests, `npm.cmd test`, Playwright proof, and real-provider
certification pass may the extension be copied to `default-user`.

## Acceptance Criteria

- The captured malformed Nemotron response recovers locally.
- Unknown Redirect evidence IDs no longer abort before semantic verification.
- Every Redirect candidate remains verifier-gated.
- Medium-and-higher Redirect uses at most two Reasoner writer attempts and never
  falls back to Utility.
- Healthy-path model-call count is unchanged.
- Every warning and failure across the extension has a visible sanitized reason.
- Every warning/error journal entry has a normalized failure descriptor.
- Generic terminal labels fail automated tests.
- Focused suites and `npm.cmd test` pass.
- Strict Playwright negative controls and success proof pass.
- A dedicated-account real-provider Redirect proof passes before deployment.
