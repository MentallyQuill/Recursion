# Recursion Declarative Generation Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pipeline selection and the Recursion Bar Regenerate button declarative next-generation intents, so changing controls never starts provider or host generation work by itself and each host generation consumes at most one Recursion pipeline run.

**Architecture:** Split idle UI intent from generation work. Pipeline selection persists the next scheduling mode and cancels stale in-flight Recursion work, but it does not run providers, warm Rapid, install a new packet, or start SillyTavern generation. Regenerate becomes a queued fresh-next-generation override consumed once by `prepareForGeneration({ hostGeneration: true })`; the forced run bypasses packet reuse, Rapid warm, and cache admission for that generation only, then returns to normal selected-pipeline behavior.

**Tech Stack:** JavaScript ES modules, Recursion runtime/run-state/settings, SillyTavern extension interception, Recursion Bar UI/view-model, deterministic Node test scripts, guarded Playwright live proof, markdown product/architecture docs.

---

## File Structure

- `src/runtime/run-state.mjs` - rename force-regenerate pending state to fresh-next-generation pending state and expose set/take/clear operations.
- `src/runtime.mjs` - remove the immediate visible regenerate wrapper, add fresh-next runtime APIs, make pipeline-only settings changes generation-neutral, and consume the fresh token once in `prepareForGeneration()`.
- `src/ui/view-model.mjs` - expose idle armed state for the Regenerate command without treating it as Stop-visible active work.
- `src/ui/bar.mjs` - rename force-regenerate presentation fields to fresh-next-generation fields.
- `src/ui.mjs` - wire the bar button to queue or cancel the fresh-next token, update labels/tooltips, and remove the immediate `forceRegenerateNow()` fallback.
- `styles/recursion.css` - carry the existing compact Regenerate button styling onto the renamed fresh-next-generation class and add armed-state styling.
- `src/runtime/diagnostics.mjs` - rename exported diagnostics field from `forceRegenerate` to `freshNextGeneration`.
- `tools/scripts/test-runtime.mjs` - replace immediate-regenerate assertions with pipeline-deferred and fresh-next-generation assertions.
- `tools/scripts/test-ui.mjs` - replace Stop-on-pending and immediate-click assertions with armed-idle button assertions.
- `tools/scripts/test-extension-smoke.mjs` - assert the extension surface exposes the new runtime view/API names.
- `tools/scripts/prove-live-force-regenerate.mjs` - rename or replace with a fresh-next-generation live proof that clicks Regenerate, then triggers exactly one host generation.
- `tools/scripts/prove-live-prompt-packet.mjs` - update direct runtime calls from `forceRegenerateNext()` to `requestFreshNextGeneration()`.
- `docs/design/UI_SPEC.md` - correct command-slot behavior and copy.
- `docs/architecture/RUNTIME_ARCHITECTURE.md` - correct pipeline selection and Regenerate runtime contracts.
- `docs/technical/RUNTIME_TURN_SEQUENCE.md` - correct the host generation sequence.
- `docs/user/RECURSION_OPERATOR_MANUAL.md` - explain the next-generation fresh override.
- `docs/superpowers/specs/2026-07-03-recursion-force-regenerate-design.md` - replace immediate-regenerate claims with the fresh-next-generation contract.
- `docs/superpowers/plans/2026-07-03-recursion-force-regenerate.md` - mark as superseded by this plan or rewrite stale immediate-regenerate steps during implementation.

---

## Contract

Runtime public APIs after this fix:

```js
runtime.requestFreshNextGeneration({ source = 'bar' } = {})
runtime.clearFreshNextGeneration({ source = 'bar' } = {})
```

`runtime.forceRegenerateNow()` is removed from the public runtime object. The visible Recursion Bar Regenerate button must never call `host.generation.start(...)` directly.

Pending runtime view:

```js
{
  freshNextGeneration: {
    pending: true,
    id: 'fresh-next-generation-...',
    reason: 'user-fresh-next-generation',
    requestedAt: '2026-07-05T00:00:00.000Z',
    source: 'bar'
  }
}
```

Queued return:

```js
{
  ok: true,
  freshNextGeneration: {
    pending: true,
    id: 'fresh-next-generation-...',
    reason: 'user-fresh-next-generation',
    requestedAt: '2026-07-05T00:00:00.000Z',
    source: 'bar'
  }
}
```

Cleared return:

```js
{
  ok: true,
  freshNextGeneration: { pending: false }
}
```

Forced run diagnostics:

```js
[
  'fresh-next-generation:user-requested',
  'fresh-next-generation:cache-bypassed',
  'fresh-next-generation:rapid-bypassed'
]
```

`fresh-next-generation:rapid-bypassed` appears only when the selected pipeline is Rapid and the pending fresh token forces the current run away from Rapid warm reuse.

---

### Task 1: Runtime Red Tests For Declarative Pipeline Selection

**Files:**
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Replace the Rapid-selection warm expectation**

Find the existing test near the `switching to Rapid queues a scene warm` assertion. Replace that assertion block with this pipeline-neutral contract:

