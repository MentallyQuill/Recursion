const LIFECYCLE_KINDS = new Set([
  'stop-resume',
  'retry-stage',
  'fused-fallback',
  'queued-reprocess'
]);

function text(value) {
  return String(value ?? '').trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function segmentedReady(profile = {}) {
  const certification = profile.certification || {};
  return ['pass', 'partial'].includes(certification.status)
    && certification.checks?.connectivity === 'pass'
    && certification.checks?.singleCard === 'pass';
}

function fusedReady(profile = {}) {
  return segmentedReady(profile)
    && profile.certification?.status === 'pass'
    && profile.certification?.checks?.fusedCards === 'pass';
}

export function qualifyUtilityProfiles(profiles = [], preferredFusedLabel = '') {
  const entries = list(profiles);
  if (entries.length !== 4) return { ok: false, assignments: {}, errors: ['profile-count'] };
  const labels = entries.map((entry) => text(entry?.label));
  if (labels.some((label) => !label)) return { ok: false, assignments: {}, errors: ['profile-label-missing'] };
  if (new Set(labels).size !== labels.length) return { ok: false, assignments: {}, errors: ['duplicate-profile-label'] };
  if (entries.some((entry) => !segmentedReady(entry))) {
    return { ok: false, assignments: {}, errors: ['profile-not-segmented-ready'] };
  }
  const preferred = text(preferredFusedLabel);
  const preferredIndex = labels.indexOf(preferred);
  if (preferredIndex < 0) return { ok: false, assignments: {}, errors: ['preferred-fused-profile-missing'] };
  const fusedIndex = fusedReady(entries[preferredIndex])
    ? preferredIndex
    : entries.findIndex(fusedReady);
  if (fusedIndex < 0) return { ok: false, assignments: {}, errors: ['no-fused-ready-profile'] };

  const scenarioByIndex = ['stop-resume', 'retry-stage', 'fused-fallback', 'queued-reprocess'];
  if (fusedIndex !== preferredIndex) {
    const displaced = scenarioByIndex[fusedIndex];
    scenarioByIndex[fusedIndex] = 'fused-fallback';
    scenarioByIndex[preferredIndex] = displaced;
  }
  const assignments = Object.fromEntries(scenarioByIndex.map((scenario, index) => [scenario, labels[index]]));
  return { ok: true, assignments, errors: [] };
}

function commonLifecycleErrors(evidence = {}) {
  const errors = [];
  if (evidence.operationState !== 'completed') errors.push('operation-not-completed');
  if (Number(evidence.adverseStageCount) !== 0) errors.push('adverse-stage');
  if (evidence.assistantAfter !== true) errors.push('assistant-not-observed');
  return errors;
}

export function inspectLifecycleMilestone(kind, evidence = {}) {
  const normalizedKind = text(kind);
  const errors = commonLifecycleErrors(evidence);
  if (!LIFECYCLE_KINDS.has(normalizedKind)) errors.push('unknown-milestone');

  if (normalizedKind === 'stop-resume') {
    if (Number(evidence.hostStopCalls) !== 1) errors.push('host-stop-count');
    if (Number(evidence.promptClears) !== 1) errors.push('prompt-clear-count');
    if (evidence.paused !== true) errors.push('operation-not-paused');
    if (Number(evidence.nativeResumeStarts) !== 1) errors.push('native-resume-count');
    if (Number(evidence.detachedProviderCalls) !== 0) errors.push('detached-provider-call');
    if (evidence.freshFrontierSignal !== true) errors.push('stale-frontier-signal');
  } else if (normalizedKind === 'retry-stage') {
    if (evidence.failedStageId !== 'preprocess.arbiter') errors.push('wrong-failed-stage');
    if (evidence.retryActionVisible !== true) errors.push('retry-action-missing');
    if (evidence.sameOperation !== true) errors.push('retry-operation-changed');
    if (Number(evidence.attemptAfter) !== Number(evidence.attemptBefore) + 1) errors.push('retry-attempt-count');
    if (Number(evidence.upstreamDuplicateCount) !== 0) errors.push('retry-upstream-duplicate');
  } else if (normalizedKind === 'fused-fallback') {
    if (evidence.requestedPipeline !== 'fused' || evidence.effectivePipeline !== 'fused') errors.push('fused-not-effective');
    if (Number(evidence.fusedAttemptCount) !== Number(evidence.configuredAttemptLimit)) errors.push('fused-attempt-window');
    if (evidence.fusedDirectiveCompleted !== true) errors.push('fused-directive-missing');
    if (evidence.arbiterCheckpointReused !== true) errors.push('arbiter-not-reused');
    if (JSON.stringify(list(evidence.segmentedFamilies).sort()) !== JSON.stringify(list(evidence.unresolvedFamilies).sort())) {
      errors.push('fallback-family-mismatch');
    }
    if (evidence.profileUnavailableRelabel === true) errors.push('profile-unavailable-relabel');
  } else if (normalizedKind === 'queued-reprocess') {
    if (list(evidence.queuedStageIds).length < 1) errors.push('queued-frontier-missing');
    if (Number(evidence.immediateProviderCalls) !== 0) errors.push('reprocess-started-immediately');
    if (Number(evidence.nativeSwipeStarts) !== 1) errors.push('native-swipe-count');
    if (Number(evidence.intentConsumeCount) !== 1) errors.push('intent-consume-count');
    if (evidence.upstreamCheckpointReused !== true) errors.push('upstream-not-reused');
    if (Number(evidence.downstreamRerunCount) < 1) errors.push('downstream-not-rerun');
    if (Number(evidence.duplicateOperationCount) !== 0) errors.push('duplicate-operation');
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      kind: normalizedKind,
      operationState: text(evidence.operationState),
      assistantAfter: evidence.assistantAfter === true
    }
  };
}

