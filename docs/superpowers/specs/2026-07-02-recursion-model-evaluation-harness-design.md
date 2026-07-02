# Recursion Model Evaluation Harness Design

## Purpose

Recursion needs an opt-in model evaluation harness that can answer three questions with real model calls and systematic feature traversal:

- Is Recursion choosing the right scene cards for the active turn, or is it repeatedly biasing the same families and near-identical cards?
- Does the selected hand compile into a useful prompt packet that improves the next assistant response without leaking hidden information, over-constraining the scene, or wasting prompt budget?
- Do Recursion's main functions and user-visible features hold together when exercised as a product, and can defects found by the run be reproduced, isolated, fixed, and rechecked?

The existing deterministic suite should remain the release contract gate for schemas, redaction, prompt installation, storage, and runtime fail-soft behavior. This harness is a separate effectiveness and defect-discovery gate. The full exercise mode uses Playwright inside live SillyTavern, dedicated `recursion-soak-*` users, real provider calls, scripted synthetic chats, and a second model as an automated judge. Offline synthetic harnesses are useful for development, but they are not substitutes for the full exercise gate.

## Existing Context

The current runtime path is:

1. Capture a normalized snapshot.
2. Ask the Utility Arbiter for a plan.
3. Apply card scope and reasoning-level policy.
4. Generate requested card-family jobs through real provider calls.
5. Validate provider card envelopes and evidence refs.
6. Apply lifecycle decisions to the scene deck.
7. Select a turn hand under card and token budgets.
8. Compose a prompt packet through Utility composition, with optional Reasoner synthesis.
9. Install Recursion-owned prompt blocks.

The current V1 catalog contains these fixed families:

- Scene Frame
- Active Cast
- Character Motivation
- Relationship
- Scene Constraints
- Knowledge
- Consequences
- Environment
- Items
- Open Threads

The model evaluation harness must use this catalog as the source of truth. It must not revive old catalog names such as Continuity Risk, Prose, or Environment/Items.

## Approach Options

### Option A: Metrics Only

This approach would run real Arbiter and card-generation calls, then score family coverage, omission rates, token budget use, repeated-card fingerprints, and prompt-packet section routing.

Strengths:

- Cheap and deterministic once model outputs exist.
- Good at catching scope, repetition, budget, and routing failures.
- Does not require a judge model.

Weaknesses:

- Cannot reliably judge whether a card is semantically useful.
- Cannot judge whether the final assistant response improved.
- Encourages overfitting to expected-family labels instead of actual scene usefulness.

### Option B: Judge Only

This approach would run Recursion, generate a final target-model response, and ask a second model to score the final output.

Strengths:

- Directly measures user-visible effect.
- Easier to automate than human review.
- Can catch subtle relevance and synthesis problems.

Weaknesses:

- Poor internal diagnosis if a score drops.
- Judge scores can hide whether the failure came from Arbiter selection, card generation, hand selection, prompt composition, or final generation.
- Judge position bias and model preference can distort results unless controlled.

### Option C: Hybrid Trace Plus Judge

This approach records sanitized internal traces, computes objective card and packet metrics, and uses a second model for semantic judgments of both the internal card work and the final output.

Strengths:

- Measures both internal behavior and final effect.
- Gives actionable failure localization.
- Can detect same-card bias, irrelevant family over-selection, prompt compilation loss, and final response regressions.
- Supports fully automated pass/fail reports.

Weaknesses:

- More provider calls and higher cost.
- Requires careful artifact and redaction rules.
- Requires maintained scenario fixtures and judge prompts.

Recommended approach: Option C.

## High-Level Process

Each evaluation run should execute a fixed scenario pack against one or more Recursion settings profiles. A full exercise run is a live SillyTavern Playwright run with real model calls. It has two lanes:

- functional traversal: drive Recursion's features, state transitions, and failure paths to find implementation defects;
- model effectiveness: run baseline and Recursion generation paths, then ask a separate judge model to score internal artifacts and final outputs.

The lanes can run separately for fast iteration, but the `core` pre-release process should run both in live SillyTavern. Functional traversal failures should be repaired before treating model-effectiveness scores as meaningful, because a broken UI control, prompt-clear path, provider configuration, or storage path can invalidate the model-facing result.

The full exercise flow is:

1. Run deterministic preflight checks or verify they were run for the same checkout.
2. Run a functional traversal pack through Playwright against a guarded live SillyTavern host.
3. Record defects with severity, reproduction data, layer, likely owner, and artifact links.
4. Stop immediately on critical safety failures such as secret leakage, prompt-key contamination, or Manual-scope violations.
5. Run model-effectiveness scenarios only when blocking traversal failures are absent.
6. Generate baseline and Recursion target-model outputs for the selected scenarios.
7. Ask the judge model to score card selection, card quality, prompt-packet compilation, and blind final-output comparison.
8. Aggregate traversal defects, objective metrics, judge scores, and final-output comparisons.
9. Feed each confirmed defect into the repair workflow.

