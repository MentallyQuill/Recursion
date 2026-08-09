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
  for (const item of chain) {
    const candidates = [item?.status, item?.statusCode, item?.response?.status];
    for (const candidate of candidates) {
      const value = Number(candidate || 0);
      if (Number.isInteger(value) && value > 0) return value;
    }
  }
  return 0;
}

export function normalizeProviderError(error) {
  const chain = errorChain(error);
  const text = chainText(chain);
  const codes = chainCodes(chain);
  const status = chainStatus(chain);

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

  if (codes.has('RECURSION_PROVIDER_RATE_LIMIT')
      || codes.has('RECURSION_PROVIDER_RATE_LIMITED')
      || status === 429
      || /rate limit|too many requests/.test(text)) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_RATE_LIMIT',
      'The selected profile is rate limited.',
      true,
      { category: 'capacity' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_AUTH_FAILED') || status === 401 || status === 403) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_AUTH_FAILED',
      'The selected profile could not authenticate.',
      false,
      { category: 'configuration' }
    );
  }

  if (codes.has('RECURSION_PROVIDER_TRANSIENT')
      || codes.has('RECURSION_PROVIDER_TIMEOUT')
      || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].some((code) => codes.has(code))
      || status >= 500
      || /econnreset|econnrefused|etimedout|timed? out|temporarily unavailable|socket hang up|fetch failed|network error/.test(text)) {
    return providerFailureRecord(
      'RECURSION_PROVIDER_TRANSIENT',
      'The selected profile failed temporarily.',
      true
    );
  }

  return providerFailureRecord(
    'RECURSION_PROVIDER_FAILED',
    'The selected profile request failed.',
    error?.retryable === true
  );
}
