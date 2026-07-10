# Recursion Mixed POV Auto Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class mixed POV support to the Tense & PoV override system and make Auto mode detect intentional hybrid viewpoint without false positives from dialogue or pending user text.

**Architecture:** Extend `src/story-form.mjs` as the canonical story-form module, keeping tense and POV as separate axes. Add mixed override values, segment-based POV heuristic support, Arbiter prompt examples, UI menu rows, and runtime tests so Standard and Rapid paths carry the same normalized story form.

**Tech Stack:** JavaScript ES modules, Recursion compact SillyTavern UI, Node test scripts under `tools/scripts`, CSS in `styles/recursion.css`.

## Global Constraints

- Recursion is pre-alpha; update contracts in place and do not add legacy compatibility aliases.
- Mixed POV is a POV value, not a tense value.
- Auto mode infers from recent assistant narration first.
- Pending user message style is ignored when assistant narration exists.
- Dialogue pronouns must not produce mixed POV by themselves.
- Desktop Tense & PoV labels must fit without clipping.
- Mobile Tense & PoV labels use shorthand.
- `storyFormOverride` must flow through settings, cache signatures, Rapid signatures, Prompt Packet diagnostics, and safe settings view.

---

## File Structure

- Modify `src/story-form.mjs`: add mixed override values, forced-form mapping, segment-based narrative POV helpers, mixed Auto heuristics, and Arbiter prompt examples.
- Modify `src/settings.mjs`: normalize the expanded override enum.
- Modify `src/runtime.mjs`: ensure mixed override and Auto mixed story forms flow through Standard, Rapid warm, safe settings, cache signatures, and diagnostics.
- Modify `src/ui.mjs`: add `Past Mixed` and `Present Mixed` menu options and shorthand labels.
- Modify `styles/recursion.css`: keep Tense & PoV button flexible on desktop and compact on mobile.
- Modify `tools/scripts/test-story-form.mjs`: add focused contract and heuristic tests.
- Modify `tools/scripts/test-runtime.mjs`: add Standard/Rapid mixed override and Auto mixed flow tests.
- Modify `tools/scripts/test-ui.mjs`: add menu, selected state, order, and responsive label tests.
- Modify `docs/design/UI_SPEC.md`: update the canonical Tense & PoV selector option list and shorthand contract.

### Task 1: Mixed Override Contract

**Files:**
- Modify: `src/story-form.mjs`
- Modify: `src/settings.mjs`
- Modify: `tools/scripts/test-story-form.mjs`

**Interfaces:**
- Consumes: existing `STORY_FORM_OVERRIDE_OPTIONS`, `forcedStoryForm(value)`, and settings normalization.
- Produces: `past-mixed` and `present-mixed` override values that normalize to high-confidence mixed POV story forms.

- [ ] **Step 1: Add failing override tests**

Add assertions to `tools/scripts/test-story-form.mjs`:

```js
assert(STORY_FORM_OVERRIDE_OPTIONS.includes('past-mixed'), 'override options include past mixed POV');
assert(STORY_FORM_OVERRIDE_OPTIONS.includes('present-mixed'), 'override options include present mixed POV');

assertDeepEqual(
  forcedStoryForm('past-mixed'),
  {
    schema: STORY_FORM_SCHEMA,
    tense: 'past',
    pov: 'mixed',
    confidence: 'high',
    evidenceRefs: [],
    reason: 'User forced past tense, mixed POV.'
  },
  'past mixed override creates a high-confidence mixed story form'
);

assertDeepEqual(
  forcedStoryForm('present-mixed'),
  {
    schema: STORY_FORM_SCHEMA,
    tense: 'present',
    pov: 'mixed',
    confidence: 'high',
    evidenceRefs: [],
    reason: 'User forced present tense, mixed POV.'
  },
  'present mixed override creates a high-confidence mixed story form'
);
```

- [ ] **Step 2: Run the failing focused test**

Run:

```powershell
node tools\scripts\test-story-form.mjs
```

Expected: FAIL because the mixed override values are missing or return `null`.

- [ ] **Step 3: Implement the mixed override values**

In `src/story-form.mjs`, extend `STORY_FORM_OVERRIDE_OPTIONS`:

```js
export const STORY_FORM_OVERRIDE_OPTIONS = Object.freeze([
  'auto',
  'past-first-person',
  'past-second-person',
  'past-third-limited',
  'past-third-omniscient',
  'past-mixed',
  'present-first-person',
  'present-second-person',
  'present-third-limited',
  'present-third-omniscient',
  'present-mixed'
]);
```