```js
{
  const roleCalls = [];
  const hostStartCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' },
    hostGeneration: {
      async start(details = {}) {
        hostStartCalls.push(details);
        return { ok: true, started: true };
      }
    },
    generationRouter: {
      async generate(roleId) {
        roleCalls.push(roleId);
        throw new Error(`pipeline switch should not call provider role ${roleId}`);
      }
    }
  });

  const update = await harness.runtime.updateSettings({ pipelineMode: 'rapid' });
  assertEqual(update.ok, true, 'switching to Rapid succeeds');
  assertEqual(update.settings.pipelineMode, 'rapid', 'settings update records Rapid pipeline');
  assertEqual(update.warm, undefined, 'switching to Rapid does not queue a scene warm');
  assertDeepEqual(roleCalls, [], 'switching pipeline does not call providers');
  assertDeepEqual(hostStartCalls, [], 'switching pipeline does not start host generation');
  assertEqual(harness.runtime.view().settings.pipelineMode, 'rapid', 'runtime view shows the selected next pipeline');
}
```

- [ ] **Step 2: Add same-value pipeline selection coverage**

Add this runtime test after the pipeline-switch test:

```js
{
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' }
  });

  const beforeClearCount = harness.calls.clear;
  const result = await harness.runtime.updateSettings({ pipelineMode: 'standard' });
  assertEqual(result.ok, true, 'selecting the current pipeline succeeds');
  assertEqual(harness.calls.clear, beforeClearCount, 'selecting the current pipeline does not clear the prompt');
}
```

- [ ] **Step 3: Add next-generation pipeline consumption coverage**

Add this runtime test after the same-value test:

```js
{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Pipeline switch next generation.' }],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              reasonerDecision: { mode: 'skip', reason: 'pipeline switch test', signals: [] },
              diagnostics: ['pipeline-switch-next-generation']
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          return {
            ok: true,
            roleId,
            lane: 'utility',
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [{
                schema: 'recursion.card.v1',
                family: 'Scene Frame',
                role: 'sceneFrameCard',
                promptText: 'Pipeline-switched Fused card.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 12
              }]
            }
          };
        }
        if (roleId === 'sceneFrameCard') return cardProviderResponse(roleId, request);
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Use the newly selected Standard path.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['pipeline-switch-guidance']
            }
          };
        }
        throw new Error(`unexpected role after pipeline switch ${roleId}`);
      }
    }
  });

  await harness.runtime.updateSettings({ pipelineMode: 'fused' });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Use the new pipeline.', hostGeneration: true });
  assertEqual(result.ok, true, 'next generation after pipeline switch succeeds');
  assertEqual(result.packet.diagnostics.pipelineMode, 'fused', 'next generation uses the selected pipeline mode');
  assert(roleCalls.includes('fusedCardBundle'), 'next generation enters the Fused card bundle path');
}
```

- [ ] **Step 4: Run the red test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: the Rapid-selection test fails because current `updateSettings({ pipelineMode: 'rapid' })` queues Rapid warm work, and the same-value test fails if the current code clears prompt state for unchanged values.

---

### Task 2: Runtime Red Tests For Fresh Next Generation

**Files:**
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Replace immediate force-regenerate tests**

Remove tests that assert `runtime.forceRegenerateNow()` exists, starts `host.generation.start({ type: 'regenerate' })`, or makes Stop visible before a host generation. Add this test in the same runtime section:

```js
{
  const hostStartCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' },
    hostGeneration: {
      async start(details = {}) {
        hostStartCalls.push(details);
        return { ok: true, started: true };
      }
    }
  });

  assertEqual(runtimeHasOwnMethod(harness.runtime, 'forceRegenerateNow'), false, 'runtime does not expose immediate forceRegenerateNow');
  assertEqual(typeof harness.runtime.requestFreshNextGeneration, 'function', 'runtime exposes fresh-next-generation request');
  assertEqual(typeof harness.runtime.clearFreshNextGeneration, 'function', 'runtime exposes fresh-next-generation clear');

  const queued = await harness.runtime.requestFreshNextGeneration({ source: 'bar' });
  assertEqual(queued.ok, true, 'fresh next generation queues successfully');
  assertEqual(harness.runtime.view().freshNextGeneration?.pending, true, 'fresh next generation is visible as pending');
  assertEqual(harness.runtime.view().lastBrief?.reason, 'user-fresh-next-generation', 'fresh next generation clears Last Brief with queued reason');
  assertDeepEqual(hostStartCalls, [], 'queuing fresh next generation does not start host generation');
  assertEqual(harness.calls.install, 0, 'queuing fresh next generation does not install a prompt');
}
```

Add this helper near other local test helpers:

```js
function runtimeHasOwnMethod(runtime, name) {
  return typeof runtime?.[name] === 'function';
}
```

- [ ] **Step 2: Add single-consumption coverage**

Add this test after the queuing test:

```js
{
  let providerCalls = 0;
  const { runtime, installed } = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        providerCalls += 1;
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Fresh next generation.' }],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              reasonerDecision: { mode: 'skip', reason: 'fresh next generation', signals: [] },
              diagnostics: ['fresh-next-generation-arbiter']
            }
          };
        }
        if (roleId === 'sceneFrameCard') return cardProviderResponse(roleId, request);
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Use fresh generated cards.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['fresh-next-generation-guidance']
            }
          };
        }
        throw new Error(`unexpected fresh-next role ${roleId}`);
      }
    }
  });

  const first = await runtime.prepareForGeneration({ userMessage: 'Build the baseline packet.', hostGeneration: true });
  assertEqual(first.ok, true, 'baseline generation succeeds');
  const callsAfterFirst = providerCalls;
  await runtime.requestFreshNextGeneration({ source: 'bar' });
  const second = await runtime.prepareForGeneration({ userMessage: 'Build the baseline packet.', hostGeneration: true });
  assertEqual(second.ok, true, 'fresh next generation succeeds');
  assertEqual(second.reused, undefined, 'fresh next generation does not reuse the prior packet');
  assert(providerCalls > callsAfterFirst, 'fresh next generation calls providers again');
  assertEqual(installed.length, 2, 'fresh next generation installs a second packet');
  assertNotEqual(installed[0].packetId, installed[1].packetId, 'fresh next generation changes packet identity');
  assertEqual(runtime.view().freshNextGeneration?.pending, false, 'fresh next generation token is consumed once');
  assertEqual(runtime.view().lastBrief?.reason, 'fresh-next-generation-installed', 'fresh next generation marks installed reason');
}
```

