import {
  classifyModelFailure,
  resolveModelRetryDirective,
  runModelStageAttempts
} from '../../src/execution/attempt-policy.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';



const schemaRequest = { structuredOutputMethod: 'native-schema', responseLength: 900 };
assertDeepEqual(resolveModelRetryDirective({
  failure: { code: 'RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED', retryable: false },
  request: schemaRequest,
  attempt: 1,
  limit: 2
}), {
  action: 'downgrade-structured-output',
  delayMs: 0,
  diagnosticCode: 'structured-output-downgraded',
  nextRequest: { structuredOutputMethod: 'prompt-json', responseLength: 900 }
}, 'unsupported native schema downgrades immediately');

const contextDirective = resolveModelRetryDirective({
  failure: { code: 'RECURSION_PROVIDER_CONTEXT_LIMIT', retryable: false },
  request: { roleId: 'sceneFrameCard', responseLength: 900 },
  attempt: 1,
  limit: 2
});
assertEqual(contextDirective.action, 'reduce-output-budget', 'context overflow chooses budget reduction');
assertEqual(contextDirective.nextRequest.responseLength, 675, 'context overflow reduces output by 25 percent');
assertEqual(contextDirective.nextRequest.roleId, 'sceneFrameCard', 'budget reduction preserves the rest of the request');

assertDeepEqual(resolveModelRetryDirective({
  failure: { code: 'RECURSION_PROFILE_UNAVAILABLE', retryable: false },
  request: { roleId: 'sceneFrameCard', responseLength: 900 },
  attempt: 1,
  limit: 2
}), {
  action: 'stop',
  delayMs: 0,
  diagnosticCode: '',
  nextRequest: null
}, 'profile configuration failures stop');

assertEqual(resolveModelRetryDirective({
  failure: { kind: 'validation', code: 'RECURSION_MODEL_OUTPUT_INVALID', retryable: true },
  request: { roleId: 'sceneFrameCard', responseLength: 900 },
  attempt: 1,
  limit: 2
}).action, 'retry-corrected', 'validation failure requests one corrected retry');

assertDeepEqual(resolveModelRetryDirective({
  failure: { code: 'RECURSION_PROVIDER_TRANSIENT', retryable: true },
  request: { roleId: 'sceneFrameCard', responseLength: 900 },
  attempt: 1,
  limit: 2
}), {
  action: 'retry-same',
  delayMs: 250,
  diagnosticCode: 'provider-transient-retry',
  nextRequest: { roleId: 'sceneFrameCard', responseLength: 900 }
}, 'transient failure gets deterministic first retry delay');

function parseJsonResponse({ text }) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

const calls = [];
const settled = [];
const result = await runModelStageAttempts({
  attemptsPerStep: 2,
  request: { prompt: 'INITIAL_PROMPT_CANARY' },
  invoke: async (request) => {
    calls.push(request);
    return calls.length === 1
      ? { text: 'RAW_INVALID_RESPONSE_CANARY' }
      : { text: '{"ok":true}' };
  },
  validate: parseJsonResponse,
  buildCorrectionRequest: ({ request }) => ({
    ...request,
    prompt: 'Return valid JSON.'
  }),
  onAttemptSettled: (attempt) => settled.push(attempt)
});

assertEqual(result.ok, true, 'validation correction can succeed inside one attempt window');
assertDeepEqual(result.value, { ok: true }, 'accepted validation value is returned');
assertEqual(calls.length, 2, 'validation correction consumes the second attempt');
assertEqual(settled.length, 2, 'each settled attempt produces one summary');
assertEqual(settled[0].outcome, 'invalid', 'validation failure is classified as invalid');
assertEqual(settled[0].action, 'retry-corrected', 'validation attempt records one correction action');
assertEqual(settled[0].diagnosticCode, 'model-output-corrected', 'validation attempt records a safe diagnostic code');
assertEqual(settled[1].outcome, 'accepted', 'valid response is accepted');
assert(
  !JSON.stringify(settled).includes('INITIAL_PROMPT_CANARY')
    && !JSON.stringify(settled).includes('RAW_INVALID_RESPONSE_CANARY'),
  'attempt summaries exclude raw prompts and model responses'
);

const actionableValidation = await runModelStageAttempts({
  attemptsPerStep: 1,
  request: { prompt: 'Validate one Active Cast card.' },
  async invoke() {
    return { ok: false };
  },
  validate() {
    return {
      ok: false,
      error: {
        code: 'RECURSION_PROVIDER_SCHEMA_MISMATCH',
        category: 'provider-output',
        message: 'Active Cast provider output did not match recursion.card.v1.',
        retryable: true,
        suggestedAction: 'Retry Active Cast.'
      }
    };
  }
});
assertEqual(actionableValidation.ok, false, 'actionable validation failure exhausts its attempt window');
assertEqual(actionableValidation.failure.code, 'RECURSION_PROVIDER_SCHEMA_MISMATCH', 'validation failure preserves its stable code');
assertEqual(actionableValidation.failure.category, 'provider-output', 'validation failure preserves its category');
assertEqual(actionableValidation.failure.message, 'Active Cast provider output did not match recursion.card.v1.', 'validation failure preserves its actionable message');
assertEqual(actionableValidation.failure.suggestedAction, 'Retry Active Cast.', 'validation failure preserves its suggested action');

