# Live Resilience and Multi-Model Utility Soak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use systematic debugging for every live failure, test-driven development for every repair, and verification-before-completion before pass claims.

**Goal:** Build and run a resumable real-model soak that exercises four requested Utility profiles across Stop/Resume, Retry Stage, forced Fused fallback, queued reprocess, and an eight-new-turn cumulative endurance chat, excluding Post-process.

**Architecture:** Keep pure qualification, counting, lifecycle, and privacy verdicts in a small contract module. Extend the existing pipeline proof with reusable browser/profile helpers, then implement one Playwright coordinator that owns a persistent synthetic chat, bounded fault injection, visible progress actions, and a sanitized checkpoint ledger. The coordinator stops at the first defect and resumes at the failed milestone after a test-first repair.

**Tech Stack:** Node.js ESM, Playwright, SillyTavern Connection Manager, repository-native assertions, PowerShell, Git.

## Global Constraints

- Use only `recursion-soak-a`; never navigate or mutate `default-user` during live proof execution.
- `default-user` may be read once to copy the single missing MiniMax M3 Connection Profile after backing up soak settings.
- Writer and Reasoner remain `nanogpt zai-org/glm-5.2:thinking - Celia V5.4`.
- Utility profiles are the four exact labels in the approved design.
- Use Auto mode, two-card budget, system/in-prompt/depth-one injection, and isolated Recursion provider policy.
- Exactly eight native new-turn generations count; the queued-reprocess swipe does not count.
- Post-process is excluded.
- No unchanged live retry, screenshots, traces, transcript text, raw provider envelopes, profile ids, or secrets in reports.
- Production synchronization remains limited to `manifest.json`, `package.json`, `src/`, `styles/`, and `assets/icons/`.
- The existing `refactor` linked worktree remains the implementation workspace.

---

### Task 1: Pure resilience matrix contract

**Files:**

- Create: `tools/scripts/lib/live-resilience-matrix-contract.mjs`
- Create: `tools/scripts/test-live-resilience-matrix-contract.mjs`
- Modify: `tools/scripts/run-tests.mjs`

**Interfaces:**

- Produces `qualifyUtilityProfiles(profiles, preferredFusedLabel) -> { ok, assignments, errors }`.
- Produces `inspectLifecycleMilestone(kind, evidence) -> { ok, errors, summary }`.
- Produces `inspectEnduranceLedger(ledger) -> { ok, errors, acceptedNewTurns }`.
- Produces `sanitizeResilienceReport(value) -> redacted clone`.

- [ ] **Step 1: Write failing qualification and assignment tests**

  Cover four safe labels, Segmented-ready requirements, preferred Fused assignment, fallback to the first Fused-ready requested profile, duplicate labels, missing models, and genuine incompatibility records.

- [ ] **Step 2: Run the contract test and confirm RED**

  Run: `node tools/scripts/test-live-resilience-matrix-contract.mjs`

  Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement qualification and assignment**

  Return stable error codes such as `profile-missing`, `profile-not-segmented-ready`, and `no-fused-ready-profile`. Assign exactly one requested profile to each of `stop-resume`, `retry-stage`, `fused-fallback`, and `queued-reprocess`.

- [ ] **Step 4: Add failing lifecycle verdict tests**

  Require:

  - Stop/Resume: one host stop, paused manifest, one native resume start, zero detached pre-callback calls, fresh frontier signal, completed operation.
  - Retry Stage: failed blocking Arbiter, visible retry action, same operation id, attempt increment, no upstream duplicate, completed operation.
  - Fused fallback: requested Fused, completed Fused directive, exhausted bounded invalid attempts, only unresolved Segmented stages, Arbiter checkpoint reuse, completed host turn.
  - Queued reprocess: one queued frontier, zero immediate calls, one native swipe, one intent consumption, upstream reuse, downstream rerun, no duplicate operation.

- [ ] **Step 5: Implement lifecycle verdicts and confirm GREEN**

  Run: `node tools/scripts/test-live-resilience-matrix-contract.mjs`

