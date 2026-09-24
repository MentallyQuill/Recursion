# Intelligent Card Selection Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the core integration and superpowers:dispatching-parallel-agents for independent host/UI work. Steps use checkbox syntax for tracking.

**Goal:** Ship need-based Auto arbitration, Low default variety, and optional strict card cooldown.
**Architecture:** Pure deterministic selection policy over ranked family/authored candidates; source-ID eligibility projected into both generators. Completed-response receipts live with host message/swipe metadata, with branch-validated history supplied before bounded context. Existing durable snapshots/checkpoints freeze each turn's selection input.
**Tech Stack:** Native JavaScript ES modules, Node assert script tests, existing DOM settings and Playwright harness.
**Spec:** ../specs/2026-09-23-card-selection-variety-design.md

## Global Constraints
- cardSelection.variety: off | low | medium | high, default low.
- cardSelection.cooldownTurns: integer 0 through 10, default 0.
- Auto only. All runnable Priority cards mandatory in deck order.
- Strict cooldown; shortages produce smaller hands. No extra model calls.
- Never edit the running SillyTavern installation or the concurrent main checkout.
- Reuse checkpoints on same-turn retries/swipes; record usage only after completed host response.

## Review Focus
- One Priority source must not restore cooled siblings in a generated family: policy and runtime tests.
- Branch edits outside provider context must invalidate downstream receipts: full-chat host test.
- A provider returning only cooled or duplicate candidates must not trigger endless empty-refresh repair: runtime test.
- Stop/error completion events and repeated events must not record phantom use: completion integration test.
- Settings changes and resume must preserve correct source identity and selected hand: runtime/cache tests.

## Task 1: Selection policy and settings
Files: create src/card-selection.mjs and tools/scripts/test-card-selection.mjs; modify src/pre-process-decks.mjs and src/settings.mjs.
Interfaces: normalizeCardSelectionSettings(value); cardSelectionEligibility(settings, history) returns excluded rows and allowed IDs; selectCardCandidates(candidates, {slots,variety,seed}) returns selected/omitted/variety metadata. Transient `cardSelectionExcludedIds` in runtime-only settings filters eligible deck sources, never saved card state. Source cards honor optional per-job sourceCardIds; Priority always restored.
- [ ] Add failing tests with Node assert, e.g. `assert.deepEqual(normalizeCardSelectionSettings(), {variety:'low',cooldownTurns:0})`; assert cooldown boundaries and Manual/Priority exemptions.
- [ ] Run `node tools/scripts/test-card-selection.mjs` and confirm missing policy fails.
- [ ] Implement normalization, source eligibility and deterministic ranked selection. Derive seeded draw from hashJson; Low replacement probability .25 and next-two window; Medium .5/next-four; High 1/all; at most one final-slot replacement.
- [ ] Sweep 200 fixed seeds: both retained and changed Low hands occur; first N-1 candidates remain equal; same input produces equal output; duplicate coverage cannot occupy two optional slots.
- [ ] Run policy, settings and pre-process deck suites.

## Task 2: Host receipts and branch history (independent host worker)
Files: src/hosts/sillytavern/host.mjs, new src/hosts/sillytavern/card-selection-history.mjs, tools/scripts/test-card-selection-history.mjs, and relevant host tests.
Interfaces: host.messages.saveCardSelectionUsage({expectedSourceIdentity,usage}); usage includes turnKeyHash, sourcePrefixHash, deckId, cards:[{cardId,categoryId,reason}], generationType. Snapshot adds cardSelectionHistory and cardSelectionSourcePrefixHash. History rows include response identity and cards, including empty rows for completed responses without receipts.
- [ ] Add tests proving persistence, full-prefix and target-text verification, active swipe behavior and deletion/edit invalidation before implementing.
- [ ] Reuse required chat save and mutation rollback. Store receipt in message and selected swipe extras. Preserve/rebind receipts through editorial replacements/swipes. Reject stopped/aborted/unfinished streamed targets.
- [ ] Run new history and host suites; verify repeated writes are idempotent and no raw story bodies are stored in receipts.

## Task 3: Arbiter/runtime integration
Files: src/runtime.mjs, src/cards.mjs, provider schemas if needed, tools/scripts/test-card-selection-runtime.mjs, tools/scripts/test-runtime.mjs.
Interfaces: consume policy/settings and host snapshot fields; store branch-validated history in durable snapshot artifact. Use filtered settings only for card scope and card generation; original settings continue to determine contracts and provider policy.
- [ ] Add failing runtime fixture: previous selected source on cooldown, sibling eligible, Priority exempt; intercept Fused and Segmented prompts to verify excluded text never enters either.
- [ ] Preserve history on normalized snapshots and durable restore. Include selection settings in prepared signatures and increment card selection contract.
- [ ] Add turn-needs and recent-selection context to arbiter prompt. Extend normalized jobs to sourceCardIds/cardId, need and coverageKey. Ask for ranked useful alternatives beyond capacity without demanding slots be filled.
- [ ] Enforce eligibility, deduplicate coverage, select seeded candidates after Priority reservations, reconcile mandatory work and restrict authored hand insertion to selected IDs. Preserve selection reasons and omissions in hand diagnostics.
- [ ] Permit genuine empty eligible hands to compose/skip cleanly. All nonempty mandatory coverage remains enforced.
- [ ] Arm usage only on successful host-owned prepared result; settle completed response via host writer; clear on failure/Stop; duplicate events cannot advance usage. Persist IDs from actual installed sourceCards, never infer entire families.
- [ ] Run runtime, cards, checkpoints, prepared-generation and new integration suites. Add successive-turn fixtures for changed needs, history and deterministic resume.

## Task 4: Settings and documentation (independent UI worker)
Files: src/ui.mjs, tools/scripts/test-ui.mjs, tools/scripts/test-settings.mjs, DESIGN.md, docs/design/UI_SPEC.md, docs/user/RECURSION_OPERATOR_MANUAL.md.
Interfaces: nested settings.cardSelection from Task 1; controls `Selection variety` (Off/Low/Medium/High) and `Card cooldown (turns)` (0..10). Existing save path persists both together and preserves other settings.
- [ ] Add failing settings interaction tests for default Low/0 and editing to Medium/2, normalization, and Manual explanatory copy.
- [ ] Implement compact rows next to card budgets, tooltips and plain helper text; no extra bar badge. Show concise selection/cooldown information in existing inspection content if supported there.
- [ ] Update design/operator documentation with exact defaults, scope, strict shortage behavior and Priority exemption.
- [ ] Run settings/UI suites and capture browser settings evidence on desktop/narrow width.

## Task 5: Review, integrate and push
- [ ] Review spec coverage and diff; have a fresh reviewer inspect lifecycle, source filtering, randomness and replay boundaries while the full suite runs.
- [ ] Fix findings with targeted red/green tests. Run `npm.cmd test` and required browser checks.
- [ ] Fetch main using network permission; integrate concurrent main changes in this isolated branch, without touching the user's dirty checkout. Re-run affected/full suite after integration.
- [ ] Stage only feature files; create scoped commits; push HEAD:main using network permission. Verify remote SHA. Mark goal complete only after successful push and report tests and limitations.

## Execution ledger
- Spec and plan written before implementation; user explicitly granted all approvals including push to main.
- Clean isolated baseline: 83 offline scripts pass after npm ci --ignore-scripts.
- Ruling: use source-ID cooldown but retain family-slot generation budgets; generated siblings remain individually eligible and Priority restoration is source-scoped.
- Ruling: split independent host persistence and UI work while the primary agent implements policy/runtime; no overlapping file ownership.
