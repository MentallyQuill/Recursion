import { createRecursionRuntime } from '../../src/runtime.mjs';
import { createActivityReporter } from '../../src/activity.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from '../../src/storage.mjs';
import { createGenerationRouter } from '../../src/providers.mjs';
import { CARD_CATALOG, cardsFromProviderResult } from '../../src/cards.mjs';
import { hashJson } from '../../src/core.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

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

{
  const { runtime, calls, installed, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'The lamp breaks.' });
  const view = runtime.view();
  assertEqual(runtime.storage, storage, 'runtime exposes storage repository');
  assertEqual(result.ok, true, 'auto mode returns ok');
  assertEqual(calls.snapshot, 1, 'auto mode reads snapshot');
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
  assertEqual(journal.entries.length, 1, 'install journal entry persisted');
  assertEqual(journal.entries[0].event, 'prompt.installed', 'install journal records success');
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
    lastMesId: 2
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
  const result = await runtime.prepareForGeneration({ userMessage: 'Observe only.' });
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
  assertEqual(journal.entries.length, 0, 'observe mode does not append install journal');
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
  assertEqual(journal.entries[0].event, 'prompt.install_failed', 'install failure journaled');
  assert(journal.entries[0].summary.includes('install transport failed'), 'install failure summary includes compact error');
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
  assertEqual(journal.entries[0].event, 'prompt.install_failed', 'missing installer journaled');
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
  assertEqual(appendCalls, 1, 'throwing scene cache save still appends install journal');
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
  const arbiterPrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: {
      mode: 'auto',
      promptFootprint: 'normal',
      reasonerUse: 'auto',
      providers: {
        utility: { enabled: true, source: 'host-current-model', lastTest: { compactError: 'Bearer settings-token sk-live-settings private-secret' } },
        reasoner: { enabled: true, source: 'openai-compatible', openAICompatible: { apiKey: 'sk-settings-key' }, lastTest: { compactError: 'Bearer reasoner-settings' } }
      }
    },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') arbiterPrompts.push(request.prompt);
        return { ok: true, data: { action: 'skip', diagnostics: ['settings-projection'] } };
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
  assertDeepEqual(Object.keys(result.plan).sort(), ['action', 'budgets', 'cardJobs', 'diagnostics', 'lifecycle', 'reasonerDecision', 'sceneStatus', 'schema', 'snapshotHash', 'source'].sort(), 'result plan only exposes whitelisted fields');
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
  assertEqual(result.ok, true, 'provider card provenance run installs');
  assert(handCard, 'provider card is selected into full hand');
  assertEqual(handCard.source?.snapshotHash, undefined, 'hand card exposes compact prompt-safe shape only');
  assert(providerCard, 'provider card is persisted to cache');
  assertEqual(providerCard.sourceFingerprint, result.plan.snapshotHash, 'provider card cache fingerprint uses runtime snapshot hash');
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
  const serialized = JSON.stringify({ cache, hand: view.lastHand, packet: view.lastPacket });
  assert(!serialized.includes('Bearer live-token'), 'provider card bearer token redacted before persistence and prompt');
  assert(!serialized.includes('sk-live-runtime'), 'provider card sk token redacted before persistence and prompt');
}

