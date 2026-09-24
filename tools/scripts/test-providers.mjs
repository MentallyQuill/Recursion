import {
  REASONER_ROLE_IDS,
  UTILITY_ROLE_IDS,
  PROVIDER_CONTRACT_VERSION,
  createGenerationRouter,
  createProviderClient,
  jsonSchemaForRequest,
  listProviderConnectionProfiles,
  parseStructuredOutput,
  providerModelStatus,
  providerRouteSummary,
  roleLane,
  validateProviderConfiguration
} from '../../src/providers.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { providerConfigHash } from '../../src/provider-capability.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const PROFILES = Object.freeze([
  Object.freeze({
    id: 'profile-utility',
    name: 'Utility Local',
    label: 'Utility Local / utility-model',
    model: 'utility-model',
    api: 'textgenerationwebui',
    completionMode: 'text',
    presetName: 'Local Precise',
    instructName: 'ChatML'
  }),
  Object.freeze({
    id: 'profile-reasoner',
    name: 'Reasoner Local',
    label: 'Reasoner Local / reasoner-model',
    model: 'reasoner-model',
    api: 'openai',
    completionMode: 'chat',
    presetName: 'Reasoner Precise',
    instructName: ''
  })
]);

function createStore() {
  return createSettingsStore({ root: {} });
}

function configureProfile(store, lane, profileId) {
  const result = store.updateProviderConfig(lane, { connectionProfileId: profileId });
  assertEqual(result.ok, true, `${lane} profile configuration succeeds`);
  return result.provider;
}

function certifyProfile(store, lane, { fused = false, fail = false } = {}) {
  const provider = store.get().providers[lane];
  const result = store.recordProviderCertification(lane, {
    status: fail ? 'fail' : (fused ? 'pass' : 'partial'),
    checkedAt: '2026-08-06T00:00:00.000Z',
    completionMode: lane === 'reasoner' ? 'chat' : 'text',
    structuredOutput: 'prompt-json',
    checks: {
      connectivity: fail ? 'fail' : 'pass',
      singleCard: fail ? 'fail' : 'pass',
      fusedCards: fused && !fail ? 'pass' : 'fail'
    },
    safeConcurrency: 1,
    diagnosticCodes: fail ? ['profile-certification-failed'] : [],
    compactError: fail ? 'Profile certification failed.' : ''
  }, {
    configHash: providerConfigHash(provider),
    configRevision: provider.configRevision
  });
  assertEqual(result.ok, true, `${lane} certification persists`);
  return result.provider;
}

function responseForRequest(request) {
  if (request.roleId === 'providerTest') {
    return { schema: 'recursion.providerTest.v1', ok: true };
  }
  if (request.roleId === 'sceneFrameCard') {
    return {
      promptText: 'Track the immediate objective and obstruction.',
      evidenceRefs: ['message:12']
    };
  }
  if (request.roleId === 'fusedCardBundle') {
    return {
      items: [{
        family: 'Scene Frame',
        promptText: 'Track the immediate objective and obstruction.',
        evidenceRefs: ['message:12'],
        coveredSourceCardIds: []
      }]
    };
  }
  if (request.roleId === 'postProcessGuidanceUtility' || request.roleId === 'postProcessGuidanceReasoner') {
    return {
      guidanceText: 'Apply the selected cards while preserving the existing prose.'
    };
  }
  const schemaByRole = {
    utilityArbiter: 'recursion.utilityArbiter.v1',
    reasonerComposer: 'recursion.reasonerComposer.v1',
    guidanceComposer: 'recursion.guidanceComposer.v1'
  };
  return { schema: schemaByRole[request.roleId] || request.responseSchema, ok: true };
}

assertEqual(parseStructuredOutput('```json\n{"schema":"x"}\n```').schema, 'x', 'structured parser accepts fenced JSON');
assertEqual(parseStructuredOutput('Before {"schema":"x","ok":true} after').schema, 'x', 'structured parser extracts wrapped JSON');

