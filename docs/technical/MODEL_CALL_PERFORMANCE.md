# Model call performance

Independent requests share a bounded queue per Connection Profile. `maxConcurrentRequests` is a requested limit from one to three (default two). Effective concurrency remains one until an explicit Test Profile call verifies overlapping, individually identifiable responses for the exact configuration. Lanes sharing a profile use the lowest qualified limit. Changing generation settings invalidates qualification. HTTP 429 responses apply a profile cooldown using bounded Retry-After metadata.

A structurally valid Fused envelope survives malformed sibling items. The router rejects invalid shapes, duplicate families, and unrequested families; source/evidence validation still runs on every retained card. Partial success invokes segmented fallback only for unresolved families. A zero-useful-card correction includes the expected schema and bounded validation feedback. Explicit refusal and content-filter metadata are terminal and never trigger equivalent segmented requests. Narrative words such as “refused” do not classify a provider refusal.

The persisted operation recovery budget allows one correction plus one recovery dispatch per selected generated family. Reservations commit before calls start, share the scheduler mutation lock, and survive Resume. Initial Fused fallback requests consume recovery; so do retries and interrupted-stage redispatches. Explicit Retry and Reprocess create a named fresh window. Every selected generated family blocks on exhausted failure, retaining its original failure and targeted Retry. Accepted sibling work remains checkpointed. A final hand check also blocks missing planned source or authored coverage before Guidance and installation.

Default deadlines are 180 seconds per dispatched request and 300 seconds of operation active time. Advanced controls bound these to 30–600 and 60–1800 seconds. The operation timer includes queueing and persistence; pauses stop its clock. A timed-out transport still holds its queue slot until the underlying request settles. Cancellation ownership prevents late artifact commits.

The run manifest stores requested/effective pipeline, selected lane, hashed profile identity, configuration hash, qualification state, and fallback reason. The selected toolbar mode is a preference; the persisted decision records what actually ran.

The planner prompt serializes the selected catalog once. Scope selection, eligibility, sub-items, priorities, and authored instructions remain intact. A local planner or authored-only composer bypass was deliberately not enabled: Manual mode still needs story-form inference and scene selection, and authored text can require coverage/conflict reconciliation. Removing those model calls needs a narrower product contract and quality evidence; an unconditional bypass would change behavior.

Provider diagnostics preserve queue wait, host preparation, transport and normalization durations, and provider-reported input/output/reasoning usage when the host supplies it. Stage records measure validation and artifact persistence separately. Turn timing binds to a unique attempt and operation, measures preparation through prompt readiness, and uses nonempty native primary stream events for the first visible token. Completion is never substituted for a missing stream event. Source changes, Stop, and stale attempts invalidate further timing commits.

`tools/scripts/benchmark-preprocess-latency.mjs --live` uses a dedicated `recursion-soak-*` account. It serves checkout files only inside its isolated browser so installed host files are not modified. Live result files belong under `artifacts/latency-benchmark`; qualification and failed runs must be reported alongside successful samples.

## Verification and remaining live proof (2026-09-21)

The alpha integration gate passed 78 offline scripts, documentation contracts, and Playwright readiness. Independent review found and resolved reload deadline accounting, required recovery starvation, and optional-only refusal blocking. Desktop 1440px and mobile 390px settings checks showed visible controls, no horizontal panel overflow, and no browser errors. Screenshots and measurements are in `artifacts/latency-benchmark`.

A catalog-based scope fixture shrank from 15,355 to 163 UTF-8 bytes after removing two duplicate catalog arrays; the catalog remains supplied once separately. This is a prompt-fragment measurement, not an end-to-end latency result.

The initial dedicated-account qualification failed with provider `Unauthorized`. After explicit user authorization to provision its credential, the live comparison completed. See [measured results and limitations](MODEL_CALL_BENCHMARK.md): Utility reasoning off with qualified concurrency two reduced median preparation from 105.5 to 26.2 seconds on the six-family workload. All six reasoning-off samples passed coverage and reported zero Utility reasoning tokens.

Preprocessing alone owns the new operation budget/deadline; postprocessing behavior is unchanged. Optional paid recovery waits for required card work before reserving its allowance. Reload settles active time at the last persisted checkpoint and excludes offline time. Explicit Retry starts a fresh recovery window by design; Resume preserves spending.

Utility explicitly requests reasoning off; Reasoner preserves its role intent. Provider-aware minimum fallback is diagnostic when a model cannot disable reasoning. Both Segmented and Fused corrections include validation feedback. See [provider routing](MODEL_CALLS_AND_PROVIDER_ROUTING.md).
