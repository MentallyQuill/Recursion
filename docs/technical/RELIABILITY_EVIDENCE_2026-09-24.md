# Reliability evidence and verification — 2026-09-24

## Observed problems

The supplied `recursion-diagnostics-2026-09-24T03-05-46-355Z.json` contains 50 journal entries. Four Guidance calls failed with `RECURSION_PROVIDER_SCHEMA_MISMATCH` and missing schema identifiers. The two failure sequences consumed approximately 35.1 and 15.3 seconds of provider-call time. One sequence installed a raw-card-only fallback. Two host-stop events had unknown causes but were reported as internal errors. The latest packet exported an omission ID as `[object Object]`.

The latest captured run succeeded with zero recovery calls: 22,941 ms preparation, 66,076 ms from start to first visible token, and 76,597 ms total reply time. Thus 43,135 ms elapsed between preparation and the first visible token. The export cannot identify how much of that interval was host assembly, network/provider work, hidden reasoning, other extensions, or stream delivery. No 429, context-limit, token-limit, or transient-network failure is established by this export.

## Implemented disposition

1. **Guidance:** retain the existing required-composition fix. Tests exercise the actual Recursion host adapter, Connection Manager boundary with controlled responses, provider client/router and semantic validator. Usable Guidance with missing request-owned identifiers succeeds in one call; conflicting identities, missing/empty/object content remain invalid. Correction prompts and durable failures preserve bounded known field types without response prose. Provider journals preserve local envelope normalization and scheduler `stageAttempt` separately from router `retryCount`. Existing runtime tests verify exhausted Guidance blocks installation/narration and Retry reuses successful upstream checkpoints.
2. **Omissions:** the exporter coerced omission objects to strings; Last Brief's string-list sanitizer discarded them. Both boundaries now preserve validated `{id, reason}` records, deduplicate IDs and reject invalid records. A regression follows composition through save/reload/export and keeps hand-selection omissions separate from Guidance omissions. Already-corrupted historical records cannot be reconstructed and are not migrated or guessed.
3. **Stops:** unknown host stops retain `host-stop-cause-unavailable`; Recursion-requested stops retain their origin; supplied structured failures survive. Warning severity alone no longer manufactures an internal failure for a host-stop event. Nothing here assumes the observed cancellations were bugs.
4. **Timing:** read-only inspection of installed SillyTavern found that `CHAT_COMPLETION_SETTINGS_READY` precedes fetch and contains generation `type`. Raw/background calls also emit it with `type: quiet`. Only explicitly typed primary requests after preparation can mark request readiness. Untyped `GENERATE_AFTER_DATA` was deliberately excluded after review because it cannot reliably distinguish nested work. New durations separate preparation-to-request-ready, request-ready-to-first-visible-token, and visible streaming. Missing/ambiguous boundaries stay unavailable; no historical cause or latency improvement is inferred.

No additional successful-path model call, model judge, provider fallback, retry allowance, concurrency policy, host installation change, or live-user-data mutation was introduced.

## Verification and limits

- Baseline: 83 offline scripts passed after installing lockfile dependencies in the isolated worktree.
- Regressions were observed failing before fixes for lost omission records, false internal stop failures, missing Guidance correction structure, missing journal normalization/attempt details, and missing timing milestones.
- Focused checks cover private-data canaries, identity conflicts, checkpoint reuse, bounded corrections, unknown/supplied stop causes, nested quiet/raw events, missing boundaries, invalidation, duplicates, empty streams and teardown.
- The full alpha gate passed with 86 offline scripts, documentation checks and Playwright readiness. Three browser-dependent scripts also passed against isolated fixture servers. The browser harness initially rejected the new helper missing from its served-module inventory; the fixture was corrected rather than weakening freshness validation.
- Independent review identified two timing-attribution defects in an initial design. The final implementation uses typed request-ready events only, with regression coverage for both cases; follow-up review found no remaining blocking defect.

Live provider behavior and exact historical rejected response bodies are not reproduced here. The installed extension was inspected read-only at `01a2d63f`; no installation or settings changes were made. Request-ready is a host observation, not confirmed network dispatch, and the host does not supply a request ID to distinguish overlapping primary invocations. Installation and a future representative live run can collect the new boundaries; this change does not claim the historical 43.1-second delay is fixed.
