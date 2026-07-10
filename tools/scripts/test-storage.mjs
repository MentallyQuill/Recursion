import {
  SYSTEM_INDEX_KEY,
  createMemoryStorageAdapter,
  createStorageRepository,
  sceneCacheKey,
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

assertEqual(sceneCacheKey('Chat One', 'Scene/One'), 'recursion-scene-Chat-One-Scene-One.v1.json', 'scene key sanitized');
assertEqual(runJournalKey('Chat One'), 'recursion-run-journal-Chat-One.v1.json', 'journal key sanitized');

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
      family: 'Relationship',
      role: 'Environment',
      catalogKey: 'Scene-Constraints',
      summary: 'safe summary',
      promptText: 'safe prompt'
    }]
  });
  const cache = await repo.loadSceneCache('Slash Metadata Chat', 'Scene One');
  assertEqual(cache.cards[0].family, 'Relationship', 'scene card family preserves category label');
  assertEqual(cache.cards[0].role, 'Environment', 'scene card role preserves category label');
  assertEqual(cache.cards[0].catalogKey, 'Scene-Constraints', 'scene card catalog key preserves category label');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.saveSceneCache('Swipe Variant Chat', 'Scene One', {
    activeSourceRevisionHash: 'source-rev-b',
    variantOrder: ['source-rev-a', 'source-rev-b'],
    variants: {
      'source-rev-a': {
        sourceRevisionHash: 'source-rev-a',
        cards: [{
          id: 'variant-a-card',
          family: 'Scene Frame',
          summary: 'variant A summary',
          promptText: 'Variant A card guidance.',
          evidenceRefs: ['message:2'],
          source: {
            chatId: 'Swipe Variant Chat',
            firstMesId: 2,
            lastMesId: 2,
            fingerprint: 'source-rev-a',
            snapshotHash: 'source-rev-a',
            sourceRevisionHash: 'source-rev-a'
          },
          freshness: { sourceFingerprint: 'source-rev-a' }
        }],
        latestHand: { handId: 'hand-a', cardIds: ['variant-a-card'], promptPacketHash: 'packet-a' }
      },
      'source-rev-b': {
        sourceRevisionHash: 'source-rev-b',
        cards: [{
          id: 'variant-b-card',
          family: 'Scene Frame',
          summary: 'variant B summary',
          promptText: 'Variant B card guidance.',
          evidenceRefs: ['message:2'],
          origin: 'cache',
          source: {
            chatId: 'Swipe Variant Chat',
            firstMesId: 2,
            lastMesId: 2,
            fingerprint: 'source-rev-b',
            snapshotHash: 'source-rev-b',
            sourceRevisionHash: 'source-rev-b'
          },
          freshness: { sourceFingerprint: 'source-rev-b' }
        }],
        latestHand: { handId: 'hand-b', cardIds: ['variant-b-card'], promptPacketHash: 'packet-b' }
      }
    }
  });
  const cache = await repo.loadSceneCache('Swipe Variant Chat', 'Scene One');
  assertEqual(cache.activeSourceRevisionHash, 'source-rev-b', 'scene cache records active source revision');
  assertDeepEqual(cache.variantOrder, ['source-rev-a', 'source-rev-b'], 'scene cache preserves bounded variant order');
  assertEqual(cache.variants['source-rev-a'].cards[0].source.sourceRevisionHash, 'source-rev-a', 'variant cards preserve source revision');
  assertEqual(cache.variants['source-rev-b'].cards[0].origin, 'cache', 'variant cards preserve safe origin metadata');
  assertEqual(cache.variants['source-rev-b'].latestHand.handId, 'hand-b', 'variant latest hand is normalized');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.saveSceneCache('Rapid Cache Chat', 'Rapid Scene', {
    activeSourceRevisionHash: 'base-source',
    variantOrder: ['base-source'],
    variants: {
      'base-source': {
        sourceRevisionHash: 'base-source',
        cards: [],
        rapid: {
          pipelineVersion: 2,
          status: 'ready',
          warmArtifactId: 'rapid-warm-v2',
          baseSourceRevisionHash: 'base-source',
          baseSnapshotHash: 'base-snapshot',
          selectedCardIds: ['card-a'],
          cardIds: ['card-a', 'card-b'],
          guidance: {
            schema: 'recursion.guidanceComposer.v1',
            status: 'used',
            text: 'Warm provider guidance.',
            sourceCardIds: ['card-a'],
            guardrailCardIds: ['card-b'],
            omittedCardIds: [{ id: 'card-b', reason: 'lower-priority' }],
            diagnostics: ['guidance-ok', '[object Object]'],
            rawProviderResponse: 'must not persist'
          },
          storyForm: {
            schema: 'recursion.storyForm.v1',
            tense: 'past',
            pov: 'third-person-limited',
            confidence: 'high',
            evidenceRefs: ['message:2'],
            reason: 'Warm assistant narration establishes form.'
          },
          settingsHash: 'settings-hash',
          providerContractHash: 'provider-hash',
          cardCatalogHash: 'catalog-hash',
          promptContractHash: 'prompt-hash',
          diagnostics: ['rapid-warm-ready', '[object Object]'],
          rawProviderResponse: 'must not persist'
        }
      }
    }
  });
  const rapidCache = await repo.loadSceneCache('Rapid Cache Chat', 'Rapid Scene');
  assertEqual(
    rapidCache.variants['base-source'].rapid.warmArtifactId,
    'rapid-warm-v2',
    'rapid warm artifact id persists'
  );
  assertEqual(
    rapidCache.variants['base-source'].rapid.rawProviderResponse,
    undefined,
    'rapid raw provider response is dropped'
  );
  assertEqual(
    rapidCache.variants['base-source'].rapid.status,
    'ready',
    'rapid warm status persists'
  );
  assertEqual(
    rapidCache.variants['base-source'].rapid.guidance.text,
    'Warm provider guidance.',
    'rapid warm V2 guidance persists'
  );
  assertDeepEqual(
    rapidCache.variants['base-source'].rapid.selectedCardIds,
    ['card-a'],
    'rapid warm V2 selected card ids persist'
  );
  assertEqual(
    rapidCache.variants['base-source'].rapid.storyForm.tense,
    'past',
    'rapid warm V2 story tense persists'
  );
  assertEqual(
    rapidCache.variants['base-source'].rapid.storyForm.pov,
    'third-person-limited',
    'rapid warm V2 story pov persists'
  );
  assertEqual(
    rapidCache.variants['base-source'].rapid.conditionedSceneBrief,
    undefined,
    'rapid V1 conditionedSceneBrief is dropped'
  );
  assertNoObjectString(rapidCache.variants['base-source'].rapid, 'rapid warm artifact drops object-string diagnostics');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.saveSceneCache('Rapid Failed Chat', 'Rapid Failed Scene', {
    activeSourceRevisionHash: 'source-a',
    variantOrder: ['source-a'],
    variants: {
      'source-a': {
        sourceRevisionHash: 'source-a',
        rapid: {
          pipelineVersion: 2,
          status: 'failed',
          warmArtifactId: 'rapid-warm-failed',
          baseSourceRevisionHash: 'source-a',
          startedAt: '2026-07-03T08:00:00.000Z',
          failedAt: '2026-07-03T08:00:03.000Z',
          failureReasonCode: 'warm-failed',
          failureReasonLabel: 'authorization: Bearer rapid-storage-token'
        }
      }
    }
  });
  const cache = await repo.loadSceneCache('Rapid Failed Chat', 'Rapid Failed Scene');
  const rapid = cache.variants['source-a'].rapid;
  assertEqual(rapid.status, 'failed', 'rapid failed status persists');
  assertEqual(rapid.startedAt, '2026-07-03T08:00:00.000Z', 'rapid warm startedAt persists');
  assertEqual(rapid.failedAt, '2026-07-03T08:00:03.000Z', 'rapid warm failedAt persists');
  assertEqual(rapid.failureReasonCode, 'warm-failed', 'rapid warm failure reason code persists');
  assert(!JSON.stringify(rapid).includes('Bearer'), 'rapid warm failure label is sanitized');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  await repo.saveSceneCache('Swipe Variant Bound Chat', 'Scene One', {
    activeSourceRevisionHash: 'source-rev-e',
    variantOrder: ['source-rev-a', 'source-rev-b', 'source-rev-c', 'source-rev-d', 'source-rev-e'],
    variants: {
      'source-rev-a': { sourceRevisionHash: 'source-rev-a', cards: [] },
      'source-rev-b': { sourceRevisionHash: 'source-rev-b', cards: [] },
      'source-rev-c': { sourceRevisionHash: 'source-rev-c', cards: [] },
      'source-rev-d': { sourceRevisionHash: 'source-rev-d', cards: [] },
      'source-rev-e': { sourceRevisionHash: 'source-rev-e', cards: [] }
    }
  });
  const cache = await repo.loadSceneCache('Swipe Variant Bound Chat', 'Scene One');
  assertDeepEqual(cache.variantOrder, ['source-rev-b', 'source-rev-c', 'source-rev-d', 'source-rev-e'], 'scene cache keeps only four newest source variants');
  assert(!cache.variants['source-rev-a'], 'scene cache prunes oldest source variant');
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
  assertEqual(saved.recursionVersion, '0.1.0-pre-alpha.2', 'scene cache version canonical');
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

  const fallbackWrites = new Map();
  const fallbackActivityEvents = [];
  const fallbackRepo = createStorageRepository({
    storage: {
      async readJson(key) {
        return fallbackWrites.has(key) ? fallbackWrites.get(key) : null;
      },
      async writeJson(key, value) {
        fallbackWrites.set(key, value);
        return { ok: true, key, fallback: 'memory', detail: 'sk-storage-secret' };
      },
      async deleteJson(key) {
        fallbackWrites.delete(key);
        return { ok: true, key, fallback: 'memory' };
      }
    },
    activity: {
      stage(event) {
        fallbackActivityEvents.push(event);
      }
    }
  });
  const fallbackSaved = await fallbackRepo.saveSceneCache('Fallback Storage Chat', 'Scene', {});
  const serializedFallbackEvents = JSON.stringify(fallbackActivityEvents);
  assertEqual(fallbackSaved.storageStatus.persisted, false, 'fallback save returns non-durable storage status');
  assertEqual(fallbackSaved.storageStatus.fallback, 'memory', 'fallback save records memory fallback status');
  assert(fallbackActivityEvents.some((event) => event.phase === 'storageWarning' && event.severity === 'warning'), 'fallback save emits storage warning activity');
  assert(fallbackActivityEvents.some((event) => event.logicalStage === 'Storage fallback'), 'fallback save reports fallback logical stage');
  assert(!fallbackActivityEvents.some((event) => event.logicalStage === 'Storage ready'), 'fallback save does not report durable storage ready');
  assert(!serializedFallbackEvents.includes('sk-storage-secret'), 'fallback storage warning omits adapter secret details');

  const indexFallbackActivityEvents = [];
  const indexFallbackRepo = createStorageRepository({
    storage: {
      async readJson() {
        return null;
      },
      async writeJson(key) {
        if (key === SYSTEM_INDEX_KEY) return { ok: true, key, fallback: 'memory' };
        return { ok: true, key };
      },
      async deleteJson(key) {
        return { ok: true, key };
      }
    },
    activity: {
      stage(event) {
        indexFallbackActivityEvents.push(event);
      }
    }
  });
  const indexFallbackSaved = await indexFallbackRepo.saveSceneCache('Index Fallback Chat', 'Scene', {});
  assertEqual(indexFallbackSaved.storageStatus.persisted, false, 'index fallback save returns non-durable storage status');
  assertEqual(indexFallbackSaved.storageStatus.fallback, 'memory', 'index fallback save records memory fallback status');
  assert(indexFallbackActivityEvents.some((event) => event.phase === 'storageWarning'), 'index fallback save emits storage warning');
  assert(!indexFallbackActivityEvents.some((event) => event.logicalStage === 'Storage ready'), 'index fallback save does not report durable ready');

  let failedSceneIndexWriteAttempted = false;
  const failedSceneRepo = createStorageRepository({
    storage: {
      async readJson() {
        return null;
      },
      async writeJson(key) {
        if (key === SYSTEM_INDEX_KEY) {
          failedSceneIndexWriteAttempted = true;
          return { ok: true, key };
        }
        return { ok: false, key, fallback: 'memory', detail: 'sk-write-failed-secret' };
      },
      async deleteJson(key) {
        return { ok: true, key };
      }
    },
    activity: { stage() {} }
  });
  const failedSceneSaved = await failedSceneRepo.saveSceneCache('Failed Scene Write Chat', 'Scene', {});
  assertEqual(failedSceneSaved.storageStatus.persisted, false, 'ok false scene write returns non-durable storage status');
  assertEqual(failedSceneSaved.storageStatus.reason, 'write-failed', 'ok false scene write takes precedence over fallback label');
  assertEqual(failedSceneSaved.storageStatus.fallback, undefined, 'ok false scene write does not masquerade as fallback');
  assertEqual(failedSceneIndexWriteAttempted, false, 'ok false scene write does not update index');

  const unsafeFallbackEvents = [];
  const unsafeFallbackRepo = createStorageRepository({
    storage: {
      async readJson() {
        return null;
      },
      async writeJson(key) {
        return { ok: true, key, fallback: 'Bearer unsafe-fallback-token sk-unsafe-fallback' };
      },
      async deleteJson(key) {
        return { ok: true, key };
      }
    },
    activity: {
      stage(event) {
        unsafeFallbackEvents.push(event);
      }
    }
  });
  const unsafeFallbackSaved = await unsafeFallbackRepo.saveSceneCache('Unsafe Fallback Chat', 'Scene', {});
  const serializedUnsafeFallback = JSON.stringify({ saved: unsafeFallbackSaved, events: unsafeFallbackEvents });
  assertEqual(unsafeFallbackSaved.storageStatus.persisted, false, 'unsafe fallback label still returns non-durable storage status');
  assertEqual(unsafeFallbackSaved.storageStatus.fallback, 'unknown', 'unsafe fallback label defaults to unknown');
  assert(serializedUnsafeFallback.includes('"fallback":"unknown"'), 'unsafe fallback warning records unknown fallback label');
  assert(!serializedUnsafeFallback.includes('unsafe-fallback-token'), 'unsafe fallback warning redacts bearer token');
  assert(!serializedUnsafeFallback.includes('sk-unsafe-fallback'), 'unsafe fallback warning redacts sk token');

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
  assertNoOwnField(persisted.source, 'name', 'scene cache source drops non-contract name metadata');
  assertNoOwnField(persisted.source, 'authorization', 'scene cache source drops non-contract authorization metadata');
  assertEqual(persisted.versions.prompt.token, '[redacted]', 'versions nested token redacted');
  assertNoSecret(persisted, 'scene cache nested metadata contains no raw secrets');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const key = sceneCacheKey('Source Boundary Chat', 'Scene Cache');
  const longExcerpt = `${'Visible excerpt. '.repeat(40)}Bearer source-token should redact.`;
  await repo.saveSceneCache('Source Boundary Chat', 'Scene Cache', {
    source: {
      chatIdHash: 'chat-hash-safe',
      firstMesId: 2,
      lastMesId: 5,
      latestMesId: 8,
      sceneFingerprint: 'scene-fingerprint-safe',
      chatWindowHash: 'window-hash-safe',
      transcript: 'Full transcript text must not persist.',
      messages: [{ text: 'Message text must not persist.' }],
      arbitrary: { providerPrompt: 'provider prompt body' },
      sourceRefs: [
        {
          refId: 'message:2-5',
          firstMesId: 2,
          lastMesId: 5,
          textHash: 'text-hash-safe',
          role: 'assistant',
          excerpt: longExcerpt
        },
        {
          refId: 'F:\\SillyTavern\\unsafe\\chat.jsonl',
          firstMesId: 1,
          lastMesId: 1,
          textHash: 'unsafe-path-ref',
          role: 'user',
          excerpt: 'Unsafe path ref must not persist.'
        },
        {
          refId: 'message:7',
          firstMesId: 7,
          lastMesId: 7,
          textHash: 'Bearer source-ref-token',
          role: 'user',
          excerpt: 'Unsafe token hash must not persist.'
        }
      ]
    }
  });
  const persisted = adapter.dump()[key];
  assertDeepEqual(
    Object.keys(persisted.source).sort(),
    ['chatIdHash', 'chatWindowHash', 'firstMesId', 'lastMesId', 'latestMesId', 'sceneFingerprint', 'sceneStatus', 'sourceRefs', 'sourceRevisionHash', 'sourceWindowHash'].sort(),
    'scene cache source keeps only allowlisted source metadata fields'
  );
  assertEqual(persisted.source.chatIdHash, 'chat-hash-safe', 'scene source keeps safe chat hash');
  assertEqual(persisted.source.firstMesId, 2, 'scene source keeps first message id');
  assertEqual(persisted.source.lastMesId, 5, 'scene source keeps last message id');
  assertEqual(persisted.source.latestMesId, 8, 'scene source keeps latest message id');
  assertEqual(persisted.source.sceneFingerprint, 'scene-fingerprint-safe', 'scene source keeps scene fingerprint');
  assertEqual(persisted.source.chatWindowHash, 'window-hash-safe', 'scene source keeps chat window hash');
  assertEqual(persisted.source.sourceRefs.length, 1, 'scene source drops unsafe source refs');
  assertEqual(persisted.source.sourceRefs[0].refId, 'message:2-5', 'scene source keeps safe source ref id');
  assertEqual(persisted.source.sourceRefs[0].firstMesId, 2, 'scene source ref keeps first message id');
  assertEqual(persisted.source.sourceRefs[0].lastMesId, 5, 'scene source ref keeps last message id');
  assertEqual(persisted.source.sourceRefs[0].textHash, 'text-hash-safe', 'scene source ref keeps text hash');
  assertEqual(persisted.source.sourceRefs[0].role, 'assistant', 'scene source keeps allowed source ref role');
  assert(persisted.source.sourceRefs[0].excerpt.length <= 160, 'scene source ref excerpt is bounded');
  const serialized = JSON.stringify(persisted);
  assert(!serialized.includes('Full transcript text must not persist'), 'scene source drops transcript text');
  assert(!serialized.includes('Message text must not persist'), 'scene source drops message text');
  assert(!serialized.includes('provider prompt body'), 'scene source drops arbitrary provider prompt text');
  assert(!serialized.includes('Unsafe path ref must not persist'), 'scene source drops unsafe path source ref');
  assert(!serialized.includes('Unsafe token hash must not persist'), 'scene source drops unsafe token source ref');
  assertNoRawSecretText(persisted, 'scene source boundary redacts unsafe excerpt text');
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
  const orphanSceneKey = sceneCacheKey('Repair Chat', 'Scene One');
  const orphanJournalKey = runJournalKey('Repair Chat');
  const missingSceneKey = sceneCacheKey('Repair Chat', 'Missing Scene');
  const invalidSceneKey = sceneCacheKey('Repair Chat', 'Invalid Scene');
  const nonRecursionKey = 'other-extension-state.v1.json';

  await adapter.writeJson(orphanSceneKey, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    recursionVersion: '0.1.0-pre-alpha.2',
    chatKey: 'Repair-Chat',
    sceneKey: 'Scene-One',
    cacheState: 'active',
    cards: []
  });
  await adapter.writeJson(orphanJournalKey, {
    recordType: 'recursion.runJournal',
    schemaVersion: 1,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    recursionVersion: '0.1.0-pre-alpha.2',
    chatKey: 'Repair-Chat',
    maxEntries: 100,
    nextIndex: 0,
    entries: []
  });
  await adapter.writeJson(invalidSceneKey, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 999,
    chatKey: 'Repair-Chat',
    sceneKey: 'Invalid-Scene',
    apiKey: 'index-repair-secret'
  });
  await adapter.writeJson(nonRecursionKey, {
    owner: 'other-extension',
    apiKey: 'other-extension-secret'
  });
  await adapter.writeJson(SYSTEM_INDEX_KEY, {
    records: {
      [missingSceneKey]: {
        key: missingSceneKey,
        kind: 'sceneCache',
        chatKey: 'Repair Chat',
        updatedAt: '2026-06-30T00:00:00.000Z'
      },
      [invalidSceneKey]: {
        key: invalidSceneKey,
        kind: 'sceneCache',
        chatKey: 'Repair Chat',
        updatedAt: '2026-06-30T00:00:00.000Z',
        apiKey: 'stale-index-secret'
      },
      '../../outside.json': {
        key: '../../outside.json',
        kind: 'sceneCache',
        chatKey: 'Unsafe Secret Chat',
        updatedAt: 'not-a-date',
        apiKey: 'unsafe-index-secret'
      }
    }
  });

  const result = await repo.repairIndex();
  const index = await repo.readIndex();
  const dump = adapter.dump();
  const serializedResult = JSON.stringify(result);

  assertEqual(result.ok, true, 'repairIndex returns ok');
  assert(index.records[orphanSceneKey], 'repairIndex adds valid orphaned scene cache');
  assertEqual(index.records[orphanSceneKey].kind, 'sceneCache', 'repairIndex records orphaned scene cache kind');
  assertEqual(index.records[orphanSceneKey].chatKey, 'Repair-Chat', 'repairIndex records orphaned scene cache chatKey');
  assert(index.records[orphanJournalKey], 'repairIndex adds valid orphaned run journal');
  assertEqual(index.records[orphanJournalKey].kind, 'runJournal', 'repairIndex records orphaned run journal kind');
  assert(!index.records[missingSceneKey], 'repairIndex removes missing index record');
  assert(!index.records[invalidSceneKey], 'repairIndex removes invalid index record');
  assert(dump[invalidSceneKey], 'repairIndex does not delete invalid Recursion records');
  assertEqual(dump[nonRecursionKey].owner, 'other-extension', 'repairIndex does not touch non-Recursion records');
  assert(result.repaired.some((entry) => entry.kind === 'sceneCache'), 'repairIndex reports repaired scene cache index entry');
  assert(result.repaired.some((entry) => entry.kind === 'runJournal'), 'repairIndex reports repaired run journal index entry');
  assert(result.pruned.some((entry) => entry.reason === 'missing-record'), 'repairIndex reports missing record prune');
  assert(result.pruned.some((entry) => entry.reason === 'invalid-record'), 'repairIndex reports invalid record prune');
  assert(result.pruned.some((entry) => entry.reason === 'invalid-index-record'), 'repairIndex reports raw invalid index record prune');
  assert(result.journalEvents.some((entry) => entry.event === 'storage.repaired'), 'repairIndex reports storage.repaired diagnostic');
  assert(result.journalEvents.some((entry) => entry.event === 'storage.pruned'), 'repairIndex reports storage.pruned diagnostic');
  assert(!serializedResult.includes('secret'), 'repairIndex diagnostics omit secret text');
  assert(!serializedResult.includes(nonRecursionKey), 'repairIndex diagnostics omit non-Recursion record keys');
}

