import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

let payload;
const host = createSillyTavernHost({
  contextFactory: () => ({ ConnectionManagerRequestService: {
    getSupportedProfiles: () => [],
    getProfile: id => ({ id, model: id === 'modern-openai' ? 'gpt-5.6' : id === 'older-gpt5' ? 'gpt-5' : 'model',
      api: ['modern-openai', 'older-gpt5'].includes(id) ? 'openai' : id }),
    validateProfile: p => p.api === 'text'
      ? { selected: 'textgenerationwebui', type: 'ooba' }
      : { selected: 'openai', source: p.api },
    async sendRequest(id, messages, tokens, options, overrides) {
      payload = overrides;
      return { choices: [{ message: { content: '{}' } }] };
    }
  } }),
  settingsRoot: {}, fetchImpl: null, secretMetadataFactory: () => null
});
for (const [api, intent, expected] of [
  ['nanogpt', 'none', 'min'], ['openai', 'none', 'low'], ['openrouter', 'none', 'none'],
  ['modern-openai', 'none', 'none'], ['older-gpt5', 'none', 'min'],
  ['nanogpt', 'minimal', 'low'], ['nanogpt', 'medium', 'high'],
  ['nanogpt', 'high', 'max'], ['openai', 'minimal', 'min'],
  ['openai', 'medium', 'medium'], ['openai', 'high', 'high'],
  ['text', 'minimal', undefined], ['nanogpt', undefined, undefined]
]) {
  await host.generation.generate({ connectionProfileId: api, prompt: 'Return JSON', reasoningIntent: intent });
  assertEqual(payload.reasoning_effort, expected, `${api} forwards ${intent} using the host effort vocabulary`);
  if (intent === 'none') assertEqual(payload.include_reasoning, false, 'reasoning off overrides inherited reasoning flags');
}
console.log('[pass] profile reasoning controls');