The normal live scenario flow is:

1. Load a synthetic scenario fixture.
2. Use Playwright to open SillyTavern as a dedicated `recursion-soak-*` user.
3. Create or reset a synthetic evaluation chat for the scenario.
4. Install the scenario transcript and pending user turn through visible host controls or a guarded harness bridge that records its trigger source.
5. Configure Recursion provider settings for real Utility, Reasoner, target, and judge calls.
6. Run Recursion through the visible bar, Cards surface, progress menu, Last Brief, and Full Viewer.
7. Let Recursion make real provider calls for Arbiter, card generation, and optional Reasoner composition.
8. Capture the sanitized plan, generated cards, deck states, selected hand, omissions, prompt packet metadata, prompt sections, provider-call metadata, and activity stages.
9. Generate a baseline target-model response without Recursion prompt blocks.
10. Generate a Recursion target-model response with the same base prompt plus the Recursion prompt packet.
11. Ask the judge model to score card selection, card quality, prompt-packet compilation, and blind final-output comparison.
12. Write machine-readable artifacts and a short summary.
13. Aggregate metrics across scenarios and repeated runs.

The target model and judge model must be configured separately. They may use the same provider source during local experimentation, but the maintained evaluation profile should use a judge model that is distinct from the target generation model.

## Scenario Packs

Scenario fixtures should be checked in under:

```text
tests/evaluation/scenarios/
```

Fixtures are synthetic, but the full exercise runner should materialize them inside live SillyTavern chats for dedicated soak users. The fixture is the source data; live SillyTavern is the execution surface.

The first implementation should support three packs:

- `smoke`: 6 scenarios, 1 run each. Cheap sanity proof for the harness and judge schema.
- `core`: 20 to 30 scenarios, 3 runs each. Main effectiveness signal.
- `stress`: 40 to 60 scenarios, 3 to 5 runs each. Broader distribution, harder conflicts, and repetition pressure.

Each scenario should be synthetic and safe to store. It should not use private chats.

Recommended scenario axes:

- spatial constraint: movement, access, sightline, or distance matters;
- knowledge boundary: a secret, suspicion, mistaken belief, or reveal limit matters;
- active cast: multiple visible characters can speak, interrupt, or be forgotten;
- item affordance: an object enables, blocks, exposes, or threatens action;
- consequence clock: deadline, countdown, delayed fallout, or escalation trigger matters;
- relationship pressure: promise, refusal, leverage, trust, threat, or taboo wording matters;
- environment affordance: route, hazard, tool, cover, sound, exposure, or interruption matters;
- open thread: visible unanswered question or pending action matters;
- red herring: tempting but irrelevant family should not dominate;
- manual scope: disabled families must not be generated, selected, composed, or injected.

Scenario fixture shape:

```json
{
  "id": "core-airlock-access-001",
  "title": "Airlock access conflict",
  "pack": "core",
  "tags": ["spatial-constraint", "item-affordance", "active-cast"],
  "snapshot": {
    "chatId": "eval-core-airlock-access-001",
    "sceneKey": "airlock-access",
    "messages": [
      {
        "mesid": 1,
        "role": "assistant",
        "text": "Synthetic setup text."
      }
    ]
  },
  "pendingUserMessage": "Synthetic user turn.",
  "settingsProfile": "auto-normal",
  "oracle": {
    "expectedFamilies": ["Scene Constraints", "Items", "Active Cast"],
    "allowedSupportingFamilies": ["Scene Frame", "Environment", "Open Threads"],
    "discouragedFamilies": ["Knowledge", "Consequences"],
    "mustUseFacts": ["airlock is sealed", "Mara controls the keycard"],
    "mustNotReveal": ["the captain ordered the lockout"],
    "mustAvoid": ["time skip", "inventing a second keycard"],
    "successCriteria": [
      "The next response respects who can open the airlock.",
      "The next response does not reveal the hidden order."
    ]
  }
}
```

The oracle is not a script for the target model. It is evaluation metadata for deterministic metrics and judge prompts.

## Functional Traversal Packs

Functional traversal packs exercise Recursion as a product. The primary traversal path uses Playwright against live SillyTavern with synthetic evaluation chats and real provider calls. Fake storage, fake providers, fake prompt install adapters, and DOM-only harnesses may exist for narrow deterministic regressions, but they do not count as the full exercise proof.

