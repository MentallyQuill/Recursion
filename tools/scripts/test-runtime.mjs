import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { createGenerationRouter } from '../../src/providers.mjs';
import { CARD_CATALOG, cardsFromProviderResult } from '../../src/cards.mjs';
import { hashJson } from '../../src/core.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const UTILITY_ARBITER_SCHEMA = 'recursion.utilityArbiter.v1';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function waitUntil(predicate, message, { attempts = 50, delayMs = 0 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(message);
}

function assertNoSecretText(value, label) {
  const serialized = JSON.stringify(value);
  assert(!/\bbearer\s+[a-z0-9._-]+/i.test(serialized), `${label} redacts bearer text`);
  assert(!/\bsk-[a-z0-9_-]+/i.test(serialized), `${label} redacts sk text`);
  assert(!/private[-_\s]*secret/i.test(serialized), `${label} redacts private secret text`);
  return serialized;
}

function parsePromptJsonSection(prompt, label) {
  const prefix = `${label}: `;
  const section = String(prompt || '').split('\n\n').find((entry) => entry.startsWith(prefix));
  assert(section, `arbiter prompt includes ${label}`);
  return JSON.parse(section.slice(prefix.length));
}

function messageTextHash(message) {
  return hashJson(String(message?.text ?? message?.mes ?? message?.content ?? ''));
}

function sourceWindowHash(messages, firstMesId, lastMesId) {
  return hashJson((Array.isArray(messages) ? messages : [])
    .filter((message) => message?.visible !== false)
    .map((message, index) => ({
      mesid: Number(message?.mesid ?? message?.id ?? message?.messageId ?? index),
      role: String(message?.role ?? (message?.is_user === true ? 'user' : (message?.is_system === true ? 'system' : 'assistant'))),
      textHash: String(message?.textHash || messageTextHash(message))
    }))
    .filter((message) => message.mesid >= firstMesId && message.mesid <= lastMesId));
}

function runtimeSnapshotHash(snapshot) {
  const messages = (Array.isArray(snapshot.messages) ? snapshot.messages : []).map((message, index) => ({
    mesid: Number(message?.mesid ?? message?.id ?? message?.messageId ?? index),
    role: String(message?.role ?? (message?.is_user === true ? 'user' : (message?.is_system === true ? 'system' : 'assistant'))),
    text: String(message?.text ?? message?.mes ?? message?.content ?? ''),
    textHash: String(message?.textHash || messageTextHash(message)),
    visible: message?.visible === false || message?.hidden === true ? false : true
  }));
  const latest = messages.at(-1);
  return hashJson({
    chatId: String(snapshot.chatId ?? snapshot.chatKey ?? 'chat'),
    chatKey: String(snapshot.chatKey ?? snapshot.chatId ?? 'chat'),
    sceneKey: String(snapshot.sceneKey ?? snapshot.sceneFingerprint ?? 'scene'),
    sceneFingerprint: String(snapshot.sceneFingerprint ?? hashJson(messages)),
    turnFingerprint: String(snapshot.turnFingerprint ?? hashJson({ latestMesId: snapshot.latestMesId ?? latest?.mesid ?? 0, messages: messages.slice(-3) })),
    latestMesId: Number(snapshot.latestMesId ?? latest?.mesid ?? 0),
    messages
  });
}

function isAbortSignal(value) {
  return Boolean(value)
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function';
}

function createRuntimeHarness({
  settings = {},
  snapshot = null,
  hostPrompt = {},
  generationRouter = null,
  activity = createActivityReporter(),
  storage: providedStorage = null
} = {}) {
  const calls = {
    snapshot: 0,
    install: 0,
    clear: 0
  };
  const installed = [];
  const cleared = [];
  const adapter = createMemoryStorageAdapter();
  const storage = providedStorage || createStorageRepository({ storage: adapter });
  const settingsStore = createSettingsStore({ root: {} });
  settingsStore.update(settings);
  const host = {
    async snapshot() {
      calls.snapshot += 1;
      if (typeof snapshot === 'function') return clone(await snapshot());
      return clone(snapshot ?? {
        chatId: 'chat-1',
        chatKey: 'chat-1',
        sceneKey: 'scene-1',
        sceneFingerprint: 'scene-fp',
        turnFingerprint: 'turn-fp',
        latestMesId: 2,
        messages: [
          { mesid: 1, role: 'assistant', text: 'A hidden draft.', visible: false },
          { mesid: 2, role: 'user', text: 'The lamp breaks.', visible: true }
        ]
      });
    },
    prompt: {
      async install(packet) {
        calls.install += 1;
        installed.push(packet);
        if (hostPrompt.install) return hostPrompt.install(packet);
        return { ok: true, installed: true };
      },
      async clear() {
        calls.clear += 1;
        cleared.push(true);
        if (hostPrompt.clear) return hostPrompt.clear();
        return { ok: true, cleared: true };
      },
      ...hostPrompt.methods
    }
  };
  const runtime = createRecursionRuntime({ host, settingsStore, storage, activity, generationRouter });
  return { runtime, calls, installed, cleared, storage, settingsStore, activity, adapter };
}

async function assertSingleCachedCardUnavailable({ card, snapshot, userMessage, label }) {
  const storage = {
    async loadSceneCache() {
      return { cards: [card] };
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot,
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', `${label}: only utility arbiter should run`);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'reuse-cache',
            lifecycle: [{ action: 'select', cardId: card.id, reason: label }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: [label]
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage });
  const serialized = JSON.stringify({ result, view: runtime.view() });
  assertEqual(result.ok, true, `${label}: stale cache remains fail-soft`);
  assertEqual(result.skipped, true, `${label}: cache is unavailable`);
  assertEqual(result.reason, 'cache-unavailable', `${label}: unavailable reason returned`);
  assertEqual(installed.length, 0, `${label}: prompt is not installed`);
  assert(!serialized.includes(card.promptText), `${label}: stale prompt text is not exposed`);
}

{
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'The lamp breaks.' });
  const view = runtime.view();
  assertEqual(runtime.storage, storage, 'runtime exposes storage repository');
  assertEqual(result.ok, true, 'auto mode returns ok');
  assertEqual(calls.snapshot, 3, 'auto mode reads snapshot and rechecks before compose and install');
  assertEqual(installed.length, 1, 'auto mode installs one prompt');
  assert(view.lastHand.cards.length > 0, 'hand available in view');
  assert(view.lastPacket.sections.sceneBrief.includes('The lamp breaks.'), 'scene frame uses latest visible message');
  assert(!view.lastPacket.sections.sceneBrief.includes('hidden draft'), 'scene frame ignores invisible message');
  assertEqual(view.activity.label, 'Recursion prompt ready.', 'activity settled');
  assertEqual(view.activeRunId, null, 'active run cleared after auto success');
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  assert(cache.cards.length >= 2, 'scene cache persists fallback cards');
  assert(cache.latestHand?.handId, 'scene cache persists latest hand metadata');
  assert(cache.latestHand.cards.length > 0, 'scene cache latest hand records selected cards');
  assert(cache.cards.some((card) => Number.isFinite(card.source?.firstMesId) && Number.isFinite(card.source?.lastMesId)), 'scene cache cards preserve source message range');
  const journal = await storage.loadRunJournal(view.lastSnapshot.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['hand.selected', 'prompt.installed'], 'auto journals hand before prompt install');
  const handSelected = journal.entries.find((entry) => entry.event === 'hand.selected');
  const promptInstalled = journal.entries.find((entry) => entry.event === 'prompt.installed');
  assert(handSelected, 'hand selection journal entry persisted');
  assert(promptInstalled, 'install journal records success');
  assertEqual(handSelected.details?.handId, view.lastHand.handId, 'hand selection journal records hand id');
  assertEqual(handSelected.details?.selectedCount, view.lastHand.cards.length, 'hand selection journal records selected count');
  assertEqual(handSelected.details?.cards?.length, view.lastHand.cards.length, 'hand selection journal records selected card metadata');
  assertEqual(handSelected.details?.listedCount, view.lastHand.cards.length, 'hand selection journal records listed count');
  assertEqual(handSelected.details?.truncated, false, 'hand selection journal records truncation state');
  assert(handSelected.hashes?.promptPacketHash, 'hand selection journal records prompt packet hash');
  assert(!JSON.stringify(handSelected).includes(view.lastHand.cards[0].promptText), 'hand selection journal omits prompt text');
}

{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  const run = await runtime.prepareForGeneration({ userMessage: 'The lamp breaks.' });
  assertEqual(run.ok, true, 'cache invalidation setup run installs');
  const snapshot = runtime.view().lastSnapshot;

  const providerUpdate = await runtime.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-live-runtime',
    openAICompatible: {
      baseUrl: 'https://provider-change.test/v1',
      model: 'provider-change-model'
    }
  });
  assertEqual(providerUpdate.ok, true, 'provider update still succeeds after cache invalidation');
  let cache = await storage.loadSceneCache(snapshot.chatKey, snapshot.sceneKey);
  assertEqual(cache.cacheState, 'stale', 'provider update marks active scene cache stale');
  assertEqual(cache.invalidation.reason, 'provider-changed', 'provider update records invalidation reason');
  assertDeepEqual(cache.invalidation.details.changedKeys, ['source', 'apiKey', 'openAICompatible'], 'provider invalidation records changed keys');
  assert(!JSON.stringify(cache.invalidation).includes('provider-change-model'), 'provider invalidation does not persist raw model patch');
  assert(!JSON.stringify(cache.invalidation).includes('provider-change.test'), 'provider invalidation does not persist raw endpoint patch');
  assertNoSecretText(cache.invalidation, 'provider cache invalidation');
  let journal = await storage.loadRunJournal(snapshot.chatKey);
  assert(journal.entries.some((entry) => entry.event === 'cache.invalidated' && entry.details?.reason === 'provider-changed'), 'provider update records cache invalidation journal');
  assert(!JSON.stringify(journal).includes('provider-change-model'), 'provider invalidation journal does not persist raw model patch');
  assert(!JSON.stringify(journal).includes('provider-change.test'), 'provider invalidation journal does not persist raw endpoint patch');
  assertNoSecretText(journal, 'provider cache invalidation journal');

  const settingsUpdate = await runtime.updateSettings({ reasonerUse: 'always' });
  assertEqual(settingsUpdate.ok, true, 'settings update still succeeds after cache invalidation');
  cache = await storage.loadSceneCache(snapshot.chatKey, snapshot.sceneKey);
  assertEqual(cache.cacheState, 'stale', 'settings update keeps scene cache stale');
  assertEqual(cache.invalidation.reason, 'settings-changed', 'settings update records invalidation reason');
  assertNoSecretText(cache.invalidation, 'settings cache invalidation');
  journal = await storage.loadRunJournal(snapshot.chatKey);
  assert(journal.entries.some((entry) => entry.event === 'cache.invalidated' && entry.details?.reason === 'settings-changed'), 'settings update records cache invalidation journal');
}

{
  let arbiterPrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'stale cache arbiter metadata test only calls arbiter');
        arbiterPrompts.push(request.prompt);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage: 'Build cache before invalidation.' });
  assertEqual(first.ok, true, 'stale cache metadata setup run installs');
  const providerUpdate = await runtime.updateProvider('utility', { source: 'host-current-model' });
  assertEqual(providerUpdate.ok, true, 'provider update invalidates cache before next arbiter pass');
  arbiterPrompts = [];
  const second = await runtime.prepareForGeneration({ userMessage: 'Arbiter should see stale cache.' });
  assertEqual(second.ok, true, 'stale cache metadata followup run installs');
  assert(arbiterPrompts[0].includes('"cacheState":"stale"'), 'arbiter prompt includes stale cache state');
  assert(arbiterPrompts[0].includes('"reason":"provider-changed"'), 'arbiter prompt includes invalidation reason');
}

{
  const adapter = createMemoryStorageAdapter();
  const baseStorage = createStorageRepository({ storage: adapter });
  let releaseInvalidation;
  let invalidationStarted = false;
  let invalidationCompleted = false;
  const storage = {
    ...baseStorage,
    async invalidateSceneCache(chatKey, sceneKey, options) {
      invalidationStarted = true;
      await new Promise((resolve) => {
        releaseInvalidation = resolve;
      });
      const result = await baseStorage.invalidateSceneCache(chatKey, sceneKey, options);
      invalidationCompleted = true;
      return result;
    }
  };
  const arbiterPrompts = [];
  let arbiterCalls = 0;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'concurrent invalidation wait test only calls arbiter');
        arbiterCalls += 1;
        if (arbiterCalls > 1) {
          assertEqual(invalidationCompleted, true, 'prepare waits for cache invalidation before asking Arbiter');
        }
        arbiterPrompts.push(request.prompt);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage: 'Build cache before delayed invalidation.' });
  assertEqual(first.ok, true, 'delayed invalidation setup run installs');
  const providerUpdate = runtime.updateProvider('utility', { source: 'host-current-model' });
  await waitUntil(() => invalidationStarted, 'provider update did not start invalidation');
  const second = runtime.prepareForGeneration({ userMessage: 'Wait for invalidation before reading cache.' });
  releaseInvalidation();
  const updateResult = await providerUpdate;
  assertEqual(updateResult.ok, true, 'provider update succeeds after delayed invalidation');
  const secondResult = await second;
  assertEqual(secondResult.ok, true, 'prepare after delayed invalidation succeeds');
  assert(arbiterPrompts[1].includes('"cacheState":"stale"'), 'concurrent prepare Arbiter prompt includes stale cache state');
  assert(arbiterPrompts[1].includes('"reason":"provider-changed"'), 'concurrent prepare Arbiter prompt includes invalidation reason');
}

{
  const adapter = createMemoryStorageAdapter();
  const baseStorage = createStorageRepository({ storage: adapter });
  let releaseSave;
  let saveStarted = false;
  const storage = {
    ...baseStorage,
    async saveSceneCache(chatKey, sceneKey, value) {
      saveStarted = true;
      await new Promise((resolve) => {
        releaseSave = resolve;
      });
      return baseStorage.saveSceneCache(chatKey, sceneKey, value);
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage
  });
  const run = runtime.prepareForGeneration({ userMessage: 'Save is still in flight.' });
  await waitUntil(() => saveStarted, 'in-flight save did not start before provider update');
  const providerUpdatePromise = runtime.updateProvider('utility', { source: 'host-current-model' });
  releaseSave();
  const providerUpdate = await providerUpdatePromise;
  assertEqual(providerUpdate.ok, true, 'provider update succeeds while save is in flight');
  const runResult = await run;
  assertEqual(runResult.superseded, true, 'in-flight save run is superseded by provider update');
  const snapshot = runtime.view().lastSnapshot;
  const cache = await baseStorage.loadSceneCache(snapshot.chatKey, snapshot.sceneKey);
  assertEqual(cache.cacheState, 'stale', 'provider update leaves in-flight saved cache stale');
  assertEqual(cache.invalidation.reason, 'provider-changed', 'in-flight saved cache records provider invalidation');
}

{
  const adapter = createMemoryStorageAdapter();
  const baseStorage = createStorageRepository({ storage: adapter });
  let saveCalls = 0;
  let delayedSaveStarted = false;
  let releaseDelayedSave;
  let invalidationCompleted = false;
  const storage = {
    ...baseStorage,
    async saveSceneCache(chatKey, sceneKey, value) {
      saveCalls += 1;
      if (saveCalls === 2) {
        delayedSaveStarted = true;
        await new Promise((resolve) => {
          releaseDelayedSave = resolve;
        });
      }
      return baseStorage.saveSceneCache(chatKey, sceneKey, value);
    },
    async invalidateSceneCache(chatKey, sceneKey, options) {
      const result = await baseStorage.invalidateSceneCache(chatKey, sceneKey, options);
      invalidationCompleted = true;
      return result;
    }
  };
  let arbiterCalls = 0;
  const arbiterPrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'storage-tail mutation wait test only calls arbiter');
        arbiterCalls += 1;
        if (arbiterCalls === 3) {
          assertEqual(invalidationCompleted, true, 'prepare waiting on storage tail also waits for provider invalidation added later');
        }
        arbiterPrompts.push(request.prompt);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage: 'Save first cache before storage wait.' });
  assertEqual(first.ok, true, 'storage-tail wait setup run installs');
  const delayedRun = runtime.prepareForGeneration({ userMessage: 'Delay second save.' });
  await waitUntil(() => delayedSaveStarted, 'second save did not enter delayed storage write');
  const waitingRun = runtime.prepareForGeneration({ userMessage: 'Wait through storage and provider mutation.' });
  const providerUpdate = runtime.updateProvider('utility', { source: 'host-current-model' });
  releaseDelayedSave();
  const updateResult = await providerUpdate;
  assertEqual(updateResult.ok, true, 'provider update succeeds after delayed storage save');
  const delayedResult = await delayedRun;
  assertEqual(delayedResult.superseded, true, 'delayed run is superseded by provider update');
  const waitingResult = await waitingRun;
  assertEqual(waitingResult.ok, true, 'waiting run succeeds after provider invalidation');
  assert(arbiterPrompts[2].includes('"cacheState":"stale"'), 'storage-tail waiting Arbiter prompt includes stale cache state');
  assert(arbiterPrompts[2].includes('"reason":"provider-changed"'), 'storage-tail waiting Arbiter prompt includes invalidation reason');
}