export function inspectEnduranceLedger(ledger = {}) {
  const turns = list(ledger.acceptedNewTurns);
  const errors = [];
  if (turns.length !== 8) errors.push('accepted-new-turn-count');
  if (new Set(turns.map((turn) => text(turn.turnId))).size !== turns.length) errors.push('duplicate-turn-id');
  if (new Set(turns.map((turn) => text(turn.turnKeyHash))).size !== turns.length) errors.push('duplicate-turn-key');
  const chatIds = new Set(turns.map((turn) => text(turn.chatIdHash)).filter(Boolean));
  if (chatIds.size !== 1) errors.push('chat-identity-changed');
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index] || {};
    if (Number(turn.userCount) !== index + 1 || Number(turn.assistantCount) !== index + 1) errors.push('nonmonotonic-message-count');
    if (turn.operationState !== 'completed') errors.push('turn-not-completed');
    if (Number(turn.promptKeyCount) !== 3) errors.push('prompt-key-count');
    if (turn.preparedReuse === true) errors.push('prepared-packet-reused');
  }
  const profileCounts = turns.reduce((counts, turn) => {
    const label = text(turn.profileLabel);
    if (label) counts[label] = (counts[label] || 0) + 1;
    return counts;
  }, {});
  const plannedLabels = list(ledger.expectedProfileLabels).map((label) => text(label)).filter(Boolean);
  if (plannedLabels.length === 8) {
    const expectedCounts = plannedLabels.reduce((counts, label) => {
      counts[label] = (counts[label] || 0) + 1;
      return counts;
    }, {});
    if (JSON.stringify(profileCounts) !== JSON.stringify(expectedCounts)) errors.push('profile-rotation-count');
  } else if (Object.keys(profileCounts).length !== 4 || Object.values(profileCounts).some((count) => count !== 2)) {
    errors.push('profile-rotation-count');
  }
  if (list(ledger.swipeRecords).some((record) => record?.countsAsNewTurn !== false)) errors.push('swipe-counted-as-turn');
  if (ledger.queuedReprocess) errors.push('queued-reprocess-remains');
  if (Number(ledger.pausedOperationCount) !== 0) errors.push('paused-operation-remains');
  if (Number(ledger.runningStageCount) !== 0) errors.push('running-stage-remains');
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    acceptedNewTurns: turns.length,
    profileCounts
  };
}

const PRIVATE_KEYS = /^(?:message|mes|prompt|promptText|request|response|content|reasoning|connectionProfileId|secret-id|secretId|cookie|authorization|headers|chat|packet|transcript|excerpts)$/i;

export function sanitizeResilienceReport(value, key = '') {
  if (PRIVATE_KEYS.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeResilienceReport(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeResilienceReport(entryValue, entryKey)
    ]));
  }
  return typeof value === 'string' ? value.slice(0, 500) : value;
}
