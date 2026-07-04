# Recursion Refactor And Bug Hunt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Recursion's largest runtime, UI, provider, and host-boundary modules while fixing the confirmed and likely bugs found in the first full-extension audit.

**Architecture:** Start with correctness fixes that have narrow blast radius, then extract shared safety helpers, provider host discovery, runtime pipeline seams, and UI surface modules. Keep the public runtime API and SillyTavern extension behavior stable while moving implementation details behind smaller modules with deterministic tests for each boundary.

**Tech Stack:** JavaScript ES modules, SillyTavern extension adapter, Recursion deterministic Node test scripts, markdown architecture/design docs, optional guarded Playwright live smoke after host-facing changes.

---

## Scope Check

This plan spans four subsystems: runtime pipelines, UI surfaces, provider/host boundaries, and diagnostics/tests. Execute it as one refactor program, but treat each task as independently shippable. Stop after any task if `npm.cmd test` or the task-specific gate fails.

Recursion is pre-alpha. Do not preserve compatibility shims for old internal shapes when a cleaner V1 contract exists. When a contract changes, update code, tests, docs, schemas, and examples in place.

Before any visible UI change, re-read:

```powershell
Get-Content .\DESIGN.md
Get-Content .\docs\design\UI_SPEC.md
```

---

## File Structure

- `src/activity.mjs` - activity event normalization and composer/provider lane validation.
- `src/ui.mjs` - temporary integration point while UI surfaces are extracted.
- `src/ui/provider-panel.mjs` - new provider-pane draft/readiness/copy helpers.
- `src/ui/action-status.mjs` - new small helper for UI action success/failure normalization.
- `src/safe-values.mjs` - new shared object/text/diagnostic safety helpers.
- `src/providers.mjs` - provider routing/client/configuration after host profile discovery is removed.
- `src/hosts/sillytavern/provider-profiles.mjs` - new SillyTavern connection-profile discovery module.
- `src/hosts/sillytavern/host.mjs` - host adapter exposes profile discovery and shared message normalization.
- `src/extension/index.js` - bootstrap/lifecycle only after host event normalization moves into the adapter.
- `src/runtime.mjs` - conductor while pipeline/state helpers are extracted.
- `src/runtime/run-state.mjs` - new active run, prompt mutation, force-regenerate, and swipe-retry state helpers.
- `src/runtime/prompt-install.mjs` - new prompt clear/install/reinstall orchestration helpers.
- `src/runtime/pipelines/standard.mjs` - new Standard card generation path.
- `src/runtime/pipelines/fused.mjs` - new Fused card bundle path.
- `src/runtime/pipelines/rapid.mjs` - new Rapid warm and foreground path.
- `src/runtime/diagnostics.mjs` - new explicit diagnostics export payload builder.
- `src/rapid-pipeline.mjs` - existing Rapid artifact, turn-delta prompt, turn-delta normalization, and hedge helper contracts.
- `src/rapid-warm-state.mjs` - existing Rapid warm status, miss reason, label, and join-timeout contracts.
- `src/cards.mjs` - card request construction, Fused bundle request construction, item-level Fused validation, and targeted repair planning.
- `src/providers/structured-output-parser.mjs` - generic structured JSON repair and Fused fragment recovery helpers.
- `src/providers/provider-response-normalizer.mjs` - provider visible-text extraction and token-limit classification used before parsing.
- `styles/recursion.css` - later structural cleanup only, grouped by extracted UI surfaces.
- `tools/scripts/test-activity.mjs` - composer-lane regression test.
- `tools/scripts/test-ui.mjs` - provider draft/readiness, tooltip copy, action-status, and surface-contract tests.
- `tools/scripts/test-providers.mjs` - provider core remains host-neutral; host discovery moves.
- `tools/scripts/test-host.mjs` - SillyTavern profile discovery and message normalization tests.
- `tools/scripts/test-runtime.mjs` - runtime public behavior remains stable during extraction.
- `tools/scripts/test-rapid-pipeline.mjs` - focused Rapid artifact, delta, and hedge contract tests.
- `tools/scripts/test-rapid-warm-state.mjs` - focused Rapid status and miss-reason tests.
- `tools/scripts/test-cards.mjs` - Fused item salvage, invalid item classification, and repair-plan tests.
- `tools/scripts/test-provider-response-parser.mjs` - damaged structured-output recovery tests.
- `tools/scripts/test-diagnostics.mjs` - new explicit diagnostics payload tests if no existing diagnostics-only suite exists.
- `docs/architecture/RUNTIME_ARCHITECTURE.md` - runtime module and pipeline boundary updates.
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md` - provider/host discovery contract updates.
- `docs/technical/HOST_INTEGRATION_MANUAL.md` - host adapter responsibilities.
- `docs/design/UI_SPEC.md` - provider pane copy/action-status behavior if visible UI text changes.
- `docs/testing/LIVE_SMOKE_TEST_PLAN.md` - host-facing verification notes after provider/extension boundary changes.

---

## Phase 1: Confirmed Bug Fixes Before Moving Boundaries

### Task 1: Preserve Guidance Composer Activity Lane

**Files:**
- Modify: `src/activity.mjs`
- Modify: `tools/scripts/test-activity.mjs`

- [ ] **Step 1: Write the failing activity test**

Add this block after the existing `laneReporter` assertions in `tools/scripts/test-activity.mjs`:

```js
const guidanceLaneReporter = createActivityReporter();
const guidanceLaneRun = guidanceLaneReporter.start({
  runId: 'guidance-lane-run',
  label: 'Guidance lane start'
});
guidanceLaneReporter.stage({
  runId: guidanceLaneRun.runId,
  phase: 'guidanceFallback',
  composerLane: 'guidance',
  label: 'Guidance fallback'
});
assertEqual(
  guidanceLaneReporter.current().composerLane,
  'guidance',
  'guidance composer lane is preserved for fallback prompt composition'
);
```

- [ ] **Step 2: Run the focused failing test**

Run:

```powershell
node tools\scripts\test-activity.mjs
```

Expected before implementation: FAIL with the new assertion showing `null` instead of `guidance`.

- [ ] **Step 3: Accept the guidance lane**

Change `src/activity.mjs`:

```js
const VALID_COMPOSER_LANES = new Set(['utility', 'guidance', 'reasoner', 'local']);
```

- [ ] **Step 4: Run focused and full gates**

Run:

```powershell
node tools\scripts\test-activity.mjs
npm.cmd test
```

Expected: both pass.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\activity.mjs tools\scripts\test-activity.mjs
git commit -m "fix: preserve guidance activity lane"
```

---

### Task 2: Make Provider Readiness Use Current Blank Controls

**Files:**
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-ui.mjs`

- [ ] **Step 1: Export a testable provider draft reader**

In `src/ui.mjs`, replace the current private `providerFromControls(container, lane, savedProvider = {})` body with exported helpers that distinguish missing controls from blank controls:

```js
function controlElement(root, selector) {
  return root?.querySelector?.(selector) ?? null;
}

function controlValueOrFallback(root, selector, fallback = '') {
  const element = controlElement(root, selector);
  if (!element) return fallback;
  return cleanText(element.value);
}

export function providerFromControls(container, lane, savedProvider = {}) {
  const saved = asObject(savedProvider);
  const savedOpenAI = asObject(saved.openAICompatible);
  return {
    source: controlValueOrFallback(container, providerSelector('source', lane), saved.source || 'host-current-model') || 'host-current-model',
    hostConnectionProfileId: controlValueOrFallback(container, providerSelector('profile', lane), saved.hostConnectionProfileId || ''),
    openAICompatible: {
      baseUrl: controlValueOrFallback(container, providerSelector('base-url', lane), savedOpenAI.baseUrl || ''),
      model: controlValueOrFallback(container, providerSelector('model', lane), savedOpenAI.model || ''),
      sessionApiKeyPresent: Boolean(controlValueOrFallback(container, providerSelector('api-key', lane), ''))
    }
  };
}
```

Keep existing call sites of `providerFromControls(...)` unchanged.

- [ ] **Step 2: Write focused provider draft tests**

Update the import in `tools/scripts/test-ui.mjs`:

```js
import { activityLabel, createRecursionViewModel, mountRecursionUi, providerFromControls } from '../../src/ui.mjs';
```

Add this helper near the top of `tools/scripts/test-ui.mjs`:

```js
function fakeProviderControls(values = {}) {
  return {
    querySelector(selector) {
      if (!Object.hasOwn(values, selector)) return null;
      return { value: values[selector] };
    }
  };
}
```

Add these assertions near other provider/settings assertions:

```js
const savedProviderDraft = {
  source: 'host-connection-profile',
  hostConnectionProfileId: 'saved-profile',
  openAICompatible: {
    baseUrl: 'https://saved.example/v1',
    model: 'saved-model',
    sessionApiKeyPresent: true
  }
};
const clearedProviderDraft = providerFromControls(fakeProviderControls({
  '[data-recursion-provider-source-utility]': 'openai-compatible',
  '[data-recursion-provider-profile-utility]': '',
  '[data-recursion-provider-base-url-utility]': '',
  '[data-recursion-provider-model-utility]': '',
  '[data-recursion-provider-api-key-utility]': ''
}), 'utility', savedProviderDraft);
assertEqual(clearedProviderDraft.source, 'openai-compatible', 'provider draft uses current source control');
assertEqual(clearedProviderDraft.hostConnectionProfileId, '', 'blank current profile does not fall back to saved profile');
assertEqual(clearedProviderDraft.openAICompatible.baseUrl, '', 'blank current base URL does not fall back to saved base URL');
assertEqual(clearedProviderDraft.openAICompatible.model, '', 'blank current model does not fall back to saved model');
assertEqual(clearedProviderDraft.openAICompatible.sessionApiKeyPresent, false, 'blank current API key is not treated as present');

const missingProviderDraft = providerFromControls(fakeProviderControls({}), 'utility', savedProviderDraft);
assertEqual(missingProviderDraft.hostConnectionProfileId, 'saved-profile', 'missing profile control falls back to saved profile');
assertEqual(missingProviderDraft.openAICompatible.baseUrl, 'https://saved.example/v1', 'missing base URL control falls back to saved base URL');
assertEqual(missingProviderDraft.openAICompatible.model, 'saved-model', 'missing model control falls back to saved model');
```

- [ ] **Step 3: Run the focused test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: pass after the helper export and current-blank handling are added.

- [ ] **Step 4: Commit**

Run:

```powershell
git add src\ui.mjs tools\scripts\test-ui.mjs
git commit -m "fix: respect cleared provider controls"
```

---

### Task 3: Remove Stale Provider Save Copy

**Files:**
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `docs/design/UI_SPEC.md`

- [ ] **Step 1: Add a copy regression assertion**

Add this assertion to `tools/scripts/test-ui.mjs` after the file-content checks that already read source files, or add a file read if none is nearby:

```js
const uiSource = readFileSync(new URL('../../src/ui.mjs', import.meta.url), 'utf8');
assert(!uiSource.includes('save and test it'), 'provider tooltip copy does not mention a removed save action');
assert(uiSource.includes('changes auto-save'), 'provider tooltip copy explains autosave behavior');
```

- [ ] **Step 2: Update provider tooltip copy**

In `src/ui.mjs`, change the provider heading tooltip text in `renderProviderSettings(...)` to:

```js
...tooltipAttrs(tooltipsEnabled, `${title} settings. Choose the model source for this lane; changes auto-save. Test it before relying on it during generation. Current status: ${statusText}.`)
```

- [ ] **Step 3: Update design spec copy contract**

In `docs/design/UI_SPEC.md`, update the provider pane section to include this exact contract:

```markdown
Provider lane controls autosave. Tooltip and helper copy must not mention a Save Provider action; testing a provider is a separate explicit command.
```

- [ ] **Step 4: Run focused and docs-aware tests**

Run:

```powershell
node tools\scripts\test-ui.mjs
npm.cmd test
```

Expected: both pass.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\ui.mjs tools\scripts\test-ui.mjs docs\design\UI_SPEC.md
git commit -m "fix: align provider tooltip with autosave"
```

---

### Task 4: Surface UI Action Failures

**Files:**
- Create: `src/ui/action-status.mjs`
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `docs/design/UI_SPEC.md`

- [ ] **Step 1: Create action-status helper**

Create `src/ui/action-status.mjs`:

```js
function safeMessage(error) {
  const message = String(error?.message || error || '').trim();
  if (!message) return 'Action failed.';
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

export function normalizeUiActionFailure(error, fallback = 'Action failed.') {
  const message = safeMessage(error);
  return {
    severity: 'warning',
    label: message === 'Action failed.' ? fallback : message
  };
}

export function createUiActionStatus() {
  let current = null;
  return {
    setFailure(error, fallback) {
      current = normalizeUiActionFailure(error, fallback);
      return current;
    },
    clear() {
      current = null;
    },
    current() {
      return current ? { ...current } : null;
    }
  };
}
```

- [ ] **Step 2: Write action-status tests inside UI suite**

Add this import in `tools/scripts/test-ui.mjs`:

```js
import { createUiActionStatus, normalizeUiActionFailure } from '../../src/ui/action-status.mjs';
```

Add these assertions:

```js
const normalizedUiFailure = normalizeUiActionFailure(new Error('Clipboard denied'), 'Copy failed.');
assertEqual(normalizedUiFailure.severity, 'warning', 'UI action failure uses warning severity');
assertEqual(normalizedUiFailure.label, 'Clipboard denied', 'UI action failure preserves concise error message');
const uiActionStatus = createUiActionStatus();
uiActionStatus.setFailure('', 'Copy failed.');
assertEqual(uiActionStatus.current().label, 'Copy failed.', 'UI action status uses fallback for empty failures');
uiActionStatus.clear();
assertEqual(uiActionStatus.current(), null, 'UI action status clears transient state');
```

- [ ] **Step 3: Wire failures into `mountRecursionUi`**

In `src/ui.mjs`, import the helper:

```js
import { createUiActionStatus } from './ui/action-status.mjs';
```

Near the other local state inside `mountRecursionUi(...)`, add:

