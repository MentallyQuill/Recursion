# Recursion Enhancement Context And Intervention Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Enhancements meaningfully rewrite weak dialogue/prose when there is clear slop while giving the passes enough bounded speaker, transcript, and card context to preserve character voice.

**Architecture:** Add a small pure `src/enhancement-context.mjs` module that turns the existing Enhancements context-message window plus the current selected hand into safe prompt context. Preserve sender names through runtime snapshot normalization, feed derived character/card context into Dialogue Enhancement, feed card/style context into Prose Enhancement, and add no-op rejection only when deterministic slop detectors say an intervention is required.

**Tech Stack:** JavaScript ES modules, Recursion runtime/provider modules, SillyTavern host adapter snapshots, deterministic Node tests, existing machine-JSON provider schema path.

## Global Constraints

- Recursion is pre-alpha; update code, docs, schemas, tests, and examples in place to the best current contract.
- The existing `enhancements.contextMessages` setting remains the operator-facing control for bounded transcript context.
- Enhancement requests must not include raw prompt packets, raw provider responses, hidden reasoning, secrets, API keys, or unbounded transcript text.
- Enhancement context must be derived from already-visible SillyTavern messages and already-selected Recursion card summaries only.
- Dialogue Enhancement must preserve scene events, dialogue span count, and narration shell unless a later approved validator change explicitly widens that boundary.
- Prose Enhancement must continue protecting ordinary dialogue, with the existing banned-dialogue exception.
- Byte-identical output remains valid only when deterministic detectors find no required intervention.
- If a required intervention is detected and the provider returns byte-identical text, validation fails and Recursion reveals the original unchanged.
- High and Ultra Enhancements request the Reasoner lane directly; Low and Medium use Utility.
- If this plan is implemented as a shipped checkpoint, bump Recursion from `0.1.0-pre-alpha.3` to `0.1.0-pre-alpha.4`.

---

## Strategy

The current problem is two separate failures that reinforce each other:

1. **Context Messages are too shallow.** Runtime sends recent transcript text, but runtime normalization drops `sender`, and the enhancer request does not include selected Recursion cards. The prompt asks the model to prioritize example dialogue and character/card context, but the real request mostly contains `assistant:` / `user:` lines.
2. **The passes are allowed to be timid.** Validators accept byte-identical text. That is correct for clean text, but wrong when the original contains deterministic slop such as forced agency questions or exact banned prose cliches.

The fix is not "always rewrite harder." The fix is:

- Keep the existing context-message setting, but make it richer and truthful by preserving sender labels and deriving bounded dialogue examples from the selected window.
- Pass selected hand cards into enhancement prompts using a compact safe representation.
- Add optional provider diagnostics so we can see whether the model found issues.
- Reject no-op outputs only when local detectors identify intervention-required slop.

---

## File Structure

- Create: `src/enhancement-context.mjs` - pure helpers for sender-aware transcript lines, recent dialogue examples, selected-card context, and combined enhancement context.
- Modify: `src/runtime.mjs` - preserve `sender` in normalized snapshots, build enhancement context from snapshot plus `lastHand`, and pass it into enhancement requests.
- Modify: `src/dialogue-enhancement.mjs` - use sender-aware context formatting, add intervention detectors, strengthen prompt instructions, accept optional diagnostics, and reject no-op when dialogue slop is detected.
- Modify: `src/prose-enhancement.mjs` - add optional `cardContext`, add intervention detectors around banned prose/dialogue slop, strengthen prompt instructions, and reject no-op when prose slop is detected.
- Modify: `tools/scripts/test-dialogue-enhancement.mjs` - sender/card context prompt coverage and no-op rejection coverage.
- Modify: `tools/scripts/test-prose-enhancement.mjs` - card context prompt coverage and no-op rejection coverage.
- Modify: `tools/scripts/test-runtime.mjs` - runtime passes sender/card/example context into Dialogue and Prose enhancement requests.
- Modify: `tools/scripts/test-storage.mjs`, `src/storage.mjs`, `manifest.json`, `package.json`, `docs/release/*` - only if shipping this as `0.1.0-pre-alpha.4`.

---

### Task 1: Preserve Sender In Runtime Snapshots

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Produces: normalized snapshot messages with optional `sender: string`.
- Consumed by: `src/enhancement-context.mjs` in Task 2.

