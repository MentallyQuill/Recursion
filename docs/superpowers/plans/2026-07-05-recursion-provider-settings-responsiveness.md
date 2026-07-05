# Recursion Provider Settings Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Reasoner Provider disclosure open while provider controls autosave, and make Provider Test feel responsive by showing immediate lane-local busy feedback and using a small test-only generation budget.

**Architecture:** Preserve transient provider-panel UI state inside `mountRecursionUi()` instead of deriving every disclosure from persisted provider settings after each rerender. Provider Test gets a local in-flight lane state that updates the existing compact provider action button immediately, while runtime sends the same structured `providerTest` role through a bounded test request instead of the full lane `maxTokens` budget. The fix keeps provider setup SillyTavern-native, compact, and disclosure-based per `DESIGN.md` and `docs/design/UI_SPEC.md`.

**Tech Stack:** JavaScript ES modules, Recursion Settings/Providers/Runtime UI, SillyTavern host adapter provider routing, deterministic Node test scripts, optional Playwright live proof against the served SillyTavern extension copy.

---

## Current Diagnosis

Issue 1: Reasoner Provider collapses after any Providers change.

The provider autosave handler calls `runtime.updateProvider(...)`, then marks the whole settings panel stale and rerenders it:

```js
const handleProviderAutoSave = (event) => {
  const target = event?.target;
  if (!isProviderAutoSaveControl(target)) return;
  const lane = providerLaneFromDataset(target.dataset);
  runAction(runtime?.updateProvider?.(lane, readProviderPatch(root, lane)), () => {
    settingsPanelRendered = false;
    update();
  });
};
```

`renderSettingsPanel()` rebuilds the panel with `panel.replaceChildren()`. `renderProviderSettings()` then computes the section default from saved provider configuration:

```js
const open = lane === 'utility' || source.openAICompatible?.sessionApiKeyPresent === true || Boolean(source.openAICompatible?.model);
```

For a Reasoner lane using Current Host Model or Host Connection Profile, that expression is false, so the opened Reasoner section returns collapsed after every provider autosave.

Issue 2: Testing Reasoner Provider can make SillyTavern feel frozen.

The Test Provider button calls `runtime.testProvider(lane)` directly and does not set an immediate visible lane-local busy state:

```js
const providerTest = control('recursionProviderTest');
if (providerTest) {
  consumeClickEvent(event);
  const lane = providerLaneFromDataset(providerTest.dataset);
  runAction(runtime?.testProvider?.(lane), () => {
    settingsPanelRendered = false;
    update();
  }, 'Provider test failed.');
}
```

Runtime sends a real provider call through the selected lane:

```js
const result = await generationRouter.generate('providerTest', {
  runId,
  lane: resolvedLane,
  ...reasoningRequestMetadata({}, 'provider-test'),
  prompt: providerTestPrompt(resolvedLane)
});
```

The test prompt is tiny, but provider routing can still inherit the lane `maxTokens` value. Current provider defaults are `8192`, including Reasoner. OpenAI-compatible requests use `enriched.providerConfig.maxTokens` directly, and SillyTavern host profile generation receives `requestMaxTokens(request)`, which currently falls back to `request.providerConfig?.maxTokens`.

---

## File Structure

- `src/ui.mjs` - preserve provider disclosure state across provider rerenders and add lane-local provider-test busy state.
- `src/runtime.mjs` - add provider-test request constants and send a bounded `responseLength` plus provider-test timeout to the generation router.
- `src/providers.mjs` - honor per-request `responseLength` / `maxTokens` overrides for OpenAI-compatible requests.
- `tools/scripts/test-ui.mjs` - add regression coverage for Reasoner disclosure persistence and provider-test immediate busy feedback.
- `tools/scripts/test-runtime.mjs` - assert runtime provider tests pass a small response budget and timeout metadata to the router.
- `tools/scripts/test-providers.mjs` - assert OpenAI-compatible provider calls honor per-request max-token overrides.
- `docs/user/PROVIDER_SETUP.md` - clarify that Provider Test sends a small structured test call and shows in-progress state.
- `docs/design/UI_SPEC.md` - record that provider-test busy feedback stays inside the compact provider action row.
- `docs/testing/LIVE_SMOKE_TEST_PLAN.md` - add a live Providers check for disclosure persistence and Reasoner test responsiveness.

