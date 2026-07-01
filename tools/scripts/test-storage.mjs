import {
  SYSTEM_INDEX_KEY,
  createMemoryStorageAdapter,
  createStorageRepository,
  sceneCacheKey,
  runJournalKey
} from '../../src/storage.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
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

function assertNoForbiddenDiagnosticText(value, message) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes('raw prompt body'), `${message}: raw prompt redacted`);
  assert(!serialized.includes('raw response body'), `${message}: raw response redacted`);
  assert(!serialized.includes('provider prompt body'), `${message}: provider prompt redacted`);
  assert(!serialized.includes('provider response body'), `${message}: provider response redacted`);
  assert(!serialized.includes('hidden reasoning body'), `${message}: hidden reasoning redacted`);
  assert(!serialized.includes('private story plan'), `${message}: private story plan redacted`);
  assert(!serialized.includes('private plan body'), `${message}: private plan redacted`);
  assert(!serialized.includes('session-id-value'), `${message}: session id redacted`);
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
  await repo.appendJournal('Chat One', {
    event: 'provider.call.started',
    summary: 'one',
    details: {
      apiKey: 'secret',
      rawPrompt: 'raw prompt body',
      providerResponse: 'provider response body',
      hiddenReasoning: 'hidden reasoning body',
      privatePlan: 'private plan body',
      sessionId: 'session-id-value',
      sessionCount: 2
    }
  });
  await repo.appendJournal('Chat One', { event: 'provider.call.completed', summary: 'two' });
  await repo.appendJournal('Chat One', { event: 'prompt.installed', summary: 'three' });
  const journal = await repo.loadRunJournal('Chat One');
  assertEqual(journal.entries.length, 3, 'journal pruned to max');
  assertEqual(journal.entries[0].summary, 'one', 'oldest entry pruned');
  assertEqual(journal.entries[0].details.apiKey, '[redacted]', 'journal redacts retained secrets');
  assertEqual(journal.entries[0].details.rawPrompt, '[redacted]', 'journal redacts raw prompt fields');
  assertEqual(journal.entries[0].details.providerResponse, '[redacted]', 'journal redacts provider response fields');
  assertEqual(journal.entries[0].details.hiddenReasoning, '[redacted]', 'journal redacts hidden reasoning fields');
  assertEqual(journal.entries[0].details.privatePlan, '[redacted]', 'journal redacts private plan fields');
  assertEqual(journal.entries[0].details.sessionId, '[redacted]', 'journal redacts session id fields');
  assertEqual(journal.entries[0].details.sessionCount, 2, 'journal preserves safe session count');
  assertNoSecret(journal.entries, 'journal redacts secrets');
  assertNoForbiddenDiagnosticText(journal.entries, 'journal redacts forbidden diagnostics');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.saveSceneCache('Card Privacy Chat', 'Scene One', {
    cards: [{
      id: 'privacy-card',
      family: 'Scene Frame',
      summary: 'rawPrompt: SYSTEM PROMPT TEXT credentials: session token',
      promptText: 'Visible card guidance with sk-card-secret and Cookie: sid=abc',
      inspectorNotes: 'private diagnostic notes with session-token-card'
    }]
  });
  const cache = await repo.loadSceneCache('Card Privacy Chat', 'Scene One');
  assertEqual(cache.cards[0].summary, '[redacted]', 'scene card summary redacts unsafe diagnostic text');
  assertEqual(cache.cards[0].promptText, '[redacted]', 'scene card promptText redacts unsafe secrets');
  assertEqual(cache.cards[0].inspectorNotes, '[redacted]', 'scene card inspector notes redact unsafe private notes');
  assert(!JSON.stringify(cache).includes('SYSTEM PROMPT TEXT'), 'scene cache omits raw prompt text');
  assert(!JSON.stringify(cache).includes('sk-card-secret'), 'scene cache omits sk token text');
  assert(!JSON.stringify(cache).includes('sid=abc'), 'scene cache omits cookie text');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.saveSceneCache('Slash Metadata Chat', 'Scene One', {
    cards: [{
      id: 'slash-card',
      family: 'Dialogue/Relationship',
      role: 'Environment/Items',
      catalogKey: 'Prose/Pacing',
      summary: 'safe summary',
      promptText: 'safe prompt'
    }]
  });
  const cache = await repo.loadSceneCache('Slash Metadata Chat', 'Scene One');
  assertEqual(cache.cards[0].family, 'Dialogue/Relationship', 'scene card family preserves category slash');
  assertEqual(cache.cards[0].role, 'Environment/Items', 'scene card role preserves category slash');
  assertEqual(cache.cards[0].catalogKey, 'Prose/Pacing', 'scene card catalog key preserves category slash');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.saveSceneCache('Card Metadata Privacy Chat', 'Scene One', {
    latestHand: {
      handId: 'hand-safe',
      composedAt: '2026-06-30T00:00:00.000Z',
      cardIds: ['card-safe', 'F:\\SillyTavern\\secret-card'],
      promptPacketHash: 'packet-safe',
      omitted: [
        { cardId: 'card-safe', reason: 'already active' },
        { cardId: 'unsafe-card', reason: 'private_plan: should not persist' }
      ],
      promptText: 'latest hand promptText should not persist',
      inspectorNotes: 'latest hand inspectorNotes should not persist',
      providerResponse: 'provider_response: hidden'
    },
    cards: [{
      id: 'card-safe',
      family: 'raw_prompt: hidden family',
      role: 'provider_response: hidden role',
      catalogKey: 'private_plan: hidden catalog',
      sceneId: 'session_key: hidden scene',
      evidenceRefs: [
        'safe-ref',
        'F:\\SillyTavern\\secret\\message.jsonl',
        'hidden_reasoning: evidence'
      ],
      sourceFingerprint: 'api_key: hidden fingerprint',
      source: {
        chatId: 'Cookie=sid-hidden',
        fingerprint: 'raw_prompt: source fingerprint',
        snapshotHash: 'provider_response: source snapshot'
      },
      arbiter: {
        lastDecisionId: 'session_key: decision',
        reason: 'Set-Cookie=sid-hidden'
      },
      arbiterDecisionHash: 'raw_prompt: hash',
      summary: 'safe summary',
      promptText: 'safe prompt'
    }]
  });
  const cache = await repo.loadSceneCache('Card Metadata Privacy Chat', 'Scene One');
  const serialized = JSON.stringify(cache);
  assertEqual(cache.latestHand.handId, 'hand-safe', 'latestHand keeps hand id');
  assertEqual(cache.latestHand.cardIds.length, 1, 'latestHand drops unsafe card ids');
  assertEqual(cache.latestHand.cardIds[0], 'card-safe', 'latestHand keeps safe card id');
  assertEqual(cache.latestHand.promptPacketHash, 'packet-safe', 'latestHand keeps safe prompt packet hash');
  assertEqual(cache.latestHand.omitted.length, 1, 'latestHand drops unsafe omission reasons');
  assert(!serialized.includes('latest hand promptText should not persist'), 'latestHand omits prompt text');
  assert(!serialized.includes('latest hand inspectorNotes should not persist'), 'latestHand omits inspector notes');
  assert(!serialized.includes('provider_response'), 'scene cache omits provider_response marker');
  assert(!serialized.includes('raw_prompt'), 'scene cache omits raw_prompt marker');
  assert(!serialized.includes('private_plan'), 'scene cache omits private_plan marker');
  assert(!serialized.includes('hidden_reasoning'), 'scene cache omits hidden_reasoning marker');
  assert(!serialized.includes('api_key'), 'scene cache omits api_key marker');
  assert(!serialized.includes('session_key'), 'scene cache omits session_key marker');
  assert(!serialized.includes('sid-hidden'), 'scene cache omits cookie values');
  assert(!serialized.includes('SillyTavern'), 'scene cache omits path-like refs');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.appendJournal('Hand Privacy Chat', {
    event: 'hand.selected',
    summary: 'Turn hand selected.',
    details: {
      handId: 'hand-privacy',
      selectedCount: 1,
      omittedCount: 0,
      listedCount: 1,
      truncated: false,
      promptText: 'top-level prompt text must not persist',
      inspectorNotes: 'top-level notes must not persist',
      cards: [{
        id: 'card-safe',
        family: 'Scene Frame',
        role: 'scene',
        emphasis: 'normal',
        detailProfile: 'standard',
        tokenEstimate: 12,
        promptText: 'card prompt text must not persist',
        inspectorNotes: 'card notes must not persist'
      }]
    }
  });
  const journal = await repo.loadRunJournal('Hand Privacy Chat');
  const details = journal.entries[0].details;
  assertEqual(details.handId, 'hand-privacy', 'hand.selected journal keeps hand id');
  assertEqual(details.selectedCount, 1, 'hand.selected journal keeps selected count');
  assertEqual(details.cards[0].id, 'card-safe', 'hand.selected journal keeps card id');
  assert(!JSON.stringify(journal).includes('prompt text must not persist'), 'hand.selected journal omits prompt text');
  assert(!JSON.stringify(journal).includes('notes must not persist'), 'hand.selected journal omits inspector notes');
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
      providerNote: 'contains sk-live-runtime and private-secret text',
      rawPrompt: 'raw prompt body',
      rawResponse: 'raw response body',
      providerPrompt: 'provider prompt body',
      providerResponse: 'provider response body',
      hiddenReasoning: 'hidden reasoning body',
      privateStoryPlan: 'private story plan',
      privatePlan: 'private plan body',
      sessionId: 'session-id-value'
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
  assertNoForbiddenDiagnosticText(cache.invalidation, 'scene cache invalidation metadata');

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
  assertNoForbiddenDiagnosticText(entry, 'cache invalidated journal entry');

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
  assertEqual(activityEvents[0].phase, 'storageProgress', 'save emits logical storage progress start');
  assertEqual(activityEvents[1].phase, 'storageProgress', 'save emits logical storage progress completion');
  assertEqual(activityEvents[0].logicalStage, 'Updating scene cache', 'save reports logical cache update stage');
  assertEqual(activityEvents[1].logicalStage, 'Storage ready', 'save reports logical storage ready stage');
  assertType(activityEvents[0].operationId, 'string', 'save progress has stable operation id');
  assertEqual(activityEvents[1].operationId, activityEvents[0].operationId, 'save progress reuses operation id');
  assert(!JSON.stringify(activityEvents).includes('recursion-scene-Unsafe-Chat-Unsafe-Scene.v1.json'), 'save progress does not expose scene cache filename');

  const reporterEvents = [];
  const reporter = createActivityReporter({ onEvent: (event) => reporterEvents.push(event) });
  const reporterRun = reporter.start({ runId: 'storage-reporter-run', label: 'Storage reporter run' });
  const reporterRepo = createStorageRepository({ storage: createMemoryStorageAdapter(), activity: reporter });
  await reporterRepo.saveSceneCache('Reporter Chat', 'Reporter Scene', {
    cards: [{ id: 'reporter-card', promptText: 'keep' }]
  });
  const reporterProgress = reporterEvents.filter((event) => event.phase === 'storageProgress');
  assertEqual(reporterProgress.length, 2, 'real activity reporter records storage progress events');
  assertEqual(reporterProgress[0].runId, reporterRun.runId, 'storage progress uses active reporter run');
  assertEqual(reporterProgress[0].logicalStage, 'Updating scene cache', 'real reporter preserves storage logical start');
  assertEqual(reporterProgress[1].logicalStage, 'Storage ready', 'real reporter preserves storage logical completion');
  assertEqual(reporterProgress[1].operationId, reporterProgress[0].operationId, 'real reporter preserves shared storage operation id');

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
      handId: 'hand-1',
      composedAt: '2026-06-30T00:00:00.000Z',
      cardIds: ['nested-card'],
      promptPacketHash: 'packet-nested',
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
  assertEqual(persisted.latestHand.handId, 'hand-1', 'latestHand keeps allowlisted handId');
  assertNoOwnField(persisted.latestHand, 'provider', 'latestHand drops non-contract provider metadata');
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
  assertEqual(entry.event, 'activity.stage_changed', 'journal entry object event falls back to canonical default');
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
  assertEqual(clean.event, 'activity.stage_changed', 'null journal entry gets canonical default event');
  assertEqual(clean.summary, '', 'null journal entry gets empty summary');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const clean = await repo.appendJournal('Event Gate Chat', {
    id: 'F:\\SillyTavern\\secret\\entry.json',
    event: 'raw.provider.response.should.not.persist',
    summary: `${'SYSTEM PROMPT TEXT '.repeat(40)} rawPrompt: credentials: live session token; Set-Cookie: sid=abc`,
    runId: 'F:\\SillyTavern\\secret\\chat.jsonl',
    sceneKey: '../Bearer scene-token',
    details: {
      debugRawPrompt: 'SYSTEM PROMPT TEXT without marker',
      rawPromptText: 'raw prompt value without canonical key',
      providerResponseText: 'provider response value without marker',
      authorizationHeader: 'plain authorization header value',
      cookieHeader: 'sid=plain-cookie-value',
      apiKeyValue: 'plain api key value',
      selectedTokenEstimate: 42,
      nested: `${'visible detail '.repeat(60)} rawPrompt: credentials: live session token; Cookie: sid=abc`,
      variants: 'raw_prompt provider_response hidden_reasoning private_plan api_key session_key Cookie=sid Set-Cookie=sid',
      prefixedPath: 'path=F:\\SillyTavern\\secret\\cache.json',
      prefixedUrl: 'url=https://provider-change.test/v1/raw.json',
      path: 'F:\\SillyTavern\\secret\\cache.json',
      sessionKey: 'sessionKey: abc123'
    }
  });
  assertEqual(clean.event, 'activity.stage_changed', 'unknown journal event normalizes to canonical default');
  const journal = await repo.loadRunJournal('Event Gate Chat');
  assertEqual(journal.entries[0].event, 'activity.stage_changed', 'persisted unknown event is canonical default');
  assert(!journal.entries[0].id.includes('SillyTavern'), 'journal id redacts path-like source id');
  assertEqual(journal.entries[0].runId, undefined, 'unsafe journal run id is omitted');
  assertEqual(journal.entries[0].sceneKey, undefined, 'unsafe journal scene key is omitted');
  assert(!JSON.stringify(journal).includes('raw.provider.response.should.not.persist'), 'unknown event name is not persisted');
  assert(!JSON.stringify(journal).includes('SYSTEM PROMPT TEXT'), 'journal summary redacts raw prompt text');
  assert(!JSON.stringify(journal).includes('credentials'), 'journal summary redacts credential text');
  assert(!JSON.stringify(journal).includes('session token'), 'journal summary redacts session token text');
  assert(!JSON.stringify(journal).includes('sid=abc'), 'journal summary redacts cookie text');
  assert(!JSON.stringify(journal).includes('abc123'), 'journal details redact session key text');
  assert(!JSON.stringify(journal).includes('raw_prompt'), 'journal details redact raw_prompt variant');
  assert(!JSON.stringify(journal).includes('provider_response'), 'journal details redact provider_response variant');
  assert(!JSON.stringify(journal).includes('hidden_reasoning'), 'journal details redact hidden_reasoning variant');
  assert(!JSON.stringify(journal).includes('private_plan'), 'journal details redact private_plan variant');
  assert(!JSON.stringify(journal).includes('api_key'), 'journal details redact api_key variant');
  assert(!JSON.stringify(journal).includes('session_key'), 'journal details redact session_key variant');
  assert(!JSON.stringify(journal).includes('Cookie='), 'journal details redact Cookie= variant');
  assert(!JSON.stringify(journal).includes('Set-Cookie='), 'journal details redact Set-Cookie= variant');
  assert(!JSON.stringify(journal).includes('SillyTavern'), 'journal details redact path-like text');
  assert(!JSON.stringify(journal).includes('provider-change.test'), 'journal details redact prefixed URL text');
  assertEqual(journal.entries[0].summary, '[redacted]', 'unsafe journal summary redacts whole summary');
  assertEqual(journal.entries[0].details.debugRawPrompt, '[redacted]', 'unsafe raw prompt key redacts value without marker');
  assertEqual(journal.entries[0].details.rawPromptText, '[redacted]', 'unsafe raw prompt suffix key redacts value without marker');
  assertEqual(journal.entries[0].details.providerResponseText, '[redacted]', 'unsafe provider response suffix key redacts value without marker');
  assertEqual(journal.entries[0].details.authorizationHeader, '[redacted]', 'authorization header key redacts value without marker');
  assertEqual(journal.entries[0].details.cookieHeader, '[redacted]', 'cookie header key redacts value without marker');
  assertEqual(journal.entries[0].details.apiKeyValue, '[redacted]', 'api key value key redacts value without marker');
  assertEqual(journal.entries[0].details.selectedTokenEstimate, 42, 'safe token estimate counter survives key screening');
  assertEqual(journal.entries[0].details.nested, '[redacted]', 'unsafe nested string journal details redact whole value');
  assertEqual(journal.entries[0].details.variants, '[redacted]', 'unsafe variant string journal details redact whole value');
  assertEqual(journal.entries[0].details.prefixedPath, '[redacted]', 'prefixed path-like journal details redact whole value');
  assertEqual(journal.entries[0].details.prefixedUrl, '[redacted]', 'prefixed URL-like journal details redact whole value');
  assertEqual(journal.entries[0].details.path, '[redacted]', 'path-like journal details redact whole value');
  assertNoRawSecretText(journal, 'journal summary redacts raw secret text');
  assertNoSecret(journal, 'unknown event normalization keeps redaction');
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
  await repo.appendJournal('Bounds Chat', { event: 'activity.settled', summary: 'new' });
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
  await appendJournal('Index Floor Chat', { event: 'activity.settled', summary: 'four' });
  const journal = await repo.loadRunJournal('Index Floor Chat');
  assertEqual(journal.nextIndex, 4, 'destructured appendJournal increments from normalized nextIndex');
}

console.log('[pass] storage');
