# Schemas

Standalone schema files are not required for the current pre-alpha runtime.

Recursion V1 keeps its structured contracts close to the source modules that validate them:

- settings and provider preferences in `src/settings.mjs`;
- scene cache and run journal payloads in `src/storage.mjs`;
- card catalog and card lifecycle payloads in `src/cards.mjs`;
- card-scope family and sub-item payloads in `src/card-scope.mjs`;
- progress-row and Hero Pixel Array view models in `src/progress.mjs`;
- prompt packet contracts in `src/prompt.mjs`;
- provider response parsing and diagnostics in `src/providers.mjs`.

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
