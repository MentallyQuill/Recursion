# Failed-run resilience implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Native execution is selected under the user's standing authorization; use one independent read-only whole-branch reviewer before integration.

**Goal:** Implement the six evidence-based improvements with truthful, bounded diagnostics and correct Continue history receipts, then verify and push to main.

**Architecture:** Extend the existing profile queue, durable scheduler, journal repository, host-owned receipt guards, and compact UI. New pure normalizers own build metadata, bounded attempt/operation history, and read-only benchmark analysis; no second generation engine or recovery parser is added.

**Tech stack:** Browser ES modules, Node.js built-ins, existing SillyTavern adapter, existing offline script runner and Playwright synthetic harness. No runtime dependency is added.

**Spec:** [Failed-run resilience design](../specs/2026-10-07-failed-run-resilience-design.md).

## Global constraints

- Baseline `452f35c9a2b7534593480880f9462b513b394b85`; isolated branch `codex/failed-run-resilience`.
- Keep at most **20** operation summaries per chat, **32** stage summaries per operation, and the latest **5** attempt outcomes per stage; preserve total counters independently of truncation.
- Stage IDs are bounded to 180 characters; codes to 120; issue paths to 160; count values to 100,000; at most eight canonical field issues.
- Build metadata is schema `recursion.buildInfo.v1`, at most 2,048 characters, with lowercase SHA-256 and optional 40-character source revision; runtime identity is declared, installation verification establishes actual file agreement.
- Preserve bounded parser/correction rules, required card coverage, operation deadlines, profile identity checks, conservative concurrency, and host-owned generation authority.
- Read `DESIGN.md` and `docs/design/UI_SPEC.md` before UI changes; preserve graphite/native compact rows, disclosures, drafts, and 390px usability.
- No paid provider calls, Default User benchmark fixtures, private story data in diagnostics, or automatic live settings edits. Paid experiments require explicit dedicated-user opt-in.
- Update current contracts/docs/tests in place; do not introduce legacy migration paths or compatibility shims.

## Review focus

- A successful correction clears active failure but must retain its rejection code/field issues in bounded history: Task 2 scheduler + storage integration test.
- Two lanes sharing one profile must not bypass an existing cooldown through Retry, Stop/Resume, or rendering: Task 3 fake-clock and runtime/UI tests.
- Missing build metadata or partial timing must remain unavailable, never falsely verified or zero-duration: Tasks 1 and 7 corruption/partial-input tests.
- A late completion after Continue/swipe/chat edit must never redirect a receipt to a different target: Tasks 5 and 6 actual host/runtime race tests.
- Failure of optional diagnostic persistence must not undo a verified manifest or recursively journal the same storage error: Task 2 injected lower-level storage failure test.

## Execution order and ownership

Tasks 1–4 establish safe identity/history/status contracts. Task 5 corrects the host basis; Task 6 integrates it with runtime. Task 7 provides measurement, and Tasks 8–9 finish UI/docs/integration. Implementation is sequential because storage/runtime contracts overlap. Every task gets a real RED/GREEN cycle; baseline behavior already correct is tested and documented, not rewritten.

### Task 1: Production build identity and staging

**Files:** Create `tools/scripts/lib/production-build.mjs`, `tools/scripts/prepare-recursion-install.mjs`, `src/runtime/build-identity.mjs`, and `tools/scripts/test-build-identity.mjs`. Modify `tools/scripts/verify-installed-copy.mjs`, `src/extension/index.js`, `src/runtime.mjs`, `src/runtime/diagnostics.mjs`, and `package.json` where a CLI script improves discovery.

**Interfaces:** `productionTreeIdentity(root) -> {productionHash,files}`; `prepareRecursionInstall({repositoryRoot,outputRoot,sourceRevision,dirty,createdAt}) -> stagingReport`; `normalizeBuildIdentity(value) -> immutableDescriptor`; `createBuildIdentityReader({fetchImpl,url}) -> {load(),snapshot()}`. Runtime accepts a `buildIdentity` getter, defaulting to unavailable; entry point loads only its own `../../build-info.json` once. Status is `declared` or `unavailable`, with no generated timestamp as a build identity key.

