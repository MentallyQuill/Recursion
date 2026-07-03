# Recursion Rapid Warm Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rapid warming visible, persistent, joinable, and diagnosable without changing Prompt Packet V3 or Rapid Warm V2 model-facing content.

**Architecture:** Add a small operational Rapid warm state helper, split background warm lifecycle from foreground run lifecycle, persist warm status before and after provider work, let foreground Rapid wait briefly for exact in-flight warm work, and surface the resulting state through progress/UI. Runtime may classify cache eligibility and status reasons, but it must not compose semantic scene guidance, turn guidance, or card summaries.

**Tech Stack:** JavaScript ES modules, SillyTavern extension runtime, Recursion scene cache storage, activity/progress view models, compact bar UI, Node script tests under `tools/scripts`, live SillyTavern proof scripts.

---

## File Structure

- Create `src/rapid-warm-state.mjs`: operational status normalization, miss reason labels, join eligibility, and safe view shaping.
- Create `tools/scripts/test-rapid-warm-state.mjs`: focused tests for status/reason normalization and eligibility.
- Modify `src/runtime.mjs`: split background warm run state from foreground `activeRunId`, persist `warming` and `failed`, add foreground wait/join, expose `rapidWarm` in `view()`, and improve miss diagnostics.
- Modify `src/storage.mjs`: preserve `startedAt`, `failedAt`, `failureReasonCode`, and `failureReasonLabel` on `variant.rapid`.
- Modify `src/progress.mjs`: add Rapid waiting/failed phase ids and derive progress rows from `view.rapidWarm`.
- Modify `src/ui.mjs`: show Rapid warm status in compact model, keep `Rapid deck ready.` persistent while valid, and map new phases.
- Modify `tools/scripts/test-runtime.mjs`: prove non-aborting warm, persistent warm states, foreground join, timeout fallback, and miss reasons.
- Modify `tools/scripts/test-progress.mjs`: prove Rapid warm/wait/fail rows and Hero Pixel states.
- Modify `tools/scripts/test-ui.mjs`: prove compact status, persistent ready text, and pipeline-mode truth.
- Modify `tools/scripts/test-extension-smoke.mjs`: prove assistant-landed warm path emits visible warm activity through extension glue.
- Modify `DESIGN.md`, `docs/design/UI_SPEC.md`, `docs/architecture/RUNTIME_ARCHITECTURE.md`, `docs/technical/RUNTIME_TURN_SEQUENCE.md`, and user docs after runtime behavior is green.

## Task 1: Rapid Warm State Helper

**Files:**
- Create: `src/rapid-warm-state.mjs`
- Create: `tools/scripts/test-rapid-warm-state.mjs`

- [ ] **Step 1: Write failing helper tests**

Create `tools/scripts/test-rapid-warm-state.mjs` with:

```js
import {
  RAPID_WARM_JOIN_WAIT_MS,
  rapidWarmMissReason,
  rapidWarmReasonLabel,
  rapidWarmStatusView
} from '../../src/rapid-warm-state.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(RAPID_WARM_JOIN_WAIT_MS, 4000, 'Rapid foreground join wait is 4000 ms');
assertEqual(rapidWarmReasonLabel('warm-timeout'), 'Rapid deck still warming; Standard started.', 'timeout label is safe');
assertEqual(rapidWarmReasonLabel('settings-mismatch'), 'Rapid deck was built with different settings.', 'settings mismatch label is safe');
assertEqual(rapidWarmReasonLabel('unknown-code'), 'Rapid warm unavailable.', 'unknown reason is generic');

const expectedContracts = {
  settingsHash: 'settings-a',
  providerContractHash: 'provider-a',
  cardCatalogHash: 'catalog-a',
  promptContractHash: 'prompt-a'
};

assertDeepEqual(
  rapidWarmMissReason({
    activeVariant: { exact: false },
    rapid: null,
    candidateCards: [],
    expectedContracts,
    baseSourceRevisionHash: 'base-a'
  }),
  { code: 'no-active-variant', label: 'No Rapid deck for this source yet.' },
  'missing active variant gives no-active-variant'
);

assertDeepEqual(
  rapidWarmMissReason({
    activeVariant: { exact: true },
    rapid: {
      status: 'ready',
      baseSourceRevisionHash: 'base-a',
      settingsHash: 'settings-b',
      providerContractHash: 'provider-a',
      cardCatalogHash: 'catalog-a',
      promptContractHash: 'prompt-a',
      guidance: { schema: 'recursion.guidanceComposer.v1', status: 'used', text: 'Warm guidance.' },
      selectedCardIds: ['card-a'],
      cardIds: ['card-a']
    },
    candidateCards: [{ id: 'card-a' }],
    expectedContracts,
    baseSourceRevisionHash: 'base-a'
  }),
  { code: 'settings-mismatch', label: 'Rapid deck was built with different settings.' },
  'settings mismatch reason is detected'
);

assertDeepEqual(
  rapidWarmStatusView({
    status: 'warming',
    pipelineMode: 'rapid',
    runId: 'rapid-warm-1',
    baseSourceRevisionHash: 'source-a',
    selectedCardCount: 0,
    cardCount: 0,
    reasonCode: 'warming',
    joinable: true
  }),
  {
    status: 'warming',
    pipelineMode: 'rapid',
    runId: 'rapid-warm-1',
    warmArtifactId: '',
    baseSourceRevisionHash: 'source-a',
    startedAt: '',
    completedAt: '',
    failedAt: '',
    selectedCardCount: 0,
    cardCount: 0,
    reasonCode: 'warming',
    reasonLabel: 'Rapid deck still warming.',
    joinable: true
  },
  'warm status view is sanitized and complete'
);

assert(!JSON.stringify(rapidWarmStatusView({
  status: 'failed',
  reasonCode: 'warm-failed',
  reasonLabel: 'authorization: Bearer secret-token'
})).includes('Bearer'), 'unsafe detail is not exposed in warm view');
```

