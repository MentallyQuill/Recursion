const REASONING_LEVELS = new Set(['low', 'medium', 'high', 'ultra']);
const REASONING_INTENTS = new Set(['minimal', 'medium', 'high']);
const REASONING_CATEGORIES = new Set(['final-brief', 'arbiter', 'card', 'provider-test']);

function settingsReasoningLevel(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value.reasoningLevel;
  return value;
}

export function normalizeReasoningLevel(value, fallback = 'medium') {
  const level = String(settingsReasoningLevel(value) || '').trim().toLowerCase();
  if (level === 'med') return 'medium';
  if (REASONING_LEVELS.has(level)) return level;
  return REASONING_LEVELS.has(fallback) ? fallback : 'medium';
}

export function normalizeReasoningIntent(value, fallback = '') {
  const intent = String(value || '').trim().toLowerCase();
  if (REASONING_INTENTS.has(intent)) return intent;
  if (intent === 'low') return 'minimal';
  if (intent === 'max' || intent === 'maximum' || intent === 'xhigh') return 'high';
  return fallback;
}

export function normalizeReasoningCategory(value, fallback = '') {
  const category = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (REASONING_CATEGORIES.has(category)) return category;
  return fallback;
}

export function reasoningIntentForLevel(settingsOrLevel = {}, category = 'final-brief') {
  const level = normalizeReasoningLevel(settingsOrLevel);
  const resolvedCategory = normalizeReasoningCategory(category, 'final-brief');
  if (resolvedCategory === 'provider-test') return 'minimal';
  if (resolvedCategory === 'final-brief') {
    if (level === 'ultra') return 'high';
    if (level === 'medium' || level === 'high') return 'medium';
    return 'minimal';
  }
  if (resolvedCategory === 'arbiter') {
    if (level === 'high' || level === 'ultra') return 'medium';
    return 'minimal';
  }
  if (resolvedCategory === 'card') {
    if (level === 'ultra') return 'medium';
    return 'minimal';
  }
  return 'minimal';
}

export function reasoningRequestMetadata(settingsOrLevel = {}, category = 'final-brief') {
  const reasoningCategory = normalizeReasoningCategory(category, 'final-brief');
  return {
    reasoningCategory,
    reasoningIntent: reasoningIntentForLevel(settingsOrLevel, reasoningCategory)
  };
}
