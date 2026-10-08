import { normalizeOutputIssues } from '../providers/output-contract.mjs';
import { normalizeInstructionValidationRule } from '../instruction-safety.mjs';
import { FAILURE_CATEGORIES, normalizeCancellationOrigin } from '../failures.mjs';

export const CHECKPOINT_DIAGNOSTIC_CODES = Object.freeze([
  'structured-output-downgraded', 'output-budget-increased', 'output-budget-at-ceiling',
  'output-budget-reduced', 'output-budget-at-floor', 'model-output-corrected',
  'correction-request-unchanged', 'native-schema-required', 'provider-rate-limit-retry',
  'provider-rate-limit-exhausted', 'provider-transient-retry', 'provider-transient-exhausted',
  'provider-retry', 'stage-reprocess-consumed', 'profile-sampler-projection-failed',
  'fused-fallback-segmented', 'unresolved-fused-families', 'zero-useful-fused-cards'
]);
export const CHECKPOINT_ATTEMPT_ACTIONS = Object.freeze([
  'stop', 'downgrade-structured-output', 'increase-output-budget', 'reduce-output-budget', 'retry-corrected', 'retry-same'
]);
const FAILURE_CODES = new Set([
  'RECURSION_ATTEMPT_FAILURE_UNKNOWN', 'RECURSION_JSON_AMBIGUOUS', 'RECURSION_JSON_DEPTH_LIMIT',
  'RECURSION_JSON_ITEM_LIMIT', 'RECURSION_JSON_OBJECT_REQUIRED', 'RECURSION_JSON_PARSE_FAILED', 'RECURSION_JSON_SIZE_LIMIT',
  'RECURSION_CARD_INVALID', 'RECURSION_CARD_PROVIDER_FAILED', 'RECURSION_CARD_PROVIDER_UNAVAILABLE',
  'RECURSION_GUIDANCE_INVALID', 'RECURSION_GUIDANCE_PROVIDER_FAILED', 'RECURSION_GUIDANCE_PROVIDER_UNAVAILABLE',
  'RECURSION_MODEL_ATTEMPT_ABORTED', 'RECURSION_MODEL_OUTPUT_INVALID', 'RECURSION_OPERATION_DEADLINE',
  'RECURSION_RECOVERY_BUDGET_EXHAUSTED', 'RECURSION_PROVIDER_ABORTED', 'RECURSION_PROVIDER_AUTH_FAILED',
  'RECURSION_PROVIDER_BATCH_INVALID', 'RECURSION_PROVIDER_BATCH_SLOT_FAILED', 'RECURSION_PROVIDER_BUSY',
  'RECURSION_PROVIDER_CONFIG_STALE', 'RECURSION_PROVIDER_CONTENT_FILTER', 'RECURSION_PROVIDER_CONTEXT_LIMIT',
  'RECURSION_PROVIDER_EMPTY_RESPONSE', 'RECURSION_PROVIDER_FAILED', 'RECURSION_PROVIDER_FUSED_INVALID',
  'RECURSION_PROVIDER_INSUFFICIENT_FUNDS', 'RECURSION_PROVIDER_NOT_READY', 'RECURSION_PROVIDER_RATE_LIMIT',
  'RECURSION_PROVIDER_REASONING_ONLY', 'RECURSION_PROVIDER_REFUSAL', 'RECURSION_PROVIDER_REQUEST_INVALID',
  'RECURSION_PROVIDER_RESPONSE_JSON_INVALID', 'RECURSION_PROVIDER_ROLE_LANE_MISMATCH', 'RECURSION_PROVIDER_ROLE_MISSING',
  'RECURSION_PROVIDER_ROLE_UNSUPPORTED', 'RECURSION_PROVIDER_ROUTER_UNAVAILABLE', 'RECURSION_PROVIDER_SCHEMA_MISMATCH',
  'RECURSION_PROVIDER_SINGLE_CARD_INVALID', 'RECURSION_PROVIDER_TIMEOUT', 'RECURSION_PROVIDER_TOKEN_LIMIT', 'RECURSION_PROVIDER_TRANSIENT'
]);
const FAILURE_CLASSES = new Set([...FAILURE_CATEGORIES, 'abort', 'validation', 'transport', 'internal', 'capacity', 'cancellation',
  'provider', 'provider-account', 'provider-request', 'provider-timeout', 'provider-length',
  'configuration', 'compatibility', 'stale-state']);
const TIMING_KEYS = ['queueMs', 'providerMs', 'normalizationMs', 'validationMs', 'artifactPersistenceMs'];
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'promptTokens', 'completionTokens', 'totalTokens'];
export function boundedCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100000, Math.trunc(value))) : 0;
}
export function normalizeAttemptFailureCode(value) {
  return FAILURE_CODES.has(value) ? value : 'RECURSION_ATTEMPT_FAILURE_UNKNOWN';
}
function observedNumbers(value, keys, limit) {
  return Object.fromEntries(keys.filter(key => value?.[key] === null || Number.isFinite(value?.[key]))
    .map(key => [key, value[key] === null ? null : Math.max(0, Math.min(limit, value[key]))]));
}
function normalizeOutcome(value) {
  if (!value || !['accepted', 'rejected', 'failed', 'canceled'].includes(value.outcome)) return null;
  const fieldIssues = normalizeOutputIssues(value.fieldIssues);
  const validationRule = normalizeInstructionValidationRule(value.validationRule);
  return { attempt:boundedCount(value.attempt), window:boundedCount(value.window), outcome:value.outcome,
    action:CHECKPOINT_ATTEMPT_ACTIONS.includes(value.action) ? value.action : 'stop',
    ...(value.outcome === 'canceled' ? {cancellationOrigin:normalizeCancellationOrigin(value.cancellationOrigin)} : {}),
    ...(value.outcome !== 'accepted' ? {code:normalizeAttemptFailureCode(value.code)} : {}),
    ...(FAILURE_CLASSES.has(value.failureClass) ? {failureClass:value.failureClass} : {}),
    ...(CHECKPOINT_DIAGNOSTIC_CODES.includes(value.diagnosticCode) ? {diagnosticCode:value.diagnosticCode} : {}),
    ...(fieldIssues.length ? {fieldIssues} : {}), ...(validationRule ? {validationRule} : {}),
    delayMs: Number.isFinite(value.delayMs) ? Math.max(0, Math.min(2147483647, Math.trunc(value.delayMs))) : 0,
    timings:observedNumbers(value.timings, TIMING_KEYS, 2147483647),
    usage:observedNumbers(value.usage, USAGE_KEYS, 100000) };
}
export function normalizeAttemptOutcomes(values) {
  return (Array.isArray(values) ? values : []).map(normalizeOutcome).filter(Boolean).slice(-5);
}
export function attemptOutcomeFrom(summary, {attempt = summary?.attempt, window = 1} = {}) {
  return normalizeOutcome({ ...summary, attempt, window,
    outcome: ({invalid:'rejected',aborted:'canceled'})[summary?.outcome] || summary?.outcome,
    code:summary?.failure?.code, failureClass:summary?.failure?.category || summary?.failure?.kind,
    fieldIssues:summary?.failure?.fieldIssues, validationRule:summary?.failure?.validationRule,
    cancellationOrigin:summary?.failure?.cancellationOrigin });
}
