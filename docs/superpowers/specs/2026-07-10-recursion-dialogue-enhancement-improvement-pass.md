# Recursion Dialogue Enhancement Improvement Pass

Date: 2026-07-10

## Purpose

Dialogue Enhancement should be a paid, visible revision candidate generator. It should not decide that already-clean dialogue deserves a byte-identical no-op. The user can compare the enhanced swipe or replacement and decide whether the revision helped.

This pass tightens Dialogue Enhancement in four places:

- no exact clean no-op as the first accepted Dialogue result;
- dialogue-span edit ratio in addition to whole-message edit ratio;
- one soft retry for exact no-op or under-target dialogue-span edits;
- broader but tiered dialogue-slop detection that detects candidate problems without banning legitimate phrasing.

The pass keeps the current hard safety constraints: no new events, no new named entities, no relationship progress, no speaker-order change, no broad narration rewrite, no secret leakage, and no prompt/hidden-reasoning exposure.

## Current Problem

The current Dialogue prompt contains the ratio contract, but validation accepts clean no-op output:

```js
return { ok: true, text, editRatio: roundedEnhancementEditRatio(originalText, text) };
```

That means a Dialogue provider call can return the original text, get applied as an "enhanced" swipe, and report `editRatio: 0` if no deterministic slop regex fired.

Prose Enhancement feels stronger because it can rewrite non-dialogue narration. Dialogue Enhancement preserves narration and dialogue span structure, so whole-message edit ratio can stay near zero even when quoted speech changes meaningfully. A narration-heavy assistant message makes this worse.

## Product Contract

Dialogue Enhancement must always attempt a useful dialogue-focused revision candidate.

Allowed outcomes:

- valid revised dialogue is applied;
- first attempt is too close, so Recursion retries once with a stronger low-change instruction;
- second attempt is still low-change but not byte-identical, so Recursion applies it and records ratios;
- both attempts are exact duplicates, so Recursion skips applying an "enhanced" duplicate and reveals the original with a low-change warning.

Disallowed outcome:

- byte-identical Dialogue output accepted as a successful enhanced swipe on the first attempt.

## Ratio Contract

Keep current whole-message ratios:

```js
export const ENHANCEMENT_EDIT_RATIO_MINIMUM = 0.1;
export const ENHANCEMENT_EDIT_RATIO_TARGET_MIN = 0.1;
export const ENHANCEMENT_EDIT_RATIO_TARGET_MAX = 0.2;
export const ENHANCEMENT_EDIT_RATIO_SOFT_MAX = 0.3;
```

Add dialogue-specific ratio helpers that compare only dialogue spans:

```js
import { dialogueSpans } from './prose-enhancement.mjs';

export function joinedDialogueText(text = '') {
  return dialogueSpans(text)
    .map((span) => span.text)
    .join('\n');
}

export function dialogueEditRatio(originalText = '', enhancedText = '') {
  return enhancementEditRatio(
    joinedDialogueText(originalText),
    joinedDialogueText(enhancedText)
  );
}

export function roundedDialogueEditRatio(originalText = '', enhancedText = '') {
  return Number(dialogueEditRatio(originalText, enhancedText).toFixed(4));
}
```

Validation should return both values:

```js
return {
  ok: true,
  text,
  editRatio: roundedEnhancementEditRatio(originalText, text),
  dialogueEditRatio: roundedDialogueEditRatio(originalText, text)
};
```

Runtime markers should preserve both:

```js
passHashes.push({
  pass,
  hash: hashJson(enhancedText),
  editRatio: validation.editRatio ?? roundedEnhancementEditRatio(passOriginalText, enhancedText),
  dialogueEditRatio: validation.dialogueEditRatio ?? roundedDialogueEditRatio(passOriginalText, enhancedText),
  lane: generation.lane,
  attempt: generation.attempt ?? 1,
  ...(generation.retryReason ? { retryReason: generation.retryReason } : {}),
  ...(generation.fallbackFrom ? { fallbackFrom: generation.fallbackFrom } : {})
});
```

The final marker should keep `editRatio` as the whole-message ratio and add `dialogueEditRatio` when the target includes Dialogue:

```js
marker.editRatio = roundedEnhancementEditRatio(originalText, enhancedText);
if (passSequence.includes('dialogue')) {
  marker.dialogueEditRatio = roundedDialogueEditRatio(originalText, enhancedText);
}
```

## Prompt Contract Changes

Remove this line from Dialogue Enhancement:

```js
'- If the dialogue is already clean, returning it unchanged is allowed.',
```