- [ ] **Step 3: Add cancel coverage**

Add this test after the single-consumption test:

```js
{
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' }
  });

  await runtime.requestFreshNextGeneration({ source: 'bar' });
  assertEqual(runtime.view().freshNextGeneration?.pending, true, 'fresh next generation starts pending');
  const cleared = await runtime.clearFreshNextGeneration({ source: 'bar' });
  assertEqual(cleared.ok, true, 'fresh next generation clear succeeds');
  assertEqual(runtime.view().freshNextGeneration?.pending, false, 'fresh next generation clear removes pending token');
}
```

- [ ] **Step 4: Run the red test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: failure because the runtime still exposes `forceRegenerateNow`, still exposes `forceRegenerate`, and does not expose the new fresh-next API/view names.

---

### Task 3: Runtime State And API Cleanup

**Files:**
- Modify: `src/runtime/run-state.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/runtime/diagnostics.mjs`

- [ ] **Step 1: Rename run-state pending token**

In `src/runtime/run-state.mjs`, replace the pending force state with fresh-next-generation state:

```js
let pendingFreshNextGeneration = null;
```

Expose it from `current()`:

```js
pendingFreshNextGeneration
```

Replace force-specific methods with:

```js
setFreshNextGeneration(token) {
  pendingFreshNextGeneration = token || null;
},
takeFreshNextGeneration() {
  const token = pendingFreshNextGeneration;
  pendingFreshNextGeneration = null;
  return token || null;
},
clearFreshNextGeneration() {
  pendingFreshNextGeneration = null;
}
```

- [ ] **Step 2: Replace runtime helper names**

In `src/runtime.mjs`, replace `forceRegenerateView()` with:

```js
function freshNextGenerationView() {
  const pendingFreshNextGeneration = runState.current().pendingFreshNextGeneration;
  if (!pendingFreshNextGeneration) {
    return { pending: false };
  }
  return {
    pending: true,
    id: safeText(pendingFreshNextGeneration.id || '', 180),
    reason: safeText(pendingFreshNextGeneration.reason || 'user-fresh-next-generation', 120),
    requestedAt: safeText(pendingFreshNextGeneration.requestedAt || '', 80),
    source: safeText(pendingFreshNextGeneration.source || 'bar', 80)
  };
}
```

Replace `clearPendingForceRegenerate()` with:

```js
function clearPendingFreshNextGeneration() {
  runState.clearFreshNextGeneration();
}
```

Replace `forceRegenerateDetails(...)` with:

```js
function freshNextGenerationDetails(freshContext, snapshot = null) {
  const source = asObject(freshContext);
  return {
    latestMesId: numberOr(snapshot?.latestMesId, 0),
    source: safeText(source.source || 'bar', 80),
    freshNextGenerationId: safeText(source.id || '', 180)
  };
}
```

Replace `forceStaleSceneCache(...)` with:

```js
function freshStaleSceneCache(cache, freshContext, snapshot = null) {
  if (!freshContext || !cache) return cache;
  return {
    ...cache,
    cacheState: 'stale',
    invalidation: {
      reason: 'user-fresh-next-generation',
      detectedAt: safeText(freshContext.requestedAt || nowIso(), 80),
      details: freshNextGenerationDetails(freshContext, snapshot)
    }
  };
}
```

Replace `consumePendingForceRegenerate(runId)` with:

```js
function consumePendingFreshNextGeneration(runId) {
  const pendingFreshNextGeneration = runState.current().pendingFreshNextGeneration;
  if (!pendingFreshNextGeneration) return null;
  const token = {
    ...pendingFreshNextGeneration,
    consumeByRunId: safeText(runId || '', 160)
  };
  runState.clearFreshNextGeneration();
  return token;
}
```

- [ ] **Step 3: Add public queue and clear APIs**

Replace `forceRegenerateNext(...)` and delete `forceRegenerateNow(...)`. Add:

```js
async function requestFreshNextGeneration(details = {}) {
  const settings = settingsStore.get();
  if (settings.enabled === false) {
    clearPendingFreshNextGeneration();
    clearPendingLatestAssistantSwipeRetry();
    clearLastBrief({ status: 'empty', reason: 'disabled' });
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  const source = asObject(details);
  runState.setFreshNextGeneration({
    id: makeId('fresh-next-generation'),
    reason: 'user-fresh-next-generation',
    requestedAt: nowIso(),
    consumeByRunId: '',
    source: safeText(source.source || 'bar', 80) || 'bar'
  });
  clearPendingLatestAssistantSwipeRetry();
  clearLastBrief({ status: 'clearing', reason: 'user-fresh-next-generation' });
  return {
    ok: true,
    freshNextGeneration: freshNextGenerationView()
  };
}

async function clearFreshNextGeneration() {
  clearPendingFreshNextGeneration();
  if (lastBrief.status === 'clearing' && lastBrief.reason === 'user-fresh-next-generation') {
    clearLastBrief({ status: 'empty', reason: 'fresh-next-generation-cleared' });
  }
  return {
    ok: true,
    freshNextGeneration: freshNextGenerationView()
  };
}
```

