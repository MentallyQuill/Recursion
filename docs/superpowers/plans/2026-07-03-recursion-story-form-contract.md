# Recursion Story Form Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Arbiter-owned story-form contract so generated cards, guidance, and Rapid prompt artifacts preserve the active chat's tense and POV.

**Architecture:** Add a small `src/story-form.mjs` contract module, then thread normalized `storyForm` through Arbiter plans, card requests, prompt packet composition, and Rapid warm/foreground paths. Runtime validates and serializes the contract, while providers do the semantic inference and generation under explicit tense/POV instructions.

**Tech Stack:** JavaScript ES modules, Recursion provider router, SillyTavern host adapter, Node test scripts under `tools/scripts`.

---

## File Structure

- Create `src/story-form.mjs`: story-form schema constants, normalization, prompt lines, diagnostics helpers, and Rapid validation helpers.
- Create `tools/scripts/test-story-form.mjs`: focused contract tests for normalization and prompt copy.
- Modify `src/runtime.mjs`: request `storyForm` from Utility Arbiter, normalize it into plans, pass it to card generation, prompt packet composition, and Rapid warm artifacts.
- Modify `src/cards.mjs`: accept `context.storyForm`, add safe request metadata, and include a model-visible story-form prompt block for card `promptText`.
- Modify `src/prompt.mjs`: accept `storyForm`, include it in guidance composer prompts, installed guidance text, packet metadata, packet diagnostics, and reasoner composer prompts.
- Modify `src/rapid-pipeline.mjs`: store and validate warm story form, include it in Rapid foreground delta prompts and artifact hashes.
- Modify `tools/scripts/test-cards.mjs`: assert card provider prompts include tense/POV instructions.
- Modify `tools/scripts/test-prompt.mjs`: assert prompt packets and guidance sections preserve target story form.
- Modify `tools/scripts/test-rapid-pipeline.mjs`: assert Rapid warm artifacts validate story form and foreground prompts include it.
- Modify `tools/scripts/test-runtime.mjs`: assert Arbiter prompt, plan normalization, card requests, Standard packet, and Rapid warm/foreground paths receive `storyForm`.
- Modify docs: `docs/design/CARD_SYSTEM_SPEC.md`, `docs/technical/RUNTIME_TURN_SEQUENCE.md`, `docs/technical/PROMPT_PACKET_AND_INJECTION.md`, `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, and `docs/architecture/PROMPT_COMPOSITION_SPEC.md`.

## Task 1: Story Form Contract Module

**Files:**
- Create: `src/story-form.mjs`
- Create: `tools/scripts/test-story-form.mjs`

- [ ] **Step 1: Write the failing contract tests**

Create `tools/scripts/test-story-form.mjs`:

```js
import {
  STORY_FORM_SCHEMA,
  UNKNOWN_STORY_FORM,
  arbiterStoryFormContractLine,
  normalizeStoryForm,
  storyFormInstruction,
  storyFormPromptBlock
} from '../../src/story-form.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const valid = normalizeStoryForm({
  schema: STORY_FORM_SCHEMA,
  tense: 'past',
  pov: 'third-person-limited',
  confidence: 'high',
  evidenceRefs: ['message:42', 'raw-secret'],
  reason: 'Latest assistant narration uses past tense third person.'
});

assertEqual(valid.schema, STORY_FORM_SCHEMA, 'valid story form keeps schema');
assertEqual(valid.tense, 'past', 'valid story form keeps tense');
assertEqual(valid.pov, 'third-person-limited', 'valid story form keeps pov');
assertEqual(valid.confidence, 'high', 'valid story form keeps confidence');
assertDeepEqual(valid.evidenceRefs, ['message:42'], 'story form keeps only safe message refs');
assertEqual(valid.reason, 'Latest assistant narration uses past tense third person.', 'story form keeps safe reason');

const invalid = normalizeStoryForm({
  schema: 'wrong',
  tense: 'future',
  pov: 'camera',
  confidence: 'certain',
  evidenceRefs: ['message:2'],
  reason: 'bad values'
});

assertEqual(invalid.schema, STORY_FORM_SCHEMA, 'invalid story form still returns current schema');
assertEqual(invalid.tense, 'unknown', 'invalid tense falls back');
assertEqual(invalid.pov, 'unknown', 'invalid pov falls back');
assertEqual(invalid.confidence, 'low', 'invalid confidence falls back');
assertDeepEqual(invalid.evidenceRefs, [], 'invalid schema drops evidence refs');
assert(invalid.reason.includes('story form unavailable'), 'invalid schema uses safe fallback reason');

