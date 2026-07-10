# Recursion Story Form Selector Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat Tense & PoV dropdown with a compact Auto + Tense + Point of View selector while preserving the existing single-string `storyFormOverride` runtime contract.

**Architecture:** Keep `src/story-form.mjs` and `src/settings.mjs` as the authoritative story-form enum and normalization layer. Refactor only the UI option model, rendering, event handling, CSS, tests, and design docs so the popover presents separate axes but still saves values such as `present-mixed`.

**Tech Stack:** JavaScript ES modules, Recursion compact SillyTavern UI, DOM helper rendering in `src/ui.mjs`, CSS in `styles/recursion.css`, Node test scripts under `tools/scripts`.

## Global Constraints

- Recursion is pre-alpha; update docs, tests, and implementation in place.
- The persisted setting remains `storyFormOverride: string`.
- Do not add `{ tense, pov }` settings or partial override states.
- `Auto` saves `storyFormOverride: "auto"`.
- Forced mode always saves a complete tense + POV pair.
- Missing forced axis defaults to `past-third-limited`.
- Forced-axis clicks keep the story-form popover open.
- Selecting `Auto`, clicking outside, or pressing `Esc` closes the popover.
- The compact bar button keeps existing full and shorthand labels.
- The UI must not present Mixed POV as a style preset or rewrite mode.

---

## File Structure

- Modify `src/ui.mjs`: replace flat `STORY_FORM_MENU_OPTIONS` rendering with separate `STORY_FORM_TENSE_OPTIONS` and `STORY_FORM_POV_OPTIONS`, add mapping helpers, render the new popover, and update click handling.
- Modify `styles/recursion.css`: add compact section/grid styling for the new story-form menu while preserving existing button sizing.
- Modify `tools/scripts/test-ui.mjs`: replace flat-list assertions with axis selector rendering, mapping, selected-state, and close/open behavior tests.
- Modify `docs/design/UI_SPEC.md`: update the canonical Tense & PoV section to describe the new selector.
- No changes planned for `src/story-form.mjs`, `src/settings.mjs`, `src/runtime.mjs`, or cache logic.

### Task 1: Story Form Axis Helpers

**Files:**
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: existing `storyFormOverride` strings from settings.
- Produces: UI-local helpers that split, combine, label, and normalize story-form override values without changing runtime settings shape.

- [ ] **Step 1: Add failing helper behavior tests**

In `tools/scripts/test-ui.mjs`, add assertions near the existing story-form menu tests. Use the repo's current UI test harness and exported/rendered HTML patterns; if private helpers are not exported, assert by clicking rendered controls in Task 3 instead. The intended helper behavior is:

```js
assertEqual(resolveStoryFormOverride({ current: 'past-third-limited', tense: 'present' }), 'present-third-limited', 'tense click preserves current POV');
assertEqual(resolveStoryFormOverride({ current: 'present-third-limited', pov: 'mixed' }), 'present-mixed', 'POV click preserves current tense');
assertEqual(resolveStoryFormOverride({ current: 'auto', tense: 'present' }), 'present-third-limited', 'tense click from Auto uses default POV');
assertEqual(resolveStoryFormOverride({ current: 'auto', pov: 'mixed' }), 'past-mixed', 'POV click from Auto uses default tense');
assertEqual(resolveStoryFormOverride({ current: 'bad-value', pov: 'second-person' }), 'past-second-person', 'invalid current value uses default tense');
```

If tests cannot directly access `resolveStoryFormOverride`, implement the same assertions through rendered button clicks after Task 3. Do not export UI helpers solely for production code.

- [ ] **Step 2: Run the failing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: FAIL because the axis helper behavior does not exist yet.

- [ ] **Step 3: Replace flat option source with axis option sources**

In `src/ui.mjs`, replace `STORY_FORM_MENU_OPTIONS` with these constants:

```js
const DEFAULT_FORCED_STORY_FORM = Object.freeze({
  tense: 'past',
  pov: 'third-limited'
});

const STORY_FORM_TENSE_OPTIONS = Object.freeze([
  { value: 'past', label: 'Past', title: 'Past tense' },
  { value: 'present', label: 'Present', title: 'Present tense' }
]);

const STORY_FORM_POV_OPTIONS = Object.freeze([
  { value: 'first-person', label: '1st', fullLabel: '1st Person', title: 'First-person POV', tip: 'I walk to the door' },
  { value: 'second-person', label: '2nd', fullLabel: '2nd Person', title: 'Second-person POV', tip: 'You walk to the door' },
  { value: 'third-limited', label: '3rd Ltd', fullLabel: '3rd Limited', title: 'Third-person limited POV', tip: 'She walks to the door' },
  { value: 'third-omniscient', label: '3rd Omni', fullLabel: '3rd Omni', title: 'Third-person omniscient POV', tip: 'She walks to the door with broader narrative knowledge' },
  { value: 'mixed', label: 'Mixed', fullLabel: 'Mixed', title: 'Mixed POV', tip: 'Preserve established viewpoint alternation' }
]);

const STORY_FORM_LABELS = Object.freeze({
  auto: { label: 'Auto', shortLabel: 'Auto', title: 'Auto' },
  'past-first-person': { label: 'Past 1st', shortLabel: 'Pa1', title: 'Past 1st Person' },
  'past-second-person': { label: 'Past 2nd', shortLabel: 'Pa2', title: 'Past 2nd Person' },
  'past-third-limited': { label: 'Past 3rd Limited', shortLabel: 'Pa3L', title: 'Past 3rd Limited' },
  'past-third-omniscient': { label: 'Past 3rd Omni', shortLabel: 'Pa3O', title: 'Past 3rd Omni' },
  'past-mixed': { label: 'Past Mixed', shortLabel: 'PaM', title: 'Past Mixed' },
  'present-first-person': { label: 'Present 1st', shortLabel: 'Pr1', title: 'Present 1st Person' },
  'present-second-person': { label: 'Present 2nd', shortLabel: 'Pr2', title: 'Present 2nd Person' },
  'present-third-limited': { label: 'Present 3rd Limited', shortLabel: 'Pr3L', title: 'Present 3rd Limited' },
  'present-third-omniscient': { label: 'Present 3rd Omni', shortLabel: 'Pr3O', title: 'Present 3rd Omni' },
  'present-mixed': { label: 'Present Mixed', shortLabel: 'PrM', title: 'Present Mixed' }
});
```

- [ ] **Step 4: Add split/combine helpers**

In `src/ui.mjs`, replace `normalizeStoryFormOverride()` and update `storyFormLabel()` with:

```js
function storyFormOverrideValues() {
  return Object.keys(STORY_FORM_LABELS);
}

function normalizeStoryFormOverride(value) {
  const text = cleanText(value, 'auto').toLowerCase();
  return Object.prototype.hasOwnProperty.call(STORY_FORM_LABELS, text) ? text : 'auto';
}

function splitStoryFormOverride(value) {
  const override = normalizeStoryFormOverride(value);
  if (override === 'auto') {
    return {
      override: 'auto',
      tense: DEFAULT_FORCED_STORY_FORM.tense,
      pov: DEFAULT_FORCED_STORY_FORM.pov,
      auto: true
    };
  }

  const [tense, ...povParts] = override.split('-');
  const pov = povParts.join('-');
  return {
    override,
    tense: tense === 'present' ? 'present' : 'past',
    pov: STORY_FORM_POV_OPTIONS.some((option) => option.value === pov) ? pov : DEFAULT_FORCED_STORY_FORM.pov,
    auto: false
  };
}

function combineStoryFormOverride(tense, pov) {
  const resolvedTense = tense === 'present' ? 'present' : 'past';
  const resolvedPov = STORY_FORM_POV_OPTIONS.some((option) => option.value === pov)
    ? pov
    : DEFAULT_FORCED_STORY_FORM.pov;
  return normalizeStoryFormOverride(`${resolvedTense}-${resolvedPov}`);
}

function resolveStoryFormOverride({ current = 'auto', tense = null, pov = null } = {}) {
  const parsed = splitStoryFormOverride(current);
  return combineStoryFormOverride(tense || parsed.tense, pov || parsed.pov);
}

function storyFormLabel(value, { compact = false } = {}) {
  const override = normalizeStoryFormOverride(value);
  const option = STORY_FORM_LABELS[override] || STORY_FORM_LABELS.auto;
  return compact && option.shortLabel ? option.shortLabel : option.label;
}
```

