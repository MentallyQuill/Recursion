import { createPostProcessComparisonStore, POST_PROCESS_COMPARISONS_PATTERN, postProcessComparisonsKey } from './post-process-comparison.mjs';
import { cloneJson, makeId, nowIso, redact, safeId } from './core.mjs';
import { failureFrom } from './failures.mjs';
import { UNKNOWN_STORY_FORM, normalizeStoryForm } from './story-form.mjs';
import { normalizeRetentionSettings } from './retention-policy.mjs';
import { stableHash } from './execution/provenance.mjs';
import { normalizePipelineRun } from './execution/checkpoints.mjs';
import {
  QUEUED_REPROCESS_ENVELOPE_SCHEMA,
  normalizeQueuedReprocess,
  normalizeQueuedReprocessEnvelope
} from './execution/queued-reprocess.mjs';
import {
  LAST_BRIEF_SCHEMA,
  lastBriefKey,
  normalizeLastBriefRecord
} from './storage/last-brief.mjs';

export {
  LAST_BRIEF_SCHEMA,
  lastBriefKey,
  normalizeLastBriefRecord
};

const RECURSION_VERSION = '0.3.0-beta.1';
const MAX_JOURNAL_ENTRIES = 500;
const RUN_JOURNAL_KEY_PATTERN = /^recursion-run-journal-[A-Za-z0-9_.-]+\.v1\.json$/;
const PIPELINE_RUN_KEY_PATTERN = /^recursion-pipeline-run-[A-Za-z0-9_.-]+\.v2\.json$/;
const PIPELINE_ARTIFACT_KEY_PATTERN = /^recursion-pipeline-artifact-[A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+\.v2\.json$/;
const QUEUED_REPROCESS_KEY_PATTERN = /^recursion-queued-reprocess-[A-Za-z0-9_.-]+\.v2\.json$/;
const LAST_BRIEF_KEY_PATTERN = /^recursion-last-brief-[A-Za-z0-9_.-]+\.v1\.json$/;
const RETIRED_GENERATED_KEY_PATTERNS = Object.freeze([
  /^recursion-scene-[A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+\.v1\.json$/,
  /^recursion-pipeline-run-[A-Za-z0-9_.-]+\.v1\.json$/,
  /^recursion-pipeline-artifact-[A-Za-z0-9_.-]+-v1\.json$/,
  /^recursion-queued-reprocess-[A-Za-z0-9_.-]+\.v1\.json$/
]);
const INDEX_KINDS = new Set([
  'runJournal',
  'pipelineRun',
  'pipelineArtifact',
  'queuedReprocess',
  'lastBrief',
  'postProcessComparisons'
]);
const DEFAULT_JOURNAL_EVENT = 'activity.stage_changed';
const UNSAFE_JOURNAL_TEXT_PATTERN = /\b(raw[-_\s]*prompt|rawPrompt|raw[-_\s]*response|rawResponse|provider[-_\s]*prompt|providerPrompt|provider[-_\s]*response|providerResponse|hidden[-_\s]*reasoning|hiddenReasoning|reasoning[-_\s]*(?:content|details)|reasoningContent|reasoningDetails|private[-_\s]*story[-_\s]*plan|privateStoryPlan|private[-_\s]*plan|privatePlan|session[-_\s]*id|sessionId|session[-_\s]*key\s*[:=]|sessionKey\s*[:=]|session[-_\s]*token|credentials?|password\s*[:=]|token\s*[:=]|api[-_\s]*key\s*[:=]|apiKey\s*[:=]|authorization\s*[:=]|set-cookie\s*[:=]|cookie\s*[:=]|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;
const OBJECT_COERCION_TEXT_PATTERN = /\[object Object\]|object-Object/i;
const PATH_LIKE_TEXT_PATTERN = /(^|[\s"'`=:(\[])(?:[A-Za-z]:[\\/]|\\\\|\/\/|\.{1,2}[\\/]|\/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/-]*|[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/-]*\.(?:jsonl?|mjs|js|css|md|txt|png|jpe?g|webp|db|sqlite)\b)/i;
const FORBIDDEN_STORAGE_KEY_PARTS = [
  'rawprompt',
  'rawresponse',
  'providerprompt',
  'providerresponse',
  'hiddenreasoning',
  'privatestoryplan',
  'privateplan',
  'sessionid',
  'artifactbody',
  'arbiterbody',
  'cardbody',
  'packetbody',
  'handbody',
  'guidancebody',
  'draftbody',
  'prosebody'
];
const PROVIDER_REASONING_STORAGE_KEYS = [
  'reasoning',
  'reasoningcontent',
  'reasoningdetails'
];
const SECRET_STORAGE_KEY_PARTS = [
  'apikey',
  'authorization',
  'cookie',
  'password',
  'secret',
  'sessionkey',
  'bearer',
  'privatekey',
  'credentials',
  'authheader'
];
const JOURNAL_EVENTS = new Set([
  'runtime.started',
  'runtime.stopped',
  DEFAULT_JOURNAL_EVENT,
  'activity.settled',
  'cache.hit',
  'cache.miss',
  'cache.invalidated',
  'card.generated',
  'card.rejected',
  'editorial.preflight.skipped',
  'editorial.run.settled',
  'hand.selected',
  'host.generation_stopped',
  'prompt.installed',
  'prompt.install_failed',
  'prompt.install_skipped',
  'prompt.cleared',
  'provider.call.started',
  'provider.call.completed',
  'provider.call.failed',
  'provider.capability.changed',
  'storage.repaired',
  'storage.pruned'
]);

export const SYSTEM_INDEX_KEY = 'recursion-system-index.v1.json';

export function runJournalKey(chatKey) {
  return `recursion-run-journal-${safeId(chatKey, 'chat')}.v1.json`;
}

export function pipelineRunKey(chatKey) {
  return `recursion-pipeline-run-${safeId(chatKey, 'chat')}.v2.json`;
}

export function pipelineArtifactKey(chatKey, operationId, artifactId) {
  return [
    'recursion-pipeline-artifact',
    safeId(chatKey, 'chat'),
    safeId(operationId, 'operation'),
    safeId(artifactId, 'artifact')
  ].join('-') + '.v2.json';
}

export function queuedReprocessKey(chatKey) {
  return `recursion-queued-reprocess-${safeId(chatKey, 'chat')}.v2.json`;
}

function resumeArtifactReferences(manifest) {
  const normalized = normalizePipelineRun(manifest);
  if (!normalized) return [];
  return Object.values(normalized.stageRecords)
    .map((record) => {
      const checkpoint = record?.checkpoint;
      const artifactRef = checkpoint?.artifactRef;
      if (!checkpoint || artifactRef?.kind !== 'logical-storage') return null;
      return {
        stageId: record.stageId,
        operationId: checkpoint.operationId || normalized.operationId,
        artifactId: artifactRef.artifactId || record.stageId,
        key: artifactRef.key,
        hash: checkpoint.outputHash || artifactRef.hash,
        artifactBytes: normalizeNonNegativeInteger(artifactRef.artifactBytes, 0)
      };
    })
    .filter(Boolean);
}

function retiredGeneratedKey(key) {
  return RETIRED_GENERATED_KEY_PATTERNS.some((pattern) => pattern.test(String(key || '')));
}

export function collectResumeArtifactReferences(manifest) {
  const normalized = normalizePipelineRun(manifest);
  if (!normalized || ['stale', 'abandoned'].includes(normalized.state)) return [];
  const references = resumeArtifactReferences(normalized);
  if (normalized.state !== 'completed' || normalized.phase !== 'postprocess') {
    return references;
  }
  const commitRecord = normalized.stageRecords['postprocess.host-commit'];
  const finalRewriteStageIds = Object.keys(commitRecord?.checkpoint?.dependencyHashes || {})
    .filter((stageId) => stageId.startsWith('postprocess.') && stageId.endsWith('.rewrite'));
  const retainedStageIds = new Set([
    'postprocess.host-commit',
    ...finalRewriteStageIds
  ]);
  return references.filter((reference) => retainedStageIds.has(reference.stageId));
}

export async function purgeTerminalResumeArtifacts({ repository, manifest } = {}) {
  const normalized = normalizePipelineRun(manifest);
  if (
    !normalized
    || normalized.state !== 'completed'
    || normalized.phase !== 'postprocess'
    || typeof repository?.deletePipelineArtifact !== 'function'
  ) {
    return {
      ok: true,
      deletedArtifactIds: [],
      retainedArtifactIds: collectResumeArtifactReferences(normalized)
        .map((reference) => reference.artifactId)
    };
  }
  const retained = collectResumeArtifactReferences(normalized);
  const retainedKeys = new Set(retained.map((reference) => reference.key));
  const disposable = resumeArtifactReferences(normalized)
    .filter((reference) => !retainedKeys.has(reference.key));
  const settled = await Promise.allSettled(disposable.map((reference) => (
    repository.deletePipelineArtifact(
      normalized.chatKey,
      reference.operationId,
      reference.artifactId
    )
  )));
  return {
    ok: settled.every((result) => (
      result.status === 'fulfilled' && result.value?.ok !== false
    )),
    deletedArtifactIds: disposable.map((reference) => reference.artifactId),
    retainedArtifactIds: retained.map((reference) => reference.artifactId)
  };
}

export function createMemoryStorageAdapter() {
  const files = new Map();
  return {
    async readJson(key) {
      return files.has(key) ? cloneJson(files.get(key)) : null;
    },
    async writeJson(key, value) {
      files.set(key, cloneJson(value));
      return { ok: true, key };
    },
    async deleteJson(key) {
      files.delete(key);
      return { ok: true, key };
    },
    dump() {
      return cloneJson(Object.fromEntries(files.entries()));
    }
  };
}

function isValidTimestampString(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function timestampValue(value, fallback = nowIso()) {
  return isValidTimestampString(value) ? value : fallback;
}

function baseRecord(recordType, extra = {}) {
  const now = nowIso();
  return {
    ...extra,
    recordType,
    schemaVersion: 1,
    createdAt: timestampValue(extra.createdAt, now),
    updatedAt: now,
    recursionVersion: RECURSION_VERSION
  };
}

function cloneJsonValue(value, fallback) {
  try {
    const cloned = cloneJson(value);
    return cloned === undefined ? fallback : cloned;
  } catch {
    return fallback;
  }
}

function sanitizedJsonValue(value, fallback, options = {}) {
  return redact(redactSecretText(cloneJsonValue(value, fallback)), options);
}

function stringValue(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && !Number.isFinite(value)) return fallback;
  if (['string', 'number', 'boolean', 'bigint'].includes(typeof value)) {
    const text = String(value);
    return text ? text : fallback;
  }
  return fallback;
}

function isUnsafeStorageText(value, { pathLike = true } = {}) {
  const text = stringValue(value, '');
  if (!text) return false;
  return OBJECT_COERCION_TEXT_PATTERN.test(text)
    || UNSAFE_JOURNAL_TEXT_PATTERN.test(text)
    || (pathLike && PATH_LIKE_TEXT_PATTERN.test(text));
}

function isUnsafeStorageKey(value) {
  const key = String(value ?? '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
  if (!key || key.endsWith('count')) return false;
  if (PROVIDER_REASONING_STORAGE_KEYS.includes(key)) return true;
  if (FORBIDDEN_STORAGE_KEY_PARTS.some((part) => key.includes(part))) return true;
  if (SECRET_STORAGE_KEY_PARTS.some((part) => key.includes(part))) return true;
  return key === 'token' || key.endsWith('tokenvalue') || key.endsWith('tokenheader');
}

function redactSecretText(value) {
  if (typeof value === 'string') {
    if (isUnsafeStorageText(value)) return '[redacted]';
    return value
      .replace(/\braw\s+(prompt|response)\s+body\b/gi, '[redacted]')
      .replace(/\bprovider\s+(prompt|response)\s+body\b/gi, '[redacted]')
      .replace(/\bhidden\s+reasoning\s+body\b/gi, '[redacted]')
      .replace(/\bprivate\s+(story\s+plan|plan\s+body)\b/gi, '[redacted]')
      .replace(/\bsession-id-value\b/gi, '[redacted]')
      .replace(/\bAuthorization\s+Bearer\s+[A-Za-z0-9._-]+/g, 'Authorization Bearer [redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
      .replace(/\bprivate[-_\s]*secret\b/gi, '[redacted]');
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecretText(entry));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    isUnsafeStorageKey(key) ? '[redacted]' : redactSecretText(entry)
  ]));
}

function optionalStringValue(value) {
  if (value === undefined || value === null) return undefined;
  const text = stringValue(value, '');
  return text || undefined;
}

function sanitizedTextValue(value, limit) {
  return stringValue(sanitizedJsonValue(value, '', { maxString: limit }), '').slice(0, limit);
}

function sanitizedOptionalTextValue(value, limit) {
  if (value === undefined || value === null || value === '') return undefined;
  return sanitizedTextValue(value, limit) || undefined;
}

function safeMetadataText(value, limit = 160, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  if (isUnsafeStorageText(value)) return fallback;
  const text = stringValue(value, '').slice(0, limit);
  return text || fallback;
}

function safeOptionalMetadataText(value, limit = 160) {
  const text = safeMetadataText(value, limit, '');
  return text || undefined;
}

function safeIdentifier(value, fallback = '') {
  const text = safeMetadataText(value, 160, '');
  if (!text) return fallback;
  const id = safeId(text, fallback || 'item');
  return id === 'item' && !fallback ? '' : id;
}

function safeMetadataList(value, limit = 160, max = 12) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => safeMetadataText(entry, limit, ''))
    .filter(Boolean)
    .slice(0, max);
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.round(number));
}

function normalizeMaxEntries(value) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) ? Math.max(1, Math.min(MAX_JOURNAL_ENTRIES, numeric)) : 1;
}

