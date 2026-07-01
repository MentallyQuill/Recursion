import {
  SYSTEM_INDEX_KEY,
  createMemoryStorageAdapter,
  createStorageRepository,
  sceneCacheKey,
  runJournalKey
} from '../../src/storage.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

function assertNoSecret(value, message) {
  assert(!JSON.stringify(value).includes('secret'), message);
}

function assertNoRawSecretText(value, message) {
  const serialized = JSON.stringify(value);
  assert(!/\bapiKey\b[^"]*"[^"]*secret/i.test(serialized), `${message}: apiKey value redacted`);
  assert(!/\bAuthorization\s+Bearer\s+[a-z0-9._-]+/i.test(serialized), `${message}: bearer text redacted`);
  assert(!/\bsk-[a-z0-9_-]+/i.test(serialized), `${message}: sk text redacted`);
  assert(!/\bprivate[-_\s]*secret\b/i.test(serialized), `${message}: secret text redacted`);
}

function assertNoOwnField(value, field, message) {
  assert(!Object.prototype.hasOwnProperty.call(value, field), message);
}

function assertType(value, expectedType, message) {
  assertEqual(typeof value, expectedType, message);
}

function assertParseableTimestamp(value, message) {
  assertType(value, 'string', message);
  assert(Number.isFinite(Date.parse(value)), message);
}

function assertNoObjectString(value, message) {
  const text = String(value ?? '');
  assert(!text.includes('[object Object]') && !text.includes('object-Object'), message);
}

assertEqual(sceneCacheKey('Chat One', 'Scene/One'), 'recursion-scene-Chat-One-Scene-One.v1.json', 'scene key sanitized');
assertEqual(runJournalKey('Chat One'), 'recursion-run-journal-Chat-One.v1.json', 'journal key sanitized');

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter, maxJournalEntries: 3 });

  await repo.saveSceneCache('Chat One', 'Scene One', {
    cacheState: 'active',
    cards: [{ id: 'card-1', promptText: 'keep', inspectorNotes: 'private' }]
  });
  const cache = await repo.loadSceneCache('Chat One', 'Scene One');
  assertEqual(cache.cards[0].id, 'card-1', 'scene cache persisted');

  await repo.appendJournal('Chat One', { event: 'runtime.event', summary: 'zero' });
  await repo.appendJournal('Chat One', { event: 'provider.call.started', summary: 'one', details: { apiKey: 'secret' } });
  await repo.appendJournal('Chat One', { event: 'provider.call.completed', summary: 'two' });
  await repo.appendJournal('Chat One', { event: 'prompt.installed', summary: 'three' });
  const journal = await repo.loadRunJournal('Chat One');
  assertEqual(journal.entries.length, 3, 'journal pruned to max');
  assertEqual(journal.entries[0].summary, 'one', 'oldest entry pruned');
  assertEqual(journal.entries[0].details.apiKey, '[redacted]', 'journal redacts retained secrets');
  assertNoSecret(journal.entries, 'journal redacts secrets');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const key = sceneCacheKey('Invalidate Chat', 'Scene One');
  await repo.saveSceneCache('Invalidate Chat', 'Scene One', {
    cacheState: 'active',
    cards: [{ id: 'preserved-card', family: 'Scene Frame', promptText: 'Preserve this card.' }],
    latestHand: { handId: 'hand-1', cards: [{ id: 'preserved-card' }] },
    source: { sceneFingerprint: 'scene-fp' },
    versions: { prompt: 'v1' }
  });

  const result = await repo.invalidateSceneCache('Invalidate Chat', 'Scene One', {
    reason: 'provider-changed',
    runId: 'run-1',
    details: {
      model: 'new-model',
      apiKey: 'secret',
      authorizationHeader: 'Authorization Bearer live-token',
      providerNote: 'contains sk-live-runtime and private-secret text'
    }
  });

  assertEqual(result.ok, true, 'invalidateSceneCache returns ok when cache exists');
  assertEqual(result.key, key, 'invalidateSceneCache returns scene cache key');
  const cache = await repo.loadSceneCache('Invalidate Chat', 'Scene One');
  assertEqual(cache.cacheState, 'stale', 'invalidateSceneCache marks cache stale');
  assertEqual(cache.cards[0].id, 'preserved-card', 'invalidateSceneCache preserves cards');
  assertEqual(cache.latestHand.handId, 'hand-1', 'invalidateSceneCache preserves latestHand');
  assertEqual(cache.source.sceneFingerprint, 'scene-fp', 'invalidateSceneCache preserves source');
  assertEqual(cache.versions.prompt, 'v1', 'invalidateSceneCache preserves versions');
  assertEqual(cache.invalidation.reason, 'provider-changed', 'invalidateSceneCache records reason');
  assertParseableTimestamp(cache.invalidation.detectedAt, 'invalidateSceneCache records detectedAt');
  assertEqual(cache.invalidation.details.model, 'new-model', 'invalidateSceneCache keeps safe details');
  assertNoRawSecretText(cache.invalidation, 'scene cache invalidation metadata');

  const index = await repo.readIndex();
  assert(index.records[key], 'invalidateSceneCache keeps scene cache index entry');
  const journal = await repo.loadRunJournal('Invalidate Chat');
  const entry = journal.entries.at(-1);
  assertEqual(entry.event, 'cache.invalidated', 'invalidateSceneCache appends journal event');
  assertEqual(entry.severity, 'info', 'invalidateSceneCache journal severity is info');
  assertEqual(entry.runId, 'run-1', 'invalidateSceneCache journal records run id');
  assertEqual(entry.sceneKey, 'Scene-One', 'invalidateSceneCache journal records scene key');
  assertEqual(entry.details.reason, 'provider-changed', 'invalidateSceneCache journal records reason');
  assertNoRawSecretText(entry, 'cache invalidated journal entry');

  const missing = await repo.invalidateSceneCache('Invalidate Chat', 'Missing Scene', { reason: 'settings-changed' });
  assertEqual(missing.ok, false, 'invalidateSceneCache missing cache returns fail-soft');
  assertEqual(missing.reason, 'missing-cache', 'invalidateSceneCache missing cache reason');
  assert(!adapter.dump()[sceneCacheKey('Invalidate Chat', 'Missing Scene')], 'invalidateSceneCache does not create missing cache');
}