- [ ] **Step 2: Run the failing helper test**

Run:

```powershell
node tools\scripts\test-rapid-warm-state.mjs
```

Expected: FAIL with module-not-found for `src/rapid-warm-state.mjs`.

- [ ] **Step 3: Create helper implementation**

Create `src/rapid-warm-state.mjs`:

```js
const SAFE_TEXT_LIMIT = 180;
const SAFE_LABEL_LIMIT = 240;
const UNSAFE_TEXT = /\b(raw\s*prompt|provider\s*prompt|provider\s*response|hidden\s*reasoning|password|api[-_\s]*key|authorization|cookie|credentials?|session[-_\s]*key|bearer\s+\S+|sk-[a-z0-9_-]+)\b/i;

export const RAPID_WARM_JOIN_WAIT_MS = 4000;

const REASON_LABELS = Object.freeze({
  'not-rapid-mode': 'Standard Pipeline selected.',
  'provider-unavailable': 'Utility provider unavailable.',
  'no-active-variant': 'No Rapid deck for this source yet.',
  warming: 'Rapid deck still warming.',
  'warm-timeout': 'Rapid deck still warming; Standard started.',
  'warm-failed': 'Rapid warm failed; Standard started.',
  'source-mismatch': 'Rapid deck belongs to a different source.',
  'settings-mismatch': 'Rapid deck was built with different settings.',
  'provider-contract-mismatch': 'Rapid deck was built with different provider settings.',
  'catalog-mismatch': 'Rapid deck was built with a different card catalog.',
  'prompt-contract-mismatch': 'Rapid deck was built with a different prompt contract.',
  'story-form-mismatch': 'Rapid deck uses incompatible story-form guidance.',
  'no-candidate-cards': 'Rapid deck has no usable cards.',
  'selected-card-miss': 'Rapid selected cards are missing from cache.',
  'guidance-missing': 'Rapid deck has no usable guidance.',
  'delta-provider-failed': 'Rapid turn guidance failed.',
  'delta-invalid': 'Rapid turn guidance was invalid.',
  'delta-mandatory-gap': 'Rapid found a mandatory context gap.',
  'delta-empty': 'Rapid turn guidance was empty.',
  ready: 'Rapid deck ready.',
  stale: 'Rapid deck stale.',
  failed: 'Rapid warm failed.'
});

function cleanText(value, limit = SAFE_TEXT_LIMIT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  return UNSAFE_TEXT.test(text) ? '' : text;
}

function cleanStatus(value) {
  const status = cleanText(value, 40).toLowerCase();
  return ['idle', 'queued', 'warming', 'waiting', 'ready', 'missed', 'stale', 'failed'].includes(status)
    ? status
    : 'idle';
}

function sameHash(left, right) {
  return cleanText(left, 180) === cleanText(right, 180);
}

function guidanceUsable(guidance = {}) {
  return guidance?.schema === 'recursion.guidanceComposer.v1'
    && cleanText(guidance?.text, 6000).length > 0;
}

export function rapidWarmReasonLabel(code) {
  return REASON_LABELS[cleanText(code, 80)] || 'Rapid warm unavailable.';
}

export function rapidWarmMissReason({
  activeVariant = {},
  rapid = null,
  candidateCards = [],
  expectedContracts = {},
  baseSourceRevisionHash = '',
  storyFormMismatch = false
} = {}) {
  if (!activeVariant?.exact || !rapid) return { code: 'no-active-variant', label: rapidWarmReasonLabel('no-active-variant') };
  if (rapid.status === 'warming' || rapid.status === 'queued') return { code: 'warming', label: rapidWarmReasonLabel('warming') };
  if (rapid.status === 'failed') return { code: 'warm-failed', label: rapidWarmReasonLabel('warm-failed') };
  if (!sameHash(rapid.baseSourceRevisionHash, baseSourceRevisionHash)) return { code: 'source-mismatch', label: rapidWarmReasonLabel('source-mismatch') };
  if (!sameHash(rapid.settingsHash, expectedContracts.settingsHash)) return { code: 'settings-mismatch', label: rapidWarmReasonLabel('settings-mismatch') };
  if (!sameHash(rapid.providerContractHash, expectedContracts.providerContractHash)) return { code: 'provider-contract-mismatch', label: rapidWarmReasonLabel('provider-contract-mismatch') };
  if (!sameHash(rapid.cardCatalogHash, expectedContracts.cardCatalogHash)) return { code: 'catalog-mismatch', label: rapidWarmReasonLabel('catalog-mismatch') };
  if (!sameHash(rapid.promptContractHash, expectedContracts.promptContractHash)) return { code: 'prompt-contract-mismatch', label: rapidWarmReasonLabel('prompt-contract-mismatch') };
  if (storyFormMismatch) return { code: 'story-form-mismatch', label: rapidWarmReasonLabel('story-form-mismatch') };
  if (!Array.isArray(candidateCards) || candidateCards.length === 0) return { code: 'no-candidate-cards', label: rapidWarmReasonLabel('no-candidate-cards') };
  if (!Array.isArray(rapid.selectedCardIds) || rapid.selectedCardIds.length === 0) return { code: 'selected-card-miss', label: rapidWarmReasonLabel('selected-card-miss') };
  if (!guidanceUsable(rapid.guidance)) return { code: 'guidance-missing', label: rapidWarmReasonLabel('guidance-missing') };
  return { code: 'no-active-variant', label: rapidWarmReasonLabel('no-active-variant') };
}

export function rapidWarmStatusView(input = {}) {
  const reasonCode = cleanText(input.reasonCode || input.status || 'idle', 80) || 'idle';
  const fallbackLabel = rapidWarmReasonLabel(reasonCode);
  return {
    status: cleanStatus(input.status),
    pipelineMode: cleanText(input.pipelineMode, 40) === 'rapid' ? 'rapid' : 'standard',
    runId: cleanText(input.runId, 160),
    warmArtifactId: cleanText(input.warmArtifactId, 160),
    baseSourceRevisionHash: cleanText(input.baseSourceRevisionHash, 180),
    startedAt: cleanText(input.startedAt, 80),
    completedAt: cleanText(input.completedAt, 80),
    failedAt: cleanText(input.failedAt, 80),
    selectedCardCount: Math.max(0, Math.floor(Number(input.selectedCardCount) || 0)),
    cardCount: Math.max(0, Math.floor(Number(input.cardCount) || 0)),
    reasonCode,
    reasonLabel: cleanText(input.reasonLabel, SAFE_LABEL_LIMIT) || fallbackLabel,
    joinable: input.joinable === true
  };
}
```

