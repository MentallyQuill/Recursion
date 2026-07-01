const VALID_STATES = new Set(['pending', 'running', 'done', 'warning', 'failed', 'skipped']);
const VALID_PROVIDER_LANES = new Set(['utility', 'reasoner']);
const SAFE_PROGRESS_TITLES = new Set(['Generating', 'Ready', 'Idle', 'Issue', 'Needs attention']);
const MODEL_CALL_ROLE_IDS = new Set([
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'continuityRiskCard',
  'environmentItemsCard',
  'prosePacingCard',
  'openThreadsCard'
]);

const STEP_ORDER = [
  'read-turn',
  'checking-scene-shift',
  'planning-card-pass',
  'reusing-scene-deck',
  'utility-card-batch',
  'validating-cards',
  'repairing-card-json',
  'updating-scene-deck',
  'selecting-turn-hand',
  'saving-scene-cache',
  'composing-prompt-packet',
  'reasoner-brief',
  'installing-recursion-prompt',
  'clearing-recursion-prompt',
  'recursion-prompt-ready'
];

const STEP_DEFINITIONS = Object.freeze({
  'read-turn': { label: 'Reading current turn', providerLane: 'utility' },
  'checking-scene-shift': { label: 'Checking scene shift', providerLane: 'utility' },
  'planning-card-pass': { label: 'Planning card pass', providerLane: 'utility' },
  'reusing-scene-deck': { label: 'Reusing scene deck', providerLane: 'utility' },
  'utility-card-batch': { label: 'Utility card batch', providerLane: 'utility' },
  'validating-cards': { label: 'Validating cards', providerLane: 'utility' },
  'repairing-card-json': { label: 'Repairing card JSON', providerLane: 'utility' },
  'updating-scene-deck': { label: 'Updating scene deck', providerLane: 'utility' },
  'selecting-turn-hand': { label: 'Selecting turn hand', providerLane: 'utility' },
  'saving-scene-cache': { label: 'Saving scene cache', providerLane: 'utility' },
  'composing-prompt-packet': { label: 'Composing prompt packet', providerLane: 'utility' },
  'reasoner-brief': { label: 'Reasoner brief', providerLane: 'reasoner' },
  'installing-recursion-prompt': { label: 'Installing Recursion prompt', providerLane: 'utility' },
  'clearing-recursion-prompt': { label: 'Clearing Recursion prompt', providerLane: 'utility' },
  'recursion-prompt-ready': { label: 'Recursion prompt ready', providerLane: 'utility' }
});

const PHASE_STEP_IDS = Object.freeze({
  started: 'read-turn',
  sceneChecking: 'checking-scene-shift',
  arbiterPlanning: 'planning-card-pass',
  cacheReusing: 'reusing-scene-deck',
  cardBatchRunning: 'utility-card-batch',
  cardValidating: 'validating-cards',
  deckUpdating: 'updating-scene-deck',
  handSelected: 'selecting-turn-hand',
  storageSaving: 'saving-scene-cache',
  storageComplete: 'saving-scene-cache',
  storageProgress: 'saving-scene-cache',
  storageWarning: 'saving-scene-cache',
  utilityComposing: 'composing-prompt-packet',
  promptPacketBuilt: 'composing-prompt-packet',
  reasonerComposing: 'reasoner-brief',
  promptReasonerFallback: 'reasoner-brief',
  promptInstalling: 'installing-recursion-prompt',
  promptClearing: 'clearing-recursion-prompt',
  promptClearFailed: 'clearing-recursion-prompt',
  cacheWarning: 'reusing-scene-deck',
  settled: 'recursion-prompt-ready'
});

const FINAL_STATES = new Set(['done', 'warning', 'failed', 'skipped']);
const UNSAFE_DISPLAY_PATTERN = /\b(raw\s*prompt|prompt\s*text|system\s*prompt|password|api[-_\s]*key|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]+|private[-_\s]*secret)\b/i;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function truncateText(value, limit = 120) {
  const text = String(value ?? '');
  const cap = Math.max(0, Math.floor(Number(limit)) || 0);
  if (text.length <= cap) return text;
  if (cap <= 3) return '.'.repeat(cap);
  return `${text.slice(0, cap - 3)}...`;
}

