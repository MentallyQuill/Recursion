# Schemas

Guidance omission lists contain bounded `{ id: string, reason: 'duplicate' | 'lower-priority' | 'unsupported' | 'unsafe' }` records, including in Last Brief and diagnostics. They are not string-ID lists. Hand-selection omissions retain their own contract. Provider journals may include `stageAttempt` (1–5) and `semanticNormalization: 'guidance-request-envelope'`; neither field contains provider prose. Turn timing includes a nullable host request-ready milestone and derived phase durations; see [Storage and Diagnostics](../docs/architecture/STORAGE_AND_DIAGNOSTICS.md).

Performance execution fields: `pipelineRun.v2` includes nullable `pipelineDecision` and `recoveryBudget`. The decision contains `{requestedMode,effectiveMode,selectedLane,profileIdHash,configHash,certificationState,reasonCode}`. Recovery contains `{windowId,recoveryLimit,recoveryUsed,reservationIds,elapsedActiveMs,activeSince,deadlineMs}`; reservations are durable before dispatch and Resume never resets them. Stage records carry optional `{validationMs,artifactPersistenceMs}` timings. Settings include `requestDeadlineSeconds` (180, range 30–600) and `operationDeadlineSeconds` (300, range 60–1800). Fused router diagnostics include bounded `bundleItemRejections` while retaining only item-valid siblings. Explicit refusal/content-filter codes are non-retryable.

Standalone schema files are not required for the current pre-alpha runtime.

Fused card stage version 2 includes full source instructions in provider-visible prompts and records `rejections: [{family, code}]` in its artifact and summary. `src/fused-recovery.mjs` validates request-owned catalog families and allowlisted codes: `missing-family`, `duplicate-family`, `invalid-item-shape`, `instruction-shape`, `hidden-content`, `private-claim`, `evidence-message-missing`, and `invalid-card`. Records are unique by family and bounded to 40. Diagnostics expose `stages[].fused = {acceptedFamilies, unresolvedFamilies, rejections, fallback}`; `fallback` is `segmented` or null. Rejections describe the original bundle, while repair-stage state determines final recovery. Raw provider prose and arbitrary extra fields are excluded. The stage version invalidates old Fused checkpoints.

Recursion V1 keeps its structured contracts close to the source modules that validate them:

- settings and provider preferences in `src/settings.mjs`;
- scene cache and run journal payloads in `src/storage.mjs`;
- card catalog and card lifecycle payloads in `src/cards.mjs`;
- card-scope family and sub-item payloads in `src/card-scope.mjs`;
- progress-row and Hero Pixel Array view models in `src/progress.mjs`;
- prompt packet contracts in `src/prompt.mjs`;
- provider response parsing and diagnostics in `src/providers.mjs`;
- Pre-process Guidance in `src/providers.mjs` and `src/prompt.mjs`: the native schema requires `schema`, `snapshotHash`, nonempty string `guidanceText`, `sourceCardIds`, `guardrailCardIds`, `omittedCardIds`, and `diagnostics`. Prompt-based outputs may omit bookkeeping identifiers; these are locally bound only when Guidance text exists and no supplied identity conflicts. Invalid content still fails stage validation, and exhausted Guidance blocks installation.
- Post-process model output in `src/post-process-guidance.mjs`: exactly
  `{ "guidanceText": "Nonempty revision guidance, at most 6000 characters." }`.
  The normalized internal `recursion.postProcessGuidance.v1` envelope adds
  locally bound `schema`, `snapshotHash`, and `sourceHash`; these fields are
  never requested from the model.

Use this folder only if those contracts are later extracted into shared standalone schemas.

Provider settings include `maxConcurrentRequests` (1–3, requested default 2).
Certification includes `checks.concurrency` and the actually qualified
`safeConcurrency`; unqualified configurations execute one request at a time.
Lanes sharing a Connection Profile share a queue and use the lower qualified
limit. Configuration hashes include the requested concurrency.

Provider diagnostics retain successful usage and numeric `timings`: queue entry
and dispatch times, queue wait, host preparation, transport, and normalization.
Transport start/end monotonic timestamps support qualification overlap checks;
they are meaningful only inside the current browser session. The existing
wall-clock `latencyMs` includes queue wait and must not be summed for overlapping
requests. No request text or private reasoning is included in these timings.

Auto Arbiter cardJobs order is semantically significant (highest marginal relevance first). Runtime-owned plan.selection records proposed/retained/omitted family decisions, mandatory card IDs/families and discretionary capacity. hand.metadata.selection adds actual selected IDs, origins, mandatory status and hand omissions. These fields are projected into compact diagnostics and the hand.selected journal; they are not model-authored schema authority or prompt evidence. Successful plans carry arbiter-model-plan. Selection prompt contract and preprocess graph version 2 invalidate old durable selections.
