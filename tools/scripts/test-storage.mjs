import {
  SYSTEM_INDEX_KEY,
  createMemoryStorageAdapter,
  createStorageRepository,
  runJournalKey
} from '../../src/storage.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

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
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert(!text.includes('[object Object]') && !text.includes('object-Object'), message);
}

assertEqual(runJournalKey('Chat One'), 'recursion-run-journal-Chat-One.v1.json', 'journal key sanitized');

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  for (const prefix of ['load', 'save', 'invalidate', 'clear']) {
    assertEqual(typeof repo[`${prefix}SceneCache`], 'undefined', `repository does not expose ${prefix} scene-cache authority`);
  }
  await repo.appendJournal('Failure Contract Chat', {
    event: 'provider.call.failed',
    severity: 'error',
    summary: 'Provider call failed.'
  });
  await repo.appendJournal('Failure Contract Chat', {
    event: 'prompt.install_skipped',
    severity: 'warn',
    summary: 'Prompt install skipped.',
    details: {
      failure: {
        code: 'RECURSION_PROMPT_STALE',
        stage: 'prompt-install',
        category: 'stale-state',
        message: 'Host turn changed before prompt installation.',
        retryable: true
      }
    }
  });
  const journal = await repo.loadRunJournal('Failure Contract Chat');
  assertEqual(
    journal.entries[0].details.failure.message,
    'Recursion hit an unexpected internal error.',
    'unexplained error journal entries receive a readable internal descriptor'
  );
  assertEqual(
    journal.entries[1].details.failure.message,
    'Host turn changed before prompt installation.',
    'explicit warning journal failure descriptor remains authoritative'
  );
}

{
  const privatePlanPayload = 'future branch plan payload must not persist';
  const sessionIdPayload = 'session-live-payload-12345';
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.appendJournal('Payload Redaction Chat', {
    event: 'provider.call.started',
    summary: 'payload redaction coverage',
    details: {
      privatePlanPayload,
      sessionIdPayload,
      nestedPrivatePlan: `privatePlan: ${privatePlanPayload}`,
      nestedSessionId: `sessionId=${sessionIdPayload}`,
      sessionCount: 2
    }
  });
  const persisted = adapter.dump();
  const journalDetails = persisted[runJournalKey('Payload Redaction Chat')].entries[0].details;
  const serializedStorage = JSON.stringify(persisted);
  assertEqual(journalDetails.privatePlanPayload, '[redacted]', 'storage journal privatePlan payload key redacted');
  assertEqual(journalDetails.sessionIdPayload, '[redacted]', 'storage journal sessionId payload key redacted');
  assertEqual(journalDetails.nestedPrivatePlan, '[redacted]', 'storage journal privatePlan payload text redacted');
  assertEqual(journalDetails.nestedSessionId, '[redacted]', 'storage journal sessionId payload text redacted');
  assertEqual(journalDetails.sessionCount, 2, 'storage journal preserves safe session count');
  assert(!serializedStorage.includes(privatePlanPayload), 'serialized storage omits raw privatePlan payload');
  assert(!serializedStorage.includes(sessionIdPayload), 'serialized storage omits raw sessionId payload');
  assert(serializedStorage.includes('[redacted]'), 'serialized storage includes redaction marker');
}