assertDeepEqual(normalizeStoryForm(null), UNKNOWN_STORY_FORM, 'null story form returns unknown constant shape');
assert(storyFormInstruction(valid).includes('past tense, third-person-limited POV'), 'instruction names target form');
assert(storyFormInstruction(UNKNOWN_STORY_FORM).includes("active chat's established story form"), 'unknown instruction stays conservative');
assert(storyFormPromptBlock(valid).includes('Target tense: past.'), 'prompt block includes tense');
assert(storyFormPromptBlock(valid).includes('Target POV: third-person-limited.'), 'prompt block includes pov');
assert(storyFormPromptBlock(valid).includes('Do not switch to first person'), 'prompt block forbids drift');
assert(arbiterStoryFormContractLine().includes('latest visible assistant narration first'), 'Arbiter contract names assistant-first source rule');
assert(arbiterStoryFormContractLine().includes(STORY_FORM_SCHEMA), 'Arbiter contract names schema');
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
node tools\scripts\test-story-form.mjs
```

Expected: FAIL with module-not-found for `src/story-form.mjs`.

- [ ] **Step 3: Implement the story form module**

Create `src/story-form.mjs`:

```js
import { compact, redact, truncate } from './core.mjs';

export const STORY_FORM_SCHEMA = 'recursion.storyForm.v1';

const VALID_TENSES = new Set(['past', 'present', 'mixed', 'unknown']);
const VALID_POVS = new Set([
  'first-person',
  'second-person',
  'third-person-limited',
  'third-person-omniscient',
  'mixed',
  'unknown'
]);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
const SAFE_MESSAGE_REF = /^message:\d{1,12}$/;
const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|inspector[-_\s]*only|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/i;
const MAX_REASON = 220;

export const UNKNOWN_STORY_FORM = Object.freeze({
  schema: STORY_FORM_SCHEMA,
  tense: 'unknown',
  pov: 'unknown',
  confidence: 'low',
  evidenceRefs: Object.freeze([]),
  reason: 'story form unavailable'
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeText(value, limit = MAX_REASON) {
  return truncate(compact(String(redact(value ?? '', { maxString: limit }) ?? '')
    .replace(new RegExp(SECRET_TEXT_PATTERN.source, 'ig'), '[redacted]')), limit);
}

function enumValue(value, allowed, fallback) {
  const text = String(value ?? '').trim().toLowerCase();
  return allowed.has(text) ? text : fallback;
}

function safeEvidenceRefs(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => safeText(entry, 80))
    .filter((entry) => SAFE_MESSAGE_REF.test(entry)))]
    .slice(0, 8);
}

export function normalizeStoryForm(value = {}, fallback = UNKNOWN_STORY_FORM) {
  const source = asObject(value);
  if (source.schema !== STORY_FORM_SCHEMA) {
    return {
      ...UNKNOWN_STORY_FORM,
      reason: safeText(asObject(fallback).reason || UNKNOWN_STORY_FORM.reason)
    };
  }
  const tense = enumValue(source.tense, VALID_TENSES, 'unknown');
  const pov = enumValue(source.pov, VALID_POVS, 'unknown');
  const confidence = enumValue(source.confidence, VALID_CONFIDENCE, 'low');
  const reason = safeText(source.reason || '', MAX_REASON) || storyFormFallbackReason({ tense, pov });
  return {
    schema: STORY_FORM_SCHEMA,
    tense,
    pov,
    confidence,
    evidenceRefs: safeEvidenceRefs(source.evidenceRefs),
    reason
  };
}

export function storyFormFallbackReason(storyForm = {}) {
  if (storyForm.tense === 'unknown' || storyForm.pov === 'unknown') return 'story form unavailable';
  return 'story form normalized';
}

export function storyFormInstruction(storyForm = UNKNOWN_STORY_FORM) {
  const form = normalizeStoryForm(storyForm);
  if (form.tense === 'unknown' || form.pov === 'unknown') {
    return "Write the next reply in the active chat's established story form.";
  }
  return `Write the next reply in ${form.tense} tense, ${form.pov} POV.`;
}

