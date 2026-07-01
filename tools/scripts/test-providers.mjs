import {
  REASONER_ROLE_IDS,
  UTILITY_ROLE_IDS,
  createGenerationRouter,
  createProviderClient,
  parseStructuredOutput,
  roleLane
} from '../../src/providers.mjs';
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

assertEqual(parseStructuredOutput('```json\n{"schema":"x"}\n```').schema, 'x', 'structured parser accepts fenced json');
assertEqual(roleLane('unknownRole'), 'utility', 'unknown roles default to utility lane');
assertEqual(roleLane('reasonerComposer'), 'reasoner', 'reasonerComposer uses reasoner lane');
const expectedUtilityRoles = [
  'utilityArbiter',
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'continuityRiskCard',
  'environmentItemsCard',
  'prosePacingCard',
  'openThreadsCard',
  'briefUtilityComposer',
  'providerTest'
];
assertDeepEqual(UTILITY_ROLE_IDS, expectedUtilityRoles, 'utility role catalog exactly matches Task 6 plan');
assertDeepEqual(REASONER_ROLE_IDS, ['reasonerComposer'], 'reasoner role catalog exactly matches Task 6 plan');
for (const utilityRole of expectedUtilityRoles) {
  assertEqual(roleLane(utilityRole), 'utility', `${utilityRole} uses utility lane`);
}

const calls = [];
const host = {
  generation: {
    async generate(request) {
      calls.push(request);
      return { text: '{"schema":"recursion.test.v1","ok":true}', providerId: 'fake-host', model: 'fake-model' };
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
      return { text: '{"schema":"recursion.retry.v1","ok":true}' };
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
          return { text: `{"schema":"single.${request.roleId}","lane":"${request.lane}"}` };
        },
        async batch(requests) {
          routerHostBatchCallCount += 1;
          routerHostBatchCalls.push(requests);
          return requests.map((request) => ({ text: `{"schema":"batch.${request.roleId}","lane":"${request.lane}"}` }));
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
assertDeepEqual(routerHostBatchResults.map((entry) => entry.data.schema), ['batch.utilityArbiter', 'batch.providerTest'], 'router batch parses each response');

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
      return requests.map((request) => ({ text: `{"schema":"retry.${request.roleId}","lane":"${request.lane}"}` }));
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], { runId: 'provider-batch-transient-retry' });
assertEqual(transientBatchCalls, 2, 'router batch retries one transient transport failure');
assertDeepEqual(transientBatch.map((entry) => entry.ok), [true, true], 'transient retry returns successful batch entries');
assertDeepEqual(transientBatch.map((entry) => entry.diagnostics.retryCount), [1, 1], 'retried batch entries record retry count');

const routerMalformedSlot = await createGenerationRouter({
  client: {
    async generate() {
      throw new Error('single generate should not be used for malformed batch test');
    },
    async batch() {
      return [
        { text: '{"schema":"batch.valid","ok":true}', roleId: 'utilityArbiter', lane: 'utility', providerId: 'fake-host', model: 'fake-model' },
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
        { text: '{"schema":"batch.safe","ok":true}', roleId: 'utilityArbiter', lane: 'utility', providerId: 'fake-host', model: 'fake-model' },
        { text: 'RAW_BATCH_RESPONSE_MARKER_42 not json', roleId: 'providerTest', lane: 'utility', providerId: 'fake-host', model: 'fake-model' }
      ];
    }
  },
  activity: routerBatchLeakActivity,
  journal: { append: (entry) => routerBatchLeakJournal.push(entry) }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
], { runId: 'provider-batch-leak-test' });
assertEqual(routerBatchLeak[0].ok, true, 'router batch leak regression keeps valid slot successful');
assertEqual(routerBatchLeak[1].ok, false, 'router batch leak regression returns failure for malformed slot');
assertNoRawBatchMarker(routerBatchLeak, 'router batch result diagnostics do not expose raw malformed provider response');
assertNoRawBatchMarker(routerBatchLeakJournal, 'router batch journal does not expose raw malformed provider response');
assertNoRawBatchMarker(routerBatchLeakActivity.history(), 'router batch activity does not expose raw malformed provider response');
assertEqual(routerBatchLeakActivity.current().phase, 'settled', 'router batch activity settles after all slots');
assertEqual(routerBatchLeakActivity.current().severity, 'warning', 'router batch activity reports mixed slot failure as warning');
assert(routerBatchLeakActivity.current().detail.failed === 1, 'router batch activity detail records failed slot count');

let routerSequentialFallbackCalls = 0;
const routerSequentialFallback = await createGenerationRouter({
  client: {
    async generate(roleId, request) {
      routerSequentialFallbackCalls += 1;
      return { text: `{"schema":"fallback.${roleId}","lane":"${request.lane || 'utility'}"}` };
    }
  }
}).batch([
  { roleId: 'utilityArbiter', prompt: 'A' },
  { roleId: 'providerTest', prompt: 'B' }
]);
assertEqual(routerSequentialFallbackCalls, 2, 'router batch falls back to sequential generate when client batch is absent');
assertDeepEqual(routerSequentialFallback.map((entry) => entry.data.schema), ['fallback.utilityArbiter', 'fallback.providerTest'], 'router batch sequential fallback still parses results');

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
          choices: [{ message: { content: '{"schema":"recursion.openai.v1","ok":true}' } }]
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
        choices: [{ message: { content: '{"schema":"recursion.redaction.v1","ok":true}' } }]
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
const redacted = await redactionRouter.generate('utilityArbiter', { prompt: 'Do not log sk-live-secret' });
assertEqual(redacted.ok, true, 'redaction route succeeds');
assertEqual(redacted.diagnostics.runId, 'activity-assigned-run', 'returned diagnostics use activity-assigned run id');
assertEqual(redactionJournalEntries.at(-1).runId, 'activity-assigned-run', 'journal uses activity-assigned run id');
assertEqual(redactionActivityEvents.at(-1).runId, 'activity-assigned-run', 'settle activity uses activity-assigned run id');
assertNoSecret(redacted.diagnostics, 'diagnostics do not leak API keys');
assertNoSecret(redactionActivityEvents, 'activity events do not leak API keys');
assertNoSecret(redactionJournalEntries, 'journal entries do not leak API keys');
assert(!JSON.stringify(redactionJournalEntries).includes('Do not log'), 'journal does not include raw prompts');

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
assertEqual(timeoutAttempts, 1, 'timeout does not start overlapping retry');
assertEqual(timeoutSignalAborted, true, 'timeout aborts in-flight provider signal');

console.log('[pass] providers');