---

## Contracts

Provider section open state:

```js
const providerDisclosureState = {
  utility: null,
  reasoner: null
};
```

`null` means "use the provider's default-open rule." A boolean means "use the user's latest disclosure choice until the settings panel is destroyed."

Provider test action state:

```js
const providerTestState = {
  utility: { running: false },
  reasoner: { running: false }
};
```

The Test Provider button during a running test:

```html
<button
  class="recursion-button"
  type="button"
  aria-label="Testing Reasoner Provider"
  aria-busy="true"
  disabled
  data-recursion-provider-test
  data-recursion-provider-lane="reasoner">
  Testing...
</button>
```

Provider test request budget:

```js
const PROVIDER_TEST_RESPONSE_TOKENS = 256;
const PROVIDER_TEST_TIMEOUT_MS = 30000;
```

Runtime call shape:

```js
const result = await generationRouter.generate('providerTest', {
  runId,
  lane: resolvedLane,
  responseLength: PROVIDER_TEST_RESPONSE_TOKENS,
  ...reasoningRequestMetadata({}, 'provider-test'),
  prompt: providerTestPrompt(resolvedLane)
}, {
  timeoutMs: PROVIDER_TEST_TIMEOUT_MS
});
```

---

### Task 1: UI Red Tests For Provider Disclosure And Busy State

**Files:**
- Modify: `tools/scripts/test-ui.mjs`

- [ ] **Step 1: Add a pending provider test gate in the mounted UI harness**

Find the main mounted UI harness near the existing declarations:

```js
const providerUpdates = [];
const providerTests = [];
const providerClears = [];
```

Replace that cluster with:

```js
const providerUpdates = [];
const providerTests = [];
const providerTestGates = [];
const providerClears = [];
```

In the same harness, replace the `testProvider` fake:

```js
testProvider: async (lane) => {
  providerTests.push(lane);
  return { ok: true };
},
```

with:

```js
testProvider: (lane) => {
  providerTests.push(lane);
  const gate = deferred();
  providerTestGates.push({ lane, gate });
  return gate.promise.then(() => ({ ok: true }));
},
```

- [ ] **Step 2: Add the Reasoner disclosure persistence red test**

After the existing assertion:

```js
assertEqual(root.querySelector('[data-recursion-provider-body-reasoner]').hidden, false, 'Reasoner provider section expands');
```

add:

```js
const reasonerSourceBeforeAutosave = root.querySelector('[data-recursion-provider-source-reasoner]');
reasonerSourceBeforeAutosave.value = 'host-connection-profile';
for (const listener of root.querySelector('[data-recursion-settings-panel]').eventListeners.change || []) {
  listener({ target: reasonerSourceBeforeAutosave });
}
await Promise.resolve();
await Promise.resolve();
assertEqual(providerUpdates.at(-1).lane, 'reasoner', 'reasoner provider source autosave targets Reasoner lane');
assertEqual(root.querySelector('[data-recursion-provider-body-reasoner]').hidden, false, 'Reasoner provider section stays expanded after provider autosave rerender');
assertEqual(root.querySelector('[data-recursion-provider-toggle-reasoner]').getAttribute('aria-expanded'), 'true', 'Reasoner provider toggle preserves expanded ARIA state after provider autosave rerender');
```

- [ ] **Step 3: Add the provider-test busy red test**

Replace the current provider-test block:

```js
root.querySelector('[data-recursion-utility-provider-test]').click();
await Promise.resolve();
assertDeepEqual(providerTests, ['utility'], 'utility provider test action calls runtime');
assertEqual(hostGenerationClicks, 0, 'utility provider test consumes its click before host generation handlers can see it');
```