Remove this immediate wrapper entirely:

```js
async function forceRegenerateNow(details = {}) {
  const queued = await forceRegenerateNext(details);
  if (queued?.skipped) return queued;
  const prepare = await prepareForGeneration({ userMessage: null, hostGeneration: true });
  if (prepare?.superseded || prepare?.ok === false || prepare?.skipped) return prepare;
  const hostGeneration = await requestHostGenerationStart({
    type: 'regenerate',
    source: 'recursion-ui',
    reason: 'force-regenerate'
  });
  setHostGenerationActive(false);
  return {
    ...asObject(prepare),
    hostGeneration
  };
}
```

- [ ] **Step 4: Update runtime view and exports**

In every `runtime.view()` object, replace:

```js
forceRegenerate: forceRegenerateView()
```

with:

```js
freshNextGeneration: freshNextGenerationView()
```

In the returned runtime object, replace:

```js
forceRegenerateNext,
forceRegenerateNow,
```

with:

```js
requestFreshNextGeneration,
clearFreshNextGeneration,
```

- [ ] **Step 5: Update diagnostics view**

In `src/runtime/diagnostics.mjs`, replace the force field:

```js
forceRegenerate: runtime.forceRegenerate || null,
```

with:

```js
freshNextGeneration: runtime.freshNextGeneration || null,
```

- [ ] **Step 6: Run focused runtime tests**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: fresh API existence tests pass; pipeline-only behavior and consumption tests still fail until later tasks integrate the new token.

---

### Task 4: Pipeline-Only Setting Behavior

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Add setting-change helpers**

Add these helpers near the current settings update helpers in `src/runtime.mjs`:

```js
function settingValuesEqual(left, right) {
  return hashJson(left) === hashJson(right);
}

function changedSettingKeys(patch, before, after) {
  return Object.keys(asObject(patch)).filter((key) => !settingValuesEqual(before?.[key], after?.[key]));
}

function isPipelineOnlySettingsChange(keys) {
  return keys.length === 1 && keys[0] === 'pipelineMode';
}
```

- [ ] **Step 2: Use actual changed keys**

In `updateSettings(patch = {})`, replace:

```js
const changedKeys = Object.keys(cleanPatch);
```

with:

```js
const changedKeys = changedSettingKeys(cleanPatch, currentSettings, next);
```

Add this no-change return immediately after `changedKeys` is computed:

```js
if (changedKeys.length === 0) {
  return { ok: true, settings: next, clear: null };
}
```

- [ ] **Step 3: Add pipeline-only branch**

Before the existing non-neutral settings invalidation branch, add:

```js
if (isPipelineOnlySettingsChange(changedKeys)) {
  supersedeActiveRun();
  abortActiveRapidWarmRun('pipeline-mode-changed');
  const result = await trackRuntimeMutation(async () => {
    const clear = await clearPromptAfterSupersede({
      successLabel: 'Recursion prompt cleared after pipeline change.',
      journalReason: 'pipeline-mode-changed'
    });
    return {
      ok: clear?.ok !== false,
      settings: next,
      clear,
      pipelineChange: {
        deferred: true,
        previous: safeText(currentSettings.pipelineMode || 'standard', 40),
        next: safeText(next.pipelineMode || 'standard', 40)
      }
    };
  });
  return result;
}
```

This branch intentionally does not call `invalidateActiveSceneCacheBestEffort(...)` and does not queue `warmRapidScene(...)`.

- [ ] **Step 4: Keep mixed setting changes strict**

Leave the existing settings invalidation path for patches such as:

```js
{ pipelineMode: 'rapid', maxCards: 4 }
```

Mixed patches still invalidate because card/prompt settings changed. Only a patch whose actual changed keys are exactly `['pipelineMode']` is generation-neutral.

- [ ] **Step 5: Run focused runtime tests**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: pipeline-only setting tests pass; fresh token consumption tests still fail until the next task.

---

### Task 5: Fresh Token Consumption In `prepareForGeneration()`

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Consume the new token**

In `prepareForGeneration(...)`, replace:

```js
const forceContext = consumePendingForceRegenerate(runId);
const forceReason = forceContext ? 'user-force-regenerate' : '';
```

with:

```js
const freshContext = hostGeneration === true
  ? consumePendingFreshNextGeneration(runId)
  : null;
const freshReason = freshContext ? 'user-fresh-next-generation' : '';
```

This makes the token a next-host-generation override. Manual refresh and non-host maintenance calls do not consume it.

- [ ] **Step 2: Update clear and reuse gates**

Replace force-specific gates in `prepareForGeneration(...)`:

```js
reason: forceReason || (hasSwipeRetry ? 'latest-assistant-swipe' : (refreshReason || 'generation-started')),
```

with:

```js
reason: freshReason || (hasSwipeRetry ? 'latest-assistant-swipe' : (refreshReason || 'generation-started')),
```

Replace:

```js
const baseSnapshot = settings.pipelineMode === 'rapid' && !refreshReason && !forceContext
```

with:

```js
const baseSnapshot = settings.pipelineMode === 'rapid' && !refreshReason && !freshContext
```

Replace:

```js
const swipeRetrySnapshot = !refreshReason && !forceContext
```

with:

```js
const swipeRetrySnapshot = !refreshReason && !freshContext
```

Replace:

