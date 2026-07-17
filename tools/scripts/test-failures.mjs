import {
  createFailure,
  failureFrom,
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
assertEqual(timeout.message, 'Provider call timed out.', 'timeout is explicit');
assertEqual(timeout.retryable, true, 'timeout remains retryable');

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
assertEqual(generic.message, 'Unexpected internal failure (RECURSION_INTERNAL).', 'generic failure gains a real reason');
assertEqual(failureReason(generic), generic.message, 'failureReason returns normalized message');

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
