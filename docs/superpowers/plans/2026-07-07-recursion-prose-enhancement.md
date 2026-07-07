# Recursion Prose Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Prose Enhancement as a Utility-powered post-generation polish pass with Off, As Swipe, and Replace modes.

**Architecture:** Keep the feature outside the prompt-packet/card pipeline. Runtime handles the post-generation lifecycle, provider routing handles a new structured `proseEnhancer` role, `src/prose-enhancement.mjs` owns prompt building and validation, and the SillyTavern host adapter owns message hold, replace, and swipe mutation.

**Tech Stack:** JavaScript ES modules, Recursion runtime/provider/settings/UI modules, SillyTavern extension host adapter, deterministic Node tests, Playwright live SillyTavern proof, markdown docs.

## Global Constraints

- Recursion is pre-alpha; update code, docs, schemas, tests, and examples in place to the best V1 contract.
- UI must follow `DESIGN.md` and `docs/design/UI_SPEC.md`: SillyTavern-native, compact, graphite-dark, operational.
- Prose Enhancement modes are exactly `off`, `as-swipe`, and `replace`.
- Default mode is `off`.
- Prose Enhancement primary UI is one icon-only bar button using `upgrade.svg`, located immediately to the right of Cards.
- Prose Enhancement menu follows the Mode dropdown pattern with rows for Off, As Swipe, and Replace plus mini-descriptions.
- When mode is `off`, the Prose Enhancement icon greys out like the On/Off button disabled treatment.
- Default context message count is `13`.
- Context message range is integer `0..35`.
- Prose Enhancement uses Utility only; Reasoner is not part of V1 routing.
- Provider schema is `recursion.proseEnhancer.v1`.
- Dialogue spans must remain byte-identical before enhanced text can apply, except exact or obvious direct variants from the full banned AI slop list may be removed or neutralized inside dialogue. Non-dialogue prose may be rewritten freely.
- Prose Enhancement prompt must include the full banned AI slop and clichés list intact; do not reduce, summarize, or paraphrase it.
- Raw original text, enhanced text, provider prompts, provider responses, full scene context, secrets, and hidden reasoning must not persist to journals or diagnostics.
- Enabled Prose Enhancement should capture raw host output and mask it before the player sees it, without destructively blanking the SillyTavern chat row. If capture fails, skip enhancement and reveal original output.
- `As Swipe` creates or selects one enhanced sibling for one original message/swipe hash, then selects the enhanced swipe.
- `As Swipe` must keep SillyTavern `swipes` and `swipe_info` aligned and refresh the current chat view so the enhanced sibling appears without a page reload.
- `Replace` replaces the active assistant text; failure reveals original unchanged.
- If the Utility pass returns valid text, apply it even when byte-identical or minimally changed. `As Swipe` still appends the provider output as the enhanced sibling; `Replace` still writes it as the active text.
- If an interrupted pass leaves a persisted held marker with a blank active assistant row, bootstrap recovery restores the held original and clears the marker.

---

## File Structure

- `src/settings.mjs` - normalize and persist `proseEnhancement`.
- `src/prose-enhancement.mjs` - new pure module for prompt building, JSON shape helpers, dialogue-span validation, result validation, duplicate keys, and compact diagnostics.
- `src/providers.mjs` - add Utility role `proseEnhancer` and schema `recursion.proseEnhancer.v1`.
- `src/runtime.mjs` - orchestrate post-generation enhancement after assistant landing and before Rapid warm continuation.
- `src/hosts/sillytavern/host.mjs` - expose host-neutral `messages` methods for hold, reveal, replace, append swipe, active identity, and duplicate lookup.
- `src/extension/index.js` - arm hold on generation start and invoke runtime enhancement on assistant landed events before Rapid warm.
- `src/ui.mjs` and `src/ui/view-model.mjs` - render `Prose Enhancement` bar icon dropdown, Advanced context setting, status copy, and safe view data.
- `styles/recursion.css` - add compact bar/menu/control styles only if existing Mode/settings styles cannot cover them.
- `assets/icons/upgrade.svg` - repo-local copy of `C:/Users/Keptin/Downloads/upgrade.svg` for the bar control.
- `tools/scripts/test-settings.mjs` - settings normalization coverage.
- `tools/scripts/test-providers.mjs` - provider role/schema coverage.
- `tools/scripts/test-prose-enhancement.mjs` - pure prompt/validation/duplicate-key coverage.
- `tools/scripts/test-host.mjs` - fake and SillyTavern host message mutation coverage.
- `tools/scripts/test-runtime.mjs` - post-generation lifecycle, stale/cancel/failure coverage.
- `tools/scripts/test-ui.mjs` - settings rendering and status copy coverage.
- `tools/scripts/run-alpha-gate.mjs` - include the new focused test.
- `tools/scripts/prove-live-prose-enhancement.mjs` - live SillyTavern proof for As Swipe and Replace.
- Product, architecture, technical, user, design, and testing docs listed in Task 8.

---

### Task 1: Settings Contract

**Files:**
- Modify: `src/settings.mjs`
- Modify: `tools/scripts/test-settings.mjs`

**Interfaces:**
- Produces: `normalizeProseEnhancementSettings(value) -> { mode: 'off' | 'as-swipe' | 'replace', contextMessages: number }`
- Produces setting path: `settings.proseEnhancement`
- Consumed by: UI, runtime, cache/settings signatures.

- [ ] **Step 1: Write failing settings tests**

Add to `tools/scripts/test-settings.mjs` near other normalization tests:

```js
assertDeepEqual(
  normalizeSettings({}).proseEnhancement,
  { mode: 'off', contextMessages: 13 },
  'Prose Enhancement defaults off with Recast-style context length'
);
assertDeepEqual(
  normalizeSettings({ proseEnhancement: { mode: 'as-swipe', contextMessages: 21 } }).proseEnhancement,
  { mode: 'as-swipe', contextMessages: 21 },
  'Prose Enhancement accepts As Swipe mode and context count'
);
assertDeepEqual(
  normalizeSettings({ proseEnhancement: { mode: 'replace', contextMessages: '35' } }).proseEnhancement,
  { mode: 'replace', contextMessages: 35 },
  'Prose Enhancement accepts Replace mode and string numeric context'
);
assertDeepEqual(
  normalizeSettings({ proseEnhancement: { mode: 'custom-pass', contextMessages: 99 } }).proseEnhancement,
  { mode: 'off', contextMessages: 35 },
  'Prose Enhancement rejects unsupported pass mode and clamps context'
);
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
node tools\scripts\test-settings.mjs
```

Expected: failure because `settings.proseEnhancement` is undefined.

- [ ] **Step 3: Implement settings normalization**

In `src/settings.mjs`, add constants:

```js
const PROSE_ENHANCEMENT_MODES = new Set(['off', 'as-swipe', 'replace']);
const PROSE_ENHANCEMENT_CONTEXT_MIN = 0;
const PROSE_ENHANCEMENT_CONTEXT_MAX = 35;
```

Add to `DEFAULT_RECURSION_SETTINGS`:

```js
proseEnhancement: {
  mode: 'off',
  contextMessages: 13
},
```

Add export:

```js
export function normalizeProseEnhancementSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    mode: enumValue(source.mode, PROSE_ENHANCEMENT_MODES, DEFAULT_RECURSION_SETTINGS.proseEnhancement.mode),
    contextMessages: Math.round(numberInRange(
      source.contextMessages,
      DEFAULT_RECURSION_SETTINGS.proseEnhancement.contextMessages,
      PROSE_ENHANCEMENT_CONTEXT_MIN,
      PROSE_ENHANCEMENT_CONTEXT_MAX
    ))
  };
}
```

