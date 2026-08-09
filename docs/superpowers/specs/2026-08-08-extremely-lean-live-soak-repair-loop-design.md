# Extremely Lean Live Soak Repair Loop Design

**Status:** Approved by the repository owner on 2026-08-08.

**Target:** `refactor` at `8ece25b180ad6d5756d0429e2c94c7d6ca84b4c3`.

## Goal

Run a contract-first live SillyTavern soak against the refactored Recursion pipeline using real model calls, repair every discovered defect before advancing, and finish after three fresh accepted host generations.

The soak is an iterative development pass, not a passive report. A failing boundary pauses progression. The repair loop establishes the root cause, adds the narrowest deterministic regression available, implements one focused fix, verifies it locally, and repeats the failed live boundary before the next milestone begins.

## Chosen approach

Use a three-milestone mode-and-pipeline ladder:

1. Manual plus Segmented.
2. Auto plus Segmented.
3. Auto plus Fused.

This is preferred over a resilience-first or fallback-first allocation because it directly covers the known Manual over-expansion defect while still reaching both V1 pipelines within an extremely lean host-generation budget. Stop/Resume and forced Fused fallback remain explicit follow-up soak milestones rather than being weakly sampled here.

## Budget and counting contract

- The budget is exactly three accepted host generations.
- The earlier exploratory Segmented success does not count. All three accepted generations occur after this design is implemented.
- A generation counts only when its entire milestone contract passes and the resulting host assistant response is observed in the active synthetic soak chat.
- Failed reproductions and focused repair-validation runs do not count as accepted generations.
- Real-model retries are still expensive. A live boundary is never repeated unchanged merely to see whether it behaves differently.
- Before any repair retest, there must be new evidence, a deterministic regression, a focused implementation change, or a documented environmental correction.
- The third accepted generation ends this first soak.

## Environment and model contract

The first run uses one dedicated automated account:

- SillyTavern user: `recursion-soak-a`.
- Extension: `Recursion-refactor` from the exact `refactor` checkout under test.
- SillyTavern writer: `nanogpt zai-org/glm-5.2:thinking - Celia V5.4`.
- Recursion Utility: `nanogpt nvidia/nemotron-3-ultra-550b-a55b:thinking - Provider`.
- Recursion Reasoner: `nanogpt zai-org/glm-5.2:thinking - Celia V5.4`.
- Hand budget: minimum two, maximum two.
- Reasoning level: High.
- Reasoner use: Always.
- Injection: system role, in-prompt placement, depth one.

Provider and writer labels are operator-facing configuration evidence. Normal reports store bounded labels or hashes, not Connection Profile ids, secrets, raw requests, raw responses, hidden reasoning, or full transcripts.

## Preflight gate

Preflight consumes no accepted host generation. It must complete before milestone 1:

1. Confirm the worktree is clean, on `refactor`, and at the expected local and remote SHA.
2. Run the focused tests covering settings, provider routing, Segmented, Fused, runtime Pre-process execution, live harness behavior, and privacy.
3. Run the full deterministic suite and alpha gate.
4. Synchronize only `manifest.json`, `package.json`, `src/`, `styles/`, and `assets/icons/` into the dedicated installed `Recursion-refactor` copy and its public served copy.
5. Prove source, installed, and public parity with `verify-installed-copy.mjs` using explicit roots.
6. Reject `default-user` before browser navigation or mutation.
7. Prove dedicated-user storage write, read, isolation, and cleanup.
8. Confirm the old `third-party/Recursion` runtime is disabled for the soak user so only `Recursion-refactor` owns the generation interceptor.
9. Confirm the active writer, Utility, and Reasoner profile labels match this design.
10. Run bounded Utility and Reasoner profile certification. Milestone 3 may not begin unless the selected configuration has current Fused-capable certification.

Any stale copy, unsafe user, duplicate interceptor, missing profile, failed storage probe, or red deterministic gate blocks live model spend.

## Milestone 1: Manual plus Segmented

### Purpose

Repair and certify the known Manual card-budget boundary before broader live testing.

### Known failing evidence

The exploratory Manual run configured a two-card cap but produced an Arbiter artifact with eleven card jobs. Nine jobs were marked `forcedBy: "manual-selection"`, the persisted plan raised `budgets.maxCards` to eleven, and the live harness reached its 30-second deadline while the expanded wave was still running. This is a high-severity runtime or harness-contract defect until root cause proves otherwise.

