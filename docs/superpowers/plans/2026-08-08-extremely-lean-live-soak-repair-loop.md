# Extremely Lean Live Soak Repair Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task. Use `superpowers:systematic-debugging` for every unexpected result, `superpowers:test-driven-development` for every code repair, and `superpowers:verification-before-completion` before any pass claim.

**Goal:** Repair the live-pipeline harness defect that expanded Manual scope, then earn exactly three fresh accepted SillyTavern host generations across Manual/Segmented, Auto/Segmented, and genuine Auto/Fused with the approved real-model configuration.

**Architecture:** Extend the existing `prove-live-pipelines.mjs` proof path instead of creating a parallel runtime or soak framework. Make its scenario contract explicit (mode, two-family Manual scope, two-card hand, unique message), expose only small pure helpers for deterministic tests, and enrich its current-run assertions enough to distinguish genuine Fused execution from fallback. Keep deployment and preflight as explicit operator commands using the repository's existing verifier and guarded SillyTavern harness.

**Tech Stack:** Node.js ESM, repository-native assertion helpers, Playwright, SillyTavern live harness, PowerShell, Git.

## Global Constraints

- Execute in the existing `refactor` linked worktree; do not create another worktree.
- Preserve the approved three-accepted-generation budget. Failed attempts and repair retests do not count.
- Never repeat a failed real-model attempt unchanged.
- Never mutate `default-user`; use only `recursion-soak-a`.
- Do not persist raw model requests, responses, reasoning, credentials, connection-profile ids, or transcript prose.
- Synchronize only `manifest.json`, `package.json`, `src/`, `styles/`, and `assets/icons/`.
- Stop at the first failing milestone, repair it test-first, resynchronize, and rerun that same boundary.
- Do not add compatibility shims; Recursion is pre-alpha.

---

### Task 1: Establish the deterministic baseline and reproduce the harness defect

**Files:**

- Read: `tools/scripts/prove-live-pipelines.mjs`
- Read: `tools/scripts/test-live-pipeline-proof.mjs`
- Read: `src/runtime.mjs`
- Read: `tools/scripts/test-runtime.mjs`
- Test: `tools/scripts/test-live-pipeline-proof.mjs`

1. Record branch, HEAD, remote tracking state, and dirty files with `git status -sb`, `git rev-parse HEAD`, and `git rev-parse --abbrev-ref --symbolic-full-name @{u}`.
2. Run the focused deterministic baseline:

   ```powershell
   npm.cmd run test:runtime
   node tools/scripts/test-live-pipeline-proof.mjs
   npm.cmd run test:live-harness
   ```

   Expected: all pass before the new regression is added.
3. Add a failing assertion to `test-live-pipeline-proof.mjs` requiring a Manual fixture helper to leave exactly the requested two families active and every other family off. Also require the default Auto fixture path not to rewrite the user's deck selection.
4. Run `node tools/scripts/test-live-pipeline-proof.mjs`.

   Expected RED: the helper/export is missing or the current activate-every-card behavior violates the expected scope.

### Task 2: Repair and harden live scenario configuration

**Files:**

- Modify: `tools/scripts/prove-live-pipelines.mjs`
- Modify: `tools/scripts/test-live-pipeline-proof.mjs`
- Test: `tools/scripts/test-runtime.mjs`

1. Add `--mode auto|manual` and `--families "Scene Frame,Open Threads"` parsing. Reject Manual without exactly two known families and reject family overrides in Auto.
2. Replace `ensureRunnableDeckFixture`'s blanket activation with a deterministic fixture transform:
   - Manual: activate exactly the requested two families and turn all others off.
   - Auto: preserve the existing active deck; only create/use a runnable fallback when the deck has no active cards.
3. Update the live setup through `runtime.updateSettings` to set `mode`, `minCards: 2`, and `maxCards: 2` together with the fixture deck.
4. Export the pure fixture helper and test exact active/off state, argument validation, and preservation of Auto selections.
5. Extend the live snapshot/report with bounded evidence only: configured mode, requested families, plan job families/count, hand families/count, pipeline mode/reason codes, stage role/status counts, and prompt metadata hashes/lengths.
6. Make Manual assertions require exactly two plan jobs, two dispatched card roles, two hand families, and no out-of-scope family. Keep existing prompt and native-host assertions.
7. Run:

   ```powershell
   node tools/scripts/test-live-pipeline-proof.mjs
   npm.cmd run test:runtime
   npm.cmd run test:cards
   npm.cmd run test:live-harness
   npm.cmd run test:settings
   npm.cmd run test:providers
   ```

   Expected GREEN: all pass.
8. Commit the focused repair:

   ```powershell
   git add tools/scripts/prove-live-pipelines.mjs tools/scripts/test-live-pipeline-proof.mjs
   git commit -m "fix: preserve manual soak scope"
   ```

### Task 3: Add genuine-Fused and privacy verdicts

**Files:**

- Modify: `tools/scripts/test-live-pipeline-proof.mjs`
- Modify: `tools/scripts/prove-live-pipelines.mjs`
- Test: `tools/scripts/test-execution-privacy.mjs`

