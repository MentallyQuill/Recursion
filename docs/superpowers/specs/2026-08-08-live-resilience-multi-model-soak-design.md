# Live Resilience and Multi-Model Utility Soak Design

**Status:** Approved for execution by the repository owner on 2026-08-08 through the standing instruction to expand, document, and run the soak without further approval gates.

**Parent baseline:** `docs/superpowers/specs/2026-08-08-extremely-lean-live-soak-repair-loop-design.md` and its completed 3/3 accepted-generation result.

## Goal

Extend live Recursion testing through the remaining Pre-process resilience boundaries while beginning a real-model Utility compatibility matrix. The pass must cover Stop/Resume, Retry Stage, queued reprocess, forced Fused fallback, and cumulative long-story endurance. Post-process remains excluded and will receive its own later design and soak.

Every defect still enters the established evidence, deterministic regression, focused repair, redeploy, and same-boundary retest loop. A model response is not retried unchanged merely to seek a different outcome.

## Chosen approach

Use a woven eight-new-turn matrix in one persistent synthetic story chat.

The first four accepted native new-turn generations bind one resilience scenario to each requested Utility model. The next four are ordinary continuation turns, one per model, that bring the same chat to an eight-turn endurance boundary. The queued-reprocess milestone also performs one native swipe, but that swipe is verification work and does not increase the accepted new-turn count. This gives every Utility model both an exceptional-path observation and an ordinary-path observation without multiplying four models by every scenario.

Two alternatives were rejected:

- A complete model-by-scenario cross-product would require at least sixteen resilience generations before endurance and would spend model calls without proportional diagnostic value.
- Running all resilience cases on one model and giving the other three only certification would not establish that their Utility output survives the real host boundary.

## Exact model and profile contract

The SillyTavern writer and Recursion Reasoner remain:

- Writer: `nanogpt zai-org/glm-5.2:thinking - Celia V5.4`.
- Reasoner: `nanogpt zai-org/glm-5.2:thinking - Celia V5.4`.

The Utility matrix, in preferred order, is:

1. `nanogpt deepseek/deepseek-v4-flash:thinking - Provider`.
2. `nanogpt minimax/minimax-m3:thinking - Freaky Frankenstein 5 - Internal States - Fast`.
3. `nanogpt deepseek/deepseek-v4-pro-cheaper:thinking - Celia V5.4`.
4. `nanogpt gemma-4-31B-Fabled - RedRising-1.3`.

The Drummer Cydonia is a fifth, Segmented-only compatibility add-on:

5. `nanogpt TheDrummer/Cydonia-24B-v4.3 - Wandlight-1.3`.

Cydonia does not alter or extend the completed eight-turn resilience ledger. It receives a separate fresh synthetic chat, connectivity plus single-card certification, and one accepted Segmented host turn. Its certification, request audit, and durable stage graph must all prove that no Fused bundle test or Fused pipeline stage ran. Prior Cydonia failures are treated as Recursion integration defects until request shaping, output parsing, and the live host boundary have been exhausted through the repair loop.

The first, third, and fourth profiles already exist on `recursion-soak-a`. The MiniMax M3 profile exists only on `default-user`; preflight may copy that one complete Connection Manager profile record into the soak user's profile list after backing up `settings.json`. It must not mutate `default-user`, copy unrelated settings, expose the profile id or secret reference, or duplicate an equivalent model/profile already present.

The Cydonia profile also originates on `default-user`. The same exact-profile, backup-first, shared-credential-reference guard applies when adding it to `recursion-soak-a`.

Recursion uses isolated provider policy during the matrix. Saved SillyTavern presets identify the requested profiles but do not become hidden prompt dependencies.

## Qualification gate

Before a profile owns a host milestone:

1. Select it for Utility by safe operator-facing label.
2. Leave Reasoner and writer on GLM/Celia.
3. Set Auto mode, two-card budget, system/in-prompt/depth-one injection, and the scenario's required pipeline.
4. Run Utility-only staged certification: connectivity, one Segmented card, and Fused bundle.
5. Record only label, model, completion mode, structured-output method, bounded checks, capability state, and safe diagnostic codes.