- [x] Write tests for equal LF/CRLF text fingerprints, changed production bytes, binary changes, ignored docs/dependencies, unsafe symlink inventory, missing/oversized/invalid metadata, and input immutability. A stamp with a short/fake SHA cannot claim declared identity.

```js
assert.equal(productionTreeIdentity(lfTree).productionHash, productionTreeIdentity(crlfTree).productionHash);
assert.notEqual(productionTreeIdentity(changedTree).productionHash, productionTreeIdentity(lfTree).productionHash);
assert.equal(normalizeBuildIdentity({...validBuild,sourceRevision:'main'}).status, 'unavailable');
```

- [x] Run `node tools/scripts/test-build-identity.mjs`; observe the missing implementation or incorrect identity fail. Use temporary workspace directories and a fake HTTP response for the metadata reader; no live extension read is needed.
- [x] Implement deterministic hashing over the existing `productionFilePaths()` inventory. Generated metadata is excluded from its own hash. Staging accepts an explicit empty output directory; reject repository-root output, symlinks, and preexisting unrelated files. Source revision/dirty fields come from actual Git state at CLI time. Do not overwrite a live extension through the staging command.
- [x] Load metadata with a 2-second timeout and allowlist validation; unavailable metadata never prevents extension startup. Pass the getter into runtime diagnostics. Preserve metadata status and hash through sanitized export.
- [x] Extend installed verification to check generated metadata's production hash when present, without counting metadata itself as executable code or treating a stamp as proof of content agreement. Verify all actual code/assets with the existing byte comparisons.
- [x] Run build-identity, installed-copy-verifier, diagnostics, and extension-smoke suites. Commit `feat: identify and stage production builds` with current install instructions.

### Task 2: Bounded attempt outcomes and operation summaries

**Files:** Create `src/execution/attempt-outcomes.mjs`, `src/storage/operation-history.mjs`, and `tools/scripts/test-operation-history.mjs`. Modify `src/execution/attempt-policy.mjs`, `src/execution/checkpoints.mjs`, `src/execution/scheduler.mjs`, `src/storage.mjs`, `src/runtime/diagnostics.mjs`, and existing execution-contract/privacy/storage/diagnostics tests.

**Interfaces:** `normalizeAttemptOutcomes(values) -> atMostFiveAllowlistedOutcomes`; `attemptOutcomeFrom(summary,{attempt,window}) -> outcome`; `buildOperationSummary(manifest,{build,previous}) -> summary`; `normalizeOperationSummaries(values) -> atMostTwentySummaries`. Repository adds `saveOperationSummary(chatKey,manifest)` under the same per-chat journal serialization seam. Journal gains `operationSummaries`; no separate unbounded file or raw-response archive.

- [x] Write a scheduler + real-memory-repository test: first attempt has `RECURSION_JSON_PARSE_FAILED`, second succeeds; active failure is null and final state completed, while exported retained history contains both outcomes and one correction. Then append 500 ordinary cleanup events and reload; the operation explanation survives.

```js
assert.equal(saved.stageRecords['preprocess.guidance'].failure, null);
assert.equal(history[0].outcome, 'completed');
assert.equal(history[0].stages[0].attempts[0].code, 'RECURSION_JSON_PARSE_FAILED');
assert.equal(history[0].recoveryCounts.correctionRequests, 1);
```

