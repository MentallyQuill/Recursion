import {
  compareRunProvenance,
  normalizeExecutionProvenance
} from './provenance.mjs';
import { normalizeOperationBudget } from './operation-budget.mjs';
import { normalizeInstructionValidationRule } from '../instruction-safety.mjs';
import { normalizePipelineDecision } from '../runtime/pipeline-policy.mjs';

export const PIPELINE_RUN_SCHEMA = 'recursion.pipelineRun.v2';
export const CHECKPOINT_SCHEMA = 'recursion.stageCheckpoint.v2';

export const OPERATION_STATES = Object.freeze([
  'running',
  'paused',
  'completed',
  'stale',
  'abandoned'
]);

export const STAGE_STATES = Object.freeze([
  'pending',
  'running',
  'failed',
  'completed',
  'skipped',
  'stale'
]);

const TERMINAL_OPERATION_STATES = new Set(['completed', 'stale', 'abandoned']);

export const CHECKPOINT_DIAGNOSTIC_CODES = Object.freeze([
  'structured-output-downgraded',
  'output-budget-increased',
  'output-budget-at-ceiling',
  'output-budget-reduced',
  'output-budget-at-floor',
  'model-output-corrected',
  'provider-rate-limit-retry',
  'provider-rate-limit-exhausted',
  'provider-transient-retry',
  'provider-retry',
  'stage-reprocess-consumed',
  'profile-sampler-projection-failed',
  'fused-fallback-segmented',
  'unresolved-fused-families',
  'zero-useful-fused-cards'
]);

export const CHECKPOINT_ATTEMPT_ACTIONS = Object.freeze([
  'stop',
  'downgrade-structured-output',
  'increase-output-budget',
  'reduce-output-budget',
  'retry-corrected',
  'retry-same'
]);

const CHECKPOINT_DIAGNOSTIC_CODE_SET = new Set(CHECKPOINT_DIAGNOSTIC_CODES);
const CHECKPOINT_ATTEMPT_ACTION_SET = new Set(CHECKPOINT_ATTEMPT_ACTIONS);

export function normalizeCheckpointDiagnosticCodes(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((code) => cleanText(code).trim().toLowerCase())
      .filter((code) => CHECKPOINT_DIAGNOSTIC_CODE_SET.has(code))
  )];
}

export function normalizeCheckpointAttemptAction(value) {
  const action = cleanText(value).trim().toLowerCase();
  return CHECKPOINT_ATTEMPT_ACTION_SET.has(action) ? action : null;
}

function cleanText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeSourceIdentity(value = {}) {
  return {
    sourceRevisionHash: cleanText(value.sourceRevisionHash),
    latestMessageId: cleanText(value.latestMessageId),
    selectedSwipeId: cleanText(value.selectedSwipeId),
    characterHash: cleanText(value.characterHash),
    groupHash: cleanText(value.groupHash)
  };
}

export function isTerminalOperationState(state) {
  return TERMINAL_OPERATION_STATES.has(state);
}

function cleanStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.trim()))];
}

function positiveInteger(value, fallback = 1) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function unsafeSummaryKey(value) {
  const key = cleanText(value).replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
  if (!key) return false;
  const protectedMetadataSuffix = /(id|ids|hash|count|length|status|class|mode|reason|code|codes|bytes)$/;
  if (protectedMetadataSuffix.test(key)) return false;
  return /(body|prompt|response|text|guidance|draft|prose|packet|hand|card|reference|arbiter|artifact)/.test(key);
}

function normalizeHashMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => cleanText(value[key]))
      .map((key) => [key, cleanText(value[key])])
  );
}

function normalizeStageSummary(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 240);
  if (depth >= 3) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, 30)
      .map((entry) => normalizeStageSummary(entry, depth + 1))
      .filter((entry) => entry !== null);
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return null;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .slice(0, 40)
      .filter((key) => key === 'authoredCards' || !unsafeSummaryKey(key))
      .map((key) => [key.slice(0, 80), key === 'authoredCards'
        ? (Array.isArray(value[key]) ? value[key] : []).filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string').map((entry) => ({
            id: entry.id.slice(0, 160), name: entry.name.slice(0, 120), priority: entry.priority === true
          }))
        : normalizeStageSummary(value[key], depth + 1)])
      .filter(([, entry]) => entry !== null)
  );
}

function normalizeAttempts(value = {}) {
  return {
    window: nonNegativeInteger(value.window),
    limit: positiveInteger(value.limit),
    used: nonNegativeInteger(value.used),
    total: nonNegativeInteger(value.total)
  };
}

function normalizeArtifactRef(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = value.kind === 'inline' || value.kind === 'logical-storage'
    ? value.kind
    : '';
  const key = cleanText(value.key);
  const hash = cleanText(value.hash);
  const artifactId = cleanText(value.artifactId);
  if (!kind || !hash || (kind === 'logical-storage' && !key)) return null;
  return {
    kind,
    key,
    hash,
    ...(artifactId ? { artifactId } : {}),
    ...(Number.isInteger(value.artifactBytes ?? value.bytes) && (value.artifactBytes ?? value.bytes) >= 0
      ? { artifactBytes: value.artifactBytes ?? value.bytes }
      : {})
  };
}

