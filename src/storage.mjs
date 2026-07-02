import { cloneJson, makeId, nowIso, redact, safeId } from './core.mjs';

const RECURSION_VERSION = '0.1.0-pre-alpha.1';
const MAX_JOURNAL_ENTRIES = 500;
const DEFAULT_MAX_SCENE_CACHES_PER_CHAT = 3;
const DEFAULT_MAX_SCENE_CACHES_TOTAL = 24;
const SCENE_CACHE_KEY_PATTERN = /^recursion-scene-[A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+\.v1\.json$/;
const RUN_JOURNAL_KEY_PATTERN = /^recursion-run-journal-[A-Za-z0-9_.-]+\.v1\.json$/;
const DEFAULT_JOURNAL_EVENT = 'activity.stage_changed';
const UNSAFE_JOURNAL_TEXT_PATTERN = /\b(raw[-_\s]*prompt|rawPrompt|raw[-_\s]*response|rawResponse|provider[-_\s]*prompt|providerPrompt|provider[-_\s]*response|providerResponse|hidden[-_\s]*reasoning|hiddenReasoning|private[-_\s]*story[-_\s]*plan|privateStoryPlan|private[-_\s]*plan|privatePlan|session[-_\s]*id|sessionId|session[-_\s]*key\s*[:=]|sessionKey\s*[:=]|session[-_\s]*token|credentials?|password\s*[:=]|token\s*[:=]|api[-_\s]*key\s*[:=]|apiKey\s*[:=]|authorization\s*[:=]|set-cookie\s*[:=]|cookie\s*[:=]|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;
const PATH_LIKE_TEXT_PATTERN = /(^|[\s"'`=:(\[])(?:[A-Za-z]:[\\/]|\\\\|\/\/|\.{1,2}[\\/]|\/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/-]*|[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/-]*\.(?:jsonl?|mjs|js|css|md|txt|png|jpe?g|webp|db|sqlite)\b)/i;
const FORBIDDEN_STORAGE_KEY_PARTS = [
  'rawprompt',
  'rawresponse',
  'providerprompt',
  'providerresponse',
  'hiddenreasoning',
  'privatestoryplan',
  'privateplan',
  'sessionid'
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
  'hand.selected',
  'prompt.installed',
  'prompt.install_failed',
  'prompt.install_skipped',
  'prompt.cleared',
  'provider.call.started',
  'provider.call.completed',
  'provider.call.failed',
  'storage.repaired',
  'storage.pruned'
]);

export const SYSTEM_INDEX_KEY = 'recursion-system-index.v1.json';

export function sceneCacheKey(chatKey, sceneKey) {
  return `recursion-scene-${safeId(chatKey, 'chat')}-${safeId(sceneKey, 'scene')}.v1.json`;
}

export function runJournalKey(chatKey) {
  return `recursion-run-journal-${safeId(chatKey, 'chat')}.v1.json`;
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

function sanitizedJsonValue(value, fallback) {
  return redact(redactSecretText(cloneJsonValue(value, fallback)));
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
  return UNSAFE_JOURNAL_TEXT_PATTERN.test(text) || (pathLike && PATH_LIKE_TEXT_PATTERN.test(text));
}

function isUnsafeStorageKey(value) {
  const key = String(value ?? '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
  if (!key || key.endsWith('count')) return false;
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
  return stringValue(sanitizedJsonValue(value, ''), '').slice(0, limit);
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

function normalizeInvalidation(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const details = source.details === undefined ? undefined : sanitizedJsonValue(source.details, undefined);
  return redactSecretText(redact({
    reason: stringValue(source.reason, 'runtime-change').slice(0, 120) || 'runtime-change',
    detectedAt: timestampValue(source.detectedAt),
    ...(details === undefined ? {} : { details })
  }));
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.round(number));
}

function normalizeSourceRole(value) {
  const role = safeMetadataText(value, 40, '');
  return ['user', 'assistant', 'system', 'unknown'].includes(role) ? role : undefined;
}

function normalizeSourceRef(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const refId = safeMetadataText(source.refId || source.id || '', 160, '');
  const textHash = safeMetadataText(source.textHash || source.hash || '', 160, '');
  if (!refId || !textHash) return null;
  const output = {
    refId,
    firstMesId: normalizeNonNegativeInteger(source.firstMesId),
    lastMesId: normalizeNonNegativeInteger(source.lastMesId),
    textHash
  };
  const role = normalizeSourceRole(source.role);
  if (role) output.role = role;
  const excerpt = sanitizedOptionalTextValue(source.excerpt, 160);
  if (excerpt) output.excerpt = excerpt;
  return output;
}

function normalizeSceneSource(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    chatIdHash: safeMetadataText(source.chatIdHash || '', 160, ''),
    firstMesId: normalizeNonNegativeInteger(source.firstMesId),
    lastMesId: normalizeNonNegativeInteger(source.lastMesId),
    latestMesId: normalizeNonNegativeInteger(source.latestMesId),
    sceneFingerprint: safeMetadataText(source.sceneFingerprint || '', 160, ''),
    chatWindowHash: safeMetadataText(source.chatWindowHash || '', 160, ''),
    sourceRefs: Array.isArray(source.sourceRefs)
      ? source.sourceRefs.map(normalizeSourceRef).filter(Boolean).slice(0, 32)
      : []
  };
}

function normalizeSceneCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  const source = card.source && typeof card.source === 'object' && !Array.isArray(card.source) ? card.source : {};
  const freshness = card.freshness && typeof card.freshness === 'object' && !Array.isArray(card.freshness) ? card.freshness : {};
  const arbiter = card.arbiter && typeof card.arbiter === 'object' && !Array.isArray(card.arbiter) ? card.arbiter : {};
  const sourceFingerprint = safeMetadataText(
    card.sourceFingerprint || source.snapshotHash || source.fingerprint || freshness.sourceFingerprint || '',
    160
  );
  const firstMesId = Number(source.firstMesId ?? card.firstMesId ?? 0);
  const lastMesId = Number(source.lastMesId ?? card.lastMesId ?? 0);
  const expiresAfterMesId = Number(freshness.expiresAfterMesId);
  return {
    id: safeIdentifier(card.id || makeId('card'), 'card'),
    family: safeMetadataText(card.family || 'unknown', 80, 'unknown'),
    role: safeMetadataText(card.role || '', 80),
    sceneId: safeIdentifier(card.sceneId || '', ''),
    catalogKey: safeMetadataText(card.catalogKey || '', 160),
    status: ['candidate', 'active', 'stowed', 'stale', 'discarded'].includes(card.status) ? card.status : 'active',
    summary: sanitizedTextValue(card.summary || '', 400),
    promptText: sanitizedTextValue(card.promptText || '', 1000),
    evidenceRefs: safeMetadataList(card.evidenceRefs, 160, 12),
    tokenEstimate: Math.max(0, Math.min(1000, Number(card.tokenEstimate) || 0)),
    emphasis: ['normal', 'emphasized', 'muted'].includes(card.emphasis) ? card.emphasis : 'normal',
    detailProfile: ['compact', 'standard', 'expanded'].includes(card.detailProfile) ? card.detailProfile : 'standard',
    generatedAt: timestampValue(card.generatedAt || freshness.generatedAt),
    sourceFingerprint,
    source: {
      chatId: safeIdentifier(source.chatId || card.chatId || '', ''),
      firstMesId: Number.isFinite(firstMesId) ? Math.max(0, Math.round(firstMesId)) : 0,
      lastMesId: Number.isFinite(lastMesId) ? Math.max(0, Math.round(lastMesId)) : 0,
      fingerprint: safeMetadataText(source.fingerprint || sourceFingerprint, 160),
      snapshotHash: safeMetadataText(source.snapshotHash || sourceFingerprint, 160)
    },
    freshness: {
      generatedAt: timestampValue(freshness.generatedAt || card.generatedAt),
      sourceFingerprint,
      ...(Number.isFinite(expiresAfterMesId) ? { expiresAfterMesId: Math.round(expiresAfterMesId) } : {})
    },
    arbiter: {
      lastDecisionId: safeMetadataText(arbiter.lastDecisionId || card.decisionId || '', 160),
      reason: safeMetadataText(arbiter.reason || card.reason || '', 240)
    },
    arbiterDecisionHash: safeOptionalMetadataText(card.arbiterDecisionHash, 160),
    inspectorNotes: sanitizedOptionalTextValue(card.inspectorNotes, 800)
  };
}

function normalizeLatestHand(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const cardIds = safeMetadataList(source.cardIds, 160, 32);
  const omitted = Array.isArray(source.omitted)
    ? source.omitted.map((entry) => {
      const omission = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      const cardId = safeMetadataText(omission.cardId, 160, '');
      const reason = safeMetadataText(omission.reason, 160, '');
      return cardId && reason ? { cardId, reason } : null;
    }).filter(Boolean).slice(0, 32)
    : [];
  return redactSecretText(redact({
    handId: safeMetadataText(source.handId, 160, ''),
    composedAt: timestampValue(source.composedAt),
    cardIds,
    promptPacketHash: safeMetadataText(source.promptPacketHash, 160, ''),
    omitted
  }));
}

function normalizeSceneCache(chatKey, sceneKey, value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return baseRecord('recursion.sceneCache', {
    createdAt: source.createdAt,
    chatKey: safeId(chatKey, 'chat'),
    sceneKey: safeId(sceneKey, 'scene'),
    cacheState: ['active', 'stale', 'retired', 'invalid'].includes(source.cacheState) ? source.cacheState : 'active',
    cards: Array.isArray(source.cards) ? source.cards.map(normalizeSceneCard).filter(Boolean) : [],
    latestHand: normalizeLatestHand(source.latestHand),
    source: normalizeSceneSource(source.source),
    versions: sanitizedJsonValue(source.versions, {}),
    ...(source.invalidation === undefined ? {} : { invalidation: normalizeInvalidation(source.invalidation) })
  });
}

function normalizeMaxEntries(value) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) ? Math.max(1, Math.min(MAX_JOURNAL_ENTRIES, numeric)) : 1;
}

function normalizeRetentionLimit(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? Math.min(500, numeric) : fallback;
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
    selectedCount: numberValue(source.selectedCount, 0, 100000),
    omittedCount: numberValue(source.omittedCount, 0, 100000),
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
  return redact({
    id: safeJournalId(source.id),
    recordedAt: timestampValue(source.recordedAt),
    severity,
    event,
    summary: normalizeJournalSummary(source.summary),
    runId: optionalJournalString(source.runId),
    sceneKey: optionalJournalString(source.sceneKey),
    details: normalizeJournalDetails(event, source.details),
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
  const kind = ['sceneCache', 'runJournal'].includes(source.kind) ? source.kind : null;
  if (!kind) return null;
  const key = normalizeIndexKey(kind, source.key) || normalizeIndexKey(kind, fallbackKey);
  if (!key) return null;
  return {
    key,
    kind,
    chatKey: source.chatKey === undefined || source.chatKey === null ? null : safeId(source.chatKey, 'chat'),
    updatedAt: timestampValue(source.updatedAt)
  };
}

function normalizeIndexKey(kind, value) {
  if (typeof value !== 'string' || !value || /[\\/]/.test(value)) return null;
  if (kind === 'sceneCache') return SCENE_CACHE_KEY_PATTERN.test(value) ? value : null;
  if (kind === 'runJournal') return RUN_JOURNAL_KEY_PATTERN.test(value) ? value : null;
  return null;
}

function indexKindForKey(key) {
  if (SCENE_CACHE_KEY_PATTERN.test(key)) return 'sceneCache';
  if (RUN_JOURNAL_KEY_PATTERN.test(key)) return 'runJournal';
  return null;
}

function isStorageObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function indexRecordFromStoredRecord(key, value) {
  const kind = indexKindForKey(key);
  if (!kind || !isStorageObject(value) || value.schemaVersion !== 1) return null;
  if (kind === 'sceneCache') {
    if (value.recordType !== 'recursion.sceneCache' || !Array.isArray(value.cards)) return null;
    const chatKey = safeIdentifier(value.chatKey, '');
    const sceneKey = safeIdentifier(value.sceneKey, '');
    if (!chatKey || !sceneKey) return null;
    return {
      key,
      kind,
      chatKey,
      updatedAt: timestampValue(value.updatedAt)
    };
  }
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
  return null;
}

function sameIndexRecord(left, right) {
  return left?.key === right?.key
    && left?.kind === right?.kind
    && left?.chatKey === right?.chatKey
    && left?.updatedAt === right?.updatedAt;
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
    if (Object.keys(rawRecord).length !== 4) return true;
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
    kind: ['sceneCache', 'runJournal'].includes(entry?.kind) ? entry.kind : 'unknown',
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

function protectedSceneKeySet(options = {}) {
  const protectedKeys = new Set();
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  for (const key of Array.isArray(source.protectedKeys) ? source.protectedKeys : []) {
    if (typeof key === 'string' && SCENE_CACHE_KEY_PATTERN.test(key)) protectedKeys.add(key);
  }
  for (const scene of Array.isArray(source.protectedScenes) ? source.protectedScenes : []) {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) continue;
    protectedKeys.add(sceneCacheKey(scene.chatKey, scene.sceneKey));
  }
  if (source.activeScene && typeof source.activeScene === 'object' && !Array.isArray(source.activeScene)) {
    protectedKeys.add(sceneCacheKey(source.activeScene.chatKey, source.activeScene.sceneKey));
  }
  return protectedKeys;
}

function sortSceneRecordsNewestFirst(left, right) {
  const rightTime = Date.parse(right.updatedAt) || 0;
  const leftTime = Date.parse(left.updatedAt) || 0;
  if (rightTime !== leftTime) return rightTime - leftTime;
  return String(left.key).localeCompare(String(right.key));
}

function plannedSceneCachePrunes(records, { maxPerChat, maxTotal, protectedKeys }) {
  const pruned = new Map();
  const sceneRecords = records.filter((record) => record?.kind === 'sceneCache' && SCENE_CACHE_KEY_PATTERN.test(record.key));
  const byChat = new Map();
  for (const record of sceneRecords) {
    const chatKey = safeIdentifier(record.chatKey || 'chat', 'chat');
    if (!byChat.has(chatKey)) byChat.set(chatKey, []);
    byChat.get(chatKey).push(record);
  }

  for (const group of byChat.values()) {
    group.sort(sortSceneRecordsNewestFirst);
    const protectedInGroup = group.filter((record) => protectedKeys.has(record.key)).length;
    let remainingUnprotected = Math.max(0, maxPerChat - protectedInGroup);
    for (const record of group) {
      if (protectedKeys.has(record.key)) continue;
      if (remainingUnprotected > 0) {
        remainingUnprotected -= 1;
        continue;
      }
      pruned.set(record.key, { record, reason: 'per-chat-retention-limit' });
    }
  }

  const kept = sceneRecords
    .filter((record) => !pruned.has(record.key))
    .sort(sortSceneRecordsNewestFirst);
  const protectedTotal = kept.filter((record) => protectedKeys.has(record.key)).length;
  let remainingUnprotectedTotal = Math.max(0, maxTotal - protectedTotal);
  for (const record of kept) {
    if (protectedKeys.has(record.key)) continue;
    if (remainingUnprotectedTotal > 0) {
      remainingUnprotectedTotal -= 1;
      continue;
    }
    pruned.set(record.key, { record, reason: 'total-retention-limit' });
  }

  return [...pruned.values()];
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
      fallback
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
  reportActivity(activity, {
    operationId,
    phase: 'storageWarning',
    logicalStage: 'Storage fallback',
    mode: 'background',
    severity: 'warning',
    label: 'Recursion storage warning; continuing in memory.',
    chips: ['Storage'],
    detail: {
      ...detail,
      persisted: false,
      fallback: status.fallback,
      reason: status.reason
    }
  });
}

export function createStorageRepository({ storage = createMemoryStorageAdapter(), maxJournalEntries = 100, activity = null } = {}) {
  const journalEntryLimit = normalizeMaxEntries(maxJournalEntries);

  async function writeIndexEntry(key, kind, chatKey = null) {
    const index = normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    index.records[key] = { key, kind, chatKey, updatedAt: nowIso() };
    index.updatedAt = nowIso();
    return storage.writeJson(SYSTEM_INDEX_KEY, index);
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
      return { ok: true, value: await storage.readJson(key) };
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

  async function pruneSceneCaches(options = {}) {
    const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const repair = await repairIndex();
    const index = normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    const protectedKeys = protectedSceneKeySet(source);
    const plannedPrunes = plannedSceneCachePrunes(Object.values(index.records), {
      maxPerChat: normalizeRetentionLimit(source.maxPerChat, DEFAULT_MAX_SCENE_CACHES_PER_CHAT),
      maxTotal: normalizeRetentionLimit(source.maxTotal, DEFAULT_MAX_SCENE_CACHES_TOTAL),
      protectedKeys
    });
    const pruned = [];
    const skipped = [];
    for (const { record, reason } of plannedPrunes) {
      const read = await readRepairRecord(record.key);
      if (!read.ok) {
        skipped.push(repairDiagnostic('scene-cache-retained', {
          kind: 'sceneCache',
          chatKey: record.chatKey,
          reason: 'read-failed'
        }));
        continue;
      }
      const validRecord = indexRecordFromStoredRecord(record.key, read.value);
      if (!validRecord || validRecord.kind !== 'sceneCache') {
        skipped.push(repairDiagnostic('scene-cache-retained', {
          kind: 'sceneCache',
          chatKey: record.chatKey,
          reason: 'invalid-record'
        }));
        continue;
      }
      try {
        const deleted = await storage.deleteJson(record.key);
        if (deleted?.ok === false) {
          skipped.push(repairDiagnostic('scene-cache-retained', {
            kind: 'sceneCache',
            chatKey: record.chatKey,
            reason: 'delete-failed'
          }));
          continue;
        }
        delete index.records[record.key];
        pruned.push(repairDiagnostic('scene-cache-deleted', {
          kind: 'sceneCache',
          chatKey: record.chatKey,
          reason
        }));
      } catch {
        skipped.push(repairDiagnostic('scene-cache-retained', {
          kind: 'sceneCache',
          chatKey: record.chatKey,
          reason: 'delete-failed'
        }));
      }
    }
    if (pruned.length > 0) {
      index.updatedAt = nowIso();
      await storage.writeJson(SYSTEM_INDEX_KEY, index);
    }
    return {
      ok: true,
      repaired: repair.repaired,
      pruned,
      skipped: [...repair.skipped, ...skipped],
      keptCount: Object.values(index.records).filter((record) => record.kind === 'sceneCache').length,
      deletedCount: pruned.length,
      journalEvents: [...repair.journalEvents, ...cleanupJournalEvents([], pruned)]
    };
  }

  async function loadSceneCache(chatKey, sceneKey) {
    const key = sceneCacheKey(chatKey, sceneKey);
    const existing = await storage.readJson(key);
    return existing ? normalizeSceneCache(chatKey, sceneKey, existing) : null;
  }

  async function loadRunJournal(chatKey) {
    const key = runJournalKey(chatKey);
    return normalizeJournal(chatKey, await storage.readJson(key), journalEntryLimit);
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

  return {
    loadSceneCache,
    async saveSceneCache(chatKey, sceneKey, value) {
      const key = sceneCacheKey(chatKey, sceneKey);
      const operationId = makeId('storage');
      reportActivity(activity, {
        operationId,
        phase: 'storageProgress',
        logicalStage: 'Updating scene cache',
        mode: 'background',
        severity: 'info',
        label: 'Updating scene cache...',
        detail: {
          kind: 'sceneCache',
          chatKey: safeId(chatKey, 'chat'),
          sceneKey: safeId(sceneKey, 'scene')
        }
      });
      const record = normalizeSceneCache(chatKey, sceneKey, value);
      const writeResult = await storage.writeJson(key, record);
      const sceneWriteStatus = storageWriteStatus(writeResult);
      let indexWriteStatus = { persisted: true };
      if (sceneWriteStatus.persisted || sceneWriteStatus.fallback) {
        indexWriteStatus = storageWriteStatus(await writeIndexEntry(key, 'sceneCache', safeId(chatKey, 'chat')));
      }
      const storageStatus = combineStorageStatuses(sceneWriteStatus, indexWriteStatus);
      reportStorageWriteStatus(activity, operationId, storageStatus, {
        kind: 'sceneCache',
        chatKey: safeId(chatKey, 'chat'),
        sceneKey: safeId(sceneKey, 'scene'),
        cardCount: record.cards.length
      });
      return attachStorageStatus(record, storageStatus);
    },
    async invalidateSceneCache(chatKey, sceneKey, options = {}) {
      const key = sceneCacheKey(chatKey, sceneKey);
      const existing = await storage.readJson(key);
      if (!existing) return { ok: false, reason: 'missing-cache', key };
      const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      const reason = stringValue(source.reason, 'runtime-change').slice(0, 120) || 'runtime-change';
      const cacheState = ['active', 'stale', 'retired', 'invalid'].includes(source.cacheState) ? source.cacheState : 'stale';
      const invalidation = normalizeInvalidation({
        reason,
        detectedAt: source.detectedAt,
        details: source.details
      });
      const record = normalizeSceneCache(chatKey, sceneKey, {
        ...existing,
        cacheState,
        invalidation
      });
      await storage.writeJson(key, record);
      await writeIndexEntry(key, 'sceneCache', safeId(chatKey, 'chat'));
      const journalEntry = await appendJournal(chatKey, {
        event: 'cache.invalidated',
        severity: 'info',
        summary: `Scene cache marked ${record.cacheState}: ${invalidation.reason}`,
        runId: optionalStringValue(source.runId),
        sceneKey: safeId(sceneKey, 'scene'),
        details: {
          reason: invalidation.reason,
          cacheState: record.cacheState,
          ...(invalidation.details === undefined ? {} : { details: invalidation.details })
        }
      });
      return { ok: true, key, record, journalEntry };
    },
    loadRunJournal,
    appendJournal,
    repairIndex,
    pruneSceneCaches,
    async clearSceneCache(chatKey, sceneKey) {
      const key = sceneCacheKey(chatKey, sceneKey);
      await storage.deleteJson(key);
      await removeIndexEntry(key);
      return { ok: true, key };
    },
    async readIndex() {
      return normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    }
  };
}