export function storyFormPromptBlock(storyForm = UNKNOWN_STORY_FORM) {
  const form = normalizeStoryForm(storyForm);
  return [
    'Story form contract for card promptText:',
    `- Target tense: ${form.tense}.`,
    `- Target POV: ${form.pov}.`,
    `- Confidence: ${form.confidence}.`,
    '- Write promptText in this same tense and POV when describing scene actions, narration, response posture, or likely next-beat implications.',
    '- Prefer neutral constraint wording when the family is not narrative prose.',
    '- Do not switch to first person, second person, or present tense unless storyForm requires it.'
  ].join('\n');
}

export function arbiterStoryFormContractLine() {
  return [
    'Story form contract:',
    '- Determine tense and POV from the latest visible assistant narration first.',
    '- Ignore the pending user message style unless no assistant narration exists.',
    '- Use "mixed" only when recent assistant narration truly alternates forms.',
    '- Use "unknown" with low confidence when the snapshot has no usable story prose.',
    `- Return storyForm using schema "${STORY_FORM_SCHEMA}".`,
    '- Do not use storyForm to rewrite events, infer hidden thoughts, or add style coaching.'
  ].join('\n');
}
```

- [ ] **Step 4: Run the contract test**

Run:

```powershell
node tools\scripts\test-story-form.mjs
```

Expected: PASS with no thrown assertion.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src\story-form.mjs tools\scripts\test-story-form.mjs
git commit -m "feat: add story form contract"
```

## Task 2: Arbiter Story Form Plan Contract

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Write failing Arbiter runtime tests**

In `tools/scripts/test-runtime.mjs`, add `storyForm` assertions near the existing Arbiter output contract tests:

```js
{
  const arbiterPrompts = [];
  const guidancePrompts = [];
  const cardPrompts = [];
  const storySnapshot = {
    chatId: 'story-form-chat',
    chatKey: 'story-form-chat',
    sceneKey: 'story-form-scene',
    sceneFingerprint: 'story-form-scene',
    turnFingerprint: 'story-form-turn',
    latestMesId: 3,
    messages: [
      { mesid: 1, role: 'user', text: 'I open the hatch.', visible: true },
      { mesid: 2, role: 'assistant', text: 'Mara stepped through the hatch and kept her hand on the rail.', visible: true },
      { mesid: 3, role: 'user', text: 'I ask what she sees.', visible: true }
    ]
  };
  const { runtime } = createRuntimeHarness({
    snapshot: storySnapshot,
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          arbiterPrompts.push(request.prompt);
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              storyForm: {
                schema: 'recursion.storyForm.v1',
                tense: 'past',
                pov: 'third-person-limited',
                confidence: 'high',
                evidenceRefs: ['message:2'],
                reason: 'Latest assistant narration is past-tense third person.'
              },
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Check story form.' }],
              reasonerDecision: { mode: 'skip', reason: 'unit story form', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['story-form-arbiter']
            }
          };
        }
        if (roleId === 'sceneFrameCard') {
          cardPrompts.push(request.prompt);
          return cardProviderResponse(roleId, request);
        }
        if (roleId === 'guidanceComposer') {
          guidancePrompts.push(request.prompt);
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Keep the response in past tense third-person limited form.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['story-form-guidance']
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'I ask what she sees.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'story form run installs');
  assert(arbiterPrompts[0].includes('latest visible assistant narration first'), 'Arbiter prompt includes assistant-first story form rule');
  assert(arbiterPrompts[0].includes('"storyForm"'), 'Arbiter output contract requires storyForm');
  assertDeepEqual(result.plan.storyForm, {
    schema: 'recursion.storyForm.v1',
    tense: 'past',
    pov: 'third-person-limited',
    confidence: 'high',
    evidenceRefs: ['message:2'],
    reason: 'Latest assistant narration is past-tense third person.'
  }, 'valid Arbiter story form enters plan');
  assert(cardPrompts[0].includes('Target tense: past.'), 'card prompt receives story tense');
  assert(cardPrompts[0].includes('Target POV: third-person-limited.'), 'card prompt receives story pov');
  assert(guidancePrompts[0].includes('past tense, third-person-limited POV'), 'guidance composer receives story form');
  assertEqual(view.lastPacket.storyForm.tense, 'past', 'packet stores story tense');
  assertEqual(view.lastPacket.storyForm.pov, 'third-person-limited', 'packet stores story pov');
  assert(view.lastPacket.sections.guidance.includes('past tense, third-person-limited POV'), 'installed guidance names story form');
}
```