- [ ] **Step 5: Update any loops over the old flat options**

Replace loops like:

```js
for (const option of STORY_FORM_MENU_OPTIONS) {
  const node = root.querySelector(`[data-recursion-story-form-choice-${option.value}]`);
}
```

with loops over `storyFormOverrideValues()` or the two axis arrays depending on the use site.

- [ ] **Step 6: Run focused UI tests**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: helper tests PASS, rendering tests may still fail until Task 2 and Task 3 complete.

### Task 2: Axis Popover Rendering

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: helpers from Task 1.
- Produces: rendered Auto + Tense + Point of View popover with selected states.

- [ ] **Step 1: Add failing rendering tests**

In `tools/scripts/test-ui.mjs`, replace flat-list assertions with:

```js
const menuText = fakeDocument.textTree(root.querySelector('[data-recursion-story-form-menu]'));
assert(menuText.includes('Auto'), 'story form menu includes Auto');
assert(menuText.includes('Tense'), 'story form menu includes Tense section');
assert(menuText.includes('Past'), 'story form menu includes Past tense');
assert(menuText.includes('Present'), 'story form menu includes Present tense');
assert(menuText.includes('Point of View'), 'story form menu includes POV section');
assert(menuText.includes('1st'), 'story form menu includes first-person POV');
assert(menuText.includes('2nd'), 'story form menu includes second-person POV');
assert(menuText.includes('3rd Ltd'), 'story form menu includes third-person limited POV');
assert(menuText.includes('3rd Omni'), 'story form menu includes third-person omniscient POV');
assert(menuText.includes('Mixed'), 'story form menu includes mixed POV');
assertEqual(root.querySelectorAll('[data-recursion-story-form-choice]').length, 0, 'story form menu no longer renders flat combined choices');
```

Add selected-state assertions:

```js
view = { ...view, settings: { ...view.settings, storyFormOverride: 'present-mixed' } };
ui.update(view);
assertEqual(root.querySelector('[data-recursion-story-form-auto-choice]').getAttribute('aria-pressed'), 'false', 'Auto is not selected for forced story form');
assertEqual(root.querySelector('[data-recursion-story-form-tense="present"]').getAttribute('aria-pressed'), 'true', 'present tense is selected');
assertEqual(root.querySelector('[data-recursion-story-form-pov="mixed"]').getAttribute('aria-pressed'), 'true', 'mixed POV is selected');

view = { ...view, settings: { ...view.settings, storyFormOverride: 'auto' } };
ui.update(view);
assertEqual(root.querySelector('[data-recursion-story-form-auto-choice]').getAttribute('aria-pressed'), 'true', 'Auto is selected for automatic story form');
assertEqual(root.querySelector('[data-recursion-story-form-tense="present"]').getAttribute('aria-pressed'), 'false', 'no forced tense selected in Auto');
assertEqual(root.querySelector('[data-recursion-story-form-pov="mixed"]').getAttribute('aria-pressed'), 'false', 'no forced POV selected in Auto');
```

- [ ] **Step 2: Run the failing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: FAIL because the menu still renders flat choices.

- [ ] **Step 3: Replace `storyFormMenuChoice()` with axis renderers**

In `src/ui.mjs`, replace `storyFormMenuChoice(option)` with:

```js
function storyFormAutoChoice() {
  return el('button', {
    className: 'recursion-story-form-auto-choice',
    attrs: {
      type: 'button',
      title: 'Let Recursion infer tense and POV from recent assistant narration.',
      'aria-pressed': 'false'
    },
    dataset: { recursionStoryFormAutoChoice: '' }
  }, [
    el('span', { className: 'recursion-story-form-choice-name', text: 'Auto' }),
    el('span', {
      className: 'recursion-story-form-choice-tip',
      text: 'Infer tense and POV from recent assistant narration.'
    })
  ]);
}

function storyFormAxisChoice(option, axis) {
  return el('button', {
    className: 'recursion-story-form-axis-choice',
    attrs: {
      type: 'button',
      title: option.title,
      'aria-pressed': 'false'
    },
    dataset: axis === 'tense'
      ? { recursionStoryFormTense: option.value }
      : { recursionStoryFormPov: option.value }
  }, [
    el('span', { className: 'recursion-story-form-axis-label', text: option.label }),
    option.tip ? el('span', { className: 'recursion-story-form-axis-tip', text: option.tip }) : null
  ].filter(Boolean));
}

function storyFormMenu() {
  return [
    storyFormAutoChoice(),
    el('div', { className: 'recursion-story-form-section' }, [
      el('div', { className: 'recursion-story-form-section-label', text: 'Tense' }),
      el('div', { className: 'recursion-story-form-axis-grid recursion-story-form-axis-grid-tense' },
        STORY_FORM_TENSE_OPTIONS.map((option) => storyFormAxisChoice(option, 'tense')))
    ]),
    el('div', { className: 'recursion-story-form-section' }, [
      el('div', { className: 'recursion-story-form-section-label', text: 'Point of View' }),
      el('div', { className: 'recursion-story-form-axis-grid recursion-story-form-axis-grid-pov' },
        STORY_FORM_POV_OPTIONS.map((option) => storyFormAxisChoice(option, 'pov')))
    ])
  ];
}
```

- [ ] **Step 4: Update menu construction**

In the Recursion Bar render tree, replace:

```js
el('div', { className: 'recursion-story-form-menu', attrs: { 'aria-label': 'Tense and POV selector' }, dataset: { recursionStoryFormMenu: '' } },
  STORY_FORM_MENU_OPTIONS.map(storyFormMenuChoice))
```

with:

```js
el('div', {
  className: 'recursion-story-form-menu',
  attrs: { 'aria-label': 'Tense and POV selector' },
  dataset: { recursionStoryFormMenu: '' }
}, storyFormMenu())
```

- [ ] **Step 5: Add CSS for the new menu**

In `styles/recursion.css`, update the story-form menu block:

```css
.recursion-story-form-menu {
  width: 248px;
  padding: 6px;
}

.recursion-story-form-auto-choice,
.recursion-story-form-axis-choice {
  width: 100%;
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 5px;
  background: rgba(255, 255, 255, .025);
  color: inherit;
  font: inherit;
  text-align: left;
}

.recursion-story-form-auto-choice {
  display: grid;
  gap: 2px;
  min-height: 36px;
  padding: 6px 7px;
}

.recursion-story-form-section {
  margin-top: 7px;
}

.recursion-story-form-section-label {
  margin: 0 1px 4px;
  color: rgba(224, 224, 224, .58);
  font-size: 10px;
  line-height: 1.2;
}

.recursion-story-form-axis-grid {
  display: grid;
  gap: 4px;
}

.recursion-story-form-axis-grid-tense {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.recursion-story-form-axis-grid-pov {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.recursion-story-form-axis-choice {
  min-height: 26px;
  padding: 4px 6px;
  text-align: center;
}

.recursion-story-form-axis-label {
  display: block;
  overflow-wrap: anywhere;
  line-height: 1.15;
}

.recursion-story-form-auto-choice[aria-pressed="true"],
.recursion-story-form-axis-choice[aria-pressed="true"] {
  border-color: rgba(101, 216, 232, .34);
  background: rgba(101, 216, 232, .075);
  box-shadow: inset 2px 0 0 rgba(101, 216, 232, .44);
}
```

- [ ] **Step 6: Run focused UI tests**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: rendering assertions PASS.

### Task 3: Axis Selection Behavior

**Files:**
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: `runtime.updateSettings()` and helpers from Task 1.
- Produces: immediate settings updates for Auto, tense, and POV choices with correct menu close behavior.

- [ ] **Step 1: Add failing click behavior tests**

In `tools/scripts/test-ui.mjs`, add click assertions using the existing fake runtime pattern:

```js
view = { ...view, settings: { ...view.settings, storyFormOverride: 'past-third-limited' } };
ui.update(view);
root.querySelector('[data-recursion-story-form-tense="present"]').click();
assertEqual(lastSettingsPatch.storyFormOverride, 'present-third-limited', 'clicking Present preserves current POV');
assertEqual(root.querySelector('[data-recursion-story-form-menu]').hidden, false, 'forced tense click keeps story form menu open');

view = { ...view, settings: { ...view.settings, storyFormOverride: 'present-third-limited' } };
ui.update(view);
root.querySelector('[data-recursion-story-form-pov="mixed"]').click();
assertEqual(lastSettingsPatch.storyFormOverride, 'present-mixed', 'clicking Mixed preserves current tense');
assertEqual(root.querySelector('[data-recursion-story-form-menu]').hidden, false, 'forced POV click keeps story form menu open');

view = { ...view, settings: { ...view.settings, storyFormOverride: 'auto' } };
ui.update(view);
root.querySelector('[data-recursion-story-form-pov="mixed"]').click();
assertEqual(lastSettingsPatch.storyFormOverride, 'past-mixed', 'clicking Mixed from Auto uses default past tense');

root.querySelector('[data-recursion-story-form-auto-choice]').click();
assertEqual(lastSettingsPatch.storyFormOverride, 'auto', 'clicking Auto saves auto story form');
assertEqual(root.querySelector('[data-recursion-story-form-menu]').hidden, true, 'clicking Auto closes story form menu');
```

Use the exact existing test variables for runtime patches instead of introducing `lastSettingsPatch` if the file already names it differently.

- [ ] **Step 2: Run the failing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: FAIL until click handling understands axis buttons.

- [ ] **Step 3: Update click handling**

In the root click handler in `src/ui.mjs`, replace the flat choice block:

```js
const storyFormChoice = control('recursionStoryFormChoice');
if (storyFormChoice) {
  runAction(runtime?.updateSettings?.({ storyFormOverride: normalizeStoryFormOverride(storyFormChoice.dataset.recursionStoryFormChoice) }));
  setStoryFormMenuOpen(false);
}
```

with:

```js
const storyFormAutoChoice = control('recursionStoryFormAutoChoice');
if (storyFormAutoChoice) {
  runAction(runtime?.updateSettings?.({ storyFormOverride: 'auto' }));
  setStoryFormMenuOpen(false);
}

const storyFormTenseChoice = control('recursionStoryFormTense');
if (storyFormTenseChoice) {
  const current = normalizeStoryFormOverride(currentView().settings?.storyFormOverride);
  runAction(runtime?.updateSettings?.({
    storyFormOverride: resolveStoryFormOverride({
      current,
      tense: storyFormTenseChoice.dataset.recursionStoryFormTense
    })
  }));
}

const storyFormPovChoice = control('recursionStoryFormPov');
if (storyFormPovChoice) {
  const current = normalizeStoryFormOverride(currentView().settings?.storyFormOverride);
  runAction(runtime?.updateSettings?.({
    storyFormOverride: resolveStoryFormOverride({
      current,
      pov: storyFormPovChoice.dataset.recursionStoryFormPov
    })
  }));
}
```

Do not close the menu after tense or POV clicks.

- [ ] **Step 4: Update selected-state rendering**

Replace `renderStoryFormMenuSelection(storyFormOverride)` with:

```js
function renderStoryFormMenuSelection(storyFormOverride) {
  const parsed = splitStoryFormOverride(storyFormOverride);
  const autoChoice = root.querySelector('[data-recursion-story-form-auto-choice]');
  if (autoChoice) {
    autoChoice.setAttribute('aria-pressed', parsed.auto ? 'true' : 'false');
    autoChoice.className = parsed.auto ? 'recursion-story-form-auto-choice is-selected' : 'recursion-story-form-auto-choice';
  }

  for (const choice of root.querySelectorAll('[data-recursion-story-form-tense]')) {
    const selected = !parsed.auto && choice.dataset.recursionStoryFormTense === parsed.tense;
    choice.setAttribute('aria-pressed', selected ? 'true' : 'false');
    choice.className = selected ? 'recursion-story-form-axis-choice is-selected' : 'recursion-story-form-axis-choice';
  }

  for (const choice of root.querySelectorAll('[data-recursion-story-form-pov]')) {
    const selected = !parsed.auto && choice.dataset.recursionStoryFormPov === parsed.pov;
    choice.setAttribute('aria-pressed', selected ? 'true' : 'false');
    choice.className = selected ? 'recursion-story-form-axis-choice is-selected' : 'recursion-story-form-axis-choice';
  }
}
```