assertEqual(roleLane('unknownRole'), '', 'unknown roles have no lane');
assertEqual(roleLane('utilityArbiter'), 'utility', 'Utility Arbiter uses Utility');
assertEqual(roleLane('reasonerComposer'), 'reasoner', 'Reasoner Composer uses Reasoner');
assert(UTILITY_ROLE_IDS.includes('providerTest'), 'Utility role catalog contains provider certification');
assertDeepEqual(REASONER_ROLE_IDS, ['reasonerComposer', 'postProcessGuidanceReasoner', 'cardRefinementDraft', 'cardRefinementReview'], 'Reasoner role catalog remains bounded');
assert(PROVIDER_CONTRACT_VERSION >= 7, 'provider contract version is current');

assertDeepEqual(
  listProviderConnectionProfiles({ host: { providerProfiles: { list: () => PROFILES } } }),
  PROFILES,
  'provider core delegates profile discovery to the host adapter'
);
assertDeepEqual(listProviderConnectionProfiles({}), [], 'no unsupported global profile discovery fallback remains');

const missingValidation = validateProviderConfiguration({ lane: 'utility', connectionProfileId: '' }, { profiles: PROFILES });
assertEqual(missingValidation.ready, false, 'missing profile is not testable');
assertDeepEqual(missingValidation.missing, ['connectionProfileId'], 'missing profile has one explicit blocker');

const unavailableValidation = validateProviderConfiguration({ lane: 'utility', connectionProfileId: 'deleted-profile' }, { profiles: PROFILES });
assertEqual(unavailableValidation.ready, false, 'deleted profile is not testable');
assertDeepEqual(unavailableValidation.missing, ['connectionProfile'], 'deleted profile is reported as unavailable');

const readyValidation = validateProviderConfiguration({ lane: 'utility', connectionProfileId: 'profile-utility' }, { profiles: PROFILES });
assertEqual(readyValidation.ready, true, 'listed Connection Profile is testable');
const status = providerModelStatus({ lane: 'utility', connectionProfileId: 'profile-utility' }, { profiles: PROFILES });
assertEqual(status.model, 'utility-model', 'profile status exposes safe model metadata');
assertEqual(status.completionMode, 'text', 'profile status exposes completion mode');
assertEqual(JSON.stringify(status).includes('api-url'), false, 'profile status does not expose endpoint metadata');

const routeStore = createStore();
configureProfile(routeStore, 'utility', 'profile-utility');
configureProfile(routeStore, 'reasoner', 'profile-reasoner');
certifyProfile(routeStore, 'utility');
certifyProfile(routeStore, 'reasoner');
routeStore.update({ reasoningLevel: 'high' });
const routeSummary = providerRouteSummary(routeStore.get(), { connectionProfiles: PROFILES });
assertEqual(routeSummary.reasonerHealthy, true, 'certified Reasoner is routed at high reasoning');
assert(routeSummary.text.includes('Arbiter: Reasoner'), 'route summary reports Reasoner Arbiter');

const unhealthyStore = createStore();
configureProfile(unhealthyStore, 'utility', 'profile-utility');
configureProfile(unhealthyStore, 'reasoner', 'profile-reasoner');
certifyProfile(unhealthyStore, 'utility');
certifyProfile(unhealthyStore, 'reasoner', { fail: true });
unhealthyStore.update({ reasoningLevel: 'high' });
const unhealthySummary = providerRouteSummary(unhealthyStore.get(), { connectionProfiles: PROFILES });
assertEqual(unhealthySummary.reasonerHealthy, false, 'failed Reasoner certification disables Reasoner routing');
assert(unhealthySummary.text.includes('Utility fallback'), 'route summary exposes Utility fallback');

const calls = [];
const host = {
  providerProfiles: { list: () => PROFILES },
  generation: {
    async generate(request) {
      calls.push(request);
      return {
        raw: { text: JSON.stringify(responseForRequest(request)) },
        providerId: 'sillytavern-connection-profile',
        model: request.connectionProfileId === 'profile-reasoner' ? 'reasoner-model' : 'utility-model',
        completionMode: request.connectionProfileId === 'profile-reasoner' ? 'chat' : 'text',
        generationPolicy: {
          includePreset: false,
          includeInstruct: request.connectionProfileId === 'profile-utility',
          samplerSource: 'profile',
          structuredOutputMethod: 'prompt-json',
          diagnosticCodes: []
        }
      };
    }
  }
};