{
  let sceneId = 'saved-scene';
  let releaseSecondArbiter;
  let secondArbiterStarted = false;
  let arbiterCalls = 0;
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => ({
      chatId: 'cache-target-chat',
      chatKey: 'cache-target-chat',
      sceneKey: sceneId,
      sceneFingerprint: `${sceneId}-fp`,
      turnFingerprint: `${sceneId}-turn-fp`,
      latestMesId: 2,
      messages: [
        { mesid: 2, role: 'user', text: `Message in ${sceneId}.`, visible: true }
      ]
    }),
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'last saved cache invalidation test only calls arbiter');
        arbiterCalls += 1;
        if (arbiterCalls === 2) {
          secondArbiterStarted = true;
          await new Promise((resolve) => {
            releaseSecondArbiter = resolve;
          });
        }
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: [`arbiter-${arbiterCalls}`]
          }
        };
      }
    }
  });
  const first = await runtime.prepareForGeneration({ userMessage: 'Save first cache.' });
  assertEqual(first.ok, true, 'last saved cache setup run installs');
  const savedSnapshot = runtime.view().lastSnapshot;
  sceneId = 'unsaved-scene';
  const second = runtime.prepareForGeneration({ userMessage: 'Start unsaved second cache.' });
  await waitUntil(() => secondArbiterStarted, 'second arbiter did not start before provider update');
  const providerUpdate = await runtime.updateProvider('utility', { source: 'host-current-model' });
  assertEqual(providerUpdate.ok, true, 'provider update succeeds while newer run is superseded');
  releaseSecondArbiter();
  const secondResult = await second;
  assertEqual(secondResult.superseded, true, 'second run is superseded before saving cache');
  const savedCache = await storage.loadSceneCache(savedSnapshot.chatKey, savedSnapshot.sceneKey);
  assertEqual(savedCache.cacheState, 'stale', 'provider update invalidates last successfully saved cache');
  const unsavedCache = await storage.loadSceneCache('cache-target-chat', 'unsaved-scene');
  assertEqual(unsavedCache, null, 'provider update does not create or target unsaved cache');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'secret-chat Bearer id-token',
      chatKey: 'secret-chat',
      sceneKey: 'scene sk-live-scene',
      sceneFingerprint: 'scene-fp Bearer scene-token',
      turnFingerprint: 'turn-fp sk-live-turn private-secret',
      latestMesId: 1,
      messages: [{ mesid: 1, role: 'user', text: 'Identifier metadata should be safe.', visible: true }]
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Secret identifiers.' });
  assertEqual(result.ok, true, 'secret identifier run installs');
  assertNoSecretText({ packet: result.packet, viewPacket: runtime.view().lastPacket, view: runtime.view() }, 'packet metadata');
}

{
  const directProviderCards = cardsFromProviderResult({
    ok: true,
    roleId: 'openThreadsCard',
    data: {
      schema: 'recursion.card.v1',
      role: 'openThreadsCard',
      family: 'Open Threads',
      items: [{
        sceneId: 'provider-direct-scene',
        chatId: 'provider-direct-chat',
        source: {
          chatId: 'provider-direct-source-chat',
          firstMesId: 100,
          lastMesId: 200
        },
        freshness: { sourceFingerprint: 'hallucinated-direct-freshness-hash' },
        promptText: 'Direct provider card should keep runtime-owned provenance.',
        evidenceRefs: ['message:2']
      }]
    }
  }, {
    sceneId: 'scene-1',
    chatId: 'chat-1',
    snapshotHash: 'runtime-direct-snapshot-hash',
    firstMesId: 1,
    lastMesId: 2,
    expectedRole: 'openThreadsCard',
    expectedFamily: 'Open Threads'
  });
  assertEqual(directProviderCards.length, 1, 'direct provider card normalizes');
  assertEqual(directProviderCards[0].sceneId, 'scene-1', 'direct provider card scene uses runtime context');
  assertEqual(directProviderCards[0].source.chatId, 'chat-1', 'direct provider card chat uses runtime context');
  assertEqual(directProviderCards[0].source.firstMesId, 1, 'direct provider card first message uses runtime context');
  assertEqual(directProviderCards[0].source.lastMesId, 2, 'direct provider card last message uses runtime context');
  assertEqual(directProviderCards[0].source.snapshotHash, 'runtime-direct-snapshot-hash', 'direct provider card source uses runtime hash');
  assertEqual(directProviderCards[0].freshness.sourceFingerprint, 'runtime-direct-snapshot-hash', 'direct provider card freshness uses runtime hash');

  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'secret-chat',
      chatKey: 'secret-chat',
      sceneKey: 'secret-scene',
      sceneFingerprint: 'secret-scene-fp',
      turnFingerprint: 'secret-turn-fp',
      latestMesId: 4,
      messages: [{ mesid: 4, role: 'user', text: 'Bearer live-token and sk-live-runtime should not persist.', visible: true }]
    },
    hostPrompt: {
      async install() {
        throw new Error('install failed with Bearer live-token and sk-live-runtime');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'secret test' });
  const view = runtime.view();
  assertEqual(result.ok, false, 'secret install failure returns ok false');
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const journal = await storage.loadRunJournal(view.lastSnapshot.chatKey);
  const serialized = JSON.stringify({ cache, journal });
  assert(!serialized.includes('Bearer live-token'), 'runtime cache and journal redact bearer token');
  assert(!serialized.includes('sk-live-runtime'), 'runtime cache and journal redact sk token');
  assertNoSecretText({ result, view }, 'install failure result and view');
}

{
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'observe', reasonerUse: 'off' }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: 'Observe only with Bearer live-token, sk-live-runtime, and private-secret.'
  });
  const view = runtime.view();
  assertEqual(result.ok, true, 'observe mode returns ok');
  assertEqual(result.observe, true, 'observe result marked');
  assertEqual(calls.snapshot, 1, 'observe mode reads snapshot');
  assertEqual(installed.length, 0, 'observe mode does not install');
  assert(view.lastPacket, 'observe mode still builds packet');
  assert(view.lastHand.cards.length > 0, 'observe mode still builds hand');
  assertEqual(view.activity.label, 'Observe mode: hand preview ready. No prompt injected.', 'observe activity label');
  assertEqual(view.activeRunId, null, 'active run cleared after observe');
  const journal = await storage.loadRunJournal(view.lastSnapshot.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['hand.selected'], 'observe only journals hand selection');
  const handSelected = journal.entries.find((entry) => entry.event === 'hand.selected');
  assert(handSelected, 'observe mode appends hand selection journal');
  assert(!journal.entries.some((entry) => entry.event === 'prompt.installed'), 'observe mode does not append install journal');
  assertEqual(handSelected.details?.selectedCount, view.lastHand.cards.length, 'observe hand journal records selected count');
  assertEqual(handSelected.details?.omittedCount, view.lastHand.omitted.length, 'observe hand journal records omitted count');
  assert(!JSON.stringify(handSelected).includes(view.lastHand.cards[0].promptText), 'observe hand journal omits prompt text');
  assert(!JSON.stringify(handSelected).includes('inspectorNotes'), 'observe hand journal omits inspector notes');
  assertNoSecretText(handSelected, 'observe hand journal');
}

{
  const adapter = createMemoryStorageAdapter();
  const repository = createStorageRepository({ storage: adapter });
  let releaseFirstLoad;
  let firstLoadStarted = false;
  let snapshotReads = 0;
  const storage = {
    async loadSceneCache(chatKey, sceneKey) {
      if (!firstLoadStarted) {
        firstLoadStarted = true;
        await new Promise((resolve) => {
          releaseFirstLoad = resolve;
        });
      }
      return repository.loadSceneCache(chatKey, sceneKey);
    },
    async saveSceneCache(...args) {
      return repository.saveSceneCache(...args);
    },
    async appendJournal(...args) {
      return repository.appendJournal(...args);
    },
    async loadRunJournal(...args) {
      return repository.loadRunJournal(...args);
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'observe', reasonerUse: 'off' },
    storage,
    snapshot: () => {
      snapshotReads += 1;
      const run = snapshotReads === 1 ? 'a' : 'b';
      return {
        chatId: `observe-${run}`,
        chatKey: `observe-${run}`,
        sceneKey: `observe-scene-${run}`,
        sceneFingerprint: `observe-scene-${run}`,
        turnFingerprint: `observe-turn-${run}`,
        latestMesId: run === 'a' ? 1 : 2,
        messages: [{ mesid: run === 'a' ? 1 : 2, role: 'user', text: `Observe ${run}.`, visible: true }]
      };
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'Observe a.' });
  await waitUntil(() => firstLoadStarted, 'first observe run did not block in scene cache load');
  const second = await runtime.prepareForGeneration({ userMessage: 'Observe b.' });
  releaseFirstLoad();
  const firstResult = await first;
  assertEqual(second.ok, true, 'newer observe run completes');
  assertEqual(second.observe, true, 'newer observe run remains observe');
  assertEqual(firstResult.superseded, true, 'older observe run is superseded');
  const staleJournal = await storage.loadRunJournal('observe-a');
  const freshJournal = await storage.loadRunJournal('observe-b');
  assertEqual(staleJournal.entries.length, 0, 'superseded observe run does not append hand journal');
  assertDeepEqual(freshJournal.entries.map((entry) => entry.event), ['hand.selected'], 'only final observe run records one hand journal');
}

{
  const { runtime, installed, cleared, settingsStore } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  const autoResult = await runtime.prepareForGeneration({ userMessage: 'Install first.' });
  assertEqual(autoResult.ok, true, 'auto before observe installs');
  settingsStore.update({ mode: 'observe' });
  const observeResult = await runtime.prepareForGeneration({ userMessage: 'Observe after install.' });
  assertEqual(observeResult.ok, true, 'observe after auto returns ok');
  assertEqual(observeResult.observe, true, 'observe after auto is marked observe');
  assertEqual(installed.length, 1, 'observe after auto does not install another prompt');
  assertEqual(cleared.length, 1, 'observe after auto clears prior Recursion prompt');
}

{
  let releaseClear;
  let updateResolved = false;
  const { runtime, calls } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  const update = runtime.updateSettings({ mode: 'off' });
  update.then(() => {
    updateResolved = true;
  });
  await waitUntil(() => typeof releaseClear === 'function', 'Off settings change did not start prompt clear');
  assertEqual(updateResolved, false, 'Off settings change waits for prompt clear before resolving');
  assertEqual(runtime.view().settings.mode, 'off', 'Off settings change updates mode immediately');
  assertEqual(runtime.view().activity.phase, 'promptClearing', 'Off settings change surfaces prompt clear activity');
  releaseClear();
  const result = await update;
  const view = runtime.view();
  assertEqual(result.ok, true, 'Off settings change returns success when prompt clear succeeds');
  assertEqual(result.settings.mode, 'off', 'Off settings change returns updated settings');
  assertEqual(result.clear.ok, true, 'Off settings change returns clear result');
  assertEqual(calls.clear, 1, 'Off settings change clears host prompt');
  assertEqual(view.activity.severity, 'success', 'Off settings change surfaces success activity');
  assertEqual(view.activity.label, 'Recursion Off. Prompt cleared.', 'Off settings change has visible success label');
}

{
  const { runtime, calls } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        throw new Error('clear failed with Bearer clear-token, sk-clear-runtime, and private-secret');
      }
    }
  });
  const result = await runtime.updateSettings({ mode: 'off' });
  const view = runtime.view();
  assertEqual(result.ok, false, 'Off settings change returns non-ok when prompt clear fails');
  assertEqual(result.settings.mode, 'off', 'Off settings still applies when prompt clear fails');
  assertEqual(result.clear.ok, false, 'Off settings change returns failed clear result');
  assertEqual(calls.clear, 1, 'Off settings clear failure still calls host prompt clear');
  assertEqual(view.activity.severity, 'warning', 'Off settings clear failure surfaces warning activity');
  assert(view.activity.label.includes('Prompt clear failed'), 'Off settings clear failure has visible warning label');
  assertNoSecretText(result, 'Off settings clear failure result');
  assertNoSecretText(view.activity, 'Off settings clear failure activity');
}

{
  let releaseClear;
  let updateResolved = false;
  const { runtime, calls, settingsStore } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  const update = Promise.resolve(runtime.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-runtime-secret',
    openAICompatible: { baseUrl: 'https://provider-change.test/v1', model: 'provider-change-model' }
  }));
  update.then(() => {
    updateResolved = true;
  });
  await waitUntil(() => typeof releaseClear === 'function', 'provider settings change did not start prompt clear');
  assertEqual(updateResolved, false, 'provider settings change waits for prompt clear before resolving');
  assertEqual(settingsStore.getApiKey('utility'), 'sk-runtime-secret', 'provider settings change stores key immediately');
  assertEqual(runtime.view().settings.providers.utility.openAICompatible.model, 'provider-change-model', 'provider settings change updates provider immediately');
  assertEqual(runtime.view().activity.phase, 'promptClearing', 'provider settings change surfaces prompt clear activity');
  releaseClear();
  const result = await update;
  const view = runtime.view();
  assertEqual(result.ok, true, 'provider settings change returns success when prompt clear succeeds');
  assertEqual(result.provider.openAICompatible.sessionApiKeyPresent, true, 'provider settings change returns updated provider');
  assertEqual(result.clear.ok, true, 'provider settings change returns clear result');
  assertEqual(calls.clear, 1, 'provider settings change clears host prompt');
  assertEqual(view.activity.severity, 'success', 'provider settings change surfaces success activity');
  assertEqual(view.activity.label, 'Recursion prompt cleared after provider change.', 'provider settings change has visible success label');
  assertNoSecretText(result, 'provider settings change result');
}

{
  let releaseFirstClear;
  let releaseSecondClear;
  let clearCalls = 0;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        clearCalls += 1;
        if (clearCalls === 1) {
          await new Promise((resolve) => {
            releaseFirstClear = resolve;
          });
          return { ok: true, cleared: true, call: 1 };
        }
        await new Promise((resolve) => {
          releaseSecondClear = resolve;
        });
        return { ok: true, cleared: true, call: 2 };
      }
    }
  });
  const first = runtime.updateProvider('utility', {
    openAICompatible: { baseUrl: 'https://first-provider.test/v1', model: 'first-provider-model' }
  });
  await waitUntil(() => typeof releaseFirstClear === 'function', 'first provider clear did not start');
  const second = runtime.updateProvider('utility', {
    openAICompatible: { baseUrl: 'https://second-provider.test/v1', model: 'second-provider-model' }
  });
  assertEqual(runtime.view().activity.label, 'Clearing Recursion prompt...', 'newer provider change owns visible prompt clear activity');
  releaseFirstClear();
  await first;
  assertEqual(runtime.view().activity.label, 'Clearing Recursion prompt...', 'older provider clear cannot settle while newer clear is pending');
  await waitUntil(() => typeof releaseSecondClear === 'function', 'second provider clear did not start');
  releaseSecondClear();
  const secondResult = await second;
  assertEqual(secondResult.ok, true, 'newer provider clear resolves successfully');
  assertEqual(runtime.view().activity.label, 'Recursion prompt cleared after provider change.', 'newer provider clear settles activity');
}

{
  const { runtime, calls, settingsStore } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        throw new Error('clear failed with Bearer provider-clear-token, sk-provider-clear, and private-secret');
      }
    }
  });
  const result = await runtime.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-runtime-secret',
    openAICompatible: { baseUrl: 'https://provider-fail.test/v1', model: 'provider-fail-model' }
  });
  const view = runtime.view();
  assertEqual(result.ok, false, 'provider settings change returns non-ok when prompt clear fails');
  assertEqual(result.provider.openAICompatible.model, 'provider-fail-model', 'provider settings still applies when prompt clear fails');
  assertEqual(settingsStore.getApiKey('utility'), 'sk-runtime-secret', 'provider key still applies when prompt clear fails');
  assertEqual(result.clear.ok, false, 'provider settings change returns failed clear result');
  assertEqual(calls.clear, 1, 'provider settings clear failure still calls host prompt clear');
  assertEqual(view.activity.severity, 'warning', 'provider settings clear failure surfaces warning activity');
  assert(view.activity.label.includes('Prompt clear failed'), 'provider settings clear failure has visible warning label');
  assertNoSecretText(result, 'provider settings clear failure result');
  assertNoSecretText(view.activity, 'provider settings clear failure activity');
}

{
  let releaseClear;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  const update = runtime.updateProvider('utility', {
    openAICompatible: { baseUrl: 'https://provider-test-race.test/v1', model: 'provider-test-race-model' }
  });
  await waitUntil(() => typeof releaseClear === 'function', 'provider test race clear did not start');
  const providerTest = await runtime.testProvider('utility');
  assertEqual(providerTest.ok, false, 'provider test without router fails for activity ownership regression');
  assertEqual(runtime.view().activity.label, 'Utility provider test failed.', 'newer provider test owns visible activity before older clear resolves');
  releaseClear();
  await update;
  assertEqual(runtime.view().activity.label, 'Utility provider test failed.', 'older provider clear cannot overwrite newer provider test activity');
}

{
  let releaseClear;
  let clearResolved = false;
  const { runtime, calls, settingsStore } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        await new Promise((resolve) => {
          releaseClear = resolve;
        });
        return { ok: true, cleared: true };
      }
    }
  });
  settingsStore.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-runtime-secret',
    openAICompatible: { baseUrl: 'https://provider-key.test/v1', model: 'provider-key-model' }
  });
  const clear = Promise.resolve(runtime.clearProviderKey('utility'));
  clear.then(() => {
    clearResolved = true;
  });
  await waitUntil(() => typeof releaseClear === 'function', 'provider key clear did not start prompt clear');
  assertEqual(clearResolved, false, 'provider key clear waits for prompt clear before resolving');
  assertEqual(settingsStore.getApiKey('utility'), '', 'provider key clear removes session secret immediately');
  assertEqual(runtime.view().settings.providers.utility.openAICompatible.sessionApiKeyPresent, false, 'provider key clear updates provider immediately');
  assertEqual(runtime.view().activity.phase, 'promptClearing', 'provider key clear surfaces prompt clear activity');
  releaseClear();
  const result = await clear;
  const view = runtime.view();
  assertEqual(result.ok, true, 'provider key clear returns success when prompt clear succeeds');
  assertEqual(result.provider.openAICompatible.sessionApiKeyPresent, false, 'provider key clear returns updated provider');
  assertEqual(result.clear.ok, true, 'provider key clear returns clear result');
  assertEqual(calls.clear, 1, 'provider key clear clears host prompt');
  assertEqual(view.activity.severity, 'success', 'provider key clear surfaces success activity');
  assertEqual(view.activity.label, 'Recursion prompt cleared after provider key change.', 'provider key clear has visible success label');
  assertNoSecretText(result, 'provider key clear result');
}