Add to `normalizeSettings` return:

```js
proseEnhancement: normalizeProseEnhancementSettings(source.proseEnhancement),
```

- [ ] **Step 4: Run passing test**

Run:

```powershell
node tools\scripts\test-settings.mjs
```

Expected: `[pass] settings`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/settings.mjs tools/scripts/test-settings.mjs
git commit -m "feat: add prose enhancement settings"
```

---

### Task 2: Provider Role

**Files:**
- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-providers.mjs`

**Interfaces:**
- Consumes: `generationRouter.generate('proseEnhancer', request)`
- Produces provider schema: `recursion.proseEnhancer.v1`
- Consumed by: runtime Prose Enhancement orchestration.

- [ ] **Step 1: Write failing provider tests**

In `tools/scripts/test-providers.mjs`, update role schema helper:

```js
if (roleId === 'proseEnhancer') return 'recursion.proseEnhancer.v1';
```

Add `proseEnhancer` to expected Utility roles:

```js
'proseEnhancer',
```

Add assertions:

```js
assertEqual(roleLane('proseEnhancer'), 'utility', 'proseEnhancer defaults to Utility lane');

const proseStore = createStore();
const proseRouter = createGenerationRouter({
  client: createProviderClient({
    settingsStore: proseStore,
    host: {
      generation: {
        async generate(request) {
          assertEqual(request.responseSchema, 'recursion.proseEnhancer.v1', 'Prose Enhancement carries schema metadata');
          assertEqual(request.machineJson, true, 'Prose Enhancement requests machine JSON');
          return {
            text: JSON.stringify({
              schema: 'recursion.proseEnhancer.v1',
              sourceMessageHash: request.sourceMessageHash,
              rewrittenText: 'The polished text remains faithful.',
              diagnostics: []
            })
          };
        }
      }
    }
  })
});
const proseResult = await proseRouter.generate('proseEnhancer', {
  sourceMessageHash: 'hash-original',
  prompt: 'Enhance prose.',
  messages: [{ role: 'user', content: 'Enhance prose.' }]
});
assertEqual(proseResult.ok, true, 'proseEnhancer validates structured output');
assertEqual(proseResult.data.schema, 'recursion.proseEnhancer.v1', 'proseEnhancer schema accepted');
```

- [ ] **Step 2: Run failing provider test**

Run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: failure because `proseEnhancer` is unsupported.

- [ ] **Step 3: Add role in provider registry**

In `src/providers.mjs`, add to `UTILITY_ROLE_IDS` before `providerTest`:

```js
'proseEnhancer',
```

Add to `ROLE_RESPONSE_SCHEMAS`:

```js
proseEnhancer: 'recursion.proseEnhancer.v1',
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
git commit -m "feat: add prose enhancer provider role"
```

---

### Task 3: Pure Prose Enhancement Module

**Files:**
- Create: `src/prose-enhancement.mjs`
- Create: `tools/scripts/test-prose-enhancement.mjs`
- Modify: `tools/scripts/run-tests.mjs` if it enumerates focused scripts
- Modify: `tools/scripts/run-alpha-gate.mjs`

**Interfaces:**
- Produces: `buildProseEnhancementRequest(input, options) -> object`
- Produces: `validateProseEnhancementResult(result, context) -> { ok, text, diagnostics }`
- Produces: `proseEnhancementKey({ chatKey, messageId, swipeId, originalHash }) -> string`
- Consumed by: runtime and tests.

- [ ] **Step 1: Write pure-module tests**

Create `tools/scripts/test-prose-enhancement.mjs`:

```js
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';
import {
  buildProseEnhancementRequest,
  dialogueSpans,
  proseEnhancementKey,
  validateProseEnhancementResult
} from '../../src/prose-enhancement.mjs';

const original = 'She looked at the sealed door. "Do not touch it," Mara said. She waited.';
const polished = 'She looked toward the sealed door, then stilled. "Do not touch it," Mara said.';

const request = buildProseEnhancementRequest({
  messageId: 12,
  swipeId: 0,
  sourceMessageHash: 'hash-12-0',
  textToTransform: original,
  sceneMessages: [
    { mesid: 10, role: 'user', text: 'Open it.' },
    { mesid: 11, role: 'assistant', text: 'Mara blocked the door.' }
  ],
  contextMessages: 13,
  storyForm: { schema: 'recursion.storyForm.v1', tense: 'past', pov: 'third-person-limited', confidence: 'high' }
});

assertEqual(request.roleId, 'proseEnhancer', 'request uses proseEnhancer role');
assertEqual(request.lane, 'utility', 'request uses Utility lane');
assertEqual(request.responseSchema, 'recursion.proseEnhancer.v1', 'request declares schema');
assertEqual(request.machineJson, true, 'request asks for machine JSON');
assert(request.messages.some((message) => message.content.includes('<text_to_transform>')), 'request wraps text to transform');
assert(request.messages.some((message) => message.content.includes('<scene_context>')), 'request includes bounded scene context');
assert(request.messages.some((message) => message.content.includes('## Core banned AI slop and clichés')), 'request includes full banned slop list heading');
assert(request.messages.some((message) => message.content.includes('* felt it like a physical blow')), 'request includes full physical-impact list items');
assert(request.messages.some((message) => message.content.includes("* a breath she didn't know she was holding")), 'request includes full breath-loop list items');
assert(request.messages.some((message) => message.content.includes('* where do we go from here?')), 'request includes forced-question list items');
assert(request.messages.some((message) => message.content.includes('* controlled chaos')), 'request includes final banned slop item');
assert(request.messages.some((message) => message.content.includes('Do not replace one banned pattern with a neighboring cliché')), 'request blocks adjacent cliché substitutions');
assert(request.messages.some((message) => message.content.includes('Exception: the banned AI slop list below can override this dialogue rule')), 'request documents dialogue exception for banned slop');
assert(!request.messages.some((message) => message.content.includes('rawPrompt')), 'request avoids diagnostic prompt markers');

assertDeepEqual(dialogueSpans(original), ['"Do not touch it,"'], 'dialogue spans extract quoted dialogue');

const ok = validateProseEnhancementResult({
  ok: true,
  data: {
    schema: 'recursion.proseEnhancer.v1',
    sourceMessageHash: 'hash-12-0',
    rewrittenText: polished,
    diagnostics: []
  }
}, {
  originalText: original,
  sourceMessageHash: 'hash-12-0'
});
assertEqual(ok.ok, true, 'valid enhancement accepted');
assertEqual(ok.text, polished, 'valid enhancement returns rewritten text');

const changedDialogue = validateProseEnhancementResult({
  ok: true,
  data: {
    schema: 'recursion.proseEnhancer.v1',
    sourceMessageHash: 'hash-12-0',
    rewrittenText: 'She looked at the sealed door. "Please do not touch it," Mara said.',
    diagnostics: []
  }
}, {
  originalText: original,
  sourceMessageHash: 'hash-12-0'
});
assertEqual(changedDialogue.ok, false, 'changed dialogue rejected');
assert(changedDialogue.diagnostics.includes('dialogue-changed'), 'changed dialogue diagnostic recorded');

const bannedDialogue = validateProseEnhancementResult({
  ok: true,
  data: {
    schema: 'recursion.proseEnhancer.v1',
    sourceMessageHash: 'hash-12-0',
    rewrittenText: 'He stepped closer without the possessive line.',
    diagnostics: []
  }
}, {
  originalText: "\"You're mine,\" he growled.",
  sourceMessageHash: 'hash-12-0'
});
assertEqual(bannedDialogue.ok, true, 'banned slop can override dialogue preservation rule');

const wrongHash = validateProseEnhancementResult({
  ok: true,
  data: {
    schema: 'recursion.proseEnhancer.v1',
    sourceMessageHash: 'wrong',
    rewrittenText: polished,
    diagnostics: []
  }
}, {
  originalText: original,
  sourceMessageHash: 'hash-12-0'
});
assertEqual(wrongHash.ok, false, 'source hash mismatch rejected');

assertEqual(
  proseEnhancementKey({ chatKey: 'chat-a', messageId: 12, swipeId: 0, originalHash: 'hash-12-0' }),
  'chat-a::12::0::hash-12-0',
  'duplicate key is stable'
);

console.log('[pass] prose-enhancement');
```

