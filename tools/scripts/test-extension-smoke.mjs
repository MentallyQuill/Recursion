import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';
import { hashJson } from '../../src/core.mjs';

const RECURSION_PROMPT_KEYS = [
  'recursion.guidance',
  'recursion.cardEvidence',
  'recursion.guardrails'
];

await import('../../src/extension/index.js');

async function waitUntil(predicate, message, { attempts = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

assertEqual(typeof globalThis.recursionGenerationInterceptor, 'function', 'generation interceptor is registered globally');
assertEqual(typeof globalThis.recursionOnEnable, 'function', 'enable hook is registered globally');

const chat = await globalThis.recursionGenerationInterceptor('hello');
assertEqual(chat, 'hello', 'generation interceptor returns original chat without host');

const hooks = [
  'recursionOnInstall',
  'recursionOnUpdate',
  'recursionOnEnable',
  'recursionOnDisable',
  'recursionOnDelete',
  'recursionOnClean',
  'recursionOnActivate'
];

for (const hook of hooks) {
  assertEqual(typeof globalThis[hook], 'function', `${hook} is registered globally`);
  assertEqual(await globalThis[hook](), true, `${hook} is fail-soft without host`);
}

function createFakeSillyTavernContext(label) {
  const promptWrites = [];
  const promptState = new Map();
  const controlEvents = [];
  const fake = {
    promptWrites,
    promptState,
    controlEvents,
    context: {
      chatId: `${label}-chat`,
      chat: [{ mesid: 0, is_user: true, mes: `${label} user message.` }],
      extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
      extension_prompt_roles: { SYSTEM: 'SYSTEM' },
      setExtensionPrompt(key, text, position, depth, scan, role) {
        if (fake.throwOnClear && text === '') {
          throw new Error(`${label} clear failed`);
        }
        promptWrites.push({ key, text, position, depth, scan, role });
        promptState.set(key, text);
      },
      deactivateSendButtons() {
        controlEvents.push('lock');
      },
      activateSendButtons() {
        controlEvents.push('unlock');
      },
      swipe: {
        hide() {
          controlEvents.push('hide-swipes');
        }
      },
      async generateRaw() {
        return {
          text: JSON.stringify({
            schema: 'recursion.utilityArbiter.v1',
            action: 'compose-brief',
            cardJobs: [],
            reasonerDecision: { mode: 'skip', reason: 'smoke test', signals: [] },
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: [`${label}-smoke`]
          })
        };
      }
    }
  };
  fake.throwOnClear = false;
  return fake;
}

function createFakeEventSource() {
  const listeners = new Map();
  return {
    on(eventName, handler) {
      const key = String(eventName);
      const list = listeners.get(key) || [];
      list.push(handler);
      listeners.set(key, list);
    },
    removeListener(eventName, handler) {
      const key = String(eventName);
      const list = listeners.get(key) || [];
      listeners.set(key, list.filter((entry) => entry !== handler));
    },
    listenerCount(eventName) {
      return (listeners.get(String(eventName)) || []).length;
    },
    async emit(eventName, payload = {}) {
      const list = [...(listeners.get(String(eventName)) || [])];
      await Promise.all(list.map((handler) => handler(payload)));
    }
  };
}

function createFakeClassList() {
  const values = new Set();
  return {
    add(value) {
      values.add(String(value));
    },
    remove(value) {
      values.delete(String(value));
    },
    toggle(value, force) {
      if (force) values.add(String(value));
      else values.delete(String(value));
    },
    contains(value) {
      return values.has(String(value));
    }
  };
}

async function assertLifecycleClearsInstalledPrompt(hookName) {
  const fake = createFakeSillyTavernContext(hookName);
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };

  const originalChat = { payload: `${hookName}-chat-payload` };
  assertEqual(await globalThis.recursionGenerationInterceptor(originalChat), originalChat, `${hookName} setup keeps original chat`);
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(fake.promptState.get(key), `${hookName} setup installs ${key}`);
  }

  const firstLifecycleWrite = fake.promptWrites.length;
  assertEqual(await globalThis[hookName](), true, `${hookName} returns true`);
  const cleanupWrites = fake.promptWrites.slice(firstLifecycleWrite);
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(
      cleanupWrites.some((entry) => entry.key === key && entry.text === ''),
      `${hookName} clears ${key}`
    );
    assertEqual(fake.promptState.get(key), '', `${hookName} leaves ${key} empty`);
  }
}

async function assertLifecycleClearFailureIsFailSoft(hookName) {
  const fake = createFakeSillyTavernContext(`${hookName}-clear-failure`);
  const warnings = [];
  const originalWarn = console.warn;
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };

  try {
    console.warn = (...args) => warnings.push(args);
    assertEqual(await globalThis.recursionGenerationInterceptor(`${hookName}-failure-chat`), `${hookName}-failure-chat`, `${hookName} failure setup keeps original chat`);
    fake.throwOnClear = true;
    assertEqual(await globalThis[hookName](), true, `${hookName} returns true when prompt clear throws`);
    assert(warnings.some((entry) => String(entry[0] || '').includes('clear')), `${hookName} logs prompt clear failure`);
  } finally {
    console.warn = originalWarn;
    fake.throwOnClear = false;
    await globalThis.recursionOnDelete();
  }
}

const previousGlobals = {
  SillyTavern: globalThis.SillyTavern,
  getContext: globalThis.getContext,
  extensionSettings: globalThis.extension_settings,
  fetch: globalThis.fetch
};
const lifecycleFailures = [];
try {
  for (const hookName of ['recursionOnDisable', 'recursionOnDelete']) {
    try {
      await assertLifecycleClearsInstalledPrompt(hookName);
      await assertLifecycleClearFailureIsFailSoft(hookName);
    } catch (error) {
      lifecycleFailures.push(`${hookName}: ${error?.message || error}`);
      await globalThis.recursionOnDelete();
    }
  }
} finally {
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.getContext === undefined) delete globalThis.getContext;
  else globalThis.getContext = previousGlobals.getContext;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
  if (previousGlobals.fetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = previousGlobals.fetch;
}
if (lifecycleFailures.length) {
  throw new Error(lifecycleFailures.join('\n'));
}