{
  const { runtime, calls, installed, cleared } = createRuntimeHarness({
    settings: { mode: 'off', reasonerUse: 'off' }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Skip this.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'off mode returns ok');
  assertEqual(result.skipped, true, 'off mode skipped');
  assertEqual(result.reason, 'off', 'off mode reason');
  assertEqual(calls.snapshot, 0, 'off mode does not read snapshot');
  assertEqual(installed.length, 0, 'off mode does not install');
  assertEqual(cleared.length, 1, 'off mode clears host prompt');
  assertEqual(view.activity.phase, 'idle', 'off mode clears activity');
  assertEqual(view.activeRunId, null, 'active run clear after off mode');
}

{
  const { runtime, calls } = createRuntimeHarness({
    settings: { mode: 'off', reasonerUse: 'off' },
    hostPrompt: {
      async clear() {
        throw new Error('clear failed with Bearer clear-token, sk-clear-runtime, and private-secret');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Clear fails.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'off mode still returns ok when clear fails');
  assertEqual(result.clear.ok, false, 'off mode reports clear warning');
  assertEqual(calls.snapshot, 0, 'off clear failure still skips snapshot');
  assertEqual(view.activity.severity, 'warning', 'off clear failure surfaces warning activity');
  assert(view.activity.label.includes('Prompt clear failed'), 'off clear failure has visible warning label');
  assertNoSecretText(result, 'off clear result');
}

{
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'off', reasonerUse: 'off' },
    hostPrompt: { methods: { clear: undefined } }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Missing clear.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'off mode still skips when clear API is missing');
  assertEqual(result.clear.ok, false, 'missing clear returns non-ok clear outcome');
  assertEqual(result.clear.error.code, 'RECURSION_PROMPT_CLEAR_UNAVAILABLE', 'missing clear returns explicit error code');
  assertEqual(calls.snapshot, 0, 'missing clear off path still skips snapshot');
  assertEqual(calls.clear, 0, 'missing clear off path does not call host clear');
  assertEqual(installed.length, 0, 'missing clear off path does not install');
  assertEqual(view.activity.severity, 'warning', 'missing clear off path surfaces warning activity');
  assert(view.activity.label.includes('Prompt clear failed'), 'missing clear off path has visible warning label');
}

{
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async install() {
        throw new Error('install transport failed');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Install fails.' });
  const view = runtime.view();
  assertEqual(result.ok, false, 'install exception returns ok false');
  assertEqual(calls.install, 1, 'install attempted once');
  assertEqual(installed.length, 1, 'failed install still received packet');
  assertEqual(view.activity.severity, 'warning', 'install failure settles warning');
  assertEqual(view.activity.label, 'Prompt install failed. Generation will continue without Recursion.', 'install failure label');
  assertEqual(view.activeRunId, null, 'active run cleared after install failure');
  const journal = await storage.loadRunJournal(view.lastSnapshot.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['hand.selected', 'prompt.install_failed'], 'install failure journals hand before failure');
  const installFailed = journal.entries.find((entry) => entry.event === 'prompt.install_failed');
  assert(installFailed, 'install failure journaled');
  assert(installFailed.summary.includes('install transport failed'), 'install failure summary includes compact error');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: {
      async install() {
        return {
          ok: false,
          error: {
            code: 'RETURNED_SECRET',
            message: 'returned failure with Bearer returned-token, sk-returned-runtime, and private-secret'
          },
          apiKey: 'sk-extra-field',
          installed: ['Bearer installed-token']
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Returned install failure.' });
  assertEqual(result.ok, false, 'returned install failure returns ok false');
  assertEqual(result.install.error.code, 'RETURNED_SECRET', 'returned install failure preserves safe code');
  assertNoSecretText(result, 'returned install result');
}

{
  const { runtime, calls, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: { methods: { install: undefined } }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'No installer.' });
  const view = runtime.view();
  assertEqual(result.ok, false, 'missing host prompt install is explicit failure');
  assertEqual(calls.install, 0, 'missing installer is not called');
  assertEqual(result.install.error.code, 'RECURSION_PROMPT_INSTALL_UNAVAILABLE', 'missing installer returns explicit error code');
  assertEqual(view.activity.label, 'Prompt install failed. Generation will continue without Recursion.', 'missing installer warning label');
  assertEqual(view.activeRunId, null, 'active run cleared after missing installer');
  const journal = await storage.loadRunJournal(view.lastSnapshot.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['hand.selected', 'prompt.install_failed'], 'missing installer journals hand before failure');
}

{
  let snapshotReads = 0;
  const firstTurn = {
    chatId: 'stale-chat',
    chatKey: 'stale-chat',
    sceneKey: 'stale-scene',
    sceneFingerprint: 'stale-scene',
    turnFingerprint: 'stale-turn-1',
    latestMesId: 10,
    messages: [
      { mesid: 10, role: 'user', text: 'First pending turn.', visible: true }
    ]
  };
  const movedTurn = {
    ...firstTurn,
    turnFingerprint: 'stale-turn-2',
    latestMesId: 11,
    messages: [
      ...firstTurn.messages,
      { mesid: 11, role: 'assistant', text: 'The host has moved on.', visible: true }
    ]
  };
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? firstTurn : movedTurn;
    },
    hostPrompt: {
      async install() {
        throw new Error('stale prompt install should not be called');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'First pending turn.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'stale prompt install returns nonfatal ok');
  assertEqual(result.skipped, true, 'stale prompt install is skipped');
  assertEqual(result.reason, 'stale-snapshot', 'stale prompt install reports stale snapshot reason');
  assertEqual(calls.snapshot, 2, 'runtime rechecks host snapshot before prompt install');
  assertEqual(calls.install, 0, 'stale snapshot does not call host prompt install');
  assertEqual(installed.length, 0, 'stale snapshot does not write prompt packet');
  assertEqual(view.activity.severity, 'warning', 'stale install skip surfaces warning activity');
  assert(view.activity.label.includes('Recursion skipped'), 'stale install skip has visible status label');
  const journal = await storage.loadRunJournal(firstTurn.chatKey);
  assertEqual(journal.entries[0].event, 'prompt.install_skipped', 'stale install skip is journaled');
}

{
  let snapshotReads = 0;
  const currentTurn = {
    chatId: 'recheck-fail-chat',
    chatKey: 'recheck-fail-chat',
    sceneKey: 'recheck-fail-scene',
    sceneFingerprint: 'recheck-fail-scene',
    turnFingerprint: 'recheck-fail-turn',
    latestMesId: 20,
    messages: [
      { mesid: 20, role: 'user', text: 'Snapshot recheck should fail closed.', visible: true }
    ]
  };
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      if (snapshotReads === 1) return currentTurn;
      throw new Error('snapshot recheck failed with Bearer recheck-token and sk-recheck-runtime');
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Snapshot recheck should fail closed.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'failed snapshot recheck returns nonfatal ok');
  assertEqual(result.skipped, true, 'failed snapshot recheck skips prompt install');
  assertEqual(result.reason, 'snapshot-recheck-failed', 'failed snapshot recheck reports reason');
  assertEqual(calls.snapshot, 2, 'failed recheck still attempts final host snapshot');
  assertEqual(calls.install, 0, 'failed snapshot recheck does not call host prompt install');
  assertEqual(installed.length, 0, 'failed snapshot recheck does not write prompt packet');
  assertEqual(view.activity.severity, 'warning', 'failed snapshot recheck surfaces warning activity');
  assertNoSecretText(result, 'snapshot recheck failure result');
  assertNoSecretText(view.activity, 'snapshot recheck failure activity');
  const journal = await storage.loadRunJournal(currentTurn.chatKey);
  assertDeepEqual(journal.entries.map((entry) => entry.event), ['prompt.install_skipped'], 'failed snapshot recheck skip is journaled without hand commit');
  assertEqual(journal.entries[0].details.reason, 'snapshot-recheck-failed', 'failed snapshot recheck journal records reason');
  assertNoSecretText(journal.entries[0], 'snapshot recheck failure journal');
}

{
  const activity = createActivityReporter();
  const storage = {
    async loadSceneCache() {
      throw new Error('load failed with Bearer load-token, sk-load-runtime, and private-secret');
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    activity
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Load cache fails.' });
  assertEqual(result.ok, true, 'throwing scene cache load does not abort runtime');
  assertEqual(installed.length, 1, 'throwing scene cache load still installs prompt');
  const serializedHistory = JSON.stringify(activity.history());
  assert(serializedHistory.includes('"operation":"loadSceneCache"'), 'load failure warning is surfaced');
  assert(!serializedHistory.includes('Bearer load-token'), 'load failure warning redacts bearer token');
  assert(!serializedHistory.includes('sk-load-runtime'), 'load failure warning redacts sk token');
  assert(!serializedHistory.includes('private-secret'), 'load failure warning redacts private secret');
}

{
  const activity = createActivityReporter();
  let appendCalls = 0;
  const storage = {
    async loadSceneCache() {
      return null;
    },
    async saveSceneCache() {
      throw new Error('save failed with Bearer save-token, sk-save-runtime, and private-secret');
    },
    async appendJournal() {
      appendCalls += 1;
      return {};
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    activity
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Save cache fails.' });
  assertEqual(result.ok, true, 'throwing scene cache save does not abort runtime');
  assertEqual(installed.length, 1, 'throwing scene cache save still installs prompt');
  assertEqual(appendCalls, 2, 'throwing scene cache save still appends hand and install journals');
  const serializedHistory = JSON.stringify(activity.history());
  assert(serializedHistory.includes('"operation":"saveSceneCache"'), 'save failure warning is surfaced');
  assert(!serializedHistory.includes('Bearer save-token'), 'save failure warning redacts bearer token');
  assert(!serializedHistory.includes('sk-save-runtime'), 'save failure warning redacts sk token');
  assert(!serializedHistory.includes('private-secret'), 'save failure warning redacts private secret');
}

{
  const activity = createActivityReporter();
  const storage = {
    async loadSceneCache() {
      return null;
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      throw new Error('append failed with Bearer journal-token, sk-journal-runtime, and private-secret');
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    activity
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Append journal fails.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'throwing journal append does not abort runtime');
  assertEqual(installed.length, 1, 'throwing journal append happens after prompt install');
  assertEqual(view.activity.label, 'Recursion prompt ready.', 'journal append failure still settles successful install');
  const serializedHistory = JSON.stringify(activity.history());
  assert(serializedHistory.includes('"operation":"appendJournal"'), 'append failure warning is surfaced');
  assert(!serializedHistory.includes('Bearer journal-token'), 'append failure warning redacts bearer token');
  assert(!serializedHistory.includes('sk-journal-runtime'), 'append failure warning redacts sk token');
  assert(!serializedHistory.includes('private-secret'), 'append failure warning redacts private secret');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', promptFootprint: 'rich', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        assertEqual(roleId, 'utilityArbiter', 'only utility arbiter should be called');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            cardJobs: [{ family: 'Open Threads', reason: 'Need one open thread card.' }],
            budgets: { targetBriefTokens: 60, maxCards: 1 },
            reasonerDecision: { mode: 'use', reason: 'arbiter requested reasoner', signals: ['test'] },
            diagnostics: ['router-plan']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Router budgets.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'router arbiter success still installs');
  assertDeepEqual(view.lastPlan.cardJobs, [{ family: 'Open Threads', reason: 'Need one open thread card.' }], 'router card jobs merged');
  assertEqual(view.lastPlan.budgets.maxCards, 1, 'router maxCards budget merged');
  assertEqual(view.lastPlan.budgets.targetBriefTokens, 60, 'router token budget merged');
  assertEqual(view.lastPlan.reasonerDecision.mode, 'use', 'arbiter reasoner decision preserved in plan');
  assertEqual(view.lastHand.cards.length, 1, 'router card budget changes selected hand');
  assertEqual(view.lastPacket.diagnostics.reasonerStatus, 'skipped', 'settings reasonerUse off is preserved');
  assertEqual(routerCalls.length, 1, 'reasoner composer not called when reasonerUse is off');
}

{
  const { runtime, installed, settingsStore } = createRuntimeHarness({
    settings: { mode: 'auto', promptFootprint: 'normal', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'compact footprint override only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            promptFootprint: 'compact',
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['compact-footprint-override']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use compact footprint this turn.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'arbiter compact footprint run installs');
  assertEqual(result.plan.promptFootprint, 'compact', 'result plan exposes sanitized arbiter compact footprint');
  assertEqual(view.lastPlan.promptFootprint, 'compact', 'view plan exposes sanitized arbiter compact footprint');
  assertEqual(view.lastPacket.footprint, 'compact', 'last packet uses arbiter compact footprint');
  assertEqual(installed[0].footprint, 'compact', 'installed packet uses arbiter compact footprint');
  assertEqual(settingsStore.get().promptFootprint, 'normal', 'arbiter footprint does not mutate stored setting');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', promptFootprint: 'compact', reasonerUse: 'auto' },
    generationRouter: {
      async generate(roleId) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              promptFootprint: 'rich',
              reasonerDecision: { mode: 'use', reason: 'rich turn needs synthesis', signals: ['rich-footprint'] },
              budgets: { targetBriefTokens: 900, maxCards: 6 }
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.reasonerComposer.v1',
              instructionPatch: 'Use the richer synthesis for this turn.',
              keptCardIds: [],
              droppedCardIds: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use rich footprint with reasoner.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'arbiter rich footprint run installs');
  assertEqual(view.lastPlan.promptFootprint, 'rich', 'view plan exposes sanitized arbiter rich footprint');
  assertEqual(view.lastPacket.footprint, 'rich', 'last packet uses arbiter rich footprint');
  assert(routerCalls.includes('reasonerComposer'), 'rich arbiter footprint with auto reasoner invokes reasoner composer');
  assertEqual(view.lastPacket.diagnostics.composerLane, 'reasoner', 'rich arbiter footprint records reasoner composer lane');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', promptFootprint: 'compact', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'invalid footprint fallback only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            promptFootprint: 'oversized-secret-mode',
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['invalid-footprint-fallback']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reject invalid footprint.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'invalid arbiter footprint falls back and installs');
  assertEqual(result.plan.promptFootprint, 'compact', 'result plan falls back to stored compact footprint');
  assertEqual(view.lastPlan.promptFootprint, 'compact', 'view plan falls back to stored compact footprint');
  assertEqual(view.lastPacket.footprint, 'compact', 'last packet uses stored compact footprint fallback');
  assert(!JSON.stringify(result.plan).includes('oversized-secret-mode'), 'invalid arbiter footprint is not exposed in result plan');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'invalid scene status fallback only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            sceneStatus: 'hard_shift',
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['invalid-scene-status-fallback']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reject old scene status.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'invalid arbiter scene status falls back and installs');
  assertEqual(result.plan.sceneStatus, 'same-scene', 'result plan falls back to V1 scene status');
  assertEqual(view.lastPlan.sceneStatus, 'same-scene', 'view plan falls back to V1 scene status');
  assert(!JSON.stringify(result.plan).includes('hard_shift'), 'invalid arbiter scene status is not exposed in result plan');
}

{
  let arbiterPrompt = '';
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'pending-chat',
      chatKey: 'pending-chat',
      sceneKey: 'pending-scene',
      sceneFingerprint: 'pending-scene-fp',
      turnFingerprint: 'pending-old-turn-fp',
      latestMesId: 7,
      messages: [
        { mesid: 7, role: 'assistant', text: 'The previous assistant reply is already committed.', visible: true }
      ]
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'pending user message merge only needs Utility Arbiter');
        arbiterPrompt = request.prompt;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'skip',
            diagnostics: ['pending-user-message']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'The pending user turn should be visible to Recursion.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'pending user message merge run skips safely');
  assert(view.lastSnapshot.messages.some((message) => message.text === 'The pending user turn should be visible to Recursion.'), 'runtime snapshot includes pending user turn');
  assert(arbiterPrompt.includes('The pending user turn should be visible to Recursion.'), 'arbiter prompt includes pending user turn text');
  assertEqual(view.lastSnapshot.latestMesId, 8, 'pending user turn advances latest message id');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'pending-mesid-chat',
      chatKey: 'pending-mesid-chat',
      sceneKey: 'pending-mesid-scene',
      sceneFingerprint: 'pending-mesid-scene-fp',
      turnFingerprint: 'pending-mesid-old-turn-fp',
      latestMesId: 7,
      messages: [
        { mesid: 7, role: 'assistant', text: 'The previous assistant reply is committed.', visible: true }
      ]
    },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'skip',
            diagnostics: ['pending-user-message-mesid']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({
    userMessage: { mesid: 12, text: 'The pending user turn carries its host mesid.' }
  });
  const view = runtime.view();
  const pendingMessage = view.lastSnapshot.messages.find((message) => message.text === 'The pending user turn carries its host mesid.');
  assertEqual(result.ok, true, 'pending user message object merge run skips safely');
  assertEqual(pendingMessage?.mesid, 12, 'pending user turn preserves host mesid');
  assertEqual(view.lastSnapshot.latestMesId, 12, 'pending user turn preserves host latest message id');
}

{
  let snapshotReads = 0;
  const pendingText = 'The committed pending turn should still install.';
  const initialSnapshot = {
    chatId: 'pending-install-chat',
    chatKey: 'pending-install-chat',
    sceneKey: 'pending-install-scene',
    sceneFingerprint: 'pending-install-scene-fp',
    turnFingerprint: 'pending-install-before-host-fp',
    latestMesId: 30,
    messages: [
      { mesid: 30, role: 'assistant', text: 'The prior assistant reply is committed.', visible: true }
    ]
  };
  const committedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'host-committed-pending-fp',
    latestMesId: 31,
    messages: [
      ...initialSnapshot.messages,
      { mesid: 31, role: 'user', text: pendingText, visible: true }
    ]
  };
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : committedSnapshot;
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: { mesid: 31, text: pendingText } });
  assertEqual(result.ok, true, 'committed pending user turn is still fresh enough to install');
  assertEqual(result.skipped, undefined, 'committed pending user turn is not treated as stale');
  assertEqual(calls.snapshot, 3, 'committed pending install reads initial, compose, and install snapshots');
  assertEqual(installed.length, 1, 'committed pending user turn installs prompt');
  assert(JSON.stringify(installed[0]).includes(pendingText), 'installed prompt includes committed pending user turn');
}

{
  let snapshotReads = 0;
  const pendingText = 'The committed pending hard shift should still install.';
  const initialSnapshot = {
    chatId: 'pending-hard-shift-chat',
    chatKey: 'pending-hard-shift-chat',
    sceneKey: 'pending-hard-shift-scene',
    sceneFingerprint: 'pending-hard-shift-scene-fp',
    turnFingerprint: 'pending-hard-shift-before-host-fp',
    latestMesId: 40,
    messages: [
      { mesid: 40, role: 'assistant', text: 'The prior scene ends.', visible: true }
    ]
  };
  const committedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'host-committed-pending-hard-shift-fp',
    latestMesId: 41,
    messages: [
      ...initialSnapshot.messages,
      { mesid: 41, role: 'user', text: pendingText, visible: true }
    ]
  };
  const { runtime, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : committedSnapshot;
    },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'pending hard-shift install only needs Utility Arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'compose-brief',
            sceneStatus: 'hard-shift',
            diagnostics: ['pending-hard-shift-commit']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: { mesid: 41, text: pendingText } });
  const expectedCommittedSceneFingerprint = hashJson({
    previousSceneFingerprint: committedSnapshot.sceneFingerprint,
    hardShiftAtMesId: committedSnapshot.latestMesId,
    turnFingerprint: committedSnapshot.turnFingerprint
  });
  const expectedCommittedSceneKey = `${committedSnapshot.chatKey}-${expectedCommittedSceneFingerprint}`;
  const view = runtime.view();
  assertEqual(result.ok, true, 'committed pending hard-shift turn is still fresh enough to install');
  assertEqual(result.skipped, undefined, 'committed pending hard-shift turn is not treated as stale');
  assertEqual(installed.length, 1, 'committed pending hard-shift turn installs prompt');
  assertEqual(view.lastSnapshot.sceneFingerprint, expectedCommittedSceneFingerprint, 'committed pending hard-shift snapshot becomes canonical');
  assertEqual(view.lastPacket.sceneFingerprint, expectedCommittedSceneFingerprint, 'committed pending hard-shift packet uses canonical scene fingerprint');
  const committedCache = await storage.loadSceneCache(committedSnapshot.chatKey, expectedCommittedSceneKey);
  assertEqual(committedCache.latestHand?.handId, view.lastHand.handId, 'committed pending hard-shift cache saves under canonical scene key');
}

{
  let snapshotReads = 0;
  const pendingText = 'The late committed hard shift should recompose before install.';
  const initialSnapshot = {
    chatId: 'late-hard-shift-chat',
    chatKey: 'late-hard-shift-chat',
    sceneKey: 'late-hard-shift-scene',
    sceneFingerprint: 'late-hard-shift-scene-fp',
    turnFingerprint: 'late-hard-shift-before-host-fp',
    latestMesId: 50,
    messages: [
      { mesid: 50, role: 'assistant', text: 'The old scene is still closing.', visible: true }
    ]
  };
  const committedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'host-late-committed-hard-shift-fp',
    latestMesId: 51,
    messages: [
      ...initialSnapshot.messages,
      { mesid: 51, role: 'user', text: pendingText, visible: true }
    ]
  };
  const { runtime, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads <= 2 ? initialSnapshot : committedSnapshot;
    },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'late pending hard-shift install only needs Utility Arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'compose-brief',
            sceneStatus: 'hard-shift',
            diagnostics: ['late-pending-hard-shift-commit']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: { mesid: 51, text: pendingText } });
  const expectedCommittedSceneFingerprint = hashJson({
    previousSceneFingerprint: committedSnapshot.sceneFingerprint,
    hardShiftAtMesId: committedSnapshot.latestMesId,
    turnFingerprint: committedSnapshot.turnFingerprint
  });
  const expectedCommittedSceneKey = `${committedSnapshot.chatKey}-${expectedCommittedSceneFingerprint}`;
  const view = runtime.view();
  assertEqual(result.ok, true, 'late committed pending hard-shift turn still installs');
  assertEqual(installed.length, 1, 'late committed pending hard-shift turn installs one prompt');
  assertEqual(view.lastSnapshot.sceneFingerprint, expectedCommittedSceneFingerprint, 'late committed pending hard-shift snapshot becomes canonical');
  assertEqual(view.lastPacket.sceneFingerprint, expectedCommittedSceneFingerprint, 'late committed pending hard-shift packet is recomposed with canonical scene fingerprint');
  const committedCache = await storage.loadSceneCache(committedSnapshot.chatKey, expectedCommittedSceneKey);
  assertEqual(committedCache.latestHand?.handId, view.lastHand.handId, 'late committed pending hard-shift cache saves under canonical scene key');
}