- [ ] **Step 6: Add endurance and privacy tests**

  Require eight unique accepted new-turn ids in one chat, all four profiles appearing twice, monotonic counts, distinct turn hashes, no paused/stale/running terminal state, and a non-counting swipe record. Seed forbidden values under `message`, `prompt`, `request`, `response`, `connectionProfileId`, `secret-id`, `reasoning`, `chat`, and `packet` and prove they are redacted.

- [ ] **Step 7: Implement endurance/privacy helpers and run affected tests**

  Run:

  ```powershell
  node tools/scripts/test-live-resilience-matrix-contract.mjs
  node tools/scripts/test-execution-privacy.mjs
  npm.cmd run test:runtime
  ```

- [ ] **Step 8: Commit**

  ```powershell
  git add tools/scripts/lib/live-resilience-matrix-contract.mjs tools/scripts/test-live-resilience-matrix-contract.mjs tools/scripts/run-tests.mjs
  git commit -m "test: define resilience soak contract"
  ```

### Task 2: Reusable live profile and browser helpers

**Files:**

- Modify: `tools/scripts/prove-live-pipelines.mjs`
- Modify: `tools/scripts/test-live-pipeline-proof.mjs`

**Interfaces:**

- Produces `selectUtilityProfileByLabel(page, label, timeoutMs)` returning only safe label/model metadata.
- Produces `certifyUtilityProfile(page, timeoutMs)` returning bounded certification/capability evidence.
- Exports the existing root, power, mode, pipeline, injection, deck, send, diagnostics, and snapshot helpers required by the coordinator.

- [ ] **Step 1: Add RED tests for exact safe-label matching**

  Reject partial ambiguous matches, empty labels, profile-id input, and absent profiles. Prove only Utility configuration changes and Reasoner remains unchanged.

- [ ] **Step 2: Run RED**

  Run: `node tools/scripts/test-live-pipeline-proof.mjs`

- [ ] **Step 3: Implement the smallest exports and Utility-only selector/certifier**

  Profile lookup may inspect ids internally but returns no ids. Certification accepts `pass` or `partial` for Segmented qualification and exposes whether `fusedCards` passed.

- [ ] **Step 4: Verify**

  ```powershell
  node tools/scripts/test-live-pipeline-proof.mjs
  npm.cmd run test:settings
  npm.cmd run test:providers
  node tools/scripts/test-profile-certification.mjs
  ```

- [ ] **Step 5: Commit**

  ```powershell
  git add tools/scripts/prove-live-pipelines.mjs tools/scripts/test-live-pipeline-proof.mjs
  git commit -m "test: expose utility profile soak helpers"
  ```

### Task 3: Resumable coordinator and persistent synthetic chat

**Files:**

- Create: `tools/scripts/prove-live-resilience-matrix.mjs`
- Create: `tools/scripts/test-live-resilience-matrix.mjs`
- Modify: `tools/scripts/run-browser-tests.mjs`
- Modify: `package.json`

**Interfaces:**

- CLI: `node tools/scripts/prove-live-resilience-matrix.mjs --live --state <safe-json-path>`.
- Checkpoint schema: `recursion.liveResilienceMatrix.v1` with run id, safe profile labels, assignments, current milestone, accepted new-turn records, swipe records, defect record, and completion status.

- [ ] **Step 1: Add RED CLI/source-contract tests**

  Require `--live`, a dedicated `recursion-soak-*` user, exactly four configured labels, a safe state path under `artifacts/live-resilience-matrix`, no Post-process import/call, and no screenshot/trace API.

- [ ] **Step 2: Run RED**

  Run: `node tools/scripts/test-live-resilience-matrix.mjs`

- [ ] **Step 3: Implement preflight, checkpoint loading, and persistent chat creation**

  Create or reopen one synthetic chat, record only chat id/hash/counts, and refuse a ledger whose user, branch SHA, profile labels, or chat identity differs.

- [ ] **Step 4: Implement profile qualification loop and dynamic assignment**

  Select and certify each Utility profile sequentially. Persist safe results after each profile so a later repair does not repeat completed qualification calls.

- [ ] **Step 5: Implement stop-at-first-defect behavior**

  Emit `pass`, `fail`, `environment-fail`, `stale-extension`, or `model-incompatible`; never advance the ledger after a failed verdict.

