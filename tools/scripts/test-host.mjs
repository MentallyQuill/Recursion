import { createSillyTavernHost, promptBlocksFromPacket } from '../../src/hosts/sillytavern/host.mjs';
import { createGenerationRouter } from '../../src/providers.mjs';
import { assert, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

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
