# Post-process Lifecycle and Native Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make valid SillyTavern generation completion reliably start visible, stoppable Post-processing and settle every terminal lifecycle branch.

**Architecture:** Normalize SillyTavern's scalar `generation_ended` count at the host boundary, retain explicit object message ids, and make assistant-landed cleanup unconditional. Reuse the existing Post-process control lock, unified abort path, activity model, and native quiet writer rather than adding parallel UI state.

**Tech Stack:** JavaScript ES modules, SillyTavern host APIs/events, custom Node test scripts, Playwright live harness.

## Global Constraints

- Recursion is pre-alpha; update the V1 contract in place without compatibility shims.
- Native Stop remains visible from guidance synthesis through rewrite and final commit.
- Recursion extends native Stop ownership only when Post-process Cards is enabled and a valid operation is pending/running.
- SillyTavern remains the prose writer through `context.generate("quiet")`.
- Progress and diagnostics remain privacy-safe.
- Existing user-owned work must be preserved.

---

### Task 1: Normalize the SillyTavern terminal event

**Files:**
- Modify: `src/hosts/sillytavern/host.mjs`
- Test: `tools/scripts/test-host.mjs`

**Interfaces:**
- Consumes: `normalizeSillyTavernMessageEvent(event, { eventName, context })`
- Produces: normalized `generation_ended` details whose `messageId` is the latest assistant id for scalar count payloads

- [ ] **Step 1: Write the failing host regression test**

Add a fixture with `chat.length === 3`, latest assistant `mesid === 2`, and:

```js
const normalizedGenerationEnded = normalizeSillyTavernMessageEvent(3, {
  eventName: 'generation_ended',
  context: { chat }
});
assertEqual(normalizedGenerationEnded.messageId, 2, 'generation-ended chat length binds to latest assistant id');
assertEqual(normalizedGenerationEnded.latestAssistant, true, 'generation-ended count identifies latest assistant');
```

Also prove `{ mesid: 7 }` remains `7`.

- [ ] **Step 2: Run the host test and verify RED**

Run: `npm.cmd run test:host`

Expected: fail because the scalar payload remains `3`.

- [ ] **Step 3: Implement terminal-event normalization**

In `normalizeSillyTavernMessageEvent`, detect
`eventName === "generation_ended"` plus a scalar payload. Use
`latestAssistant.mesid ?? latestAssistant.index` as `messageId`. Preserve
explicit object ids.

- [ ] **Step 4: Run the host test and verify GREEN**

Run: `npm.cmd run test:host`

Expected: pass.

### Task 2: Settle invalid assistant-landed branches

**Files:**
- Modify: `src/extension/index.js`
- Test: `tools/scripts/test-extension-smoke.mjs`

**Interfaces:**
- Consumes: normalized assistant-landed details and `postProcessFinalTargetReady`
- Produces: one terminal cleanup on valid, invalid, duplicate, and skipped branches

- [ ] **Step 1: Write failing lifecycle tests**

Add a real-shape scalar terminal event:

```js
const landed = eventSource.emit('generation_ended', fake.context.chat.length);
await landed;
assertEqual(runCalls, 1, 'SillyTavern chat-length terminal event starts Post-process once');
```

Add an invalid-target case that asserts:

```js
await eventSource.emit('generation_ended', { mesid: 999 });
assertEqual(activeRuntime.view().hostGenerationActive, false, 'invalid terminal target settles host generation state');
```

- [ ] **Step 2: Run the smoke test and verify RED**

Run: `node tools/scripts/test-extension-smoke.mjs`

Expected: at least the invalid-target cleanup assertion fails.

- [ ] **Step 3: Make cleanup unconditional**

Refactor the pending Post-process branch so target validation and optional
Post-processing return an outcome, then invoke `handleHostGenerationEnded`
before returning on every terminal path. Keep finalization-claim and duplicate
event protections intact.

- [ ] **Step 4: Run the smoke test and verify GREEN**

Run: `node tools/scripts/test-extension-smoke.mjs`

Expected: pass.

### Task 3: Prove full-window native Stop and visible progress

