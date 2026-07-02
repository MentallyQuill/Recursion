import {
  REASONER_ROLE_IDS,
  UTILITY_ROLE_IDS,
  createGenerationRouter,
  createProviderClient,
  fetchOpenAICompatibleModels,
  listProviderConnectionProfiles,
  parseStructuredOutput,
  providerModelStatus,
  providerRouteSummary,
  validateProviderConfiguration,
  roleLane
} from '../../src/providers.mjs';
import { readFileSync } from 'node:fs';
import { createActivityReporter } from '../../src/activity.mjs';
import { createSessionSecretStore, createSettingsStore } from '../../src/settings.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

function createStore() {
  return createSettingsStore({ root: {}, secretStore: createSessionSecretStore() });
}

function assertNoSecret(value, message) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes('sk-live-secret'), message);
  assert(!serialized.includes('session-key'), message);
  assert(!serialized.includes('Bearer'), message);
}

function assertNoRawBatchMarker(value, message) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes('RAW_BATCH'), message);
}

function assertNoProviderMarker(value, marker, message) {
  assert(!JSON.stringify(value).includes(marker), message);
}

function responseSchemaForRole(roleId) {
  if (roleId === 'reasonerComposer') return 'recursion.reasonerComposer.v1';
  if (roleId === 'utilityArbiter') return 'recursion.utilityArbiter.v1';
  if (roleId === 'briefUtilityComposer') return 'recursion.briefUtilityComposer.v1';
  if (roleId === 'providerTest') return 'recursion.providerTest.v1';
  return 'recursion.card.v1';
}

function responseTextForRole(roleId, fields = {}) {
  return JSON.stringify({ schema: responseSchemaForRole(roleId), ok: true, ...fields });
}

assertEqual(parseStructuredOutput('```json\n{"schema":"x"}\n```').schema, 'x', 'structured parser accepts fenced json');
assertEqual(roleLane('unknownRole'), '', 'unknown roles have no provider lane');
assertEqual(roleLane('reasonerComposer'), 'reasoner', 'reasonerComposer uses reasoner lane');
const expectedUtilityRoles = [
  'utilityArbiter',
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'sceneConstraintsCard',
  'knowledgeSecretsCard',
  'clocksConsequencesCard',
  'environmentAffordancesCard',
  'possessionsItemsCard',
  'openThreadsCard',
  'briefUtilityComposer',
  'providerTest'
];
assertDeepEqual(UTILITY_ROLE_IDS, expectedUtilityRoles, 'utility role catalog exactly matches Task 6 plan');
assertDeepEqual(REASONER_ROLE_IDS, ['reasonerComposer'], 'reasoner role catalog exactly matches Task 6 plan');
for (const utilityRole of expectedUtilityRoles) {
  assertEqual(roleLane(utilityRole), 'utility', `${utilityRole} uses utility lane`);
}
const providerSpec = readFileSync(new URL('../../docs/architecture/PROVIDER_AND_GENERATION_SPEC.md', import.meta.url), 'utf8');
for (const utilityRole of expectedUtilityRoles) {
  assert(providerSpec.includes(`\`${utilityRole}\``), `provider spec documents ${utilityRole}`);
}
assert(providerSpec.includes('`reasonerComposer`'), 'provider spec documents reasonerComposer');
assert(!/characterLensCard|environmentTextureCard/.test(providerSpec), 'provider spec omits legacy card role names');

const contextProfileService = {
  getSupportedProfiles() {
    return [
      { profileId: 'ctx-utility', label: 'Context Utility', model_name: 'glm-fast' },
      { id: 'ctx-reasoner', name: 'Context Reasoner', settings: { model: 'o-reasoner' } }
    ];
  }
};
const contextProfiles = listProviderConnectionProfiles({
  context: { ConnectionManagerRequestService: contextProfileService },
  globals: {}
});
assertDeepEqual(
  contextProfiles.map((profile) => [profile.id, profile.label, profile.model]),
  [
    ['ctx-utility', 'Context Utility / glm-fast', 'glm-fast'],
    ['ctx-reasoner', 'Context Reasoner / o-reasoner', 'o-reasoner']
  ],
  'connection profiles are detected from context.ConnectionManagerRequestService'
);

const objectMapProfiles = listProviderConnectionProfiles({
  context: {
    state: {
      connectionManager: {
        profiles: {
          mapUtility: { uuid: 'map-utility', title: 'Map Utility', generationSettings: { model: 'map-fast' } },
          mapReasoner: { profile_id: 'map-reasoner', profileName: 'Map Reasoner', modelId: 'map-deep' }
        }
      }
    }
  },
  globals: {}
});
assertDeepEqual(
  objectMapProfiles.map((profile) => [profile.id, profile.label, profile.model]),
  [
    ['map-utility', 'Map Utility / map-fast', 'map-fast'],
    ['map-reasoner', 'Map Reasoner / map-deep', 'map-deep']
  ],
  'connection profiles are detected from nested object-map host state'
);

const profileStatus = providerModelStatus({
  lane: 'utility',
  source: 'host-connection-profile',
  hostConnectionProfileId: 'ctx-utility'
}, {
  context: { ConnectionManagerRequestService: contextProfileService },
  globals: {}
});
assertEqual(profileStatus.ready, true, 'provider status reports selected connection profile ready');
assertEqual(profileStatus.model, 'glm-fast', 'provider status resolves connection profile model');
assertEqual(profileStatus.label, 'Context Utility / glm-fast', 'provider status exposes readable profile/model label');

const directValidation = validateProviderConfiguration({
  source: 'openai-compatible',
  openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
  maxTokens: 4096
});
assertEqual(directValidation.ready, false, 'OpenAI-compatible validation catches missing setup');
assertDeepEqual(
  directValidation.missing,
  ['baseUrl', 'model', 'sessionApiKey'],
  'OpenAI-compatible validation names missing setup fields'
);

const routeSummary = providerRouteSummary({
  reasoningLevel: 'high',
  providers: {
    reasoner: { enabled: true, lastTest: { status: 'pass' } }
  }
});
assertEqual(routeSummary.level, 'high', 'provider route summary tracks reasoning level');
assert(routeSummary.text.includes('Arbiter: Reasoner'), 'provider route summary exposes Reasoner Arbiter route');
assert(routeSummary.text.includes('Composer: Reasoner'), 'provider route summary exposes Reasoner composer route');