Update the existing plan whitelist assertion:

```js
assertDeepEqual(
  Object.keys(result.plan).sort(),
  ['action', 'budgets', 'cardJobs', 'diagnostics', 'lifecycle', 'promptFootprint', 'reasonerDecision', 'sceneStatus', 'schema', 'snapshotHash', 'source', 'storyForm'].sort(),
  'result plan only exposes whitelisted fields'
);
```

- [ ] **Step 2: Run failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: FAIL because runtime does not import the story-form helpers, Arbiter prompt lacks `storyForm`, and plan normalization drops `storyForm`.

- [ ] **Step 3: Thread story form through runtime plan normalization**

In `src/runtime.mjs`, add imports:

```js
import {
  UNKNOWN_STORY_FORM,
  arbiterStoryFormContractLine,
  normalizeStoryForm
} from './story-form.mjs';
```

Add `storyForm` to `localFallbackPlan(...)`:

```js
storyForm: UNKNOWN_STORY_FORM,
```

In `mergePlan(fallbackPlan, arbiterData)`, add:

```js
storyForm: normalizeStoryForm(data.storyForm, fallbackPlan.storyForm),
```

In `arbiterOutputContractLine(snapshotHash)`, add this required field line before `cardJobs`:

```js
'- "storyForm": {"schema":"recursion.storyForm.v1","tense":"past|present|mixed|unknown","pov":"first-person|second-person|third-person-limited|third-person-omniscient|mixed|unknown","confidence":"high|medium|low","evidenceRefs":["message:N"],"reason":"string"}',
```

In the `askUtilityArbiter(...)` prompt lines, add:

```js
arbiterStoryFormContractLine(),
```

Place it after `arbiterCardJobContractLine()` so the Arbiter sees card and story-form contracts together.

- [ ] **Step 4: Pass story form from runtime into card and prompt calls**

In both Standard card generation paths inside `generatePlanCards(...)`, pass `storyForm` to `buildCardRequests(...)`:

```js
storyForm: plan.storyForm || UNKNOWN_STORY_FORM
```

In every `composePromptPacket(...)` call in `src/runtime.mjs`, add:

```js
storyForm: plan.storyForm || UNKNOWN_STORY_FORM
```

In `installRapidPacket(...)`, add the warm artifact story form to the `plan` object:

```js
storyForm: rapid?.storyForm || UNKNOWN_STORY_FORM,
```

In the `composePromptPacket(...)` call inside `installRapidPacket(...)`, pass:

```js
storyForm: rapid?.storyForm || plan.storyForm || UNKNOWN_STORY_FORM,
```

- [ ] **Step 5: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: still FAIL until card and prompt modules accept `storyForm`.

- [ ] **Step 6: Commit after Task 3 and Task 4 are green**

Do not commit this task alone if tests fail because card and prompt modules are not wired yet.

## Task 3: Card Generation Story Form Prompting

**Files:**
- Modify: `src/cards.mjs`
- Modify: `tools/scripts/test-cards.mjs`

- [ ] **Step 1: Write failing card request assertions**

In `tools/scripts/test-cards.mjs`, after the `requests` assertions for `buildCardRequests(...)`, add:

```js
const storyFormRequest = buildCardRequests({
  cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Preserve narrative form.' }]
}, {
  runId: 'story-form-card-run',
  snapshotHash: 'story-form-card-hash',
  snapshot: {},
  storyForm: {
    schema: 'recursion.storyForm.v1',
    tense: 'past',
    pov: 'third-person-limited',
    confidence: 'high',
    evidenceRefs: ['message:7'],
    reason: 'Assistant narration establishes form.'
  }
})[0];

assertEqual(storyFormRequest.storyForm.tense, 'past', 'card request metadata carries story tense');
assertEqual(storyFormRequest.storyForm.pov, 'third-person-limited', 'card request metadata carries story pov');
assert(storyFormRequest.prompt.includes('Story form contract for card promptText:'), 'card prompt includes story form block');
assert(storyFormRequest.prompt.includes('Target tense: past.'), 'card prompt includes target tense');
assert(storyFormRequest.prompt.includes('Target POV: third-person-limited.'), 'card prompt includes target pov');
assert(storyFormRequest.prompt.includes('Do not switch to first person'), 'card prompt warns against POV drift');
```

