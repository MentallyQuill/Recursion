import { compact, truncate } from './core.mjs';
import { dialogueSpans } from './prose-enhancement.mjs';

export const DIALOGUE_ENHANCER_SCHEMA = 'recursion.dialogueEnhancer.v1';

const MAX_CONTEXT_TEXT = 12000;
const MAX_TARGET_TEXT = 12000;
const SECRET_PATTERN = /(raw[-_\s]*prompt|rawPrompt|provider[-_\s]*response|hidden[-_\s]*reasoning|api[-_\s]*key|authorization|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]+)/ig;

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
  reasoningIntent = 'minimal'
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
    ...(lane ? { lane } : {}),
    reasoningCategory,
    reasoningIntent,
    machineJson: true,
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
  return { ok: true, text };
}