```js
if (refreshReason || forceContext) clearPendingLatestAssistantSwipeRetry();
```

with:

```js
if (refreshReason || freshContext) clearPendingLatestAssistantSwipeRetry();
```

Replace:

```js
if (!refreshReason && !forceContext && canReuseLastPacketForSnapshot(snapshot)) {
```

with:

```js
if (!refreshReason && !freshContext && canReuseLastPacketForSnapshot(snapshot)) {
```

- [ ] **Step 3: Update cache invalidation and diagnostics**

Replace:

```js
const invalidationReason = forceReason || refreshReason;
```

with:

```js
const invalidationReason = freshReason || refreshReason;
```

Replace force details in the storage invalidation call:

```js
details: freshContext
  ? freshNextGenerationDetails(freshContext, snapshot)
  : { latestMesId: snapshot.latestMesId }
```

Replace:

```js
const rapidForeground = settings.pipelineMode === 'rapid' && !refreshReason && !forceContext;
let initialCache = forceStaleSceneCache(await loadSceneCacheSafe(runId, rapidCacheSnapshot, settings), forceContext, rapidCacheSnapshot);
```

with:

```js
const rapidForeground = settings.pipelineMode === 'rapid' && !refreshReason && !freshContext;
let initialCache = freshStaleSceneCache(await loadSceneCacheSafe(runId, rapidCacheSnapshot, settings), freshContext, rapidCacheSnapshot);
```

Where forced diagnostics are merged into the packet, replace the old entries with:

```js
[
  'fresh-next-generation:user-requested',
  'fresh-next-generation:cache-bypassed',
  ...(settings.pipelineMode === 'rapid' ? ['fresh-next-generation:rapid-bypassed'] : [])
]
```

Replace the ready reason:

```js
freshContext ? 'fresh-next-generation-installed' : 'packet-installed'
```

and the install-failure reason:

```js
freshContext ? 'fresh-next-generation-install-failed' : 'install-failed'
```

- [ ] **Step 4: Update disabled, reset, dispose, and source-clear paths**

Replace calls to:

```js
clearPendingForceRegenerate();
runState.clearForceRegenerate();
```

with:

```js
clearPendingFreshNextGeneration();
runState.clearFreshNextGeneration();
```

Apply this in disabled handling, chat/source reset handling, stop cleanup, and runtime disposal.

- [ ] **Step 5: Run focused runtime tests**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: runtime tests for pipeline selection, fresh queuing, token consumption, same-turn bypass, latest-assistant bypass, and Rapid warm bypass pass.

---

### Task 6: UI And View-Model