- [ ] **Step 2: Run failing card test**

Run:

```powershell
node tools\scripts\test-cards.mjs
```

Expected: FAIL because `buildCardRequests()` does not include `storyForm`.

- [ ] **Step 3: Add story form to card requests**

In `src/cards.mjs`, import:

```js
import { UNKNOWN_STORY_FORM, normalizeStoryForm, storyFormPromptBlock } from './story-form.mjs';
```

Inside `buildCardRequests(...)`, after `selectedSubItems`, add:

```js
const storyForm = normalizeStoryForm(context.storyForm || UNKNOWN_STORY_FORM);
```

Add the story-form prompt block after `cardScopePromptBlock(...)`:

```js
storyFormPromptBlock(storyForm),
```

Add request metadata at the top level:

```js
storyForm,
```

Add request metadata under `metadata`:

```js
storyForm: {
  tense: storyForm.tense,
  pov: storyForm.pov,
  confidence: storyForm.confidence
},
```

- [ ] **Step 4: Run card test**

Run:

```powershell
node tools\scripts\test-cards.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit card prompting**

Run:

```powershell
git add src\cards.mjs tools\scripts\test-cards.mjs
git commit -m "feat: add story form to card prompts"
```

## Task 4: Prompt Packet And Guidance Story Form

**Files:**
- Modify: `src/prompt.mjs`
- Modify: `tools/scripts/test-prompt.mjs`

- [ ] **Step 1: Write failing prompt packet assertions**

In `tools/scripts/test-prompt.mjs`, update the first `composePromptPacket(...)` call to include:

```js
storyForm: {
  schema: 'recursion.storyForm.v1',
  tense: 'past',
  pov: 'third-person-limited',
  confidence: 'high',
  evidenceRefs: ['message:913'],
  reason: 'Assistant narration establishes form.'
},
```

Replace the existing generic guidance assertion:

```js
assert(packet.sections.guidance.includes('Write the next reply as normal story prose/dialogue.'), 'guidance section tells the final model to keep normal output shape');
```

with:

```js
assert(packet.sections.guidance.includes('Write the next reply in past tense, third-person-limited POV.'), 'guidance section names target story form');
assert(!packet.sections.guidance.includes('normal story prose/dialogue'), 'generic story-prose line is removed');
assertEqual(packet.storyForm.tense, 'past', 'packet stores story tense');
assertEqual(packet.storyForm.pov, 'third-person-limited', 'packet stores story pov');
assertEqual(packet.diagnostics.storyFormTense, 'past', 'packet diagnostics store story tense');
assertEqual(packet.diagnostics.storyFormPov, 'third-person-limited', 'packet diagnostics store story pov');
assert(guidanceCalls[0].request.prompt.includes('past tense, third-person-limited POV'), 'guidance composer prompt includes story form');
```

Add a fallback packet case after the first packet tests:

```js
const unknownFormPacket = await composePromptPacket({
  runId: 'unknown-story-form-run',
  hand: markerHand({ omitted: [] }),
  snapshot: baseSnapshot(),
  settings: { promptFootprint: 'normal', reasonerUse: 'off' },
  storyForm: { schema: 'recursion.storyForm.v1', tense: 'unknown', pov: 'unknown', confidence: 'low', evidenceRefs: [], reason: 'story form unavailable' },
  generationRouter: null
});
assert(unknownFormPacket.sections.guidance.includes("active chat's established story form"), 'unknown story form uses conservative guidance text');
```

- [ ] **Step 2: Run failing prompt test**

Run:

```powershell
node tools\scripts\test-prompt.mjs
```

Expected: FAIL because `composePromptPacket()` does not accept or serialize story form.

- [ ] **Step 3: Add story form to prompt composition**

In `src/prompt.mjs`, import:

```js
import { UNKNOWN_STORY_FORM, normalizeStoryForm, storyFormInstruction } from './story-form.mjs';
```

Update `buildGuidancePrompt(...)` signature to accept `storyForm`, then add these lines before `Behavior policy`:

```js
`Story form: ${JSON.stringify(normalizeStoryForm(storyForm))}`,
storyFormInstruction(storyForm),
```

Update `buildReasonerPrompt(...)` signature to accept `storyForm`, then add:

```js
`Story form: ${JSON.stringify(normalizeStoryForm(storyForm))}`,
storyFormInstruction(storyForm),
```

Update `buildGuidanceSection(guidance)` to accept `storyForm`:

```js
function buildGuidanceSection(guidance, storyForm = UNKNOWN_STORY_FORM) {
  const text = safeText(guidance?.text, MAX_GUIDANCE_TEXT);
  return [
    'Private Recursion guidance for the next assistant message.',
    storyFormInstruction(storyForm),
    'Guidance:',
    text || 'Guidance unavailable; use the raw Recursion card evidence directly.'
  ].join('\n');
}
```

In `composePromptPacket(...)`, add parameter:

```js
storyForm = UNKNOWN_STORY_FORM,
```

Normalize it near the top:

```js
const normalizedStoryForm = normalizeStoryForm(storyForm);
```

Pass `normalizedStoryForm` to `composeGuidanceForCards(...)`, `buildGuidanceSection(...)`, `applyReasonerGuidance(...)`, and `buildPacket(...)`.

In `buildPacket(...)`, add:

```js
storyForm: normalizedStoryForm,
```

In `baseDiagnostics(...)`, add:

```js
storyFormTense: storyForm.tense,
storyFormPov: storyForm.pov,
storyFormConfidence: storyForm.confidence,
```

- [ ] **Step 4: Run prompt test**

Run:

```powershell
node tools\scripts\test-prompt.mjs
```

Expected: PASS.

- [ ] **Step 5: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS for the Standard story-form test added in Task 2.

- [ ] **Step 6: Commit runtime and prompt composition**

Run:

```powershell
git add src\runtime.mjs src\prompt.mjs tools\scripts\test-runtime.mjs tools\scripts\test-prompt.mjs
git commit -m "feat: thread story form through prompt packets"
```

## Task 5: Rapid Warm And Foreground Story Form

**Files:**
- Modify: `src/rapid-pipeline.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-rapid-pipeline.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Write failing Rapid unit tests**