- [x] Add deterministic 21-operation eviction, 33-stage truncation, six-attempt truncation, same-operation upsert, chat isolation, reset/clear, restored-interruption, optional-omission, semantic field-issue, and private/unsafe arbitrary-property tests. Assert total counters remain correct after detailed outcomes truncate.
- [x] Observe RED with `node tools/scripts/test-operation-history.mjs` before writing production normalizers.
- [x] Add `attemptOutcomes` to the current stage record/checkpoint normalization contract. Persist an allowlisted outcome in `scheduler.onAttemptSettled` before active failure is replaced/cleared. Use existing canonical issue normalization and semantic-rule enums. Accept no provider message, prompt, rationale, payload, stack, endpoint, or unknown numeric/string metadata.
- [x] After verified `savePipelineRun()`, update its summary from the persisted manifest through the journal queue. Do not hold one journal mutation while attempting another. Bound each collection on both read and write; preserve the ordinary ring and Post-process outcomes. Save summary storage failures as a nonrecursive warning without failing the already committed manifest.
- [x] Bind first-observed and latest-written build descriptors honestly; an unavailable first observation remains unavailable. Diagnostics/analyzer distinguish mixed or unavailable build identity rather than attributing every attempt to the final installed build.
- [x] Join existing operation summaries with `turn.timing.*` events by chat and `details.operationId`; retain only observed numeric/null timing fields. Cover ring rollover, late completion for an evicted ID, another chat with the same ID, and absent first-visible-token data. Unknown code values map to a fixed internal fallback or are omitted.
- [x] Run operation-history, execution-contracts, execution-privacy, execution-storage, execution-scheduler, durable-card-recovery, storage, and diagnostics suites. Commit `feat: retain bounded operation recovery history`.

### Task 3: Profile cooldown status and cross-operation verification

**Files:** Modify `src/providers.mjs`, `src/providers/profile-request-queue.mjs` only if a reproduced ownership defect needs correction, `src/runtime.mjs`, `src/ui/provider-panel.mjs`, `src/ui/progress-panel.mjs`, and `src/ui.mjs`. Extend profile-request-queue, operation-budget, runtime-preprocess, provider-panel, and rendered UI tests.

**Interfaces:** Provider client exposes `queueState(lane) -> {available,active,pending,concurrency,cooldownRemainingMs}` using the existing queue and current selected profile. Runtime `providerOperationState()` includes lane queue snapshots. `providerQueueLine(queue) -> string|null` renders fixed ordinary copy with rounded-up seconds; unavailable queue state is hidden/explicit, not a fake idle queue.

- [x] Write fake-clock tests for Utility/Reasoner sharing one profile, an independent profile, repeated Retry during cooldown, queued Stop cancellation, Resume after serialized cooldown, and old timer expiry after cancellation. Pin dispatch counts, times, budget use, and absence of segmented fan-out after a capacity failure.

```js
const controller = new AbortController();
queue.rateLimited('shared-profile', 5000);
const waiting = queue.run('shared-profile', dispatch, {signal:controller.signal});
assert.equal(dispatches, 0);
controller.abort(); clock.advance(5000);
await assert.rejects(waiting);
assert.equal(dispatches, 0);
```

- [x] Add real rendered UI tests: a 1,001-ms cooldown displays `retry in 2s`; refresh changes only the queue/progress text and preserves unsaved provider controls and disclosures. Status reads never invoke generation.
- [x] Observe RED for missing status APIs/visible copy; retain passing existing ownership tests as baseline evidence.
- [x] Expose queue state, render `Waiting for provider · retry in Ns` in the existing provider/progress surfaces, and show actual remaining operation recovery allowance. Reuse the existing UI 500-ms timer; add no poller or provider probing. Preserve Stop/Resume/Retry dispatch through the native host seam.
- [x] Run queue, attempt-policy, operation-budget, provider-panel, runtime-preprocess, UI-render/UI suites. Commit `feat: explain provider cooldown and retry waits`.

### Task 4: Cancellation descriptors, explained activity, and interrupted reload

**Files:** Modify `src/failures.mjs`, `src/activity.mjs`, `src/runtime.mjs`, `src/ui/view-model.mjs`, `src/ui/progress-panel.mjs`, and `src/runtime/diagnostics.mjs`. Extend failure-reporting, activity, host-stop-attribution, runtime-preprocess, and UI-view-model tests.

