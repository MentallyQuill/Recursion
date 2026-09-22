# Recursion model-call latency design

Status: approved by the user on September 21, 2026. Implements the active latency goal and the findings in `artifacts/performance-review-2026-09-21.md`.

**Intent and scope**

Reduce the delay before a story reply without weakening authored-card authority, required constraints, source grounding, turn freshness, cancellation, or provider qualification. Cover the entire preprocessing path, including Fused fallback, and distinguish its duration from primary generation. The user explicitly requested proportionate testing: use focused checks for changed failure boundaries and actual timing comparisons, not an expanding unrelated test effort.

The review captured 102.5- and 197.4-second preprocessing runs. These are historical observations, not a controlled benchmark. The current checkout has an unrelated edit in `tools/scripts/test-runtime.mjs`; preserve it and implement in an isolated checkout once the design is approved.

**Chosen approach and alternatives**

Improve the existing durable scheduler and provider boundary in place. Retain its dependent planning/card/guidance stages, checkpoint ownership, and same-turn reuse. Add bounded concurrency only between independent requests, salvage validated Fused siblings, and bound recovery across the operation. This directly removes measured waste while retaining the existing quality contracts.

A single model call that plans, creates cards, and writes guidance could reduce round trips further, but replaces several validation boundaries and couples planning quality to card generation. Defer this unless the measured improvements leave a material bottleneck. Aggressive cross-turn caching would reduce calls but requires evidence that turn-specific material remains valid; it is outside this implementation. Same-turn prepared-generation reuse remains supported and verified.

**Effective mode and qualification**

Persist a run decision containing requested mode, effective mode, selected card lane, profile/configuration identity, certification state, and fallback reason. Derive the decision from the exact selected configuration. Never qualify Utility using Reasoner's certification or treat selecting Fused as proof of execution.

Surface the decision in the existing Progress and Last Brief inspection surfaces using compact text; for example, `Segmented · Fused unavailable for Utility`. Keep the bar and native notifications unchanged. Provider testing remains the explicit way to certify a changed profile; ordinary turns do not silently run qualification requests. The live validation step must demonstrate an actual `fusedCardBundle` dispatch for the active qualified profile.

**Queue ownership and concurrency**

Add a normalized per-provider request concurrency setting, bounded from one to three. Start at one until a selected configuration has passed a bounded two-request concurrency probe; qualified configurations may use two. Three is an explicit advanced setting, not an automatic escalation. Do not claim qualification for a concurrency level that was not exercised.

The queue is keyed by Connection Profile identity, not lane or role. If Utility and Reasoner share a profile, they share its limit; resolve conflicting lane limits conservatively. Lowering a limit stops additional dispatch until active work falls below it. FIFO applies to requests waiting for the same profile.

Queued cancellation removes the request before dispatch. Active cancellation aborts the transport, and the occupied slot is released exactly once when its underlying operation settles. A timed-out wrapper must not release a still-running transport and start excess calls. Stop prevents queued work, retry sleeps, and fallback dispatch. A later explicit user gesture can create a new attempt.

A rate-limit response applies a bounded profile cooldown before further dispatch, honoring usable provider retry timing and otherwise using bounded backoff. Do not retry authentication/configuration failures. Record configured and actual peak concurrency. Keep concurrency one usable for constrained providers.

**Fused item validation and recovery**

Separate bundle-envelope validation from item validation. Require a valid object with an items array; validate each requested item independently. Reject malformed strings, missing evidence, unrequested families, invalid source references, and conflicting duplicate families. Preserve fully valid siblings with their source and snapshot identity. Never stringify an array into trusted prompt text or relax evidence validation.

Return accepted families plus structured unresolved-family reasons to the durable stage. Keep accepted cards unchanged while generating only unresolved families. Existing strict validation and source binding apply again to fallback outputs. Required/forced coverage is checked before installing a prompt; an unresolved required constraint blocks installation rather than silently disappearing. Optional failures are visible omissions.

A correctable malformed response gets a bounded correction containing the actual schema/validation error and requested families. Do not append unbounded histories or repeat an unchanged request under a correction label. Prefer selective fallback when valid siblings already exist.

Classify explicit provider refusal/content-filter metadata separately from empty content, reasoning-only content, token exhaustion, and malformed JSON. Treat recognized explicit refusal as terminal for that work, without reprompting around the refusal. Do not use broad keyword matching that would mistake quoted narrative for a refusal. Required refused work blocks; optional refused work is recorded as omitted.

**Budgets and deadlines**

Use one operation-owned recovery-call allowance shared across Fused retries and segmented fallback. The default allowance is one correction plus one fallback call per selected generated family. Every additional dispatch beyond the initial card wave consumes this allowance atomically, including concurrent fallback calls. Per-stage attempt limits still apply. Persist consumed allowance across Resume; a deliberate Reprocess opens a clearly identified new recovery window. Schedule required coverage before optional recovery when allowance is scarce.