Extend the forced-form map used by `forcedStoryForm(value)`:

```js
const FORCED_STORY_FORM_MAP = Object.freeze({
  'past-first-person': ['past', 'first-person', 'User forced past tense, first-person POV.'],
  'past-second-person': ['past', 'second-person', 'User forced past tense, second-person POV.'],
  'past-third-limited': ['past', 'third-person-limited', 'User forced past tense, third-person-limited POV.'],
  'past-third-omniscient': ['past', 'third-person-omniscient', 'User forced past tense, third-person-omniscient POV.'],
  'past-mixed': ['past', 'mixed', 'User forced past tense, mixed POV.'],
  'present-first-person': ['present', 'first-person', 'User forced present tense, first-person POV.'],
  'present-second-person': ['present', 'second-person', 'User forced present tense, second-person POV.'],
  'present-third-limited': ['present', 'third-person-limited', 'User forced present tense, third-person-limited POV.'],
  'present-third-omniscient': ['present', 'third-person-omniscient', 'User forced present tense, third-person-omniscient POV.'],
  'present-mixed': ['present', 'mixed', 'User forced present tense, mixed POV.']
});
```

- [ ] **Step 4: Verify settings normalization accepts the new values**

If `src/settings.mjs` imports `STORY_FORM_OVERRIDE_OPTIONS`, no extra implementation is needed beyond Task 1 Step 3. If it has a local allowlist, replace that allowlist with the imported `STORY_FORM_OVERRIDE_OPTIONS`.

Add a settings assertion where the existing settings tests live, or in the closest focused test script:

```js
const normalized = normalizeSettings({ storyFormOverride: 'present-mixed' });
assertEqual(normalized.storyFormOverride, 'present-mixed', 'settings preserve present mixed story-form override');
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node tools\scripts\test-story-form.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src\story-form.mjs src\settings.mjs tools\scripts\test-story-form.mjs
git commit -m "feat: add mixed story form overrides"
```

### Task 2: Narrative Segment POV Heuristic

**Files:**
- Modify: `src/story-form.mjs`
- Modify: `tools/scripts/test-story-form.mjs`

**Interfaces:**
- Consumes: existing `heuristicPov(text)` and `normalizeStoryFormWithHeuristic(storyForm, text)` behavior.
- Produces: mixed-aware POV classification that discounts dialogue and pending-user contamination.

- [ ] **Step 1: Add failing heuristic tests**

Add tests to `tools/scripts/test-story-form.mjs`:

```js
assertEqual(
  heuristicPov('You cross the room. Mara watches from the doorway, her fingers tight around the key. You hear the lock turn. Mara thinks the sound came too soon.'),
  'mixed',
  'heuristic detects present mixed POV across narrative segments'
);

assertEqual(
  heuristicPov('I crossed the room and remembered the old oath. Mara watched from the doorway, her fingers tight around the key. I knew the lock would turn. Mara feared the sound came too soon.'),
  'mixed',
  'heuristic detects past mixed POV across narrative segments'
);

assertEqual(
  heuristicPov('"I saw you," Mara said. "You saw me too." She crossed the room and opened the door.'),
  'third-person-limited',
  'dialogue pronouns do not create mixed POV'
);

const mixedCrossCheck = normalizeStoryFormWithHeuristic({
  schema: STORY_FORM_SCHEMA,
  tense: 'present',
  pov: 'second-person',
  confidence: 'medium',
  evidenceRefs: ['message:10'],
  reason: 'Arbiter saw second person.'
}, 'You cross the room. Mara watches from the doorway, her fingers tight around the key. You hear the lock turn. Mara thinks the sound came too soon.');

assertEqual(mixedCrossCheck.pov, 'mixed', 'heuristic can normalize medium-confidence single POV to mixed when narrative evidence supports it');
assertEqual(mixedCrossCheck.tense, 'present', 'mixed POV cross-check preserves stable tense');
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
node tools\scripts\test-story-form.mjs
```

Expected: FAIL on mixed POV assertions.

- [ ] **Step 3: Add narrative cleanup helpers**

In `src/story-form.mjs`, add helpers near the existing heuristic functions:

```js
function stripCodeBlocks(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ');
}

function stripQuotedDialogue(text) {
  return String(text || '')
    .replace(/"[^"\n]*(?:\n[^"\n]*)?"/g, ' ')
    .replace(/'[^'\n]{2,}'/g, ' ');
}

function narrativeSegments(text) {
  return stripQuotedDialogue(stripCodeBlocks(text))
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 16)
    .slice(-12);
}
```