const modelFetchCalls = [];
const fetchedModels = await fetchOpenAICompatibleModels({
  baseUrl: 'https://models.example/v1/chat/completions',
  apiKey: 'sk-live-secret',
  fetchImpl: async (url, init = {}) => {
    modelFetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            { id: 'alpha-model', name: 'Alpha Model' },
            { id: 'beta-model' }
          ]
        };
      }
    };
  }
});
assertDeepEqual(
  fetchedModels.models.map((model) => [model.id, model.label]),
  [
    ['alpha-model', 'Alpha Model'],
    ['beta-model', 'beta-model']
  ],
  'OpenAI-compatible model fetch parses /models data'
);
assertEqual(modelFetchCalls[0].url, 'https://models.example/v1/models', 'OpenAI-compatible model fetch normalizes endpoint to /models');
assertEqual(modelFetchCalls[0].init.method, 'GET', 'OpenAI-compatible model fetch uses GET');
assertEqual(modelFetchCalls[0].init.headers.Authorization, 'Bearer sk-live-secret', 'OpenAI-compatible model fetch sends session bearer key');
assertNoSecret(fetchedModels, 'OpenAI-compatible model fetch result does not expose session secret');

const calls = [];
const host = {
  generation: {
    async generate(request) {
      calls.push(request);
      return { text: responseTextForRole(request.roleId), providerId: 'fake-host', model: 'fake-model' };
    },
    async batch(requests) {
      return Promise.all(requests.map((request) => this.generate(request)));
    }
  }
};
const store = createStore();
const client = createProviderClient({ host, settingsStore: store });
const router = createGenerationRouter({ client });
const result = await router.generate('utilityArbiter', { prompt: 'Return JSON' });
assertEqual(result.ok, true, 'generation succeeds');
assertEqual(result.data.ok, true, 'json data parsed');
assertEqual(calls[0].lane, 'utility', 'utility lane selected');
assertEqual(calls[0].roleId, 'utilityArbiter', 'role id passed to host');
assertEqual(calls[0].providerSource, 'host-current-model', 'provider source passed to host');

store.update({ reasonerUse: 'always' });
store.updateProvider('reasoner', { enabled: true });
const reasoner = await router.generate('reasonerComposer', { prompt: 'Reason' });
assertEqual(reasoner.ok, true, 'reasoner route succeeds');
assertEqual(calls.at(-1).lane, 'reasoner', 'reasoner lane selected');

const utilityOverride = await router.generate('reasonerComposer', { lane: 'utility', prompt: 'Use utility override' });
assertEqual(utilityOverride.ok, true, 'reasoner role can be explicitly routed to utility');
assertEqual(calls.at(-1).lane, 'utility', 'explicit utility lane override applied');

const callsBeforeUnknownRole = calls.length;
const unknownRole = await router.generate('unknownRole', { lane: 'utility', prompt: 'Do not route unknown roles.' });
assertEqual(unknownRole.ok, false, 'unknown provider role fails');
assertEqual(unknownRole.error.code, 'RECURSION_PROVIDER_ROLE_UNSUPPORTED', 'unknown provider role uses stable error code');
assertEqual(calls.length, callsBeforeUnknownRole, 'unknown provider role does not call host generation');

const batchCallsBeforeUnknownRole = calls.length;
const unknownRoleBatch = await router.batch([
  { roleId: 'utilityArbiter', prompt: 'Known role still runs.' },
  { roleId: 'unknownRole', prompt: 'Unknown role should fail.' }
]);
assertEqual(unknownRoleBatch[0].ok, true, 'batch with unknown role keeps known slot successful');
assertEqual(unknownRoleBatch[1].ok, false, 'batch with unknown role fails unknown slot');
assertEqual(unknownRoleBatch[1].error.code, 'RECURSION_PROVIDER_ROLE_UNSUPPORTED', 'batch unknown role uses stable error code');
assertEqual(calls.length, batchCallsBeforeUnknownRole + 1, 'batch unknown role does not call host for unknown slot');

const batchCallsBeforeMalformedEntry = calls.length;
const malformedEntryBatch = await router.batch([
  { roleId: 'utilityArbiter', prompt: 'Known role still runs after malformed sibling.' },
  null,
  { prompt: 'Missing role should fail without aborting sibling slots.' }
], { runId: 'provider-batch-malformed-entry' });
assertEqual(malformedEntryBatch[0].ok, true, 'batch with malformed entry keeps known slot successful');
assertEqual(malformedEntryBatch[1].ok, false, 'batch with malformed entry fails only malformed slot');
assertEqual(malformedEntryBatch[1].error.code, 'RECURSION_PROVIDER_REQUEST_INVALID', 'batch malformed entry uses stable error code');
assertEqual(malformedEntryBatch[2].ok, false, 'batch with missing role fails only missing-role slot');
assertEqual(malformedEntryBatch[2].error.code, 'RECURSION_PROVIDER_ROLE_MISSING', 'batch missing role uses stable error code');
assertEqual(calls.length, batchCallsBeforeMalformedEntry + 1, 'batch malformed entries do not call host');
assertDeepEqual(
  malformedEntryBatch.map((entry) => entry.diagnostics.runId),
  ['provider-batch-malformed-entry', 'provider-batch-malformed-entry', 'provider-batch-malformed-entry'],
  'batch malformed-entry diagnostics keep shared run id'
);

const wrongSchemaRouter = createGenerationRouter({
  client: {
    async generate() {
      return { text: '{"schema":"wrong.schema","ok":true}', providerId: 'fake-host', model: 'fake-model' };
    },
    async batch(requests) {
      return requests.map((request) => ({
        text: request.roleId === 'utilityArbiter'
          ? '{"schema":"recursion.utilityArbiter.v1","snapshotHash":"hash-ok"}'
          : '{"schema":"wrong.schema","ok":true}',
        providerId: 'fake-host',
        model: 'fake-model'
      }));
    }
  }
});
const wrongSchema = await wrongSchemaRouter.generate('providerTest', { prompt: 'Wrong schema.' });
assertEqual(wrongSchema.ok, false, 'known provider role rejects mismatched schema');
assertEqual(wrongSchema.error.code, 'RECURSION_PROVIDER_SCHEMA_MISMATCH', 'known provider role schema mismatch uses stable error code');
const wrongSchemaBatch = await wrongSchemaRouter.batch([
  { roleId: 'utilityArbiter', prompt: 'Known valid schema.' },
  { roleId: 'providerTest', prompt: 'Known wrong schema.' }
]);
assertEqual(wrongSchemaBatch[0].ok, true, 'batch schema validation keeps valid slot successful');
assertEqual(wrongSchemaBatch[1].ok, false, 'batch schema validation fails wrong-schema slot');
assertEqual(wrongSchemaBatch[1].error.code, 'RECURSION_PROVIDER_SCHEMA_MISMATCH', 'batch wrong-schema slot uses stable error code');

