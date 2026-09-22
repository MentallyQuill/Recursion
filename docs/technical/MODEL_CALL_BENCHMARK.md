# Model call latency benchmark — 2026-09-21

Utility reasoning off plus qualified two-way concurrency reduced median prompt preparation from 105.5 to 26.2 seconds (75.2%) and median total reply time from 112.3 to 29.8 seconds (73.5%) on this workload. Reasoning-off Fused was comparable, not faster: 27.2 seconds preparation and 32.7 seconds total.

## Method

Three attempted samples per arm on the dedicated recursion-soak-ui account, identical synthetic user text in fresh empty chats, six selected families, Medium routing with all preprocessing calls on Utility, postprocessing disabled. Utility and primary generation used NanoGPT deepseek/deepseek-v4-flash:thinking; Utility retained a 16000-token ceiling. Primary generation remained streaming and its reasoning policy was unchanged. Calls used real model responses through the running SillyTavern host, with this worktree's extension served only in an isolated browser. Installed extension files and the default account's settings/chat data were not changed. User explicitly authorized provisioning the dedicated account with the existing NanoGPT credential.

Each configuration passed real profile/schema qualification; concurrency two additionally passed the overlapping-response probe. Effective mode was asserted from the durable manifest, not inferred from toolbar selection. Timers distinguish prompt readiness, the first actual nonempty primary stream event, and host completion. Each sample had an assistant reply. Acceptance additionally required all six requested families and the expected completed card stage.

## Results

Times are medians in seconds across every attempted sample, including the failed coverage sample. Calls and recoveries list each sample in order; primary generation is excluded from call counts.

| Utility reasoning | Mode | Concurrency | Coverage accepted | Prepare | First visible token | Full reply | Model calls | Recovery calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Enabled | segmented | 1 | 3/3 | 105.5 | 111.3 | 112.3 | 8, 9, 8 | 0, 1, 0 |
| Enabled | segmented | 2 | 2/3 | 87.6 | 91.6 | 93.3 | 9, 8, 9 | 1, 0, 1 |
| Enabled | fused | 2 | 3/3 | 72.8 | 80.1 | 81.6 | 3, 5, 3 | 0, 2, 0 |
| Off | segmented | 2 | 3/3 | 26.1 | 28.8 | 29.8 | 8, 8, 9 | 0, 0, 1 |
| Off | fused | 2 | 3/3 | 27.2 | 31.5 | 32.7 | 3, 4, 4 | 0, 1, 1 |

The reasoning-enabled parallel sample with 5/6 families is retained as a failed acceptance, not counted as a quality-preserving speedup: Character Motivation failed the existing hidden-reasoning-wording validator twice and was omitted. Segmented corrections were then improved to include bounded validation feedback, so the reasoning-off cohort also contains that recovery improvement. The thinking-enabled Fused cohort includes this targeted correction change, but unchanged reasoning controls. This is not a perfectly isolated randomized reasoning-only experiment.

Across the three serial samples, Utility reported 16541 reasoning tokens out of 20324 output tokens. All 36 Utility calls across the six reasoning-off samples reported zero reasoning tokens. All six passed full-family coverage; one segmented run and two Fused runs needed one targeted recovery apiece. Fused preserved its valid siblings and regenerated only one unresolved family in each of those cases. Explicit refusals were checked offline; no deliberate live refusal workload was sent.

The longest card queue wait was 59.3 seconds in the serial cohort, 28.6 seconds in the thinking-enabled parallel cohort, and 9.9 seconds in the reasoning-off parallel cohort. Validation maxima were under 6 ms and individual artifact-persistence maxima under 45 ms: these local operations are not the dominant cost. Thinking-enabled Fused still ranged from 49.7 to 112.1 seconds of preparation because the planner and recovery remain serial dependencies.

## Quality and limits

Every accepted card retained a valid source reference. Review of all reasoning-off card prompts found the core locked-door, key, chart, rain, lantern-time and telescope objective preserved. Both the baseline and optimized outputs sometimes extrapolated posture or minor scene details: for example, baseline described Ivo as having agreed to keep watch; one optimized card called Mara's key the only key. Structural/evidence-reference acceptance is not proof that every generated implication is entailed by source text. This small synthetic cohort does not establish broad writing-quality equivalence or production p95 latency.

Arms were grouped, not interleaved. Provider load, cache behavior and stochastic wording can affect timings. An initial primary-setup failure completed preprocessing in 107.3 seconds but generated no assistant reply; it is retained separately and excluded from successful latency comparisons. The harness now explicitly selects and verifies the native primary model. No 429, deadline or explicit provider refusal occurred in the comparative samples.

## Disposition of review findings

1. Requested/effective Fused mode and exact Utility qualification are persisted; successful live Fused stage execution was verified.
2. Qualified bounded concurrency works; queue ownership, cancellation and rate-limit behavior retain offline coverage.
3. Partial Fused recovery preserves valid siblings; live reasoning-off samples exercised one-family fallback twice.
4. Segmented and Fused validation retries now receive feedback. Explicit refusal/filter outcomes are terminal, optional work can be omitted, required work remains blocking, and shared recovery/deadline budgets prevent expansion without bounds.
5. Duplicate planner catalogs are removed (catalog scope fixture 15355 to 163 bytes, with catalog still supplied once separately). Local planning/raw-guidance bypasses remain disabled: current Manual selection still has story-form inference and scene decisions, and authored guidance needs coverage/conflict reconciliation. These paths require a narrower product contract, not a latency-only shortcut.
6. Queue, provider, usage, validation, persistence, recovery counts and end-to-end boundaries are available. Keep 180-second dispatched-request and 300-second active-preprocessing limits: all comparative samples fit, but this cohort does not justify tighter universal limits. Keep the token ceiling: enabled calls peaked at 2860 output tokens and disabled calls at 579, so reducing the ceiling is not the demonstrated speedup. Utility now requests reasoning off; provider-aware minimum fallback reports a downgrade where off is unsupported. Reasoner retains its own policy. Same-turn reuse and provenance remain intact; no cross-turn cache added.

Recommended configuration: Utility reasoning off and two concurrent requests after Test Profile qualification. Keep the user's selected pipeline preference; these samples do not establish a reason to force Fused as a universal default. The exact default-user profile still needs qualification after installation because its configuration differs from this test profile.

## Evidence and verification

Raw results: artifacts/latency-benchmark/results.json and artifacts/latency-benchmark-reasoning-off/results.json. Aggregates: artifacts/latency-benchmark-summary.json. Initial failed-attempt evidence: artifacts/latency-benchmark/initial-primary-setup-failure-details.json. Desktop/mobile screenshots and overflow checks: artifacts/latency-benchmark. Run the current optimized policy with node tools/scripts/benchmark-preprocess-latency.mjs --live --reasoning-off using the dedicated-account environment variables; --resume retains existing attempted samples.

Final alpha gate: 79 offline scripts, documentation contract and Playwright readiness passed. Independent review and targeted followups resolved recovery ordering, reload clock, optional refusal and provider-aware reasoning mappings. Work is committed on perf/model-call-latency; deployment and shared-branch integration are separate from this measurement.
