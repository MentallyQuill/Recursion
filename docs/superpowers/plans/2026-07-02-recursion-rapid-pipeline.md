# Recursion Rapid Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Rapid pipeline that warms provider-generated scene guidance in the background, then uses one foreground Utility delta or fast-start provider call on send.

**Architecture:** Keep Standard as the existing foreground reference pipeline. Add `pipelineMode`, Rapid provider schemas, a pure Rapid helper module, background warm artifacts in scene cache variants, foreground Rapid orchestration in runtime, and a compact bar pipeline selector. Rapid preserves quality by using provider-generated artifacts only and never creating local fallback cards or deterministic local briefs.

**Tech Stack:** JavaScript ES modules, Recursion SillyTavern extension runtime, existing provider/router/storage/activity modules, markdown docs, Node script tests, `npm.cmd` test runner on Windows PowerShell.

---

## Scope Check

This is one feature with two cooperating paths:

- background warm path;
- foreground Rapid send path.

The work is broad but not independent enough to split into separate implementation plans because both paths share settings, schemas, cache keys, provider roles, source freshness, progress, and UI state.

Before execution, run:

```powershell
git status --short
```

Expected: record the current dirty files and avoid reverting unrelated work. The current shared worktree may already contain unrelated edits in provider or host files.

---

## File Structure

- Create `src/rapid-pipeline.mjs`: pure Rapid schemas, cache key helpers, prompt builders, output normalizers, warm artifact validation, prompt packet assembly inputs, and hedge result selection helpers.
- Modify `src/settings.mjs`: add `pipelineMode` default and normalization.
- Modify `src/providers.mjs`: add `rapidTurnDelta` and `rapidFastStartPack` roles and response schema ids.
- Modify `src/runtime.mjs`: add Rapid background warm scheduling, foreground Rapid branch, Standard escalation, cache writes, source invalidation, and view model fields.
- Modify `src/storage.mjs`: normalize and persist `variant.rapid` metadata without legacy shims.
- Modify `src/progress.mjs`: add Rapid progress phases and labels.
- Modify `src/ui.mjs`: render the compact Standard/Rapid pipeline selector button, dropdown rows, and setting update dispatch.
- Modify `styles/recursion.css`: style the pipeline selector and dropdown as compact graphite SillyTavern-native chrome.
- Create `tools/scripts/test-rapid-pipeline.mjs`: pure unit tests for Rapid helpers.
- Modify `tools/scripts/test-settings.mjs`: settings normalization coverage.
- Modify `tools/scripts/test-providers.mjs`: provider role/schema coverage.
- Modify `tools/scripts/test-storage.mjs`: scene cache `rapid` metadata normalization and redaction.
- Modify `tools/scripts/test-runtime.mjs`: background warm, foreground delta, fast-start, mandatory escalation, source invalidation, and no-local-fallback coverage.
- Modify `tools/scripts/test-progress.mjs`: Rapid progress view model coverage.
- Modify `tools/scripts/test-ui.mjs`: bar pipeline selector dropdown coverage.
- Modify `tools/scripts/run-tests.mjs`: include `test-rapid-pipeline.mjs`.
- Modify docs: `docs/design/UI_SPEC.md`, `docs/technical/RUNTIME_TURN_SEQUENCE.md`, `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`, `docs/technical/CARD_DECK_AND_HAND.md`, `docs/architecture/RUNTIME_ARCHITECTURE.md`, `docs/user/RECURSION_OPERATOR_MANUAL.md`, and `docs/testing/TESTING_STRATEGY.md`.

---

### Task 1: Add Pipeline Setting And UI Contract Tests

**Files:**
- Modify: `src/settings.mjs`
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-settings.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `docs/design/UI_SPEC.md`

- [ ] **Step 1: Write failing settings tests**

Add these assertions to `tools/scripts/test-settings.mjs` near mode/reasoning settings coverage:

```js
assertEqual(normalizeSettings({}).pipelineMode, 'standard', 'pipeline mode defaults to Standard');
assertEqual(normalizeSettings({ pipelineMode: 'rapid' }).pipelineMode, 'rapid', 'Rapid pipeline mode is accepted');
assertEqual(normalizeSettings({ pipelineMode: 'standard' }).pipelineMode, 'standard', 'Standard pipeline mode is accepted');
assertEqual(normalizeSettings({ pipelineMode: 'fast' }).pipelineMode, 'standard', 'invalid pipeline mode normalizes to Standard');
assertEqual(normalizeSettings({ mode: 'manual', pipelineMode: 'rapid' }).mode, 'manual', 'Rapid does not replace Auto/Manual mode');
```

- [ ] **Step 2: Write failing UI tests**

In `tools/scripts/test-ui.mjs`, after the existing compact bar control assertions, add:

```js
const pipelineButton = root.querySelector('[data-recursion-pipeline-button]');
assert(pipelineButton, 'bar renders pipeline selector button');
assertEqual(pipelineButton.getAttribute('aria-expanded'), 'false', 'pipeline selector starts closed');
const leftControls = [
  root.querySelector('[data-recursion-power-toggle]'),
  root.querySelector('[data-recursion-pipeline-button]'),
  root.querySelector('[data-recursion-mode-button]'),
  root.querySelector('[data-recursion-cards-button]')
].filter(Boolean);
assertDeepEqual(
  leftControls.map((node) => Object.keys(node.dataset).find((key) => key.startsWith('recursion') && key.endsWith('Button')) || Object.keys(node.dataset)[0]),
  ['recursionPowerToggle', 'recursionPipelineButton', 'recursionModeButton', 'recursionCardsButton'],
  'left bar controls render Power, Pipeline, Mode, Cards in order'
);
assert(
  pipelineButton.getAttribute('title').includes('Standard Pipeline'),
  'Standard pipeline tooltip explains current pipeline'
);

pipelineButton.dispatchEvent(new fakeWindow.Event('click', { bubbles: true }));
const pipelineMenu = root.querySelector('[data-recursion-pipeline-menu]');
assertEqual(pipelineMenu.hidden, false, 'pipeline click opens pipeline dropdown');
assert(root.querySelector('[data-recursion-pipeline-choice-standard]'), 'pipeline dropdown has Standard row');
assert(root.querySelector('[data-recursion-pipeline-choice-rapid]'), 'pipeline dropdown has Rapid row');
assert(
  root.querySelector('[data-recursion-pipeline-choice-standard]').textContent.includes('Standard'),
  'Standard row has visible short name'
);
assert(
  root.querySelector('[data-recursion-pipeline-choice-rapid]').textContent.includes('Rapid'),
  'Rapid row has visible short name'
);

await ui.update({
  ...view,
  settings: { ...view.settings, pipelineMode: 'rapid' }
});

const rapidPipelineButton = root.querySelector('[data-recursion-pipeline-button]');
assert(
  rapidPipelineButton.getAttribute('title').includes('Rapid Pipeline'),
  'Rapid pipeline tooltip explains current pipeline'
);
```

Add a click assertion where UI action dispatches are tested:

```js
pipelineButton.dispatchEvent(new fakeWindow.Event('click', { bubbles: true }));
root.querySelector('[data-recursion-pipeline-choice-rapid]').dispatchEvent(new fakeWindow.Event('click', { bubbles: true }));
assert(
  runtimeActions.some((action) => action.type === 'updateSettings' && action.patch.pipelineMode === 'rapid'),
  'pipeline dropdown switches Standard to Rapid'
);
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
node tools/scripts/test-settings.mjs
node tools/scripts/test-ui.mjs
```

Expected: both fail because `pipelineMode` and the pipeline selector do not exist.

- [ ] **Step 4: Add setting normalization**

In `src/settings.mjs`, add:

```js
const PIPELINE_MODES = new Set(['standard', 'rapid']);
```

Add to `DEFAULT_RECURSION_SETTINGS`:

```js
pipelineMode: 'standard',
```

Add inside `normalizeSettings(source = {})`:

```js
pipelineMode: enumValue(source.pipelineMode, PIPELINE_MODES, DEFAULT_RECURSION_SETTINGS.pipelineMode),
```

- [ ] **Step 5: Render pipeline selector**

In `src/ui.mjs`, add helpers near `modeLabel()`:

```js
function pipelineMode(value) {
  return cleanText(value, 'standard').toLowerCase() === 'rapid' ? 'rapid' : 'standard';
}

function pipelineLabel(value) {
  return pipelineMode(value) === 'rapid' ? 'Rapid Pipeline' : 'Standard Pipeline';
}

function pipelineTooltip(value) {
  return pipelineMode(value) === 'rapid'
    ? 'Rapid Pipeline: warm provider-generated scene guidance in the background and use a short provider delta on send.'
    : 'Standard Pipeline: run full Arbiter, card, compose, and install work on send.';
}
```

