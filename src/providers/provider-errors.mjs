const TRANSIENT_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'ENETDOWN', 'ENETRESET', 'ENETUNREACH'
]);

function providerFailureRecord(code, message, retryable, {
  kind = 'transport',
  category = 'provider'
} = {}) {
  return Object.freeze({
    kind,
    code,
    category,
    message,
    retryable: retryable === true
  });
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function chainText(chain) {
  return chain
    .map((item) => String(item?.message || ''))
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
}

function chainCodes(chain) {
  return new Set(chain
    .map((item) => String(item?.code || '').trim())
    .filter(Boolean));
}

function chainStatus(chain) {
  const statuses = [];
  // SillyTavern's chat endpoint forwards only statusText and its request
  // service wraps that in Error.cause, dropping numeric HTTP metadata.
  const statusTexts = new Map([
    ['bad request', 400], ['unauthorized', 401], ['payment required', 402],
    ['forbidden', 403], ['not found', 404], ['request timeout', 408],
    ['unprocessable entity', 422], ['unprocessable content', 422],
    ['too many requests', 429], ['internal server error', 500],
    ['bad gateway', 502], ['service unavailable', 503], ['gateway timeout', 504]
  ]);
  for (const item of [...chain].reverse()) {
    const candidates = [item?.status, item?.statusCode, item?.response?.status];
    if (!candidates.some((value) => Number(value) >= 400 && Number(value) < 600)) {
      candidates.push(statusTexts.get(String(item?.message || '').trim().toLowerCase()));
    }
    for (const candidate of candidates) {
      const value = Number(candidate || 0);
      if (Number.isInteger(value) && value >= 400 && value < 600) statuses.push(value);
    }
  }
  // A gateway/wrapper failure must not hide a definitive upstream rejection.
  return statuses.find((status) => status < 500 && status !== 408 && status !== 429)
    || statuses.find((status) => status === 429)
    || statuses.find((status) => status === 408)
    || statuses[0] || 0;
}

export function normalizeProviderError(error) {
  const chain = errorChain(error);
  const status = chainStatus(chain);
  const transportCode = [...chainCodes(chain)].find((code) => TRANSIENT_TRANSPORT_CODES.has(code));
  return Object.freeze({
    ...classifyProviderError(error, chain, status),
    ...(status ? { status } : {}),
    ...(transportCode ? { transportCode } : {})
  });
}

function classifyProviderError(error, chain, status) {
  const text = chainText(chain);
  const codes = chainCodes(chain);
  const budgetCode = ['RECURSION_RECOVERY_BUDGET_EXHAUSTED', 'RECURSION_OPERATION_DEADLINE'].find((code) => codes.has(code));
  if (budgetCode) return providerFailureRecord(budgetCode,
    'The operation recovery or time allowance is exhausted.', false, { category: 'capacity' });
  const refusalCode = ['RECURSION_PROVIDER_REFUSAL', 'RECURSION_PROVIDER_CONTENT_FILTER'].find((code) => codes.has(code));
  if (refusalCode) return providerFailureRecord(refusalCode,
    'The provider declined this request.', false, { category: 'provider-request' });

  if (chain.some((item) => item?.name === 'AbortError')
      || codes.has('ABORT_ERR')
      || codes.has('RECURSION_PROVIDER_ABORTED')) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_ABORTED',
      'Provider request was stopped.',
      false,
      { kind: 'abort', category: 'stale-state' }
    );
  }

  if (codes.has('RECURSION_POST_PROCESS_WRITER_TIMEOUT')) {
    return providerFailureRecord(
      'RECURSION_POST_PROCESS_WRITER_TIMEOUT',
      'Post-process writer exceeded its deadline.',
      true,
      { category: 'provider-timeout' }
    );
  }

  if ([
    'RECURSION_PROFILE_MISSING',
    'RECURSION_PROFILE_UNAVAILABLE',
    'RECURSION_CONNECTION_MANAGER_UNAVAILABLE'
  ].some((code) => codes.has(code))
      || /profile not found|select a connection profile|connection manager (?:is|api is) (?:not available|missing)/.test(text)) {
    return providerFailureRecord(
      'RECURSION_PROFILE_UNAVAILABLE',
      'The selected Connection Profile is unavailable.',
      false,
      { category: 'configuration' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_EMPTY_RESPONSE')) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_EMPTY_RESPONSE',
      'The selected profile returned no visible structured content.',
      false,
      { kind: 'validation', category: 'validation' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_REASONING_ONLY')) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_REASONING_ONLY',
      'The selected profile returned hidden reasoning without visible structured content.',
      false,
      { kind: 'validation', category: 'validation' }
    );
  }

  if (codes.has('RECURSION_JSON_PARSE_FAILED') || codes.has('RECURSION_JSON_OBJECT_REQUIRED')) {
    const code = codes.has('RECURSION_JSON_OBJECT_REQUIRED')
      ? 'RECURSION_JSON_OBJECT_REQUIRED'
      : 'RECURSION_JSON_PARSE_FAILED';
    return providerFailureRecord(
      code,
      code === 'RECURSION_JSON_OBJECT_REQUIRED'
        ? 'The model response was not a JSON object.'
        : 'The model response was not valid JSON.',
      false,
      { kind: 'validation', category: 'validation' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_TEST_INVALID')) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_TEST_INVALID',
      'Profile connectivity check returned invalid structured data.',
      false,
      { kind: 'validation', category: 'validation' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_SINGLE_CARD_INVALID')) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_SINGLE_CARD_INVALID',
      'Profile single-card check returned invalid structured data.',
      false,
      { kind: 'validation', category: 'validation' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_FUSED_INVALID')) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_FUSED_INVALID',
      'Profile Fused-card check returned invalid structured data.',
      false,
      { kind: 'validation', category: 'validation' }
    );
  }

  if (codes.has('RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED')
      || (/json_schema|response_format/.test(text)
        && /not supported|unsupported|unknown|invalid/.test(text))) {
    return providerFailureRecord(
      'RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED',
      'Native structured output is unsupported.',
      false,
      { category: 'compatibility' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_TOKEN_LIMIT')) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_TOKEN_LIMIT',
      'The provider response reached its completion token limit.',
      false,
      { category: 'provider-length' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_CONTEXT_LIMIT')
      || /context length|context window|too many tokens|maximum context|max(?:imum)?[_ -]?tokens/.test(text)) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_CONTEXT_LIMIT',
      'The request exceeded the model context limit.',
      false,
      { category: 'capacity' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_AUTH_FAILED') || status === 401 || status === 403
      || /\bunauthori[sz]ed\b|invalid api key|incorrect api key/.test(text)) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_AUTH_FAILED',
      'The selected profile could not authenticate.',
      false,
      { category: 'configuration' }
    );
  }

  if ((status >= 400 && status < 500 && status !== 408 && status !== 429)
      || codes.has('RECURSION_PROVIDER_REQUEST_INVALID')
      || codes.has('invalid_request_error')) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_FAILED',
      status ? `The selected profile rejected the request (HTTP ${status}).` : 'The selected profile rejected the request.',
      false,
      { category: 'provider-request' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_RATE_LIMIT')
      || codes.has('RECURSION_PROVIDER_RATE_LIMITED')
      || status === 429
      || /rate limit|too many requests/.test(text)) {
    const retryAfter = chain.map((entry) => {
      if (Number.isFinite(entry.retryAfterMs)) return entry.retryAfterMs;
      const headers = entry.response?.headers || entry.headers;
      const value = headers?.get?.('retry-after') ?? headers?.['retry-after'];
      if (value === undefined || value === null) return null;
      const seconds = Number(value);
      return Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    }).find((value) => Number.isFinite(value) && value >= 0);
    return Object.freeze({ ...providerFailureRecord(
      'RECURSION_PROVIDER_RATE_LIMIT',
      'The selected profile is rate limited.',
      true,
      { category: 'capacity' }
    ), retryAfterMs: Math.min(2147483647, Math.max(0, retryAfter ?? 1000)) });
  }

  if (chain.some((entry) => entry?.retryable === false)) {
    return providerFailureRecord('RECURSION_PROVIDER_FAILED', 'The selected profile request failed.', false);
  }

  if (codes.has('RECURSION_PROVIDER_TRANSIENT')
      || codes.has('RECURSION_PROVIDER_TIMEOUT')
      || [...TRANSIENT_TRANSPORT_CODES].some((code) => codes.has(code))
      || status === 408
      || status >= 500
      || chain.some((entry) => /^api request failed$/i.test(String(entry?.message || '').trim()))
      || /econnreset|econnrefused|etimedout|timed? out|temporarily unavailable|socket hang up|fetch failed|network error/.test(text)) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_TRANSIENT',
      status ? `The selected profile failed temporarily (HTTP ${status}).` : 'The selected profile failed temporarily.',
      true
    );
  }

  return providerFailureRecord(
    'RECURSION_PROVIDER_FAILED',
    'The selected profile request failed.',
    error?.retryable === true
  );
}