const reasonerOverrideStore = createStore();
const reasonerOverrideRouter = createGenerationRouter({
  client: createProviderClient({ host, settingsStore: reasonerOverrideStore })
});
const disabledLaneOverride = await reasonerOverrideRouter.generate('utilityArbiter', { lane: 'reasoner', prompt: 'Disabled reasoner override' });
assertEqual(disabledLaneOverride.ok, false, 'utility role cannot use disabled reasoner lane');
assertEqual(disabledLaneOverride.error.code, 'RECURSION_REASONER_DISABLED', 'disabled lane override exposes reasoner disabled code');
reasonerOverrideStore.update({ reasonerUse: 'always' });
reasonerOverrideStore.updateProvider('reasoner', { enabled: true });
const enabledLaneOverride = await reasonerOverrideRouter.generate('utilityArbiter', { lane: 'reasoner', prompt: 'Enabled reasoner override' });
assertEqual(enabledLaneOverride.ok, true, 'utility role can use enabled explicit reasoner lane');
assertEqual(calls.at(-1).lane, 'reasoner', 'explicit reasoner lane override applied when enabled');

const malformedHost = {
  generation: {
    async generate() {
      return { text: 'not-json', providerId: 'fake-host', model: 'fake-model' };
    }
  }
};
const malformedStore = createStore();
const malformedRouter = createGenerationRouter({
  client: createProviderClient({ host: malformedHost, settingsStore: malformedStore })
});
const malformed = await malformedRouter.generate('utilityArbiter', { prompt: 'Return bad JSON' });
assertEqual(malformed.ok, false, 'malformed json returns failure result');
assertEqual(malformed.error.code, 'RECURSION_JSON_PARSE_FAILED', 'malformed json exposes useful parse code');

let retryAttempts = 0;
const retryHost = {
  generation: {
    async generate() {
      retryAttempts += 1;
      if (retryAttempts === 1) {
        const error = new Error('temporary network failure');
        error.code = 'ECONNRESET';
        error.retryable = true;
        throw error;
      }
      return { text: responseTextForRole('utilityArbiter') };
    }
  }
};
const retryRouter = createGenerationRouter({
  client: createProviderClient({ host: retryHost, settingsStore: createStore() })
});
const retried = await retryRouter.generate('utilityArbiter', { prompt: 'Retry once' });
assertEqual(retried.ok, true, 'transient retry succeeds');
assertEqual(retryAttempts, 2, 'transient failure retries exactly once');
assertEqual(retried.diagnostics.retryCount, 1, 'retry count recorded');

let staleRetryAttempts = 0;
const staleRetryGuardContexts = [];
const staleRetryRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          staleRetryAttempts += 1;
          const error = new Error('temporary network failure after superseded run');
          error.code = 'ECONNRESET';
          error.retryable = true;
          throw error;
        }
      }
    },
    settingsStore: createStore()
  })
});
const staleRetry = await staleRetryRouter.generate('utilityArbiter', { prompt: 'Do not retry stale run' }, {
  runId: 'stale-single-run',
  async isCurrent(context) {
    staleRetryGuardContexts.push(context);
    return false;
  }
});
assertEqual(staleRetry.ok, false, 'stale single retry returns failure result');
assertEqual(staleRetryAttempts, 1, 'stale single retry guard prevents second attempt');
assertEqual(staleRetry.error.code, 'ECONNRESET', 'stale single retry keeps sanitized provider failure code');
assertEqual(staleRetry.diagnostics.retryCount, 0, 'stale single retry does not count a skipped retry');
assertEqual(staleRetry.diagnostics.retrySkippedReason, 'stale-current-guard', 'stale single retry records skipped retry reason');
assertEqual(staleRetryGuardContexts.length, 1, 'stale single retry checks freshness once');
assertEqual(staleRetryGuardContexts[0].roleId, 'utilityArbiter', 'stale single retry guard receives role id');
assertEqual(staleRetryGuardContexts[0].lane, 'utility', 'stale single retry guard receives lane');
assertEqual(staleRetryGuardContexts[0].runId, 'stale-single-run', 'stale single retry guard receives run id');
assertEqual(staleRetryGuardContexts[0].attempt, 1, 'stale single retry guard receives next attempt number');

let requestSignalRetryAttempts = 0;
const requestSignalRetryController = new AbortController();
const requestSignalOptionsController = new AbortController();
const requestSignalRetry = await createGenerationRouter({
  client: {
    async generate() {
      requestSignalRetryAttempts += 1;
      if (requestSignalRetryAttempts === 1) {
        requestSignalRetryController.abort();
        const error = new Error('temporary failure after request was aborted');
        error.code = 'ECONNRESET';
        error.retryable = true;
        throw error;
      }
      return { text: responseTextForRole('utilityArbiter') };
    }
  }
}).generate('utilityArbiter', {
  prompt: 'Request signal should block retry.',
  signal: requestSignalRetryController.signal
}, {
  runId: 'request-signal-retry-guard',
  signal: requestSignalOptionsController.signal
});
assertEqual(requestSignalRetry.ok, false, 'aborted request signal blocks single retry even when options signal is open');
assertEqual(requestSignalRetryAttempts, 1, 'aborted request signal prevents second single attempt');
assertEqual(requestSignalRetry.diagnostics.retrySkippedReason, 'aborted', 'aborted request signal records skipped retry reason');

let throwingGuardAttempts = 0;
const throwingGuard = await createGenerationRouter({
  client: {
    async generate() {
      throwingGuardAttempts += 1;
      const error = new Error('temporary failure before throwing guard');
      error.code = 'ECONNRESET';
      error.retryable = true;
      throw error;
    }
  }
}).generate('utilityArbiter', { prompt: 'Throwing retry guard.' }, {
  runId: 'throwing-guard-single-run',
  isRetryCurrent() {
    throw new Error('guard unavailable');
  }
});
assertEqual(throwingGuard.ok, false, 'throwing retry guard returns failure result');
assertEqual(throwingGuardAttempts, 1, 'throwing retry guard prevents second attempt');
assertEqual(throwingGuard.diagnostics.retrySkippedReason, 'current-guard-failed', 'throwing retry guard records current-guard-failed reason');

let nonTransientAttempts = 0;
const nonTransientHost = {
  generation: {
    async generate() {
      nonTransientAttempts += 1;
      const error = new Error('bad request');
      error.code = 'RECURSION_BAD_REQUEST';
      error.retryable = false;
      throw error;
    }
  }
};
const nonTransientRouter = createGenerationRouter({
  client: createProviderClient({ host: nonTransientHost, settingsStore: createStore() })
});
const nonTransient = await nonTransientRouter.generate('utilityArbiter', { prompt: 'Do not retry' });
assertEqual(nonTransient.ok, false, 'non-transient failure returns failure result');
assertEqual(nonTransientAttempts, 1, 'non-transient failure is not retried');

