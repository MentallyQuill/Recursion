const UNHEALTHY_PROGRESS_STATES = new Set(['caution', 'warning', 'warn', 'failed', 'failure', 'error']);
const UNHEALTHY_JOURNAL_SEVERITIES = new Set(['warning', 'warn', 'error', 'fatal']);
const UNHEALTHY_JOURNAL_EVENTS = new Set(['provider.call.failed', 'prompt.install_skipped']);
const REQUIRED_EDITORIAL_LABELS = Object.freeze([
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

export function evaluateLiveEnhancementRun({
  transitions = [],
  finalRows = [],
  journalDelta = [],
  enhancementMutation = null
} = {}) {
  const failures = [];
  const observedRows = [...transitions, ...finalRows];
  const unhealthyTransitions = observedRows.filter((row) => (
    UNHEALTHY_PROGRESS_STATES.has(normalized(row?.state))
    || normalized(row?.label) === 'issue'
    || normalized(row?.title) === 'issue'
  ));
  if (unhealthyTransitions.length) failures.push('progress-observed-unhealthy');

  const skippedRows = observedRows.filter((row) => normalized(row?.state) === 'skipped');
  if (skippedRows.length) failures.push('enhancement-skipped');

  for (const requiredLabel of REQUIRED_EDITORIAL_LABELS) {
    const rows = finalRows.filter((row) => normalized(row?.label) === requiredLabel);
    if (!rows.length) failures.push(`missing-${requiredLabel.replace(/\s+/g, '-')}`);
    else if (rows.some((row) => normalized(row?.state) !== 'done')) {
      failures.push(`${requiredLabel.replace(/\s+/g, '-')}-not-done`);
    }
  }

  const unhealthyJournal = journalDelta.filter((entry) => (
    UNHEALTHY_JOURNAL_SEVERITIES.has(normalized(entry?.severity))
    || UNHEALTHY_JOURNAL_EVENTS.has(text(entry?.event))
  ));
  if (unhealthyJournal.length) failures.push('journal-observed-unhealthy');

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

  const mutation = enhancementMutation && typeof enhancementMutation === 'object'
    ? enhancementMutation
    : {};
  if (!['swipe', 'replace'].includes(text(mutation.kind))) failures.push('enhancement-result-missing');
  if (mutation.recursionOwned !== true) failures.push('enhancement-result-not-recursion-owned');
  if (mutation.validated !== true) failures.push('enhancement-result-not-validated');

  return {
    ok: failures.length === 0,
    failures: [...new Set(failures)],
    unhealthyTransitions,
    unhealthyJournal,
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
      const parent = String(row.parentElement?.dataset?.recursionProgressParentStep || '');
      const key = `${label}::${parent}`;
      if (state.lastStateByRow[key] === progressState && source !== 'removed') return;
      state.lastStateByRow[key] = progressState;
      state.transitions.push({ label, state: progressState, parent, source, at: new Date().toISOString() });
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

export async function collectLiveEnhancementRunOracle(page) {
  const observation = await page.evaluate(async () => {
    const state = globalThis.__recursionLiveEnhancementRunOracle;
    const runtime = globalThis.__recursionLiveHarnessRuntime || null;
    if (!state || !runtime?.exportDiagnostics) throw new Error('Recursion live oracle was not installed.');
    state.observer?.disconnect();
    const finalRows = [...document.querySelectorAll('[data-recursion-status-popover] [data-recursion-progress-row]')]
      .map((row) => ({
        label: String(row.dataset.recursionProgressLabel || row.querySelector('[data-recursion-progress-label]')?.textContent || '').replace(/\s+/g, ' ').trim(),
        state: String(row.dataset.recursionProgressState || '').trim().toLowerCase(),
        parent: String(row.parentElement?.dataset?.recursionProgressParentStep || '')
      }))
      .filter((row) => row.label && row.state);
    const diagnosticsResult = await runtime.exportDiagnostics();
    const journal = Array.isArray(diagnosticsResult?.diagnostics?.journal)
      ? diagnosticsResult.diagnostics.journal
      : [];
    const baselineIds = new Set(state.baselineJournalIds || []);
    const journalDelta = journal.filter((entry) => !baselineIds.has(String(entry?.id || '')));
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const assistant = [...(Array.isArray(context.chat) ? context.chat : [])].reverse().find((entry) => entry?.is_user === false) || null;
    const swipeId = Number(assistant?.swipe_id ?? 0);
    const swipeMarker = Array.isArray(assistant?.__recursionGenerationReviewSwipes)
      ? assistant.__recursionGenerationReviewSwipes[swipeId]
      : null;
    const replaceMarker = assistant?.__recursionGenerationReview || null;
    const marker = swipeMarker || replaceMarker || null;
    const markerSchema = String(marker?.schema || '');
    const applyMode = String(marker?.applyMode || '');
    const enhancementMutation = {
      kind: applyMode === 'as-swipe' ? 'swipe' : (applyMode === 'replace' ? 'replace' : 'none'),
      recursionOwned: markerSchema === 'recursion.editorialMarker.v1',
      validated: markerSchema === 'recursion.editorialMarker.v1'
        && Boolean(marker?.diagnosisHash)
        && Boolean(marker?.candidateHash),
      markerSchema,
      applyMode,
      swipeId,
      swipeCount: Array.isArray(assistant?.swipes) ? assistant.swipes.length : 0
    };
    delete globalThis.__recursionLiveEnhancementRunOracle;
    return {
      transitions: state.transitions || [],
      finalRows,
      journalDelta,
      enhancementMutation,
      startedAt: state.startedAt
    };
  });
  return {
    observation,
    verdict: evaluateLiveEnhancementRun(observation)
  };
}
