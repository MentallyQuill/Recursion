import { cloneJson, makeId, nowIso, redact, truncate } from './core.mjs';

const HISTORY_LIMIT = 100;
const VALID_MODES = new Set(['foreground', 'background', 'review']);
const VALID_SEVERITIES = new Set(['info', 'success', 'warning', 'error']);
const VALID_PROVIDER_LANES = new Set(['utility', 'reasoner']);
const VALID_COMPOSER_LANES = new Set(['utility', 'reasoner', 'local']);
const OUTCOME_SEVERITY = new Map([
  ['success', 'success'],
  ['warning', 'warning'],
  ['error', 'error']
]);
const SECRET_TEXT_PATTERN = /(sk-[a-z0-9_-]+|bearer\s+[a-z0-9._-]+|secret[-_\s]*value|private[-_\s]*key[-_\s]*material)/ig;

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
  return scrubSecretText(redact(cloneSafe(value, undefined), { maxString }));
}

function scrubSecretText(value) {
  if (typeof value === 'string') return value.replace(SECRET_TEXT_PATTERN, '[redacted]');
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubSecretText(entry));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrubSecretText(child)]));
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

function normalizeEvent(input = {}, defaults = {}) {
  const event = {
    runId: cleanRunId(input.runId ?? defaults.runId),
    phase: cleanText(input.phase ?? defaults.phase ?? 'activity', 80),
    operationId: cleanText(input.operationId ?? defaults.operationId, 128) ?? null,
    logicalStage: cleanText(input.logicalStage ?? defaults.logicalStage, 160) ?? null,
    mode: cleanChoice(input.mode ?? defaults.mode, VALID_MODES, defaults.mode ?? 'background'),
    severity: cleanChoice(input.severity ?? defaults.severity, VALID_SEVERITIES, defaults.severity ?? 'info'),
    label: cleanText(input.label ?? defaults.label ?? '', 160),
    detail: cleanStructured(input.detail ?? defaults.detail) ?? null,
    chips: cleanChips(input.chips ?? defaults.chips),
    providerLane: cleanChoice(input.providerLane ?? defaults.providerLane, VALID_PROVIDER_LANES) ?? null,
    composerLane: cleanChoice(input.composerLane ?? defaults.composerLane, VALID_COMPOSER_LANES) ?? null,
    cardCounts: cleanStructured(input.cardCounts ?? defaults.cardCounts) ?? null,
    fallbackReason: cleanText(input.fallbackReason ?? defaults.fallbackReason, 240) ?? null,
    recordedAt: nowIso()
  };

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