```js
const uiActionStatus = createUiActionStatus();
```

Change `runAction(...)` to:

```js
function runAction(result, after = null, failureLabel = 'Action failed.') {
  if (!result || typeof result.then !== 'function') {
    try {
      after?.();
    } catch (error) {
      uiActionStatus.setFailure(error, failureLabel);
      update();
    }
    return;
  }
  result
    .then(() => {
      uiActionStatus.clear();
      after?.();
      update();
    })
    .catch((error) => {
      uiActionStatus.setFailure(error, failureLabel);
      update();
    });
}
```

Before rendering the compact status in `update()`, prefer the transient failure if present:

```js
const actionFailure = uiActionStatus.current();
if (actionFailure) {
  view = {
    ...view,
    activity: {
      ...(view.activity || {}),
      phase: 'uiActionFailed',
      severity: actionFailure.severity,
      label: actionFailure.label
    }
  };
}
```

For known failure-prone call sites, pass specific labels:

```js
runAction(globalThis.navigator?.clipboard?.writeText?.(packetText), null, 'Copy prompt failed.');
runAction(runtime?.exportDiagnostics?.(), null, 'Export diagnostics failed.');
runAction(runtime?.fetchProviderModels?.(lane, readProviderPatch(root, lane)), null, 'Fetch models failed.');
runAction(runtime?.testProvider?.(lane), () => update(), 'Provider test failed.');
```

- [ ] **Step 4: Update design spec**

Add to `docs/design/UI_SPEC.md`:

```markdown
UI command failures use the compact bar's existing transient status line. They must not open a modal or create a progress run unless runtime work actually started.
```

- [ ] **Step 5: Run gates**

Run:

```powershell
node tools\scripts\test-ui.mjs
npm.cmd test
```

Expected: both pass.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src\ui.mjs src\ui\action-status.mjs tools\scripts\test-ui.mjs docs\design\UI_SPEC.md
git commit -m "fix: surface ui action failures"
```

---

## Phase 2: Shared Safety And Diagnostics

### Task 5: Extract Shared Safe Value Helpers

**Files:**
- Create: `src/safe-values.mjs`
- Modify: `src/core.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/prompt.mjs`
- Modify: `src/providers.mjs`
- Modify: `src/hosts/sillytavern/host.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `tools/scripts/test-host.mjs`

- [ ] **Step 1: Create the shared helper module**

Create `src/safe-values.mjs`:

```js
import { redact, truncate } from './core.mjs';

export function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function safeText(value, limit = 200) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return truncate(value.trim(), limit);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncate(JSON.stringify(redact(value, { maxString: limit })), limit);
  } catch {
    return '';
  }
}

export function unsafeObjectString(value) {
  const text = String(value || '');
  return text === '[object Object]' || text === 'object-Object';
}

export function safeDiagnosticText(value, limit = 500) {
  const text = safeText(value, limit);
  return unsafeObjectString(text) ? '' : text;
}

export function safeIdentifier(value, fallback = 'item') {
  const text = safeText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text || fallback;
}
```

- [ ] **Step 2: Add tests at existing object-string seams**

In `tools/scripts/test-runtime.mjs`, add:

```js
import { safeDiagnosticText, safeIdentifier, safeText, unsafeObjectString } from '../../src/safe-values.mjs';

assertEqual(safeText({ label: 'Visible', token: 'sk-live-secret' }).includes('[redacted]'), true, 'safeText redacts object secrets');
assertEqual(unsafeObjectString('[object Object]'), true, 'unsafe object marker is detected');
assertEqual(safeDiagnosticText('[object Object]'), '', 'unsafe object marker is removed from diagnostics text');
assertEqual(safeIdentifier(' Scene / Beat 1 '), 'scene-beat-1', 'safeIdentifier normalizes labels');
```

If the file already imports from `safe-values.mjs` after implementation, merge the import rather than adding a duplicate import.

- [ ] **Step 3: Replace local duplicates gradually**

Replace local `asObject`, `safeText`, and `safeIdentifier` definitions in touched files with imports. Use this pattern:

```js
import { asObject, safeDiagnosticText, safeIdentifier, safeText } from './safe-values.mjs';
```

For host adapter files one directory deeper, use:

```js
import { asObject, safeDiagnosticText, safeText } from '../../safe-values.mjs';
```

Do not replace helper names that have materially different semantics in the same patch. Leave those for a follow-up extraction task with a focused test.

- [ ] **Step 4: Run focused gates after each file family**

Run after runtime/prompt changes:

```powershell
node tools\scripts\test-runtime.mjs
```

Run after provider changes:

```powershell
node tools\scripts\test-providers.mjs
```

Run after host changes:

```powershell
node tools\scripts\test-host.mjs
```

- [ ] **Step 5: Run full gate and commit**

Run:

```powershell
npm.cmd test
```

Expected: pass.

Commit:

```powershell
git add src\safe-values.mjs src\core.mjs src\runtime.mjs src\prompt.mjs src\providers.mjs src\hosts\sillytavern\host.mjs tools\scripts\test-runtime.mjs tools\scripts\test-providers.mjs tools\scripts\test-host.mjs
git commit -m "refactor: share safe value helpers"
```

---

### Task 6: Make Diagnostics Export Explicit

**Files:**
- Create: `src/runtime/diagnostics.mjs`
- Modify: `src/runtime.mjs`
- Create or Modify: `tools/scripts/test-diagnostics.mjs`
- Modify: `package.json` only if a new test script must be wired into `npm.cmd test`

- [ ] **Step 1: Create diagnostics payload builder**

Create `src/runtime/diagnostics.mjs`:

```js
import { redact } from '../core.mjs';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function mapJournalEntry(entry) {
  return redact({
    id: entry?.id,
    runId: entry?.runId,
    event: entry?.event,
    phase: entry?.phase,
    severity: entry?.severity,
    label: entry?.label,
    recordedAt: entry?.recordedAt,
    details: entry?.details
  }, { maxString: 500 });
}

export function buildDiagnosticsPayload({
  view,
  settings,
  cacheContracts,
  journal,
  includeExcerpts = false,
  createdAt = new Date().toISOString()
} = {}) {
  const sourceEntries = safeArray(journal?.entries).slice(-50);
  return redact({
    schema: 'recursion.diagnostics.v1',
    createdAt,
    settings,
    runtime: {
      activeRunId: view?.activeRunId || null,
      hostGenerationActive: Boolean(view?.hostGenerationActive),
      activity: view?.activity || null,
      forceRegenerate: view?.forceRegenerate || null,
      rapidWarm: view?.rapidWarm || null
    },
    cacheContracts,
    journal: sourceEntries.map(mapJournalEntry),
    excerpts: includeExcerpts ? {
      lastPacket: view?.lastPacket || null,
      lastHand: view?.lastHand || null,
      lastPlan: view?.lastPlan || null
    } : null
  }, { maxString: includeExcerpts ? 900 : 500 });
}
```

- [ ] **Step 2: Add diagnostics tests**

Create `tools/scripts/test-diagnostics.mjs`. If the file already exists in the checkout used for implementation, append the assertions below to that file instead of creating a second diagnostics suite:

```js
import { buildDiagnosticsPayload } from '../../src/runtime/diagnostics.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const payload = buildDiagnosticsPayload({
  createdAt: '2026-07-04T00:00:00.000Z',
  settings: { provider: { utility: { openAICompatible: { apiKey: 'sk-live-secret' } } } },
  view: {
    activeRunId: 'run-1',
    hostGenerationActive: true,
    activity: { label: 'Working' },
    lastPacket: { promptText: 'visible excerpt' }
  },
  cacheContracts: { settings: 'abc' },
  journal: {
    entries: [
      {
        id: 'entry-1',
        runId: 'run-1',
        event: 'provider',
        phase: 'done',
        severity: 'info',
        label: 'Provider done',
        details: { authorization: 'Bearer private-token', safe: 'visible' },
        rawPrompt: 'should not be copied by default mapping'
      }
    ]
  },
  includeExcerpts: false
});

const serialized = JSON.stringify(payload);
assertEqual(payload.schema, 'recursion.diagnostics.v1', 'diagnostics schema is versioned');
assertEqual(payload.excerpts, null, 'excerpts are omitted by default');
assert(!serialized.includes('sk-live-secret'), 'settings secrets are redacted');
assert(!serialized.includes('Bearer private-token'), 'journal secrets are redacted');
assert(!serialized.includes('should not be copied'), 'raw prompt fields are not copied by default');
assert(serialized.includes('visible'), 'safe diagnostic details are preserved');

const excerptPayload = buildDiagnosticsPayload({
  view: { lastPacket: { promptText: 'visible excerpt' } },
  includeExcerpts: true,
  createdAt: '2026-07-04T00:00:00.000Z'
});
assert(JSON.stringify(excerptPayload).includes('visible excerpt'), 'explicit excerpts include last packet data');
```

- [ ] **Step 3: Wire runtime export to builder**

In `src/runtime.mjs`, import:

```js
import { buildDiagnosticsPayload } from './runtime/diagnostics.mjs';
```

Inside `exportDiagnostics()`, replace the inline payload construction with:

```js
const payload = buildDiagnosticsPayload({
  view: safeRuntimeView(),
  settings: settingsStore?.get?.(),
  cacheContracts: cacheContractVersions(settingsStore?.get?.()),
  journal: runJournal,
  includeExcerpts: Boolean(settingsStore?.get?.()?.diagnostics?.includeExcerpts)
});
```

Keep the existing file download / host export mechanics unchanged.

- [ ] **Step 4: Wire the test into the suite if needed**

If `npm.cmd test` is script-list based, add `tools/scripts/test-diagnostics.mjs` to the same list that runs the other test scripts. If it already discovers `tools/scripts/test-*.mjs`, no package change is needed.

- [ ] **Step 5: Run gates and commit**

Run:

```powershell
node tools\scripts\test-diagnostics.mjs
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\runtime.mjs src\runtime\diagnostics.mjs tools\scripts\test-diagnostics.mjs package.json
git commit -m "refactor: make diagnostics export explicit"
```

If `package.json` was not modified, omit it from `git add`.

---

## Phase 3: Provider And Host Boundary

### Task 7: Move Connection Profile Discovery Into SillyTavern Host Adapter

**Files:**
- Create: `src/hosts/sillytavern/provider-profiles.mjs`
- Modify: `src/hosts/sillytavern/host.mjs`
- Modify: `src/providers.mjs`
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `tools/scripts/test-host.mjs`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/technical/HOST_INTEGRATION_MANUAL.md`

- [ ] **Step 1: Create host-owned profile discovery module**

Move the existing profile normalization, path allow-listing, and bounded candidate traversal from `src/providers.mjs` into `src/hosts/sillytavern/provider-profiles.mjs`. Export this contract:

```js
export function listSillyTavernConnectionProfiles({ context = null, globals = globalThis } = {}) {
  const roots = [
    context?.ConnectionManagerRequestService,
    context?.connectionManager,
    context?.state?.connectionManager,
    globals?.ConnectionManagerRequestService,
    globals?.connectionManager,
    globals?.ConnectionManager,
    context?.extension_settings,
    globals?.extension_settings,
    context?.power_user,
    globals?.power_user
  ];
  return collectProfileCandidatesFromRoots(roots);
}
```

Keep traversal bounded with the current max depth and path pattern. Preserve current dedupe by profile id.

- [ ] **Step 2: Expose discovery through host adapter**

In `src/hosts/sillytavern/host.mjs`, import the new module:

```js
import { listSillyTavernConnectionProfiles } from './provider-profiles.mjs';
```

Expose the capability on the host object:

```js
providerProfiles: {
  list(options = {}) {
    return listSillyTavernConnectionProfiles({
      context: getContext?.(),
      globals: options.globals ?? globalThis
    });
  }
}
```

Use the host adapter's existing context accessor name. If the adapter already exposes capabilities under another namespace, place `listConnectionProfiles(options)` beside them instead of introducing a second namespace.

- [ ] **Step 3: Keep provider core host-neutral**

In `src/providers.mjs`, remove direct `globalThis` / `ConnectionManagerRequestService` profile discovery from provider core. Replace `listProviderConnectionProfiles(options = {})` with:

```js
export function listProviderConnectionProfiles(options = {}) {
  if (typeof options.host?.providerProfiles?.list === 'function') {
    return options.host.providerProfiles.list(options);
  }
  if (typeof options.listConnectionProfiles === 'function') {
    return options.listConnectionProfiles(options);
  }
  return [];
}
```

Leave OpenAI-compatible model fetching and provider routing in `providers.mjs`.

- [ ] **Step 4: Route UI discovery through runtime or host capability**

In `src/ui.mjs`, remove direct profile discovery imports from provider core if the UI can read profiles from `runtime.view()`. Preferred view shape:

```js
{
  providerProfiles: [
    { id: 'profile-id', label: 'Profile / model', model: 'model-name' }
  ]
}
```

Add a runtime wrapper so UI never calls provider-core discovery directly:

```js
function listProviderConnectionProfilesForUi(options = {}) {
  return host?.providerProfiles?.list?.(options) || host?.listConnectionProfiles?.(options) || [];
}
```

Expose it from the runtime return object:

```js
listProviderConnectionProfiles: listProviderConnectionProfilesForUi
```

In `src/ui.mjs`, render provider profile options from `runtime?.listProviderConnectionProfiles?.()` or from `runtime.view().providerProfiles` if the view already includes that field after this task. Do not call SillyTavern globals from UI.

- [ ] **Step 5: Move provider tests to host tests**

In `tools/scripts/test-providers.mjs`, delete tests that assert nested SillyTavern state traversal from provider core. Replace them with:

```js
assertDeepEqual(listProviderConnectionProfiles({ host: { providerProfiles: { list: () => [{ id: 'ctx-utility', label: 'Context Utility', model: 'glm-fast' }] } } }), [
  { id: 'ctx-utility', label: 'Context Utility', model: 'glm-fast' }
], 'provider core delegates connection profile listing to host capability');
assertDeepEqual(listProviderConnectionProfiles({}), [], 'provider core returns empty profiles without host discovery capability');
```

Move the old nested traversal cases into `tools/scripts/test-host.mjs` against `listSillyTavernConnectionProfiles(...)`.

- [ ] **Step 6: Update docs**

In `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, add:

```markdown
Connection-profile discovery is a host-adapter capability. Provider core accepts an already discovered profile list or a host capability callback; it does not inspect SillyTavern globals.
```

In `docs/technical/HOST_INTEGRATION_MANUAL.md`, add:

```markdown
The SillyTavern adapter owns connection-profile discovery because the object graph and ConnectionManager APIs are host-specific.
```

- [ ] **Step 7: Run gates and commit**

Run:

```powershell
node tools\scripts\test-providers.mjs
node tools\scripts\test-host.mjs
node tools\scripts\test-ui.mjs
npm.cmd test
```

Commit:

```powershell
git add src\providers.mjs src\ui.mjs src\hosts\sillytavern\host.mjs src\hosts\sillytavern\provider-profiles.mjs tools\scripts\test-providers.mjs tools\scripts\test-host.mjs docs\architecture\PROVIDER_AND_GENERATION_SPEC.md docs\technical\HOST_INTEGRATION_MANUAL.md
git commit -m "refactor: move provider profile discovery to host"
```

---

### Task 8: Move SillyTavern Message Normalization Out Of Bootstrap

**Files:**
- Modify: `src/hosts/sillytavern/host.mjs`
- Modify: `src/extension/index.js`
- Modify: `tools/scripts/test-host.mjs`
- Modify: `tools/scripts/test-extension-smoke.mjs`
- Modify: `docs/technical/HOST_INTEGRATION_MANUAL.md`

- [ ] **Step 1: Add host event normalization API**

In `src/hosts/sillytavern/host.mjs`, export or expose:

```js
export function normalizeSillyTavernMessageEvent(event = {}, context = {}) {
  return {
    messageId: event.messageId ?? event.message_id ?? event.id ?? null,
    swiped: Boolean(event.swiped || event.type === 'MESSAGE_SWIPED'),
    deleted: Boolean(event.deleted || event.type === 'MESSAGE_DELETED'),
    edited: Boolean(event.edited || event.type === 'MESSAGE_EDITED'),
    latestAssistant: Boolean(context.latestAssistantMessageId && (event.messageId ?? event.id) === context.latestAssistantMessageId),
    text: normalizeGenerationResponse(event.text ?? event.message ?? event.content ?? '')
  };
}
```

Use existing host helper names where they already exist. The important contract is that bootstrap receives a normalized event object instead of duplicating SillyTavern field rules.

- [ ] **Step 2: Write host tests**

Add to `tools/scripts/test-host.mjs`:

```js
const normalizedSwipeEvent = normalizeSillyTavernMessageEvent(
  { type: 'MESSAGE_SWIPED', id: 'm-2', content: { schema: 'x', ok: true } },
  { latestAssistantMessageId: 'm-2' }
);
assertEqual(normalizedSwipeEvent.swiped, true, 'swipe event is normalized by host adapter');
assertEqual(normalizedSwipeEvent.latestAssistant, true, 'latest assistant identity is normalized by host adapter');
assert(!String(normalizedSwipeEvent.text).includes('[object Object]'), 'object-shaped event content is JSON-normalized');
```

- [ ] **Step 3: Simplify extension bootstrap**

In `src/extension/index.js`, replace duplicated event field normalization with a call to the host adapter:

```js
const normalizedEvent = host.normalizeMessageEvent?.(event) ?? event;
runtime.handleHostMessageEvent?.(normalizedEvent);
```

Keep lifecycle binding, settings mounting, and runtime creation in bootstrap.

- [ ] **Step 4: Run gates and commit**

Run:

```powershell
node tools\scripts\test-host.mjs
node tools\scripts\test-extension-smoke.mjs
npm.cmd test
```

Commit:

```powershell
git add src\hosts\sillytavern\host.mjs src\extension\index.js tools\scripts\test-host.mjs tools\scripts\test-extension-smoke.mjs docs\technical\HOST_INTEGRATION_MANUAL.md
git commit -m "refactor: centralize host message normalization"
```

---

## Phase 3.5: Rapid Warm Bug Hunt Before Runtime Extraction

The Rapid workflow has current deterministic coverage for the happy path, warm join, warm timeout, failed warm persistence, settings abort, visible pending user, sparse alternate variants, stale hook payload recheck, invalid delta output, and hedge backup. The focused Rapid suites pass at the time this addendum was written:

```powershell
node tools\scripts\test-rapid-pipeline.mjs
node tools\scripts\test-rapid-warm-state.mjs
node tools\scripts\test-runtime.mjs
```

The remaining risk is not a known red test. It is brittle eligibility and observability around why Rapid misses and falls back to Standard in live use. Complete these tasks before extracting Rapid into `src/runtime/pipelines/rapid.mjs`.

### Task 8A: Add Rapid Warm Miss Telemetry With Root Cause Buckets

**Files:**
- Modify: `src/rapid-warm-state.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-rapid-warm-state.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Add a stable miss snapshot helper**

In `src/rapid-warm-state.mjs`, add:

```js
export function rapidWarmMissSnapshot(input = {}) {
  const diagnostics = Array.isArray(input.diagnostics)
    ? input.diagnostics.map((entry) => cleanText(entry, 160)).filter(Boolean).slice(0, 16)
    : [];
  return {
    reasonCode: cleanText(input.reasonCode || 'no-active-variant', 80) || 'no-active-variant',
    reasonLabel: cleanText(input.reasonLabel || rapidWarmReasonLabel(input.reasonCode), SAFE_LABEL_LIMIT)
      || rapidWarmReasonLabel(input.reasonCode),
    exactVariant: input.exactVariant === true,
    joinAttempted: input.joinAttempted === true,
    joinTimedOut: input.joinTimedOut === true,
    activeWarmRunPresent: input.activeWarmRunPresent === true,
    activeWarmRunBaseKnown: input.activeWarmRunBaseKnown === true,
    candidateCardCount: Math.max(0, Math.floor(Number(input.candidateCardCount) || 0)),
    selectedCardCount: Math.max(0, Math.floor(Number(input.selectedCardCount) || 0)),
    diagnostics
  };
}
```

- [ ] **Step 2: Test the helper**

Update the import in `tools/scripts/test-rapid-warm-state.mjs`:

```js
import {
  RAPID_WARM_JOIN_WAIT_MS,
  rapidWarmMissReason,
  rapidWarmMissSnapshot,
  rapidWarmReasonLabel,
  rapidWarmStatusView
} from '../../src/rapid-warm-state.mjs';
```

Add:

```js
assertDeepEqual(
  rapidWarmMissSnapshot({
    reasonCode: 'warm-timeout',
    exactVariant: true,
    joinAttempted: true,
    joinTimedOut: true,
    activeWarmRunPresent: true,
    activeWarmRunBaseKnown: true,
    candidateCardCount: 2,
    selectedCardCount: 1,
    diagnostics: ['rapid-warm-miss-standard', 'authorization Bearer secret-token']
  }),
  {
    reasonCode: 'warm-timeout',
    reasonLabel: 'Rapid deck still warming; Standard started.',
    exactVariant: true,
    joinAttempted: true,
    joinTimedOut: true,
    activeWarmRunPresent: true,
    activeWarmRunBaseKnown: true,
    candidateCardCount: 2,
    selectedCardCount: 1,
    diagnostics: ['rapid-warm-miss-standard']
  },
  'Rapid miss snapshot is bounded, stable, and redacts unsafe diagnostic text'
);
```

- [ ] **Step 3: Wire miss snapshots into runtime journals and activity**

In `src/runtime.mjs`, import:

```js
import { rapidWarmMissSnapshot } from './rapid-warm-state.mjs';
```

In `prepareRapidForGeneration(...)`, build one miss snapshot before each Standard escalation:

```js
const missSnapshot = rapidWarmMissSnapshot({
  reasonCode: miss.code,
  reasonLabel: miss.label,
  exactVariant: activeVariant.exact,
  joinAttempted: Boolean(joinableWarm),
  joinTimedOut: false,
  activeWarmRunPresent: Boolean(activeRapidWarmRun),
  activeWarmRunBaseKnown: Boolean(activeRapidWarmRun?.baseSourceRevisionHash),
  candidateCardCount: candidateCards.length,
  selectedCardCount: Array.isArray(rapid?.selectedCardIds) ? rapid.selectedCardIds.length : 0,
  diagnostics: warmMissDiagnostics()
});
```

Use `missSnapshot` in the activity `detail`, the `rapid.warm_missed` journal details, and the returned Standard escalation diagnostics. For the join timeout path, pass `joinTimedOut: joined.reasonCode === 'warm-timeout'`.

- [ ] **Step 4: Add runtime assertion for miss telemetry**

In the existing warm-timeout block in `tools/scripts/test-runtime.mjs`, after the current `reasonCode` assertion, add:

```js
const timeoutActivity = harness.activity.current();
assertEqual(timeoutActivity.detail.reasonCode, 'warm-timeout', 'Rapid timeout activity exposes reason code');
assertEqual(timeoutActivity.detail.joinAttempted, true, 'Rapid timeout activity records join attempt');
assertEqual(timeoutActivity.detail.joinTimedOut, true, 'Rapid timeout activity records timeout');
assertEqual(timeoutActivity.detail.activeWarmRunPresent, true, 'Rapid timeout activity records active warm run presence');
```

- [ ] **Step 5: Run gates and commit**

Run:

```powershell
node tools\scripts\test-rapid-warm-state.mjs
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\rapid-warm-state.mjs src\runtime.mjs tools\scripts\test-rapid-warm-state.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "test: expose rapid warm miss reasons"
```

---

### Task 8B: Close The Rapid Warm Join Race Before Base Hash Is Known

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Write a failing race test**

Add this block near the existing Rapid warm join tests in `tools/scripts/test-runtime.mjs`:

```js
{
  const snapshotGate = deferred();
  let warmSnapshotReads = 0;
  const roleCalls = [];
  const { snapshot } = rapidWarmSnapshotFixture();
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    rapidWarmJoinWaitMs: 200,
    snapshot: async () => {
      warmSnapshotReads += 1;
      if (warmSnapshotReads === 1) await snapshotGate.promise;
      return snapshot;
    },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Race warm card.' }],
              reasonerDecision: { mode: 'skip', reason: 'race warm', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['rapid-warm-race']
            }
          };
        }
        if (roleId === 'sceneFrameCard') return cardProviderResponse(roleId, request, 'Race warm card text.');
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Race warm guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['race-warm-guidance']
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
              turnGuidanceText: 'RACE_JOIN_MARKER use newly warmed deck.',
              guardrailCardIds: [],
              packetInstructions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['race-joined']
            }
          };
        }
        throw new Error(`unexpected race role ${roleId}`);
      }
    }
  });
  const warmPromise = harness.runtime.warmRapidScene({ reason: 'unit-base-hash-race' });
  await Promise.resolve();
  const foregroundPromise = harness.runtime.prepareForGeneration({ userMessage: 'Join warm after base hash publishes.' });
  await Promise.resolve();
  snapshotGate.resolve();
  const [warmResult, foregroundResult] = await Promise.all([warmPromise, foregroundPromise]);
  assertEqual(warmResult.ok, true, 'race warm completes');
  assertEqual(foregroundResult.ok, true, 'foreground completes after base-hash race');
  assertEqual(foregroundResult.packet.diagnostics.pipelineMode, 'rapid', 'foreground waits for warm base hash instead of immediate Standard fallback');
  assert(roleCalls.includes('rapidTurnDelta'), 'race foreground uses Rapid delta');
}
```

Expected before implementation: this may fall back to Standard because `exactWarmRunForSource(...)` requires `activeRapidWarmRun.baseSourceRevisionHash`, which starts empty until `warmRapidScene(...)` finishes its snapshot read.

- [ ] **Step 2: Add a bounded wait for an active warm run with unknown base**

In `src/runtime.mjs`, add:

```js
async function waitForRapidWarmBaseSource(runId, expectedContracts = {}, timeoutMs = 250) {
  const warm = activeRapidWarmRun;
  if (!warm?.promise || warm.signal?.aborted === true) return null;
  const contract = asObject(warm.contract);
  for (const key of ['settingsHash', 'providerContractHash', 'cardCatalogHash', 'promptContractHash']) {
    if (safeText(contract[key] || '', 180) !== safeText(expectedContracts[key] || '', 180)) return null;
  }
  if (safeText(warm.baseSourceRevisionHash || '', 180)) return warm;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isActiveRun(runId)) return null;
    if (!activeRapidWarmRun || activeRapidWarmRun.runId !== warm.runId) return null;
    if (safeText(activeRapidWarmRun.baseSourceRevisionHash || '', 180)) return activeRapidWarmRun;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}
