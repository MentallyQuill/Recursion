import { normalizeOutputIssues } from '../providers/output-contract.mjs';

// Build each correction from the source request, retaining capacity/format changes.
// Never copy a rejected response into a new prompt or a durable attempt summary.
export function buildStructuredCorrectionRequest({
  originalRequest,
  currentRequest = originalRequest,
  failure = {},
  taskFeedback = ''
} = {}) {
  const wrapped = originalRequest?.request && typeof originalRequest.request === 'object';
  const original = wrapped ? originalRequest.request : originalRequest;
  const current = wrapped ? currentRequest?.request : currentRequest;
  if (!original || typeof original !== 'object') return null;
  const code = String(failure.code || 'RECURSION_MODEL_OUTPUT_INVALID').replace(/[^A-Z0-9_]/g, '').slice(0, 120);
  const feedback = [
    'Correct the previous output. Return one complete JSON object matching the requested schema.',
    String(taskFeedback).slice(0, 1200),
    `Failure: ${code}.`,
    ...normalizeOutputIssues(failure.fieldIssues).map((issue) => `${issue.path}: ${issue.message}`),
    'Use only supplied evidence. Do not invent missing source references or include private reasoning.'
  ].filter(Boolean).join('\n');
  const next = { ...original, ...current, prompt: `${original.prompt || ''}\n\n${feedback}` };
  // Trusted stage context is non-enumerable so it never enters transport/log payloads.
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(original))) {
    if (!descriptor.enumerable && !Object.hasOwn(next, key)) Object.defineProperty(next, key, descriptor);
  }
  if (Array.isArray(original.messages) && original.messages.length > 0) {
    next.messages = [...original.messages, { role: 'user', content: feedback }];
  }
  return wrapped ? { ...originalRequest, ...currentRequest, request: next } : next;
}