Replace it with:

```js
'- Always produce the best dialogue-focused revision candidate.',
'- If the dialogue is already strong, make subtle improvements through compression, rhythm, subtext, implication, character-specific word choice, or sharper response to the emotional pressure.',
'- Do not return the original text unchanged unless every safe revision would violate the hard rules.',
```

Add explicit edit levers so the model knows how to revise without decorative rewriting:

```js
'Allowed dialogue edit levers:',
'- Replace fake open-ended questions with character action, pressure, refusal, narrowed options, consequences, or specific grounded questions.',
'- Replace parroting with a response to the motive, fear, pressure, or implication underneath the other character's line.',
'- Make intelligent characters precise and situation-aware instead of generically technical.',
'- Replace stock defensive deflection with character-specific avoidance, minimization, practicality, silence, or misdirection.',
'- Replace generic attraction heat with restraint, specificity, interruption, evasion, awkwardness, directness, or grounded tension.',
```

Add a retry mode to the builder:

```js
export function buildDialogueEnhancementRequest({
  text = '',
  contextMessages = [],
  contextMessageLimit = 13,
  storyForm = null,
  characterContext = {},
  cardContext = [],
  lane = '',
  reasoningCategory = 'dialogue-enhancement',
  reasoningIntent = 'minimal',
  retryReason = ''
} = {}) {
  const retryLines = retryReason ? [
    '',
    'Retry instruction:',
    retryReason === 'low-dialogue-edit-ratio'
      ? '- Your previous revision stayed too close to the source. Revise the dialogue more decisively while preserving structure, speaker intent, and character voice.'
      : '- Your previous revision returned the original text. Produce a real dialogue revision candidate while preserving all hard rules.'
  ] : [];

  const prompt = [
    'You are a dialogue consistency editor.',
    // existing lines...
    ...retryLines,
    '<text_to_transform>',
    targetText,
    '</text_to_transform>',
    // existing strict JSON return line...
  ].join('\n');
}
```

## Tiered Slop Detection

Regex should answer: "Should Dialogue Enhancement be pushed to produce a real revision?" It should not answer: "May this phrase never appear?"

### Tier 1: Strong No-Op Triggers

These phrases are low-false-positive AI-isms. If a Dialogue output is byte-identical and one is present, validation should reject no-op as it does today.

```js
const STRONG_DIALOGUE_INTERVENTION_PATTERNS = Object.freeze([
  {
    id: 'forced-agency-ending',
    pattern: /\b(what do you say\??|what now\??|your move\.?|the choice is yours\.?|or something else entirely|shall we continue\??|where do we go from here\??)\b/i
  },
  {
    id: 'menu-question',
    pattern: /\b(do you want to .+?,\s*or .+?\?|are you going to .+?,\s*or will you .+?\?|will you .+?,\s*or will you .+?\?|would you prefer .+?,\s*or .+?\?)\b/i
  },
  {
    id: 'romance-cliche',
    pattern: /\b(you'?re mine|ruin you(?: for anyone else)?|mark you|claim you|devour you|worship you|make you forget your own name|last chance to back out|once i start, i won'?t stop)\b/i
  },
  {
    id: 'romance-body-cliche',
    pattern: /\b(hungry gaze|predatory gaze|possessive growl|feral need|primal need|kiss-swollen lips|kissed hard enough to bruise|bruising kiss)\b/i
  },
  {
    id: 'echo-banter',
    pattern: /\b(so that'?s what we'?re calling it now|you really just said|you'?re either .+ or .+ probably both|no one ever .+ before|let'?s not get ahead of ourselves|you have no idea what you'?re doing to me)\b/i
  }
]);
```

### Tier 2: Soft Suspicion

These can be good in context. They should increase pressure for a meaningful revision and appear in `changePlan.targets`, but they should not permanently ban the phrase.

```js
const SOFT_DIALOGUE_SUSPICION_PATTERNS = Object.freeze([
  {
    id: 'generic-romance-heat',
    pattern: /\b(tell me what you want|dangerous game|playing with fire|you menace|be gentle|i'?ve never done anything like this before)\b/i
  },
  {
    id: 'generic-comfort',
    pattern: /\b(are you okay\??|talk to me\.?|i'?m here\.?|you don'?t have to do this|tell me what you need|i can explain)\b/i
  },
  {
    id: 'generic-smalltalk',
    pattern: /\b(what brings you here\??|what do you do for fun\??|what are your hobbies\??|what makes you tick\??)\b/i
  },
  {
    id: 'stock-deflection',
    pattern: /\b(don'?t look at me like that|say that again|try not to .+ too much|don'?t .+ too hard|you'?re enjoying this, aren'?t you)\b/i
  },
  {
    id: 'unsupported-smart-talk',
    pattern: /\b(assessing variables|recalibrating|hypothesis|data point|probability|variables|acceptable risk|optimal|efficient|inefficient|logical conclusion|statistically|tactically|non-negotiable)\b/i
  }
]);
```