function normalizeNextIndex(value, fallback) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeJournalEvent(value) {
  const event = stringValue(value, '');
  return JOURNAL_EVENTS.has(event) ? event : DEFAULT_JOURNAL_EVENT;
}

function normalizeJournalSummary(value) {
  const summary = stringValue(sanitizedJsonValue(value, ''), '');
  return UNSAFE_JOURNAL_TEXT_PATTERN.test(summary) ? '[redacted]' : summary.slice(0, 300);
}

function safeJournalId(value) {
  const text = stringValue(value, '');
  return text && !UNSAFE_JOURNAL_TEXT_PATTERN.test(text) && !PATH_LIKE_TEXT_PATTERN.test(text)
    ? safeId(text, 'journal')
    : safeId(makeId('journal'), 'journal');
}

function optionalJournalString(value) {
  const text = optionalStringValue(value);
  return text && !UNSAFE_JOURNAL_TEXT_PATTERN.test(text) && !PATH_LIKE_TEXT_PATTERN.test(text) ? text : undefined;
}

function numberValue(value, fallback = 0, max = 100000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(max, Math.round(number)));
}

function safeJournalText(value, limit = 120) {
  const text = sanitizedTextValue(value, limit);
  return text === '[redacted]' ? '' : text;
}

function normalizeHandSelectedDetails(details) {
  const source = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  const cards = Array.isArray(source.cards)
    ? source.cards.map((card) => {
      const cardSource = card && typeof card === 'object' && !Array.isArray(card) ? card : {};
      return {
        id: safeJournalText(cardSource.id, 160),
        family: safeJournalText(cardSource.family, 80),
        role: safeJournalText(cardSource.role, 80),
        emphasis: safeJournalText(cardSource.emphasis, 40),
        detailProfile: safeJournalText(cardSource.detailProfile, 40),
        tokenEstimate: numberValue(cardSource.tokenEstimate, 0, 100000)
      };
    }).slice(0, 16)
    : [];
  return {
    handId: safeJournalText(source.handId, 160),
    selection: source.selection ? sanitizedJsonValue(source.selection, null, { maxString: 240 }) : null,
    selectedCount: numberValue(source.selectedCount, 0, 100000),
    omittedCount: numberValue(source.omittedCount, 0, 100000),
    guidanceStatus: safeJournalText(source.guidanceStatus, 80),
    guidanceFallbackReason: safeJournalText(source.guidanceFallbackReason, 180),
    guidanceInvalidSourceIdCount: numberValue(source.guidanceInvalidSourceIdCount, 0, 100000),
    guidanceSourceCardCount: numberValue(source.guidanceSourceCardCount, 0, 100000),
    guidanceGuardrailCardCount: numberValue(source.guidanceGuardrailCardCount, 0, 100000),
    guidanceOmittedCardCount: numberValue(source.guidanceOmittedCardCount, 0, 100000),
    listedCount: numberValue(source.listedCount, cards.length, 16),
    truncated: source.truncated === true,
    cards
  };
}

