# Redirect Hard Contract And Recovery Design

## Status

Approved for implementation on 2026-07-15.

This document amends `2026-07-15-recursion-redirect-improvement-design.md`.
Where they conflict, this document controls Redirect diagnosis decisions and
provider token-limit recovery. Repair and Recompose remain unchanged.

## Problem

Redirect is an explicit, expensive request for a materially different,
evidence-supported trajectory. Returning `no-change` after a successful model
call violates that user contract and prevents transformation, verification, and
host swipe creation.

Editorial diagnosis can also stop at the provider output limit. The current
provider router treats `RECURSION_PROVIDER_TOKEN_LIMIT` as non-retryable, records
too little sanitized evidence to explain the failure, and never spends the one
structured recovery token already owned by the Editorial operation.

## Decision Contract

For `mode: "redirect"`, `decision: "proceed"` is the only valid diagnosis
decision. A valid Redirect diagnosis must contain:

- non-null `sourceFailure` and `replacementObjective`;
- non-empty `requiredBeats` and `forbiddenSourceBeats`;
- complete evidence-backed `sceneCharacters` and `characterPressure`.

The machine schema must constrain Redirect decisions to `proceed`. Runtime
semantic validation must reject a provider-authored `no-change` response with
`RECURSION_EDITORIAL_DIAGNOSIS_DECISION_INVALID`. That semantic rejection may
spend the Editorial operation's single correction token. If the corrected
diagnosis still cannot produce `proceed`, Redirect fails visibly and preserves
the original response. It never reports success or skipped.

Repair and Recompose retain their existing `no-change` behavior.

## Token-Limit Recovery

Editorial diagnosis requests use low reasoning intent from their first attempt so
structured output retains the configured response budget. `RECURSION_PROVIDER_TOKEN_LIMIT` is eligible for one structured recovery only
for machine-JSON calls and only while `allowStructuredRecovery` is true. The
retry uses the same frozen source, snapshot, lane, provider configuration, and
provider max-token ceiling. It must not silently switch models.

The retry prompt must:

- identify the previous token-limit failure;
- require one complete compact JSON object with no prose;
- request concise claims and evidence references;
- preserve all schema and frozen identity constraints;
- request low reasoning effort through existing request metadata where the host
  supports it.

For SillyTavern Connection Manager profiles, the host adapter must also map that
normalized intent to `reasoning_effort` and set `include_reasoning: false`.
Passing only Recursion's nested reasoning metadata is insufficient because the
OpenRouter backend does not consume that private shape; a `:thinking` model would
otherwise use its default extended reasoning and exhaust the configured output
ceiling before completing the diagnosis JSON.

The retry remains bounded to the provider router's existing two-attempt loop.
If it also reaches the token limit, the call fails with
`RECURSION_PROVIDER_TOKEN_LIMIT`; runtime reports a red Editorial failure and
does not add or replace a swipe.

## Diagnostics

Sanitized provider failure diagnostics must retain, when available:

- provider source and model;
- effective requested max tokens;
- finish reason;
- total, completion, and reasoning token counts;
- visible response character count;
- retry count and recovery kind.

No raw prompt, provider response, hidden reasoning, credentials, or private
Redirect diagnosis content may enter the journal or UI.

## Tests

Deterministic tests must prove:

1. Redirect machine schema exposes only `proceed`.
2. Redirect semantic validation rejects `no-change`.
3. A first `no-change` diagnosis receives one correction and can proceed to one
   verified Recursion-owned swipe.
4. Two invalid Redirect diagnoses fail red and preserve host swipe state.
5. A token-limit machine-JSON response receives one compact retry.
6. A successful retry carries the same frozen identity and returns normally.
7. Two token-limit responses fail with no third call.
8. Failed-call diagnostics retain sanitized model, limit, finish reason, usage,
   visible size, and recovery metadata.
9. Repair and Recompose `no-change` behavior remains unchanged.

The live Redirect proof must use the exact turn-deferral failure class seen in
SG-1, require `proceed`, require exactly one verified swipe, and fail on every
skipped, caution, warning, or failed observation through the shared live
Enhancement oracle.
