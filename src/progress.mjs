import { activeCardDeckSourceCards } from './card-decks.mjs';

const VALID_STATES = new Set(['pending', 'running', 'done', 'cached', 'warning', 'failed', 'skipped', 'info']);
const VALID_PROVIDER_LANES = new Set(['utility', 'reasoner']);
const SAFE_PROGRESS_TITLES = new Set(['Generating', 'Ready', 'Idle', 'Issue', 'Needs attention']);
const DEFAULT_HERO_PIXEL_ROWS = 3;
const DEFAULT_HERO_PIXEL_MAX_COLUMNS = 12;
const HERO_CONTROL_ONLY_STEP_IDS = new Set([
  'installing-recursion-prompt',
  'clearing-recursion-prompt',
  'recursion-prompt-ready',
  'provider-test'
]);
const VALID_CHILD_SOURCES = new Set(['generated', 'included', 'cache', 'fallback', 'provider', 'local', 'fused-repair']);
const MODEL_CALL_ROLE_IDS = new Set([
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'socialSubtextCard',
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
  socialSubtextCard: 'Social Subtext',
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
  'checking-scene-cache',
  'rapid-warming-scene-deck',
  'rapid-warm-waiting',
  'rapid-selecting-turn-delta',
  'rapid-warm-miss-standard',
  'rapid-deck-ready',
  'rapid-deck-stale',
  'rapid-warm-failed',
  'reusing-scene-deck',
  'provider-test',
  'generation-review',
  'editorial-diagnosis',
  'editorial-candidate',
  'editorial-verification',
  'fused-card-bundle',
  'utility-card-batch',
  'validating-cards',
  'repairing-card-json',
  'updating-scene-deck',
  'selecting-turn-hand',
  'saving-scene-cache',
  'composing-prompt-packet',
  'reasoner-guidance',
  'installing-recursion-prompt',
  'clearing-recursion-prompt',
  'recursion-prompt-ready'
];

const STEP_DEFINITIONS = Object.freeze({
  'read-turn': { label: 'Reading current turn', providerLane: 'utility' },
  'checking-scene-shift': { label: 'Checking scene shift', providerLane: 'utility' },
  'planning-card-pass': { label: 'Planning card pass', providerLane: 'utility' },
  'checking-scene-cache': { label: 'Checking scene cache', providerLane: 'utility' },
  'rapid-warming-scene-deck': { label: 'Rapid warming scene deck', providerLane: 'utility' },
  'rapid-warm-waiting': { label: 'Waiting for Rapid deck', providerLane: 'utility' },
  'rapid-selecting-turn-delta': { label: 'Rapid selecting turn delta', providerLane: 'utility' },
  'rapid-warm-miss-standard': { label: 'Rapid warm miss; Standard', providerLane: 'utility' },
  'rapid-deck-ready': { label: 'Rapid deck ready', providerLane: 'utility' },
  'rapid-deck-stale': { label: 'Rapid deck stale', providerLane: 'utility' },
  'rapid-warm-failed': { label: 'Rapid warm', providerLane: 'utility' },
  'reusing-scene-deck': { label: 'Reusing scene deck', providerLane: 'utility' },
  'provider-test': { label: 'Provider test', providerLane: 'utility' },
  'generation-review': { label: 'Generation review', currentLabel: 'Reviewing generated response', providerLane: 'utility' },
  'editorial-diagnosis': { label: 'Editorial diagnosis', currentLabel: 'Diagnosing response', providerLane: 'utility' },
  'editorial-candidate': { label: 'Editorial candidate', currentLabel: 'Transforming response', providerLane: 'utility' },
  'editorial-verification': { label: 'Editorial verification', currentLabel: 'Verifying candidate', providerLane: 'reasoner' },
  'fused-card-bundle': { label: 'Fused card bundle', providerLane: 'utility' },
  'utility-card-batch': { label: 'Utility card batch', providerLane: 'utility' },
  'validating-cards': { label: 'Validating cards', providerLane: 'utility' },
  'repairing-card-json': { label: 'Repairing card JSON', providerLane: 'utility' },
  'updating-scene-deck': { label: 'Updating scene deck', providerLane: 'utility' },
  'selecting-turn-hand': { label: 'Selecting turn hand', providerLane: 'utility' },
  'saving-scene-cache': { label: 'Saving scene cache', providerLane: 'utility' },
  'composing-prompt-packet': { label: 'Composing prompt packet', providerLane: 'utility' },
  'reasoner-guidance': { label: 'Reasoner guidance', providerLane: 'reasoner' },
  'installing-recursion-prompt': { label: 'Installing Recursion prompt', providerLane: 'utility' },
  'clearing-recursion-prompt': { label: 'Clearing Recursion prompt', providerLane: 'utility' },
  'recursion-prompt-ready': { label: 'Recursion prompt ready', providerLane: 'utility' }
});

const PHASE_STEP_IDS = Object.freeze({
  started: 'read-turn',
  sceneChecking: 'checking-scene-shift',
  arbiterPlanning: 'planning-card-pass',
  cacheReusing: 'reusing-scene-deck',
  rapidWarming: 'rapid-warming-scene-deck',
  rapidWarmWaiting: 'rapid-warm-waiting',
  rapidDeltaRunning: 'rapid-selecting-turn-delta',
  rapidWarmMissStandard: 'rapid-warm-miss-standard',
  rapidWarmReady: 'rapid-deck-ready',
  rapidWarmStale: 'rapid-deck-stale',
  rapidWarmFailed: 'rapid-warm-failed',
  cardBatchRunning: 'utility-card-batch',
  fusedCardBundleRunning: 'fused-card-bundle',
  cardValidating: 'validating-cards',
  deckUpdating: 'updating-scene-deck',
  handSelected: 'selecting-turn-hand',
  storageSaving: 'saving-scene-cache',
  storageComplete: 'saving-scene-cache',
  storageProgress: 'saving-scene-cache',
  storageWarning: 'saving-scene-cache',
  utilityComposing: 'composing-prompt-packet',
  promptPacketBuilt: 'composing-prompt-packet',
  reasonerComposing: 'reasoner-guidance',
  promptReasonerFallback: 'reasoner-guidance',
  promptInstalling: 'installing-recursion-prompt',
  promptClearing: 'clearing-recursion-prompt',
  promptClearFailed: 'clearing-recursion-prompt',
  providerTestFailed: 'provider-test',
  generationReviewing: 'generation-review',
  editorialDiagnosing: 'editorial-diagnosis',
  editorialTransforming: 'editorial-candidate',
  editorialVerifying: 'editorial-verification',
  cacheWarning: 'checking-scene-cache',
  settled: 'recursion-prompt-ready'
});

const FINAL_STATES = new Set(['done', 'warning', 'failed', 'skipped', 'info']);
const UNSAFE_DISPLAY_PATTERN = /\b(raw\s*prompt|prompt\s*text|system\s*prompt|password|api[-_\s]*key|authorization|cookie|credentials?|session[-_\s]*id|session[-_\s]*key|bearer\s+\S+|sk-[a-z0-9_-]+|private[-_\s]*secret)\b\s*(?:[:=]|\]|$)/i;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function normalizePipelineMode(value) {
  const mode = cleanText(value, 'standard').toLowerCase();
  if (mode === 'rapid') return 'rapid';
  if (mode === 'fused') return 'fused';
  return 'standard';
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

function normalizeRetryCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(99, Math.floor(count));
}