### Setup

- Mode is Manual.
- Pipeline is Segmented.
- Exactly two named families are selected for the scenario.
- A third selection is visibly rejected by the Max Cards control.
- The synthetic scene and pending user message are fixed across reproduction and repair retests.

### Pass contract

- Runtime Manual scope contains exactly the two selected families.
- Arbiter output cannot expand Manual scope.
- Runtime-forced coverage cannot increase the dispatch budget beyond two.
- Exactly two card stages are executable and dispatched.
- Both accepted cards preserve the frozen snapshot and operation identity.
- The selected hand contains exactly those two families.
- Guidance, Card Evidence, and Guardrails contain no out-of-scope card source.
- All three prompt blocks install at system/in-prompt/depth-one.
- The outbound native SillyTavern request contains the three current-run blocks.
- The GLM/Celia writer produces one assistant response.
- Prompt and activity state settle without caution, warning, failed, skipped, or stranded running stages.

Only then does milestone 1 count as accepted generation one.

## Milestone 2: Auto plus Segmented

### Purpose

Certify the ordinary independently checkpointed Pre-process path with both configured Recursion lanes and the native host writer.

### Setup

- Mode is Auto.
- Pipeline is Segmented.
- Hand budget remains two.
- Reasoning remains High with Reasoner Always.
- The synthetic scene differs from milestone 1 so prepared-packet reuse cannot mask provider execution.

### Pass contract

- The Arbiter completes through the expected routed lane and produces a validated current-snapshot plan.
- The final executable card plan contains no more than two jobs.
- Segmented creates one independent durable stage and artifact per requested family.
- Every provider start has exactly one terminal completion or explicit accepted failure transition; no stage remains stranded in `running`.
- The configured Utility and Reasoner lanes are both exercised when routing policy requires them.
- Guidance composition succeeds or follows the documented visible fail-soft route without blocking host generation.
- The hand contains exactly two valid current-source cards.
- The three prompt blocks install and appear in the outbound native host request.
- The GLM/Celia writer produces one assistant response.
- Current-run diagnostics contain no hidden provider failure, stale packet, duplicate call, or prompt-cleanup violation.

Only then does milestone 2 count as accepted generation two.

## Milestone 3: Auto plus Fused

### Purpose

Prove the refactor reaches the genuine Fused provider path and completes the same host boundary without silently normalizing back to Segmented.

### Setup

- Mode is Auto.
- Requested pipeline is Fused.
- Utility and Reasoner certifications are current and explicitly allow Fused for the effective routed configuration.
- Hand budget remains two.
- The synthetic scene differs from milestones 1 and 2.

### Pass contract

- Effective pipeline evidence is Fused in the execution manifest, packet diagnostics, progress surface, and exported diagnostics.
- Exactly one `fusedCardBundle` provider request represents the requested family set.
- No ordinary Segmented card stage starts unless a validated Fused partial/zero-useful fallback is explicitly recorded. A fallback is a failed milestone for this first success-path soak and becomes its own repair target.
- Fused item validation accepts only requested, unique, current-snapshot families.
- The final hand contains exactly two accepted cards.
- Guidance composition, prompt installation, outbound prompt evidence, and native host continuation all complete.
- The GLM/Celia writer produces one assistant response.
- No provider failure is relabeled as generic Fused unavailability, and no stale or late result mutates the completed operation.

Only then does milestone 3 count as accepted generation three and end the soak.

## Iterative defect repair loop

Every failure follows the same loop:

1. **Freeze evidence.** Record the run id, exact checkout SHA, milestone, user, model labels, stage states, sanitized journal delta, manifest identity, and artifact references.
2. **Classify the boundary.** Decide whether the defect belongs to harness, settings/profile configuration, provider transport, Arbiter validation, card budgeting/scope, execution scheduling, prompt installation, host continuation, persistence, or privacy.
3. **Trace the root cause.** Read the persisted stage/artifact truth and follow the bad value or transition backward. A visible ribbon or final response is not sufficient evidence.
4. **Write the regression first.** Add the narrowest deterministic test that fails for the observed contract. If the defect is genuinely live-only, add a bounded live-harness assertion or synthetic reproduction fixture.
5. **Implement one focused repair.** Update code, docs, schemas, tests, and examples together when the contract changes. Recursion is pre-alpha; do not add legacy compatibility shims.
6. **Verify locally.** Run the focused regression, the affected subsystem tests, and any privacy/storage checks implicated by the change.
7. **Synchronize and verify.** Copy only production files, then repeat installed/public parity checks.
8. **Retest the same live boundary.** Use the same synthetic scenario and configuration. Do not advance on a partial pass.
9. **Close or retain the defect.** Mark it repaired only when the original live symptom is absent and the full milestone contract passes. Otherwise return to root-cause investigation.

