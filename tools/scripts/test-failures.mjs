import {
  createFailure,
  failureFrom,
  failureFromError,
  failureReason,
  providerFailure
} from '../../src/failures.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const funds = providerFailure(
  { status: 402, message: 'Insufficient funds for this request.' },
  { stage: 'editorial-diagnosis' }
);
assertEqual(funds.code, 'RECURSION_PROVIDER_INSUFFICIENT_FUNDS', 'funds failure has stable code');
assertEqual(funds.category, 'provider-account', 'funds failure has account category');
assertEqual(funds.message, 'Provider account has insufficient funds.', 'funds failure is explicit');
assertEqual(funds.retryable, false, 'funds failure is not retryable');

const auth = providerFailure(
  { code: 'RECURSION_PROVIDER_AUTH_FAILED', message: 'Bearer sk-live-secret was rejected.' },
  { stage: 'provider-call' }
);
assertEqual(auth.message, 'Provider authentication failed.', 'authentication failure is explicit');
assert(!JSON.stringify(auth).includes('sk-live-secret'), 'authentication failure excludes secret material');

const timeout = providerFailure(
  { code: 'RECURSION_PROVIDER_TIMEOUT', message: 'Timed out.' },
  { stage: 'editorial-transform' }
);
assertEqual(timeout.category, 'provider-timeout', 'timeout has stable category');
assertEqual(timeout.message, 'The selected model connection did not respond before the time limit.', 'timeout is explicit');
assertEqual(timeout.retryable, true, 'timeout remains retryable');
assertEqual(timeout.suggestedAction, 'Check the selected connection profile, then try again.', 'timeout gives a concrete next action');

const length = providerFailure(
  { code: 'RECURSION_PROVIDER_TOKEN_LIMIT', message: 'finish_reason length' },
  { stage: 'editorial-transform' }
);
assertEqual(length.category, 'provider-length', 'token limit has stable category');
assertEqual(length.message, 'Provider response reached its token limit.', 'token limit is explicit');

const unsupported = providerFailure(
  {
    status: 400,
    code: 'RECURSION_PROVIDER_REQUEST_INVALID',
    message: 'Invalid value for reasoning.effort.'
  },
  { stage: 'provider-call' }
);
assertEqual(unsupported.category, 'provider-request', 'unsupported request has stable category');
assertEqual(unsupported.message, 'Provider rejected the request parameters.', 'unsupported request is explicit');

const malformed = providerFailure(
  { code: 'RECURSION_JSON_PARSE_FAILED', message: 'Provider output was not a valid JSON object.' },
  { stage: 'editorial-diagnosis' }
);
assertEqual(malformed.category, 'provider-output', 'malformed output has stable category');
assertEqual(malformed.message, 'Provider returned malformed JSON.', 'malformed output is explicit');

const host = createFailure({
  code: 'RECURSION_SWIPE_UNAVAILABLE',
  stage: 'host-mutation',
  category: 'host-mutation',
  message: 'SillyTavern did not confirm the enhanced swipe.'
});
assertEqual(host.message, 'SillyTavern did not confirm the enhanced swipe.', 'host mutation reason survives');

const generic = failureFrom('Action failed.');
assertEqual(generic.code, 'RECURSION_INTERNAL', 'generic failure uses internal code');
assertEqual(generic.category, 'internal', 'generic failure uses internal category');
assertEqual(generic.message, 'Recursion hit an unexpected internal error.', 'generic failure uses readable copy');
assert(!generic.message.includes(generic.code), 'generic user copy excludes the internal code');
assertEqual(failureReason(generic), generic.message, 'failureReason returns normalized message');

const thrownTimeout = failureFromError(
  Object.assign(new Error('Provider generation timed out after 120000ms.'), {
    code: 'RECURSION_PROVIDER_TIMEOUT'
  }),
  { stage: 'utility-card-batch' }
);
assertEqual(thrownTimeout.code, 'RECURSION_PROVIDER_TIMEOUT', 'thrown timeout keeps stable code');
assertEqual(thrownTimeout.category, 'provider-timeout', 'thrown timeout is provider timeout');
assertEqual(thrownTimeout.message, 'The selected model connection did not respond before the time limit.', 'thrown timeout uses layman-safe copy');
assertEqual(thrownTimeout.suggestedAction, 'Check the selected connection profile, then try again.', 'thrown timeout gives a concrete next action');
assert(!thrownTimeout.message.includes('120000'), 'timeout UI copy excludes milliseconds');

const thrownInternal = failureFromError(
  Object.assign(new Error('C:\\private\\runtime\\packet.mjs:93 secret-value'), {
    code: 'RECURSION_PACKET_INTERNAL'
  }),
  { stage: 'utility-composing' }
);
assertEqual(thrownInternal.code, 'RECURSION_PACKET_INTERNAL', 'internal failure keeps diagnostic code');
assertEqual(thrownInternal.category, 'internal', 'unknown thrown error remains internal');
assertEqual(thrownInternal.message, 'Recursion hit an unexpected internal error.', 'unknown thrown error hides technical text');
assert(!JSON.stringify(thrownInternal).includes('C:\\private'), 'unknown failure excludes filesystem path');
assert(!JSON.stringify(thrownInternal).includes('secret-value'), 'unknown failure excludes raw exception secret');

const unknownProvider = providerFailure(
  { code: 'RECURSION_PROVIDER_REMOTE_FAILURE', message: 'Remote adapter failed.' },
  { stage: 'provider-call' }
);
assertEqual(unknownProvider.message, 'The selected model connection could not complete the request.', 'unknown provider failure remains readable');

const bounded = createFailure({
  code: 'RECURSION_TEST',
  stage: 'runtime',
  category: 'internal',
  message: `Failure ${'x'.repeat(600)}`,
  attemptedRecovery: `Recovery ${'y'.repeat(600)}`,
  suggestedAction: `Action ${'z'.repeat(600)}`
});
assert(bounded.message.length <= 300, 'failure message is bounded');
assert(bounded.attemptedRecovery.length <= 300, 'recovery text is bounded');
assert(bounded.suggestedAction.length <= 300, 'suggested action is bounded');

console.log('[pass] failures');