{
  const eventSource = createFakeEventSource();
  const warnings = [];
  const originalWarn = console.warn;
  const delayedContext = {
    chatId: 'delayed-settings-chat',
    chat: [{ mesid: 0, is_user: true, mes: 'Deferred settings user message.' }],
    extensionSettings: { memory: {} },
    extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
    extension_prompt_roles: { SYSTEM: 'SYSTEM' },
    eventSource,
    event_types: {
      EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
      SETTINGS_LOADED: 'settings_loaded',
      APP_READY: 'app_ready'
    },
    setExtensionPrompt() {
      return true;
    }
  };
  try {
    console.warn = (...args) => warnings.push(args);
    globalThis.SillyTavern = { getContext: () => delayedContext };
    delete globalThis.extension_settings;

    await globalThis.recursionOnDelete();
    assertEqual(await globalThis.recursionOnActivate(), true, 'early activate remains fail-soft before settings load');
    assertEqual(eventSource.listenerCount('extension_settings_loaded'), 1, 'early activate waits for extension settings load');
    delayedContext.extensionSettings.recursion = { mode: 'manual', reasonerUse: 'off' };
    delayedContext.saveSettingsDebounced = () => {};
    await eventSource.emit('extension_settings_loaded');
    assertEqual(eventSource.listenerCount('extension_settings_loaded'), 0, 'settings-load bootstrap unsubscribes retry listener');
    assertEqual(delayedContext.extensionSettings.recursion.mode, 'manual', 'deferred bootstrap uses loaded SillyTavern settings');
    assert(delayedContext.extensionSettings.recursion.cardDecks, 'deferred bootstrap normalizes loaded Card Deck settings in place');
    assertEqual(delayedContext.extensionSettings.recursion.cardScope, undefined, 'deferred bootstrap removes legacy cardScope');
    await globalThis.recursionOnDelete();
    assertEqual(warnings.length, 0, 'deferred settings bootstrap does not emit harness warnings');
  } finally {
    console.warn = originalWarn;
    if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
    else globalThis.SillyTavern = previousGlobals.SillyTavern;
    if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
    else globalThis.extension_settings = previousGlobals.extensionSettings;
  }
}