export function createCheckpoint({
  operationId,
  stageId,
  stageVersion,
  inputHash,
  outputHash,
  dependencyHashes,
  provenance,
  attempts,
  artifactRef,
  diagnosticCodes = [],
  lastAttemptAction = null,
  completedAt
}) {
  return {
    schema: CHECKPOINT_SCHEMA,
    operationId: cleanText(operationId),
    stageId: cleanText(stageId),
    stageVersion: positiveInteger(stageVersion),
    state: 'completed',
    inputHash: cleanText(inputHash),
    outputHash: cleanText(outputHash),
    dependencyHashes: normalizeHashMap(dependencyHashes),
    provenance: normalizeExecutionProvenance(provenance),
    attempts: normalizeAttempts(attempts),
    artifactRef: normalizeArtifactRef(artifactRef),
    diagnosticCodes: normalizeCheckpointDiagnosticCodes(diagnosticCodes),
    lastAttemptAction: normalizeCheckpointAttemptAction(lastAttemptAction),
    completedAt: cleanText(completedAt)
  };
}

export function normalizeCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema !== CHECKPOINT_SCHEMA || value.state !== 'completed') return null;
  const artifactRef = normalizeArtifactRef(value.artifactRef);
  if (
    !cleanText(value.operationId)
    || !cleanText(value.stageId)
    || !cleanText(value.inputHash)
    || !cleanText(value.outputHash)
    || !artifactRef
  ) {
    return null;
  }
  return {
    schema: CHECKPOINT_SCHEMA,
    operationId: cleanText(value.operationId),
    stageId: cleanText(value.stageId),
    stageVersion: positiveInteger(value.stageVersion),
    state: 'completed',
    inputHash: cleanText(value.inputHash),
    outputHash: cleanText(value.outputHash),
    dependencyHashes: normalizeHashMap(value.dependencyHashes),
    provenance: normalizeExecutionProvenance(value.provenance),
    attempts: normalizeAttempts(value.attempts),
    artifactRef,
    diagnosticCodes: normalizeCheckpointDiagnosticCodes(value.diagnosticCodes),
    lastAttemptAction: normalizeCheckpointAttemptAction(value.lastAttemptAction),
    completedAt: cleanText(value.completedAt)
  };
}

export function isCheckpointReusable({
  checkpoint,
  stage,
  dependencyCheckpoints = {},
  artifactHash,
  expectedProvenance
}) {
  const normalized = normalizeCheckpoint(checkpoint);
  if (!normalized || !stage || typeof stage !== 'object') return false;
  if (!Number.isInteger(stage.version) || stage.version <= 0) return false;
  if (normalized.stageId !== cleanText(stage.id)) return false;
  if (normalized.stageVersion !== stage.version) return false;
  if (normalized.inputHash !== cleanText(stage.inputHash)) return false;
  if (normalized.outputHash !== cleanText(artifactHash)) return false;
  if (normalized.artifactRef.hash !== cleanText(artifactHash)) return false;
  if (!compareRunProvenance(expectedProvenance, normalized.provenance).reusable) return false;
  if (stage.provenance && !compareRunProvenance(stage.provenance, normalized.provenance).reusable) {
    return false;
  }
  const expectedDependencyIds = Object.keys(dependencyCheckpoints).sort();
  const checkpointDependencyIds = Object.keys(normalized.dependencyHashes).sort();
  if (JSON.stringify(expectedDependencyIds) !== JSON.stringify(checkpointDependencyIds)) return false;
  return Object.entries(normalized.dependencyHashes).every(([stageId, outputHash]) => (
    cleanText(dependencyCheckpoints[stageId]?.outputHash) === outputHash
  ));
}

export function createStageRecord({
  stageId,
  stageVersion,
  kind,
  attemptsLimit,
  updatedAt
}) {
  return {
    stageId: cleanText(stageId),
    stageVersion: positiveInteger(stageVersion),
    kind: cleanText(kind),
    state: 'pending',
    checkpoint: null,
    summary: null,
    timings: null,
    failure: null,
    diagnosticCodes: [],
    lastAttemptAction: null,
    attempts: {
      window: 0,
      limit: positiveInteger(attemptsLimit),
      used: 0,
      total: 0
    },
    executionToken: null,
    startedAt: null,
    updatedAt: cleanText(updatedAt)
  };
}

