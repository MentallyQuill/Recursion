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

export function storyFormFallbackReason(storyForm = {}) {
  if (storyForm.tense === 'unknown' || storyForm.pov === 'unknown') return 'story form unavailable';
  return 'story form normalized';
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