- [ ] **Step 5: Run focused UI tests**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: PASS.

### Task 4: UI Spec Update

**Files:**
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/superpowers/specs/2026-07-10-recursion-story-form-selector-redesign-design.md`
- Modify: `docs/superpowers/plans/2026-07-10-recursion-story-form-selector-redesign.md`

**Interfaces:**
- Consumes: implemented UI behavior from Tasks 1-3.
- Produces: canonical docs matching the new selector.

- [ ] **Step 1: Update `docs/design/UI_SPEC.md` Tense & PoV section**

Replace the current flat menu paragraph with:

```markdown
The selector menu contains one `Auto` row and two forced axes:

- `Auto`: Arbiter infers tense and POV from the latest visible assistant narration.
- `Tense`: `Past` or `Present`.
- `Point of View`: `1st`, `2nd`, `3rd Ltd`, `3rd Omni`, or `Mixed`.

Selecting `Auto` stores no forced story form and closes the menu. Selecting a tense or POV stores a complete forced story form by combining that axis with the currently forced other axis. If the current value is `Auto`, the missing forced axis defaults to `past-third-limited`: choosing `Present` from `Auto` stores `present-third-limited`, and choosing `Mixed` from `Auto` stores `past-mixed`. Forced-axis clicks keep the menu open so the operator can adjust both axes.
```

Keep the existing shorthand list.

- [ ] **Step 2: Verify docs do not describe the old flat list as canonical**

Run:

```powershell
rg "Past 1st.*Present Mixed|Past Mixed.*Present Mixed|flat list|Menu order" docs\design docs\user docs\superpowers
```

Expected: any remaining references either describe the override enum/runtime values or are updated to describe the new axis selector.

- [ ] **Step 3: Run docs whitespace check**

Run:

```powershell
git diff --check -- docs\design\UI_SPEC.md docs\superpowers\specs\2026-07-10-recursion-story-form-selector-redesign-design.md docs\superpowers\plans\2026-07-10-recursion-story-form-selector-redesign.md
```

Expected: no whitespace errors.

- [ ] **Step 4: Commit docs and implementation together**

Run:

```powershell
git add src\ui.mjs styles\recursion.css tools\scripts\test-ui.mjs docs\design\UI_SPEC.md docs\superpowers\specs\2026-07-10-recursion-story-form-selector-redesign-design.md docs\superpowers\plans\2026-07-10-recursion-story-form-selector-redesign.md
git commit -m "feat: redesign story form selector"
```

### Task 5: Final Verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: all completed tasks.
- Produces: evidence that the redesign is correct in focused and broad tests.

- [ ] **Step 1: Run focused UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: PASS.

- [ ] **Step 2: Run runtime/settings smoke tests**

Run:

```powershell
node tools\scripts\test-settings.mjs
node tools\scripts\test-runtime.mjs
```

Expected: PASS. These should not require code changes for the UI-only redesign, but they prove the saved override values still normalize and flow.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm.cmd test
```

Expected: PASS.

- [ ] **Step 4: Run final whitespace check**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 5: Optional live UI proof**

If validating in SillyTavern, sync the served extension copy from `F:\git\Recursion` using the current repo-to-served procedure, open the actual Recursion bar, and verify:

```text
Auto row visible.
Tense row visible with Past and Present.
Point of View row visible with 1st, 2nd, 3rd Ltd, 3rd Omni, Mixed.
Forced-axis clicks update the compact bar label.
Auto closes the popover.
Esc and outside click close the popover.
```

## Self-Review

- Spec coverage: Auto behavior, separate axes, complete-pair mapping, default forced pair, selected states, accessibility, CSS shape, docs, and verification are each covered.
- Placeholder scan: no placeholder tasks remain.
- Type consistency: the plan consistently uses `storyFormOverride`, `past-third-limited`, `present-mixed`, `DEFAULT_FORCED_STORY_FORM`, `STORY_FORM_TENSE_OPTIONS`, and `STORY_FORM_POV_OPTIONS`.