function retryCountFromSource(source) {
  const input = asObject(source);
  return normalizeRetryCount(input.retryCount ?? input.providerRetryCount ?? input.diagnostics?.retryCount);
}

function normalizeStateWithRetry(value, retryCount = 0) {
  const state = normalizeState(value);
  if (state === 'done' && normalizeRetryCount(retryCount) > 0) return 'warning';
  return state;
}

function reasonMentionsRetry(reason) {
  return /\bretr(?:y|ied|ies|ying)\b/i.test(String(reason || ''));
}

function retryReason(retryCount, subject = 'Provider call') {
  const count = normalizeRetryCount(retryCount);
  if (!count) return '';
  const countText = count === 1 ? 'once' : `${count} times`;
  return `${subject} retried ${countText} before completing.`;
}

function safeReasonText(value) {
  return safeDisplayText(value, '', 180);
}

function reasonFromSource(source, state, retryCount = 0, childSource = '') {
  const input = asObject(source);
  const explicit = safeReasonText(
    input.reason
    || input.statusReason
    || input.cautionReason
    || input.failureReason
    || input.fallbackReason
    || input.error?.message
  );
  if (explicit) return explicit;
  if (state === 'warning' && normalizeRetryCount(retryCount) > 0) return retryReason(retryCount);
  if (state === 'warning' && normalizeChildSource(childSource) === 'fallback') return 'Local fallback was used.';
  return '';
}

