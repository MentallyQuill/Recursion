# Recursion Structured Output Recovery Design

## Status

**Approved direction.** This is a follow-on to [Provider JSON Robustness Pass](../../planning/PROVIDER_JSON_ROBUSTNESS_PASS.md). That pass added ordinary syntax recovery and provider-envelope normalization. This design closes the remaining batch-slot retry gap and defines bounded partial-output and raw-text recovery.

## Decision

Recursion will recover structured output in a fixed, evidence-preserving order. It may repair syntax, isolate independently valid fragments, normalize a documented semantic alias, or ask the original provider once to correct a complete damaged response. It must never turn arbitrary prose into trusted Recursion state or fabricate a missing semantic contract.

```text
provider payload
  -> normalize visible text / classify empty, reasoning-only, or token-limit failure
  -> deterministic JSON candidate parsing and syntax repair
  -> role-schema and role-specific validation
  -> role semantic validation, including Generation Review patch and card-outcome validation
  -> accept valid result
     or recover valid independently validated Fused fragments
     or make exactly one slot-local correction, semantic correction, or raw-reformat request
  -> validate again
  -> retain valid siblings and omit only irrecoverable cards
```

The objective is not “make every model response succeed.” It is: a format-inconsistent model should not make unrelated card work fail, while a damaged response must never cross the same trust boundary as a valid `recursion.*.v1` result.

## Current gap

Recursion already strips fences and wrapper prose, removes common JSON syntax damage, and records a sanitized repair marker. A normal `generationRouter.generate(...)` call also retries one parse or schema error with an explicit correction prompt.

The Standard card path normally calls `generationRouter.batch(...)`. Valid sibling slots complete independently, but an invalid JSON/schema slot is finalized after the first batch response rather than receiving the correction retry used by `generate(...)`. That explains how several card passes can fail while others in the same run succeed.

Fused has a useful special case: after a failed bundle it retains a bounded raw response in memory and extracts complete members of a damaged `items` array. That capability remains limited to a bundle schema with independently meaningful siblings.

## Goals

- Give a failed Standard batch slot one structured-output recovery attempt without reissuing valid siblings.
- Give a Generation Review result one shared correction attempt when its bounded patch contract or installed-card outcome ledger is repairable but incomplete.
- Keep the deterministic parser as the first recovery layer.
- Recover complete Fused item fragments only after ordinary role, family, evidence, and snapshot validation.
- Permit one same-lane raw-text reformat request only when the original response is complete enough to reformat without filling a truncated tail.
- Report a stable, sanitized recovery reason in progress and the model-call journal.
- Keep raw provider text, hidden reasoning, and repair prompts out of persisted diagnostics, activity, cache, exports, and UI details.

## Non-goals

- No prose fallback for Arbiter, card, composer, or provider-test roles.
- No invention of `schema`, `snapshotHash`, role, family, evidence, card text, budgets, or composer fields.
- No multi-provider repair routing, provider racing, or visible retry button.
- No generic schema-specific JSON surgery; a new rule requires a demonstrated recurring response shape and a focused fixture.
- No model repair after token-limit, empty-response, reasoning-only, transport, cancellation, or stale-run failure.
- No second provider correction after either structural recovery or semantic recovery has spent the single recovery budget for that provider result.

## Recovery eligibility

| Failure after normalization | Deterministic parser | Fragment recovery | One follow-up request | Final behavior |
| --- | --- | --- | --- | --- |
| Fence, comments, smart quotes, trailing comma, literal newline | Yes | No | No | Validate normally. |
| Valid JSON with wrong/missing schema or role | Already parsed | Fused only, if independent items validate | One correction request | Retain valid siblings; omit the failed slot if correction fails. |
| Structurally complete but unparseable JSON | Yes | Fused only | One same-lane raw reformat request | Validate from scratch. |
| Truncated Fused `items` array | Yes | Complete items only | One correction request for missing siblings | Keep validated fragments; regenerate missing families. |
| Truncated Standard single-card response | Yes | No independent card exists | One correction request | Omit that card if correction fails. |
| Generation Review has valid schema but an aliasable outcome label | Already parsed | No | No | Normalize only a documented, unambiguous alias; journal the normalization. |
| Generation Review has valid patches but missing/unknown installed-card outcome coverage | Already parsed | No | One semantic correction request | Preserve only independently safe patches; report unresolved coverage exactly. |
| Generation Review has unsafe, stale, overlapping, or source-mismatched patches | Already parsed | No | One correction request only if the request has not spent recovery | Reject all patches if correction fails. |
| Token limit, empty content, reasoning-only, timeout, abort, stale run | No semantic repair | No | No | Existing fail-soft behavior. |