Use configurable request and total preprocessing deadlines with explicit failure reasons. Measure queue time separately from dispatch-to-response time. A request deadline begins at actual dispatch; an operation deadline includes queue and retry time. Elapsed active execution survives resumable checkpoints without charging a long user pause as inference time. Deadlines abort work through the same cancellation owner and prevent late commits.

Choose shipping deadline defaults from the baseline distribution rather than arbitrarily truncating the observed successful 197-second run. The implementation must support finite bounds, show them in advanced settings, and include a verified default in the implementation results before completion. Never describe a deadline as a compute speedup.

**Planner and guidance work**

Remove duplicate catalogs from the arbiter prompt and project only fields needed for eligibility, card selection, story form, and required output. Preserve source messages, authored priority, selection limits, and output semantics. Measure prompt characters and actual input tokens when available.

Evaluate a deterministic planner path only when the full generated-family selection and story form are explicitly determined by settings. Auto selection, ambiguous coverage, and dynamic story-form inference keep the planner. The local plan must pass the same scope, coverage, and hand-selection checks as a model plan.

Evaluate omitting model guidance when no generated cards require reconciliation and the packet can use authorized raw authored instructions directly. Preserve raw authored instructions exactly and label the decision. Use ordinary composition when conflicts, inferred posture, or other model decisions remain. Retain the current path if quality checks do not support a fast path; document measured costs and the specific disposition rather than claiming an unsupported optimization.

Do not lower output ceilings indiscriminately. Record effective budgets, output usage, and reasoning usage on successes and failures, then tune stage budgets only where successful workloads demonstrate headroom.

**Timing and diagnostics**

Add operation/attempt identifiers and timestamps or durations for queue entry, dispatch, host request preparation, transport completion, normalization/validation, durable persistence, prompt installation, first primary visible token, and primary completion. Separate normal execution and recovery. Primary first-token timing is nullable with an explicit unavailable reason when the host does not provide a reliable event; do not substitute completion time for first-token time.

Journal durations are measurements, not sums of overlapping calls. Report the critical-path preprocessing duration alongside individual calls. Failed attempts retain timings and token usage. Use bounded sanitized summaries without prompts, story text, credentials, or private reasoning. Keep diagnostics in existing inspectors and JSON exports rather than adding a dashboard.

**Validation and benchmark deliverables**

Use a small focused set of checks for actual risks:

- Two concurrent requests through one profile, shared lanes, changing limits, rate-limit cooldown, queued abort, active abort, and no slot release before underlying settlement.
- A real router response with one valid and one malformed Fused item retains the valid item; duplicates, wrong families, and invalid evidence remain rejected.
- Corrective requests differ meaningfully, explicit refusal is terminal, concurrent recovery cannot overspend, and required coverage blocks when unavailable.
- Same-turn reuse is retained; source edits, authored-deck edits, settings changes, Stop, and stale responses cannot install an old packet.
- Effective Fused decisions survive persistence and render accurately in compact desktop/mobile inspection surfaces.

Run the changed-module checks once during each meaningful change, then the required repository gate after integration. Repeat only for a new change or failure. Use the existing isolated live-harness approach for a small paired workload: identical synthetic source, card count, provider configuration, and primary settings; compare Segmented concurrency one, bounded concurrency, and qualified Fused. Capture at least three successful paired samples per selected comparison, with failures reported rather than excluded silently. Record preprocessing, time to first visible primary token, total reply time, calls, input/output/reasoning tokens, recovery count, and card-quality results. A synthetic queue benchmark proves scheduling mechanics only and cannot substitute for the live comparison.

Do not modify the user's running default-user host or deploy until the concrete changes are ready for review and that action is authorized. Use an existing dedicated test profile/environment where available. If a separate live environment needs access or setup, prepare the exact benchmark and identify the remaining dependency rather than substituting mock timings.

Read-only benchmark preflight on September 21 found existing `recursion-soak-a`, `recursion-soak-b`, and `recursion-soak-ui` data directories. The current shell has no configured harness base URL, user, or password; the dry-run preflight skipped live checks and changed no host state. Directory existence is not proof of a runnable test session. Reuse an appropriate existing dedicated account after validating access instead of creating duplicate accounts or using default-user. Other work is actively editing `cards.mjs`, `pre-process-decks.mjs`, `prompt.mjs`, `runtime.mjs`, and `test-runtime.mjs`; isolate implementation and reconcile those changes before integration.

**Completion evidence**

Deliver the scoped implementation, updated schemas/docs/examples/design contracts, focused checks, required integration-gate results, and an updated performance report mapping every review finding to code and measured outcome or an evidence-backed disposition. Verify actual Fused dispatch and actual speed improvement. Keep the goal active while live performance or any other explicit requirement remains unverified.
