# Recursion Enhancement Swipe Certification Design

**Date:** 2026-07-18  
**Status:** Approved for implementation planning

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