- [ ] **Step 4: Run helper test**

Run:

```powershell
node tools\scripts\test-rapid-warm-state.mjs
```

Expected: PASS.

## Task 2: Split Rapid Warm From Foreground Run

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Add failing non-abort runtime test**

In `tools/scripts/test-runtime.mjs`, add a deferred helper near existing runtime helpers:

```js
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
```

Add a test:

```js
{
  const arbiterGate = deferred();
  const calls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', pipelineMode: 'rapid', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        calls.push(roleId);
        if (roleId === 'utilityArbiter') {
          await arbiterGate.promise;
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Warm visible status.' }],
              budgets: { targetBriefTokens: 600, maxCards: 3 },
              diagnostics: ['warm-non-abort']
            }
          };
        }
        if (roleId === 'sceneFrameCard') {
          return {
            ok: true,
            data: {
              schema: 'recursion.card.v1',
              role: 'sceneFrameCard',
              family: 'Scene Frame',
              snapshotHash: request.snapshotHash,
              items: [{ promptText: 'Warm card survives foreground send.', evidenceRefs: ['message:1'] }]
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Warm guidance survives foreground send.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['warm-guidance']
            }
          };
        }
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: [],
              turnGuidanceText: 'Turn guidance after join.',
              guardrailCardIds: [],
              packetInstructions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['joined-warm']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const warmPromise = runtime.warmRapidScene({ reason: 'unit-non-abort' });
  await Promise.resolve();
  const foregroundPromise = runtime.prepareForGeneration({ userMessage: 'Use current warm if ready.' });
  await Promise.resolve();
  arbiterGate.resolve();
  const [warmResult, foregroundResult] = await Promise.all([warmPromise, foregroundPromise]);
  assertEqual(warmResult.ok, true, 'background warm completes');
  assertEqual(foregroundResult.ok, true, 'foreground generation completes');
  assert(calls.includes('rapidTurnDelta'), 'foreground uses Rapid delta after joining warm');
}
```

- [ ] **Step 2: Run failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: FAIL because foreground `startRun()` aborts `warmRapidScene()`.

- [ ] **Step 3: Add separate warm run state**

In `src/runtime.mjs`, import helper constants:

```js
import {
  RAPID_WARM_JOIN_WAIT_MS,
  rapidWarmMissReason,
  rapidWarmReasonLabel,
  rapidWarmStatusView
} from './rapid-warm-state.mjs';
```

Near existing runtime variables, add:

```js
let activeRapidWarmRun = null;
let lastRapidWarmView = rapidWarmStatusView({ pipelineMode: settingsStore.get().pipelineMode });
```

Add helpers:

```js
function isActiveRapidWarmRun(runId) {
  return activeRapidWarmRun?.runId === runId;
}

function abortActiveRapidWarmRun(reasonCode = 'stale') {
  const current = activeRapidWarmRun;
  if (!current) return;
  try {
    current.controller?.abort?.();
  } catch {
    // Abort notification is best-effort.
  }
  lastRapidWarmView = rapidWarmStatusView({
    ...lastRapidWarmView,
    status: reasonCode === 'warm-failed' ? 'failed' : 'stale',
    reasonCode,
    reasonLabel: rapidWarmReasonLabel(reasonCode),
    joinable: false
  });
  activeRapidWarmRun = null;
}

function startRapidWarmRun(runId, context = {}) {
  abortActiveRapidWarmRun('stale');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  activeRapidWarmRun = {
    runId,
    controller,
    signal: controller?.signal ?? null,
    baseSourceRevisionHash: safeText(context.baseSourceRevisionHash || '', 180),
    startedAt: nowIso(),
    promise: null
  };
  lastRapidWarmView = rapidWarmStatusView({
    status: 'warming',
    pipelineMode: settingsStore.get().pipelineMode,
    runId,
    baseSourceRevisionHash: context.baseSourceRevisionHash,
    startedAt: activeRapidWarmRun.startedAt,
    reasonCode: 'warming',
    joinable: true
  });
  return activeRapidWarmRun.signal;
}

function clearRapidWarmRun(runId) {
  if (activeRapidWarmRun?.runId === runId) activeRapidWarmRun = null;
}
```

- [ ] **Step 4: Convert warmRapidScene to warm run state**

In `warmRapidScene()`, replace:

```js
const signal = startRun(runId);
```

with:

```js
const signal = startRapidWarmRun(runId, {});
```

After reading `snapshot`, set the base source on the active warm:

```js
const warmBaseSourceRevisionHash = activeSourceRevisionHash(snapshot);
if (activeRapidWarmRun?.runId === runId) {
  activeRapidWarmRun.baseSourceRevisionHash = warmBaseSourceRevisionHash;
  lastRapidWarmView = rapidWarmStatusView({
    ...lastRapidWarmView,
    baseSourceRevisionHash: warmBaseSourceRevisionHash,
    joinable: true
  });
}
```

Replace `isActiveRun(runId)` checks in `warmRapidScene()` with `isActiveRapidWarmRun(runId)`. Leave foreground functions unchanged.

In `finally`, replace:

```js
clearActiveRun(runId);
```

with:

```js
clearRapidWarmRun(runId);
```

- [ ] **Step 5: Abort warm on global invalidation**

Call `abortActiveRapidWarmRun('stale')` in cleanup paths that invalidate source or settings:

