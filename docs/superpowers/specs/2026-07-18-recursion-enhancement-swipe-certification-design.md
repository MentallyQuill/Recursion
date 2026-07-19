# Recursion Enhancement Swipe Certification Design

**Date:** 2026-07-18  
**Status:** Implemented and live-certified

## Problem

Recursion currently distinguishes provider-call completion from final Editorial
validation at runtime, but its ordinary deterministic and Playwright-readiness
gates do not prove that every enabled `As Swipe` Enhancement actually creates a
validated second assistant swipe.

The dedicated real-provider Enhancement proof is also Redirect-focused. It does
not certify Repair against providers that return parseable
`recursion.editorialPass.v1` JSON in the wrong mode-specific shape, such as a
full `candidate` where Repair requires bounded `patches`.

A provider call, parser result, or green intermediate progress row must never be
sufficient evidence of Enhancement success.

## Decision

The shared live-enhancement oracle owns one apply-mode-aware mutation contract.
Every live proof that claims an enabled Enhancement passed must supply the
before/after assistant-message state, selected apply mode, terminal runtime
result, and persisted Recursion marker to that oracle.

For `As Swipe`, a pass requires exactly one new validated Recursion-owned swipe.
For `Replace`, a pass requires one validated in-place replacement and no new
swipe. `Replace` remains a supported product mode.

## Certification Contract

### Enabled `As Swipe`

A run passes only when all of the following are true:

1. Enhancement was enabled with mode `repair`, `recompose`, or `redirect`.
2. The terminal runtime result is `ok: true`, is not skipped, and is not
   `partial-failed`.
3. The final Editorial status is healthy. Provider-call completion alone does
   not satisfy this requirement.
4. The assistant message's swipe count increased by exactly one.
5. The newly created swipe is selected.
6. No second Enhancement-owned swipe was appended.
7. The selected swipe carries a validated Recursion Editorial marker.
8. The marker binds the same chat, message, source hash, selected Enhancement
   mode, apply mode, and resulting candidate hash.
9. The selected assistant text hashes to the marker's candidate hash.
10. The shared progress/journal oracle observed no warning, failure,
    `partial-failed`, skipped Enhancement, unmatched provider start, or terminal
    Editorial error.

Any missing swipe, duplicate swipe, unselected new swipe, stale marker, marker
hash mismatch, or unhealthy terminal result fails the proof.

### Enabled `Replace`

A run passes only when:

- swipe count is unchanged;
- the active assistant text changed;
- the active message carries a validated Recursion Editorial replacement
  marker bound to the source and resulting text;
- the terminal result is healthy under the same progress and journal rules.

### Enhancement `Off`

When Enhancement is off, the oracle requires no Recursion-owned swipe or
replacement mutation. This is a control case, not an Enhancement-success case.

## Shared Oracle

`tools/scripts/lib/live-enhancement-run-oracle.mjs` remains the common
certification boundary. It will accept a normalized mutation observation with:

```js
{
  enhancement: {
    enabled: true,
    mode: 'repair',
    applyMode: 'as-swipe'
  },
  before: {
    messageId,
    swipeCount,
    swipeId,
    textHash
  },
  after: {
    messageId,
    swipeCount,
    swipeId,
    textHash,
    marker
  },
  enhancementResult,
  editorialResult,
  transitions,
  finalRows,
  journalDelta
}
```

The oracle derives mutation validity itself. Callers may no longer provide only
a trusted boolean such as `enhancementMutation.validated: true`.

The existing transition and journal checks remain authoritative. Mutation
success is an additional mandatory condition, not a substitute for semantic
health.

## Real-Provider Playwright Proof

`npm.cmd run prove:enhancements-live` will certify both:

- Redirect, retaining its current verifier and independent effectiveness judge;
- Repair, using a source response with deterministic eligible patch targets and
  an `As Swipe` configuration.

The Repair scenario must use the configured live provider and the production
Diagnostician and Transformer path. It passes only when the Transformer returns
valid bounded patches and the shared oracle observes exactly one validated
second swipe.

If the provider returns a full candidate, repeatedly omits required fields,
exhausts correction, or produces a terminal red Editorial result, the live
command exits nonzero even when every provider call returned parseable JSON.

The proof remains restricted to `recursion-soak-*` users. It must not mutate
`default-user`.

### Provider and Harness Hardening

Certification uses one pinned synthetic SillyTavern context with an own
synthetic `chat` array. The live provider/settings capabilities remain inherited
from the real context, while the runtime and oracle observe the same assistant
message identity. A context mismatch fails closed as
`live-source-context-drift`.

The oracle seeds existing progress-row signatures without recording them as
current-run transitions. Rows retained from an earlier scenario cannot make a
later scenario pass or fail.

Repair keeps bounded target identity authoritative:

- configured card IDs and target IDs always come from the frozen request;
- legal diagnosis decisions displaced into the schema slot are recovered;
- an adjacent repeated token in the frozen source is deterministic evidence
  that Repair may proceed even when the provider puts diagnosis prose or a
  brief object in `decision`;