{
  let snapshotReads = 0;
  const pendingText = 'The final moved hard shift must not install.';
  const initialSnapshot = {
    chatId: 'final-move-chat',
    chatKey: 'final-move-chat',
    sceneKey: 'final-move-scene',
    sceneFingerprint: 'final-move-scene-fp',
    turnFingerprint: 'final-move-before-host-fp',
    latestMesId: 60,
    messages: [
      { mesid: 60, role: 'assistant', text: 'The old scene waits.', visible: true }
    ]
  };
  const committedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'host-final-move-committed-fp',
    latestMesId: 61,
    messages: [
      ...initialSnapshot.messages,
      { mesid: 61, role: 'user', text: pendingText, visible: true }
    ]
  };
  const movedSnapshot = {
    ...committedSnapshot,
    turnFingerprint: 'host-final-move-after-recompose-fp',
    latestMesId: 62,
    messages: [
      ...committedSnapshot.messages,
      { mesid: 62, role: 'assistant', text: 'The host moved again before install.', visible: true }
    ]
  };
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      if (snapshotReads <= 2) return initialSnapshot;
      if (snapshotReads === 3) return committedSnapshot;
      return movedSnapshot;
    },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'final move hard-shift install only needs Utility Arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'compose-brief',
            sceneStatus: 'hard-shift',
            diagnostics: ['final-move-after-recompose']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: { mesid: 61, text: pendingText } });
  assertEqual(result.ok, true, 'final moved hard-shift skip is nonfatal');
  assertEqual(result.skipped, true, 'final moved hard-shift skips prompt install');
  assertEqual(result.reason, 'stale-snapshot', 'final moved hard-shift reports stale snapshot');
  assertEqual(calls.snapshot, 4, 'final moved hard-shift rechecks after recompose');
  assertEqual(calls.install, 0, 'final moved hard-shift does not call host prompt install');
  assertEqual(installed.length, 0, 'final moved hard-shift does not write prompt packet');
}

{
  let snapshotReads = 0;
  const unchangedPrefix = 'A'.repeat(950);
  const initialText = `${unchangedPrefix} old visible ending`;
  const editedText = `${unchangedPrefix} new visible ending`;
  const initialSnapshot = {
    chatId: 'long-edit-chat',
    chatKey: 'long-edit-chat',
    sceneKey: 'long-edit-scene',
    sceneFingerprint: 'long-edit-scene-fp',
    turnFingerprint: 'long-edit-before-fp',
    latestMesId: 70,
    messages: [
      { mesid: 70, role: 'user', text: initialText, visible: true }
    ]
  };
  const editedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'long-edit-after-fp',
    messages: [
      { mesid: 70, role: 'user', text: editedText, visible: true }
    ]
  };
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : editedSnapshot;
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: initialText });
  assertEqual(result.ok, true, 'long visible edit skip is nonfatal');
  assertEqual(result.skipped, true, 'long visible edit skips prompt install');
  assertEqual(result.reason, 'stale-snapshot', 'long visible edit reports stale snapshot');
  assertEqual(calls.install, 0, 'long visible edit does not call host prompt install');
  assertEqual(installed.length, 0, 'long visible edit does not write prompt packet');
}

{
  let snapshotReads = 0;
  const unchangedPrefix = 'B'.repeat(1300);
  const initialText = `${unchangedPrefix} old beyond runtime cap`;
  const editedText = `${unchangedPrefix} new beyond runtime cap`;
  const initialSnapshot = {
    chatId: 'runtime-cap-edit-chat',
    chatKey: 'runtime-cap-edit-chat',
    sceneKey: 'runtime-cap-edit-scene',
    sceneFingerprint: 'runtime-cap-edit-scene-fp',
    turnFingerprint: 'runtime-cap-edit-before-fp',
    latestMesId: 75,
    messages: [
      { mesid: 75, role: 'user', text: initialText, visible: true }
    ]
  };
  const editedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'runtime-cap-edit-after-fp',
    messages: [
      { mesid: 75, role: 'user', text: editedText, visible: true }
    ]
  };
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : editedSnapshot;
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: initialText });
  assertEqual(result.ok, true, 'runtime-cap visible edit skip is nonfatal');
  assertEqual(result.skipped, true, 'runtime-cap visible edit skips prompt install');
  assertEqual(result.reason, 'stale-snapshot', 'runtime-cap visible edit reports stale snapshot');
  assertEqual(calls.install, 0, 'runtime-cap visible edit does not call host prompt install');
  assertEqual(installed.length, 0, 'runtime-cap visible edit does not write prompt packet');
}

{
  let snapshotReads = 0;
  const visibleText = 'Visible turn is unchanged while hidden host state advances.';
  const initialSnapshot = {
    chatId: 'hidden-bookkeeping-chat',
    chatKey: 'hidden-bookkeeping-chat',
    sceneKey: 'hidden-bookkeeping-scene',
    sceneFingerprint: 'hidden-bookkeeping-scene-fp',
    turnFingerprint: 'hidden-bookkeeping-before-fp',
    latestMesId: 80,
    messages: [
      { mesid: 80, role: 'user', text: visibleText, visible: true }
    ]
  };
  const hiddenAdvancedSnapshot = {
    ...initialSnapshot,
    turnFingerprint: 'hidden-bookkeeping-after-fp',
    latestMesId: 81,
    messages: [
      ...initialSnapshot.messages,
      { mesid: 81, role: 'assistant', text: 'Hidden bookkeeping update.', visible: false }
    ]
  };
  const { runtime, calls, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? initialSnapshot : hiddenAdvancedSnapshot;
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: visibleText });
  assertEqual(result.ok, true, 'hidden host bookkeeping still installs');
  assertEqual(result.skipped, undefined, 'hidden host bookkeeping is not treated as stale');
  assertEqual(calls.snapshot, 3, 'hidden host bookkeeping uses normal install recheck cadence');
  assertEqual(calls.install, 1, 'hidden host bookkeeping calls host prompt install');
  assertEqual(installed.length, 1, 'hidden host bookkeeping writes one prompt packet');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'repeat-pending-chat',
      chatKey: 'repeat-pending-chat',
      sceneKey: 'repeat-pending-scene',
      sceneFingerprint: 'repeat-pending-scene-fp',
      turnFingerprint: 'repeat-pending-old-turn-fp',
      latestMesId: 4,
      messages: [
        { mesid: 3, role: 'user', text: 'Repeat this.', visible: true },
        { mesid: 4, role: 'assistant', text: 'The assistant answered the first repeat.', visible: true }
      ]
    },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'skip',
            diagnostics: ['repeated-pending-user-message']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Repeat this.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'repeated pending user text run skips safely');
  assertEqual(view.lastSnapshot.messages.filter((message) => message.role === 'user' && message.text === 'Repeat this.').length, 2, 'repeated pending user text is appended after an assistant reply');
  assertEqual(view.lastSnapshot.latestMesId, 5, 'repeated pending user turn advances latest message id');
}

{
  const arbiterPrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: {
      mode: 'auto',
      promptFootprint: 'normal',
      reasonerUse: 'auto',
      providers: {
        utility: { enabled: true, source: 'host-current-model', lastTest: { status: 'fail', checkedAt: '2026-06-30T00:00:00.000Z', compactError: 'Bearer settings-token sk-live-settings private-secret' } },
        reasoner: { enabled: true, source: 'openai-compatible', openAICompatible: { apiKey: 'sk-settings-key' }, lastTest: { status: 'pass', compactError: 'Bearer reasoner-settings' } }
      }
    },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') arbiterPrompts.push(request.prompt);
        return { ok: true, data: { schema: UTILITY_ARBITER_SCHEMA, action: 'skip', diagnostics: ['settings-projection'] } };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Settings projection.' });
  assertEqual(result.ok, true, 'settings projection run skips safely');
  assertEqual(arbiterPrompts.length, 1, 'arbiter prompt captured');
  assert(arbiterPrompts[0].includes('"mode":"auto"'), 'arbiter prompt includes planning mode');
  assert(arbiterPrompts[0].includes('"promptFootprint":"normal"'), 'arbiter prompt includes prompt footprint');
  assert(!arbiterPrompts[0].includes('lastTest'), 'arbiter prompt omits provider test diagnostics');
  assert(!arbiterPrompts[0].includes('openAICompatible'), 'arbiter prompt omits endpoint settings');
  assert(!arbiterPrompts[0].includes('compactError'), 'arbiter prompt omits provider compact errors');
  assert(!arbiterPrompts[0].includes('checkedAt'), 'arbiter prompt omits provider test timestamps');
  const providerHealth = parsePromptJsonSection(arbiterPrompts[0], 'Provider health');
  assertDeepEqual(providerHealth, {
    utility: { enabled: true, source: 'host-current-model', status: 'fail' },
    reasoner: { enabled: true, source: 'openai-compatible', status: 'pass' }
  }, 'arbiter provider health prompt exposes only lane, source, and status');
  assertNoSecretText(arbiterPrompts[0], 'arbiter settings prompt');
  assertNoSecretText(runtime.view().settings, 'runtime view settings');
  assertEqual(runtime.view().settings.providers.utility.enabled, true, 'view keeps utility provider enabled flag');
  assertEqual(runtime.view().settings.providers.utility.source, 'host-current-model', 'view keeps utility provider source');
  assertDeepEqual(
    runtime.view().settings.providers.reasoner.openAICompatible,
    { baseUrl: '', model: '', sessionApiKeyPresent: false },
    'view keeps safe endpoint settings without secrets'
  );
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'compose-brief',
            sceneStatus: 'same-scene',
            cardJobs: [{
              family: 'Open Threads',
              reason: 'Bearer plan-token, sk-live-card, and private-secret must be scrubbed.',
              extraJobField: 'sk-extra-job'
            }],
            budgets: { targetBriefTokens: 500, maxCards: 1 },
            reasonerDecision: {
              mode: 'skip',
              reason: 'Bearer reasoner-token, sk-live-reasoner, and private-secret must be scrubbed.',
              signals: ['safe-signal', 'Bearer signal-token', 'sk-live-signal', { nested: 'private-secret' }],
              extraDecisionField: 'sk-extra-decision'
            },
            diagnostics: ['safe-diagnostic', 'Bearer diagnostic-token', 'sk-live-diagnostic', 'private-secret'],
            apiKey: 'sk-extra-top-level',
            authorization: 'Bearer extra-top-level',
            nested: { secret: 'private-secret' }
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Scrub plan.' });
  const viewPlan = runtime.view().lastPlan;
  assertEqual(result.ok, true, 'scrubbed arbiter plan still installs');
  assertEqual(result.plan.apiKey, undefined, 'result plan drops arbitrary top-level apiKey');
  assertEqual(result.plan.authorization, undefined, 'result plan drops arbitrary top-level authorization');
  assertEqual(result.plan.nested, undefined, 'result plan drops arbitrary top-level nested object');
  assertEqual(result.plan.cardJobs[0].extraJobField, undefined, 'result plan drops arbitrary card job fields');
  assertEqual(result.plan.reasonerDecision.extraDecisionField, undefined, 'result plan drops arbitrary reasoner decision fields');
  assertDeepEqual(Object.keys(result.plan).sort(), ['action', 'budgets', 'cardJobs', 'diagnostics', 'lifecycle', 'promptFootprint', 'reasonerDecision', 'sceneStatus', 'schema', 'snapshotHash', 'source'].sort(), 'result plan only exposes whitelisted fields');
  assert(result.plan.diagnostics.includes('safe-diagnostic'), 'safe diagnostics survive plan scrub');
  assert(result.plan.reasonerDecision.signals.includes('safe-signal'), 'safe reasoner signals survive plan scrub');
  assert(result.plan.reasonerDecision.signals.every((signal) => typeof signal === 'string'), 'reasoner signals normalize to strings');
  assertNoSecretText({ resultPlan: result.plan, viewPlan }, 'successful arbiter plan');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            snapshotHash: 'hallucinated-provider-hash',
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['bogus-snapshot-hash']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Ignore bogus hash.' });
  assertEqual(result.ok, true, 'bogus arbiter snapshot hash still installs');
  assert(result.plan.snapshotHash !== 'hallucinated-provider-hash', 'provider snapshot hash is ignored');
  assertEqual(result.plan.snapshotHash, result.plan.source.snapshotHash, 'runtime snapshot hash remains authoritative');
  assertEqual(runtime.view().lastPlan.snapshotHash, result.plan.snapshotHash, 'view plan uses runtime snapshot hash');
}

{
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            budgets: { targetBriefTokens: 0, maxCards: 0 },
            diagnostics: ['zero-budget']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Zero budget.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'zero-budget plan still runs fail-soft');
  assertEqual(installed.length, 1, 'zero-budget plan still installs compact packet');
  assertEqual(view.lastPlan.budgets.maxCards, 0, 'zero maxCards budget is preserved');
  assertEqual(view.lastPlan.budgets.targetBriefTokens, 0, 'zero token budget is preserved');
  assertEqual(view.lastHand.cards.length, 0, 'zero maxCards budget selects no cards');
}