{
  const files = new Map();
  const validSceneKey = sceneCacheKey('No Discovery Chat', 'Scene One');
  const missingSceneKey = sceneCacheKey('No Discovery Chat', 'Missing Scene');
  const invalidSceneKey = sceneCacheKey('No Discovery Chat', 'Invalid Scene');
  const unreadableRunKey = runJournalKey('Unreadable Chat');
  const orphanSceneKey = sceneCacheKey('No Discovery Chat', 'Orphan Scene');
  const storage = {
    async readJson(key) {
      if (key === unreadableRunKey) throw new Error('read failed with sk-storage-secret');
      return files.has(key) ? files.get(key) : null;
    },
    async writeJson(key, value) {
      files.set(key, value);
      return { ok: true, key };
    },
    async deleteJson(key) {
      files.delete(key);
      return { ok: true, key };
    }
  };
  await storage.writeJson(validSceneKey, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    recursionVersion: '0.1.0-pre-alpha.2',
    chatKey: 'No-Discovery-Chat',
    sceneKey: 'Scene-One',
    cacheState: 'active',
    cards: []
  });
  await storage.writeJson(invalidSceneKey, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 999,
    chatKey: 'No-Discovery-Chat',
    sceneKey: 'Invalid-Scene'
  });
  await storage.writeJson(orphanSceneKey, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    recursionVersion: '0.1.0-pre-alpha.2',
    chatKey: 'No-Discovery-Chat',
    sceneKey: 'Orphan-Scene',
    cacheState: 'active',
    cards: []
  });
  await storage.writeJson(SYSTEM_INDEX_KEY, {
    records: {
      [validSceneKey]: {
        key: validSceneKey,
        kind: 'sceneCache',
        chatKey: 'No Discovery Chat',
        updatedAt: 'not-a-date'
      },
      [missingSceneKey]: {
        key: missingSceneKey,
        kind: 'sceneCache',
        chatKey: 'No Discovery Chat',
        updatedAt: '2026-06-30T00:00:00.000Z'
      },
      [invalidSceneKey]: {
        key: invalidSceneKey,
        kind: 'sceneCache',
        chatKey: 'No Discovery Chat',
        updatedAt: '2026-06-30T00:00:00.000Z'
      },
      [unreadableRunKey]: {
        key: unreadableRunKey,
        kind: 'runJournal',
        chatKey: 'Unreadable Chat',
        updatedAt: '2026-06-30T00:00:00.000Z'
      }
    }
  });

  const repo = createStorageRepository({ storage });
  const result = await repo.repairIndex();
  const index = await repo.readIndex();
  const serializedResult = JSON.stringify(result);
  assertEqual(result.discovery.available, false, 'repairIndex records missing discovery support');
  assert(index.records[validSceneKey], 'repairIndex keeps indexed valid record without discovery');
  assertEqual(index.records[validSceneKey].chatKey, 'No-Discovery-Chat', 'repairIndex repairs indexed valid record metadata without discovery');
  assert(!index.records[missingSceneKey], 'repairIndex prunes indexed missing record without discovery');
  assert(!index.records[invalidSceneKey], 'repairIndex prunes indexed invalid record without discovery');
  assert(index.records[unreadableRunKey], 'repairIndex preserves unreadable indexed record without discovery');
  assert(!index.records[orphanSceneKey], 'repairIndex cannot add orphan records without discovery');
  assert(result.pruned.some((entry) => entry.reason === 'missing-record'), 'repairIndex reports no-discovery missing prune');
  assert(result.pruned.some((entry) => entry.reason === 'invalid-record'), 'repairIndex reports no-discovery invalid prune');
  assert(result.skipped.some((entry) => entry.reason === 'read-failed'), 'repairIndex reports no-discovery read failure skip');
  assert(!serializedResult.includes('sk-storage-secret'), 'repairIndex no-discovery diagnostics redact read failure secrets');
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
  const rapidMiss = await repo.appendJournal('Event Gate Chat', {
    event: 'rapid.warm_missed',
    severity: 'warn',
    summary: 'Rapid warm missed; Standard started.',
    details: {
      reasonCode: 'base-source-mismatch',
      reasonLabel: 'Warm source differs from current turn'
    }
  });
  assertEqual(rapidMiss.event, 'rapid.warm_missed', 'rapid warm miss journal event is preserved');
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
  const repo = createStorageRepository({ storage: adapter });
  const writeSceneCache = async (chatKey, sceneKey, updatedAt) => {
    const key = sceneCacheKey(chatKey, sceneKey);
    await adapter.writeJson(key, {
      recordType: 'recursion.sceneCache',
      schemaVersion: 1,
      createdAt: updatedAt,
      updatedAt,
      recursionVersion: '0.1.0-pre-alpha.2',
      chatKey: chatKey.replace(/\s+/g, '-'),
      sceneKey: sceneKey.replace(/\s+/g, '-'),
      cacheState: 'active',
      cards: []
    });
    return key;
  };
  const protectedOld = await writeSceneCache('Prune Chat A', 'Scene 1', '2026-06-30T00:00:00.000Z');
  const prunedMiddle = await writeSceneCache('Prune Chat A', 'Scene 2', '2026-06-30T01:00:00.000Z');
  const keptNewest = await writeSceneCache('Prune Chat A', 'Scene 3', '2026-06-30T02:00:00.000Z');
  const prunedTotal = await writeSceneCache('Prune Chat B', 'Scene 1', '2026-06-30T00:30:00.000Z');
  const keptB = await writeSceneCache('Prune Chat B', 'Scene 2', '2026-06-30T03:00:00.000Z');
  const keptC = await writeSceneCache('Prune Chat C', 'Scene 1', '2026-06-30T04:00:00.000Z');
  const nonRecursionKey = 'other-extension-prune-state.v1.json';
  await adapter.writeJson(nonRecursionKey, {
    owner: 'other-extension',
    apiKey: 'other-extension-secret'
  });

  const result = await repo.pruneSceneCaches({
    maxPerChat: 2,
    maxTotal: 4,
    protectedScenes: [{ chatKey: 'Prune Chat A', sceneKey: 'Scene 1' }]
  });
  const dump = adapter.dump();
  const index = await repo.readIndex();
  const serializedResult = JSON.stringify(result);

  assertEqual(result.ok, true, 'pruneSceneCaches returns ok');
  assert(dump[protectedOld], 'pruneSceneCaches keeps protected active scene even when old');
  assert(!dump[prunedMiddle], 'pruneSceneCaches deletes extra per-chat scene cache');
  assert(dump[keptNewest], 'pruneSceneCaches keeps newest scene for protected chat');
  assert(!dump[prunedTotal], 'pruneSceneCaches deletes oldest unprotected scene for total cap');
  assert(dump[keptB], 'pruneSceneCaches keeps newer cache in second chat');
  assert(dump[keptC], 'pruneSceneCaches keeps newest total cache');
  assertEqual(dump[nonRecursionKey].owner, 'other-extension', 'pruneSceneCaches never touches non-Recursion records');
  assert(!index.records[prunedMiddle], 'pruneSceneCaches removes per-chat pruned key from index');
  assert(!index.records[prunedTotal], 'pruneSceneCaches removes total-pruned key from index');
  assert(index.records[protectedOld], 'pruneSceneCaches keeps protected key indexed');
  assertEqual(result.pruned.length, 2, 'pruneSceneCaches reports each deleted scene cache');
  assert(result.pruned.every((entry) => entry.kind === 'sceneCache'), 'pruneSceneCaches reports scene cache kind');
  assert(result.pruned.some((entry) => entry.reason === 'per-chat-retention-limit'), 'pruneSceneCaches reports per-chat limit');
  assert(result.pruned.some((entry) => entry.reason === 'total-retention-limit'), 'pruneSceneCaches reports total limit');
  assert(result.journalEvents.some((entry) => entry.event === 'storage.pruned'), 'pruneSceneCaches returns storage.pruned diagnostic');
  assertNoSecret(result, 'pruneSceneCaches diagnostics redact secrets');
  assert(!serializedResult.includes(nonRecursionKey), 'pruneSceneCaches diagnostics omit non-Recursion record keys');
}