{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.appendJournal('Journal Clear Chat', { event: 'runtime.started', summary: 'started' });
  assert(adapter.dump()[runJournalKey('Journal Clear Chat')], 'run journal exists before clear');
  let index = await repo.readIndex();
  assert(index.records[runJournalKey('Journal Clear Chat')], 'run journal is indexed before clear');
  const result = await repo.clearRunJournal('Journal Clear Chat');
  assertEqual(result.ok, true, 'clearRunJournal succeeds');
  assertEqual(result.key, runJournalKey('Journal Clear Chat'), 'clearRunJournal reports owned key');
  assert(!adapter.dump()[runJournalKey('Journal Clear Chat')], 'run journal file removed');
  index = await repo.readIndex();
  assert(!index.records[runJournalKey('Journal Clear Chat')], 'run journal index entry removed');
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
  const clean = await repo.appendJournal('Capability Chat', {
    event: 'provider.capability.changed',
    severity: 'info',
    summary: 'Reasoner provider capability untested to ready.',
    details: {
      lane: 'reasoner',
      kind: 'health',
      changedKeys: [],
      beforeState: 'untested',
      afterState: 'ready',
      configRevision: 4,
      configHash: '7e23c91a',
      stale: false
    }
  });
  assertEqual(clean.event, 'provider.capability.changed', 'provider capability event survives the journal allowlist');
  assertDeepEqual(clean.details, {
    lane: 'reasoner',
    kind: 'health',
    changedKeys: [],
    beforeState: 'untested',
    afterState: 'ready',
    configRevision: 4,
    configHash: '7e23c91a',
    stale: false
  }, 'provider capability event retains bounded safe transition evidence');
  const journal = await repo.loadRunJournal('Capability Chat');
  assertEqual(journal.entries[0].event, 'provider.capability.changed', 'provider capability event persists canonically');
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
      variants: 'raw_prompt provider_response hidden_reasoning reasoning_details reasoning_content private_plan api_key session_key Cookie=sid Set-Cookie=sid',
      nativeReasoningMarkers: 'reasoning_details reasoning_content',
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
  assert(!JSON.stringify(journal).includes('reasoning_details'), 'journal details redact reasoning_details variant');
  assert(!JSON.stringify(journal).includes('reasoning_content'), 'journal details redact reasoning_content variant');
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
  assertEqual(journal.entries[0].details.nativeReasoningMarkers, '[redacted]', 'unsafe native reasoning marker string journal details redact whole value');
  assertEqual(journal.entries[0].details.prefixedPath, '[redacted]', 'prefixed path-like journal details redact whole value');
  assertEqual(journal.entries[0].details.prefixedUrl, '[redacted]', 'prefixed URL-like journal details redact whole value');
  assertEqual(journal.entries[0].details.path, '[redacted]', 'path-like journal details redact whole value');
  assertNoRawSecretText(journal, 'journal summary redacts raw secret text');
  assertNoSecret(journal, 'unknown event normalization keeps redaction');
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

{
  const adapter = createMemoryStorageAdapter();
  let retention = { runJournalEntries: 10 };
  const repo = createStorageRepository({
    storage: adapter,
    getRetentionSettings: () => retention
  });
  for (let index = 0; index < 12; index += 1) {
    await repo.appendJournal('Dynamic Journal Chat', { event: 'activity.settled', summary: `entry-${index}` });
  }
  let journal = await repo.loadRunJournal('Dynamic Journal Chat');
  assertEqual(journal.maxEntries, 10, 'dynamic retention starts at ten entries');
  assertDeepEqual(
    journal.entries.map((entry) => entry.summary),
    ['entry-2', 'entry-3', 'entry-4', 'entry-5', 'entry-6', 'entry-7', 'entry-8', 'entry-9', 'entry-10', 'entry-11'],
    'dynamic journal retention prunes to current cap'
  );

  retention = { runJournalEntries: 12 };
  await repo.appendJournal('Dynamic Journal Chat', { event: 'activity.settled', summary: 'entry-12' });
  journal = await repo.loadRunJournal('Dynamic Journal Chat');
  assertEqual(journal.maxEntries, 12, 'dynamic retention expands on next append');
  assertDeepEqual(
    journal.entries.map((entry) => entry.summary),
    ['entry-2', 'entry-3', 'entry-4', 'entry-5', 'entry-6', 'entry-7', 'entry-8', 'entry-9', 'entry-10', 'entry-11', 'entry-12'],
    'dynamic journal keeps retained entries plus new append after expansion'
  );
}



{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.savePipelineArtifact(
    'Orphan Artifact Chat',
    'superseded-operation',
    'preprocess.arbiter',
    { body: 'orphan body' }
  );
  const repaired = await repo.repairIndex();
  assertEqual(
    await repo.loadPipelineArtifact(
      'Orphan Artifact Chat',
      'superseded-operation',
      'preprocess.arbiter'
    ),
    null,
    'repair removes an artifact that is not referenced by an authoritative manifest'
  );
  assert(
    repaired.pruned.some((entry) => (
      entry.kind === 'pipelineArtifact'
      && entry.reason === 'orphaned-pipeline-artifact'
    )),
    'repair reports orphan artifact cleanup without exposing its body'
  );
}


{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const retiredKey = 'recursion-scene-Turn-Storage-Chat-Retired-Scene.v1.json';
  const retiredRunKey = 'recursion-pipeline-run-Turn-Storage-Chat.v1.json';
  const retiredArtifactKey = 'recursion-pipeline-artifact-Turn-Storage-Chat-operation-old-preprocess.packet.stage-old-v1.json';
  const retiredQueueKey = 'recursion-queued-reprocess-Turn-Storage-Chat.v1.json';
  await adapter.writeJson(retiredKey, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1,
    chatKey: 'Turn-Storage-Chat',
    sceneKey: 'Retired-Scene',
    cards: []
  });
  await adapter.writeJson(retiredRunKey, { manifest: { schema: 'recursion.pipelineRun.v1' } });
  await adapter.writeJson(retiredArtifactKey, { artifact: { body: 'retired pipeline body' } });
  await adapter.writeJson(retiredQueueKey, { schema: 'recursion.queuedReprocess.v1' });
  await repo.appendJournal('Turn Storage Chat', {
    event: 'runtime.started',
    severity: 'info',
    summary: 'durable journal entry'
  });
  await repo.saveLastBrief('Turn Storage Chat', {
    turnKeyHash: 'turn-storage-a',
    status: 'historical',
    packet: { packetId: 'packet-a', prompt: 'display-only packet' },
    hand: { cards: [{ id: 'card-a', promptText: 'display-only card' }] },
    committedAt: '2026-08-01T12:00:00.000Z'
  });
  const retired = await repo.pruneRetiredGeneratedRecords();
  assertEqual(retired.ok, true, 'retired generated cleanup succeeds');
  assertEqual(
    await adapter.readJson(retiredKey),
    null,
    'retired generated cleanup removes legacy scene authority'
  );
  assertEqual(await adapter.readJson(retiredRunKey), null, 'retired cleanup removes V1 pipeline manifests');
  assertEqual(await adapter.readJson(retiredArtifactKey), null, 'retired cleanup removes V1 pipeline artifacts');
  assertEqual(await adapter.readJson(retiredQueueKey), null, 'retired cleanup removes V1 queued intents');
  assertEqual(
    (await repo.loadRunJournal('Turn Storage Chat')).entries.length,
    1,
    'retired generated cleanup preserves the run journal'
  );
  assertEqual(
    (await repo.loadLastBrief('Turn Storage Chat')).turnKeyHash,
    'turn-storage-a',
    'retired generated cleanup preserves isolated Last Brief data'
  );
  assert(
    !Object.values((await repo.readIndex()).records).some((record) => record.kind === 'sceneCache'),
    'retired generated cleanup removes scene-cache index authority'
  );
}

console.log('[pass] storage');