Traversal packs should live under:

```text
tests/evaluation/traversals/
```

The first implementation should support three traversal packs:

- `traversal-smoke`: fast Playwright pass through live SillyTavern core controls and one real model-call prompt install/clear cycle.
- `traversal-core`: broad live SillyTavern product traversal over runtime, UI, storage, providers, prompt injection, real model calls, and fail-soft behavior.
- `traversal-regression`: narrow non-live or live repros for specific defects after they are isolated.

The traversal runner should support two execution styles:

- `collect`: continue after non-critical defects so one run can build a useful defect list.
- `fail-fast`: stop at the first failure, useful for focused regression repair.

Critical failures always stop the run. Critical failures include API-key leakage, raw provider prompt or response persistence, hidden-reasoning leakage, prompt keys outside the `recursion.` namespace, Manual-scope prompt injection, live `default-user` mutation, and prompt cleanup failure after disable or teardown.

## Playwright SillyTavern Execution Contract

The full exercise runner must use Playwright to operate the same Recursion surfaces a user sees in SillyTavern.

Required preflight:

- `SILLYTAVERN_BASE_URL` is configured and reachable.
- The selected user matches `recursion-soak-*`.
- `default-user`, empty users, and ambiguous aliases are rejected before mutation.
- The served extension manifest and selected source files match the checkout under test.
- Playwright readiness passes in the current environment.
- The dedicated user can write, verify, read, and delete a Recursion-owned storage probe.
- Real Utility provider configuration is present and tested.
- Real target-model configuration is present.
- Real judge-model configuration is present.
- Reasoner configuration is present when the selected profile requires Reasoner.

Playwright should prefer visible controls:

- open SillyTavern;
- select or create the synthetic evaluation chat;
- mount and enable Recursion;
- use the Recursion Bar power, mode, Cards, progress, Last Brief, options, and viewer controls;
- enter or verify provider configuration through the provider surface when feasible;
- send scenario messages through visible SillyTavern input and send controls;
- inspect Recursion prompt metadata through Recursion-owned exposed state and prompt-key wrappers.

Guarded harness bridges are allowed only for operations that cannot be performed safely through visible controls, such as creating a synthetic scenario chat or wrapping prompt-key writes for metadata capture. Each bridge use must record `triggerSource`, `bridgeName`, reason, and whether a strict run permits it.

Generation-enabled Playwright runs must not write screenshots or traces after chat/model text appears. They may write text and JSON artifacts that pass redaction checks. No-generation UI preflights may write screenshots and traces.

## Functional Feature Matrix

The traversal lane should cover these Recursion features.

### Runtime And Mode Control

- Power off does not inspect chat, call providers, update cards, write cache, or install prompts.
- Power on allows Auto and Manual preparation.
- Auto mode treats card scope as focus and records high-relevance exceptions.
- Manual mode treats card scope as a strict whitelist from Arbiter plan through prompt packet.
- Reasoning levels route Arbiter, card calls, and composer work according to provider health.
- Prompt Footprint changes section budgets without silently changing card scope.
- Strength and Focus affect card pressure and composition metadata without overwriting prompt safety.

### Card Scope And Selection

- Cards surface preserves the ten V1 families and thirty facets.
- Family toggles disable and restore sub-items.
- Partial family state is mixed.
- Zero-selection is blocked.
- Manual disabled families cannot be requested, generated, selected, composed, or injected.
- Auto disabled-focus families can appear only with visible `auto-scope-exception:<family>` diagnostics.
- Last Brief and viewer surfaces show selected and omitted families accurately.

### Provider And Model Calls

- Utility provider setup, status, model discovery, and Test Provider work without persisting session keys.
- Reasoner provider setup, status, model discovery, and Test Provider work when enabled.
- Host-current-model, host-connection-profile, and openai-compatible sources are represented in traversal fixtures where feasible.
- Provider failures, malformed JSON, token-limit output, reasoning-only output, timeouts, and auth failures degrade Recursion without blocking host generation.
- Batch card calls preserve one frozen snapshot hash and shared run id.
- Stale provider results cannot update active cache, hand, packet, or prompt install state.

### Prompt Packet And Injection

- Prompt packet composition creates Scene Brief, Turn Brief, and Guardrails.
- Packet sections route selected families to the expected sections.
- Packet sections record source ids or valid omission reasons.
- `packetToPromptBlocks` emits only known Recursion prompt keys.
- Prompt install replaces or clears known Recursion keys rather than appending duplicates.
- Prompt install failure rolls back or reports warning without blocking host generation.
- Power-off, chat change, source change, disable, reset, and teardown clear Recursion-owned prompt keys.