- [ ] **Step 2: Run failing pure test**

Run:

```powershell
node tools\scripts\test-prose-enhancement.mjs
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement pure module**

Create `src/prose-enhancement.mjs`:

```js
import { compact, truncate } from './core.mjs';
import { asObject } from './safe-values.mjs';

export const PROSE_ENHANCER_SCHEMA = 'recursion.proseEnhancer.v1';
const MAX_CONTEXT_TEXT = 900;
const MAX_TARGET_TEXT = 12000;
const MAX_DIAGNOSTIC = 120;
const SECRET_PATTERN = /(raw[-_\s]*prompt|rawPrompt|provider[-_\s]*response|hidden[-_\s]*reasoning|api[-_\s]*key|authorization|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]+)/i;
const BANNED_AI_SLOP_LIST = String.raw`## Core banned AI slop and clichés

### Physical-impact metaphors

* felt it like a physical blow
* hit like a physical blow
* struck like a physical blow
* landed like a blow
* hit like a fist to the chest
* hit like ice water
* hit like a punch to the gut
* the words struck him
* the words landed
* the realization crashed over them
* the truth slammed into them
* the weight of his words settled
* the words hung in the air
* the silence settled over them
* the moment settled between them

### Breath, throat, chest, and heartbeat loops

* a breath she didn't know she was holding
* breath hitched
* breath caught
* drew in a breath
* let out a breath
* exhaled slowly
* inhaled sharply
* released a shaky breath
* swallowed thickly
* throat tightened
* chest tightened
* heart raced
* pulse quickened
* heart skipped a beat
* a shiver ran down her spine
* a jolt ran through him
* goosebumps rose on her skin
* caught her breath
* couldn't breathe
* forgot how to breathe

### Generic tension atmosphere

* time seemed to stop
* the tension was palpable
* the air grew thick
* the air crackled
* electricity crackled between them
* the silence spoke volumes
* a silence that spoke louder than words
* the world fell away
* everything else faded
* the room seemed smaller
* the moment stretched
* the moment hung suspended
* an unspoken understanding passed between them
* something shifted between them
* neither of them moved
* neither of them spoke
* for a long moment
* for what felt like forever

### Face, eyes, gaze, jaw

* eyes widened
* pupils dilated
* gaze softened
* gaze darkened
* gaze flickered
* gaze dropped
* searched their face for
* looked at him, really looked at him
* studied his face
* jaw clenched
* jaw tightened
* jaw set
* jaw worked
* jaw opened and closed
* lips parted
* lips twitched
* mouth opened, then closed
* brows furrowed
* expression unreadable
* something unreadable crossed his face
* eyes flashed with something

### Voice and delivery clichés

* voice dropped
* voice caught
* voice softened
* voice barely above a whisper
* voice turned low
* voice was rough
* voice was thick with emotion
* murmured
* whispered
* purred
* growled
* said softly
* said quietly
* said gently
* said, too casually
* the words came out before she could stop them
* before he could think better of it
* despite himself
* couldn't help but

### Micro-gesture loops

* fingers brushed
* fingers ghosted over
* traced lazy circles
* traced patterns on skin
* hand hovered
* hand lingered
* lingered a bit too long
* leaned against the doorframe
* leaned in close
* tilted his head
* cocked his head
* tucked a strand of hair behind her ear
* reached out, then stopped
* froze
* stiffened
* flinched
* knuckles whitened
* dug crescent moons into his palms
* nails bit into his palm
* lip caught between teeth
* bit her lip hard enough to draw blood
* heels clicked
* collarbones drew attention

### False-profundity sentence structures

* not just X, but Y
* not X. Not Y. Just Z.
* no words. No movement. Only X.
* for the first time
* and somehow, that was enough
* something almost like a laugh
* something not quite a smile
* a sound somewhere between X and Y
* the kind of X that Y
* as if X itself had Y
* as though the universe had narrowed to this
* a key turning in a lock
* a lock he didn't know existed
* a truth he wasn't ready to name
* an answer to a question she hadn't asked
* the weight of everything unsaid
* unspoken promise
* unspoken question
* unspoken challenge
* unspoken permission

### Emotional abstraction filler

* a mix of
* a mixture of
* a hint of
* a flicker of
* a flash of
* a trace of
* a spark of
* a pang of
* a wave of
* a rush of
* a surge of
* a storm of
* a cocktail of
* something like
* something close to
* something almost
* something unreadable
* something primal
* something ancient
* something dangerous
* something vulnerable
* something raw

### Forced romance / attraction clichés

* he was a man starved and she was a feast
* hungry gaze
* predatory gaze
* possessive growl
* feral need
* primal need
* ruin you
* ruin you for anyone else
* you're mine
* mark you
* claim you
* devour you
* worship you
* make you forget your own name
* kiss-swollen lips
* kissed hard enough to bruise
* bruising kiss
* dangerous game
* playing with fire
* you're going to be the death of me
* you menace
* be gentle
* I've never done anything like this before
* last chance to back out
* tell me what you want
* once I start, I won't stop

### Forced question endings and fake agency

* what do you say?
* what do you want?
* what now?
* your move
* the choice is yours
* do you want to X, or Y?
* are you going to X, or will you Y?
* will you X, or will you Y?
* or something else entirely
* what brings you here?
* what do you do for fun?
* what are your hobbies?
* what makes you tick?
* would you prefer this, or that?
* shall we continue?
* where do we go from here?

### Echoing and parroting

* repeats the user's exact phrase as a question
* restates the user's action before responding
* "So that's what we're calling it now?"
* "You really just said X."
* "You're either very X or very Y. Probably both."
* "No one ever X before."
* "Let's not get ahead of ourselves."
* "Just because you X, don't think Y."
* "Try not to X too much."
* "Don't X too hard."
* "You're enjoying this, aren't you?"
* "You have no idea what you're doing to me."

### Scene-setting slop

* dust motes
* golden light
* warm light
* dimly lit room
* neon glow
* scent of ozone
* ozone in the air
* metallic tang
* coppery tang
* smell of rain
* scent uniquely hers
* something distinctly him
* something distinctly you
* masculine scent
* feminine scent
* the city hummed outside
* somewhere, a dog barked
* somewhere, X happened
* outside, X; inside, Y
* the sun dipped below the horizon
* sunset arrived suddenly
* the room felt charged
* shadows danced

### Tsundere / defensive deflection slop

* it's not like I care
* don't get the wrong idea
* purely for research
* purely for educational purposes
* this is just tactical
* tactical retreat
* strategic maneuver
* adequate
* acceptable
* hmph
* idiot
* don't think this means anything
* I'm only doing this because
* you're impossible
* you're insufferable
* you're annoying, you know that?
* I hate that you're right

### Over-technical or out-of-character diction

* structural integrity
* assessing variables
* recalibrating
* hypothesis
* data point
* optimal
* inefficient
* adequate
* acceptable
* statistically
* biologically
* physiologically
* strategically
* tactically
* non-negotiable
* utterly
* completely
* quiet and efficient
* clinical precision
* predatory grace
* controlled chaos`;