Expose both reason sets:

```js
function patternReasons(patterns, text = '') {
  const source = String(text || '');
  return patterns
    .filter((entry) => entry.pattern.test(source))
    .map((entry) => entry.id);
}

export function dialogueInterventionReasons(text = '') {
  return patternReasons(STRONG_DIALOGUE_INTERVENTION_PATTERNS, text);
}

export function dialogueSuspicionReasons(text = '') {
  return patternReasons(SOFT_DIALOGUE_SUSPICION_PATTERNS, text);
}
```

Validation should still hard-reject exact no-op for strong patterns:

```js
const interventionReasons = dialogueInterventionReasons(originalText);
if (text === String(originalText ?? '') && interventionReasons.length) {
  return validationError(
    'RECURSION_DIALOGUE_NOOP_WITH_DETECTED_SLOP',
    `Dialogue enhancement returned unchanged text despite detected slop: ${interventionReasons.join(', ')}.`
  );
}
```

Runtime retry should use both strong and soft reasons when deciding whether a low-change output deserves one stronger attempt.

## Context-Aware Echo Detection

Static regex cannot detect the worst echoing case: the assistant repeats the user's exact phrase as a question.

Add a context helper in `dialogue-enhancement.mjs` or `enhancement-context.mjs`:

```js
function significantWords(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !COMMON_DIALOGUE_STOP_WORDS.has(word));
}

export function echoedUserPhraseReasons({ sourceText = '', contextMessages = [] } = {}) {
  const latestUser = [...(Array.isArray(contextMessages) ? contextMessages : [])]
    .reverse()
    .find((message) => String(message?.role || '').toLowerCase() === 'user');
  if (!latestUser) return [];

  const userWords = significantWords(latestUser.text ?? latestUser.mes ?? latestUser.content);
  const assistant = String(sourceText || '').toLowerCase();
  for (let index = 0; index <= userWords.length - 4; index += 1) {
    const phrase = userWords.slice(index, index + 4).join(' ');
    if (assistant.includes(phrase)) return ['echoed-user-phrase'];
  }
  return [];
}
```

Use this only as a retry pressure signal. Do not hard-ban a repeated phrase: exact repetition can be valid when the character is confirming a code word, quoting, interrogating, or reacting to a shocking statement.

## Soft Retry Runtime Flow

Dialogue should be allowed one stronger retry before applying or skipping.

```js
async function runDialogueEnhancementAttempt({
  text,
  retryReason = '',
  attempt = 1
}) {
  const request = buildDialogueEnhancementRequest({
    text,
    contextMessages,
    contextMessageLimit: enhancementSettings.contextMessages,
    storyForm,
    characterContext: enhancementContext.characterContext,
    cardContext: enhancementContext.cardContext,
    lane: enhancementLane,
    retryReason,
    ...enhancementReasoning
  });

  const generation = await generateEnhancementPass('dialogueEnhancer', request);
  const result = generation.result;
  if (result?.ok !== true) return { ok: false, generation, result };

  const validation = validateDialogueEnhancementResult(result.data, {
    originalText: text,
    contextMessages
  });
  return { ok: validation.ok === true, validation, generation, attempt, retryReason };
}
```

Retry decision:

```js
function dialogueRetryReason({ originalText = '', validation = {}, contextMessages = [] } = {}) {
  if (validation.ok !== true) return '';
  if (validation.text === String(originalText ?? '')) return 'exact-noop';
  if ((validation.dialogueEditRatio ?? 0) < ENHANCEMENT_EDIT_RATIO_MINIMUM) {
    const strongReasons = dialogueInterventionReasons(originalText);
    const softReasons = dialogueSuspicionReasons(originalText);
    const echoReasons = echoedUserPhraseReasons({ sourceText: originalText, contextMessages });
    if (strongReasons.length || softReasons.length || echoReasons.length) return 'low-dialogue-edit-ratio';
  }
  return '';
}
```

Runtime application:

```js
let dialogueAttempt = await runDialogueEnhancementAttempt({ text: enhancedText, attempt: 1 });
if (dialogueAttempt.ok !== true) {
  return failDialogue(dialogueAttempt);
}

const retryReason = dialogueRetryReason({
  originalText: enhancedText,
  validation: dialogueAttempt.validation,
  contextMessages
});

if (retryReason) {
  const retry = await runDialogueEnhancementAttempt({
    text: enhancedText,
    retryReason,
    attempt: 2
  });
  if (retry.ok === true) dialogueAttempt = retry;
}

const validation = dialogueAttempt.validation;
if (validation.text === String(enhancedText ?? '')) {
  settleRuntimeActivity({
    runId,
    phase: 'settled',
    severity: 'warning',
    label: 'Dialogue unchanged. Original kept.',
    chips: ['Dialogue']
  });
  return {
    ok: false,
    target,
    mode,
    error: { code: 'RECURSION_DIALOGUE_EXACT_NOOP', message: 'Dialogue Enhancement returned unchanged text after retry.' }
  };
}

enhancedText = validation.text;
```

This keeps deterministic rejection narrow. It does not reject a low-ratio but non-identical second attempt. It only refuses to apply an exact duplicate as a paid "enhanced" result.

## Duplicate Swipe Handling

Current `As Swipe` behavior may append a provider result even when it is byte-identical. After this pass:

- first exact no-op retries once;
- second exact no-op skips apply and reveals original;
- non-identical low-ratio output may still be appended and selected;
- existing enhanced sibling lookup remains hash/profile based.

This avoids polluting SillyTavern swipes with duplicates while still letting the user decide on real revision candidates.

## Provider And Lane Behavior

Keep current lane behavior:

- Low/Medium use Utility;
- High/Ultra use Reasoner when available;
- if the Reasoner enhancement call fails after its normal same-lane retry, retry the same pass through Utility;
- the low-change Dialogue retry should use the same lane/fallback path as the first attempt.

Pass marker should show attempt and fallback details:

```js
{
  pass: 'dialogue',
  hash: '...',
  editRatio: 0.031,
  dialogueEditRatio: 0.142,
  lane: 'utility',
  attempt: 2,
  retryReason: 'low-dialogue-edit-ratio',
  fallbackFrom: 'reasoner'
}
```

## Test Plan

### Dialogue Unit Tests

Add or update `tools/scripts/test-dialogue-enhancement.mjs`:

```js
assert(!request.prompt.includes('returning it unchanged is allowed'), 'dialogue prompt no longer allows clean no-op');
assert(request.prompt.includes('Always produce the best dialogue-focused revision candidate'), 'dialogue prompt requires a candidate');
assert(request.prompt.includes('Allowed dialogue edit levers'), 'dialogue prompt explains safe revision levers');
```

```js
const cleanNoop = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: 'Mara set the cup down. "Sit down before you fall over."'
}, { originalText: 'Mara set the cup down. "Sit down before you fall over."' });
assertEqual(cleanNoop.ok, true, 'validator can still report exact no-op for runtime retry handling');
assertEqual(cleanNoop.editRatio, 0, 'validator reports whole-message no-op ratio');
assertEqual(cleanNoop.dialogueEditRatio, 0, 'validator reports dialogue no-op ratio');
```

```js
const dialogueOnlyChange = validateDialogueEnhancementResult({
  schema: DIALOGUE_ENHANCER_SCHEMA,
  text: 'Mara stayed beside the door. "Sit. We can argue after."'
}, { originalText: 'Mara stayed beside the door. "Sit down before you fall over."' });
assert(dialogueOnlyChange.dialogueEditRatio > dialogueOnlyChange.editRatio, 'dialogue ratio is not diluted by narration');
```

```js
assertDeepEqual(
  dialogueInterventionReasons('"Once I start, I won\\'t stop."'),
  ['romance-cliche'],
  'strong romance cliche requires no-op intervention'
);
assertDeepEqual(
  dialogueSuspicionReasons('"Tell me what you want."'),
  ['generic-romance-heat'],
  'soft romance line is suspicion, not a hard ban'
);
```

### Runtime Tests

Add to `tools/scripts/test-runtime.mjs`:

```js
{
  const proseHost = createProseMessageHarness('Mara set the cup down. "Sit down before you fall over."');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'as-swipe', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: routerCalls.length === 1
              ? 'Mara set the cup down. "Sit down before you fall over."'
              : 'Mara set the cup down. "Sit. We can argue after."'
          }
        };
      }
    }
  });

  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-clean-noop-retries' });
  assertEqual(result.ok, true, 'Dialogue exact no-op retries and accepts revised candidate');
  assertEqual(routerCalls.length, 2, 'Dialogue exact no-op performs one retry');
  assert(routerCalls[1].request.prompt.includes('previous revision returned the original text'), 'retry prompt explains exact no-op problem');
  assertEqual(proseHost.message.swipes[1], 'Mara set the cup down. "Sit. We can argue after."', 'retry candidate is appended');
}
```

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

  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-exact-noop-skips-after-retry' });
  assertEqual(result.ok, false, 'Dialogue exact no-op skips after retry');
  assertEqual(result.error.code, 'RECURSION_DIALOGUE_EXACT_NOOP', 'exact no-op uses stable error code');
  assertEqual(proseHost.message.swipes.length, 1, 'exact duplicate enhanced swipe is not appended');
}
```

```js
{
  const proseHost = createProseMessageHarness('Mara set the cup down. "Tell me what you want."');
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { enhancements: { target: 'dialogue', applyMode: 'replace', contextMessages: 3 } },
    hostMessages: proseHost.messages,
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(request);
        return {
          ok: true,
          data: {
            schema: 'recursion.dialogueEnhancer.v1',
            text: routerCalls.length === 1
              ? 'Mara set the cup down. "Tell me what you need."'
              : 'Mara set the cup down. "Start with the part you keep dodging."'
          }
        };
      }
    }
  });

  const result = await runtime.enhanceLatestAssistantMessage({ reason: 'unit-dialogue-soft-suspicion-low-ratio-retry' });
  assertEqual(result.ok, true, 'soft-suspicion low-ratio output gets a stronger retry');
  assertEqual(routerCalls.length, 2, 'soft suspicion low-ratio retry runs once');
  assert(result.passHashes[0].dialogueEditRatio >= 0, 'marker records dialogue edit ratio');
}
```

### UI And Progress Tests

No visible menu redesign is required. Update only tests that inspect marker surfaces or progress detail if new retry labels surface.

Expected progress behavior:

- still shows `Dialogue Enhancement`;
- retry remains inside the same pass row, not a new generic `Provider call running` row;
- warning copy for exact duplicate says `Dialogue unchanged. Original kept.`;
- no raw prompt, raw provider response, hidden reasoning, or transcript text appears in progress rows.

### Live SillyTavern Proof

After implementation, sync the installed default-user Recursion extension before judging the browser:

```powershell
robocopy F:\git\Recursion F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion /E /XD .git node_modules artifacts .tmp /XF debug.log
```

Then run the focused live proof:

```powershell
node tools\scripts\prove-live-enhancements.mjs
```

Manual SG-1 proof target:

- set Enhancement target to `Dialogue`;
- use `As Swipe`;
- generate a response with at least one quoted line;
- confirm the original remains hidden until the pass settles;
- confirm the selected enhanced swipe is not byte-identical;
- confirm marker or diagnostics reports `dialogueEditRatio`;
- test High and Ultra to confirm Reasoner first, Utility fallback only after Reasoner failure.

## Documentation Updates

Update these docs after implementation:

- `docs/user/RECURSION_OPERATOR_MANUAL.md`: remove "Clean output may remain unchanged" for Dialogue; explain exact no-op retry/skip.
- `docs/technical/RUNTIME_TURN_SEQUENCE.md`: document dialogue-span ratio, one soft retry, exact duplicate skip, and marker fields.
- `docs/user/PROVIDER_SETUP.md`: keep current High/Ultra Reasoner language if fallback behavior remains current; otherwise update with the Reasoner-to-Utility enhancement fallback contract.
- `docs/design/UI_SPEC.md`: only update if progress or visible warning text changes.

## Acceptance Criteria

- Dialogue prompt no longer gives the model a clean no-op escape hatch.
- Dialogue validation reports both `editRatio` and `dialogueEditRatio`.
- Runtime performs one retry for exact no-op Dialogue output.
- Runtime performs one retry for under-10% dialogue-span edits when strong, soft, or context echo signals exist.
- Runtime does not append or replace with byte-identical Dialogue output after retry.
- Runtime may still apply a non-identical low-ratio second attempt and lets the user decide.
- Prose Enhancement behavior is unchanged except for shared metrics helper additions.
- Combined `Prose + Dialogue` keeps pass order: Dialogue first, Prose second.
- Progress continues to show first-class `Dialogue Enhancement` and `Prose Enhancement` rows.
- Unit tests cover prompt contract, ratio helpers, strong patterns, soft suspicion, retry, exact duplicate skip, and marker fields.
- Live SillyTavern proof confirms visible Dialogue changes on a real model call.