- [ ] **Step 4: Add segment classification**

In `src/story-form.mjs`, add:

```js
function classifyPovSegment(segment) {
  const text = ` ${String(segment || '').toLowerCase()} `;
  const first = /\b(i|me|my|mine|we|us|our|ours)\b/.test(text);
  const second = /\b(you|your|yours)\b/.test(text);
  const third = /\b(he|she|they|him|her|them|his|hers|their|theirs|mara|character|npc)\b/.test(text);
  const interior = /\b(thinks?|thought|knows?|knew|feels?|felt|realizes?|realized|remembers?|remembered|wonders?|wondered|fears?|feared|hopes?|hoped)\b/.test(text);

  if (first && !second && !third) return 'first-person';
  if (second && !first && !third) return 'second-person';
  if (third && interior) return 'third-person-limited';
  if (third) return 'third-person-limited';
  return 'unknown';
}
```

Use repo-specific names only in tests if needed. If the existing heuristic already avoids named-character checks, keep that pattern and classify third person through pronouns and verb posture instead.

- [ ] **Step 5: Implement mixed decision**

Update `heuristicPov(text)` to count segment classifications:

```js
export function heuristicPov(text) {
  const counts = new Map();
  for (const segment of narrativeSegments(text)) {
    const pov = classifyPovSegment(segment);
    if (pov === 'unknown') continue;
    counts.set(pov, (counts.get(pov) || 0) + 1);
  }

  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total <= 0) return 'unknown';

  if (entries.length >= 2) {
    const dominant = entries[0][1];
    const secondary = entries[1][1];
    if (total >= 3 && (secondary >= 2 || secondary / total >= 0.25) && dominant / total <= 0.85) {
      return 'mixed';
    }
  }

  return entries[0][0];
}
```

If existing `heuristicPov()` has stronger local logic, preserve it and add the mixed branch at the point where classifications are available.

- [ ] **Step 6: Update cross-check policy**

Update `normalizeStoryFormWithHeuristic()` so it treats `mixed` as a first-class POV:

```js
if (heuristic.pov === 'mixed' && form.pov !== 'mixed' && form.confidence !== 'high') {
  return {
    ...form,
    pov: 'mixed',
    confidence: 'medium',
    reason: `${form.reason} Local narrative heuristic found mixed POV evidence.`
  };
}

if (form.pov === 'mixed' && heuristic.pov !== 'unknown') {
  return form;
}
```

Use the existing function's naming and confidence helpers rather than duplicating code if they already exist.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
node tools\scripts\test-story-form.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add src\story-form.mjs tools\scripts\test-story-form.mjs
git commit -m "feat: detect mixed POV in story form auto"
```

### Task 3: Arbiter And Prompt Copy

**Files:**
- Modify: `src/story-form.mjs`
- Modify: `tools/scripts/test-story-form.mjs`

**Interfaces:**
- Consumes: `arbiterStoryFormContractLine()`, `storyFormInstruction(storyForm)`, and story-form prompt block helpers.
- Produces: prompt text that names mixed POV precisely and avoids treating it as style coaching.

- [ ] **Step 1: Add failing prompt-copy tests**

Add assertions:

```js
const contract = arbiterStoryFormContractLine();
assert(contract.includes('intentional alternation between narrative viewpoint families'), 'Arbiter contract defines mixed POV');
assert(contract.includes('Do not infer mixed POV from dialogue pronouns'), 'Arbiter contract rejects dialogue false positives');
assert(contract.includes('present+mixed or past+mixed'), 'Arbiter contract keeps tense separate from mixed POV');