```js
function clearVolatileSceneState() {
  abortActiveRapidWarmRun('stale');
  lastPacket = null;
  lastHand = { cards: [], omitted: [] };
  lastPlan = null;
  lastSnapshot = null;
  lastSavedSceneCacheRef = null;
  pendingLatestAssistantSwipeRetry = null;
}
```

In `dispose()`:

```js
async dispose() {
  supersedeActiveRun();
  abortActiveRapidWarmRun('stale');
  await waitForExternalMutations();
}
```

- [ ] **Step 6: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: The new non-abort assertion passes or reaches the next missing foreground join behavior.

## Task 3: Persist Warming, Ready, Failed

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `src/storage.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-storage.mjs`

- [ ] **Step 1: Add failing runtime persistence test**

Add a runtime test that starts a blocked warm and reads storage before releasing the provider:

```js
{
  const gate = deferred();
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', pipelineMode: 'rapid', reasonerUse: 'off' },
    storage,
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          await gate.promise;
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'skip',
              diagnostics: ['blocked-warm']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const warmPromise = runtime.warmRapidScene({ reason: 'unit-warming-persist' });
  await Promise.resolve();
  const view = runtime.view();
  assertEqual(view.rapidWarm.status, 'warming', 'runtime view exposes warming state');
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const active = cache.variants[cache.activeSourceRevisionHash];
  assertEqual(active.rapid.status, 'warming', 'scene cache persists warming status before provider work completes');
  gate.resolve();
  await warmPromise;
}
```

- [ ] **Step 2: Add storage sanitizer test**

In `tools/scripts/test-storage.mjs`, save and reload a Rapid failed artifact:

```js
await repo.saveSceneCache('rapid-status-chat', 'rapid-status-scene', {
  activeSourceRevisionHash: 'source-a',
  variants: {
    'source-a': {
      sourceRevisionHash: 'source-a',
      rapid: {
        pipelineVersion: 2,
        status: 'failed',
        warmArtifactId: 'rapid-warm-artifact-a',
        baseSourceRevisionHash: 'source-a',
        startedAt: '2026-07-03T08:00:00.000Z',
        failedAt: '2026-07-03T08:00:03.000Z',
        failureReasonCode: 'warm-failed',
        failureReasonLabel: 'authorization: Bearer secret-token'
      }
    }
  },
  variantOrder: ['source-a']
});
const cache = await repo.loadSceneCache('rapid-status-chat', 'rapid-status-scene');
const rapid = cache.variants['source-a'].rapid;
assertEqual(rapid.status, 'failed', 'rapid failed status persists');
assertEqual(rapid.failureReasonCode, 'warm-failed', 'rapid failed reason code persists');
assert(!JSON.stringify(rapid).includes('Bearer'), 'rapid failed reason label is sanitized');
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
node tools\scripts\test-runtime.mjs
node tools\scripts\test-storage.mjs
```

Expected: FAIL because warming and failed metadata are not persisted.

- [ ] **Step 4: Extend storage sanitizer**

In `normalizeRapidWarmArtifact()` in `src/storage.mjs`, preserve safe metadata:

```js
startedAt: safeMetadataText(value.startedAt || '', 80, ''),
failedAt: safeMetadataText(value.failedAt || '', 80, ''),
failureReasonCode: safeMetadataText(value.failureReasonCode || '', 80, ''),
failureReasonLabel: safeMetadataText(value.failureReasonLabel || '', 240, ''),
```

The existing `redactSecretText(redact(...))` path must remove unsafe label text.

- [ ] **Step 5: Add runtime rapid status persistence helper**

In `src/runtime.mjs`, add:

```js
async function persistRapidWarmStatus(runId, snapshot, cache, rapidPatch = {}) {
  const active = activeSceneCacheVariant(cache, snapshot);
  const deck = {
    cards: Array.isArray(active.cards) ? active.cards : [],
    latestHand: active.latestHand || null
  };
  const rapid = {
    pipelineVersion: RAPID_PIPELINE_VERSION,
    status: safeText(rapidPatch.status || 'warming', 40),
    warmArtifactId: safeText(rapidPatch.warmArtifactId || makeId('rapid-warm-artifact'), 160),
    baseSourceRevisionHash: activeSourceRevisionHash(snapshot),
    baseSnapshotHash: hashJson(snapshot),
    selectedCardIds: Array.isArray(rapidPatch.selectedCardIds) ? rapidPatch.selectedCardIds : [],
    cardIds: Array.isArray(rapidPatch.cardIds) ? rapidPatch.cardIds : [],
    guidance: rapidPatch.guidance || {
      schema: GUIDANCE_SCHEMA,
      status: 'missing',
      text: '',
      sourceCardIds: [],
      guardrailCardIds: [],
      omittedCardIds: [],
      diagnostics: []
    },
    storyForm: rapidPatch.storyForm || UNKNOWN_STORY_FORM,
    ...cacheContractVersions(settingsStore.get()),
    startedAt: rapidPatch.startedAt || nowIso(),
    builtAt: rapidPatch.builtAt || '',
    failedAt: rapidPatch.failedAt || '',
    failureReasonCode: safeText(rapidPatch.failureReasonCode || '', 80),
    failureReasonLabel: safeText(rapidPatch.failureReasonLabel || '', 240),
    runId,
    diagnostics: mergeDiagnostics(rapidPatch.diagnostics, [`rapid-warm-${safeText(rapidPatch.status || 'warming', 40)}`])
  };
  if (rapid.status === 'ready') rapid.artifactHash = rapidArtifactHash(rapid);
  await runStorageSaveSection(runId, () => saveSceneCacheSafe(
    runId,
    snapshot,
    sceneCachePayload(snapshot, deck, active.latestHand || { cards: [], omitted: [] }, lastPlan, null, settingsStore.get(), cache, { rapid })
  ));
  return rapid;
}
```

- [ ] **Step 6: Call persistence helper from warmRapidScene**