const disabledReasonerCalls = [];
const disabledReasonerRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate(request) {
          disabledReasonerCalls.push(request);
          return { text: '{"schema":"should.not.call"}' };
        }
      }
    },
    settingsStore: createStore()
  })
});
const disabledReasoner = await disabledReasonerRouter.generate('reasonerComposer', { prompt: 'Reason disabled' });
assertEqual(disabledReasoner.ok, false, 'disabled reasoner returns failure result');
assertEqual(disabledReasoner.error.code, 'RECURSION_REASONER_DISABLED', 'disabled reasoner exposes stable code');
assertEqual(disabledReasonerCalls.length, 0, 'disabled reasoner does not call host');

let missingKeyFetches = 0;
const missingKeyStore = createStore();
missingKeyStore.updateProvider('utility', {
  source: 'openai-compatible',
  openAICompatible: { baseUrl: 'https://example.test/v1', model: 'utility-model' }
});
const missingKeyRouter = createGenerationRouter({
  client: createProviderClient({
    settingsStore: missingKeyStore,
    fetchImpl: async () => {
      missingKeyFetches += 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    }
  })
});
const missingKey = await missingKeyRouter.generate('utilityArbiter', { prompt: 'Needs key' });
assertEqual(missingKey.ok, false, 'missing direct endpoint key returns failure result');
assertEqual(missingKey.error.code, 'RECURSION_PROVIDER_KEY_MISSING', 'missing key exposes stable code');
assertEqual(missingKeyFetches, 0, 'missing key does not call fetch');

const fallbackBatchCalls = [];
const fallbackBatchClient = createProviderClient({
  host: {
    generation: {
      async generate(request) {
        fallbackBatchCalls.push(request);
        return { text: `{"schema":"${request.roleId}","lane":"${request.lane}"}` };
      }
    }
  },
  settingsStore: createStore()
});
const fallbackBatchResults = await fallbackBatchClient.batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'briefUtilityComposer', prompt: 'B' }
]);
assertEqual(fallbackBatchResults.length, 2, 'batch fallback returns all results');
assertDeepEqual(fallbackBatchCalls.map((request) => request.roleId), ['utilityArbiter', 'briefUtilityComposer'], 'batch fallback enriches role ids');
assertDeepEqual(fallbackBatchCalls.map((request) => request.lane), ['utility', 'utility'], 'batch fallback enriches lanes');

const hostBatchCalls = [];
const hostBatchClient = createProviderClient({
  host: {
    generation: {
      async generate() {
        throw new Error('host generate should not be used when batch is available');
      },
      async batch(requests) {
        hostBatchCalls.push(...requests);
        return requests.map((request) => ({ text: `{"schema":"${request.roleId}","lane":"${request.lane}"}` }));
      }
    }
  },
  settingsStore: createStore()
});
const hostBatchResults = await hostBatchClient.batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
]);
assertEqual(hostBatchResults.length, 2, 'host batch returns all responses');
assertDeepEqual(hostBatchCalls.map((request) => request.roleId), ['utilityArbiter', 'providerTest'], 'host batch receives enriched role ids');
assertDeepEqual(hostBatchCalls.map((request) => request.lane), ['utility', 'utility'], 'host batch receives enriched lanes');

let routerHostBatchCallCount = 0;
let routerHostGenerateCallCount = 0;
const routerHostBatchCalls = [];
const routerHostBatchRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate(request) {
          routerHostGenerateCallCount += 1;
          return { text: responseTextForRole(request.roleId, { lane: request.lane }) };
        },
        async batch(requests) {
          routerHostBatchCallCount += 1;
          routerHostBatchCalls.push(requests);
          return requests.map((request) => ({ text: responseTextForRole(request.roleId, { lane: request.lane }) }));
        }
      }
    },
    settingsStore: createStore()
  })
});
const routerHostBatchResults = await routerHostBatchRouter.batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
]);
assertEqual(routerHostBatchCallCount, 1, 'router batch calls host/client batch once when available');
assertEqual(routerHostGenerateCallCount, 0, 'router batch does not call host/client single generate when batch is available');
assertDeepEqual(routerHostBatchCalls[0].map((request) => request.roleId), ['utilityArbiter', 'providerTest'], 'router batch sends enriched role ids to host batch');
assertDeepEqual(routerHostBatchResults.map((entry) => entry.ok), [true, true], 'router batch returns router-style success results');
assertDeepEqual(
  routerHostBatchResults.map((entry) => entry.data.schema),
  ['recursion.utilityArbiter.v1', 'recursion.providerTest.v1'],
  'router batch validates each response schema'
);

const suppliedBatchRunId = 'provider-batch-run-test';
const routerRunIdBatch = await routerHostBatchRouter.batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], { runId: suppliedBatchRunId });
assertDeepEqual(routerRunIdBatch.map((entry) => entry.diagnostics.runId), [suppliedBatchRunId, suppliedBatchRunId], 'router batch diagnostics use supplied shared run id');
assertDeepEqual(routerRunIdBatch.map((entry) => entry.roleId), ['utilityArbiter', 'providerTest'], 'router batch preserves role ids in parsed results');

let transientBatchCalls = 0;
const transientBatch = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for transient batch retry');
    },
    async batch(requests) {
      transientBatchCalls += 1;
      if (transientBatchCalls === 1) {
        const error = new Error('temporary reset');
        error.code = 'ECONNRESET';
        throw error;
      }
      return requests.map((request) => ({ text: responseTextForRole(request.roleId, { lane: request.lane }) }));
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], { runId: 'provider-batch-transient-retry' });
assertEqual(transientBatchCalls, 2, 'router batch retries one transient transport failure');
assertDeepEqual(transientBatch.map((entry) => entry.ok), [true, true], 'transient retry returns successful batch entries');
assertDeepEqual(transientBatch.map((entry) => entry.diagnostics.retryCount), [1, 1], 'retried batch entries record retry count');

