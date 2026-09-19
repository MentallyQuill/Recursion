import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { profileSecretOverride } from '../../src/hosts/sillytavern/profile-secrets.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

const profiles = Object.freeze([
  Object.freeze({ id: 'nano', model: 'nano-model', api: 'nanogpt', 'secret-id': 'deleted' }),
  Object.freeze({ id: 'text', model: 'local-model', api: 'text', 'secret-id': 'deleted-text' })
]);
let metadata = {
  SECRET_KEYS: { NANOGPT: 'nano-keys', OOBA: 'text-keys', OPENAI: 'other-keys' },
  chatSources: { NANOGPT: 'nanogpt', OPENAI: 'openai' },
  textTypes: { OOBA: 'ooba' },
  secret_state: {
    'nano-keys': [{ id: 'active-nano', active: true }],
    'text-keys': [{ id: 'active-text', active: true }],
    'other-keys': [{ id: 'other-provider', active: true }]
  }
};
const calls = [];
const service = {
  getSupportedProfiles: () => profiles,
  getProfile: id => profiles.find(p => p.id === id),
  validateProfile: p => p.api === 'text'
    ? { selected: 'textgenerationwebui', type: 'ooba' }
    : { selected: 'openai', source: p.api },
  async sendRequest(id, messages, maxTokens, options, overrides) {
    // Match the host service's profile-then-override precedence.
    const payload = { secret_id: this.getProfile(id)['secret-id'], ...overrides };
    calls.push({ id, payload, options });
    await Promise.resolve();
    return { choices: [{ message: { content: '{}' } }] };
  }
};
const host = createSillyTavernHost({
  contextFactory: () => ({ ConnectionManagerRequestService: service }),
  settingsRoot: {}, fetchImpl: null,
  secretMetadataFactory: async () => metadata
});
const controller = new AbortController();
const generate = id => host.generation.generate({
  connectionProfileId: id, prompt: 'Return JSON', signal: controller.signal
});

const responses = await Promise.all([generate('nano'), generate('text')]);
assertEqual(calls[0].payload.secret_id, 'active-nano', 'missing chat key uses active key from same provider');
assertEqual(calls[1].payload.secret_id, 'active-text', 'text key uses text provider mapping');
assertEqual(calls[0].options.signal, controller.signal, 'fallback preserves cancellation');
assertEqual(profiles[0]['secret-id'], 'deleted', 'fallback never rewrites shared profile');
assertEqual(JSON.stringify(responses).includes('active-nano'), false, 'key identifiers stay out of result metadata');

metadata.secret_state['nano-keys'].push({ id: 'deleted', active: false });
await generate('nano');
assertEqual(calls.at(-1).payload.secret_id, 'deleted', 'existing explicitly selected key wins over active key');
metadata.secret_state['nano-keys'] = [{ id: 'inactive', active: false }];
await generate('nano');
assertEqual(calls.at(-1).payload.secret_id, 'deleted', 'no active same-provider key never borrows another provider key');
metadata.secret_state['nano-keys'] = true;
await generate('nano');
assertEqual(calls.at(-1).payload.secret_id, 'deleted', 'unknown metadata cannot establish a missing key');
metadata = null;
await generate('nano');
assertEqual(calls.at(-1).payload.secret_id, 'deleted', 'unavailable metadata preserves host behavior');

assertEqual(Object.keys(await profileSecretOverride(profiles[0], service.validateProfile(profiles[0]), async () => {
  throw new Error('metadata unavailable');
})).length, 0, 'metadata read failure preserves host request');
assertEqual(Object.keys(await profileSecretOverride({ id: 'no-key' }, { selected: 'openai', source: 'nanogpt' }, () => {
  throw new Error('should not inspect keys without an explicit reference');
})).length, 0, 'profile without a key already uses host default');

metadata = {
  SECRET_KEYS: { NANOGPT: 'nano-keys' }, chatSources: { NANOGPT: 'nanogpt' },
  secret_state: { 'nano-keys': [{ id: 'replacement', active: true }] }
};
await generate('nano');
assertEqual(calls.at(-1).payload.secret_id, 'replacement', 'key rotation is observed on the next request');
const originalSend = service.sendRequest;
let failedCalls = 0;
service.sendRequest = async () => { failedCalls++; throw new Error('Unauthorized'); };
try { await generate('nano'); } catch (error) {
  assertEqual(error.message, 'Unauthorized', 'provider failure propagates');
}
assertEqual(failedCalls, 1, 'authentication failure does not cycle through other keys');
service.sendRequest = originalSend;

console.log('[pass] profile secret fallback');