`snapshotHash` remains hard authority. A damaged Fused outer envelope may not cause a stale response to be upgraded simply because runtime knows the current hash. The implementation must require an explicit current snapshot association for every recovered item.

## One recovery budget, two validation layers

The router owns one external correction budget for an initial provider result. Parsing/schema validation and role semantic validation are deliberately separate trust layers, but they are **not** separate retry budgets.

```text
initial Generation Reviewer response
  -> parser/schema failure
       -> one raw-reformat or schema correction request
  -> parses and schemas correctly
       -> Generation Review semantic validation
            -> deterministic alias normalization, if applicable
            -> one semantic correction request, if still repairable
  -> no more provider correction for this response
```

A successful structural retry still goes through ordinary semantic validation. If that semantic validation fails, Recursion reports the exact semantic failure; it does not ask the provider a second time. Conversely, a semantic correction is sent only after the result is already structurally valid. This prevents a Fused or Generation Review run from silently spending two or more unaccounted provider calls.

The provider correction must stay on the original lane, source, model configuration, frozen source hash, review snapshot, and pipeline provenance. Reasoner-to-Utility fallback remains a routing failure policy, not a second structured-output recovery budget.

## Generation Review semantic recovery

`generationReviewer` uses the normal parser and router, then adds one role-owned semantic validator. It distinguishes unsafe patches from repairable ledger defects:

```js
// src/generation-review.mjs
const CARD_OUTCOME_ALIASES = new Map([
  ['not_applicable', 'not-applicable'],
  ['partially_reflected', 'partially-reflected'],
  ['requires_regeneration', 'requires-regeneration'],
  ['partially reflected', 'partially-reflected']
]);

export function normalizeCardOutcomeStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  return CARD_OUTCOME_ALIASES.get(raw) || raw;
}

export function classifyGenerationReviewFailure(validation) {
  if (validation.code === 'RECURSION_GENERATION_REVIEW_CARD_OUTCOME_INVALID'
    || validation.code === 'RECURSION_GENERATION_REVIEW_CARD_OUTCOME_MISSING') {
    return 'semantic_correction_retry';
  }
  return validation.retryable === true ? 'semantic_correction_retry' : 'none';
}
```

Only exact aliases above normalize locally. Missing installed-card outcomes, unknown outcome labels, duplicate card entries, or invalid outcome evidence may receive the one semantic correction request. Unknown card IDs, stale source hashes, unsafe target IDs, source-text mismatch, overlapping patches, and invalid replacement text remain hard validation failures. A semantic correction asks only for the affected outcome entries or invalid patch IDs and keeps already accepted source/target identifiers frozen.

When patches are independently safe but coverage remains unresolved after the one permitted correction, Recursion may apply the safe patches as `partial-failed`; the tree must show the unresolved card children as red and must never call the review successful. If a patch itself is unsafe, no part of that provider result is applied.

## Batch-slot recovery contract

The router owns retry policy, raw-text lifetime, and provider calls. `runStandardCardPipeline(...)` consumes ordinary per-slot results and does not parse raw text.

For a batch of `N` card requests:

1. Dispatch all `N` requests once.
2. Parse and validate every response independently.
3. Mark only a parse failure, object-required failure, or provider-schema mismatch as a structured-retry candidate.
4. Recheck run freshness, cancellation, and the slot signal.
5. Dispatch one correction request for each still-current candidate. It restates the exact role schema and frozen snapshot hash.
6. Validate each retry result exactly like an initial result.
7. Never reissue valid slots, and never retry more than once per slot.