function normalizeJournalDetails(event, details) {
  if (details === undefined) return undefined;
  if (event === 'hand.selected') return normalizeHandSelectedDetails(details);
  return sanitizedJsonValue(details, undefined);
}

function normalizeJournalEntry(entry = {}) {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const severity = ['debug', 'info', 'warn', 'error'].includes(source.severity) ? source.severity : 'info';
  const event = normalizeJournalEvent(source.event);
  let details = normalizeJournalDetails(event, source.details);
  if (['warn', 'error'].includes(severity)) {
    const structuredDetails = details && typeof details === 'object' && !Array.isArray(details)
      ? details
      : {};
    const explicitFailure = structuredDetails.failure
      || structuredDetails.error
      || structuredDetails.compactError
      || (structuredDetails.code && structuredDetails.message ? structuredDetails : null);
    const cause = explicitFailure
      || structuredDetails.reason
      || structuredDetails.statusReason
      || structuredDetails.cautionReason;
    details = event === 'host.generation_stopped' && !explicitFailure ? {
      ...structuredDetails,
      reason: structuredDetails.reason || (structuredDetails.recursionRequested === true
        ? 'recursion-requested-stop' : 'host-stop-cause-unavailable')
    } : {
      ...structuredDetails,
      failure: failureFrom(cause, {
        code: 'RECURSION_JOURNAL_REASON_MISSING',
        stage: event,
        category: 'internal'
      })
    };
  }
  return redact({
    id: safeJournalId(source.id),
    recordedAt: timestampValue(source.recordedAt),
    severity,
    event,
    summary: normalizeJournalSummary(source.summary),
    runId: optionalJournalString(source.runId),
    sceneKey: optionalJournalString(source.sceneKey),
    details,
    hashes: sanitizedJsonValue(source.hashes, undefined),
    metrics: sanitizedJsonValue(source.metrics, undefined)
  });
}

function normalizeJournal(chatKey, value = {}, maxEntries = 100) {
  const source = value && typeof value === 'object' ? value : {};
  const limit = normalizeMaxEntries(maxEntries);
  const entries = Array.isArray(source.entries)
    ? source.entries
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map(normalizeJournalEntry)
      .slice(-limit)
    : [];
  return baseRecord('recursion.runJournal', {
    createdAt: source.createdAt,
    chatKey: safeId(chatKey, 'chat'),
    maxEntries: limit,
    nextIndex: Math.max(normalizeNextIndex(source.nextIndex, entries.length), entries.length),
    entries
  });
}

function normalizeIndex(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const records = {};
  if (source.records && typeof source.records === 'object' && !Array.isArray(source.records)) {
    for (const [fallbackKey, record] of Object.entries(source.records)) {
      const normalized = normalizeIndexRecord(fallbackKey, record);
      if (normalized) records[normalized.key] = normalized;
    }
  }
  return baseRecord('recursion.systemIndex', {
    createdAt: source.createdAt,
    records
  });
}

function normalizeIndexRecord(fallbackKey, value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = INDEX_KINDS.has(source.kind) ? source.kind : null;
  if (!kind) return null;
  const key = normalizeIndexKey(kind, source.key) || normalizeIndexKey(kind, fallbackKey);
  if (!key) return null;
  const base = {
    key,
    kind,
    chatKey: source.chatKey === undefined || source.chatKey === null ? null : safeId(source.chatKey, 'chat'),
    updatedAt: timestampValue(source.updatedAt)
  };
  if (kind === 'pipelineRun') {
    const operationId = safeIdentifier(source.operationId, '');
    return operationId ? { ...base, operationId } : null;
  }
  if (kind === 'pipelineArtifact') {
    const operationId = safeIdentifier(source.operationId, '');
    const artifactId = safeIdentifier(source.artifactId, '');
    if (!operationId || !artifactId) return null;
    return {
      ...base,
      operationId,
      artifactId,
      artifactBytes: normalizeNonNegativeInteger(source.artifactBytes, 0)
    };
  }
  return base;
}

function normalizeIndexKey(kind, value) {
  if (typeof value !== 'string' || !value || /[\\/]/.test(value)) return null;
  if (kind === 'runJournal') return RUN_JOURNAL_KEY_PATTERN.test(value) ? value : null;
  if (kind === 'pipelineRun') return PIPELINE_RUN_KEY_PATTERN.test(value) ? value : null;
  if (kind === 'pipelineArtifact') return PIPELINE_ARTIFACT_KEY_PATTERN.test(value) ? value : null;
  if (kind === 'queuedReprocess') return QUEUED_REPROCESS_KEY_PATTERN.test(value) ? value : null;
  if (kind === 'lastBrief') return LAST_BRIEF_KEY_PATTERN.test(value) ? value : null;
  if (kind === 'postProcessComparisons') return POST_PROCESS_COMPARISONS_PATTERN.test(value) ? value : null;
  return null;
}

