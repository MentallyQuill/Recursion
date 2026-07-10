import { compact, truncate } from './core.mjs';
import { speakerLabel } from './enhancement-context.mjs';
import { enhancementEditRatio, roundedEnhancementEditRatio } from './enhancement-metrics.mjs';
import { dialogueSpans } from './prose-enhancement.mjs';

export const DIALOGUE_ENHANCER_SCHEMA = 'recursion.dialogueEnhancer.v1';

const MAX_CONTEXT_TEXT = 12000;
const MAX_TARGET_TEXT = 12000;
const SECRET_PATTERN = /(raw[-_\s]*prompt|rawPrompt|provider[-_\s]*response|hidden[-_\s]*reasoning|api[-_\s]*key|authorization\s*[:=]\s*(?:bearer\s+)?[a-z0-9._~+/=-]+|bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]+)/ig;

export const DIALOGUE_SLOP_RULES = String.raw`## Dialogue slop priorities

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

const STRONG_DIALOGUE_INTERVENTION_PATTERNS = Object.freeze([
  {
    id: 'forced-question',
    pattern: /\b(what do you say\??|what do you want\??|what now\??|your move\.?|the choice is yours\.?|or something else entirely|shall we continue\??|where do we go from here\??)\b/i
  },
  {
    id: 'menu-question',
    pattern: /\b(do you want to .+?,\s*or .+?\?|are you going to .+?,\s*or will you .+?\?|will you .+?,\s*or will you .+?\?|would you prefer .+?,\s*or .+?\?)\b/i
  },
  {
    id: 'echoing',
    pattern: /\b(so that'?s what we'?re calling it now|you really just said|you'?re either .+ or .+ probably both|no one ever .+ before|let'?s not get ahead of ourselves|you have no idea what you'?re doing to me)\b/i
  },
  {
    id: 'unsupported-technical',
    pattern: /\b(assessing variables|recalibrating|hypothesis|data point|acceptable risk|optimal|inefficient|logical conclusion|statistically|tactically|non-negotiable)\b/i
  },
  {
    id: 'defensive-trope',
    pattern: /\b(it'?s not like i care|don'?t get the wrong idea|i'?m only doing this because|you'?re impossible|i hate that you'?re right)\b/i
  },
  {
    id: 'romance-cliche',
    pattern: /\b(you'?re mine|ruin you(?: for anyone else)?|mark you|claim you|devour you|worship you|make you forget your own name|you'?re going to be the death of me|last chance to back out|once i start, i won'?t stop)\b/i
  },
  {
    id: 'romance-body-cliche',
    pattern: /\b(hungry gaze|predatory gaze|possessive growl|feral need|primal need|kiss-swollen lips|kissed hard enough to bruise|bruising kiss)\b/i
  }
]);

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

const COMMON_DIALOGUE_STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'because',
  'before',
  'could',
  'from',
  'have',
  'into',
  'just',
  'like',
  'more',
  'that',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
  'your'
]);

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

function significantWords(text = '') {
  return String(text ?? '')
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
  const assistantWords = significantWords(sourceText);
  const assistant = ` ${assistantWords.join(' ')} `;
  for (let index = 0; index <= userWords.length - 4; index += 1) {
    const phrase = userWords.slice(index, index + 4).join(' ');
    if (assistant.includes(` ${phrase} `)) return ['echoed-user-phrase'];
  }
  return [];
}

export function joinedDialogueText(text = '') {
  return dialogueSpans(text)
    .map((span) => span.text)
    .join('\n');
}

export function roundedDialogueEditRatio(originalText = '', enhancedText = '') {
  return Number(enhancementEditRatio(joinedDialogueText(originalText), joinedDialogueText(enhancedText)).toFixed(4));
}

function safeText(value, limit = MAX_CONTEXT_TEXT) {
  return truncate(compact(String(value ?? '').replace(SECRET_PATTERN, '[redacted]')), limit);
}

function contextLine(message = {}) {
  return `${speakerLabel(message)}: ${safeText(message.text ?? message.mes ?? message.content, 1200)}`;
}

function characterLines(characterContext = {}) {
  const source = characterContext && typeof characterContext === 'object' ? characterContext : {};
  const examples = Array.isArray(source.exampleDialogue)
    ? source.exampleDialogue.slice(0, 8).map((line) => `- ${safeText(line, 500)}`)
    : [];
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
  cardContext = [],
  lane = '',
  reasoningCategory = 'dialogue-enhancement',
  reasoningIntent = 'minimal',
  retryReason = ''
} = {}) {
  const targetText = truncate(String(text ?? '').replace(SECRET_PATTERN, '[redacted]'), MAX_TARGET_TEXT);
  const limit = Math.max(0, Math.min(35, Math.round(Number(contextMessageLimit) || 0)));
  const sceneContext = (Array.isArray(contextMessages) ? contextMessages : []).slice(-limit).map(contextLine).join('\n');
  const storyFormLine = storyForm && typeof storyForm === 'object'
    ? `Story form: ${safeText(JSON.stringify(storyForm), 600)}`
    : 'Story form: infer from source text.';
  const retryLines = retryReason ? [
    '',
    'Retry instruction:',
    retryReason === 'low-dialogue-edit-ratio'
      ? '- Your previous revision stayed too close to the source. Revise the dialogue more decisively while preserving structure, speaker intent, and character voice.'
      : '- Your previous revision returned the original text. Produce a real dialogue revision candidate while preserving all hard rules.'
  ] : [];
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
    'Intervention policy:',
    '- If any intervention-required pattern appears, do not return the original text unchanged.',
    '- Minimum edit ratio: 10%.',
    '- Target edit ratio: 10-20%.',
    '- Soft maximum edit ratio: 30%.',
    '- Prefer precise, character-consistent revision over decorative rewriting.',
    '- If the source is short or structurally constrained, come as close to the target band as possible without breaking the hard rules.',
    '- Always produce the best dialogue-focused revision candidate.',
    '- If the dialogue is already strong, make subtle improvements through compression, rhythm, subtext, implication, character-specific word choice, or sharper response to the emotional pressure.',
    '- Do not return the original text unchanged unless every safe revision would violate the hard rules.',
    '- Optional diagnostics are allowed in changePlan, but the text field is the only applied output.',
    '',
    'Allowed dialogue edit levers:',
    '- Replace fake open-ended questions with character action, pressure, refusal, narrowed options, consequences, or specific grounded questions.',
    "- Replace parroting with a response to the motive, fear, pressure, or implication underneath the other character's line.",
    '- Make intelligent characters precise and situation-aware instead of generically technical.',
    '- Replace stock defensive deflection with character-specific avoidance, minimization, practicality, silence, or misdirection.',
    '- Replace generic attraction heat with restraint, specificity, interruption, evasion, awkwardness, directness, or grounded tension.',
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
    ...retryLines,
    '<text_to_transform>',
    targetText,
    '</text_to_transform>',
    '',
    `Return strict JSON only: {"schema":"${DIALOGUE_ENHANCER_SCHEMA}","text":"rewritten full assistant message","changePlan":{"changed":true,"targets":["forced-question"],"noChangeReason":""}}. No explanations, no notes, no commentary.`
  ].join('\n');
  return {
    prompt,
    responseSchema: DIALOGUE_ENHANCER_SCHEMA,
    responseLength: 4096,
    ...(lane ? { lane } : {}),
    reasoningCategory,
    reasoningIntent,
    machineJson: true,
    characterContext: {
      name: safeText(characterContext?.name || 'unknown', 120),
      description: safeText(characterContext?.description || '', 1600),
      exampleDialogue: Array.isArray(characterContext?.exampleDialogue)
        ? characterContext.exampleDialogue.slice(0, 8).map((line) => safeText(line, 500)).filter(Boolean)
        : []
    },
    cardContext: (Array.isArray(cardContext) ? cardContext : [])
      .slice(0, 8)
      .map((card) => ({
        family: safeText(card?.family || 'Context', 80),
        text: safeText(card?.text || card?.summary || '', 700)
      }))
      .filter((card) => card.family && card.text),
    contextMessages: (Array.isArray(contextMessages) ? contextMessages : []).slice(-limit)
  };
}

function validationError(code, message) {
  return { ok: false, error: { code, message } };
}

function normalizeNarration(text = '') {
  const source = String(text ?? '');
  const spans = dialogueSpans(source).sort((a, b) => a.start - b.start);
  let cursor = 0;
  const chunks = [];
  for (const span of spans) {
    chunks.push(source.slice(cursor, span.start));
    cursor = span.end;
  }
  chunks.push(source.slice(cursor));
  return compact(chunks.join(' '));
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
  if (normalizeNarration(originalText) !== normalizeNarration(text)) {
    return validationError('RECURSION_DIALOGUE_NARRATION_CHANGED', 'Dialogue enhancement changed narration outside dialogue repair.');
  }
  const interventionReasons = dialogueInterventionReasons(originalText);
  if (text === String(originalText ?? '') && interventionReasons.length) {
    return validationError(
      'RECURSION_DIALOGUE_NOOP_WITH_DETECTED_SLOP',
      `Dialogue enhancement returned unchanged text despite detected slop: ${interventionReasons.join(', ')}.`
    );
  }
  return {
    ok: true,
    text,
    editRatio: roundedEnhancementEditRatio(originalText, text),
    dialogueEditRatio: roundedDialogueEditRatio(originalText, text)
  };
}