const store = createStore();
configureProfile(store, 'utility', 'profile-utility');
configureProfile(store, 'reasoner', 'profile-reasoner');
const client = createProviderClient({ host, settingsStore: store });
const router = createGenerationRouter({ client });

{
  const cooldowns = [];
  const limitedClient = createProviderClient({
    settingsStore: store,
    host: { ...host, generation: { async generate() { throw { status: 429, headers: { 'retry-after': '120' } }; } } },
    requestQueue: {
      run: async (_id, task) => task(),
      stats: () => ({ concurrency: 1 }),
      rateLimited: (id, delay) => { cooldowns.push([id, delay]); return delay; }
    }
  });
  const failed = await createGenerationRouter({ client: limitedClient }).generate('utilityArbiter', { prompt: 'test' });
  assertEqual(failed.error.code, 'RECURSION_PROVIDER_RATE_LIMIT', 'router retains the capacity error');
  assertDeepEqual(cooldowns, [['profile-utility', 120000]], 'provider boundary coordinates cooldown for the entire connection');
  assertEqual(failed.error.retryAfterMs, 120000, 'retry policy receives the coordinated cooldown');
}

const utility = await router.generate('utilityArbiter', { prompt: 'Return JSON.' });
assertEqual(utility.ok, true, 'profile-backed Utility generation succeeds');
assertEqual(utility.data.schema, 'recursion.utilityArbiter.v1', 'Utility response is parsed');
assertEqual(calls[0].connectionProfileId, 'profile-utility', 'Utility request carries selected profile ID');
assertEqual(calls[0].responseSchema, 'recursion.utilityArbiter.v1', 'Utility request carries role schema');
assertEqual(calls[0].responseLength, 8192, 'Utility Arbiter receives lane ceiling');
assertEqual(Object.hasOwn(calls[0], 'providerSource'), false, 'legacy provider source is absent');
assertEqual(calls[0].providerConfig.generationPolicy.structuredOutputMode, 'auto', 'structured output policy is explicit');

const reasoner = await router.generate('reasonerComposer', { prompt: 'Reason about the turn.' });
assertEqual(reasoner.ok, true, 'profile-backed Reasoner generation succeeds');
assertEqual(calls.at(-1).connectionProfileId, 'profile-reasoner', 'Reasoner request carries selected profile ID');
assertEqual(calls.at(-1).responseLength, 8192, 'Reasoner Composer receives lane ceiling');

const profileTest = await router.generate('providerTest', { prompt: 'Connectivity check.' });
assertEqual(profileTest.ok, true, 'provider test is allowed before certification');
assertEqual(calls.at(-1).responseLength, 128, 'provider test uses a small output budget');

const card = await router.generate('sceneFrameCard', {
  prompt: 'Return compact card data.',
  snapshotHash: 'snapshot-card',
  metadata: { role: 'sceneFrameCard', family: 'Scene Frame' }
});
assertEqual(card.ok, true, 'compact Segmented card payload succeeds');
assertEqual(card.data.promptText, 'Track the immediate objective and obstruction.', 'card payload remains model-owned data');
assertEqual(card.diagnostics.effectivePolicy.connectionProfileIdHash.length, 16, 'provider diagnostics hash the selected profile ID');
assertEqual(card.diagnostics.effectivePolicy.completionMode, 'text', 'provider diagnostics record completion mode');
assertEqual(card.diagnostics.effectivePolicy.presetMode, 'isolated', 'provider diagnostics record preset isolation');
assertEqual(card.diagnostics.effectivePolicy.instructApplied, true, 'provider diagnostics record instruct application');
assertEqual(card.diagnostics.effectivePolicy.samplerSource, 'profile', 'provider diagnostics record sampler source');
assertEqual(card.diagnostics.effectivePolicy.structuredOutputMethod, 'prompt-json', 'provider diagnostics record structured-output method');
assertEqual(card.diagnostics.effectivePolicy.responseLength, 8192, 'provider diagnostics record lane ceiling');
assertEqual(card.diagnostics.effectivePolicy.queueConcurrency, 1, 'provider diagnostics record queue concurrency');
assertEqual(JSON.stringify(card.diagnostics).includes('profile-utility'), false, 'provider diagnostics omit the raw profile ID');

