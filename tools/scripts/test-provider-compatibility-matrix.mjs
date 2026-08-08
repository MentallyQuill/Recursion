import { hashJson } from '../../src/core.mjs';
import { createProviderClient, createGenerationRouter } from '../../src/providers.mjs';
import { createProfileRequestQueue } from '../../src/providers/profile-request-queue.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const CASES = Object.freeze([
  'chat-content',
  'text-completion',
  'direct-structured-object',
  'message-parsed-object',
  'tool-call-arguments',
  'legacy-function-arguments',
  'native-schema-success',
  'prompt-json-success',
  'empty-object-response',
  'truncated-json',
  'reasoning-only-response',
  'singleton-object-array',
  'unsupported-native-schema',
  'context-limit',
  'rate-limit',
  'transient-transport',
  'queued-abort'
]);

const PROFILE_ID = 'profile-private-raw-id';
const RAW_PROMPT = 'RAW_PROMPT_MUST_NOT_LEAK';
const RAW_OUTPUT = 'RAW_OUTPUT_MUST_NOT_LEAK';
const PRIVATE_ENDPOINT = 'https://private-endpoint.invalid/v1';
const PRIVATE_SECRET = 'sk-private-secret-must-not-leak';
const CARD = Object.freeze({
  promptText: 'Track the immediate objective and obstruction.',
  evidenceRefs: ['message:0']
});
const CARD_JSON = JSON.stringify(CARD);
function expectedProfileIdHash(profileId) {
  return `${hashJson(profileId)}${hashJson(`profile:${profileId}`)}`.slice(0, 16);
}

const PROFILE = Object.freeze({
  id: PROFILE_ID,
  name: 'Fixture Profile',
  label: 'Fixture Profile / fixture-model',
  model: 'fixture-model',
  api: 'textgenerationwebui',
  completionMode: 'text',
  presetName: 'Fixture Precise',
  instructName: 'ChatML'
});

function createStore() {
  const store = createSettingsStore({ root: {} });
  const update = store.updateProviderConfig('utility', { connectionProfileId: PROFILE_ID });
  assertEqual(update.ok, true, 'fixture profile config succeeds');
  return store;
}