{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            cardJobs: [{ family: 'Open Threads', reason: 'Need a provider provenance card.' }],
            budgets: { targetBriefTokens: 900, maxCards: 6 }
          }
        };
      },
      async batch(requests) {
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            items: [{
              snapshotHash: 'hallucinated-card-snapshot-hash',
              source: { snapshotHash: 'hallucinated-source-snapshot-hash' },
              freshness: { sourceFingerprint: 'hallucinated-freshness-hash' },
              promptText: 'Provider card should keep runtime-owned provenance.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 12
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Provider provenance.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const providerCard = cache.cards.find((card) => card.promptText.includes('Provider card should keep runtime-owned provenance.'));
  const handCard = view.lastHand.cards.find((card) => card.promptText.includes('Provider card should keep runtime-owned provenance.'));
  const expectedProviderSourceHash = sourceWindowHash([
    { mesid: 2, role: 'user', text: 'The lamp breaks.', visible: true },
    { mesid: 3, role: 'user', text: 'Provider provenance.', visible: true }
  ], 2, 3);
  assertEqual(result.ok, true, 'provider card provenance run installs');
  assert(handCard, 'provider card is selected into full hand');
  assertEqual(handCard.source?.snapshotHash, undefined, 'hand card exposes compact prompt-safe shape only');
  assert(providerCard, 'provider card is persisted to cache');
  assertEqual(providerCard.sourceFingerprint, expectedProviderSourceHash, 'provider card cache fingerprint uses runtime source-window hash');
  assert(!JSON.stringify({ view, cache }).includes('hallucinated-card-snapshot-hash'), 'provider card top-level snapshot hash is ignored everywhere visible');
  assert(!JSON.stringify({ view, cache }).includes('hallucinated-source-snapshot-hash'), 'provider card source snapshot hash is ignored everywhere visible');
  assert(!JSON.stringify({ view, cache }).includes('hallucinated-freshness-hash'), 'provider card freshness fingerprint is ignored everywhere visible');
}

{
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'skip',
            diagnostics: ['arbiter-skip-test'],
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Arbiter says skip.' });
  assertEqual(result.ok, true, 'arbiter skip returns ok');
  assertEqual(result.skipped, true, 'arbiter skip result is marked skipped');
  assertEqual(result.reason, 'arbiter-skip', 'arbiter skip reason is explicit');
  assertEqual(installed.length, 0, 'arbiter skip does not install prompt');
  assertEqual(runtime.view().activity.label, 'Recursion skipped by Utility Arbiter.', 'arbiter skip settles visible activity');
}

{
  const { runtime, installed, calls } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    hostPrompt: { methods: { clear: undefined } },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'skip',
            diagnostics: ['arbiter-skip-missing-clear']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Arbiter skip missing clear.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'arbiter skip still returns skipped when clear API is missing');
  assertEqual(result.skipped, true, 'arbiter skip missing clear result is marked skipped');
  assertEqual(result.clear.ok, false, 'arbiter skip missing clear returns non-ok clear outcome');
  assertEqual(result.clear.error.code, 'RECURSION_PROMPT_CLEAR_UNAVAILABLE', 'arbiter skip missing clear returns explicit error code');
  assertEqual(calls.clear, 0, 'arbiter skip missing clear does not call host clear');
  assertEqual(installed.length, 0, 'arbiter skip missing clear does not install prompt');
  assertEqual(view.activity.severity, 'warning', 'arbiter skip missing clear surfaces warning activity');
  assert(view.activity.label.includes('Prompt clear failed'), 'arbiter skip missing clear has visible warning label');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', promptFootprint: 'normal', reasonerUse: 'auto' },
    generationRouter: {
      async generate(roleId) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              reasonerDecision: { mode: 'use', reason: 'crowded hand', signals: ['test'] },
              budgets: { targetBriefTokens: 900, maxCards: 6 }
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.reasonerComposer.v1',
              instructionPatch: 'Use the compact synthesis.',
              keptCardIds: [],
              droppedCardIds: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use reasoner when arbiter asks.' });
  assertEqual(result.ok, true, 'arbiter reasoner decision still installs');
  assert(routerCalls.includes('reasonerComposer'), 'arbiter reasoner use promotes reasoner composer when setting is auto');
  assertEqual(runtime.view().lastPacket.diagnostics.reasonerStatus, 'used', 'reasoner status records arbiter-promoted reasoner');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', promptFootprint: 'rich', reasonerUse: 'auto' },
    generationRouter: {
      async generate(roleId) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              reasonerDecision: { mode: 'skip', reason: 'rich prompt does not need reasoner', signals: ['explicit-skip'] },
              budgets: { targetBriefTokens: 900, maxCards: 6 }
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.reasonerComposer.v1',
              instructionPatch: 'This should not be used.',
              keptCardIds: [],
              droppedCardIds: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Skip reasoner on rich auto.' });
  assertEqual(result.ok, true, 'rich auto run still installs when arbiter skips reasoner');
  assert(!routerCalls.includes('reasonerComposer'), 'arbiter reasoner skip suppresses reasoner composer for rich auto prompts');
  assertEqual(runtime.view().lastPacket.diagnostics.reasonerStatus, 'skipped', 'reasoner status stays skipped when arbiter skips reasoner');
}

{
  let arbiterSignal = null;
  let batchSignal = null;
  let reasonerSignal = null;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', promptFootprint: 'rich', reasonerUse: 'always' },
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          arbiterSignal = request.signal;
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              cardJobs: [{ family: 'Open Threads', reason: 'Need one open thread card.' }],
              budgets: { targetBriefTokens: 900, maxCards: 6 },
              reasonerDecision: { mode: 'use', reason: 'signal propagation test', signals: ['signal-test'] }
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          reasonerSignal = request.signal;
          return {
            ok: true,
            data: {
              schema: 'recursion.reasonerComposer.v1',
              instructionPatch: 'Keep the signal-threaded guidance.',
              keptCardIds: [],
              droppedCardIds: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      },
      async batch(requests, options = {}) {
        batchSignal = options.signal;
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            items: [{
              promptText: 'Remember the signal-threaded open thread.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 10
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Thread abort signals.' });
  assertEqual(result.ok, true, 'signal-threaded provider run still installs');
  assert(isAbortSignal(arbiterSignal), 'utility arbiter receives per-run abort signal');
  assert(isAbortSignal(batchSignal), 'card batch receives per-run abort signal');
  assert(isAbortSignal(reasonerSignal), 'reasoner composer receives per-run abort signal through prompt composition');
  assertEqual(arbiterSignal, batchSignal, 'utility arbiter and batch share the run signal');
  assertEqual(arbiterSignal, reasonerSignal, 'reasoner composer shares the run signal');
}

{
  const activity = createActivityReporter();
  const router = createGenerationRouter({
    activity,
    client: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'shared activity test only needs utility arbiter');
        return {
          text: JSON.stringify({
            schema: 'recursion.utilityArbiter.v1',
            action: 'compose-brief',
            cardJobs: [],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            reasonerDecision: { mode: 'skip', reason: 'shared activity test' }
          }),
          providerSource: 'test-client',
          providerId: 'test-client',
          model: 'test-model'
        };
      }
    }
  });
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    activity,
    generationRouter: router
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Shared activity.' });
  assertEqual(result.ok, true, 'shared activity router run installs');
  assertEqual(runtime.view().activity.label, 'Recursion prompt ready.', 'runtime prompt readiness owns final activity status');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate() {
        throw new Error('arbiter failed with Bearer arbiter-token, sk-arbiter-runtime, and private-secret');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Arbiter secret fallback.' });
  const serialized = JSON.stringify({ result, view: runtime.view() });
  assertEqual(result.ok, true, 'secret-bearing arbiter error falls back');
  assert(serialized.includes('utility-arbiter-fallback'), 'arbiter fallback diagnostic retained');
  assert(!serialized.includes('Bearer arbiter-token'), 'arbiter fallback reason redacts bearer token');
  assert(!serialized.includes('sk-arbiter-runtime'), 'arbiter fallback reason redacts sk token');
  assert(!serialized.includes('private-secret'), 'arbiter fallback reason redacts private secret');
}

{
  const routerCalls = [];
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId) {
        routerCalls.push(roleId);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            cardJobs: [{ role: 'openThreadsCard', reason: 'Need one open thread card.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['provider-card-plan']
          }
        };
      },
      async batch(requests) {
        routerCalls.push(...requests.map((request) => request.roleId));
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            items: [{
              promptText: 'The unanswered signal still needs a response without Bearer live-token or sk-live-runtime.',
              summary: 'Open thread summary with Bearer live-token.',
              evidenceRefs: ['message:2 sk-live-runtime'],
              inspectorNotes: 'Diagnostic with Bearer live-token.',
              tokenEstimate: 18
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Generate card job.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  assertEqual(result.ok, true, 'provider card job run installs prompt');
  assert(routerCalls.includes('utilityArbiter'), 'arbiter called for provider card job');
  assert(routerCalls.includes('openThreadsCard'), 'card job routed through batch');
  assert(cache.cards.some((card) => card.family === 'Open Threads'), 'provider card persisted in scene cache');
  assert(view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'provider card selected into hand');
  assert(view.lastPacket.sections.turnBrief.includes('unanswered signal'), 'provider card reaches prompt packet');
  assert(!cache.cards.some((card) => card.family === 'Scene Frame'), 'successful provider card pass does not add local Scene Frame fallback card');
  assert(!cache.cards.some((card) => card.family === 'Continuity Risk'), 'successful provider card pass does not add local Continuity Risk fallback card');
  const serialized = JSON.stringify({ cache, hand: view.lastHand, packet: view.lastPacket });
  assert(!serialized.includes('Bearer live-token'), 'provider card bearer token redacted before persistence and prompt');
  assert(!serialized.includes('sk-live-runtime'), 'provider card sk token redacted before persistence and prompt');
}

{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            cardJobs: [{ role: 'openThreadsCard', reason: 'Need one open thread card.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['identityless-provider-envelope']
          }
        };
      },
      async batch(requests) {
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            items: [{
              promptText: 'Identityless provider card must not enter cache or prompt.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 12
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reject identityless card envelope.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const serialized = JSON.stringify({ cache, hand: view.lastHand, packet: view.lastPacket });
  assertEqual(result.ok, true, 'identityless provider envelope run remains fail-soft');
  assert(!serialized.includes('Identityless provider card'), 'identityless provider envelope is not accepted into cache, hand, or packet');
}

{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            cardJobs: [{ role: 'openThreadsCard', reason: 'Need one open thread card.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['wrong-role-provider-envelope']
          }
        };
      },
      async batch() {
        return [{
          ok: true,
          roleId: 'continuityRiskCard',
          data: {
            schema: 'recursion.card.v1',
            role: 'continuityRiskCard',
            family: 'Continuity Risk',
            items: [{
              promptText: 'Wrong returned role must not enter cache or prompt.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 12
            }]
          }
        }];
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reject wrong role card envelope.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const serialized = JSON.stringify({ cache, hand: view.lastHand, packet: view.lastPacket });
  assertEqual(result.ok, true, 'wrong-role provider envelope run remains fail-soft');
  assert(!serialized.includes('Wrong returned role'), 'provider envelope with role mismatched to request slot is not accepted');
}

{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            cardJobs: [{ role: 'openThreadsCard', reason: 'Need one open thread card.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['extra-provider-envelope']
          }
        };
      },
      async batch(requests) {
        return [
          {
            ok: true,
            roleId: requests[0].roleId,
            data: {
              schema: 'recursion.card.v1',
              role: requests[0].metadata.role,
              family: requests[0].metadata.family,
              items: [{
                promptText: 'Expected provider card may enter cache.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 12
              }]
            }
          },
          {
            ok: true,
            roleId: 'sceneFrameCard',
            data: {
              schema: 'recursion.card.v1',
              role: 'sceneFrameCard',
              family: 'Scene Frame',
              items: [{
                promptText: 'Extra provider result must not enter cache or prompt.',
                evidenceRefs: ['message:2'],
                tokenEstimate: 12
              }]
            }
          }
        ];
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reject extra card envelope.' });
  const view = runtime.view();
  const cache = await storage.loadSceneCache(view.lastSnapshot.chatKey, view.lastSnapshot.sceneKey);
  const serialized = JSON.stringify({ cache, hand: view.lastHand, packet: view.lastPacket });
  assertEqual(result.ok, true, 'extra provider result run remains fail-soft');
  assert(serialized.includes('Expected provider card'), 'expected provider card remains accepted');
  assert(!serialized.includes('Extra provider result'), 'extra provider result without request metadata is not accepted');
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const cacheAwareMessages = [
    { mesid: 1, role: 'assistant', text: 'The shuttle shudders in the storm.', visible: true },
    { mesid: 2, role: 'user', text: 'Mara braces against the hatch.', visible: true },
    { mesid: 3, role: 'user', text: 'Check cached card relevance.', visible: true }
  ];
  const cacheAwareSourceHash = sourceWindowHash(cacheAwareMessages, 1, 2);
  await storage.saveSceneCache('cache-aware-chat', 'cache-aware-scene', {
    cards: [{
      id: 'cache-aware-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Cached scene card the Arbiter should be able to inspect.',
      summary: 'Cached scene summary',
      tokenEstimate: 12,
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'cache-aware-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: cacheAwareSourceHash,
        snapshotHash: cacheAwareSourceHash
      },
      freshness: { sourceFingerprint: cacheAwareSourceHash }
    }],
    latestHand: {
      handId: 'cache-aware-hand',
      cards: [{ id: 'cache-aware-card', family: 'Scene Frame' }]
    }
  });
  let arbiterPrompt = '';
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'cache-aware-chat',
      chatKey: 'cache-aware-chat',
      sceneKey: 'cache-aware-scene',
      sceneFingerprint: 'cache-aware-scene-fp',
      turnFingerprint: 'cache-aware-turn-fp',
      latestMesId: 3,
      messages: cacheAwareMessages
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'cache-aware test only calls utility arbiter');
        arbiterPrompt = request.prompt;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'reuse-cache',
            lifecycle: [{ action: 'select', cardId: 'cache-aware-card', reason: 'still relevant' }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['cache-aware-plan']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Cache-aware Arbiter.' });
  assertEqual(result.ok, true, 'cache-aware arbiter run installs');
  assert(arbiterPrompt.includes('cache-aware-card'), 'arbiter prompt includes compact scene cache card metadata');
  assert(arbiterPrompt.includes('cache-aware-hand'), 'arbiter prompt includes latest hand metadata');
  assertDeepEqual(runtime.view().lastHand.cards.map((card) => card.id), ['cache-aware-card'], 'cache-aware plan reuses selected cached card');
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const staleMessages = [
    { mesid: 1, role: 'assistant', text: 'The old corridor is no longer reliable.', visible: true },
    { mesid: 2, role: 'user', text: 'The player changed what happened here.', visible: true },
    { mesid: 3, role: 'user', text: 'Try to reuse a stale cache card.', visible: true }
  ];
  await storage.saveSceneCache('stale-cache-chat', 'stale-cache-scene', {
    cards: [{
      id: 'stale-cache-card',
      family: 'Continuity Risk',
      status: 'active',
      promptText: 'Stale cached continuity must not reach the prompt.',
      summary: 'Stale continuity',
      tokenEstimate: 12,
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'stale-cache-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: 'stale-source-fingerprint',
        snapshotHash: 'stale-source-fingerprint'
      },
      freshness: { sourceFingerprint: 'stale-source-fingerprint' }
    }],
    latestHand: {
      handId: 'stale-cache-hand',
      cards: [{ id: 'stale-cache-card', family: 'Continuity Risk' }]
    }
  });
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'stale-cache-chat',
      chatKey: 'stale-cache-chat',
      sceneKey: 'stale-cache-scene',
      sceneFingerprint: 'stale-cache-scene-fp',
      turnFingerprint: 'stale-cache-turn-fp',
      latestMesId: 3,
      messages: staleMessages
    },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'stale cache test only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'reuse-cache',
            lifecycle: [{ action: 'select', cardId: 'stale-cache-card', reason: 'provider thought it was reusable' }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['stale-cache-reuse']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Try to reuse a stale cache card.' });
  const serialized = JSON.stringify({ result, view: runtime.view() });
  assertEqual(result.ok, true, 'stale reuse-cache remains fail-soft');
  assertEqual(result.skipped, true, 'stale reuse-cache is treated as unavailable');
  assertEqual(result.reason, 'cache-unavailable', 'stale reuse-cache returns unavailable reason');
  assertEqual(installed.length, 0, 'stale cache card does not install prompt');
  assert(!serialized.includes('Stale cached continuity must not reach the prompt'), 'stale cache prompt text is not exposed');
}

{
  const fullHashBypassMessages = [
    { mesid: 1, role: 'assistant', text: 'Old source window.', visible: true },
    { mesid: 2, role: 'user', text: 'User source window.', visible: true },
    { mesid: 3, role: 'user', text: 'Reject full snapshot hash bypass.', visible: true }
  ];
  const snapshot = {
    chatId: 'full-hash-cache-chat',
    chatKey: 'full-hash-cache-chat',
    sceneKey: 'full-hash-cache-scene',
    sceneFingerprint: 'full-hash-cache-scene-fp',
    turnFingerprint: 'full-hash-cache-turn-fp',
    latestMesId: 3,
    messages: fullHashBypassMessages
  };
  await assertSingleCachedCardUnavailable({
    label: 'full-snapshot-hash-cache',
    userMessage: 'Reject full snapshot hash bypass.',
    snapshot,
    card: {
      id: 'full-hash-cache-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Full snapshot hash must not validate stale source window.',
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'full-hash-cache-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: runtimeSnapshotHash(snapshot),
        snapshotHash: runtimeSnapshotHash(snapshot)
      },
      freshness: { sourceFingerprint: runtimeSnapshotHash(snapshot) }
    }
  });
}

{
  const missingRangeMessages = [
    { mesid: 1, role: 'assistant', text: 'Message one.', visible: true },
    { mesid: 2, role: 'user', text: 'Reject missing source range.', visible: true }
  ];
  const snapshot = {
    chatId: 'missing-range-cache-chat',
    chatKey: 'missing-range-cache-chat',
    sceneKey: 'missing-range-cache-scene',
    sceneFingerprint: 'missing-range-cache-scene-fp',
    turnFingerprint: 'missing-range-cache-turn-fp',
    latestMesId: 2,
    messages: missingRangeMessages
  };
  await assertSingleCachedCardUnavailable({
    label: 'missing-source-range-cache',
    userMessage: 'Reject missing source range.',
    snapshot,
    card: {
      id: 'missing-range-cache-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Missing source range must not be inferred from current snapshot.',
      source: {
        chatId: 'missing-range-cache-chat',
        fingerprint: runtimeSnapshotHash(snapshot),
        snapshotHash: runtimeSnapshotHash(snapshot)
      },
      freshness: { sourceFingerprint: runtimeSnapshotHash(snapshot) }
    }
  });
}

{
  const gappedRangeMessages = [
    { mesid: 1, role: 'assistant', text: 'Visible endpoint one.', visible: true },
    { mesid: 3, role: 'user', text: 'Reject gapped source range.', visible: true }
  ];
  const sourceHash = sourceWindowHash(gappedRangeMessages, 1, 3);
  await assertSingleCachedCardUnavailable({
    label: 'gapped-source-range-cache',
    userMessage: 'Reject gapped source range.',
    snapshot: {
      chatId: 'gapped-cache-chat',
      chatKey: 'gapped-cache-chat',
      sceneKey: 'gapped-cache-scene',
      sceneFingerprint: 'gapped-cache-scene-fp',
      turnFingerprint: 'gapped-cache-turn-fp',
      latestMesId: 3,
      messages: gappedRangeMessages
    },
    card: {
      id: 'gapped-cache-card',
      family: 'Continuity Risk',
      status: 'active',
      promptText: 'Gapped source range must not be reused.',
      evidenceRefs: ['message:3'],
      source: {
        chatId: 'gapped-cache-chat',
        firstMesId: 1,
        lastMesId: 3,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const malformedEvidenceMessages = [
    { mesid: 1, role: 'assistant', text: 'Valid source start.', visible: true },
    { mesid: 2, role: 'user', text: 'Reject malformed evidence ref.', visible: true },
    { mesid: 4, role: 'assistant', text: 'Outside evidence target.', visible: true }
  ];
  const sourceHash = sourceWindowHash(malformedEvidenceMessages, 1, 2);
  await assertSingleCachedCardUnavailable({
    label: 'malformed-evidence-cache',
    userMessage: 'Reject malformed evidence ref.',
    snapshot: {
      chatId: 'malformed-evidence-chat',
      chatKey: 'malformed-evidence-chat',
      sceneKey: 'malformed-evidence-scene',
      sceneFingerprint: 'malformed-evidence-scene-fp',
      turnFingerprint: 'malformed-evidence-turn-fp',
      latestMesId: 4,
      messages: malformedEvidenceMessages
    },
    card: {
      id: 'malformed-evidence-card',
      family: 'Continuity Risk',
      status: 'active',
      promptText: 'Malformed evidence ref outside source range must not be ignored.',
      evidenceRefs: ['message:4 stale suffix'],
      source: {
        chatId: 'malformed-evidence-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const chatMismatchMessages = [
    { mesid: 1, role: 'assistant', text: 'Reject wrong chat source.', visible: true },
    { mesid: 2, role: 'user', text: 'Source chat mismatch.', visible: true }
  ];
  const sourceHash = sourceWindowHash(chatMismatchMessages, 1, 2);
  await assertSingleCachedCardUnavailable({
    label: 'source-chat-mismatch-cache',
    userMessage: 'Reject source chat mismatch.',
    snapshot: {
      chatId: 'current-cache-chat',
      chatKey: 'current-cache-chat',
      sceneKey: 'current-cache-scene',
      sceneFingerprint: 'current-cache-scene-fp',
      turnFingerprint: 'current-cache-turn-fp',
      latestMesId: 2,
      messages: chatMismatchMessages
    },
    card: {
      id: 'chat-mismatch-cache-card',
      family: 'Continuity Risk',
      status: 'active',
      promptText: 'Wrong chat cache card must not be reused.',
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'other-cache-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const futureRangeMessages = [
    { mesid: 1, role: 'assistant', text: 'Known source start.', visible: true },
    { mesid: 2, role: 'user', text: 'Reject future source range.', visible: true }
  ];
  const sourceHash = sourceWindowHash(futureRangeMessages, 1, 3);
  await assertSingleCachedCardUnavailable({
    label: 'future-source-range-cache',
    userMessage: 'Reject future source range.',
    snapshot: {
      chatId: 'future-cache-chat',
      chatKey: 'future-cache-chat',
      sceneKey: 'future-cache-scene',
      sceneFingerprint: 'future-cache-scene-fp',
      turnFingerprint: 'future-cache-turn-fp',
      latestMesId: 2,
      messages: futureRangeMessages
    },
    card: {
      id: 'future-range-cache-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Future source range must not be reused.',
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'future-cache-chat',
        firstMesId: 1,
        lastMesId: 3,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const hiddenRangeMessages = [
    { mesid: 1, role: 'assistant', text: 'Visible range start.', visible: true },
    { mesid: 2, role: 'assistant', text: 'Hidden middle source.', visible: false },
    { mesid: 3, role: 'user', text: 'Reject hidden source range.', visible: true }
  ];
  const sourceHash = sourceWindowHash(hiddenRangeMessages, 1, 3);
  await assertSingleCachedCardUnavailable({
    label: 'hidden-source-range-cache',
    userMessage: 'Reject hidden source range.',
    snapshot: {
      chatId: 'hidden-range-chat',
      chatKey: 'hidden-range-chat',
      sceneKey: 'hidden-range-scene',
      sceneFingerprint: 'hidden-range-scene-fp',
      turnFingerprint: 'hidden-range-turn-fp',
      latestMesId: 3,
      messages: hiddenRangeMessages
    },
    card: {
      id: 'hidden-range-cache-card',
      family: 'Continuity Risk',
      status: 'active',
      promptText: 'Hidden source range must not be reused.',
      evidenceRefs: ['message:3'],
      source: {
        chatId: 'hidden-range-chat',
        firstMesId: 1,
        lastMesId: 3,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const expiredMessages = [
    { mesid: 1, role: 'assistant', text: 'Expired card source.', visible: true },
    { mesid: 2, role: 'user', text: 'Still in source window.', visible: true },
    { mesid: 3, role: 'user', text: 'Reject expired source freshness.', visible: true }
  ];
  const sourceHash = sourceWindowHash(expiredMessages, 1, 2);
  await assertSingleCachedCardUnavailable({
    label: 'expired-cache-card',
    userMessage: 'Reject expired cached card.',
    snapshot: {
      chatId: 'expired-cache-chat',
      chatKey: 'expired-cache-chat',
      sceneKey: 'expired-cache-scene',
      sceneFingerprint: 'expired-cache-scene-fp',
      turnFingerprint: 'expired-cache-turn-fp',
      latestMesId: 3,
      messages: expiredMessages
    },
    card: {
      id: 'expired-cache-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Expired cache card must not be reused.',
      evidenceRefs: ['message:2'],
      source: {
        chatId: 'expired-cache-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash, expiresAfterMesId: 2 }
    }
  });
}

{
  const missingEvidenceMessages = [
    { mesid: 1, role: 'assistant', text: 'Valid source start.', visible: true },
    { mesid: 2, role: 'user', text: 'Reject missing evidence ref.', visible: true }
  ];
  const sourceHash = sourceWindowHash(missingEvidenceMessages, 1, 2);
  await assertSingleCachedCardUnavailable({
    label: 'missing-evidence-cache',
    userMessage: 'Reject missing evidence ref.',
    snapshot: {
      chatId: 'missing-evidence-chat',
      chatKey: 'missing-evidence-chat',
      sceneKey: 'missing-evidence-scene',
      sceneFingerprint: 'missing-evidence-scene-fp',
      turnFingerprint: 'missing-evidence-turn-fp',
      latestMesId: 2,
      messages: missingEvidenceMessages
    },
    card: {
      id: 'missing-evidence-card',
      family: 'Continuity Risk',
      status: 'active',
      promptText: 'Missing evidence ref must not be ignored.',
      evidenceRefs: ['message:4'],
      source: {
        chatId: 'missing-evidence-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const unparseableEvidenceMessages = [
    { mesid: 1, role: 'assistant', text: 'Valid source start.', visible: true },
    { mesid: 2, role: 'user', text: 'Reject unparseable evidence refs.', visible: true }
  ];
  const sourceHash = sourceWindowHash(unparseableEvidenceMessages, 1, 2);
  await assertSingleCachedCardUnavailable({
    label: 'unparseable-evidence-cache',
    userMessage: 'Reject unparseable evidence refs.',
    snapshot: {
      chatId: 'unparseable-evidence-chat',
      chatKey: 'unparseable-evidence-chat',
      sceneKey: 'unparseable-evidence-scene',
      sceneFingerprint: 'unparseable-evidence-scene-fp',
      turnFingerprint: 'unparseable-evidence-turn-fp',
      latestMesId: 2,
      messages: unparseableEvidenceMessages
    },
    card: {
      id: 'unparseable-evidence-card',
      family: 'Continuity Risk',
      status: 'active',
      promptText: 'Unparseable evidence ref must not be ignored.',
      evidenceRefs: ['turn:2'],
      source: {
        chatId: 'unparseable-evidence-chat',
        firstMesId: 1,
        lastMesId: 2,
        fingerprint: sourceHash,
        snapshotHash: sourceHash
      },
      freshness: { sourceFingerprint: sourceHash }
    }
  });
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache('hostile-cache-chat', 'hostile-cache-scene', {
    cards: [{
      id: 'Bearer cache-card-token',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Prompt text raw-host-metadata-should-not-leak with Bearer cache-prompt-token.',
      evidenceRefs: ['message:2 raw-evidence-metadata-should-not-leak Bearer cache-evidence-token'],
      source: {
        chatId: 'hostile-cache-chat',
        firstMesId: 1,
        lastMesId: 2,
        snapshotHash: 'raw-source-metadata-should-not-leak'
      },
      freshness: {
        sourceFingerprint: 'raw-freshness-metadata-should-not-leak'
      }
    }],
    latestHand: {
      handId: 'Bearer cache-hand-token',
      cards: [{ id: 'Bearer cache-card-token' }]
    }
  });
  let arbiterPrompt = '';
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'hostile-cache-chat',
      chatKey: 'hostile-cache-chat',
      sceneKey: 'hostile-cache-scene',
      sceneFingerprint: 'hostile-cache-scene-fp',
      turnFingerprint: 'hostile-cache-turn-fp',
      latestMesId: 3,
      messages: [{ mesid: 3, role: 'user', text: 'Do not leak hostile cache metadata.', visible: true }]
    },
    generationRouter: {
      async generate(roleId, request) {
        assertEqual(roleId, 'utilityArbiter', 'hostile cache safety test only calls utility arbiter');
        arbiterPrompt = request.prompt;
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'skip',
            diagnostics: ['hostile-cache-safety']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Hostile cache safety.' });
  assertEqual(result.ok, true, 'hostile cache safety run skips safely');
  const sceneCache = parsePromptJsonSection(arbiterPrompt, 'Scene cache');
  const serializedPrompt = JSON.stringify({ prompt: arbiterPrompt, sceneCache });
  assert(!serializedPrompt.includes('raw-host-metadata-should-not-leak'), 'arbiter cache view omits raw cached prompt text');
  assert(!serializedPrompt.includes('raw-evidence-metadata-should-not-leak'), 'arbiter cache view omits raw cached evidence metadata');
  assert(!serializedPrompt.includes('raw-source-metadata-should-not-leak'), 'arbiter cache view omits raw cached source fingerprint text');
  assert(!serializedPrompt.includes('raw-freshness-metadata-should-not-leak'), 'arbiter cache view omits raw cached freshness fingerprint text');
  assertNoSecretText(serializedPrompt, 'arbiter hostile cache prompt');
  assert(sceneCache.cards.length === 1, 'arbiter cache view keeps valid sanitized card metadata');
  assert(sceneCache.cards[0].source.fingerprint.startsWith('hash:'), 'arbiter cache view hashes source fingerprints');
}

{
  let batchCalled = false;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'invalid schema test only asks Utility Arbiter');
        return {
          ok: true,
          data: {
            schema: 'wrong.schema.v1',
            cardJobs: [{ family: 'Open Threads', reason: 'This invalid plan must not run.' }],
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['invalid-schema-plan']
          }
        };
      },
      async batch() {
        batchCalled = true;
        return [];
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Invalid schema fallback.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'invalid arbiter schema falls back fail-soft');
  assertEqual(batchCalled, false, 'invalid arbiter schema does not execute provider card jobs');
  assert(view.lastPlan.diagnostics.includes('utility-arbiter-fallback'), 'invalid arbiter schema records fallback diagnostic');
  assert(view.lastHand.cards.some((card) => card.family === 'Scene Frame'), 'invalid arbiter schema uses local fallback scene card');
  assert(!view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'invalid arbiter schema ignores untrusted provider card jobs');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            diagnostics: ['missing-schema-plan'],
            authorization: 'Bearer missing-schema-token'
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Missing schema fallback.' });
  const serialized = JSON.stringify({ result, view: runtime.view() });
  assertEqual(result.ok, true, 'missing arbiter schema falls back fail-soft');
  assert(runtime.view().lastPlan.diagnostics.includes('utility-arbiter-fallback'), 'missing arbiter schema records fallback diagnostic');
  assert(!serialized.includes('Bearer missing-schema-token'), 'missing schema fallback does not leak rejected provider fields');
  assertNoSecretText(serialized, 'missing schema fallback');
}

{
  const reuseCacheMessages = [
    { mesid: 2, role: 'user', text: 'Reuse cached card.', visible: true }
  ];
  const reuseCacheSourceHash = sourceWindowHash(reuseCacheMessages, 2, 2);
  const storage = {
    async loadSceneCache() {
      return {
        cards: [{
          id: 'sk-live-card-id',
          family: 'Scene Frame',
          promptText: 'Cached card with Bearer cache-token, sk-cache-runtime, and private-secret must be scrubbed.',
          summary: 'Cached summary with Bearer cache-token.',
          evidenceRefs: ['message:2 sk-cache-runtime'],
          inspectorNotes: 'Cached inspector private-secret',
          emphasis: 'normal',
          source: {
            chatId: 'reuse-cache-chat',
            firstMesId: 2,
            lastMesId: 2,
            fingerprint: reuseCacheSourceHash,
            snapshotHash: reuseCacheSourceHash
          },
          freshness: { sourceFingerprint: reuseCacheSourceHash }
        }]
      };
    },
    async saveSceneCache() {
      throw new Error('reuse-cache should not save scene cache');
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'reuse-cache-chat',
      chatKey: 'reuse-cache-chat',
      sceneKey: 'reuse-cache-scene',
      sceneFingerprint: 'reuse-cache-scene-fp',
      turnFingerprint: 'reuse-cache-turn-fp',
      latestMesId: 2,
      messages: reuseCacheMessages
    },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'reuse-cache',
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['reuse-cache-redaction']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reuse cached card.' });
  assertEqual(result.ok, true, 'reuse-cache card run installs');
  assertNoSecretText({ resultHand: result.hand, viewHand: runtime.view().lastHand }, 'cached hand cards');
}

{
  const storage = {
    async loadSceneCache() {
      return {
        cards: [{ family: 'Bogus Family', promptText: 'bad cached card' }]
      };
    },
    async saveSceneCache() {
      throw new Error('reuse-cache malformed cache should not save');
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'reuse-cache',
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['malformed-cache']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Reuse malformed cached card.' });
  assertEqual(result.ok, true, 'malformed reuse-cache does not throw');
  assertEqual(result.skipped, true, 'malformed reuse-cache is treated as unavailable');
  assertEqual(result.reason, 'cache-unavailable', 'malformed reuse-cache returns unavailable reason');
  assertEqual(installed.length, 0, 'malformed reuse-cache does not install prompt');
}

{
  const providerPrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'provider-chat',
      chatKey: 'provider-chat',
      sceneKey: 'provider-scene',
      sceneFingerprint: 'provider-scene-fp',
      turnFingerprint: 'provider-turn-fp',
      latestMesId: 3,
      messages: [
        {
          mesid: 1,
          role: 'assistant',
          text: 'Invisible message with Bearer hidden-token, sk-hidden-runtime, and private-secret must not leak.',
          visible: false,
          metadata: { note: 'hidden metadata should not leak' }
        },
        {
          mesid: 2,
          role: 'user',
          text: 'Visible request with Bearer live-token, sk-live-runtime, and private-secret should be redacted.',
          visible: true,
          hostMetadata: 'metadata should not leak',
          apiKey: 'sk-message-key',
          nested: { authorization: 'Bearer nested-token' }
        },
        {
          mesid: 3,
          role: 'assistant',
          text: 'Visible response is safe.',
          visible: true,
          rawHostPacket: { note: 'metadata should not leak' }
        }
      ]
    },
    generationRouter: {
      async generate(roleId, request) {
        providerPrompts.push({ roleId, prompt: request.prompt });
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            cardJobs: [{ family: 'Open Threads', reason: 'Check the current thread.' }],
            budgets: { targetBriefTokens: 500, maxCards: 4 },
            diagnostics: ['provider-safe-snapshot']
          }
        };
      },
      async batch(requests) {
        providerPrompts.push(...requests.map((request) => ({ roleId: request.roleId, prompt: request.prompt })));
        return requests.map((request) => ({
          ok: true,
          roleId: request.roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            items: [{
              promptText: 'Keep following the visible request.',
              evidenceRefs: ['message:2'],
              tokenEstimate: 10
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Provider safe snapshot.' });
  assertEqual(result.ok, true, 'provider-safe snapshot run still installs');
  assert(providerPrompts.length >= 2, 'arbiter and card provider prompts captured');
  const serializedPrompts = JSON.stringify(providerPrompts);
  assert(serializedPrompts.includes('Visible request'), 'provider prompts keep visible message text');
  assert(!serializedPrompts.includes('Invisible message'), 'provider prompts omit invisible message text');
  assert(!serializedPrompts.includes('Bearer live-token'), 'provider prompts redact visible bearer token');
  assert(!serializedPrompts.includes('sk-live-runtime'), 'provider prompts redact visible sk token');
  assert(!serializedPrompts.includes('private-secret'), 'provider prompts redact private secret text');
  assert(!serializedPrompts.includes('Bearer hidden-token'), 'provider prompts omit hidden bearer token');
  assert(!serializedPrompts.includes('sk-hidden-runtime'), 'provider prompts omit hidden sk token');
  assert(!serializedPrompts.includes('metadata should not leak'), 'provider prompts omit arbitrary host metadata values');
  assert(!serializedPrompts.includes('hostMetadata'), 'provider prompts omit arbitrary host metadata keys');
  assert(!serializedPrompts.includes('rawHostPacket'), 'provider prompts omit raw host packet keys');
  const serializedView = JSON.stringify(runtime.view());
  assert(!serializedView.includes('Invisible message'), 'runtime view excludes invisible message text');
  assert(!serializedView.includes('metadata should not leak'), 'runtime view excludes arbitrary host metadata values');
  assert(!serializedView.includes('hostMetadata'), 'runtime view excludes arbitrary host metadata keys');
  assert(!serializedView.includes('rawHostPacket'), 'runtime view excludes raw host packet keys');
  assertNoSecretText(runtime.view(), 'runtime view snapshot');
}

{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: {
      chatId: 'fallback-chat',
      chatKey: 'fallback-chat',
      sceneKey: 'fallback-scene',
      sceneFingerprint: 'fallback-scene-fp',
      turnFingerprint: 'fallback-turn-fp',
      latestMesId: 1,
      messages: [{ mesid: 1, role: 'user', text: 'Fallback visible message.', visible: true }]
    },
    generationRouter: {
      async generate(roleId) {
        routerCalls.push(roleId);
        throw new Error('arbiter unavailable');
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Fallback plan.' });
  const view = runtime.view();
  const expectedSnapshotHash = hashJson({
    ...view.lastSnapshot,
    messages: view.lastSnapshot.messages.map((message) => ({
      ...message,
      textHash: hashJson(message.text)
    }))
  });
  assertEqual(result.ok, true, 'arbiter exception falls back without throwing');
  assertEqual(routerCalls.length, 1, 'arbiter attempted once');
  assert(view.lastPlan.diagnostics.includes('local-fallback-plan'), 'local fallback diagnostic retained');
  assert(view.lastPlan.diagnostics.includes('utility-arbiter-fallback'), 'arbiter fallback diagnostic recorded');
  assertEqual(view.lastPlan.snapshotHash, expectedSnapshotHash, 'fallback plan uses normalized snapshot hash');
  assertEqual(view.lastPlan.source.snapshotHash, expectedSnapshotHash, 'fallback source stores normalized snapshot hash');
  assertEqual(view.lastPlan.source.userMessageHash, hashJson('Fallback plan.'), 'fallback source stores user message hash separately');
  assertEqual(view.lastPlan.source.catalogHash, hashJson(CARD_CATALOG), 'fallback source stores catalog hash separately');
  assert(view.lastHand.cards.length > 0, 'fallback still selects hand');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'observe', reasonerUse: 'off' },
    snapshot: {
      messages: null
    }
  });
  const result = await runtime.prepareForGeneration();
  const view = runtime.view();
  assertEqual(result.ok, true, 'missing snapshot fields still prepares');
  assertEqual(view.lastSnapshot.chatId, 'chat', 'missing chat id normalized');
  assertEqual(view.lastSnapshot.chatKey, 'chat', 'missing chat key normalized');
  assertEqual(view.lastSnapshot.sceneKey, 'scene', 'missing scene key normalized');
  assertEqual(view.lastSnapshot.latestMesId, 0, 'missing latest message id normalized');
  assertDeepEqual(view.lastSnapshot.messages, [], 'missing messages normalized to empty array');
  assertEqual(view.lastPacket.chatId, 'chat', 'packet gets normalized chat id');
  assertEqual(view.activeRunId, null, 'active run cleared after normalized observe');
}

{
  const activity = {
    start() {
      throw new Error('start observer failed');
    },
    stage() {
      throw new Error('stage observer failed');
    },
    settle() {
      throw new Error('settle observer failed');
    },
    clear() {
      throw new Error('clear observer failed');
    },
    current() {
      return { phase: 'custom', label: 'observer failed safely' };
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    activity
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Activity throws.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'throwing activity reporter does not crash runtime');
  assertEqual(view.activity.label, 'observer failed safely', 'view still reads activity best-effort');
  assertEqual(view.activeRunId, null, 'active run cleared when activity throws');
}

{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      throw new Error('snapshot failed with Bearer crash-token, sk-crash-runtime, and private-secret');
    }
  });
  let threw = false;
  let caughtError = null;
  try {
    await runtime.prepareForGeneration({ userMessage: 'Crash safely.' });
  } catch (error) {
    threw = true;
    caughtError = error;
  }
  assertEqual(threw, true, 'runtime failure still throws to caller');
  assertNoSecretText(caughtError?.message || caughtError, 'runtime thrown error');
  assertNoSecretText(runtime.view().activity.detail, 'runtime failure activity detail');
}

{
  let releaseFirstLoad;
  const storageOps = [];
  const storage = {
    async loadSceneCache(chatKey) {
      storageOps.push(`load:${chatKey}`);
      if (chatKey === 'run-a') {
        await new Promise((resolve) => {
          releaseFirstLoad = resolve;
        });
      }
      return null;
    },
    async saveSceneCache(chatKey) {
      storageOps.push(`save:${chatKey}`);
      return {};
    },
    async appendJournal(chatKey) {
      storageOps.push(`journal:${chatKey}`);
      return {};
    }
  };
  let snapshotCalls = 0;
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) {
        return {
          chatId: 'run-a',
          chatKey: 'run-a',
          sceneKey: 'scene-a',
          sceneFingerprint: 'scene-a-fp',
          turnFingerprint: 'turn-a-fp',
          latestMesId: 1,
          messages: [{ mesid: 1, role: 'user', text: 'Stale first run text.', visible: true }]
        };
      }
      return {
        chatId: 'run-b',
        chatKey: 'run-b',
        sceneKey: 'scene-b',
        sceneFingerprint: 'scene-b-fp',
        turnFingerprint: 'turn-b-fp',
        latestMesId: 2,
        messages: [{ mesid: 2, role: 'user', text: 'Fresh second run text.', visible: true }]
      };
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'Stale first run text.' });
  await waitUntil(() => typeof releaseFirstLoad === 'function', 'first run did not reach scene cache wait');
  const second = await runtime.prepareForGeneration({ userMessage: 'Fresh second run text.' });
  assertEqual(second.ok, true, 'newer run completes while older run is blocked');
  assertEqual(installed.length, 1, 'newer run installs while older run remains blocked');
  assert(JSON.stringify(installed[0]).includes('Fresh second run text.'), 'newer installed packet uses second snapshot');
  releaseFirstLoad();
  const firstResult = await first;
  assertEqual(firstResult.superseded, true, 'older run reports superseded after newer run completes');
  assertEqual(installed.length, 1, 'older run does not install after newer run starts');
  const view = runtime.view();
  const serializedView = JSON.stringify(view);
  assertEqual(view.lastSnapshot.chatKey, 'run-b', 'older run does not overwrite last snapshot');
  assert(serializedView.includes('Fresh second run text.'), 'view keeps newer run prompt state');
  assert(!serializedView.includes('Stale first run text.'), 'older run does not overwrite prompt packet');
  assert(!storageOps.includes('save:run-a'), 'older run does not save stale scene cache');
  assert(!storageOps.includes('journal:run-a'), 'older run does not append stale journal');
}

{
  let releaseFirstSave;
  let firstSaveStarted = false;
  let snapshotCalls = 0;
  const sideEffects = [];
  const storage = {
    async loadSceneCache() {
      return null;
    },
    async saveSceneCache(chatKey) {
      if (!firstSaveStarted) {
        firstSaveStarted = true;
        await new Promise((resolve) => {
          releaseFirstSave = () => {
            sideEffects.push(`save:${chatKey}`);
            resolve();
          };
        });
        return {};
      }
      sideEffects.push(`save:${chatKey}`);
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: () => {
      snapshotCalls += 1;
      const snapshotRun = snapshotCalls <= 2 ? 1 : 2;
      return {
        chatId: `save-run-${snapshotRun}`,
        chatKey: `save-run-${snapshotRun}`,
        sceneKey: `save-scene-${snapshotRun}`,
        sceneFingerprint: `save-scene-${snapshotRun}`,
        turnFingerprint: `save-turn-${snapshotRun}`,
        latestMesId: snapshotRun,
        messages: [{ mesid: snapshotRun, role: 'user', text: snapshotRun === 1 ? 'Older save packet.' : 'Newer save packet.', visible: true }]
      };
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'Older save packet.' });
  await waitUntil(() => typeof releaseFirstSave === 'function', 'first run did not enter scene cache save');
  const second = runtime.prepareForGeneration({ userMessage: 'Newer save packet.' });
  await Promise.resolve();
  assertEqual(snapshotCalls, 2, 'newer run waits for in-flight scene cache save before snapshot');
  assertEqual(sideEffects.length, 0, 'blocked first save has not committed yet');
  releaseFirstSave();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert(firstResult.ok || firstResult.superseded, 'first save run either completes or is superseded after save commits');
  assertEqual(secondResult.ok, true, 'queued newer run completes after cache save');
  assertDeepEqual(sideEffects, ['save:save-run-1', 'save:save-run-2'], 'scene cache saves commit in run order');
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  const arbiterMessages = [
    { mesid: 1, role: 'assistant', text: 'The continuity risk was established.', visible: true },
    { mesid: 2, role: 'user', text: 'Keep only the risk that matters.', visible: true },
    { mesid: 3, role: 'user', text: 'Use only the Arbiter-selected card.', visible: true }
  ];
  const arbiterSourceHash = sourceWindowHash(arbiterMessages, 1, 2);
  await storage.saveSceneCache('arbiter-chat', 'arbiter-scene', {
    cards: [
      {
        id: 'arbiter-keep',
        family: 'Continuity Risk',
        status: 'active',
        promptText: 'The only selected continuity risk should remain active.',
        summary: 'Keep continuity',
        tokenEstimate: 20,
        evidenceRefs: ['message:2'],
        source: {
          chatId: 'arbiter-chat',
          firstMesId: 1,
          lastMesId: 2,
          fingerprint: arbiterSourceHash,
          snapshotHash: arbiterSourceHash
        },
        freshness: { sourceFingerprint: arbiterSourceHash }
      },
      {
        id: 'arbiter-stow',
        family: 'Scene Frame',
        status: 'active',
        promptText: 'This card should be stowed by the Arbiter.',
        summary: 'Stow scene',
        tokenEstimate: 20,
        evidenceRefs: ['message:2'],
        source: {
          chatId: 'arbiter-chat',
          firstMesId: 1,
          lastMesId: 2,
          fingerprint: arbiterSourceHash,
          snapshotHash: arbiterSourceHash
        },
        freshness: { sourceFingerprint: arbiterSourceHash }
      }
    ]
  });
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'arbiter-chat',
      chatKey: 'arbiter-chat',
      sceneKey: 'arbiter-scene',
      sceneFingerprint: 'arbiter-scene-fp',
      turnFingerprint: 'arbiter-turn-fp',
      latestMesId: 3,
      messages: arbiterMessages
    },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'arbiter lifecycle regression only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'reuse-cache',
            lifecycle: [
              { action: 'select', cardId: 'arbiter-keep', reason: 'still important' },
              { action: 'stow', cardId: 'arbiter-stow', reason: 'not needed this turn' }
            ],
            budgets: { targetBriefTokens: 700, maxCards: 6 },
            diagnostics: ['arbiter-lifecycle-regression']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use only the Arbiter-selected card.' });
  assertEqual(result.ok, true, 'arbiter lifecycle run installs');
  assertDeepEqual(runtime.view().lastHand.cards.map((card) => card.id), ['arbiter-keep'], 'turn hand honors Arbiter select/stow lifecycle');
  const updated = await storage.loadSceneCache('arbiter-chat', 'arbiter-scene');
  assertEqual(updated.cards.find((card) => card.id === 'arbiter-stow')?.status, 'stowed', 'scene deck persists Arbiter stow decision');
}

{
  const adapter = createMemoryStorageAdapter();
  const storage = createStorageRepository({ storage: adapter });
  await storage.saveSceneCache('hard-shift-chat', 'hard-shift-original', {
    cards: [{
      id: 'old-scene-card',
      family: 'Scene Frame',
      status: 'active',
      promptText: 'Original scene cache should only inform planning.',
      summary: 'Original scene',
      source: { chatId: 'hard-shift-chat', firstMesId: 1, lastMesId: 2, snapshotHash: 'old-source' }
    }]
  });
  const snapshot = {
    chatId: 'hard-shift-chat',
    chatKey: 'hard-shift-chat',
    sceneKey: 'hard-shift-original',
    sceneFingerprint: 'hard-shift-original-fp',
    turnFingerprint: 'hard-shift-turn-fp',
    latestMesId: 3,
    messages: [{ mesid: 3, role: 'user', text: 'A new scene begins elsewhere.', visible: true }]
  };
  const shiftedFingerprint = hashJson({
    previousSceneFingerprint: snapshot.sceneFingerprint,
    hardShiftAtMesId: snapshot.latestMesId,
    turnFingerprint: snapshot.turnFingerprint
  });
  const shiftedSceneKey = `${snapshot.chatKey}-${shiftedFingerprint}`;
  const shiftedSourceHash = sourceWindowHash(snapshot.messages, 3, 3);
  await storage.saveSceneCache('hard-shift-chat', shiftedSceneKey, {
    cards: [{
      id: 'new-scene-card',
      family: 'Continuity Risk',
      status: 'active',
      promptText: 'New scene cache should remain available after hard shift.',
      summary: 'New scene continuity',
      evidenceRefs: ['message:3'],
      source: {
        chatId: 'hard-shift-chat',
        firstMesId: 3,
        lastMesId: 3,
        fingerprint: shiftedSourceHash,
        snapshotHash: shiftedSourceHash
      },
      freshness: { sourceFingerprint: shiftedSourceHash }
    }]
  });
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot,
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'hard-shift lifecycle regression only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'compose-brief',
            sceneStatus: 'hard-shift',
            lifecycle: [{ action: 'select', cardId: 'old-scene-card', reason: 'selected from original cache before hard shift' }],
            budgets: { targetBriefTokens: 700, maxCards: 6 },
            diagnostics: ['hard-shift-lifecycle-regression']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'A new scene begins elsewhere.' });
  assertEqual(result.ok, true, 'hard-shift lifecycle run installs');
  assertDeepEqual(runtime.view().lastHand.cards.map((card) => card.id), ['new-scene-card'], 'hard-shift cache survives stale pre-shift lifecycle selection');
  const updated = await storage.loadSceneCache('hard-shift-chat', shiftedSceneKey);
  assertEqual(updated.cards.find((card) => card.id === 'new-scene-card')?.status, 'active', 'hard-shift target cache card remains active');
}

{
  const mixedCacheMessages = [
    { mesid: 2, role: 'user', text: 'Use valid cache despite rejected selection.', visible: true }
  ];
  const mixedCacheSourceHash = sourceWindowHash(mixedCacheMessages, 2, 2);
  const storage = {
    async loadSceneCache() {
      return {
        cards: [
          { id: 'rejected-selected', family: 'Bogus Family', promptText: 'invalid selected card' },
          {
            id: 'valid-cache-card',
            family: 'Scene Frame',
            status: 'active',
            promptText: 'Valid cache card should not be stowed by rejected-card lifecycle.',
            summary: 'Valid cache card',
            evidenceRefs: ['message:2'],
            source: {
              chatId: 'mixed-cache-chat',
              firstMesId: 2,
              lastMesId: 2,
              fingerprint: mixedCacheSourceHash,
              snapshotHash: mixedCacheSourceHash
            },
            freshness: { sourceFingerprint: mixedCacheSourceHash }
          }
        ]
      };
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: {
      chatId: 'mixed-cache-chat',
      chatKey: 'mixed-cache-chat',
      sceneKey: 'mixed-cache-scene',
      sceneFingerprint: 'mixed-cache-scene-fp',
      turnFingerprint: 'mixed-cache-turn-fp',
      latestMesId: 2,
      messages: mixedCacheMessages
    },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'mixed cache lifecycle regression only calls utility arbiter');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'compose-brief',
            lifecycle: [{ action: 'select', cardId: 'rejected-selected', reason: 'malformed card was selected before validation' }],
            budgets: { targetBriefTokens: 700, maxCards: 6 },
            diagnostics: ['mixed-cache-lifecycle-regression']
          }
        };
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Use valid cache despite rejected selection.' });
  assertEqual(result.ok, true, 'mixed cache lifecycle run installs');
  assertDeepEqual(runtime.view().lastHand.cards.map((card) => card.id), ['valid-cache-card'], 'valid cache card survives lifecycle for rejected card id');
}

{
  let utilityCalls = 0;
  let firstGenerateStarted = false;
  let firstAbortObserved = false;
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'provider supersession test only calls utility arbiter');
        utilityCalls += 1;
        if (utilityCalls === 1) {
          firstGenerateStarted = true;
          if (request.signal) {
            request.signal.addEventListener('abort', () => {
              firstAbortObserved = true;
            }, { once: true });
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            ok: false,
            error: { code: 'FIRST_NOT_ABORTED', message: 'first provider call was not aborted' }
          };
        }
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'skip',
            diagnostics: ['newer-run-superseded-provider']
          }
        };
      }
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'first provider call' });
  await waitUntil(() => firstGenerateStarted, 'first run did not enter provider call');
  const second = await runtime.prepareForGeneration({ userMessage: 'second provider call' });
  assertEqual(second.ok, true, 'newer run completes while older provider call is blocked');
  const firstResult = await first;
  assertEqual(firstResult.superseded, true, 'older provider run reports superseded');
  assertEqual(firstAbortObserved, true, 'blocked provider call observes abort when superseded');
}

{
  let releaseArbiter;
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'dispose regression only needs utility arbiter');
        await new Promise((resolve) => {
          releaseArbiter = resolve;
        });
        assertEqual(request.signal?.aborted, true, 'dispose aborts in-flight provider signal');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'compose-brief',
            diagnostics: ['dispose-regression']
          }
        };
      }
    }
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Dispose before install.' });
  await waitUntil(() => typeof releaseArbiter === 'function', 'dispose run did not enter arbiter');
  assertEqual(typeof runtime.dispose, 'function', 'runtime exposes dispose for extension teardown');
  await runtime.dispose();
  releaseArbiter();
  const result = await pending;
  assertEqual(result.superseded, true, 'disposed run reports superseded');
  assertEqual(installed.length, 0, 'disposed run cannot install a prompt');
  assertEqual(runtime.view().activeRunId, null, 'dispose clears active run id');
}

{
  let releaseArbiter;
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'off-mode regression only needs utility arbiter');
        await new Promise((resolve) => {
          releaseArbiter = resolve;
        });
        assertEqual(request.signal?.aborted, true, 'switching to Off aborts in-flight provider signal');
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            action: 'compose-brief',
            diagnostics: ['off-mode-regression']
          }
        };
      }
    }
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Turn off before install.' });
  await waitUntil(() => typeof releaseArbiter === 'function', 'off-mode run did not enter arbiter');
  const offUpdate = runtime.updateSettings({ mode: 'off' });
  releaseArbiter();
  const result = await pending;
  assertEqual(result.superseded, true, 'Off mode change supersedes in-flight generation preparation');
  assertEqual(installed.length, 0, 'Off mode change prevents stale prompt install');
  assertEqual(runtime.view().activeRunId, null, 'Off mode change clears active run id');
  await offUpdate;
}

{
  let releaseFirstClear;
  let firstClearStarted = false;
  let snapshotCalls = 0;
  const sideEffects = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotCalls += 1;
      const snapshotRun = snapshotCalls === 1 ? 1 : 2;
      return {
        chatId: `clear-run-${snapshotRun}`,
        chatKey: `clear-run-${snapshotRun}`,
        sceneKey: `clear-scene-${snapshotRun}`,
        sceneFingerprint: `clear-scene-${snapshotRun}`,
        turnFingerprint: `clear-turn-${snapshotRun}`,
        latestMesId: snapshotRun,
        messages: [{ mesid: snapshotRun, role: 'user', text: snapshotRun === 1 ? 'Older clear packet.' : 'Newer install after clear.', visible: true }]
      };
    },
    hostPrompt: {
      async clear() {
        if (!firstClearStarted) {
          firstClearStarted = true;
          await new Promise((resolve) => {
            releaseFirstClear = () => {
              sideEffects.push('clear:first');
              resolve();
            };
          });
          return { ok: true, cleared: true };
        }
        sideEffects.push('clear:next');
        return { ok: true, cleared: true };
      },
      async install(packet) {
        sideEffects.push(`install:${JSON.stringify(packet).includes('Newer install after clear.') ? 'newer' : 'older'}`);
        return { ok: true };
      }
    },
    generationRouter: {
      async generate() {
        if (snapshotCalls === 1) {
          return { ok: true, data: { schema: UTILITY_ARBITER_SCHEMA, action: 'skip', diagnostics: ['older-clear'] } };
        }
        return { ok: true, data: { schema: UTILITY_ARBITER_SCHEMA, action: 'compose-brief', diagnostics: ['newer-install'] } };
      }
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'Older clear packet.' });
  await waitUntil(() => typeof releaseFirstClear === 'function', 'first run did not enter prompt clear');
  const second = runtime.prepareForGeneration({ userMessage: 'Newer install after clear.' });
  await Promise.resolve();
  assertEqual(snapshotCalls, 1, 'newer run waits for in-flight prompt clear before snapshot');
  assertDeepEqual(sideEffects, [], 'blocked clear has not produced host side effect yet');
  releaseFirstClear();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assertEqual(firstResult.skipped, true, 'older clear run remains skipped');
  assertEqual(secondResult.ok, true, 'newer install run completes after prompt clear');
  assertDeepEqual(sideEffects, ['clear:first', 'install:newer'], 'prompt clear completes before newer install');
}

{
  let releaseFirstInstall;
  let firstInstallStarted = false;
  let snapshotCalls = 0;
  const sideEffects = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    snapshot: () => {
      snapshotCalls += 1;
      const snapshotRun = snapshotCalls <= 3 ? 1 : 2;
      return {
        chatId: `install-run-${snapshotRun}`,
        chatKey: `install-run-${snapshotRun}`,
        sceneKey: `install-scene-${snapshotRun}`,
        sceneFingerprint: `install-scene-${snapshotRun}`,
        turnFingerprint: `install-turn-${snapshotRun}`,
        latestMesId: snapshotRun,
        messages: [{ mesid: snapshotRun, role: 'user', text: snapshotRun === 1 ? 'Older install packet.' : 'Newer install packet.', visible: true }]
      };
    },
    hostPrompt: {
      async install(packet) {
        const serialized = JSON.stringify(packet);
        if (!firstInstallStarted) {
          firstInstallStarted = true;
          await new Promise((resolve) => {
            releaseFirstInstall = () => {
              sideEffects.push(serialized);
              resolve();
            };
          });
          return { ok: true };
        }
        sideEffects.push(serialized);
        return { ok: true };
      }
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'Older install packet.' });
  await waitUntil(() => typeof releaseFirstInstall === 'function', 'first run did not enter prompt install');
  const second = runtime.prepareForGeneration({ userMessage: 'Newer install packet.' });
  await Promise.resolve();
  assertEqual(snapshotCalls, 3, 'newer run waits for in-flight prompt install before snapshot');
  assertEqual(sideEffects.length, 0, 'blocked first install has not produced host side effect yet');
  releaseFirstInstall();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assertEqual(firstResult.ok, true, 'first install completes before queued newer run starts');
  assertEqual(secondResult.ok, true, 'queued newer run completes');
  assertEqual(sideEffects.length, 2, 'both installs complete in serialized order');
  assert(sideEffects[0].includes('Older install packet.'), 'older install finishes first');
  assert(sideEffects[1].includes('Newer install packet.'), 'newer install overwrites after older install');
}

{
  let loadCalls = 0;
  let releaseFirstLoad;
  let releaseSecondLoad;
  const deferredStorage = {
    async loadSceneCache() {
      loadCalls += 1;
      if (loadCalls === 1) {
        await new Promise((resolve) => {
          releaseFirstLoad = resolve;
        });
      } else if (loadCalls === 2) {
        await new Promise((resolve) => {
          releaseSecondLoad = resolve;
        });
      }
      return null;
    },
    async saveSceneCache() {
      return {};
    },
    async appendJournal() {
      return {};
    }
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'observe', reasonerUse: 'off' },
    storage: deferredStorage,
    snapshot: () => ({
      chatId: 'concurrent-chat',
      chatKey: 'concurrent-chat',
      sceneKey: 'concurrent-scene',
      sceneFingerprint: 'concurrent-scene',
      turnFingerprint: `turn-${Date.now()}`,
      latestMesId: 1,
      messages: [{ mesid: 1, role: 'user', text: 'Concurrent run.', visible: true }]
    })
  });
  const first = runtime.prepareForGeneration({ userMessage: 'first' });
  await waitUntil(() => typeof releaseFirstLoad === 'function', 'first run did not reach storage wait');
  const second = runtime.prepareForGeneration({ userMessage: 'second' });
  await waitUntil(() => typeof releaseSecondLoad === 'function', 'second run did not reach storage wait');
  const activeWithSecondBlocked = runtime.view().activeRunId;
  assert(activeWithSecondBlocked, 'overlapping run exposes active run id');
  releaseFirstLoad();
  await first;
  assertEqual(runtime.view().activeRunId, activeWithSecondBlocked, 'older run completion does not clear newer active run');
  releaseSecondLoad();
  await second;
  assertEqual(runtime.view().activeRunId, null, 'active run cleared after overlapping runs finish');
}

{
  const arbiterPrompts = [];
  const { runtime, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request = {}) {
        assertEqual(roleId, 'utilityArbiter', 'manual refresh only calls utility arbiter');
        arbiterPrompts.push(request.prompt);
        return {
          ok: true,
          data: {
            schema: UTILITY_ARBITER_SCHEMA,
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
    }
  });
  const setup = await runtime.prepareForGeneration({ userMessage: 'Prepare cache before manual refresh.' });
  assertEqual(setup.ok, true, 'manual refresh setup prepares generation');
  const setupSnapshot = runtime.view().lastSnapshot;
  const result = await runtime.refreshScene();
  assertEqual(result.ok, true, 'manual refresh prepares generation');
  assertEqual(installed.length, 2, 'manual refresh installs prompt in auto mode');
  assert(arbiterPrompts[1].includes('"cacheState":"stale"'), 'manual refresh Arbiter prompt sees stale prior cache');
  assert(arbiterPrompts[1].includes('"reason":"user-refresh"'), 'manual refresh Arbiter prompt sees invalidation reason');
  const refreshedSnapshot = parsePromptJsonSection(arbiterPrompts[1], 'Snapshot');
  assert(!refreshedSnapshot.messages.some((message) => message.text === 'manual refresh'), 'manual refresh does not inject synthetic chat text');
  const journal = await storage.loadRunJournal(setupSnapshot.chatKey);
  assert(journal.entries.some((entry) => entry.event === 'cache.invalidated' && entry.details?.reason === 'user-refresh'), 'manual refresh records cache invalidation journal');
  assertEqual(runtime.view().activeRunId, null, 'active run cleared after refresh');
}

{
  const adapter = createMemoryStorageAdapter();
  const repository = createStorageRepository({ storage: adapter });
  let releaseRefreshInvalidation;
  let refreshInvalidationStarted = false;
  let snapshotReads = 0;
  const storage = {
    async loadSceneCache(...args) {
      return repository.loadSceneCache(...args);
    },
    async saveSceneCache(...args) {
      return repository.saveSceneCache(...args);
    },
    async appendJournal(...args) {
      return repository.appendJournal(...args);
    },
    async loadRunJournal(...args) {
      return repository.loadRunJournal(...args);
    },
    async invalidateSceneCache(...args) {
      refreshInvalidationStarted = true;
      await new Promise((resolve) => {
        releaseRefreshInvalidation = resolve;
      });
      return repository.invalidateSceneCache(...args);
    }
  };
  let currentTurn = {
    chatId: 'refresh-race-chat',
    chatKey: 'refresh-race-chat',
    sceneKey: 'refresh-race-scene',
    sceneFingerprint: 'refresh-race-scene',
    turnFingerprint: 'refresh-race-turn-initial',
    latestMesId: 1,
    messages: [{ mesid: 1, role: 'user', text: 'Refresh race initial.', visible: true }]
  };
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    storage,
    snapshot: () => {
      snapshotReads += 1;
      return currentTurn;
    }
  });
  const setup = await runtime.prepareForGeneration({ userMessage: 'Create cache before refresh race.' });
  assertEqual(setup.ok, true, 'refresh race setup installs');
  const refresh = runtime.refreshScene();
  await waitUntil(() => refreshInvalidationStarted, 'refresh invalidation did not start');
  const snapshotReadsBeforeFollowup = snapshotReads;
  currentTurn = {
    chatId: 'refresh-race-chat',
    chatKey: 'refresh-race-chat',
    sceneKey: 'refresh-race-scene',
    sceneFingerprint: 'refresh-race-scene',
    turnFingerprint: 'refresh-race-turn-followup',
    latestMesId: 10,
    messages: [{ mesid: 10, role: 'user', text: 'Refresh race followup base.', visible: true }]
  };
  const followup = runtime.prepareForGeneration({ userMessage: 'Newer turn after refresh.' });
  await Promise.resolve();
  assertEqual(snapshotReads, snapshotReadsBeforeFollowup, 'newer run waits for refresh invalidation storage tail before snapshot');
  releaseRefreshInvalidation();
  const [refreshResult, followupResult] = await Promise.all([refresh, followup]);
  assert(refreshResult.ok || refreshResult.superseded, 'refresh race run resolves');
  assertEqual(followupResult.ok, true, 'newer run completes after refresh invalidation');
  assertEqual(followupResult.skipped, undefined, 'newer run does not skip after refresh invalidation');
  const finalSnapshot = runtime.view().lastSnapshot;
  const cache = await repository.loadSceneCache(finalSnapshot.chatKey, finalSnapshot.sceneKey);
  assertEqual(cache.cacheState, 'active', 'newer run active cache survives delayed refresh invalidation');
}