After loading cache in `warmRapidScene()`:

```js
const warmingRapid = await persistRapidWarmStatus(runId, snapshot, cache, {
  status: 'warming',
  startedAt: nowIso(),
  diagnostics: [`rapid-warm-started:${safeText(reason, 80)}`]
});
lastRapidWarmView = rapidWarmStatusView({
  ...lastRapidWarmView,
  warmArtifactId: warmingRapid.warmArtifactId,
  status: 'warming',
  reasonCode: 'warming',
  joinable: true
});
```

On success, replace the direct ready save with `persistRapidWarmStatus(runId, snapshot, cache, { status: 'ready', ...readyFields })`.

On catch, persist failed:

```js
await persistRapidWarmStatus(runId, lastSnapshot || await readSnapshot(), cache || {}, {
  status: 'failed',
  failedAt: nowIso(),
  failureReasonCode: 'warm-failed',
  failureReasonLabel: rapidWarmReasonLabel('warm-failed'),
  diagnostics: ['rapid-warm-failed']
});
lastRapidWarmView = rapidWarmStatusView({
  ...lastRapidWarmView,
  status: 'failed',
  failedAt: nowIso(),
  reasonCode: 'warm-failed',
  reasonLabel: rapidWarmReasonLabel('warm-failed'),
  joinable: false
});
```

- [ ] **Step 7: Expose rapidWarm in runtime view**

In `view()` return:

```js
rapidWarm: rapidWarmStatusView({
  ...lastRapidWarmView,
  pipelineMode: settingsStore.get().pipelineMode
}),
```

- [ ] **Step 8: Run tests**

Run:

```powershell
node tools\scripts\test-runtime.mjs
node tools\scripts\test-storage.mjs
```

Expected: PASS for warming, ready, failed, and storage sanitizer assertions.

## Task 4: Foreground Join And Precise Miss Reasons

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Add foreground join test**

Add a test where `warmRapidScene()` finishes inside the join window:

```js
{
  const warmGate = deferred();
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', pipelineMode: 'rapid', reasonerUse: 'off' },
    rapidHedgeDelayMs: -1,
    generationRouter: {
      async generate(roleId, request) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          await warmGate.promise;
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'join warm' }],
              budgets: { targetBriefTokens: 600, maxCards: 3 },
              diagnostics: ['join-warm']
            }
          };
        }
        if (roleId === 'sceneFrameCard') {
          return {
            ok: true,
            data: {
              schema: 'recursion.card.v1',
              role: 'sceneFrameCard',
              family: 'Scene Frame',
              snapshotHash: request.snapshotHash,
              items: [{ promptText: 'JOIN_WARM_CARD_MARKER', evidenceRefs: ['message:1'] }]
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'JOIN_WARM_GUIDANCE_MARKER',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['join-guidance']
            }
          };
        }
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: [],
              turnGuidanceText: 'JOIN_TURN_GUIDANCE_MARKER',
              guardrailCardIds: [],
              packetInstructions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['join-delta']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const warmPromise = runtime.warmRapidScene({ reason: 'unit-join' });
  await Promise.resolve();
  const foregroundPromise = runtime.prepareForGeneration({ userMessage: 'Join the warm deck.' });
  await Promise.resolve();
  assertEqual(runtime.view().rapidWarm.status, 'waiting', 'foreground exposes waiting state while joining warm');
  warmGate.resolve();
  const result = await foregroundPromise;
  await warmPromise;
  assertEqual(result.ok, true, 'foreground succeeds after warm join');
  assert(roleCalls.includes('rapidTurnDelta'), 'Rapid delta runs after join');
  assert(runtime.view().lastPacket.diagnostics.rapidPath === 'warm-v2', 'joined turn records warm-v2 path');
}
```

- [ ] **Step 2: Add timeout fallback test**

Use a warm gate that resolves after `prepareForGeneration()` returns. Assert:

```js
assertEqual(runtime.view().rapidWarm.reasonCode, 'warm-timeout', 'timeout reason is exposed');
assert(runtime.view().lastPlan.diagnostics.includes('rapid-warm-miss:warm-timeout'), 'timeout diagnostic is recorded');
assert(roleCalls.filter((role) => role === 'utilityArbiter').length >= 1, 'Standard arbiter runs after timeout');
```

- [ ] **Step 3: Add miss reason tests**

Seed scene cache variants with wrong settings hash, wrong prompt hash, empty card list, and missing selected card ids. Assert diagnostics include:

```js
'rapid-warm-miss:settings-mismatch'
'rapid-warm-miss:prompt-contract-mismatch'
'rapid-warm-miss:no-candidate-cards'
'rapid-warm-miss:selected-card-miss'
```

- [ ] **Step 4: Run failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: FAIL because foreground does not wait for active warm and miss reasons are generic.

- [ ] **Step 5: Add join helpers to runtime**

In `src/runtime.mjs`, add:

```js
function exactWarmRunForSource(baseSourceRevisionHash, expectedContracts) {
  const warm = activeRapidWarmRun;
  if (!warm || !warm.promise) return null;
  if (warm.signal?.aborted === true) return null;
  if (safeText(warm.baseSourceRevisionHash || '', 180) !== safeText(baseSourceRevisionHash || '', 180)) return null;
  const contract = warm.contract || {};
  for (const key of ['settingsHash', 'providerContractHash', 'cardCatalogHash', 'promptContractHash']) {
    if (safeText(contract[key] || '', 180) !== safeText(expectedContracts[key] || '', 180)) return null;
  }
  return warm;
}

async function waitForRapidWarm(runId, warmRun, timeoutMs = RAPID_WARM_JOIN_WAIT_MS) {
  lastRapidWarmView = rapidWarmStatusView({
    ...lastRapidWarmView,
    status: 'waiting',
    reasonCode: 'warming',
    reasonLabel: 'Waiting for Rapid deck...',
    joinable: true
  });
  stageRuntimeActivity({
    runId,
    phase: 'rapidWarmWaiting',
    label: 'Waiting for Rapid deck...',
    chips: ['Rapid']
  });
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, timeout: true }), Math.max(0, timeoutMs));
  });
  const result = await Promise.race([warmRun.promise, timeout]);
  if (result?.ok === true && result?.rapid?.status === 'ready') return result;
  if (result?.timeout) return { ok: false, reasonCode: 'warm-timeout' };
  return { ok: false, reasonCode: 'warm-failed' };
}
```

