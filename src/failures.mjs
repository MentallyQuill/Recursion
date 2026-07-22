export const FAILURE_CATEGORIES = Object.freeze([
  'provider-account',
  'provider-request',
  'provider-timeout',
  'provider-length',
  'provider-output',
  'model-output',
  'validation',
  'stale-state',
  'host-mutation',
  'prompt-install',
  'storage',
  'internal'
]);

const CATEGORY_SET = new Set(FAILURE_CATEGORIES);
const GENERIC_MESSAGES = new Set([
  '',
  'failed',
  'failure',
  'warning',
  'caution',
  'needs attention',
  'action failed',
  'provider call failed',
  'provider generation failed'
]);
const INTERNAL_FAILURE_MESSAGE = 'Recursion hit an unexpected internal error.';
const INTERNAL_FAILURE_ACTION = 'Try again. If it keeps happening, copy the failure code from Diagnostics.';

function compact(value = '', maxLength = 300) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function safeCode(value = '') {
  const code = String(value || 'RECURSION_INTERNAL')
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return code || 'RECURSION_INTERNAL';
}

function safeStage(value = '') {
  const stage = String(value || 'runtime')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return stage || 'runtime';
}

function redact(value = '') {
  return String(value || '')
    .replace(/\b(?:sk|sess|key)-[A-Za-z0-9_-]{6,}\b/gi, '[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:api[_-]?key|authorization|token)["']?\s*[:=]\s*)["']?[^"',;\s}]+/gi, '$1[redacted]');
}

function normalizedMessage(value) {
  const message = compact(redact(value), 300);
  const generic = message.toLowerCase().replace(/[.!]+$/g, '');
  if (!message || GENERIC_MESSAGES.has(generic)) return INTERNAL_FAILURE_MESSAGE;
  return message;
}

function optionalText(value) {
  const text = compact(redact(value), 300);
  return text || '';
}

export function createFailure(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : { message: input };
  const code = safeCode(source.code);
  const category = CATEGORY_SET.has(source.category) ? source.category : 'internal';
  const attemptedRecovery = optionalText(source.attemptedRecovery);
  const suggestedAction = optionalText(source.suggestedAction);
  return Object.freeze({
    code,
    stage: safeStage(source.stage),
    category,
    message: normalizedMessage(source.message),
    retryable: source.retryable === true,
    ...(attemptedRecovery ? { attemptedRecovery } : {}),
    ...(suggestedAction ? { suggestedAction } : {})
  });
}

function errorCode(error = {}) {
  return safeCode(error?.code || error?.name || 'RECURSION_PROVIDER_FAILED');
}

function errorStatus(error = {}) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  return Number.isFinite(status) ? status : 0;
}

function looksLikeProviderFailure(error = {}) {
  const code = errorCode(error);
  const status = errorStatus(error);
  const message = String(error?.message || error || '').toLowerCase();
  return status >= 400
    || code.startsWith('RECURSION_PROVIDER_')
    || code.startsWith('RECURSION_JSON_')
    || /timed?\s*out|timeout|rate limit|context length|finish_reason.?length/.test(message);
}