Connectivity and single-card success are required for every model. Full Fused certification is required only for the model assigned the forced-Fused-fallback scenario. Prefer DeepSeek V4 Pro Cheaper for that scenario; if it is only Segmented-ready, assign the scenario to the first requested model that is Fused-ready and give V4 Pro Cheaper the displaced scenario.

A certification failure pauses progression for diagnosis. Transport, parsing, budgeting, schema, and harness defects are repairable. MiniMax M3 and DeepSeek V4 Pro Cheaper are required Recursion integration targets: completion truncation, request-budget, schema, or transport failures must be diagnosed and repaired in Recursion rather than classified as model incompatibility. Another Fused-ready requested model may still own the injected fallback scenario, but both required models must complete accepted pipeline turns before the soak passes.

## Persistent chat contract

All eight accepted new-turn continuations occur in one dedicated synthetic chat owned by `recursion-soak-a`.

- The chat is created for this soak and is never a user-authored chat.
- Every new-turn scenario appends a unique synthetic user message and requires one native assistant continuation.
- Swipe/reprocess operations remain attached to the current assistant turn and do not falsely increase the new-turn count.
- Before each scenario, record the current chat identity, visible message counts, latest message hashes, operation baseline, journal baseline, and installed prompt-key baseline.
- After each scenario, prove that only the intended new turn or swipe changed the chat.
- Do not delete the chat during repair loops. Reproduce against the same scenario boundary or branch to another synthetic soak chat when a failed host action makes exact replay unsafe.

## Milestones 1 through 4: model-bound resilience

Each requested model receives one milestone. Assignment is finalized after qualification while preserving the preferred order and the Fused-ready requirement.

### Stop and Resume

- Start an Auto/Segmented native host generation with Utility owning the relevant Pre-process calls.
- Observe a current-operation provider stage in `running`.
- Invoke the visible `Stop and pause this operation` action.
- Prove the native host stop was called once, Recursion prompt keys were cleared once, the operation became `paused`, and no late provider result committed.
- Invoke `Resume from saved checkpoint`.
- Prove Resume requested one native host continuation, used a fresh signal, reused completed checkpoints, resumed only the frontier, and made no detached provider call before the host callback.
- Require one assistant continuation and a terminal completed operation.

### Retry Stage

- Start an Auto/Segmented native host generation.
- After a real Utility Arbiter response returns, fault injection replaces that one client-visible response with a bounded invalid result.
- Prove the blocking Arbiter stage becomes failed/paused and exposes `Retry this step`.
- Remove the one-shot fault and invoke Retry through the visible progress action.
- Prove the same operation retries only the failed frontier with incremented attempt count, preserves valid earlier checkpoints, completes prompt installation, and reaches one assistant continuation.

### Forced Fused fallback

- Use a Fused-certified requested Utility profile with Reasoner disabled for the scenario so the tested Utility owns the bundle.
- Start a requested Auto/Fused native generation.
- Allow each real `fusedCardBundle` request to complete, but replace the client-visible bundle with a bounded zero-useful result for the configured Fused attempt window.
- Prove the operation records requested Fused, completes the Fused stage with an explicit validated fallback directive, starts Segmented stages only for unresolved families, reuses the Arbiter checkpoint, and does not relabel the injected failure as profile unavailability.
- Remove fault injection before Segmented calls, require a two-card hand, outbound prompt blocks, and one assistant continuation.

### Queued reprocess

- Complete a normal Auto/Segmented host turn first.
- From the completed progress surface, invoke `Reprocess from here on the next swipe` for a model stage.
- Prove one chat-scoped queued intent names the selected stage frontier and no provider call starts immediately.
- Trigger one native swipe.
- Prove the queued intent is consumed once, the selected stage and downstream stages rerun, upstream checkpoints remain reusable, the swipe owns the host action, and no duplicate operation or provider stage is created.
- Require the latest swipe to settle with current prompt evidence and a completed operation. The preceding ordinary Gemma new turn counts as milestone 4's accepted new turn; the swipe itself does not count toward eight.

## Milestones 5 through 8: rotating endurance continuation

Return to ordinary Auto/Segmented operation. Run four additional native story turns in the same chat, one with each Utility profile in preferred order.

For every turn:

