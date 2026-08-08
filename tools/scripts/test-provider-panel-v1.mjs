import {
  providerCapabilityDetail,
  providerCapabilityLabel,
  readProviderDraftFromControls
} from '../../src/ui/provider-panel.mjs';
import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

for (const [state, label, detail] of [
  ['unconfigured', 'Configure', ''],
  ['uncertified', 'Untested', ''],
  ['segmented-ready', 'Ready', 'Segmented'],
  ['fused-ready', 'Ready', 'Fused'],
  ['unhealthy', 'Unhealthy', '']
]) {
  assertEqual(providerCapabilityLabel(state), label, `${state} maps to the approved compact provider state`);
  assertEqual(providerCapabilityDetail(state), detail, `${state} retains its separate capability detail`);
}

const values = new Map([
  ['[data-recursion-provider-profile-utility]', 'profile-text'],
  ['[data-recursion-provider-preset-mode-utility]', 'isolated'],
  ['[data-recursion-provider-instruct-mode-utility]', 'auto'],
  ['[data-recursion-provider-sampler-mode-utility]', 'profile'],
  ['[data-recursion-provider-structured-output-mode-utility]', 'auto'],
  ['[data-recursion-provider-temperature-utility]', '0.1'],
  ['[data-recursion-provider-top-p-utility]', '0.95'],
  ['[data-recursion-provider-output-token-ceiling-utility]', '4096']
]);
const root = {
  querySelector(selector) {
    return values.has(selector) ? { value: values.get(selector) } : null;
  }
};
const draft = readProviderDraftFromControls({
  root,
  lane: 'utility',
  savedProvider: {},
  cleanText: (value) => String(value ?? '').trim(),
  asObject: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
});
assertDeepEqual(draft, {
  connectionProfileId: 'profile-text',
  generationPolicy: {
    presetMode: 'isolated',
    instructMode: 'auto',
    samplerMode: 'profile',
    structuredOutputMode: 'auto'
  },
  samplerOverrides: { temperature: 0.1, topP: 0.95 },
  outputTokenCeiling: 4096
}, 'provider draft contains only profile and policy fields');
assertDeepEqual(Object.keys(draft).sort(), [
  'connectionProfileId',
  'generationPolicy',
  'outputTokenCeiling',
  'samplerOverrides'
].sort(), 'provider draft emits only profile and policy fields');
console.log('[pass] provider panel v1');