Batch transport retry remains separate: it may reissue an entire batch only for transient transport failure. Structured recovery reissues only failed slots after an otherwise received batch.

```text
Initial batch:     Scene Frame ✓    Constraints ✗    Consequences ✗
Slot correction:                    Constraints ✓    Consequences ✗
Final card hand:   Scene Frame ✓    Constraints ✓    Consequences omitted
```

A recovered row remains amber, with compact text such as `retried after schema mismatch`. Raw output is never shown.

## Raw-text reformat contract

Saga provides two useful patterns: try deterministic candidates before another call, and make a repair request explicitly preserve usable material without inventing facts. Recursion borrows that discipline, not Saga’s permissive shape coercion.

Raw-text reformat is eligible only when all conditions hold:

- normalized visible text is non-empty and at most 12,000 characters;
- parser classification is `RECURSION_JSON_PARSE_FAILED`, not a token limit or semantic contract failure;
- a balanced object candidate is present, so the source is not an unfinished tail;
- current run/snapshot/signal guards pass;
- the slot has not already spent its one structured recovery attempt.

The reformat request uses the same role, lane, provider source, and model configuration as the failed request. It names the expected schema and snapshot hash, asks for one JSON object only, and says to preserve only information present in the malformed visible response. Its result re-enters the ordinary normalizer, parser, role-schema validator, and runtime/card semantic validators.

Raw text exists only in the in-flight failed result and repair request. It is capped before entering the repair prompt, discarded after the follow-up returns, and represented elsewhere only by response hash, visible length, recovery code, and stable failure code.

## Fused fragment recovery contract

Fused is the only current response shape with independently meaningful siblings in one shared envelope. A damaged `items` array may contain a complete `Scene Frame` object followed by an incomplete `Scene Constraints` object. The parser may extract the first fragment, but only ordinary card validation decides whether it is usable.

Each recovered item must:

- identify a requested family and its matching role;
- not duplicate another accepted family;
- pass evidence-range and card normalization rules;
- carry or inherit an explicit, verified current snapshot association;
- avoid hidden reasoning and unsupported prompt-facing fields.

Accepted fragments remain ordinary provider cards. Missing siblings use normal Standard repair requests; partial recovery reduces loss without creating a permissive parallel card format.

## Observability and privacy

```ts
type StructuredOutputRecovery =
  | 'none'
  | 'json_repaired'
  | 'slot_correction_retry'
  | 'raw_reformat_retry'
  | 'semantic_correction_retry'
  | 'fused_fragment_recovered';

type StructuredOutputDiagnostics = {
  structuredOutputRepaired: boolean;
  structuredOutputRecovery: StructuredOutputRecovery;
  visibleContentLength: number;
  retryCount: 0 | 1;
};
```

Journals, activity, cache, diagnostics export, and UI state may contain those compact values plus normal request/response hashes. They must never contain raw malformed output, repair prompts, hidden reasoning, prompt packet text, transcript text, secrets, cookies, bearer values, or provider session identifiers.

## Acceptance criteria

- A Standard batch with one wrong-schema slot sends exactly one correction request for that slot and accepts its valid retry without reissuing successful siblings.
- A slot cannot retry when stale, stopped, or aborted.
- A successful retry records `retryCount: 1` and a stable recovery code.
- A malformed Fused bundle recovers only complete, fully validated requested items and regenerates only missing siblings.
- An incomplete token-limited response never enters raw-text reformat.
- Reformat uses the same configured lane/source and a 12,000-character cap.
- Recovered output still fails when schema, role, family, snapshot, or evidence is wrong.
- A `generationReviewer` result with a recognized outcome alias normalizes without another call and records that normalization without raw output.
- A structurally valid Generation Review response with missing or invalid installed-card outcome coverage makes at most one semantic correction request; a prior parser/schema correction exhausts that request budget.
- A safe patch plus unresolved outcome coverage is rendered as `partial-failed` with red unresolved card children; unsafe patches are never applied.
- Tests prove raw markers do not enter returned diagnostics, journals, activity, cache, or exported diagnostics.