Add pipeline icon branches near the existing mode icons:

```js
if (kind === 'pipeline-standard') {
  return el('svg', { attrs: { width: '17', height: '17', viewBox: '0 0 17 17', 'aria-hidden': 'true' } }, [
    el('path', { attrs: { d: 'M3 4.2h7.8M10.8 4.2 8.9 2.5M10.8 4.2 8.9 5.9M3 8.5h10.8M13.8 8.5 11.9 6.8M13.8 8.5l-1.9 1.7M3 12.8h7.8M10.8 12.8l-1.9-1.7M10.8 12.8l-1.9 1.7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } })
  ]);
}

if (kind === 'pipeline-rapid') {
  return el('svg', { attrs: { width: '17', height: '17', viewBox: '0 0 17 17', 'aria-hidden': 'true' } }, [
    el('path', { attrs: { d: 'M9.4 1.8 4.6 8.9h3.2l-1.2 6.3 5.8-8h-3.3l.3-5.4Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linejoin': 'round' } })
  ]);
}
```

Add a selector choice helper:

```js
const PIPELINE_MENU_OPTIONS = Object.freeze([
  {
    value: 'standard',
    label: 'Standard',
    icon: 'pipeline-standard',
    tip: 'Run full Arbiter, card, compose, and install work on send.'
  },
  {
    value: 'rapid',
    label: 'Rapid',
    icon: 'pipeline-rapid',
    tip: 'Warm provider-generated scene guidance in the background and use a short provider delta on send.'
  }
]);

function pipelineMenuChoice(option) {
  return el('button', {
    className: 'recursion-pipeline-choice',
    attrs: {
      type: 'button',
      title: option.tip
    },
    dataset: {
      recursionPipelineChoice: option.value,
      [`recursionPipelineChoice${option.value[0].toUpperCase()}${option.value.slice(1)}`]: ''
    }
  }, [
    el('span', { className: 'recursion-pipeline-choice-icon', attrs: { 'aria-hidden': 'true' } }, [modeIconSvg(option.icon)]),
    el('span', { className: 'recursion-pipeline-choice-copy' }, [
      el('span', { className: 'recursion-pipeline-choice-name', text: option.label }),
      el('span', { className: 'recursion-pipeline-choice-tip', text: option.tip })
    ])
  ]);
}
```

In the compact bar markup, insert the Pipeline cluster immediately after Power and before Mode:

```js
el('div', { className: 'recursion-pipeline-cluster' }, [
  el('button', {
    className: 'recursion-pipeline-button',
    attrs: {
      type: 'button',
      'aria-label': 'Pipeline: Standard Pipeline',
      'aria-expanded': 'false'
    },
    dataset: { recursionPipelineButton: '' }
  }, [
    el('span', { className: 'recursion-pipeline-icon', attrs: { 'aria-hidden': 'true' }, dataset: { recursionPipelineIcon: '' } }, [
      modeIconSvg('pipeline-standard')
    ])
  ]),
  el('div', {
    className: 'recursion-pipeline-menu',
    attrs: { 'aria-label': 'Recursion pipeline selector' },
    dataset: { recursionPipelineMenu: '' }
  }, PIPELINE_MENU_OPTIONS.map(pipelineMenuChoice))
])
```

In `update()`, sync the control:

```js
const pipeline = pipelineMode(model.settings?.pipelineMode);
const pipelineButton = root.querySelector('[data-recursion-pipeline-button]');
if (pipelineButton) {
  const tip = pipelineTooltip(pipeline);
  pipelineButton.setAttribute('aria-label', `Pipeline: ${pipelineLabel(pipeline)}`);
  setTooltip(pipelineButton, model.tooltipsEnabled, tip);
  renderModeIcon(root.querySelector('[data-recursion-pipeline-icon]'), pipeline === 'rapid' ? 'pipeline-rapid' : 'pipeline-standard');
}
for (const choice of root.querySelectorAll('[data-recursion-pipeline-choice]')) {
  const selected = choice.dataset.recursionPipelineChoice === pipeline;
  choice.className = selected ? 'recursion-pipeline-choice is-selected' : 'recursion-pipeline-choice';
}
```

In event wiring, add:

```js
const pipelineButton = root.querySelector('[data-recursion-pipeline-button]');
const pipelineMenu = root.querySelector('[data-recursion-pipeline-menu]');

function setPipelineMenuOpen(open) {
  if (!pipelineMenu) return;
  pipelineMenu.hidden = !open;
  pipelineButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

pipelineButton?.addEventListener('click', () => {
  setPipelineMenuOpen(pipelineMenu?.hidden !== false);
});

pipelineMenu?.addEventListener('click', (event) => {
  const choice = closestDatasetElement(event?.target, 'recursionPipelineChoice', pipelineMenu);
  if (!choice) return;
  runAction(runtime?.updateSettings?.({ pipelineMode: choice.dataset.recursionPipelineChoice }));
  setPipelineMenuOpen(false);
});
```

- [ ] **Step 6: Style the selector**

In `styles/recursion.css`, include the new classes wherever compact icon buttons and menu choices share sizing:

```css
.recursion-pipeline-cluster {
  position: relative;
}

.recursion-pipeline-button {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
}

.recursion-pipeline-button:hover,
.recursion-pipeline-button:focus-visible {
  background: rgba(255, 255, 255, .06);
  outline: none;
}

.recursion-pipeline-menu {
  position: absolute;
  top: 28px;
  left: 6px;
  width: 238px;
  z-index: 85;
  border: 1px solid var(--SmartThemeBorderColor);
  border-radius: 0 0 8px 8px;
  background: var(--SmartThemeBlurTintColor);
  box-shadow: 0 18px 38px rgba(0, 0, 0, .40);
}

.recursion-pipeline-choice {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 7px 9px;
  border: 0;
  border-top: 1px solid rgba(255, 255, 255, .055);
  background: transparent;
  color: inherit;
  text-align: left;
}
```

- [ ] **Step 7: Update UI spec**

In `docs/design/UI_SPEC.md`, add this under the Recursion Bar controls:

```markdown
Pipeline is a separate compact control from Auto/Manual mode. It lives immediately to the left of the Mode button and uses a Mode-like icon button plus dropdown, not a Settings control. The selected icon represents the active pipeline: Standard uses a compact full-route/workflow icon, Rapid uses a compact lightning/fast-lane icon. Clicking the Pipeline icon opens a compact Standard/Rapid menu with icon, short name, and hover/focus tip rows. Standard runs the full foreground Arbiter, card, compose, and install path on send. Rapid warms provider-generated scene guidance in the background and uses a short provider turn-delta or fast-start pack on send.
```

- [ ] **Step 8: Verify and commit**

Run:

```powershell
node tools/scripts/test-settings.mjs
node tools/scripts/test-ui.mjs
```

Expected: both pass.

Commit:

```powershell
git add src/settings.mjs src/ui.mjs styles/recursion.css tools/scripts/test-settings.mjs tools/scripts/test-ui.mjs docs/design/UI_SPEC.md
git commit -m "feat: add rapid pipeline selector"
```

---

### Task 2: Add Rapid Provider Roles And Pure Helper Tests

**Files:**
- Create: `src/rapid-pipeline.mjs`
- Create: `tools/scripts/test-rapid-pipeline.mjs`
- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `tools/scripts/run-tests.mjs`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`

- [ ] **Step 1: Write failing provider role tests**

In `tools/scripts/test-providers.mjs`, add role coverage:

```js
assert(UTILITY_ROLE_IDS.includes('rapidTurnDelta'), 'Utility roles include rapidTurnDelta');
assert(UTILITY_ROLE_IDS.includes('rapidFastStartPack'), 'Utility roles include rapidFastStartPack');
assertEqual(expectedResponseSchema('rapidTurnDelta'), 'recursion.rapidTurnDelta.v1', 'rapidTurnDelta schema is registered');
assertEqual(expectedResponseSchema('rapidFastStartPack'), 'recursion.rapidFastStartPack.v1', 'rapidFastStartPack schema is registered');
```

- [ ] **Step 2: Create failing Rapid helper tests**

Create `tools/scripts/test-rapid-pipeline.mjs`:

```js
import {
  RAPID_FAST_START_SCHEMA,
  RAPID_PIPELINE_VERSION,
  RAPID_TURN_DELTA_SCHEMA,
  buildRapidFastStartPrompt,
  buildRapidTurnDeltaPrompt,
  normalizeRapidFastStartPack,
  normalizeRapidTurnDelta,
  rapidCacheKey,
  rapidWarmArtifactIsUsable
} from '../../src/rapid-pipeline.mjs';
import { assert, assertDeepEqual, assertEqual } from './helpers/assert.mjs';