with:

```js
root.querySelector('[data-recursion-utility-provider-test]').click();
await Promise.resolve();
assertDeepEqual(providerTests, ['utility'], 'utility provider test action calls runtime');
assertEqual(hostGenerationClicks, 0, 'utility provider test consumes its click before host generation handlers can see it');
assertEqual(root.querySelector('[data-recursion-utility-provider-test]').disabled, true, 'utility provider test button disables immediately while the test is running');
assertEqual(root.querySelector('[data-recursion-utility-provider-test]').getAttribute('aria-busy'), 'true', 'utility provider test button exposes busy state while the test is running');
assertEqual(root.querySelector('[data-recursion-utility-provider-test]').textContent, 'Testing...', 'utility provider test button uses compact in-progress copy');
providerTestGates[0].gate.resolve();
await Promise.resolve();
await Promise.resolve();
assertEqual(root.querySelector('[data-recursion-utility-provider-test]').disabled, false, 'utility provider test button re-enables after the test settles');
assertEqual(root.querySelector('[data-recursion-utility-provider-test]').getAttribute('aria-busy'), 'false', 'utility provider test button clears busy state after the test settles');
assertEqual(root.querySelector('[data-recursion-utility-provider-test]').textContent, 'Test Provider', 'utility provider test button restores normal copy after the test settles');
```

- [ ] **Step 4: Run the red UI test**

Run:

```powershell
npm.cmd run test:ui
```

Expected: FAIL on the new disclosure persistence and busy-state assertions.

---