```

- [ ] **Step 3: Use the wait before declaring no active warm**

In `prepareRapidForGeneration(...)`, before `const joinableWarm = exactWarmRunForSource(...)`, add:

```js
await waitForRapidWarmBaseSource(runId, expectedContracts);
if (!isActiveRun(runId)) return supersededResult(runId);
```

Then keep the existing `exactWarmRunForSource(baseSourceRevisionHash, expectedContracts)` call.

- [ ] **Step 4: Run gates and commit**

Run:

```powershell
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\runtime.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "fix: wait for rapid warm base hash"
```

---

### Task 8C: Narrow Rapid Warm Eligibility To Artifact-Relevant Settings

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Write the contract test for unrelated settings drift**

Add to `tools/scripts/test-runtime.mjs` near other Rapid cache fixture tests:

```js
{
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const warmCache = rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, warmCache);
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: {
      pipelineMode: 'rapid',
      mode: 'auto',
      retention: { sourceVariantsPerScene: 12, runJournalEntries: 12 },
      providers: {
        reasoner: {
          enabled: true,
          source: 'openai-compatible',
          openAICompatible: { baseUrl: 'https://reasoner.changed/v1', model: 'changed-reasoner' },
          temperature: 0.1,
          topP: 1,
          maxTokens: 4096
        }
      }
    },
    snapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnGuidanceText: 'UNRELATED_SETTINGS_MARKER still use Rapid.',
              guardrailCardIds: [],
              packetInstructions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['unrelated-settings-rapid']
            }
          };
        }
        throw new Error(`unexpected unrelated settings role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Use warm deck after unrelated setting drift.' });
  assertEqual(result.ok, true, 'Rapid succeeds after unrelated setting drift');
  assertEqual(result.packet.diagnostics.pipelineMode, 'rapid', 'unrelated retention/reasoner settings do not invalidate Rapid warm deck');
  assertDeepEqual(roleCalls, ['rapidTurnDelta'], 'unrelated setting drift does not run Standard');
}
```

Expected before implementation: likely FAIL because `settingsHash` currently includes retention and both provider lanes.

- [ ] **Step 2: Add a Rapid-specific settings signature**

In `src/runtime.mjs`, add:

```js
function rapidWarmSettingsSignature(settings = {}) {
  const normalized = normalizeSettings(settings);
  return {
    enabled: normalized.enabled,
    mode: normalized.mode,
    pipelineMode: normalized.pipelineMode,
    cardScope: normalized.cardScope,
    strength: normalized.strength,
    minCards: normalized.minCards,
    maxCards: normalized.maxCards,
    reasoningLevel: normalized.reasoningLevel,
    promptFootprint: normalized.promptFootprint,
    focus: normalized.focus,
    utilityProvider: cacheProviderSettingsSignature(normalized.providers?.utility)
  };
}

function rapidWarmContractVersions(settings = {}) {
  const base = cacheContractVersions(settings);
  return {
    providerContractHash: base.providerContractHash,
    cardCatalogHash: base.cardCatalogHash,
    promptContractHash: base.promptContractHash,
    settingsHash: hashJson(rapidWarmSettingsSignature(settings))
  };
}
```

- [ ] **Step 3: Use Rapid contract versions for warm artifacts and joins**

Replace Rapid-specific `cacheContractVersions(settings)` calls with `rapidWarmContractVersions(settings)` at:

```text
startRapidWarmRun(... contract ...)
saveRapidWarmStatus(...)
rapid ready artifact construction
prepareRapidForGeneration expectedContracts
```

Do not change the scene cache's top-level `versions` contract in `sceneCachePayload(...)`.

- [ ] **Step 4: Keep true warm-affecting settings invalidating Rapid**

Add one paired assertion in `tools/scripts/test-runtime.mjs`:

```js
const changedUtilitySettings = cacheContractVersions({
  pipelineMode: 'rapid',
  mode: 'auto',
  providers: {
    utility: {
      source: 'openai-compatible',
      openAICompatible: { baseUrl: 'https://utility.changed/v1', model: 'changed-utility' },
      temperature: 0.3,
      topP: 1,
      maxTokens: 4096
    }
  }
});
assert(changedUtilitySettings.settingsHash, 'utility provider settings still participate in cache contract');
```

Then add a runtime fixture where a changed Utility provider causes `rapid-warm-miss:settings-mismatch`.

- [ ] **Step 5: Run gates and commit**

Run:

```powershell
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\runtime.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "fix: narrow rapid warm settings contract"
```

---

### Task 8D: Investigate Warm Failures Caused By No Candidate Cards

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Pin the no-candidate-card symptom**

Add this block after the existing `unit-warming-persist` test in `tools/scripts/test-runtime.mjs`:

```js
{
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'skip',
              sceneStatus: 'same-scene',
              promptFootprint: 'compact',
              cardJobs: [],
              reasonerDecision: { mode: 'skip', reason: 'provider said skip', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['warm-arbiter-skip-no-cache']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Use raw local warm evidence.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['local-warm-guidance']
            }
          };
        }
        throw new Error(`unexpected no-candidate warm role ${roleId}`);
      }
    }
  });
  const warm = await harness.runtime.warmRapidScene({ reason: 'unit-no-candidate-skip' });
  assertEqual(warm.ok, true, 'Rapid warm returns ok for no-candidate skip case');
  assertEqual(warm.reason, 'rapid-warm-failed', 'current behavior records generic warm failure for no candidate cards');
  assertEqual(harness.runtime.view().rapidWarm.reasonCode, 'warm-failed', 'current view hides no-candidate-card root cause');
}
```

This pins the current behavior before changing it.

- [ ] **Step 2: Decide and implement the intended behavior**

If the product decision is that Rapid warm should not fail generically when the Arbiter skips on an empty cache, change `warmRapidScene(...)` after `candidateCards` is built:

```js
if (!candidateCards.length) {
  const localGeneratedCards = cardsWithOrigin(localCards(snapshot).map(sanitizeGeneratedCard), 'fallback');
  if (localGeneratedCards.length) {
    providerCards.push(...localGeneratedCards);
  }
}
```

Then set the warm diagnostics to include:

```js
'rapid-warm-local-candidate-cards'
```

If the decision is that Rapid should remain provider-only, keep the failure but set `failureReasonCode: 'no-candidate-cards'` instead of generic `warm-failed`.

- [ ] **Step 3: Update the test to assert the chosen behavior**

For the local-card fallback behavior, replace the final assertions with:

```js
assertEqual(warm.ok, true, 'Rapid warm succeeds using local warm candidate cards');
assertEqual(harness.runtime.view().rapidWarm.status, 'ready', 'Rapid warm is ready after local candidate fallback');
assert(JSON.stringify(warm.rapid).includes('rapid-warm-local-candidate-cards'), 'Rapid artifact records local candidate fallback');
```

For provider-only behavior, replace the final assertions with:

```js
assertEqual(warm.reason, 'rapid-warm-failed', 'Rapid warm still fails without candidate cards');
assertEqual(harness.runtime.view().rapidWarm.reasonCode, 'no-candidate-cards', 'Rapid view exposes no-candidate-card root cause');
```

- [ ] **Step 4: Run gates and commit**

Run:

```powershell
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\runtime.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "fix: classify rapid warm no-candidate cases"
```

---

### Task 8E: Audit Rapid Delta Escalation Rules

**Files:**
- Modify: `src/rapid-pipeline.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-rapid-pipeline.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Add focused normalization tests for non-escalating refresh requests**

In `tools/scripts/test-rapid-pipeline.mjs`, add:

```js
const refreshOnlyDelta = normalizeRapidTurnDelta({
  schema: RAPID_TURN_DELTA_SCHEMA,
  selectedCardIds: ['scene-card'],
  turnGuidanceText: 'Use the warm scene card.',
  backgroundRefreshRequests: [{ family: 'Open Threads', reason: 'Refresh soon' }],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: ['refresh-only']
}, {
  snapshotHash: 'trusted-snapshot',
  baseSourceRevisionHash: 'trusted-base',
  turnSourceRevisionHash: 'trusted-turn',
  allowedCardIds: ['scene-card']
});
assertEqual(refreshOnlyDelta.escalateToStandard, false, 'background refresh requests do not escalate Rapid');
assertEqual(refreshOnlyDelta.backgroundRefreshRequests.length, 1, 'background refresh request is preserved');
```

- [ ] **Step 2: Add runtime tests for empty delta and mandatory gap classification**

Add to `tools/scripts/test-runtime.mjs`:

```js
{
  const { snapshot, baseSourceRevisionHash } = rapidWarmSnapshotFixture();
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, rapidWarmCacheFixture({ cardId: 'warm-card-1', baseSourceRevisionHash }));
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    snapshot,
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v2',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnGuidanceText: '',
              guardrailCardIds: [],
              packetInstructions: ['Use warm guidance only.'],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['warm-guidance-only']
            }
          };
        }
        throw new Error(`unexpected warm-guidance-only role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Continue with warm guidance only.' });
  assertEqual(result.ok, true, 'Rapid accepts packet instructions without turn guidance prose');
  assertEqual(result.packet.diagnostics.pipelineMode, 'rapid', 'packet-instruction-only delta remains Rapid');
}
```

- [ ] **Step 3: Preserve mandatory gap escalation but expose details**

In `prepareRapidForGeneration(...)`, when `normalized.escalateToStandard || normalized.mandatoryMissingCards.length`, return diagnostics that include the first mandatory gap:

```js
diagnostics: [
  'rapid-escalated-standard:mandatory-gap',
  ...normalized.mandatoryMissingCards.slice(0, 3).map((entry) => `rapid-mandatory-gap:${safeText(entry.family || entry.role || 'unknown', 80)}`)
]
```

- [ ] **Step 4: Run gates and commit**

Run:

```powershell
node tools\scripts\test-rapid-pipeline.mjs
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\rapid-pipeline.mjs src\runtime.mjs tools\scripts\test-rapid-pipeline.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "fix: clarify rapid delta escalation"
```

---

### Task 8F: Capture Rapid Warm Duration And Tune Join Wait

**Files:**
- Modify: `src/rapid-warm-state.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-rapid-warm-state.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Add duration fields to the warm status view**

In `src/rapid-warm-state.mjs`, extend `rapidWarmStatusView(...)`:

```js
const startedMs = Date.parse(input.startedAt || '');
const completedMs = Date.parse(input.completedAt || input.failedAt || '');
const elapsedMs = Number.isFinite(Number(input.elapsedMs))
  ? Math.max(0, Math.round(Number(input.elapsedMs)))
  : (Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, completedMs - startedMs) : 0);
```

Add `elapsedMs` to the returned object.

- [ ] **Step 2: Update status tests**

In `tools/scripts/test-rapid-warm-state.mjs`, update the expected `rapidWarmStatusView(...)` object to include:

```js
elapsedMs: 0,
```

Add:

```js
assertEqual(
  rapidWarmStatusView({
    status: 'ready',
    pipelineMode: 'rapid',
    startedAt: '2026-07-04T00:00:00.000Z',
    completedAt: '2026-07-04T00:00:04.250Z'
  }).elapsedMs,
  4250,
  'Rapid warm status view computes elapsed duration'
);
```

- [ ] **Step 3: Record elapsed time when warm succeeds, fails, or misses**

In `warmRapidScene(...)`, capture:

```js
const warmStartedAtMs = Date.now();
```

When setting `lastRapidWarmView` for ready/failed/missed states, include:

```js
elapsedMs: Date.now() - warmStartedAtMs
```

In `waitForRapidWarm(...)`, include the configured timeout in activity detail:

```js
detail: { joinWaitMs: Math.max(0, Number(timeoutMs) || 0) }
```

- [ ] **Step 4: Add runtime assertion for timeout telemetry**

In the warm-timeout test in `tools/scripts/test-runtime.mjs`, add:

```js
assertEqual(harness.runtime.view().rapidWarm.reasonCode, 'warm-timeout', 'Rapid warm timeout reason is retained');
assert(Number(harness.runtime.view().rapidWarm.elapsedMs) >= 0, 'Rapid warm view exposes elapsed milliseconds');
```

- [ ] **Step 5: Decide join wait tuning after live evidence**

Use the new telemetry to inspect live `rapid.warm_missed` journal rows before changing the default from `RAPID_WARM_JOIN_WAIT_MS = 4000`. If most misses show `warm-timeout` with successful warm completion shortly after, raise the default or make it a compact advanced setting. If misses are mostly `settings-mismatch`, `no-candidate-cards`, or `delta-*`, fix those buckets first.

- [ ] **Step 6: Run gates and commit**

Run:

```powershell
node tools\scripts\test-rapid-warm-state.mjs
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\rapid-warm-state.mjs src\runtime.mjs tools\scripts\test-rapid-warm-state.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "test: add rapid warm duration telemetry"
```

---

## Phase 3.6: Fused Partial-Recovery Bug Hunt Before Runtime Extraction

The current Fused path already validates each item independently after a valid bundle envelope is parsed. Focused suites pass at the time this addendum was written:

```powershell
node tools\scripts\test-cards.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-provider-response-parser.mjs
node tools\scripts\test-runtime.mjs
```

Current risk: if the envelope parses and at least one requested card survives, runtime immediately returns only those fused cards. Missing or damaged requested siblings are diagnosed but not regenerated. If the top-level envelope is damaged, schema-mismatched, or parser-rejected, the whole Fused bundle is treated as unusable and Standard card generation runs for every requested card. The intended refactor contract is narrower: salvage valid fused items, rerun only damaged or missing requested card families through the Standard individual-card path, and use full Standard fallback only when no trustworthy fused item can be recovered or the bundle belongs to the wrong snapshot.

### Task 8G: Preserve Fused Item Damage As Structured Repair Data

**Files:**
- Modify: `src/cards.mjs`
- Modify: `tools/scripts/test-cards.mjs`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`

- [ ] **Step 1: Add Fused parser metadata assertions**

In `tools/scripts/test-cards.mjs`, after the existing `fusedInvalidUnsafeText` assertion, add:

```js
assertDeepEqual(fusedParsed.acceptedFamilies, ['Scene Frame', 'Character Motivation'], 'Fused parser reports accepted families');
assertDeepEqual(fusedParsed.missingFamilies, [], 'Fused parser reports no missing families when requested siblings are accepted');
assertDeepEqual(fusedInvalidUnsafeText.acceptedFamilies, [], 'Fused parser reports no accepted families for invalid-only bundle');
assertDeepEqual(fusedInvalidUnsafeText.invalidFamilies, ['Scene Frame'], 'Fused parser reports invalid families for targeted repair');
assertDeepEqual(fusedInvalidUnsafeText.missingFamilies, ['Character Motivation'], 'Fused parser reports requested siblings absent from damaged bundle');
```

Expected before implementation: FAIL because `cardsFromFusedProviderResult(...)` currently returns only `cards`, `omissions`, and `diagnostics`.

- [ ] **Step 2: Extend Fused parser output shape**

In `src/cards.mjs`, change the initial output in `cardsFromFusedProviderResult(...)`:

```js
const output = {
  cards: [],
  omissions: [],
  diagnostics: [],
  acceptedFamilies: [],
  invalidFamilies: [],
  rejectedFamilies: [],
  missingFamilies: []
};
```

When an unrequested, unknown, or duplicate item is rejected, add:

```js
if (catalog?.family) output.rejectedFamilies.push(catalog.family);
```

When item validation fails, add:

```js
output.invalidFamilies.push(catalog.family);
```

When a card is accepted, add:

```js
output.acceptedFamilies.push(catalog.family);
```

When requested families are not seen as accepted, change the missing loop:

```js
for (const family of requested.keys()) {
  if (!seen.has(family)) {
    output.missingFamilies.push(family);
    output.diagnostics.push(`fused-item-missing:${family}`);
  }
}
```

At the end, de-duplicate the arrays while preserving order:

```js
for (const key of ['acceptedFamilies', 'invalidFamilies', 'rejectedFamilies', 'missingFamilies']) {
  output[key] = [...new Set(output[key])];
}
```

- [ ] **Step 3: Update provider docs**

In `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, update the `fusedCardBundle` behavior note:

```markdown
Fused bundle validation reports accepted, invalid, rejected, omitted, and missing requested families. Runtime uses that structure to rerun only damaged or missing requested families when at least one fused item is trustworthy.
```

- [ ] **Step 4: Run gates and commit**

Run:

```powershell
node tools\scripts\test-cards.mjs
npm.cmd test
```

Commit:

```powershell
git add src\cards.mjs tools\scripts\test-cards.mjs docs\architecture\PROVIDER_AND_GENERATION_SPEC.md
git commit -m "test: expose fused item repair metadata"
```

---

### Task 8H: Salvage Valid Items From Damaged Fused Envelopes

**Files:**
- Modify: `src/cards.mjs`
- Modify: `tools/scripts/test-cards.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Add damaged-envelope salvage tests**

Add these assertions to `tools/scripts/test-cards.mjs` after the existing Fused parser block:

```js
const fusedDamagedEnvelope = cardsFromFusedProviderResult({
  ok: true,
  roleId: 'fusedCardBundle',
  lane: 'reasoner',
  data: {
    schema: 'recursion.cardBundle.damaged',
    snapshotHash: 'snapshot-fused-1',
    items: [{
      schema: 'recursion.card.v1',
      family: 'Scene Frame',
      role: 'sceneFrameCard',
      promptText: 'DAMAGED_ENVELOPE_SCENE_FRAME survives envelope schema damage.',
      evidenceRefs: ['message:8'],
      tokenEstimate: 20
    }]
  }
}, fusedCardContext);
assertEqual(fusedDamagedEnvelope.cards.length, 1, 'Fused validator salvages valid requested item from damaged envelope schema');
assert(fusedDamagedEnvelope.diagnostics.includes('fused-bundle-envelope-damaged'), 'damaged envelope salvage records diagnostic');
assertDeepEqual(fusedDamagedEnvelope.acceptedFamilies, ['Scene Frame'], 'damaged envelope salvage reports accepted family');
assertDeepEqual(fusedDamagedEnvelope.missingFamilies, ['Character Motivation'], 'damaged envelope salvage reports missing sibling');

const fusedWrongSnapshotEnvelope = cardsFromFusedProviderResult({
  ok: true,
  roleId: 'fusedCardBundle',
  data: {
    schema: 'recursion.cardBundle.damaged',
    snapshotHash: 'wrong-snapshot',
    items: [{
      schema: 'recursion.card.v1',
      family: 'Scene Frame',
      role: 'sceneFrameCard',
      promptText: 'Wrong snapshot must not be salvaged.',
      evidenceRefs: ['message:8']
    }]
  }
}, fusedCardContext);
assertEqual(fusedWrongSnapshotEnvelope.cards.length, 0, 'Fused validator never salvages wrong-snapshot envelope');
assert(fusedWrongSnapshotEnvelope.diagnostics.includes('fused-bundle-snapshot-mismatch'), 'wrong snapshot still records mismatch diagnostic');
```

Expected before implementation: the first salvage test fails because schema mismatch returns before item validation.

- [ ] **Step 2: Treat schema mismatch as envelope damage when items are present**

In `cardsFromFusedProviderResult(...)`, replace the early schema mismatch return:

```js
if (data.schema !== CARD_BUNDLE_RESPONSE_SCHEMA) {
  output.diagnostics.push('fused-bundle-schema-mismatch');
  return output;
}
```

with:

```js
const envelopeSchemaOk = data.schema === CARD_BUNDLE_RESPONSE_SCHEMA;
if (!envelopeSchemaOk) {
  output.diagnostics.push('fused-bundle-schema-mismatch');
  if (!Array.isArray(data.items) || data.items.length === 0) return output;
  output.diagnostics.push('fused-bundle-envelope-damaged');
}
```

Keep the snapshot check before item salvage. Explicit wrong snapshot remains a hard stop:

```js
if (!providerSnapshotMatches(data, context)) {
  output.diagnostics.push('fused-bundle-snapshot-mismatch');
  return output;
}
```

- [ ] **Step 3: Update architecture doc**

In `docs/architecture/RUNTIME_ARCHITECTURE.md`, replace the Fused validation bullets with:

```markdown
4. Validate the bundle snapshot first. A wrong snapshot is a hard stop.
5. Validate each requested item as a normal `recursion.card.v1` card. A damaged top-level schema may still yield trustworthy requested items if the snapshot matches.
6. Regenerate only damaged or missing requested siblings through individual card generation; run full Standard card generation only when no Fused item is trustworthy.
```

- [ ] **Step 4: Run gates and commit**

Run:

```powershell
node tools\scripts\test-cards.mjs
npm.cmd test
```

Commit:

```powershell
git add src\cards.mjs tools\scripts\test-cards.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "fix: salvage damaged fused envelopes"
```

---

### Task 8I: Add Targeted Standard Repair For Missing Or Invalid Fused Siblings

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Write the targeted repair runtime test**

Add this block after the existing Fused happy-path test in `tools/scripts/test-runtime.mjs`:

```js
{
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode: 'fused', mode: 'auto', reasoningLevel: 'low', reasonerUse: 'off' },
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
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              cardJobs: [
                { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Valid fused sibling.' },
                { family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'Damaged fused sibling.' }
              ],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              reasonerDecision: { mode: 'skip', reason: 'targeted fused repair', signals: [] },
              diagnostics: ['targeted-fused-repair-plan']
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          return {
            ok: true,
            roleId,
            lane: request.lane,
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [
                {
                  schema: 'recursion.card.v1',
                  family: 'Scene Frame',
                  role: 'sceneFrameCard',
                  promptText: 'FUSED_PARTIAL_VALID_SCENE: keep this fused sibling.',
                  evidenceRefs: ['message:2'],
                  tokenEstimate: 18
                },
                {
                  schema: 'recursion.card.v1',
                  family: 'Scene Constraints',
                  role: 'sceneConstraintsCard',
                  promptText: 'The hidden chain of thought says this sibling is damaged.',
                  evidenceRefs: ['message:2'],
                  tokenEstimate: 18
                }
              ]
            }
          };
        }
        if (roleId === 'sceneConstraintsCard') {
          return {
            ok: true,
            roleId,
            data: {
              schema: 'recursion.card.v1',
              role: 'sceneConstraintsCard',
              family: 'Scene Constraints',
              snapshotHash: request.snapshotHash,
              items: [{
                promptText: 'FUSED_TARGETED_REPAIR_CONSTRAINT: repaired only the damaged sibling.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 16
              }]
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Use fused partial repair cards.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['targeted-fused-repair-guidance']
            }
          };
        }
        throw new Error(`unexpected targeted fused repair role ${roleId}`);
      },
      async batch(requests = [], options = {}) {
        const results = [];
        for (const request of requests) {
          results.push(await this.generate(request.roleId, request, options));
        }
        return results;
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Repair only damaged fused card.' });
  assertEqual(result.ok, true, 'Fused targeted repair installs prompt');
  assertDeepEqual(roleCalls, ['utilityArbiter', 'fusedCardBundle', 'sceneConstraintsCard', 'guidanceComposer'], 'Fused targeted repair reruns only damaged requested sibling');
  assert(!roleCalls.includes('sceneFrameCard'), 'Fused targeted repair does not rerun valid fused sibling');
  assert(result.packet.sections.cardEvidence.includes('FUSED_PARTIAL_VALID_SCENE'), 'valid fused sibling reaches packet');
  assert(result.packet.sections.cardEvidence.includes('FUSED_TARGETED_REPAIR_CONSTRAINT'), 'repaired sibling reaches packet');
  assert(result.plan.diagnostics.includes('fused-partial-repair-standard'), 'plan records targeted repair path');
  assert(!result.plan.diagnostics.includes('fused-fallback-standard'), 'targeted repair is not full Standard fallback');
}
```

Expected before implementation: FAIL because current runtime returns immediately after `parsed.cards.length > 0` and never calls `sceneConstraintsCard`.

- [ ] **Step 2: Add a helper to select repair requests**

Inside `generatePlanCards(...)` in `src/runtime.mjs`, after `const requests = ...`, add:

```js
function repairRequestsForFusedResult(parsed, allRequests) {
  const accepted = new Set(Array.isArray(parsed.acceptedFamilies) ? parsed.acceptedFamilies : parsed.cards.map((card) => card.family));
  const damaged = new Set([
    ...(Array.isArray(parsed.invalidFamilies) ? parsed.invalidFamilies : []),
    ...(Array.isArray(parsed.missingFamilies) ? parsed.missingFamilies : []),
    ...(Array.isArray(parsed.omissions) ? parsed.omissions.map((entry) => safeText(entry.family || '', 120)).filter(Boolean) : [])
  ]);
  return allRequests.filter((request) => {
    const family = safeText(request.metadata?.family || '', 120);
    return family && !accepted.has(family) && damaged.has(family);
  });
}
```

- [ ] **Step 3: Run targeted repair before returning parsed fused cards**

Replace the immediate return in the `if (parsed.cards.length > 0)` block with:

```js
const repairRequests = repairRequestsForFusedResult(parsed, requests);
let repairedCards = [];
if (repairRequests.length) {
  fusedDiagnostics.push('fused-partial-repair-standard');
  fusedDiagnostics.push(...repairRequests.map((request) => `fused-repair:${safeText(request.metadata?.family || request.roleId || 'unknown', 80)}`));
  const signalRepairRequests = signal ? repairRequests.map((request) => ({ ...request, signal })) : repairRequests;
  const repairOptions = { runId, signal, isCurrent: () => isRuntimeRunCurrent(runId) };
  const usedRepairBatch = typeof generationRouter.batch === 'function';
  const repairResults = usedRepairBatch
    ? await generationRouter.batch(signalRepairRequests, repairOptions)
    : [];
  if (!usedRepairBatch) {
    for (const request of signalRepairRequests) {
      if (signal?.aborted === true || !isRuntimeRunCurrent(runId)) break;
      try {
        repairResults.push(await generationRouter.generate(request.roleId, request, repairOptions));
      } catch {
        if (signal?.aborted === true || !isRuntimeRunCurrent(runId)) break;
        repairResults.push({ ok: false });
      }
    }
  }
  repairedCards = repairResults.flatMap((repairResult, index) => cardsFromProviderResult(repairResult, {
    ...cardSourceContext(snapshot),
    expectedSnapshotHash: repairRequests[index]?.snapshotHash,
    expectedRole: repairRequests[index]?.metadata?.role,
    expectedFamily: repairRequests[index]?.metadata?.family
  }).map((card) => ({
    ...card,
    providerLane: repairResult?.lane || repairRequests[index]?.lane || 'utility',
    providerRole: repairRequests[index]?.roleId || card.providerRole || '',
    fusedRepair: true
  })));
}
```

Then return the merged result:

```js
return {
  cards: [
    ...parsed.cards.map((card) => ({
      ...card,
      providerLane: result?.lane || fusedRequest.lane || 'utility',
      ...(retryCount ? {
        providerRetryCount: retryCount,
        providerProgressReason: providerCardRetryReason(retryCount, true)
      } : {})
    })),
    ...repairedCards
  ],
  diagnostics: mergeDiagnostics(['fused-bundle-used'], fusedDiagnostics)
};
```

- [ ] **Step 4: Keep full fallback only for zero trusted cards**

Leave this existing behavior intact:

```js
if (parsed.cards.length === 0) {
  fusedDiagnostics.push('fused-fallback-standard');
}
```

Do not add `fused-fallback-standard` when `parsed.cards.length > 0`; use `fused-partial-repair-standard` instead.

- [ ] **Step 5: Run gates and commit**

Run:

```powershell
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\runtime.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "fix: repair partial fused bundles"
```

---

### Task 8J: Recover Fused Items From Truncated Or Malformed Provider Text

**Files:**
- Modify: `src/providers/structured-output-parser.mjs`
- Modify: `src/providers.mjs`
- Modify: `src/cards.mjs`
- Modify: `tools/scripts/test-provider-response-parser.mjs`
- Modify: `tools/scripts/test-cards.mjs`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`

- [ ] **Step 1: Add parser tests for an incomplete Fused items array**

In `tools/scripts/test-provider-response-parser.mjs`, add:

```js
import {
  extractJsonObjectsFromArrayProperty
} from '../../src/providers/structured-output-parser.mjs';