- provider patch domains are replaced by the trusted domain of the known target
  ID;
- Repair requests carry complete frozen target metadata. A visibly displaced
  evidence list may be restored from `domain` only when every value is known
  frozen evidence and the opposite field contains only a legal domain token;
- Repair uses one candidate-free bounded-patch envelope, rejects empty patch
  lists, and reserves its single extra provider call for semantic correction;
- explicit no-op rows are omitted while at least one effective patch remains;
- empty or malformed known-ID patch rows may recover only to locally derived
  adjacent-repeat deletion patches carrying a machine-owned exact-proposal
  signal bound to the trusted target ID and before/after hashes;
- grammatical repetition is never rewritten from lexical equality alone;
- unknown, duplicate, overlapping, or review-only beat patch IDs still fail;
- when the provider's installed-card audit remains incomplete, Recursion may
  apply only that deterministic duplicate-removal subset, but dynamic card rows
  remain unresolved and the result remains `partial-failed`;
- Recursion then runs a dedicated Repair card audit through the Editorial
  Verifier. It receives the transformed candidate and exact request-derived
  installed card IDs. The provider returns only `failedCardIds`; Recursion
  validates those IDs against the dynamic frozen set and constructs the complete
  canonical ledger locally. An empty validated list accepts and clears the
  unresolved rows; a nonempty list rejects while retaining locally resolved
  rows, and malformed coverage remains `partial-failed`. Provider-authored
  `repairSignals` are stripped; only an exact displaced patch proposal can
  produce a locally derived target-and-hash-bound fallback signal.

The strict live oracle requires current-run progress transitions plus matched
completed calls for the Editorial Diagnostician and Transformer, and additionally
the Editorial Verifier for Redirect or a Repair card audit. Retained final DOM
rows cannot certify a new run. Unrelated Rapid warm-state calls are outside this
Editorial scope, and same-role calls from another Editorial run cannot satisfy
the proof: provider evidence must match the successful Enhancement result's exact
run ID. Current `prepareForGeneration()` evidence must also report `ok: true`; a
stale prompt-ready DOM row is insufficient, and prompt readiness must appear as
a current transition. A recovered retry with an explicit safe reason and
successful terminal provider settlement is recorded separately from unhealthy
warnings.

Redirect's independent judge treats `responseRequired: false` pressure as an
advisory coherence constraint, not a mandatory rendered beat.

## Deterministic Test Methodology

Focused oracle tests cover:

- exactly one valid selected swipe: pass;
- no appended swipe: fail;
- two appended swipes: fail;
- appended but unselected swipe: fail;
- missing marker: fail;
- marker bound to another source or message: fail;
- marker candidate hash not matching selected text: fail;
- `partial-failed` result with a safely appended swipe: fail certification;
- green provider stages followed by red Editorial settlement: fail;
- healthy `Replace` with unchanged swipe count and validated changed text: pass;
- `Replace` that appends a swipe: fail;
- Enhancement off with no mutation: control pass;
- Enhancement off with a Recursion mutation: fail.

Runtime tests retain mode-specific semantic validation:

- Repair rejects a full candidate and requires bounded patches;
- Recompose accepts only a complete candidate;
- Redirect retains its proposal and verifier contract;
- one correction request remains the maximum;
- no unsafe or stale mutation is committed.

Harness tests prove that every live Enhancement script installs and collects the
shared oracle and gates its final status on the oracle verdict.

Focused provider/validator tests also cover displaced Repair decisions,
malformed known-ID patch slots, generic `replace` domains, no-op omission,
empty-patch duplicate recovery, unknown-ID rejection, dynamic card-audit safe
subsets, stale progress baselines, and synthetic context drift.

## Progress Semantics

`provider.call.completed` means the provider call returned parseable role data.
It is not an accepted Editorial candidate.

A proof may show intermediate provider activity as completed, but its candidate
stage and overall result are successful only after mode-specific semantic
validation and the required host mutation complete. A later validation failure
must leave the terminal Editorial row red and fail certification.

## Non-Goals

- Removing or changing the `Replace` product mode.
- Treating `partial-failed` as certification success merely because it retained
  a safe paid-for swipe.
- Weakening Repair validation to accept full candidates.
- Requiring a new swipe when Enhancement is off.
- Running certification against `default-user`.

## Acceptance Criteria

- The shared oracle rejects enabled `As Swipe` runs unless swipe count increases
  by exactly one and the selected new swipe has a valid source-bound marker.
- The oracle validates mutation evidence itself instead of trusting a caller's
  boolean.
- `Replace` has a separate, equally strict in-place mutation contract.
- The real-provider Playwright command includes Repair and Redirect.
- A schema-parse success followed by Repair semantic failure exits nonzero.
- All deterministic negative controls fail for their intended reason.
- Repository, installed soak extension, and served public extension match before
  live certification.
