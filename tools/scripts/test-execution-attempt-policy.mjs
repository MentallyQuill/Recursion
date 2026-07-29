import {
  classifyModelFailure,
  runModelStageAttempts
} from '../../src/execution/attempt-policy.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

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
assertEqual(settled[1].outcome, 'accepted', 'valid response is accepted');
assert(
  !JSON.stringify(settled).includes('INITIAL_PROMPT_CANARY')
    && !JSON.stringify(settled).includes('RAW_INVALID_RESPONSE_CANARY'),
  'attempt summaries exclude raw prompts and model responses'
);

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
  validate: parseJsonResponse
});
assertEqual(transportResult.ok, false, 'exhausted transport attempts return failure');
assertEqual(transportCalls, 2, 'two-attempt window makes only two transport requests');
assertEqual(transportResult.attempts.length, 2, 'transport failures are summarized per attempt');
assertEqual(transportResult.attempts[0].outcome, 'failed', 'transport failure has failed outcome');
assertEqual(transportResult.failure.kind, 'transport', 'transport failure is classified');

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
    validate: parseJsonResponse
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
