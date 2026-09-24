# Card Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship mandatory, bounded recursive refinement for marked pre-process cards and push verified changes to main.

**Architecture:** Add a fourth participation state and pure refinement contracts. Insert checkpointed prepare/review/revise/verify/final-hand stages between selection and Guidance only when Refinement is enabled. Keep transport retries distinct from semantic rounds and preserve authored instructions.

**Tech Stack:** Existing JavaScript ES modules, JSON-schema provider contracts, Node assertion scripts, existing browser harness and CSS/SVG.

**Spec:** `docs/superpowers/specs/2026-09-24-card-refinement-design.md`

## Global Constraints

- No new dependencies, model profiles, persistent character memory, or prose rewrite stages.
- Refinement forces inclusion in both Auto and Manual; it may expand mandatory capacity.
- One required semantic review, at most one revision and one verification review.
- Saved authored text is unchanged; final scene applications remain source-bound.
- Required incomplete/rejected refinement blocks prompt installation and narration.
- User approved all implementation and main push; do not ask again.
- Work only in the isolated card-refinement worktree; preserve the dirty main checkout.

## Review Focus

- Two marked facets sharing one family need two verdicts but one replacement body (Task 2).
- A marked authored card must produce a scene application without changing the saved instruction (Tasks 2/3).
- Cancellation after review must resume without repeating accepted earlier stages (Task 3).
- A refined packet reused on a swipe must become stale after card-state or text changes (Task 3).
- Manual mode and bulk reset must preserve clear participation semantics (Task 1).

## Task 1: Participation, compact UI, and product documentation

**Files:** `src/pre-process-decks.mjs`, `src/ui.mjs`, `styles/recursion.css`, `DESIGN.md`, `docs/design/UI_SPEC.md`, `docs/design/CARD_SYSTEM_SPEC.md`, `docs/technical/CARD_DECK_AND_HAND.md`, `tools/scripts/test-pre-process-decks.mjs`, `tools/scripts/test-ui.mjs`.

**Interfaces:** Preserve `cardSelectionState`, `nextCardSelectionState`, and existing eligibility functions; extend them to `refinement`. Export `isMandatoryCardState(state)` if needed, with true for priority/refinement. Existing source-card and authored-card projections retain selectionState. Runtime derives refinement targets from `getActiveCardDeck(settings)` and selected hand lineage.

- [x] Add a failing cycle/persistence test, e.g. `assertEqual(nextCardSelectionState({selectionState:'priority'}, 'auto'), 'refinement')`; run `node tools/scripts/test-pre-process-decks.mjs` and observe the intended failure.
- [x] Extend normalization, ordering, eligibility, forced families/IDs, duplication, default overrides and counts. Cover Manual refinement mandatory IDs while normal priority retains existing Manual behavior.
- [x] Update the existing eye control and accessibility labels; add a compact SVG eye/arrow icon and state-specific styling. Add UI interaction checks for full Auto and Manual cycles, default/custom deck persistence, counts, and bulk reset.
- [x] Update design and operator contracts in place. Run deck/UI tests. Commit scoped files after tests pass.

## Task 2: Pure refinement contracts and provider schemas

**Files:** create `src/card-refinement.mjs`, `tools/scripts/test-card-refinement.mjs`; modify `src/providers.mjs` and focused provider tests only.

**Interfaces:** Implement the exact exports and schemas in the spec: collectRefinementTargets, buildRefinementRequest, validateRefinementResult, applyRefinementDraft, finalizeRefinementHand. Provider roles `cardRefinementDraft` and `cardRefinementReview` use the existing Reasoner lane and strict schema limits.

- [x] Write a failing target-coverage test using a hand result with `sourceCardIds:['focus-a','focus-b']` and two marked source cards; expect two targets mapped to one runtime card.
- [x] Implement target selection and draft/review request builders with frozen scene and peer-card evidence; authored prepare requests contain only authored result IDs, revise requests contain only affected IDs and actual review findings.
- [x] In red/green increments test unknown, duplicate, missing IDs; stale snapshot; unsupported evidence; empty findings on revise; findings on accept; unsafe and oversized draft text; family replacement; unchanged preservation; original authored instruction retention.
- [x] Register roles, schemas and request bounds without adding another provider configuration. Run `node tools/scripts/test-card-refinement.mjs` and relevant provider scripts. Commit scoped files after tests pass.