{
  const adapter = createMemoryStorageAdapter();
  const activityEvents = [];
  const repo = createStorageRepository({
    storage: adapter,
    activity: {
      stage(event) {
        activityEvents.push(event);
      }
    }
  });
  const saved = await repo.saveSceneCache('Unsafe Chat', 'Unsafe Scene', {
    recordType: 'wrong',
    schemaVersion: 999,
    updatedAt: 'wrong-date',
    recursionVersion: 'wrong-version',
    chatKey: 'wrong-chat',
    sceneKey: 'wrong-scene',
    createdAt: 'not-a-date',
    apiKey: 'secret',
    rawUnexpected: 'drop-me',
    cacheState: 'active',
    cards: [{ id: 'card-allow', promptText: 'keep', generatedAt: { apiKey: 'card-time-secret' } }]
  });
  const loaded = await repo.loadSceneCache('Unsafe Chat', 'Unsafe Scene');
  assertEqual(saved.recordType, 'recursion.sceneCache', 'scene cache recordType canonical');
  assertEqual(saved.schemaVersion, 1, 'scene cache schemaVersion canonical');
  assertEqual(saved.recursionVersion, '0.1.0-pre-alpha.1', 'scene cache version canonical');
  assertEqual(saved.chatKey, 'Unsafe-Chat', 'scene cache chatKey canonical');
  assertEqual(saved.sceneKey, 'Unsafe-Scene', 'scene cache sceneKey canonical');
  assertParseableTimestamp(saved.createdAt, 'scene cache malformed createdAt replaced with timestamp string');
  assert(saved.createdAt !== 'not-a-date', 'scene cache malformed createdAt not preserved');
  assertParseableTimestamp(saved.cards[0].generatedAt, 'scene card generatedAt normalized to timestamp string');
  assertNoOwnField(saved, 'apiKey', 'scene cache drops secret top-level fields');
  assertNoOwnField(saved, 'rawUnexpected', 'scene cache drops unexpected top-level fields');
  assertEqual(loaded.recordType, 'recursion.sceneCache', 'loaded scene cache recordType canonical');
  assertNoSecret(adapter.dump(), 'scene cache does not persist dropped secrets');
  assertEqual(activityEvents[0].phase, 'storageSaving', 'save emits storageSaving activity');
  assertEqual(activityEvents[1].phase, 'storageComplete', 'save emits storageComplete activity');

  const throwingAdapter = createMemoryStorageAdapter();
  const throwingRepo = createStorageRepository({
    storage: throwingAdapter,
    activity: {
      stage() {
        throw new Error('activity failed');
      }
    }
  });
  await throwingRepo.saveSceneCache('Throwing Activity Chat', 'Scene', {});
  assert(await throwingRepo.loadSceneCache('Throwing Activity Chat', 'Scene'), 'throwing activity hook does not block scene cache save');

  const rejectingAdapter = createMemoryStorageAdapter();
  const rejectingRepo = createStorageRepository({
    storage: rejectingAdapter,
    activity: {
      stage() {
        return Promise.reject(new Error('activity rejected'));
      }
    }
  });
  await rejectingRepo.saveSceneCache('Rejecting Activity Chat', 'Scene', {});
  assert(await rejectingRepo.loadSceneCache('Rejecting Activity Chat', 'Scene'), 'rejecting activity hook does not block scene cache save');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const key = sceneCacheKey('Nested Secret Chat', 'Scene Cache');
  await repo.saveSceneCache('Nested Secret Chat', 'Scene Cache', {
    createdAt: { apiKey: 'created-secret' },
    latestHand: {
      id: 'hand-1',
      provider: { apiKey: 'latest-hand-secret' }
    },
    source: {
      name: 'visible source',
      authorization: 'source-secret'
    },
    versions: {
      prompt: {
        token: 'version-secret'
      }
    }
  });
  const persisted = adapter.dump()[key];
  assertParseableTimestamp(persisted.createdAt, 'scene cache invalid createdAt replaced with timestamp string');
  assertEqual(persisted.latestHand.provider.apiKey, '[redacted]', 'latestHand nested apiKey redacted');
  assertEqual(persisted.source.authorization, '[redacted]', 'source authorization redacted');
  assertEqual(persisted.versions.prompt.token, '[redacted]', 'versions nested token redacted');
  assertNoSecret(persisted, 'scene cache nested metadata contains no raw secrets');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter, maxJournalEntries: 3 });
  await adapter.writeJson(runJournalKey('Manual Chat'), {
    recordType: 'wrong',
    schemaVersion: 999,
    chatKey: 'wrong-chat',
    apiKey: 'secret',
    nextIndex: 'not-a-number',
    entries: [{
      id: 'entry-1',
      recordedAt: '2026-06-30T00:00:00.000Z',
      severity: 'info',
      event: 'provider.call.started',
      summary: 'contaminated',
      details: { apiKey: 'secret' },
      rawUnexpected: 'drop-me'
    }]
  });
  const loaded = await repo.loadRunJournal('Manual Chat');
  assertEqual(loaded.recordType, 'recursion.runJournal', 'journal recordType canonical on load');
  assertEqual(loaded.chatKey, 'Manual-Chat', 'journal chatKey canonical on load');
  assertEqual(loaded.entries[0].details.apiKey, '[redacted]', 'loaded journal entry redacted');
  assertNoOwnField(loaded, 'apiKey', 'journal drops secret top-level fields');
  assertNoOwnField(loaded.entries[0], 'rawUnexpected', 'journal entry drops unexpected fields');
  assertNoSecret(loaded, 'loaded journal redacts contaminated entries');

  await repo.appendJournal('Manual Chat', { event: 'runtime.followup', summary: 'new' });
  const rewritten = await adapter.readJson(runJournalKey('Manual Chat'));
  assertEqual(rewritten.entries.length, 2, 'append preserves retained existing entry');
  assertNoSecret(rewritten, 'append rewrites journal without reintroducing secrets');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter, maxJournalEntries: 2 });
  await adapter.writeJson(runJournalKey('Scalar Chat'), {
    entries: [{
      id: { apiKey: 'id-secret' },
      recordedAt: 'not-a-date',
      severity: 'fatal',
      event: { authorization: 'event-secret' },
      summary: { apiKey: 'summary-secret' },
      runId: { token: 'run-secret' },
      sceneKey: { apiKey: 'scene-secret' }
    }]
  });
  const journal = await repo.loadRunJournal('Scalar Chat');
  const entry = journal.entries[0];
  assertType(entry.id, 'string', 'journal entry id normalized to string');
  assertNoObjectString(entry.id, 'journal entry id does not stringify object input');
  assertParseableTimestamp(entry.recordedAt, 'journal entry recordedAt normalized to timestamp string');
  assert(entry.recordedAt !== 'not-a-date', 'journal entry invalid recordedAt not preserved');
  assertEqual(entry.severity, 'info', 'journal entry invalid severity defaults to info');
  assertEqual(entry.event, 'runtime.event', 'journal entry object event falls back');
  assertEqual(entry.summary, '', 'journal entry object summary falls back');
  assertEqual(entry.runId, undefined, 'journal entry object runId is omitted');
  assertEqual(entry.sceneKey, undefined, 'journal entry object sceneKey is omitted');
  assertNoSecret(entry, 'journal scalar normalization redacts object-valued secrets');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const clean = await repo.appendJournal('Json Safe Chat', {
    event: 'runtime.bigint',
    summary: 'drop non-json payloads',
    details: { count: 1n, apiKey: 'sk-live-details' },
    hashes: { token: 'Bearer hash-token' },
    metrics: { privateKey: 'private-key-material' }
  });
  assertEqual(clean.details, undefined, 'journal entry drops non-json details payload');
  assertEqual(clean.hashes.token, '[redacted]', 'journal entry redacts JSON-safe hashes');
  assertEqual(clean.metrics.privateKey, '[redacted]', 'journal entry redacts JSON-safe metrics');
  const journal = await repo.loadRunJournal('Json Safe Chat');
  assertEqual(journal.entries[0].details, undefined, 'persisted journal omits non-json details payload');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const key = sceneCacheKey('Index Chat', 'Scene A');
  await repo.saveSceneCache('Index Chat', 'Scene A', {});
  let index = await repo.readIndex();
  assert(index.records[key], 'index records saved scene cache');
  await repo.clearSceneCache('Index Chat', 'Scene A');
  index = await repo.readIndex();
  assert(!index.records[key], 'clear removes scene cache from index');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const saved = await repo.saveSceneCache('Corrupt Chat', 'Cards', {
    cards: [null, { id: 'card-2', promptText: 'safe' }]
  });
  assertEqual(saved.cards.length, 1, 'null scene cards filtered');
  assertEqual(saved.cards[0].id, 'card-2', 'valid scene card retained');

  await adapter.writeJson(SYSTEM_INDEX_KEY, { recordType: 'corrupt-index' });
  await repo.saveSceneCache('Corrupt Chat', 'Index Repair', {});
  const index = await repo.readIndex();
  assert(index.records[sceneCacheKey('Corrupt Chat', 'Index Repair')], 'corrupt index repaired on write');

  const clean = await repo.appendJournal('Corrupt Chat', null);
  assertEqual(clean.event, 'runtime.event', 'null journal entry gets default event');
  assertEqual(clean.summary, '', 'null journal entry gets empty summary');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const staleKey = sceneCacheKey('Dirty Index Chat', 'Old Scene');
  const validRunKey = runJournalKey('Dirty Index Chat');
  const mismatchKey = runJournalKey('Mismatch Chat');
  await adapter.writeJson(SYSTEM_INDEX_KEY, {
    records: {
      [staleKey]: {
        key: staleKey,
        kind: 'sceneCache',
        chatKey: '../Dirty Index Chat',
        updatedAt: '2026-06-30T00:00:00.000Z',
        apiKey: 'index-secret',
        unexpected: 'drop-me'
      },
      unsafeKey: {
        key: '../../outside.json',
        kind: 'sceneCache',
        chatKey: 'Unsafe Chat',
        updatedAt: 'not-a-date'
      },
      [validRunKey]: {
        key: validRunKey,
        kind: 'runJournal',
        chatKey: 'Dirty Index Chat',
        updatedAt: 'not-a-date'
      },
      [mismatchKey]: {
        key: mismatchKey,
        kind: 'sceneCache',
        chatKey: 'Mismatch Chat'
      },
      'bad-kind': {
        key: 'bad-kind',
        kind: 'providerCall',
        chatKey: 'Bad Chat',
        authorization: 'bad-kind-secret'
      }
    }
  });
  await repo.saveSceneCache('Dirty Index Chat', 'New Scene', {});
  const index = await repo.readIndex();
  assertEqual(index.records[staleKey].key, staleKey, 'index record keeps key');
  assertEqual(index.records[staleKey].kind, 'sceneCache', 'index record keeps allowed kind');
  assertEqual(index.records[staleKey].chatKey, 'Dirty-Index-Chat', 'index record sanitizes chatKey');
  assertType(index.records[staleKey].updatedAt, 'string', 'index record keeps string updatedAt');
  assert(!Object.values(index.records).some((record) => record.key === '../../outside.json'), 'index drops unsafe path-like key');
  assert(index.records[validRunKey], 'index keeps valid run journal key');
  assertParseableTimestamp(index.records[validRunKey].updatedAt, 'index normalizes invalid updatedAt');
  assert(index.records[validRunKey].updatedAt !== 'not-a-date', 'index invalid updatedAt not preserved');
  assert(!index.records[mismatchKey], 'index drops records whose kind does not match key pattern');
  assertNoOwnField(index.records[staleKey], 'apiKey', 'index record drops secret field');
  assertNoOwnField(index.records[staleKey], 'unexpected', 'index record drops unexpected field');
  assert(!index.records['bad-kind'], 'index drops records with unsupported kind');
  assertNoSecret(index, 'index normalization removes raw secrets');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter, maxJournalEntries: 0 });
  await adapter.writeJson(runJournalKey('Bounds Chat'), {
    nextIndex: 'not-a-number',
    entries: [{ id: 'old', summary: 'old' }]
  });
  const loaded = await repo.loadRunJournal('Bounds Chat');
  assertEqual(loaded.maxEntries, 1, 'maxJournalEntries clamps to at least one');
  assertEqual(Number.isNaN(loaded.nextIndex), false, 'loaded journal nextIndex is numeric');
  await repo.appendJournal('Bounds Chat', { event: 'runtime.next', summary: 'new' });
  const journal = await repo.loadRunJournal('Bounds Chat');
  assertEqual(journal.entries.length, 1, 'clamped journal keeps one entry');
  assertEqual(Number.isNaN(journal.nextIndex), false, 'appended journal nextIndex is numeric');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter, maxJournalEntries: 999999 });
  await adapter.writeJson(runJournalKey('Upper Bound Chat'), {
    entries: Array.from({ length: 510 }, (_, index) => ({ id: `entry-${index}`, summary: `entry ${index}` }))
  });
  const journal = await repo.loadRunJournal('Upper Bound Chat');
  assertEqual(journal.maxEntries, 500, 'maxJournalEntries clamps to upper bound');
  assertEqual(journal.entries.length, 500, 'journal entries clamp to upper bound');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await adapter.writeJson(runJournalKey('Index Floor Chat'), {
    nextIndex: 0,
    entries: [
      { id: 'entry-1', summary: 'one' },
      { id: 'entry-2', summary: 'two' },
      { id: 'entry-3', summary: 'three' }
    ]
  });
  const loaded = await repo.loadRunJournal('Index Floor Chat');
  assertEqual(loaded.nextIndex, 3, 'journal nextIndex loads at least retained entry count');
  const { appendJournal } = repo;
  await appendJournal('Index Floor Chat', { event: 'runtime.next', summary: 'four' });
  const journal = await repo.loadRunJournal('Index Floor Chat');
  assertEqual(journal.nextIndex, 4, 'destructured appendJournal increments from normalized nextIndex');
}

console.log('[pass] storage');
