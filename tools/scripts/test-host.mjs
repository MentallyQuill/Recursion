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

const unavailablePromptHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'missing-prompt-api-chat',
    chat: [],
    extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 2, BEFORE_PROMPT: 0 },
    extension_prompt_roles: { SYSTEM: 0 }
  }),
  settingsRoot: {}
});
const unavailablePromptResult = await unavailablePromptHost.prompt.install(packet);
assertDeepEqual(
  unavailablePromptResult,
  {
    ok: false,
    error: {
      code: 'RECURSION_PROMPT_INSTALL_UNAVAILABLE',
      message: 'SillyTavern setExtensionPrompt API is unavailable.'
    }
  },
  'prompt install returns a result-shaped failure when setExtensionPrompt is unavailable'
);

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
await storageHost.storageAdapter.writeJson('recursion-after-404.v1.json', { ok: 'host' });
assert(storageFetchCalls.some((call) => call.url === '/api/files/upload' && JSON.parse(call.options.body).name === 'recursion-after-404.v1.json'), 'missing user file reads do not force memory fallback');
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

const fallbackUploadCalls = [];
const fallbackUploadHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'fallback-upload-chat',
    chat: [],
    getRequestHeaders: () => ({ 'X-CSRF-Token': 'fallback-token' })
  }),
  settingsRoot: {},
  fetchImpl: async (url, options = {}) => {
    fallbackUploadCalls.push({ url, options });
    if (url === '/api/files/upload') return { ok: false, status: 500, json: async () => ({ error: 'disk unavailable' }) };
    if (url.startsWith('/user/files/')) throw new Error('read should stay in memory after fallback');
    throw new Error(`Unexpected fallback fetch URL: ${url}`);
  }
});
assertDeepEqual(
  await fallbackUploadHost.storageAdapter.writeJson('recursion-fallback-upload.v1.json', { fallback: true }),
  { ok: true, key: 'recursion-fallback-upload.v1.json', fallback: 'memory' },
  'default storage downgrades failed uploads to memory storage'
);
assertDeepEqual(
  await fallbackUploadHost.storageAdapter.readJson('recursion-fallback-upload.v1.json'),
  { fallback: true },
  'default storage reads fallback writes from memory without user-file API'
);
assert(!fallbackUploadCalls.some((call) => call.url.startsWith('/user/files/')), 'fallback storage skips user-file reads after upload failure');
const fallbackUploadCallCountBeforeRejectedKeys = fallbackUploadCalls.length;
await assertRejects(
  async () => fallbackUploadHost.storageAdapter.writeJson('../recursion-fallback-escape.v1.json', { ok: false }),
  /path traversal/i,
  'fallback storage rejects traversal keys before memory fallback'
);
await assertRejects(
  async () => fallbackUploadHost.storageAdapter.readJson('recursion-fallback-not-json.txt'),
  /\.json/i,
  'fallback storage rejects non-json keys before memory fallback'
);
assertEqual(fallbackUploadCalls.length, fallbackUploadCallCountBeforeRejectedKeys, 'fallback storage rejects unsafe keys without extra fetch');

