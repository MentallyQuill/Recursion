import { cloneJson, makeId, nowIso, redact, safeId } from './core.mjs';

const RECURSION_VERSION = '0.1.0-pre-alpha.1';
const MAX_JOURNAL_ENTRIES = 500;
const SCENE_CACHE_KEY_PATTERN = /^recursion-scene-[A-Za-z0-9_.-]+-[A-Za-z0-9_.-]+\.v1\.json$/;
const RUN_JOURNAL_KEY_PATTERN = /^recursion-run-journal-[A-Za-z0-9_.-]+\.v1\.json$/;

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
  return redactSecretText(redact(cloneJsonValue(value, fallback)));
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

function redactSecretText(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\bAuthorization\s+Bearer\s+[A-Za-z0-9._-]+/g, 'Authorization Bearer [redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
      .replace(/\bprivate[-_\s]*secret\b/gi, '[redacted]');
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecretText(entry));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecretText(entry)]));
}

function optionalStringValue(value) {
  if (value === undefined || value === null) return undefined;
  const text = stringValue(value, '');
  return text || undefined;
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

function normalizeSceneCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  const source = card.source && typeof card.source === 'object' && !Array.isArray(card.source) ? card.source : {};
  const freshness = card.freshness && typeof card.freshness === 'object' && !Array.isArray(card.freshness) ? card.freshness : {};
  const arbiter = card.arbiter && typeof card.arbiter === 'object' && !Array.isArray(card.arbiter) ? card.arbiter : {};
  const sourceFingerprint = String(card.sourceFingerprint || source.snapshotHash || source.fingerprint || freshness.sourceFingerprint || '');
  const firstMesId = Number(source.firstMesId ?? card.firstMesId ?? 0);
  const lastMesId = Number(source.lastMesId ?? card.lastMesId ?? 0);
  const expiresAfterMesId = Number(freshness.expiresAfterMesId);
  return {
    id: safeId(card.id || makeId('card')),
    family: String(card.family || 'unknown'),
    role: String(card.role || ''),
    sceneId: String(card.sceneId || ''),
    catalogKey: String(card.catalogKey || ''),
    status: ['candidate', 'active', 'stowed', 'stale', 'discarded'].includes(card.status) ? card.status : 'active',
    summary: String(card.summary || '').slice(0, 400),
    promptText: String(card.promptText || '').slice(0, 1000),
    evidenceRefs: Array.isArray(card.evidenceRefs) ? card.evidenceRefs.map(String).slice(0, 12) : [],
    tokenEstimate: Math.max(0, Math.min(1000, Number(card.tokenEstimate) || 0)),
    emphasis: ['normal', 'emphasized', 'muted'].includes(card.emphasis) ? card.emphasis : 'normal',
    detailProfile: ['compact', 'standard', 'expanded'].includes(card.detailProfile) ? card.detailProfile : 'standard',
    generatedAt: timestampValue(card.generatedAt || freshness.generatedAt),
    sourceFingerprint,
    source: {
      chatId: String(source.chatId || card.chatId || ''),
      firstMesId: Number.isFinite(firstMesId) ? Math.max(0, Math.round(firstMesId)) : 0,
      lastMesId: Number.isFinite(lastMesId) ? Math.max(0, Math.round(lastMesId)) : 0,
      fingerprint: String(source.fingerprint || sourceFingerprint),
      snapshotHash: String(source.snapshotHash || sourceFingerprint)
    },
    freshness: {
      generatedAt: timestampValue(freshness.generatedAt || card.generatedAt),
      sourceFingerprint,
      ...(Number.isFinite(expiresAfterMesId) ? { expiresAfterMesId: Math.round(expiresAfterMesId) } : {})
    },
    arbiter: {
      lastDecisionId: String(arbiter.lastDecisionId || card.decisionId || ''),
      reason: String(arbiter.reason || card.reason || '').slice(0, 240)
    },
    arbiterDecisionHash: card.arbiterDecisionHash ? String(card.arbiterDecisionHash) : undefined,
    inspectorNotes: card.inspectorNotes ? String(card.inspectorNotes).slice(0, 800) : undefined
  };
}

function normalizeSceneCache(chatKey, sceneKey, value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return baseRecord('recursion.sceneCache', {
    createdAt: source.createdAt,
    chatKey: safeId(chatKey, 'chat'),
    sceneKey: safeId(sceneKey, 'scene'),
    cacheState: ['active', 'stale', 'retired', 'invalid'].includes(source.cacheState) ? source.cacheState : 'active',
    cards: Array.isArray(source.cards) ? source.cards.map(normalizeSceneCard).filter(Boolean) : [],
    latestHand: sanitizedJsonValue(source.latestHand, null),
    source: sanitizedJsonValue(source.source, null),
    versions: sanitizedJsonValue(source.versions, {}),
    ...(source.invalidation === undefined ? {} : { invalidation: normalizeInvalidation(source.invalidation) })
  });
}

function normalizeMaxEntries(value) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) ? Math.max(1, Math.min(MAX_JOURNAL_ENTRIES, numeric)) : 1;
}

function normalizeNextIndex(value, fallback) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeJournalEntry(entry = {}) {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const severity = ['debug', 'info', 'warn', 'error'].includes(source.severity) ? source.severity : 'info';
  return redact({
    id: safeId(stringValue(source.id, makeId('journal')), 'journal'),
    recordedAt: timestampValue(source.recordedAt),
    severity,
    event: stringValue(source.event, 'runtime.event'),
    summary: stringValue(source.summary, '').slice(0, 300),
    runId: optionalStringValue(source.runId),
    sceneKey: optionalStringValue(source.sceneKey),
    details: sanitizedJsonValue(source.details, undefined),
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

function reportActivity(activity, event) {
  try {
    const result = activity?.stage?.(event);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // Activity reporting must never block storage persistence.
  }
}

export function createStorageRepository({ storage = createMemoryStorageAdapter(), maxJournalEntries = 100, activity = null } = {}) {
  const journalEntryLimit = normalizeMaxEntries(maxJournalEntries);

  async function writeIndexEntry(key, kind, chatKey = null) {
    const index = normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    index.records[key] = { key, kind, chatKey, updatedAt: nowIso() };
    index.updatedAt = nowIso();
    await storage.writeJson(SYSTEM_INDEX_KEY, index);
  }

  async function removeIndexEntry(key) {
    const index = normalizeIndex(await storage.readJson(SYSTEM_INDEX_KEY));
    if (!index.records[key]) return;
    delete index.records[key];
    index.updatedAt = nowIso();
    await storage.writeJson(SYSTEM_INDEX_KEY, index);
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
      await storage.writeJson(key, record);
      await writeIndexEntry(key, 'sceneCache', safeId(chatKey, 'chat'));
      reportActivity(activity, {
        operationId,
        phase: 'storageProgress',
        logicalStage: 'Storage ready',
        mode: 'background',
        severity: 'success',
        label: 'Storage ready.',
        detail: {
          kind: 'sceneCache',
          chatKey: safeId(chatKey, 'chat'),
          sceneKey: safeId(sceneKey, 'scene'),
          cardCount: record.cards.length
        }
      });
      return record;
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