**Files:**
- Modify: `src/ui/view-model.mjs`
- Modify: `src/ui/bar.mjs`
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-ui.mjs`

- [ ] **Step 1: Replace UI tests for immediate Regenerate**

In `tools/scripts/test-ui.mjs`, replace fake runtime methods:

```js
forceRegenerateNow: (details = {}) => {
  forceRegenerateCalls += 1;
  forceRegenerateDetails.push(details);
  view = {
    ...view,
    forceRegenerate: {
      pending: true,
      reason: 'user-force-regenerate',
      source: details.source || 'bar'
    },
    lastBrief: { status: 'clearing', reason: 'user-force-regenerate', previousPacketId: 'packet-ui' }
  };
  return { ok: true, forceRegenerate: view.forceRegenerate };
}
```

with:

```js
requestFreshNextGeneration: (details = {}) => {
  freshNextGenerationCalls += 1;
  freshNextGenerationDetails.push(details);
  view = {
    ...view,
    freshNextGeneration: {
      pending: true,
      reason: 'user-fresh-next-generation',
      source: details.source || 'bar'
    },
    lastBrief: { status: 'clearing', reason: 'user-fresh-next-generation', previousPacketId: 'packet-ui' }
  };
  return { ok: true, freshNextGeneration: view.freshNextGeneration };
},
clearFreshNextGeneration: (details = {}) => {
  clearFreshNextGenerationCalls += 1;
  clearFreshNextGenerationDetails.push(details);
  view = {
    ...view,
    freshNextGeneration: { pending: false },
    lastBrief: { status: 'empty', reason: 'fresh-next-generation-cleared' }
  };
  return { ok: true, freshNextGeneration: view.freshNextGeneration };
}
```

Initialize the counters near the old force-regenerate counters:

```js
let freshNextGenerationCalls = 0;
const freshNextGenerationDetails = [];
let clearFreshNextGenerationCalls = 0;
const clearFreshNextGenerationDetails = [];
```

- [ ] **Step 2: Replace command-slot expectations**

Replace the idle Regenerate click assertions with:

```js
view = { settings: { mode: 'auto' }, activity: { phase: 'idle' }, lastHand: { cards: [] }, freshNextGeneration: { pending: false } };
ui.update();
assertEqual(root.querySelector('[data-recursion-stop-generation]').hidden, true, 'idle view hides stop generation button');
assertEqual(root.querySelector('[data-recursion-fresh-next-generation]').hidden, false, 'idle view shows fresh-next-generation button');
assertEqual(root.querySelector('[data-recursion-fresh-next-generation]').getAttribute('aria-label'), 'Force next generation fresh', 'fresh-next button exposes accessible copy');
root.querySelector('[data-recursion-fresh-next-generation]').click();
assertEqual(freshNextGenerationCalls, 1, 'fresh-next button queues the next generation override');
assertDeepEqual(freshNextGenerationDetails.at(-1), { source: 'bar' }, 'fresh-next button identifies bar as source');
ui.update();
assertEqual(root.querySelector('[data-recursion-stop-generation]').hidden, true, 'queued fresh-next state does not show Stop while idle');
assertEqual(root.querySelector('[data-recursion-fresh-next-generation]').getAttribute('aria-pressed'), 'true', 'queued fresh-next state renders armed button state');
assert(fakeDocument.textTree(root.querySelector('[data-recursion-hand-dropdown]')).includes('Next generation will be fresh.'), 'fresh-next clearing state uses queued copy');
root.querySelector('[data-recursion-fresh-next-generation]').click();
assertEqual(clearFreshNextGenerationCalls, 1, 'clicking armed fresh-next button clears the override');
```

- [ ] **Step 3: Update view-model active-state logic**

In `src/ui/view-model.mjs`, replace force state extraction:

```js
const forceRegenerate = asObject(source.forceRegenerate);
const forceRegeneratePending = forceRegenerate.pending === true;
```

with:

```js
const freshNextGeneration = asObject(source.freshNextGeneration);
const freshNextGenerationPending = freshNextGeneration.pending === true;
```

Remove pending fresh state from `generationStopVisible`. The Stop button should be visible for active work only:

```js
const generationStopVisible = enabled && (
  Boolean(cleanText(source.activeRunId))
  || source.hostGenerationActive === true
  || Number(progressRun.activeCount || 0) > 0
);
```

Replace returned force fields with:

```js
freshNextGenerationVisible: enabled && !generationStopVisible,
freshNextGenerationPending,
freshNextGenerationDisabled: !enabled || generationStopVisible,
```

- [ ] **Step 4: Update bar presenter fields**

In `src/ui/bar.mjs`, replace:

```js
showForceRegenerate: Boolean(viewModel.forceRegenerateVisible),
```

with:

```js
showFreshNextGeneration: Boolean(viewModel.freshNextGenerationVisible),
freshNextGenerationPending: Boolean(viewModel.freshNextGenerationPending),
```

- [ ] **Step 5: Update DOM selectors, labels, and click handler**

In `src/ui.mjs`, replace the force-regenerate selector variable with:

```js
const freshNextGenerationButton = root.querySelector('[data-recursion-fresh-next-generation]');
```

Use this tooltip:

```js
const FRESH_NEXT_GENERATION_TOOLTIP = 'Force the next send or swipe to rebuild fresh cards and prompt guidance without using cached cards, Rapid warm, or same-turn packet reuse.';
```

Render the button with:

```js
el('button', {
  className: 'recursion-fresh-next-generation',
  attrs: { type: 'button', 'aria-label': 'Force next generation fresh', title: FRESH_NEXT_GENERATION_TOOLTIP, 'aria-pressed': 'false' },
  dataset: { recursionFreshNextGeneration: '' }
}, [
  el('span', { className: 'recursion-fresh-next-generation-icon', attrs: { 'aria-hidden': 'true' }, dataset: { recursionFreshNextGenerationIcon: '' } })
])
```

Replace the click handler with:

```js
freshNextGenerationButton?.addEventListener('click', (event) => {
  consumeClickEvent(event);
  setProgressPopoverOpen(false);
  const view = currentView();
  const pending = view.freshNextGeneration?.pending === true;
  const action = pending
    ? runtime?.clearFreshNextGeneration?.({ source: 'bar' })
    : runtime?.requestFreshNextGeneration?.({ source: 'bar' });
  update();
  runAction(action, () => update());
});
```

Update the render pass:

```js
if (freshNextGenerationButton) {
  const supported = typeof runtime?.requestFreshNextGeneration === 'function'
    && typeof runtime?.clearFreshNextGeneration === 'function';
  const visible = supported && model.freshNextGenerationVisible;
  const pending = model.freshNextGenerationPending;
  freshNextGenerationButton.hidden = !visible;
  freshNextGenerationButton.disabled = !visible || model.freshNextGenerationDisabled;
  freshNextGenerationButton.setAttribute('aria-hidden', visible ? 'false' : 'true');
  freshNextGenerationButton.setAttribute('tabindex', visible ? '0' : '-1');
  freshNextGenerationButton.setAttribute('aria-pressed', pending ? 'true' : 'false');
  freshNextGenerationButton.setAttribute('aria-label', pending ? 'Fresh next generation armed' : 'Force next generation fresh');
  setTooltip(
    freshNextGenerationButton,
    model.tooltipsEnabled,
    pending ? 'Next send or swipe will rebuild fresh. Click to cancel.' : FRESH_NEXT_GENERATION_TOOLTIP
  );
}
```

- [ ] **Step 6: Update Last Brief clearing copy**

In the Last Brief status text helper, replace:

```js
if (model.lastBriefReason === 'user-force-regenerate') return 'Preparing fresh prompt packet.';
```

with:

```js
if (model.lastBriefReason === 'user-fresh-next-generation') return 'Next generation will be fresh.';
if (model.lastBriefReason === 'fresh-next-generation-cleared') return 'Fresh generation request cleared.';
```

The active generation status still comes from progress phases once the next host generation starts.

- [ ] **Step 7: Carry button styling forward**

In `styles/recursion.css`, copy the existing `.recursion-force-regenerate` selector behavior onto the renamed class. If the current file uses grouped command-slot selectors, add `.recursion-fresh-next-generation` to that group. Add armed-state styling:

```css
.recursion-fresh-next-generation[aria-pressed="true"] {
  color: var(--recursion-accent, currentColor);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 40%, transparent);
}
```

Keep the icon mask rule shared with the existing regenerate icon asset:

```css
.recursion-fresh-next-generation-icon {
  background: currentColor;
  mask: url('../assets/icons/regenerate.svg') center / 12px 12px no-repeat;
}
```

- [ ] **Step 8: Run focused UI tests**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: UI tests pass and no assertion expects idle pending fresh state to show Stop.

---

### Task 7: Extension Smoke And Live Proof Updates

**Files:**
- Modify: `tools/scripts/test-extension-smoke.mjs`
- Modify: `tools/scripts/prove-live-force-regenerate.mjs`
- Modify: `tools/scripts/prove-live-prompt-packet.mjs`
- Rename: `tools/scripts/prove-live-force-regenerate.mjs` to `tools/scripts/prove-live-fresh-next-generation.mjs`

- [ ] **Step 1: Update smoke API assertions**

In `tools/scripts/test-extension-smoke.mjs`, replace assertions that look for `forceRegenerateNow`, `forceRegenerateNext`, or `forceRegenerate` with:

```js
assertEqual(typeof runtime.requestFreshNextGeneration, 'function', 'runtime exposes fresh-next-generation request');
assertEqual(typeof runtime.clearFreshNextGeneration, 'function', 'runtime exposes fresh-next-generation clear');
assertEqual(runtime.view().freshNextGeneration?.pending, false, 'fresh-next-generation view is present and idle by default');
```

- [ ] **Step 2: Update prompt-packet proof helper**

In `tools/scripts/prove-live-prompt-packet.mjs`, replace:

```js
if (typeof runtime?.forceRegenerateNext === 'function') {
  await runtime.forceRegenerateNext({ source: 'prompt-packet-proof' });
}
```

with:

```js
if (typeof runtime?.requestFreshNextGeneration === 'function') {
  await runtime.requestFreshNextGeneration({ source: 'prompt-packet-proof' });
}
```

- [ ] **Step 3: Rename and rewrite the live proof expectations**

Rename:

```powershell
Move-Item -LiteralPath tools\scripts\prove-live-force-regenerate.mjs -Destination tools\scripts\prove-live-fresh-next-generation.mjs
```

Inside the renamed script, change the proof sequence to:

```js
// 1. Start with a ready Last Brief and capture packet id.
// 2. Click [data-recursion-fresh-next-generation].
// 3. Assert runtime.view().freshNextGeneration.pending === true.
// 4. Assert no host generation call has happened yet.
// 5. Trigger exactly one host generation through the normal SillyTavern send/swipe path.
// 6. Assert the fresh token is consumed.
// 7. Assert the resulting packet id differs from the baseline.
// 8. Assert packet diagnostics include fresh-next-generation:cache-bypassed.
// 9. Assert provider-call count increased once for the host generation attempt.
// 10. Assert no second Recursion run occurs after the same send/swipe settles.
```

Implement the no-immediate-host assertion with the existing in-page probe object:

```js
if (readyAfterClick.hostProbe?.generateCalls?.length > readyBefore.hostProbe?.generateCalls?.length) {
  fail('fresh-next-started-host-generation', 'Clicking Regenerate started host generation before the next send/swipe.', {
    before: readyBefore.hostProbe?.generateCalls,
    after: readyAfterClick.hostProbe?.generateCalls
  });
}
```

Implement the single-run assertion with runtime journal entries:

```js
const freshRuns = journal.entries.filter((entry) => {
  const diagnostics = JSON.stringify(entry.details?.diagnostics || entry.diagnostics || []);
  return diagnostics.includes('fresh-next-generation:cache-bypassed');
});
if (freshRuns.length !== 1) {
  fail('fresh-next-run-count-mismatch', 'Fresh-next generation should be consumed by exactly one Recursion run.', {
    freshRunCount: freshRuns.length
  });
}
```

- [ ] **Step 4: Run smoke tests**

Run:

```powershell
node tools\scripts\test-extension-smoke.mjs
```

Expected: smoke tests pass.

---

### Task 8: Documentation Updates

**Files:**
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/superpowers/specs/2026-07-03-recursion-force-regenerate-design.md`
- Modify: `docs/superpowers/plans/2026-07-03-recursion-force-regenerate.md`
- Modify: `README.md` only if it contains immediate Regenerate wording after search.

