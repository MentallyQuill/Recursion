export const RECOVERY_COUNT_KEYS = Object.freeze([
  'parseFailures', 'shapeFailures', 'correctionRequests', 'budgetAdjustments',
  'rateLimitRetries', 'transientRetries', 'salvagedItems', 'segmentedRepairCalls',
  'optionalOmissions', 'requiredBlocks'
]);

export function normalizeRecoveryCounts(value = {}) {
  return Object.fromEntries(RECOVERY_COUNT_KEYS.map(key => [key,
    Math.max(0, Math.min(100000, Math.trunc(Number(value?.[key]) || 0)))]));
}

export function recoveryCountsAfterAttempt(previous, summary, { segmentedRepair = false } = {}) {
  const counts = normalizeRecoveryCounts(previous);
  const code = summary.failure?.code || '';
  if (code.startsWith('RECURSION_JSON_')) counts.parseFailures += 1;
  if (code === 'RECURSION_PROVIDER_SCHEMA_MISMATCH') counts.shapeFailures += 1;
  if (summary.action === 'retry-corrected') counts.correctionRequests += 1;
  if (['increase-output-budget', 'reduce-output-budget'].includes(summary.action)) counts.budgetAdjustments += 1;
  if (summary.diagnosticCode === 'provider-rate-limit-retry') counts.rateLimitRetries += 1;
  if (summary.diagnosticCode === 'provider-transient-retry') counts.transientRetries += 1;
  if (segmentedRepair) counts.segmentedRepairCalls += 1;
  return normalizeRecoveryCounts(counts);
}

export function recoveryCountsAfterArtifact(previous, summary = {}) {
  const counts = normalizeRecoveryCounts(previous);
  counts.salvagedItems += Math.max(0, Math.min(40, Math.trunc(Number(summary.salvagedItemCount) || 0)));
  counts.optionalOmissions += Math.max(0, Math.min(40, Math.trunc(Number(summary.optionalOmissionCount) || 0)));
  if (summary.recoveryCause?.startsWith('RECURSION_JSON_')) counts.parseFailures += 1;
  if (summary.recoveryCause === 'RECURSION_PROVIDER_SCHEMA_MISMATCH') counts.shapeFailures += 1;
  return normalizeRecoveryCounts(counts);
}
