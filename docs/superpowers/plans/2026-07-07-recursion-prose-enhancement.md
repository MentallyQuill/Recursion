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
- Default context message count is `13`.
- Context message range is integer `0..35`.
- Prose Enhancement uses Utility only; Reasoner is not part of V1 routing.
- Provider schema is `recursion.proseEnhancer.v1`.
- Dialogue spans must remain byte-identical before enhanced text can apply.
- Raw original text, enhanced text, provider prompts, provider responses, full scene context, secrets, and hidden reasoning must not persist to journals or diagnostics.
- Enabled Prose Enhancement should hold or blank raw host output before the player sees it. If the hold path fails, skip enhancement and reveal original output.
- `As Swipe` creates or selects one enhanced sibling for one original message/swipe hash, then selects the enhanced swipe.
- `Replace` replaces the active assistant text; failure reveals original unchanged.

---

## File Structure

- `src/settings.mjs` - normalize and persist `proseEnhancement`.
- `src/prose-enhancement.mjs` - new pure module for prompt building, JSON shape helpers, dialogue-span validation, result validation, duplicate keys, and compact diagnostics.
- `src/providers.mjs` - add Utility role `proseEnhancer` and schema `recursion.proseEnhancer.v1`.
- `src/runtime.mjs` - orchestrate post-generation enhancement after assistant landing and before Rapid warm continuation.
- `src/hosts/sillytavern/host.mjs` - expose host-neutral `messages` methods for hold, reveal, replace, append swipe, active identity, and duplicate lookup.
- `src/extension/index.js` - arm hold on generation start and invoke runtime enhancement on assistant landed events before Rapid warm.
- `src/ui.mjs` and `src/ui/view-model.mjs` - render `Prose Enhancement` setting, status copy, and safe view data.
- `styles/recursion.css` - add compact setting control styles only if existing settings styles cannot cover it.
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
    'You are a prose editor. Your only job is to improve how <text_to_transform> reads without changing what it says.',
    'Rules:',
    '- Do not change any dialogue. Not a single word.',
    '- Do not change what happens, what characters do, or the order of events.',
    '- Do not add new actions, reactions, or details that were not there.',
    '- Do not remove actions, reactions, or details that were there.',
    '- Write in the verb tenses the original text is written, keeping the grammatical person as well.',
    '- Prioritize avoiding repetition of descriptive words by changing the phrase or removing it altogether.',
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
  if (originalDialog.length !== rewrittenDialog.length || originalDialog.some((span, index) => span !== rewrittenDialog[index])) {
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

### Task 6: UI Settings And Status

**Files:**
- Modify: `src/ui.mjs`
- Modify: `src/ui/view-model.mjs`
- Modify: `styles/recursion.css` only if needed
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: `view.settings.proseEnhancement`
- Produces settings patch: `{ proseEnhancement: { mode, contextMessages } }`
- Produces status label for phase `proseEnhancing`.

- [ ] **Step 1: Write failing UI tests**

In `tools/scripts/test-ui.mjs`, add settings assertions:

```js
assert(root.querySelector('[data-recursion-prose-enhancement-mode]'), 'Settings render Prose Enhancement mode control');
assertDeepEqual(
  [...root.querySelector('[data-recursion-prose-enhancement-mode]').querySelectorAll('option')].map((option) => option.value),
  ['off', 'as-swipe', 'replace'],
  'Prose Enhancement mode options are Off, As Swipe, Replace'
);
root.querySelector('[data-recursion-prose-enhancement-mode]').value = 'as-swipe';
root.querySelector('[data-recursion-prose-enhancement-mode]').dispatchEvent(new Event('change', { bubbles: true }));
assertDeepEqual(settingsUpdates.at(-1), { proseEnhancement: { mode: 'as-swipe' } }, 'Prose Enhancement mode autosaves');

assert(root.querySelector('[data-recursion-prose-enhancement-context]'), 'Settings render Prose Enhancement context input');
root.querySelector('[data-recursion-prose-enhancement-context]').value = '21';
root.querySelector('[data-recursion-prose-enhancement-context]').dispatchEvent(new Event('change', { bubbles: true }));
assertDeepEqual(settingsUpdates.at(-1), { proseEnhancement: { contextMessages: 21 } }, 'Prose Enhancement context autosaves');

view = { ...view, activity: { phase: 'proseEnhancing', label: 'Enhancing prose...' } };
ui.update();
assert(root.textContent.includes('Enhancing prose...'), 'UI renders Prose Enhancement status');
```

- [ ] **Step 2: Run failing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: failure because controls are missing.

- [ ] **Step 3: Add view model status**

In `src/ui/view-model.mjs`, add to phase labels:

```js
proseEnhancing: 'Enhancing prose...',
```

- [ ] **Step 4: Add settings controls**

In `src/ui.mjs`, add Play tab controls near behavior settings:

```js
field.append(
  label('Prose Enhancement'),
  selectControl({
    value: settings.proseEnhancement?.mode || 'off',
    dataset: { recursionProseEnhancementMode: '' },
    options: [
      ['off', 'Off'],
      ['as-swipe', 'As Swipe'],
      ['replace', 'Replace']
    ],
    onChange: (event) => actions.updateSettings?.({ proseEnhancement: { mode: event.target.value } })
  })
);

field.append(
  label('Context Messages'),
  numberInput({
    value: settings.proseEnhancement?.contextMessages ?? 13,
    min: 0,
    max: 35,
    dataset: { recursionProseEnhancementContext: '' },
    onChange: (event) => actions.updateSettings?.({ proseEnhancement: { contextMessages: Number(event.target.value) } })
  })
);
```

Use existing local helper names for labels/selects/number inputs. If helper names differ, implement the same attributes and patch shape using current UI patterns.

- [ ] **Step 5: Run UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: `[pass] ui`.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/ui.mjs src/ui/view-model.mjs styles/recursion.css tools/scripts/test-ui.mjs
git commit -m "feat: add prose enhancement controls"
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
Host generation starts -> arm hold when Prose Enhancement enabled -> assistant lands -> hold output -> Utility proseEnhancer -> validate dialogue/source invariants -> append enhanced swipe or replace active text -> reveal message -> Rapid warm may continue
```

- [ ] **Step 3: Update provider docs**

Add role row:

```markdown
| `proseEnhancer` | Utility | Rewrite the latest assistant output for prose rhythm using bounded scene context. | Reveal original unchanged when Utility is unavailable, schema is invalid, dialogue changes, or source identity is stale. |
```

Add schema:

```markdown
`proseEnhancer` returns `recursion.proseEnhancer.v1` with `sourceMessageHash`, `rewrittenText`, and compact diagnostics. It is structured JSON even though the rewritten text itself is prose.
```

- [ ] **Step 4: Update UI docs**

Add settings contract:

```markdown
Play settings include `Prose Enhancement` with `Off`, `As Swipe`, and `Replace`. The control is compact and does not expose a Recast-style pass editor. `As Swipe` is the review surface because it keeps the original host output as a sibling swipe and selects the enhanced swipe automatically.
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
- [ ] Plan includes dialogue byte-identity validation.
- [ ] Plan includes hold/reveal behavior so raw output is not shown first when enabled.
- [ ] Plan keeps original output available in `As Swipe`.
- [ ] Plan selects enhanced swipe automatically.
- [ ] Plan prevents duplicate enhanced siblings.
- [ ] Plan reveals original on validation/provider/hold/stale failures.
- [ ] Plan keeps host message mutation inside host adapter.
- [ ] Plan updates settings, UI, provider routing, runtime, host, docs, deterministic tests, alpha gate, and live proof.
- [ ] Plan has no Recast-style configurable pass editor or diff viewer.