When `warmRapidScene()` starts, set:

```js
activeRapidWarmRun.contract = cacheContractVersions(settings);
activeRapidWarmRun.promise = warmPromise;
```

If the function structure cannot assign its own promise internally, wrap the existing warm body:

```js
const warmPromise = runRapidWarmBody({ runId, reason, settings, signal });
activeRapidWarmRun.promise = warmPromise;
return await warmPromise;
```

- [ ] **Step 6: Use join in prepareRapidForGeneration**

In `prepareRapidForGeneration()`, before generic miss escalation:

```js
if (!usableWarm) {
  const miss = rapidWarmMissReason({
    activeVariant,
    rapid,
    candidateCards,
    expectedContracts,
    baseSourceRevisionHash
  });
  const joinableWarm = miss.code === 'warming'
    ? exactWarmRunForSource(baseSourceRevisionHash, expectedContracts)
    : null;
  if (joinableWarm) {
    const joined = await waitForRapidWarm(runId, joinableWarm, RAPID_WARM_JOIN_WAIT_MS);
    if (!isActiveRun(runId)) return supersededResult(runId);
    if (joined?.ok === true) {
      const reloadedCache = await loadSceneCacheSafe(runId, baseSnapshot, settings);
      return await prepareRapidForGeneration({
        runId,
        baseSnapshot,
        turnSnapshot,
        pendingUserMessage,
        initialCache: reloadedCache,
        settings,
        signal
      });
    }
    lastRapidWarmView = rapidWarmStatusView({
      ...lastRapidWarmView,
      status: 'missed',
      reasonCode: joined.reasonCode || 'warm-failed',
      reasonLabel: rapidWarmReasonLabel(joined.reasonCode || 'warm-failed'),
      joinable: false
    });
    return {
      ok: false,
      escalateToStandard: true,
      diagnostics: [...warmMissDiagnostics(), `rapid-warm-miss:${joined.reasonCode || 'warm-failed'}`]
    };
  }
  lastRapidWarmView = rapidWarmStatusView({
    ...lastRapidWarmView,
    status: 'missed',
    reasonCode: miss.code,
    reasonLabel: miss.label,
    joinable: false
  });
  stageRuntimeActivity({
    runId,
    phase: 'rapidWarmMissStandard',
    label: 'Rapid warm missed; Standard started.',
    chips: ['Rapid', 'Standard'],
    detail: { reasonCode: miss.code, reasonLabel: miss.label }
  });
  return {
    ok: false,
    escalateToStandard: true,
    diagnostics: [...warmMissDiagnostics(), `rapid-warm-miss:${miss.code}`]
  };
}
```

- [ ] **Step 7: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS for join, timeout, and miss reason assertions.

## Task 5: Progress Model And Compact UI

**Files:**
- Modify: `src/progress.mjs`
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `tools/scripts/test-ui.mjs`

- [ ] **Step 1: Add progress tests**

In `tools/scripts/test-progress.mjs`, add:

```js
const rapidWaitingProgress = createProgressRunModel({
  settings: { pipelineMode: 'rapid' },
  rapidWarm: {
    status: 'waiting',
    reasonCode: 'warming',
    reasonLabel: 'Waiting for Rapid deck...',
    runId: 'rapid-wait',
    joinable: true
  },
  activity: { phase: 'idle' }
});
assert(rapidWaitingProgress.steps.some((step) => step.id === 'rapid-warm-waiting'), 'rapid waiting status creates progress row');
assertEqual(rapidWaitingProgress.currentStepText, 'Waiting for Rapid deck...', 'rapid waiting owns compact current step');

const rapidFailedProgress = createProgressRunModel({
  settings: { pipelineMode: 'rapid' },
  rapidWarm: {
    status: 'failed',
    reasonCode: 'warm-failed',
    reasonLabel: 'Rapid warm failed.',
    runId: 'rapid-failed'
  },
  activity: { phase: 'idle' }
});
const failedStep = rapidFailedProgress.steps.find((step) => step.id === 'rapid-warm-failed');
assert(failedStep, 'rapid failed status creates failed progress row');
assertEqual(failedStep.state, 'failed', 'rapid failed progress row is failed');

const rapidReadyProgress = createProgressRunModel({
  settings: { pipelineMode: 'rapid' },
  rapidWarm: {
    status: 'ready',
    reasonCode: 'ready',
    reasonLabel: 'Rapid deck ready.',
    runId: 'rapid-ready',
    selectedCardCount: 3
  },
  activity: { phase: 'idle' }
});
assert(rapidReadyProgress.steps.some((step) => step.id === 'rapid-deck-ready'), 'rapid ready status creates ready progress row');
assertEqual(rapidReadyProgress.heroPixelState, 'done', 'rapid ready progress is successful');
```

- [ ] **Step 2: Add UI tests**

In `tools/scripts/test-ui.mjs`, add:

```js
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true, pipelineMode: 'rapid' },
    rapidWarm: { status: 'warming', reasonLabel: 'Rapid warming scene deck.', reasonCode: 'warming' },
    activity: { phase: 'idle' },
    lastHand: { cards: [] }
  }).standbyStatusText,
  'Rapid warming scene deck.',
  'rapid warming status appears in compact standby text'
);

assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true, pipelineMode: 'rapid' },
    rapidWarm: { status: 'ready', reasonLabel: 'Rapid deck ready.', reasonCode: 'ready', selectedCardCount: 3 },
    activity: { phase: 'idle' },
    lastHand: { cards: [] }
  }).standbyStatusText,
  'Rapid deck ready.',
  'rapid ready status persists even when current activity is idle'
);

assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true, pipelineMode: 'standard' },
    rapidWarm: { status: 'ready', reasonLabel: 'Rapid deck ready.', reasonCode: 'ready' },
    activity: { phase: 'idle' },
    lastHand: { cards: [] }
  }).standbyStatusText,
  'Ready for Recursion.',
  'rapid status does not override Standard Pipeline UI'
);
```