- [ ] **Step 1: Write failing runtime normalization test**

Add a focused assertion near the existing enhancement runtime tests:

```js
{
  const proseHost = createProseMessageHarness('O\'Neill looked at Carter. "Options?"');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    snapshot: {
      messages: [
        { mesid: 1, role: 'assistant', sender: 'O\'Neill', text: '"Carter?"', visible: true },
        { mesid: 2, role: 'assistant', sender: 'Carter', text: '"Working on it, sir."', visible: true },
        { mesid: 3, role: 'assistant', sender: 'SG-1', text: proseHost.message.text, visible: true }
      ]
    },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'O\'Neill looked at Carter. "Options?"'
          }
        };
      }
    }
  });
  await runtime.enhanceLatestAssistantMessage({ reason: 'unit-enhancement-sender-context' });
  assert(
    routerCalls[0].request.contextMessages.some((message) => message.sender === 'Carter'),
    'Enhancement request preserves sender labels from the snapshot window'
  );
}
```

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: FAIL because runtime `normalizeMessage()` currently drops `sender`.

- [ ] **Step 2: Preserve sender in runtime normalized messages**

In `src/runtime.mjs`, update `normalizeMessage()`:

```js
function normalizeMessage(message, index) {
  const source = asObject(message);
  const mesid = numberOr(source.mesid ?? source.id ?? source.messageId, index);
  const rawText = source.text ?? source.mes ?? source.content ?? '';
  const swipeId = Number(source.swipeId ?? source.swipe_id);
  const swipeCount = Number(source.swipeCount ?? (Array.isArray(source.swipes) ? source.swipes.length : NaN));
  const role = cleanString(
    source.role ?? (source.is_user === true ? 'user' : (source.is_system === true ? 'system' : 'assistant')),
    'assistant'
  );
  const sender = safeText(source.sender || source.name || '', 120);
  return {
    mesid,
    role,
    ...(sender ? { sender } : {}),
    text: safeText(rawText, SNAPSHOT_MESSAGE_TEXT_LIMIT),
    textHash: hashJson(String(rawText ?? '')),
    ...(Number.isFinite(swipeId) ? { swipeId: Math.max(0, Math.round(swipeId)) } : {}),
    ...(Number.isFinite(swipeCount) ? { swipeCount: Math.max(0, Math.round(swipeCount)) } : {}),
    ...(source.activeSwipeTextHash ? { activeSwipeTextHash: safeText(source.activeSwipeTextHash, 180) } : {}),
    visible: source.visible === false || source.hidden === true ? false : true
  };
}
```

- [ ] **Step 3: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS.

---

### Task 2: Add Enhancement Context Builder

**Files:**
- Create: `src/enhancement-context.mjs`
- Modify: `tools/scripts/test-dialogue-enhancement.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Produces: `speakerLabel(message) -> string`
- Produces: `enhancementContextFromSnapshot({ snapshot, hand, activeText, activeSender, contextMessageLimit }) -> { contextMessages, characterContext, cardContext }`
- Consumed by: `src/runtime.mjs`, `src/dialogue-enhancement.mjs`, `src/prose-enhancement.mjs`.

- [ ] **Step 1: Add failing pure context tests**

Create a test block in `tools/scripts/test-dialogue-enhancement.mjs` after the first request assertions:

```js
import {
  enhancementContextFromSnapshot,
  speakerLabel
} from '../../src/enhancement-context.mjs';
```

Add:

```js
assertEqual(
  speakerLabel({ role: 'assistant', sender: 'Carter' }),
  'assistant(Carter)',
  'speaker label includes assistant sender name'
);

const enhancementContext = enhancementContextFromSnapshot({
  snapshot: {
    messages: [
      { role: 'assistant', sender: 'O\'Neill', text: 'O\'Neill folded his arms. "Carter?"', visible: true },
      { role: 'assistant', sender: 'Carter', text: 'Carter did not look up. "Working on it, sir."', visible: true },
      { role: 'user', sender: 'Will', text: 'Will waits.', visible: true }
    ]
  },
  hand: {
    cards: [
      { family: 'Active Cast', promptText: 'O\'Neill presses with dry understatement. Carter answers with technical brevity.' },
      { family: 'Social Subtext', promptText: 'SG-1 remains wary of Will but keeps the exchange professional.' },
      { family: 'Possessions & Items', promptText: 'Coffee mug on the table.' }
    ]
  },
  activeText: 'O\'Neill glanced over. "What do you want to do next?"',
  activeSender: 'SG-1',
  contextMessageLimit: 2
});