const snapshot = {
  chatKey: 'rapid-chat',
  sceneKey: 'rapid-scene',
  sourceRevisionHash: 'turn-source',
  turnFingerprint: 'turn-fingerprint',
  latestMesId: 42,
  messages: [{ mesid: 42, role: 'user', text: 'Open the sealed hatch.', visible: true }]
};

const warmArtifact = {
  pipelineVersion: RAPID_PIPELINE_VERSION,
  status: 'ready',
  warmArtifactId: 'rapid-warm-1',
  baseSourceRevisionHash: 'base-source',
  conditionedSceneBrief: 'The sealed hatch blocks the corridor.',
  candidateCardIds: ['card-scene', 'card-constraints'],
  cardIds: ['card-scene', 'card-constraints'],
  settingsHash: 'settings-hash',
  providerContractHash: 'provider-hash',
  cardCatalogHash: 'catalog-hash',
  promptContractHash: 'prompt-hash'
};

assertEqual(RAPID_TURN_DELTA_SCHEMA, 'recursion.rapidTurnDelta.v1', 'rapid turn delta schema id is stable');
assertEqual(RAPID_FAST_START_SCHEMA, 'recursion.rapidFastStartPack.v1', 'rapid fast-start schema id is stable');
assertEqual(
  rapidCacheKey({ chatKey: 'rapid-chat', sceneKey: 'rapid-scene', sourceRevisionHash: 'base-source' }),
  'rapid-chat::rapid-scene::base-source',
  'rapid cache key uses exact source revision'
);

assertEqual(
  rapidWarmArtifactIsUsable(warmArtifact, {
    baseSourceRevisionHash: 'base-source',
    settingsHash: 'settings-hash',
    providerContractHash: 'provider-hash',
    cardCatalogHash: 'catalog-hash',
    promptContractHash: 'prompt-hash'
  }),
  true,
  'matching warm artifact is usable'
);

assertEqual(
  rapidWarmArtifactIsUsable(warmArtifact, {
    baseSourceRevisionHash: 'other-source',
    settingsHash: 'settings-hash',
    providerContractHash: 'provider-hash',
    cardCatalogHash: 'catalog-hash',
    promptContractHash: 'prompt-hash'
  }),
  false,
  'wrong source warm artifact is rejected'
);

const deltaPrompt = buildRapidTurnDeltaPrompt({
  snapshotHash: 'snapshot-hash',
  baseSourceRevisionHash: 'base-source',
  turnSourceRevisionHash: 'turn-source',
  userMessage: 'Open the sealed hatch.',
  warmArtifact,
  candidateCards: [
    { id: 'card-scene', family: 'Scene Frame', summary: 'The sealed hatch blocks the corridor.' },
    { id: 'card-constraints', family: 'Scene Constraints', summary: 'The hatch is sealed until opened.' }
  ]
});
assert(deltaPrompt.includes(RAPID_TURN_DELTA_SCHEMA), 'turn delta prompt names schema');
assert(deltaPrompt.includes('Open the sealed hatch.'), 'turn delta prompt includes user delta');
assert(deltaPrompt.includes('card-constraints'), 'turn delta prompt includes candidate card ids');

const fastStartPrompt = buildRapidFastStartPrompt({
  snapshotHash: 'snapshot-hash',
  turnSourceRevisionHash: 'turn-source',
  snapshot
});
assert(fastStartPrompt.includes(RAPID_FAST_START_SCHEMA), 'fast-start prompt names schema');
assert(fastStartPrompt.includes('No warm deck is available'), 'fast-start prompt states missing warm deck');

const normalizedDelta = normalizeRapidTurnDelta({
  schema: RAPID_TURN_DELTA_SCHEMA,
  snapshotHash: 'snapshot-hash',
  baseSourceRevisionHash: 'base-source',
  turnSourceRevisionHash: 'turn-source',
  selectedCardIds: ['card-constraints', 'unknown-card'],
  turnDeltaBrief: 'The user tests the hatch directly.',
  packetInstructions: ['Keep the hatch constraint visible.'],
  guardrails: ['Do not imply it opens without an action.'],
  backgroundRefreshRequests: [{ family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'Hatch access changed.' }],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: ['rapid-warm-deck']
}, {
  snapshotHash: 'snapshot-hash',
  baseSourceRevisionHash: 'base-source',
  turnSourceRevisionHash: 'turn-source',
  allowedCardIds: ['card-scene', 'card-constraints']
});
assertDeepEqual(normalizedDelta.selectedCardIds, ['card-constraints'], 'delta keeps only known warm card ids');
assertEqual(normalizedDelta.escalateToStandard, false, 'delta does not escalate by default');

const normalizedFastStart = normalizeRapidFastStartPack({
  schema: RAPID_FAST_START_SCHEMA,
  snapshotHash: 'snapshot-hash',
  turnSourceRevisionHash: 'turn-source',
  sceneBrief: 'The sealed hatch blocks the corridor.',
  turnBrief: 'The user tries the hatch.',
  guardrails: ['Keep access constraints intact.'],
  omissions: ['No warm scene deck was ready.'],
  backgroundRefreshRequests: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Warm next turn.' }],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: ['rapid-fast-start']
}, {
  snapshotHash: 'snapshot-hash',
  turnSourceRevisionHash: 'turn-source'
});
assertEqual(normalizedFastStart.sceneBrief.includes('sealed hatch'), true, 'fast-start preserves provider scene brief');

console.log('[pass] rapid-pipeline');
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
node tools/scripts/test-providers.mjs
node tools/scripts/test-rapid-pipeline.mjs
```

Expected: providers fail for missing roles and rapid-pipeline fails because the module does not exist.

- [ ] **Step 4: Implement provider roles**

In `src/providers.mjs`, add role ids to the Utility role list:

```js
'rapidTurnDelta',
'rapidFastStartPack',
```

Add schema ids:

```js
rapidTurnDelta: 'recursion.rapidTurnDelta.v1',
rapidFastStartPack: 'recursion.rapidFastStartPack.v1',
```

Do not add these to `REASONER_ROLE_IDS`.

- [ ] **Step 5: Implement `src/rapid-pipeline.mjs`**

Create `src/rapid-pipeline.mjs`:

```js
import { hashJson } from './core.mjs';

export const RAPID_PIPELINE_VERSION = 1;
export const RAPID_TURN_DELTA_SCHEMA = 'recursion.rapidTurnDelta.v1';
export const RAPID_FAST_START_SCHEMA = 'recursion.rapidFastStartPack.v1';

const TEXT_LIMIT = 1200;
const SHORT_TEXT_LIMIT = 240;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, limit = TEXT_LIMIT) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function cleanList(value, limit = SHORT_TEXT_LIMIT, max = 16) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => cleanText(entry, limit))
    .filter(Boolean)
    .slice(0, max);
}