function indexKindForKey(key) {
  if (RUN_JOURNAL_KEY_PATTERN.test(key)) return 'runJournal';
  if (PIPELINE_RUN_KEY_PATTERN.test(key)) return 'pipelineRun';
  if (PIPELINE_ARTIFACT_KEY_PATTERN.test(key)) return 'pipelineArtifact';
  if (QUEUED_REPROCESS_KEY_PATTERN.test(key)) return 'queuedReprocess';
  if (LAST_BRIEF_KEY_PATTERN.test(key)) return 'lastBrief';
  if (POST_PROCESS_COMPARISONS_PATTERN.test(key)) return 'postProcessComparisons';
  return null;
}

function isStorageObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function indexRecordFromStoredRecord(key, value) {
  const kind = indexKindForKey(key);
  if (!kind || !isStorageObject(value)) return null;
  if (kind === 'queuedReprocess' ? value.schemaVersion !== 2 : value.schemaVersion !== 1) return null;
  if (kind === 'runJournal') {
    if (value.recordType !== 'recursion.runJournal' || !Array.isArray(value.entries)) return null;
    const chatKey = safeIdentifier(value.chatKey, '');
    if (!chatKey) return null;
    return {
      key,
      kind,
      chatKey,
      updatedAt: timestampValue(value.updatedAt)
    };
  }
  if (kind === 'pipelineRun') {
    if (value.recordType !== 'recursion.pipelineRun') return null;
    const chatKey = safeIdentifier(value.chatKey, '');
    const operationId = safeIdentifier(value.operationId, '');
    const manifest = normalizePipelineRun(value.manifest);
    if (!chatKey || !operationId || !manifest || safeId(manifest.operationId, 'operation') !== operationId) {
      return null;
    }
    return {
      key,
      kind,
      chatKey,
      updatedAt: timestampValue(value.updatedAt),
      operationId
    };
  }
  if (kind === 'pipelineArtifact') {
    if (
      value.recordType !== 'recursion.pipelineArtifact'
      || !isStorageObject(value.artifact)
      || typeof value.artifactHash !== 'string'
    ) {
      return null;
    }
    const chatKey = safeIdentifier(value.chatKey, '');
    const operationId = safeIdentifier(value.operationId, '');
    const artifactId = safeIdentifier(value.artifactId, '');
    if (!chatKey || !operationId || !artifactId) return null;
    return {
      key,
      kind,
      chatKey,
      updatedAt: timestampValue(value.updatedAt),
      operationId,
      artifactId,
      artifactBytes: normalizeNonNegativeInteger(value.artifactBytes, 0)
    };
  }
  if (kind === 'queuedReprocess') {
    if (
      value.recordType !== 'recursion.queuedReprocess'
      || value.schema !== QUEUED_REPROCESS_ENVELOPE_SCHEMA
      || !normalizeQueuedReprocessEnvelope(value)
    ) {
      return null;
    }
    const chatKey = safeId(value.chatKey, '');
    if (!chatKey) return null;
    return {
      key,
      kind,
      chatKey,
      updatedAt: timestampValue(value.updatedAt)
    };
  }
  if (kind === 'postProcessComparisons') {
    if (value.recordType !== 'recursion.postProcessComparisons' || !Array.isArray(value.records) || !safeIdentifier(value.chatKey, '')) return null;
    return { key, kind, chatKey: safeIdentifier(value.chatKey, ''), updatedAt: timestampValue(value.updatedAt) };
  }
  if (kind === 'lastBrief') {
    if (
      value.recordType !== 'recursion.lastBrief'
      || value.schema !== LAST_BRIEF_SCHEMA
    ) {
      return null;
    }
    const brief = normalizeLastBriefRecord(value);
    const chatKey = safeIdentifier(value.chatKey, '');
    if (!brief || !chatKey || brief.chatKey !== chatKey) return null;
    return {
      key,
      kind,
      chatKey,
      updatedAt: timestampValue(value.updatedAt)
    };
  }
  return null;
}

function sameIndexRecord(left, right) {
  if (!left || !right) return false;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.every((key) => left[key] === right[key]);
}

function rawIndexRequiresRewrite(rawIndex, normalizedIndex) {
  if (rawIndex === null) return false;
  if (!isStorageObject(rawIndex)) return true;
  if (rawIndex.recordType !== 'recursion.systemIndex' || rawIndex.schemaVersion !== 1) return true;
  if (!isValidTimestampString(rawIndex.createdAt) || !isValidTimestampString(rawIndex.updatedAt)) return true;
  if (!isStorageObject(rawIndex.records)) return true;
  if (Object.keys(rawIndex.records).length !== Object.keys(normalizedIndex.records).length) return true;
  for (const [key, record] of Object.entries(normalizedIndex.records)) {
    const rawRecord = rawIndex.records[key];
    if (!rawRecord || !sameIndexRecord(rawRecord, record)) return true;
    if (Object.keys(rawRecord).sort().join('|') !== Object.keys(record).sort().join('|')) return true;
  }
  return false;
}

function rawIndexPrunedDiagnostics(rawIndex) {
  if (!isStorageObject(rawIndex) || !isStorageObject(rawIndex.records)) return [];
  const pruned = [];
  for (const [fallbackKey, record] of Object.entries(rawIndex.records)) {
    if (normalizeIndexRecord(fallbackKey, record)) continue;
    pruned.push(repairDiagnostic('index-removed', {
      kind: isStorageObject(record) ? record.kind : 'unknown',
      reason: 'invalid-index-record'
    }));
  }
  return pruned;
}

function normalizeStorageKeyList(value) {
  return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : null;
}

function retiredGeneratedKeysFromRawIndex(value) {
  if (!isStorageObject(value) || !isStorageObject(value.records)) return [];
  const keys = new Set();
  for (const [fallbackKey, record] of Object.entries(value.records)) {
    for (const candidate of [fallbackKey, isStorageObject(record) ? record.key : null]) {
      if (typeof candidate === 'string' && retiredGeneratedKey(candidate)) keys.add(candidate);
    }
  }
  return [...keys];
}

async function discoverStorageKeys(storage) {
  if (typeof storage.listJsonKeys === 'function') {
    return normalizeStorageKeyList(await storage.listJsonKeys());
  }
  if (typeof storage.listKeys === 'function') {
    return normalizeStorageKeyList(await storage.listKeys());
  }
  if (typeof storage.dump === 'function') {
    const dumped = storage.dump();
    return dumped && typeof dumped === 'object' && !Array.isArray(dumped) ? Object.keys(dumped) : null;
  }
  return null;
}

function repairDiagnostic(action, entry) {
  return redactSecretText(redact({
    action,
    kind: INDEX_KINDS.has(entry?.kind) ? entry.kind : 'unknown',
    chatKey: safeOptionalMetadataText(entry?.chatKey, 160),
    reason: safeOptionalMetadataText(entry?.reason, 80)
  }));
}

