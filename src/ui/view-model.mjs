import {
  cardScopeCounts,
  cardScopeLabel,
  defaultCardScope,
  normalizeCardScope
} from '../card-scope.mjs';
import { createHeroPixelBlocks, createProgressRunModel } from '../progress.mjs';
import { DEFAULT_RECURSION_SETTINGS } from '../settings.mjs';

const PHASE_LABELS = Object.freeze({
  idle: '',
  started: 'Reading current turn...',
  activity: 'Recursion is working...',
  sceneChecking: 'Checking scene shift...',
  arbiterPlanning: 'Planning card pass...',
  rapidWarming: 'Rapid warming scene deck...',
  rapidWarmWaiting: 'Waiting for Rapid deck...',
  rapidDeltaRunning: 'Rapid selecting turn delta...',
  rapidWarmMissStandard: 'Rapid warm miss; Standard...',
  rapidWarmReady: 'Rapid deck ready.',
  rapidWarmStale: 'Rapid deck stale.',
  rapidWarmFailed: 'Rapid warm failed.',
  cacheReusing: 'Reusing scene deck...',
  cardBatchRunning: 'Generating scene cards...',
  fusedCardBundleRunning: 'Generating fused card bundle...',
  cardValidating: 'Validating cards...',
  deckUpdating: 'Updating scene deck...',
  handSelected: 'Selecting turn hand...',
  utilityComposing: 'Composing prompt packet with Utility...',
  reasonerComposing: 'Reasoner refining guidance...',
  promptInstalling: 'Installing Recursion prompt...',
  promptPacketBuilt: 'Recursion prompt ready.',
  storageSaving: 'Saving scene cache...',
  storageComplete: 'Scene cache saved.',
  promptClearing: 'Clearing Recursion prompt...',
  promptClearFailed: 'Prompt clear failed. Recursion skipped without clearing host prompt.',
  storageWarning: 'Recursion storage warning; continuing in memory.',
  cacheWarning: 'Ignored invalid cached Recursion cards.',
  settled: 'Recursion prompt ready.'
});

const VALID_SEVERITIES = new Set(['info', 'success', 'warning', 'error']);
const READY_PHASES = new Set(['idle', 'settled', '', undefined, null]);
const REASONER_ACTIVE_PHASES = new Set(['reasonerComposing']);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function terminalStatusText(value) {
  const text = cleanText(value);
  if (!text) return '';
  if (/[.!?]$|\.{3}$/.test(text)) return text;
  return `${text}.`;
}

function normalizeSeverity(value) {
  const severity = cleanText(value, 'info').toLowerCase();
  return VALID_SEVERITIES.has(severity) ? severity : 'info';
}

function normalizeChips(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const chips = [];
  for (const chip of value) {
    const normalized = cleanText(chip);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    chips.push(normalized);
  }
  return chips;
}

function laneLabel(value, fallback = 'Utility') {
  const lane = cleanText(value).toLowerCase();
  if (lane === 'reasoner') return 'Reasoner';
  if (lane === 'guidance') return 'Guidance';
  if (lane === 'local') return 'Local';
  if (lane === 'utility') return 'Utility';
  return fallback;
}

function normalizeMode(value) {
  return cleanText(value, 'auto').toLowerCase() === 'manual' ? 'manual' : 'auto';
}

function modeLabel(value) {
  return normalizeMode(value) === 'manual' ? 'Manual' : 'Auto';
}

function normalizePipelineMode(value) {
  const mode = cleanText(value, 'standard').toLowerCase();
  if (mode === 'rapid') return 'rapid';
  if (mode === 'fused') return 'fused';
  return 'standard';
}

function pipelineLabel(value) {
  const mode = normalizePipelineMode(value);
  if (mode === 'rapid') return 'Rapid Pipeline';
  if (mode === 'fused') return 'Fused Pipeline';
  return 'Standard Pipeline';
}

function normalizeLastBriefStatus(value, hasCards = false, hasPacket = false) {
  const status = cleanText(value, '').toLowerCase();
  if (['ready', 'clearing', 'preparing', 'empty'].includes(status)) return status;
  return hasCards || hasPacket ? 'ready' : 'empty';
}