function cleanRefreshRequests(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = asObject(entry);
      const family = cleanText(source.family, 120);
      const role = cleanText(source.role, 120);
      const reason = cleanText(source.reason, 240);
      if (!family && !role) return null;
      return {
        ...(family ? { family } : {}),
        ...(role ? { role } : {}),
        ...(reason ? { reason } : {}),
        priority: cleanText(source.priority || 'soon', 40) || 'soon'
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

export function rapidCacheKey(snapshot = {}) {
  const source = asObject(snapshot);
  return [
    cleanText(source.chatKey || source.chatId || 'unknown-chat', 180),
    cleanText(source.sceneKey || 'default-scene', 180),
    cleanText(source.sourceRevisionHash || '', 180)
  ].join('::');
}

export function rapidWarmArtifactIsUsable(artifact = {}, expected = {}) {
  const source = asObject(artifact);
  const required = asObject(expected);
  return source.pipelineVersion === RAPID_PIPELINE_VERSION
    && source.status === 'ready'
    && cleanText(source.baseSourceRevisionHash, 180) === cleanText(required.baseSourceRevisionHash, 180)
    && cleanText(source.settingsHash, 180) === cleanText(required.settingsHash, 180)
    && cleanText(source.providerContractHash, 180) === cleanText(required.providerContractHash, 180)
    && cleanText(source.cardCatalogHash, 180) === cleanText(required.cardCatalogHash, 180)
    && cleanText(source.promptContractHash, 180) === cleanText(required.promptContractHash, 180)
    && cleanText(source.conditionedSceneBrief, TEXT_LIMIT)
    && Array.isArray(source.cardIds)
    && source.cardIds.length > 0;
}

export function buildRapidTurnDeltaPrompt(input = {}) {
  const source = asObject(input);
  return [
    'Return one strict JSON object for Recursion Rapid foreground turn delta.',
    `Schema: ${RAPID_TURN_DELTA_SCHEMA}`,
    `Snapshot hash: ${cleanText(source.snapshotHash, 180)}`,
    `Base source revision hash: ${cleanText(source.baseSourceRevisionHash, 180)}`,
    `Turn source revision hash: ${cleanText(source.turnSourceRevisionHash, 180)}`,
    'Given the warm provider-generated scene guidance and the latest user message, select only what should condition this reply.',
    'Do not invent cards. Missing non-mandatory cards should become backgroundRefreshRequests.',
    'Set escalateToStandard true only when a missing card is mandatory for safe or coherent response guidance.',
    `Warm artifact: ${JSON.stringify(asObject(source.warmArtifact))}`,
    `Candidate cards: ${JSON.stringify(Array.isArray(source.candidateCards) ? source.candidateCards : [])}`,
    `User message: ${cleanText(source.userMessage, TEXT_LIMIT)}`
  ].join('\n\n');
}

export function buildRapidFastStartPrompt(input = {}) {
  const source = asObject(input);
  return [
    'Return one strict JSON object for Recursion Rapid fast-start pack.',
    `Schema: ${RAPID_FAST_START_SCHEMA}`,
    `Snapshot hash: ${cleanText(source.snapshotHash, 180)}`,
    `Turn source revision hash: ${cleanText(source.turnSourceRevisionHash, 180)}`,
    'No warm deck is available. Create compact provider-generated scene and turn guidance directly.',
    'Degrade breadth only. Do not return local fallback language, hidden reasoning, markdown, or prose outside JSON.',
    `Snapshot: ${JSON.stringify(asObject(source.snapshot))}`
  ].join('\n\n');
}

export function normalizeRapidTurnDelta(value = {}, expected = {}) {
  const source = asObject(value);
  const allowed = new Set(Array.isArray(expected.allowedCardIds) ? expected.allowedCardIds.map(String) : []);
  if (source.schema !== RAPID_TURN_DELTA_SCHEMA) throw new Error('Invalid Rapid turn delta schema.');
  if (cleanText(source.snapshotHash, 180) !== cleanText(expected.snapshotHash, 180)) throw new Error('Rapid turn delta snapshot mismatch.');
  if (cleanText(source.baseSourceRevisionHash, 180) !== cleanText(expected.baseSourceRevisionHash, 180)) throw new Error('Rapid turn delta base source mismatch.');
  if (cleanText(source.turnSourceRevisionHash, 180) !== cleanText(expected.turnSourceRevisionHash, 180)) throw new Error('Rapid turn delta turn source mismatch.');
  return {
    schema: RAPID_TURN_DELTA_SCHEMA,
    snapshotHash: cleanText(source.snapshotHash, 180),
    baseSourceRevisionHash: cleanText(source.baseSourceRevisionHash, 180),
    turnSourceRevisionHash: cleanText(source.turnSourceRevisionHash, 180),
    selectedCardIds: cleanList(source.selectedCardIds, 180, 20).filter((cardId) => allowed.has(cardId)),
    turnDeltaBrief: cleanText(source.turnDeltaBrief, TEXT_LIMIT),
    packetInstructions: cleanList(source.packetInstructions, SHORT_TEXT_LIMIT, 12),
    guardrails: cleanList(source.guardrails, SHORT_TEXT_LIMIT, 12),
    backgroundRefreshRequests: cleanRefreshRequests(source.backgroundRefreshRequests),
    mandatoryMissingCards: cleanRefreshRequests(source.mandatoryMissingCards),
    escalateToStandard: source.escalateToStandard === true,
    diagnostics: cleanList(source.diagnostics, 120, 16)
  };
}

export function normalizeRapidFastStartPack(value = {}, expected = {}) {
  const source = asObject(value);
  if (source.schema !== RAPID_FAST_START_SCHEMA) throw new Error('Invalid Rapid fast-start schema.');
  if (cleanText(source.snapshotHash, 180) !== cleanText(expected.snapshotHash, 180)) throw new Error('Rapid fast-start snapshot mismatch.');
  if (cleanText(source.turnSourceRevisionHash, 180) !== cleanText(expected.turnSourceRevisionHash, 180)) throw new Error('Rapid fast-start source mismatch.');
  return {
    schema: RAPID_FAST_START_SCHEMA,
    snapshotHash: cleanText(source.snapshotHash, 180),
    turnSourceRevisionHash: cleanText(source.turnSourceRevisionHash, 180),
    sceneBrief: cleanText(source.sceneBrief, TEXT_LIMIT),
    turnBrief: cleanText(source.turnBrief, TEXT_LIMIT),
    guardrails: cleanList(source.guardrails, SHORT_TEXT_LIMIT, 12),
    omissions: cleanList(source.omissions, SHORT_TEXT_LIMIT, 12),
    backgroundRefreshRequests: cleanRefreshRequests(source.backgroundRefreshRequests),
    mandatoryMissingCards: cleanRefreshRequests(source.mandatoryMissingCards),
    escalateToStandard: source.escalateToStandard === true,
    diagnostics: cleanList(source.diagnostics, 120, 16)
  };
}

export function rapidArtifactHash(artifact = {}) {
  return hashJson({
    version: RAPID_PIPELINE_VERSION,
    warmArtifactId: artifact.warmArtifactId,
    baseSourceRevisionHash: artifact.baseSourceRevisionHash,
    cardIds: artifact.cardIds,
    conditionedSceneBrief: artifact.conditionedSceneBrief
  });
}
```

- [ ] **Step 6: Add test runner entry**

In `tools/scripts/run-tests.mjs`, add:

```js
'tools/scripts/test-rapid-pipeline.mjs',
```

Use the same list style as the existing script.

- [ ] **Step 7: Update provider docs**

In `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`, add `rapidTurnDelta` and `rapidFastStartPack` to Utility generation roles and state that they are Utility-only foreground Rapid roles.

- [ ] **Step 8: Verify and commit**

Run:

```powershell
node tools/scripts/test-rapid-pipeline.mjs
node tools/scripts/test-providers.mjs
```

Expected: both pass.

Commit:

```powershell
git add src/rapid-pipeline.mjs src/providers.mjs tools/scripts/test-rapid-pipeline.mjs tools/scripts/test-providers.mjs tools/scripts/run-tests.mjs docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md
git commit -m "feat: add rapid provider contracts"
```

---

### Task 3: Persist Rapid Warm Artifacts In Scene Cache Variants

**Files:**
- Modify: `src/storage.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-storage.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/technical/CARD_DECK_AND_HAND.md`

- [ ] **Step 1: Write failing storage tests**

In `tools/scripts/test-storage.mjs`, add a scene cache normalization case:

```js
const rapidCache = normalizeSceneCacheRecord({
  chatKey: 'rapid-chat',
  sceneKey: 'rapid-scene',
  activeSourceRevisionHash: 'base-source',
  variants: {
    'base-source': {
      sourceRevisionHash: 'base-source',
      cards: [],
      rapid: {
        pipelineVersion: 1,
        status: 'ready',
        warmArtifactId: 'rapid-warm-1',
        baseSourceRevisionHash: 'base-source',
        conditionedSceneBrief: 'Provider scene brief.',
        candidateCardIds: ['card-a'],
        cardIds: ['card-a'],
        settingsHash: 'settings-hash',
        providerContractHash: 'provider-hash',
        cardCatalogHash: 'catalog-hash',
        promptContractHash: 'prompt-hash',
        diagnostics: ['rapid-warm-ready'],
        rawProviderResponse: 'must not persist'
      }
    }
  }
});

assertEqual(
  rapidCache.variants['base-source'].rapid.warmArtifactId,
  'rapid-warm-1',
  'rapid warm artifact id persists'
);
assertEqual(
  rapidCache.variants['base-source'].rapid.rawProviderResponse,
  undefined,
  'rapid raw provider response is dropped'
);
assertEqual(
  rapidCache.variants['base-source'].rapid.status,
  'ready',
  'rapid warm status persists'
);
```

- [ ] **Step 2: Write failing runtime cache payload test**

In `tools/scripts/test-runtime.mjs`, add a focused assertion after a helper-export section or by exercising runtime view after a warm write:

```js
assertEqual(typeof runtime.warmRapidScene, 'function', 'runtime exposes Rapid warm entrypoint');
```

This assertion should fail until Task 4 adds the runtime entrypoint.

- [ ] **Step 3: Run failing tests**

Run:

```powershell
node tools/scripts/test-storage.mjs
node tools/scripts/test-runtime.mjs
```

Expected: storage fails because `rapid` metadata is not normalized; runtime fails because no warm entrypoint exists.

- [ ] **Step 4: Add Rapid metadata normalization**

In `src/storage.mjs`, add helpers near scene cache variant normalization:

```js
function normalizeRapidWarmArtifact(source = {}) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const status = ['queued', 'warming', 'ready', 'stale', 'failed'].includes(value.status) ? value.status : '';
  const warmArtifactId = safeMetadataText(value.warmArtifactId || '', 160, '');
  if (!status && !warmArtifactId) return null;
  return {
    pipelineVersion: Math.max(1, Math.floor(Number(value.pipelineVersion) || 1)),
    status: status || 'stale',
    warmArtifactId,
    baseSourceRevisionHash: safeMetadataText(value.baseSourceRevisionHash || '', 180, ''),
    conditionedSceneBrief: safeMetadataText(value.conditionedSceneBrief || '', 1600, ''),
    candidateCardIds: safeMetadataList(value.candidateCardIds, 180, 32),
    cardIds: safeMetadataList(value.cardIds, 180, 32),
    settingsHash: safeMetadataText(value.settingsHash || '', 180, ''),
    providerContractHash: safeMetadataText(value.providerContractHash || '', 180, ''),
    cardCatalogHash: safeMetadataText(value.cardCatalogHash || '', 180, ''),
    promptContractHash: safeMetadataText(value.promptContractHash || '', 180, ''),
    builtAt: safeMetadataText(value.builtAt || '', 80, ''),
    runId: safeMetadataText(value.runId || '', 120, ''),
    diagnostics: safeMetadataList(value.diagnostics, 120, 24)
  };
}
```

Inside `normalizeSceneCacheVariant`, add:

```js
const rapid = normalizeRapidWarmArtifact(value.rapid);
if (rapid) variant.rapid = rapid;
```

Use existing safe metadata helper names if they differ; do not persist raw provider request or response fields.

- [ ] **Step 5: Document cache shape**

In `docs/technical/CARD_DECK_AND_HAND.md`, add:

```markdown
Rapid may attach a `rapid` object to a source variant. This object stores sanitized warm-artifact metadata and provider-generated conditioned scene guidance for that exact source revision. It is not a separate memory layer, and it must not contain raw provider prompts, raw provider responses, hidden reasoning, API keys, inactive swipe text, or prompt packets.
```

- [ ] **Step 6: Verify storage test**

Run:

```powershell
node tools/scripts/test-storage.mjs
```

Expected: storage test passes. Runtime test still fails until Task 4.

- [ ] **Step 7: Commit**

```powershell
git add src/storage.mjs tools/scripts/test-storage.mjs docs/technical/CARD_DECK_AND_HAND.md
git commit -m "feat: persist rapid warm artifacts"
```

---

### Task 4: Add Background Rapid Warm Entry Point

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `src/progress.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`

- [ ] **Step 1: Add failing runtime warm test**

In `tools/scripts/test-runtime.mjs`, add:

```js
{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: 'recursion.utilityArbiter.v1',
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Warm scene frame.' }],
              reasonerDecision: { mode: 'skip', reason: 'background warm', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['rapid-background-warm']
            }
          };
        }
        if (roleId === 'sceneFrameCard') {
          return cardProviderResponse(request, 'Scene Frame', 'The corridor ends at a sealed hatch.', ['message:1']);
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const warm = await harness.runtime.warmRapidScene({ reason: 'test-idle' });
  assertEqual(warm.ok, true, 'Rapid background warm succeeds');
  assert(roleCalls.includes('utilityArbiter'), 'Rapid warm uses provider Arbiter');
  assert(roleCalls.includes('sceneFrameCard'), 'Rapid warm generates provider card');
  const cache = await harness.storage.loadSceneCache('test-chat', 'test-scene');
  const variant = cache.variants[cache.activeSourceRevisionHash];
  assertEqual(variant.rapid.status, 'ready', 'Rapid warm artifact is ready');
  assertEqual(harness.installed.length, 0, 'Rapid warm does not install prompt');
}
```

Use existing harness names for `storage` and `installed`; adapt only to match current helper return shape.

- [ ] **Step 2: Add failing progress test**

In `tools/scripts/test-progress.mjs`, add:

```js
reporter.stage({ runId: 'rapid-warm', phase: 'rapidWarming', label: 'Rapid warming scene deck...', chips: ['Rapid'] });
const rapidProgress = progressRunFromActivity(reporter.view());
assert(
  JSON.stringify(rapidProgress).includes('Rapid warming scene deck'),
  'progress includes Rapid warming row'
);
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
node tools/scripts/test-runtime.mjs
node tools/scripts/test-progress.mjs
```

Expected: both fail for missing Rapid runtime/progress support.

- [ ] **Step 4: Add progress definitions**

In `src/progress.mjs`, add step definitions:

```js
rapidWarming: { label: 'Rapid warming scene deck', providerLane: 'utility' },
rapidWarmReady: { label: 'Rapid deck ready', providerLane: 'utility' },
rapidWarmStale: { label: 'Rapid deck stale', providerLane: 'utility' },
```

Map activity phases to these ids in the same helper that maps existing phases.

- [ ] **Step 5: Implement runtime warm entrypoint**

In `src/runtime.mjs`, import:

```js
import { RAPID_PIPELINE_VERSION, rapidArtifactHash } from './rapid-pipeline.mjs';
```

Add `warmRapidScene` near `refreshScene()`:

```js
async function warmRapidScene({ reason = 'idle' } = {}) {
  const settings = settingsStore.get();
  if (settings.enabled === false || settings.pipelineMode !== 'rapid') {
    return { ok: true, skipped: true, reason: 'rapid-disabled' };
  }
  await waitForExternalMutations();
  const runId = makeId('rapid-warm');
  const signal = startRun(runId);
  startRuntimeActivity({ runId, phase: 'rapidWarming', label: 'Rapid warming scene deck...', chips: ['Rapid'] });
  try {
    const snapshot = await readSnapshot();
    if (!isActiveRun(runId)) return supersededResult(runId);
    const fallbackPlan = localFallbackPlan(snapshot, settings);
    const cache = await loadSceneCacheSafe(runId, snapshot, settings);
    let plan = await askUtilityArbiter({
      runId,
      snapshot,
      settings,
      fallbackPlan,
      sceneCache: cache,
      userMessage: '',
      signal
    });
    plan = enforceReasonerAvailability(plan, settings);
    plan = applyReasoningPolicyToPlan(plan, settings);
    plan = applyBehaviorPolicyToPlan(plan, settings);
    const providerCards = (await generatePlanCards({ runId, plan, snapshot, settings, signal })).map(sanitizeGeneratedCard);
    const activeCache = activeSceneCacheVariant(cache, snapshot);
    const cacheCards = sanitizedCacheCards(runId, snapshot, activeCache.cards);
    const deck = applyCardPlan(cacheCards, {
      acceptedCards: providerCards,
      lifecycle: lifecycleForDeck([...cacheCards, ...providerCards], plan, () => 'rapid background warm')
    });
    const hand = selectHand(deck.cards, {
      maxCards: budgetOr(plan.budgets?.maxCards, 6),
      maxTokens: budgetOr(plan.budgets?.targetBriefTokens, 700),
      behaviorPolicy: runPolicyForEffectivePlan(settings, plan)
    });
    const conditionedSceneBrief = hand.cards.map((card) => card.promptText).filter(Boolean).join('\n').slice(0, 1600);
    const rapid = {
      pipelineVersion: RAPID_PIPELINE_VERSION,
      status: 'ready',
      warmArtifactId: makeId('rapid-warm-artifact'),
      baseSourceRevisionHash: activeSourceRevisionHash(snapshot),
      conditionedSceneBrief,
      candidateCardIds: hand.cards.map((card) => card.id),
      cardIds: deck.cards.map((card) => card.id),
      ...cacheContractVersions(settings),
      builtAt: nowIso(),
      runId,
      diagnostics: mergeDiagnostics(plan.diagnostics, [`rapid-warm:${reason}`])
    };
    rapid.artifactHash = rapidArtifactHash(rapid);
    await runStorageSaveSection(runId, () => saveSceneCacheSafe(
      runId,
      snapshot,
      sceneCachePayload(snapshot, deck, hand, plan, null, settings, cache, { rapid })
    ));
    settleRuntimeActivity({ runId, outcome: 'success', label: 'Rapid deck ready.' });
    return { ok: true, rapid, hand, plan };
  } finally {
    clearActiveRun(runId);
  }
}
```

Update `sceneCachePayload(...)` signature to accept an optional `{ rapid }` option and attach it to the active variant:

```js
if (options.rapid) variants[sourceRevisionHash].rapid = options.rapid;
```

Keep all existing callers working by defaulting `options = {}`.

- [ ] **Step 6: Expose entrypoint**

In the runtime return object, add:

```js
warmRapidScene,
```

- [ ] **Step 7: Document background warm flow**

In `docs/technical/RUNTIME_TURN_SEQUENCE.md`, add a Rapid section that states background warm uses provider Arbiter/card work, saves cache only, and never installs prompt keys.

- [ ] **Step 8: Verify and commit**

Run:

```powershell
node tools/scripts/test-progress.mjs
node tools/scripts/test-runtime.mjs
```

Expected: both pass.

Commit:

```powershell
git add src/runtime.mjs src/progress.mjs tools/scripts/test-runtime.mjs tools/scripts/test-progress.mjs docs/technical/RUNTIME_TURN_SEQUENCE.md
git commit -m "feat: warm rapid scene decks"
```

---

### Task 5: Implement Foreground Rapid Delta And Fast-Start

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`