In `tools/scripts/test-rapid-pipeline.mjs`, import `UNKNOWN_STORY_FORM`:

```js
import { UNKNOWN_STORY_FORM } from '../../src/story-form.mjs';
```

Add a usable artifact assertion:

```js
const rapidStoryForm = {
  schema: 'recursion.storyForm.v1',
  tense: 'past',
  pov: 'third-person-limited',
  confidence: 'high',
  evidenceRefs: ['message:2'],
  reason: 'Warm assistant narration establishes form.'
};

assertEqual(rapidWarmArtifactIsUsable({
  pipelineVersion: 2,
  status: 'ready',
  baseSourceRevisionHash: 'base',
  selectedCardIds: ['card-1'],
  cardIds: ['card-1'],
  guidance: { schema: 'recursion.guidanceComposer.v1', status: 'used', text: 'Warm guidance.' },
  storyForm: rapidStoryForm,
  settingsHash: 'settings',
  providerContractHash: 'provider',
  cardCatalogHash: 'catalog',
  promptContractHash: 'prompt'
}, {
  baseSourceRevisionHash: 'base',
  settingsHash: 'settings',
  providerContractHash: 'provider',
  cardCatalogHash: 'catalog',
  promptContractHash: 'prompt',
  storyForm: rapidStoryForm
}), true, 'Rapid warm artifact with matching story form is usable');

assertEqual(rapidWarmArtifactIsUsable({
  pipelineVersion: 2,
  status: 'ready',
  baseSourceRevisionHash: 'base',
  selectedCardIds: ['card-1'],
  cardIds: ['card-1'],
  guidance: { schema: 'recursion.guidanceComposer.v1', status: 'used', text: 'Warm guidance.' },
  storyForm: { ...UNKNOWN_STORY_FORM, reason: 'missing warm form' },
  settingsHash: 'settings',
  providerContractHash: 'provider',
  cardCatalogHash: 'catalog',
  promptContractHash: 'prompt'
}, {
  baseSourceRevisionHash: 'base',
  settingsHash: 'settings',
  providerContractHash: 'provider',
  cardCatalogHash: 'catalog',
  promptContractHash: 'prompt',
  storyForm: rapidStoryForm
}), false, 'Rapid warm artifact with mismatched story form is not usable');

const rapidPrompt = buildRapidTurnDeltaPrompt({
  snapshotHash: 'snap',
  baseSourceRevisionHash: 'base',
  turnSourceRevisionHash: 'turn',
  warmArtifact: { storyForm: rapidStoryForm },
  warmGuidance: { text: 'Warm guidance.' },
  selectedCards: [{ id: 'card-1', promptText: 'Raw card.' }],
  storyForm: rapidStoryForm,
  userMessage: 'What happens?'
});
assert(rapidPrompt.includes('past tense, third-person-limited POV'), 'Rapid delta prompt includes story form instruction');
```