**Interfaces:** `FAILURE_CATEGORIES` adds `cancellation`; provider abort descriptor retains `RECURSION_PROVIDER_ABORTED`, `retryable:false`, and fixed cancellation message. Trusted origin enum is `recursion-stop|host-stop|operation-deadline|profile-changed|chat-changed|unknown`; it never substitutes a guess for unknown. Interrupted display derives from paused + `restored-after-reload`; manifest state remains paused.

- [x] Write RED for aborted provider failure receiving a generic connection message/category. Write RED for explained activity warnings receiving `RECURSION_ACTIVITY_REASON_MISSING`, including 121/501 spaces and unsafe text after 500 characters.

```js
const stopped = providerFailure({code:'RECURSION_PROVIDER_ABORTED'});
assert.equal(stopped.category, 'cancellation');
assert.equal(stopped.message, 'Provider request was canceled.');
assert.equal(stopped.retryable, false);
```

- [x] Test explicit failure precedence, sanitized string aliases, missing reason fallback, completion after successful correction, unknown host initiator, and late canceled provider resolution. Verify the activity consumer still renders a readable warning without requiring a fabricated failure.
- [x] Implement abort classification before generic provider matching; align activity explanations with the current journal contract and trim before bounds. Carry only trusted origins through normalization/diagnostics where supplied.
- [x] Pin existing reload behavior with actual storage/runtime fixtures: running becomes paused/interrupted, completed checkpoints preserved, unfinished tokens revoked, no model call on restore, app-closed duration not charged, and source changes produce stale instead of Resume. Add fixed interruption diagnostic/history code and neutral explicit UI text.
- [x] Run relevant failure/activity/host-stop/execution/runtime/UI tests. Commit `fix: distinguish canceled and interrupted work`.

### Task 5: Host-owned receipt basis and precise guard failures

**Files:** Modify `src/hosts/sillytavern/host.mjs`, `src/hosts/sillytavern/card-selection-history.mjs`, and `tools/scripts/test-card-selection-history.mjs`.

**Interfaces:** `messages.cardSelectionReceiptBasis({generationType}) -> {ok,generationType,chatIdentityHash,sourcePrefixHash,targetIndex,targetMessageId,targetSwipeId,previousReceipt}`; `targetMessageId` is null for appended Normal/Regenerate and numeric for an existing mutable or blank target. Every layout requires a numeric `targetSwipeId`: appended outputs bind initial swipe 0; existing targets bind the active swipe, including a native provisional Swipe slot. Save/incomplete APIs consume that binding along with the existing expected current identity. Previous receipt is deeply immutable, valid at capture, and merged only for the same deck/target during Continue.

- [x] Add the exact synthetic Continue from the spec as RED: request source basis captured before a valid continuation must save successfully. Extend the actual host fixture to assert one history position and preserved same-deck prior + current card IDs after completion/reload.
- [x] Add Normal appended response, empty placeholder, Swipe, Regenerate, missing Continue target, missing turn/deck IDs, source edit, distant source edit, active swipe switch, changed target ID, chat switch during async validation, duplicate completion, disk failure rollback, and incomplete streaming cases. Assert every stale case performs zero metadata writes.

```js
const basis = await host.messages.cardSelectionReceiptBasis({generationType:'continue'});
assert.equal(basis.targetMessageId, 1);
context.chat[1].mes += ' continued';
const expectedSourceIdentity = await host.messages.postProcessSourceIdentity();
assert.equal((await host.messages.saveCardSelectionUsage({expectedSourceIdentity,
  usage:{...usage,sourcePrefixHash:basis.sourcePrefixHash}, receiptBasis:basis})).ok, true);
```

- [x] Implement basis capture using current raw host chat and active assistant lookup; exclude only the mutable output target from receipt prefix. Do not change model-visible story snapshot or accept alternate prefix hashes as fallback. Bind exact target/chat and recheck all source/handoff/completion guards before persistence.
- [x] Split invalid receipt identity, changed prefix, and changed target reasons into the fixed codes in the spec. Return only safe hash/target metadata useful for journal diagnosis. Preserve existing host mutation validation and rollback.
- [x] Run `node tools/scripts/test-card-selection-history.mjs`, `node tools/scripts/test-host.mjs`, `node tools/scripts/test-post-process-host-writer.mjs`, and `node tools/scripts/test-post-process-host-restore.mjs`; expected PASS. Commit `fix: bind continuation history to its source prefix`.