const fused = await router.generate('fusedCardBundle', {
  prompt: 'Return compact bundle data.',
  requestedCards: [{ family: 'Scene Frame' }, { family: 'Active Cast' }]
});
assertEqual(fused.ok, true, 'compact Fused bundle succeeds');
assertEqual(calls.at(-1).responseLength, 8192, 'Fused output budget uses lane ceiling');

const guidance = await router.generate('postProcessGuidanceUtility', {
  prompt: 'Return guidance.',
  snapshotHash: 'snapshot-guidance',
  sourceHash: 'source-guidance',
  reasoningLevel: 'medium'
});
assertEqual(guidance.ok, true, 'post-process guidance preserves trusted identities');
assertEqual(guidance.data.snapshotHash, 'snapshot-guidance', 'trusted snapshot identity survives');

const providerTestSchema = jsonSchemaForRequest({ responseSchema: 'recursion.providerTest.v1' });
assertEqual(providerTestSchema.schema.properties.schema.const, 'recursion.providerTest.v1', 'provider test schema is role-bound');

const callsBeforeUnknown = calls.length;
const unknown = await router.generate('unknownRole', { prompt: 'Do not call host.' });
assertEqual(unknown.ok, false, 'unknown provider role fails');
assertEqual(unknown.error.code, 'RECURSION_PROVIDER_ROLE_UNSUPPORTED', 'unknown role has stable code');
assertEqual(calls.length, callsBeforeUnknown, 'unknown role fails before host generation');

const malformedMarker = 'RAW_PROVIDER_OUTPUT_MUST_NOT_LEAK';
const malformedRouter = createGenerationRouter({
  client: {
    async generate() {
      return { text: `{not-json ${malformedMarker}` };
    }
  }
});
const malformed = await malformedRouter.generate('utilityArbiter', { prompt: 'Return malformed JSON.' });
assertEqual(malformed.ok, false, 'malformed JSON is rejected');
assertEqual(malformed.error.code, 'RECURSION_JSON_PARSE_FAILED', 'malformed JSON has stable parse code');
assertEqual(JSON.stringify(malformed).includes(malformedMarker), false, 'malformed raw output is absent from diagnostics');

const truncatedStore = createStore();
configureProfile(truncatedStore, 'utility', 'profile-utility');
const truncatedRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      providerProfiles: { list: () => PROFILES },
      generation: {
        async generate() {
          return {
            raw: {
              choices: [{
                message: { content: '{"schema":"recursion.utilityArbiter.v1"' },
                finish_reason: 'length'
              }],
              usage: { completion_tokens: 4096 }
            }
          };
        }
      }
    },
    settingsStore: truncatedStore
  })
});
const truncated = await truncatedRouter.generate('utilityArbiter', { prompt: 'Return complete JSON.' });
assertEqual(truncated.ok, false, 'visible partial JSON stopped at the token limit is rejected before parsing');
assertEqual(truncated.error.code, 'RECURSION_PROVIDER_TOKEN_LIMIT', 'visible completion truncation preserves its distinct failure code');

const wrongSchemaRouter = createGenerationRouter({
  client: {
    async generate() {
      return { text: JSON.stringify({ schema: 'recursion.wrong.v1', ok: true }) };
    }
  }
});
const wrongSchema = await wrongSchemaRouter.generate('providerTest', { prompt: 'Return wrong schema.' });
assertEqual(wrongSchema.ok, false, 'wrong role schema is rejected');
assertEqual(wrongSchema.error.code, 'RECURSION_PROVIDER_SCHEMA_MISMATCH', 'wrong role schema has stable code');