### Storage, Cache, And Diagnostics

- Scene cache stores bounded card metadata and latest-hand metadata without raw provider prompts or API keys.
- Cache contract versions invalidate hard drift and mark settings drift stale.
- Cached cards with stale source ranges, hidden messages, mismatched fingerprints, or out-of-window evidence cannot enter the hand.
- Manual refresh invalidates cache without adding synthetic chat content.
- Reset scene cache clears memory state, storage state, and prompt keys.
- Run journal entries are bounded, sanitized, and ordered.
- Diagnostics export omits secrets, full transcripts, raw provider prompts, raw responses, hidden reasoning, and inspector-only notes.

### UI And Operator Surfaces

- Recursion Bar mounts and exposes power, mode, Cards, progress, Last Brief, and options controls.
- Hero Pixel Array progress shows reading, Arbiter planning, card batch, card progress, hand selection, prompt composition, install, fallback, warning, and settled states.
- Last Brief dropdown reflects the most recent hand and omissions.
- Full Viewer opens Now, Deck, Activity, Prompt Packet, Settings, Providers, and diagnostics views.
- Provider cards show ready, unavailable, disabled, issue, composing, and test-failed states without raw error leakage.
- Desktop and phone viewports do not overlap controls or hide required controls.

### Live Host Boundaries

Full exercise traversal must run in live SillyTavern and must use the existing dedicated-user guardrails:

- `SILLYTAVERN_BASE_URL` must be configured and reachable.
- The active user must match `recursion-soak-*`.
- `default-user` and ambiguous aliases are rejected before mutation.
- Served extension files must match the checkout or the run is `stale-extension`.
- Storage probes must prove Recursion-owned write/read/delete behavior for the dedicated user.
- Generation-enabled live traversal must not capture screenshots or traces that may contain model text.

## Defect Records

Every traversal failure should produce a structured defect record. Defect records belong in the evaluation report and can also be emitted as standalone JSON under the run artifact root.

Defect record shape:

```json
{
  "recordType": "recursion.evalDefect",
  "schemaVersion": 1,
  "id": "defect-example",
  "scenarioId": "core-airlock-access-001",
  "traversalId": "providers-openai-auth-failure",
  "severity": "critical | high | medium | low",
  "layer": "runtime | ui | provider | prompt | storage | live-host | judge | artifact",
  "status": "open",
  "summary": "One sentence defect summary.",
  "reproduction": {
    "command": "node tools\\scripts\\eval-recursion-models.mjs --traversal providers-openai-auth-failure --fail-fast",
    "profile": "auto-normal",
    "artifact": "scenario-results/example/sample-1.json"
  },
  "expected": "Bounded expected behavior.",
  "actual": "Bounded actual behavior.",
  "suspectedOwner": "src/providers.mjs",
  "regressionTarget": "tools/scripts/test-providers.mjs",
  "blocking": true
}
```

Severity semantics:

- `critical`: safety, privacy, prompt-key contamination, live unsafe-user mutation, or host generation blockage.
- `high`: core runtime, provider, prompt install, scope, or storage behavior is wrong.
- `medium`: user-visible feature, diagnostics, progress, viewer, or artifact behavior is wrong but fail-soft generation still works.
- `low`: copy, polish, non-blocking artifact metadata, or minor report quality issue.

## Repair Workflow

The evaluation process should include a repair loop. The runner itself should not modify source code, but it should produce enough reproduction data for a developer or Codex implementation pass to repair defects without rediscovery.

For each confirmed defect:

1. Reproduce the defect with the narrowest traversal, scenario, or focused command.
2. Classify the layer and severity.
3. Identify whether the defect is deterministic, model-dependent, live-host dependent, or judge-dependent.
4. Add or update the narrowest deterministic regression test when the behavior can be isolated without real model calls.
5. If the defect is only visible with real model calls, add a synthetic eval scenario or traversal assertion that captures the failure without private data.
6. Fix the implementation, docs, schemas, tests, or examples in place. Recursion is pre-alpha, so prefer the clean current contract over compatibility shims.
7. Run the focused regression command.
8. Rerun the failed traversal or scenario in `fail-fast` mode.
9. Rerun the affected pack in `collect` mode.
10. If the defect touched live-host behavior, rerun the guarded live smoke or live traversal with a dedicated `recursion-soak-*` user.
11. Update the defect record to `fixed`, `wont-fix`, `duplicate`, or `needs-human-review`.

Repair completion requires evidence. A fixed defect must cite:

- original failing run id and defect id;
- reproduction command;
- changed files;
- focused regression command and result;
- rerun traversal or scenario command and result;
- live proof command and result when applicable.

