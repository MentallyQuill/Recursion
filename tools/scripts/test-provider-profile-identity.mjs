import { hashJson } from '../../src/core.mjs';
import {
  providerConfigHash, providerProfileIdentityHash, effectiveProfileConcurrency, resolveProviderCapability
} from '../../src/provider-capability.mjs';
import { resolveGenerationPolicy } from '../../src/providers/generation-policy.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { createRecursionRuntime } from '../../src/runtime.mjs';
import { providerRouteSummary } from '../../src/providers.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

const profile = {
  id: 'profile-a', model: 'tested-model', api: 'openai', completionMode: 'chat',
  presetName: 'Precise', instructName: ''
};
const provider = {
  lane: 'utility', connectionProfileId: profile.id, maxConcurrentRequests: 2,
  generationPolicy: { structuredOutputMode: 'auto' }
};
provider.certification = {
  status: 'pass', configHash: providerConfigHash(provider), profileIdentityHash: hashJson(profile),
  completionMode: 'chat', structuredOutput: 'native-schema',
  checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'pass', concurrency: 'pass' },
  safeConcurrency: 2
};
const settings = { providers: { utility: provider } };
const changedProfile = { ...profile, model: 'different-model' };
const changed = resolveProviderCapability({
  settings, lane: 'utility', host: { connectionProfiles: [changedProfile] }
});
assertEqual(changed.state, 'uncertified', 'same profile ID with a changed model is untested');
assertEqual(changed.safeConcurrency, 1, 'changed live profile restores conservative concurrency');
assertEqual(changed.structuredOutput, 'unknown', 'changed profile does not display the stale native qualification');
assertEqual(changed.fusedEligible, true, 'live identity drift does not gate explicit Fused requests');
const matched = resolveProviderCapability({ settings, host: { connectionProfiles: [profile] } });
assertEqual(matched.state, 'fused-ready', 'unchanged live profile keeps its complete qualification');
assertEqual(matched.safeConcurrency, 2, 'unchanged live profile retains proven concurrency');
for (const field of ['model', 'api', 'completionMode', 'presetName', 'instructName']) {
  const drifted = resolveProviderCapability({
    settings, host: { connectionProfiles: [{ ...profile, [field]: `changed-${field}` }] }
  });
  assertEqual(drifted.state, 'uncertified', `${field} participates in live qualification`);
  assertEqual(drifted.safeConcurrency, 1, `${field} drift resets safe concurrency`);
}
assertEqual(providerProfileIdentityHash({ ...profile, name: 'renamed', label: 'renamed',
  endpoint: 'https://private.invalid', apiKey: 'private-token', 'secret-id': 'private-secret' }), hashJson(profile),
  'names, endpoints, and secrets do not participate in the profile fingerprint');
assertEqual(providerProfileIdentityHash({ ...profile, id: 'different-id' }) === hashJson(profile), false,
  'profile ID participates in the identity fingerprint');
const reasoner = { ...provider, lane: 'reasoner', certification: { ...provider.certification,
  configHash: 'stale-settings' } };
assertEqual(effectiveProfileConcurrency({ providers: { utility: provider, reasoner } }, profile.id, profile), 1,
  'two lanes sharing a profile respect the most conservative qualification');
assertEqual(effectiveProfileConcurrency({ providers: { utility: {
  ...provider, certification: { ...provider.certification, status: 'fail' }
} } }, profile.id, profile), 1, 'a failed certification cannot authorize concurrent generation');
const routeSettings = { reasoningLevel: 'high', providers: { reasoner: {
  ...provider, lane: 'reasoner', certification: { status: 'not-run' }
} } };
const reasonerCapability = resolveProviderCapability({
  settings: routeSettings, lane: 'reasoner', host: { connectionProfiles: [profile] }
});
assertEqual(providerRouteSummary(routeSettings, { reasonerCapability }).reasonerHealthy, true,
  'UI route summary consumes the supplied current runtime capability');
assertEqual(resolveGenerationPolicy({
  provider: { ...provider, certification: { ...provider.certification, configHash: 'stale' } },
  completionMode: 'chat', certificationValid: false
}).structuredOutputMethod, 'prompt-json', 'Auto ignores a stale native-schema marker');

const store = createSettingsStore({ root: {} });
store.updateProviderConfig('utility', { connectionProfileId: profile.id });
const configured = store.get().providers.utility;
const { configHash: savedHash, ...certification } = provider.certification;
const recorded = store.recordProviderCertification('utility', certification, {
  configHash: providerConfigHash(configured), configRevision: configured.configRevision
});
assertEqual(recorded.ok, true, 'certification accepts the exercised identity hash');
assertEqual(store.get().providers.utility.certification.profileIdentityHash, hashJson(profile),
  'certification persists the identity separately from Recursion settings');