The loop has no arbitrary fix-attempt allowance. If three focused repair attempts fail for the same defect, stop and reassess the architecture with the repository owner before attempting a fourth.

## Harness and evidence architecture

The soak runner should be a thin coordinator over existing focused capabilities rather than a second runtime implementation.

It should:

- preflight the dedicated user, profiles, source/install/public identity, storage, and deterministic gates;
- execute one milestone at a time through visible SillyTavern controls;
- establish a journal and manifest baseline before each attempt;
- correlate only current-run provider, stage, prompt, and host evidence;
- stop after the first milestone defect;
- emit a repair-ready defect record;
- resume from the failed milestone after the developer repair; and
- finish after three accepted generations.

The coordinator must not automatically edit source, retry unchanged live calls, delete chat history, reset unrelated user data, switch to `default-user`, or infer success from a previous packet or journal row.

## Result and defect semantics

Attempt results are:

- `pass`: the current milestone contract completed and counts as one accepted generation.
- `fail`: Recursion or the harness violated the current contract; progression stops for repair.
- `environment-fail`: the host, browser, authentication, provider, filesystem, or network prevented a valid attempt; it does not count.
- `stale-extension`: source, installed, or public production files differ; it does not count and blocks model spend.
- `manual-required`: an operator-only safety boundary prevents automation.

Defects use these severities:

- `critical`: privacy/secret leakage, unsafe-user mutation, prompt namespace contamination, duplicate runtime ownership, or host generation blockage with unsafe state.
- `high`: wrong scope/budget, wrong provider or pipeline route, missing/duplicate model stage, invalid checkpoint transition, prompt-install failure, stale mutation, or incorrect host continuation.
- `medium`: progress, diagnostics, viewer, Last Brief, or harness evidence is materially wrong while the runtime remains fail-soft.
- `low`: bounded copy or artifact-quality problem that does not undermine the verdict.

Any critical or high defect blocks the milestone. Medium defects block when they make the current-run verdict ambiguous. Low defects are recorded but do not consume an additional host generation unless their repair touches a live boundary.

## Privacy and artifact contract

Generation-enabled soak attempts do not capture screenshots or Playwright traces after model or chat text appears.

Persisted reports may contain:

- run, operation, stage, and artifact ids;
- hashes, counts, durations, bounded model/profile labels, pipeline/mode labels, and status codes;
- selected/requested family names and omission reasons;
- prompt-key names, placement, role, depth, section lengths, and hashes;
- bounded defect summaries and exact reproduction commands.

Persisted reports must not contain:

- API keys, cookies, authorization headers, Connection Profile ids, or secret references;
- raw provider request/response envelopes or hidden reasoning;
- full transcripts, assistant prose, or private chat text;
- artifact bodies containing synthetic or live prompt text outside an explicitly approved synthetic evaluation corpus;
- unrelated local paths or user data.

Every artifact root runs the existing redaction canary before it can support a pass claim.

## Completion contract

The first soak is complete only when:

1. Milestone 1 passes after the Manual expansion defect is repaired.
2. Milestone 2 passes on a fresh Auto Segmented scene.
3. Milestone 3 passes through a genuine Fused execution on a fresh scene.
4. Exactly three accepted host generations are recorded.
5. Every discovered critical/high defect is repaired and has regression coverage.
6. Source, installed soak copy, and public served copy are byte-identical for all production files.
7. The final worktree and remote state are reported separately.

Completion does not certify Stop/Resume, Retry Stage, queued reprocess, forced Fused fallback, Post-process, long-story endurance, story quality, or multi-user isolation beyond preflight. Those remain named follow-up soak passes.