function safeDisplayText(value, fallback = '', limit = 120) {
  const text = cleanText(value);
  if (!text || UNSAFE_DISPLAY_PATTERN.test(text)) return fallback;
  return truncateText(text, limit);
}

function idFromText(value, fallback) {
  const id = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || fallback;
}

function normalizeProviderLane(value, fallback = 'utility') {
  const lane = cleanText(value, fallback).toLowerCase();
  return VALID_PROVIDER_LANES.has(lane) ? lane : fallback;
}

function normalizeState(value, fallback = 'pending') {
  const state = cleanText(value, fallback).toLowerCase();
  return VALID_STATES.has(state) ? state : fallback;
}

function metaForState(state) {
  if (state === 'done') return 'done';
  if (state === 'running') return 'running';
  if (state === 'warning') return 'caution';
  if (state === 'failed') return 'failed';
  if (state === 'skipped') return 'skipped';
  return 'waiting';
}

function sourceEvents(view) {
  const source = asObject(view);
  const history = Array.isArray(source.activityHistory) ? source.activityHistory : [];
  const activity = asObject(source.activity);
  const events = [...history.map(asObject)];
  if (activity.phase && !events.some((event) => sameEvent(event, activity))) events.push(activity);
  return events.filter((event) => cleanText(event.phase));
}

function sameEvent(left, right) {
  return cleanText(left.runId) === cleanText(right.runId)
    && cleanText(left.phase) === cleanText(right.phase)
    && cleanText(left.recordedAt) === cleanText(right.recordedAt)
    && cleanText(left.label) === cleanText(right.label);
}

function roleStepId(event) {
  const detail = asObject(event.detail);
  const roleId = cleanText(detail.roleId || event.roleId);
  if (roleId === 'utilityArbiter') return 'planning-card-pass';
  if (roleId === 'reasonerComposer') return 'reasoner-brief';
  if (roleId === 'briefUtilityComposer') return 'composing-prompt-packet';
  if (MODEL_CALL_ROLE_IDS.has(roleId)) return 'utility-card-batch';
  return null;
}

function eventStepId(event) {
  const phase = cleanText(event.phase);
  if (phase.startsWith('providerCall')) return roleStepId(event) || 'utility-card-batch';
  return PHASE_STEP_IDS[phase] || null;
}

function eventState(event, isCurrent) {
  const phase = cleanText(event.phase);
  const severity = cleanText(event.severity, 'info').toLowerCase();
  if (severity === 'error') return 'failed';
  if (severity === 'warning' || phase === 'providerCallRetrying' || phase === 'promptReasonerFallback') return 'warning';
  if (severity === 'success' || phase === 'storageComplete' || phase === 'promptPacketBuilt' || phase === 'settled') return 'done';
  if (isCurrent) return 'running';
  return 'done';
}

function compareStepOrder(left, right) {
  const leftIndex = STEP_ORDER.indexOf(left.id);
  const rightIndex = STEP_ORDER.indexOf(right.id);
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  }
  return left.order - right.order;
}

function upsertStep(map, step) {
  const existing = map.get(step.id);
  if (!existing) {
    map.set(step.id, step);
    return;
  }
  const next = { ...existing, ...step, order: existing.order };
  if (stateRank(step.state) < stateRank(existing.state)) next.state = existing.state;
  map.set(step.id, next);
}

function stateRank(state) {
  if (state === 'failed') return 5;
  if (state === 'warning') return 4;
  if (state === 'running') return 3;
  if (state === 'done') return 2;
  if (state === 'skipped') return 1;
  return 0;
}