- [ ] **Step 1: Add failing warm-delta runtime test**

In `tools/scripts/test-runtime.mjs`, add:

```js
{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidTurnDelta') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidTurnDelta.v1',
              snapshotHash: request.snapshotHash,
              baseSourceRevisionHash: request.baseSourceRevisionHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              selectedCardIds: ['warm-card-1'],
              turnDeltaBrief: 'The user tests the hatch now.',
              packetInstructions: ['Keep hatch access constrained.'],
              guardrails: ['Do not open the hatch for free.'],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['rapid-warm-deck']
            }
          };
        }
        throw new Error(`unexpected foreground role ${roleId}`);
      }
    },
    initialSceneCache: rapidWarmCacheFixture({
      cardId: 'warm-card-1',
      baseSourceRevisionHash: 'base-source'
    })
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Try the hatch.' });
  assertEqual(result.ok, true, 'Rapid foreground installs from warm deck');
  assert(roleCalls.includes('rapidTurnDelta'), 'Rapid foreground calls turn delta');
  assert(!roleCalls.includes('utilityArbiter'), 'Rapid warm foreground does not call full Arbiter');
  assertEqual(harness.installed.length, 1, 'Rapid foreground installs one prompt packet');
  assertNoSecretText(result.packet, 'Rapid packet');
}
```