let staleBatchCalls = 0;
const staleBatchGuardContexts = [];
const staleBatch = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for stale batch retry');
    },
    async batch() {
      staleBatchCalls += 1;
      const error = new Error('temporary batch reset after superseded run');
      error.code = 'ECONNRESET';
      error.retryable = true;
      throw error;
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], {
  runId: 'stale-batch-run',
  async isCurrent(context) {
    staleBatchGuardContexts.push(context);
    return false;
  }
});
assertEqual(staleBatchCalls, 1, 'stale batch retry guard prevents second batch call');
assertDeepEqual(staleBatch.map((entry) => entry.ok), [false, false], 'stale batch retry returns failure entries');
assertDeepEqual(staleBatch.map((entry) => entry.error.code), ['ECONNRESET', 'ECONNRESET'], 'stale batch retry keeps sanitized provider failure codes');
assertDeepEqual(staleBatch.map((entry) => entry.diagnostics.retryCount), [0, 0], 'stale batch retry does not count skipped retry');
assertDeepEqual(
  staleBatch.map((entry) => entry.diagnostics.retrySkippedReason),
  ['stale-current-guard', 'stale-current-guard'],
  'stale batch retry records skipped retry reason for pending entries'
);
assertEqual(staleBatchGuardContexts.length, 1, 'stale batch retry checks freshness once');
assertEqual(staleBatchGuardContexts[0].runId, 'stale-batch-run', 'stale batch retry guard receives run id');
assertEqual(staleBatchGuardContexts[0].attempt, 1, 'stale batch retry guard receives next attempt number');
assertEqual(staleBatchGuardContexts[0].batch, true, 'stale batch retry guard identifies batch retry');
assertDeepEqual(
  staleBatchGuardContexts[0].entries.map((entry) => entry.roleId),
  ['utilityArbiter', 'providerTest'],
  'stale batch retry guard receives pending batch entries'
);

const routerMalformedSlot = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for malformed batch test');
    },
    async batch() {
      return [
        { text: responseTextForRole('utilityArbiter'), roleId: 'utilityArbiter', lane: 'utility', providerId: 'fake-host', model: 'fake-model' },
        { text: 'not-json', roleId: 'providerTest', lane: 'utility', providerId: 'fake-host', model: 'fake-model' }
      ];
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], { runId: 'provider-batch-malformed-test' });
assertEqual(routerMalformedSlot[0].ok, true, 'router batch keeps valid slot successful when another slot is malformed');
assertEqual(routerMalformedSlot[1].ok, false, 'router batch returns failure result for malformed slot');
assertEqual(routerMalformedSlot[1].error.code, 'RECURSION_JSON_PARSE_FAILED', 'router batch malformed slot exposes parse code');

const routerBatchLeakActivity = createActivityReporter();
const routerBatchLeakJournal = [];
const routerBatchLeak = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for leak batch test');
    },
    async batch() {
      return [
        { text: responseTextForRole('utilityArbiter'), roleId: 'utilityArbiter', lane: 'utility', providerId: 'fake-host', model: 'fake-model' },
        { text: 'RAW_BATCH_RESPONSE_MARKER_42 not json', roleId: 'providerTest', lane: 'utility', providerId: 'fake-host', model: 'fake-model' }
      ];
    }
  },
  activity: routerBatchLeakActivity,
  journal: { append: (entry) => routerBatchLeakJournal.push(entry) }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A', snapshotHash: 'batch-snapshot-a' },
  { roleId: 'providerTest', prompt: 'B', snapshotHash: 'batch-snapshot-b' }
], { runId: 'provider-batch-leak-test', timeoutMs: 3456 });
assertEqual(routerBatchLeak[0].ok, true, 'router batch leak regression keeps valid slot successful');
assertEqual(routerBatchLeak[1].ok, false, 'router batch leak regression returns failure for malformed slot');
assertDeepEqual(
  routerBatchLeakJournal.map((entry) => entry.status),
  ['started', 'started', 'success', 'validation-failed'],
  'router batch journal records started events before slot outcomes'
);
assertDeepEqual(
  routerBatchLeakJournal.slice(0, 2).map((entry) => entry.roleId),
  ['utilityArbiter', 'providerTest'],
  'router batch started journal records each role'
);
assertDeepEqual(
  routerBatchLeakJournal.slice(0, 2).map((entry) => entry.snapshotHash),
  ['batch-snapshot-a', 'batch-snapshot-b'],
  'router batch started journal records each request snapshot hash'
);
assertDeepEqual(
  routerBatchLeakJournal.map((entry) => entry.timeoutMs),
  [3456, 3456, 3456, 3456],
  'router batch journal records effective timeout on every entry'
);
assertNoRawBatchMarker(routerBatchLeak, 'router batch result diagnostics do not expose raw malformed provider response');
assertNoRawBatchMarker(routerBatchLeakJournal, 'router batch journal does not expose raw malformed provider response');
assertNoRawBatchMarker(routerBatchLeakActivity.history(), 'router batch activity does not expose raw malformed provider response');
assertEqual(routerBatchLeakActivity.current().phase, 'settled', 'router batch activity settles after all slots');
assertEqual(routerBatchLeakActivity.current().severity, 'warning', 'router batch activity reports mixed slot failure as warning');
assert(routerBatchLeakActivity.current().detail.failed === 1, 'router batch activity detail records failed slot count');

const abortedBatchController = new AbortController();
abortedBatchController.abort();
const abortedBatchJournal = [];
const abortedBatch = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for aborted batch slot');
    },
    async batch() {
      throw new Error('provider batch should not run aborted slot');
    }
  },
  journal: { append: (entry) => abortedBatchJournal.push(entry) }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'Aborted before batch.', signal: abortedBatchController.signal }
], { runId: 'provider-batch-aborted-slot' });
assertEqual(abortedBatch[0].ok, false, 'aborted batch slot returns failure result');
assertDeepEqual(
  abortedBatchJournal.map((entry) => entry.status),
  ['aborted'],
  'aborted batch slot does not record a provider-call started event'
);

