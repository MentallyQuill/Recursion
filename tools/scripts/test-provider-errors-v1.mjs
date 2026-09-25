import { normalizeProviderError } from '../../src/providers/provider-errors.mjs';
import { assertEqual } from '../../tests/helpers/assert.mjs';

const wrapped = new Error('API request failed', {
  cause: new Error('response_format json_schema is not supported')
});
assertEqual(
  normalizeProviderError(wrapped).code,
  'RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED',
  'wrapped native-schema rejection is classified'
);

assertEqual(
  normalizeProviderError(new Error('maximum context length exceeded')).code,
  'RECURSION_PROVIDER_CONTEXT_LIMIT',
  'context overflow is classified'
);

assertEqual(
  normalizeProviderError(Object.assign(new Error('response stopped at max_tokens'), {
    code: 'RECURSION_PROVIDER_TOKEN_LIMIT'
  })).code,
  'RECURSION_PROVIDER_TOKEN_LIMIT',
  'completion truncation is not mislabeled as input context overflow'
);

assertEqual(
  normalizeProviderError(Object.assign(new Error('rate limited'), { status: 429 })).code,
  'RECURSION_PROVIDER_RATE_LIMIT',
  '429 is classified'
);

assertEqual(
  normalizeProviderError(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })).code,
  'RECURSION_PROVIDER_TRANSIENT',
  'connection resets are classified as transient'
);

assertEqual(
  normalizeProviderError(Object.assign(new Error('stopped'), { name: 'AbortError' })).code,
  'RECURSION_PROVIDER_ABORTED',
  'aborts are classified'
);

assertEqual(
  normalizeProviderError(Object.assign(new Error('profile not found'), { code: 'RECURSION_PROFILE_MISSING' })).code,
  'RECURSION_PROFILE_UNAVAILABLE',
  'missing profiles are classified as configuration failures'
);

const sanitized = normalizeProviderError(new Error('Bearer SECRET_PROVIDER_TOKEN'));
assertEqual(normalizeProviderError({ status: 429, headers: { 'retry-after': '120' } }).retryAfterMs,
  120000, 'provider cooldown must not be shortened to one minute');
assertEqual(JSON.stringify(sanitized).includes('SECRET_PROVIDER_TOKEN'), false, 'provider errors do not expose raw messages');

for (const [name, error, code, retryable, status] of [
  ['host status text retains permanent rejection', new Error('API request failed', { cause: new Error('Bad Request') }), 'RECURSION_PROVIDER_FAILED', false, 400],
  ['host status text retains authentication', new Error('API request failed', { cause: new Error('Forbidden') }), 'RECURSION_PROVIDER_AUTH_FAILED', false, 403],
  ['host status text retains gateway outage', new Error('API request failed', { cause: new Error('Bad Gateway') }), 'RECURSION_PROVIDER_TRANSIENT', true, 502],
  ['host status text retains cooldown', new Error('API request failed', { cause: new Error('Too Many Requests') }), 'RECURSION_PROVIDER_RATE_LIMIT', true, 429],
  ['opaque Connection Manager failure', new Error('API request failed'), 'RECURSION_PROVIDER_TRANSIENT', true, undefined],
  ['request timeout', { status: 408 }, 'RECURSION_PROVIDER_TRANSIENT', true, 408],
  ['nested authentication overrides gateway status', { status: 500, cause: { response: { status: 401 } } }, 'RECURSION_PROVIDER_AUTH_FAILED', false, 401],
  ['nested cooldown overrides gateway status', { status: 500, cause: { statusCode: 429 } }, 'RECURSION_PROVIDER_RATE_LIMIT', true, 429],
  ['invalid request overrides generic failure', { message: 'API request failed', cause: { status: 400 } }, 'RECURSION_PROVIDER_FAILED', false, 400],
  ['explicit permanent cause overrides generic failure', { message: 'API request failed', cause: { retryable: false } }, 'RECURSION_PROVIDER_FAILED', false, undefined],
  ['invalid request code overrides generic failure', { message: 'API request failed', cause: { code: 'RECURSION_PROVIDER_REQUEST_INVALID' } }, 'RECURSION_PROVIDER_FAILED', false, undefined],
  ['invalid request overrides transient wrapper', { code: 'RECURSION_PROVIDER_TRANSIENT', retryable: true, status: 500, cause: { status: 422 } }, 'RECURSION_PROVIDER_FAILED', false, 422],
  ['auth status overrides rate-limit wording', { message: 'rate limit', status: 403 }, 'RECURSION_PROVIDER_AUTH_FAILED', false, 403],
  ['temporary DNS resolution', { code: 'EAI_AGAIN' }, 'RECURSION_PROVIDER_TRANSIENT', true, undefined],
  ['unknown error remains terminal', { message: 'private provider detail' }, 'RECURSION_PROVIDER_FAILED', false, undefined],
  ['non-HTTP status is excluded', { status: 12345 }, 'RECURSION_PROVIDER_FAILED', false, undefined]
]) {
  const failure = normalizeProviderError(error);
  assertEqual(failure.code, code, `${name}: code`);
  assertEqual(failure.retryable, retryable, `${name}: retryability`);
  assertEqual(failure.status, status, `${name}: safe HTTP status`);
}
assertEqual(normalizeProviderError({ code: 'ECONNRESET' }).transportCode, 'ECONNRESET', 'known transport code survives');
assertEqual(normalizeProviderError({ code: 'PRIVATE_KEY', message: 'API request failed' }).transportCode,
  undefined, 'arbitrary upstream codes do not become diagnostics');

console.log('[pass] provider errors v1');
