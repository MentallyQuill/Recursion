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
  if (form.tense === 'unknown' || form.pov === 'unknown' || form.confidence === 'low') {
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

const PAST_TENSE_MARKERS = /\b(walked|said|was|were|had|went|looked|turned|smiled|spoke|asked|thought|knew|felt|saw|heard|stood|sat|ran|gave|took|came|made|told|began|seemed|became|showed|found|held|opened|closed|stopped|started|tried|wanted|needed|liked|loved|hated|hoped|feared|wondered|remembered|forgot|understood|realized|noticed|watched|listened|felt|seemed|appeared)\b/gi;
const PRESENT_TENSE_MARKERS = /\b(walks|says|is|are|has|goes|looks|turns|smiles|speaks|asks|thinks|knows|feels|sees|hears|stands|sits|runs|gives|takes|comes|makes|tells|begins|seems|becomes|shows|finds|holds|opens|closes|stops|starts|tries|wants|needs|likes|loves|hates|hopes|fears|wonders|remembers|forgets|understands|realizes|notices|watches|listens|feels|seems|appears)\b/gi;
const FIRST_PERSON_MARKERS = /\b(I|I'm|I've|I'll|I'd|me|my|mine|myself|we|we're|we've|we'll|we'd|us|our|ours|ourselves)\b/gi;
const SECOND_PERSON_MARKERS = /\b(you|you're|you've|you'll|you'd|your|yours|yourself|yourselves)\b/gi;
const THIRD_PERSON_MARKERS = /\b(he|he's|he'll|he'd|him|his|himself|she|she's|she'll|she'd|her|hers|herself|it|it's|it'll|it'd|its|itself|they|they're|they've|they'll|they'd|them|their|theirs|themselves)\b/gi;

function countMatches(text, pattern) {
  return (String(text || '').match(new RegExp(pattern.source, 'gi')) || []).length;
}

export function heuristicTense(text) {
  const pastCount = countMatches(text, PAST_TENSE_MARKERS);
  const presentCount = countMatches(text, PRESENT_TENSE_MARKERS);
  if (pastCount > presentCount * 1.5 && pastCount >= 2) return 'past';
  if (presentCount > pastCount * 1.5 && presentCount >= 2) return 'present';
  return null;
}

export function heuristicPov(text) {
  const firstCount = countMatches(text, FIRST_PERSON_MARKERS);
  const secondCount = countMatches(text, SECOND_PERSON_MARKERS);
  const thirdCount = countMatches(text, THIRD_PERSON_MARKERS);
  if (thirdCount > firstCount * 2 && thirdCount > secondCount * 2 && thirdCount >= 3) return 'third-person-limited';
  if (firstCount > thirdCount * 2 && firstCount > secondCount * 2 && firstCount >= 3) return 'first-person';
  if (secondCount > thirdCount * 2 && secondCount > firstCount * 2 && secondCount >= 3) return 'second-person';
  return null;
}

export function normalizeStoryFormWithHeuristic(value = {}, fallback = UNKNOWN_STORY_FORM, latestAssistantText = '') {
  const normalized = normalizeStoryForm(value, fallback);
  if (normalized.tense === 'unknown' && normalized.pov === 'unknown') return normalized;
  const text = String(latestAssistantText || '');
  if (!text.trim()) return normalized;
  const heuristicTenseResult = heuristicTense(text);
  const heuristicPovResult = heuristicPov(text);
  let tense = normalized.tense;
  let pov = normalized.pov;
  let confidence = normalized.confidence;
  let reason = normalized.reason;
  if (heuristicTenseResult && heuristicTenseResult !== normalized.tense && normalized.tense !== 'mixed' && normalized.tense !== 'unknown') {
    tense = 'unknown';
    pov = 'unknown';
    confidence = 'low';
    reason = 'Heuristic cross-check disagreed with Arbiter tense detection';
  }
  if (heuristicPovResult && heuristicPovResult !== normalized.pov && normalized.pov !== 'mixed' && normalized.pov !== 'unknown') {
    tense = 'unknown';
    pov = 'unknown';
    confidence = 'low';
    reason = 'Heuristic cross-check disagreed with Arbiter POV detection';
  }
  if (tense === normalized.tense && pov === normalized.pov) return normalized;
  return {
    schema: STORY_FORM_SCHEMA,
    tense,
    pov,
    confidence,
    evidenceRefs: normalized.evidenceRefs,
    reason: safeText(reason, MAX_REASON)
  };
}

export const STORY_FORM_OVERRIDE_OPTIONS = Object.freeze([
  'auto',
  'past-first-person',
  'past-second-person',
  'past-third-limited',
  'past-third-omniscient',
  'present-first-person',
  'present-second-person',
  'present-third-limited',
  'present-third-omniscient'
]);

const OVERRIDE_POV_MAP = {
  'first-person': 'first-person',
  'second-person': 'second-person',
  'third-limited': 'third-person-limited',
  'third-omniscient': 'third-person-omniscient'
};

export function forcedStoryForm(override) {
  const value = String(override || '').trim().toLowerCase();
  if (!value || value === 'auto' || !STORY_FORM_OVERRIDE_OPTIONS.includes(value)) return null;
  const parts = value.split('-');
  const tense = parts[0];
  const povKey = parts.slice(1).join('-');
  const pov = OVERRIDE_POV_MAP[povKey];
  if (!pov) return null;
  return {
    schema: STORY_FORM_SCHEMA,
    tense,
    pov,
    confidence: 'high',
    evidenceRefs: [],
    reason: 'User override'
  };
}

export function arbiterStoryFormContractLine() {
  return [
    'Story form contract:',
    '- Determine tense and POV from the latest visible assistant narration first.',
    '- Ignore the pending user message style unless no assistant narration exists.',
    '- User messages are often first-person present ("I walk to the door") — this is player input, not narrator form.',
    '- Past-tense narration uses verbs like "walked", "said", "was" with third-person pronouns (he/she/they).',
    '- Present-tense narration uses verbs like "walks", "says", "is".',
    '- Use "mixed" only when recent assistant narration truly alternates forms.',
    '- Use "unknown" with low confidence when the snapshot has no usable story prose.',
    `- Return storyForm using schema "${STORY_FORM_SCHEMA}".`,
    '- Do not use storyForm to rewrite events, infer hidden thoughts, or add style coaching.'
  ].join('\n');
}