let routerSequentialFallbackCalls = 0;
const routerSequentialFallback = await createGenerationRouter({
  client: {
    async generate(roleId, request) {
      routerSequentialFallbackCalls += 1;
      return { text: responseTextForRole(roleId, { lane: request.lane || 'utility' }) };
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
]);
assertEqual(routerSequentialFallbackCalls, 2, 'router batch falls back to sequential generate when client batch is absent');
assertDeepEqual(
  routerSequentialFallback.map((entry) => entry.data.schema),
  ['recursion.utilityArbiter.v1', 'recursion.providerTest.v1'],
  'router batch sequential fallback validates response schemas'
);
assert(routerSequentialFallback[0].diagnostics.runId.startsWith('provider-batch-'), 'router sequential fallback mints a batch run id');
assertEqual(
  routerSequentialFallback[1].diagnostics.runId,
  routerSequentialFallback[0].diagnostics.runId,
  'router sequential fallback uses one shared batch run id'
);

let routerSequentialFallbackActivityStarts = 0;
const routerSequentialFallbackActivity = await createGenerationRouter({
  client: {
    async generate(roleId, request) {
      return { text: responseTextForRole(roleId, { lane: request.lane || 'utility' }) };
    }
  },
  activity: {
    start(event) {
      routerSequentialFallbackActivityStarts += 1;
      return { ...event, runId: `${event.runId}-activity-${routerSequentialFallbackActivityStarts}` };
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A', runId: 'slot-a-run' },
  { roleId: 'providerTest', prompt: 'B', runId: 'slot-b-run' }
]);
assertEqual(routerSequentialFallbackActivityStarts, 2, 'router sequential fallback still emits per-slot start activity');
assert(routerSequentialFallbackActivity[0].diagnostics.runId.startsWith('provider-batch-'), 'router sequential fallback ignores per-slot request run ids');
assertEqual(
  routerSequentialFallbackActivity[1].diagnostics.runId,
  routerSequentialFallbackActivity[0].diagnostics.runId,
  'router sequential fallback keeps shared run id even when activity returns per-slot ids'
);

const badHostBatchClient = createProviderClient({
  host: {
    generation: {
      async batch() {
        return [{ text: '{"schema":"only-one"}' }];
      }
    }
  },
  settingsStore: createStore()
});
let badBatchCode = '';
try {
  await badHostBatchClient.batch([
    { roleId: 'utilityArbiter', prompt: 'A' },
    { roleId: 'providerTest', prompt: 'B' }
  ]);
} catch (error) {
  badBatchCode = error.code;
}
assertEqual(badBatchCode, 'RECURSION_PROVIDER_BATCH_INVALID', 'host batch validates response length');

const fetchCalls = [];
const openAiStore = createStore();
openAiStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'session-key',
  openAICompatible: { baseUrl: 'https://provider.test/v1/', model: 'utility-model' },
  temperature: 0.25,
  topP: 0.8,
  maxTokens: 321
});
const openAiRouter = createGenerationRouter({
  client: createProviderClient({
    settingsStore: openAiStore,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({
          id: 'chatcmpl-test',
          model: 'utility-model',
          choices: [{ message: { content: responseTextForRole('utilityArbiter') } }]
        })
      };
    }
  })
});
const openAiResult = await openAiRouter.generate('utilityArbiter', { prompt: 'OpenAI compatible' });
assertEqual(openAiResult.ok, true, 'openai-compatible route succeeds');
assertEqual(fetchCalls[0].url, 'https://provider.test/v1/chat/completions', 'openai-compatible endpoint is constructed');
assertEqual(fetchCalls[0].options.headers.Authorization, 'Bearer session-key', 'session key sent as bearer token');
assertEqual(fetchCalls[0].body.model, 'utility-model', 'configured model sent');
assertEqual(fetchCalls[0].body.temperature, 0.25, 'configured temperature sent');
assertEqual(fetchCalls[0].body.top_p, 0.8, 'configured top_p sent');
assertEqual(fetchCalls[0].body.max_tokens, 321, 'configured max tokens sent');
assertEqual(fetchCalls[0].body.messages[0].content, 'OpenAI compatible', 'prompt sent as chat message');

const invalidUrlStore = createStore();
invalidUrlStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'session-key',
  openAICompatible: { baseUrl: 'not a url', model: 'utility-model' }
});
let invalidUrlFetches = 0;
const invalidUrlResult = await createGenerationRouter({
  client: createProviderClient({
    settingsStore: invalidUrlStore,
    fetchImpl: async () => {
      invalidUrlFetches += 1;
      return { ok: true, json: async () => ({}) };
    }
  })
}).generate('utilityArbiter', { prompt: 'Invalid URL' });
assertEqual(invalidUrlResult.ok, false, 'invalid openai base url returns failure result');
assertEqual(invalidUrlResult.error.code, 'RECURSION_PROVIDER_CONFIG_INVALID', 'invalid base url exposes config error');
assertEqual(invalidUrlFetches, 0, 'invalid base url does not call fetch');

const invalidProtocolStore = createStore();
invalidProtocolStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'session-key',
  openAICompatible: { baseUrl: 'ftp://provider.test/v1', model: 'utility-model' }
});
let invalidProtocolFetches = 0;
const invalidProtocolResult = await createGenerationRouter({
  client: createProviderClient({
    settingsStore: invalidProtocolStore,
    fetchImpl: async () => {
      invalidProtocolFetches += 1;
      return { ok: true, json: async () => ({}) };
    }
  })
}).generate('utilityArbiter', { prompt: 'Invalid protocol' });
assertEqual(invalidProtocolResult.ok, false, 'invalid openai base protocol returns failure result');
assertEqual(invalidProtocolResult.error.code, 'RECURSION_PROVIDER_CONFIG_INVALID', 'invalid protocol exposes config error');
assertEqual(invalidProtocolFetches, 0, 'invalid protocol does not call fetch');

const badJsonStore = createStore();
badJsonStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'session-key',
  openAICompatible: { baseUrl: 'https://bad-json.test/v1', model: 'utility-model' }
});
const badJsonResult = await createGenerationRouter({
  client: createProviderClient({
    settingsStore: badJsonStore,
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('not provider json');
      }
    })
  })
}).generate('utilityArbiter', { prompt: 'Bad response JSON' });
assertEqual(badJsonResult.ok, false, 'bad provider response json returns failure result');
assertEqual(badJsonResult.error.code, 'RECURSION_PROVIDER_RESPONSE_JSON_INVALID', 'bad response json exposes stable code');

const authFailureStore = createStore();
authFailureStore.updateProvider('reasoner', {
  enabled: true,
  source: 'openai-compatible',
  apiKey: 'sk-live-secret',
  openAICompatible: { baseUrl: 'https://auth-failure.test/v1', model: 'reasoner-model' }
});
authFailureStore.updateProvider('reasoner', {
  resolvedProviderLabel: 'stale-provider',
  resolvedModelLabel: 'stale-model',
  lastTest: { status: 'pass', checkedAt: '2026-07-01T00:00:00.000Z' }
});
let authFailureFetches = 0;
const authFailureResult = await createGenerationRouter({
  client: createProviderClient({
    settingsStore: authFailureStore,
    fetchImpl: async () => {
      authFailureFetches += 1;
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Invalid sk-live-secret' } })
      };
    }
  })
}).generate('reasonerComposer', { prompt: 'Auth failure must mark health failed.' });
const authFailureReasoner = authFailureStore.get().providers.reasoner;
assertEqual(authFailureResult.ok, false, 'openai auth failure returns failure result');
assertEqual(authFailureResult.error.code, 'RECURSION_PROVIDER_AUTH_FAILED', 'openai auth failure exposes stable auth code');
assertEqual(authFailureFetches, 1, 'openai auth failure is not retried');
assertEqual(authFailureReasoner.lastTest.status, 'fail', 'openai auth failure marks lane test status failed');
assertEqual(authFailureReasoner.lastTest.compactError, 'OpenAI-compatible authentication failed.', 'openai auth failure records stable compact error');
assertEqual(authFailureReasoner.resolvedProviderLabel, '', 'openai auth failure clears stale provider label');
assertEqual(authFailureReasoner.resolvedModelLabel, '', 'openai auth failure clears stale model label');
assertEqual(authFailureReasoner.openAICompatible.sessionApiKeyPresent, false, 'openai auth failure clears invalid session key');
assertEqual(authFailureReasoner.openAICompatible.baseUrl, 'https://auth-failure.test/v1', 'openai auth failure preserves non-secret base URL');
assertEqual(authFailureReasoner.openAICompatible.model, 'reasoner-model', 'openai auth failure preserves non-secret model');
assertNoSecret(authFailureResult, 'openai auth failure result redacts session key');
assertNoSecret(authFailureReasoner, 'openai auth failure provider health redacts session key');