const presentMixed = forcedStoryForm('present-mixed');
assert(storyFormInstruction(presentMixed).includes('present tense, mixed POV'), 'mixed instruction names present mixed POV');
assert(storyFormPromptBlock(presentMixed).includes('Preserve the established mixed POV pattern'), 'mixed prompt block preserves hybrid pattern');
assert(storyFormPromptBlock(presentMixed).includes('Do not collapse'), 'mixed prompt block prevents single-POV collapse');
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
node tools\scripts\test-story-form.mjs
```

Expected: FAIL until prompt copy is expanded.

- [ ] **Step 3: Update Arbiter contract copy**

In `arbiterStoryFormContractLine()`, include these bullets:

```text
- Treat mixed POV as intentional alternation between narrative viewpoint families in assistant prose.
- Do not infer mixed POV from dialogue pronouns, user instructions, or one-off wording.
- Prefer present+mixed or past+mixed when tense is stable but viewpoint family alternates.
```

- [ ] **Step 4: Update mixed prompt block copy**

In `storyFormPromptBlock(storyForm)`, append mixed-only bullets when `form.pov === 'mixed'`:

```js
if (form.pov === 'mixed') {
  lines.push('- Preserve the established mixed POV pattern.');
  lines.push('- Do not collapse the reply into a single viewpoint family unless the chat itself has shifted.');
  lines.push('- Do not infer hidden thoughts unless the established mixed viewpoint already permits them.');
}
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node tools\scripts\test-story-form.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src\story-form.mjs tools\scripts\test-story-form.mjs
git commit -m "docs: clarify mixed POV prompt contract"
```

### Task 4: Runtime Standard And Rapid Flow

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Consumes: `forcedStoryForm("present-mixed")`, `normalizeStoryFormWithHeuristic()`, and `settings.storyFormOverride`.
- Produces: mixed story form in Standard packet metadata, Rapid warm artifacts, cache signatures, and safe settings view.

- [ ] **Step 1: Add failing runtime tests**

Add focused cases to `tools/scripts/test-runtime.mjs` following the existing story-form override tests:

```js
await runtime.configure({ storyFormOverride: 'present-mixed' });
await runtime.generateForTurn({ userText: 'Continue.' });

const packet = runtime.view().lastPacket;
assertEqual(packet.storyForm.tense, 'present', 'present mixed override reaches packet tense');
assertEqual(packet.storyForm.pov, 'mixed', 'present mixed override reaches packet POV');
assertEqual(packet.diagnostics.storyFormPov, 'mixed', 'packet diagnostics expose mixed POV');

const settingsView = runtime.view().settings;
assertEqual(settingsView.storyFormOverride, 'present-mixed', 'safe settings view exposes present mixed override');
```

Add a Rapid warm signature assertion using the existing helper pattern:

```js
const autoWarm = rapidWarmSettingsSignature({ storyFormOverride: 'auto' });
const mixedWarm = rapidWarmSettingsSignature({ storyFormOverride: 'present-mixed' });
assert(autoWarm !== mixedWarm, 'Rapid warm signature changes for present mixed override');
```

- [ ] **Step 2: Run the failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: FAIL if any runtime path rejects or drops the new override.

- [ ] **Step 3: Update runtime allowlists and signatures**

If `src/runtime.mjs` contains local validation for story-form override values, replace it with `STORY_FORM_OVERRIDE_OPTIONS` from `src/story-form.mjs`.

Confirm these signatures include `storyFormOverride`:

```js
cacheSettingsSignature(settings)
rapidWarmSettingsSignature(settings)
```

No new signature field is needed if they already serialize `settings.storyFormOverride`; the expanded enum makes the new values distinct.

- [ ] **Step 4: Ensure Standard and Rapid use forced mixed**

In the main generation path and Rapid warm path, confirm this pattern handles mixed values:

```js
const forced = forcedStoryForm(settings.storyFormOverride);
const storyForm = forced || normalizeStoryFormWithHeuristic(arbiterStoryForm, assistantNarrationText);
```

Do not special-case mixed after `forcedStoryForm()` returns a normalized story form.

- [ ] **Step 5: Run focused runtime tests**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src\runtime.mjs tools\scripts\test-runtime.mjs
git commit -m "feat: carry mixed POV through runtime"
```

### Task 5: Tense & PoV UI Options

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: `settings.storyFormOverride` values and existing Tense & PoV dropdown helpers.
- Produces: menu rows for `Past Mixed` and `Present Mixed`, desktop labels that fit, and mobile shorthand `PaM` and `PrM`.

- [ ] **Step 1: Add failing UI tests**

Add assertions to `tools/scripts/test-ui.mjs` near the existing story-form menu tests:

```js
assert(html.includes('Past Mixed'), 'story form menu includes Past Mixed');
assert(html.includes('Present Mixed'), 'story form menu includes Present Mixed');
assert(html.includes('PaM'), 'story form UI supports Past Mixed shorthand');
assert(html.includes('PrM'), 'story form UI supports Present Mixed shorthand');

const storyFormOptions = [
  'Auto',
  'Past 1st',
  'Past 2nd',
  'Past 3rd Limited',
  'Past 3rd Omni',
  'Past Mixed',
  'Present 1st',
  'Present 2nd',
  'Present 3rd Limited',
  'Present 3rd Omni',
  'Present Mixed'
];

assertOrdered(html, storyFormOptions, 'story form options appear in canonical menu order');
```