- [ ] **Step 3: Run failing progress/UI tests**

Run:

```powershell
node tools\scripts\test-progress.mjs
node tools\scripts\test-ui.mjs
```

Expected: FAIL because `rapidWarm` view is not consumed.

- [ ] **Step 4: Add progress phases**

In `src/progress.mjs`, add step ids:

```js
'rapid-warm-waiting',
'rapid-warm-failed',
```

Add definitions:

```js
'rapid-warm-waiting': { label: 'Waiting for Rapid deck', providerLane: 'utility' },
'rapid-warm-failed': { label: 'Rapid warm failed', providerLane: 'utility' },
```

Add phase mappings:

```js
rapidWarmWaiting: 'rapid-warm-waiting',
rapidWarmFailed: 'rapid-warm-failed',
```

Add a normalizer that merges `source.rapidWarm` when `settings.pipelineMode === 'rapid'`:

```js
function rapidWarmStep(source = {}) {
  const warm = asObject(source.rapidWarm);
  if (asObject(source.settings).pipelineMode !== 'rapid') return null;
  if (!warm.status || warm.status === 'idle') return null;
  const byStatus = {
    warming: ['rapid-warming-scene-deck', 'Rapid warming scene deck', 'running', 'warming'],
    waiting: ['rapid-warm-waiting', 'Waiting for Rapid deck', 'running', 'waiting'],
    ready: ['rapid-deck-ready', 'Rapid deck ready', 'done', 'ready'],
    missed: ['rapid-warm-miss-standard', 'Rapid warm miss; Standard', 'warning', 'missed'],
    failed: ['rapid-warm-failed', 'Rapid warm failed', 'failed', 'failed'],
    stale: ['rapid-deck-stale', 'Rapid deck stale', 'warning', 'stale']
  };
  const tuple = byStatus[warm.status];
  if (!tuple) return null;
  return normalizeStep({
    id: tuple[0],
    label: safeDisplayText(warm.reasonLabel, tuple[1], 120),
    providerLane: 'utility',
    state: tuple[2],
    meta: tuple[3],
    reason: safeDisplayText(warm.reasonLabel, '', 160)
  }, 0);
}
```

Merge this step into `createProgressRunModel()` after explicit/derived run construction, avoiding duplicate ids.

- [ ] **Step 5: Update UI model**

In `src/ui.mjs`, add phase labels:

```js
rapidWarmWaiting: 'Waiting for Rapid deck...',
rapidWarmFailed: 'Rapid warm failed.',
```

In `createRecursionViewModel()`, before generic idle standby text, prefer valid Rapid state when `settings.pipelineMode === 'rapid'`:

```js
const rapidWarm = asObject(view.rapidWarm);
if (settings.pipelineMode === 'rapid' && ['warming', 'waiting', 'ready', 'missed', 'failed', 'stale'].includes(rapidWarm.status)) {
  standbyStatusText = cleanText(rapidWarm.reasonLabel || PHASE_LABELS[`rapidWarm${titleCase(rapidWarm.status)}`] || 'Rapid deck standing by.');
}
```

Keep this branch below active foreground work so `Installing Recursion prompt...` and provider calls still win while running.

- [ ] **Step 6: Run progress/UI tests**

Run:

```powershell
node tools\scripts\test-progress.mjs
node tools\scripts\test-ui.mjs
```

Expected: PASS.

## Task 6: Extension Smoke And Settings Truth

**Files:**
- Modify: `tools/scripts/test-extension-smoke.mjs`
- Modify: `src/extension/index.js` only if the test proves the existing event path hides warm activity

- [ ] **Step 1: Add extension smoke test**

Extend the existing fake runtime warm test so `warmRapidScene()` records activity-visible state:

```js
const warmViews = [];
const fakeRuntime = {
  view() {
    return {
      settings: { enabled: true, mode: 'auto', pipelineMode: 'rapid' },
      rapidWarm: warmViews.at(-1) || { status: 'idle', pipelineMode: 'rapid' },
      activity: { phase: 'idle' },
      lastHand: { cards: [] }
    };
  },
  async warmRapidScene(input = {}) {
    warmViews.push({ status: 'warming', pipelineMode: 'rapid', reasonCode: 'warming', reasonLabel: 'Rapid warming scene deck.', runId: 'rapid-warm-smoke' });
    warmViews.push({ status: 'ready', pipelineMode: 'rapid', reasonCode: 'ready', reasonLabel: 'Rapid deck ready.', runId: 'rapid-warm-smoke', selectedCardCount: 3 });
    return { ok: true, reason: input.reason };
  }
};
```

Assert:

```js
assert(warmViews.some((view) => view.status === 'warming'), 'assistant landing exposes Rapid warming state');
assert(warmViews.some((view) => view.status === 'ready'), 'assistant landing exposes Rapid ready state');
```

- [ ] **Step 2: Run extension smoke test**

Run:

```powershell
node tools\scripts\test-extension-smoke.mjs
```

Expected: PASS if existing glue already calls `warmRapidScene()` and rerenders view. FAIL if UI rerender does not observe warm status.

- [ ] **Step 3: Fix extension glue only if needed**

If the test fails because no render happens after warm state changes, ensure the warm call path schedules UI refresh after starting and after finishing:

```js
void runtime.warmRapidScene({ reason: 'assistant-message-landed' })
  .finally(() => renderRecursionUi());
renderRecursionUi();
```

Do not block host generation and do not install prompts from this path.

- [ ] **Step 4: Run extension smoke test**