- [ ] **Step 2: Run failing Rapid unit test**

Run:

```powershell
node tools\scripts\test-rapid-pipeline.mjs
```

Expected: FAIL because Rapid artifacts do not validate story form and the delta prompt does not mention it.

- [ ] **Step 3: Update Rapid helper functions**

In `src/rapid-pipeline.mjs`, import:

```js
import { normalizeStoryForm, storyFormInstruction } from './story-form.mjs';
```

Add:

```js
function storyFormKey(value = {}) {
  const form = normalizeStoryForm(value);
  return [form.tense, form.pov, form.confidence].join('|');
}
```

In `rapidWarmArtifactIsUsable(...)`, require story form to match expected when provided:

```js
const expectedStoryForm = required.storyForm ? normalizeStoryForm(required.storyForm) : null;
const sourceStoryForm = normalizeStoryForm(source.storyForm);
```

Add this boolean condition:

```js
&& sourceStoryForm.tense !== 'unknown'
&& sourceStoryForm.pov !== 'unknown'
&& (!expectedStoryForm || storyFormKey(sourceStoryForm) === storyFormKey(expectedStoryForm))
```

In `buildRapidTurnDeltaPrompt(input)`, normalize `source.storyForm || source.warmArtifact?.storyForm`, then add:

```js
storyFormInstruction(storyForm),
`Story form: ${JSON.stringify(storyForm)}`,
```

In `rapidArtifactHash(artifact)`, include:

```js
storyForm: normalizeStoryForm(artifact.storyForm)
```

- [ ] **Step 4: Update runtime Rapid artifact creation and fixture tests**

In `src/runtime.mjs`, when saving the Rapid warm artifact, add:

```js
storyForm: plan.storyForm || UNKNOWN_STORY_FORM,
```

When checking `rapidWarmArtifactIsUsable(...)`, pass:

```js
storyForm: activeVariant.rapid?.storyForm || UNKNOWN_STORY_FORM,
```

When building the Rapid foreground request with `buildRapidTurnDeltaPrompt(...)`, pass:

```js
storyForm: activeVariant.rapid?.storyForm || UNKNOWN_STORY_FORM,
```

In `tools/scripts/test-runtime.mjs`, update `rapidWarmCacheFixture(...)` to include:

```js
storyForm: {
  schema: 'recursion.storyForm.v1',
  tense: 'past',
  pov: 'third-person-limited',
  confidence: 'high',
  evidenceRefs: ['message:2'],
  reason: 'Warm assistant narration establishes form.'
},
```

Update Rapid foreground assertions:

```js
assert(rapidTurnDeltaRequest.prompt.includes('past tense, third-person-limited POV'), 'Rapid foreground receives story form');
assertEqual(result.packet.storyForm.tense, 'past', 'Rapid packet stores warm story tense');
assertEqual(result.packet.storyForm.pov, 'third-person-limited', 'Rapid packet stores warm story pov');
```

- [ ] **Step 5: Run Rapid and runtime tests**

Run:

```powershell
node tools\scripts\test-rapid-pipeline.mjs
node tools\scripts\test-runtime.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Rapid story form support**

Run:

```powershell
git add src\rapid-pipeline.mjs src\runtime.mjs tools\scripts\test-rapid-pipeline.mjs tools\scripts\test-runtime.mjs
git commit -m "feat: preserve story form in rapid pipeline"
```

## Task 6: Docs And Full Verification

**Files:**
- Modify: `docs/design/CARD_SYSTEM_SPEC.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/technical/PROMPT_PACKET_AND_INJECTION.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/architecture/PROMPT_COMPOSITION_SPEC.md`

- [ ] **Step 1: Update card system docs**

In `docs/design/CARD_SYSTEM_SPEC.md`, after the paragraph that starts `The Utility Arbiter is the primary decision engine`, add:

```markdown
The Utility Arbiter also determines the active story form for the scene. Story form is the current tense and point of view inferred from the latest visible assistant narration first, with the pending user message used only when no assistant narration exists. Runtime validates that `storyForm` and passes it to card generation, guidance composition, and Rapid artifacts so raw card evidence does not introduce conflicting tense or POV.
```

- [ ] **Step 2: Update runtime sequence docs**

In `docs/technical/RUNTIME_TURN_SEQUENCE.md`, in `Behavior Policy And Utility Arbiter`, add:

```markdown
The Arbiter returns `storyForm` with schema `recursion.storyForm.v1`. Runtime treats it as a prompt-contract consistency signal: card generators and guidance composers must preserve that tense and POV, but runtime does not rewrite card meaning or run brittle tense validation. If `storyForm` is missing or invalid, runtime records a fallback diagnostic and uses `unknown` story form for conservative prompt wording.
```

In `Card Jobs And Deck Update`, add:

```markdown
Card-generation prompts include a story-form block with target tense, target POV, and confidence. The block tells providers to write `promptText` in the same form when describing scene actions or next-beat implications, and to prefer neutral constraint wording for non-narrative card families.
```

- [ ] **Step 3: Update prompt packet docs**

In `docs/technical/PROMPT_PACKET_AND_INJECTION.md`, in the prompt packet description, add:

```markdown
Prompt Packet V3 carries `storyForm` metadata alongside selected raw cards and guidance. The installed guidance section names the target tense and POV, while card evidence remains raw selected `promptText`. Recursion does not install a separate story-form prompt key.
```

- [ ] **Step 4: Update architecture provider docs**

In `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, update the `utilityArbiter` role row or nearby role text with:

```markdown
The Utility Arbiter also returns `storyForm` using `recursion.storyForm.v1`. It infers tense and POV from the latest visible assistant narration first, ignores pending user message style unless no assistant narration exists, and provides compact message evidence refs.
```

In the card role section, add:

```markdown
Card roles receive normalized `storyForm` in request metadata and model-visible prompt text. Card `promptText` should preserve that tense and POV when it describes narrative implications, while constraint-heavy cards may use neutral wording instead of drifting into a different story form.
```

- [ ] **Step 5: Update prompt composition architecture docs**

In `docs/architecture/PROMPT_COMPOSITION_SPEC.md`, add:

```markdown
Guidance composition receives normalized `storyForm` and includes a direct instruction such as `Write the next reply in past tense, third-person-limited POV.` Unknown story form falls back to `Write the next reply in the active chat's established story form.` This replaces generic story-prose guidance.
```

- [ ] **Step 6: Run focused tests**

Run:

```powershell
node tools\scripts\test-story-form.mjs
node tools\scripts\test-cards.mjs
node tools\scripts\test-prompt.mjs
node tools\scripts\test-rapid-pipeline.mjs
node tools\scripts\test-runtime.mjs
```

Expected: all commands pass.

- [ ] **Step 7: Run full deterministic test gate**

Run:

```powershell
node tools\scripts\run-tests.mjs
```

Expected: final line reports all test scripts passed.

- [ ] **Step 8: Commit docs and final gate**

Run:

```powershell
git add docs\design\CARD_SYSTEM_SPEC.md docs\technical\RUNTIME_TURN_SEQUENCE.md docs\technical\PROMPT_PACKET_AND_INJECTION.md docs\architecture\PROVIDER_AND_GENERATION_SPEC.md docs\architecture\PROMPT_COMPOSITION_SPEC.md
git commit -m "docs: describe story form contract"
```

## Self-Review

- Spec coverage: Arbiter story-form detection, runtime normalization, card prompts, guidance prompts, packet diagnostics, Rapid artifacts, docs, and tests are each covered by a task.
- Placeholder scan: no placeholder steps remain.
- Type consistency: `storyForm`, `STORY_FORM_SCHEMA`, `UNKNOWN_STORY_FORM`, `normalizeStoryForm`, `storyFormInstruction`, and `storyFormPromptBlock` are introduced before later tasks use them.
- Scope check: this plan changes prompt/runtime contracts only; it does not add UI controls or deterministic prose rewriting.