let transportCalls = 0;
const transportResult = await runModelStageAttempts({
  attemptsPerStep: 2,
  request: { prompt: 'transport' },
  async invoke() {
    transportCalls += 1;
    const error = new Error('temporary provider reset');
    error.code = 'ECONNRESET';
    error.retryable = true;
    throw error;
  },
  validate: parseJsonResponse,
  sleep: async () => {}
});
assertEqual(transportResult.ok, false, 'exhausted transport attempts return failure');
assertEqual(transportCalls, 2, 'two-attempt window makes only two transport requests');
assertEqual(transportResult.attempts.length, 2, 'transport failures are summarized per attempt');
assertEqual(transportResult.attempts[0].outcome, 'failed', 'transport failure has failed outcome');
assertEqual(transportResult.failure.kind, 'transport', 'transport failure is classified');
assertEqual(transportResult.attempts[0].action, 'retry-same', 'transient transport failure records retry action');
assertEqual(transportResult.attempts[0].delayMs, 250, 'first transient retry records deterministic delay');


let invalidResponseCalls = 0;
const exhaustedWithResponse = await runModelStageAttempts({
  attemptsPerStep: 2,
  request: { roleId: 'sceneFrameCard', responseLength: 900 },
  async invoke() {
    invalidResponseCalls += 1;
    return { marker: `response-${invalidResponseCalls}` };
  },
  validate() {
    return { ok: false, error: { code: 'RECURSION_MODEL_OUTPUT_INVALID', category: 'validation', message: 'Invalid.', retryable: true } };
  },
  buildCorrectionRequest: ({ request }) => request
});
assertEqual(exhaustedWithResponse.ok, false, 'invalid responses can exhaust the attempt window');
assertEqual(exhaustedWithResponse.lastResponse.marker, 'response-2', 'exhausted result retains the last response');

const abortController = new AbortController();
let abortCalls = 0;
const abortResult = await runModelStageAttempts({
  attemptsPerStep: 3,
  request: { prompt: 'abort' },
  signal: abortController.signal,
  async invoke() {
    abortCalls += 1;
    abortController.abort();
    const error = new Error('stopped');
    error.name = 'AbortError';
    throw error;
  },
  validate: parseJsonResponse
});
assertEqual(abortResult.ok, false, 'abort returns a terminal attempt result');
assertEqual(abortResult.aborted, true, 'abort is identified explicitly');
assertEqual(abortCalls, 1, 'abort never consumes a second automatic attempt');
assertEqual(abortResult.attempts.length, 1, 'aborted attempt settles once');
assertEqual(abortResult.attempts[0].outcome, 'aborted', 'abort summary uses aborted outcome');

const lateAbortController = new AbortController();
let lateAbortCalls = 0;
const lateAbortResult = await runModelStageAttempts({
  attemptsPerStep: 2,
  request: { prompt: 'late response' },
  signal: lateAbortController.signal,
  async invoke() {
    lateAbortCalls += 1;
    lateAbortController.abort();
    return { text: '{"ok":true}' };
  },
  validate: parseJsonResponse
});
assertEqual(lateAbortResult.ok, false, 'response settling after abort is never accepted');
assertEqual(lateAbortResult.aborted, true, 'late response is classified as aborted');
assertEqual(lateAbortCalls, 1, 'late response after abort never starts another attempt');

let singleAttemptCalls = 0;
const singleAttemptResult = await runModelStageAttempts({
  attemptsPerStep: 1,
  request: { prompt: 'one only' },
  async invoke() {
    singleAttemptCalls += 1;
    return { text: 'invalid' };
  },
  validate: parseJsonResponse,
  buildCorrectionRequest: () => ({ prompt: 'correction' })
});
assertEqual(singleAttemptResult.ok, false, 'single invalid attempt exhausts its window');
assertEqual(singleAttemptCalls, 1, 'attemptsPerStep one makes no correction request');

let manualWindowCalls = 0;
async function runManualWindow() {
  return runModelStageAttempts({
    attemptsPerStep: 2,
    request: { prompt: 'manual retry' },
    async invoke() {
      manualWindowCalls += 1;
      const error = new Error('still unavailable');
      error.code = 'ECONNRESET';
      error.retryable = true;
      throw error;
    },
    validate: parseJsonResponse,
    sleep: async () => {}
  });
}
await runManualWindow();
await runManualWindow();
assertEqual(manualWindowCalls, 4, 'separate manual invocation receives a fresh full attempt window');

const classified = classifyModelFailure({
  code: 'RECURSION_PROVIDER_AUTH_FAILED',
  status: 401,
  message: 'Bearer SECRET_PROVIDER_TOKEN'
});
assertEqual(classified.kind, 'transport', 'provider errors classify as transport failures');
assertEqual(classified.code, 'RECURSION_PROVIDER_AUTH_FAILED', 'failure classification preserves safe code');
assert(
  !JSON.stringify(classified).includes('SECRET_PROVIDER_TOKEN'),
  'failure classification does not expose raw provider error text'
);

console.log('Execution attempt policy tests passed.');
