# Stabilized Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the audited alpha.2 provider/pipeline candidate into `refactor`, repair every proven boundary regression, and certify source-to-SillyTavern parity.

**Architecture:** Treat the extracted candidate as a donor and `refactor` as authority. Transplant only project-owned changes, then use focused TDD to harden response normalization, per-slot batch settlement, Fused failure identity, and release truth before full and live verification.

**Tech Stack:** JavaScript ES modules, Node.js test scripts, SillyTavern extension APIs, Playwright/live proof scripts, PowerShell/robocopy, Git/GitHub CLI.

## Global Constraints

- Target branch and worktree: `refactor` in `F:\git\Recursion\.worktrees\resumable-pipeline-execution`.
- Donor: `C:\Users\Keptin\AppData\Local\Temp\recursion-zip-audit-45550368841346fb9ad0672b80060ccb\Recursion`.
- Do not import `node_modules`, nested baselines, archives, transient artifacts, or the candidate stabilization review/old plan.
- V1 is Connection Profile-only; do not retain direct provider/API-key compatibility.
- Preserve unrelated user work and all SillyTavern user data.
- Visible UI remains governed by `DESIGN.md` and `docs/design/UI_SPEC.md`.
- Production fixes require a focused test that is observed failing first.
- Luna Max owns implementation; it must return only status, files changed, checks plus results, and blockers/decisions.

---

### Task 1: Build the controlled donor patch

**Files:**
- Modify: candidate-changed project files under `src/`, `styles/`, `tools/scripts/`, `docs/`, `README.md`, `package.json`, `manifest.json`, and lock metadata when tracked
- Preserve: `DESIGN.md` unless the provider UI violates its existing contract
- Exclude: `node_modules/`, `docs/reviews/2026-08-07-stabilization-pass.md`, `docs/superpowers/plans/2026-08-06-recursion-model-pipeline-robustness.md`

**Interfaces:**
- Consumes: the extracted candidate and clean `refactor` worktree
- Produces: a reviewable source-tree transplant with no generated/vendor payload

- [ ] **Step 1: Reconfirm clean target and donor provenance**

Run `git status --short`, `git rev-parse HEAD`, and compute the donor ZIP SHA-256. Expected: clean target at `b4256f203dacd23c69707a6b26c640ed10046659` and donor hash `B83D3171EC84574429C63EB083442263DE6BEC192D5D1FA5C3DA2BDA7FD3E4E6`.

- [ ] **Step 2: Copy only controlled project paths**

Use a deterministic copy/filter operation. Do not copy `.git`, `node_modules`, nested `refactor`, archives, coverage, screenshots, or temporary output.

- [ ] **Step 3: Inspect the resulting name-status and diff summary**

Run `git status --short` and `git diff --stat`. Expected: only repository-owned integration files plus this design and plan.

### Task 2: Normalize real SillyTavern Claude structured responses

**Files:**
- Modify: `src/providers/provider-response-normalizer.mjs`
- Modify: `tools/scripts/test-provider-response-parser.mjs`
- Modify or create: provider response fixture(s) used by that test

**Interfaces:**
- Consumes: SillyTavern Claude content blocks such as `{ type: "tool_use", input: { ...schema payload... } }`
- Produces: `normalizeProviderEnvelope(value) -> { text, structured, ... }` with the tool `input` exposed as structured data

- [ ] **Step 1: Add the real Claude tool-input fixture and assertion**

Assert that `content[].input` containing a valid Recursion schema returns non-null `structured` data and does not become an empty response.

- [ ] **Step 2: Run `node tools/scripts/test-provider-response-parser.mjs` and record RED**

Expected: failure because the candidate ignores `content[].input`.

- [ ] **Step 3: Implement the smallest normalizer repair**

Recognize object-valued tool input without weakening schema validation or exposing raw hidden content.

- [ ] **Step 4: Re-run the focused test and record GREEN**

Expected: all response parser cases pass.

### Task 3: Settle Segmented batch slots independently

**Files:**
- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-providers.mjs` or the focused candidate batch test registered by `tools/scripts/run-tests.mjs`

**Interfaces:**
- Consumes: ordered provider requests where individual calls may resolve or reject
- Produces: an ordered result array in which each non-abort rejection is represented as that slot's normalized failure

- [ ] **Step 1: Add a mixed-success batch regression**

Use at least two requests: one resolves and one throws `slot exploded`. Assert the batch resolves, preserves order, retains the successful sibling, and emits one failure slot.

- [ ] **Step 2: Run the focused provider test and record RED**

Expected: the outer `Promise.all` rejects the complete batch.

- [ ] **Step 3: Implement per-slot settlement**

Convert request-local rejection into the same stable failure envelope used by ordinary provider failures. Preserve operation-level abort behavior.

- [ ] **Step 4: Re-run the focused test and record GREEN**

Expected: mixed batch resolves with one success and one failure.

### Task 4: Preserve provider failure identity across Fused fallback

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-pipeline-fused.mjs`
- Modify: `tools/scripts/test-execution-attempt-policy.mjs` when needed to assert downstream directives