The harness summary should keep a defect ledger:

- `openCriticalCount`
- `openHighCount`
- `fixedCount`
- `regressionAddedCount`
- `requiresLiveProofCount`
- `requiresHumanReviewCount`

Model-effectiveness scores should not hide open traversal defects. If critical or high traversal defects remain open, the aggregate report status should be `fail` or `inconclusive` even if judge scores are good.

## Settings Profiles

The harness should run each pack against named Recursion profiles:

- `auto-normal`: Auto mode, normal footprint, default card budget, Reasoner off or auto according to local provider setup.
- `auto-rich-reasoner`: Auto mode, rich footprint, Reasoner eligible and tested healthy.
- `manual-focused`: Manual mode with a scenario-provided strict family subset.
- `low-lean`: Low reasoning level, lean card pressure, compact footprint.
- `ultra-wide`: Ultra reasoning level, larger card budget, Reasoner eligible.

The first implementation should ship `auto-normal` and `manual-focused`. The broader profiles can follow once the harness can produce stable summaries.

## Internal Trace Capture

The harness should capture enough internal state to diagnose decisions without storing private provider envelopes.

Per scenario run, capture:

- scenario id, pack, tags, settings profile, model labels, provider sources, SillyTavern base URL hash, dedicated user, trigger source, and run id;
- Recursion settings hash, card catalog hash, provider contract hash, and prompt packet version;
- served extension freshness status and checked file hashes;
- Playwright action timeline with visible-control, bridge, and assertion steps;
- Arbiter action, scene status, prompt footprint, requested card jobs, lifecycle actions, budgets, and sanitized diagnostics;
- generated card metadata: id, family, role, status, emphasis, detail profile, token estimate, evidence refs, source range, provider lane, and prompt text for synthetic scenarios;
- rejected card counts grouped by rejection reason when available;
- selected hand ids, families, token estimates, omissions, and omission reasons;
- prompt packet section hashes, section lengths, source ids per section, composer lane, Reasoner status, and injection plan metadata;
- activity phases and card progress counts;
- final baseline and Recursion candidate outputs for synthetic scenarios;
- judge model scores and rationales.

Because the standard fixtures are synthetic, the harness may persist full card prompt text, prompt packet text, and candidate output text under `artifacts/model-evals/` after redaction checks. This permission applies only to checked-in synthetic evaluation scenarios run against dedicated soak users. Manual exploratory live chats and private chats must keep the stricter live-smoke artifact policy and persist hashes or bounded excerpts only.

No evaluation artifact may store API keys, authorization headers, cookies, raw hidden reasoning, unredacted provider request envelopes, or private live transcripts.

## Objective Metrics

The harness should compute objective metrics before calling the judge.

### Card Selection Metrics

- `expectedFamilyCoverage`: percentage of oracle expected families represented in requested jobs, generated cards, and selected hand.
- `discouragedFamilyRate`: percentage of selected cards from oracle discouraged families.
- `manualScopeViolationCount`: generated, selected, composed, or injected cards outside Manual scope.
- `autoExceptionRate`: unselected Auto families accepted as high-relevance exceptions.
- `selectedFamilyEntropy`: normalized entropy across selected hand families.
- `topFamilyConcentration`: largest single-family share across a pack.
- `irrelevantFamilyPersistence`: rate at which a family appears in scenarios where it is neither expected nor allowed supporting.
- `nearDuplicateCardRate`: repeated or near-identical prompt text across unrelated scenarios.
- `sameFamilyStreak`: longest streak of the same dominant selected family across scenario order.
- `evidenceCoverage`: share of selected cards with valid in-window `message:N` evidence.

Scene Frame and Scene Constraints are allowed to have high base rates. They should not be flagged merely for being common. Bias alarms should trigger when a family appears repeatedly in scenarios where the oracle marks it irrelevant or when near-identical card text recurs across unrelated scenarios.

### Prompt Compilation Metrics

- `selectedSourceCoverage`: selected hand card ids represented in prompt section source ids or omitted with a valid reason.
- `sectionBudgetUse`: section length over budget by packet section.
- `guardrailRetention`: expected Scene Constraints and Knowledge cards represented in Guardrails when selected.
- `sceneBriefRouting`: Scene Frame, Active Cast, Environment, and Items represented in Scene Brief when selected and budgeted.
- `turnBriefRouting`: Character Motivation, Relationship, Consequences, and Open Threads represented in Turn Brief when selected and budgeted.
- `compositionLossRate`: selected cards with no section source and no omission reason.
- `reasonerFallbackRate`: Reasoner eligible runs that fell back to Utility.
- `unsafeTextViolationCount`: hidden-thought, future-plan, secret-leak, or inspector-note leakage in prompt packet text.