const partialFusedItems = extractJsonObjectsFromArrayProperty(`{
  "schema": "recursion.cardBundle.v1",
  "snapshotHash": "snapshot-fused-1",
  "items": [
    {"schema":"recursion.card.v1","family":"Scene Frame","role":"sceneFrameCard","promptText":"Recovered first item.","evidenceRefs":["message:8"]},
    {"schema":"recursion.card.v1","family":"Scene Constraints","role":"sceneConstraintsCard","promptText":"Unclosed second item"
`, 'items');
assertEqual(partialFusedItems.length, 1, 'parser recovers complete objects before damaged array tail');
assertEqual(partialFusedItems[0].family, 'Scene Frame', 'parser preserves recovered fused item family');
```

Expected before implementation: FAIL because the helper does not exist.

- [ ] **Step 2: Implement a generic array-object fragment extractor**

In `src/providers/structured-output-parser.mjs`, add:

```js
export function extractJsonObjectsFromArrayProperty(text = '', propertyName = 'items') {
  const source = String(text || '');
  const propertyPattern = new RegExp(`"${propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*\\[`, 'i');
  const match = propertyPattern.exec(source);
  if (!match) return [];
  let index = match.index + match[0].length;
  const values = [];
  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index] || '')) index += 1;
    if (source[index] === ']') break;
    if (source[index] !== '{') {
      index += 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    const start = index;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseStructuredJsonText(source.slice(start, index + 1), { requireObject: true });
          if (parsed.ok) values.push(parsed.value);
          index += 1;
          break;
        }
      }
    }
    if (depth !== 0) break;
  }
  return values;
}
```

- [ ] **Step 3: Surface recoverable Fused text on provider parse failure**

In `src/providers.mjs`, when `generate(...)` catches a structured-output parse/schema error for `roleId === 'fusedCardBundle'`, include bounded visible text in the returned failure:

```js
return {
  ok: false,
  roleId,
  lane,
  error: safeError,
  diagnostics,
  recoverableText: roleId === 'fusedCardBundle' ? truncate(String(raw?.text || ''), 12000) : ''
};
```

If `raw` is not currently in catch scope, hoist it:

```js
let raw = null;
```

before the attempt loop, assign it from `client.generate(...)`, then use it in the catch.

- [ ] **Step 4: Let Fused validator recover complete item fragments from failed result text**

In `src/cards.mjs`, import:

```js
import { extractJsonObjectsFromArrayProperty } from './providers/structured-output-parser.mjs';
```

At the top of `cardsFromFusedProviderResult(...)`, replace the early provider-failed return:

```js
if (!result?.ok) {
  output.diagnostics.push('fused-bundle-provider-failed');
  return output;
}
```

with:

```js
if (!result?.ok) {
  output.diagnostics.push('fused-bundle-provider-failed');
  const recoveredItems = extractJsonObjectsFromArrayProperty(result?.recoverableText || result?.text || '', 'items');
  if (!recoveredItems.length) return output;
  output.diagnostics.push('fused-bundle-fragment-recovered');
  result = {
    ...result,
    ok: true,
    data: {
      schema: CARD_BUNDLE_RESPONSE_SCHEMA,
      snapshotHash: context.expectedSnapshotHash || context.snapshotHash || '',
      items: recoveredItems
    }
  };
}
```

- [ ] **Step 5: Add cards-level fragment recovery test**

In `tools/scripts/test-cards.mjs`, add:

```js
const fusedRecoveredFragment = cardsFromFusedProviderResult({
  ok: false,
  roleId: 'fusedCardBundle',
  recoverableText: `{"schema":"recursion.cardBundle.v1","snapshotHash":"snapshot-fused-1","items":[{"schema":"recursion.card.v1","family":"Scene Frame","role":"sceneFrameCard","promptText":"FUSED_FRAGMENT_RECOVERED_SCENE survives truncation.","evidenceRefs":["message:8"]},{"schema":"recursion.card.v1","family":"Scene Constraints","role":"sceneConstraintsCard","promptText":"unfinished"`
}, fusedCardContext);
assertEqual(fusedRecoveredFragment.cards.length, 1, 'Fused validator recovers complete item before malformed tail');
assert(fusedRecoveredFragment.cards[0].promptText.includes('FUSED_FRAGMENT_RECOVERED_SCENE'), 'recovered fragment card text is preserved');
assert(fusedRecoveredFragment.diagnostics.includes('fused-bundle-fragment-recovered'), 'fragment recovery diagnostic recorded');
assertDeepEqual(fusedRecoveredFragment.missingFamilies, ['Character Motivation'], 'fragment recovery still reports missing requested sibling');
```

- [ ] **Step 6: Run gates and commit**

Run:

```powershell
node tools\scripts\test-provider-response-parser.mjs
node tools\scripts\test-cards.mjs
node tools\scripts\test-providers.mjs
npm.cmd test
```

Commit:

```powershell
git add src\providers\structured-output-parser.mjs src\providers.mjs src\cards.mjs tools\scripts\test-provider-response-parser.mjs tools\scripts\test-cards.mjs docs\architecture\PROVIDER_AND_GENERATION_SPEC.md
git commit -m "fix: recover fused item fragments"
```

---

### Task 8K: Keep Fused Repair Progress And Diagnostics Precise

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `src/progress.mjs`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Add progress model test for repaired siblings**

In `tools/scripts/test-progress.mjs`, add:

```js
const fusedRepairProgress = createProgressRunModel({
  history: [
    { runId: 'fused-repair-progress', phase: 'started', label: 'Reading current turn...', recordedAt: '1' },
    { runId: 'fused-repair-progress', phase: 'fusedCardBundleRunning', label: 'Generating fused card bundle...', providerLane: 'utility', cardCounts: { requested: 2 }, recordedAt: '2' },
    {
      runId: 'fused-repair-progress',
      phase: 'cardProgress',
      providerLane: 'utility',
      detail: {
        parentStepId: 'fused-card-bundle',
        roleId: 'sceneFrameCard',
        family: 'Scene Frame',
        state: 'done'
      },
      recordedAt: '3'
    },
    {
      runId: 'fused-repair-progress',
      phase: 'cardProgress',
      providerLane: 'utility',
      detail: {
        parentStepId: 'utility-card-batch',
        roleId: 'sceneConstraintsCard',
        family: 'Scene Constraints',
        state: 'done',
        source: 'fused-repair'
      },
      recordedAt: '4'
    }
  ],
  activity: { runId: 'fused-repair-progress', phase: 'cardBatchRunning', label: 'Repairing fused cards...', providerLane: 'utility', recordedAt: '4' },
  settings: { pipelineMode: 'fused' }
});
const repairBatch = fusedRepairProgress.steps.find((step) => step.id === 'utility-card-batch');
assert(repairBatch.children.some((child) => child.id === 'scene-constraints-card' && child.state === 'done'), 'Fused repair progress shows repaired sibling under utility card batch');
```

- [ ] **Step 2: Stage accepted Fused cards and repaired cards separately**

In `src/runtime.mjs`, after parsing Fused cards, call:

```js
stageCardProgress(runId, parsed.cards, { source: 'generated', state: 'done' });
```

For repaired cards, add a helper stage:

```js
stageCardProgress(runId, repairedCards.map((card) => ({
  ...card,
  providerRole: card.providerRole || card.role,
  providerProgressSource: 'fused-repair'
})), { source: 'generated', state: 'done' });
```

If `stageCardProgress(...)` cannot currently distinguish repaired cards, extend `cardProgressDetail(...)` to use `card.providerProgressSource === 'fused-repair'` and set:

```js
parentStepId: 'utility-card-batch',
source: 'fused-repair'
```

- [ ] **Step 3: Add runtime diagnostics assertion**

In the targeted repair runtime test from Task 8I, add:

```js
assert(result.plan.diagnostics.includes('fused-repair:Scene Constraints'), 'targeted repair names repaired family');
assert(!result.plan.diagnostics.includes('fused-repair:Scene Frame'), 'targeted repair does not name accepted fused family');
```

- [ ] **Step 4: Run gates and commit**

Run:

```powershell
node tools\scripts\test-progress.mjs
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\runtime.mjs src\progress.mjs tools\scripts\test-progress.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "test: expose fused repair progress"
```

---

### Task 8L: Restrict Full Standard Fallback To Absolute Fused Failure

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`

- [ ] **Step 1: Add full-fallback boundary tests**

In `tools/scripts/test-runtime.mjs`, keep the existing schema-mismatch full fallback test only for a bundle with no recoverable items. Add this second boundary test:

```js
{
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { pipelineMode: 'fused', mode: 'auto', reasoningLevel: 'low', reasonerUse: 'off' },
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
              cardJobs: [
                { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'No recoverable fused item.' },
                { family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'No recoverable fused item.' }
              ],
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              reasonerDecision: { mode: 'skip', reason: 'full fallback boundary', signals: [] },
              diagnostics: ['fused-full-fallback-boundary']
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          return {
            ok: true,
            roleId,
            data: { schema: 'wrong.schema', snapshotHash: request.snapshotHash, items: [] }
          };
        }
        if (roleId === 'sceneFrameCard' || roleId === 'sceneConstraintsCard') {
          return {
            ok: true,
            roleId,
            data: {
              schema: 'recursion.card.v1',
              role: roleId,
              family: roleId === 'sceneFrameCard' ? 'Scene Frame' : 'Scene Constraints',
              snapshotHash: request.snapshotHash,
              items: [{
                promptText: `${roleId === 'sceneFrameCard' ? 'FULL_FALLBACK_SCENE' : 'FULL_FALLBACK_CONSTRAINT'} recovered from full Standard fallback.`,
                evidenceRefs: ['message:2'],
                tokenEstimate: 16
              }]
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Use full fallback cards.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['full-fallback-guidance']
            }
          };
        }
        throw new Error(`unexpected full fallback role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Fallback only when nothing is salvageable.' });
  assertEqual(result.ok, true, 'full fallback still succeeds when Fused has no recoverable items');
  assert(roleCalls.includes('sceneFrameCard'), 'full fallback regenerates Scene Frame');
  assert(roleCalls.includes('sceneConstraintsCard'), 'full fallback regenerates Scene Constraints');
  assert(result.plan.diagnostics.includes('fused-fallback-standard'), 'full fallback diagnostic remains for zero trusted fused cards');
}
```

- [ ] **Step 2: Make the fallback condition explicit**

In `generatePlanCards(...)`, enforce this rule:

```js
if (parsed.cards.length > 0) {
  // targeted repair path; never append fused-fallback-standard
}
if (parsed.cards.length === 0) {
  fusedDiagnostics.push('fused-fallback-standard');
  // Standard runs for every requested card.
}
```

Do not use `fused-fallback-standard` for targeted sibling repairs.

- [ ] **Step 3: Update docs**

In `docs/architecture/RUNTIME_ARCHITECTURE.md`, add:

```markdown
Fused has three recovery levels: accept all requested cards from the bundle, accept trustworthy bundle items and repair only damaged/missing siblings with individual card calls, or full Standard fallback when no trustworthy Fused item survives. Full fallback is not the normal response to a partially damaged bundle.
```

In `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, update the `fusedCardBundle` row recovery text:

```markdown
Validate each item independently; rerun only damaged/missing requested families when any requested item is trustworthy; fall back to full Standard card generation only when no requested item is recoverable or the snapshot is wrong.
```

- [ ] **Step 4: Run gates and commit**

Run:

```powershell
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\runtime.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md docs\architecture\PROVIDER_AND_GENERATION_SPEC.md
git commit -m "fix: restrict fused full fallback"
```

---

## Phase 4: Runtime Refactor

### Task 9: Extract Runtime Run State

**Files:**
- Create: `src/runtime/run-state.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Create run-state helper**

Create `src/runtime/run-state.mjs`:

```js
export function createRuntimeRunState() {
  let activeRunId = null;
  let activeRunController = null;
  let activeRapidWarmRun = null;
  let hostGenerationActive = false;
  let activeRuntimeMutations = 0;
  let activePromptMutationId = null;
  let pendingLatestAssistantSwipeRetry = null;
  let pendingForceRegenerate = null;

  return {
    current() {
      return {
        activeRunId,
        activeRunController,
        activeRapidWarmRun,
        hostGenerationActive,
        activeRuntimeMutations,
        activePromptMutationId,
        pendingLatestAssistantSwipeRetry,
        pendingForceRegenerate
      };
    },
    setActiveRun(runId, controller = null) {
      activeRunId = runId || null;
      activeRunController = controller || null;
    },
    clearActiveRun(runId = activeRunId) {
      if (!runId || runId === activeRunId) {
        activeRunId = null;
        activeRunController = null;
      }
    },
    setHostGenerationActive(value) {
      hostGenerationActive = Boolean(value);
    },
    beginRuntimeMutation() {
      activeRuntimeMutations += 1;
      return activeRuntimeMutations;
    },
    endRuntimeMutation() {
      activeRuntimeMutations = Math.max(0, activeRuntimeMutations - 1);
      return activeRuntimeMutations;
    },
    setPromptMutation(id) {
      activePromptMutationId = id || null;
    },
    setRapidWarmRun(run) {
      activeRapidWarmRun = run || null;
    },
    setLatestAssistantSwipeRetry(retry) {
      pendingLatestAssistantSwipeRetry = retry || null;
    },
    takeLatestAssistantSwipeRetry() {
      const retry = pendingLatestAssistantSwipeRetry;
      pendingLatestAssistantSwipeRetry = null;
      return retry;
    },
    clearLatestAssistantSwipeRetry() {
      pendingLatestAssistantSwipeRetry = null;
    },
    setForceRegenerate(token) {
      pendingForceRegenerate = token || null;
    },
    takeForceRegenerate() {
      const token = pendingForceRegenerate;
      pendingForceRegenerate = null;
      return token;
    }
  };
}
```

- [ ] **Step 2: Add run-state tests**

Add to `tools/scripts/test-runtime.mjs`:

```js
import { createRuntimeRunState } from '../../src/runtime/run-state.mjs';

const runState = createRuntimeRunState();
runState.setActiveRun('run-state-1', { abort() {} });
assertEqual(runState.current().activeRunId, 'run-state-1', 'run state stores active run id');
runState.setLatestAssistantSwipeRetry({ reason: 'latest-assistant-swipe' });
assertEqual(runState.takeLatestAssistantSwipeRetry().reason, 'latest-assistant-swipe', 'run state takes swipe retry once');
assertEqual(runState.takeLatestAssistantSwipeRetry(), null, 'swipe retry is cleared after take');
runState.setForceRegenerate({ id: 'force-1' });
assertEqual(runState.takeForceRegenerate().id, 'force-1', 'force regenerate token is taken once');
runState.clearActiveRun('run-state-1');
assertEqual(runState.current().activeRunId, null, 'run state clears active run');
```

- [ ] **Step 3: Replace closure variables in runtime**

In `src/runtime.mjs`, import:

```js
import { createRuntimeRunState } from './runtime/run-state.mjs';
```

Inside `createRecursionRuntime(...)`, add:

```js
const runState = createRuntimeRunState();
```

Replace direct reads/writes of these variables with run-state methods:

```js
activeRunId
activeRunController
activeRapidWarmRun
hostGenerationActive
activeRuntimeMutations
activePromptMutationId
pendingLatestAssistantSwipeRetry
pendingForceRegenerate
```

For code that needs multiple values, use:

```js
const state = runState.current();
```

Do not change runtime public return methods in this task.

- [ ] **Step 4: Run runtime gate**

Run:

```powershell
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Expected: public runtime behavior unchanged.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\runtime.mjs src\runtime\run-state.mjs tools\scripts\test-runtime.mjs
git commit -m "refactor: extract runtime run state"
```

---

### Task 10: Extract Prompt Install Orchestration

**Files:**
- Create: `src/runtime/prompt-install.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Create prompt-install module**