Use the existing fixture and assertion helpers in the file rather than introducing new DOM tooling.

- [ ] **Step 2: Run the failing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: FAIL until the options are added.

- [ ] **Step 3: Update menu options**

In `src/ui.mjs`, extend `STORY_FORM_MENU_OPTIONS`:

```js
{ value: 'past-mixed', label: 'Past Mixed', shortLabel: 'PaM', title: 'Past tense, mixed POV', tip: 'Preserve hybrid past-tense viewpoint' },
{ value: 'present-mixed', label: 'Present Mixed', shortLabel: 'PrM', title: 'Present tense, mixed POV', tip: 'Preserve hybrid present-tense viewpoint' }
```

Place `past-mixed` after `past-third-omniscient` and `present-mixed` after `present-third-omniscient`.

- [ ] **Step 4: Verify button label helpers**

Confirm `storyFormLabel(value, { compact: true })` returns `PaM` and `PrM`, while desktop returns `Past Mixed` and `Present Mixed`.

If the helper currently falls back to `option.label`, update it:

```js
function storyFormLabel(value, { compact = false } = {}) {
  const option = storyFormMenuChoice(value);
  return compact && option.shortLabel ? option.shortLabel : option.label;
}
```

- [ ] **Step 5: Confirm CSS still fits**

In `styles/recursion.css`, keep the desktop button flexible:

```css
.recursion-story-form-button {
  max-width: none;
  min-width: fit-content;
}
```

Keep the mobile cap:

```css
@media (max-width: 720px) {
  .recursion-story-form-button {
    min-width: 36px;
  }

  .recursion-story-form-text {
    max-width: 32px;
  }
}
```

- [ ] **Step 6: Run focused UI tests**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src\ui.mjs styles\recursion.css tools\scripts\test-ui.mjs
git commit -m "feat: add mixed POV UI choices"
```

### Task 6: Design Docs And Final Verification

**Files:**
- Modify: `docs/design/UI_SPEC.md`
- Modify: any prompt/runtime docs that already describe the story-form override list.

**Interfaces:**
- Consumes: the implemented mixed story-form behavior.
- Produces: canonical documentation matching the code and tests.

- [ ] **Step 1: Update UI spec option list**

In `docs/design/UI_SPEC.md`, update the Tense & PoV selector section so the menu list says:

```markdown
- `Auto`: Arbiter infers tense and POV from the latest visible assistant narration.
- `Past 1st`, `Past 2nd`, `Past 3rd Limited`, `Past 3rd Omni`, `Past Mixed`.
- `Present 1st`, `Present 2nd`, `Present 3rd Limited`, `Present 3rd Omni`, `Present Mixed`.
```

Update the shorthand list to include `PaM` and `PrM`.

- [ ] **Step 2: Update story-form technical docs if present**

Search:

```powershell
rg "storyFormOverride|Tense & PoV|story form|third-person-omniscient" docs
```

For any doc that lists the override enum, update it to include `past-mixed` and `present-mixed`. Do not add mixed POV copy to unrelated docs that only describe the broad Arbiter contract.

- [ ] **Step 3: Run focused tests**

Run:

```powershell
node tools\scripts\test-story-form.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-ui.mjs
```

Expected: all PASS.

- [ ] **Step 4: Run full suite**

Run:

```powershell
npm.cmd test
```

Expected: all configured scripts PASS.

- [ ] **Step 5: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors. PowerShell may print CRLF warnings for existing Windows-normalized files; those are acceptable if there are no whitespace error lines.

- [ ] **Step 6: Sync served copy if validating live UI**

If testing in the live SillyTavern extension, sync the changed files from `F:\git\Recursion` into the served extension copy and verify the browser menu. Use the existing repo-to-served sync procedure for this environment.

- [ ] **Step 7: Commit final docs**

Run:

```powershell
git add docs\design\UI_SPEC.md docs\superpowers\specs\2026-07-10-recursion-mixed-pov-auto-design.md docs\superpowers\plans\2026-07-10-recursion-mixed-pov-auto.md
git commit -m "docs: plan mixed POV auto support"
```

## Self-Review

- Spec coverage: forced mixed choices, Auto mixed detection, prompt wording, runtime flow, UI labels, CSS fit, documentation, and verification are each covered by a task.
- Placeholder scan: no placeholder tasks remain.
- Type consistency: the plan uses `past-mixed`, `present-mixed`, `pov: "mixed"`, and existing story-form helper names consistently.
