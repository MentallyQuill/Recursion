# Fused Empty Card Plan Fix Design

**Status:** Approved design; written specification review pending

**Date:** 2026-07-30

**Feature owner:** Recursion

## Problem

The resumable Fused Pre-process graph currently assumes that every validated
Arbiter plan contains at least one card job. That assumption is not enforced.

In the live `default-user` Writer chat, the Utility Arbiter completed with this
contradictory plan:

```json
{
  "action": "refresh-cards",
  "cardJobs": []
}
```

The durable runtime then scheduled `preprocess.cards.fused`.
`buildFusedCardBundleRequest(...)` correctly returned `null` because there were
no requested cards. `generateBundle(...)` treated that absent request as a
provider failure and paused the operation with
`RECURSION_FUSED_PROVIDER_UNAVAILABLE`.

The Utility provider was available and had just completed the Arbiter call.
The visible error therefore described the wrong component and gave the
operator no useful recovery direction.

## Goals

- Reject a `refresh-cards` Arbiter plan that contains no executable card jobs.
- Use the existing bounded Arbiter correction attempt for that semantic error.
- Allow legitimate zero-card plans to continue without scheduling a Fused or
  Segmented card provider stage.
- Preserve the existing local deck, hand, guidance, packet, and installation
  behavior for zero-card plans.
- Prevent an absent card request from being reported as provider
  unavailability.
- Lock both behaviors with durable Pre-process regression tests.

## Non-Goals

- Changing provider settings, provider health rules, or connection profiles.
- Making Writer-card-specific changes.
- Synthesizing model-owned card jobs in deterministic runtime code.
- Changing Fused bundle validation when one or more card jobs exist.
- Changing the existing attempt-window policy.
- Adding compatibility behavior for older pipeline artifacts.

## Design

### 1. Enforce the Arbiter action invariant

After the durable Arbiter result has passed schema normalization, runtime scope
filtering, and card-budget selection, validation must reject the plan when:

```text
action == "refresh-cards" AND executable cardJobs is empty
```

The validation result is retryable and uses a specific semantic error code,
`RECURSION_ARBITER_EMPTY_REFRESH`. The message explains that `refresh-cards`
requires at least one executable card job.

This boundary is intentionally after scope and budget enforcement. A provider
may return card jobs that are structurally valid but all become ineligible
under the current runtime scope. Such a plan is still not executable as
`refresh-cards` and should receive the same correction opportunity.

The existing durable Arbiter correction request will append the validation
message and request one corrected `recursion.utilityArbiter.v1` object. The
model remains the semantic planning authority: it may return at least one
eligible card job or change to a legitimate action such as `compose-brief`.

### 2. Elide card stages for legitimate zero-card plans

`durableCardStageSet(...)` must return an empty stage set when the normalized,
validated plan has no card jobs, regardless of whether the configured pipeline
is Fused or Segmented.

The returned contract is:

```js
{
  stages: [],
  resultStageIds: [],
  segmentedFallback: false
}
```

The downstream durable deck stage already supports an empty
`cardStageIds` collection. It can reuse current cache cards or produce the
existing safe local fallback cards before hand selection and guidance
composition. No provider-card stage is needed.

This guard covers valid `compose-brief`, `reuse-cache`, or other normalized
zero-card plans and prevents future callers from passing a null card request
into provider execution.

### 3. Keep provider-unavailable errors truthful

`RECURSION_FUSED_PROVIDER_UNAVAILABLE` remains reserved for a missing or
invalid generation router at the provider boundary. A missing request is not a
provider outage.

With the two earlier guards, `generateBundle(...)` should only receive a
non-null request. Its defensive failure handling may continue to reject a
missing request, but the normal durable graph cannot create that state.

## Data Flow

For a contradictory Arbiter response:

```text
Utility Arbiter response
  -> normalize and apply scope/budget
  -> detect refresh-cards plus zero jobs
  -> reject with RECURSION_ARBITER_EMPTY_REFRESH
  -> existing correction attempt
  -> validate corrected plan
  -> build the appropriate card graph
```

For a legitimate zero-card response:

```text
Utility Arbiter response
  -> normalize and validate
  -> durableCardStageSet returns no card stages
  -> deck
  -> hand
  -> guidance
  -> packet
  -> prompt installation
```

## Failure And Recovery Behavior

- A contradictory first Arbiter response consumes one Arbiter attempt and
  receives the existing correction prompt.
- A valid corrected response continues the same operation without rerunning
  the snapshot stage.
- Repeated contradictory responses exhaust the configured Arbiter attempt
  window and pause on the Arbiter stage with the specific semantic error.
- A legitimate zero-card plan does not consume a Fused or Segmented card-model
  attempt.
- Existing Stop, Retry, checkpoint, and provenance behavior remains unchanged.

## Verification

Add focused durable Pre-process regressions proving:

1. Fused mode rejects `refresh-cards` plus zero jobs, sends a correction
   request, accepts a corrected card plan, and completes without emitting
   `RECURSION_FUSED_PROVIDER_UNAVAILABLE`.
2. Fused mode accepts a legitimate `compose-brief` plus zero jobs, makes no
   `fusedCardBundle` call, records no `preprocess.cards.fused` stage, and
   completes the downstream operation.
3. Segmented mode accepts a legitimate zero-card plan without scheduling
   segmented card stages.

Run the focused durable Pre-process test first, then the repository test gates.
After the repository is green, sync the production extension surface to the
installed `default-user/extensions/Recursion-refactor` copy, verify file
parity, reload SillyTavern, and retry the paused Writer operation. Live proof
must show that the operation no longer reports provider unavailability; if the
Arbiter again returns a contradictory plan twice, the visible failure must be
the specific Arbiter semantic error instead.