const fallbackThrownUploadCalls = [];
const fallbackThrownUploadHost = createSillyTavernHost({
  contextFactory: () => ({ chatId: 'fallback-thrown-upload-chat', chat: [] }),
  settingsRoot: {},
  fetchImpl: async (url, options = {}) => {
    fallbackThrownUploadCalls.push({ url, options });
    throw new Error('simulated user-file API outage');
  }
});
const circularStorageValue = {};
circularStorageValue.self = circularStorageValue;
await assertRejects(
  async () => fallbackThrownUploadHost.storageAdapter.writeJson('recursion-unserializable.v1.json', circularStorageValue),
  /circular|converting/i,
  'default storage rejects JSON serialization errors before user-file fallback'
);
await assertRejects(
  async () => fallbackThrownUploadHost.storageAdapter.writeJson('recursion-undefined-value.v1.json', undefined),
  /json-serializable/i,
  'default storage rejects top-level undefined before user-file fallback'
);
await assertRejects(
  async () => fallbackThrownUploadHost.storageAdapter.writeJson('recursion-function-value.v1.json', () => {}),
  /json-serializable/i,
  'default storage rejects top-level functions before user-file fallback'
);
await assertRejects(
  async () => fallbackThrownUploadHost.storageAdapter.writeJson('recursion-symbol-value.v1.json', Symbol('storage')),
  /json-serializable/i,
  'default storage rejects top-level symbols before user-file fallback'
);
assertEqual(fallbackThrownUploadCalls.length, 0, 'default storage does not fetch when JSON serialization fails');
assertDeepEqual(
  await fallbackThrownUploadHost.storageAdapter.writeJson('recursion-fallback-thrown-upload.v1.json', { outage: true }),
  { ok: true, key: 'recursion-fallback-thrown-upload.v1.json', fallback: 'memory' },
  'default storage downgrades thrown upload failures to memory storage'
);
assertDeepEqual(
  await fallbackThrownUploadHost.storageAdapter.readJson('recursion-fallback-thrown-upload.v1.json'),
  { outage: true },
  'default storage reads memory value after thrown upload fallback'
);
assertEqual(fallbackThrownUploadCalls.length, 1, 'default storage avoids failing user-file API after thrown upload fallback');

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

const quietProfileHost = createSillyTavernHost({
  contextFactory: () => ({
    currentChatId: 'quiet-profile-chat',
    chat: [],
    generateQuietPrompt: async () => 'quiet profile text'
  }),
  settingsRoot: {
    recursion: {
      providers: {
        utility: {
          source: 'host-connection-profile',
          hostConnectionProfileId: 'quiet-profile-a'
        }
      }
    }
  }
});
const quietProfileResult = await createGenerationRouter({ client: quietProfileHost.providerClient }).generate('utilityArbiter', { prompt: 'Profile should not silently fall back.' });
assertEqual(quietProfileResult.ok, false, 'host profile route fails when only quiet generation is available');
assertEqual(quietProfileResult.error.code, 'RECURSION_HOST_PROFILE_UNSUPPORTED', 'host profile route reports unsupported API instead of current-model fallback');

const connectionProfileCalls = [];
const connectionProfileSignal = new AbortController().signal;
const connectionProfileHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'connection-profile-chat',
    chat: [],
    ConnectionManagerRequestService: {
      async sendRequest(profileId, messages, maxTokens, requestOptions, parameters) {
        connectionProfileCalls.push({ profileId, messages, maxTokens, requestOptions, parameters });
        return { text: '{"schema":"recursion.host.connectionProfile","ok":true}' };
      }
    }
  }),
  settingsRoot: {
    recursion: {
      providers: {
        utility: {
          source: 'host-connection-profile',
          hostConnectionProfileId: 'utility-profile-service',
          maxTokens: 512,
          temperature: 0.15,
          topP: 0.7
        }
      }
    }
  }
});
const connectionProfileResult = await createGenerationRouter({ client: connectionProfileHost.providerClient }).generate('utilityArbiter', {
  prompt: 'Use profile service.',
  systemPrompt: 'System profile service.',
  signal: connectionProfileSignal
});
assertEqual(connectionProfileResult.ok, true, 'host connection profile routes through ConnectionManagerRequestService when available');
assertEqual(connectionProfileCalls[0].profileId, 'utility-profile-service', 'connection profile service receives profile id');
assertDeepEqual(
  connectionProfileCalls[0].messages,
  [
    { role: 'system', content: 'System profile service.' },
    { role: 'user', content: 'Use profile service.' }
  ],
  'connection profile service receives system and user messages'
);
assertEqual(connectionProfileCalls[0].maxTokens, 512, 'connection profile service receives configured max tokens');
assertEqual(connectionProfileCalls[0].requestOptions.stream, false, 'connection profile service disables streaming for structured calls');
assertEqual(connectionProfileCalls[0].requestOptions.extractData, true, 'connection profile service requests extracted data');
assertEqual(connectionProfileCalls[0].parameters.temperature, 0.15, 'connection profile service receives configured temperature');
assertEqual(connectionProfileCalls[0].parameters.top_p, 0.7, 'connection profile service receives configured top p');
assert(typeof connectionProfileCalls[0].parameters.signal?.addEventListener === 'function', 'connection profile service receives abort-capable provider signal');
assertEqual(connectionProfileCalls[0].parameters.signal.aborted, false, 'connection profile service receives active provider signal');

