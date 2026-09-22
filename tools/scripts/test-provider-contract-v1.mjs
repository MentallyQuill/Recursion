import {
  createSettingsStore,
  normalizeProviderSettings
} from '../../src/settings.mjs';
import {
  PROVIDER_CAPABILITY_STATES,
  providerConfigHash,
  resolveProviderCapability
} from '../../src/provider-capability.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const provider = normalizeProviderSettings('utility', {
  unexpectedProviderField: 'must-not-survive',
  nestedUnexpectedProviderField: { value: 'must-not-survive' },
  connectionProfileId: 'profile-local-text',
  generationPolicy: {
    presetMode: 'isolated',
    instructMode: 'auto',
    samplerMode: 'profile',
    structuredOutputMode: 'auto'
  },
  samplerOverrides: { temperature: 0.25, topP: 0.82 },
  outputTokenCeiling: 4096
});

assertEqual(provider.connectionProfileId, 'profile-local-text', 'profile id survives');
assertEqual(provider.generationPolicy.samplerMode, 'profile', 'profile samplers are defaultable');
assertEqual(provider.samplerOverrides.temperature, 0.25, 'temperature override is bounded');
assertEqual(provider.outputTokenCeiling, 4096, 'output ceiling survives');
assertDeepEqual(Object.keys(provider).sort(), [
  'certification',
  'configRevision',
  'connectionProfileId',
  'generationPolicy',
  'lane',
  'maxConcurrentRequests',
  'outputTokenCeiling',
  'samplerOverrides'
].sort(), 'provider normalization emits only the profile-only contract');

assertDeepEqual(PROVIDER_CAPABILITY_STATES, [
  'unconfigured',
  'uncertified',
  'segmented-ready',
  'fused-ready',
  'unhealthy'
], 'capability states use the profile certification contract');

const root = { recursion: { providers: { utility: provider } } };
const store = createSettingsStore({ root, save: () => {} });
const initial = store.get().providers.utility;
const hash = providerConfigHash(initial);
const recorded = store.recordProviderCertification('utility', {
  status: 'partial',
  checkedAt: '2026-08-06T00:00:00.000Z',
  completionMode: 'text',
  structuredOutput: 'prompt-json',
  checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'fail' },
  safeConcurrency: 99,
  diagnosticCodes: ['native-schema-unsupported'],
  compactError: 'Fused shape did not validate.'
}, {
  configHash: hash,
  configRevision: initial.configRevision
});
assertEqual(recorded.ok, true, 'certification is recorded');
assertEqual(recorded.provider.certification.safeConcurrency, 1, 'safe concurrency is fixed at one');

const capability = resolveProviderCapability({
  settings: store.get(),
  lane: 'utility',
  operation: 'prompt-packet',
  host: { connectionProfiles: [{ id: 'profile-local-text' }] }
});
assertEqual(capability.state, 'segmented-ready', 'single-card certification enables Segmented');
assertEqual(capability.segmentedEligible, true, 'Segmented is eligible');
assertEqual(capability.fusedEligible, false, 'Fused is not eligible after a failed Fused check');
assertEqual(capability.completionMode, 'text', 'completion mode is exposed');
assertEqual(capability.structuredOutput, 'prompt-json', 'structured output method is exposed');

const changed = store.updateProviderConfig('utility', {
  generationPolicy: { instructMode: 'off' }
}, { expectedRevision: recorded.provider.configRevision });
assertEqual(changed.ok, true, 'provider policy update succeeds');
assertDeepEqual(changed.provider.certification, { status: 'not-run' }, 'policy change invalidates certification');
assert(providerConfigHash(changed.provider) !== hash, 'policy change updates provider config hash');

console.log('[pass] provider contract v1');