{
  const routerCalls = [];
  const { runtime, settingsStore } = createRuntimeHarness({
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push({ roleId, request });
        return {
          ok: true,
          diagnostics: { providerId: 'host-current-model', model: 'utility-test-model' },
          data: { schema: 'recursion.providerTest.v1', ok: true }
        };
      }
    }
  });

  const updated = await runtime.updateSettings({
    mode: 'auto',
    strength: 'strong',
    promptFootprint: 'rich',
    focus: 'character',
    reasonerUse: 'always'
  });
  assertEqual(updated.ok, true, 'runtime exposes successful high-level settings update');
  assertEqual(updated.settings.mode, 'auto', 'runtime exposes high-level settings update');
  assertEqual(updated.settings.strength, 'strong', 'runtime settings update preserves strength');
  assertEqual(runtime.view().settings.focus, 'character', 'settings update is visible in runtime view');

  const utilityResult = await runtime.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-runtime-secret',
    openAICompatible: { baseUrl: 'https://example.test/v1', model: 'utility-model' },
    temperature: 0.2,
    topP: 0.8,
    maxTokens: 2048
  });
  assertEqual(utilityResult.ok, true, 'runtime provider update returns success result');
  assertEqual(utilityResult.clear.ok, true, 'runtime provider update returns prompt clear result');
  const utility = utilityResult.provider;
  assertEqual(utility.openAICompatible.sessionApiKeyPresent, true, 'runtime provider update accepts session key');
  assertEqual(settingsStore.getApiKey('utility'), 'sk-runtime-secret', 'runtime provider update stores key in session store');
  assert(!JSON.stringify(settingsStore.get()).includes('sk-runtime-secret'), 'runtime provider update does not persist api key');
  const viewProvider = runtime.view().settings.providers.utility;
  assertEqual(viewProvider.openAICompatible.baseUrl, 'https://example.test/v1', 'runtime view exposes safe provider base URL for UI round-trip');
  assertEqual(viewProvider.openAICompatible.model, 'utility-model', 'runtime view exposes safe provider model for UI round-trip');
  assertEqual(viewProvider.openAICompatible.sessionApiKeyPresent, true, 'runtime view exposes safe session key presence flag');
  assertEqual(viewProvider.temperature, 0.2, 'runtime view exposes provider temperature for UI round-trip');
  assertEqual(viewProvider.topP, 0.8, 'runtime view exposes provider topP for UI round-trip');
  assertEqual(viewProvider.maxTokens, 2048, 'runtime view exposes provider maxTokens for UI round-trip');
  assertNoSecretText(runtime.view().settings, 'runtime provider settings view');

  const providerTest = await runtime.testProvider('utility');
  assertEqual(providerTest.ok, true, 'runtime provider test returns success result');
  assertEqual(routerCalls[0].roleId, 'providerTest', 'runtime provider test uses providerTest role');
  assertEqual(routerCalls[0].request.lane, 'utility', 'runtime provider test targets selected lane');
  assertEqual(settingsStore.get().providers.utility.lastTest.status, 'pass', 'runtime provider test records passing provider status');
  assertEqual(settingsStore.get().providers.utility.resolvedModelLabel, 'utility-test-model', 'runtime provider test records resolved model');

  const cleared = await runtime.clearProviderKey('utility');
  assertEqual(cleared.ok, true, 'runtime provider key clear returns success result');
  assertEqual(cleared.clear.ok, true, 'runtime provider key clear returns prompt clear result');
  assertEqual(cleared.provider.openAICompatible.sessionApiKeyPresent, false, 'runtime can clear provider session key');
  assertEqual(settingsStore.getApiKey('utility'), '', 'runtime provider key clear removes session secret');
}