- [ ] **Step 1: Update UI spec command-slot wording**

Replace the immediate Regenerate paragraph in `docs/design/UI_SPEC.md` with:

```markdown
When no active run or host generation exists, the same command slot shows an icon-only Regenerate button with accessible label `Force next generation fresh`. Clicking it arms a one-shot fresh-next-generation override; it does not start Recursion provider work, does not install a prompt packet, and does not call SillyTavern native regenerate. While armed, the button remains visible in a pressed state with tooltip copy `Next send or swipe will rebuild fresh. Click to cancel.` Stop appears only while Recursion preparation or SillyTavern host generation is actually active. The next host generation consumes the armed token once, bypasses cached card admission, Rapid warm, latest-assistant swipe packet reuse, and same-turn packet reinstall, then returns to the selected Standard, Rapid, or Fused pipeline behavior.
```

- [ ] **Step 2: Update runtime architecture**

Replace the Force Regenerate paragraph in `docs/architecture/RUNTIME_ARCHITECTURE.md` with:

```markdown
Regenerate is a one-shot fresh-next-generation override from the Recursion Bar command slot. The bar calls `runtime.requestFreshNextGeneration({ source: 'bar' })`, runtime records a pending token and clears Last Brief to an armed state, but no provider work or host generation starts on click. The next `prepareForGeneration({ hostGeneration: true })` consumes the token once, skips same-turn packet reinstall, skips latest-assistant swipe packet reuse, bypasses Rapid foreground warm, soft-invalidates the current scene cache with reason `user-fresh-next-generation`, prevents cached cards from entering the prompt-eligible hand, and records diagnostics such as `fresh-next-generation:cache-bypassed` and `fresh-next-generation:rapid-bypassed`. Pipeline selection remains a deferred scheduling setting; changing Standard/Rapid/Fused does not start generation or Rapid warming.
```

