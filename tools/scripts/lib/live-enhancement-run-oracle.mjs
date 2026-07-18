import { hashJson } from '../../../src/core.mjs';

const UNHEALTHY_PROGRESS_STATES = new Set(['caution', 'warning', 'warn', 'failed', 'failure', 'error']);
const UNHEALTHY_JOURNAL_SEVERITIES = new Set(['warning', 'warn', 'error', 'fatal']);
const UNHEALTHY_JOURNAL_EVENTS = new Set(['provider.call.failed', 'prompt.install_skipped']);
const BASE_REQUIRED_EDITORIAL_LABELS = Object.freeze([
  'editorial diagnosis',
  'editorial candidate',
  'recursion prompt ready'
]);

function text(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalized(value = '') {
  return text(value).toLowerCase();
}

function usefulReason(value = '') {
  const reason = normalized(value).replace(/[.!]+$/g, '');
  return Boolean(reason) && !new Set([
    'failed',
    'failure',
    'warning',
    'caution',
    'needs attention',
    'issue'
  ]).has(reason);
}

function providerCallKey(entry = {}) {
  const requestHash = text(entry?.hashes?.requestHash);
  if (requestHash) return `${text(entry.runId)}::${text(entry?.details?.roleId)}::${requestHash}`;
  return `${text(entry.runId)}::${text(entry?.details?.roleId)}`;
}

function countByKey(entries = []) {
  const counts = new Map();
  for (const entry of entries) {
    const key = providerCallKey(entry);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasMutationState(value) {
  const state = object(value);
  return text(state.chatKey)
    && state.messageId !== undefined
    && Number.isInteger(Number(state.swipeCount))
    && Number.isInteger(Number(state.swipeId))
    && typeof state.text === 'string';
}

function sameIdentity(left = {}, right = {}) {
  return text(left.chatKey) === text(right.chatKey)
    && String(left.messageId ?? '') === String(right.messageId ?? '');
}

function pushIf(failures, condition, code) {
  if (condition) failures.push(code);
}

function markerSummary(value) {
  const marker = object(value);
  return {
    schema: text(marker.schema),
    chatKeyHash: marker.chatKey === undefined ? '' : hashJson(String(marker.chatKey)),
    messageId: marker.messageId ?? null,
    swipeId: marker.swipeId ?? null,
    mode: text(marker.mode),
    applyMode: text(marker.applyMode),
    sourceHash: text(marker.sourceHash),
    candidateHash: text(marker.candidateHash),
    diagnosisHash: text(marker.diagnosisHash),
    outcome: text(marker.outcome)
  };
}

function mutationStateSummary(value) {
  const state = object(value);
  return {
    chatKeyHash: state.chatKey === undefined ? '' : hashJson(String(state.chatKey)),
    messageId: state.messageId ?? null,
    swipeCount: Number(state.swipeCount || 0),
    swipeId: Number(state.swipeId || 0),
    textHash: typeof state.text === 'string' ? hashJson(state.text) : '',
    marker: markerSummary(state.marker)
  };
}

export function evaluateEnhancementMutation({
  enhancement = null,
  before = null,
  after = null,
  enhancementResult = null,
  editorialResult = null
} = {}) {
  const failures = [];
  const configured = object(enhancement);
  const source = object(before);
  const final = object(after);
  const result = object(enhancementResult);
  const editorial = object(editorialResult);
  const mode = normalized(configured.mode);
  const applyMode = normalized(configured.applyMode);
  const enabled = configured.enabled !== false && !['off', 'none', 'disabled'].includes(mode);

  if (!Object.keys(configured).length) failures.push('enhancement-config-missing');
  if (!hasMutationState(source)) failures.push('enhancement-before-state-missing');
  if (!hasMutationState(final)) failures.push('enhancement-after-state-missing');

  if (!enabled) {
    if (hasMutationState(source) && hasMutationState(final)) {
      const stateChanged = !sameIdentity(source, final)
        || Number(source.swipeCount) !== Number(final.swipeCount)
        || Number(source.swipeId) !== Number(final.swipeId)
        || source.text !== final.text;
      const beforeMarkerHash = hashJson(object(source.marker));
      const afterMarkerHash = hashJson(object(final.marker));
      const recursionMarkerAdded = final.marker?.schema === 'recursion.editorialMarker.v1'
        && beforeMarkerHash !== afterMarkerHash;
      pushIf(failures, stateChanged || recursionMarkerAdded, 'enhancement-disabled-mutated');
    }
    return {
      ok: failures.length === 0,
      kind: 'off',
      failures: [...new Set(failures)],
      marker: markerSummary(final.marker)
    };
  }

  pushIf(failures, !['as-swipe', 'replace'].includes(applyMode), 'enhancement-apply-mode-invalid');
  pushIf(failures, !Object.keys(result).length || result.ok !== true, 'enhancement-result-unhealthy');
  pushIf(failures, result.skipped === true, 'enhancement-result-skipped');
  pushIf(
    failures,
    result.partialFailed === true || normalized(result?.marker?.outcome) === 'partial-failed',
    'enhancement-result-partial-failed'
  );
  pushIf(
    failures,
    !Object.keys(editorial).length
      || normalized(editorial.status) !== 'success'
      || !['applied', 'cached'].includes(normalized(editorial.outcome)),
    'enhancement-editorial-result-unhealthy'
  );
  pushIf(
    failures,
    normalized(result.mode) !== mode,
    'enhancement-result-mode-mismatch'
  );
  pushIf(
    failures,
    normalized(editorial.mode) !== mode || normalized(editorial.applyMode) !== applyMode,
    'enhancement-editorial-result-mismatch'
  );

  if (hasMutationState(source) && hasMutationState(final)) {
    pushIf(failures, !sameIdentity(source, final), 'enhancement-message-identity-mismatch');
    if (applyMode === 'as-swipe') {
      pushIf(
        failures,
        Number(final.swipeCount) !== Number(source.swipeCount) + 1,
        'enhancement-swipe-count-invalid'
      );
      pushIf(
        failures,
        Number(final.swipeId) !== Number(final.swipeCount) - 1,
        'enhancement-swipe-selection-invalid'
      );
      pushIf(failures, final.text === source.text, 'enhancement-swipe-text-unchanged');
    } else if (applyMode === 'replace') {
      pushIf(
        failures,
        Number(final.swipeCount) !== Number(source.swipeCount)
          || Number(final.swipeId) !== Number(source.swipeId),
        'enhancement-replace-swipe-state-invalid'
      );
      pushIf(failures, final.text === source.text, 'enhancement-replace-text-unchanged');
    }
  }

  const marker = object(final.marker);
  if (!Object.keys(marker).length) {
    failures.push('enhancement-marker-missing');
  } else {
    pushIf(failures, marker.schema !== 'recursion.editorialMarker.v1', 'enhancement-marker-schema-invalid');
    pushIf(
      failures,
      text(marker.chatKey) !== text(source.chatKey)
        || String(marker.messageId ?? '') !== String(source.messageId ?? '')
        || Number(marker.swipeId ?? -1) !== Number(source.swipeId ?? -2),
      'enhancement-marker-identity-mismatch'
    );
    pushIf(failures, normalized(marker.mode) !== mode, 'enhancement-marker-mode-mismatch');
    pushIf(failures, normalized(marker.applyMode) !== applyMode, 'enhancement-marker-apply-mode-mismatch');
    pushIf(failures, text(marker.sourceHash) !== hashJson(source.text), 'enhancement-marker-source-mismatch');
    pushIf(failures, text(marker.candidateHash) !== hashJson(final.text), 'enhancement-marker-candidate-mismatch');
    pushIf(failures, !text(marker.diagnosisHash), 'enhancement-marker-diagnosis-missing');
    pushIf(failures, normalized(marker.outcome) !== 'applied', 'enhancement-marker-outcome-invalid');
    pushIf(
      failures,
      Object.keys(object(result.marker)).length > 0 && hashJson(result.marker) !== hashJson(marker),
      'enhancement-result-marker-mismatch'
    );
  }

  return {
    ok: failures.length === 0,
    kind: applyMode === 'as-swipe' ? 'swipe' : (applyMode === 'replace' ? 'replace' : 'invalid'),
    failures: [...new Set(failures)],
    marker: markerSummary(marker)
  };
}

export function journalDeltaSince(journal = [], { baselineIds = [], startedAt = '' } = {}) {
  const baseline = new Set((baselineIds || []).map((id) => String(id || '')).filter(Boolean));
  const startedAtMs = Date.parse(String(startedAt || ''));
  return (Array.isArray(journal) ? journal : []).filter((entry) => {
    if (baseline.has(String(entry?.id || ''))) return false;
    const recordedAtMs = Date.parse(String(entry?.recordedAt || ''));
    if (Number.isFinite(startedAtMs) && Number.isFinite(recordedAtMs) && recordedAtMs < startedAtMs) return false;
    return true;
  });
}

export function evaluateLiveEnhancementRun({
  transitions = [],
  finalRows = [],
  journalDelta = [],
  enhancement = null,
  before = null,
  after = null,
  enhancementResult = null,
  editorialResult = null
} = {}) {
  const failures = [];
  const observedRows = [...transitions, ...finalRows];
  const unhealthyTransitions = observedRows.filter((row) => (
    UNHEALTHY_PROGRESS_STATES.has(normalized(row?.state))
    || normalized(row?.label) === 'issue'
    || normalized(row?.title) === 'issue'
  ));
  if (unhealthyTransitions.length) failures.push('progress-observed-unhealthy');
  const unexplainedTransitions = unhealthyTransitions.filter((row) => !usefulReason(row?.reason));
  if (unexplainedTransitions.length) failures.push('progress-unhealthy-reason-missing');

  const skippedRows = observedRows.filter((row) => normalized(row?.state) === 'skipped');
  if (skippedRows.length) failures.push('enhancement-skipped');

  const latestByLabel = new Map();
  for (const row of observedRows) {
    const label = normalized(row?.label);
    if (label) latestByLabel.set(label, row);
  }
  const requiredEditorialLabels = normalized(enhancement?.mode) === 'redirect'
    ? [...BASE_REQUIRED_EDITORIAL_LABELS, 'editorial verification']
    : BASE_REQUIRED_EDITORIAL_LABELS;
  for (const requiredLabel of requiredEditorialLabels) {
    const row = latestByLabel.get(requiredLabel);
    if (!row) failures.push(`missing-${requiredLabel.replace(/\s+/g, '-')}`);
    else if (normalized(row?.state) !== 'done') {
      failures.push(`${requiredLabel.replace(/\s+/g, '-')}-not-done`);
    }
  }

  const unhealthyJournal = journalDelta.filter((entry) => (
    UNHEALTHY_JOURNAL_SEVERITIES.has(normalized(entry?.severity))
    || UNHEALTHY_JOURNAL_EVENTS.has(text(entry?.event))
  ));
  if (unhealthyJournal.length) failures.push('journal-observed-unhealthy');
  const unexplainedJournal = unhealthyJournal.filter((entry) => !usefulReason(
    entry?.details?.failure?.message
    || entry?.detail?.failure?.message
    || entry?.failure?.message
  ));
  if (unexplainedJournal.length) failures.push('journal-unhealthy-reason-missing');

  const started = journalDelta.filter((entry) => entry?.event === 'provider.call.started');
  const settled = journalDelta.filter((entry) => (
    entry?.event === 'provider.call.completed' || entry?.event === 'provider.call.failed'
  ));
  const startedCounts = countByKey(started);
  const settledCounts = countByKey(settled);
  const unmatchedProviderCalls = [...startedCounts.entries()]
    .filter(([key, count]) => (settledCounts.get(key) || 0) < count)
    .map(([key]) => key);
  if (unmatchedProviderCalls.length) failures.push('provider-call-unmatched');

  const mutation = evaluateEnhancementMutation({
    enhancement,
    before,
    after,
    enhancementResult,
    editorialResult
  });
  failures.push(...mutation.failures);

  return {
    ok: failures.length === 0,
    failures: [...new Set(failures)],
    unhealthyTransitions,
    unexplainedTransitions,
    unhealthyJournal,
    unexplainedJournal,
    unmatchedProviderCalls,
    skippedRows,
    finalRows,
    enhancementMutation: mutation
  };
}

export async function installLiveEnhancementRunOracle(page) {
  return page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime || null;
    if (!runtime?.exportDiagnostics) throw new Error('Recursion live oracle requires runtime diagnostics.');
    const diagnosticsResult = await runtime.exportDiagnostics();
    const baselineJournal = Array.isArray(diagnosticsResult?.diagnostics?.journal)
      ? diagnosticsResult.diagnostics.journal
      : [];
    const state = {
      baselineJournalIds: baselineJournal.map((entry) => String(entry?.id || '')).filter(Boolean),
      transitions: [],
      lastStateByRow: {},
      startedAt: new Date().toISOString(),
      observer: null
    };
    const rowSnapshot = (row, source = 'tree', stateOverride = '') => {
      if (!(row instanceof Element)) return;
      const label = String(
        row.dataset.recursionProgressLabel
        || row.querySelector('[data-recursion-progress-label]')?.textContent
        || ''
      ).replace(/\s+/g, ' ').trim();
      const progressState = String(stateOverride || row.dataset.recursionProgressState || '').trim().toLowerCase();
      if (!label || !progressState) return;
      const reason = String(
        row.querySelector('[data-recursion-progress-reason]')?.textContent
        || ''
      ).replace(/\s+/g, ' ').trim();
      const parent = String(row.parentElement?.dataset?.recursionProgressParentStep || '');
      const key = `${label}::${parent}`;
      const signature = `${progressState}::${reason}`;
      if (state.lastStateByRow[key] === signature && source !== 'removed') return;
      state.lastStateByRow[key] = signature;
      state.transitions.push({ label, state: progressState, reason, parent, source, at: new Date().toISOString() });
    };
    const captureNode = (node, source) => {
      if (!(node instanceof Element)) return;
      if (node.matches('[data-recursion-progress-row]')) rowSnapshot(node, source);
      for (const row of node.querySelectorAll('[data-recursion-progress-row]')) rowSnapshot(row, source);
    };
    const captureTree = (source = 'tree') => {
      for (const row of document.querySelectorAll('[data-recursion-status-popover] [data-recursion-progress-row]')) {
        rowSnapshot(row, source);
      }
      const title = String(document.querySelector('[data-recursion-progress-title]')?.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^issue$/i.test(title)) state.transitions.push({ title, state: 'failed', source, at: new Date().toISOString() });
    };
    captureTree('initial');
    state.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === 'attributes'
          && mutation.attributeName === 'data-recursion-progress-state'
          && mutation.oldValue
          && mutation.target instanceof Element
          && mutation.target.matches('[data-recursion-progress-row]')
        ) {
          rowSnapshot(mutation.target, 'attribute-old', mutation.oldValue);
        }
        captureNode(mutation.target, 'changed');
        for (const node of mutation.addedNodes || []) captureNode(node, 'added');
        for (const node of mutation.removedNodes || []) captureNode(node, 'removed');
      }
      captureTree('tree');
    });
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-recursion-progress-state', 'data-recursion-progress-label'],
      characterData: true
    });
    globalThis.__recursionLiveEnhancementRunOracle = state;
    return { ok: true, baselineJournalCount: baselineJournal.length, startedAt: state.startedAt };
  });
}