function summarizeByField(entries, field) {
  return entries.reduce((counts, entry) => {
    const key = safeMetadataText(entry?.[field], 80, 'unknown');
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function cleanupJournalEvents(repaired, pruned) {
  const events = [];
  if (repaired.length > 0) {
    events.push(normalizeJournalEntry({
      event: 'storage.repaired',
      severity: 'info',
      summary: 'Storage index repaired.',
      details: {
        repairedCount: repaired.length,
        kinds: summarizeByField(repaired, 'kind')
      }
    }));
  }
  if (pruned.length > 0) {
    events.push(normalizeJournalEntry({
      event: 'storage.pruned',
      severity: 'info',
      summary: 'Storage index pruned.',
      details: {
        prunedCount: pruned.length,
        kinds: summarizeByField(pruned, 'kind'),
        reasons: summarizeByField(pruned, 'reason')
      }
    }));
  }
  return events;
}


function reportActivity(activity, event) {
  try {
    const result = activity?.stage?.(event);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // Activity reporting must never block storage persistence.
  }
}

function storageWriteStatus(result) {
  const source = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  if (source.ok === false) {
    return {
      persisted: false,
      reason: 'write-failed'
    };
  }
  if (Object.prototype.hasOwnProperty.call(source, 'fallback')
    && source.fallback !== undefined
    && source.fallback !== null
    && source.fallback !== '') {
    const fallback = safeOptionalMetadataText(source.fallback, 80) || 'unknown';
    return {
      persisted: false,
      fallback,
      reason: safeOptionalMetadataText(source.reason, 120) || 'memory-fallback',
      ...(safeOptionalMetadataText(source.fallbackReason, 240)
        ? { fallbackReason: safeOptionalMetadataText(source.fallbackReason, 240) }
        : {})
    };
  }
  return { persisted: true };
}

function combineStorageStatuses(...statuses) {
  return statuses.find((status) => status?.persisted === false) || { persisted: true };
}

function attachStorageStatus(record, status) {
  if (status?.persisted === false) {
    return {
      ...record,
      storageStatus: status
    };
  }
  return record;
}

function reportStorageWriteStatus(activity, operationId, status, detail = {}) {
  if (status?.persisted !== false) {
    reportActivity(activity, {
      operationId,
      phase: 'storageProgress',
      logicalStage: 'Storage ready',
      mode: 'background',
      severity: 'success',
      label: 'Storage ready.',
      detail
    });
    return;
  }
  const warningReason = status.fallbackReason || status.reason;
  reportActivity(activity, {
    operationId,
    phase: 'storageWarning',
    logicalStage: 'Storage fallback',
    mode: 'background',
    severity: 'warning',
    label: warningReason
      ? `Recursion storage warning: ${warningReason}`
      : 'Recursion storage warning; continuing in memory.',
    chips: ['Storage'],
    detail: {
      ...detail,
      persisted: false,
      fallback: status.fallback,
      reason: status.reason,
      ...(status.fallbackReason ? { fallbackReason: status.fallbackReason } : {})
    }
  });
}

export function createStorageRepository({
  storage = createMemoryStorageAdapter(),
  maxJournalEntries = 100,
  activity = null,
  getRetentionSettings = null
} = {}) {
  const fallbackJournalEntryLimit = normalizeMaxEntries(maxJournalEntries);
  const comparisonStore = createPostProcessComparisonStore({
    storage, onWrite: (key, chatKey) => writeIndexEntry(key, 'postProcessComparisons', chatKey),
    onDelete: (key) => removeIndexEntry(key)
  });

  function currentRetention() {
    if (typeof getRetentionSettings === 'function') {
      try {
        return normalizeRetentionSettings(getRetentionSettings());
      } catch {
        return normalizeRetentionSettings({});
      }
    }
    return {
      ...normalizeRetentionSettings({}),
      runJournalEntries: fallbackJournalEntryLimit
    };
  }

  async function writeIndexEntry(key, kind, chatKey = null, metadata = {}) {
    const index = normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    const record = normalizeIndexRecord(key, {
      key,
      kind,
      chatKey,
      updatedAt: nowIso(),
      ...metadata
    });
    if (!record) throw new TypeError('Storage index entry is invalid.');
    index.records[key] = record;
    index.updatedAt = nowIso();
    return storage.writeJson(SYSTEM_INDEX_KEY, index);
  }

  async function writeAuxiliaryIndexEntry(key, kind, chatKey = null, metadata = {}) {
    try {
      return storageWriteStatus(await writeIndexEntry(key, kind, chatKey, metadata));
    } catch {
      return { persisted: false };
    }
  }

  async function removeIndexEntry(key) {
    const index = normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    if (!index.records[key]) return;
    delete index.records[key];
    index.updatedAt = nowIso();
    await storage.writeJson(SYSTEM_INDEX_KEY, index);
  }

  async function readRepairRecord(key) {
    try {
      const value = await storage.readJson(key);
      if (value && POST_PROCESS_COMPARISONS_PATTERN.test(key)) {
        if (value.recordType !== 'recursion.postProcessComparisons' || value.schemaVersion !== 1
          || !Array.isArray(value.records) || key !== postProcessComparisonsKey(value.chatKey)) {
          const result = await storage.deleteJson(key);
          if (result?.ok === false) return { ok: false };
          return { ok: true, value: null };
        }
        return { ok: true, value: await comparisonStore.repairPostProcessComparisons(value.chatKey) };
      }
      return { ok: true, value };
    } catch {
      return { ok: false };
    }
  }

  async function repairIndex() {
    const rawIndex = await storage.readJson(SYSTEM_INDEX_KEY);
    const existingIndex = normalizeIndex(rawIndex);
    const desiredRecords = {};
    const repaired = [];
    const pruned = rawIndexPrunedDiagnostics(rawIndex);
    const skipped = [];
    const discoveredKeys = await discoverStorageKeys(storage);
    const discoveredKeySet = discoveredKeys ? new Set(discoveredKeys) : null;
    const unreadableKeys = new Set();

    if (discoveredKeySet) {
      for (const key of [...discoveredKeySet].sort()) {
        const kind = indexKindForKey(key);
        if (!kind) continue;
        const read = await readRepairRecord(key);
        if (!read.ok) {
          unreadableKeys.add(key);
          skipped.push(repairDiagnostic('index-skipped', { kind, reason: 'read-failed' }));
          continue;
        }
        const record = indexRecordFromStoredRecord(key, read.value);
        if (record) desiredRecords[key] = record;
      }

      for (const [key, record] of Object.entries(existingIndex.records)) {
        if (desiredRecords[key]) continue;
        if (unreadableKeys.has(key)) {
          desiredRecords[key] = record;
          continue;
        }
        pruned.push(repairDiagnostic('index-removed', {
          ...record,
          reason: discoveredKeySet.has(key) ? 'invalid-record' : 'missing-record'
        }));
      }

      for (const [key, record] of Object.entries(desiredRecords)) {
        if (!sameIndexRecord(existingIndex.records[key], record)) {
          repaired.push(repairDiagnostic(existingIndex.records[key] ? 'index-updated' : 'index-added', record));
        }
      }
    } else {
      for (const [key, record] of Object.entries(existingIndex.records)) {
        const read = await readRepairRecord(key);
        if (!read.ok) {
          desiredRecords[key] = record;
          skipped.push(repairDiagnostic('index-skipped', { ...record, reason: 'read-failed' }));
          continue;
        }
        if (!read.value) {
          pruned.push(repairDiagnostic('index-removed', { ...record, reason: 'missing-record' }));
          continue;
        }
        const validRecord = indexRecordFromStoredRecord(key, read.value);
        if (!validRecord) {
          pruned.push(repairDiagnostic('index-removed', { ...record, reason: 'invalid-record' }));
          continue;
        }
        desiredRecords[key] = validRecord;
        if (!sameIndexRecord(record, validRecord)) {
          repaired.push(repairDiagnostic('index-updated', validRecord));
        }
      }
    }

    const manifestsByChat = new Map();
    const unreadableManifestChats = new Set();
    for (const runRecord of Object.values(desiredRecords)) {
      if (runRecord.kind !== 'pipelineRun') continue;
      const read = await readRepairRecord(runRecord.key);
      if (!read.ok) {
        unreadableManifestChats.add(runRecord.chatKey);
        continue;
      }
      const manifest = normalizePipelineRun(read.value?.manifest);
      if (manifest) manifestsByChat.set(runRecord.chatKey, manifest);
    }
    for (const artifactRecord of Object.values({ ...desiredRecords })) {
      if (artifactRecord.kind !== 'pipelineArtifact') continue;
      if (unreadableManifestChats.has(artifactRecord.chatKey)) continue;
      const manifest = manifestsByChat.get(artifactRecord.chatKey);
      const ownsCurrentOperation = manifest?.operationId === artifactRecord.operationId;
      const nonterminalCurrentOperation = ownsCurrentOperation
        && ['running', 'paused'].includes(manifest.state);
      const referencedKeys = ownsCurrentOperation
        ? new Set(collectResumeArtifactReferences(manifest).map((reference) => reference.key))
        : new Set();
      if (nonterminalCurrentOperation || referencedKeys.has(artifactRecord.key)) continue;
      try {
        await storage.deleteJson(artifactRecord.key);
        delete desiredRecords[artifactRecord.key];
        pruned.push(repairDiagnostic('pipeline-artifact-deleted', {
          kind: 'pipelineArtifact',
          chatKey: artifactRecord.chatKey,
          reason: 'orphaned-pipeline-artifact'
        }));
      } catch {
        skipped.push(repairDiagnostic('index-skipped', {
          kind: 'pipelineArtifact',
          chatKey: artifactRecord.chatKey,
          reason: 'delete-failed'
        }));
      }
    }

    if (rawIndex === null || rawIndexRequiresRewrite(rawIndex, existingIndex) || repaired.length > 0 || pruned.length > 0) {
      const nextIndex = normalizeIndex({
        createdAt: existingIndex.createdAt,
        records: desiredRecords
      });
      nextIndex.updatedAt = nowIso();
      await storage.writeJson(SYSTEM_INDEX_KEY, nextIndex);
    }

    return {
      ok: true,
      repaired,
      pruned,
      skipped,
      journalEvents: cleanupJournalEvents(repaired, pruned),
      discovery: {
        available: Boolean(discoveredKeySet),
        recordCount: Object.keys(desiredRecords).length
      }
    };
  }


  async function loadRunJournal(chatKey) {
    const key = runJournalKey(chatKey);
    return normalizeJournal(chatKey, await storage.readJson(key), currentRetention().runJournalEntries);
  }

  async function appendJournal(chatKey, entry) {
    const key = runJournalKey(chatKey);
    const journal = await loadRunJournal(chatKey);
    const clean = normalizeJournalEntry(entry);
    journal.entries.push(clean);
    journal.entries = journal.entries.slice(-journal.maxEntries);
    journal.nextIndex += 1;
    journal.updatedAt = nowIso();
    await storage.writeJson(key, journal);
    await writeIndexEntry(key, 'runJournal', safeId(chatKey, 'chat'));
    return clean;
  }

  async function loadLastBrief(chatKey) {
    const key = lastBriefKey(chatKey);
    const record = await storage.readJson(key);
    if (
      !isStorageObject(record)
      || record.recordType !== 'recursion.lastBrief'
      || record.schema !== LAST_BRIEF_SCHEMA
      || record.schemaVersion !== 1
      || record.chatKey !== safeId(chatKey, 'chat')
    ) {
      return null;
    }
    return normalizeLastBriefRecord(record);
  }

  async function saveLastBrief(chatKey, value) {
    const normalized = normalizeLastBriefRecord({
      ...(isStorageObject(value) ? value : {}),
      chatKey: safeId(chatKey, 'chat')
    });
    if (!normalized) throw new TypeError('Last Brief record requires a turn key.');
    const key = lastBriefKey(chatKey);
    const record = baseRecord('recursion.lastBrief', normalized);
    const writeResult = await storage.writeJson(key, record);
    if (storageWriteStatus(writeResult).persisted === false) {
      throw new Error('Last Brief write failed.');
    }
    const persisted = normalizeLastBriefRecord(await storage.readJson(key));
    if (!persisted || await stableHash(persisted) !== await stableHash(normalized)) {
      throw new Error('Last Brief write verification failed.');
    }
    await writeAuxiliaryIndexEntry(key, 'lastBrief', safeId(chatKey, 'chat'));
    return normalized;
  }

  async function clearLastBrief(chatKey) {
    const key = lastBriefKey(chatKey);
    const deleted = await storage.deleteJson(key);
    if (deleted?.ok !== false) await removeIndexEntry(key);
    return {
      ok: deleted?.ok !== false,
      key,
      deleted: deleted?.ok !== false
    };
  }

  async function loadPipelineArtifact(chatKey, operationId, artifactId) {
    const key = pipelineArtifactKey(chatKey, operationId, artifactId);
    const record = await storage.readJson(key);
    if (
      !isStorageObject(record)
      || record.recordType !== 'recursion.pipelineArtifact'
      || record.schemaVersion !== 1
      || record.chatKey !== safeId(chatKey, 'chat')
      || record.operationId !== safeId(operationId, 'operation')
      || record.artifactId !== safeId(artifactId, 'artifact')
      || !isStorageObject(record.artifact)
      || typeof record.artifactHash !== 'string'
    ) {
      return null;
    }
    const artifact = cloneJsonValue(record.artifact, null);
    if (!artifact || await stableHash(artifact) !== record.artifactHash) return null;
    return artifact;
  }

  async function savePipelineArtifact(chatKey, operationId, artifactId, artifact) {
    const key = pipelineArtifactKey(chatKey, operationId, artifactId);
    const artifactBody = cloneJsonValue(artifact, null);
    if (!isStorageObject(artifactBody)) {
      throw new TypeError('Pipeline artifacts must be JSON objects.');
    }
    const artifactHash = await stableHash(artifactBody);
    const artifactBytes = new TextEncoder().encode(JSON.stringify(artifactBody)).byteLength;
    const record = baseRecord('recursion.pipelineArtifact', {
      chatKey: safeId(chatKey, 'chat'),
      operationId: safeId(operationId, 'operation'),
      artifactId: safeId(artifactId, 'artifact'),
      artifactHash,
      artifactBytes,
      artifact: artifactBody
    });
    const writeResult = await storage.writeJson(key, record);
    if (storageWriteStatus(writeResult).persisted === false) {
      throw new Error('Pipeline artifact write failed.');
    }
    const persistedRecord = await storage.readJson(key);
    if (
      !persistedRecord
      || persistedRecord.artifactHash !== artifactHash
      || await stableHash(persistedRecord.artifact) !== artifactHash
    ) {
      throw new Error('Pipeline artifact write verification failed.');
    }
    await writeAuxiliaryIndexEntry(key, 'pipelineArtifact', safeId(chatKey, 'chat'), {
      operationId: safeId(operationId, 'operation'),
      artifactId: safeId(artifactId, 'artifact'),
      artifactBytes
    });
    return {
      kind: 'logical-storage',
      key,
      hash: artifactHash,
      artifactBytes,
      operationId: safeId(operationId, 'operation'),
      artifactId: safeId(artifactId, 'artifact')
    };
  }

  async function loadPipelineRun(chatKey) {
    const key = pipelineRunKey(chatKey);
    const record = await storage.readJson(key);
    if (
      !isStorageObject(record)
      || record.recordType !== 'recursion.pipelineRun'
      || record.schemaVersion !== 1
      || record.chatKey !== safeId(chatKey, 'chat')
    ) {
      return null;
    }
    return normalizePipelineRun(record.manifest);
  }

  async function savePipelineRun(chatKey, manifest) {
    const normalized = normalizePipelineRun(manifest);
    if (!normalized || safeId(normalized.chatKey, 'chat') !== safeId(chatKey, 'chat')) {
      throw new TypeError('Pipeline manifest does not match the requested chat.');
    }
    const key = pipelineRunKey(chatKey);
    const record = baseRecord('recursion.pipelineRun', {
      chatKey: safeId(chatKey, 'chat'),
      operationId: safeId(normalized.operationId, 'operation'),
      manifest: normalized
    });
    const writeResult = await storage.writeJson(key, record);
    if (storageWriteStatus(writeResult).persisted === false) {
      throw new Error('Pipeline manifest write failed.');
    }
    const persistedManifest = normalizePipelineRun((await storage.readJson(key))?.manifest);
    if (!persistedManifest || await stableHash(persistedManifest) !== await stableHash(normalized)) {
      throw new Error('Pipeline manifest write verification failed.');
    }
    await writeAuxiliaryIndexEntry(key, 'pipelineRun', safeId(chatKey, 'chat'), {
      operationId: safeId(normalized.operationId, 'operation')
    });
    return normalized;
  }

  async function loadQueuedReprocessEnvelope(chatKey) {
    const key = queuedReprocessKey(chatKey);
    const record = await storage.readJson(key);
    if (
      !isStorageObject(record)
      || record.recordType !== 'recursion.queuedReprocess'
      || record.schemaVersion !== 2
      || record.schema !== QUEUED_REPROCESS_ENVELOPE_SCHEMA
      || record.chatKey !== String(chatKey || '').trim()
    ) {
      return null;
    }
    return normalizeQueuedReprocessEnvelope(record);
  }

  async function loadQueuedReprocess(chatKey, phase = 'preprocess') {
    const envelope = await loadQueuedReprocessEnvelope(chatKey);
    return envelope?.[phase === 'postprocess' ? 'postprocess' : 'preprocess'] || null;
  }

  async function saveQueuedReprocess(chatKey, intent) {
    const normalized = normalizeQueuedReprocess(intent);
    if (!normalized) throw new TypeError('Queued reprocess intent is invalid.');
    const normalizedChatKey = String(chatKey || '').trim();
    if (!normalizedChatKey || normalized.chatKey !== normalizedChatKey) {
      throw new TypeError('Queued reprocess chat binding does not match the storage key.');
    }
    const key = queuedReprocessKey(chatKey);
    const existing = await loadQueuedReprocessEnvelope(chatKey);
    const envelope = normalizeQueuedReprocessEnvelope({
      schema: QUEUED_REPROCESS_ENVELOPE_SCHEMA,
      chatKey: normalizedChatKey,
      preprocess: normalized.phase === 'preprocess' ? normalized : existing?.preprocess || null,
      postprocess: normalized.phase === 'postprocess' ? normalized : existing?.postprocess || null
    });
    const record = {
      ...baseRecord('recursion.queuedReprocess', envelope),
      schemaVersion: 2
    };
    const writeResult = await storage.writeJson(key, record);
    if (storageWriteStatus(writeResult).persisted === false) {
      throw new Error('Queued reprocess write failed.');
    }
    const persistedIntent = (await loadQueuedReprocessEnvelope(chatKey))?.[normalized.phase] || null;
    if (!persistedIntent || await stableHash(persistedIntent) !== await stableHash(normalized)) {
      throw new Error('Queued reprocess write verification failed.');
    }
    await writeAuxiliaryIndexEntry(key, 'queuedReprocess', safeId(chatKey, 'chat'));
    return normalized;
  }

  async function clearPipelineRun(chatKey) {
    const key = pipelineRunKey(chatKey);
    const deleted = await storage.deleteJson(key);
    await removeIndexEntry(key);
    return { ok: deleted?.ok !== false, key };
  }

  async function clearQueuedReprocess(chatKey, phase = null) {
    const key = queuedReprocessKey(chatKey);
    if (phase === 'preprocess' || phase === 'postprocess') {
      const existing = await loadQueuedReprocessEnvelope(chatKey);
      if (!existing) return { ok: true, key };
      const next = normalizeQueuedReprocessEnvelope({
        ...existing,
        [phase]: null
      });
      if (next?.preprocess || next?.postprocess) {
        const record = {
          ...baseRecord('recursion.queuedReprocess', next),
          schemaVersion: 2
        };
        const writeResult = await storage.writeJson(key, record);
        if (storageWriteStatus(writeResult).persisted === false) {
          throw new Error('Queued reprocess clear failed.');
        }
        await writeAuxiliaryIndexEntry(key, 'queuedReprocess', safeId(chatKey, 'chat'));
        return { ok: true, key };
      }
    }
    const deleted = await storage.deleteJson(key);
    await removeIndexEntry(key);
    return { ok: deleted?.ok !== false, key };
  }

  async function clearPipelineArtifacts(chatKey, operationId = null) {
    await repairIndex();
    const index = normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    const safeChatKey = safeId(chatKey, 'chat');
    const safeOperationId = operationId === null ? null : safeId(operationId, 'operation');
    const keys = Object.values(index.records)
      .filter((record) => (
        record.kind === 'pipelineArtifact'
        && record.chatKey === safeChatKey
        && (safeOperationId === null || record.operationId === safeOperationId)
      ))
      .map((record) => record.key);
    for (const key of keys) {
      await storage.deleteJson(key);
      delete index.records[key];
    }
    if (keys.length > 0) {
      index.updatedAt = nowIso();
      await storage.writeJson(SYSTEM_INDEX_KEY, index);
    }
    return { ok: true, deletedKeys: keys };
  }

  async function deletePipelineArtifact(chatKey, operationId, artifactId) {
    const key = pipelineArtifactKey(chatKey, operationId, artifactId);
    const deleted = await storage.deleteJson(key);
    await removeIndexEntry(key);
    return {
      ok: deleted?.ok !== false,
      key,
      deleted: deleted?.ok !== false
    };
  }

  async function clearPipelineExecution(chatKey) {
    const artifacts = await clearPipelineArtifacts(chatKey);
    const manifest = await clearPipelineRun(chatKey);
    const queued = await clearQueuedReprocess(chatKey);
    const comparisons = await comparisonStore.clearPostProcessComparisons(chatKey);
    return {
      ok: artifacts.ok && manifest.ok && queued.ok && comparisons.ok,
      comparisons,
      artifacts,
      manifest,
      queued
    };
  }

  async function revokeTurnExecution(chatKey, options = {}) {
    const source = isStorageObject(options) ? options : {};
    const safeChatKey = safeId(chatKey, 'chat');
    const operationId = safeId(source.operationId, 'operation');
    const manifest = await loadPipelineRun(chatKey);
    if (!manifest) {
      return {
        ok: false,
        revoked: false,
        eligibilityRevoked: false,
        reason: 'missing-manifest',
        cleanupFailures: []
      };
    }
    if (safeId(manifest.operationId, 'operation') !== operationId) {
      return {
        ok: false,
        revoked: false,
        eligibilityRevoked: false,
        reason: 'operation-mismatch',
        cleanupFailures: []
      };
    }

    await repairIndex();
    const index = normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    const artifactTargets = Object.values(index.records)
      .filter((record) => (
        record.kind === 'pipelineArtifact'
        && record.chatKey === safeChatKey
        && record.operationId === operationId
      ))
      .map((record) => ({ key: record.key, kind: 'pipelineArtifact' }));
    const reason = safeMetadataText(source.reason, 120, 'revoked');
    try {
      await savePipelineRun(chatKey, {
        ...manifest,
        revision: normalizeNonNegativeInteger(manifest.revision) + 1,
        state: 'abandoned',
        pauseReason: `revoked:${reason}`.slice(0, 180),
        updatedAt: nowIso()
      });
    } catch {
      return {
        ok: false,
        revoked: false,
        eligibilityRevoked: false,
        reason: 'revoke-write-failed',
        cleanupFailures: [{ kind: 'pipelineRun', reason: 'revoke-write-failed' }]
      };
    }

    const targets = [
      ...artifactTargets,
      { key: pipelineRunKey(chatKey), kind: 'pipelineRun' },
      { key: queuedReprocessKey(chatKey), kind: 'queuedReprocess' }
    ];
    const cleanupFailures = [];
    const deletedKeys = [];
    for (const target of targets) {
      try {
        const deleted = await storage.deleteJson(target.key);
        if (deleted?.ok === false) {
          cleanupFailures.push({ kind: target.kind, reason: 'delete-failed' });
          continue;
        }
        deletedKeys.push(target.key);
        delete index.records[target.key];
      } catch {
        cleanupFailures.push({ kind: target.kind, reason: 'delete-failed' });
      }
    }
    if (deletedKeys.length > 0) {
      index.updatedAt = nowIso();
      try {
        const indexWrite = await storage.writeJson(SYSTEM_INDEX_KEY, index);
        if (storageWriteStatus(indexWrite).persisted === false) {
          cleanupFailures.push({ kind: 'systemIndex', reason: 'write-failed' });
        }
      } catch {
        cleanupFailures.push({ kind: 'systemIndex', reason: 'write-failed' });
      }
    }
    const boundedFailures = cleanupFailures.slice(0, 3);
    return {
      ok: cleanupFailures.length === 0,
      revoked: true,
      eligibilityRevoked: true,
      operationId,
      reason,
      deletedKeys,
      cleanupFailures: boundedFailures,
      cleanupFailureCount: cleanupFailures.length
    };
  }

  async function pruneRetiredGeneratedRecords() {
    const rawIndex = await storage.readJson(SYSTEM_INDEX_KEY);
    const indexedRetiredKeys = retiredGeneratedKeysFromRawIndex(rawIndex);
    const repair = await repairIndex();
    const index = normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    const discoveredKeys = await discoverStorageKeys(storage);
    const retiredKeys = new Set([
      ...indexedRetiredKeys,
      ...Object.values(index.records)
        .filter((record) => record.kind === 'sceneCache')
        .map((record) => record.key),
      ...(discoveredKeys || []).filter(retiredGeneratedKey)
    ]);
    const deletedKeys = [];
    const cleanupFailures = [];
    for (const key of [...retiredKeys].sort()) {
      try {
        const deleted = await storage.deleteJson(key);
        if (deleted?.ok === false) {
          cleanupFailures.push({ kind: 'sceneCache', reason: 'delete-failed' });
          continue;
        }
        deletedKeys.push(key);
        delete index.records[key];
      } catch {
        cleanupFailures.push({ kind: 'sceneCache', reason: 'delete-failed' });
      }
    }
    if (deletedKeys.length > 0) {
      index.updatedAt = nowIso();
      try {
        const indexWrite = await storage.writeJson(SYSTEM_INDEX_KEY, index);
        if (storageWriteStatus(indexWrite).persisted === false) {
          cleanupFailures.push({ kind: 'systemIndex', reason: 'write-failed' });
        }
      } catch {
        cleanupFailures.push({ kind: 'systemIndex', reason: 'write-failed' });
      }
    }
    return {
      ok: cleanupFailures.length === 0,
      deletedKeys,
      cleanupFailures: cleanupFailures.slice(0, 3),
      cleanupFailureCount: cleanupFailures.length,
      repaired: repair.repaired,
      skipped: repair.skipped
    };
  }

  async function prunePipelineExecution() {
    const repair = await repairIndex();
    const index = normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    const pruned = [];
    for (const runRecord of Object.values(index.records)) {
      if (runRecord.kind !== 'pipelineRun') continue;
      const stored = await storage.readJson(runRecord.key);
      const manifest = normalizePipelineRun(stored?.manifest);
      if (!manifest || manifest.state !== 'abandoned') continue;
      const artifactRecords = Object.values(index.records).filter((record) => (
        record.kind === 'pipelineArtifact'
        && record.chatKey === runRecord.chatKey
        && record.operationId === runRecord.operationId
      ));
      for (const artifactRecord of artifactRecords) {
        await storage.deleteJson(artifactRecord.key);
        delete index.records[artifactRecord.key];
        pruned.push(repairDiagnostic('pipeline-artifact-deleted', {
          kind: 'pipelineArtifact',
          chatKey: artifactRecord.chatKey,
          reason: 'operation-abandoned'
        }));
      }
      await storage.deleteJson(runRecord.key);
      delete index.records[runRecord.key];
      pruned.push(repairDiagnostic('pipeline-run-deleted', {
        kind: 'pipelineRun',
        chatKey: runRecord.chatKey,
        reason: 'operation-abandoned'
      }));
    }
    if (pruned.length > 0) {
      index.updatedAt = nowIso();
      await storage.writeJson(SYSTEM_INDEX_KEY, index);
    }
    return {
      ok: true,
      repaired: repair.repaired,
      pruned,
      skipped: repair.skipped,
      journalEvents: [...repair.journalEvents, ...cleanupJournalEvents([], pruned)]
    };
  }

  return {
    ...comparisonStore,
    loadRunJournal,
    async clearRunJournal(chatKey) {
      const key = runJournalKey(chatKey);
      const deleted = await storage.deleteJson(key);
      await removeIndexEntry(key);
      return { ok: deleted?.ok !== false, key, deleted: deleted?.ok !== false };
    },
    appendJournal,
    loadLastBrief,
    saveLastBrief,
    clearLastBrief,
    loadPipelineArtifact,
    savePipelineArtifact,
    loadPipelineRun,
    savePipelineRun,
    loadQueuedReprocessEnvelope,
    loadQueuedReprocess,
    saveQueuedReprocess,
    clearPipelineRun,
    clearPipelineArtifacts,
    deletePipelineArtifact,
    clearQueuedReprocess,
    clearPipelineExecution,
    revokeTurnExecution,
    pruneRetiredGeneratedRecords,
    prunePipelineExecution,
    repairIndex,
    maintainRetention: prunePipelineExecution,
    async readIndex() {
      return normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    }
  };
}
