export const UNSAFE_DIAGNOSTIC_TEXT_PATTERN = /\b(raw[-_\s]*prompt|rawPrompt|raw[-_\s]*response|rawResponse|provider[-_\s]*prompt|providerPrompt|provider[-_\s]*response|providerResponse|hidden[-_\s]*reasoning|hiddenReasoning|reasoning[-_\s]*(?:content|details)|reasoningContent|reasoningDetails|private[-_\s]*story[-_\s]*plan|privateStoryPlan|private[-_\s]*plan|privatePlan|session[-_\s]*id|sessionId|session[-_\s]*key\s*[:=]|sessionKey\s*[:=]|session[-_\s]*token|credentials?|password\s*[:=]|token\s*[:=]|api[-_\s]*key\s*[:=]|apiKey\s*[:=]|authorization\s*[:=]|set-cookie\s*[:=]|cookie\s*[:=]|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;

export function normalizeDiagnosticExplanation(value, limit = 500) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return UNSAFE_DIAGNOSTIC_TEXT_PATTERN.test(text) ? '[redacted]' : text.slice(0, limit);
}