{
  const { runtime, settingsStore } = createRuntimeHarness({
    settings: { reasonerUse: 'always', providers: { reasoner: { enabled: true } } },
    generationRouter: {
      async generate() {
        return {
          ok: false,
          error: {
            code: 'RECURSION_PROVIDER_KEY_MISSING',
            message: 'Bearer sk-runtime-secret should not leak'
          }
        };
      }
    }
  });

  const failed = await runtime.testProvider('reasoner');
  assertEqual(failed.ok, false, 'runtime provider test returns failure result');
  const reasoner = settingsStore.get().providers.reasoner;
  assertEqual(reasoner.lastTest.status, 'fail', 'runtime provider test records failing provider status');
  assertNoSecretText(reasoner.lastTest, 'provider test failure status');
}

{
  const { runtime, settingsStore } = createRuntimeHarness({
    settings: {
      providers: {
        utility: {
          resolvedProviderLabel: 'stale-provider',
          resolvedModelLabel: 'stale-model'
        }
      }
    },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          diagnostics: { providerId: 'unsafe-provider', model: 'unsafe-model' },
          data: {
            schema: 'wrong.providerTest.schema',
            ok: true,
            detail: 'Bearer invalid-provider-token and sk-invalid-provider'
          }
        };
      }
    }
  });

  const invalid = await runtime.testProvider('utility');
  assertEqual(invalid.ok, false, 'runtime provider test rejects invalid success schema');
  assertEqual(invalid.error.code, 'RECURSION_PROVIDER_TEST_INVALID', 'invalid provider test returns stable error code');
  const utility = settingsStore.get().providers.utility;
  assertEqual(utility.lastTest.status, 'fail', 'invalid provider test records failing status');
  assertEqual(utility.resolvedProviderLabel, '', 'invalid provider test clears stale provider label');
  assertEqual(utility.resolvedModelLabel, '', 'invalid provider test does not record resolved model');
  assertNoSecretText(utility.lastTest, 'invalid provider test status');
  assertNoSecretText(invalid, 'invalid provider test result');
}

