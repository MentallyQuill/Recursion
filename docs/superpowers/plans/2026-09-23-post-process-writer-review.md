# Post-process Writer and Review Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for integration and
> superpowers:dispatching-parallel-agents for the independent bounded tasks below.
> Steps use checkboxes for tracking.

**Goal:** Ship the approved Post-process writer, editing scopes, deck style, and
source-bound review workflow, verify it, and push scoped changes to main.

**Architecture:** Keep guidance structured and prose transport separate. Extend the
existing host writer entry point, persist comparison records through the existing
repository, and coordinate review/commit/retry through a focused controller that
uses existing source guards and host mutation receipts.

**Tech Stack:** Native JavaScript ES modules, Node assert-based tests, SillyTavern
Connection Manager and native quiet generation, Playwright.

**Spec:** ../specs/2026-09-23-post-process-writer-review-design.md

## Global Constraints

- Worktree: C:/Users/Keptin/.codex/worktrees/post-process-writer/Recursion.
- Branch: codex/post-process-writer. Preserve unrelated files and non-force main integration.
- User approved the design and explicitly waived further approval requests.
- Polish defaults; native writer defaults; Unified recommended; As Swipe defaults.
- Brief/sample limits: 2000/6000 characters; reject oversized user input.
- Profile output override: integer 256..65536; null inherits selected profile.
- No JSON requirements for prose, no silent fallback, no main profile mutation.
- Source/hash/character/group/turn identity must guard every mutation and retry.
- At most ten retained completed comparisons per chat; pending review is protected.
- Use existing native visual contracts and keep secrets/raw prose out of diagnostics.

## Review Focus

1. A profile is edited mid-run: stop reuse instead of silently changing writer (Task 2).
2. Review approval races source edits or a second click: one guarded mutation (Task 4).
3. Replace succeeds but receipt persistence fails: marker reconciliation prevents duplication (Task 4).
4. Original data expires or storage fills: do not offer unsafe restore/retry (Tasks 3, 4).
5. Host change events from selecting/restoring a revision: never recurse into generation (Tasks 4, 5).

## Task 1: Settings, deck style, and editing instructions

**Files:** src/settings.mjs, src/post-process-decks.mjs,
src/post-process-guidance.mjs, new src/post-process-editing.mjs;
tools/scripts/test-settings.mjs, test-post-process-decks.mjs,
new tools/scripts/test-post-process-editing.mjs.

**Produces:**
- normalizePostProcessWriter(value) -> { mode, connectionProfileId, maxOutputTokens,
  samplerMode, samplerOverrides: { temperature, topP } }.
- normalizePostProcessEditingScope(value) -> polish|revise.
- normalizePostProcessStyle(value) -> { styleBrief, styleSample }; throws for oversized fields.
- buildPostProcessEditingInstructions({editingScope,styleBrief,styleSample}) -> string.
- settings.postProcess includes writer, editingScope, reviewBeforeApplying.
- Deck normalization/copy/export/import preserves styleBrief/styleSample.

- [x] Add one behavior test at a time, run RED, implement, run GREEN.
  Example: settings configured with a profile retains that profile through store update;
  exporting and importing a deck retains its brief and sample.
  Code pattern: assert.equal(normalizeRecursionSettings(input).postProcess.writer.connectionProfileId, 'prose');
- [x] Apply the editing instructions to guidance requests, including ordered precedence.
  Test: buildPostProcessGuidanceRequest({editingScope:'polish',styleBrief:'Short sentences',...})
  retains the brief and dialogue-preservation boundary.
- [x] Update Follow Through wording to prohibit introducing unperformed actions.
- [x] Run node tools/scripts/test-post-process-editing.mjs, test-settings.mjs,
  test-post-process-decks.mjs, test-post-process-guidance.mjs. Expected: PASS.
- [x] Include owned files in the reviewed integration commit.

## Task 2: Isolated profile prose transport

**Files:** src/hosts/sillytavern/host.mjs, optional focused profile-writer helper,
new tools/scripts/test-post-process-profile-writer.mjs.

**Consumes:** The plain writer config from Task 1; transport tests supply literal
config, so this task has no source dependency on Task 1.
**Produces:** host.generation.resolvePostProcessWriter(writer) -> frozen effective
writer { mode, connectionProfileId, model, label, maxOutputTokens, samplerMode,
samplerOverrides, profileFingerprint }; native resolves {mode:'native',label:...}.
host.generation.rewriteWithPostProcess({writer,guidancePacket,writerDirective,signal,timeoutMs})
returns existing normalized writer result, plus safe writer metadata.

- [x] RED test: a profile rewrite dispatches through the selected Connection Manager
  profile and does not invoke native context.generate or mutate main settings.
  Assert captured transport arguments and actual returned text.
- [x] Implement profile resolution, output-budget inheritance, request-local samplers,
  secrets, text-completion formatting, and pre-dispatch fingerprint validation.
- [x] Incremental RED/GREEN cases: empty result, provider error, known truncation,
  missing profile/output limit, invalid overrides, changed profile, abort, late completion.
- [x] Native path remains unchanged when writer is absent/native.
- [x] Run node tools/scripts/test-post-process-profile-writer.mjs,
  test-post-process-host-writer.mjs, test-host.mjs. Expected: PASS.
- [x] Include owned files in the reviewed integration commit.

## Task 3: Durable comparison storage

**Files:** src/storage.mjs, new src/post-process-comparison.mjs,
new tools/scripts/test-post-process-comparison.mjs.

