# Segmented payload and transport recovery

## Observed evidence

The supplied `recursion-diagnostics-2026-09-25T20-28-16-203Z.json` records a running Segmented operation with four failed Utility families: Open Threads, Realism, Relationship, and Social Subtext. Each failed twice on the configured NanoGPT `z-ai/glm-5.2:thinking` profile. Errors were exported as `RECURSION_PROVIDER_TRANSIENT`; the export contains no original upstream status or cause, so it cannot establish the provider's exact rejection reason. The Reasoner profile was `z-ai/glm-5.3:thinking`; its successful calls demonstrate that the failures were not universal across both lanes.

Five schema-mismatch events across the two recorded runs have `evidenceRefs:array(2)` and `promptText:array(4)` or `promptText:array(5)`. Card payloads require a string, not a list. The missing schema label was incidental: these payload-only card roles do not require the model to echo a schema identifier. The export does not contain rejected text, so its semantic validity cannot be judged retrospectively.

Read-only inspection of SillyTavern's request path showed that its server can replace upstream details with HTTP status text; the browser wraps that text in the cause of `API request failed`. Recursion previously treated such an otherwise unrecognized wrapper as transient, including permanent causes such as `Bad Request`.

## Repairs

- Join nonempty string-only card text lists with newlines at the provider boundary, for both Segmented and Fused. Preserve every instruction and all evidence; retain normal semantic validation. Keep requesting the canonical string shape.
- Classify exact nested HTTP status phrases before generic wrapper fallback, retaining safe numeric status without retaining upstream prose or secrets.
- Allow three transient retries with 2/4/8 second backoff, separate from model-output correction attempts. Preserve operation-wide recovery charges, deadline, cancellation, and checkpoint reuse. Persist the explicit exhaustion diagnostic.

## Verification

- New regressions failed before their corresponding fixes.
- All 110 offline scripts passed, including full preparation, restored targeted Retry, provider normalization, mixed invalid arrays, unsafe content rejection, permanent error handling, recovery budget exhaustion, and Stop during backoff.
- All four Playwright-dependent test scripts passed.
- Independent diff review found a missing diagnostic allowlist entry; it was repaired and a persistence regression added.

This is deterministic and browser-fixture verification. No paid live-provider replay or change to the user's running SillyTavern host was performed. These repairs cannot guarantee availability of the configured provider.
