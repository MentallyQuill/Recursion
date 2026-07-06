# Injection Placement Live Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove both Recursion injection placements across Standard, Rapid, and Fused using actual SillyTavern prompt-store metadata and outbound generation payloads.

**Architecture:** Extend `prove-live-pipelines.mjs` with a placement matrix and one sanitized prompt-store inspector. Keep outbound request inspection in the shared live harness helper. Tests exercise parsing and placement metadata before browser implementation.

**Tech Stack:** Node.js ESM, Playwright, SillyTavern extension prompt API, existing assertion helpers.

---

### Task 1: Define placement matrix arguments

**Files:**
- Modify: `tools/scripts/test-live-pipeline-proof.mjs`
- Modify: `tools/scripts/prove-live-pipelines.mjs`

- [x] Add failing tests for `--placement` and `--placements`, including rejection of unsupported values.
- [x] Run `node tools/scripts/test-live-pipeline-proof.mjs` and confirm the new assertions fail.
- [x] Export and implement placement argument parsing with defaults `in_prompt,in_chat`.
- [x] Rerun the focused test and confirm it passes.

### Task 2: Prove stored placement, depth, and role

**Files:**
- Modify: `tools/scripts/test-live-pipeline-proof.mjs`
- Modify: `tools/scripts/prove-live-pipelines.mjs`

- [x] Add a failing unit test for a validator that accepts three Recursion prompt entries only when position, depth, and role match the selected settings.
- [x] Run the focused test and confirm the validator is absent or fails.
- [x] Implement a sanitized prompt-store evidence collector and validator.
- [x] Select `{ injection: { placement, role: 'system', depth } }` through the visible settings controls before each generation and wait for settings convergence.
- [x] Attach stored evidence to each proof row and fail closed on mismatch.

### Task 3: Execute and document the live matrix

**Files:**
- Modify: `docs/testing/TESTING_STRATEGY.md`

- [x] Run `node tools/scripts/test-live-harness.mjs` and `node tools/scripts/test-live-pipeline-proof.mjs`.
- [x] Run `prove-live-pipelines.mjs --live --pipelines standard,rapid,fused --placements in_prompt,in_chat --depth 4` against a dedicated soak user.
- [x] Confirm all six rows report the requested placement, three valid stored blocks, configured depth/role, and `systemInjected: true` outbound evidence.
- [x] Update testing documentation with the matrix contract and run `git diff --check`.