Create `src/runtime/prompt-install.mjs` by moving these existing top-level helpers out of `src/runtime.mjs` and exporting them with the same names:

```text
installPrompt(host, packet)
installSummary(install)
installJournalDetails(install)
clearPromptBestEffort(host)
promptClearErrorSummary(clear)
promptClearSummary(clear)
```

Keep their current behavior exactly: unavailable host prompt install returns the same structured failure, thrown host errors become `RECURSION_PROMPT_INSTALL_FAILED`, clear failures remain best-effort, and summaries stay bounded/sanitized.

The new module imports the helper dependencies it currently gets from `src/runtime.mjs`:

```js
import { redact } from '../core.mjs';
import { safeText } from '../safe-values.mjs';
```

If `safeText` has not yet moved to `src/safe-values.mjs` in the execution branch, import it from the current module that owns the shared safe text helper after Task 5.
Do not change `runPromptMutationSection(...)`, freshness recheck, prompt tail ordering, or activity labels in this task.

- [ ] **Step 2: Add prompt install tests**

Add focused tests to `tools/scripts/test-runtime.mjs` using an in-memory host prompt adapter:

```js
const promptInstallCalls = [];
const promptHost = {
  prompt: {
    async install(packet, options) {
      promptInstallCalls.push({ packet, options });
      return { ok: true, promptId: 'prompt-1' };
    },
    async clear(options) {
      promptInstallCalls.push({ clear: true, options });
      return { ok: true };
    }
  }
};
const install = await installPrompt(promptHost, { promptText: 'Prompt' });
const clear = await clearPromptBestEffort(promptHost);
assertEqual(promptInstallCalls.length, 2, 'prompt install helper calls clear and install');
assertEqual(install.ok, true, 'prompt install helper preserves successful install result');
assertEqual(clear.ok, true, 'prompt clear helper preserves successful clear result');
```

Import `installPrompt` and `clearPromptBestEffort` from `src/runtime/prompt-install.mjs`.

- [ ] **Step 3: Move runtime prompt install call sites**

In `src/runtime.mjs`, import the moved helpers:

```js
import {
  clearPromptBestEffort,
  installJournalDetails,
  installPrompt,
  installSummary,
  promptClearErrorSummary,
  promptClearSummary
} from './runtime/prompt-install.mjs';
```

Delete the moved local helper definitions from `src/runtime.mjs`. Existing call sites such as `await installPrompt(host, packet)` and `await clearPromptBestEffort(host)` should continue to compile without changing their call shape.

- [ ] **Step 4: Update architecture docs**

Add to `docs/architecture/RUNTIME_ARCHITECTURE.md`:

```markdown
Prompt install is a runtime submodule. Pipeline code returns validated prompt packets; the prompt-install helper serializes host prompt writes and records install diagnostics.
```

- [ ] **Step 5: Run gates and commit**

Run:

```powershell
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\runtime.mjs src\runtime\prompt-install.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "refactor: extract prompt install flow"
```

---

### Task 11: Extract Standard And Fused Card Pipelines

**Files:**
- Create: `src/runtime/pipelines/standard.mjs`
- Create: `src/runtime/pipelines/fused.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Create Standard pipeline module**

Create `src/runtime/pipelines/standard.mjs` with a generation-router based contract:

```js
export async function runStandardCardPipeline({
  plan,
  snapshot,
  settings,
  generationRouter,
  stageCardProgress,
  signal,
  journal,
  runId
}) {
  const result = await generationRouter.generatePlanCards({ plan, snapshot, settings, signal });
  stageCardProgress?.(runId, result?.cards || [], { source: 'generated', state: 'done' });
  journal?.({ event: 'standard-card-pipeline-complete', cardCount: result?.cards?.length || 0 });
  return result;
}
```

During implementation, replace the `generationRouter.generatePlanCards(...)` sketch with the existing Standard branch from `src/runtime.mjs:3847-3888`: batch when `generationRouter.batch` exists, sequentially call `generationRouter.generate(...)` otherwise, preserve retry diagnostics, and preserve fallback-card handling. Keep the exported function's input/output shape.

- [ ] **Step 2: Create Fused pipeline module**

Create `src/runtime/pipelines/fused.mjs` with a generation-router based contract:

```js
export async function runFusedCardPipeline({
  plan,
  snapshot,
  settings,
  generationRouter,
  stageCardProgress,
  signal,
  journal,
  runId
}) {
  const result = await generationRouter.generate('fusedCardBundle', { plan, snapshot, settings, signal });
  stageCardProgress?.(runId, result?.cards || [], { source: 'generated', state: 'done' });
  journal?.({ event: 'fused-card-pipeline-complete', cardCount: result?.cards?.length || 0 });
  return result;
}
```

During implementation, replace the simple `generationRouter.generate(...)` body with the upgraded Fused branch after Phase 3.6 lands: build the fused request, call role `fusedCardBundle`, validate item-level card results, salvage damaged envelopes and recoverable fragments, repair only damaged or missing requested families through individual card generation, preserve diagnostics, and reserve full Standard fallback for zero trustworthy fused cards.

- [ ] **Step 3: Add dispatcher tests around the normalized card-pipeline contract**

In `tools/scripts/test-runtime.mjs`, add a test that stubs Standard and Fused path dependencies and asserts the selected pipeline follows `settings.pipelineMode` while returning the same `{ cards, diagnostics }` shape used by the upgraded partial-recovery Fused path:

```js
const pipelineCalls = [];
const standardResult = await runStandardCardPipeline({
  plan: { jobs: [] },
  snapshot: {},
  settings: { pipelineMode: 'standard' },
  generationRouter: {
    async generatePlanCards() {
      pipelineCalls.push('standard');
      return { cards: [] };
    }
  },
  journal: () => {}
});
assertDeepEqual(standardResult.cards, [], 'standard pipeline returns card result');

const fusedResult = await runFusedCardPipeline({
  plan: { jobs: [] },
  snapshot: {},
  settings: { pipelineMode: 'fused' },
  generationRouter: {
    async generate(roleId) {
      assertEqual(roleId, 'fusedCardBundle', 'fused helper calls fused role');
      pipelineCalls.push('fused');
      return { cards: [] };
    }
  },
  journal: () => {}
});
assertDeepEqual(fusedResult.cards, [], 'fused pipeline returns card result');
assertDeepEqual(pipelineCalls, ['standard', 'fused'], 'standard and fused pipeline helpers call their matching provider methods');
```

Import the helpers from their new modules.

- [ ] **Step 4: Wire runtime generation dispatcher**

In `src/runtime.mjs`, import:

```js
import { runStandardCardPipeline } from './runtime/pipelines/standard.mjs';
import { runFusedCardPipeline } from './runtime/pipelines/fused.mjs';
```

Replace the Standard/Fused branch inside `generatePlanCards(...)` with:

```js
if (settings.pipelineMode === 'fused') {
  return runFusedCardPipeline({
    runId,
    plan,
    snapshot,
    settings,
    generationRouter,
    stageCardProgress,
    signal,
    journal: appendJournalSafe
  });
}

return runStandardCardPipeline({
  runId,
  plan,
  snapshot,
  settings,
  generationRouter,
  stageCardProgress,
  signal,
  journal: appendJournalSafe
});
```

Keep `generatePlanCards(...)` as the conductor-owned dispatcher until all existing tests pass.

- [ ] **Step 5: Update docs**

In `docs/architecture/RUNTIME_ARCHITECTURE.md`, document:

```markdown
Standard and Fused are runtime pipeline modules. The runtime conductor selects the module; each module returns the same card result shape consumed by deck lifecycle, hand selection, guidance/reasoner composition, and prompt install.
```

- [ ] **Step 6: Run gates and commit**

Run:

```powershell
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\runtime.mjs src\runtime\pipelines\standard.mjs src\runtime\pipelines\fused.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "refactor: extract card pipelines"
```

---

### Task 12: Extract Rapid Pipeline

**Files:**
- Create: `src/runtime/pipelines/rapid.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`

- [ ] **Step 1: Create Rapid pipeline module**

Create `src/runtime/pipelines/rapid.mjs`:

```js
export async function warmRapidPipeline({
  reason,
  snapshot,
  settings,
  providerClient,
  storage,
  progress,
  signal,
  journal
}) {
  const result = await providerClient.generateRapidWarmDeck({
    reason,
    snapshot,
    settings,
    signal,
    onProgress: progress
  });
  await storage?.saveRapidWarm?.(result);
  journal?.({ event: 'rapid-warm-complete', reason, cardCount: result?.cards?.length || 0 });
  return result;
}

export async function runRapidForegroundPipeline({
  snapshot,
  settings,
  warmDeck,
  providerClient,
  progress,
  signal,
  journal
}) {
  const result = await providerClient.generateRapidTurnDelta({
    snapshot,
    settings,
    warmDeck,
    signal,
    onProgress: progress
  });
  journal?.({ event: 'rapid-foreground-complete', cardCount: result?.cards?.length || 0 });
  return result;
}
```

When moving code, preserve current Rapid warm state semantics, cancellation behavior, and Standard escalation behavior.

- [ ] **Step 2: Add helper tests**

Add to `tools/scripts/test-runtime.mjs`:

```js
const rapidPipelineCalls = [];
await warmRapidPipeline({
  reason: 'idle',
  snapshot: {},
  settings: { pipelineMode: 'rapid' },
  providerClient: {
    async generateRapidWarmDeck() {
      rapidPipelineCalls.push('warm');
      return { cards: [{ id: 'rapid-card' }] };
    }
  },
  storage: {
    async saveRapidWarm(result) {
      rapidPipelineCalls.push(`save-${result.cards.length}`);
    }
  },
  journal: () => {}
});
await runRapidForegroundPipeline({
  snapshot: {},
  settings: { pipelineMode: 'rapid' },
  warmDeck: { cards: [{ id: 'rapid-card' }] },
  providerClient: {
    async generateRapidTurnDelta() {
      rapidPipelineCalls.push('foreground');
      return { cards: [{ id: 'rapid-card' }] };
    }
  },
  journal: () => {}
});
assertDeepEqual(rapidPipelineCalls, ['warm', 'save-1', 'foreground'], 'rapid pipeline helpers run warm, save, and foreground paths');
```

Import both helpers from `src/runtime/pipelines/rapid.mjs`.

- [ ] **Step 3: Wire runtime Rapid call sites**

In `src/runtime.mjs`, replace the body of `warmRapidScene(...)` with a call to `warmRapidPipeline(...)`, and replace the foreground Rapid branch inside `prepareForGeneration(...)` with `runRapidForegroundPipeline(...)`.

Use this shape:

```js
const warmResult = await warmRapidPipeline({
  reason,
  snapshot,
  settings,
  providerClient,
  storage: storageRepository,
  progress: updateProgress,
  signal,
  journal: journalEvent
});
```

Keep the conductor responsible for deciding when Rapid is eligible, when to escalate, and when to install prompts.

- [ ] **Step 4: Run gates and commit**

Run:

```powershell
node tools\scripts\test-runtime.mjs
npm.cmd test
```

Commit:

```powershell
git add src\runtime.mjs src\runtime\pipelines\rapid.mjs tools\scripts\test-runtime.mjs docs\architecture\RUNTIME_ARCHITECTURE.md
git commit -m "refactor: extract rapid pipeline"
```

---

## Phase 5: UI Refactor

### Task 13: Extract Provider Panel Helpers

**Files:**
- Create: `src/ui/provider-panel.mjs`
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `docs/design/UI_SPEC.md`

- [ ] **Step 1: Move provider helper exports**

Create `src/ui/provider-panel.mjs`:

```js
export function providerSelector(name, lane) {
  return `[data-recursion-provider-${name}-${lane}]`;
}

export function providerStatusClass(text) {
  const normalized = String(text || '').toLowerCase();
  if (normalized.includes('ready')) return 'is-ready';
  if (normalized.includes('missing') || normalized.includes('invalid')) return 'is-warning';
  return 'is-neutral';
}

export function readProviderDraftFromControls({ root, lane, savedProvider, cleanText, asObject }) {
  const saved = asObject(savedProvider);
  const savedOpenAI = asObject(saved.openAICompatible);
  const read = (name, fallback = '') => {
    const element = root?.querySelector?.(providerSelector(name, lane)) ?? null;
    return element ? cleanText(element.value) : fallback;
  };
  return {
    source: read('source', saved.source || 'host-current-model') || 'host-current-model',
    hostConnectionProfileId: read('profile', saved.hostConnectionProfileId || ''),
    openAICompatible: {
      baseUrl: read('base-url', savedOpenAI.baseUrl || ''),
      model: read('model', savedOpenAI.model || ''),
      sessionApiKeyPresent: Boolean(read('api-key', ''))
    }
  };
}
```

- [ ] **Step 2: Re-export or import from UI**

In `src/ui.mjs`, import:

```js
import { providerSelector, providerStatusClass, readProviderDraftFromControls } from './ui/provider-panel.mjs';
```

Change `providerFromControls(...)` to:

```js
export function providerFromControls(container, lane, savedProvider = {}) {
  return readProviderDraftFromControls({
    root: container,
    lane,
    savedProvider,
    cleanText,
    asObject
  });
}
```

- [ ] **Step 3: Update tests to cover the new module**

In `tools/scripts/test-ui.mjs`, add:

```js
import { providerSelector, providerStatusClass } from '../../src/ui/provider-panel.mjs';

