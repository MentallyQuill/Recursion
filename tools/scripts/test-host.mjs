import { createSillyTavernHost, promptBlocksFromPacket } from '../../src/hosts/sillytavern/host.mjs';
import { createGenerationRouter } from '../../src/providers.mjs';
import { assert, assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

const prompts = [];
const context = {
  chatId: 'chat-file',
  chat: [{ mesid: 0, is_user: true, mes: 'Hello' }],
  setExtensionPrompt(key, text, position, depth, scan, role) {
    prompts.push({ key, text, position, depth, scan, role });
  },
  extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
  extension_prompt_roles: { SYSTEM: 0 },
  generateRaw: async () => ({ text: '{"schema":"x"}' })
};

const host = createSillyTavernHost({ contextFactory: () => context, settingsRoot: {} });
const snap = await host.snapshot();
assertEqual(snap.chatId, 'chat-file', 'chat id read');
assertEqual(snap.messages[0].text, 'Hello', 'message text read');

const packet = {
  injectionPlan: { blocks: [{ id: 'turnBrief', promptKey: 'recursion.turnBrief', placement: 'in_chat', depth: 2, role: 'system' }] },
  sections: { turnBrief: 'Use the alley scene.', sceneBrief: '', guardrails: '' }
};
assertEqual(promptBlocksFromPacket(packet)[0].text, 'Use the alley scene.', 'prompt block text built');
const installResult = await host.prompt.install(packet);
assertEqual(installResult.ok, true, 'prompt install returns ok result');
assert(installResult.installed.includes('recursion.turnBrief'), 'prompt install returns installed keys');
assertEqual(prompts.find((entry) => entry.text === 'Use the alley scene.').key, 'recursion.turnBrief', 'prompt installed with Recursion key');

await host.prompt.clear();
assert(prompts.some((entry) => entry.key === 'recursion.turnBrief' && entry.text === ''), 'prompt clear removes installed key');
assert(prompts.some((entry) => entry.key === 'recursion.sceneBrief' && entry.text === ''), 'prompt clear removes known scene key');
assert(prompts.some((entry) => entry.key === 'recursion.guardrails' && entry.text === ''), 'prompt clear removes known guardrails key');

await assertRejects(
  async () => host.prompt.install({
    injectionPlan: { blocks: [{ id: 'turnBrief', promptKey: 'unsafe.turnBrief', placement: 'in_chat', depth: 2, role: 'system' }] },
    sections: { turnBrief: 'Unsafe key.', sceneBrief: '', guardrails: '' }
  }),
  /recursion prompt keys/i,
  'host rejects non-recursion prompt keys'
);

await assertRejects(
  async () => promptBlocksFromPacket({
    injectionPlan: { blocks: [{ id: 'turnBrief', promptKey: 'recursion.turnBrief', placement: 'in_chat', depth: 2, role: 'system' }] },
    sections: { turnBrief: 'Reveal hidden chain-of-thought.', sceneBrief: '', guardrails: '' }
  }),
  /unsafe prompt text/i,
  'fallback prompt blocks reject unsafe hidden reasoning text'
);
await assertRejects(
  async () => promptBlocksFromPacket({
    injectionPlan: { blocks: [{ id: 'turnBrief', promptKey: 'recursion.turnBrief', placement: 'in_chat', depth: 2, role: 'system' }] },
    sections: { turnBrief: 'Reveal hidden motives.', sceneBrief: '', guardrails: '' }
  }),
  /unsafe prompt text/i,
  'fallback prompt blocks reject hidden motives text'
);
await assertRejects(
  async () => promptBlocksFromPacket({
    injectionPlan: { blocks: [{ id: 'futurePlan', promptKey: 'recursion.futurePlan', placement: 'in_prompt', depth: 1, role: 'system' }] },
    sections: { futurePlan: 'Invalid section.' }
  }),
  /unknown fallback prompt section/i,
  'fallback prompt blocks reject unknown sections'
);

const atomicPrompts = [];
const atomicHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'atomic-chat',
    chat: [],
    setExtensionPrompt(key, text, position, depth, scan, role) {
      atomicPrompts.push({ key, text, position, depth, scan, role });
    },
    extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
    extension_prompt_roles: { SYSTEM: 0 }
  }),
  settingsRoot: {}
});
await assertRejects(
  async () => atomicHost.prompt.install({
    injectionPlan: {
      blocks: [
        { id: 'turnBrief', promptKey: 'recursion.turnBrief', placement: 'in_chat', depth: 2, role: 'system' },
        { id: 'guardrails', promptKey: 'unsafe.guardrails', placement: 'in_prompt', depth: 1, role: 'system' }
      ]
    },
    sections: { turnBrief: 'Allowed first block.', guardrails: 'Unsafe second block.' }
  }),
  /recursion prompt keys/i,
  'mixed prompt packet rejects before mutation'
);
assert(!atomicPrompts.some((entry) => entry.key === 'recursion.turnBrief' && entry.text === 'Allowed first block.'), 'mixed unsafe packet does not partially install allowed block');