Add helper fixtures near other runtime test helpers:

```js
function rapidWarmCacheFixture({ cardId = 'warm-card-1', baseSourceRevisionHash = 'base-source' } = {}) {
  return {
    cacheState: 'active',
    activeSourceRevisionHash: baseSourceRevisionHash,
    variantOrder: [baseSourceRevisionHash],
    variants: {
      [baseSourceRevisionHash]: {
        sourceRevisionHash: baseSourceRevisionHash,
        cards: [deckCard('Scene Constraints', 'The hatch stays sealed until opened.', { id: cardId })],
        rapid: {
          pipelineVersion: 1,
          status: 'ready',
          warmArtifactId: 'rapid-warm-fixture',
          baseSourceRevisionHash,
          conditionedSceneBrief: 'The hatch stays sealed until opened.',
          candidateCardIds: [cardId],
          cardIds: [cardId],
          settingsHash: cacheContractVersions({}).settingsHash,
          providerContractHash: cacheContractVersions({}).providerContractHash,
          cardCatalogHash: cacheContractVersions({}).cardCatalogHash,
          promptContractHash: cacheContractVersions({}).promptContractHash,
          diagnostics: ['rapid-warm-ready']
        }
      }
    }
  };
}
```

- [ ] **Step 2: Add failing fast-start runtime test**

Add:

```js
{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidFastStartPack') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidFastStartPack.v1',
              snapshotHash: request.snapshotHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              sceneBrief: 'The corridor ends at a sealed hatch.',
              turnBrief: 'The user tries the hatch.',
              guardrails: ['Keep the hatch sealed unless the action opens it.'],
              omissions: ['No warm scene deck was ready.'],
              backgroundRefreshRequests: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Warm full deck.' }],
              mandatoryMissingCards: [],
              escalateToStandard: false,
              diagnostics: ['rapid-fast-start']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Try the hatch.' });
  assertEqual(result.ok, true, 'Rapid fast-start installs');
  assert(roleCalls.includes('rapidFastStartPack'), 'Rapid calls fast-start when no warm deck exists');
  assert(!JSON.stringify(result).includes('local-fallback'), 'Rapid fast-start does not use local fallback diagnostics');
}
```

- [ ] **Step 3: Add failing mandatory escalation test**

Add:

```js
{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'rapidFastStartPack') {
          return {
            ok: true,
            data: {
              schema: 'recursion.rapidFastStartPack.v1',
              snapshotHash: request.snapshotHash,
              turnSourceRevisionHash: request.turnSourceRevisionHash,
              sceneBrief: '',
              turnBrief: '',
              guardrails: [],
              omissions: [],
              backgroundRefreshRequests: [],
              mandatoryMissingCards: [{ family: 'Knowledge', reason: 'Reveal boundary is mandatory.' }],
              escalateToStandard: true,
              diagnostics: ['rapid-mandatory-gap']
            }
          };
        }
        if (roleId === 'utilityArbiter') {
          return standardComposeBriefPlan(request);
        }
        if (roleId === 'sceneFrameCard') {
          return cardProviderResponse(request, 'Scene Frame', 'Standard resolves the mandatory gap.', ['message:1']);
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Reveal the hidden thing.' });
  assertEqual(result.ok, true, 'Rapid mandatory gap escalates and installs through Standard');
  assert(roleCalls.includes('rapidFastStartPack'), 'Rapid tried fast-start first');
  assert(roleCalls.includes('utilityArbiter'), 'Rapid escalated to Standard Arbiter');
  assert(result.plan.diagnostics.includes('rapid-escalated-standard:mandatory-gap'), 'plan records Rapid escalation');
}
```

- [ ] **Step 4: Run failing runtime test**

Run:

```powershell
node tools/scripts/test-runtime.mjs
```

Expected: fails because foreground Rapid branch does not exist.

- [ ] **Step 5: Implement foreground branch**

In `src/runtime.mjs`, import:

```js
import {
  buildRapidFastStartPrompt,
  buildRapidTurnDeltaPrompt,
  normalizeRapidFastStartPack,
  normalizeRapidTurnDelta,
  rapidWarmArtifactIsUsable
} from './rapid-pipeline.mjs';
```

At the start of `prepareForGeneration`, after snapshot and initial cache load, branch:

```js
if (settings.pipelineMode === 'rapid' && !refreshReason) {
  const rapidResult = await prepareRapidForGeneration({
    runId,
    snapshot,
    pendingUserMessage,
    initialCache,
    settings,
    signal
  });
  if (rapidResult?.escalateToStandard !== true) return rapidResult;
  initialDiagnostics.push('rapid-escalated-standard:mandatory-gap');
}
```

If `initialDiagnostics` does not exist, use a local array and merge it into the Standard plan diagnostics after Arbiter returns.

Add `prepareRapidForGeneration(...)` before `prepareForGeneration`:

```js
async function prepareRapidForGeneration({ runId, snapshot, pendingUserMessage, initialCache, settings, signal }) {
  if (!generationRouter?.generate) {
    await clearPromptBestEffort(host);
    settleRuntimeActivity({ runId, outcome: 'warning', label: 'Utility provider is not ready.' });
    return { ok: true, skipped: true, reason: 'rapid-utility-unavailable' };
  }
  const baseSnapshot = snapshot;
  const turnSnapshot = snapshotWithPendingUserMessage(snapshot, pendingUserMessage);
  const snapshotHash = hashJson(turnSnapshot);
  const activeVariant = activeSceneCacheVariant(initialCache, baseSnapshot);
  const rapid = activeVariant.rapid;
  const expectedContracts = {
    baseSourceRevisionHash: activeSourceRevisionHash(baseSnapshot),
    ...cacheContractVersions(settings)
  };
  const candidateCards = sanitizedCacheCards(runId, baseSnapshot, activeVariant.cards);
  const usableWarm = rapidWarmArtifactIsUsable(rapid, expectedContracts);
  stageRuntimeActivity({
    runId,
    phase: usableWarm ? 'rapidDeltaRunning' : 'rapidFastStartRunning',
    label: usableWarm ? 'Rapid selecting turn delta...' : 'Rapid fast-start pack...',
    chips: ['Rapid', usableWarm ? 'Warm' : 'Fast start']
  });
  const providerResult = usableWarm
    ? await generationRouter.generate('rapidTurnDelta', {
        lane: 'utility',
        runId,
        signal,
        snapshotHash,
        baseSourceRevisionHash: activeSourceRevisionHash(baseSnapshot),
        turnSourceRevisionHash: activeSourceRevisionHash(turnSnapshot),
        prompt: buildRapidTurnDeltaPrompt({
          snapshotHash,
          baseSourceRevisionHash: activeSourceRevisionHash(baseSnapshot),
          turnSourceRevisionHash: activeSourceRevisionHash(turnSnapshot),
          userMessage: pendingUserMessage.text,
          warmArtifact: rapid,
          candidateCards: candidateCards.map((card) => ({ id: card.id, family: card.family, summary: card.summary }))
        })
      }, { runId, signal, isCurrent: () => isActiveRun(runId) })
    : await generationRouter.generate('rapidFastStartPack', {
        lane: 'utility',
        runId,
        signal,
        snapshotHash,
        turnSourceRevisionHash: activeSourceRevisionHash(turnSnapshot),
        prompt: buildRapidFastStartPrompt({
          snapshotHash,
          turnSourceRevisionHash: activeSourceRevisionHash(turnSnapshot),
          snapshot: providerSafeSnapshot(turnSnapshot)
        })
      }, { runId, signal, isCurrent: () => isActiveRun(runId) });
  if (!providerResult?.ok) {
    settleRuntimeActivity({ runId, outcome: 'warning', label: 'Rapid provider output was unavailable.' });
    return { ok: true, skipped: true, reason: 'rapid-provider-unavailable' };
  }
  const normalized = usableWarm
    ? normalizeRapidTurnDelta(providerResult.data, {
        snapshotHash,
        baseSourceRevisionHash: activeSourceRevisionHash(baseSnapshot),
        turnSourceRevisionHash: activeSourceRevisionHash(turnSnapshot),
        allowedCardIds: candidateCards.map((card) => card.id)
      })
    : normalizeRapidFastStartPack(providerResult.data, {
        snapshotHash,
        turnSourceRevisionHash: activeSourceRevisionHash(turnSnapshot)
      });
  if (normalized.escalateToStandard || normalized.mandatoryMissingCards.length) {
    return { ok: false, escalateToStandard: true, diagnostics: ['rapid-escalated-standard:mandatory-gap'] };
  }
  return installRapidPacket({ runId, baseSnapshot, turnSnapshot, settings, rapid, candidateCards, normalized, usableWarm });
}
```

Implement `installRapidPacket(...)` using `composePromptPacket` only as deterministic packet formatting if it can accept provider-generated sections. If current composer cannot accept direct Rapid sections, create a small packet object with the same final shape expected by `installPrompt(host, packet)`, using:

```js
const selectedCards = usableWarm
  ? candidateCards.filter((card) => normalized.selectedCardIds.includes(card.id))
  : [];
const packet = {
  version: PROMPT_PACKET_VERSION,
  schema: 'recursion.promptPacket.v1',
  source: 'rapid',
  sceneBrief: usableWarm ? rapid.conditionedSceneBrief : normalized.sceneBrief,
  turnBrief: usableWarm ? normalized.turnDeltaBrief : normalized.turnBrief,
  guardrails: normalized.guardrails,
  cards: selectedCards,
  diagnostics: {
    pipelineMode: 'rapid',
    rapidPath: usableWarm ? 'warm-delta' : 'fast-start',
    diagnostics: normalized.diagnostics
  }
};
```

Then run the same freshness recheck and install sequence Standard uses. Do not call `localCards(...)` in Rapid.

- [ ] **Step 6: Merge escalation diagnostics into Standard**

When Rapid returns `escalateToStandard`, continue through the existing Standard path and merge:

```js
plan.diagnostics = mergeDiagnostics(plan.diagnostics, ['rapid-escalated-standard:mandatory-gap']);
```

- [ ] **Step 7: Update docs**

In `docs/architecture/RUNTIME_ARCHITECTURE.md` and `docs/technical/RUNTIME_TURN_SEQUENCE.md`, describe Rapid warm-delta, fast-start, no-local-fallback, and Standard escalation behavior.

- [ ] **Step 8: Verify and commit**

Run:

```powershell
node tools/scripts/test-runtime.mjs
```

Expected: pass.

Commit:

```powershell
git add src/runtime.mjs tools/scripts/test-runtime.mjs docs/architecture/RUNTIME_ARCHITECTURE.md docs/technical/RUNTIME_TURN_SEQUENCE.md
git commit -m "feat: run rapid foreground pipeline"
```

---

### Task 6: Add Hedged Rapid Foreground Calls

**Files:**
- Modify: `src/rapid-pipeline.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-rapid-pipeline.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`

- [ ] **Step 1: Add failing hedge helper test**

In `tools/scripts/test-rapid-pipeline.mjs`, add:

```js
import { chooseRapidHedgeWinner } from '../../src/rapid-pipeline.mjs';

const hedgeWinner = chooseRapidHedgeWinner([
  { source: 'primary', result: { ok: false, error: { code: 'invalid' } }, settledAtMs: 9000 },
  { source: 'backup', result: { ok: true, data: { schema: RAPID_TURN_DELTA_SCHEMA } }, settledAtMs: 6500 }
]);
assertEqual(hedgeWinner.source, 'backup', 'first valid hedge result wins');
```

- [ ] **Step 2: Add failing runtime hedge test**

In `tools/scripts/test-runtime.mjs`, add:

```js
{
  const calls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'rapid', mode: 'auto' },
    rapidHedgeDelayMs: 1,
    generationRouter: {
      async generate(roleId, request = {}) {
        calls.push({ roleId, hedge: request.rapidHedgeSource });
        if (roleId !== 'rapidFastStartPack') throw new Error(`unexpected role ${roleId}`);
        if (request.rapidHedgeSource === 'primary') {
          await delay(20);
          return { ok: false, error: { code: 'slow-invalid', message: 'primary invalid' } };
        }
        return {
          ok: true,
          data: {
            schema: 'recursion.rapidFastStartPack.v1',
            snapshotHash: request.snapshotHash,
            turnSourceRevisionHash: request.turnSourceRevisionHash,
            sceneBrief: 'Backup scene brief.',
            turnBrief: 'Backup turn brief.',
            guardrails: [],
            omissions: [],
            backgroundRefreshRequests: [],
            mandatoryMissingCards: [],
            escalateToStandard: false,
            diagnostics: ['rapid-hedge-backup']
          }
        };
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Use backup hedge.' });
  assertEqual(result.ok, true, 'Rapid hedge installs from backup');
  assert(calls.some((call) => call.hedge === 'primary'), 'primary hedge call started');
  assert(calls.some((call) => call.hedge === 'backup'), 'backup hedge call started');
  assert(JSON.stringify(result.packet).includes('rapid-hedge-backup'), 'packet diagnostics include backup winner');
}
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
node tools/scripts/test-rapid-pipeline.mjs
node tools/scripts/test-runtime.mjs
```

Expected: fail because hedge helpers and runtime options do not exist.

- [ ] **Step 4: Add hedge helper**

In `src/rapid-pipeline.mjs`, add:

```js
export function chooseRapidHedgeWinner(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.result?.ok === true)
    .sort((a, b) => Number(a.settledAtMs || 0) - Number(b.settledAtMs || 0))[0] || null;
}
```

- [ ] **Step 5: Add runtime hedged call wrapper**

In `src/runtime.mjs`, add:

```js
async function generateRapidForeground(roleId, request, options = {}) {
  const hedgeDelayMs = Number(runtimeOptions.rapidHedgeDelayMs ?? 4000);
  if (!generationRouter?.generate || hedgeDelayMs < 0) {
    return generationRouter.generate(roleId, { ...request, rapidHedgeSource: 'primary' }, options);
  }
  const started = Date.now();
  const primary = generationRouter.generate(roleId, { ...request, rapidHedgeSource: 'primary' }, options)
    .then((result) => ({ source: 'primary', result, settledAtMs: Date.now() - started }));
  const backup = new Promise((resolve) => {
    setTimeout(() => {
      resolve(generationRouter.generate(roleId, { ...request, rapidHedgeSource: 'backup' }, options)
        .then((result) => ({ source: 'backup', result, settledAtMs: Date.now() - started })));
    }, hedgeDelayMs);
  }).then((entry) => entry);
  const first = await Promise.race([primary, backup]);
  if (first.result?.ok === true) return {
    ...first.result,
    diagnostics: { ...first.result.diagnostics, rapidHedgeWinner: first.source }
  };
  const second = await (first.source === 'primary' ? backup : primary);
  if (second.result?.ok === true) return {
    ...second.result,
    diagnostics: { ...second.result.diagnostics, rapidHedgeWinner: second.source }
  };
  return first.result;
}
```