export function providerFailure(error = {}, context = {}) {
  const code = errorCode(error);
  const status = errorStatus(error);
  const rawMessage = String(error?.message || error || '');
  const lower = rawMessage.toLowerCase();
  const stage = context.stage || 'provider-call';

  if (status === 402 || /insufficient funds|insufficient credit|credit balance|out of funds/.test(lower)) {
    return createFailure({
      code: 'RECURSION_PROVIDER_INSUFFICIENT_FUNDS',
      stage,
      category: 'provider-account',
      message: 'Provider account has insufficient funds.',
      suggestedAction: 'Add provider funds or select another provider.'
    });
  }
  if ([401, 403].includes(status) || code === 'RECURSION_PROVIDER_AUTH_FAILED') {
    return createFailure({
      code: 'RECURSION_PROVIDER_AUTH_FAILED',
      stage,
      category: 'provider-account',
      message: 'Provider authentication failed.',
      suggestedAction: 'Check the provider credentials or connection profile.'
    });
  }
  if (code === 'RECURSION_PROVIDER_TIMEOUT' || /timed?\s*out|timeout/.test(lower)) {
    return createFailure({
      code: 'RECURSION_PROVIDER_TIMEOUT',
      stage,
      category: 'provider-timeout',
      message: 'The selected model connection did not respond before the time limit.',
      retryable: true,
      suggestedAction: 'Check the selected connection profile, then try again.'
    });
  }
  if (code === 'RECURSION_PROVIDER_TOKEN_LIMIT' || /token limit|context length|finish_reason.?length|max_tokens/.test(lower)) {
    return createFailure({
      code: 'RECURSION_PROVIDER_TOKEN_LIMIT',
      stage,
      category: 'provider-length',
      message: 'Provider response reached its token limit.',
      suggestedAction: 'Increase the provider token limit or reduce the request context.'
    });
  }
  if (['RECURSION_JSON_PARSE_FAILED', 'RECURSION_JSON_OBJECT_REQUIRED'].includes(code)) {
    return createFailure({
      code,
      stage,
      category: 'provider-output',
      message: code === 'RECURSION_JSON_OBJECT_REQUIRED'
        ? 'Provider returned structured output that was not a JSON object.'
        : 'Provider returned malformed JSON.',
      retryable: true
    });
  }
  if ([
    'RECURSION_PROVIDER_EMPTY_RESPONSE',
    'RECURSION_PROVIDER_REASONING_ONLY',
    'RECURSION_PROVIDER_SCHEMA_MISMATCH',
    'RECURSION_PROVIDER_RESPONSE_JSON_INVALID'
  ].includes(code)) {
    return createFailure({
      code,
      stage,
      category: 'provider-output',
      message: code === 'RECURSION_PROVIDER_EMPTY_RESPONSE'
        ? 'Provider returned no visible content.'
        : code === 'RECURSION_PROVIDER_REASONING_ONLY'
          ? 'Provider returned reasoning without a visible answer.'
          : 'Provider returned output that did not match the required schema.',
      retryable: true
    });
  }
  if (status === 429 || /rate limit|too many requests/.test(lower)) {
    return createFailure({
      code: 'RECURSION_PROVIDER_RATE_LIMITED',
      stage,
      category: 'provider-request',
      message: 'Provider rate limit was reached.',
      retryable: true,
      suggestedAction: 'Wait briefly and retry the operation.'
    });
  }
  if (status === 400 || code === 'RECURSION_PROVIDER_REQUEST_INVALID' || /unsupported|invalid value for/.test(lower)) {
    return createFailure({
      code: 'RECURSION_PROVIDER_REQUEST_INVALID',
      stage,
      category: 'provider-request',
      message: 'Provider rejected the request parameters.',
      suggestedAction: 'Check the selected model and provider settings.'
    });
  }
  return createFailure({
    code,
    stage,
    category: 'provider-request',
    message: 'The selected model connection could not complete the request.',
    retryable: error?.retryable === true,
    suggestedAction: error?.retryable === true ? 'Try again.' : ''
  });
}

export function failureFrom(value, fallback = {}) {
  if (value?.code && value?.stage && value?.category && value?.message) {
    return createFailure(value);
  }
  const defaults = fallback && typeof fallback === 'object' ? fallback : { message: fallback };
  const source = value && typeof value === 'object'
    ? value
    : { message: value };
  return createFailure({
    code: source.code || defaults.code || 'RECURSION_INTERNAL',
    stage: source.stage || defaults.stage || 'runtime',
    category: source.category || defaults.category || 'internal',
    message: source.message || defaults.message || '',
    retryable: source.retryable ?? defaults.retryable,
    attemptedRecovery: source.attemptedRecovery || defaults.attemptedRecovery,
    suggestedAction: source.suggestedAction || defaults.suggestedAction
  });
}

export function failureFromError(error = {}, context = {}) {
  const stage = context.stage || 'runtime';
  if (looksLikeProviderFailure(error)) return providerFailure(error, { stage });
  return createFailure({
    code: error?.code || 'RECURSION_INTERNAL',
    stage,
    category: context.category || 'internal',
    message: INTERNAL_FAILURE_MESSAGE,
    retryable: false,
    suggestedAction: INTERNAL_FAILURE_ACTION
  });
}

export function failureReason(value) {
  return failureFrom(value).message;
}
