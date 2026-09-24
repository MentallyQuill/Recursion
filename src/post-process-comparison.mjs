import { hashJson, safeId } from './core.mjs';
import { stableHash } from './execution/provenance.mjs';

export const POST_PROCESS_COMPARISON_SCHEMA = 'recursion.postProcessComparison.v1';
export const POST_PROCESS_COMPARISONS_PATTERN = /^recursion-post-process-comparisons-[A-Za-z0-9_.-]+\.v1\.json$/;
export const postProcessComparisonsKey = (chatKey) =>
  `recursion-post-process-comparisons-${safeId(chatKey, 'chat')}.v1.json`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const text = (value) => typeof value === 'string' ? value : '';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => Object.assign(new Error(message), {
  code: 'RECURSION_POST_PROCESS_COMPARISON_STORAGE', retryable: false
});

export function normalizePostProcessComparison(value, chatKey) {
  if (!object(value) || value.schema !== POST_PROCESS_COMPARISON_SCHEMA
      || !text(value.id) || !text(value.revisionId) || !text(value.operationId)
      || value.chatKey !== safeId(chatKey, 'chat')
      || !object(value.originalSnapshot) || !object(value.targetIdentity)
      || !text(value.originalSnapshot.originalDraft)
      || value.originalSnapshot.sourceHash !== hashJson(value.originalSnapshot.originalDraft)
      || !text(value.candidateText).trim()
      || value.candidateHash !== hashJson(value.candidateText)
      || !['pending', 'applied', 'rejected', 'stale'].includes(value.state)) return null;
  const originalSnapshot = clone(value.originalSnapshot);
  const terminal = ['stale', 'rejected'].includes(value.state);
  if (terminal) delete originalSnapshot.supportingContext;
  return clone({
    schema: POST_PROCESS_COMPARISON_SCHEMA,
    id: value.id, operationId: value.operationId, revisionId: value.revisionId, chatKey: value.chatKey,
    originalSnapshot, candidateText: value.candidateText,
    candidateHash: value.candidateHash, targetIdentity: value.targetIdentity,
    writer: value.writer || { mode: 'native', label: 'Current SillyTavern model' },
    editingScope: value.editingScope === 'revise' ? 'revise' : 'polish',
    applyMode: value.applyMode === 'replace' ? 'replace' : 'as-swipe',
    state: value.state, retryInputs: terminal ? null : value.retryInputs || null, receipt: value.receipt || null,
    manualEdit: value.manualEdit === true,
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: value.updatedAt || new Date().toISOString(),
    lastAccessedAt: value.lastAccessedAt || value.updatedAt || new Date().toISOString()
  });
}

export function createPostProcessComparisonStore({ storage, onWrite, onDelete }) {
  const locks = new Map();
  const serial = (chatKey, run) => {
    const key = safeId(chatKey, 'chat');
    const result = (locks.get(key) || Promise.resolve()).catch(() => {}).then(() => run(key));
    locks.set(key, result);
    result.finally(() => { if (locks.get(key) === result) locks.delete(key); }).catch(() => {});
    return result;
  };
  async function read(chatKey) {
    const bucket = await storage.readJson(postProcessComparisonsKey(chatKey));
    if (!bucket) return [];
    if (bucket.recordType !== 'recursion.postProcessComparisons' || bucket.schemaVersion !== 1
        || bucket.chatKey !== chatKey || !Array.isArray(bucket.records)) throw fail('Revision records are unreadable.');
    const records = [];
    for (const entry of bucket.records) {
      const record = normalizePostProcessComparison(entry?.data, chatKey);
      if (record && entry.hash === await stableHash(record)) records.push(record);
    }
    return records;
  }
  async function write(chatKey, records) {
    const key = postProcessComparisonsKey(chatKey);
    const bucket = {
      schemaVersion: 1, recordType: 'recursion.postProcessComparisons', chatKey,
      updatedAt: new Date().toISOString(),
      records: await Promise.all(records.map(async (data) => ({ data, hash: await stableHash(data) })))
    };
    const bytes = new TextEncoder().encode(JSON.stringify(bucket)).byteLength;
    if (bytes > 8 * 1024 * 1024) throw fail('Revision comparisons exceed the 8 MiB chat storage budget. Clear older comparisons first.');
    const result = await storage.writeJson(key, bucket);
    if (result?.ok === false || result?.persisted === false || Boolean(result?.fallback)) throw fail('Could not save the revision comparison.');
    const persisted = await storage.readJson(key);
    if (!persisted || await stableHash(persisted) !== await stableHash(bucket)) throw fail('Could not verify the saved revision comparison.');
    const indexed = await onWrite?.(key, chatKey);
    if (indexed?.ok === false || indexed?.persisted === false || indexed?.fallback) throw fail('Could not persist the revision index.');
  }
  return {
    savePostProcessComparison(chatKey, value) {
      return serial(chatKey, async (key) => {
        const record = normalizePostProcessComparison(value, key);
        if (!record) throw fail('Invalid revision comparison.');
        const records = (await read(key)).filter((entry) => entry.id !== record.id);
        records.push(record);
        const completed = records.filter((entry) => entry.state !== 'pending')
          .sort((a, b) => Date.parse(b.lastAccessedAt) - Date.parse(a.lastAccessedAt));
        const retained = new Set(completed.slice(0, 10).map((entry) => entry.id));
        await write(key, records.filter((entry) => entry.state === 'pending' || retained.has(entry.id)));
        return clone(record);
      });
    },
    repairPostProcessComparisons(chatKey) {
      return serial(chatKey, async (key) => {
        const storageKey = postProcessComparisonsKey(key);
        const bucket = await storage.readJson(storageKey);
        if (!bucket) return null;
        const records = await read(key);
        if (records.length === bucket.records.length) return bucket;
        if (records.length) { await write(key, records); return storage.readJson(storageKey); }
        const result = await storage.deleteJson(storageKey);
        if (result?.ok === false) throw fail('Could not remove corrupt revision data.');
        await onDelete?.(storageKey);
        return null;
      });
    },
    clearPostProcessComparisons(chatKey) {
      return serial(chatKey, async (key) => {
        const storageKey = postProcessComparisonsKey(key);
        const result = await storage.deleteJson(storageKey);
        if (result?.ok === false) throw fail('Could not remove revision comparisons.');
        await onDelete?.(storageKey);
        return { ok: true, deletedKeys: [storageKey] };
      });
    },
    deletePostProcessComparison(chatKey, id) {
      return serial(chatKey, async (key) => {
        const records = (await read(key)).filter((entry) => entry.id !== id);
        if (records.length) await write(key, records);
        else {
          const result = await storage.deleteJson(postProcessComparisonsKey(key));
          if (result?.ok === false) throw fail('Could not remove revision comparison.');
          await onDelete?.(postProcessComparisonsKey(key));
        }
        return { ok: true };
      });
    },
    listPostProcessComparisons(chatKey) {
      return serial(chatKey, read);
    },
    loadPostProcessComparison(chatKey, id) {
      return serial(chatKey, async (key) => {
        const records = await read(key);
        const record = records.find((entry) => entry.id === id);
        if (!record) return null;
        record.lastAccessedAt = new Date().toISOString();
        await write(key, records);
        return clone(record);
      });
    }
  };
}