assertEqual(enhancementContext.contextMessages.length, 2, 'enhancement context respects context message limit');
assertEqual(enhancementContext.characterContext.name, 'SG-1', 'active sender becomes character context name');
assert(
  enhancementContext.characterContext.exampleDialogue.includes('"Working on it, sir."'),
  'recent dialogue examples are extracted from context messages'
);
assert(
  enhancementContext.cardContext.some((card) => card.family === 'Active Cast'),
  'enhancement card context keeps Active Cast'
);
assert(
  !enhancementContext.cardContext.some((card) => card.family === 'Possessions & Items'),
  'enhancement card context excludes low-voice item cards'
);
```

Run:

```powershell
node tools\scripts\test-dialogue-enhancement.mjs
```

Expected: FAIL because `src/enhancement-context.mjs` does not exist.

- [ ] **Step 2: Implement context builder**

Create `src/enhancement-context.mjs`:

```js
import { compact, truncate } from './core.mjs';
import { dialogueSpans } from './prose-enhancement.mjs';

const CONTEXT_TEXT_LIMIT = 1200;
const CARD_TEXT_LIMIT = 700;
const EXAMPLE_LIMIT = 8;
const ENHANCEMENT_CARD_FAMILIES = new Set([
  'Active Cast',
  'Character Motivation',
  'Dialogue Relationship',
  'Social Subtext',
  'Scene Constraints',
  'Open Threads'
]);
const SECRET_PATTERN = /(raw[-_\s]*prompt|rawPrompt|provider[-_\s]*response|hidden[-_\s]*reasoning|api[-_\s]*key|authorization|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]+)/ig;

function safeText(value, limit = CONTEXT_TEXT_LIMIT) {
  return truncate(compact(String(value ?? '').replace(SECRET_PATTERN, '[redacted]')), limit);
}

export function speakerLabel(message = {}) {
  const role = ['assistant', 'user', 'system'].includes(String(message.role || '').toLowerCase())
    ? String(message.role).toLowerCase()
    : 'assistant';
  const sender = safeText(message.sender || message.name || '', 120);
  return sender ? `${role}(${sender})` : role;
}

function visibleMessages(messages = [], limit = 13) {
  const bounded = Math.max(0, Math.min(35, Math.round(Number(limit) || 0)));
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.visible !== false)
    .slice(-bounded);
}

export function recentDialogueExamples(messages = [], { activeText = '', limit = EXAMPLE_LIMIT } = {}) {
  const active = String(activeText || '');
  const seen = new Set();
  const examples = [];
  for (const message of messages) {
    if (message?.visible === false) continue;
    const text = String(message.text ?? message.mes ?? message.content ?? '');
    if (!text.trim() || text === active) continue;
    for (const span of dialogueSpans(text)) {
      const example = safeText(span.text, 500);
      if (!example || seen.has(example)) continue;
      seen.add(example);
      examples.push(example);
      if (examples.length >= limit) return examples;
    }
  }
  return examples;
}

export function enhancementCardContextFromHand(hand = {}) {
  return (Array.isArray(hand?.cards) ? hand.cards : [])
    .filter((card) => ENHANCEMENT_CARD_FAMILIES.has(safeText(card?.family || '', 120)))
    .slice(0, 8)
    .map((card) => ({
      family: safeText(card.family, 80),
      text: safeText(card.promptText || card.summary || '', CARD_TEXT_LIMIT)
    }))
    .filter((card) => card.family && card.text);
}

