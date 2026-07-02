import { assert, assertEqual } from '../../tests/helpers/assert.mjs';
import { hashJson } from '../../src/core.mjs';

const RECURSION_PROMPT_KEYS = [
  'recursion.sceneBrief',
  'recursion.turnBrief',
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
  const fake = {
    promptWrites,
    promptState,
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
    assert(delayedContext.extensionSettings.recursion.cardScope, 'deferred bootstrap normalizes loaded settings in place');
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
  await eventSource.emit('message_updated', 0);
  const cleanupWrites = fake.promptWrites.slice(clearStart);
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(
      cleanupWrites.some((entry) => entry.key === key && entry.text === ''),
      `source-change event clears ${key}`
    );
    assertEqual(fake.promptState.get(key), '', `source-change event leaves ${key} empty`);
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