{
  const { runtime, settingsStore } = createRuntimeHarness({
    settings: {
      providers: {
        utility: {
          resolvedProviderLabel: 'stale-provider',
          resolvedModelLabel: 'stale-model'
        }
      }
    },
    generationRouter: {
      async generate() {
        return {
          ok: true,
          diagnostics: { providerId: 'unsafe-provider', model: 'unsafe-model' },
          data: {
            schema: 'recursion.providerTest.v1',
            ok: false,
            message: 'Bearer false-provider-token and sk-false-provider'
          }
        };
      }
    }
  });

  const invalid = await runtime.testProvider('utility');
  assertEqual(invalid.ok, false, 'runtime provider test rejects schema success with false ok flag');
  assertEqual(invalid.error.code, 'RECURSION_PROVIDER_TEST_INVALID', 'false-ok provider test returns stable error code');
  const utility = settingsStore.get().providers.utility;
  assertEqual(utility.lastTest.status, 'fail', 'false-ok provider test records failing status');
  assertEqual(utility.resolvedProviderLabel, '', 'false-ok provider test clears stale provider label');
  assertEqual(utility.resolvedModelLabel, '', 'false-ok provider test clears stale model label');
  assertNoSecretText(utility.lastTest, 'false-ok provider test status');
  assertNoSecretText(invalid, 'false-ok provider test result');
}

console.log('[pass] runtime');