export function enhancementContextFromSnapshot({
  snapshot = {},
  hand = {},
  activeText = '',
  activeSender = '',
  contextMessageLimit = 13
} = {}) {
  const messages = visibleMessages(snapshot.messages, contextMessageLimit);
  const latestAssistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  const sender = safeText(activeSender || latestAssistant?.sender || '', 120);
  return {
    contextMessages: messages,
    characterContext: {
      name: sender || 'assistant',
      description: 'Recent dialogue examples are derived from the bounded Enhancements context window.',
      exampleDialogue: recentDialogueExamples(messages, { activeText })
    },
    cardContext: enhancementCardContextFromHand(hand)
  };
}
```

- [ ] **Step 3: Run pure context test**

Run:

```powershell
node tools\scripts\test-dialogue-enhancement.mjs
```

Expected: PASS.

---

### Task 3: Feed Derived Context Into Runtime Enhancement Requests

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Consumes: `enhancementContextFromSnapshot(...)`.
- Produces: `dialogueEnhancer` requests with `contextMessages`, `characterContext`, and `cardContext`.
- Produces: `proseEnhancer` requests with `contextMessages` and `cardContext`.

- [ ] **Step 1: Write failing runtime request-context assertions**

Update the Task 1 runtime test generation router:

```js
generationRouter: {
  async generate(roleId, request) {
    routerCalls.push({ roleId, request });
    return {
      ok: true,
      data: {
        schema: 'recursion.dialogueEnhancer.v1',
        text: 'O\'Neill looked at Carter. "Options?"'
      }
    };
  }
}
```

After the enhancement call, assert:

```js
assertEqual(
  routerCalls[0].request.characterContext.name,
  'SG-1',
  'Dialogue Enhancement request receives active assistant sender as character context'
);
assert(
  routerCalls[0].request.characterContext.exampleDialogue.includes('"Working on it, sir."'),
  'Dialogue Enhancement request receives recent dialogue examples'
);
```

Add a second runtime test that seeds `lastHand` by running a normal prepare/generation fixture already used elsewhere in `test-runtime.mjs`, then runs `enhanceLatestAssistantMessage()` and asserts:

```js
assert(
  routerCalls.find((call) => call.roleId === 'dialogueEnhancer').request.cardContext
    .some((card) => card.family === 'Active Cast' || card.family === 'Social Subtext'),
  'Dialogue Enhancement request receives selected Recursion card context'
);
```

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: FAIL because runtime does not build or pass derived enhancement context.

- [ ] **Step 2: Import context builder**

At the top of `src/runtime.mjs`, add:

```js
import { enhancementContextFromSnapshot } from './enhancement-context.mjs';
```

- [ ] **Step 3: Build context once per enhancement run**

In `enhanceLatestAssistantMessage()`, replace:

```js
const contextMessages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
```

with:

```js
const enhancementContext = enhancementContextFromSnapshot({
  snapshot: snapshot || {},
  hand: lastHand,
  activeText: originalText,
  activeSender: identity.sender || '',
  contextMessageLimit: enhancementSettings.contextMessages
});
const contextMessages = enhancementContext.contextMessages;
```

If `activeAssistantMessageIdentity()` does not expose `sender`, leave the fallback blank for now. The snapshot-derived latest assistant sender still works for normal SillyTavern messages.

- [ ] **Step 4: Pass context into Dialogue request**

Update the Dialogue request:

```js
const request = buildDialogueEnhancementRequest({
  text: enhancedText,
  contextMessages,
  contextMessageLimit: enhancementSettings.contextMessages,
  storyForm,
  characterContext: enhancementContext.characterContext,
  cardContext: enhancementContext.cardContext,
  lane: enhancementLane,
  ...enhancementReasoning
});
```

- [ ] **Step 5: Pass card context into Prose request**

After Task 5 adds `cardContext` to `buildProseEnhancementRequest()`, update the Prose request:

```js
const request = buildProseEnhancementRequest({
  text: enhancedText,
  contextMessages,
  contextMessageLimit: enhancementSettings.contextMessages,
  storyForm,
  cardContext: enhancementContext.cardContext,
  lane: enhancementLane,
  ...enhancementReasoning
});
```

- [ ] **Step 6: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS after Task 5 is complete; before Task 5, expect Prose request assertions to fail if they check `cardContext`.

---

### Task 4: Make Dialogue Enhancement Less Timid

**Files:**
- Modify: `src/dialogue-enhancement.mjs`
- Modify: `tools/scripts/test-dialogue-enhancement.mjs`

**Interfaces:**
- Produces: `dialogueInterventionReasons(text) -> string[]`
- Updates: `validateDialogueEnhancementResult(result, { originalText })` rejects no-op only when intervention reasons exist.

- [ ] **Step 1: Add failing no-op and prompt-pressure tests**

In `tools/scripts/test-dialogue-enhancement.mjs`, extend the import:

```js
import {
  DIALOGUE_ENHANCER_SCHEMA,
  buildDialogueEnhancementRequest,
  dialogueInterventionReasons,
  validateDialogueEnhancementResult
} from '../../src/dialogue-enhancement.mjs';
```

Extend the helper import:

```js
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';
```

Add:

```js
assertDeepEqual(
  dialogueInterventionReasons('Mara set the cup down. "What do you want to do next?"'),
  ['forced-question'],
  'forced agency question requires dialogue intervention'
);