**Files:**
- Modify: `tools/scripts/test-extension-smoke.mjs`
- Modify: `tools/scripts/test-post-process-runtime.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify if required by RED evidence: `src/extension/index.js`
- Modify if required by RED evidence: `src/post-process-runtime.mjs`
- Modify if required by RED evidence: `src/progress.mjs`
- Modify if required by RED evidence: `src/ui/view-model.mjs`

**Interfaces:**
- Consumes: `host.generation.lockControls`, Post-process activity, unified stop path
- Produces: native Stop ownership and Hero Pixel Array state for the complete operation

- [ ] **Step 1: Write failing timing and progress assertions**

Gate guidance synthesis and assert control events contain `lock` before the
first guidance call and no `unlock` until final commit. Trigger
`generation_stopped` during guidance and during quiet rewrite; assert the
AbortSignal is aborted and no swipe/replacement is committed.

Build a view while Post-process guidance is gated:

```js
const runningView = live.runtime.view();
const runningProgress = createProgressRunModel(runningView);
assert(runningProgress.steps.some((step) => step.state === 'running'), 'Post-process exposes running progress');
assert(createHeroPixelBlocks(runningProgress).some((block) => block.state === 'running'), 'Post-process exposes running pixels');
```

After release, assert Post-process steps and pixels are terminal `done`.

- [ ] **Step 2: Run focused tests and verify RED or existing contract**

Run:

```powershell
node tools/scripts/test-extension-smoke.mjs
node tools/scripts/test-post-process-runtime.mjs
npm.cmd run test:ui
```

Expected: new assertions either fail at the precise missing seam or prove the
existing implementation already satisfies the approved behavior.

- [ ] **Step 3: Implement only missing behavior**

If RED shows a gap, keep `lockPostProcessControls` before
`runPostProcessForLatestAssistant`, keep unlock in `finally`, and ensure
`postProcessStarted` activity is emitted before provider guidance begins.
Route native stop only through the existing `GENERATION_STOPPED` cancellation
path.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the three focused commands from Step 2.

Expected: pass.

### Task 4: Update contracts and verify the installed/live path

**Files:**
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/architecture/POST_PROCESS_CARDS_RUNTIME.md`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md`
- Modify: `tools/scripts/verify-installed-copy.mjs` only if current deployment-root discovery is stale
- Modify/create live proof only if an existing safe harness cannot exercise the flow

**Interfaces:**
- Consumes: corrected lifecycle and native Stop behavior
- Produces: authoritative documentation and live installed-copy evidence

- [ ] **Step 1: Update documentation**

Document the SillyTavern scalar event-count contract, unconditional terminal
settlement, and full-window native Stop ownership.

- [ ] **Step 2: Run deterministic verification**

Run:

```powershell
npm.cmd run test:host
node tools/scripts/test-extension-smoke.mjs
node tools/scripts/test-post-process-runtime.mjs
npm.cmd run test:ui
npm.cmd test
git diff --check
```

Expected: all commands pass with no whitespace errors.

- [ ] **Step 3: Sync the repository to the installed default-user extension**

Use the repository's established safe deployment script or a scoped `robocopy`
that excludes `.git`, `node_modules`, `artifacts`, `.tmp`, `.agents`, and
`.codex` directories.

- [ ] **Step 4: Verify byte identity**

Run: `node tools/scripts/verify-installed-copy.mjs --user default-user`

Expected: repository, installed, and served copies match. If this SillyTavern
layout has no public third-party copy, update the verifier to report the actual
served installed root rather than requiring a nonexistent directory.

- [ ] **Step 5: Run live safe proof**

Use the existing live Post-process harness against `default-user` or the
dedicated safe user chosen by its guardrails. Prove scalar terminal handling,
running/completed progress, native Stop visibility during guidance and writer
work, cancellation without late commit, and final persisted marker/hash state.

- [ ] **Step 6: Audit the original SG-1 failure shape**

Confirm the regression fixture matches:

```text
final assistant index = chat.length - 1
generation_ended scalar = chat.length
postProcess.enabled = true
runnable starter cards > 0
```

Do not mutate the user's SG-1 transcript solely for proof.