- [ ] **Step 3: Update runtime turn sequence**

Replace any sequence that says the bar calls `runtime.forceRegenerateNow({ source: 'bar' })` with:

```markdown
1. The bar calls `runtime.requestFreshNextGeneration({ source: 'bar' })`.
2. Runtime stores `freshNextGeneration.pending = true`, clears pending latest-assistant swipe retry, and shows `Next generation will be fresh.` in Last Brief.
3. Runtime does not call providers, install prompt keys, or call SillyTavern native generation.
4. On the next intercepted host generation, `prepareForGeneration({ hostGeneration: true })` consumes the token and runs exactly one fresh preparation pass.
5. The forced pass bypasses packet reuse, Rapid warm, and cached-card admission for that generation only.
```

- [ ] **Step 4: Update user manual**

Use this operator-facing copy in `docs/user/RECURSION_OPERATOR_MANUAL.md`:

```markdown
Use Regenerate when Last Brief looks stale and you want the next send or swipe to rebuild Recursion context fresh. Clicking it arms the next generation; it does not immediately regenerate the current SillyTavern message. The button shows an armed state until you send, swipe, or click it again to cancel. On the next generation, Recursion ignores same-turn packet reuse, Rapid warm, and cached-card admission once, then returns to normal behavior.
```

- [ ] **Step 5: Replace stale plan/spec claims**

In `docs/superpowers/specs/2026-07-03-recursion-force-regenerate-design.md` and `docs/superpowers/plans/2026-07-03-recursion-force-regenerate.md`, replace claims that `forceRegenerateNow()` is the visible action with this notice near the top:

```markdown
This earlier immediate-regenerate design is superseded by `docs/superpowers/plans/2026-07-05-recursion-declarative-generation-controls.md`. The current V1 contract is declarative: Regenerate arms a fresh-next-generation token and never starts provider work or SillyTavern native generation on click.
```

Then remove or rewrite any acceptance checklist item that requires immediate host generation on click.

- [ ] **Step 6: Search for stale wording**

Run:

```powershell
rg -n "forceRegenerateNow|forceRegenerateNext|forceRegenerate|Regenerate this turn|immediately regenerate|native regenerate|user-force-regenerate" docs README.md src tools
```

Expected: remaining matches are either implementation names being actively changed in this plan or deliberate historical notices pointing to the superseding plan.

---

### Task 9: Verification Gate

**Files:**
- No source edits expected unless a gate exposes a missed contract.

- [ ] **Step 1: Run focused deterministic tests**

Run:

```powershell
node tools\scripts\test-runtime.mjs
node tools\scripts\test-ui.mjs
node tools\scripts\test-extension-smoke.mjs
node tools\scripts\test-host.mjs
node tools\scripts\test-progress.mjs
```

Expected: each script prints its pass line and no test expects immediate host generation from the Regenerate click.

- [ ] **Step 2: Run full alpha gate**

Run:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: alpha gate completes without failures.

- [ ] **Step 3: Run docs whitespace gate**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 4: Run guarded live proof when SillyTavern is available**

Run:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
$env:RECURSION_SILLYTAVERN_HEADLESS='1'
node tools\scripts\prove-live-fresh-next-generation.mjs --live
```

Expected evidence:

- served extension copy is fresh;
- clicking Regenerate sets `runtime.view().freshNextGeneration.pending === true`;
- clicking Regenerate does not start host generation;
- the next send or swipe consumes the token once;
- fresh packet id differs from the baseline packet id;
- packet diagnostics include `fresh-next-generation:cache-bypassed`;
- no second Recursion run occurs after the same host generation settles.

---

## Self-Review Checklist

- [ ] Pipeline selection is described as deferred scheduling intent, not generation.
- [ ] Pipeline-only settings changes do not queue Rapid warm.
- [ ] Pipeline-only settings changes do not call providers.
- [ ] Pipeline-only settings changes do not start SillyTavern generation.
- [ ] Same-value pipeline selection is a no-op.
- [ ] Regenerate click queues a fresh-next-generation token and does not prepare immediately.
- [ ] Regenerate click does not call `host.generation.start(...)`.
- [ ] Armed Regenerate state does not show Stop while idle.
- [ ] Armed Regenerate state can be canceled from the same command slot.
- [ ] The next host generation consumes the fresh token once.
- [ ] Fresh consumption bypasses same-turn packet reuse.
- [ ] Fresh consumption bypasses latest-assistant swipe packet reuse.
- [ ] Fresh consumption bypasses Rapid warm once.
- [ ] Fresh consumption prevents cached cards from entering the prompt-eligible hand.
- [ ] The selected Standard/Rapid/Fused setting remains selected after a fresh forced run.
- [ ] Historical immediate-regenerate docs/specs are rewritten or marked superseded.
- [ ] Deterministic tests, alpha gate, docs whitespace gate, and live proof are run before claiming implementation complete.
