# Editorial Swipe Lifecycle Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse the installed packet on a native swipe while an Editorial pass is active, without overlapping progress, stale host mutation, or new Fused provider calls.

**Architecture:** Keep SillyTavern snapshot messages on one canonical `mesid` contract. Give each active Enhancement an abort controller and an awaitable lifecycle; swipe/stop cancels and settles that lifecycle before reading the next generation snapshot. Existing packet reuse remains authoritative once the original source turn is reconstructed.

**Tech Stack:** JavaScript ES modules, Node test scripts, SillyTavern host adapter, Playwright live proof.

## Global Constraints

- Preserve current dirty-tree Editorial/schema work.
- Do not mutate `default-user` during automated proof; use a `recursion-soak-*` user.
- A cached swipe must make zero Arbiter, Fused bundle, card, or Guidance provider calls.
- A superseded Enhancement must not append a swipe, mutate selected text, or replace newer progress.

---

### Task 1: Lock the SillyTavern snapshot identifier contract

**Files:**
- Modify: `src/hosts/sillytavern/host.mjs`
- Test: `tools/scripts/test-host.mjs`

**Interfaces:**
- Produces: normalized snapshot messages with canonical numeric `mesid`.
- Consumes: native SillyTavern `mesid`, `swipe_id`, and `swipes` fields.

- [x] Add a long retention-bounded chat fixture with an assistant swipe placeholder and assert canonical `mesid` values survive `host.snapshot()`.
- [x] Run `npm.cmd run test:host` and confirm the new assertion fails against the current `mesId` shape.
- [x] Change the host snapshot shape and internal host consumers to use `mesid` consistently.
- [x] Run `npm.cmd run test:host` and confirm it passes.

### Task 2: Lock the overlapping Editorial-to-swipe sequence

**Files:**
- Modify: `src/runtime.mjs`
- Test: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Produces: active Enhancement cancellation that aborts provider work and can be awaited.
- Consumes: `prepareForGeneration({ hostGeneration: true, generationType: 'swipe' })`.

- [x] Add a deferred Editorial transformer fixture after a successful Fused preparation and native assistant landing.
- [x] Start a native swipe while the transformer is unresolved and assert the test currently observes new Fused calls or stale overlap.
- [x] Add one active Enhancement controller and lifecycle record; pass its signal to every Editorial provider call.
- [x] On swipe/stop, abort and await Enhancement cleanup before reading the host snapshot.
- [x] Guard final host mutation so aborted or superseded Editorial work cannot append or replace a swipe.
- [x] Assert packet identity is preserved, prompt is reinstalled, provider call counts do not increase, and old Enhancement progress cannot replace the swipe run.
- [x] Run `npm.cmd run test:runtime` and confirm it passes.

### Task 3: Exercise the extension event order

**Files:**
- Modify: `tools/scripts/test-extension-smoke.mjs`
- Modify only if required: `src/extension/index.js`

**Interfaces:**
- Consumes: `generation_ended`, `message_swiped`, `generation_stopped`, and the swipe generation interceptor.
- Produces: deterministic extension-level proof of cancellation-before-reuse.

- [x] Add the real SillyTavern event order with a delayed Enhancement provider.
- [x] Assert the interceptor waits for cleanup, reinstalls the previous prompt, and does not invoke Fused again.
- [x] Run `node tools/scripts/test-extension-smoke.mjs` and confirm it passes.

### Task 4: Verify the complete repair

**Files:**
- Modify if needed: `tools/scripts/prove-live-swipe-reuse.mjs`

**Interfaces:**
- Produces: focused, repository-wide, and live-host evidence.

- [x] Run `npm.cmd run test:host`, `npm.cmd run test:runtime`, and the extension smoke script.
- [x] Run `npm.cmd test`, `npm.cmd run test:alpha`, and `git diff --check`.
- [x] Sync the served Recursion extension and run the swipe-reuse Playwright proof against a dedicated `recursion-soak-*` user.
- [x] Confirm the live progress tree shows cached packet reuse with no new Fused call and no stale Enhancement mutation.