function normalizeStep(input, index = 0) {
  const source = asObject(input);
  const rawId = source.id || source.label;
  const id = UNSAFE_DISPLAY_PATTERN.test(String(rawId ?? ''))
    ? `step-${index + 1}`
    : idFromText(rawId, `step-${index + 1}`);
  const definition = STEP_DEFINITIONS[id] || {};
  const state = normalizeState(source.state);
  return {
    id,
    label: definition.label || safeDisplayText(source.label, `Step ${index + 1}`, 80),
    providerLane: normalizeProviderLane(source.providerLane, definition.providerLane || 'utility'),
    state,
    meta: metaForState(state),
    sourcePhase: cleanText(source.sourcePhase || source.phase) || null,
    sourceRoleId: safeDisplayText(source.sourceRoleId || source.roleId, '', 80) || null,
    order: Number.isFinite(Number(source.order)) ? Number(source.order) : index
  };
}

function pendingStep(id, order) {
  const definition = STEP_DEFINITIONS[id] || {};
  return normalizeStep({
    id,
    label: definition.label,
    providerLane: definition.providerLane,
    state: 'pending',
    order
  }, order);
}

function planWantsReasoner(view) {
  const source = asObject(view);
  const plan = asObject(source.lastPlan);
  const decision = cleanText(plan.reasonerDecision?.mode).toLowerCase();
  const reasonerUse = cleanText(source.settings?.reasonerUse).toLowerCase();
  const lastStatus = cleanText(source.lastPacket?.diagnostics?.reasonerStatus).toLowerCase();
  const composerLane = cleanText(source.lastPacket?.diagnostics?.composerLane).toLowerCase();
  return decision === 'use' || reasonerUse === 'always' || lastStatus === 'used' || composerLane === 'reasoner';
}

function planWantsCards(view, currentActivity) {
  const source = asObject(view);
  const jobs = source.lastPlan?.cardJobs;
  if (Array.isArray(jobs) && jobs.length > 0) return true;
  const requested = Number(currentActivity?.cardCounts?.requested || currentActivity?.cardCounts?.total || 0);
  return Number.isFinite(requested) && requested > 0;
}

function appendPendingPlanSteps(map, view, orderStart = 0) {
  const source = asObject(view);
  const activity = asObject(source.activity);
  const mode = cleanText(source.settings?.mode, 'observe').toLowerCase();
  let order = orderStart;
  if (planWantsCards(source, activity) || map.has('utility-card-batch')) {
    for (const id of ['selecting-turn-hand', 'saving-scene-cache', 'composing-prompt-packet']) {
      if (!map.has(id)) upsertStep(map, pendingStep(id, order++));
    }
  }
  if (planWantsReasoner(source) && !map.has('reasoner-brief')) {
    upsertStep(map, pendingStep('reasoner-brief', order++));
  }
  const promptStepId = mode === 'observe' || mode === 'off' ? 'clearing-recursion-prompt' : 'installing-recursion-prompt';
  if (!map.has(promptStepId)) upsertStep(map, pendingStep(promptStepId, order++));
}

function normalizeExplicitProgress(progressRun) {
  const source = asObject(progressRun);
  const steps = Array.isArray(source.steps)
    ? source.steps.map((step, index) => normalizeStep(step, index))
    : [];
  return finalizeProgress({
    runId: cleanText(source.runId) || null,
    title: cleanText(source.title, 'Generating'),
    subtitle: cleanText(source.subtitle),
    steps
  }, { sort: false });
}

function deriveProgressRun(view) {
  const events = sourceEvents(view);
  const current = asObject(asObject(view).activity);
  const runId = cleanText(current.runId || [...events].reverse().find((event) => cleanText(event.runId))?.runId) || null;
  const currentKey = `${cleanText(current.runId)}|${cleanText(current.phase)}|${cleanText(current.recordedAt)}|${cleanText(current.label)}`;
  const steps = new Map();
  let order = 0;
  for (const event of events) {
    if (runId && cleanText(event.runId) && cleanText(event.runId) !== runId) continue;
    const id = eventStepId(event);
    if (!id) continue;
    const definition = STEP_DEFINITIONS[id] || {};
    const eventKey = `${cleanText(event.runId)}|${cleanText(event.phase)}|${cleanText(event.recordedAt)}|${cleanText(event.label)}`;
    const providerConcurrent = cleanText(event.phase).startsWith('providerCall')
      && cleanText(current.phase).startsWith('providerCall')
      && (!runId || cleanText(current.runId) === runId);
    upsertStep(steps, normalizeStep({
      id,
      label: definition.label || activityLabelText(event),
      providerLane: event.providerLane || event.composerLane || definition.providerLane,
      state: eventState(event, eventKey === currentKey || providerConcurrent),
      sourcePhase: event.phase,
      sourceRoleId: asObject(event.detail).roleId,
      order: order++
    }, order));
  }
  appendPendingPlanSteps(steps, view, order);
  return finalizeProgress({
    runId,
    title: progressTitle([...steps.values()]),
    subtitle: '',
    steps: [...steps.values()].sort(compareStepOrder)
  });
}

