# Recursion Enhancements And Dialogue Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Prose Enhancement-only post-generation pass with a compact Enhancements system that supports Prose, Dialogue, and Prose + Dialogue targets with As Swipe or Replace application.

**Architecture:** Rename the setting/UI/runtime surface from `proseEnhancement` to `enhancements`, keep the existing Prose pass as one target, add a focused `dialogue-enhancement.mjs` module for prompt and validation, and route all targets through one runtime enhancement lifecycle. The SillyTavern host mutation methods stay shared; the runtime chooses the pass sequence, validates each pass, and applies one final result through As Swipe or Replace.

**Tech Stack:** JavaScript ES modules, Recursion settings/runtime/provider/UI modules, SillyTavern host adapter, deterministic Node tests, Playwright/live SillyTavern proof scripts, markdown docs.

## Global Constraints

- Recursion is pre-alpha; update code, docs, schemas, tests, and examples in place to the best current contract.
- UI must follow `DESIGN.md` and `docs/design/UI_SPEC.md`: SillyTavern-native, compact, graphite-dark, and operational.
- The compact bar has one icon-only `Enhancements` button in the current Prose Enhancement slot, immediately right of Cards and left of Tense & PoV.
- Settings contract is `enhancements: { target, applyMode, contextMessages }`.
- `target` values are exactly `off`, `prose`, `dialogue`, `prose-dialogue`.
- `applyMode` values are exactly `as-swipe`, `replace`.
- Default target is `off`; default apply mode is `as-swipe`; default context message count is `13`.
- Context message range is integer `0..35`.
- Dialogue Enhancement is one Utility call with two internal priorities: anti-slop repair first, natural/subtext repair second.
- Prose + Dialogue runs Dialogue first, then Prose, and applies one final result.
- Dialogue provider role is `dialogueEnhancer`; schema is `recursion.dialogueEnhancer.v1`.
- Prose provider role remains `proseEnhancer`; schema remains `recursion.proseEnhancer.v1`.
- Enhancement requests must not include raw prompt packets, raw provider responses, hidden reasoning, secrets, or unbounded transcript text.
- Journals and diagnostics must not persist raw original text, enhanced text, provider prompts, provider responses, full scene context, secrets, or hidden reasoning.
- `As Swipe` creates or selects one enhanced sibling per original hash and enhancement profile.
- `Replace` mutates the active assistant text only after validation.
- Failure, stale results, cancellation, provider unavailability, and validation rejection reveal the original unchanged.
- Recursion-owned latest-assistant update and swipe events caused by enhancement must not clear Last Brief or Prompt Packet state.

---

## File Structure

- `src/settings.mjs` - replace `proseEnhancement` normalization with `enhancements`.
- `src/prose-enhancement.mjs` - keep existing Prose prompt/validation exports, consumed by the new pipeline.
- `src/dialogue-enhancement.mjs` - new pure module for Dialogue prompt building, dialogue-focused slop rules, validation, and schema constants.
- `src/providers.mjs` - add `dialogueEnhancer` Utility role and response schema.
- `src/progress.mjs` - rename generic enhancement progress where needed and add `dialogue-enhancement`.
- `src/runtime.mjs` - replace prose-specific lifecycle helpers with enhancement target/apply-mode helpers and pass sequencing.
- `src/extension/index.js` - rename owned mutation/capture class/reasons from prose-specific to enhancement-generic.
- `src/ui.mjs` - rename the bar button/menu to Enhancements and render the Apply segmented control plus target rows.
- `styles/recursion.css` - rename selectors or add aliases only while code is updated in place; final DOM should use enhancement names.
- `tools/scripts/test-settings.mjs` - settings normalization coverage.
- `tools/scripts/test-providers.mjs` - provider role/schema coverage.
- `tools/scripts/test-dialogue-enhancement.mjs` - new pure Dialogue prompt/validation tests.
- `tools/scripts/test-prose-enhancement.mjs` - update expected integration copy under Enhancements where needed.
- `tools/scripts/test-runtime.mjs` - target sequencing, apply modes, cancellation, Rapid barrier, and owned mutation coverage.
- `tools/scripts/test-ui.mjs` - compact button/dropdown/settings tests.
- `tools/scripts/test-extension-smoke.mjs` - event-order and owned mutation smoke tests under the new naming.
- `tools/scripts/run-alpha-gate.mjs` - include `test-dialogue-enhancement.mjs`.
- `tools/scripts/prove-live-enhancements.mjs` - live proof for Dialogue and Prose + Dialogue.
- Documentation listed in Task 9.

---

### Task 1: Settings Contract

**Files:**
- Modify: `src/settings.mjs`
- Modify: `tools/scripts/test-settings.mjs`

**Interfaces:**
- Produces: `normalizeEnhancementsSettings(value) -> { target: 'off' | 'prose' | 'dialogue' | 'prose-dialogue', applyMode: 'as-swipe' | 'replace', contextMessages: number }`
- Produces setting path: `settings.enhancements`
- Consumed by: UI, runtime, settings store, safe view.

- [ ] **Step 1: Write failing settings tests**

Add the import if `normalizeEnhancementsSettings` is tested directly:

```js
import { normalizeEnhancementsSettings, normalizeSettings } from '../../src/settings.mjs';
```

Add assertions near the current Prose Enhancement settings tests, replacing those tests:

```js
assertDeepEqual(
  normalizeSettings({}).enhancements,
  { target: 'off', applyMode: 'as-swipe', contextMessages: 13 },
  'Enhancements default off with As Swipe preserved for the next enabled target'
);

assertDeepEqual(
  normalizeSettings({ enhancements: { target: 'dialogue', applyMode: 'replace', contextMessages: 21 } }).enhancements,
  { target: 'dialogue', applyMode: 'replace', contextMessages: 21 },
  'Enhancements accept Dialogue Replace with context count'
);

assertDeepEqual(
  normalizeSettings({ enhancements: { target: 'prose-dialogue', applyMode: 'as-swipe', contextMessages: '35' } }).enhancements,
  { target: 'prose-dialogue', applyMode: 'as-swipe', contextMessages: 35 },
  'Enhancements accept Prose + Dialogue with numeric string context'
);

assertDeepEqual(
  normalizeSettings({ enhancements: { target: 'custom-pass', applyMode: 'sidecar', contextMessages: 99 } }).enhancements,
  { target: 'off', applyMode: 'as-swipe', contextMessages: 35 },
  'Enhancements reject unsupported target and apply mode while clamping context'
);
```

- [ ] **Step 2: Run failing settings test**