### Final Output Metrics

Objective checks should flag:

- forbidden reveal strings from scenario oracle;
- missing must-use facts when string or regex checks are sufficient;
- obvious time skip markers when the scenario forbids time skip;
- assistant response absence or malformed output;
- output length outside configured bounds.

These checks are intentionally shallow. The judge model owns semantic scoring.

### Defect Discovery Metrics

- `criticalDefectCount`: safety, privacy, prompt-key contamination, unsafe-user, or cleanup failures.
- `highDefectCount`: core runtime, provider, prompt install, scope, or storage defects.
- `mediumDefectCount`: user-visible feature, progress, viewer, diagnostics, or report defects.
- `lowDefectCount`: minor copy, metadata, or non-blocking artifact quality defects.
- `featureCoverage`: percentage of the functional feature matrix exercised by the run.
- `visibleControlCoverage`: percentage of required Playwright-visible controls used successfully.
- `bridgeUsageCount`: number of harness bridge actions used instead of visible controls.
- `realModelCallCoverage`: required Utility, Reasoner when profiled, target, and judge calls completed with real providers.
- `repairReadyDefectRate`: share of defects with reproduction command, artifact link, expected behavior, actual behavior, and regression target.
- `regressionBackfillRate`: share of fixed defects that received deterministic regression coverage or a synthetic eval scenario.

## Judge Model Review

The judge model must return strict JSON. Free-form judge prose should be rejected and retried once with the same prompt if the provider failure is schema-related.

Judge score fields use integers from 1 to 5:

- `1`: unacceptable or actively harmful.
- `2`: weak and likely to cause drift.
- `3`: usable but incomplete or noisy.
- `4`: good and mostly aligned.
- `5`: excellent, specific, grounded, and economical.

Judge rationales should be bounded to 600 characters. They may cite scenario facts and card ids, but they must not include hidden reasoning, provider request envelopes, API keys, or full raw prompt bodies.

The judge should run three review tasks.

### Card Work Review

Inputs:

- scenario transcript and pending user message;
- oracle expected, supporting, discouraged, must-use, must-not-reveal, and must-avoid metadata;
- Arbiter requested jobs;
- generated card metadata and prompt text;
- selected hand;
- omissions.

Output schema:

```json
{
  "schema": "recursion.eval.cardJudge.v1",
  "scenarioId": "string",
  "scores": {
    "familyRelevance": 1,
    "cardSpecificity": 1,
    "evidenceGrounding": 1,
    "nonRedundancy": 1,
    "scopeDiscipline": 1
  },
  "flags": {
    "missedCriticalFamily": false,
    "selectedIrrelevantFamily": false,
    "duplicativeCards": false,
    "unsafeMotivation": false,
    "manualScopeViolation": false
  },
  "rationale": "bounded explanation"
}
```

### Prompt Packet Review

Inputs:

- selected hand;
- prompt packet sections;
- source ids per section;
- omissions;
- scenario oracle.

Output schema:

```json
{
  "schema": "recursion.eval.packetJudge.v1",
  "scenarioId": "string",
  "scores": {
    "synthesis": 1,
    "constraintRetention": 1,
    "knowledgeBoundary": 1,
    "budgetDiscipline": 1,
    "promptUsefulness": 1
  },
  "flags": {
    "lostSelectedCard": false,
    "overcompressedCriticalConstraint": false,
    "leakedForbiddenKnowledge": false,
    "overfitToCards": false
  },
  "rationale": "bounded explanation"
}
```

### Blind Final Output Review

Inputs:

- scenario transcript and pending user message;
- oracle metadata;
- output A;
- output B.

The judge must not know which output is baseline and which used Recursion. The harness should randomize labels and run a second judge pass with labels reversed for a sample or for every core-pack scenario. If the two passes disagree, the scenario preference becomes `tie_or_unstable`.

Output schema:

```json
{
  "schema": "recursion.eval.outputJudge.v1",
  "scenarioId": "string",
  "preferredOutput": "A | B | tie",
  "scores": {
    "userIntent": { "A": 1, "B": 1 },
    "sceneCoherence": { "A": 1, "B": 1 },
    "constraintAdherence": { "A": 1, "B": 1 },
    "knowledgeSafety": { "A": 1, "B": 1 },
    "castAndObjectContinuity": { "A": 1, "B": 1 },
    "usefulSpecificity": { "A": 1, "B": 1 },
    "overconstraint": { "A": 1, "B": 1 }
  },
  "flags": {
    "A": {
      "forbiddenReveal": false,
      "contradiction": false,
      "droppedUserIntent": false
    },
    "B": {
      "forbiddenReveal": false,
      "contradiction": false,
      "droppedUserIntent": false
    }
  },
  "rationale": "bounded explanation"
}
```