const batch = await router.batch([
  { roleId: 'utilityArbiter', prompt: 'Batch Utility.' },
  { roleId: 'providerTest', prompt: 'Batch test.' }
], { runId: 'profile-only-batch' });
assertDeepEqual(batch.map((entry) => entry.ok), [true, true], 'logical batch preserves successful slots');
assertDeepEqual(batch.map((entry) => entry.diagnostics.runId), ['profile-only-batch', 'profile-only-batch'], 'logical batch shares one run ID');

const mixedClient = createProviderClient({
  host: {
    providerProfiles: { list: () => PROFILES },
    generation: {
      async generate(request) {
        if (request.roleId === 'providerTest') throw new Error('slot exploded');
        return { raw: { text: JSON.stringify(responseForRequest(request)) } };
      }
    }
  },
  settingsStore: store
});
const mixedBatch = await createGenerationRouter({ client: mixedClient }).batch([
  { roleId: 'utilityArbiter', prompt: 'Mixed success.' },
  { roleId: 'providerTest', prompt: 'Mixed failure.' }
], { runId: 'mixed-slot-batch' });
assertDeepEqual(mixedBatch.map((entry) => entry.ok), [true, false], 'mixed provider batch isolates one rejected slot');
assertEqual(mixedBatch[1].error.message, 'slot exploded', 'mixed provider batch preserves slot failure message');

const operationAbortRouter = createGenerationRouter({
  client: {
    async generate() {
      throw new Error('operation abort test client only supports batch');
    },
    async batch() {
      const error = new Error('operation aborted');
      error.code = 'RECURSION_PROVIDER_ABORTED';
      throw error;
    }
  }
});
let operationAbortError = null;
try {
  await operationAbortRouter.batch([
    { roleId: 'utilityArbiter', prompt: 'Operation abort.' },
    { roleId: 'providerTest', prompt: 'Operation abort.' }
  ], { runId: 'operation-abort-batch' });
} catch (error) {
  operationAbortError = error;
}
assertEqual(operationAbortError?.code, 'RECURSION_PROVIDER_ABORTED', 'operation-level provider batch abort propagates without slot settlement');

const abortController = new AbortController();
abortController.abort();
const aborted = await router.generate('utilityArbiter', {
  prompt: 'Aborted before dispatch.',
  signal: abortController.signal
});
assertEqual(aborted.ok, false, 'pre-aborted request is rejected');
assertEqual(aborted.error.code, 'RECURSION_PROVIDER_ABORTED', 'pre-aborted request has stable code');

const timeoutRouter = createGenerationRouter({
  client: {
    async generate() {
      return new Promise(() => {});
    }
  }
});
const timedOut = await timeoutRouter.generate('utilityArbiter', { prompt: 'Never resolves.' }, { timeoutMs: 5 });
assertEqual(timedOut.ok, false, 'explicit provider timeout is enforced');
assertEqual(timedOut.error.code, 'RECURSION_PROVIDER_TIMEOUT', 'timeout has stable code');


store.updateProviderConfig('utility', { outputTokenCeiling: 16000 });
await client.generate('sceneFrameCard', { prompt: 'Return JSON.' });
assertEqual(calls.at(-1).responseLength, 16000, 'configured ceiling reaches production transport');
assertEqual(calls.at(-1).reasoningIntent, 'none', 'utility transport disables reasoning');
await client.generate('sceneFrameCard', { prompt: 'Return JSON.', responseLength: 700, reasoningIntent: 'high' });
assertEqual(calls.at(-1).responseLength, 700, 'explicit smaller transport limit survives');
assertEqual(calls.at(-1).reasoningIntent, 'none', 'Utility disables reasoning even when a role requests high effort');
await client.generate('reasonerComposer', { prompt: 'Return JSON.', reasoningIntent: 'high' });
assertEqual(calls.at(-1).reasoningIntent, 'high', 'reasoner intent survives central utility default');

const guidanceSchema = jsonSchemaForRequest({ responseSchema: 'recursion.postProcessGuidance.v1', snapshotHash: 's', sourceHash: 't' });
assertDeepEqual(Object.keys(guidanceSchema.schema.properties), ['guidanceText'], 'native guidance schema requests only model-owned text');

console.log('[pass] providers');
