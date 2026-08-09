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
assertEqual(JSON.stringify(sanitized).includes('SECRET_PROVIDER_TOKEN'), false, 'provider errors do not expose raw messages');

console.log('[pass] provider errors v1');