### Task 6: Integrate immutable receipt basis with runtime completion

**Files:** Modify `src/runtime.mjs`, `tools/scripts/test-card-selection-runtime.mjs`, and relevant runtime-preprocess fixtures. Test helpers model the complete new host basis contract.

**Interfaces:** `pendingCardSelectionUsage` includes immutable `receiptBasis`; `completeCardSelectionTurn()` passes it to complete/incomplete saves and emits the precise safe guard reason/details. Main-generation source snapshot and prompt provenance remain unchanged.

- [x] Write a runtime/actual-host integration regression proving `prepareForGeneration({generationType:'continue',hostGeneration:true})` creates correct pending basis while preserving the initial assistant reply in the model source. Complete it and verify the receipt persists. The test must exercise installed runtime wiring, not call only the new host helper.
- [x] Add concurrent completion, next generation, chat switch, active-swipe edit, Stop during incomplete streaming, and altered source before completion. Assert stale work never saves into the next turn, and the first pending completion is awaited before preparing another operation.
- [x] Observe RED. Capture the host-owned basis once before primary generation; abort/skipped basis does not get replaced with a guessed snapshot prefix. Continue uses captured prior receipt only under its same-deck/target guard. Preserve existing prompt install, primary-generation, and Post-process authority.
- [x] Emit bounded diagnostic details for rejected writes, preserve unavailable completion explanation, and test that failed receipt save does not retroactively report successful narration as failed.
- [x] Run card-selection-runtime, runtime-preprocess, runtime-card-packet, refinement, host-stop, and installed extension smoke tests. Commit `fix: preserve receipt identity through completion`.

### Task 7: Read-only benchmark analysis and explicit live inputs

**Files:** Create `tools/scripts/lib/preparation-analysis.mjs`, `tools/scripts/lib/live-benchmark-options.mjs`, `tools/scripts/analyze-preparation.mjs`, `tools/scripts/test-preparation-analysis.mjs`, and `src/execution/operation-configuration.mjs`. Modify the current manifest/runtime/operation-history contracts to capture allowlisted operation settings, `tools/scripts/benchmark-preprocess-latency.mjs`, and `docs/testing/LIVE_SMOKE_TEST_PLAN.md`.

**Interfaces:** `analyzePreparationReports(reports) -> groups` uses sanitized exports only; `parseLiveBenchmarkOptions(argv,environment) -> explicitDedicatedConfiguration`. Live samples are integer 1..10; profile is explicitly selected; no hardcoded profile fallback. Existing `--live`/`validateSoakUserHandle()` protection remains.

- [x] Write RED for missing measurements incorrectly becoming zero, failed/paused operations counted as completed latency samples, mixed build/routing groups, overlapping provider durations mistaken for preparation elapsed, unsafe extra fields, unknown primary-first-token timing, and missing/invalid live inputs.

```js
const report = analyzePreparationReports([completeSample, interruptedSample, missingTimingSample]);
assert.equal(report.groups[0].preparation.samples, 1);
assert.equal(report.groups[0].preparation.medianMs, 100000);
assert.equal(report.groups[0].firstVisibleToken.samples, 0);
assert.throws(() => parseLiveBenchmarkOptions(['--live'], {RECURSION_SILLYTAVERN_USER:'default-user'}));
```