1. Add RED tests for a pure current-run verdict helper:
   - Segmented accepts no more than two ordinary card stages.
   - Fused requires one successful `fusedCardBundle` stage/request.
   - Fused rejects downgrade reason codes or ordinary card-stage starts.
   - Any `running`, failed, duplicate, stale, or late-mutating current-run stage rejects the milestone.
2. Run `node tools/scripts/test-live-pipeline-proof.mjs` and confirm the new tests fail for the missing verdict helper.
3. Implement the smallest pure verdict helper and feed it only current-operation diagnostics exported after the unique host send.
4. Add a report sanitizer test proving forbidden key/value classes do not survive report construction.
5. Run:

   ```powershell
   node tools/scripts/test-live-pipeline-proof.mjs
   node tools/scripts/test-execution-privacy.mjs
   npm.cmd run test:runtime
   ```

   Expected GREEN: all pass.
6. Commit:

   ```powershell
   git add tools/scripts/prove-live-pipelines.mjs tools/scripts/test-live-pipeline-proof.mjs
   git commit -m "test: certify live pipeline verdicts"
   ```

### Task 4: Run the full preflight and deploy the exact checkout

**Files:**

- Verify: repository production files
- Deploy: `F:\SillyTavern\SillyTavern\data\recursion-soak-a\extensions\Recursion-refactor`
- Deploy: `F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion-refactor`

1. Run `npm.cmd test` and `npm.cmd run test:alpha`.
2. Run the guarded soak-user storage preflight against `http://127.0.0.1:8000` with `recursion-soak-a`.
3. Confirm port 8000 has a listener and the user directories exist. Confirm the old `third-party/Recursion` is disabled for the soak user.
4. Copy only the approved production surfaces from this worktree to the installed and public `Recursion-refactor` roots. Preserve all unrelated user data.
5. Run `verify-installed-copy.mjs` with explicit `--installed-root` and `--public-root`.
6. Open the dedicated user through the live harness and prove the active writer, Utility, and Reasoner labels match the approved profiles.
7. Run bounded Utility and Reasoner certification through the existing Recursion provider UI/runtime surface. Require the effective lane used by milestone 3 to report Fused-ready.
8. If any preflight item fails, classify and repair it before spending a host generation.

### Task 5: Earn accepted generation 1 — Manual plus Segmented

**Files:**

- Execute: `tools/scripts/prove-live-pipelines.mjs`
- Record: sanitized console JSON captured by the operator session only

1. Run one fresh Manual/Segmented proof with `--mode manual --pipeline segmented --placement in_prompt --depth 1 --families "Scene Frame,Open Threads"` and a timeout adequate for sequential real-model calls.
2. Require all Milestone 1 contracts from the approved design: exactly two scoped/dispatched/accepted families, current snapshot/operation identity, three prompt blocks at system/in-prompt/depth-one, outbound inclusion, one new native assistant response, and no stranded or adverse stage.
3. On failure, freeze bounded evidence, write a deterministic RED regression, make one focused repair, run affected tests, redeploy/parity-check, and rerun this same milestone. Do not advance or count the failed attempt.
4. On pass, record accepted generation count as `1/3`.

### Task 6: Earn accepted generation 2 — Auto plus Segmented

**Files:**

- Execute: `tools/scripts/prove-live-pipelines.mjs`

1. Run a fresh Auto/Segmented proof with a distinct unique scenario message and the same two-card/injection settings.
2. Require at most two plan/card stages, durable per-card Segmented artifacts, balanced start/terminal stage transitions, exercised configured lanes where policy requires them, three outbound prompt blocks, one native assistant response, and no hidden failure/stale/duplicate state.
3. Apply the same RED-fix-verify-deploy-retest loop to any failure before advancing.
4. On pass, record accepted generation count as `2/3`.

### Task 7: Earn accepted generation 3 — genuine Auto plus Fused

**Files:**

- Execute: `tools/scripts/prove-live-pipelines.mjs`

1. Reconfirm current Fused-ready certification immediately before the attempt.
2. Run a fresh Auto/Fused proof with a third unique scenario message.
3. Require effective Fused mode, exactly one successful `fusedCardBundle` current-run provider stage, no downgrade/fallback and no ordinary Segmented card-stage starts, two unique current-snapshot accepted cards, prompt installation/outbound inclusion, and one native assistant response.
4. Treat any fallback as a failed milestone and repair target. Apply the same test-first loop before rerunning.
5. On pass, record accepted generation count as `3/3` and stop live generation.

### Task 8: Final verification and closeout

**Files:**

- Update if needed: `docs/superpowers/specs/2026-08-08-extremely-lean-live-soak-repair-loop-design.md`
- Verify: all changed production and test files

1. Run focused tests for every repaired defect, then `npm.cmd test` and `npm.cmd run test:alpha`.
2. Repeat source/installed/public parity verification.
3. Search changed files and bounded reports for secrets, profile ids, raw request/response fields, transcript prose, and unfinished-work markers.
4. Inspect `git diff --check`, `git status -sb`, local HEAD, tracking SHA, and remote ref state separately.
5. Commit any remaining verified implementation/docs changes. Do not push or merge unless separately requested.
6. Report the three accepted run ids and contracts, all discovered defects and regressions, exact test results, parity result, and remaining explicitly excluded soak scope.