{
  const fake = createFakeSillyTavernContext('chat-change-event');
  const eventSource = createFakeEventSource();
  fake.context.eventSource = eventSource;
  fake.context.event_types = { CHAT_CHANGED: 'chat_changed' };
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionGenerationInterceptor('chat-change-event-payload'), 'chat-change-event-payload', 'chat-change event setup keeps original chat');
  assertEqual(eventSource.listenerCount('chat_changed'), 1, 'bootstrap subscribes to SillyTavern chat change event');
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(fake.promptState.get(key), `chat-change setup installs ${key}`);
  }
  const clearStart = fake.promptWrites.length;
  await eventSource.emit('chat_changed');
  const cleanupWrites = fake.promptWrites.slice(clearStart);
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(
      cleanupWrites.some((entry) => entry.key === key && entry.text === ''),
      `chat-change event clears ${key}`
    );
    assertEqual(fake.promptState.get(key), '', `chat-change event leaves ${key} empty`);
  }
  await globalThis.recursionOnDelete();
  assertEqual(eventSource.listenerCount('chat_changed'), 0, 'teardown unsubscribes from SillyTavern chat change event');
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const fake = createFakeSillyTavernContext('source-change-event');
  const eventSource = createFakeEventSource();
  fake.context.eventSource = eventSource;
  fake.context.event_types = {
    CHAT_CHANGED: 'chat_changed',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_SWIPED: 'message_swiped'
  };
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionGenerationInterceptor('source-change-event-payload'), 'source-change-event-payload', 'source-change event setup keeps original chat');
  assertEqual(eventSource.listenerCount('message_deleted'), 1, 'bootstrap subscribes to message deleted event');
  assertEqual(eventSource.listenerCount('message_updated'), 1, 'bootstrap subscribes to message updated event');
  assertEqual(eventSource.listenerCount('message_swiped'), 1, 'bootstrap subscribes to message swiped event');
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(fake.promptState.get(key), `source-change setup installs ${key}`);
  }
  const clearStart = fake.promptWrites.length;
  await eventSource.emit('message_swiped', 0);
  const cleanupWrites = fake.promptWrites.slice(clearStart);
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(
      cleanupWrites.some((entry) => entry.key === key && entry.text === ''),
      `swipe source-change event clears ${key}`
    );
    assertEqual(fake.promptState.get(key), '', `swipe source-change event leaves ${key} empty`);
  }
  await globalThis.recursionOnDelete();
  assertEqual(eventSource.listenerCount('message_deleted'), 0, 'teardown unsubscribes from message deleted event');
  assertEqual(eventSource.listenerCount('message_updated'), 0, 'teardown unsubscribes from message updated event');
  assertEqual(eventSource.listenerCount('message_swiped'), 0, 'teardown unsubscribes from message swiped event');
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const fake = createFakeSillyTavernContext('latest-assistant-swipe-event');
  const eventSource = createFakeEventSource();
  const prompts = [];
  fake.context.eventSource = eventSource;
  fake.context.chat = [{
    mesid: 923,
    is_user: false,
    mes: 'Latest assistant swipe A.',
    swipe_id: 0,
    swipes: ['Latest assistant swipe A.', 'Latest assistant swipe B.']
  }];
  fake.context.event_types = {
    MESSAGE_SWIPED: 'message_swiped',
    GENERATION_ENDED: 'generation_ended'
  };
  fake.context.generateRaw = async (request = {}) => {
    prompts.push(String(request.prompt || ''));
    return {
      text: JSON.stringify({
        schema: 'recursion.utilityArbiter.v1',
        snapshotHash: request.snapshotHash,
        action: 'skip',
        reasonerDecision: { mode: 'skip', reason: 'latest assistant swipe smoke', signals: [] },
        budgets: { targetBriefTokens: 500, maxCards: 6 },
        diagnostics: ['latest-assistant-swipe-smoke']
      })
    };
  };
  globalThis.extension_settings = { recursion: { pipelineMode: 'rapid', mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionOnActivate(), true, 'latest assistant swipe setup activates');
  assertEqual(eventSource.listenerCount('message_swiped'), 1, 'bootstrap subscribes to latest assistant swipe event');
  const clearStart = fake.promptWrites.length;
  fake.context.chat[0].swipe_id = 1;
  fake.context.chat[0].mes = fake.context.chat[0].swipes[1];
  await eventSource.emit('message_swiped', { mesid: 923 });
  await eventSource.emit('generation_ended', { mesid: 923 });
  const cleanupWrites = fake.promptWrites.slice(clearStart);
  assert(
    cleanupWrites.every((entry) => entry.text !== ''),
    'latest assistant swipe retry does not clear existing Recursion prompt lanes'
  );
  assertEqual(prompts.length, 0, 'latest assistant swipe retry does not warm Rapid');
  await globalThis.recursionOnDelete();
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const fake = createFakeSillyTavernContext('latest-assistant-swipe-retry');
  const eventSource = createFakeEventSource();
  const prompts = [];
  const userText = 'User asks for the retryable reply.';
  fake.context.eventSource = eventSource;
  fake.context.chat = [{ mesid: 1, is_user: true, mes: userText }];
  fake.context.event_types = { MESSAGE_SWIPED: 'message_swiped' };
  fake.context.generateRaw = async (request = {}) => {
    prompts.push(String(request.prompt || ''));
    return {
      text: JSON.stringify({
        schema: 'recursion.utilityArbiter.v1',
        snapshotHash: request.snapshotHash,
        action: 'compose-brief',
        cardJobs: [],
        reasonerDecision: { mode: 'skip', reason: 'latest assistant swipe retry smoke', signals: [] },
        budgets: { targetBriefTokens: 500, maxCards: 6 },
        diagnostics: ['latest-assistant-swipe-retry-smoke']
      })
    };
  };
  globalThis.extension_settings = { recursion: { pipelineMode: 'standard', mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };
  globalThis.__recursionLiveHarness = true;

  await globalThis.recursionOnDelete();
  assertEqual(
    await globalThis.recursionGenerationInterceptor(fake.context.chat),
    fake.context.chat,
    'latest assistant swipe retry setup keeps original chat'
  );
  assert(prompts.length > 0, 'latest assistant swipe retry setup calls provider once');
  const callsAfterSetup = prompts.length;
  const writesAfterSetup = fake.promptWrites.length;
  const preparedView = globalThis.__recursionLiveHarnessRuntime.view();
  const preparedPacketId = preparedView.lastBrief?.packetId;
  assertEqual(preparedView.lastBrief?.status, 'ready', 'successful extension setup leaves Last Brief ready');
  assertEqual(preparedView.activity?.label, 'Recursion prompt ready.', 'successful extension setup settles prompt-ready activity');
  fake.context.chat = [
    { mesid: 1, is_user: true, mes: userText },
    {
      mesid: 2,
      is_user: false,
      mes: 'Latest assistant swipe B.',
      swipe_id: 1,
      swipes: ['Latest assistant swipe A.', 'Latest assistant swipe B.']
    }
  ];
  await eventSource.emit('message_swiped', {});
  const truncatedSwipePayload = [
    { mesid: 1, is_user: true, mes: userText }
  ];
  assertEqual(
    await globalThis.recursionGenerationInterceptor(truncatedSwipePayload, undefined, undefined, 'swipe'),
    truncatedSwipePayload,
    'latest assistant native swipe sequence keeps the truncated interceptor payload'
  );
  assertEqual(fake.context.chat.length, 2, 'latest assistant native swipe sequence does not append a second assistant row');
  assertEqual(fake.context.chat[1].swipes.length, 2, 'latest assistant native swipe sequence preserves both response variants');
  assertEqual(fake.context.chat[1].swipe_id, 1, 'latest assistant native swipe sequence keeps the selected response variant');
  assertEqual(prompts.length, callsAfterSetup, 'latest assistant native swipe sequence does not call providers again');
  assert(fake.promptWrites.length > writesAfterSetup, 'latest assistant native swipe sequence reinstalls previous prompt');
  assertEqual(globalThis.__recursionLiveHarnessRuntime.view().lastCacheDecision?.kind, 'swipe-packet', 'latest assistant native swipe sequence records packet-cache provenance');
  assertEqual(globalThis.__recursionLiveHarnessRuntime.view().lastCacheDecision?.decision, 'hit', 'latest assistant native swipe sequence records a packet-cache hit');
  assertEqual(globalThis.__recursionLiveHarnessRuntime.view().lastBrief?.packetId, preparedPacketId, 'latest assistant native swipe sequence preserves packet identity');
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(fake.promptState.get(key), `latest assistant native swipe sequence keeps ${key} installed`);
  }
  await globalThis.recursionOnDelete();
  delete globalThis.__recursionLiveHarness;
  delete globalThis.__recursionLiveHarnessRuntime;
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const fake = createFakeSillyTavernContext('editorial-swipe-overlap');
  const eventSource = createFakeEventSource();
  const roles = [];
  let transformerStarted = false;
  let transformerSignal = null;
  const userText = 'Keep the team in the booth while they assess the transport method.';
  const assistantText = 'Carter kept her hands around the coffee mug while she studied Will.';
  const snapshotHashFromPrompt = (prompt) => String(prompt || '').match(/Snapshot hash:\s*([^\s<]+)/i)?.[1]
    || String(prompt || '').match(/snapshotHash must be "([^"]+)"/i)?.[1]
    || '';
  fake.context.eventSource = eventSource;
  fake.context.event_types = {
    MESSAGE_SWIPED: 'message_swiped',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended'
  };
  fake.context.chat = Array.from({ length: 30 }, (_, index) => ({
    mesid: index,
    is_user: index === 29 ? true : index % 2 === 0,
    mes: index === 29 ? userText : `bounded extension message ${index}`
  }));
  fake.context.generateRaw = async (request = {}) => {
    const prompt = String(request.prompt || '');
    const snapshotHash = snapshotHashFromPrompt(prompt);
    if (prompt.includes('Recursion Editorial Pass JSON object')) {
      roles.push('editorialTransformer');
      transformerStarted = true;
      transformerSignal = request.signal || null;
      await new Promise((resolve, reject) => {
        if (request.signal?.aborted) {
          const error = new Error('Provider generation was aborted.');
          error.code = 'RECURSION_PROVIDER_ABORTED';
          reject(error);
          return;
        }
        request.signal?.addEventListener?.('abort', () => {
          const error = new Error('Provider generation was aborted.');
          error.code = 'RECURSION_PROVIDER_ABORTED';
          reject(error);
        }, { once: true });
      });
    }
    if (prompt.includes('Recursion Editorial Diagnosis JSON object')) {
      roles.push('editorialDiagnostician');
      return {
        text: JSON.stringify({
          schema: 'recursion.editorialDiagnosis.v1',
          mode: 'recompose',
          sourceHash: 'trusted-by-runtime',
          snapshotHash: 'trusted-by-runtime',
          decision: 'proceed',
          brief: {
            mode: 'recompose',
            diagnosis: [{ dimension: 'continuity', problem: 'Tighten the immediate reaction.', evidenceRefs: ['source:0'] }],
            preserve: [],
            discard: [{ claim: 'Loose response wording.', evidenceRefs: ['source:0'] }],
            allowedChanges: ['Rewrite the immediate reaction.'],
            forbiddenChanges: ['Do not move the team out of the booth.']
          }
        })
      };
    }
    if (prompt.includes('Generate all requested Recursion scene cards')) {
      roles.push('fusedCardBundle');
      return {
        text: JSON.stringify({
          schema: 'recursion.cardBundle.v1',
          snapshotHash,
          items: [{
            schema: 'recursion.card.v1',
            family: 'Scene Frame',
            role: 'sceneFrameCard',
            promptText: 'Keep the team seated in the public diner booth.',
            evidenceRefs: ['message:29'],
            tokenEstimate: 12
          }]
        })
      };
    }
    if (prompt.includes('Write Recursion response guidance')) {
      roles.push('guidanceComposer');
      return {
        text: JSON.stringify({
          schema: 'recursion.guidanceComposer.v1',
          snapshotHash,
          guidanceText: 'Keep the response in the diner booth.',
          sourceCardIds: [],
          guardrailCardIds: [],
          omittedCardIds: [],
          diagnostics: ['extension-editorial-overlap-guidance']
        })
      };
    }
    roles.push('utilityArbiter');
    return {
      text: JSON.stringify({
        schema: 'recursion.utilityArbiter.v1',
        snapshotHash,
        action: 'compose-brief',
        sceneStatus: 'same-scene',
        cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame', priority: 100 }],
        reasonerDecision: { mode: 'skip', reason: 'extension overlap setup', signals: [] },
        budgets: { targetBriefTokens: 500, maxCards: 6 },
        diagnostics: ['extension-editorial-overlap-arbiter']
      })
    };
  };
  globalThis.extension_settings = {
    recursion: {
      pipelineMode: 'fused',
      mode: 'auto',
      reasoningLevel: 'medium',
      reasonerUse: 'off',
      enhancements: { mode: 'recompose', applyMode: 'as-swipe', contextMessages: 13 }
    }
  };
  globalThis.SillyTavern = { getContext: () => fake.context };
  globalThis.__recursionLiveHarness = true;

  await globalThis.recursionOnDelete();
  assertEqual(
    await globalThis.recursionGenerationInterceptor(fake.context.chat, undefined, undefined, 'normal'),
    fake.context.chat,
    'extension overlap setup keeps native chat payload'
  );
  const initialView = globalThis.__recursionLiveHarnessRuntime.view();
  const initialPacketId = initialView.lastBrief?.packetId;
  const initialPipelineCalls = roles.filter((roleId) => ['utilityArbiter', 'fusedCardBundle', 'guidanceComposer'].includes(roleId)).length;
  fake.context.chat.push({
    mesid: 30,
    is_user: false,
    mes: assistantText,
    swipe_id: 0,
    swipes: [assistantText],
    swipe_info: [{ send_date: '2026-07-14T00:00:00.000Z', extra: {} }]
  });
  const enhancementEvent = eventSource.emit('generation_ended', { mesid: 30 });
  await waitUntil(() => transformerStarted, 'extension overlap Editorial transformer did not start');
  fake.context.chat[30].swipe_id = 1;
  fake.context.chat[30].swipes.push('');
  await eventSource.emit('message_swiped', { mesid: 30 });
  await eventSource.emit('generation_stopped', { mesid: 30 });
  await enhancementEvent;
  const truncatedSwipePayload = fake.context.chat.slice(0, 30);
  await globalThis.recursionGenerationInterceptor(truncatedSwipePayload, undefined, undefined, 'swipe');
  const finalView = globalThis.__recursionLiveHarnessRuntime.view();
  const finalPipelineCalls = roles.filter((roleId) => ['utilityArbiter', 'fusedCardBundle', 'guidanceComposer'].includes(roleId)).length;

  assertEqual(transformerSignal?.aborted, true, 'extension event order aborts active Editorial provider work');
  assertEqual(finalPipelineCalls, initialPipelineCalls, 'extension event order makes no new Arbiter, Fused, or Guidance calls on swipe');
  assertEqual(finalView.lastCacheDecision?.kind, 'swipe-packet', 'extension event order records packet-cache reuse');
  assertEqual(finalView.lastBrief?.packetId, initialPacketId, 'extension event order preserves packet identity');
  assertEqual(fake.context.chat[30].swipes.length, 1, 'extension cancellation removes the native empty swipe placeholder');
  assert(fake.context.chat[30].swipes.every((text) => String(text).trim()), 'extension cancellation leaves no blank assistant swipes');
  assertEqual(fake.context.chat[30].__recursionGenerationReview, undefined, 'extension cancellation appends no Recursion enhancement marker');
  assertEqual(finalView.activity?.label, 'Recursion prompt reused for swipe retry.', 'extension event order leaves cached swipe progress authoritative');

  await globalThis.recursionOnDelete();
  delete globalThis.__recursionLiveHarness;
  delete globalThis.__recursionLiveHarnessRuntime;
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const fake = createFakeSillyTavernContext('editorial-owned-commit-event');
  const eventSource = createFakeEventSource();
  let enhancementCalls = 0;
  fake.context.eventSource = eventSource;
  fake.context.event_types = {
    GENERATION_ENDED: 'generation_ended'
  };
  fake.context.chat = [
    { mesid: 0, is_user: true, mes: 'Keep the response grounded.' },
    { mesid: 1, is_user: false, mes: 'The grounded response landed.' }
  ];
  globalThis.extension_settings = {
    recursion: {
      mode: 'auto',
      reasonerUse: 'off',
      enhancements: { mode: 'recompose', applyMode: 'as-swipe', contextMessages: 13 }
    }
  };
  globalThis.SillyTavern = { getContext: () => fake.context };
  globalThis.__recursionLiveHarness = true;

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionOnActivate(), true, 'owned commit event setup activates');
  const activeRuntime = globalThis.__recursionLiveHarnessRuntime;
  activeRuntime.proseEnhancementPending = () => true;
  activeRuntime.proseEnhancementRunning = () => true;
  activeRuntime.enhanceLatestAssistantMessage = async () => {
    enhancementCalls += 1;
    return { ok: true };
  };
  await eventSource.emit('generation_ended', { mesid: 1 });
  assertEqual(enhancementCalls, 0, 'generation ended during a Recursion-owned commit does not start another Enhancement');

  await globalThis.recursionOnDelete();
  delete globalThis.__recursionLiveHarness;
  delete globalThis.__recursionLiveHarnessRuntime;
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const fake = createFakeSillyTavernContext('editorial-one-shot-generation-event');
  const eventSource = createFakeEventSource();
  let pending = true;
  let enhancementCalls = 0;
  let generationEndCalls = 0;
  let releaseFirstGenerationEnd;
  const firstGenerationEndGate = new Promise((resolve) => { releaseFirstGenerationEnd = resolve; });
  fake.context.eventSource = eventSource;
  fake.context.event_types = {
    GENERATION_ENDED: 'generation_ended'
  };
  fake.context.chat = [
    { mesid: 0, is_user: true, mes: 'Generate one reply.' }
  ];
  globalThis.extension_settings = {
    recursion: {
      mode: 'auto',
      reasonerUse: 'off',
      enhancements: { mode: 'recompose', applyMode: 'as-swipe', contextMessages: 13 }
    }
  };
  globalThis.SillyTavern = { getContext: () => fake.context };
  globalThis.__recursionLiveHarness = true;

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionOnActivate(), true, 'one-shot Enhancement event setup activates');
  const activeRuntime = globalThis.__recursionLiveHarnessRuntime;
  activeRuntime.proseEnhancementPending = () => pending;
  activeRuntime.proseEnhancementRunning = () => false;
  activeRuntime.holdPendingProseEnhancementMessage = async () => ({ ok: true });
  activeRuntime.enhanceLatestAssistantMessage = async () => {
    enhancementCalls += 1;
    pending = false;
    return { ok: true };
  };
  activeRuntime.handleHostGenerationEnded = async () => {
    generationEndCalls += 1;
    if (generationEndCalls === 1) await firstGenerationEndGate;
    return { ok: true };
  };
  fake.context.chat.push({
    mesid: 1,
    is_user: false,
    mes: 'The generated reply.',
    swipe_id: 0,
    swipes: ['The generated reply.']
  });

  const firstEnded = eventSource.emit('generation_ended', { mesid: 1 });
  await waitUntil(() => enhancementCalls === 1 && generationEndCalls === 1, 'first Enhancement did not reach generation settlement gate');
  await eventSource.emit('generation_ended', { mesid: 1 });
  assertEqual(enhancementCalls, 1, 'a delayed duplicate generation-ended event cannot start a second Enhancement');
  releaseFirstGenerationEnd();
  await firstEnded;

  await globalThis.recursionOnDelete();
  delete globalThis.__recursionLiveHarness;
  delete globalThis.__recursionLiveHarnessRuntime;
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const fake = createFakeSillyTavernContext('generation-stopped-event');
  const eventSource = createFakeEventSource();
  fake.context.eventSource = eventSource;
  fake.context.event_types = {
    CHAT_CHANGED: 'chat_changed',
    GENERATION_STOPPED: 'generation_stopped'
  };
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionGenerationInterceptor('generation-stopped-event-payload'), 'generation-stopped-event-payload', 'generation stopped event setup keeps original chat');
  assertEqual(eventSource.listenerCount('generation_stopped'), 1, 'bootstrap subscribes to SillyTavern generation stopped event');
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(fake.promptState.get(key), `generation stopped setup installs ${key}`);
  }
  const clearStart = fake.promptWrites.length;
  await eventSource.emit('generation_stopped');
  const cleanupWrites = fake.promptWrites.slice(clearStart);
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(
      cleanupWrites.some((entry) => entry.key === key && entry.text === ''),
      `generation stopped event clears ${key}`
    );
    assertEqual(fake.promptState.get(key), '', `generation stopped event leaves ${key} empty`);
  }
  await globalThis.recursionOnDelete();
  assertEqual(eventSource.listenerCount('generation_stopped'), 0, 'teardown unsubscribes from SillyTavern generation stopped event');
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const fake = createFakeSillyTavernContext('generation-stopped-fallback-event');
  const eventSource = createFakeEventSource();
  fake.context.eventSource = eventSource;
  fake.context.event_types = { CHAT_CHANGED: 'chat_changed' };
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionGenerationInterceptor('generation-stopped-fallback-event-payload'), 'generation-stopped-fallback-event-payload', 'generation stopped fallback setup keeps original chat');
  assertEqual(eventSource.listenerCount('generation_stopped'), 1, 'bootstrap subscribes to generation stopped fallback event name');
  await globalThis.recursionOnDelete();
  assertEqual(eventSource.listenerCount('generation_stopped'), 0, 'teardown unsubscribes from generation stopped fallback event name');
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const fake = createFakeSillyTavernContext('generation-after-commands-event');
  const eventSource = createFakeEventSource();
  fake.context.eventSource = eventSource;
  fake.context.event_types = {
    CHAT_CHANGED: 'chat_changed',
    GENERATION_AFTER_COMMANDS: 'generation_after_commands',
    GENERATION_ENDED: 'generation_ended'
  };
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionOnActivate(), true, 'generation after-commands setup activates');
  assertEqual(eventSource.listenerCount('generation_after_commands'), 0, 'bootstrap does not treat generation-after-commands as assistant landed');
  assertEqual(eventSource.listenerCount('generation_ended'), 1, 'bootstrap still subscribes to true assistant-landed generation ended event');
  await globalThis.recursionOnDelete();
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const context = {
    chatId: 'prose-stale-held-recovery-chat',
    chat: [
      {
        mesid: 0,
        is_user: false,
        mes: '',
        swipe_id: 0,
        swipes: [''],
        __recursionHeldText: 'Recovered prose hold.'
      }
    ],
    extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
    extension_prompt_roles: { SYSTEM: 'SYSTEM' },
    eventSource: createFakeEventSource(),
    event_types: {
      CHAT_CHANGED: 'chat_changed',
      GENERATION_ENDED: 'generation_ended',
      MESSAGE_RECEIVED: 'message_received',
      MESSAGE_UPDATED: 'message_updated',
      STREAM_TOKEN_RECEIVED: 'stream_token_received'
    },
    setExtensionPrompt() {},
    saveChat() {
      context.saved = true;
    },
    async generateRaw() {
      return {
        text: JSON.stringify({
          schema: 'recursion.utilityArbiter.v1',
          action: 'skip',
          sceneStatus: 'same-scene',
          cardJobs: [],
          reasonerDecision: { mode: 'skip', reason: 'stale held recovery smoke', signals: [] },
          budgets: { targetBriefTokens: 500, maxCards: 6 },
          diagnostics: ['stale-held-recovery']
        })
      };
    }
  };
  globalThis.__recursionLiveHarness = true;
  globalThis.extension_settings = {
    recursion: {
      mode: 'auto',
      pipelineMode: 'standard',
      reasonerUse: 'off',
      enhancements: { target: 'prose', applyMode: 'as-swipe', contextMessages: 3 }
    }
  };
  globalThis.SillyTavern = { getContext: () => context };

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionOnActivate(), true, 'stale held recovery setup activates');
  await waitUntil(
    () => context.chat[0].mes === 'Recovered prose hold.',
    'bootstrap recovers stale held prose assistant text'
  );
  assertEqual(context.chat[0].swipes[0], 'Recovered prose hold.', 'bootstrap recovers stale held active swipe');
  assertEqual(context.chat[0].__recursionHeldText, undefined, 'bootstrap clears stale held marker');
  assertEqual(context.saved, true, 'bootstrap stale held recovery saves chat');
  await globalThis.recursionOnDelete();
  delete globalThis.__recursionLiveHarness;
  delete globalThis.__recursionLiveHarnessRuntime;
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const eventSource = createFakeEventSource();
  let resolveProse;
  let interceptorComplete = false;
  const proseGate = new Promise((resolve) => { resolveProse = resolve; });
  const previousDocument = globalThis.document;
  const fakeDocumentElement = { classList: createFakeClassList() };
  globalThis.document = { documentElement: fakeDocumentElement };
  const context = {
    chatId: 'prose-assistant-landed-chat',
    chat: [
      { mesid: 0, is_user: false, mes: 'Previous assistant message.' },
      { mesid: 1, is_user: true, mes: 'Polish the next reply.' }
    ],
    extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
    extension_prompt_roles: { SYSTEM: 'SYSTEM' },
    eventSource,
    controlEvents: [],
    event_types: {
      CHAT_CHANGED: 'chat_changed',
      GENERATION_ENDED: 'generation_ended',
      MESSAGE_RECEIVED: 'message_received',
      MESSAGE_UPDATED: 'message_updated',
      STREAM_TOKEN_RECEIVED: 'stream_token_received'
    },
    setExtensionPrompt() {},
    deactivateSendButtons() {
      context.controlEvents.push('lock');
    },
    activateSendButtons() {
      context.controlEvents.push('unlock');
    },
    swipe: {
      hide() {
        context.controlEvents.push('hide-swipes');
      },
      refresh(updateCounters) {
        context.controlEvents.push(`refresh-swipes:${updateCounters}`);
      }
    },
    saveChat() {
      context.controlEvents.push('save');
    },
    async generateRaw(request = {}) {
      if (interceptorComplete) {
        await proseGate;
        return {
          text: JSON.stringify({
            schema: 'recursion.generationReview.v1',
            sourceHash: hashJson('Mara was furious. "Keep the door shut," she said.'),
            assessment: { response: 'repaired' },
            reviewDomains: { 'narrative-execution': 'repaired' },
            cardOutcomes: [],
            patches: [{
              id: 'prose:1',
              domain: 'narrative-execution',
              before: 'Mara was furious.',
              after: 'Mara crossed the room.',
              reason: 'Replace generic emotional shorthand with observable action.',
              cardRefs: []
            }]
          })
        };
      }
      return {
        text: JSON.stringify({
          schema: 'recursion.utilityArbiter.v1',
          snapshotHash: request.snapshotHash,
          action: 'skip',
          sceneStatus: 'same-scene',
          promptFootprint: 'compact',
          cardJobs: [],
          reasonerDecision: { mode: 'skip', reason: 'prose event order smoke', signals: [] },
          budgets: { targetBriefTokens: 500, maxCards: 6 },
          diagnostics: ['prose-event-order-smoke']
        })
      };
    }
  };
  globalThis.__recursionLiveHarness = true;
  globalThis.extension_settings = {
    recursion: {
      mode: 'auto',
      pipelineMode: 'standard',
      reasonerUse: 'off',
      enhancements: { target: 'on', applyMode: 'replace', contextMessages: 3 }
    }
  };
  globalThis.SillyTavern = { getContext: () => context };

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionOnActivate(), true, 'prose assistant-landed setup activates');
  assertEqual(await globalThis.recursionGenerationInterceptor('prose event order payload'), 'prose event order payload', 'prose event order interceptor arms generation');
  interceptorComplete = true;
  assertEqual(globalThis.__recursionLiveHarnessRuntime.proseEnhancementPending(), true, 'generation review is armed after the generation interceptor');
  assertEqual(fakeDocumentElement.classList.contains('recursion-enhancement-capture-active'), false, 'generation review never hides the streaming assistant response');
  context.chat.push({
    mesid: 2,
    is_user: false,
    mes: 'Mara was angry. "Keep the door shut," she said.',
    swipes: ['Mara was angry. "Keep the door shut," she said.'],
    swipe_id: 0
  });
  await eventSource.emit('message_updated', { mesid: 2 });
  assertEqual(globalThis.__recursionLiveHarnessRuntime.proseEnhancementPending(), true, 'streaming message update does not clear pending generation review');
  assertEqual(fakeDocumentElement.classList.contains('recursion-enhancement-capture-active'), false, 'streaming assistant response remains visible during generation review');
  assertEqual(context.chat[2].mes, 'Mara was angry. "Keep the door shut," she said.', 'streaming message update preserves the visible assistant text');
  context.chat[2].mes = 'Mara was furious. "Keep the door shut," she said.';
  context.chat[2].swipes[0] = 'Mara was furious. "Keep the door shut," she said.';
  await eventSource.emit('stream_token_received', { mesid: 2 });
  assertEqual(context.chat[2].mes, 'Mara was furious. "Keep the door shut," she said.', 'stream token event preserves streaming assistant text in chat state');
  await eventSource.emit('message_received', { mesid: 2 });
  assertEqual(globalThis.__recursionLiveHarnessRuntime.proseEnhancementPending(), true, 'message received does not run prose enhancement before generation ended');
  assertEqual(globalThis.__recursionLiveHarnessRuntime.proseEnhancementRunning(), false, 'native generation remains pending but is not already executing Enhancement');
  const landed = eventSource.emit('generation_ended', { mesid: 2 });
  await waitUntil(
    () => context.controlEvents.includes('lock'),
    'assistant-landed generation review locks controls before provider resolves'
  );
  assertEqual(fakeDocumentElement.classList.contains('recursion-enhancement-capture-active'), false, 'completed source stays visible while generation review resolves');
  assertEqual(globalThis.__recursionLiveHarnessRuntime.view().hostGenerationActive, true, 'assistant-landed prose enhancement keeps host generation active while provider is pending');
  assertDeepEqual(context.controlEvents, ['lock', 'hide-swipes'], 'assistant-landed enhancement locks SillyTavern send and swipe controls while pending');
  resolveProse();
  await landed;
  assertEqual(context.chat[2].mes, 'Mara crossed the room. "Keep the door shut," she said.', 'assistant-landed prose enhancement replaces held text');
  assertEqual(globalThis.__recursionLiveHarnessRuntime.view().hostGenerationActive, false, 'assistant-landed prose enhancement clears host generation after provider settles');
  assertDeepEqual(context.controlEvents, ['lock', 'hide-swipes', 'save', 'unlock'], 'assistant-landed replacement saves before unlocking SillyTavern controls');
  assertEqual(globalThis.__recursionLiveHarnessRuntime.view().lastBrief?.status, 'ready', 'assistant-landed prose enhancement leaves Last Brief ready');
  const prosePacketId = globalThis.__recursionLiveHarnessRuntime.view().lastBrief?.packetId;
  await eventSource.emit('message_updated', { mesid: 2 });
  assertEqual(globalThis.__recursionLiveHarnessRuntime.view().lastBrief?.status, 'ready', 'late prose-owned message update does not clear Last Brief');
  assertEqual(globalThis.__recursionLiveHarnessRuntime.view().lastBrief?.packetId, prosePacketId, 'late prose-owned message update preserves prompt packet id');
  await eventSource.emit('chat_changed');
  assertEqual(globalThis.__recursionLiveHarnessRuntime.view().lastBrief?.status, 'ready', 'enhancement-owned chat change does not clear Last Brief');
  assertEqual(globalThis.__recursionLiveHarnessRuntime.view().lastBrief?.packetId, prosePacketId, 'enhancement-owned chat change preserves prompt packet id for swipe reuse');
  assertEqual(fakeDocumentElement.classList.contains('recursion-enhancement-capture-active'), false, 'generation review leaves capture disabled after it settles');
  await globalThis.recursionOnDelete();
  delete globalThis.__recursionLiveHarness;
  delete globalThis.__recursionLiveHarnessRuntime;
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const eventSource = createFakeEventSource();
  const prompts = [];
  const context = {
    chatId: 'rapid-assistant-landed-chat',
    chat: [
      { mesid: 0, is_user: false, mes: 'Previous assistant message.' },
      { mesid: 1, is_user: true, mes: 'User asks for the next beat.' }
    ],
    extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
    extension_prompt_roles: { SYSTEM: 'SYSTEM' },
    eventSource,
    event_types: {
      CHAT_CHANGED: 'chat_changed',
      GENERATION_ENDED: 'generation_ended'
    },
    setExtensionPrompt() {},
    async generateRaw(request = {}) {
      prompts.push(String(request.prompt || ''));
      return {
        text: JSON.stringify({
          schema: 'recursion.utilityArbiter.v1',
          snapshotHash: request.snapshotHash,
          action: 'refresh-cards',
          sceneStatus: 'same-scene',
          cardJobs: [],
          reasonerDecision: { mode: 'skip', reason: 'rapid warm smoke', signals: [] },
          budgets: { targetBriefTokens: 500, maxCards: 6 },
          diagnostics: ['rapid-warm-smoke']
        })
      };
    }
  };
  globalThis.extension_settings = { recursion: { pipelineMode: 'rapid', mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => context };

  await globalThis.recursionOnDelete();
  assertEqual(await globalThis.recursionOnActivate(), true, 'rapid assistant-landed setup activates');
  assertEqual(eventSource.listenerCount('generation_ended'), 1, 'bootstrap subscribes to assistant-landed generation ended event');
  await eventSource.emit('generation_ended', { mesid: 1 });
  assertEqual(prompts.length, 0, 'assistant-landed event without a new assistant message does not warm Rapid');
  context.chatId = 'rapid-assistant-landed-other-chat';
  context.chat = [{ mesid: 0, is_user: false, mes: 'Existing assistant in switched chat.' }];
  await eventSource.emit('chat_changed');
  await eventSource.emit('generation_ended', { mesid: 0 });
  assertEqual(prompts.length, 0, 'assistant-landed event after chat change without a new assistant message does not warm Rapid');
  context.chat.push({ mesid: 1, is_user: true, mes: 'User asks in the switched chat.' });
  context.chat.push({ mesid: 2, is_user: false, mes: 'New assistant message landed.' });
  await eventSource.emit('generation_ended', { mesid: 2 });
  await waitUntil(
    () => prompts.some((prompt) => prompt.includes('Return a Recursion Utility Arbiter plan')),
    'assistant landing schedules Rapid warm'
  );
  await globalThis.recursionOnDelete();
  assertEqual(eventSource.listenerCount('generation_ended'), 0, 'teardown unsubscribes assistant-landed generation ended event');
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const prompts = [];
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId: 'pending-interceptor-chat',
      chat: [{ mesid: 0, is_user: false, mes: 'Committed assistant message.' }],
      extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
      extension_prompt_roles: { SYSTEM: 'SYSTEM' },
      setExtensionPrompt() {},
      async generateRaw(request = {}) {
        prompts.push(String(request.prompt || ''));
        return {
          text: JSON.stringify({
            schema: 'recursion.utilityArbiter.v1',
            action: 'skip',
            reasonerDecision: { mode: 'skip', reason: 'pending interceptor smoke', signals: [] },
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['pending-interceptor-smoke']
          })
        };
      }
    })
  };

  await globalThis.recursionOnDelete();
  const pendingChat = [
    { mesid: 0, is_user: false, mes: 'Committed assistant message.' },
    { mesid: 1, is_user: true, mes: 'Pending submitted user message.' }
  ];
  assertEqual(await globalThis.recursionGenerationInterceptor(pendingChat), pendingChat, 'pending chat interceptor returns original array');
  assert(prompts.some((prompt) => prompt.includes('Pending submitted user message.')), 'interceptor passes pending user text into runtime snapshot');
  assert(prompts.some((prompt) => prompt.includes(`User message hash: ${hashJson('Pending submitted user message.')}`)), 'interceptor passes pending user text hash into Arbiter prompt');
  await globalThis.recursionOnDelete();
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const prompts = [];
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId: 'pending-messages-array-chat',
      chat: [{ mesid: 2, is_user: false, mes: 'Committed assistant before object payload.' }],
      extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
      extension_prompt_roles: { SYSTEM: 'SYSTEM' },
      setExtensionPrompt() {},
      async generateRaw(request = {}) {
        prompts.push(String(request.prompt || ''));
        return {
          text: JSON.stringify({
            schema: 'recursion.utilityArbiter.v1',
            action: 'skip',
            reasonerDecision: { mode: 'skip', reason: 'messages array smoke', signals: [] },
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['messages-array-smoke']
          })
        };
      }
    })
  };

  await globalThis.recursionOnDelete();
  const messagesPayload = {
    messages: [
      { mesid: 2, is_user: false, mes: 'Committed assistant before object payload.' },
      { mesid: 7, is_user: true, mes: 'Pending user from raw messages array.' }
    ]
  };
  assertEqual(await globalThis.recursionGenerationInterceptor(messagesPayload), messagesPayload, 'raw messages-array interceptor returns original object');
  assert(prompts.some((prompt) => prompt.includes('Pending user from raw messages array.')), 'raw messages-array payload passes pending user text');
  assert(prompts.some((prompt) => prompt.includes(`User message hash: ${hashJson('Pending user from raw messages array.')}`)), 'raw messages-array payload passes pending user hash');
  await globalThis.recursionOnDelete();
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const prompts = [];
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId: 'assistant-tail-chat',
      chat: [
        { mesid: 0, is_user: true, mes: 'Committed user message.' },
        { mesid: 1, is_user: false, mes: 'Committed assistant reply.' }
      ],
      extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
      extension_prompt_roles: { SYSTEM: 'SYSTEM' },
      setExtensionPrompt() {},
      async generateRaw(request = {}) {
        prompts.push(String(request.prompt || ''));
        return {
          text: JSON.stringify({
            schema: 'recursion.utilityArbiter.v1',
            action: 'skip',
            reasonerDecision: { mode: 'skip', reason: 'assistant tail smoke', signals: [] },
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['assistant-tail-smoke']
          })
        };
      }
    })
  };

  await globalThis.recursionOnDelete();
  const assistantTailChat = [
    { mesid: 0, is_user: true, mes: 'Committed user message.' },
    { mesid: 1, is_user: false, mes: 'Committed assistant reply.' }
  ];
  assertEqual(await globalThis.recursionGenerationInterceptor(assistantTailChat), assistantTailChat, 'assistant-tail interceptor returns original array');
  assert(prompts.some((prompt) => prompt.includes(`User message hash: ${hashJson('')}`)), 'assistant-tail payload does not pass stale user text hash');
  assert(!prompts.some((prompt) => prompt.includes(`User message hash: ${hashJson('Committed user message.')}`)), 'assistant-tail payload does not promote prior user text as pending');
  await globalThis.recursionOnDelete();
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const prompts = [];
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId: 'provider-shaped-payload-chat',
      chat: [{ mesid: 4, is_user: false, mes: 'Committed assistant reply only.' }],
      extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
      extension_prompt_roles: { SYSTEM: 'SYSTEM' },
      setExtensionPrompt() {},
      async generateRaw(request = {}) {
        prompts.push(String(request.prompt || ''));
        return {
          text: JSON.stringify({
            schema: 'recursion.utilityArbiter.v1',
            action: 'skip',
            reasonerDecision: { mode: 'skip', reason: 'provider payload smoke', signals: [] },
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['provider-payload-smoke']
          })
        };
      }
    })
  };

  await globalThis.recursionOnDelete();
  const providerPayload = {
    messages: [
      { role: 'system', content: 'Provider system scaffold.' },
      { role: 'user', content: 'Provider-shaped user block is not raw chat.' }
    ]
  };
  assertEqual(await globalThis.recursionGenerationInterceptor(providerPayload), providerPayload, 'provider-shaped interceptor returns original object');
  assert(prompts.some((prompt) => prompt.includes(`User message hash: ${hashJson('')}`)), 'provider-shaped payload does not pass prompt-array user hash');
  assert(!prompts.some((prompt) => prompt.includes('Provider-shaped user block is not raw chat.')), 'provider-shaped payload text is not promoted into runtime snapshot');
  await globalThis.recursionOnDelete();
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}