**Produces:** repository.savePostProcessComparison(chatKey,record),
loadPostProcessComparison(chatKey,id), listPostProcessComparisons(chatKey),
deletePostProcessComparison(chatKey,id), clearPostProcessComparisons(chatKey).
Record fields: schema, id, operationId, revisionId, chatKey, originalSnapshot,
candidateText, candidateHash, targetIdentity, writer, editingScope, applyMode,
state (pending/applied/rejected/stale), retryInputs, receipt, createdAt, updatedAt.

- [x] RED: save a pending record, recreate repository over the same adapter, load
  exact original/candidate and immutable source identity.
- [x] Add indexed bounded storage with content integrity checks and per-chat ordering.
- [x] RED/GREEN retention: eleven completed records evict the oldest; a pending record
  survives; stale retryInputs are removed; clear/reset deletes bodies but not host messages.
- [x] Integrate repair, retention budgets, diagnostics exclusions, and chat/turn cleanup.
- [x] Run node tools/scripts/test-post-process-comparison.mjs, test-storage.mjs,
  test-execution-privacy.mjs, test-diagnostics.mjs. Expected: PASS.
- [x] Commit scoped files after review.

## Task 4: Runtime routing and guarded review actions

**Files:** src/post-process-runtime.mjs, src/runtime.mjs,
new src/post-process-review.mjs, necessary host message helpers,
tools/scripts/test-post-process-runtime.mjs,
new tools/scripts/test-post-process-review.mjs.

**Consumes:** Tasks 1-3 interfaces.
**Produces:** runtime.postProcessComparisons(), runtime.reviewPostProcess({id,action,text}),
where actions are apply, keep, edit, retry; review actions return {ok,reason,comparison}
without exposing bodies in the ordinary runtime diagnostics view.

- [x] RED: selected profile config and full frozen draft/evidence reach the writer;
  scope/style are preserved across Unified/Progressive and recreation.
- [x] Resolve writer once, include configuration in provenance, and preserve draft whole.
- [x] RED: reviewBeforeApplying persists candidate, releases controls, and never calls commit.
- [x] Implement separate candidate/review settlement with source guard, serial action
  ownership, fresh signals, deterministic receipts, and no active deadline while waiting.
- [x] RED/GREEN: apply twice creates one swipe; edit changes candidate hash; keep
  restores only owned applied text; source edits/new turns block mutations.
- [x] RED/GREEN: retry starts from original, writer-only changes reuse matching guidance,
  scope/style/card changes regenerate it, Progressive later guidance follows new earlier draft.
- [x] RED/GREEN: applied host marker reconciles lost receipts; storage failure preserves source.
- [x] Run node tools/scripts/test-post-process-review.mjs, test-post-process-runtime.mjs,
  test-runtime.mjs, test-runtime-preprocess.mjs, test-extension-smoke.mjs. Expected: PASS.
- [x] Commit reviewed runtime integration.

## Task 5: Native controls and comparison UI

**Files:** src/ui.mjs, new src/ui/post-process-review.mjs,
src/extension/index.js, styles, UI tests and Playwright fixture/proof.

**Consumes:** normalized settings, deck edit helpers, comparison API from Task 4.
**Produces:** Writer/scope/review controls, brief/sample editor, source message action,
and keyboard-accessible comparison with highlighted/clean views and guarded buttons.

- [x] Read DESIGN.md and docs/design/UI_SPEC.md immediately before visible changes.
- [x] RED: rendered controls expose writer/profile and scope; changes persist through
  actual event handlers; readonly starter supports copy-to-custom style editing.
- [x] Implement compact controls with Advanced output/sampling and explicit context copy.
- [x] RED/GREEN: comparison escapes HTML, handles large diff with bounded fallback,
  preserves scroll/focus, allows manual editing and source-bound actions.
- [x] Bind Compare revision to the exact message, not merely the most recent record.
- [x] Browser proof at desktop/narrow sizes exercises automatic and review-first modes,
  keep/apply/edit/retry, stale targets, and reloaded pending review.
- [x] Run node tools/scripts/test-ui.mjs and focused comparison browser proof.
  Expected: PASS with inspected rendered artifacts.
- [x] Commit UI and associated design/examples.

## Task 6: Documentation, integration proof, final review, and main push

**Files:** README.md, docs/architecture/POST_PROCESS_CARDS_RUNTIME.md,
docs/design/UI_SPEC.md, DESIGN.md, user docs, examples, verification report.

- [x] Update current writer ownership, scopes, style fields, retry, review and retention
  docs coherently; remove conflicting sole-native-writer statements.
- [x] Execute npm.cmd test and npm.cmd run test:browser. Expected: exit 0.
- [x] Exercise native/profile host generation and settlement using isolated test
  data/configuration; inspect request routing, output, Stop, and resulting swipe.
- [x] Capture only sanitized proof and UI fixtures; never publish live narrative/secrets.
- [x] Fresh whole-branch review against the spec, fix material findings with RED/GREEN,
  and audit all eleven verification items in the spec with actual evidence.
- [x] Use network-enabled gh CLI to inspect remote/auth, fetch current main, integrate
  without disturbing unrelated checkout state, push scoped commits non-force to main.
- [ ] Verify remote main contains the final commit and relevant checks. Only then
  mark the goal complete.

## Execution ledger

Ledger: .superpowers/sdd/2026-09-23-post-process-writer-review/progress.md.
Pre-flight: Task 1 and Task 2 share only the literal writer shape; they own distinct
files. Task 3 owns storage independently. Task 4 waits for contracts/transport/storage;
Task 5 waits for review API. All final integration, staging, and pushes are serialized.

Final merged verification: 97 offline scripts and 4 browser scripts pass. See
`../../technical/POST_PROCESS_WRITER_REVIEW_EVIDENCE.md` for the evidence audit.