const currentModelRawCalls = [];
const currentModelProfileCalls = [];
const currentModelHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'current-model-stale-profile-chat',
    chat: [],
    generateRaw: async (request) => {
      currentModelRawCalls.push(request);
      return { text: '{"schema":"recursion.host.currentModel","ok":true}' };
    },
    ConnectionManagerRequestService: {
      async sendRequest(profileId, messages, maxTokens, requestOptions, parameters) {
        currentModelProfileCalls.push({ profileId, messages, maxTokens, requestOptions, parameters });
        return { text: '{"schema":"recursion.host.unexpectedProfile","ok":true}' };
      }
    }
  }),
  settingsRoot: {
    recursion: {
      providers: {
        utility: {
          source: 'host-current-model',
          hostConnectionProfileId: 'stale-utility-profile',
          maxTokens: 654,
          temperature: 0.33,
          topP: 0.8
        }
      }
    }
  }
});
const currentModelRouted = await createGenerationRouter({ client: currentModelHost.providerClient }).generate('utilityArbiter', { prompt: 'Use current model.' });
assertEqual(currentModelRouted.ok, true, 'host current model routes successfully with stale profile id');
assertEqual(currentModelProfileCalls.length, 0, 'host current model does not call connection profile service with stale profile id');
assertEqual(currentModelRawCalls.length, 1, 'host current model uses generateRaw when available');
assertEqual(currentModelRawCalls[0].providerSource, 'host-current-model', 'host current model source is passed to generateRaw');
assertEqual(
  Object.prototype.hasOwnProperty.call(currentModelRawCalls[0], 'hostConnectionProfileId'),
  false,
  'host current model generateRaw request omits stale profile id'
);

const stableSceneMessages = [{ mesid: 1, is_user: true, mes: 'First turn in the same scene.' }];
const stableSceneHost = createSillyTavernHost({
  contextFactory: () => ({
    chatId: 'stable-scene-chat',
    chat: stableSceneMessages
  }),
  settingsRoot: {}
});
const firstStableScene = await stableSceneHost.snapshot();
stableSceneMessages.push({ mesid: 2, is_user: false, mes: 'Second turn without a scene break.' });
const secondStableScene = await stableSceneHost.snapshot();
assertEqual(secondStableScene.chatKey, firstStableScene.chatKey, 'stable scene regression keeps chat key');
assertEqual(secondStableScene.sceneKey, firstStableScene.sceneKey, 'ordinary new messages reuse the same scene cache key');
assert(secondStableScene.turnFingerprint !== firstStableScene.turnFingerprint, 'turn fingerprint still changes across messages');

const metadataChatHost = createSillyTavernHost({
  contextFactory: () => ({
    chatMetadata: { chat_id: 'Metadata/Chat File.jsonl' },
    chat: []
  }),
  settingsRoot: {}
});
const metadataChatSnapshot = await metadataChatHost.snapshot();
assertEqual(metadataChatSnapshot.chatId, 'Metadata/Chat File.jsonl', 'chatMetadata chat_id is used when direct chat id is missing');
assertEqual(metadataChatSnapshot.chatKey, 'Metadata-Chat-File.jsonl', 'metadata chat id is normalized into chat key');

const entitySceneContext = {
  chatId: 'entity-scene-chat',
  characterId: 'character-a',
  chat: [{ mesid: 1, is_user: true, mes: 'Scene anchor test.' }]
};
const entitySceneHost = createSillyTavernHost({
  contextFactory: () => entitySceneContext,
  settingsRoot: {}
});
const firstEntityScene = await entitySceneHost.snapshot();
entitySceneContext.characterId = 'character-b';
const secondEntityScene = await entitySceneHost.snapshot();
assertEqual(secondEntityScene.chatKey, firstEntityScene.chatKey, 'entity scene anchor keeps chat key stable');
assert(secondEntityScene.sceneFingerprint !== firstEntityScene.sceneFingerprint, 'entity change updates host scene fingerprint');
assert(secondEntityScene.sceneKey !== firstEntityScene.sceneKey, 'entity change updates host scene cache key');

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