function providerError(code, retryable) {
  const error = new Error(`${code}: ${RAW_OUTPUT} ${PRIVATE_ENDPOINT} ${PRIVATE_SECRET}`);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function wrapped(raw, {
  completionMode = 'text',
  structuredOutputMethod = 'prompt-json',
  diagnosticCodes = []
} = {}) {
  return {
    raw,
    providerId: 'sillytavern-connection-profile',
    model: 'fixture-model',
    completionMode,
    generationPolicy: {
      includePreset: false,
      includeInstruct: completionMode === 'text',
      samplerSource: 'profile',
      structuredOutputMethod,
      diagnosticCodes
    }
  };
}

const FIXTURES = Object.freeze({
  'chat-content': () => wrapped({ choices: [{ message: { content: CARD_JSON } }] }, { completionMode: 'chat' }),
  'text-completion': () => wrapped({ choices: [{ text: CARD_JSON }] }),
  'direct-structured-object': () => wrapped(CARD),
  'message-parsed-object': () => wrapped({ choices: [{ message: { parsed: CARD } }] }),
  'tool-call-arguments': () => wrapped({
    choices: [{ message: { tool_calls: [{ function: { arguments: CARD_JSON } }] } }]
  }),
  'legacy-function-arguments': () => wrapped({
    choices: [{ message: { function_call: { arguments: CARD_JSON } } }]
  }),
  'native-schema-success': () => wrapped({ choices: [{ message: { parsed: CARD } }] }, {
    completionMode: 'chat',
    structuredOutputMethod: 'native-schema'
  }),
  'prompt-json-success': () => wrapped({ text: CARD_JSON }),
  'empty-object-response': () => wrapped({}),
  'truncated-json': () => wrapped({ text: `${CARD_JSON.slice(0, -2)}${RAW_OUTPUT}` }),
  'reasoning-only-response': () => wrapped({ choices: [{ message: { reasoning_content: RAW_OUTPUT, content: '' } }] }),
  'singleton-object-array': () => wrapped({ text: JSON.stringify([CARD]) }),
  'unsupported-native-schema': () => { throw providerError('RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED', false); },
  'context-limit': () => { throw providerError('RECURSION_PROVIDER_CONTEXT_LIMIT', false); },
  'rate-limit': () => { throw providerError('RECURSION_PROVIDER_RATE_LIMIT', true); },
  'transient-transport': () => { throw providerError('RECURSION_PROVIDER_TRANSIENT', true); }
});

const EXPECTED_FAILURES = Object.freeze({
  'empty-object-response': ['RECURSION_PROVIDER_EMPTY_RESPONSE', false],
  'truncated-json': ['RECURSION_JSON_PARSE_FAILED', false],
  'reasoning-only-response': ['RECURSION_PROVIDER_REASONING_ONLY', false],
  'unsupported-native-schema': ['RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED', false],
  'context-limit': ['RECURSION_PROVIDER_CONTEXT_LIMIT', false],
  'rate-limit': ['RECURSION_PROVIDER_RATE_LIMIT', true],
  'transient-transport': ['RECURSION_PROVIDER_TRANSIENT', true],
  'queued-abort': ['RECURSION_PROVIDER_ABORTED', false]
});

function createRouter(generate, requestQueue = createProfileRequestQueue({ concurrency: 1 })) {
  const host = {
    providerProfiles: { list: () => [PROFILE] },
    generation: { generate }
  };
  const client = createProviderClient({ host, settingsStore: createStore(), requestQueue });
  return { client, router: createGenerationRouter({ client }) };
}

async function runFixture(caseName) {
  const { router } = createRouter(async () => FIXTURES[caseName]());
  return router.generate('sceneFrameCard', {
    prompt: RAW_PROMPT,
    snapshotHash: 'snapshot-fixture',
    metadata: { role: 'sceneFrameCard', family: 'Scene Frame' }
  });
}

async function runQueuedAbort() {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  let calls = 0;
  const { router } = createRouter(async () => {
    calls += 1;
    if (calls === 1) {
      firstStartedResolve();
      await firstBlocked;
    }
    return wrapped({ text: CARD_JSON });
  });

  const first = router.generate('sceneFrameCard', {
    prompt: RAW_PROMPT,
    snapshotHash: 'snapshot-fixture-1',
    metadata: { role: 'sceneFrameCard', family: 'Scene Frame' }
  });
  await firstStarted;

  const controller = new AbortController();
  const second = router.generate('sceneFrameCard', {
    prompt: RAW_PROMPT,
    snapshotHash: 'snapshot-fixture-2',
    metadata: { role: 'sceneFrameCard', family: 'Scene Frame' },
    signal: controller.signal
  });
  controller.abort();
  const result = await second;
  releaseFirst();
  await first;
  assertEqual(calls, 1, 'aborted queued request never reaches Connection Manager');
  return result;
}

function stableOutcome(result) {
  if (result.ok) {
    return {
      ok: true,
      data: result.data,
      diagnosticCodes: result.diagnostics?.effectivePolicy?.diagnosticCodes || []
    };
  }
  return {
    ok: false,
    error: {
      code: result.error?.code,
      retryable: result.error?.retryable === true
    }
  };
}

assertDeepEqual(Object.keys(FIXTURES), CASES.filter((name) => name !== 'queued-abort'), 'fixture table covers every non-queue case');

const results = new Map();
for (const caseName of CASES) {
  const result = caseName === 'queued-abort'
    ? await runQueuedAbort()
    : await runFixture(caseName);
  results.set(caseName, result);
  const outcome = stableOutcome(result);
  const expectedFailure = EXPECTED_FAILURES[caseName];
  if (expectedFailure) {
    assertDeepEqual(outcome, {
      ok: false,
      error: { code: expectedFailure[0], retryable: expectedFailure[1] }
    }, `${caseName} has stable failure classification`);
  } else {
    assertDeepEqual(outcome, {
      ok: true,
      data: CARD,
      diagnosticCodes: []
    }, `${caseName} has stable compact-card outcome`);
  }
}

const chatPolicy = results.get('chat-content').diagnostics.effectivePolicy;
assertDeepEqual(chatPolicy, {
  connectionProfileIdHash: expectedProfileIdHash(PROFILE_ID),
  completionMode: 'chat',
  presetMode: 'isolated',
  instructApplied: false,
  samplerSource: 'profile',
  structuredOutputMethod: 'prompt-json',
  responseLength: 900,
  queueConcurrency: 1,
  diagnosticCodes: []
}, 'effective policy diagnostics expose only bounded operational metadata');

const textPolicy = results.get('text-completion').diagnostics.effectivePolicy;
assertEqual(textPolicy.completionMode, 'text', 'text completion is diagnosed');
assertEqual(textPolicy.instructApplied, true, 'text instruct application is diagnosed');
assertEqual(results.get('native-schema-success').diagnostics.effectivePolicy.structuredOutputMethod, 'native-schema', 'native schema method is diagnosed');

const serialized = JSON.stringify([...results.values()]);
assertEqual(serialized.includes(PROFILE_ID), false, 'raw Connection Profile ID is never exported');
assertEqual(serialized.includes(RAW_PROMPT), false, 'fixture prompt is never exported');
assertEqual(serialized.includes(RAW_OUTPUT), false, 'raw provider output and exception text are never exported');
assertEqual(serialized.includes(PRIVATE_ENDPOINT), false, 'private endpoint metadata is never exported');
assertEqual(serialized.includes(PRIVATE_SECRET), false, 'private secret metadata is never exported');
assertEqual(serialized.includes('authorization'), false, 'authorization metadata is absent');
assert(CASES.every((name) => results.has(name)), 'all compatibility cases executed');

console.log(`Provider compatibility matrix passed (${CASES.length} cases).`);