assertEqual(providerSelector('model', 'utility'), '[data-recursion-provider-model-utility]', 'provider selector helper is stable');
assertEqual(providerStatusClass('Ready'), 'is-ready', 'provider status ready class is stable');
assertEqual(providerStatusClass('Missing model'), 'is-warning', 'provider status warning class is stable');
```

- [ ] **Step 4: Run gates and commit**

Run:

```powershell
node tools\scripts\test-ui.mjs
npm.cmd test
```

Commit:

```powershell
git add src\ui.mjs src\ui\provider-panel.mjs tools\scripts\test-ui.mjs docs\design\UI_SPEC.md
git commit -m "refactor: extract provider panel helpers"
```

---

### Task 14: Extract View Model And Surface Renderers

**Files:**
- Create: `src/ui/view-model.mjs`
- Create: `src/ui/bar.mjs`
- Create: `src/ui/progress-panel.mjs`
- Create: `src/ui/cards-panel.mjs`
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `docs/design/UI_SPEC.md`

- [ ] **Step 1: Move view model into its own module**

Create `src/ui/view-model.mjs` by moving the current view-model cluster out of `src/ui.mjs`. The source span begins at `export function activityLabel(activity = {})` and ends at the closing brace of `export function createRecursionViewModel(view = {})`. Move the helper functions that are only used by that cluster with it: `runtimeHealthLabel`, `rapidWarmStandbyText`, `standbyStatusText`, `collectProviderLanesFromSteps`, and `progressFooterLabel`.

The new file imports the dependencies that remain outside the cluster:

```js
import { defaultCardScope, normalizeCardScope } from '../card-scope.mjs';
import { createHeroPixelBlocks, createProgressRunModel } from '../progress.mjs';
import { DEFAULT_RECURSION_SETTINGS, normalizeMode, normalizePipelineMode } from '../settings.mjs';
```

If any moved helper uses a UI-local utility such as `cleanText`, `asObject`, `modeLabel`, `pipelineLabel`, `cardScopeLabel`, `cardScopeCounts`, `normalizeSeverity`, `normalizeLastBriefStatus`, `normalizeChips`, `laneLabel`, `reasonerState`, `terminalStatusText`, or `integerInRange`, move that utility into `src/ui/view-model.mjs` too unless it is already imported from another module. Do not change the returned view-model object shape in this task.

- [ ] **Step 2: Re-export from UI during transition**

In `src/ui.mjs`, import and re-export:

```js
export { activityLabel, createRecursionViewModel } from './ui/view-model.mjs';
import { createRecursionViewModel } from './ui/view-model.mjs';
```

If the file needs both export and local import, use:

```js
import { activityLabel, createRecursionViewModel } from './ui/view-model.mjs';
export { activityLabel, createRecursionViewModel };
```

- [ ] **Step 3: Extract compact bar renderer**

Create `src/ui/bar.mjs`:

```js
export function renderCompactBar({ viewModel, tooltipsEnabled }) {
  return {
    statusText: viewModel.currentStepText || viewModel.standbyStatusText || 'Ready for Recursion.',
    modeLabel: viewModel.modeLabel,
    showStop: Boolean(viewModel.generationStopVisible),
    showForceRegenerate: Boolean(viewModel.forceRegenerateVisible),
    tooltipsEnabled: tooltipsEnabled !== false
  };
}
```

Use this as a pure presenter first. Keep DOM string rendering in `src/ui.mjs` until tests pass, then move actual markup in a follow-up patch.

- [ ] **Step 4: Add presenter tests**

In `tools/scripts/test-ui.mjs`, import:

```js
import { renderCompactBar } from '../../src/ui/bar.mjs';
```

Add:

```js
const compactBarPresentation = renderCompactBar({
  viewModel: {
    currentStepText: 'Generating scene cards...',
    standbyStatusText: 'Ready for Recursion.',
    modeLabel: 'Auto',
    generationStopVisible: true,
    forceRegenerateVisible: false
  },
  tooltipsEnabled: true
});
assertEqual(compactBarPresentation.statusText, 'Generating scene cards...', 'compact bar presenter prefers active step text');
assertEqual(compactBarPresentation.showStop, true, 'compact bar presenter exposes stop visibility');
assertEqual(compactBarPresentation.showForceRegenerate, false, 'compact bar presenter hides force regenerate during active work');
```

- [ ] **Step 5: Extract progress/cards presenters**

Create `src/ui/progress-panel.mjs`:

```js
export function progressPanelState(viewModel = {}) {
  return {
    title: viewModel.progressRun?.title || 'Recursion',
    subtitle: viewModel.progressRun?.subtitle || '',
    steps: Array.isArray(viewModel.progressRun?.steps) ? viewModel.progressRun.steps : []
  };
}
```

Create `src/ui/cards-panel.mjs`:

```js
export function cardsPanelState(viewModel = {}) {
  const cards = Array.isArray(viewModel.lastHand?.cards) ? viewModel.lastHand.cards : [];
  return {
    count: cards.length,
    cards,
    empty: cards.length === 0
  };
}
```

Add tests:

```js
import { progressPanelState } from '../../src/ui/progress-panel.mjs';
import { cardsPanelState } from '../../src/ui/cards-panel.mjs';

assertEqual(progressPanelState({ progressRun: { title: 'Generating', steps: [{ id: 's1' }] } }).steps.length, 1, 'progress panel presenter exposes steps');
assertEqual(cardsPanelState({ lastHand: { cards: [{ id: 'c1' }] } }).count, 1, 'cards panel presenter counts hand cards');
```

- [ ] **Step 6: Run gates and commit**

Run:

```powershell
node tools\scripts\test-ui.mjs
npm.cmd test
```

Commit:

```powershell
git add src\ui.mjs src\ui\view-model.mjs src\ui\bar.mjs src\ui\progress-panel.mjs src\ui\cards-panel.mjs tools\scripts\test-ui.mjs docs\design\UI_SPEC.md
git commit -m "refactor: split ui presenters"
```

---

### Task 15: Organize CSS By Surface

**Files:**
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `docs/design/UI_SPEC.md`

- [ ] **Step 1: Add section markers without changing selectors**

In `styles/recursion.css`, group existing selectors under these comments without changing rule bodies:

```css
/* Recursion root and compact bar */
/* Progress panel */
/* Cards and Last Brief */
/* Settings shell */
/* Provider panel */
/* Dialogs and diagnostics */
```

Keep existing selector specificity and order unless a duplicate rule is clearly identical.

- [ ] **Step 2: Add CSS section smoke assertion**

In `tools/scripts/test-ui.mjs`, add:

```js
const cssSource = readFileSync(new URL('../../styles/recursion.css', import.meta.url), 'utf8');
for (const section of [
  '/* Recursion root and compact bar */',
  '/* Progress panel */',
  '/* Cards and Last Brief */',
  '/* Settings shell */',
  '/* Provider panel */'
]) {
  assert(cssSource.includes(section), `CSS includes ${section}`);
}
```

- [ ] **Step 3: Run visual-risk gates**

Run:

```powershell
node tools\scripts\test-ui.mjs
npm.cmd test
```

If a local browser smoke is already configured and SillyTavern is running, run the existing UI smoke script from `docs/testing/LIVE_SMOKE_TEST_PLAN.md`.

- [ ] **Step 4: Commit**

Run:

```powershell
git add styles\recursion.css tools\scripts\test-ui.mjs docs\design\UI_SPEC.md
git commit -m "refactor: organize ui styles by surface"
```

---

## Phase 6: Final Bug Hunt And Verification

### Task 16: Add Static Bug-Hunt Guard Script

**Files:**
- Create: `tools/scripts/audit-refactor-hotspots.mjs`
- Modify: `package.json`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md`

- [ ] **Step 1: Create hotspot audit script**

Create `tools/scripts/audit-refactor-hotspots.mjs`:

```js
import { readFileSync } from 'node:fs';
import { assert } from '../../tests/helpers/assert.mjs';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

const activity = read('src/activity.mjs');
assert(activity.includes("'guidance'"), 'activity lane allow-list includes guidance');

const ui = read('src/ui.mjs');
assert(!ui.includes('save and test it'), 'UI copy does not reference removed provider save action');
assert(!ui.includes('catch(() => {})'), 'UI does not silently swallow action failures');

const providers = read('src/providers.mjs');
assert(!/ConnectionManagerRequestService/.test(providers), 'provider core does not inspect SillyTavern ConnectionManager globals');

const runtime = read('src/runtime.mjs');
assert(runtime.includes("from './runtime/run-state.mjs'"), 'runtime uses extracted run-state module');
assert(runtime.includes("from './runtime/diagnostics.mjs'"), 'runtime uses explicit diagnostics builder');
```

- [ ] **Step 2: Wire script into package test gate**

If `package.json` has an explicit test script list, add:

```json
"node tools/scripts/audit-refactor-hotspots.mjs"
```

If tests are discovered automatically, do not change `package.json`.

- [ ] **Step 3: Run audit and full test gate**

Run:

```powershell
node tools\scripts\audit-refactor-hotspots.mjs
npm.cmd test
```

Expected: both pass.

- [ ] **Step 4: Commit**

Run:

```powershell
git add tools\scripts\audit-refactor-hotspots.mjs package.json docs\testing\LIVE_SMOKE_TEST_PLAN.md
git commit -m "test: add refactor hotspot audit"
```

If `package.json` or docs were not modified, omit them from `git add`.

---

### Task 17: Documentation Pass

**Files:**
- Modify: `src/README.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/technical/HOST_INTEGRATION_MANUAL.md`
- Modify: `docs/DOCUMENTATION_INDEX.md`

- [ ] **Step 1: Update source layout README**

In `src/README.md`, update the module list to include:

```markdown
- `runtime/` - runtime conductor support modules: run state, prompt install, diagnostics, and pipeline runners.
- `runtime/pipelines/` - Standard, Rapid, and Fused provider-generation paths.
- `ui/` - pure UI presenters and provider/action helpers used by `ui.mjs`.
- `hosts/sillytavern/provider-profiles.mjs` - SillyTavern connection-profile discovery owned by the host adapter.
- `safe-values.mjs` - shared text/object safety helpers for diagnostics and host/provider normalization.
```

- [ ] **Step 2: Update architecture docs**

Add this paragraph to `docs/architecture/RUNTIME_ARCHITECTURE.md`:

```markdown
The runtime conductor owns sequencing and cancellation; pipeline modules own provider-generation variants. Standard, Rapid, and Fused all return normalized card results to the same deck, hand, prompt composition, and prompt-install path.
```

- [ ] **Step 3: Update provider docs**

Add this paragraph to `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`:

```markdown
Provider core is host-neutral. Host connection-profile discovery is supplied by the active host adapter; OpenAI-compatible endpoint model discovery remains provider-core behavior because it belongs to the endpoint contract rather than the SillyTavern object graph.
```

- [ ] **Step 4: Update documentation index**

In `docs/DOCUMENTATION_INDEX.md`, make sure the architecture, provider, host integration, design, and testing docs still describe current files and no removed module names.

- [ ] **Step 5: Run docs-sensitive gates**

Run:

```powershell
npm.cmd test
```

Expected: pass.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src\README.md docs\architecture\RUNTIME_ARCHITECTURE.md docs\architecture\PROVIDER_AND_GENERATION_SPEC.md docs\technical\HOST_INTEGRATION_MANUAL.md docs\DOCUMENTATION_INDEX.md
git commit -m "docs: document refactored recursion boundaries"
```

---

### Task 18: Final Verification And Live Smoke Decision

**Files:**
- Modify only if failures reveal stale docs or tests.

- [ ] **Step 1: Check worktree**

Run:

```powershell
git status --short
```

Expected: no uncommitted changes unless this task is preparing a final fixup.

- [ ] **Step 2: Run syntax check**

Run:

```powershell
Get-ChildItem -Path .\src,.\tools\scripts,.\tests -Recurse -Include *.mjs,*.js | ForEach-Object { node --check $_.FullName }
```

Expected: no output and exit code 0.

- [ ] **Step 3: Run full deterministic gate**

Run:

```powershell
npm.cmd test
```

Expected: `[pass]` for all configured test scripts.

- [ ] **Step 4: Decide live smoke requirement**

Run live SillyTavern/Playwright smoke if any of these changed since the last verified task:

```text
src/hosts/sillytavern/host.mjs
src/hosts/sillytavern/provider-profiles.mjs
src/extension/index.js
src/ui.mjs
styles/recursion.css
```

Use the repo's existing live smoke command from `docs/testing/LIVE_SMOKE_TEST_PLAN.md`. Before judging browser behavior, verify the served extension copy is fresh if the smoke plan includes a freshness gate.

- [ ] **Step 5: Record final risk notes**

Add a final implementation note to the PR or handoff:

```markdown
Verification:
- `node --check` over src/tools/tests: pass
- `npm.cmd test`: pass
- Live smoke: run/not run, with reason

Residual risk:
- UI refactor touched DOM rendering: live smoke recommended before pre-alpha release.
- Provider host discovery moved behind adapter: live profile discovery proof recommended against SillyTavern ConnectionManager.
```

---

## Self-Review

- Spec coverage: confirmed bugs, provider/host boundary, runtime pipelines, UI surfaces, diagnostics, docs, deterministic tests, and live-smoke decision are all mapped to tasks.
- Red-flag scan: plan text is clean for banned stub markers and undefined test steps.
- Type consistency: new helper names are stable across tasks: `providerFromControls`, `readProviderDraftFromControls`, `createUiActionStatus`, `buildDiagnosticsPayload`, `createRuntimeRunState`, `repairRequestsForFusedResult`, `extractJsonObjectsFromArrayProperty`, `runStandardCardPipeline`, `runFusedCardPipeline`, `warmRapidPipeline`, and `runRapidForegroundPipeline`.
- Execution order: narrow bug fixes land first; large extractions happen only after behavior is pinned by tests.