For `overconstraint`, lower is better. For the other score fields, higher is better.

## Pass And Fail Semantics

Evaluation status should use:

- `pass`: thresholds met and no critical failures.
- `fail`: Recursion behavior violates a defined evaluation threshold.
- `environment-fail`: provider, filesystem, configuration, or network conditions prevented a valid run.
- `unsafe-user`: live run attempted to use `default-user`, an empty user, or a non-dedicated user.
- `stale-extension`: live SillyTavern served extension files do not match the checkout under test.
- `judge-fail`: judge model could not return valid review JSON after retry.
- `inconclusive`: run completed but too many judge preferences were unstable or too many provider calls were skipped.
- `skipped`: pack or profile intentionally not run.

Suggested pre-alpha thresholds for the `core` pack:

- `manualScopeViolationCount` must be 0.
- `unsafeTextViolationCount` must be 0.
- `expectedFamilyCoverage` in selected hand should be at least 70 percent across the pack.
- `discouragedFamilyRate` should stay below 15 percent.
- `irrelevantFamilyPersistence` should stay below 20 percent per family.
- `nearDuplicateCardRate` across unrelated scenarios should stay below 10 percent.
- `compositionLossRate` must be 0 for selected cards unless a valid omission reason exists.
- Judge `familyRelevance`, `constraintRetention`, and `knowledgeSafety` average scores should be at least 4 out of 5.
- Recursion output should beat or tie baseline in at least 70 percent of stable blind comparisons.
- Recursion output should lose to baseline by 2 or more aggregate score points in no more than 10 percent of stable comparisons.
- Any forbidden reveal, manual-scope violation, hidden-thought leak, or API-key leak is a hard fail.
- A `core` full exercise run is not valid unless Playwright drove live SillyTavern and real model calls were made for Utility, target output, and judge review.

These thresholds should be versioned in the scenario pack config so they can tighten over time without rewriting old reports.

## Artifacts

Evaluation artifacts should live under:

```text
artifacts/model-evals/<run-id>/
```

Required files:

- `report.json`: aggregate machine-readable results.
- `summary.md`: short operational summary with failures first.
- `trace.jsonl`: bounded stage log.
- `playwright/actions.jsonl`: bounded visible-control and bridge-action log.
- `live/preflight.json`: SillyTavern user, served-extension, storage-probe, and provider-readiness preflight.
- `scenario-results/<scenario-id>/<sample-id>.json`: per-scenario run trace.
- `judge/<scenario-id>/<sample-id>-cards.json`: card judge result.
- `judge/<scenario-id>/<sample-id>-packet.json`: packet judge result.
- `judge/<scenario-id>/<sample-id>-output.json`: output judge result.
- `redaction-check.json`: artifact scan result.

Report shape:

```json
{
  "recordType": "recursion.modelEvalReport",
  "schemaVersion": 1,
  "runId": "20260702-000000",
  "generatedAt": "2026-07-02T00:00:00.000Z",
  "status": "pass",
  "pack": "core",
  "settingsProfiles": ["auto-normal"],
  "models": {
    "target": "provider/model",
    "judge": "provider/model"
  },
  "live": {
    "baseUrlHash": "sha256-example",
    "user": "recursion-soak-a",
    "servedStatus": "served-extension-match",
    "triggerSource": "ui-send"
  },
  "scenarioCount": 20,
  "sampleCount": 60,
  "metrics": {},
  "judgeSummary": {},
  "failures": [],
  "warnings": []
}
```

The redaction scan must run before reporting success. It should fail on obvious secrets and forbidden live-artifact fields such as `apiKey`, `authorization`, `bearer`, `cookie`, `password`, raw hidden reasoning, and unredacted provider request envelopes.

## CLI Shape

The first implementation should add:

```powershell
node tools\scripts\eval-recursion-models.mjs --live --pack smoke --profile auto-normal --runs 1 --target-model <model-id> --judge-model <model-id> --write-artifacts
node tools\scripts\eval-recursion-models.mjs --live --pack core --profile auto-normal --runs 3 --target-model <model-id> --judge-model <model-id> --write-artifacts
```

Useful flags:

