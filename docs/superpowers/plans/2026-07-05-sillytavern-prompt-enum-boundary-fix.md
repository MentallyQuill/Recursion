# SillyTavern Prompt Enum Boundary Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Recursion prompt blocks use valid numeric SillyTavern metadata and reach the final chat-completion request.

**Architecture:** The SillyTavern adapter owns numeric fallback constants for the host's documented prompt types and roles. Installation verifies the shared live prompt store when available, while the live harness verifies both stored metadata and outbound content.

**Tech Stack:** JavaScript ES modules, Node.js assertion scripts, SillyTavern extension API, Playwright live harness.

---

### Task 1: Reproduce the live context contract

**Files:**
- Modify: `tools/scripts/test-host.mjs`
- Modify: `src/hosts/sillytavern/host.mjs`

- [ ] Add a host test whose context exposes `setExtensionPrompt` and `extensionPrompts`, but no enum maps. Its setter must mirror SillyTavern by storing `Number(position)` and `Number(role)`.
- [ ] Assert install succeeds and stores positions `0` and roles `0` for the three default blocks.
- [ ] Run `npm.cmd run test:host` and confirm the new assertion fails because the stored values are `NaN`.
- [ ] Add numeric fallback maps matching SillyTavern's public enums: prompt types `NONE=-1`, `IN_PROMPT=0`, `IN_CHAT=1`, `BEFORE_PROMPT=2`; roles `SYSTEM=0`, `USER=1`, `ASSISTANT=2`.
- [ ] Run `npm.cmd run test:host` and confirm it passes.

### Task 2: Reject false-positive installation

**Files:**
- Modify: `tools/scripts/test-host.mjs`
- Modify: `src/hosts/sillytavern/host.mjs`

- [ ] Add a failing test whose setter stores malformed non-numeric metadata in `extensionPrompts` without throwing.
- [ ] Assert `prompt.install()` fails and rolls back known Recursion keys.
- [ ] Run `npm.cmd run test:host` and confirm the malformed-store test fails before implementation.
- [ ] Validate exact stored text plus finite numeric position and role after every write when `context.extensionPrompts` exists; throw `RECURSION_PROMPT_INSTALL_REJECTED` on mismatch so the existing rollback executes.
- [ ] Run `npm.cmd run test:host` and confirm both live-shape and rejection tests pass.

### Task 3: Strengthen live boundary proof and documentation

**Files:**
- Modify: `tools/scripts/lib/sillytavern-live-harness.mjs`
- Modify: `docs/technical/HOST_INTEGRATION_MANUAL.md`
- Modify: `docs/testing/TESTING_STRATEGY.md`

- [ ] Change harness prompt seeding and recording to use numeric metadata and inspect `context.extensionPrompts` for finite position/role values.
- [ ] Capture the final `/api/backends/chat-completions/generate` request during generation and assert its message content contains `Guidance:`, `Private Recursion card evidence`, and `Guardrails:`.
- [ ] Document that setter calls are insufficient proof and that live verification requires serialized request content.
- [ ] Run `npm.cmd run test:live-harness`, focused prompt/host tests, then the full test and alpha gates.
- [ ] Sync changed served extension files and run guarded live generation proof against a `recursion-soak-*` user.