### Task 2: Implement Provider Disclosure Persistence And Busy Feedback

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`

- [ ] **Step 1: Add provider default-open and option helpers**

In `src/ui.mjs`, add this helper near `renderProviderHiddenDefaults(...)`:

```js
function defaultProviderSectionOpen(lane, provider = {}) {
  const source = asObject(provider);
  return lane === 'utility'
    || source.openAICompatible?.sessionApiKeyPresent === true
    || Boolean(source.openAICompatible?.model);
}
```

Change the start of `renderProviderSettings(...)` from:

```js
function renderProviderSettings(panel, lane, provider, tooltipsEnabled = true, options = {}) {
  const source = asObject(provider);
  const fetchState = asObject(asObject(options).modelFetchState);
  const connectionProfiles = Array.isArray(options.connectionProfiles) ? options.connectionProfiles : null;
  const readinessOptions = connectionProfiles ? { profiles: connectionProfiles } : {};
  const title = lane === 'reasoner' ? 'Reasoner Provider' : 'Utility Provider';
  const statusText = lane === 'reasoner' && source.enabled !== true
    ? 'optional'
    : providerStatusText(source).toLowerCase();
  const open = lane === 'utility' || source.openAICompatible?.sessionApiKeyPresent === true || Boolean(source.openAICompatible?.model);
```

to:

```js
function renderProviderSettings(panel, lane, provider, tooltipsEnabled = true, options = {}) {
  const source = asObject(provider);
  const renderOptions = asObject(options);
  const fetchState = asObject(renderOptions.modelFetchState);
  const connectionProfiles = Array.isArray(renderOptions.connectionProfiles) ? renderOptions.connectionProfiles : null;
  const readinessOptions = connectionProfiles ? { profiles: connectionProfiles } : {};
  const testState = asObject(renderOptions.testState);
  const title = lane === 'reasoner' ? 'Reasoner Provider' : 'Utility Provider';
  const statusText = lane === 'reasoner' && source.enabled !== true
    ? 'optional'
    : providerStatusText(source).toLowerCase();
  const open = typeof renderOptions.open === 'boolean'
    ? renderOptions.open
    : defaultProviderSectionOpen(lane, source);
```

- [ ] **Step 2: Render lane-local provider test busy state**

In `renderProviderSettings(...)`, replace the Test Provider button block:

```js
el('button', {
  className: 'recursion-button',
  text: 'Test Provider',
  attrs: {
    type: 'button',
    'aria-label': `Test ${title}`,
    ...tooltipAttrs(tooltipsEnabled, SETTINGS_TOOLTIPS.providerTest)
  },
  dataset: {
    recursionProviderTest: '',
    [`recursion${titleCase(lane)}ProviderTest`]: '',
    recursionProviderLane: lane
  }
}),
```

with:

```js
el('button', {
  className: 'recursion-button',
  text: testState.running ? 'Testing...' : 'Test Provider',
  attrs: {
    type: 'button',
    'aria-label': testState.running ? `Testing ${title}` : `Test ${title}`,
    'aria-busy': testState.running ? 'true' : 'false',
    ...(testState.running ? { disabled: 'disabled' } : {}),
    ...tooltipAttrs(tooltipsEnabled, SETTINGS_TOOLTIPS.providerTest)
  },
  dataset: {
    recursionProviderTest: '',
    [`recursion${titleCase(lane)}ProviderTest`]: '',
    recursionProviderLane: lane
  }
}),
```

- [ ] **Step 3: Pass disclosure and test state into provider rendering**

In `mountRecursionUi(...)`, after the existing `providerModelFetchState` initialization, add:

```js
  const providerDisclosureState = {
    utility: null,
    reasoner: null
  };
  const providerTestState = {
    utility: { running: false },
    reasoner: { running: false }
  };
```

Change the `renderSettingsPanel(...)` signature from:

```js
function renderSettingsPanel(panel, view, activeTab = 'play', runtime = null, providerModelFetchState = {}) {
```

to:

```js
function renderSettingsPanel(panel, view, activeTab = 'play', runtime = null, providerModelFetchState = {}, providerUiState = {}) {
```

Inside `renderSettingsPanel(...)`, before the `renderProviderSettings(...)` calls, add:

```js
  const disclosureState = asObject(providerUiState.disclosureState);
  const testState = asObject(providerUiState.testState);
```

Change the Utility call to:

```js
  renderProviderSettings(providersPane, 'utility', settings.providers?.utility || {}, tooltipsEnabled, {
    modelFetchState: providerModelFetchState.utility,
    connectionProfiles,
    open: typeof disclosureState.utility === 'boolean' ? disclosureState.utility : undefined,
    testState: asObject(testState.utility)
  });
```

Change the Reasoner call to:

```js
  renderProviderSettings(providersPane, 'reasoner', settings.providers?.reasoner || {}, tooltipsEnabled, {
    modelFetchState: providerModelFetchState.reasoner,
    connectionProfiles,
    open: typeof disclosureState.reasoner === 'boolean' ? disclosureState.reasoner : undefined,
    testState: asObject(testState.reasoner)
  });
```

Change both `renderSettingsPanel(settingsPanel, view, settingsTab, runtime, providerModelFetchState)` calls in `mountRecursionUi(...)` to:

```js
renderSettingsPanel(settingsPanel, view, settingsTab, runtime, providerModelFetchState, {
  disclosureState: providerDisclosureState,
  testState: providerTestState
});
```

- [ ] **Step 4: Persist user disclosure choices during toggle clicks**

In the provider disclosure click handler, replace:

```js
const providerDisclosure = control('recursionProviderToggle');
if (providerDisclosure) {
  const lane = providerLaneFromDataset(providerDisclosure.dataset);
  const body = root.querySelector(`[data-recursion-provider-body-${lane}]`);
  const section = closestDatasetElement(providerDisclosure, 'recursionProviderSection', root);
  setDisclosureOpen(providerDisclosure, body, section, body?.hidden === true);
}
```

with:

```js
const providerDisclosure = control('recursionProviderToggle');
if (providerDisclosure) {
  const lane = providerLaneFromDataset(providerDisclosure.dataset);
  const body = root.querySelector(`[data-recursion-provider-body-${lane}]`);
  const section = closestDatasetElement(providerDisclosure, 'recursionProviderSection', root);
  const nextOpen = body?.hidden === true;
  providerDisclosureState[lane] = nextOpen;
  setDisclosureOpen(providerDisclosure, body, section, nextOpen);
}
```

- [ ] **Step 5: Update provider-test click handling**

Replace the provider-test click handler:

```js
const providerTest = control('recursionProviderTest');
if (providerTest) {
  consumeClickEvent(event);
  const lane = providerLaneFromDataset(providerTest.dataset);
  runAction(runtime?.testProvider?.(lane), () => {
    settingsPanelRendered = false;
    update();
  }, 'Provider test failed.');
}
```

with:

```js
const providerTest = control('recursionProviderTest');
if (providerTest) {
  consumeClickEvent(event);
  const lane = providerLaneFromDataset(providerTest.dataset);
  if (providerTestState[lane]?.running) return;
  providerTestState[lane] = { running: true };
  settingsPanelRendered = false;
  update();
  runAction(Promise.resolve(runtime?.testProvider?.(lane)).finally(() => {
    providerTestState[lane] = { running: false };
  }), () => {
    settingsPanelRendered = false;
    update();
  }, 'Provider test failed.');
}
```

- [ ] **Step 6: Add compact busy styling**

In `styles/recursion.css`, after the existing disabled button rule:

```css
.recursion-root .recursion-button:disabled,
.recursion-root .recursion-button[disabled] {
  cursor: not-allowed;
  opacity: .45;
}
```

add:

```css
.recursion-root .recursion-button[aria-busy="true"] {
  color: color-mix(in srgb, var(--recursion-accent) 78%, var(--SmartThemeBodyColor, #e0e0e0)) !important;
  opacity: .72;
}
```

- [ ] **Step 7: Run the UI test**

Run:

```powershell
npm.cmd run test:ui
```

Expected: PASS.

---

### Task 3: Runtime And Provider Red Tests For Bounded Provider Test Calls

**Files:**
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-providers.mjs`

- [ ] **Step 1: Capture runtime provider-test options**

In `tools/scripts/test-runtime.mjs`, find the provider settings/runtime view test near `const routerCalls = [];`. Replace:

```js
generationRouter: {
  async generate(roleId, request) {
    routerCalls.push({ roleId, request });
    return {
      ok: true,
      diagnostics: { providerId: 'host-current-model', model: 'utility-test-model' },
      data: { schema: 'recursion.providerTest.v1', ok: true }
    };
  }
}
```

with:

```js
generationRouter: {
  async generate(roleId, request, options = {}) {
    routerCalls.push({ roleId, request, options });
    return {
      ok: true,
      diagnostics: { providerId: 'host-current-model', model: 'utility-test-model' },
      data: { schema: 'recursion.providerTest.v1', ok: true }
    };
  }
}
```

- [ ] **Step 2: Add provider-test budget assertions**

After:

```js
assertEqual(routerCalls[0].request.reasoningIntent, 'minimal', 'runtime provider test always uses minimal provider reasoning');
```

add:

```js
assertEqual(routerCalls[0].request.responseLength, 256, 'runtime provider test uses a small response token cap');
assertEqual(routerCalls[0].options.timeoutMs, 30000, 'runtime provider test uses a shorter provider-test timeout');
```

- [ ] **Step 3: Add OpenAI-compatible request override coverage**

In `tools/scripts/test-providers.mjs`, after:

```js
assertEqual(fetchCalls[0].body.max_tokens, 321, 'configured max tokens sent');
```

add:

```js
fetchCalls.length = 0;
const openAiProviderTestResult = await openAiRouter.generate('providerTest', {
  prompt: 'OpenAI provider test',
  responseLength: 256
});
assertEqual(openAiProviderTestResult.ok, true, 'openai-compatible provider test route succeeds');
assertEqual(fetchCalls[0].body.max_tokens, 256, 'openai-compatible provider test honors per-request responseLength over configured max tokens');
assertEqual(fetchCalls[0].body.response_format.json_schema.schema.properties.schema.const, 'recursion.providerTest.v1', 'openai-compatible provider test uses the providerTest JSON schema');
```

- [ ] **Step 4: Run the red provider tests**

Run:

```powershell
npm.cmd run test:runtime
npm.cmd run test:providers
```

Expected: `test:runtime` fails because runtime does not yet pass `responseLength` or provider-test timeout. `test:providers` fails because OpenAI-compatible generation still uses `providerConfig.maxTokens`.

---

### Task 4: Implement Bounded Provider Test Calls

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `src/providers.mjs`

- [ ] **Step 1: Add runtime provider-test constants**

In `src/runtime.mjs`, near:

```js
const PROVIDER_TEST_SCHEMA = 'recursion.providerTest.v1';
```

add:

```js
const PROVIDER_TEST_RESPONSE_TOKENS = 256;
const PROVIDER_TEST_TIMEOUT_MS = 30000;
```

- [ ] **Step 2: Pass the bounded request through runtime**

In `testProvider(...)`, replace:

```js
const result = await generationRouter.generate('providerTest', {
  runId,
  lane: resolvedLane,
  ...reasoningRequestMetadata({}, 'provider-test'),
  prompt: providerTestPrompt(resolvedLane)
});
```

with:

```js
const result = await generationRouter.generate('providerTest', {
  runId,
  lane: resolvedLane,
  responseLength: PROVIDER_TEST_RESPONSE_TOKENS,
  ...reasoningRequestMetadata({}, 'provider-test'),
  prompt: providerTestPrompt(resolvedLane)
}, {
  timeoutMs: PROVIDER_TEST_TIMEOUT_MS
});
```

- [ ] **Step 3: Add a provider request-token helper**

In `src/providers.mjs`, add this helper near `providerVisibleText(...)`:

```js
function providerRequestMaxTokens(enriched = {}) {
  const explicit = Number(enriched.responseLength ?? enriched.maxTokens);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  const configured = Number(enriched.providerConfig?.maxTokens);
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : configured;
}
```

Change `providerVisibleText(...)` from:

```js
maxTokens: enriched.providerConfig?.maxTokens
```

to:

```js
maxTokens: providerRequestMaxTokens(enriched)
```

Change the OpenAI-compatible body builder from:

```js
max_tokens: enriched.providerConfig.maxTokens,
```

to:

```js
max_tokens: providerRequestMaxTokens(enriched),
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm.cmd run test:runtime
npm.cmd run test:providers
```

Expected: PASS.

---

### Task 5: Documentation And Live-Proof Hooks

**Files:**
- Modify: `docs/user/PROVIDER_SETUP.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md`

- [ ] **Step 1: Update provider setup docs**

In `docs/user/PROVIDER_SETUP.md`, find the provider test description. Replace the paragraph with:

```markdown
Use **Test Provider** after changing a lane source, profile, endpoint, model, session key, or token cap. The test sends a small structured JSON call through that lane, shows `Testing...` on the lane button while it is running, and records pass/fail status without storing prompts, raw responses, or API keys. A passing test confirms routing and structured output for Recursion calls; it is not a story-generation benchmark.
```

- [ ] **Step 2: Update UI spec provider-control contract**

In `docs/design/UI_SPEC.md`, in the Provider Controls section, add this bullet after `Provider lane controls autosave...`:

```markdown
Provider disclosure state is user-local UI state. If a user expands Reasoner Provider and then changes Source, Profile, endpoint, model, max tokens, or runs Test Provider, the Reasoner disclosure stays open across the resulting Settings rerender. The lane only returns to its default collapsed state after the Settings panel is closed and reopened.
```

Add this bullet after `Provider lane controls autosave...` or immediately below the new disclosure bullet:

```markdown
Test Provider shows lane-local in-progress feedback by disabling only the clicked lane's Test Provider button and changing its compact copy to `Testing...`. It must not open a modal, create decorative progress UI, or block the rest of the Settings panel from scrolling.
```

- [ ] **Step 3: Update live smoke test plan**

In `docs/testing/LIVE_SMOKE_TEST_PLAN.md`, add this checklist item under the provider/settings smoke scenarios:

```markdown
- Providers responsiveness: open Settings -> Providers, expand Reasoner Provider, change a Reasoner provider field that autosaves, and verify the Reasoner disclosure stays expanded. Click Reasoner Test Provider and verify the button changes to `Testing...` immediately, only that lane's test button is disabled, the SillyTavern page remains scrollable, and the final pass/fail status appears without exposing secrets or raw provider output.
```

- [ ] **Step 4: Run docs and focused UI gates**

Run:

```powershell
npm.cmd run test:ui
npm.cmd run test:runtime
npm.cmd run test:providers
npm.cmd run check:docs
git diff --check
```

Expected: PASS. If `check:docs` is not defined in `package.json`, run the repo's existing docs gate scripts listed in `docs/testing/TESTING_STRATEGY.md` and record the exact commands in the implementation closeout.

---

### Task 6: Served SillyTavern Verification

**Files:**
- Modify or create a focused Playwright harness only if the existing live harness does not already cover Settings -> Providers interactions.

- [ ] **Step 1: Sync or verify the served extension copy**

Before live proof, verify the served file that SillyTavern is using includes the same `src/ui.mjs`, `src/runtime.mjs`, and `src/providers.mjs` changes from this branch.

Run the repo's existing served-copy verification command if present. If there is no command for this exact path, compare hashes for:

```text
F:\git\Recursion\src\ui.mjs
F:\git\Recursion\src\runtime.mjs
F:\git\Recursion\src\providers.mjs
F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion\src\ui.mjs
F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion\src\runtime.mjs
F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion\src\providers.mjs
```

- [ ] **Step 2: Run the exact manual live proof or automated equivalent**

Use a dedicated `recursion-soak-*` SillyTavern user. The proof sequence is:

```text
1. Open SillyTavern with the served Recursion extension active.
2. Open Recursion Settings.
3. Switch to Providers.
4. Expand Reasoner Provider.
5. Change a Reasoner field that autosaves, such as Source.
6. Assert Reasoner Provider remains expanded.
7. Click Reasoner Test Provider.
8. Assert the clicked button changes to Testing... before the provider call settles.
9. Assert only the Reasoner test button is disabled.
10. Assert the Settings panel still scrolls and the page does not become unresponsive while the provider call is in flight.
11. Assert the final status is pass or fail without raw provider output, stack traces, or secrets.
```

- [ ] **Step 3: Record live evidence**

Record these facts in the implementation closeout:

```text
served-extension-match: true
reasoner-disclosure-after-autosave: expanded
reasoner-test-busy-visible-before-settle: true
reasoner-test-disabled-lane-only: true
provider-test-request-cap: 256
provider-test-timeout-ms: 30000
secret-leak-check: passed
```

---

## Verification Summary

Focused deterministic gates:

```powershell
npm.cmd run test:ui
npm.cmd run test:runtime
npm.cmd run test:providers
```

Broader closeout gates:

```powershell
npm.cmd test
npm.cmd run test:alpha
git diff --check
```

Live proof is required before calling the visible SillyTavern responsiveness issue complete.

---

## Self-Review

Spec coverage:

- Reasoner Provider no longer auto-collapses after provider autosave: Task 1 and Task 2.
- Provider Test no longer appears frozen without local feedback: Task 1 and Task 2.
- Provider Test avoids full lane response cap: Task 3 and Task 4.
- Design stays compact and SillyTavern-native: Task 2 and Task 5.
- Live served-copy behavior is verified: Task 6.

Placeholder scan:

- The plan contains no placeholder keywords, no unresolved file paths, and no unnamed tests.

Type consistency:

- `providerDisclosureState`, `providerTestState`, `PROVIDER_TEST_RESPONSE_TOKENS`, `PROVIDER_TEST_TIMEOUT_MS`, and `providerRequestMaxTokens(...)` are named consistently across tests and implementation steps.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-05-recursion-provider-settings-responsiveness.md`. Two execution options:

**1. Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