const forbiddenAuthStore = createStore();
forbiddenAuthStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'sk-live-secret',
  openAICompatible: { baseUrl: 'https://auth-forbidden.test/v1', model: 'utility-model' }
});
const forbiddenAuthResult = await createGenerationRouter({
  client: createProviderClient({
    settingsStore: forbiddenAuthStore,
    fetchImpl: async () => ({ ok: false, status: 403 })
  })
}).generate('utilityArbiter', { prompt: 'Forbidden auth failure.' });
assertEqual(forbiddenAuthResult.ok, false, 'openai forbidden auth failure returns failure result');
assertEqual(forbiddenAuthResult.error.code, 'RECURSION_PROVIDER_AUTH_FAILED', 'openai 403 auth failure exposes stable auth code');
assertEqual(forbiddenAuthStore.get().providers.utility.lastTest.status, 'fail', 'openai 403 auth failure marks lane unhealthy');

async function openAiProviderFailure(payload, prompt = 'OpenAI provider failure') {
  const marker = 'RAW_PROVIDER_NORMALIZER_MARKER';
  const activity = createActivityReporter();
  const journal = [];
  const store = createStore();
  store.updateProvider('utility', {
    source: 'openai-compatible',
    apiKey: 'session-key',
    openAICompatible: { baseUrl: 'https://normalizer.test/v1', model: 'normalizer-model' }
  });
  const router = createGenerationRouter({
    client: createProviderClient({
      settingsStore: store,
      fetchImpl: async () => ({
        ok: true,
        json: async () => payload(marker)
      })
    }),
    activity,
    journal: { append: (entry) => journal.push(entry) }
  });
  const result = await router.generate('utilityArbiter', { prompt });
  assertNoProviderMarker(result, marker, `${prompt} result does not expose raw provider text`);
  assertNoProviderMarker(activity.history(), marker, `${prompt} activity does not expose raw provider text`);
  assertNoProviderMarker(journal, marker, `${prompt} journal does not expose raw provider text`);
  return { result, activity, journal };
}

const tokenLimitFailure = await openAiProviderFailure((marker) => ({
  model: 'normalizer-model',
  choices: [{
    finish_reason: 'length',
    message: { content: `{"schema":"${marker}` }
  }]
}), 'Token limit response');
assertEqual(tokenLimitFailure.result.ok, false, 'token-limit provider response returns failure result');
assertEqual(tokenLimitFailure.result.error.code, 'RECURSION_PROVIDER_TOKEN_LIMIT', 'token-limit response exposes stable code');
assertEqual(tokenLimitFailure.result.diagnostics.status, 'provider-failed', 'token-limit response is a provider failure, not a JSON parse failure');

const reasoningOnlyFailure = await openAiProviderFailure((marker) => ({
  model: 'normalizer-model',
  choices: [{
    finish_reason: 'stop',
    message: {
      content: '',
      reasoning_content: `private reasoning ${marker}`
    }
  }]
}), 'Reasoning-only response');
assertEqual(reasoningOnlyFailure.result.ok, false, 'reasoning-only provider response returns failure result');
assertEqual(reasoningOnlyFailure.result.error.code, 'RECURSION_PROVIDER_REASONING_ONLY', 'reasoning-only response exposes stable code');

const emptyVisibleFailure = await openAiProviderFailure(() => ({
  model: 'normalizer-model',
  choices: [{ finish_reason: 'stop', message: { content: '   ' } }]
}), 'Empty visible response');
assertEqual(emptyVisibleFailure.result.ok, false, 'empty visible provider response returns failure result');
assertEqual(emptyVisibleFailure.result.error.code, 'RECURSION_PROVIDER_EMPTY_RESPONSE', 'empty visible response exposes stable code');

const redactionActivityEvents = [];
const redactionJournalEntries = [];
const redactionStore = createStore();
redactionStore.updateProvider('utility', {
  source: 'openai-compatible',
  apiKey: 'sk-live-secret',
  openAICompatible: { baseUrl: 'https://redaction.test/v1', model: 'redaction-model' }
});
const redactionRouter = createGenerationRouter({
  client: createProviderClient({
    settingsStore: redactionStore,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        model: 'redaction-model',
        choices: [{ message: { content: responseTextForRole('utilityArbiter') } }]
      })
    })
  }),
  activity: {
    start(event) {
      redactionActivityEvents.push(event);
      return { ...event, runId: 'activity-assigned-run' };
    },
    stage(event) {
      redactionActivityEvents.push(event);
      return event;
    },
    settle(event) {
      redactionActivityEvents.push(event);
      return event;
    }
  },
  journal: {
    append(entry) {
      redactionJournalEntries.push(entry);
    }
  }
});
const redacted = await redactionRouter.generate('utilityArbiter', { prompt: 'Do not log sk-live-secret', snapshotHash: 'single-snapshot-hash' }, { timeoutMs: 2345 });
assertEqual(redacted.ok, true, 'redaction route succeeds');
assertEqual(redacted.diagnostics.runId, 'activity-assigned-run', 'returned diagnostics use activity-assigned run id');
assertEqual(redacted.diagnostics.snapshotHash, 'single-snapshot-hash', 'single provider diagnostics record request snapshot hash');
assertEqual(redacted.diagnostics.timeoutMs, 2345, 'single provider diagnostics record effective timeout');
assertDeepEqual(
  redactionJournalEntries.map((entry) => entry.status),
  ['started', 'success'],
  'provider journal records started before completion'
);
assertEqual(redactionJournalEntries[0].roleId, 'utilityArbiter', 'started journal records role id');
assertEqual(redactionJournalEntries[0].lane, 'utility', 'started journal records lane');
assertEqual(redactionJournalEntries[0].runId, 'activity-assigned-run', 'started journal uses activity-assigned run id');
assertEqual(redactionJournalEntries[0].requestHash, redacted.diagnostics.requestHash, 'started journal records request hash');
assertEqual(redactionJournalEntries[0].snapshotHash, 'single-snapshot-hash', 'started journal records request snapshot hash');
assertEqual(redactionJournalEntries[0].timeoutMs, 2345, 'started journal records effective timeout');
assertEqual(redactionJournalEntries.at(-1).runId, 'activity-assigned-run', 'journal uses activity-assigned run id');
assertEqual(redactionJournalEntries.at(-1).snapshotHash, 'single-snapshot-hash', 'success journal records request snapshot hash');
assertEqual(redactionJournalEntries.at(-1).timeoutMs, 2345, 'success journal records effective timeout');
assertEqual(redactionActivityEvents.at(-1).runId, 'activity-assigned-run', 'settle activity uses activity-assigned run id');
assertNoSecret(redacted.diagnostics, 'diagnostics do not leak API keys');
assertNoSecret(redactionActivityEvents, 'activity events do not leak API keys');
assertNoSecret(redactionJournalEntries, 'journal entries do not leak API keys');
assert(!JSON.stringify(redactionJournalEntries).includes('Do not log'), 'journal does not include raw prompts');