{
  const files = new Map();
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId: 'journal-chat',
      chat: [{ mesid: 0, is_user: true, mes: 'Journal smoke user message.' }],
      extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
      extension_prompt_roles: { SYSTEM: 'SYSTEM' },
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'journal-token' }),
      setExtensionPrompt() {},
      async generateRaw() {
        return {
          providerId: 'journal-success-provider',
          model: 'journal-success-model',
          text: JSON.stringify({
            schema: 'recursion.utilityArbiter.v1',
            action: 'compose-brief',
            cardJobs: [],
            reasonerDecision: { mode: 'skip', reason: 'journal smoke', signals: [] },
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: ['journal-smoke', 'JOURNAL_SUCCESS_RESPONSE_SENTINEL']
          })
        };
      }
    })
  };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('/user/files/')) {
      const fileName = decodeURIComponent(target.slice('/user/files/'.length));
      if (!files.has(fileName)) return { ok: false, status: 404, json: async () => null };
      return { ok: true, status: 200, json: async () => files.get(fileName) };
    }
    if (target === '/api/files/upload') {
      const body = JSON.parse(String(options.body || '{}'));
      const text = Buffer.from(String(body.data || ''), 'base64').toString('utf8');
      files.set(String(body.name), JSON.parse(text));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (target === '/api/files/delete') {
      const body = JSON.parse(String(options.body || '{}'));
      const fileName = String(body.path || '').split('/').pop();
      files.delete(fileName);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => null };
  };

  await globalThis.recursionOnDelete();
  const journalSmokeChat = { payload: 'journal-smoke' };
  assertEqual(await globalThis.recursionGenerationInterceptor(journalSmokeChat), journalSmokeChat, 'journal smoke returns original object');
  await waitUntil(
    () => [...files.values()].some((file) => Array.isArray(file.entries) && file.entries.some((entry) => entry.event === 'provider.call.completed')),
    'provider model-call journal was not persisted by extension bootstrap'
  );
  const journal = [...files.values()].find((file) => Array.isArray(file.entries) && file.entries.some((entry) => entry.event === 'provider.call.completed'));
  const startedEntry = journal.entries.find((entry) => entry.event === 'provider.call.started');
  const providerEntry = journal.entries.find((entry) => entry.event === 'provider.call.completed');
  assert(startedEntry, 'provider journal records started event');
  assert(journal.entries.findIndex((entry) => entry.event === 'provider.call.started') < journal.entries.findIndex((entry) => entry.event === 'provider.call.completed'), 'provider started journal precedes completed event');
  assert(!journal.entries.some((entry) => entry.event === 'provider.call'), 'provider journal does not use obsolete generic event');
  assertEqual(startedEntry.details.roleId, 'utilityArbiter', 'provider started journal records role id');
  assert(!startedEntry.hashes.responseHash, 'provider started journal has no response hash');
  assertEqual(providerEntry.details.roleId, 'utilityArbiter', 'provider journal records role id');
  assert(providerEntry.hashes.responseHash, 'provider journal records response hash');
  assert(!JSON.stringify(providerEntry).includes('Journal smoke user message.'), 'provider journal does not persist raw transcript text');
  assert(!JSON.stringify(providerEntry).includes('JOURNAL_SUCCESS_RESPONSE_SENTINEL'), 'provider journal does not persist raw provider response text');
  await globalThis.recursionOnDelete();
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
  if (previousGlobals.fetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = previousGlobals.fetch;
}