function activityLabelText(event) {
  return cleanText(event.label, 'Recursion is working...').replace(/\.+$/g, '');
}

function progressTitle(steps) {
  if (steps.some((step) => step.state === 'failed')) return 'Issue';
  if (steps.some((step) => step.state === 'warning')) return 'Needs attention';
  if (steps.some((step) => step.state === 'running')) return 'Generating';
  return steps.length ? 'Ready' : 'Idle';
}

function currentStepText(steps) {
  const running = steps.filter((step) => step.state === 'running');
  if (running.length > 1) return `${running.length} model calls running...`;
  if (running.length === 1) return `${running[0].label.replace(/\.+$/g, '')}...`;
  const warning = steps.find((step) => step.state === 'warning');
  if (warning) return `${warning.label.replace(/\.+$/g, '')} needs attention`;
  const failed = steps.find((step) => step.state === 'failed');
  if (failed) return `${failed.label.replace(/\.+$/g, '')} failed`;
  const pending = steps.find((step) => step.state === 'pending');
  if (pending) return `${pending.label.replace(/\.+$/g, '')} waiting`;
  return steps.length ? 'Ready' : '';
}

function heroPixelState(steps) {
  if (steps.some((step) => step.state === 'failed')) return 'failed';
  if (steps.some((step) => step.state === 'warning')) return 'warning';
  if (steps.some((step) => step.state === 'running')) return 'running';
  if (steps.some((step) => step.state === 'done')) return 'done';
  return 'pending';
}

function finalizeProgress(progress, options = {}) {
  const steps = Array.isArray(progress.steps)
    ? progress.steps.map((step, index) => normalizeStep(step, index))
    : [];
  if (options.sort !== false) steps.sort(compareStepOrder);
  const activeCount = steps.filter((step) => step.state === 'running').length;
  const rawTitle = safeDisplayText(progress.title, '', 80);
  const fallbackSubtitle = activeCount > 1 ? `${activeCount} model calls running` : '';
  const rawSubtitle = safeDisplayText(progress.subtitle, '', 120);
  return {
    runId: progress.runId || null,
    title: SAFE_PROGRESS_TITLES.has(rawTitle) ? rawTitle : progressTitle(steps),
    subtitle: /^\d{1,2} model calls running$/.test(rawSubtitle) ? rawSubtitle : fallbackSubtitle,
    activeCount,
    heroPixelState: heroPixelState(steps),
    currentStepText: currentStepText(steps),
    steps
  };
}

export function createProgressRunModel(view = {}) {
  const source = asObject(view);
  if (source.progressRun && typeof source.progressRun === 'object') return normalizeExplicitProgress(source.progressRun);
  return deriveProgressRun(source);
}

export function createHeroPixelBlocks(progressRun = {}, options = {}) {
  const source = asObject(progressRun);
  const steps = Array.isArray(source.steps) ? source.steps.map((step, index) => normalizeStep(step, index)) : [];
  const rows = Math.max(1, Math.floor(Number(options.rows ?? 3)) || 3);
  const delayStepMs = Math.max(0, Math.floor(Number(options.delayStepMs ?? 24)) || 0);
  const columnCount = steps.length ? Math.ceil(steps.length / rows) : 0;
  return steps.map((step, index) => ({
    id: step.id,
    label: step.label,
    state: step.state,
    providerLane: step.providerLane,
    row: index % rows,
    column: Math.floor(index / rows),
    columnCount,
    delayMs: index * delayStepMs,
    className: `hero-block ${step.state}`
  }));
}
