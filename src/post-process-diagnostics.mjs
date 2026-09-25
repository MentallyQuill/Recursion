import { safeId } from './core.mjs';

export const POST_PROCESS_OUTCOME_LIMIT = 12;
const STATES = new Set(['running', 'guidance', 'writing', 'awaiting-review', 'applied', 'no-change', 'canceled', 'failed', 'paused', 'stale', 'skipped']);
const TERMINAL = new Set(['awaiting-review', 'applied', 'no-change', 'canceled', 'failed', 'paused', 'stale', 'skipped']);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value, limit = 240) => typeof value === 'string' ? value
  .replace(/\b(?:Bearer\s+\S+|sk-[\w-]+)\b/gi, '[redacted]')
  .replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]')
  .replace(/\b(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\s*[:=]\s*\S+/gi, '[redacted]')
  .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s<>"']+/g, '[redacted-path]')
  .replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';
const duration = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(86400000, Math.round(Number(value))) : 0;

// Outcome records never carry a draft, request, response, complete writer config,
// or provider endpoint, even when diagnostics excerpts are enabled.
export function summarizePostProcessOutcome(value, chatKey = '') {
  const source = object(value);
  const operationId = text(source.operationId, 180);
  const key = text(source.chatKey, 180);
  if (!operationId || !key || !STATES.has(source.status)) return null;
  if (chatKey && safeId(key, 'chat') !== safeId(chatKey, 'chat')) return null;
  const writer = object(source.writer), failure = object(source.failure);
  return {
    chatKey: safeId(key, 'chat'), operationId,
    status: source.status, reason: text(source.reason),
    stageId: text(source.stageId, 180), label: text(source.label),
    startedAt: timestamp(source.startedAt), finishedAt: timestamp(source.finishedAt),
    elapsedMs: duration(source.elapsedMs),
    writer: {mode: writer.mode === 'profile' ? 'profile' : 'native',
      connectionProfileId: text(writer.connectionProfileId, 180), model: text(writer.model, 180)},
    requestedApplyMode: ['as-swipe', 'replace'].includes(source.requestedApplyMode) ? source.requestedApplyMode : '',
    committedApplyMode: ['as-swipe', 'replace'].includes(source.committedApplyMode) ? source.committedApplyMode : '',
    rewriteFlow: ['unified', 'progressive'].includes(source.rewriteFlow) ? source.rewriteFlow : '',
    sourceHash: text(source.sourceHash, 128), snapshotHash: text(source.snapshotHash, 128),
    partial: source.partial === true,
    categories: (Array.isArray(source.categories) ? source.categories : []).slice(0, 40).map(value => {
      const category = object(value);
      return { categoryId: text(category.categoryId, 120), status: category.status === 'success' ? 'success' : 'failed',
        guidanceAttempts: Math.min(100, duration(category.guidanceAttempts)), hostAttempts: Math.min(100, duration(category.hostAttempts)),
        failureStage: text(category.failureStage, 120), failureCode: text(category.failureCode, 120),
        recoveredFailureCode: text(category.recoveredFailureCode, 120) };
    }),
    failure: failure.code ? {stageId: text(failure.stageId, 180), code: text(failure.code, 120),
      message: text(failure.message, 500), failureClass: text(failure.failureClass, 80), retryable: failure.retryable === true} : null
  };
}

export function normalizePostProcessOutcomes(values, chatKey) {
  const seen = new Set(), result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const summary = summarizePostProcessOutcome(value, chatKey);
    if (!summary || !TERMINAL.has(summary.status)) continue;
    const key = JSON.stringify([summary.operationId, summary.status, summary.finishedAt]);
    if (seen.has(key)) continue;
    seen.add(key); result.push(summary);
  }
  return result.slice(-POST_PROCESS_OUTCOME_LIMIT);
}