{
  const files = new Map();
  const deleted = [];
  const unreadableKey = sceneCacheKey('Unreadable Prune Chat', 'Old Scene');
  const storage = {
    async readJson(key) {
      if (key === unreadableKey) throw new Error('read failed with sk-unreadable-secret');
      return files.has(key) ? files.get(key) : null;
    },
    async writeJson(key, value) {
      files.set(key, value);
      return { ok: true, key };
    },
    async deleteJson(key) {
      deleted.push(key);
      files.delete(key);
      return { ok: true, key };
    }
  };
  await storage.writeJson(SYSTEM_INDEX_KEY, {
    records: {
      [unreadableKey]: {
        key: unreadableKey,
        kind: 'sceneCache',
        chatKey: 'Unreadable Prune Chat',
        updatedAt: '2026-06-30T00:00:00.000Z'
      }
    }
  });
  const repo = createStorageRepository({ storage });
  const result = await repo.pruneSceneCaches({ maxPerChat: 0, maxTotal: 0 });
  const index = await repo.readIndex();
  const serializedResult = JSON.stringify(result);

  assert(!deleted.includes(unreadableKey), 'pruneSceneCaches does not delete unreadable indexed scene cache');
  assert(index.records[unreadableKey], 'pruneSceneCaches preserves unreadable index entry');
  assert(result.skipped.some((entry) => entry.reason === 'read-failed'), 'pruneSceneCaches reports unreadable record as skipped');
  assert(!serializedResult.includes('sk-unreadable-secret'), 'pruneSceneCaches unreadable diagnostics redact read failure secrets');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const activeOld = sceneCacheKey('Active Prune Chat', 'Old Active');
  const newer = sceneCacheKey('Active Prune Chat', 'Newer Scene');
  await adapter.writeJson(activeOld, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    recursionVersion: '0.1.0-pre-alpha.2',
    chatKey: 'Active-Prune-Chat',
    sceneKey: 'Old-Active',
    cacheState: 'active',
    cards: []
  });
  await adapter.writeJson(newer, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1,
    createdAt: '2026-06-30T01:00:00.000Z',
    updatedAt: '2026-06-30T01:00:00.000Z',
    recursionVersion: '0.1.0-pre-alpha.2',
    chatKey: 'Active-Prune-Chat',
    sceneKey: 'Newer-Scene',
    cacheState: 'active',
    cards: []
  });
  const result = await repo.pruneSceneCaches({
    maxPerChat: 1,
    maxTotal: 1,
    activeScene: { chatKey: 'Active Prune Chat', sceneKey: 'Old Active' }
  });
  const dump = adapter.dump();
  const index = await repo.readIndex();

  assert(dump[activeOld], 'pruneSceneCaches keeps activeScene even when older than alternatives');
  assert(!dump[newer], 'pruneSceneCaches prunes unprotected newer scene when activeScene consumes cap');
  assert(index.records[activeOld], 'pruneSceneCaches keeps activeScene indexed');
  assert(!index.records[newer], 'pruneSceneCaches removes pruned activeScene sibling from index');
  assertEqual(result.pruned.length, 1, 'activeScene prune reports one deleted sibling');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const safeOne = sceneCacheKey('Malformed Limit Chat', 'Safe One');
  const safeTwo = sceneCacheKey('Malformed Limit Chat', 'Safe Two');
  await adapter.writeJson(safeOne, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    recursionVersion: '0.1.0-pre-alpha.2',
    chatKey: 'Malformed-Limit-Chat',
    sceneKey: 'Safe-One',
    cacheState: 'active',
    cards: []
  });
  await adapter.writeJson(safeTwo, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1,
    createdAt: '2026-06-30T01:00:00.000Z',
    updatedAt: '2026-06-30T01:00:00.000Z',
    recursionVersion: '0.1.0-pre-alpha.2',
    chatKey: 'Malformed-Limit-Chat',
    sceneKey: 'Safe-Two',
    cacheState: 'active',
    cards: []
  });
  const nullEmpty = await repo.pruneSceneCaches({ maxPerChat: null, maxTotal: '' });
  const negative = await repo.pruneSceneCaches({ maxPerChat: -1, maxTotal: -5 });
  const dump = adapter.dump();
  const index = await repo.readIndex();

  assertEqual(nullEmpty.pruned.length, 0, 'null and empty retention limits fall back instead of pruning');
  assertEqual(negative.pruned.length, 0, 'negative retention limits fall back instead of pruning');
  assert(dump[safeOne], 'malformed limits keep first scene cache');
  assert(dump[safeTwo], 'malformed limits keep second scene cache');
  assert(index.records[safeOne], 'malformed limits keep first index entry');
  assert(index.records[safeTwo], 'malformed limits keep second index entry');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({ storage: adapter });
  const pruned = sceneCacheKey('Explicit Zero Chat', 'Only Scene');
  await adapter.writeJson(pruned, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    recursionVersion: '0.1.0-pre-alpha.2',
    chatKey: 'Explicit-Zero-Chat',
    sceneKey: 'Only-Scene',
    cacheState: 'active',
    cards: []
  });
  const result = await repo.pruneSceneCaches({ maxPerChat: 0, maxTotal: 0 });
  const dump = adapter.dump();

  assertEqual(result.pruned.length, 1, 'explicit zero retention limit prunes unprotected scene cache');
  assert(!dump[pruned], 'explicit zero retention limit deletes unprotected scene cache');
}

