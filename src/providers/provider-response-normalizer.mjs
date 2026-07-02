export const PROVIDER_RESPONSE_ERROR_CODES = Object.freeze({
  EMPTY_CONTENT: 'provider_empty_content',
  REASONING_ONLY: 'provider_reasoning_only',
  TOKEN_LIMIT: 'provider_token_limit'
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanProviderTitle(value = '') {
  return String(value || '').trim() || 'Provider';
}

function cleanText(value = '', maxLength = 1000) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text.length <= maxLength ? text : text.slice(0, maxLength).trim();
}

function hasStructuredResponseShape(value) {
  if (!isObject(value)) return false;
  return [
    'schema',
    'action',
    'cardJobs',
    'reasonerDecision',
    'items',
    'instructionPatch',
    'brief',
    'summary',
    'warnings',
    'ok'
  ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function extractProviderContentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        if (Array.isArray(part.content)) return extractProviderContentText(part.content);
        if (typeof part.value === 'string') return part.value;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (isObject(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return extractProviderContentText(value.content);
    if (typeof value.value === 'string') return value.value;
  }
  return '';
}

export function extractProviderResponseText(value = '') {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value || '');
  const choice = Array.isArray(value.choices) ? value.choices[0] : null;
  const candidate = Array.isArray(value.candidates) ? value.candidates[0] : null;
  const output = Array.isArray(value.outputs) ? value.outputs[0] : (Array.isArray(value.output) ? value.output[0] : null);
  const text = extractProviderContentText(choice?.message?.content)
    || extractProviderContentText(choice?.delta?.content)
    || extractProviderContentText(choice?.text)
    || extractProviderContentText(candidate?.content)
    || extractProviderContentText(candidate?.text)
    || extractProviderContentText(output?.content)
    || extractProviderContentText(output?.text)
    || extractProviderContentText(value.message?.content)
    || extractProviderContentText(value.content)
    || extractProviderContentText(value.response)
    || extractProviderContentText(value.text);
  if (text) return text;
  if (hasStructuredResponseShape(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
    return String(value || '');
  }
  return '';
}

export function extractProviderResponseReasoning(value = '') {
  if (!value || typeof value !== 'object') return '';
  const choice = Array.isArray(value.choices) ? value.choices[0] : null;
  const message = choice?.message || value.message || value || {};
  const parts = [];
  const direct = [
    message.reasoning,
    message.reasoning_content,
    message.reasoningContent,
    choice?.reasoning,
    value.reasoning
  ];
  for (const item of direct) {
    const text = extractProviderContentText(item);
    if (text) parts.push(text);
  }
  const details = message.reasoning_details
    || message.reasoningDetails
    || choice?.message?.reasoning_details
    || value.reasoning_details
    || value.reasoningDetails;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const text = extractProviderContentText(detail?.text ?? detail?.content ?? detail);
      if (text) parts.push(text);
    }
  }
  return parts.join('').slice(0, 12000);
}

export function normalizeProviderResponseFinishReason(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'object') {
    return normalizeProviderResponseFinishReason(
      value.reason
        ?? value.type
        ?? value.code
        ?? value.status
        ?? value.finish_reason
        ?? value.finishReason
        ?? value.stop_reason
        ?? value.stopReason
        ?? value.native_finish_reason
        ?? value.nativeFinishReason
    );
  }
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function collectProviderResponseFinishReasons(value) {
  if (!value || typeof value !== 'object') return [];
  const choice = Array.isArray(value.choices) ? value.choices[0] : null;
  const candidate = Array.isArray(value.candidates) ? value.candidates[0] : null;
  const output = Array.isArray(value.outputs) ? value.outputs[0] : (Array.isArray(value.output) ? value.output[0] : null);
  const message = choice?.message || value.message || {};
  const details = choice?.finish_details || choice?.finishDetails || value.finish_details || value.finishDetails;
  const metadata = value.response_metadata || value.responseMetadata || value.metadata || {};
  return [
    choice?.finish_reason,
    choice?.finishReason,
    choice?.native_finish_reason,
    choice?.nativeFinishReason,
    choice?.stop_reason,
    choice?.stopReason,
    message?.finish_reason,
    message?.finishReason,
    message?.stop_reason,
    message?.stopReason,
    value.finish_reason,
    value.finishReason,
    value.native_finish_reason,
    value.nativeFinishReason,
    value.stop_reason,
    value.stopReason,
    details,
    metadata?.finish_reason,
    metadata?.finishReason,
    metadata?.stop_reason,
    metadata?.stopReason,
    candidate?.finish_reason,
    candidate?.finishReason,
    candidate?.stop_reason,
    candidate?.stopReason,
    output?.finish_reason,
    output?.finishReason,
    output?.stop_reason,
    output?.stopReason
  ].map(normalizeProviderResponseFinishReason).filter(Boolean);
}

export function isProviderResponseTokenLimitFinishReason(reason) {
  const normalized = normalizeProviderResponseFinishReason(reason);
  if (!normalized) return false;
  if ([
    'length',
    'max_tokens',
    'max_token',
    'max_completion_tokens',
    'max_output_tokens',
    'token_limit',
    'token_limit_reached',
    'length_limit',
    'truncated',
    'incomplete'
  ].includes(normalized)) return true;
  return normalized.includes('max_token')
    || normalized.includes('token_limit')
    || normalized.includes('length_limit')
    || normalized.includes('output_limit');
}

export function describeProviderResponse(value = '', options = {}) {
  const text = extractProviderResponseText(value);
  const reasoning = extractProviderResponseReasoning(value);
  const finishReasons = collectProviderResponseFinishReasons(value);
  const sampleLimit = Math.max(0, Math.min(1000, Number(options.sampleLimit ?? 160) || 160));
  return {
    resultType: value === null ? 'null' : (Array.isArray(value) ? 'array' : typeof value),
    finishReason: finishReasons[0] || '',
    visibleContentLength: text.length,
    reasoningLength: reasoning.length,
    sample: sampleLimit ? text.slice(0, sampleLimit) : ''
  };
}

export function getProviderResponseFailure(value = '', options = {}) {
  const providerTitle = cleanProviderTitle(options.providerTitle || options.title || options.provider || '');
  const description = describeProviderResponse(value, { sampleLimit: options.sampleLimit ?? 160 });
  const tokenReason = collectProviderResponseFinishReasons(value).find(isProviderResponseTokenLimitFinishReason) || '';
  if (tokenReason) {
    const maxTokens = Math.max(0, Number(options.maxTokens || 0) || 0);
    return {
      ...description,
      code: PROVIDER_RESPONSE_ERROR_CODES.TOKEN_LIMIT,
      providerTitle,
      finishReason: tokenReason,
      maxTokens,
      message: maxTokens
        ? `${providerTitle} provider stopped because it hit the response token limit (${tokenReason}; max ${maxTokens}).`
        : `${providerTitle} provider stopped because it hit the response token limit (${tokenReason}).`
    };
  }

  const visibleText = extractProviderResponseText(value);
  if (visibleText.trim()) return null;

  const reasoning = extractProviderResponseReasoning(value);
  if (reasoning.trim()) {
    return {
      ...description,
      code: PROVIDER_RESPONSE_ERROR_CODES.REASONING_ONLY,
      providerTitle,
      message: `${providerTitle} provider returned reasoning-only output with empty visible content.`
    };
  }

  return {
    ...description,
    code: PROVIDER_RESPONSE_ERROR_CODES.EMPTY_CONTENT,
    providerTitle,
    message: `${providerTitle} provider returned empty content.`
  };
}

export function createProviderResponseError(failureOrCode, message = '', details = {}) {
  const failure = isObject(failureOrCode) ? failureOrCode : { code: failureOrCode, message, ...details };
  const error = new Error(cleanText(failure.message || message || failure.code || 'Provider response was not usable.', 1400));
  error.name = 'ProviderResponseError';
  error.code = cleanText(failure.code || '', 120);
  error.details = { ...failure };
  return error;
}

export function assertProviderResponseText(value = '', options = {}) {
  const failure = getProviderResponseFailure(value, options);
  if (failure) throw createProviderResponseError(failure);
  return extractProviderResponseText(value);
}