{
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
          emphasis: 'normal'
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
    generationRouter: {
      async generate() {
        return {
          ok: true,
          data: {
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
  const expectedSnapshotHash = hashJson(view.lastSnapshot);
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
  const first = runtime.prepareForGeneration({ userMessage: 'first run' });
  await waitUntil(() => typeof releaseFirstLoad === 'function', 'first run did not reach scene cache wait');
  const second = await runtime.prepareForGeneration({ userMessage: 'second run' });
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
      return {
        chatId: `save-run-${snapshotCalls}`,
        chatKey: `save-run-${snapshotCalls}`,
        sceneKey: `save-scene-${snapshotCalls}`,
        sceneFingerprint: `save-scene-${snapshotCalls}`,
        turnFingerprint: `save-turn-${snapshotCalls}`,
        latestMesId: snapshotCalls,
        messages: [{ mesid: snapshotCalls, role: 'user', text: snapshotCalls === 1 ? 'Older save packet.' : 'Newer save packet.', visible: true }]
      };
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'first save' });
  await waitUntil(() => typeof releaseFirstSave === 'function', 'first run did not enter scene cache save');
  const second = runtime.prepareForGeneration({ userMessage: 'second save' });
  await Promise.resolve();
  assertEqual(snapshotCalls, 1, 'newer run waits for in-flight scene cache save before snapshot');
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
  await storage.saveSceneCache('arbiter-chat', 'arbiter-scene', {
    cards: [
      {
        id: 'arbiter-keep',
        family: 'Continuity Risk',
        status: 'active',
        promptText: 'The only selected continuity risk should remain active.',
        summary: 'Keep continuity',
        tokenEstimate: 20,
        source: { chatId: 'arbiter-chat', firstMesId: 1, lastMesId: 2, snapshotHash: 'arbiter-source' }
      },
      {
        id: 'arbiter-stow',
        family: 'Scene Frame',
        status: 'active',
        promptText: 'This card should be stowed by the Arbiter.',
        summary: 'Stow scene',
        tokenEstimate: 20,
        source: { chatId: 'arbiter-chat', firstMesId: 1, lastMesId: 2, snapshotHash: 'arbiter-source' }
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
      messages: [{ mesid: 3, role: 'user', text: 'Use only the Arbiter-selected card.', visible: true }]
    },
    generationRouter: {
      async generate(roleId) {
        assertEqual(roleId, 'utilityArbiter', 'arbiter lifecycle regression only calls utility arbiter');
        return {
          ok: true,
          data: {
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
  const result = await runtime.prepareForGeneration({ userMessage: 'honor lifecycle' });
  assertEqual(result.ok, true, 'arbiter lifecycle run installs');
  assertDeepEqual(runtime.view().lastHand.cards.map((card) => card.id), ['arbiter-keep'], 'turn hand honors Arbiter select/stow lifecycle');
  const updated = await storage.loadSceneCache('arbiter-chat', 'arbiter-scene');
  assertEqual(updated.cards.find((card) => card.id === 'arbiter-stow')?.status, 'stowed', 'scene deck persists Arbiter stow decision');
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
            action: 'compose-brief',
            diagnostics: ['off-mode-regression']
          }
        };
      }
    }
  });
  const pending = runtime.prepareForGeneration({ userMessage: 'Turn off before install.' });
  await waitUntil(() => typeof releaseArbiter === 'function', 'off-mode run did not enter arbiter');
  runtime.updateSettings({ mode: 'off' });
  releaseArbiter();
  const result = await pending;
  assertEqual(result.superseded, true, 'Off mode change supersedes in-flight generation preparation');
  assertEqual(installed.length, 0, 'Off mode change prevents stale prompt install');
  assertEqual(runtime.view().activeRunId, null, 'Off mode change clears active run id');
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
      return {
        chatId: `clear-run-${snapshotCalls}`,
        chatKey: `clear-run-${snapshotCalls}`,
        sceneKey: `clear-scene-${snapshotCalls}`,
        sceneFingerprint: `clear-scene-${snapshotCalls}`,
        turnFingerprint: `clear-turn-${snapshotCalls}`,
        latestMesId: snapshotCalls,
        messages: [{ mesid: snapshotCalls, role: 'user', text: snapshotCalls === 1 ? 'Older clear packet.' : 'Newer install after clear.', visible: true }]
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
          return { ok: true, data: { action: 'skip', diagnostics: ['older-clear'] } };
        }
        return { ok: true, data: { action: 'compose-brief', diagnostics: ['newer-install'] } };
      }
    }
  });
  const first = runtime.prepareForGeneration({ userMessage: 'first clear' });
  await waitUntil(() => typeof releaseFirstClear === 'function', 'first run did not enter prompt clear');
  const second = runtime.prepareForGeneration({ userMessage: 'second install' });
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
      return {
        chatId: `install-run-${snapshotCalls}`,
        chatKey: `install-run-${snapshotCalls}`,
        sceneKey: `install-scene-${snapshotCalls}`,
        sceneFingerprint: `install-scene-${snapshotCalls}`,
        turnFingerprint: `install-turn-${snapshotCalls}`,
        latestMesId: snapshotCalls,
        messages: [{ mesid: snapshotCalls, role: 'user', text: snapshotCalls === 1 ? 'Older install packet.' : 'Newer install packet.', visible: true }]
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
  const first = runtime.prepareForGeneration({ userMessage: 'first install' });
  await waitUntil(() => typeof releaseFirstInstall === 'function', 'first run did not enter prompt install');
  const second = runtime.prepareForGeneration({ userMessage: 'second install' });
  await Promise.resolve();
  assertEqual(snapshotCalls, 1, 'newer run waits for in-flight prompt install before snapshot');
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
  const { runtime, installed } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' }
  });
  const result = await runtime.refreshScene();
  assertEqual(result.ok, true, 'manual refresh prepares generation');
  assertEqual(installed.length, 1, 'manual refresh installs prompt in auto mode');
  assertEqual(runtime.view().activeRunId, null, 'active run cleared after refresh');
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

  const updated = runtime.updateSettings({
    mode: 'auto',
    strength: 'strong',
    promptFootprint: 'rich',
    focus: 'character',
    reasonerUse: 'always'
  });
  assertEqual(updated.mode, 'auto', 'runtime exposes high-level settings update');
  assertEqual(updated.strength, 'strong', 'runtime settings update preserves strength');
  assertEqual(runtime.view().settings.focus, 'character', 'settings update is visible in runtime view');

  const utility = runtime.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'sk-runtime-secret',
    openAICompatible: { baseUrl: 'https://example.test/v1', model: 'utility-model' },
    temperature: 0.2,
    topP: 0.8,
    maxTokens: 2048
  });
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

  const cleared = runtime.clearProviderKey('utility');
  assertEqual(cleared.openAICompatible.sessionApiKeyPresent, false, 'runtime can clear provider session key');
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

console.log('[pass] runtime');
