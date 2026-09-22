import { certifyConnectionProfile } from '../../src/providers/profile-certification.mjs';
import { createGenerationRouter, createProviderClient } from '../../src/providers.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const provider = {
  generationPolicy: { structuredOutputMode: 'auto' }
};

// Qualification uses real queue dispatch evidence, not a configured number.
const probeStore = createSettingsStore({root: {recursion: {providers: {
  utility: {connectionProfileId: 'probe', maxConcurrentRequests: 2}
}}}, save() {}});
const probeRouter = createGenerationRouter({client: createProviderClient({settingsStore: probeStore, host: {
  providerProfiles: {list: () => [{id: 'probe', completionMode: 'chat'}]},
  generation: {async generate(request) {
    await Promise.resolve();
    return {raw: JSON.stringify(request.roleId === 'providerTest'
      ? {schema: 'recursion.providerTest.v1', ok: true, probeId: request.concurrencyProbe?.id}
      : {promptText: 'Track the scene.', evidenceRefs: ['message:0']})};
  }}
}})});
const probeCertification = await certifyConnectionProfile({
  lane: 'utility', provider: probeStore.get().providers.utility,
  profile: {id: 'probe', completionMode: 'chat'}, includeFused: false,
  generate: (role, request) => probeRouter.generate(role, request)
});
assertEqual(probeCertification.safeConcurrency, 2, 'certification proves two overlapping requests');
assertEqual(probeCertification.checks.concurrency, 'pass', 'concurrency proof is recorded');
const calls = [];
const fusedPrompts = [];
const full = await certifyConnectionProfile({
  lane: 'utility',
  provider,
  profile: { id: 'profile-a', completionMode: 'text' },
  generate: async (roleId, request) => {
    calls.push([roleId, request.structuredOutputMethod, request.responseLength]);
    if (roleId === 'sceneFrameCard' && request.structuredOutputMethod === 'native-schema') {
      return { ok: false, error: { code: 'RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED' } };
    }
    if (roleId === 'providerTest') {
      return { ok: true, data: { schema: 'recursion.providerTest.v1', ok: true } };
    }
    if (roleId === 'sceneFrameCard') {
      return { ok: true, data: { promptText: 'Track the immediate objective.', evidenceRefs: ['message:0'] } };
    }
    fusedPrompts.push(request.prompt);
    return {
      ok: true,
      data: {
        items: [
          { family: 'Scene Frame', promptText: 'Track the immediate objective.', evidenceRefs: ['message:0'] },
          { family: 'Scene Constraints', promptText: 'Preserve the immediate boundary.', evidenceRefs: ['message:0'] }
        ]
      }
    };
  },
  now: () => '2026-08-06T00:00:00.000Z'
});
assertEqual(full.status, 'pass', 'prompt JSON can fully certify profile');
assertEqual(full.structuredOutput, 'prompt-json', 'fallback method is persisted');
assertEqual(full.checks.fusedCards, 'pass', 'representative Fused bundle passes');
assert(full.diagnosticCodes.includes('structured-output-downgraded'), 'native schema downgrade is recorded');
assertDeepEqual(calls, [
  ['providerTest', 'prompt-json', 900],
  ['sceneFrameCard', 'native-schema', 900],
  ['sceneFrameCard', 'prompt-json', 900],
  ['fusedCardBundle', 'prompt-json', 1792]
], 'certification runs connectivity, fallback single-card, and Fused checks with thinking-safe bounded budgets');
assert(
  fusedPrompts[0].includes('"family":"Scene Frame"')
    && fusedPrompts[0].includes('"family":"Scene Constraints"')
    && fusedPrompts[0].includes('"evidenceRefs":["message:0"]'),
  'Fused certification prompt specifies both exact families and the accepted item shape'
);