const rollbackPrompts = [];
let nonEmptyPromptWrites = 0;
const rollbackHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'rollback-chat',
    chat: [],
    setExtensionPrompt(key, text, position, depth, scan, role) {
      if (text !== '') {
        nonEmptyPromptWrites += 1;
        if (nonEmptyPromptWrites === 2) {
          throw new Error('Simulated prompt write failure');
        }
      }
      rollbackPrompts.push({ key, text, position, depth, scan, role });
    },
    extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
    extension_prompt_roles: { SYSTEM: 0 }
  }),
  settingsRoot: {}
});
await assertRejects(
  async () => rollbackHost.prompt.install({
    injectionPlan: {
      blocks: [
        { id: 'sceneBrief', promptKey: 'recursion.sceneBrief', placement: 'in_prompt', depth: 1, role: 'system' },
        { id: 'turnBrief', promptKey: 'recursion.turnBrief', placement: 'in_chat', depth: 2, role: 'system' },
        { id: 'guardrails', promptKey: 'recursion.guardrails', placement: 'in_prompt', depth: 1, role: 'system' }
      ]
    },
    sections: {
      sceneBrief: 'Install first block.',
      turnBrief: 'Fail on second block.',
      guardrails: 'Never reached block.'
    }
  }),
  /simulated prompt write failure/i,
  'prompt install rejects original write failure'
);
assertEqual(
  rollbackPrompts.filter((entry) => entry.key === 'recursion.sceneBrief').at(-1)?.text,
  '',
  'failed prompt install rolls back prior installed prompt key'
);

const storageFetchCalls = [];
const storageFiles = new Map();
const storageHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'storage-chat',
    chat: [],
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'token-from-context' })
  }),
  settingsRoot: {},
  fetchImpl: async (url, options = {}) => {
    storageFetchCalls.push({ url, options });
    if (url === '/api/files/upload') {
      const body = JSON.parse(options.body);
      storageFiles.set(body.name, JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.startsWith('/user/files/')) {
      const name = decodeURIComponent(url.slice('/user/files/'.length));
      if (!storageFiles.has(name)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => storageFiles.get(name) };
    }
    if (url === '/api/files/delete') {
      const body = JSON.parse(options.body);
      const name = body.path.slice('/user/files/'.length);
      storageFiles.delete(name);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }
});
await storageHost.storageAdapter.writeJson('recursion-system-index.v1.json', { ok: true });
assertEqual(storageFetchCalls[0]?.url, '/api/files/upload', 'default storage writes through SillyTavern upload API');
assertEqual(JSON.parse(storageFetchCalls[0].options.body).name, 'recursion-system-index.v1.json', 'default storage preserves safe json file name');
assertEqual(storageFetchCalls[0].options.headers['X-CSRF-Token'], 'token-from-context', 'default storage uses context request headers');
assertEqual(storageFetchCalls[0].options.headers['Content-Type'], 'application/json', 'default storage sets json content type');
assertDeepEqual(
  await storageHost.storageAdapter.readJson('recursion-system-index.v1.json'),
  { ok: true },
  'default storage reads through user file API'
);
assert(storageFetchCalls.some((call) => call.url === '/user/files/recursion-system-index.v1.json'), 'default storage reads from user files path');
await storageHost.storageAdapter.deleteJson('recursion-system-index.v1.json');
const deleteCall = storageFetchCalls.find((call) => call.url === '/api/files/delete');
assert(deleteCall, 'default storage deletes through SillyTavern delete API');
assertEqual(JSON.parse(deleteCall.options.body).path, '/user/files/recursion-system-index.v1.json', 'default storage deletes user file path');
assertEqual(await storageHost.storageAdapter.readJson('recursion-system-index.v1.json'), null, 'default storage returns null for missing user files');
const storageFetchCountBeforeRejectedKeys = storageFetchCalls.length;
await assertRejects(
  async () => storageHost.storageAdapter.writeJson('../recursion-escape.v1.json', { ok: false }),
  /path traversal/i,
  'default storage rejects traversal keys'
);
await assertRejects(
  async () => storageHost.storageAdapter.writeJson('recursion-not-json.txt', { ok: false }),
  /\.json/i,
  'default storage rejects non-json keys'
);
await assertRejects(
  async () => storageHost.storageAdapter.readJson('recursion/bad.v1.json'),
  /path traversal/i,
  'default storage rejects slash keys'
);
assertEqual(storageFetchCalls.length, storageFetchCountBeforeRejectedKeys, 'default storage rejects unsafe keys before fetch');