let asyncOrderJournal = [];
const asyncOrderRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          return { text: responseTextForRole('utilityArbiter') };
        }
      }
    },
    settingsStore: createStore()
  }),
  journal: {
    async append(entry) {
      const snapshot = asyncOrderJournal.slice();
      await new Promise((resolve) => setTimeout(resolve, entry.status === 'started' ? 10 : 0));
      asyncOrderJournal = [...snapshot, entry];
    }
  }
});
const asyncOrder = await asyncOrderRouter.generate('utilityArbiter', { prompt: 'Async journal ordering.' });
assertEqual(asyncOrder.ok, true, 'async journal ordering route succeeds');
await new Promise((resolve) => setTimeout(resolve, 20));
assertDeepEqual(
  asyncOrderJournal.map((entry) => entry.status),
  ['started', 'success'],
  'async provider journal preserves started before completion without lost writes'
);

const failurePrompt = 'Provider should not echo this prompt';
const failureRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          const error = new Error(`provider echoed ${failurePrompt} and sk-live-secret`);
          error.code = 'RECURSION_HOST_ECHO';
          error.retryable = false;
          throw error;
        }
      }
    },
    settingsStore: createStore()
  })
});
const failedRedaction = await failureRouter.generate('utilityArbiter', { prompt: failurePrompt });
assertEqual(failedRedaction.ok, false, 'provider failure returns structured result');
assertNoSecret(failedRedaction, 'provider failure result redacts secret-like text');
assert(!JSON.stringify(failedRedaction).includes(failurePrompt), 'provider failure result redacts echoed prompt');

const messageLeakMarker = 'MESSAGE_PROMPT_LEAK_42';
const messageFailureActivity = [];
const messageFailureJournal = [];
const messageFailureRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          const error = new Error(`provider echoed ${messageLeakMarker}`);
          error.code = 'RECURSION_MESSAGE_ECHO';
          error.retryable = false;
          throw error;
        }
      }
    },
    settingsStore: createStore()
  }),
  activity: {
    stage(event) {
      messageFailureActivity.push(event);
    },
    settle(event) {
      messageFailureActivity.push(event);
    }
  },
  journal: {
    append(entry) {
      messageFailureJournal.push(entry);
    }
  }
});
const messageFailure = await messageFailureRouter.generate('utilityArbiter', {
  messages: [{ role: 'user', content: messageLeakMarker }]
});
assertEqual(messageFailure.ok, false, 'message failure returns structured result');
assert(!JSON.stringify(messageFailure).includes(messageLeakMarker), 'message failure result redacts echoed message content');
assert(!JSON.stringify(messageFailureActivity).includes(messageLeakMarker), 'message failure activity redacts echoed message content');
assert(!JSON.stringify(messageFailureJournal).includes(messageLeakMarker), 'message failure journal redacts echoed message content');

const messageCodeLeakMarker = 'MESSAGE_CODE_LEAK_99';
const messageCodeActivity = [];
const messageCodeJournal = [];
const messageCodeRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate() {
          const error = new Error('provider failed with coded marker');
          error.code = `RECURSION_${messageCodeLeakMarker}`;
          error.retryable = false;
          throw error;
        }
      }
    },
    settingsStore: createStore()
  }),
  activity: {
    settle(event) {
      messageCodeActivity.push(event);
    }
  },
  journal: {
    append(entry) {
      messageCodeJournal.push(entry);
    }
  }
});
const messageCodeFailure = await messageCodeRouter.generate('utilityArbiter', {
  messages: [{ role: 'user', content: messageCodeLeakMarker }]
});
assertEqual(messageCodeFailure.ok, false, 'message-code failure returns structured result');
assert(!JSON.stringify(messageCodeFailure).includes(messageCodeLeakMarker), 'message-code failure result redacts echoed code content');
assert(!JSON.stringify(messageCodeActivity).includes(messageCodeLeakMarker), 'message-code failure activity redacts echoed code content');
assert(!JSON.stringify(messageCodeJournal).includes(messageCodeLeakMarker), 'message-code failure journal redacts echoed code content');

let timeoutAttempts = 0;
let timeoutSignalAborted = false;
const timeoutRouter = createGenerationRouter({
  client: createProviderClient({
    host: {
      generation: {
        async generate(request) {
          timeoutAttempts += 1;
          request.signal?.addEventListener('abort', () => {
            timeoutSignalAborted = true;
          });
          return new Promise(() => {});
        }
      }
    },
    settingsStore: createStore()
  }),
  timeoutMs: 5
});
const timedOut = await timeoutRouter.generate('utilityArbiter', { prompt: 'Never resolves' });
assertEqual(timedOut.ok, false, 'timeout returns failure result');
assertEqual(timedOut.error.code, 'RECURSION_PROVIDER_TIMEOUT', 'timeout exposes stable code');
assertEqual(timeoutAttempts, 2, 'timeout retries once before returning failure');
assertEqual(timedOut.diagnostics.retryCount, 1, 'failed timeout retry records retry count');
assertEqual(timeoutSignalAborted, true, 'timeout aborts in-flight provider signal');

let retryableTimeoutAttempts = 0;
const retryableTimeoutRouter = createGenerationRouter({
  client: {
    async generate(request) {
      retryableTimeoutAttempts += 1;
      if (retryableTimeoutAttempts === 1) {
        request.signal?.addEventListener('abort', () => {});
        return new Promise(() => {});
      }
      return { text: responseTextForRole('utilityArbiter') };
    }
  },
  timeoutMs: 5
});
const retryableTimeout = await retryableTimeoutRouter.generate('utilityArbiter', { prompt: 'Retry timeout once' });
assertEqual(retryableTimeout.ok, true, 'router timeout retries once while current');
assertEqual(retryableTimeoutAttempts, 2, 'router timeout makes one retry attempt');
assertEqual(retryableTimeout.diagnostics.retryCount, 1, 'router timeout retry records retry count');

console.log('[pass] providers');