function maxRetryCount(children = []) {
  return (Array.isArray(children) ? children : [])
    .reduce((max, child) => Math.max(max, normalizeRetryCount(child?.retryCount)), 0);
}

function aggregateReason(children = []) {
  const list = Array.isArray(children) ? children : [];
  const material = list.find((child) => ['failed', 'warning'].includes(child?.state) && safeReasonText(child?.reason));
  return safeReasonText(material?.reason);
}

function metaForState(state, source = '', reason = '', retryCount = 0) {
  const normalizedSource = normalizeChildSource(source);
  if (state === 'done' && normalizedSource === 'included') return 'included';
  if (state === 'done' && normalizedSource === 'generated') return 'generated';
  if (state === 'done') return 'done';
  if (state === 'cached') return 'cached';
  if (state === 'info') return 'included';
  if (state === 'running') return 'running';
  if (state === 'warning' && (normalizeRetryCount(retryCount) > 0 || reasonMentionsRetry(reason))) return 'retried';
  if (state === 'warning' && normalizedSource === 'fallback') return 'fallback';
  if (state === 'warning') return 'caution';
  if (state === 'failed') return 'failed';
  if (state === 'skipped') return 'skipped';
  return 'waiting';
}

function eventRetryCount(event) {
  const phase = cleanText(event.phase);
  const detail = asObject(event.detail);
  if (phase === 'providerCallRetrying') {
    return normalizeRetryCount(detail.retryCount ?? detail.attempt ?? 1);
  }
  return normalizeRetryCount(detail.retryCount ?? event.retryCount ?? detail.diagnostics?.retryCount);
}

function eventReason(event, state) {
  const phase = cleanText(event.phase);
  const detail = asObject(event.detail);
  const retryCount = eventRetryCount(event);
  const explicit = safeReasonText(
    detail.reason
    || detail.statusReason
    || detail.cautionReason
    || detail.failureReason
    || detail.error?.message
    || event.fallbackReason
  );
  if (explicit) return explicit;
  if (phase === 'providerCallRetrying') return retryReason(retryCount);
  if (state === 'warning' && retryCount > 0) return retryReason(retryCount);
  return '';
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
  if (roleId === 'providerTest') return 'provider-test';
  if (roleId === 'utilityArbiter') return 'planning-card-pass';
  if (roleId === 'reasonerComposer') return 'reasoner-guidance';
  if (roleId === 'guidanceComposer') return 'composing-prompt-packet';
  if (roleId === 'generationReviewer') return 'generation-review';
  if (roleId === 'editorialDiagnostician') return 'editorial-diagnosis';
  if (roleId === 'editorialTransformer') return 'editorial-candidate';
  if (roleId === 'editorialVerifier') return 'editorial-verification';
  if (roleId === 'fusedCardBundle') return 'fused-card-bundle';
  if (MODEL_CALL_ROLE_IDS.has(roleId)) return 'utility-card-batch';
  return null;
}

function roleLabel(roleId, fallback = '') {
  const id = cleanText(roleId);
  if (CARD_ROLE_LABELS[id]) return CARD_ROLE_LABELS[id];
  if (id === 'reasonerComposer') return 'Reasoner synthesis';
  if (id === 'utilityArbiter') return 'Utility Arbiter';
  if (id === 'guidanceComposer') return 'Guidance composer';
  if (id === 'generationReviewer') return 'Generation review';
  if (id === 'editorialDiagnostician') return 'Editorial diagnosis';
  if (id === 'editorialTransformer') return 'Editorial candidate';
  if (id === 'editorialVerifier') return 'Editorial verification';
  if (id === 'fusedCardBundle') return 'Fused card bundle';
  if (id === 'providerTest') return 'Provider test';
  return fallback;
}

function providerTestStepLabel(event) {
  const detail = asObject(event.detail);
  const lane = normalizeProviderLane(event.providerLane || detail.lane, 'utility');
  return `${lane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test`;
}

function stepLabelForEvent(id, event, definition = {}) {
  if (id === 'provider-test') return providerTestStepLabel(event);
  return definition.label || activityLabelText(event);
}