Run:

```powershell
node tools\scripts\test-settings.mjs
```

Expected: failure because `settings.enhancements` and `normalizeEnhancementsSettings` do not exist.

- [ ] **Step 3: Implement settings normalization**

In `src/settings.mjs`, replace the Prose-specific constants:

```js
const ENHANCEMENT_TARGETS = new Set(['off', 'prose', 'dialogue', 'prose-dialogue']);
const ENHANCEMENT_APPLY_MODES = new Set(['as-swipe', 'replace']);
const ENHANCEMENT_CONTEXT_MIN = 0;
const ENHANCEMENT_CONTEXT_MAX = 35;
```

Replace `DEFAULT_RECURSION_SETTINGS.proseEnhancement` with:

```js
enhancements: {
  target: 'off',
  applyMode: 'as-swipe',
  contextMessages: 13
},
```

Replace `normalizeProseEnhancementSettings` with:

```js
export function normalizeEnhancementsSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    target: enumValue(source.target, ENHANCEMENT_TARGETS, DEFAULT_RECURSION_SETTINGS.enhancements.target),
    applyMode: enumValue(source.applyMode, ENHANCEMENT_APPLY_MODES, DEFAULT_RECURSION_SETTINGS.enhancements.applyMode),
    contextMessages: Math.round(numberInRange(
      source.contextMessages,
      DEFAULT_RECURSION_SETTINGS.enhancements.contextMessages,
      ENHANCEMENT_CONTEXT_MIN,
      ENHANCEMENT_CONTEXT_MAX
    ))
  };
}
```

In `normalizeSettings`, replace the Prose setting:

```js
enhancements: normalizeEnhancementsSettings(source.enhancements),
```

- [ ] **Step 4: Run passing settings test**

Run:

```powershell
node tools\scripts\test-settings.mjs
```

Expected: `[pass] settings`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/settings.mjs tools/scripts/test-settings.mjs
git commit -m "feat: add enhancements settings contract"
```

---

### Task 2: Dialogue Provider Role

**Files:**
- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-providers.mjs`

**Interfaces:**
- Produces Utility role: `dialogueEnhancer`
- Produces schema: `recursion.dialogueEnhancer.v1`
- Consumed by: `runtime.runEnhancementPassSequence(...)`.

- [ ] **Step 1: Write failing provider tests**

In `tools/scripts/test-providers.mjs`, add `dialogueEnhancer` to the expected Utility role list and schema assertions:

```js
assertEqual(roleLane('dialogueEnhancer'), 'utility', 'dialogueEnhancer defaults to Utility lane');
assertEqual(responseSchemaForRole('dialogueEnhancer'), 'recursion.dialogueEnhancer.v1', 'dialogueEnhancer schema is stable');
```

If the helper is named differently in the current test file, use the existing provider role schema helper that validates `proseEnhancer`.

Add a router generation assertion beside the Prose Enhancement provider test:

```js
const dialogueResult = await router.generate('dialogueEnhancer', {
  prompt: 'Repair dialogue.',
  responseSchema: 'recursion.dialogueEnhancer.v1',
  machineJson: true
});
assertEqual(dialogueResult.ok, true, 'dialogueEnhancer validates structured output');
assertEqual(dialogueResult.data.schema, 'recursion.dialogueEnhancer.v1', 'dialogueEnhancer accepts matching schema');
```

- [ ] **Step 2: Run failing provider test**

Run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: failure because `dialogueEnhancer` is unsupported.

- [ ] **Step 3: Add provider role**

In `src/providers.mjs`, add to `UTILITY_ROLE_IDS` immediately before `proseEnhancer`:

```js
'dialogueEnhancer',
```

Add to `ROLE_RESPONSE_SCHEMAS`:

```js
dialogueEnhancer: 'recursion.dialogueEnhancer.v1',
```

- [ ] **Step 4: Run passing provider test**

Run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: `[pass] providers`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/providers.mjs tools/scripts/test-providers.mjs
git commit -m "feat: add dialogue enhancer provider role"
```

---

### Task 3: Dialogue Enhancement Prompt And Validation

**Files:**
- Create: `src/dialogue-enhancement.mjs`
- Create: `tools/scripts/test-dialogue-enhancement.mjs`
- Modify: `tools/scripts/run-alpha-gate.mjs`

**Interfaces:**
- Produces constant: `DIALOGUE_ENHANCER_SCHEMA = 'recursion.dialogueEnhancer.v1'`
- Produces function: `buildDialogueEnhancementRequest({ text, contextMessages, contextMessageLimit, storyForm, characterContext, cardContext })`
- Produces function: `validateDialogueEnhancementResult(result, { originalText })`
- Consumes: `dialogueSpans(...)` from `src/prose-enhancement.mjs`
- Consumed by: runtime enhancement sequencing.

- [ ] **Step 1: Write failing pure module test**

Create `tools/scripts/test-dialogue-enhancement.mjs`:

```js
import {
  DIALOGUE_ENHANCER_SCHEMA,
  buildDialogueEnhancementRequest,
  validateDialogueEnhancementResult
} from '../../src/dialogue-enhancement.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const original = [
  'Mara set the cup down. "So that is what we are calling it now?"',
  'She smiled softly. "What do you want to do next?"'
].join('\n');

const request = buildDialogueEnhancementRequest({
  text: original,
  contextMessages: [
    { role: 'user', text: '"I did not say it was safe."' },
    { role: 'assistant', text: original }
  ],
  contextMessageLimit: 2,
  storyForm: { tense: 'past', pov: 'third-person-limited' },
  characterContext: {
    name: 'Mara',
    description: 'A guarded field medic who gives orders instead of reassurance.',
    exampleDialogue: ['"Sit down before you fall over."', '"We can argue after."']
  },
  cardContext: [
    { family: 'Social Subtext', text: 'Mara hides concern behind practical commands.' }
  ]
});

assertEqual(DIALOGUE_ENHANCER_SCHEMA, 'recursion.dialogueEnhancer.v1', 'dialogue enhancer schema is stable');
assert(request.prompt.includes('Echoing and parroting'), 'prompt names echoing priority');
assert(request.prompt.includes('Forced questions and fake agency'), 'prompt names fake agency priority');
assert(request.prompt.includes('Over-technical dialogue'), 'prompt names unsupported smart jargon priority');
assert(request.prompt.includes('Tsundere tropes'), 'prompt names defensive trope priority');
assert(request.prompt.includes('Attraction cliches'), 'prompt names attraction cliche priority');
assert(request.prompt.includes('What does the character want right now?'), 'prompt includes subtext reasoning ladder');
assert(request.prompt.includes('<text_to_transform>'), 'prompt marks transform text');
assertEqual(request.responseSchema, DIALOGUE_ENHANCER_SCHEMA, 'request carries response schema');
assertEqual(request.machineJson, true, 'request requires machine JSON');
assertEqual(request.contextMessages.length, 2, 'request respects bounded context');