- [ ] **Step 6: Verify dry-run and safety behavior**

  ```powershell
  node tools/scripts/test-live-resilience-matrix.mjs
  npm.cmd run test:live-harness
  npm.cmd run test:browser
  ```

- [ ] **Step 7: Commit**

  ```powershell
  git add tools/scripts/prove-live-resilience-matrix.mjs tools/scripts/test-live-resilience-matrix.mjs tools/scripts/run-browser-tests.mjs package.json
  git commit -m "test: add live resilience matrix runner"
  ```

### Task 4: Stop/Resume and Retry Stage live drivers

**Files:**

- Modify: `tools/scripts/prove-live-resilience-matrix.mjs`
- Modify: `tools/scripts/test-live-resilience-matrix.mjs`

- [ ] **Step 1: Add RED driver tests with a fake Playwright page**

  Prove selectors use visible progress actions by exact accessible labels, wait for the current operation/stage, and capture only bounded evidence.

- [ ] **Step 2: Implement Stop/Resume driver**

  Wait for a current provider stage, click `Stop and pause this operation`, verify paused persistence/prompt cleanup, click `Resume from saved checkpoint`, and wait for the native host callback plus assistant continuation.

- [ ] **Step 3: Implement one-shot Arbiter response corruption**

  Route only the first current-operation Utility Arbiter response after the real server response completes. Substitute bounded invalid JSON client-side, restore the route, click `Retry this step`, and prove the same operation resumes.

- [ ] **Step 4: Verify**

  ```powershell
  node tools/scripts/test-live-resilience-matrix.mjs
  node tools/scripts/test-live-resilience-matrix-contract.mjs
  node tools/scripts/test-runtime-preprocess.mjs
  node tools/scripts/test-progress.mjs
  npm.cmd run test:ui
  ```

- [ ] **Step 5: Commit**

  ```powershell
  git add tools/scripts/prove-live-resilience-matrix.mjs tools/scripts/test-live-resilience-matrix.mjs
  git commit -m "test: drive live stop resume and retry"
  ```

### Task 5: Forced Fused fallback and queued reprocess drivers

**Files:**

- Modify: `tools/scripts/prove-live-resilience-matrix.mjs`
- Modify: `tools/scripts/test-live-resilience-matrix.mjs`

- [ ] **Step 1: Add RED Fused fault-window tests**

  Require real server completion for each targeted bundle request, zero-useful client substitution for only the configured attempt window, and automatic route restoration before Segmented fallback calls.

- [ ] **Step 2: Implement and verify the Fused fallback driver**

  Set Reasoner off, request Fused, inject the bounded bundle fault, then require explicit fallback directive, unresolved-only Segmented stages, Hand 2, prompt installation, and native continuation.

- [ ] **Step 3: Add RED queued-reprocess tests**

  Require completed-stage action lookup by exact label, zero immediate provider calls after queueing, one native swipe, and one-time intent consumption.

- [ ] **Step 4: Implement and verify queued reprocess**

  Use `Reprocess from here on the next swipe`, trigger one native swipe, and assert upstream checkpoint reuse plus downstream rerun within one owning operation.

- [ ] **Step 5: Run affected suites**

  ```powershell
  node tools/scripts/test-live-resilience-matrix.mjs
  node tools/scripts/test-runtime-preprocess.mjs
  node tools/scripts/test-pipeline-fused.mjs
  node tools/scripts/test-queued-reprocess.mjs
  node tools/scripts/test-progress.mjs
  ```

- [ ] **Step 6: Commit**

  ```powershell
  git add tools/scripts/prove-live-resilience-matrix.mjs tools/scripts/test-live-resilience-matrix.mjs
  git commit -m "test: drive fused fallback and reprocess"
  ```

### Task 6: Endurance driver and final report

**Files:**

- Modify: `tools/scripts/prove-live-resilience-matrix.mjs`
- Modify: `tools/scripts/test-live-resilience-matrix.mjs`

- [ ] **Step 1: Add RED eight-turn ledger tests**

  Seed four completed resilience turns and prove the runner schedules exactly four additional ordinary turns in preferred profile order. Reject stale packet reuse, changed chat identity, non-monotonic counts, and any ninth generation.