Use `generateRapidForeground(...)` in `prepareRapidForGeneration(...)` for `rapidTurnDelta` and `rapidFastStartPack`.

If the runtime factory does not currently preserve arbitrary runtime options, add `const runtimeOptions = options || {};` at the top of `createRecursionRuntime(...)` using the existing function parameter name.

- [ ] **Step 6: Document hedging**

In `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`, add:

```markdown
Rapid foreground Utility roles may hedge: the primary call starts immediately and a backup starts after the configured short delay if no valid output has returned. The first valid structured output wins, and diagnostics record the winning hedge source. Hedging is not used for final Story generation.
```

- [ ] **Step 7: Verify and commit**

Run:

```powershell
node tools/scripts/test-rapid-pipeline.mjs
node tools/scripts/test-runtime.mjs
```

Expected: both pass.

Commit:

```powershell
git add src/rapid-pipeline.mjs src/runtime.mjs tools/scripts/test-rapid-pipeline.mjs tools/scripts/test-runtime.mjs docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md
git commit -m "feat: hedge rapid foreground utility calls"
```

---

### Task 7: Wire Host Events To Background Warming

**Files:**
- Modify: `src/extension/index.js`
- Modify: `tools/scripts/test-extension-smoke.mjs`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`

- [ ] **Step 1: Write failing extension smoke test**

In `tools/scripts/test-extension-smoke.mjs`, extend the fake runtime to record `warmRapidScene` calls:

```js
const warmCalls = [];
fakeRuntimeFactory.runtime = {
  ...fakeRuntimeFactory.runtime,
  async warmRapidScene(input = {}) {
    warmCalls.push(input);
    return { ok: true };
  }
};
```

Emit the host event used when assistant generation finishes or chat updates after generation. If the existing smoke fixture exposes `GENERATION_ENDED`, use it:

```js
eventSource.emit(eventTypes.GENERATION_ENDED, { mesid: 12 });
await flushPromises();
assert(warmCalls.some((call) => call.reason === 'assistant-message-landed'), 'assistant landing schedules Rapid warm');
```

If the harness only exposes generic message update events, use the assistant-message update path and assert `reason === 'source-stable'`.

- [ ] **Step 2: Run failing extension smoke**

Run:

```powershell
node tools/scripts/test-extension-smoke.mjs
```

Expected: fail because extension does not call `warmRapidScene`.

- [ ] **Step 3: Resolve assistant-finished event names**

In `src/extension/index.js`, add:

```js
function resolveAssistantLandedEvents(context) {
  const eventTypes = hostEventTypes(context);
  return [...new Set([
    eventTypes.GENERATION_ENDED,
    eventTypes.GENERATION_AFTER_COMMANDS,
    eventTypes.MESSAGE_RECEIVED,
    'generation_ended'
  ].filter(Boolean))];
}
```

- [ ] **Step 4: Register warm handler**

In `registerHostEvents(nextRuntime)`, add:

```js
for (const eventName of resolveAssistantLandedEvents(context)) {
  registerRuntimeHostEvent(eventSource, eventName, () => {
    runtime ||= nextRuntime;
    return invokeRuntimeCleanup('warmRapidScene', 'Rapid warm failed.', { reason: 'assistant-message-landed' });
  });
}
```

This is safe because `warmRapidScene` returns skipped when Rapid is disabled.

- [ ] **Step 5: Document operator behavior**

In `docs/user/RECURSION_OPERATOR_MANUAL.md`, add:

```markdown
When Rapid is enabled, Recursion may warm a provider-generated scene deck after an assistant message lands or the source settles. This work does not install prompt text by itself. It prepares the next turn so the next send can use a short provider delta instead of a full foreground card pass.
```

- [ ] **Step 6: Verify and commit**

Run:

```powershell
node tools/scripts/test-extension-smoke.mjs
```

Expected: pass.

Commit:

```powershell
git add src/extension/index.js tools/scripts/test-extension-smoke.mjs docs/user/RECURSION_OPERATOR_MANUAL.md
git commit -m "feat: warm rapid deck after assistant turns"
```

---

### Task 8: Final Diagnostics, Documentation, And Gates

**Files:**
- Modify docs listed below only when searches find stale contract language.

- [ ] **Step 1: Add testing strategy notes**

In `docs/testing/TESTING_STRATEGY.md`, add:

```markdown
Rapid pipeline coverage is split between pure helper tests, deterministic runtime tests, extension event smoke, and optional live SillyTavern proof. Deterministic tests must prove Rapid warm artifacts are exact-source keyed, foreground Rapid never creates local fallback cards or local briefs, and mandatory gaps escalate to Standard.
```

- [ ] **Step 2: Search for contradictory Rapid wording**

Run:

```powershell
rg -n "Rapid uses local fallback|Rapid creates local fallback|Rapid uses local scene brief|Rapid creates local scene brief|Rapid uses local turn brief|Rapid creates local turn brief|timeout-based quality reduction" src docs/design docs/technical docs/architecture docs/user docs/testing tools
```

Expected: no text says Rapid uses local fallback cards, creates local Rapid briefs, or uses timeout-based quality reduction. Negative contract statements such as "Rapid never creates local fallback cards" may remain in design/spec files and should not be searched as active contradictions.

- [ ] **Step 3: Run focused tests**

Run:

```powershell
node tools/scripts/test-rapid-pipeline.mjs
node tools/scripts/test-settings.mjs
node tools/scripts/test-providers.mjs
node tools/scripts/test-storage.mjs
node tools/scripts/test-progress.mjs
node tools/scripts/test-runtime.mjs
node tools/scripts/test-ui.mjs
node tools/scripts/test-extension-smoke.mjs
```

Expected: all pass.

- [ ] **Step 4: Run repo gates**

Run:

```powershell
npm.cmd test
node tools/scripts/run-alpha-gate.mjs
```

Expected: both pass. If live-only prerequisites are missing, report them as skipped live proof, not deterministic failure.

- [ ] **Step 5: Run diff hygiene**

Run:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. `git status --short` shows only intentional Rapid changes plus any pre-existing unrelated work.

- [ ] **Step 6: Commit final docs or test alignment**

If earlier task commits were skipped, run:

```powershell
git add src tools docs styles
git commit -m "feat: add rapid pipeline"
```

If earlier task commits were used, commit only remaining docs/test adjustments:

```powershell
git add docs tools
git commit -m "docs: complete rapid pipeline contract"
```

---

## Self-Review Checklist

- [ ] `pipelineMode` is separate from Auto/Manual `mode`.
- [ ] Rapid foreground uses `rapidTurnDelta` when an exact warm deck exists.
- [ ] Rapid foreground uses `rapidFastStartPack` when no exact warm deck exists.
- [ ] Rapid background warm never installs prompt keys.
- [ ] Rapid foreground never calls `localCards(...)`.
- [ ] Rapid never creates local scene brief or local turn brief.
- [ ] Rapid rejects stale warm artifacts by source revision and contract hashes.
- [ ] Rapid escalates to Standard only for provider-declared mandatory gaps.
- [ ] Hedged foreground calls accept first valid structured provider output.
- [ ] Prompt install still rechecks current source before writing host prompt keys.
- [ ] UI remains compact, graphite-dark, and SillyTavern-native.
- [ ] Diagnostics do not persist raw prompts, raw provider responses, hidden reasoning, API keys, or inactive swipe text.
- [ ] `npm.cmd test` and `node tools/scripts/run-alpha-gate.mjs` pass before claiming implementation complete.

## Plan Self-Review

Spec coverage: Tasks 1 and 7 cover the visible pipeline selector and background event wiring. Tasks 2, 3, 4, 5, and 6 cover provider-only Rapid schemas, exact-source warm artifacts, foreground turn-delta, fast-start, mandatory Standard escalation, and hedged Utility. Task 8 covers docs, contradiction scans, deterministic tests, and repo gates.

Placeholder scan: The plan contains no placeholder markers, vague catch-all steps, or references to work without concrete files and commands.

Type consistency: `pipelineMode` is the persisted setting, `rapidTurnDelta` and `rapidFastStartPack` are Utility role ids, `recursion.rapidTurnDelta.v1` and `recursion.rapidFastStartPack.v1` are schema ids, `variant.rapid` is the cache metadata object, and `warmRapidScene()` is the runtime background entrypoint.

## Execution Handoff

Plan complete. Recommended implementation path: use `superpowers:subagent-driven-development`, one task per subagent with main-thread review after each task. Inline execution is viable if the implementer runs the focused tests after every task and avoids touching unrelated dirty source files.