const rejectedNoopForcedQuestion = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: 'Mara set the cup down. "What do you want to do next?"'
}, { originalText: 'Mara set the cup down. "What do you want to do next?"' });
assertEqual(rejectedNoopForcedQuestion.ok, false, 'dialogue no-op is rejected when forced-question slop is detected');
assertEqual(
  rejectedNoopForcedQuestion.error.code,
  'RECURSION_DIALOGUE_NOOP_WITH_DETECTED_SLOP',
  'dialogue no-op rejection uses stable code'
);

const cleanNoop = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: 'Mara set the cup down. "Sit down before you fall over."'
}, { originalText: 'Mara set the cup down. "Sit down before you fall over."' });
assertEqual(cleanNoop.ok, true, 'dialogue no-op remains valid when no deterministic slop is detected');

assert(
  request.prompt.includes('If any intervention-required pattern appears, do not return the original text unchanged.'),
  'dialogue prompt explicitly forbids no-op when slop is detected'
);
assert(
  request.prompt.includes('"changePlan"'),
  'dialogue prompt requests optional change diagnostics'
);
```

Run:

```powershell
node tools\scripts\test-dialogue-enhancement.mjs
```

Expected: FAIL because intervention detection and prompt diagnostics do not exist.

- [ ] **Step 2: Add dialogue intervention detectors**

In `src/dialogue-enhancement.mjs`, add:

```js
const DIALOGUE_INTERVENTION_PATTERNS = Object.freeze([
  {
    id: 'forced-question',
    pattern: /\b(what do you (say|want)|what now|your move|the choice is yours|where do we go from here|do you want to\b|would you prefer\b)/i
  },
  {
    id: 'echoing',
    pattern: /\b(so that'?s what we'?re calling it now|you really just said|you'?re either .+ or .+ probably both|no one ever .+ before)\b/i
  },
  {
    id: 'unsupported-technical',
    pattern: /\b(assessing variables|recalibrating|hypothesis|data point|optimal|inefficient|statistically|tactically|non-negotiable)\b/i
  },
  {
    id: 'defensive-trope',
    pattern: /\b(it'?s not like i care|don'?t get the wrong idea|i'?m only doing this because|you'?re impossible|i hate that you'?re right)\b/i
  },
  {
    id: 'attraction-cliche',
    pattern: /\b(you'?re mine|ruin you|claim you|devour you|worship you|you'?re going to be the death of me|last chance to back out)\b/i
  }
]);

export function dialogueInterventionReasons(text = '') {
  const source = String(text || '');
  return DIALOGUE_INTERVENTION_PATTERNS
    .filter((entry) => entry.pattern.test(source))
    .map((entry) => entry.id);
}
```

- [ ] **Step 3: Strengthen Dialogue prompt**

In the prompt array after `Repair priorities`, add:

```js
'Intervention policy:',
'- If any intervention-required pattern appears, do not return the original text unchanged.',
'- Prefer one precise, character-consistent replacement over broad rewriting.',
'- If the dialogue is already clean, returning it unchanged is allowed.',
'- Optional diagnostics are allowed in changePlan, but the text field is the only applied output.',
'',
```

Replace the return-shape instruction with:

```js
`Return strict JSON only: {"schema":"${DIALOGUE_ENHANCER_SCHEMA}","text":"rewritten full assistant message","changePlan":{"changed":true,"targets":["forced-question"],"noChangeReason":""}}. No explanations, no notes, no commentary.`
```

- [ ] **Step 4: Reject no-op only when local detectors require intervention**

In `validateDialogueEnhancementResult()`, before returning success:

```js
const interventionReasons = dialogueInterventionReasons(originalText);
if (text === String(originalText ?? '') && interventionReasons.length) {
  return validationError(
    'RECURSION_DIALOGUE_NOOP_WITH_DETECTED_SLOP',
    `Dialogue enhancement returned unchanged text despite detected slop: ${interventionReasons.join(', ')}.`
  );
}
return { ok: true, text };
```

- [ ] **Step 5: Run Dialogue test**

Run:

```powershell
node tools\scripts\test-dialogue-enhancement.mjs
```

Expected: PASS.

---

### Task 5: Make Prose Enhancement Less Timid

**Files:**
- Modify: `src/prose-enhancement.mjs`
- Modify: `tools/scripts/test-prose-enhancement.mjs`

**Interfaces:**
- Produces: `proseInterventionReasons(text) -> string[]`
- Updates: `buildProseEnhancementRequest({ cardContext })`
- Updates: `validateProseEnhancementResult(result, { originalText })` rejects no-op only when intervention reasons exist.

- [ ] **Step 1: Add failing Prose no-op and card-context tests**

Extend the import:

```js
import {
  BANNED_AI_SLOP_LIST,
  PROSE_ENHANCER_SCHEMA,
  buildProseEnhancementRequest,
  dialogueSpans,
  proseEnhancementKey,
  proseInterventionReasons,
  validateProseEnhancementResult
} from '../../src/prose-enhancement.mjs';
```

Extend the helper import:

```js
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';
```

Update the request fixture:

```js
const request = buildProseEnhancementRequest({
  text: sourceText,
  contextMessages: [
    { role: 'user', sender: 'Will', text: 'What happens next?' },
    { role: 'assistant', sender: 'Mara', text: sourceText }
  ],
  cardContext: [
    { family: 'Scene Constraints', text: 'Keep the action grounded and practical.' },
    { family: 'Social Subtext', text: 'Mara hides concern behind motion.' }
  ],
  storyForm: { tense: 'past', pov: 'third-person-limited' },
  contextMessageLimit: 13
});
```

Add:

```js
assert(request.prompt.includes('<recursion_card_context>'), 'prose prompt includes card context section');
assert(request.prompt.includes('Mara hides concern behind motion.'), 'prose prompt includes safe card context text');
assertDeepEqual(
  proseInterventionReasons(sourceText),
  ['banned-phrase'],
  'banned phrase requires prose intervention'
);

const rejectedNoopBannedPhrase = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: sourceText
}, { originalText: sourceText });
assertEqual(rejectedNoopBannedPhrase.ok, false, 'prose no-op is rejected when banned slop is detected');
assertEqual(
  rejectedNoopBannedPhrase.error.code,
  'RECURSION_PROSE_NOOP_WITH_DETECTED_SLOP',
  'prose no-op rejection uses stable code'
);

