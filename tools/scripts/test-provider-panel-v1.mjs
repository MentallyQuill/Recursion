import {
  providerCapabilityDetail,
  providerCapabilityLabel,
  providerCheckLines,
  readProviderDraftFromControls
} from '../../src/ui/provider-panel.mjs';
import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';
import * as providerPanel from '../../src/ui/provider-panel.mjs';
import { createRecursionRuntime } from '../../src/runtime.mjs';
import { progressRecoveryLines } from '../../src/ui/progress-panel.mjs';

assertEqual(typeof providerPanel.providerQueueLine, 'function', 'queue wait has a pure presenter');
assertEqual(providerPanel.providerQueueLine({available:true,cooldownRemainingMs:1001}),
  'Waiting for provider · retry in 2s', 'remaining seconds round upward');
assertEqual(providerPanel.providerQueueLine({available:false,cooldownRemainingMs:1001}),null);
assertEqual(providerPanel.providerQueueLine({available:true,cooldownRemainingMs:0}),null);
const runtime = createRecursionRuntime({host:{providerClient:{queueState:()=>({available:true,active:0,pending:1,
  concurrency:1,cooldownRemainingMs:1001})}}});
assertEqual(runtime.providerOperationState().queues?.utility?.cooldownRemainingMs,1001,
  'runtime exposes selected-profile queue snapshots');
assertEqual(progressRecoveryLines({execution:{state:'paused',stageRecords:{fused:{failure:{
  code:'RECURSION_PROVIDER_RATE_LIMIT',retryNotBefore:6001}}}}},{now:()=>5000}).wait,
  'Waiting for provider · retry in 2s','restored operation explains its persisted Retry wait');

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

assertDeepEqual(providerCheckLines({
  maxConcurrentRequests: 4,
  generationPolicy: { structuredOutputMode: 'auto' },
  certification: { checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'fail' } }
}, { state: 'segmented-ready', safeConcurrency: 2, structuredOutput: 'native-schema' }), [
  'Connection: Passed · Single cards: Passed · Combined cards: Failed',
  'Structured output: Native Schema · Concurrent requests: 4 configured, 2 effective',
  'Profile checks test capability; they do not predict combined-card reliability for every turn.'
], 'provider checks report separate single and combined outcomes with effective policy details');
assertDeepEqual(providerCheckLines({
  generationPolicy: { structuredOutputMode: 'auto' },
  certification: { checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'pass' } }
}, { state: 'uncertified', safeConcurrency: 1 }), [
  'Connection: Not checked · Single cards: Not checked · Combined cards: Not checked',
  'Structured output: Prompt JSON · Concurrent requests: 2 configured, 1 effective',
  'Profile checks test capability; they do not predict combined-card reliability for every turn.'
], 'stale checks are not presented as current passes');

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
