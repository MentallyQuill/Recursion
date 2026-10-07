const SALVAGE_CODES = new Set([
  'RECURSION_JSON_PARSE_FAILED', 'RECURSION_JSON_OBJECT_REQUIRED', 'RECURSION_JSON_AMBIGUOUS',
  'RECURSION_PROVIDER_SCHEMA_MISMATCH', 'RECURSION_PROVIDER_RESPONSE_JSON_INVALID',
  'RECURSION_PROVIDER_TOKEN_LIMIT'
]);

export function canSalvageStructuredOutput(failure) {
  return SALVAGE_CODES.has(failure?.code);
}

export function canNarrowFusedFailure(failure) {
  return canSalvageStructuredOutput(failure)
    || failure?.code === 'RECURSION_PROVIDER_CONTEXT_LIMIT'
    || (failure?.kind === 'validation' && failure?.category === 'validation');
}

export function requiredGeneratedCard(card) {
  return Boolean(card?.forcedBy || card?.mandatory === true
    || (card?.family || card?.role || card) === 'Scene Constraints');
}

export function settledCardStage(stage, record) {
  return record?.state === 'completed' || (record?.state === 'failed' && failureMayContinue(stage, record));
}

export function failureMayContinue(stage, record) {
  const failure = record?.failure || {};
  return stage?.failurePolicy === 'continue'
    && ((stage?.kind === 'host' && record?.checkpoint)
      || !['storage', 'stale-state', 'host-mutation', 'prompt-install'].includes(failure.failureClass || failure.category))
    && !['RECURSION_PROVIDER_ABORTED', 'RECURSION_OPERATION_DEADLINE', 'RECURSION_RECOVERY_BUDGET_EXHAUSTED'].includes(failure.code);
}