const accepted = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: [
    'Mara set the cup down. "Call it whatever lets you sleep."',
    'She smiled softly. "Sit down before you fall over. We can argue after."'
  ].join('\n')
}, { originalText: original });
assertEqual(accepted.ok, true, 'validator accepts dialogue repair with stable narration shell');

const rejectedNarrationDrift = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: [
    'Mara hurled the cup into the wall. "Call it whatever lets you sleep."',
    'She crossed the room and locked the door. "Sit down before you fall over."'
  ].join('\n')
}, { originalText: original });
assertEqual(rejectedNarrationDrift.ok, false, 'validator rejects changed scene events outside dialogue-adjacent repair');
assertEqual(rejectedNarrationDrift.error.code, 'RECURSION_DIALOGUE_NARRATION_CHANGED', 'narration drift uses stable error code');

const rejectedSchema = validateDialogueEnhancementResult({
  schema: 'recursion.proseEnhancer.v1',
  text: original
}, { originalText: original });
assertEqual(rejectedSchema.ok, false, 'validator rejects wrong schema');

console.log('[pass] dialogue enhancement');
```

- [ ] **Step 2: Run failing pure module test**

Run:

```powershell
node tools\scripts\test-dialogue-enhancement.mjs
```

Expected: module-not-found failure for `src/dialogue-enhancement.mjs`.

- [ ] **Step 3: Implement prompt builder and validator**

Create `src/dialogue-enhancement.mjs`:

```js
import { compact, truncate } from './core.mjs';
import { dialogueSpans } from './prose-enhancement.mjs';

export const DIALOGUE_ENHANCER_SCHEMA = 'recursion.dialogueEnhancer.v1';

const MAX_CONTEXT_TEXT = 12000;
const MAX_TARGET_TEXT = 12000;
const SECRET_PATTERN = /(raw[-_\s]*prompt|rawPrompt|provider[-_\s]*response|hidden[-_\s]*reasoning|api[-_\s]*key|authorization|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]+)/ig;

const DIALOGUE_SLOP_RULES = String.raw`## Dialogue slop priorities

### Echoing and parroting
* repeats the user's exact phrase as a question
* restates the user's action before responding
* "So that's what we're calling it now?"
* "You really just said X."
* "You're either very X or very Y. Probably both."
* "No one ever X before."

### Forced questions and fake agency
* what do you say?
* what do you want?
* what now?
* your move
* the choice is yours
* do you want to X, or Y?
* where do we go from here?

### Over-technical dialogue for unsupported intelligent characters
* assessing variables
* recalibrating
* hypothesis
* data point
* optimal
* inefficient
* statistically
* tactically
* non-negotiable

### Tsundere tropes and stock defensive deflection
* it's not like I care
* don't get the wrong idea
* idiot
* I'm only doing this because
* you're impossible
* I hate that you're right

### Attraction cliches and lazy romance lines
* you're mine
* ruin you
* claim you
* devour you
* worship you
* you're going to be the death of me
* tell me what you want
* last chance to back out`;

function safeText(value, limit = MAX_CONTEXT_TEXT) {
  return truncate(compact(String(value ?? '').replace(SECRET_PATTERN, '[redacted]')), limit);
}

function contextLine(message = {}) {
  const role = ['assistant', 'user', 'system'].includes(String(message.role || '').toLowerCase())
    ? String(message.role).toLowerCase()
    : 'assistant';
  return `${role}: ${safeText(message.text ?? message.mes ?? message.content, 1200)}`;
}

function characterLines(characterContext = {}) {
  const source = characterContext && typeof characterContext === 'object' ? characterContext : {};
  const examples = Array.isArray(source.exampleDialogue) ? source.exampleDialogue.slice(0, 8).map((line) => `- ${safeText(line, 500)}`) : [];
  return [
    `Name: ${safeText(source.name || 'unknown', 120)}`,
    `Description: ${safeText(source.description || '', 1600)}`,
    'Example dialogue:',
    ...examples
  ].join('\n');
}

function cardLines(cardContext = []) {
  return (Array.isArray(cardContext) ? cardContext : [])
    .slice(0, 8)
    .map((card) => `- ${safeText(card.family || 'Context', 80)}: ${safeText(card.text || card.summary || '', 700)}`)
    .join('\n');
}

export function buildDialogueEnhancementRequest({
  text = '',
  contextMessages = [],
  contextMessageLimit = 13,
  storyForm = null,
  characterContext = {},
  cardContext = []
} = {}) {
  const targetText = truncate(String(text ?? '').replace(SECRET_PATTERN, '[redacted]'), MAX_TARGET_TEXT);
  const limit = Math.max(0, Math.min(35, Math.round(Number(contextMessageLimit) || 0)));
  const sceneContext = (Array.isArray(contextMessages) ? contextMessages : []).slice(-limit).map(contextLine).join('\n');
  const storyFormLine = storyForm && typeof storyForm === 'object'
    ? `Story form: ${safeText(JSON.stringify(storyForm), 600)}`
    : 'Story form: infer from source text.';
  const prompt = [
    'You are a dialogue consistency editor.',
    'Your job is to repair dialogue in <text_to_transform> without improving general prose.',
    'Return the full assistant message with repaired dialogue, not a diff.',
    '',
    'Hard rules:',
    '- Edit dialogue and only the smallest necessary dialogue-adjacent beat.',
    '- Do not restructure the scene.',
    '- Do not add facts, decisions, consent changes, relationship progress, names, locations, objects, or outcomes.',
    '- Do not make characters warmer, more helpful, more articulate, more romantic, or more emotionally honest unless character evidence supports it.',
    '- Preserve unresolved pressure unless character evidence supports resolution.',
    '',
    'Priority order for character signals:',
    '1. Example dialogue.',
    '2. Personality and description.',
    '3. Relevant Recursion card context.',
    '4. Recent visible scene context.',
    '5. General genre tone.',
    '',
    'Repair priorities:',
    '1. Echoing and parroting.',
    '2. Forced questions and fake agency.',
    '3. Over-technical dialogue for intelligent characters when unsupported by evidence.',
    '4. Tsundere tropes and defensive deflection unless established.',
    '5. Attraction cliches and lazy romance lines.',
    '',
    'Subtext pass:',
    '- What does the character want right now?',
    '- What are they unwilling to say directly?',
    '- What are they protecting: pride, safety, leverage, affection, secrecy, status, control?',
    '- What did the other character visibly feel or imply?',
    '- How would this character respond without naming all of that?',
    '',
    'Prefer indirect, motivated speech over explicit emotional explanation.',
    'Characters may dodge, understate, redirect, test, refuse, joke, threaten, soften, or act instead of confessing the obvious.',
    '',
    DIALOGUE_SLOP_RULES,
    '',
    storyFormLine,
    '<character_context>',
    characterLines(characterContext),
    '</character_context>',
    '<recursion_card_context>',
    cardLines(cardContext),
    '</recursion_card_context>',
    '<scene_context>',
    sceneContext,
    '</scene_context>',
    '<text_to_transform>',
    targetText,
    '</text_to_transform>',
    '',
    `Return strict JSON only: {"schema":"${DIALOGUE_ENHANCER_SCHEMA}","text":"rewritten full assistant message"}. No explanations, no notes, no commentary.`
  ].join('\n');
  return {
    prompt,
    responseSchema: DIALOGUE_ENHANCER_SCHEMA,
    responseLength: 4096,
    reasoningCategory: 'dialogue-enhancement',
    reasoningIntent: 'minimal',
    machineJson: true,
    contextMessages: (Array.isArray(contextMessages) ? contextMessages : []).slice(-limit)
  };
}