Run:

```powershell
node tools\scripts\test-extension-smoke.mjs
```

Expected: PASS.

## Task 7: Documentation Updates

**Files:**
- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/user/FIRST_RUN_WORKFLOW.md` if it describes Rapid status

- [ ] **Step 1: Update design contract**

In `DESIGN.md`, update the Recursion Bar and Hero Pixel Array sections with:

```markdown
When Rapid Pipeline is selected, Rapid warm state is allowed to remain visible beyond the normal four-second standby window. `Rapid warming scene deck.`, `Waiting for Rapid deck.`, `Rapid deck ready.`, `Rapid warm missed; Standard started.`, and `Rapid warm failed.` describe active workflow readiness, not transient control acknowledgements.
```

- [ ] **Step 2: Update UI spec**

In `docs/design/UI_SPEC.md`, add Rapid warm statuses to the progress section:

```markdown
Rapid Pipeline adds warm-state progress rows: `rapidWarming`, `rapidWarmWaiting`, `rapidWarmReady`, `rapidWarmMissStandard`, `rapidWarmFailed`, `rapidWarmStale`, and `rapidDeltaRunning`. Background warm rows are visible when Rapid is selected because they determine whether the next send can use the warmed card packet.
```

Add:

```markdown
The progress popover should not auto-open for background warm work. If already open, it updates in place. The compact bar may show persistent `Rapid deck ready.` until source or settings change.
```

- [ ] **Step 3: Update architecture docs**

In `docs/architecture/RUNTIME_ARCHITECTURE.md`, document:

```markdown
Rapid warm work uses a separate warm run controller from foreground prompt preparation. Foreground sends do not supersede exact-source warm work. Source invalidation, chat change, settings change, dispose, and explicit stop paths abort stale warm work.
```

- [ ] **Step 4: Update turn sequence**

In `docs/technical/RUNTIME_TURN_SEQUENCE.md`, add:

```text
Assistant landed -> Rapid warm starts -> status warming -> warm ready or failed
User send in Rapid -> ready warm uses Rapid -> in-flight exact warm waits up to 4000 ms -> miss starts Standard with reason
```

- [ ] **Step 5: Update user docs**

Add concise user-facing descriptions:

```markdown
- `Rapid warming scene deck.` means Recursion is preparing the next turn in the background.
- `Rapid deck ready.` means the next send can use warmed card evidence and guidance.
- `Waiting for Rapid deck.` means the send caught an exact warm job near completion.
- `Rapid warm missed; Standard started.` means Recursion preserved quality by using Standard for this turn.
```

- [ ] **Step 6: Run docs search**

Run:

```powershell
rg -n "Rapid warm packet unavailable|Rapid deck ready|rapidWarmWaiting|rapidWarmFailed|Rapid warming scene deck" DESIGN.md docs src tools\scripts
```

Expected: old generic copy remains only where intentionally mapped to a safe fallback or historical docs; current docs mention new statuses.

## Task 8: Full Verification And Live Proof

**Files:**
- All modified files

- [ ] **Step 1: Run focused tests**

Run:

```powershell
node tools\scripts\test-rapid-warm-state.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-storage.mjs
node tools\scripts\test-progress.mjs
node tools\scripts\test-ui.mjs
node tools\scripts\test-extension-smoke.mjs
```

Expected: all PASS.

- [ ] **Step 2: Run alpha gate**

Run:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: PASS.

- [ ] **Step 3: Check diff hygiene**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 4: Verify served extension freshness before live proof**

Run the repo's served-copy proof or compare the served SillyTavern extension files against the repo files touched in this plan. The live path to check is:

```text
F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion
```

Expected: served `src/runtime.mjs`, `src/ui.mjs`, `src/progress.mjs`, and any new helper files match the repo copy used for tests.

- [ ] **Step 5: Run Rapid live proof**

Use the existing live prompt/pipeline proof scripts against a dedicated SillyTavern user or the current default-user SG-1 chat when explicitly selected for proof:

```powershell
node tools\scripts\prove-live-pipelines.mjs
```

Expected live evidence:

- Rapid selected in runtime settings and visible pipeline icon.
- Assistant landing starts `rapidWarming`.
- Progress menu shows Rapid warm work.
- Warm success shows persistent `Rapid deck ready.`.
- Sending during exact in-flight warm shows `Waiting for Rapid deck...`.
- Warm completion inside 4000 ms uses `rapidPath: warm-v2`.
- Warm miss reports a specific `rapid-warm-miss:<reason>` and runs Standard.
- Prompt packet still contains `recursion.guidance`, `recursion.cardEvidence`, and `recursion.guardrails`.

- [ ] **Step 6: Final source review**

Run:

```powershell
git diff -- src tools docs DESIGN.md
```

Check:

- No foreground `startRun()` call remains inside `warmRapidScene()`.
- No user send aborts exact active Rapid warm work.
- Warm state persists before provider calls.
- Miss diagnostics include reason codes.
- UI exposes Rapid state only when `pipelineMode === 'rapid'`.
- No local semantic composer, local Rapid brief, or summary-only fast-start was introduced.
- No raw provider output or secret-bearing text is exposed in view, progress, journal, or docs examples.

## Execution Notes

Implement tasks in order. Keep commits optional unless the user asks. Recursion is pre-alpha, so update contracts in place and do not add compatibility shims for old Rapid warm behavior.

## Self-Review

- Spec coverage: Tasks cover state helper, runtime coordination, persistence, foreground join, miss reasons, progress/UI, docs, and live proof.
- Open-item scan: no unresolved markers remain.
- Type consistency: plan uses `rapidWarm`, `rapidWarmWaiting`, `rapidWarmFailed`, `RAPID_WARM_JOIN_WAIT_MS`, `rapidWarmMissReason`, and `rapidWarmStatusView` consistently.
- Scope check: plan avoids prompt packet rewrite and provider schema changes; those stay under the earlier card-packet pipeline revision.