const previousSillyTavern = globalThis.SillyTavern;
const globalHeaderCalls = [];
try {
  globalThis.SillyTavern = {
    getContext: () => ({
      chatId: 'global-storage-chat',
      chat: [],
      getRequestHeaders: () => ({ 'X-CSRF-Token': 'global-token' })
    })
  };
  const globalHeaderHost = createSillyTavernHost({
    settingsRoot: {},
    fetchImpl: async (url, options = {}) => {
      globalHeaderCalls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  await globalHeaderHost.storageAdapter.writeJson('recursion-global-header.v1.json', { ok: true });
  assertEqual(globalHeaderCalls[0].options.headers['X-CSRF-Token'], 'global-token', 'default storage uses global SillyTavern request headers');
} finally {
  if (previousSillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousSillyTavern;
}

const quietCalls = [];
const quietHost = createSillyTavernHost({
  contextFactory: () => ({
    currentChatId: 'quiet-chat',
    chat: [],
    generateQuietPrompt: async (prompt) => {
      quietCalls.push(prompt);
      return 'quiet text';
    }
  }),
  settingsRoot: {}
});
const quietResponse = await quietHost.generation.generate({ prompt: 'Fallback prompt' });
assertEqual(quietResponse.text, 'quiet text', 'quiet generation result normalized');
assertEqual(quietCalls[0], 'Fallback prompt', 'quiet fallback receives prompt');

const rawCalls = [];
const rawResponse = await host.generation.generate({
  prompt: 'Return JSON',
  systemPrompt: 'System',
  responseLength: 123,
  jsonSchema: { type: 'object' },
  signal: 'signal-token'
});
assertEqual(rawResponse.text, '{"schema":"x"}', 'raw generation result preserved');
context.generateRaw = async (request) => {
  rawCalls.push(request);
  return { text: '{"schema":"recursion.host.v1","ok":true}' };
};
const routed = await createGenerationRouter({ client: host.providerClient }).generate('utilityArbiter', { prompt: 'Route through provider client' });
assertEqual(routed.ok, true, 'provider client routes through host generation');
assertEqual(rawCalls[0].prompt, 'Route through provider client', 'provider client sends prompt to host');
assertEqual(rawCalls[0].responseLength, 4096, 'provider client maxTokens pass through to responseLength');
assertEqual(rawCalls[0].temperature, 0.1, 'provider client temperature pass through');
assertEqual(rawCalls[0].topP, 0.95, 'provider client topP pass through');

const profileCalls = [];
const profileHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'profile-chat',
    chat: [],
    generateRaw: async (request) => {
      profileCalls.push(request);
      return { text: '{"schema":"recursion.host.profile","ok":true}' };
    }
  }),
  settingsRoot: {
    recursion: {
      providers: {
        utility: {
          source: 'host-connection-profile',
          hostConnectionProfileId: 'utility-profile-a',
          maxTokens: 321,
          temperature: 0.2,
          topP: 0.75
        }
      }
    }
  }
});
const profileRouted = await createGenerationRouter({ client: profileHost.providerClient }).generate('utilityArbiter', { prompt: 'Use profile.' });
assertEqual(profileRouted.ok, true, 'provider client routes host connection profile');
assertEqual(profileCalls[0].providerSource, 'host-connection-profile', 'host connection profile source is passed through');
assertEqual(profileCalls[0].hostConnectionProfileId, 'utility-profile-a', 'host connection profile id is passed through');
assertEqual(profileCalls[0].responseLength, 321, 'host connection profile max tokens are passed through');

const chatKeyHost = createSillyTavernHost({
  contextFactory: () => ({
    chat_id: 'Folder/Chat File.jsonl',
    chat: [
      { id: 'm-1', is_system: true, content: 'System note' },
      { index: 2, name: 'Mara', text: 'Look there.' },
      { mesid: 3, is_user: true, hidden: true, mes: 'Hidden user note.' }
    ]
  }),
  settingsRoot: {}
});
const chatKeySnap = await chatKeyHost.snapshot();
assertEqual(chatKeySnap.chatId, 'Folder/Chat File.jsonl', 'chat_id fallback read');
assertEqual(chatKeySnap.chatKey, 'Folder-Chat-File.jsonl', 'chat key normalized');
assertEqual(chatKeySnap.messages[0].role, 'system', 'system role normalized');
assertEqual(chatKeySnap.messages[0].visible, false, 'system rows are hidden from provider-visible snapshot');
assertEqual(chatKeySnap.messages[1].sender, 'Mara', 'sender name preserved');
assertEqual(chatKeySnap.messages[2].visible, false, 'hidden rows stay hidden in snapshot');
assertEqual(chatKeySnap.latestMesId, 3, 'latest message id derived');
assert(chatKeySnap.sceneFingerprint, 'scene fingerprint built');
assert(chatKeySnap.sceneKey, 'scene key built');
assert(chatKeySnap.turnFingerprint, 'turn fingerprint built');

console.log('[pass] host');