function validationError(code, message) {
  return { ok: false, error: { code, message } };
}

function nonDialogueText(text = '') {
  const source = String(text ?? '');
  const spans = dialogueSpans(source).sort((a, b) => a.start - b.start);
  let cursor = 0;
  const chunks = [];
  for (const span of spans) {
    chunks.push(source.slice(cursor, span.start).replace(/\s+/g, ' ').trim());
    cursor = span.end;
  }
  chunks.push(source.slice(cursor).replace(/\s+/g, ' ').trim());
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

export function validateDialogueEnhancementResult(result = {}, { originalText = '' } = {}) {
  const data = result && typeof result === 'object' ? result : {};
  if (data.schema !== DIALOGUE_ENHANCER_SCHEMA) {
    return validationError('RECURSION_DIALOGUE_SCHEMA_MISMATCH', 'Dialogue enhancement returned the wrong schema.');
  }
  const text = String(data.text ?? '');
  if (!text.trim()) return validationError('RECURSION_DIALOGUE_EMPTY', 'Dialogue enhancement returned empty text.');
  if (text.length > MAX_TARGET_TEXT) {
    return validationError('RECURSION_DIALOGUE_EXPANDED', 'Dialogue enhancement expanded the message too much.');
  }
  const originalDialogue = dialogueSpans(originalText);
  const nextDialogue = dialogueSpans(text);
  if (originalDialogue.length !== nextDialogue.length) {
    return validationError('RECURSION_DIALOGUE_STRUCTURE_CHANGED', 'Dialogue enhancement changed dialogue structure.');
  }
  if (nonDialogueText(originalText) !== nonDialogueText(text)) {
    return validationError('RECURSION_DIALOGUE_NARRATION_CHANGED', 'Dialogue enhancement changed narration outside dialogue repair.');
  }
  return { ok: true, text };
}
```

- [ ] **Step 4: Add focused test to alpha gate**

In `tools/scripts/run-alpha-gate.mjs`, add:

```js
'test-dialogue-enhancement.mjs',
```

beside `test-prose-enhancement.mjs`.

- [ ] **Step 5: Run passing tests**

Run:

```powershell
node tools\scripts\test-dialogue-enhancement.mjs
node tools\scripts\run-alpha-gate.mjs
```

Expected: `[pass] dialogue enhancement` and alpha gate success.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/dialogue-enhancement.mjs tools/scripts/test-dialogue-enhancement.mjs tools/scripts/run-alpha-gate.mjs
git commit -m "feat: add dialogue enhancement validation"
```

---

### Task 4: Runtime Enhancement Sequencing

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Produces: `enhancementsEnabled(settings) -> boolean`
- Produces: `enhancementApplyMode(settings) -> 'as-swipe' | 'replace'`
- Produces runtime method: `enhanceLatestAssistantMessage(details)`, retaining the public method name if extension callers already use it.
- Consumes: `buildDialogueEnhancementRequest`, `validateDialogueEnhancementResult`, `buildProseEnhancementRequest`, `validateProseEnhancementResult`.

- [ ] **Step 1: Write failing runtime tests**

Update existing Prose runtime tests to use `settings.enhancements`.

Add a Dialogue-only test near the current As Swipe Prose test:

```js
{
  const host = createProseMessageHarness('Mara set the cup down. "So that is what we are calling it now?"');
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: host.messages,
    generationRouter: {
      async generate(roleId, request, options) {
        roleCalls.push({ roleId, request, options });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'Mara set the cup down. "Call it whatever lets you sleep."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-as-swipe' });
  assertEqual(result.ok, true, 'Dialogue Enhancement returns success');
  assertEqual(result.target, 'dialogue', 'Dialogue result reports target');
  assertDeepEqual(roleCalls.map((call) => call.roleId), ['dialogueEnhancer'], 'Dialogue target calls only dialogueEnhancer');
  assertEqual(host.message.swipes[1], 'Mara set the cup down. "Call it whatever lets you sleep."', 'Dialogue target appends repaired dialogue swipe');
  assertEqual(host.message.swipeId, 1, 'Dialogue target selects enhanced swipe');
}
```

Add a Prose + Dialogue sequencing test:

```js
{
  const host = createProseMessageHarness('Mara set the cup down. "What do you want to do next?"');
  const roleCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'prose-dialogue', applyMode: 'replace', contextMessages: 3 } },
    hostMessages: host.messages,
    generationRouter: {
      async generate(roleId) {
        roleCalls.push(roleId);
        if (roleId === 'dialogueEnhancer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.dialogueEnhancer.v1',
              text: 'Mara set the cup down. "Sit down before you fall over. We can argue after."'
            }
          };
        }
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            text: 'Mara placed the cup on the table. "Sit down before you fall over. We can argue after."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-prose-dialogue-replace' });
  assertEqual(result.ok, true, 'Prose + Dialogue enhancement succeeds');
  assertEqual(result.target, 'prose-dialogue', 'Prose + Dialogue result reports target');
  assertDeepEqual(roleCalls, ['dialogueEnhancer', 'proseEnhancer'], 'Prose + Dialogue runs Dialogue before Prose');
  assertEqual(host.message.text, 'Mara placed the cup on the table. "Sit down before you fall over. We can argue after."', 'Replace applies one final output');
}
```

- [ ] **Step 2: Run failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: failures because runtime still reads `settings.proseEnhancement` and has no `dialogueEnhancer` sequence.

- [ ] **Step 3: Import dialogue helpers**

In `src/runtime.mjs`, add:

```js
import {
  buildDialogueEnhancementRequest,
  validateDialogueEnhancementResult
} from './dialogue-enhancement.mjs';
```

- [ ] **Step 4: Replace mode helpers**

Replace prose-specific helpers with:

```js
function enhancementTarget(settings = settingsStore.get()) {
  return safeText(settings?.enhancements?.target || 'off', 40);
}

function enhancementApplyMode(settings = settingsStore.get()) {
  const mode = safeText(settings?.enhancements?.applyMode || 'as-swipe', 40);
  return mode === 'replace' ? 'replace' : 'as-swipe';
}

function enhancementsEnabled(settings = settingsStore.get()) {
  return ['prose', 'dialogue', 'prose-dialogue'].includes(enhancementTarget(settings));
}
```

- [ ] **Step 5: Add pass sequence helper**

Add near `enhanceLatestAssistantMessageImpl`:

```js
async function runEnhancementPassSequence({ target, originalText, snapshot, settings, runId }) {
  const enhancementSettings = asObject(settings.enhancements);
  const storyForm = lastPacket?.storyForm || lastPlan?.storyForm || null;
  const contextMessages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  let currentText = originalText;
  const passSequence = target === 'prose-dialogue' ? ['dialogue', 'prose'] : [target];
  const hashes = [];

  for (const pass of passSequence) {
    if (pass === 'dialogue') {
      const request = buildDialogueEnhancementRequest({
        text: currentText,
        contextMessages,
        contextMessageLimit: enhancementSettings.contextMessages,
        storyForm
      });
      const result = await generationRouter.generate('dialogueEnhancer', request, {
        runId,
        timeoutMs: PROSE_ENHANCEMENT_TIMEOUT_MS
      });
      if (result?.ok === false) return { ok: false, pass, error: result.error };
      const validation = validateDialogueEnhancementResult(result.data, { originalText: currentText });
      if (!validation.ok) return { ok: false, pass, error: validation.error };
      currentText = validation.text;
      hashes.push({ pass, hash: hashJson(currentText) });
      continue;
    }

    if (pass === 'prose') {
      const request = buildProseEnhancementRequest({
        text: currentText,
        contextMessages,
        contextMessageLimit: enhancementSettings.contextMessages,
        storyForm
      });
      const result = await generationRouter.generate('proseEnhancer', request, {
        runId,
        timeoutMs: PROSE_ENHANCEMENT_TIMEOUT_MS
      });
      if (result?.ok === false) return { ok: false, pass, error: result.error };
      const validation = validateProseEnhancementResult(result.data, { originalText: currentText });
      if (!validation.ok) return { ok: false, pass, error: validation.error };
      currentText = validation.text;
      hashes.push({ pass, hash: hashJson(currentText) });
    }
  }

  return { ok: true, text: currentText, passSequence, hashes };
}
```

- [ ] **Step 6: Wire apply mode and marker**

Inside `enhanceLatestAssistantMessageImpl`, replace `proseSettings` reads with `settings.enhancements`, then build:

```js
const target = enhancementTarget(settings);
const applyMode = enhancementApplyMode(settings);
```

Replace the single Prose provider call with:

```js
const enhanced = await runEnhancementPassSequence({
  target,
  originalText,
  snapshot,
  settings,
  runId
});
if (!enhanced.ok) {
  settleRuntimeActivity({
    outcome: 'warning',
    label: 'Enhancement skipped.',
    detail: { diagnostics: [enhanced.error?.code || 'RECURSION_ENHANCEMENT_FAILED'] }
  });
  return { ok: true, skipped: true, reason: 'enhancement-validation-failed', error: enhanced.error };
}
const enhancedText = enhanced.text;
const marker = {
  target,
  applyMode,
  originalHash,
  enhancedHash: hashJson(enhancedText),
  passSequence: enhanced.passSequence,
  passHashes: enhanced.hashes
};
```

Use `applyMode` instead of `mode` for Replace or As Swipe branching.

- [ ] **Step 7: Run passing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: `[pass] runtime`.

- [ ] **Step 8: Commit**

Run:

```powershell
git add src/runtime.mjs tools/scripts/test-runtime.mjs
git commit -m "feat: sequence enhancement targets"
```

---

### Task 5: Extension Event Ownership And Smoke Coverage

**Files:**
- Modify: `src/extension/index.js`
- Modify: `tools/scripts/test-extension-smoke.mjs`

**Interfaces:**
- Consumes runtime public methods: `enhanceLatestAssistantMessage`, `proseEnhancementPending` or renamed equivalent.
- Produces generic owned mutation reason: `enhancement-owned-source-mutation`.
- Produces generic CSS capture class: `recursion-enhancement-capture-active`.

- [ ] **Step 1: Write failing smoke tests**

Update prose-specific smoke assertions to enhancement-generic naming:

```js
assertEqual(
  fakeDocumentElement.classList.contains('recursion-enhancement-capture-active'),
  true,
  'enhancement capture class is active immediately after generation is armed'
);
```

Add a Dialogue owned-mutation smoke case based on the existing Prose event-order case, with settings:

```js
settings: {
  enabled: true,
  enhancements: { target: 'dialogue', applyMode: 'replace', contextMessages: 3 }
}
```

The fake provider should return:

```js
{
  text: JSON.stringify({
    schema: 'recursion.dialogueEnhancer.v1',
    text: 'Mara set the cup down. "Call it whatever lets you sleep."'
  })
}
```

Expected assertion after late `message_updated`:

```js
assertEqual(
  globalThis.__recursionLiveHarnessRuntime.view().lastBrief?.packetId,
  enhancementPacketId,
  'late enhancement-owned message update preserves prompt packet id'
);
```

- [ ] **Step 2: Run failing smoke test**

Run:

```powershell
node tools\scripts\test-extension-smoke.mjs
```

Expected: failure because extension code still uses prose-specific settings and capture names.

- [ ] **Step 3: Rename extension ownership boundary**

In `src/extension/index.js`, replace prose-specific capture and reason strings:

```js
const ENHANCEMENT_CAPTURE_CLASS = 'recursion-enhancement-capture-active';
const ENHANCEMENT_OWNED_SOURCE_MUTATION_REASON = 'enhancement-owned-source-mutation';
```

Update source-change classification so Recursion-owned latest-assistant update or swipe events inside the enhancement tail return:

```js
{ ok: true, skipped: true, reason: ENHANCEMENT_OWNED_SOURCE_MUTATION_REASON }
```

Update activation/bootstrap stale held recovery copy to say enhancement rather than prose.

- [ ] **Step 4: Run passing smoke test**

Run:

```powershell
node tools\scripts\test-extension-smoke.mjs
```

Expected: `[pass] extension smoke`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/extension/index.js tools/scripts/test-extension-smoke.mjs
git commit -m "fix: generalize enhancement source ownership"
```

---

### Task 6: Enhancements UI

**Files:**
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes setting path: `settings.enhancements`
- Produces button dataset: `data-recursion-enhancements-button`
- Produces menu dataset: `data-recursion-enhancements-menu`
- Produces target choice dataset: `data-recursion-enhancement-target`
- Produces apply mode dataset: `data-recursion-enhancement-apply-mode`

- [ ] **Step 1: Write failing UI tests**

Replace current Prose Enhancement compact bar expectations:

```js
assert(root.querySelector('[data-recursion-enhancements-button]'), 'compact bar renders the Enhancements button');
assert(root.querySelector('[data-recursion-enhancements-menu]'), 'compact bar renders the Enhancements selector menu');
assert(root.querySelector('[data-recursion-enhancements-icon]'), 'Enhancements button renders the upgrade.svg mask icon');
assert(root.querySelector('[data-recursion-enhancements-button]').className.includes('is-off'), 'Enhancements button greys out when Off');

assertDeepEqual(
  root.querySelectorAll('[data-recursion-enhancement-target]').map((choice) => choice.dataset.recursionEnhancementTarget),
  ['off', 'prose', 'dialogue', 'prose-dialogue'],
  'Enhancements selector uses Off/Prose/Dialogue/Prose + Dialogue order'
);

assertDeepEqual(
  root.querySelectorAll('[data-recursion-enhancement-apply-mode]').map((choice) => choice.dataset.recursionEnhancementApplyMode),
  ['as-swipe', 'replace'],
  'Enhancements selector renders As Swipe and Replace apply modes'
);

assertEqual(
  root.querySelector('[data-recursion-enhancements-button]').getAttribute('aria-label'),
  'Enhancements: Off',
  'Enhancements button exposes the current target'
);
```

Add interaction coverage:

```js
root.querySelector('[data-recursion-enhancements-button]').click();
root.querySelector('[data-recursion-enhancement-apply-mode-replace]').click();
assertDeepEqual(settingsUpdates.at(-1), { enhancements: { applyMode: 'replace' } }, 'Apply mode updates without changing target');
assertEqual(root.querySelector('[data-recursion-enhancements-menu]').hidden, false, 'Apply mode keeps Enhancements menu open');
root.querySelector('[data-recursion-enhancement-target-dialogue]').click();
assertDeepEqual(settingsUpdates.at(-1), { enhancements: { target: 'dialogue' } }, 'Dialogue target updates setting');
```

- [ ] **Step 2: Run failing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: failures because DOM still uses Prose Enhancement names and rows.

- [ ] **Step 3: Replace menu option models**

In `src/ui.mjs`, replace `PROSE_ENHANCEMENT_MENU_OPTIONS` with:

```js
const ENHANCEMENT_TARGET_OPTIONS = Object.freeze([
  { value: 'off', label: 'Off', tip: 'Shows the SillyTavern generation unchanged.' },
  { value: 'prose', label: 'Prose', tip: 'Rewrites narration while preserving dialogue.' },
  { value: 'dialogue', label: 'Dialogue', tip: 'Repairs AI-ish speech, voice drift, fake agency, and weak subtext.' },
  { value: 'prose-dialogue', label: 'Prose + Dialogue', tip: 'Repairs dialogue first, then polishes narration.' }
]);

const ENHANCEMENT_APPLY_OPTIONS = Object.freeze([
  { value: 'as-swipe', label: 'As Swipe', tip: 'Keeps the original and selects one enhanced sibling swipe.' },
  { value: 'replace', label: 'Replace', tip: 'Shows only the enhanced version when validation passes.' }
]);
```

Add labels:

```js
function enhancementTargetLabel(value) {
  const target = normalizeEnhancementTarget(value);
  if (target === 'prose') return 'Prose';
  if (target === 'dialogue') return 'Dialogue';
  if (target === 'prose-dialogue') return 'Prose + Dialogue';
  return 'Off';
}

function enhancementApplyModeLabel(value) {
  return normalizeEnhancementApplyMode(value) === 'replace' ? 'Replace' : 'As Swipe';
}
```

- [ ] **Step 4: Render dropdown shape**

Replace the Prose Enhancement cluster DOM with:

```js
el('div', { className: 'recursion-enhancements-cluster' }, [
  el('button', {
    className: 'recursion-enhancements-button is-off',
    attrs: { type: 'button', 'aria-label': 'Enhancements: Off', 'aria-expanded': 'false' },
    dataset: { recursionEnhancementsButton: '' }
  }, [
    el('span', { className: 'recursion-enhancements-icon', attrs: { 'aria-hidden': 'true' }, dataset: { recursionEnhancementsIcon: '' } })
  ]),
  el('div', { className: 'recursion-enhancements-menu', attrs: { 'aria-label': 'Enhancements selector', hidden: '' }, dataset: { recursionEnhancementsMenu: '' } }, [
    el('div', { className: 'recursion-enhancements-menu-header' }, [
      el('span', { className: 'recursion-enhancements-menu-title' }, 'Enhancements'),
      el('span', { className: 'recursion-enhancements-menu-subtitle' }, 'Utility post-generation cleanup')
    ]),
    el('div', { className: 'recursion-enhancements-apply-row' }, [
      el('span', { className: 'recursion-enhancements-section-label' }, 'Apply'),
      ...ENHANCEMENT_APPLY_OPTIONS.map(enhancementApplyChoice)
    ]),
    el('div', { className: 'recursion-enhancements-section-label' }, 'Enhance'),
    ...ENHANCEMENT_TARGET_OPTIONS.map(enhancementTargetChoice)
  ])
])
```

- [ ] **Step 5: Wire state and actions**

Replace `renderProseEnhancementState` with:

```js
function renderEnhancementsState(view = currentView()) {
  const target = normalizeEnhancementTarget(view.settings?.enhancements?.target);
  const applyMode = normalizeEnhancementApplyMode(view.settings?.enhancements?.applyMode);
  const targetLabel = enhancementTargetLabel(target);
  const applyLabel = enhancementApplyModeLabel(applyMode);
  const label = target === 'off' ? 'Off' : `${targetLabel}, ${applyLabel}`;
  enhancementsButton?.classList?.toggle?.('is-off', target === 'off');
  enhancementsButton?.setAttribute('aria-label', `Enhancements: ${label}`);
  setTooltip(enhancementsButton, view.settings?.ui?.tooltipsEnabled !== false, `Enhancements: ${label}`);
  for (const choice of root.querySelectorAll('[data-recursion-enhancement-target]')) {
    const selected = cleanText(choice.dataset.recursionEnhancementTarget).toLowerCase() === target;
    choice.className = selected ? 'recursion-enhancement-target is-selected' : 'recursion-enhancement-target';
    choice.setAttribute('aria-current', selected ? 'true' : 'false');
  }
  for (const choice of root.querySelectorAll('[data-recursion-enhancement-apply-mode]')) {
    const selected = cleanText(choice.dataset.recursionEnhancementApplyMode).toLowerCase() === applyMode;
    choice.className = selected ? 'recursion-enhancement-apply-choice is-selected' : 'recursion-enhancement-apply-choice';
    choice.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }
}
```

Click handling:

```js
const enhancementTarget = control('recursionEnhancementTarget');
if (enhancementTarget) {
  runAction(runtime?.updateSettings?.({ enhancements: { target: normalizeEnhancementTarget(enhancementTarget.dataset.recursionEnhancementTarget) } }));
  setEnhancementsMenuOpen(false);
  return;
}

const enhancementApplyMode = control('recursionEnhancementApplyMode');
if (enhancementApplyMode) {
  runAction(runtime?.updateSettings?.({ enhancements: { applyMode: normalizeEnhancementApplyMode(enhancementApplyMode.dataset.recursionEnhancementApplyMode) } }));
  renderEnhancementsState(currentView());
  return;
}
```

- [ ] **Step 6: Run passing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: `[pass] ui`.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/ui.mjs tools/scripts/test-ui.mjs
git commit -m "feat: add enhancements bar menu"
```

---

### Task 7: Progress And Diagnostics Copy

**Files:**
- Modify: `src/progress.mjs`
- Modify: `src/activity.mjs` if status labels are centralized there
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Produces progress step id: `dialogue-enhancement`
- Keeps progress step id: `prose-enhancement`
- Produces compact labels: `Enhancing dialogue`, `Enhancing prose`, `Enhancing response`.

- [ ] **Step 1: Write failing progress tests**

Add to `tools/scripts/test-progress.mjs`:

```js
const dialogueProgress = normalizeProgressStep({ id: 'dialogue-enhancement', status: 'running' });
assertEqual(dialogueProgress.label, 'Dialogue Enhancement', 'dialogue enhancement progress label is stable');
assertEqual(dialogueProgress.currentLabel, 'Enhancing dialogue', 'dialogue enhancement current label is compact');

const responseProgress = normalizeProgressStep({ id: 'enhancement-response', status: 'running' });
assertEqual(responseProgress.currentLabel, 'Enhancing response', 'combined enhancement status uses response copy');
```

- [ ] **Step 2: Run failing progress test**

Run:

```powershell
node tools\scripts\test-progress.mjs
```

Expected: failure because `dialogue-enhancement` is unknown.

- [ ] **Step 3: Add progress labels**

In `src/progress.mjs`, add to the known step metadata:

```js
'dialogue-enhancement': { label: 'Dialogue Enhancement', currentLabel: 'Enhancing dialogue', providerLane: 'utility' },
'enhancement-response': { label: 'Enhancement', currentLabel: 'Enhancing response', providerLane: 'utility' },
```

Update runtime activity settlement copy to use:

```js
label: target === 'prose' ? 'Prose enhanced.' : target === 'dialogue' ? 'Dialogue enhanced.' : 'Response enhanced.',
```

Failure copy:

```js
label: 'Enhancement failed. Original kept.',
```

- [ ] **Step 4: Run passing progress and runtime tests**

Run:

```powershell
node tools\scripts\test-progress.mjs
node tools\scripts\test-runtime.mjs
```

Expected: `[pass] progress` and `[pass] runtime`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/progress.mjs src/activity.mjs tools/scripts/test-progress.mjs tools/scripts/test-runtime.mjs
git commit -m "feat: add enhancement progress labels"
```

---

### Task 8: Live Proof Script

**Files:**
- Rename or create: `tools/scripts/prove-live-enhancements.mjs`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md`

**Interfaces:**
- Consumes existing live harness patterns from `tools/scripts/prove-live-prose-enhancement.mjs`.
- Produces live proof for `Dialogue` and `Prose + Dialogue`.

- [ ] **Step 1: Create live proof script from existing Prose proof**

Copy the structure of `tools/scripts/prove-live-prose-enhancement.mjs` into `tools/scripts/prove-live-enhancements.mjs`.

Use these setting patches in separate phases:

```js
await runtime.updateSettings({ enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } });
```

```js
await runtime.updateSettings({ enhancements: { target: 'prose-dialogue', applyMode: 'replace', contextMessages: 3 } });
```

Required assertions:

```js
assertEqual(activeMessage.swipes.length >= 2, true, 'Dialogue As Swipe keeps original plus enhanced sibling');
assertEqual(activeMessage.swipe_id, 1, 'Dialogue As Swipe selects enhanced sibling');
assert(activeMessage.swipes[1] !== activeMessage.swipes[0], 'Dialogue As Swipe changes dialogue or returns a valid selected sibling');
assert(!document.documentElement.classList.contains('recursion-enhancement-capture-active'), 'Enhancement capture class clears after settle');
```

For `Replace`:

```js
assertEqual(activeMessage.swipes.length, 1, 'Prose + Dialogue Replace does not append a sibling swipe');
assert(activeMessage.mes && activeMessage.mes.length > 0, 'Prose + Dialogue Replace leaves visible assistant text');
```

- [ ] **Step 2: Update smoke test plan**

Add to `docs/testing/LIVE_SMOKE_TEST_PLAN.md`:

```markdown
### Enhancements Live Proof

Run `node tools\scripts\prove-live-enhancements.mjs` against an installed, fresh Recursion extension copy. The proof covers Dialogue As Swipe, Prose + Dialogue Replace, enhancement capture cleanup, selected enhanced swipe behavior, and owned late update preservation of Last Brief.
```

- [ ] **Step 3: Run live proof when SillyTavern is available**

Run:

```powershell
node tools\scripts\prove-live-enhancements.mjs
```

Expected: script reports Dialogue As Swipe and Prose + Dialogue Replace proof success.

- [ ] **Step 4: Commit**

Run:

```powershell
git add tools/scripts/prove-live-enhancements.mjs docs/testing/LIVE_SMOKE_TEST_PLAN.md
git commit -m "test: prove enhancements live"
```

---

### Task 9: Documentation Update

**Files:**
- Modify: `docs/RECURSION_EXTENSION_SPEC.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- Modify: `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md`

**Interfaces:**
- Consumes final setting contract: `settings.enhancements`.
- Produces user-facing copy for `Enhancements`, `Dialogue`, `Prose + Dialogue`, `As Swipe`, and `Replace`.

- [ ] **Step 1: Update design docs**

In `docs/design/UI_SPEC.md`, replace the Prose Enhancement section with:

```markdown
Enhancements is an icon-only upgrade button immediately to the right of Cards and immediately to the left of Tense & PoV. It uses the repo-local `assets/icons/upgrade.svg` mask icon, opens a compact dropdown, and controls post-generation Utility cleanup.

The dropdown has two zones:

- `Apply`: segmented `As Swipe` and `Replace` control.
- `Enhance`: mutually exclusive `Off`, `Prose`, `Dialogue`, and `Prose + Dialogue` rows.

`Off` leaves SillyTavern output unchanged. `Prose` rewrites narration while preserving dialogue. `Dialogue` repairs AI-ish speech, voice drift, fake agency, and weak subtext while preserving scene events. `Prose + Dialogue` runs Dialogue first, then Prose, and applies one final enhanced result.
```

- [ ] **Step 2: Update user manual**

In `docs/user/RECURSION_OPERATOR_MANUAL.md`, replace the Prose Enhancement section with:

```markdown
The Enhancements control sits immediately to the right of Cards and uses the upgrade icon. It is grey when `Off`. Choose what Recursion enhances with `Off`, `Prose`, `Dialogue`, or `Prose + Dialogue`, then choose how it applies the result with `As Swipe` or `Replace`.

`As Swipe` hides the fresh SillyTavern assistant output until the Utility pass finishes, keeps the original as one swipe, and adds the enhanced swipe selected by default. `Replace` hides the fresh output until the Utility pass finishes, then replaces the active assistant text with the enhanced version. If validation fails or Utility is unavailable, Recursion reveals the original unchanged.

`Dialogue` repairs echoing, fake agency, unsupported smart-character jargon, unsupported defensive tropes, lazy attraction lines, and weak subtext. It is a correction pass, not a style preset, and should not make characters warmer or more emotionally direct unless established character evidence supports that.
```

- [ ] **Step 3: Update provider docs**

In provider docs, add:

```markdown
`dialogueEnhancer` is a Utility role with schema `recursion.dialogueEnhancer.v1`. It is used only by the post-generation Enhancements lifecycle. `proseEnhancer` remains Utility-only with schema `recursion.proseEnhancer.v1`.
```

- [ ] **Step 4: Update runtime architecture docs**

Add lifecycle text:

```markdown
Enhancements run after host assistant output lands and before Rapid warm can observe the final source. Enabled targets arm a capture/hold window during host generation. Dialogue target calls `dialogueEnhancer`; Prose target calls `proseEnhancer`; Prose + Dialogue calls `dialogueEnhancer` and then `proseEnhancer`. Runtime validates each pass and applies one final output through As Swipe or Replace.
```

- [ ] **Step 5: Run doc checks**

Run:

```powershell
git diff --check -- docs/RECURSION_EXTENSION_SPEC.md docs/architecture/RUNTIME_ARCHITECTURE.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md docs/technical/RECURSION_TECHNICAL_MANUAL.md docs/design/UI_SPEC.md docs/user/RECURSION_OPERATOR_MANUAL.md docs/testing/LIVE_SMOKE_TEST_PLAN.md
```

Expected: no output and exit code `0`.

- [ ] **Step 6: Commit**

Run:

```powershell
git add docs/RECURSION_EXTENSION_SPEC.md docs/architecture/RUNTIME_ARCHITECTURE.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md docs/technical/RECURSION_TECHNICAL_MANUAL.md docs/design/UI_SPEC.md docs/user/RECURSION_OPERATOR_MANUAL.md docs/testing/LIVE_SMOKE_TEST_PLAN.md
git commit -m "docs: describe enhancements"
```

---

### Task 10: Final Verification

**Files:**
- Verify all files touched by Tasks 1-9.

**Interfaces:**
- Consumes all feature contracts.
- Produces release-ready local evidence.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
node tools\scripts\test-dialogue-enhancement.mjs
node tools\scripts\test-prose-enhancement.mjs
node tools\scripts\test-settings.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-ui.mjs
node tools\scripts\test-extension-smoke.mjs
```

Expected: every command exits `0` and prints its `[pass] ...` line.

- [ ] **Step 2: Run alpha gate**

Run:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: alpha gate exits `0`.

- [ ] **Step 3: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: no output and exit code `0`.

- [ ] **Step 4: Run live proof when host is available**

Run:

```powershell
node tools\scripts\prove-live-enhancements.mjs
```

Expected: Dialogue As Swipe, Prose + Dialogue Replace, capture cleanup, and owned late update checks pass.

- [ ] **Step 5: Commit final verification doc adjustments if any**

Run only if verification changed docs or evidence files:

```powershell
git add docs/testing/LIVE_SMOKE_TEST_PLAN.md tools/scripts/prove-live-enhancements.mjs
git commit -m "test: finalize enhancements proof"
```

---

## Self-Review

- Spec coverage: Tasks 1-10 cover settings, provider role, prompt contract, validation, runtime sequencing, event ownership, UI, progress copy, live proof, docs, and final verification.
- Placeholder scan: this plan contains no unresolved implementation placeholders.
- Type consistency: setting names use `enhancements.target`, `enhancements.applyMode`, and `enhancements.contextMessages`; provider role names use `dialogueEnhancer` and `proseEnhancer`; schemas use `recursion.dialogueEnhancer.v1` and `recursion.proseEnhancer.v1`.

Plan complete and saved to `docs/superpowers/plans/2026-07-10-recursion-enhancements-dialogue.md`. Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. Inline Execution - execute tasks in this session using executing-plans, batch execution with checkpoints.
