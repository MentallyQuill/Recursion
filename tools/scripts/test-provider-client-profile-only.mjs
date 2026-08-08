import { createProviderClient } from '../../src/providers.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const profile = {
  id: 'profile-a',
  name: 'Local Model',
  model: 'qwen3',
  label: 'Local Model / qwen3',
  api: 'textgenerationwebui',
  completionMode: 'text',
  presetName: 'Precise',
  instructName: 'ChatML'
};
const root = {
  recursion: {
    providers: {
      utility: { connectionProfileId: 'profile-a' },
      reasoner: { connectionProfileId: 'profile-a' }
    }
  }
};
const settingsStore = createSettingsStore({ root, save: () => {} });
const calls = [];
let hostBatchCalls = 0;
const host = {
  providerProfiles: {
    list() {
      return [profile];
    }
  },
  generation: {
    async generate(request) {
      calls.push(request);
      return { raw: '{"schema":"recursion.providerTest.v1","ok":true}', model: 'qwen3' };
    },
    async batch() {
      hostBatchCalls += 1;
      return [];
    }
  }
};
const client = createProviderClient({
  host,
  settingsStore,
  fetchImpl() {
    throw new Error('direct HTTP transport must not run');
  }
});

const result = await client.generate('providerTest', {
  lane: 'utility',
  prompt: 'Return the test object.'
});
assertEqual(JSON.parse(result.text).ok, true, 'profile response is normalized');
assertEqual(calls.length, 1, 'host profile generation is used');
assertEqual(calls[0].connectionProfileId, 'profile-a', 'selected profile id is attached');
assertEqual(calls[0].providerConfig.connectionProfileId, 'profile-a', 'provider config uses profile contract');
assertEqual(Object.hasOwn(calls[0], 'providerSource'), false, 'provider source is absent');
assertEqual(calls[0].providerConfig.generationPolicy.presetMode, 'isolated', 'behavioral preset isolation is explicit');
assertEqual(Object.hasOwn(client, 'fetchModels'), false, 'direct model discovery is absent');

const slots = [];
const batch = await client.batch([
  { roleId: 'providerTest', request: { lane: 'utility', prompt: 'One.' } },
  { roleId: 'providerTest', request: { lane: 'utility', prompt: 'Two.' } }
], {
  onSlotSettled(slot) {
    slots.push(slot.index);
  }
});
assertEqual(batch.length, 2, 'logical batch returns two slots');
assertDeepEqual(slots.sort(), [0, 1], 'logical batch settles each slot');
assertEqual(hostBatchCalls, 0, 'provider client never uses host batch');

const status = client.status('utility');
assertEqual(status.profileId, 'profile-a', 'status resolves selected profile');
assertEqual(status.completionMode, 'text', 'status exposes completion mode');
assertEqual(status.label, 'Local Model / qwen3', 'status exposes safe display label');
assert(!JSON.stringify(status).includes('http'), 'status contains no endpoint');

console.log('[pass] provider client profile only');

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
const queueRelease = deferred();
let activeProfileCalls = 0;
let peakProfileCalls = 0;
let queueCallCount = 0;
const queuedClient = createProviderClient({
  settingsStore,
  host: {
    providerProfiles: host.providerProfiles,
    generation: {
      async generate(request) {
        queueCallCount += 1;
        activeProfileCalls += 1;
        peakProfileCalls = Math.max(peakProfileCalls, activeProfileCalls);
        if (queueCallCount === 1) await queueRelease.promise;
        activeProfileCalls -= 1;
        return { raw: '{"schema":"recursion.providerTest.v1","ok":true}', model: request.connectionProfileId };
      }
    }
  }
});
const queuedFirst = queuedClient.generate('providerTest', { lane: 'utility', prompt: 'First.' });
const queuedSecond = queuedClient.generate('providerTest', { lane: 'utility', prompt: 'Second.' });
await new Promise((resolve) => setTimeout(resolve, 0));
assertEqual(peakProfileCalls, 1, 'same-profile provider client calls serialize');
assertEqual(queueCallCount, 1, 'second same-profile request remains queued');
queueRelease.resolve();
await Promise.all([queuedFirst, queuedSecond]);