export function normalizeStageRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!cleanText(value.stageId)) return null;
  const attempts = value.attempts && typeof value.attempts === 'object'
    ? value.attempts
    : {};
  return {
    stageId: cleanText(value.stageId),
    stageVersion: positiveInteger(value.stageVersion),
    kind: cleanText(value.kind),
    state: STAGE_STATES.includes(value.state) ? value.state : 'pending',
    checkpoint: normalizeCheckpoint(value.checkpoint),
    summary: normalizeStageSummary(value.summary),
    timings: value.timings ? {
      validationMs: Math.max(0, Number(value.timings.validationMs) || 0),
      artifactPersistenceMs: Math.max(0, Number(value.timings.artifactPersistenceMs) || 0)
    } : null,
    diagnosticCodes: normalizeCheckpointDiagnosticCodes(value.diagnosticCodes),
    lastAttemptAction: normalizeCheckpointAttemptAction(value.lastAttemptAction),
    failure: value.failure && typeof value.failure === 'object'
      ? {
          code: cleanText(value.failure.code),
          failureClass: cleanText(value.failure.failureClass),
          retryable: value.failure.retryable === true,
          ...(normalizeInstructionValidationRule(value.failure.validationRule)
            ? { validationRule: normalizeInstructionValidationRule(value.failure.validationRule) } : {}),
          ...(Number.isFinite(value.failure.retryAfterMs)
            ? { retryAfterMs: Math.min(2147483647, Math.max(0, Math.trunc(value.failure.retryAfterMs))) } : {}),
          ...(Number.isFinite(value.failure.retryNotBefore) ? { retryNotBefore: value.failure.retryNotBefore } : {}),
          ...(Number.isInteger(value.failure.rateLimitFailures)
            ? { rateLimitFailures: Math.max(0, value.failure.rateLimitFailures) } : {}),
          ...(typeof value.failure.providerKey === 'string'
            ? { providerKey: value.failure.providerKey.slice(0, 180) } : {}),
          ...(cleanText(value.failure.message).trim()
            ? { message: cleanText(value.failure.message).trim().slice(0, 300) }
            : {}),
          ...(cleanText(value.failure.suggestedAction).trim()
            ? { suggestedAction: cleanText(value.failure.suggestedAction).trim().slice(0, 180) }
            : {})
        }
      : null,
    attempts: normalizeAttempts(attempts),
    executionToken: cleanText(value.executionToken) || null,
    startedAt: cleanText(value.startedAt) || null,
    updatedAt: cleanText(value.updatedAt)
  };
}

function normalizeStageRecordMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeStageRecord(value[key])])
      .filter(([key, record]) => record && record.stageId === key)
  );
}

export function createPipelineRun({
  operationId,
  chatKey,
  phase,
  pipelineMode,
  createdAt,
  sourceIdentity,
  provenance,
  turnKeyHash,
  sourceBandHash,
  hostOwned = false,
  nativeGenerationType = 'normal'
}) {
  return {
    schema: PIPELINE_RUN_SCHEMA,
    operationId: cleanText(operationId),
    graphVersion: 1,
    phase: cleanText(phase),
    pipelineMode: cleanText(pipelineMode),
    chatKey: cleanText(chatKey),
    turnKeyHash: cleanText(turnKeyHash),
    sourceBandHash: cleanText(sourceBandHash),
    hostOwned: hostOwned === true,
    nativeGenerationType: ['normal', 'swipe', 'regenerate'].includes(nativeGenerationType)
      ? nativeGenerationType
      : 'normal',
    sourceIdentity: normalizeSourceIdentity(sourceIdentity),
    provenance: normalizeExecutionProvenance(provenance),
    revision: 0,
    state: 'paused',
    pauseReason: 'created',
    staleChangedFields: [],
    frontierStageIds: [],
    queuedStageIds: [],
    stageRecords: {},
    recoveryBudget: null,
    pipelineDecision: null,
    createdAt: cleanText(createdAt),
    updatedAt: cleanText(createdAt)
  };
}

export function normalizePipelineRun(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema !== PIPELINE_RUN_SCHEMA) return null;
  if (!cleanText(value.operationId) || !cleanText(value.chatKey)) return null;
  return {
    schema: PIPELINE_RUN_SCHEMA,
    operationId: cleanText(value.operationId),
    graphVersion: Number.isInteger(value.graphVersion) && value.graphVersion > 0
      ? value.graphVersion
      : 1,
    phase: cleanText(value.phase),
    pipelineMode: cleanText(value.pipelineMode),
    chatKey: cleanText(value.chatKey),
    turnKeyHash: cleanText(value.turnKeyHash),
    sourceBandHash: cleanText(value.sourceBandHash),
    hostOwned: value.hostOwned === true,
    nativeGenerationType: ['normal', 'swipe', 'regenerate'].includes(value.nativeGenerationType)
      ? value.nativeGenerationType
      : 'normal',
    sourceIdentity: normalizeSourceIdentity(value.sourceIdentity),
    provenance: normalizeExecutionProvenance(value.provenance),
    revision: nonNegativeInteger(value.revision),
    state: OPERATION_STATES.includes(value.state) ? value.state : 'paused',
    pauseReason: cleanText(value.pauseReason),
    staleChangedFields: cleanStringList(value.staleChangedFields),
    frontierStageIds: cleanStringList(value.frontierStageIds),
    queuedStageIds: cleanStringList(value.queuedStageIds),
    stageRecords: normalizeStageRecordMap(value.stageRecords),
    recoveryBudget: value.recoveryBudget ? normalizeOperationBudget(value.recoveryBudget) : null,
    pipelineDecision: value.pipelineDecision ? normalizePipelineDecision(value.pipelineDecision) : null,
    createdAt: cleanText(value.createdAt),
    updatedAt: cleanText(value.updatedAt)
  };
}
