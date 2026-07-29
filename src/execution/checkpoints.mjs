import {
  compareRunProvenance,
  normalizeExecutionProvenance
} from './provenance.mjs';

export const PIPELINE_RUN_SCHEMA = 'recursion.pipelineRun.v1';
export const CHECKPOINT_SCHEMA = 'recursion.stageCheckpoint.v1';

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

function normalizeHashMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => cleanText(value[key]))
      .map((key) => [key, cleanText(value[key])])
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
  if (!kind || !hash || (kind === 'logical-storage' && !key)) return null;
  return { kind, key, hash };
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
    failure: null,
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
    failure: value.failure && typeof value.failure === 'object'
      ? {
          code: cleanText(value.failure.code),
          failureClass: cleanText(value.failure.failureClass),
          retryable: value.failure.retryable === true
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
  sourceIdentity
}) {
  return {
    schema: PIPELINE_RUN_SCHEMA,
    operationId: cleanText(operationId),
    graphVersion: 1,
    phase: cleanText(phase),
    pipelineMode: cleanText(pipelineMode),
    chatKey: cleanText(chatKey),
    sourceIdentity: normalizeSourceIdentity(sourceIdentity),
    state: 'paused',
    pauseReason: 'created',
    frontierStageIds: [],
    queuedStageIds: [],
    stageRecords: {},
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
    sourceIdentity: normalizeSourceIdentity(value.sourceIdentity),
    state: OPERATION_STATES.includes(value.state) ? value.state : 'paused',
    pauseReason: cleanText(value.pauseReason),
    frontierStageIds: cleanStringList(value.frontierStageIds),
    queuedStageIds: cleanStringList(value.queuedStageIds),
    stageRecords: normalizeStageRecordMap(value.stageRecords),
    createdAt: cleanText(value.createdAt),
    updatedAt: cleanText(value.updatedAt)
  };
}