function safeText(value, limit = MAX_CONTEXT_TEXT) {
  return truncate(compact(String(value ?? '').replace(SECRET_PATTERN, '[redacted]')), limit);
}

function safeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return ['user', 'assistant', 'system'].includes(role) ? role : 'assistant';
}

function sceneContextBlock(messages = [], limit = 13) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-Math.max(0, Math.round(Number(limit) || 0)))
    .map((message) => {
      const source = asObject(message);
      const text = safeText(source.text ?? source.mes ?? '', MAX_CONTEXT_TEXT);
      if (!text) return '';
      return `[${safeRole(source.role)} ${Number(source.mesid ?? source.id ?? 0)}]\n${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function dialogueSpans(text) {
  const source = String(text ?? '');
  const spans = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let match;
  while ((match = pattern.exec(source))) spans.push(match[0]);
  return spans;
}

function escapedRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bannedSlopPhrases() {
  return BANNED_AI_SLOP_LIST
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('* '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function stripBannedSlop(value) {
  let output = String(value ?? '');
  for (const phrase of bannedSlopPhrases()) {
    output = output.replace(new RegExp(escapedRegex(phrase), 'ig'), '');
  }
  return output.replace(/[^\w]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function dialogueDiffLimitedToBannedSlop(originalDialog = [], rewrittenDialog = []) {
  const original = originalDialog.map(stripBannedSlop).filter(Boolean);
  const rewritten = rewrittenDialog.map(stripBannedSlop).filter(Boolean);
  return JSON.stringify(original) === JSON.stringify(rewritten);
}

function diagnosticsList(...values) {
  return values.flat().map((entry) => safeText(entry, MAX_DIAGNOSTIC)).filter(Boolean);
}

export function proseEnhancementKey({ chatKey = '', messageId = '', swipeId = '', originalHash = '' } = {}) {
  return [chatKey, messageId, swipeId, originalHash].map((part) => String(part ?? '')).join('::');
}

export function buildProseEnhancementRequest(input = {}) {
  const source = asObject(input);
  const sourceMessageHash = safeText(source.sourceMessageHash, 180);
  const textToTransform = truncate(String(source.textToTransform ?? ''), MAX_TARGET_TEXT);
  const scene = sceneContextBlock(source.sceneMessages, source.contextMessages);
  const systemPrompt = [
    'You are a prose editor. Your job is to rewrite <text_to_transform> into stronger prose while preserving all dialogue except explicitly banned slop.',
    'Rules:',
    '- Do not change any dialogue. Not a single word.',
    "- Exception: the banned AI slop list below can override this dialogue rule. If a dialogue span contains one of those exact banned phrases or an obvious direct variant, remove or neutralize only that phrase while preserving the character's intended meaning.",
    '- You may rewrite non-dialogue prose freely for rhythm, clarity, diction, texture, pacing, and sentence structure.',
    '- You may change non-dialogue narration, action phrasing, descriptive framing, and transitions when it improves the prose.',
    '- Write in the verb tenses the original text is written, keeping the grammatical person as well.',
    '- Prioritize avoiding repetition of descriptive words by changing the phrase or removing it altogether.',
    'Slop reduction:',
    '- Apply the full banned AI slop and cliché list below. Do not reduce, summarize, or paraphrase the list in the implementation prompt.',
    '- Do not replace one banned pattern with a neighboring cliché. If a phrase is empty atmosphere or filler, cut it rather than swapping in a synonym.',
    '- Do not rename existing characters or add new names to avoid a cliché.',
    BANNED_AI_SLOP_LIST,
    'Return JSON only with schema, sourceMessageHash, rewrittenText, and diagnostics.'
  ].join('\n');
  const userPrompt = [
    `<source_message_hash>${sourceMessageHash}</source_message_hash>`,
    scene ? `<scene_context>\n${scene}\n</scene_context>` : '<scene_context></scene_context>',
    `<text_to_transform>\n${textToTransform}\n</text_to_transform>`,
    `Expected JSON: {"schema":"${PROSE_ENHANCER_SCHEMA}","sourceMessageHash":"${sourceMessageHash}","rewrittenText":"...","diagnostics":[]}`
  ].join('\n\n');
  return {
    roleId: 'proseEnhancer',
    lane: 'utility',
    responseSchema: PROSE_ENHANCER_SCHEMA,
    machineJson: true,
    sourceMessageHash,
    messageId: source.messageId,
    swipeId: source.swipeId,
    prompt: userPrompt,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };
}

export function validateProseEnhancementResult(result = {}, context = {}) {
  const data = asObject(result.data);
  const originalText = String(context.originalText ?? '');
  const expectedHash = safeText(context.sourceMessageHash, 180);
  const rewrittenText = String(data.rewrittenText ?? '');
  const originalDialog = dialogueSpans(originalText);
  const rewrittenDialog = dialogueSpans(rewrittenText);
  const diagnostics = [];
  if (result.ok === false) diagnostics.push('provider-failed');
  if (data.schema !== PROSE_ENHANCER_SCHEMA) diagnostics.push('schema-mismatch');
  if (safeText(data.sourceMessageHash, 180) !== expectedHash) diagnostics.push('source-hash-mismatch');
  if (!rewrittenText.trim()) diagnostics.push('empty-output');
  const ratio = originalText.length > 0 ? rewrittenText.length / originalText.length : 1;
  if (ratio < 0.55 || ratio > 1.75) diagnostics.push('length-ratio-out-of-range');
  if (
    (originalDialog.length !== rewrittenDialog.length || originalDialog.some((span, index) => span !== rewrittenDialog[index]))
    && !dialogueDiffLimitedToBannedSlop(originalDialog, rewrittenDialog)
  ) {
    diagnostics.push('dialogue-changed');
  }
  if (SECRET_PATTERN.test(rewrittenText)) diagnostics.push('unsafe-marker');
  if (diagnostics.length) return { ok: false, text: '', diagnostics: diagnosticsList(diagnostics, data.diagnostics) };
  return { ok: true, text: rewrittenText, diagnostics: diagnosticsList(data.diagnostics) };
}
```

- [ ] **Step 4: Wire alpha gate**

Add this command to `tools/scripts/run-alpha-gate.mjs` in the deterministic test list:

```js
'test-prose-enhancement.mjs',
```

- [ ] **Step 5: Run pure test**

Run:

```powershell
node tools\scripts\test-prose-enhancement.mjs
```

Expected: `[pass] prose-enhancement`.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/prose-enhancement.mjs tools/scripts/test-prose-enhancement.mjs tools/scripts/run-alpha-gate.mjs
git commit -m "feat: add prose enhancement validation"
```

---

### Task 4: SillyTavern Host Message Mutation Adapter

**Files:**
- Modify: `src/hosts/sillytavern/host.mjs`
- Modify: `tools/scripts/test-host.mjs`

**Interfaces:**
- Produces: `host.messages.holdAssistantMessage(messageId)`
- Produces: `host.messages.revealAssistantMessage(messageId)`
- Produces: `host.messages.replaceAssistantMessageText(messageId, text, options)`
- Produces: `host.messages.appendAssistantMessageSwipe(messageId, text, options)`
- Produces: `host.messages.findEnhancedSwipe(messageId, marker)`
- Consumed by: runtime Prose Enhancement lifecycle.

- [ ] **Step 1: Write failing host tests**

In `tools/scripts/test-host.mjs`, add fake context coverage:

```js
{
  const chat = [
    { mesid: 0, is_user: true, mes: 'Open the door.' },
    { mesid: 1, is_user: false, mes: 'Mara blocked it.', swipes: ['Mara blocked it.'], swipe_id: 0 }
  ];
  const updated = [];
  let saved = 0;
  const host = createSillyTavernHost({
    contextFactory: () => ({
      chat,
      updateMessageBlock: (id, message) => updated.push({ id, text: message.mes, swipe_id: message.swipe_id }),
      saveChat: () => { saved += 1; }
    }),
    fetchImpl: null
  });
  const hold = await host.messages.holdAssistantMessage(1);
  assertEqual(hold.ok, true, 'hold assistant message succeeds');
  assertEqual(chat[1].mes, '', 'hold blanks visible message text');
  const append = await host.messages.appendAssistantMessageSwipe(1, 'Mara stood before the sealed door.', {
    select: true,
    marker: { originalHash: 'hash-original', enhancedHash: 'hash-enhanced' }
  });
  assertEqual(append.ok, true, 'append enhanced swipe succeeds');
  assertEqual(chat[1].swipes.length, 2, 'append creates enhanced sibling swipe');
  assertEqual(chat[1].swipe_id, 1, 'append selects enhanced swipe');
  assertEqual(chat[1].mes, 'Mara stood before the sealed door.', 'selected enhanced text is visible');
  const duplicate = await host.messages.findEnhancedSwipe(1, { originalHash: 'hash-original' });
  assertEqual(duplicate.found, true, 'existing enhanced sibling can be found');
  const replace = await host.messages.replaceAssistantMessageText(1, 'Mara held the sealed doorway.', {
    marker: { originalHash: 'hash-replace', enhancedHash: 'hash-replace-enhanced' }
  });
  assertEqual(replace.ok, true, 'replace active assistant text succeeds');
  assertEqual(chat[1].mes, 'Mara held the sealed doorway.', 'replace updates visible text');
  assert(saved > 0, 'message mutations save chat');
  assert(updated.length > 0, 'message mutations update rendered block');
}
```

- [ ] **Step 2: Run failing host test**

Run:

```powershell
node tools\scripts\test-host.mjs
```

Expected: failure because `host.messages` is missing.

- [ ] **Step 3: Implement host methods**

In `src/hosts/sillytavern/host.mjs`, add helper functions near existing message helpers:

```js
function findRawMessageById(context, messageId) {
  const messages = rawChatMessages(context);
  const wanted = stringValue(messageId);
  return messages.find((message, index) => stringValue(message?.mesid ?? message?.id ?? index) === wanted) || null;
}

function updateMessage(context, messageId, message) {
  const update = context.updateMessageBlock || globalThis.updateMessageBlock;
  if (typeof update === 'function') update(messageId, message);
  const save = context.saveChat || globalThis.saveChat;
  if (typeof save === 'function') save();
}

function ensureSwipeArray(message) {
  if (!Array.isArray(message.swipes)) message.swipes = [stringValue(message.mes)];
  if (!Number.isFinite(Number(message.swipe_id))) message.swipe_id = Math.max(0, message.swipes.length - 1);
  return message.swipes;
}
```

Add `messages` to returned host:

```js
messages: {
  async holdAssistantMessage(messageId) {
    const context = currentContext(contextFactory);
    const message = findRawMessageById(context, messageId);
    if (!message || messageRole(message) !== 'assistant') return { ok: false, error: { code: 'RECURSION_MESSAGE_NOT_FOUND' } };
    message.__recursionHeldText = stringValue(message.mes);
    message.mes = '';
    updateMessage(context, messageId, message);
    return { ok: true };
  },
  async revealAssistantMessage(messageId) {
    const context = currentContext(contextFactory);
    const message = findRawMessageById(context, messageId);
    if (!message || messageRole(message) !== 'assistant') return { ok: false, error: { code: 'RECURSION_MESSAGE_NOT_FOUND' } };
    if (message.mes === '' && message.__recursionHeldText) message.mes = message.__recursionHeldText;
    delete message.__recursionHeldText;
    updateMessage(context, messageId, message);
    return { ok: true };
  },
  async replaceAssistantMessageText(messageId, text, options = {}) {
    const context = currentContext(contextFactory);
    const message = findRawMessageById(context, messageId);
    if (!message || messageRole(message) !== 'assistant') return { ok: false, error: { code: 'RECURSION_MESSAGE_NOT_FOUND' } };
    const nextText = stringValue(text);
    const swipes = ensureSwipeArray(message);
    const active = Math.max(0, Math.min(swipes.length - 1, Number(message.swipe_id) || 0));
    swipes[active] = nextText;
    message.mes = nextText;
    message.recursionProseEnhancement = options.marker || null;
    delete message.__recursionHeldText;
    updateMessage(context, messageId, message);
    return { ok: true, messageId, swipeId: active };
  },
  async appendAssistantMessageSwipe(messageId, text, options = {}) {
    const context = currentContext(contextFactory);
    const message = findRawMessageById(context, messageId);
    if (!message || messageRole(message) !== 'assistant') return { ok: false, error: { code: 'RECURSION_MESSAGE_NOT_FOUND' } };
    const swipes = ensureSwipeArray(message);
    const marker = options.marker || {};
    const existing = swipes.findIndex((_, index) => message.recursionProseEnhancementSwipes?.[index]?.originalHash === marker.originalHash);
    const swipeId = existing >= 0 ? existing : swipes.push(stringValue(text)) - 1;
    if (!message.recursionProseEnhancementSwipes) message.recursionProseEnhancementSwipes = {};
    message.recursionProseEnhancementSwipes[swipeId] = marker;
    if (options.select === true) {
      message.swipe_id = swipeId;
      message.mes = swipes[swipeId];
    }
    delete message.__recursionHeldText;
    updateMessage(context, messageId, message);
    return { ok: true, messageId, swipeId, duplicate: existing >= 0 };
  },
  async findEnhancedSwipe(messageId, marker = {}) {
    const context = currentContext(contextFactory);
    const message = findRawMessageById(context, messageId);
    const entries = message?.recursionProseEnhancementSwipes || {};
    for (const [swipeId, entry] of Object.entries(entries)) {
      if (entry?.originalHash === marker.originalHash) return { found: true, swipeId: Number(swipeId), marker: entry };
    }
    return { found: false };
  },
  activeAssistantMessageIdentity() {
    return latestAssistantMessage(currentContext(contextFactory));
  }
},
```

- [ ] **Step 4: Run host test**

Run:

```powershell
node tools\scripts\test-host.mjs
```

Expected: `[pass] host`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/hosts/sillytavern/host.mjs tools/scripts/test-host.mjs
git commit -m "feat: add host prose mutation methods"
```

---

### Task 5: Runtime Lifecycle

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `src/extension/index.js`
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Produces: `runtime.armProseEnhancementHold(details)`
- Produces: `runtime.enhanceLatestAssistantMessage(details)`
- Consumes: `host.messages.*`
- Consumes: `buildProseEnhancementRequest` and `validateProseEnhancementResult`.

- [ ] **Step 1: Write runtime tests for Off, As Swipe, Replace, and failure**

Add to `tools/scripts/test-runtime.mjs`:

```js
{
  const mutations = [];
  const harness = createRuntimeHarness({
    settings: { proseEnhancement: { mode: 'as-swipe', contextMessages: 13 } },
    hostOverrides: {
      messages: {
        activeAssistantMessageIdentity: () => ({ mesid: 2, swipeId: 0, text: 'She looked at the door. "No," she said.' }),
        holdAssistantMessage: async (id) => { mutations.push(['hold', id]); return { ok: true }; },
        revealAssistantMessage: async (id) => { mutations.push(['reveal', id]); return { ok: true }; },
        findEnhancedSwipe: async () => ({ found: false }),
        appendAssistantMessageSwipe: async (id, text, options) => {
          mutations.push(['append', id, text, options.select]);
          return { ok: true, swipeId: 1 };
        }
      }
    },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'proseEnhancer', 'As Swipe calls proseEnhancer');
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            sourceMessageHash: request.sourceMessageHash,
            rewrittenText: 'She looked toward the door. "No," she said.',
            diagnostics: []
          }
        };
      }
    }
  });
  const result = await harness.runtime.enhanceLatestAssistantMessage({ reason: 'assistant-message-landed' });
  assertEqual(result.ok, true, 'As Swipe enhancement succeeds');
  assertDeepEqual(mutations.map((entry) => entry[0]), ['hold', 'append', 'reveal'], 'As Swipe holds, appends, reveals');
  assertEqual(mutations[1][3], true, 'As Swipe selects enhanced swipe');
}

{
  const mutations = [];
  const harness = createRuntimeHarness({
    settings: { proseEnhancement: { mode: 'replace', contextMessages: 13 } },
    hostOverrides: {
      messages: {
        activeAssistantMessageIdentity: () => ({ mesid: 2, swipeId: 0, text: 'She waited. "No," she said.' }),
        holdAssistantMessage: async (id) => { mutations.push(['hold', id]); return { ok: true }; },
        revealAssistantMessage: async (id) => { mutations.push(['reveal', id]); return { ok: true }; },
        replaceAssistantMessageText: async (id, text) => { mutations.push(['replace', id, text]); return { ok: true }; }
      }
    },
    generationRouter: {
      async generate(roleId, request = {}) {
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            sourceMessageHash: request.sourceMessageHash,
            rewrittenText: 'She held still. "No," she said.',
            diagnostics: []
          }
        };
      }
    }
  });
  const result = await harness.runtime.enhanceLatestAssistantMessage({ reason: 'assistant-message-landed' });
  assertEqual(result.ok, true, 'Replace enhancement succeeds');
  assertDeepEqual(mutations.map((entry) => entry[0]), ['hold', 'replace', 'reveal'], 'Replace holds, replaces, reveals');
}

{
  const mutations = [];
  const harness = createRuntimeHarness({
    settings: { proseEnhancement: { mode: 'replace', contextMessages: 13 } },
    hostOverrides: {
      messages: {
        activeAssistantMessageIdentity: () => ({ mesid: 2, swipeId: 0, text: 'She waited. "No," she said.' }),
        holdAssistantMessage: async (id) => { mutations.push(['hold', id]); return { ok: true }; },
        revealAssistantMessage: async (id) => { mutations.push(['reveal', id]); return { ok: true }; },
        replaceAssistantMessageText: async () => { mutations.push(['replace']); return { ok: true }; }
      }
    },
    generationRouter: {
      async generate(roleId, request = {}) {
        return {
          ok: true,
          data: {
            schema: 'recursion.proseEnhancer.v1',
            sourceMessageHash: request.sourceMessageHash,
            rewrittenText: 'She waited. "Please no," she said.',
            diagnostics: []
          }
        };
      }
    }
  });
  const result = await harness.runtime.enhanceLatestAssistantMessage({ reason: 'assistant-message-landed' });
  assertEqual(result.skipped, true, 'changed dialogue skips enhancement');
  assertDeepEqual(mutations.map((entry) => entry[0]), ['hold', 'reveal'], 'failure reveals original without replace');
}
```

- [ ] **Step 2: Run failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: failure because `enhanceLatestAssistantMessage` does not exist.

- [ ] **Step 3: Implement runtime orchestration**

In `src/runtime.mjs`, import:

```js
import {
  buildProseEnhancementRequest,
  proseEnhancementKey,
  validateProseEnhancementResult
} from './prose-enhancement.mjs';
```

Add state near other runtime local state:

```js
const proseEnhancementInFlight = new Map();
```

Add function inside `createRecursionRuntime`:

```js
async function enhanceLatestAssistantMessage(details = {}) {
  const settings = settingsStore.get();
  const config = settings.proseEnhancement || { mode: 'off', contextMessages: 13 };
  if (config.mode === 'off') return { ok: true, skipped: true, reason: 'prose-enhancement-off' };
  const identity = host.messages?.activeAssistantMessageIdentity?.();
  const messageId = identity?.mesid ?? identity?.messageId ?? identity?.id;
  const swipeId = Number.isFinite(Number(identity?.swipeId)) ? Number(identity.swipeId) : 0;
  const originalText = String(identity?.text || '');
  if (!messageId || !originalText.trim()) return { ok: true, skipped: true, reason: 'no-assistant-message' };
  const sourceMessageHash = hashJson(originalText);
  const key = proseEnhancementKey({ chatKey: lastSnapshot?.chatKey || 'chat', messageId, swipeId, originalHash: sourceMessageHash });
  if (proseEnhancementInFlight.has(key)) return { ok: true, skipped: true, reason: 'prose-enhancement-duplicate-in-flight' };
  proseEnhancementInFlight.set(key, true);
  try {
    const hold = await host.messages?.holdAssistantMessage?.(messageId);
    if (hold?.ok === false) return { ok: true, skipped: true, reason: 'prose-enhancement-hold-failed' };
    stageRuntimeActivity({ phase: 'proseEnhancing', label: 'Enhancing prose...', mode: 'background', chips: ['Prose'] });
    const snapshot = normalizeSnapshot(await host.snapshot());
    const request = buildProseEnhancementRequest({
      messageId,
      swipeId,
      sourceMessageHash,
      textToTransform: originalText,
      sceneMessages: snapshot.messages,
      contextMessages: config.contextMessages,
      storyForm: lastPlan?.storyForm
    });
    const providerResult = await generationRouter.generate('proseEnhancer', request, {
      runId: makeId('prose-enhancement'),
      timeoutMs: 45000
    });
    const validated = validateProseEnhancementResult(providerResult, { originalText, sourceMessageHash });
    if (!validated.ok) {
      await host.messages?.revealAssistantMessage?.(messageId);
      settleRuntimeActivity({ outcome: 'warning', label: 'Prose enhancement skipped.', detail: { diagnostics: validated.diagnostics } });
      return { ok: true, skipped: true, reason: 'prose-enhancement-validation-failed', diagnostics: validated.diagnostics };
    }
    const marker = {
      originalHash: sourceMessageHash,
      enhancedHash: hashJson(validated.text),
      sourceRevisionHash: snapshot.sourceRevisionHash,
      mode: config.mode
    };
    if (config.mode === 'as-swipe') {
      const existing = await host.messages?.findEnhancedSwipe?.(messageId, marker);
      if (existing?.found) {
        await host.messages?.appendAssistantMessageSwipe?.(messageId, validated.text, { select: true, marker });
      } else {
        await host.messages?.appendAssistantMessageSwipe?.(messageId, validated.text, { select: true, marker });
      }
    } else {
      await host.messages?.replaceAssistantMessageText?.(messageId, validated.text, { marker });
    }
    await host.messages?.revealAssistantMessage?.(messageId);
    settleRuntimeActivity({ outcome: 'success', label: 'Prose enhanced.' });
    return { ok: true, mode: config.mode, messageId, swipeId };
  } finally {
    proseEnhancementInFlight.delete(key);
  }
}
```

Return it from runtime:

```js
enhanceLatestAssistantMessage,
```

- [ ] **Step 4: Wire extension event order**

In `src/extension/index.js`, update assistant landed handler so Prose Enhancement runs before Rapid warm:

```js
const enhanced = ended.then(() => invokeRuntimeCleanup(
  'enhanceLatestAssistantMessage',
  'Prose Enhancement failed.',
  normalizeHostMessageEvent(currentHost, eventName, payload)
));
if (!nextAssistantIdentity || nextAssistantIdentity === lastAssistantIdentity) {
  return enhanced.then(() => ({ ok: true, skipped: true, reason: 'assistant-message-unchanged' }));
}
lastAssistantIdentity = nextAssistantIdentity;
return enhanced.then(() => invokeRuntimeCleanup('warmRapidScene', 'Rapid warm failed.', { reason: 'assistant-message-landed' }));
```

- [ ] **Step 5: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: `[pass] runtime`.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/runtime.mjs src/extension/index.js tools/scripts/test-runtime.mjs
git commit -m "feat: run prose enhancement after generation"
```

---

### Task 6: UI Bar Control, Advanced Setting, And Status

**Files:**
- Create: `assets/icons/upgrade.svg`
- Modify: `src/ui.mjs`
- Modify: `src/ui/view-model.mjs`
- Modify: `styles/recursion.css` only if needed
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: `view.settings.proseEnhancement`
- Produces bar settings patch: `{ proseEnhancement: { mode } }`
- Produces Advanced settings patch: `{ proseEnhancement: { contextMessages } }`
- Produces status label for phase `proseEnhancing`.

- [ ] **Step 1: Copy icon asset**

Copy `C:/Users/Keptin/Downloads/upgrade.svg` into the repo as:

```text
assets/icons/upgrade.svg
```

Keep the SVG repo-local so the extension does not depend on the user's Downloads folder. If the SVG hardcodes black fill, normalize it to `fill="currentColor"` so the icon can grey out and inherit Recursion chrome color.

- [ ] **Step 2: Write failing UI tests**

In `tools/scripts/test-ui.mjs`, add settings assertions:

```js
assert(root.querySelector('[data-recursion-prose-enhancement-button]'), 'Bar renders Prose Enhancement icon button');
assert(root.querySelector('[data-recursion-prose-enhancement-button] svg, [data-recursion-prose-enhancement-button] img'), 'Prose Enhancement button renders upgrade icon');
assert(root.querySelector('[data-recursion-prose-enhancement-button]').classList.contains('is-off'), 'Prose Enhancement icon greys out when off');
root.querySelector('[data-recursion-prose-enhancement-button]').click();
assert(root.querySelector('[data-recursion-prose-enhancement-menu]'), 'Prose Enhancement button opens dropdown menu');
assertDeepEqual(
  [...root.querySelectorAll('[data-recursion-prose-enhancement-choice]')].map((choice) => choice.dataset.recursionProseEnhancementChoice),
  ['off', 'as-swipe', 'replace'],
  'Prose Enhancement dropdown options are Off, As Swipe, Replace'
);
assert(root.querySelector('[data-recursion-prose-enhancement-choice="off"]').textContent.includes('Shows SillyTavern output unchanged.'), 'Off row has mini-description');
assert(root.querySelector('[data-recursion-prose-enhancement-choice="as-swipe"]').textContent.includes('Keeps the original'), 'As Swipe row has mini-description');
assert(root.querySelector('[data-recursion-prose-enhancement-choice="replace"]').textContent.includes('Shows only the enhanced version'), 'Replace row has mini-description');
root.querySelector('[data-recursion-prose-enhancement-choice="as-swipe"]').click();
assertDeepEqual(settingsUpdates.at(-1), { proseEnhancement: { mode: 'as-swipe' } }, 'Prose Enhancement dropdown autosaves mode');

assert(root.querySelector('[data-recursion-prose-enhancement-context]'), 'Settings render Prose Enhancement context input');
root.querySelector('[data-recursion-prose-enhancement-context]').value = '21';
root.querySelector('[data-recursion-prose-enhancement-context]').dispatchEvent(new Event('change', { bubbles: true }));
assertDeepEqual(settingsUpdates.at(-1), { proseEnhancement: { contextMessages: 21 } }, 'Prose Enhancement context autosaves');

view = { ...view, activity: { phase: 'proseEnhancing', label: 'Enhancing prose...' } };
ui.update();
assert(root.textContent.includes('Enhancing prose...'), 'UI renders Prose Enhancement status');
```

- [ ] **Step 3: Run failing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: failure because bar control, dropdown, or context control is missing.

- [ ] **Step 4: Add view model status**

In `src/ui/view-model.mjs`, add to phase labels:

```js
proseEnhancing: 'Enhancing prose...',
```

- [ ] **Step 5: Add bar dropdown control**

In `src/ui.mjs`, add the icon-only Prose Enhancement control immediately after the Cards button in the compact bar layout:

```js
const PROSE_ENHANCEMENT_OPTIONS = Object.freeze([
  {
    value: 'off',
    label: 'Off',
    tip: 'Shows SillyTavern output unchanged.'
  },
  {
    value: 'as-swipe',
    label: 'As Swipe',
    tip: 'Keeps the original and selects one enhanced sibling swipe.'
  },
  {
    value: 'replace',
    label: 'Replace',
    tip: 'Shows only the enhanced version when validation passes.'
  }
]);
```

Use the existing Mode dropdown structure as the implementation pattern. Required attributes:

```js
el('button', {
  className: `recursion-icon-button recursion-prose-enhancement-button ${mode === 'off' ? 'is-off' : ''}`,
  attrs: {
    type: 'button',
    title: `Prose Enhancement: ${label}`,
    'aria-label': `Prose Enhancement: ${label}`,
    'aria-expanded': state.proseEnhancementOpen ? 'true' : 'false',
    'data-recursion-prose-enhancement-button': ''
  }
}, [
  upgradeIconSvg()
]);
```

Dropdown row shape:

```js
el('button', {
  className: `recursion-mode-choice ${mode === option.value ? 'is-selected' : ''}`,
  attrs: {
    type: 'button',
    'data-recursion-prose-enhancement-choice': option.value,
    title: option.tip
  },
  on: {
    click: () => actions.updateSettings?.({ proseEnhancement: { mode: option.value } })
  }
}, [
  el('span', { className: 'recursion-mode-choice-icon' }, [upgradeIconSvg()]),
  el('span', {}, [
    el('span', { className: 'recursion-mode-choice-name' }, [option.label]),
    el('span', { className: 'recursion-mode-choice-tip' }, [option.tip])
  ])
]);
```

Implement `upgradeIconSvg()` from `assets/icons/upgrade.svg` using current-color SVG paths, matching existing repo icon conventions.

- [ ] **Step 6: Add Advanced context setting**

In `src/ui.mjs`, add `Context Messages` under Advanced settings:

```js
field.append(
  label('Prose Enhancement Context Messages'),
  numberInput({
    value: settings.proseEnhancement?.contextMessages ?? 13,
    min: 0,
    max: 35,
    dataset: { recursionProseEnhancementContext: '' },
    onChange: (event) => actions.updateSettings?.({ proseEnhancement: { contextMessages: Number(event.target.value) } })
  })
);
```

Use existing local helper names for labels and number inputs. If helper names differ, implement the same attributes and patch shape using current UI patterns.

- [ ] **Step 7: Run UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: `[pass] ui`.

- [ ] **Step 8: Commit**

Run:

```powershell
git add assets/icons/upgrade.svg src/ui.mjs src/ui/view-model.mjs styles/recursion.css tools/scripts/test-ui.mjs
git commit -m "feat: add prose enhancement bar control"
```

---

### Task 7: Focused Gates And Alpha Gate

**Files:**
- Modify only if focused gates reveal missing contracts.

**Interfaces:**
- Consumes all previous tasks.
- Produces no new API.

- [ ] **Step 1: Run focused deterministic tests**

Run:

```powershell
node tools\scripts\test-settings.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-prose-enhancement.mjs
node tools\scripts\test-host.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-ui.mjs
```

Expected: each script prints `[pass] ...`.

- [ ] **Step 2: Run alpha gate**

Run:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: alpha gate completes without failures.

- [ ] **Step 3: Fix gate failures**

If a gate fails, patch the smallest file that owns the failed contract, rerun the failing command, then rerun alpha gate.

- [ ] **Step 4: Commit gate fixes**

Run only if files changed:

```powershell
git add src tools
git commit -m "fix: complete prose enhancement gates"
```

---

### Task 8: Documentation Updates

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
- Consumes final V1 runtime/settings/provider contract.
- Produces aligned docs.

- [ ] **Step 1: Update product docs**

Add:

```markdown
Prose Enhancement is an optional post-generation Utility pass. `Off` leaves SillyTavern output unchanged. `As Swipe` preserves the original host output and creates one enhanced sibling swipe, selecting the enhanced swipe automatically. `Replace` replaces the active assistant text with the enhanced result. If enhancement fails, Recursion reveals the original output unchanged.
```

- [ ] **Step 2: Update architecture docs**

Add lifecycle:

```text
Host generation starts -> arm hold when Prose Enhancement enabled -> assistant lands -> hold output -> Utility proseEnhancer -> validate schema, hard length cap, and dialogue invariants -> append enhanced swipe or replace active text -> reveal message -> Rapid warm may continue
```

- [ ] **Step 3: Update provider docs**

Add role row:

```markdown
| `proseEnhancer` | Utility | Rewrite the latest assistant non-dialogue prose using bounded scene context. | Reveal original unchanged when Utility is unavailable, schema is invalid, or dialogue changes. |
```

Add schema:

```markdown
`proseEnhancer` returns `recursion.proseEnhancer.v1` with `text`. It is structured JSON even though the rewritten text itself is prose.
```

- [ ] **Step 4: Update UI docs**

Add bar control contract:

```markdown
The compact bar includes one icon-only `Prose Enhancement` button immediately to the right of Cards. It uses the repo-local `upgrade.svg` icon and opens a Mode-like dropdown with `Off`, `As Swipe`, and `Replace`, each with a mini-description. When set to `Off`, the icon greys out like the disabled On/Off treatment. It does not expose a Recast-style pass editor. `As Swipe` is the review surface because it keeps the original host output as a sibling swipe and selects the enhanced swipe automatically.
```

- [ ] **Step 5: Update user docs**

Add:

```markdown
Use `As Swipe` when you want a reversible polish pass. Use `Replace` when you want the chat to show only the polished output. Both modes hide the raw host output while enhancement runs; if enhancement cannot safely apply, Recursion shows the original.
```

- [ ] **Step 6: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: no trailing whitespace warnings.

- [ ] **Step 7: Commit docs**

Run:

```powershell
git add docs/RECURSION_EXTENSION_SPEC.md docs/architecture/RUNTIME_ARCHITECTURE.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md docs/technical/RECURSION_TECHNICAL_MANUAL.md docs/design/UI_SPEC.md docs/user/RECURSION_OPERATOR_MANUAL.md docs/testing/LIVE_SMOKE_TEST_PLAN.md
git commit -m "docs: describe prose enhancement"
```

---

### Task 9: Live SillyTavern Proof

**Files:**
- Create: `tools/scripts/prove-live-prose-enhancement.mjs`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md`

**Interfaces:**
- Consumes implemented host/runtime feature.
- Produces live proof artifacts and command.

- [ ] **Step 1: Add live proof script**

Create `tools/scripts/prove-live-prose-enhancement.mjs` using the existing live harness pattern. The script must:

```js
// Required assertions:
// 1. Served Recursion copy is fresh.
// 2. Set Prose Enhancement to As Swipe.
// 3. Generate one assistant response.
// 4. Wait for Prose Enhancement status to settle.
// 5. Assert active assistant message has at least two swipes.
// 6. Assert active swipe is the enhanced swipe.
// 7. Assert original swipe text still exists.
// 8. Switch to Replace.
// 9. Generate or swipe again.
// 10. Assert active assistant text changed by enhancement or original revealed on validation failure.
// 11. Assert no duplicate enhanced sibling for same original hash.
```

- [ ] **Step 2: Run readiness**

Run:

```powershell
node tools\scripts\check-playwright-readiness.mjs
```

Expected: readiness passes or reports exact missing prerequisite.

- [ ] **Step 3: Run live proof**

Run:

```powershell
node tools\scripts\prove-live-prose-enhancement.mjs
```

Expected:

- served extension copy is fresh;
- As Swipe creates original + enhanced swipes;
- As Swipe appends matching `swipe_info` metadata and shows the enhanced swipe without a page reload;
- enhanced swipe is selected automatically;
- Replace updates active assistant text or reveals original on validation failure;
- status settles without blocking SillyTavern generation.

- [ ] **Step 4: Commit live proof**

Run:

```powershell
git add tools/scripts/prove-live-prose-enhancement.mjs docs/testing/LIVE_SMOKE_TEST_PLAN.md
git commit -m "test: prove prose enhancement live"
```

---

## Self-Review Checklist

- [ ] Plan covers `Off`, `As Swipe`, and `Replace`.
- [ ] Plan makes Prose Enhancement Utility-only.
- [ ] Plan requires structured schema `recursion.proseEnhancer.v1`.
- [ ] Plan includes dialogue byte-identity validation with banned-list exception.
- [ ] Plan includes full banned AI slop list intact in prompt instructions.
- [ ] Plan includes icon-only bar control to right of Cards using `upgrade.svg`.
- [ ] Plan includes Mode-like dropdown rows with mini-descriptions.
- [ ] Plan includes greyed-out icon treatment when mode is `off`.
- [ ] Plan includes hold/reveal behavior so raw output is not shown first when enabled.
- [ ] Plan keeps original output available in `As Swipe`.
- [ ] Plan requires `As Swipe` to maintain SillyTavern `swipe_info` and refresh the current chat view.
- [ ] Plan selects enhanced swipe automatically.
- [ ] Plan prevents duplicate enhanced siblings.
- [ ] Plan reveals original on validation/provider/hold/stale failures.
- [ ] Plan keeps host message mutation inside host adapter.
- [ ] Plan updates settings, UI, provider routing, runtime, host, docs, deterministic tests, alpha gate, and live proof.
- [ ] Plan has no Recast-style configurable pass editor or diff viewer.
