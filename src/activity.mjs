import { cloneJson, makeId, nowIso, redact, truncate } from './core.mjs';
import { failureFrom } from './failures.mjs';

const HISTORY_LIMIT = 100;
const VALID_MODES = new Set(['foreground', 'background', 'review']);
const VALID_SEVERITIES = new Set(['info', 'success', 'warning', 'error']);
const VALID_OUTCOMES = new Set(['success', 'warning', 'error', 'skipped', 'canceled']);
const VALID_PROVIDER_LANES = new Set(['utility', 'reasoner']);
const VALID_COMPOSER_LANES = new Set(['utility', 'guidance', 'reasoner', 'local']);
const OUTCOME_SEVERITY = new Map([
  ['success', 'success'],
  ['warning', 'warning'],
  ['error', 'error']
]);
const SECRET_TEXT_PATTERN = /(sk-[a-z0-9_-]+|bearer\s+[a-z0-9._-]+|secret[-_\s]*value|private[-_\s]*key[-_\s]*material)/ig;
const PRIVATE_PROSE_KEYS = new Set([
  'sourcetext',
  'sourceprose',
  'originaldraft',
  'draft',
  'candidate',
  'candidatetext',
  'candidateprose',
  'guidance',
  'guidancetext',
  'prompt',
  'prompttext',
  'provideroutput',
  'transcriptexcerpt',
  'intermediatedraft'
]);

function cloneSafe(value, fallback = undefined) {
  try {
    const cloned = cloneJson(value);
    return cloned === undefined ? fallback : cloned;
  } catch {
    return fallback;
  }
}

function cleanText(value, limit) {
  if (value === undefined || value === null) return undefined;
  return truncate(String(redact(value)).replace(SECRET_TEXT_PATTERN, '[redacted]'), limit);
}

function cleanStructured(value, maxString = 500) {
  if (value === undefined || value === null) return undefined;
  return scrubPrivateProse(scrubSecretText(redact(cloneSafe(value, undefined), { maxString })));
}

function scrubSecretText(value) {
  if (typeof value === 'string') return value.replace(SECRET_TEXT_PATTERN, '[redacted]');
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubSecretText(entry));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrubSecretText(child)]));
}

function scrubPrivateProse(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubPrivateProse(entry));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_PROSE_KEYS.has(String(key).replace(/[^a-z0-9]/gi, '').toLowerCase()))
      .map(([key, child]) => [key, scrubPrivateProse(child)])
  );
}

function cleanChips(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((chip) => cleanText(chip, 80))
    .filter((chip) => chip);
}

function cleanChoice(value, valid, fallback = undefined) {
  const text = cleanText(value, 80);
  return valid.has(text) ? text : fallback;
}

function cleanRunId(value) {
  return cleanText(value || makeId('run'), 128);
}

function ensureUnhealthyFailure(event) {
  if (!['warning', 'error'].includes(event.severity)) return event;
  const detail = event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
    ? event.detail
    : {};
  const cause = detail.failure
    || detail.error
    || detail.compactError
    || detail.reason
    || detail.statusReason
    || detail.cautionReason
    || detail.decision
    || event.fallbackReason;
  const failure = failureFrom(cause, {
    code: 'RECURSION_ACTIVITY_REASON_MISSING',
    stage: event.logicalStage || event.phase || 'activity',
    category: 'internal',
    message: 'Recursion hit an unexpected internal error.',
    suggestedAction: 'Try again. If it keeps happening, copy the failure code from Diagnostics.'
  });
  const descriptorDetail = { ...detail };
  delete descriptorDetail.message;
  return {
    ...event,
    detail: cleanStructured({ ...descriptorDetail, failure }) ?? { failure }
  };
}