**Interfaces:**
- Consumes: Fused provider results and stable provider failure descriptors
- Produces: original provider codes for failed transport/provider calls; `RECURSION_FUSED_ZERO_USEFUL_CARDS` only for successful zero-card parsing

- [ ] **Step 1: Add focused failure-boundary cases**

Cover context-limit, structured-output-unsupported, rate-limit/transient, and successful zero-useful-card outcomes. Assert only the final case receives `RECURSION_FUSED_ZERO_USEFUL_CARDS`.

- [ ] **Step 2: Run the focused Fused/attempt-policy tests and record RED**

Expected: at least one provider code is masked by the synthetic zero-card code.

- [ ] **Step 3: Move provider-failure handling ahead of zero-useful validation**

Keep partial valid-card retention and Segmented fallback behavior unchanged while passing original descriptors to the attempt policy.

- [ ] **Step 4: Re-run focused tests and record GREEN**

Expected: all failure identities and fallback outcomes match the design.

### Task 5: Make alpha.2 release truth enforceable

**Files:**
- Modify: `src/storage.mjs`
- Modify: `README.md`
- Modify: `docs/DOCUMENTATION_INDEX.md`
- Create: `docs/release/0.2.0-alpha.2.md`
- Modify: normative provider/user/technical documents transplanted by Task 1
- Modify: `tools/scripts/test-alpha-gate.mjs`
- Modify: `tools/scripts/run-alpha-gate.mjs` only if the new checks must be registered

**Interfaces:**
- Consumes: package, manifest, runtime/storage, release-index, and normative documentation state
- Produces: one `0.2.0-alpha.2` release contract and a gate that detects drift

- [ ] **Step 1: Add release-consistency and forbidden-guidance assertions**

Assert exact alpha.2 agreement, presence of the alpha.2 release note/index entry, absence of normative direct API-key setup, and registration of the Claude/batch regression tests.

- [ ] **Step 2: Run `node tools/scripts/test-alpha-gate.mjs` and record RED**

Expected: failure on the alpha.1 storage/release drift and/or missing coverage assertions.

- [ ] **Step 3: Update version and normative documentation**

Describe Connection Profile-only setup, profile certification, generation-policy/sampler separation, Segmented/Fused capability, and the corrected failure behavior. Remove stale alpha.1 and direct-key claims rather than adding compatibility notes.

- [ ] **Step 4: Re-run the alpha-gate unit and record GREEN**

Expected: all release-truth checks pass.

### Task 6: Verify the integrated source tree

**Files:**
- Modify only if verification finds a regression, always with a new RED test first

**Interfaces:**
- Consumes: final uncommitted source tree
- Produces: deterministic evidence suitable for independent review

- [ ] **Step 1: Run focused regression scripts**

Run the provider response parser, provider batch, Fused pipeline, attempt policy, and alpha gate tests. Expected: all pass.

- [ ] **Step 2: Run production-module syntax checks**

Run the repository's module check or `node --check` across production `.mjs` modules. Expected: zero syntax failures.

- [ ] **Step 3: Run `npm test`**

Expected: every registered offline script passes with zero failures.

- [ ] **Step 4: Run `npm run test:alpha`**

Expected: release, documentation, test, and Playwright-readiness gates pass.

- [ ] **Step 5: Inspect `git diff --check`, `git diff --stat`, and status**

Expected: no whitespace errors, no generated/vendor files, and no unrelated work.

### Task 7: Independent review, commit, push, and live synchronization

**Files:**
- Source commit: all verified files from Tasks 1-6
- Installed production copy: `F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion-refactor`
- Public served copy: `F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion-refactor`

**Interfaces:**
- Consumes: independently reviewed source tree
- Produces: pushed `origin/refactor` commit and byte-equivalent production copies

- [ ] **Step 1: Run a read-only independent review against the design and this plan**

Expected: no release-blocking finding; any finding is repaired under TDD and re-reviewed before continuing.

- [ ] **Step 2: Stage the exact reviewed scope and commit**

Use a concise Conventional Commit describing the provider/pipeline integration. Do not include `.codex` runtime history unless it was already a tracked project artifact required by policy.

- [ ] **Step 3: Re-run the full offline suite on committed HEAD**

Expected: `npm test` and `npm run test:alpha` exit zero.

- [ ] **Step 4: Synchronize production files only**

Copy `manifest.json`, `package.json`, `src/`, `styles/`, and production assets/icons to the installed and public `Recursion-refactor` roots. Do not delete or overwrite SillyTavern user data, settings, chats, or unrelated extensions.

- [ ] **Step 5: Verify installed/public parity**

Run `node tools/scripts/verify-installed-copy.mjs` with explicit source, installed, and public roots. Expected: exact production-file parity and alpha.2 manifest identity.

- [ ] **Step 6: Run browser/live loading proof**

Run `npm run test:browser` or the narrower live extension smoke against the running SillyTavern host. Expected: `Recursion-refactor` is served, loads without startup errors, and exposes the integrated provider surface.

- [ ] **Step 7: Push `refactor` and verify remote SHA**

Use `git push origin refactor`, then GitHub CLI with network permission to confirm `origin/refactor` resolves to the committed SHA.
