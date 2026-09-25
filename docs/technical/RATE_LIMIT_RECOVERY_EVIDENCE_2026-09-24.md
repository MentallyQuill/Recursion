# Provider rate-limit recovery evidence

## Observed failure

The supplied September 24 diagnostic recorded a successful Arbiter followed by two rate-limited Fused requests and eight rate-limited Segmented fallback requests on the same Utility connection. One Fused retry plus eight repair reservations exhausted the 9-call recovery allowance after 211,955 ms of a 300,000 ms deadline. No card validation rejection was recorded. Fallback and progress defaults nevertheless reported `invalid-card`.

The relevant source files matched the installed extension during diagnosis. Read-only reproductions established the false Fused fallback, misleading progress message, and exhausted shared repair allowance before changes.

## Contract and regression evidence

- `test-pipeline-fused.mjs`: exhausted provider errors remain failures; malformed model output still permits targeted or full Segmented repair.
- `test-execution-attempt-policy.mjs`: repeated capacity failures recover automatically with increasing waits and preserve the subsequent model correction attempt.
- `test-profile-request-queue.mjs` and `test-providers.mjs`: shared profile cooldown, independent connections, queued cancellation, success reset, and provider cooldowns longer than one minute.
- `test-execution-scheduler.mjs`: separate recovery accounting, bounded sustained failure, deadline cancellation, completed checkpoint reuse, repeated Stop/reload, pending siblings inheriting cooldown, and explicit Retry preserving the provider's retry-not-before time.
- `test-runtime-preprocess.mjs`: the real preparation pipeline recovers from two simulated Fused rate limits, delivers all eight planned families, and installs one complete packet without Segmented calls.
- `test-fused-progress.mjs` and `test-diagnostics.mjs`: actual provider cause survives progress projection and diagnostic export, without provider response prose or invented validation reasons.
- `prove-rate-limit-ui.mjs`: isolated Chromium fixture renders production UI/CSS in failed and retrying states. Screenshots are written to `artifacts/rate-limit-ui`.

Validation completed with all 106 offline test scripts, Playwright readiness, and the dedicated rendered UI proof passing. Independent review found interruption/reload gaps; their repeated-Stop, sibling-cooldown, and explicit-Retry regressions now pass.

## Scope

Tests use controlled provider results and do not establish upstream service availability or a live model failure rate. The running SillyTavern installation and user data were not changed. Persisted cooldown restoration covers the same operation after a browser restart; unrelated new operations do not inherit its saved failure state. Live profile queues coordinate all calls sharing a connection during the current session.

## Follow-up: saved operation replay

The default-user Story chat continued to replay its original operation after the rate-limit fix was installed. Its Fused fallback was checkpointed as completed under preprocess graph contract 7, while the shared recovery allowance remained exhausted. Installing new retry code alone did not invalidate those saved artifacts.

Preprocess graph contract 8 invalidates those checkpoints. The normal generation entry point also compares execution provenance before restoring saved artifacts or returning a completed packet, so Send can rebuild obsolete work even before startup restoration runs. The same-turn source identity remains bound to the saved source band; current-contract same-turn reuse still passes its existing tests.

Regression coverage exercises paused and completed obsolete operations with an exhausted allowance, both with and without explicit reload restoration. Each rebuilds successfully with fresh planning and a new allowance, without an extra manual retry. All 106 offline scripts passed, including from a clean archive of the committed tree, and independent review found no actionable issues. Reopening the actual default-user Story branch with the updated runtime persisted `state: stale`, `pauseReason: provenance-changed`, and `staleChangedFields: [promptVersions]` for the old operation.

## Approved live Story verification

With explicit approval to send Story context to the configured NanoGPT providers, a new message was sent through the normal SillyTavern interface on September 24 (September 25 UTC). The installed runtime was commit `89e2478f`.

- A fresh operation replaced the obsolete checkpoint. Utility planning and Fused generation ran successfully.
- Seven Fused cards passed validation. Realism was rejected with `hidden-content`, and one targeted Segmented request repaired it automatically. Recovery usage was 1 of 9; no provider rate limit occurred in this run.
- All eight planned cards reached the hand, with no shortfall. Prompt installation completed and permitted native narration.
- NanoGPT `z-ai/glm-5.3:thinking` produced a complete visible Story reply. Preparation took 46.3 seconds and the full turn took 70.5 seconds according to the persisted timing journal. The interface returned to Ready and removed Stop generation.
- One user message and one assistant response were added. Prior message text remained unchanged. No manual retry or provider configuration change was needed.

This verifies the reported chat's normal send path and automatic targeted repair with live providers. Rate-limit backoff remains covered by deterministic tests; this successful live run did not encounter an upstream rate limit.
