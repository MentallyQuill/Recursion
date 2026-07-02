const VALID_STATES = new Set(['pending', 'running', 'done', 'cached', 'warning', 'failed', 'skipped']);
const VALID_PROVIDER_LANES = new Set(['utility', 'reasoner']);
const SAFE_PROGRESS_TITLES = new Set(['Generating', 'Ready', 'Idle', 'Issue', 'Needs attention']);
const DEFAULT_HERO_PIXEL_ROWS = 3;
const DEFAULT_HERO_PIXEL_MAX_COLUMNS = 12;
const HERO_CONTROL_ONLY_STEP_IDS = new Set([
  'installing-recursion-prompt',
  'clearing-recursion-prompt',
  'recursion-prompt-ready'
]);
const VALID_CHILD_SOURCES = new Set(['generated', 'cache', 'fallback', 'provider', 'local']);
const MODEL_CALL_ROLE_IDS = new Set([
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'sceneConstraintsCard',
  'knowledgeSecretsCard',
  'clocksConsequencesCard',
  'environmentAffordancesCard',
  'possessionsItemsCard',
  'openThreadsCard'
]);
const CARD_ROLE_LABELS = Object.freeze({
  sceneFrameCard: 'Scene Frame',
  activeCastCard: 'Active Cast',
  characterMotivationCard: 'Character Motivation',
  dialogueRelationshipCard: 'Relationship',
  sceneConstraintsCard: 'Scene Constraints',
  knowledgeSecretsCard: 'Knowledge',
  clocksConsequencesCard: 'Consequences',
  environmentAffordancesCard: 'Environment',
  possessionsItemsCard: 'Items',
  openThreadsCard: 'Open Threads'
});

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
const UNSAFE_DISPLAY_PATTERN = /\b(raw\s*prompt|prompt\s*text|system\s*prompt|password|api[-_\s]*key|authorization|cookie|credentials?|session[-_\s]*id|session[-_\s]*key|bearer\s+\S+|sk-[a-z0-9_-]+|private[-_\s]*secret)\b\s*(?:[:=]|\]|$)/i;

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

function normalizeChildSource(value) {
  const source = cleanText(value).toLowerCase();
  if (source === 'cached') return 'cache';
  if (source === 'provider') return 'generated';
  if (source === 'local' || source === 'local-fallback') return 'fallback';
  return VALID_CHILD_SOURCES.has(source) ? source : '';
}