const cleanProseNoop = validateProseEnhancementResult({
  schema: PROSE_ENHANCER_SCHEMA,
  text: 'Mara crossed the room. "Keep the door shut," she said.'
}, { originalText: 'Mara crossed the room. "Keep the door shut," she said.' });
assertEqual(cleanProseNoop.ok, true, 'prose no-op remains valid when no deterministic slop is detected');
```

Run:

```powershell
node tools\scripts\test-prose-enhancement.mjs
```

Expected: FAIL because `cardContext` and `proseInterventionReasons()` do not exist, and byte-identical banned slop is accepted.

- [ ] **Step 2: Add card context formatting**

In `src/prose-enhancement.mjs`, add:

```js
function cardLines(cardContext = []) {
  return (Array.isArray(cardContext) ? cardContext : [])
    .slice(0, 8)
    .map((card) => `- ${safeText(card.family || 'Context', 80)}: ${safeText(card.text || card.summary || '', 700)}`)
    .join('\n');
}
```

Update the builder signature:

```js
export function buildProseEnhancementRequest({
  text = '',
  contextMessages = [],
  contextMessageLimit = 13,
  storyForm = null,
  cardContext = [],
  lane = '',
  reasoningCategory = 'prose-enhancement',
  reasoningIntent = 'minimal'
} = {}) {
```

Add to the prompt before `<scene_context>`:

```js
'<recursion_card_context>',
cardLines(cardContext),
'</recursion_card_context>',
```

- [ ] **Step 3: Add prose intervention reasons**

Export:

```js
export function proseInterventionReasons(text = '') {
  return containsBannedPhrase(text) ? ['banned-phrase'] : [];
}
```

- [ ] **Step 4: Strengthen Prose prompt**

After the banned-pattern instructions, add:

```js
'Intervention policy:',
'- If the source contains a banned phrase or banned dialogue exception, do not return the original text unchanged.',
'- If a sentence is generic but not unsafe, improve it through concrete action, compression, or rhythm rather than decorative synonym swaps.',
'- If the prose is already clean, returning it unchanged is allowed.',
'- Optional diagnostics are allowed in changePlan, but the text field is the only applied output.',
'',
```

Replace the return instruction with:

```js
`Return strict JSON only: {"schema":"${PROSE_ENHANCER_SCHEMA}","text":"rewritten text","changePlan":{"changed":true,"targets":["banned-phrase"],"noChangeReason":""}}. No explanations, no notes, no commentary.`
```

- [ ] **Step 5: Reject no-op only when local detectors require intervention**

In `validateProseEnhancementResult()`, before returning success:

```js
const interventionReasons = proseInterventionReasons(originalText);
if (text === String(originalText ?? '') && interventionReasons.length) {
  return validationError(
    'RECURSION_PROSE_NOOP_WITH_DETECTED_SLOP',
    `Prose enhancement returned unchanged text despite detected slop: ${interventionReasons.join(', ')}.`
  );
}
return { ok: true, text };
```

- [ ] **Step 6: Run Prose test**

Run:

```powershell
node tools\scripts\test-prose-enhancement.mjs
```

Expected: PASS.

---

### Task 6: Runtime No-Op Failure Behavior

**Files:**
- Modify: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Verifies: provider no-op with detected Dialogue slop fails validation and does not append or replace.
- Verifies: provider no-op with clean text can still append/select in As Swipe mode.

- [ ] **Step 1: Add failing runtime no-op rejection test**

Add near existing Dialogue Enhancement runtime tests:

```js
{
  const proseHost = createProseMessageHarness('Mara set the cup down. "What do you want to do next?"');
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'Mara set the cup down. "What do you want to do next?"'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-noop-detected-slop' });
  assertEqual(result.ok, false, 'detected dialogue slop no-op fails enhancement');
  assertEqual(result.error.code, 'RECURSION_DIALOGUE_NOOP_WITH_DETECTED_SLOP', 'runtime preserves dialogue no-op validation error');
  assertEqual(proseHost.message.swipes.length, 1, 'failed dialogue no-op does not append enhanced swipe');
  assertEqual(proseHost.message.text, 'Mara set the cup down. "What do you want to do next?"', 'failed dialogue no-op keeps original text');
}
```

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS after Task 4.

- [ ] **Step 2: Add clean no-op runtime guard**

Add:

```js
{
  const proseHost = createProseMessageHarness('Mara set the cup down. "Sit down before you fall over."');
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: 'Mara set the cup down. "Sit down before you fall over."'
          }
        };
      }
    }
  });
  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-clean-noop' });
  assertEqual(result.ok, true, 'clean dialogue no-op remains valid');
  assertEqual(proseHost.message.swipes.length, 2, 'clean dialogue no-op still appends provider output as enhanced swipe');
}
```

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS.

---

### Task 7: Docs, Release, And Verification

**Files:**
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/user/PROVIDER_SETUP.md`
- Modify: `docs/superpowers/specs/2026-07-10-recursion-enhancements-dialogue-design.md`
- Modify: `manifest.json`, `package.json`, `src/storage.mjs`, `tools/scripts/test-storage.mjs`
- Create: `docs/release/0.1.0-pre-alpha.4.md`
- Modify: `docs/release/README.md`
- Modify: `docs/DOCUMENTATION_INDEX.md`