## Task 3: Durable runtime loop and truthful progress

**Files:** `src/runtime.mjs`, new `src/runtime/card-refinement-stages.mjs`, `src/progress.mjs`, relevant execution summary/registry files only as needed, `tools/scripts/test-runtime-preprocess.mjs`, new focused stage tests, `tools/scripts/test-progress.mjs`.

**Interfaces:** `createCardRefinementStages({settings, snapshot, snapshotHash, generate})` returns five stage definitions; export `REFINED_HAND_STAGE_ID`. Each stage depends on the previous checkpoint and initial hand/snapshot; final artifact is an accepted hand. No targets means no extra stages or calls. Summaries are owned inside the stage module.

- [x] Add a failing runtime test selecting a marked generated card; scripted provider returns accept and test asserts a review call precedes Guidance.
- [x] Add bounded static stage definitions with conditional local no-op for unnecessary preparation/revision/verification. Provider failures retain classification and block. Every mandatory target is validated, all artifact hashes participate in freshness, second-review revise produces `RECURSION_REFINEMENT_UNRESOLVED`.
- [x] Wire Guidance and packet to the accepted refined hand, including final Last Brief and prepared-generation storage. Preserve default no-refinement graph and same-turn reuse semantics.
- [x] Add red/green runtime cases for generated family, authored application, revise/verify, failure blocking install, cancellation/resume and deck-state invalidation in both pipeline modes. Ensure no silent direct-authored bypass.
- [x] Add concise progress labels and counts/outcomes with no raw prompt text in summaries. Show final refinement metadata in existing Viewer metadata surfaces.
- [x] Run focused runtime, stage, progress, privacy and provider tests; commit scoped changes after they pass.

## Task 4: Integration, review, and main push

- [x] Run `npm.cmd test` in the isolated worktree; fix failures with targeted red/green checks.
- [x] Run an isolated browser render of the card-state cycle and progress state; inspect screenshot/accessibility labels without changing the running host.
- [x] Request fresh spec and code review of all changes, including cross-task contracts and malformed-output/replay boundaries. Fix actionable findings and rerun affected tests plus full suite for final code.
- [x] Verify `git diff --check`, scoped commit history, clean worktree, and latest origin/main. Integrate remote changes if needed and rerun full tests after integration.
- [x] Push `HEAD:main` without force and verify GitHub SHA using network-enabled `gh`.

## Execution ledger

- Design and plan created from approved in-chat design; native isolated worktree starts at `73ff268b`.
- Ruling: use explicit checkpointed rounds rather than a graph cycle; scheduler requires an acyclic graph and each completed round must resume independently.
- Ruling: separate pure contracts, UI/deck changes, and runtime integration as disjoint work units. Parallel workers may own Tasks 1 and 2; root owns Task 3 and integration. Review the integrated result before pushing.
- Tasks 1-3 implemented and focused tests pass. Mandatory source lineage survives deck and hand projection without the former 32-ID truncation.
- Review fixes: preserve provider transport classification; explicit semantic Retry restarts review through a validated strict-ancestor declaration; Manual forced IDs preserve Refinement deck order; progress outcomes remain visible without tooltips.
- Runtime integration covers Fused/Segmented revision, authored preparation, two facets sharing one result, refusal/unresolved blocking, explicit Retry, cancellation/Resume, swipe reuse, fresh turns, deck text/state invalidation, and Manual mandatory overflow.
- Final merged offline suite passed all 102 scripts, including scheduler, runtime, privacy, contracts, UI, and progress tests. No live provider quality claim is made.
- Isolated browser renders verify the 15px eye-arrow state and desktop/mobile layouts without touching the running host. Progress renders identified the visible outcome correction above.
- Two independent reviews completed; all findings addressed. Global revision rounds and revised-card counts are distinct, with a two-result regression.
- Concurrent main changes through `432253b3` were merged at `6d662038`, preserving Post-process writer/review, card-budget behavior, and complete-message context. The one design-text conflict retains both features. Combined runtime/cache/selection contract versions were incremented to prevent stale reuse.
- Post-merge independent review and isolated desktop/mobile state/progress browser checks passed with no JavaScript errors. Pushed implementation `e8ec3e8b888c9ef59e2ed9d2b692506cfef5ec02` to main and verified that exact GitHub branch SHA; this final ledger update changes documentation only.