- [x] Implement finite nonnegative measurement validation, grouping by build/configuration, median/range, observed call/correction/omission/required-block counts, and explicit unavailable statistics. Ignore arbitrary input fields; output no private prose or identifiers from stories.
- [x] The analysis CLI reads explicitly provided local export paths and writes a workspace report. It makes no network calls and requires no Playwright. Validate paid mode before loading browser/session code; accept explicit sample/profile inputs and retain dedicated-user guard.
- [x] Document a reproducible 6/9-card × actual Low/Medium comparison using the same dedicated fixture/model/profile; explain that isolated Auto/Always is unavailable because Reasoner use is derived, include quality/required coverage gates, and distinguish measured versus unmeasured effects. Execute only synthetic/read-only analysis for this goal.
- [x] Run preparation-analysis, benchmark CLI guard, turn-timing, diagnostics and model-eval harness tests. Commit `feat: analyze preparation without live model calls`.

### Task 8: Clear cost helpers, current docs, and synthetic UI proof

**Files:** Modify `src/ui.mjs`, `DESIGN.md`, `docs/design/UI_SPEC.md`, `docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md`, `docs/architecture/STORAGE_AND_DIAGNOSTICS.md`, `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`, `docs/user/RECURSION_OPERATOR_MANUAL.md`, and relevant documentation index. Extend `tools/scripts/prove-card-selection-settings-ui.mjs` and rendered UI tests. Add `docs/verification/2026-10-07-failed-run-resilience.md`.

- [x] Add rendered assertions for the spec's exact target/routing/recovery helper copy, queue countdown, interrupted/canceled outcomes, and unchanged saved card target/routing/disclosures. No tests solely grepping source strings.
- [x] Implement helpers and compact status in the existing rows, preserving current settings values and autosave behavior. No new preset silently changes the user configuration; no model price/latency estimate is invented.
- [x] Update docs with declared versus verified builds, fixed history limits, clear-journal semantics, Continue receipt basis, cancellation origin, and live benchmark opt-in. Keep the original audit as dated evidence; do not rewrite its observed failure counts to include new synthetic findings.
- [x] Run desktop 1360×820 and narrow 390×844 synthetic proofs, inspect screenshots, verify tooltips-off copy, disclosure/draft persistence, keyboard usability and no horizontal overflow. Add current screenshots/results and explicit live-measurement limits to the verification report.
- [x] Commit `docs: explain recovery status and measurement` with UI changes after behavior tests pass.

### Task 9: Review, verified installation package, and main integration

**Files:** Whole branch, verification report, this plan and ignored local command logs.

- [x] Run changed-module syntax checks, focused suites, `npm.cmd test`, `npm.cmd run test:alpha`, appropriate `npm.cmd run test:browser`, and UI proof. Record failures by name and resolve before completion.
- [x] Request a fresh-context read-only whole-branch review against the spec/plan. Give exact SHAs/files and do not pass private user logs. Resolve Critical/Important findings with observed RED/GREEN regressions and rerun affected gates.
- [x] After code is committed and clean, stage a production installation package using its actual commit/build fingerprint. Verify package contents and generated metadata in a temporary synthetic installed copy. Provide exact Default User account-only verification/rollback/reload instructions; live code deployment and paid generation are not implied by staging.
- [x] Check maintained doc links, `git diff --check`, exact branch state, and plan coverage. Mark implementation steps only when verified; record unmeasured live performance separately.
- [ ] Use network-enabled GitHub CLI to confirm remote main/authentication, integrate current main without discarding other edits, verify integrated tests, and push under standing authorization. Verify remote SHA equals the tested local commit. Do not change branch protections or force-push.
- [ ] Mark the goal complete only after all scoped implementation/verification/publication steps are satisfied, and deliver spec, plan, report, install package location, and explicit live-measurement limits.

## Self-review record

The six priorities map to Tasks 1, 3, 7–8, 2, 4, and 5–6 respectively. The five Review Focus conditions have explicit owning regressions. This plan preserves the existing cooldown and reload mechanisms, distinguishes declared builds from verified installations, and uses the reproduced Continue mismatch as a bug rather than assuming the two audited warnings had that cause. Code examples distinguish current defects (in the spec) from named proposed interfaces/tests (in the plan). Every newly introduced interface has an owning task; staging and paid measurement boundaries are explicit.