- recertify the newly selected Utility profile because certification is bound to provider configuration;
- keep GLM/Celia Reasoner and writer unchanged;
- append a unique continuation message that references prior synthetic story facts without copying transcript text into reports;
- require a current-snapshot plan, at most two executable card stages, a valid two-card hand, three installed/outbound prompt blocks, and one assistant response;
- require balanced provider starts/terminals, no stale or late mutation, no duplicate operation, and no stranded running stage.

At the eighth accepted new-turn continuation, additionally require:

- the same synthetic chat identity used at milestone 1;
- monotonically increasing visible user/assistant counts for new turns;
- no prompt namespace accumulation beyond the three Recursion keys;
- bounded journal, artifact-index, and retained execution counts within configured limits;
- current turn/source hashes distinct from earlier turns;
- no prepared-packet reuse across changed user messages;
- no unresolved queued reprocess, paused operation, or stale prompt state.

This is a bounded endurance signal, not a long-duration performance certification.

## Fault-injection safety

Fault injection lives only in the Playwright proof context and is one-shot or attempt-window bounded.

- It may observe a completed local response and substitute a synthetic invalid response before Recursion parses it.
- It must never alter SillyTavern server files, saved Connection Profiles, API secrets, or unrelated requests.
- It identifies target requests from bounded role/schema metadata, never by storing full prompts.
- It restores normal routing before fallback, Retry, Resume, or the next milestone as required.
- Reports record fault kind, target role, attempt number, response status, and hashes/counts only.

## Harness architecture

Create one thin `prove-live-resilience-matrix.mjs` coordinator over shared helpers extracted from the existing live pipeline proof. It owns:

- exact safe-label profile selection and Utility-only certification;
- persistent synthetic-chat creation and turn baselines;
- bounded request/response fault injection;
- visible progress-action selection;
- current-operation, prompt, host, and chat verdicts;
- checkpointed progress so a repaired run resumes at the failed milestone without repeating accepted generations;
- a sanitized report under `artifacts/live-resilience-matrix/<run-id>/report.json`.

The coordinator never edits source, retries unchanged failures, switches to `default-user`, silently changes the requested model, captures screenshots/traces after chat content exists, or treats the existing deterministic served-module lifecycle proof as real-model evidence.

## Counting and repair contract

- Exactly eight accepted native new-turn generations complete this pass.
- Qualification calls, failed attempts, Stop-triggered aborted calls, Retry attempts, Fused attempts replaced by the fault injector, and repair retests do not independently count.
- Stop/Resume counts when the resumed native new-turn continuation completes.
- Retry Stage counts when the retried operation completes its native continuation.
- Forced Fused fallback counts when the explicit fallback operation completes its native continuation.
- Queued reprocess passes when its native swipe settles, but only the ordinary new turn created immediately before that swipe enters the eight-turn counter.
- Every failure freezes sanitized evidence, adds the narrowest deterministic regression, implements one focused repair, reruns affected gates, synchronizes production files if needed, verifies parity, and repeats the same boundary.

## Privacy and artifacts

The previous live-report redaction contract remains authoritative.

Reports may contain ids, hashes, counts, statuses, durations, safe model/profile labels, role names, family names, stage ids, attempt counts, and bounded diagnostic codes. They must not contain raw prompt/chat text, assistant prose, hidden reasoning, raw requests/responses, profile ids, secret references, cookies, authorization data, or screenshots/traces containing generated text.

Run the redaction canary and credential-like diff scan before a report supports a pass claim.

## Completion contract

This soak completes only when:

1. All four requested Utility models pass connectivity and Segmented-card qualification or have a clearly evidenced genuine incompatibility after repairable integration defects are exhausted.
2. Stop/Resume, Retry Stage, forced Fused fallback, and queued reprocess each pass through the real SillyTavern host boundary.
3. Every requested Utility model reaches at least one completed ordinary or resilience host continuation.
4. The persistent synthetic chat reaches the bounded eight-new-turn endurance verdict.
5. All discovered critical/high defects are repaired with regression coverage.
6. Full offline, alpha, browser, privacy, storage, and installed/public parity gates pass.
7. Local, remote, and deployed state are reported separately.

Post-process, story-quality comparison, multi-user concurrent generation, and open-ended duration/load testing remain outside this pass.