function integerInRange(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function reasonerState(view, activity) {
  const settings = asObject(view.settings);
  const reasoner = settings.providers && Object.prototype.hasOwnProperty.call(settings.providers, 'reasoner')
    ? asObject(settings.providers.reasoner)
    : null;
  if (reasoner?.enabled === false) return 'Disabled';
  if (REASONER_ACTIVE_PHASES.has(activity.phase) || activity.providerLane === 'reasoner' || activity.composerLane === 'reasoner') {
    return 'Composing';
  }
  if (!reasoner) return 'Unavailable';
  if (reasoner.lastTest?.status && !['ok', 'pass', 'passed', 'ready', 'not-run'].includes(cleanText(reasoner.lastTest.status).toLowerCase())) {
    return 'Issue';
  }
  return reasoner.enabled === true ? 'Available' : 'Unavailable';
}

function collectProviderLanesFromSteps(steps, lanes = new Set()) {
  if (!Array.isArray(steps)) return lanes;
  for (const step of steps) {
    const lane = cleanText(asObject(step).providerLane).toLowerCase();
    if (lane === 'utility' || lane === 'reasoner') lanes.add(lane);
    collectProviderLanesFromSteps(step?.children, lanes);
  }
  return lanes;
}

function progressFooterLabel(modelSource, progressRun, composerLane) {
  const lanes = collectProviderLanesFromSteps(progressRun?.steps);
  const fallbackLane = cleanText(composerLane, 'utility').toLowerCase();
  if (!lanes.size && (fallbackLane === 'utility' || fallbackLane === 'reasoner')) lanes.add(fallbackLane);
  const mode = modeLabel(cleanText(modelSource.settings?.mode, 'auto').toLowerCase());
  if (lanes.has('utility') && lanes.has('reasoner')) return `${mode} - Utility and Reasoner lanes`;
  if (lanes.has('reasoner')) return `${mode} - Reasoner lane`;
  return `${mode} - Utility lane`;
}

export function activityLabel(activity = {}) {
  const source = asObject(activity);
  const explicitLabel = cleanText(source.label);
  if (explicitLabel) return explicitLabel;
  if (Object.prototype.hasOwnProperty.call(PHASE_LABELS, source.phase)) return PHASE_LABELS[source.phase];
  return 'Recursion is working...';
}

function runtimeHealthLabel(activity, progressRun) {
  if (!READY_PHASES.has(activity.phase)) return 'Working';
  const severity = normalizeSeverity(activity.severity);
  if (severity === 'error') return 'Issue';
  if (severity === 'warning') return 'Needs attention';
  if (progressRun?.title === 'Issue') return 'Issue';
  if (progressRun?.title === 'Needs attention') return 'Needs attention';
  return 'Ready';
}

function rapidWarmStandbyText(rapidWarm, pipelineMode) {
  if (pipelineMode !== 'rapid') return '';
  const source = asObject(rapidWarm);
  const status = cleanText(source.status).toLowerCase();
  const label = cleanText(source.reasonLabel || source.failureReasonLabel);
  if (status === 'ready') return terminalStatusText(label || 'Rapid deck ready');
  if (status === 'stale') return terminalStatusText(label || 'Rapid deck stale');
  if (status === 'missed') return terminalStatusText(label || 'Rapid warm missed; Standard started');
  if (status === 'failed') return terminalStatusText(label || 'Rapid warm failed');
  return '';
}

function standbyStatusText(activity, progressRun, enabled, mode, pipelineMode, cards, rapidWarm) {
  if (!enabled) return terminalStatusText('Recursion off');
  if (progressRun?.currentStepText) return '';
  const severity = normalizeSeverity(activity.severity);
  if (severity === 'error') return terminalStatusText('Needs attention');
  if (severity === 'warning') return terminalStatusText('Needs attention');
  const phase = cleanText(activity.phase, 'idle');
  if (phase === 'rapidWarmReady') return terminalStatusText('Rapid deck ready');
  if (phase === 'rapidWarmStale') return terminalStatusText('Rapid deck stale');
  const label = cleanText(activity.label).replace(/\.+$/g, '');
  if (phase === 'settled' || phase === 'promptPacketBuilt') {
    if (/recursion prompt ready/i.test(label)) return terminalStatusText('Recursion prompt ready');
    if (/generation canceled/i.test(label)) return terminalStatusText('Generation canceled');
    return terminalStatusText(label || 'Ready for next turn');
  }
  if (!READY_PHASES.has(activity.phase)) return '';
  if (mode === 'manual') return terminalStatusText('Manual scope armed');
  const rapidStatus = rapidWarmStandbyText(rapidWarm, pipelineMode);
  if (rapidStatus) return rapidStatus;
  if (pipelineMode === 'rapid' && Array.isArray(cards) && cards.length > 0) return terminalStatusText('Rapid deck standing by');
  if (Array.isArray(cards) && cards.length > 0) return terminalStatusText('Scene deck standing by');
  return terminalStatusText('Ready for Recursion');
}

export function createRecursionViewModel(view = {}) {
  const source = asObject(view);
  const settings = asObject(source.settings);
  const activity = asObject(source.activity);
  const enabled = settings.enabled !== false;
  const mode = normalizeMode(settings.mode);
  const pipelineMode = normalizePipelineMode(settings.pipelineMode);
  const cardScope = normalizeCardScope(settings.cardScope || defaultCardScope());
  const rawCards = Array.isArray(source.lastHand?.cards) ? source.lastHand.cards : [];
  const lastBriefStatus = normalizeLastBriefStatus(source.lastBrief?.status, rawCards.length > 0, Boolean(source.lastPacket));
  const cards = lastBriefStatus === 'ready' ? rawCards : [];
  const composerLane = source.lastPacket?.diagnostics?.composerLane || activity.composerLane || activity.providerLane || 'utility';
  const progressRun = createProgressRunModel(source);
  const heroPixelBlocks = createHeroPixelBlocks(progressRun);
  const freshNextGeneration = asObject(source.freshNextGeneration);
  const freshNextGenerationPending = freshNextGeneration.pending === true;
  const generationStopVisible = enabled && (
    Boolean(cleanText(source.activeRunId))
    || source.hostGenerationActive === true
    || Number(progressRun.activeCount || 0) > 0
  );
  const freshNextGenerationVisible = enabled && !generationStopVisible;
  const defaultUi = DEFAULT_RECURSION_SETTINGS.ui;
  const progressChildVisibleLimit = integerInRange(settings.ui?.progressChildVisibleLimit, defaultUi.progressChildVisibleLimit, 1, 20);
  const progressListVisibleLimit = integerInRange(settings.ui?.progressListVisibleLimit, defaultUi.progressListVisibleLimit, 5, 80);
  const tooltipsEnabled = settings.ui?.tooltipsEnabled !== false;
  const activityChips = normalizeChips([
    ...(Array.isArray(activity.chips) ? activity.chips : []),
    activity.providerLane ? laneLabel(activity.providerLane) : '',
    activity.cardCounts?.selected ? `${activity.cardCounts.selected} cards` : ''
  ]);

  return {
    mode,
    pipelineMode,
    lastBriefStatus,
    lastBriefReason: cleanText(source.lastBrief?.reason || ''),
    enabled,
    modeLabel: modeLabel(mode),
    pipelineLabel: pipelineLabel(pipelineMode),
    cardScope,
    cardScopeLabel: cardScopeLabel(cardScope),
    cardScopeCounts: cardScopeCounts(cardScope),
    runtimeHealthLabel: enabled ? runtimeHealthLabel(activity, progressRun) : 'Off',
    handCount: cards.length,
    activityLabel: activityLabel(activity),
    activitySeverity: normalizeSeverity(activity.severity),
    activityChips,
    progressRun,
    generationStopVisible,
    freshNextGenerationVisible,
    freshNextGenerationPending,
    freshNextGenerationDisabled: !enabled || generationStopVisible,
    currentStepText: progressRun.currentStepText,
    standbyStatusText: standbyStatusText(activity, progressRun, enabled, mode, pipelineMode, cards, source.rapidWarm),
    heroPixelBlocks,
    heroPixelColumnCount: heroPixelBlocks.at(-1)?.columnCount || 0,
    progressChildVisibleLimit,
    progressListVisibleLimit,
    tooltipsEnabled,
    composerLabel: laneLabel(composerLane, 'Utility'),
    progressFooterLabel: progressFooterLabel(source, progressRun, composerLane),
    reasonerState: reasonerState(source, activity),
    reasonerLabel: `Reasoner ${reasonerState(source, activity).toLowerCase()}`,
    lastUpdatedAt: cleanText(source.updatedAt),
    cards
  };
}
