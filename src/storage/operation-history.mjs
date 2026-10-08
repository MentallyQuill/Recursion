import { normalizeBuildIdentity } from '../runtime/build-identity.mjs';
import { boundedCount, normalizeAttemptOutcomes, normalizeAttemptFailureCode, CHECKPOINT_DIAGNOSTIC_CODES } from '../execution/attempt-outcomes.mjs';
import { normalizeRecoveryCounts, RECOVERY_COUNT_KEYS } from '../execution/recovery-counts.mjs';
import { summarizeFusedOutcome } from '../fused-recovery.mjs';
import { normalizeOperationConfiguration } from '../execution/operation-configuration.mjs';

const STATES = new Set(['running', 'paused', 'completed', 'stale', 'abandoned']);
const OUTCOMES = new Set([...STATES, 'completed-with-omissions', 'canceled', 'interrupted', 'failed']);
const STAGE_STATES = new Set(['pending', 'running', 'failed', 'completed', 'skipped', 'stale']);
const TURN_TIMING_KEYS = ['preprocessMs', 'firstVisibleTokenMs', 'totalReplyMs', 'preparedToRequestReadyMs',
  'requestReadyToFirstVisibleTokenMs', 'postPreparationMs', 'visibleStreamingMs'];
function identifier(value) {
  const text = typeof value === 'string' ? value.trim().slice(0, 180) : '';
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : '';
}
function timestamp(value) {
  return typeof value === 'string' && value.length <= 30 && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}
function observedCount(value) { return Number.isFinite(value) ? boundedCount(value) : null; }
export function normalizeOperationTiming(value) {
  return Object.fromEntries(TURN_TIMING_KEYS.map(key => [key, Number.isFinite(value?.[key]) && value[key] >= 0
    ? Math.min(2147483647, value[key]) : null]));
}
function normalizeStage(value) {
  const stageId = identifier(value?.stageId);
  if (!stageId) return null;
  return {stageId, state:STAGE_STATES.has(value.state) ? value.state : 'pending',
    kind:['model', 'local', 'validation-outcome'].includes(value.kind) ? value.kind : 'unknown',
    attemptCount:boundedCount(value.attemptCount), attempts:normalizeAttemptOutcomes(value.attempts),
    recoveryCounts:normalizeRecoveryCounts(value.recoveryCounts),
    diagnosticCodes:(Array.isArray(value.diagnosticCodes) ? value.diagnosticCodes : [])
      .filter(code => CHECKPOINT_DIAGNOSTIC_CODES.includes(code)),
    failureCode:value.failureCode ? normalizeAttemptFailureCode(value.failureCode) : null,
    ...(stageId === 'preprocess.cards.fused' ? {fused:summarizeFusedOutcome(value.fused)} : {}),
    timings:Object.fromEntries(['validationMs','artifactPersistenceMs'].map(key => [key,
      Number.isFinite(value.timings?.[key]) ? Math.max(0, Math.min(2147483647, value.timings[key])) : null]))};
}
function normalizeSummary(value) {
  const operationId = identifier(value?.operationId);
  if (!operationId) return null;
  return {operationId, phase:['preprocess','postprocess'].includes(value.phase) ? value.phase : 'unknown',
    state:STATES.has(value.state) ? value.state : 'paused', outcome:OUTCOMES.has(value.outcome) ? value.outcome : 'paused',
    diagnosticCodes:value.outcome === 'interrupted' ? ['operation-interrupted-after-reload'] : [],
    createdAt:timestamp(value.createdAt), updatedAt:timestamp(value.updatedAt),
    firstObservedBuild:normalizeBuildIdentity(value.firstObservedBuild), latestBuild:normalizeBuildIdentity(value.latestBuild),
    pipelineMode:['segmented','fused'].includes(value.pipelineMode) ? value.pipelineMode : 'unknown',
    configuration:normalizeOperationConfiguration(value.configuration),
    lane:['utility','reasoner'].includes(value.lane) ? value.lane : 'unknown',
    stageCount:boundedCount(value.stageCount), totalAttempts:boundedCount(value.totalAttempts),
    recoveryCounts:normalizeRecoveryCounts(value.recoveryCounts),
    counts:Object.fromEntries(['targetCards','selectedCards','deliveredCards','omittedCards','requiredBlocks']
      .map(key => [key,observedCount(value.counts?.[key])])),
    stages:(Array.isArray(value.stages) ? value.stages : []).map(normalizeStage).filter(Boolean).slice(0, 32),
    turnTiming:normalizeOperationTiming(value.turnTiming)};
}
export function normalizeOperationSummaries(values) {
  const result = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const summary = normalizeSummary(value);
    if (!summary) continue;
    result.delete(summary.operationId);
    result.set(summary.operationId, summary);
    if (result.size > 20) result.delete(result.keys().next().value);
  }
  return [...result.values()];
}
function operationOutcome(manifest, recoveryCounts) {
  if (manifest.state === 'completed') return recoveryCounts.optionalOmissions > 0 ? 'completed-with-omissions' : 'completed';
  if (manifest.state === 'paused') {
    if (manifest.pauseReason === 'restored-after-reload') return 'interrupted';
    if (['user-stop','recursion-stop','host-stop','host-generation-stopped'].includes(manifest.pauseReason)) return 'canceled';
    if (String(manifest.pauseReason || '').startsWith('stage-failed:')) return 'failed';
  }
  return manifest.state;
}
export function buildOperationSummary(manifest, {build, previous} = {}) {
  const records = Object.values(manifest?.stageRecords || {}).sort((a,b) => String(a.stageId).localeCompare(String(b.stageId)));
  const recoveryCounts = normalizeRecoveryCounts(Object.fromEntries(RECOVERY_COUNT_KEYS.map(key => [key,
    records.reduce((total, record) => total + normalizeRecoveryCounts(record.recoveryCounts)[key], 0)])));
  const hand = records.find(record => record.stageId === 'preprocess.hand')?.summary;
  const summary = normalizeSummary({operationId:manifest?.operationId, phase:manifest?.phase, state:manifest?.state,
    outcome:operationOutcome(manifest || {}, recoveryCounts), createdAt:manifest?.createdAt,updatedAt:manifest?.updatedAt,
    firstObservedBuild:previous?.operationId === manifest?.operationId ? previous.firstObservedBuild : build,
    latestBuild:build, pipelineMode:manifest?.pipelineMode,lane:manifest?.pipelineDecision?.selectedLane,
    configuration:manifest?.configuration,
    stageCount:records.length,totalAttempts:records.reduce((sum, record) => sum + boundedCount(record.attempts?.total), 0),
    recoveryCounts, counts:{targetCards:hand?.targetCount, deliveredCards:hand?.cardCount,
      selectedCards:hand?.selectedCount, omittedCards:hand?.omittedCount, requiredBlocks:recoveryCounts.requiredBlocks},
    stages:records.map(record => ({stageId:record.stageId,state:record.state,kind:record.kind,
      attemptCount:record.attempts?.total,attempts:record.attemptOutcomes,recoveryCounts:record.recoveryCounts,
      fused:record.summary,
      failureCode:record.failure?.code,diagnosticCodes:record.diagnosticCodes,timings:record.timings})),
    turnTiming:previous?.operationId === manifest?.operationId ? previous.turnTiming : null});
  return summary;
}
