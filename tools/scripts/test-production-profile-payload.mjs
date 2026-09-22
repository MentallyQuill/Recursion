import { createProviderClient } from '../../src/providers.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

const calls = [];
const profile = { id: 'nano', name: 'Nano', api: 'nanogpt', model: 'deepseek/deepseek-latest' };
const settingsStore = createSettingsStore({ root: { recursion: { providers: {
  utility: { connectionProfileId: 'nano', outputTokenCeiling: 16000 },
  reasoner: { connectionProfileId: 'nano', outputTokenCeiling: 16000 }
} } } });
const host = createSillyTavernHost({
  contextFactory: () => ({ ConnectionManagerRequestService: {
    getSupportedProfiles: () => [profile], getProfile: () => profile,
    validateProfile: () => ({ selected: 'openai', source: 'nanogpt' }),
    async sendRequest(id, messages, maxTokens, options, overrides) {
      calls.push({ maxTokens, ...overrides });
      return { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] };
    }
  } }),
  settingsRoot: {}, fetchImpl: null, secretMetadataFactory: () => null
});
const client = createProviderClient({ host, settingsStore });
for (const roleId of ['utilityArbiter', 'sceneFrameCard', 'knowledgeSecretsCard', 'fusedCardBundle', 'guidanceComposer']) {
  await client.generate(roleId, { lane: 'utility', prompt: 'Return JSON' });
  assertEqual(calls.at(-1).maxTokens, 16000, `${roleId} reaches Connection Manager with configured allowance`);
  assertEqual(calls.at(-1).reasoning_effort, 'min', `${roleId} reaches NanoGPT adapter with reasoning off`);
  assertEqual(calls.at(-1).include_reasoning, false, `${roleId} overrides inherited reasoning inclusion`);
}
await client.generate('guidanceComposer', { lane: 'reasoner', prompt: 'Return JSON', reasoningIntent: 'medium' });
assertEqual(calls.at(-1).reasoning_effort, 'high', 'explicit reasoner effort survives the full transport path');
await client.generate('sceneFrameCard', { lane: 'utility', prompt: 'Return JSON', responseLength: 1200 });
assertEqual(calls.at(-1).maxTokens, 1200, 'explicit bounded probe remains bounded');
console.log('[pass] production profile payload');