**Interfaces:**
- Documents: Context Messages now includes recent transcript text plus sender-aware examples and selected Recursion card context.
- Documents: no-op output is valid only when no deterministic slop is detected.

- [ ] **Step 1: Update operator docs**

In `docs/user/RECURSION_OPERATOR_MANUAL.md`, replace the Enhancements paragraph with wording equivalent to:

```markdown
The Enhancements context count controls the recent visible transcript window used by Prose and Dialogue passes. Recursion preserves sender names from that window when available, derives recent dialogue examples from it, and adds compact selected-card context for voice, subtext, and scene constraints. Clean output may remain unchanged, but if Recursion detects a deterministic banned pattern such as forced agency questions, echoing, or exact banned prose cliches, a byte-identical provider result is rejected and the original is kept.
```

- [ ] **Step 2: Bump version to pre-alpha.4**

Update:

```json
"version": "0.1.0-pre-alpha.4"
```

in `manifest.json` and `package.json`.

In `src/storage.mjs`, update:

```js
const RECURSION_VERSION = '0.1.0-pre-alpha.4';
```

In `tools/scripts/test-storage.mjs`, replace expected `0.1.0-pre-alpha.3` values with `0.1.0-pre-alpha.4`.

- [ ] **Step 3: Add release note**

Create `docs/release/0.1.0-pre-alpha.4.md`:

```markdown
# Recursion 0.1.0-pre-alpha.4

Recursion `0.1.0-pre-alpha.4` improves Enhancements after live testing showed Dialogue and Prose passes could return unchanged or barely changed text despite obvious slop.

## Release Highlights

- Preserves sender labels through runtime snapshots for Enhancement context.
- Builds bounded Enhancement context from recent transcript messages, recent dialogue examples, and selected Recursion cards.
- Feeds character/card context into Dialogue Enhancement and card context into Prose Enhancement.
- Rejects byte-identical Enhancement output when deterministic slop detectors require intervention.
- Keeps clean no-op output valid when no deterministic slop is detected.

## Verification Commands

```powershell
node tools\scripts\test-dialogue-enhancement.mjs
node tools\scripts\test-prose-enhancement.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-storage.mjs
git diff --check
```
```

Add `.4` above `.3` in `docs/release/README.md` and `docs/DOCUMENTATION_INDEX.md`.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
node tools\scripts\test-dialogue-enhancement.mjs
node tools\scripts\test-prose-enhancement.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-storage.mjs
git diff --check
```

Expected:

```text
[pass] dialogue enhancement
[pass] prose enhancement
[pass] runtime
[pass] storage
```

`git diff --check` should emit no whitespace errors. Line-ending warnings are acceptable on this Windows checkout.

- [ ] **Step 5: Copy to installed SillyTavern profiles for live validation**

After local tests pass, copy the changed extension files into:

```text
F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion
F:\SillyTavern\SillyTavern\data\recursion-soak-a\extensions\Recursion
F:\SillyTavern\SillyTavern\data\recursion-soak-b\extensions\Recursion
F:\SillyTavern\SillyTavern\data\recursion-soak-ui\extensions\Recursion
```

Verify the installed `default-user` copy:

```powershell
$base='F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion'
$manifest=Get-Content -LiteralPath (Join-Path $base 'manifest.json') -Raw | ConvertFrom-Json
$runtime=Get-Content -LiteralPath (Join-Path $base 'src\runtime.mjs') -Raw
$dialogue=Get-Content -LiteralPath (Join-Path $base 'src\dialogue-enhancement.mjs') -Raw
[pscustomobject]@{
  Version=$manifest.version
  SenderContext=$runtime.Contains('enhancementContextFromSnapshot')
  DialogueNoopGate=$dialogue.Contains('RECURSION_DIALOGUE_NOOP_WITH_DETECTED_SLOP')
} | Format-List
```

Expected:

```text
Version          : 0.1.0-pre-alpha.4
SenderContext    : True
DialogueNoopGate : True
```

---

## Self-Review Notes

- This plan keeps `enhancements.contextMessages` as the operator-facing knob, but upgrades what the runtime derives from that bounded window.
- The plan avoids unconditional rewrite pressure; no-op is rejected only when local detectors identify deterministic slop.
- The plan does not widen the Dialogue validator beyond stable narration and stable dialogue span count.
- The new context builder is pure and separately testable, avoiding more ad hoc prompt assembly inside `runtime.mjs`.
- Optional `changePlan` diagnostics rely on the existing provider machine schema allowing additional properties, so provider routing does not need a schema migration.