- `--live`
- `--base-url <url>`
- `--user recursion-soak-a`
- `--pack smoke|core|stress`
- `--traversal traversal-smoke|traversal-core|traversal-regression`
- `--profile auto-normal|manual-focused|auto-rich-reasoner|low-lean|ultra-wide`
- `--scenario <id>`
- `--runs <count>`
- `--collect`
- `--fail-fast`
- `--max-provider-calls <count>`
- `--max-estimated-cost <amount>`
- `--utility-model <model-id>`
- `--reasoner-model <model-id>`
- `--target-model <model-id>`
- `--judge-model <model-id>`
- `--write-artifacts`
- `--dry-run`
- `--strict`

The runner should refuse a full exercise run without `--live`, a reachable base URL, a dedicated soak user, served-extension freshness proof, and provider configuration for real Utility, target, and judge calls. It should print the estimated number of Utility, Reasoner, target, and judge model calls before making calls.

## Cost And Reproducibility

Provider outputs are not perfectly reproducible even with fixed settings, so every report must record:

- target model id and provider source;
- judge model id and provider source;
- temperature, top-p, max tokens, and reasoning level;
- scenario pack version;
- card catalog hash;
- provider contract hash;
- prompt packet version;
- settings hash;
- run id and sample id;
- request and response hashes for provider calls, not raw provider envelopes.

The `smoke` pack should stay cheap enough to run frequently in live SillyTavern. The `core` pack should be the normal effectiveness and defect-discovery gate. The `stress` pack is for pre-release confidence and investigation.

## Failure Triage

The harness should classify failures by layer:

- `arbiter-selection`: wrong or missing card jobs, excessive irrelevant families, bad lifecycle action.
- `card-generation`: malformed card JSON, weak promptText, invalid evidence, repeated generic text.
- `scope-enforcement`: Manual violations or unexplained Auto exceptions.
- `hand-selection`: useful generated cards omitted while weaker cards selected.
- `prompt-compilation`: selected card lost, wrong section, budget loss, leaked diagnostics.
- `reasoner-composition`: invalid patch, stale hash, unsafe synthesis, unnecessary fallback.
- `target-output`: final response worse than baseline, constraint break, reveal leak, dropped user intent.
- `judge-instability`: judge disagreed with reversed labels or returned inconsistent scores.
- `environment`: provider, network, config, timeout, or artifact write problem.

Reports should list the top failing scenarios by severity and then aggregate heatmaps by card family and scenario axis.

## Integration With Existing Gates

This harness should not be part of `npm.cmd test` or `node tools\scripts\run-alpha-gate.mjs` at first. It uses real model calls, costs money, and can fail due to provider conditions.

Recommended integration stages:

1. Add the live Playwright harness and `traversal-smoke` plus `smoke` scenario pack as opt-in only.
2. Run live `smoke` after deterministic gates when provider credentials and a dedicated soak user are available.
3. Add live `traversal-core` plus `core` as a manual pre-release gate once judge stability is acceptable.
4. Promote only stable objective regressions into deterministic tests.
5. Keep the existing live SillyTavern smoke focused on host integration; this new harness owns product traversal, real model-call effectiveness, and repair-loop evidence.

## Non-Goals

The harness should not attempt to certify:

- long campaign quality;
- general writing style;
- campaign memory or durable continuity;
- private chat quality or private user data;
- external extension interaction;
- provider price or latency benchmarking beyond basic diagnostics;
- exact deterministic model output;
- user-facing UI layout or documentation renders.

Recursion is a current-scene prompt compiler. The evaluation should stay focused on card relevance, prompt synthesis, and next-response improvement.

## Acceptance Criteria

- A design doc defines the model-evaluation harness as separate from deterministic tests and live smoke.
- The process uses real provider calls for Recursion and final target responses.
- The full exercise process uses Playwright in live SillyTavern with a dedicated `recursion-soak-*` user.
- A second model performs automated card, packet, and blind final-output review.
- Functional traversal packs exercise Recursion's main controls, provider setup, storage, prompt injection, cleanup, progress, Last Brief, Full Viewer, and fail-soft paths.
- Defects produce structured defect records with severity, layer, reproduction command, expected behavior, actual behavior, and regression target.
- The repair loop requires reproduction, focused regression where possible, implementation fix, focused rerun, affected-pack rerun, and live proof when applicable.
- Synthetic scenario fixtures define oracle metadata for expected families, discouraged families, must-use facts, and forbidden reveals.
- Metrics detect repeated family bias, near-duplicate cards, irrelevant-family persistence, scope violations, composition loss, and final-output regression.
- Artifacts are written under `artifacts/model-evals/<run-id>/` and scanned for secrets before success.
- The standard full exercise evaluation requires live SillyTavern but does not use private chats.
- The CLI supports cheap smoke runs and broader core runs with explicit provider-call and cost caps.
- The harness remains opt-in until judge stability and thresholds are proven.