const segmentedCalls = [];
const segmentedOnly = await certifyConnectionProfile({
  lane: 'utility',
  provider: { generationPolicy: { structuredOutputMode: 'prompt-json' } },
  profile: { id: 'profile-segmented', completionMode: 'chat' },
  includeFused: false,
  generate: async (roleId) => {
    segmentedCalls.push(roleId);
    if (roleId === 'providerTest') return { ok: true, data: { schema: 'recursion.providerTest.v1', ok: true } };
    return { ok: true, data: { promptText: 'Track the scene.', evidenceRefs: ['message:0'] } };
  },
  now: () => '2026-08-06T00:30:00.000Z'
});
assertEqual(segmentedOnly.status, 'partial', 'Segmented-only certification produces Segmented-ready status');
assertDeepEqual(segmentedOnly.checks, {
  connectivity: 'pass', singleCard: 'pass', fusedCards: 'not-run', concurrency: 'not-run'
}, 'Segmented-only certification records Fused as not run');
assertDeepEqual(segmentedCalls, ['providerTest', 'sceneFrameCard'], 'Segmented-only certification never calls the Fused role');

const partial = await certifyConnectionProfile({
  lane: 'reasoner',
  provider: { generationPolicy: { structuredOutputMode: 'prompt-json' } },
  profile: { id: 'profile-b', completionMode: 'chat' },
  generate: async (roleId) => {
    if (roleId === 'providerTest') return { ok: true, data: { schema: 'recursion.providerTest.v1', ok: true } };
    if (roleId === 'sceneFrameCard') return { ok: true, data: { promptText: 'Track the scene.', evidenceRefs: ['message:0'] } };
    return { ok: true, data: { items: [{ family: 'Scene Frame', promptText: 'Only one item.', evidenceRefs: ['message:0'] }] } };
  },
  now: () => '2026-08-06T01:00:00.000Z'
});
assertEqual(partial.status, 'partial', 'single-card pass with Fused failure produces partial certification');
assertEqual(partial.checks.singleCard, 'pass', 'partial certification permits Segmented use');
assertEqual(partial.checks.fusedCards, 'fail', 'partial certification records Fused failure');

const failed = await certifyConnectionProfile({
  lane: 'utility',
  provider,
  profile: { id: 'profile-c', completionMode: 'text' },
  generate: async () => ({
    ok: false,
    error: Object.assign(new Error('Bearer CERTIFICATION_SECRET'), { code: 'RECURSION_PROVIDER_TRANSIENT' })
  }),
  now: () => '2026-08-06T02:00:00.000Z'
});
assertEqual(failed.status, 'fail', 'connectivity failure fails certification');
assertEqual(failed.checks.connectivity, 'fail', 'connectivity failure is recorded');
assertEqual(failed.checks.singleCard, 'not-run', 'later checks do not run after connectivity failure');
assertEqual(JSON.stringify(failed).includes('CERTIFICATION_SECRET'), false, 'certification never stores provider error text');

const forcedNative = await certifyConnectionProfile({
  lane: 'utility',
  provider: { generationPolicy: { structuredOutputMode: 'native-schema' } },
  profile: { id: 'profile-d', completionMode: 'chat' },
  generate: async (roleId) => {
    if (roleId === 'providerTest') return { ok: true, data: { schema: 'recursion.providerTest.v1', ok: true } };
    return { ok: false, error: { code: 'RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED' } };
  },
  now: () => '2026-08-06T03:00:00.000Z'
});
assertEqual(forcedNative.status, 'fail', 'forced native schema does not silently downgrade');
assertEqual(forcedNative.structuredOutput, 'native-schema', 'forced method remains visible in safe result');

const invalidConnectivity = await certifyConnectionProfile({
  lane: 'utility',
  provider,
  profile: { id: 'profile-e', completionMode: 'chat' },
  generate: async () => ({
    ok: true,
    data: {
      schema: 'wrong.providerTest.schema',
      ok: true,
      detail: 'Bearer CERTIFICATION_INVALID_SECRET'
    }
  }),
  now: () => '2026-08-06T04:00:00.000Z'
});
assertEqual(invalidConnectivity.status, 'fail', 'invalid connectivity payload fails certification');
assert(invalidConnectivity.compactError.startsWith('RECURSION_PROVIDER_TEST_INVALID:'), 'invalid connectivity has a stable safe error code');
assertEqual(JSON.stringify(invalidConnectivity).includes('CERTIFICATION_INVALID_SECRET'), false, 'invalid connectivity payload is not persisted');

console.log('[pass] profile certification');