export async function collectLiveEnhancementRunOracle(page, certification = {}) {
  const observation = await page.evaluate(async () => {
    const state = globalThis.__recursionLiveEnhancementRunOracle;
    const runtime = globalThis.__recursionLiveHarnessRuntime || null;
    if (!state || !runtime?.exportDiagnostics) throw new Error('Recursion live oracle was not installed.');
    state.observer?.disconnect();
    const finalRows = [...document.querySelectorAll('[data-recursion-status-popover] [data-recursion-progress-row]')]
      .map((row) => ({
        label: String(row.dataset.recursionProgressLabel || row.querySelector('[data-recursion-progress-label]')?.textContent || '').replace(/\s+/g, ' ').trim(),
        state: String(row.dataset.recursionProgressState || '').trim().toLowerCase(),
        reason: String(row.querySelector('[data-recursion-progress-reason]')?.textContent || '').replace(/\s+/g, ' ').trim(),
        parent: String(row.parentElement?.dataset?.recursionProgressParentStep || '')
      }))
      .filter((row) => row.label && row.state);
    const diagnosticsResult = await runtime.exportDiagnostics();
    const journal = Array.isArray(diagnosticsResult?.diagnostics?.journal)
      ? diagnosticsResult.diagnostics.journal
      : [];
    delete globalThis.__recursionLiveEnhancementRunOracle;
    return {
      transitions: state.transitions || [],
      finalRows,
      journal,
      baselineJournalIds: state.baselineJournalIds || [],
      startedAt: state.startedAt
    };
  });
  Object.assign(observation, {
    enhancement: object(certification.enhancement),
    before: object(certification.before),
    after: object(certification.after),
    enhancementResult: object(certification.enhancementResult),
    editorialResult: object(certification.editorialResult)
  });
  observation.journalDelta = journalDeltaSince(observation.journal, {
    baselineIds: observation.baselineJournalIds,
    startedAt: observation.startedAt
  });
  delete observation.journal;
  delete observation.baselineJournalIds;
  const verdict = evaluateLiveEnhancementRun(observation);
  return {
    observation: {
      ...observation,
      before: mutationStateSummary(observation.before),
      after: mutationStateSummary(observation.after),
      enhancementResult: {
        ok: observation.enhancementResult?.ok === true,
        skipped: observation.enhancementResult?.skipped === true,
        partialFailed: observation.enhancementResult?.partialFailed === true,
        mode: text(observation.enhancementResult?.mode),
        marker: markerSummary(observation.enhancementResult?.marker)
      },
      editorialResult: {
        mode: text(observation.editorialResult?.mode),
        status: text(observation.editorialResult?.status),
        outcome: text(observation.editorialResult?.outcome),
        applyMode: text(observation.editorialResult?.applyMode),
        errorCode: text(observation.editorialResult?.errorCode)
      }
    },
    verdict
  };
}