- [ ] **Step 2: Implement rotating endurance turns**

  Re-select and recertify each Utility profile, append one unique synthetic continuation, require two-card/current-prompt/native-writer success, and checkpoint after each accepted turn.

- [ ] **Step 3: Implement bounded final report**

  Include profile qualification summaries, milestone verdicts, accepted turn ids/hashes/counts, one non-counting swipe record, retention counts, parity SHA, and defect summaries. Run `sanitizeResilienceReport` before writing or printing.

- [ ] **Step 4: Verify**

  ```powershell
  node tools/scripts/test-live-resilience-matrix.mjs
  node tools/scripts/test-live-resilience-matrix-contract.mjs
  node tools/scripts/test-execution-privacy.mjs
  npm.cmd run test:browser
  ```

- [ ] **Step 5: Commit**

  ```powershell
  git add tools/scripts/prove-live-resilience-matrix.mjs tools/scripts/test-live-resilience-matrix.mjs
  git commit -m "test: certify rotating utility endurance"
  ```

### Task 7: Preflight and safely add MiniMax M3 to the soak user

**Files:**

- Read: `F:\SillyTavern\SillyTavern\data\default-user\settings.json`
- Backup/modify: `F:\SillyTavern\SillyTavern\data\recursion-soak-a\settings.json`
- Verify: installed and public `Recursion-refactor` copies

- [ ] **Step 1: Run full deterministic preflight**

  ```powershell
  npm.cmd test
  npm.cmd run test:alpha
  npm.cmd run test:browser
  ```

- [ ] **Step 2: Verify exact profile inventory by safe label/model**

  Abort if any of the three existing soak profiles is missing or ambiguous.

- [ ] **Step 3: Back up soak settings and clone only MiniMax M3**

  Copy the complete matching profile object from default to soak with a newly generated profile id only if no equivalent MiniMax model/profile exists. Preserve all other soak settings and never write default-user.

- [ ] **Step 4: Reparse settings and prove one MiniMax match, unchanged writer/Reasoner labels, old Recursion disabled, and refactor enabled**

- [ ] **Step 5: Synchronize approved production surfaces and prove 86-file parity**

  Run `verify-installed-copy.mjs` with explicit installed/public roots.

### Task 8: Execute qualification and eight-turn repair loop

**Files:**

- Execute: `tools/scripts/prove-live-resilience-matrix.mjs`
- Persist: sanitized checkpoint/report beneath `artifacts/live-resilience-matrix/`

- [ ] **Step 1: Qualify all four Utility profiles**

  Run the coordinator with a 300-second per-boundary timeout. Stop on the first failed profile, diagnose persisted safe errors, add a deterministic RED regression, repair, verify, redeploy if production changed, and resume.

- [ ] **Step 2: Complete Stop/Resume**

  Count the resumed native new turn only after the complete lifecycle verdict passes.

- [ ] **Step 3: Complete Retry Stage**

  Count only the native new turn produced by the repaired same-operation retry.

- [ ] **Step 4: Complete forced Fused fallback**

  Count only the host turn that finishes after explicit Fused-to-Segmented fallback.

- [ ] **Step 5: Complete queued reprocess**

  Count the preceding ordinary new turn; record the settled native swipe separately without incrementing the turn counter.

- [ ] **Step 6: Complete four rotating endurance turns**

  Stop immediately when accepted new-turn count reaches eight.

### Task 9: Final verification and closeout

**Files:**

- Verify: all changed source, tests, documentation, installed copy, public copy, and sanitized reports

- [ ] **Step 1: Run focused regressions, full suite, alpha gate, and browser suite**

- [ ] **Step 2: Repeat storage isolation and 86-file source/install/public parity**

- [ ] **Step 3: Scan diffs and reports for unfinished markers, credential-like values, profile ids, raw prompt/chat text, and forbidden artifact keys**

- [ ] **Step 4: Inspect `git diff --check`, clean status, local HEAD, remote `refactor` SHA through network-enabled GitHub CLI, and deployed parity separately**

- [ ] **Step 5: Report qualifications, assignments, eight accepted new-turn ids, swipe evidence, repaired defects, exact test results, and remaining Post-process scope**

  Do not push, merge, or open a pull request unless separately requested.