const hostCalls = [];
let failNativeTransport = false;
const rawProfile = { ...profile, preset: profile.presetName, instruct: profile.instructName };
const host = createSillyTavernHost({ settingsRoot: {}, saveSettings() {}, contextFactory: () => ({
  ConnectionManagerRequestService: {
    getSupportedProfiles: () => [rawProfile],
    getProfile: () => rawProfile,
    validateProfile: () => ({ selected: 'openai', type: 'openai' }),
    async sendRequest(...args) {
      hostCalls.push(args);
      if (failNativeTransport) throw Object.assign(new Error('Native schema unsupported.'), {
        code: 'RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED'
      });
      return { choices: [{ message: { content: '{"schema":"recursion.providerTest.v1","ok":true}' } }] };
    }
  }
}) });
const native = await host.generation.generate({
  connectionProfileId: profile.id, providerConfig: provider, roleId: 'providerTest',
  responseSchema: 'recursion.providerTest.v1', prompt: 'Return the test object.', responseLength: 128
});
assertEqual(native.generationPolicy.structuredOutputMethod, 'native-schema',
  'transport revalidates the live descriptor before using qualified native support');

rawProfile.model = 'different-model';
const staleNative = await host.generation.generate({
  connectionProfileId: profile.id, providerConfig: provider, roleId: 'providerTest',
  responseSchema: 'recursion.providerTest.v1', prompt: 'Return the test object.', responseLength: 128
});
assertEqual(staleNative.generationPolicy.structuredOutputMethod, 'prompt-json',
  'transport Auto becomes conservative after a same-ID model edit');
assertEqual(hostCalls.length, 2, 'live qualification lookup never makes a hidden generation probe');
const explicitNative = await host.generation.generate({
  connectionProfileId: profile.id,
  providerConfig: { ...provider, generationPolicy: { structuredOutputMode: 'native-schema' } },
  roleId: 'providerTest', responseSchema: 'recursion.providerTest.v1',
  prompt: 'Return the test object.', responseLength: 128
});
assertEqual(explicitNative.generationPolicy.structuredOutputMethod, 'native-schema',
  'explicit Native Schema remains explicit after profile identity drift');
rawProfile.model = profile.model;

failNativeTransport = true;
let transportError;
try {
  await host.generation.generate({
    connectionProfileId: profile.id, providerConfig: provider, roleId: 'providerTest',
    responseSchema: 'recursion.providerTest.v1', prompt: 'Return the test object.', responseLength: 128
  });
} catch (error) { transportError = error; }
assertEqual(transportError?.providerDiagnostics?.structuredOutputMethod, 'native-schema',
  'failed transport retains only the actual attempted structured-output method');

let runtimeProfile = { ...profile };
let editProfileDuringTest = true;
let runtimeCalls = 0;
const runtimeStore = createSettingsStore({ root: { recursion: { providers: {
  utility: { connectionProfileId: profile.id, maxConcurrentRequests: 1 }
} } } });
const runtime = createRecursionRuntime({
  settingsStore: runtimeStore,
  host: { providerProfiles: { list: () => [runtimeProfile] } },
  generationRouter: { async generate(roleId) {
    runtimeCalls += 1;
    if (roleId === 'providerTest') {
      if (editProfileDuringTest) runtimeProfile = { ...runtimeProfile, model: 'edited-during-test' };
      return { ok: true, data: { schema: 'recursion.providerTest.v1', ok: true } };
    }
    return { ok: true, data: { promptText: 'Track the scene.', evidenceRefs: ['message:0'] } };
  } }
});
runtime.view();
assertEqual(runtimeCalls, 0, 'opening settings never runs paid profile qualification');
const driftedTest = await runtime.testProvider('utility', { scope: 'segmented' });
assertEqual(driftedTest.certificationStale, true, 'live identity drift during a test invalidates its save');
assertEqual(runtimeStore.get().providers.utility.certification.status, 'not-run',
  'identity drift cannot certify the edited profile');
assertEqual(runtimeCalls, 1, 'profile identity drift stops later certification calls');

editProfileDuringTest = false;
const currentTest = await runtime.testProvider('utility', { scope: 'segmented' });
assertEqual(currentTest.certificationStale, false, 'an unchanged live profile retains qualification');
runtimeProfile = { ...runtimeProfile, api: 'edited-api' };
assertEqual(runtime.view().settings.providers.utility.certification.status, 'not-run',
  'runtime settings summarize changed live profile checks as untested');
assertEqual(runtimeCalls, 3, 'live profile status refresh never makes a hidden generation probe');
runtimeProfile = { ...profile, model: 'long-model-'.repeat(25) };
const longIdentityTest = await runtime.testProvider('utility', { scope: 'segmented' });
assertEqual(longIdentityTest.certification.profileIdentityHash, providerProfileIdentityHash(runtimeProfile),
  'display truncation does not change the identity tested by runtime certification');

console.log('[pass] provider profile identity');