function normalizeEvent(input = {}, defaults = {}) {
  const event = ensureUnhealthyFailure({
    runId: cleanRunId(input.runId ?? defaults.runId),
    phase: cleanText(input.phase ?? defaults.phase ?? 'activity', 80),
    operationId: cleanText(input.operationId ?? defaults.operationId, 128) ?? null,
    logicalStage: cleanText(input.logicalStage ?? defaults.logicalStage, 160) ?? null,
    mode: cleanChoice(input.mode ?? defaults.mode, VALID_MODES, defaults.mode ?? 'background'),
    severity: cleanChoice(input.severity ?? defaults.severity, VALID_SEVERITIES, defaults.severity ?? 'info'),
    outcome: cleanChoice(input.outcome ?? defaults.outcome, VALID_OUTCOMES) ?? null,
    label: cleanText(input.label ?? defaults.label ?? '', 160),
    detail: cleanStructured(input.detail ?? defaults.detail) ?? null,
    chips: cleanChips(input.chips ?? defaults.chips),
    providerLane: cleanChoice(input.providerLane ?? defaults.providerLane, VALID_PROVIDER_LANES) ?? null,
    composerLane: cleanChoice(input.composerLane ?? defaults.composerLane, VALID_COMPOSER_LANES) ?? null,
    cardCounts: cleanStructured(input.cardCounts ?? defaults.cardCounts) ?? null,
    fallbackReason: cleanText(input.fallbackReason ?? defaults.fallbackReason, 240) ?? null,
    recordedAt: nowIso()
  });

  return cloneSafe(event, normalizeIdleEvent());
}

function normalizeIdleEvent() {
  return cloneJson({
    runId: null,
    phase: 'idle',
    operationId: null,
    logicalStage: null,
    mode: 'background',
    severity: 'info',
    outcome: null,
    label: '',
    detail: null,
    chips: [],
    providerLane: null,
    composerLane: null,
    cardCounts: null,
    fallbackReason: null,
    recordedAt: nowIso()
  });
}

function publish(event, state, onEvent) {
  state.currentEvent = cloneJson(event);
  state.history.push(cloneJson(event));
  if (state.history.length > HISTORY_LIMIT) {
    state.history.splice(0, state.history.length - HISTORY_LIMIT);
  }

  if (typeof onEvent !== 'function') return;
  try {
    const result = onEvent(cloneJson(event));
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // Activity observers are best-effort; UI failures must not break runtime work.
  }
}

export function createActivityReporter({ onEvent = null } = {}) {
  const state = {
    activeRunId: null,
    currentEvent: normalizeIdleEvent(),
    history: []
  };

  function start(input = {}) {
    const event = normalizeEvent(input, {
      phase: 'started',
      mode: 'foreground',
      severity: 'info'
    });
    state.activeRunId = event.runId;
    publish(event, state, onEvent);
    return cloneJson(event);
  }

  function stage(input = {}) {
    if (!state.activeRunId) return cloneJson(state.currentEvent);
    if (input.runId && input.runId !== state.activeRunId) return cloneJson(state.currentEvent);
    const event = normalizeEvent(input, {
      runId: state.activeRunId,
      mode: state.currentEvent.mode,
      severity: 'info'
    });
    publish(event, state, onEvent);
    return cloneJson(event);
  }

  function settle(input = {}) {
    if (!state.activeRunId) return cloneJson(state.currentEvent);
    if (input.runId && input.runId !== state.activeRunId) return cloneJson(state.currentEvent);
    const severity = OUTCOME_SEVERITY.get(input.outcome) || cleanChoice(input.severity, VALID_SEVERITIES, 'info');
    const event = normalizeEvent(input, {
      runId: state.activeRunId,
      phase: 'settled',
      mode: state.currentEvent.mode,
      severity
    });
    event.phase = 'settled';
    event.severity = severity;
    publish(event, state, onEvent);
    state.activeRunId = null;
    return cloneJson(event);
  }

  function current() {
    return cloneJson(state.currentEvent);
  }

  function history() {
    return cloneJson(state.history);
  }

  function clear() {
    state.activeRunId = null;
    state.history = [];
    const event = normalizeIdleEvent();
    publish(event, state, onEvent);
    return cloneJson(event);
  }

  return { start, stage, settle, current, history, clear };
}