{
  const files = new Map();
  const failedDeleteKey = sceneCacheKey('Delete Fail Chat', 'Old Scene');
  const storage = {
    async readJson(key) {
      return files.has(key) ? files.get(key) : null;
    },
    async writeJson(key, value) {
      files.set(key, value);
      return { ok: true, key };
    },
    async deleteJson(key) {
      return { ok: false, key, error: { message: 'delete failed with sk-delete-secret' } };
    }
  };
  await storage.writeJson(failedDeleteKey, {
    recordType: 'recursion.sceneCache',
    schemaVersion: 1,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    recursionVersion: '0.1.0-pre-alpha.2',
    chatKey: 'Delete-Fail-Chat',
    sceneKey: 'Old-Scene',
    cacheState: 'active',
    cards: []
  });
  await storage.writeJson(SYSTEM_INDEX_KEY, {
    records: {
      [failedDeleteKey]: {
        key: failedDeleteKey,
        kind: 'sceneCache',
        chatKey: 'Delete Fail Chat',
        updatedAt: '2026-06-30T00:00:00.000Z'
      }
    }
  });
  const repo = createStorageRepository({ storage });
  const result = await repo.pruneSceneCaches({ maxPerChat: 0, maxTotal: 0 });
  const index = await repo.readIndex();
  const serializedResult = JSON.stringify(result);

  assertEqual(result.pruned.length, 0, 'failed delete is not reported as pruned');
  assert(result.skipped.some((entry) => entry.reason === 'delete-failed'), 'failed delete is reported as skipped');
  assert(index.records[failedDeleteKey], 'failed delete keeps index entry');
  assert(!serializedResult.includes('sk-delete-secret'), 'failed delete diagnostics redact adapter error text');
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
  const repo = createStorageRepository({
    storage: adapter,
    getRetentionSettings: () => ({ sourceVariantsPerScene: 2 })
  });
  await repo.saveSceneCache('Variant Cap Chat', 'Scene One', {
    activeSourceRevisionHash: 'rev-c',
    variantOrder: ['rev-a', 'rev-b', 'rev-c'],
    variants: {
      'rev-a': { sourceRevisionHash: 'rev-a', cards: [] },
      'rev-b': { sourceRevisionHash: 'rev-b', cards: [] },
      'rev-c': { sourceRevisionHash: 'rev-c', cards: [] }
    }
  });
  const cache = await repo.loadSceneCache('Variant Cap Chat', 'Scene One');
  assertDeepEqual(cache.variantOrder, ['rev-b', 'rev-c'], 'storage applies dynamic variant cap');
  assert(!cache.variants['rev-a'], 'storage drops oldest variant beyond cap');
}

{
  const adapter = createMemoryStorageAdapter();
  const repo = createStorageRepository({
    storage: adapter,
    getRetentionSettings: () => ({ sceneCachesPerChat: 1, sceneCachesTotal: 4 })
  });
  await repo.saveSceneCache('Maintain Chat A', 'Old Scene', {});
  await repo.saveSceneCache('Maintain Chat A', 'Active Scene', {});
  await repo.saveSceneCache('Maintain Chat B', 'Other Scene', {});
  const result = await repo.maintainRetention({
    activeScene: { chatKey: 'Maintain Chat A', sceneKey: 'Active Scene' }
  });
  const dump = adapter.dump();
  assertEqual(result.ok, true, 'maintainRetention succeeds');
  assert(!dump[sceneCacheKey('Maintain Chat A', 'Old Scene')], 'maintenance prunes old same-chat scene');
  assert(dump[sceneCacheKey('Maintain Chat A', 'Active Scene')], 'maintenance protects active scene');
  assert(dump[sceneCacheKey('Maintain Chat B', 'Other Scene')], 'maintenance keeps other chat cache');
}

console.log('[pass] storage');