{
  const files = new Map();
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId: 'journal-failure-chat',
      chat: [{ mesid: 0, is_user: true, mes: 'Journal failure smoke user message.' }],
      extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
      extension_prompt_roles: { SYSTEM: 'SYSTEM' },
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'journal-failure-token' }),
      setExtensionPrompt() {},
      async generateRaw() {
        return { text: 'provider failure raw text should not persist' };
      }
    })
  };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('/user/files/')) {
      const fileName = decodeURIComponent(target.slice('/user/files/'.length));
      if (!files.has(fileName)) return { ok: false, status: 404, json: async () => null };
      return { ok: true, status: 200, json: async () => files.get(fileName) };
    }
    if (target === '/api/files/upload') {
      const body = JSON.parse(String(options.body || '{}'));
      const text = Buffer.from(String(body.data || ''), 'base64').toString('utf8');
      files.set(String(body.name), JSON.parse(text));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (target === '/api/files/delete') {
      const body = JSON.parse(String(options.body || '{}'));
      const fileName = String(body.path || '').split('/').pop();
      files.delete(fileName);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => null };
  };

  await globalThis.recursionOnDelete();
  const journalFailureChat = { payload: 'journal-failure-smoke' };
  assertEqual(await globalThis.recursionGenerationInterceptor(journalFailureChat), journalFailureChat, 'journal failure smoke returns original object');
  await waitUntil(
    () => [...files.values()].some((file) => Array.isArray(file.entries) && file.entries.some((entry) => entry.event === 'provider.call.failed')),
    'provider failed-call journal was not persisted by extension bootstrap'
  );
  const journal = [...files.values()].find((file) => Array.isArray(file.entries) && file.entries.some((entry) => entry.event === 'provider.call.failed'));
  const startedEntry = journal.entries.find((entry) => entry.event === 'provider.call.started');
  const providerEntry = journal.entries.find((entry) => entry.event === 'provider.call.failed');
  assert(startedEntry, 'failed provider journal records started event');
  assert(journal.entries.findIndex((entry) => entry.event === 'provider.call.started') < journal.entries.findIndex((entry) => entry.event === 'provider.call.failed'), 'provider started journal precedes failed event');
  assert(!journal.entries.some((entry) => entry.event === 'provider.call'), 'failed provider journal does not use obsolete generic event');
  assertEqual(startedEntry.details.roleId, 'utilityArbiter', 'failed provider started journal records role id');
  assert(!startedEntry.hashes.responseHash, 'failed provider started journal has no response hash');
  assertEqual(providerEntry.details.roleId, 'utilityArbiter', 'failed provider journal records role id');
  assert(!JSON.stringify(providerEntry).includes('provider failure raw text should not persist'), 'failed provider journal does not persist raw provider text');
  assert(!JSON.stringify(providerEntry).includes('Journal failure smoke user message.'), 'failed provider journal does not persist raw transcript text');
  await globalThis.recursionOnDelete();
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
  if (previousGlobals.fetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = previousGlobals.fetch;
}

console.log('[pass] extension smoke');