function metaForState(state, source = '') {
  const normalizedSource = normalizeChildSource(source);
  if (state === 'done' && normalizedSource === 'generated') return 'generated';
  if (state === 'done') return 'done';
  if (state === 'cached') return 'cached';
  if (state === 'running') return 'running';
  if (state === 'warning' && normalizedSource === 'fallback') return 'fallback';
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

function roleLabel(roleId, fallback = '') {
  const id = cleanText(roleId);
  if (CARD_ROLE_LABELS[id]) return CARD_ROLE_LABELS[id];
  if (id === 'reasonerComposer') return 'Reasoner synthesis';
  if (id === 'utilityArbiter') return 'Utility Arbiter';
  if (id === 'briefUtilityComposer') return 'Utility composer';
  return fallback;
}

function isProviderSettledEvent(event) {
  const phase = cleanText(event.phase);
  if (phase !== 'settled' && phase !== 'providerCallSettled') return false;
  return Boolean(roleStepId(event));
}

function eventStepId(event) {
  const phase = cleanText(event.phase);
  const detail = asObject(event.detail);
  if (phase === 'cardProgress') return cleanText(detail.parentStepId, 'utility-card-batch');
  if (phase.startsWith('providerCall')) return roleStepId(event) || 'utility-card-batch';
  if (isProviderSettledEvent(event)) return roleStepId(event);
  return PHASE_STEP_IDS[phase] || null;
}

function eventState(event, isCurrent) {
  const phase = cleanText(event.phase);
  const severity = cleanText(event.severity, 'info').toLowerCase();
  const outcome = cleanText(event.outcome).toLowerCase();
  const detail = asObject(event.detail);
  if (phase === 'cardProgress' && detail.state) return normalizeState(detail.state);
  if (phase === 'providerCallSettled' || isProviderSettledEvent(event)) {
    if (outcome === 'skipped' || outcome === 'canceled') return 'skipped';
    if (outcome === 'error' || severity === 'error') return 'failed';
    if (outcome === 'warning' || severity === 'warning') return 'warning';
    return 'done';
  }
  if (outcome === 'skipped' || outcome === 'canceled') return 'skipped';
  if (severity === 'error') return 'failed';
  if (severity === 'warning' || phase === 'providerCallRetrying' || phase === 'promptReasonerFallback') return 'warning';
  if (phase === 'cacheReusing') return 'cached';
  if (severity === 'success' || phase === 'storageComplete' || phase === 'promptPacketBuilt' || phase === 'settled') return 'done';
  if (isCurrent) return 'running';
  return 'done';
}

function childStepFromEvent(event, state, order = 0) {
  const phase = cleanText(event.phase);
  const detail = asObject(event.detail);
  if (phase === 'promptReasonerFallback') {
    return normalizeChildStep({
      id: 'utility-fallback',
      label: 'Utility fallback',
      providerLane: 'utility',
      state: 'warning',
      source: 'fallback',
      sourcePhase: phase,
      order
    }, order);
  }
  if (phase === 'cardProgress') {
    const roleId = cleanText(detail.roleId || detail.role);
    return normalizeChildStep({
      id: detail.id,
      label: detail.family || roleLabel(roleId, activityLabelText(event)),
      providerLane: event.providerLane || detail.lane || 'utility',
      state,
      source: detail.source || detail.sourceType,
      sourcePhase: phase,
      sourceRoleId: roleId,
      order
    }, order);
  }
  if (phase.startsWith('providerCall') || isProviderSettledEvent(event)) {
    const roleId = cleanText(detail.roleId || event.roleId);
    if (!roleId) return null;
    return normalizeChildStep({
      label: roleLabel(roleId, activityLabelText(event)),
      providerLane: event.providerLane || detail.lane,
      state,
      source: state === 'done' && MODEL_CALL_ROLE_IDS.has(roleId) ? 'generated' : '',
      sourcePhase: phase,
      sourceRoleId: roleId,
      order
    }, order);
  }
  return null;
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

function compareChildOrder(left, right) {
  return left.order - right.order;
}

function upsertStep(map, step) {
  const existing = map.get(step.id);
  if (!existing) {
    map.set(step.id, step);
    return;
  }
  const next = {
    ...existing,
    ...step,
    children: mergeChildren(existing.children, step.children),
    order: existing.order
  };
  next.state = next.children?.length
    ? aggregateParentState(mergeState(existing.state, step.state), next.children)
    : mergeState(existing.state, step.state);
  next.meta = metaForState(next.state);
  map.set(step.id, next);
}

function mergeState(existingState, nextState) {
  const existing = normalizeState(existingState);
  const next = normalizeState(nextState);
  if (existing === 'failed' || next === 'failed') return 'failed';
  if (existing === 'warning' || next === 'warning') return 'warning';
  if (next === 'pending' && existing !== 'pending') return existing;
  return next;
}

function mergeChildren(existingChildren = [], nextChildren = []) {
  const children = new Map();
  for (const child of Array.isArray(existingChildren) ? existingChildren : []) {
    children.set(child.id, child);
  }
  for (const child of Array.isArray(nextChildren) ? nextChildren : []) {
    const existing = children.get(child.id);
    if (!existing) {
      children.set(child.id, child);
      continue;
    }
    const merged = {
      ...existing,
      ...child,
      order: existing.order,
      source: child.source || existing.source,
      sourceRoleId: child.sourceRoleId || existing.sourceRoleId,
      sourcePhase: child.sourcePhase || existing.sourcePhase,
      state: mergeState(existing.state, child.state)
    };
    merged.meta = metaForState(merged.state, merged.source);
    children.set(child.id, merged);
  }
  return [...children.values()].sort(compareChildOrder);
}

function childAggregateState(children = []) {
  const list = Array.isArray(children) ? children : [];
  if (!list.length) return null;
  if (list.some((child) => child.state === 'failed')) return 'failed';
  if (list.some((child) => child.state === 'warning')) return 'warning';
  if (list.some((child) => child.state === 'running')) return 'running';
  if (list.some((child) => child.state === 'pending')) return 'pending';
  if (list.every((child) => child.state === 'cached')) return 'cached';
  if (list.every((child) => child.state === 'skipped')) return 'skipped';
  return 'done';
}

function aggregateParentState(parentState, children = []) {
  const childState = childAggregateState(children);
  if (!childState) return normalizeState(parentState);
  if (parentState === 'failed' || childState === 'failed') return 'failed';
  if (parentState === 'warning' || childState === 'warning') return 'warning';
  if (childState === 'running') return 'running';
  if (parentState === 'running' && childState === 'pending') return 'running';
  return childState;
}

function childIdFromRole(roleId, fallback) {
  const role = cleanText(roleId);
  if (role === 'sceneFrameCard') return 'scene-frame-card';
  if (role === 'activeCastCard') return 'active-cast-card';
  if (role === 'characterMotivationCard') return 'character-motivation-card';
  if (role === 'dialogueRelationshipCard') return 'dialogue-relationship-card';
  if (role === 'sceneConstraintsCard') return 'scene-constraints-card';
  if (role === 'knowledgeSecretsCard') return 'knowledge-secrets-card';
  if (role === 'clocksConsequencesCard') return 'clocks-consequences-card';
  if (role === 'environmentAffordancesCard') return 'environment-affordances-card';
  if (role === 'possessionsItemsCard') return 'possessions-items-card';
  if (role === 'openThreadsCard') return 'open-threads-card';
  if (role === 'reasonerComposer') return 'reasoner-synthesis';
  if (role === 'briefUtilityComposer') return 'utility-composer';
  return idFromText(role, fallback);
}

function normalizeChildStep(input, index = 0) {
  const source = asObject(input);
  const roleId = safeDisplayText(source.sourceRoleId || source.roleId || source.role, '', 80);
  const label = roleLabel(roleId, safeDisplayText(source.label, `Item ${index + 1}`, 80));
  const rawId = source.id || roleId || label;
  const id = roleId && !source.id
    ? childIdFromRole(roleId, `child-${index + 1}`)
    : idFromText(rawId, `child-${index + 1}`);
  const state = normalizeState(source.state);
  const childSource = normalizeChildSource(source.source || source.sourceType || (state === 'cached' ? 'cache' : ''));
  return {
    id,
    label,
    providerLane: normalizeProviderLane(source.providerLane, roleId === 'reasonerComposer' ? 'reasoner' : 'utility'),
    state,
    meta: metaForState(state, childSource),
    source: childSource || null,
    sourcePhase: cleanText(source.sourcePhase || source.phase) || null,
    sourceRoleId: roleId || null,
    order: Number.isFinite(Number(source.order)) ? Number(source.order) : index
  };
}

function normalizeStep(input, index = 0) {
  const source = asObject(input);
  const rawId = source.id || source.label;
  const id = UNSAFE_DISPLAY_PATTERN.test(String(rawId ?? ''))
    ? `step-${index + 1}`
    : idFromText(rawId, `step-${index + 1}`);
  const definition = STEP_DEFINITIONS[id] || {};
  const children = Array.isArray(source.children)
    ? source.children.map((child, childIndex) => normalizeChildStep(child, childIndex)).sort(compareChildOrder)
    : [];
  const state = children.length
    ? aggregateParentState(normalizeState(source.state), children)
    : normalizeState(source.state);
  const step = {
    id,
    label: definition.label || safeDisplayText(source.label, `Step ${index + 1}`, 80),
    providerLane: normalizeProviderLane(source.providerLane, definition.providerLane || 'utility'),
    state,
    meta: metaForState(state),
    sourcePhase: cleanText(source.sourcePhase || source.phase) || null,
    sourceRoleId: safeDisplayText(source.sourceRoleId || source.roleId, '', 80) || null,
    order: Number.isFinite(Number(source.order)) ? Number(source.order) : index
  };
  if (children.length) step.children = children;
  return step;
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
  const lastStatus = cleanText(source.lastPacket?.diagnostics?.reasonerStatus).toLowerCase();
  const composerLane = cleanText(source.lastPacket?.diagnostics?.composerLane).toLowerCase();
  return decision === 'use' || lastStatus === 'used' || composerLane === 'reasoner';
}

function planWantsCards(view, currentActivity) {
  const source = asObject(view);
  const jobs = source.lastPlan?.cardJobs;
  if (Array.isArray(jobs) && jobs.length > 0) return true;
  const requested = Number(currentActivity?.cardCounts?.requested || currentActivity?.cardCounts?.total || 0);
  return Number.isFinite(requested) && requested > 0;
}

function hasTerminalPromptOutcome(map) {
  for (const id of ['recursion-prompt-ready', 'installing-recursion-prompt', 'clearing-recursion-prompt']) {
    const state = map.get(id)?.state;
    if (FINAL_STATES.has(state)) return true;
  }
  return false;
}

function appendPendingPlanSteps(map, view, orderStart = 0) {
  const source = asObject(view);
  const activity = asObject(source.activity);
  const enabled = source.settings?.enabled !== false;
  if (hasTerminalPromptOutcome(map)) return;
  let order = orderStart;
  if (planWantsCards(source, activity) || map.has('utility-card-batch')) {
    for (const id of ['selecting-turn-hand', 'saving-scene-cache', 'composing-prompt-packet']) {
      if (!map.has(id)) upsertStep(map, pendingStep(id, order++));
    }
  }
  if (planWantsReasoner(source) && !map.has('reasoner-brief')) {
    upsertStep(map, pendingStep('reasoner-brief', order++));
  }
  const promptStepId = enabled ? 'installing-recursion-prompt' : 'clearing-recursion-prompt';
  if (!map.has(promptStepId)) upsertStep(map, pendingStep(promptStepId, order++));
}

function appendPendingChildSteps(map, view, orderStart = 0) {
  const source = asObject(view);
  const jobs = Array.isArray(source.lastPlan?.cardJobs) ? source.lastPlan.cardJobs : [];
  if (hasTerminalPromptOutcome(map)) return;
  if (jobs.length && map.has('utility-card-batch')) {
    let order = orderStart;
    for (const job of jobs) {
      const roleId = cleanText(job?.role || job?.roleId);
      const family = cleanText(job?.family);
      upsertStep(map, normalizeStep({
        id: 'utility-card-batch',
        label: STEP_DEFINITIONS['utility-card-batch'].label,
        providerLane: 'utility',
        state: map.get('utility-card-batch')?.state || 'pending',
        order: map.get('utility-card-batch')?.order ?? order,
        children: [
          {
            label: family || roleLabel(roleId, 'Card'),
            providerLane: 'utility',
            state: 'pending',
            sourceRoleId: roleId,
            order: order++
          }
        ]
      }, map.get('utility-card-batch')?.order ?? order));
    }
  }
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

function hasMaterialProgressState(step) {
  const source = asObject(step);
  const state = normalizeState(source.state);
  if (state !== 'pending') return true;
  return Array.isArray(source.children) && source.children.some(hasMaterialProgressState);
}

function shouldDiscardIdlePendingProgress(view, progress) {
  const activity = asObject(asObject(view).activity);
  const phase = cleanText(activity.phase).toLowerCase();
  const title = cleanText(progress.title).toLowerCase();
  if (phase !== 'idle' && title !== 'ready' && title !== 'idle') return false;
  return Array.isArray(progress.steps)
    && progress.steps.length > 0
    && !progress.steps.some(hasMaterialProgressState);
}

function shouldDiscardSuccessfulControlOnlyProgress(progress) {
  const source = asObject(progress);
  const runId = cleanText(source.runId).toLowerCase();
  const steps = Array.isArray(source.steps) ? source.steps : [];
  if (!runId.startsWith('settings-') || steps.length === 0) return false;
  if (!steps.every((step) => HERO_CONTROL_ONLY_STEP_IDS.has(step.id))) return false;
  return !steps.some((step) => ['warning', 'failed'].includes(normalizeState(step.state)));
}

function isControlOnlySettingsProgress(runId, steps = []) {
  const id = cleanText(runId).toLowerCase();
  const list = Array.isArray(steps) ? steps : [];
  return id.startsWith('settings-')
    && list.length > 0
    && list.every((step) => HERO_CONTROL_ONLY_STEP_IDS.has(step.id));
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
    const eventOrder = order++;
    const state = eventState(event, eventKey === currentKey || providerConcurrent);
    const child = childStepFromEvent(event, state, eventOrder);
    upsertStep(steps, normalizeStep({
      id,
      label: definition.label || activityLabelText(event),
      providerLane: event.providerLane || event.composerLane || definition.providerLane,
      state,
      sourcePhase: event.phase,
      sourceRoleId: asObject(event.detail).roleId,
      children: child ? [child] : [],
      order: eventOrder
    }, eventOrder));
  }
  const beforePlanSteps = [...steps.values()];
  if (!isControlOnlySettingsProgress(runId, beforePlanSteps)) {
    appendPendingPlanSteps(steps, view, order);
    appendPendingChildSteps(steps, view, order);
  }
  const derived = finalizeProgress({
    runId,
    title: progressTitle([...steps.values()]),
    subtitle: '',
    steps: [...steps.values()].sort(compareStepOrder)
  });
  if (shouldDiscardIdlePendingProgress(view, derived)) {
    return finalizeProgress({
      runId: derived.runId,
      title: 'Ready',
      subtitle: '',
      steps: []
    }, { sort: false });
  }
  if (shouldDiscardSuccessfulControlOnlyProgress(derived)) {
    return finalizeProgress({
      runId: derived.runId,
      title: 'Ready',
      subtitle: '',
      steps: []
    }, { sort: false });
  }
  return derived;
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
  return '';
}

function heroPixelState(steps) {
  if (steps.some((step) => step.state === 'failed')) return 'failed';
  if (steps.some((step) => step.state === 'warning')) return 'warning';
  if (steps.some((step) => step.state === 'running')) return 'running';
  if (steps.some((step) => step.state === 'skipped')) return 'skipped';
  if (steps.some((step) => step.state === 'cached')) return 'cached';
  if (steps.some((step) => step.state === 'done')) return 'done';
  return 'pending';
}

function overflowPixelState(steps) {
  if (steps.some((step) => step.state === 'running')) return 'running';
  if (steps.some((step) => step.state === 'failed')) return 'failed';
  if (steps.some((step) => step.state === 'warning')) return 'warning';
  if (steps.some((step) => step.state === 'skipped')) return 'skipped';
  if (steps.some((step) => step.state === 'pending')) return 'pending';
  if (steps.some((step) => step.state === 'cached')) return 'cached';
  if (steps.some((step) => step.state === 'done')) return 'done';
  return steps[0]?.state || 'pending';
}

function overflowProviderLane(steps) {
  return steps.some((step) => step.providerLane === 'reasoner') ? 'reasoner' : 'utility';
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
  if (source.progressRun && typeof source.progressRun === 'object') {
    const explicit = normalizeExplicitProgress(source.progressRun);
    if (shouldDiscardIdlePendingProgress(source, explicit)) {
      return finalizeProgress({
        runId: explicit.runId,
        title: 'Ready',
        subtitle: '',
        steps: []
      }, { sort: false });
    }
    if (shouldDiscardSuccessfulControlOnlyProgress(explicit)) {
      return finalizeProgress({
        runId: explicit.runId,
        title: 'Ready',
        subtitle: '',
        steps: []
      }, { sort: false });
    }
    return explicit;
  }
  return deriveProgressRun(source);
}

export function createHeroPixelBlocks(progressRun = {}, options = {}) {
  const source = asObject(progressRun);
  const steps = Array.isArray(source.steps) ? source.steps.map((step, index) => normalizeStep(step, index)) : [];
  if (steps.length > 0 && steps.every((step) => HERO_CONTROL_ONLY_STEP_IDS.has(step.id))) return [];
  const rows = Math.max(1, Math.floor(Number(options.rows ?? DEFAULT_HERO_PIXEL_ROWS)) || DEFAULT_HERO_PIXEL_ROWS);
  const maxColumns = Math.max(1, Math.floor(Number(options.maxColumns ?? DEFAULT_HERO_PIXEL_MAX_COLUMNS)) || DEFAULT_HERO_PIXEL_MAX_COLUMNS);
  const maxBlocks = rows * maxColumns;
  const delayStepMs = Math.max(0, Math.floor(Number(options.delayStepMs ?? 24)) || 0);
  const visibleSteps = steps.length > maxBlocks
    ? [
        ...steps.slice(0, maxBlocks - 1),
        {
          id: 'overflow-progress',
          label: `${steps.length - maxBlocks + 1} more progress items`,
          state: overflowPixelState(steps.slice(maxBlocks - 1)),
          providerLane: overflowProviderLane(steps.slice(maxBlocks - 1)),
          hiddenStepCount: steps.length - maxBlocks + 1
        }
      ]
    : steps;
  const columnCount = visibleSteps.length ? Math.ceil(visibleSteps.length / rows) : 0;
  return visibleSteps.map((step, index) => ({
    id: step.id,
    label: step.label,
    state: step.state,
    providerLane: step.providerLane,
    hiddenStepCount: step.hiddenStepCount || 0,
    row: index % rows,
    column: Math.floor(index / rows),
    columnCount,
    delayMs: index * delayStepMs,
    className: `hero-block ${step.state}`
  }));
}