function isProviderTestEvent(event) {
  const phase = cleanText(event.phase);
  const detail = asObject(event.detail);
  const roleId = cleanText(detail.roleId || event.roleId);
  const runId = cleanText(event.runId).toLowerCase();
  return roleId === 'providerTest'
    || phase.startsWith('providerTest')
    || runId === 'provider-test'
    || runId.startsWith('provider-test-');
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
  if (isProviderTestEvent(event)) return 'provider-test';
  if (phase.startsWith('providerCall')) return roleStepId(event) || 'utility-card-batch';
  if (isProviderSettledEvent(event)) return roleStepId(event);
  return PHASE_STEP_IDS[phase] || null;
}

function eventState(event, isCurrent) {
  const phase = cleanText(event.phase);
  const severity = cleanText(event.severity, 'info').toLowerCase();
  const outcome = cleanText(event.outcome).toLowerCase();
  const detail = asObject(event.detail);
  const retryCount = eventRetryCount(event);
  if (phase === 'cardProgress' && detail.state) return normalizeStateWithRetry(detail.state, retryCount);
  if (phase === 'cacheWarning') return severity === 'error' ? 'failed' : 'done';
  if (phase === 'providerCallSettled' || isProviderSettledEvent(event)) {
    if (outcome === 'skipped' || outcome === 'canceled') return 'skipped';
    if (outcome === 'error' || severity === 'error') return 'failed';
    if (outcome === 'warning' || severity === 'warning') return 'warning';
    if (retryCount > 0) return 'warning';
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
  const retryCount = eventRetryCount(event);
  const reason = eventReason(event, state);
  if (phase === 'promptReasonerFallback') {
    return normalizeChildStep({
      id: 'utility-fallback',
      label: 'Utility fallback',
      providerLane: 'utility',
      state: 'warning',
      source: 'fallback',
      reason: reason || 'Reasoner fallback used Utility composition.',
      sourcePhase: phase,
      order
    }, order);
  }
  if (phase === 'cardProgress') {
    const roleId = cleanText(detail.roleId || detail.role);
    const sourceCardsAreIncluded = cleanText(detail.parentStepId) === 'fused-card-bundle'
      && normalizeChildSource(detail.source || detail.sourceType) === 'generated';
    return normalizeChildStep({
      id: childIdFromRole(roleId, detail.family || detail.id || activityLabelText(event)),
      label: detail.family || roleLabel(roleId, activityLabelText(event)),
      providerLane: event.providerLane || detail.lane || 'utility',
      state,
      source: detail.source || detail.sourceType,
      retryCount,
      reason,
      children: Array.isArray(detail.sourceCards)
        ? detail.sourceCards.map((sourceCard, childIndex) => ({
            id: sourceCard.id,
            label: sourceCard.label,
            providerLane: event.providerLane || detail.lane || 'utility',
            state: sourceCard.state === 'info' ? state : (sourceCard.state || state),
            // Fused calls generate categories. Their source-card children are inputs,
            // so the UI must describe them as included rather than generated.
            source: sourceCardsAreIncluded ? 'included' : (detail.source || detail.sourceType),
            reason: sourceCard.reason || (sourceCard.selectionState === 'priority' ? 'Priority source card included.' : ''),
            order: childIndex
          }))
        : [],
      sourcePhase: phase,
      sourceRoleId: roleId,
      order
    }, order);
  }
  if (phase === 'generationReviewing' && Array.isArray(detail.cardOutcomes)) {
    const stateForOutcome = (status) => {
      if (status === 'violated' || status === 'requires-regeneration' || status === 'unresolved') return 'failed';
      if (status === 'partially-reflected') return 'warning';
      if (status === 'not-applicable') return 'info';
      return 'done';
    };
    return normalizeChildStep({
      id: 'generation-review-cards',
      label: 'Installed cards',
      providerLane: event.providerLane || detail.lane || 'utility',
      state,
      source: 'generated',
      children: detail.cardOutcomes.map((outcome, childIndex) => ({
        id: outcome.cardId,
        label: outcome.name || outcome.cardId,
        providerLane: event.providerLane || detail.lane || 'utility',
        state: stateForOutcome(cleanText(outcome.status)),
        reason: outcome.reason || '',
        order: childIndex
      })),
      sourcePhase: phase,
      order
    }, order);
  }
  if (isProviderTestEvent(event)) return null;
  if (phase.startsWith('providerCall') || isProviderSettledEvent(event)) {
    const roleId = cleanText(detail.roleId || event.roleId);
    if (!roleId) return null;
    if (roleId === 'fusedCardBundle') return null;
    return normalizeChildStep({
      label: roleLabel(roleId, activityLabelText(event)),
      providerLane: event.providerLane || detail.lane,
      state,
      source: (state === 'done' || (state === 'warning' && retryCount > 0)) && MODEL_CALL_ROLE_IDS.has(roleId) ? 'generated' : '',
      retryCount,
      reason,
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
    providerLane: existing.providerLane === 'reasoner' ? 'reasoner' : step.providerLane,
    children: mergeChildren(existing.children, step.children),
    order: existing.order
  };
  next.retryCount = Math.max(
    normalizeRetryCount(existing.retryCount),
    normalizeRetryCount(step.retryCount),
    maxRetryCount(next.children)
  );
  next.state = next.children?.length
    ? aggregateParentState(mergeState(existing.state, step.state), next.children)
    : normalizeStateWithRetry(mergeState(existing.state, step.state), next.retryCount);
  next.reason = safeReasonText(step.reason) || safeReasonText(existing.reason) || aggregateReason(next.children) || reasonFromSource(next, next.state, next.retryCount);
  next.meta = metaForState(next.state, next.source, next.reason, next.retryCount);
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
      retryCount: Math.max(normalizeRetryCount(existing.retryCount), normalizeRetryCount(child.retryCount)),
      reason: safeReasonText(child.reason) || safeReasonText(existing.reason),
      state: mergeState(existing.state, child.state)
    };
    merged.state = normalizeStateWithRetry(merged.state, merged.retryCount);
    merged.meta = metaForState(merged.state, merged.source, merged.reason, merged.retryCount);
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
  if (role === 'socialSubtextCard') return 'social-subtext-card';
  if (role === 'sceneConstraintsCard') return 'scene-constraints-card';
  if (role === 'knowledgeSecretsCard') return 'knowledge-secrets-card';
  if (role === 'clocksConsequencesCard') return 'clocks-consequences-card';
  if (role === 'environmentAffordancesCard') return 'environment-affordances-card';
  if (role === 'possessionsItemsCard') return 'possessions-items-card';
  if (role === 'openThreadsCard') return 'open-threads-card';
  if (role === 'reasonerComposer') return 'reasoner-synthesis';
  if (role === 'guidanceComposer') return 'guidance-composer';
  return idFromText(role, fallback);
}

function normalizeChildStep(input, index = 0) {
  const source = asObject(input);
  const children = Array.isArray(source.children)
    ? source.children.map((child, childIndex) => normalizeChildStep(child, childIndex)).sort(compareChildOrder)
    : [];
  const roleId = safeDisplayText(source.sourceRoleId || source.roleId || source.role, '', 80);
  const label = roleLabel(roleId, safeDisplayText(source.label, `Item ${index + 1}`, 80));
  const rawId = source.id || roleId || label;
  const id = roleId && !source.id
    ? childIdFromRole(roleId, `child-${index + 1}`)
    : idFromText(rawId, `child-${index + 1}`);
  const retryCount = retryCountFromSource(source);
  const state = normalizeStateWithRetry(source.state, retryCount);
  const childSource = normalizeChildSource(source.source || source.sourceType || (state === 'cached' ? 'cache' : ''));
  const reason = reasonFromSource(source, state, retryCount, childSource);
  const step = {
    id,
    label,
    providerLane: normalizeProviderLane(source.providerLane, roleId === 'reasonerComposer' ? 'reasoner' : 'utility'),
    state,
    meta: metaForState(state, childSource, reason, retryCount),
    source: childSource || null,
    sourcePhase: cleanText(source.sourcePhase || source.phase) || null,
    sourceRoleId: roleId || null,
    retryCount,
    reason: reason || null,
    order: Number.isFinite(Number(source.order)) ? Number(source.order) : index
  };
  if (children.length) step.children = children;
  return step;
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
  const retryCount = Math.max(retryCountFromSource(source), maxRetryCount(children));
  const state = children.length
    ? aggregateParentState(normalizeStateWithRetry(source.state, retryCount), children)
    : normalizeStateWithRetry(source.state, retryCount);
  const reason = reasonFromSource(source, state, retryCount) || aggregateReason(children);
  const fallbackLabel = id === 'provider-test' ? 'Provider test' : `Step ${index + 1}`;
  const definitionLabel = id === 'provider-test' ? '' : definition.label;
  const step = {
    id,
    label: definitionLabel || safeDisplayText(source.label, fallbackLabel, 80),
    currentLabel: safeDisplayText(source.currentLabel || definition.currentLabel, '', 80) || null,
    providerLane: normalizeProviderLane(source.providerLane, definition.providerLane || 'utility'),
    state,
    meta: metaForState(state, source.source || source.sourceType, reason, retryCount),
    sourcePhase: cleanText(source.sourcePhase || source.phase) || null,
    sourceRoleId: safeDisplayText(source.sourceRoleId || source.roleId, '', 80) || null,
    retryCount,
    reason: reason || null,
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
  if (planWantsCards(source, activity) || map.has('utility-card-batch') || map.has('fused-card-bundle')) {
    for (const id of ['selecting-turn-hand', 'saving-scene-cache', 'composing-prompt-packet']) {
      if (!map.has(id)) upsertStep(map, pendingStep(id, order++));
    }
  }
  if (planWantsReasoner(source) && !map.has('reasoner-guidance')) {
    upsertStep(map, pendingStep('reasoner-guidance', order++));
  }
  const promptStepId = enabled ? 'installing-recursion-prompt' : 'clearing-recursion-prompt';
  if (!map.has(promptStepId)) upsertStep(map, pendingStep(promptStepId, order++));
}

function appendPendingChildSteps(map, view, orderStart = 0) {
  const source = asObject(view);
  const jobs = Array.isArray(source.lastPlan?.cardJobs) ? source.lastPlan.cardJobs : [];
  const sourceCardsByFamily = activeCardDeckSourceCards(source.settings || {});
  if (hasTerminalPromptOutcome(map)) return;
  const parentStepId = map.has('fused-card-bundle') ? 'fused-card-bundle' : 'utility-card-batch';
  if (parentStepId === 'fused-card-bundle') return;
  if (jobs.length && map.has(parentStepId)) {
    const parent = map.get(parentStepId);
    const mergedJobs = new Map();
    for (const job of jobs) {
      const roleId = cleanText(job?.role || job?.roleId);
      const family = cleanText(job?.family) || roleLabel(roleId, 'Card');
      mergedJobs.set(`${roleId}|${family}`, { roleId, family });
    }
    for (const child of Array.isArray(parent.children) ? parent.children : []) {
      const roleId = cleanText(child?.sourceRoleId);
      const family = cleanText(child?.label);
      if (!roleId && !family) continue;
      mergedJobs.set(`${roleId}|${family}`, { roleId, family });
    }
    let order = orderStart;
    for (const job of mergedJobs.values()) {
      const roleId = job.roleId;
      const family = job.family;
      const sourceCards = Array.isArray(sourceCardsByFamily[family])
        ? sourceCardsByFamily[family]
        : [];
      upsertStep(map, normalizeStep({
        id: parentStepId,
        label: STEP_DEFINITIONS[parentStepId].label,
        providerLane: map.get(parentStepId)?.providerLane || STEP_DEFINITIONS[parentStepId].providerLane,
        state: map.get(parentStepId)?.state || 'pending',
        order: map.get(parentStepId)?.order ?? order,
        children: [
          {
            label: family || roleLabel(roleId, 'Card'),
            providerLane: map.get(parentStepId)?.providerLane || 'utility',
            state: 'pending',
            sourceRoleId: roleId,
            children: sourceCards.map((card, index) => ({
              id: card.id,
              label: card.name || card.id,
              providerLane: map.get(parentStepId)?.providerLane || 'utility',
              state: 'pending',
              reason: card.selectionState === 'priority' ? 'Priority source card included.' : '',
              order: index
            })),
            order: order++
          }
        ]
      }, map.get(parentStepId)?.order ?? order));
    }
  }
}

function rapidWarmStatusStep(rapidWarm, order = 0) {
  const source = asObject(rapidWarm);
  const status = cleanText(source.status, 'idle').toLowerCase();
  const reason = safeReasonText(source.reasonLabel || source.failureReasonLabel || source.reason);
  const phase = cleanText(source.phase);
  if (status === 'warming') {
    return normalizeStep({
      id: 'rapid-warming-scene-deck',
      label: STEP_DEFINITIONS['rapid-warming-scene-deck'].label,
      providerLane: 'utility',
      state: 'running',
      reason,
      sourcePhase: phase || 'rapidWarming',
      order
    }, order);
  }
  if (status === 'waiting') {
    return normalizeStep({
      id: 'rapid-warm-waiting',
      label: STEP_DEFINITIONS['rapid-warm-waiting'].label,
      providerLane: 'utility',
      state: 'running',
      reason,
      sourcePhase: phase || 'rapidWarmWaiting',
      order
    }, order);
  }
  if (status === 'ready') {
    return normalizeStep({
      id: 'rapid-deck-ready',
      label: STEP_DEFINITIONS['rapid-deck-ready'].label,
      providerLane: 'utility',
      state: 'done',
      reason,
      sourcePhase: phase || 'rapidWarmReady',
      order
    }, order);
  }
  if (status === 'stale') {
    return normalizeStep({
      id: 'rapid-deck-stale',
      label: STEP_DEFINITIONS['rapid-deck-stale'].label,
      providerLane: 'utility',
      state: 'warning',
      reason,
      sourcePhase: phase || 'rapidWarmStale',
      order
    }, order);
  }
  if (status === 'missed') {
    return normalizeStep({
      id: 'rapid-warm-miss-standard',
      label: STEP_DEFINITIONS['rapid-warm-miss-standard'].label,
      providerLane: 'utility',
      state: 'warning',
      reason,
      sourcePhase: phase || 'rapidWarmMissStandard',
      order
    }, order);
  }
  if (status === 'failed') {
    return normalizeStep({
      id: 'rapid-warm-failed',
      label: STEP_DEFINITIONS['rapid-warm-failed'].label,
      providerLane: 'utility',
      state: 'failed',
      reason,
      sourcePhase: phase || 'rapidWarmFailed',
      order
    }, order);
  }
  if (status === 'queued') {
    return normalizeStep({
      id: 'rapid-warming-scene-deck',
      label: STEP_DEFINITIONS['rapid-warming-scene-deck'].label,
      providerLane: 'utility',
      state: 'pending',
      reason,
      sourcePhase: phase || 'rapidWarming',
      order
    }, order);
  }
  return null;
}

function appendRapidWarmStatusStep(map, view, order = 0) {
  const source = asObject(view);
  if (normalizePipelineMode(source.settings?.pipelineMode) !== 'rapid') return;
  const step = rapidWarmStatusStep(source.rapidWarm, order);
  if (step) upsertStep(map, step);
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

function isControlOnlyRunId(runId) {
  const id = cleanText(runId).toLowerCase();
  return id.startsWith('settings-')
    || id === 'provider-test'
    || id.startsWith('provider-test-');
}

function isProviderTestRunId(runId) {
  const id = cleanText(runId).toLowerCase();
  return id === 'provider-test' || id.startsWith('provider-test-');
}

function shouldDiscardSuccessfulControlOnlyProgress(progress) {
  const source = asObject(progress);
  const steps = Array.isArray(source.steps) ? source.steps : [];
  if (!isControlOnlyRunId(source.runId) || steps.length === 0) return false;
  if (!steps.every((step) => HERO_CONTROL_ONLY_STEP_IDS.has(step.id))) return false;
  if (steps.some((step) => ['warning', 'failed'].includes(normalizeState(step.state)))) return false;
  if (isProviderTestRunId(source.runId) && steps.some((step) => normalizeState(step.state) === 'running')) return false;
  return true;
}

function isControlOnlyProgress(runId, steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  return isControlOnlyRunId(runId)
    && list.length > 0
    && list.every((step) => HERO_CONTROL_ONLY_STEP_IDS.has(step.id));
}

function deriveProgressRun(view) {
  const source = asObject(view);
  const events = sourceEvents(source);
  const current = asObject(source.activity);
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
    const retryCount = eventRetryCount(event);
    const reason = eventReason(event, state);
    upsertStep(steps, normalizeStep({
      id,
      label: stepLabelForEvent(id, event, definition),
      providerLane: event.providerLane || event.composerLane || definition.providerLane,
      state,
      retryCount,
      reason,
      sourcePhase: event.phase,
      sourceRoleId: asObject(event.detail).roleId,
      children: child ? [child] : [],
      order: eventOrder
    }, eventOrder));
  }
  appendRapidWarmStatusStep(steps, source, order++);
  const beforePlanSteps = [...steps.values()];
  const hasEnhancementStep = steps.has('generation-review');
  if (!isControlOnlyProgress(runId, beforePlanSteps) && !hasEnhancementStep) {
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
  if (running.length === 1) return `${(running[0].currentLabel || running[0].label).replace(/\.+$/g, '')}...`;
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
