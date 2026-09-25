import { failureFrom } from '../failures.mjs';
import { normalizeInstructionValidationRule } from '../instruction-safety.mjs';
import { normalizeProviderError } from '../providers/provider-errors.mjs';
import { minimumOutputBudgetForRole, outputBudgetForRequest } from '../providers/stage-output-budgets.mjs';
import { RATE_LIMIT_RETRY_LIMIT, rateLimitDelay } from '../providers/rate-limit-policy.mjs';

const ATTEMPT_MIN = 1;
const ATTEMPT_MAX = 5;
const TRANSIENT_RETRY_LIMIT = 3;
const MODEL_RETRY_ACTIONS = new Set([
  'stop',
  'downgrade-structured-output',
  'increase-output-budget',
  'reduce-output-budget',
  'retry-corrected',
  'retry-same'
]);

function normalizeAttempts(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(ATTEMPT_MAX, Math.max(ATTEMPT_MIN, parsed));
}

function isAbort(error, signal) {
  return signal?.aborted === true
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.code === 'RECURSION_PROVIDER_ABORTED';
}

export function classifyModelFailure(error, { kind = 'transport', signal = null } = {}) {
  if (isAbort(error, signal)) {
    return normalizeProviderError(Object.assign(new Error('Stopped.'), {
      name: 'AbortError',
      code: 'RECURSION_PROVIDER_ABORTED'
    }));
  }
  if (kind === 'validation') {
    const validationRule = normalizeInstructionValidationRule(error?.validationRule);
    const failure = failureFrom(error, {
      code: 'RECURSION_MODEL_OUTPUT_INVALID',
      stage: 'model-attempt',
      category: 'validation',
      message: 'The model response did not pass validation.',
      retryable: true
    });
    return Object.freeze({
      kind: 'validation',
      code: failure.code,
      category: failure.category,
      message: failure.message,
      retryable: failure.retryable,
      ...(validationRule ? { validationRule } : {}),
      ...(failure.suggestedAction ? { suggestedAction: failure.suggestedAction } : {})
    });
  }
  return normalizeProviderError(error);
}

function normalizeValidation(value) {
  if (value?.ok === true) return { ok: true, value: value.value };
  if (value?.ok === false) return { ok: false, error: value.error };
  return { ok: true, value };
}

function failureKindForRejectedResponse(error) {
  if (error?.kind === 'transport') return 'transport';
  const category = String(error?.category || '').trim().toLowerCase();
  if ([
    'provider',
    'provider-account',
    'provider-request',
    'provider-timeout',
    'provider-length',
    'configuration',
    'compatibility',
    'capacity'
  ].includes(category)) return 'transport';
  return 'validation';
}

function retryDirective(action, {
  delayMs = 0,
  diagnosticCode = '',
  nextRequest = null
} = {}) {
  if (!MODEL_RETRY_ACTIONS.has(action)) throw new TypeError(`Unknown retry action: ${action}`);
  return Object.freeze({
    action,
    delayMs: Math.max(0, Math.trunc(Number(delayMs) || 0)),
    diagnosticCode: String(diagnosticCode || '').slice(0, 120),
    nextRequest
  });
}

function stopDirective(diagnosticCode = '') {
  return retryDirective('stop', { diagnosticCode });
}

export function resolveModelRetryDirective({ failure, request, attempt, limit, rateLimitFailures = 1, transientFailures = 1 }) {
  if (failure?.kind === 'abort') return stopDirective();
  if (failure?.code === 'RECURSION_PROVIDER_RATE_LIMIT') {
    if (rateLimitFailures > RATE_LIMIT_RETRY_LIMIT) return stopDirective('provider-rate-limit-exhausted');
    return retryDirective('retry-same', {
      delayMs: rateLimitDelay(failure.retryAfterMs, rateLimitFailures),
      diagnosticCode: 'provider-rate-limit-retry',
      nextRequest: request
    });
  }
  if (failure?.code === 'RECURSION_PROVIDER_TRANSIENT' && failure?.retryable !== false) {
    if (transientFailures > TRANSIENT_RETRY_LIMIT) return stopDirective('provider-transient-exhausted');
    return retryDirective('retry-same', {
      delayMs: Math.max(2000 * (2 ** Math.max(0, transientFailures - 1)), failure.retryAfterMs || 0),
      diagnosticCode: 'provider-transient-retry',
      nextRequest: request
    });
  }
  if (attempt >= limit) return stopDirective();
  if (['RECURSION_PROVIDER_REFUSAL', 'RECURSION_PROVIDER_CONTENT_FILTER',
    'RECURSION_RECOVERY_BUDGET_EXHAUSTED', 'RECURSION_OPERATION_DEADLINE'].includes(failure?.code)) {
    return stopDirective('provider-declined-request');
  }

  if (failure?.code === 'RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED'
      && request?.structuredOutputMethod === 'native-schema') {
    return retryDirective('downgrade-structured-output', {
      diagnosticCode: 'structured-output-downgraded',
      nextRequest: { ...request, structuredOutputMethod: 'prompt-json' }
    });
  }

  if (failure?.code === 'RECURSION_PROVIDER_CONTEXT_LIMIT') {
    const wrapped = request?.request && typeof request.request === 'object' && !Array.isArray(request.request);
    const providerRequest = wrapped ? request.request : request;
    const roleId = request?.roleId || providerRequest?.roleId;
    const floor = minimumOutputBudgetForRole(roleId);
    const ceiling = outputBudgetForRequest('', {}, providerRequest?.providerConfig?.outputTokenCeiling);
    const current = outputBudgetForRequest(roleId, providerRequest, ceiling);
    const reduced = Math.max(floor, Math.floor(current * 0.75));
    if (reduced >= current) return stopDirective('output-budget-at-floor');
    const nextRequest = wrapped
      ? { ...request, request: { ...providerRequest, responseLength: reduced } }
      : { ...request, responseLength: reduced };
    return retryDirective('reduce-output-budget', {
      diagnosticCode: 'output-budget-reduced',
      nextRequest
    });
  }

  if (failure?.code === 'RECURSION_PROVIDER_TOKEN_LIMIT') {
    const wrapped = request?.request && typeof request.request === 'object' && !Array.isArray(request.request);
    const providerRequest = wrapped ? request.request : request;
    const roleId = request?.roleId || providerRequest?.roleId;
    const ceiling = outputBudgetForRequest('', {}, providerRequest?.providerConfig?.outputTokenCeiling);
    const current = outputBudgetForRequest(roleId, providerRequest, ceiling);
    const increased = Math.min(ceiling, Math.max(current + 1024, current * 2));
    if (increased <= current) return stopDirective('output-budget-at-ceiling');
    const nextRequest = wrapped
      ? { ...request, request: { ...providerRequest, responseLength: increased } }
      : { ...request, responseLength: increased };
    return retryDirective('increase-output-budget', {
      diagnosticCode: 'output-budget-increased',
      nextRequest
    });
  }

  if (failure?.kind === 'validation') {
    return retryDirective('retry-corrected', {
      diagnosticCode: 'model-output-corrected'
    });
  }

  if (failure?.kind === 'transport' && failure?.retryable === true) {
    const delayMs = failure?.retryAfterMs ?? (attempt === 1 ? 250 : 750);
    return retryDirective('retry-same', {
      delayMs,
      diagnosticCode: 'provider-retry',
      nextRequest: request
    });
  }

  return stopDirective();
}

export function abortableSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('Provider retry was stopped.'), {
      name: 'AbortError',
      code: 'RECURSION_PROVIDER_ABORTED'
    }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('Provider retry was stopped.'), {
        name: 'AbortError',
        code: 'RECURSION_PROVIDER_ABORTED'
      }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function notifyAttempt(onAttemptSettled, attempts, summary) {
  const frozen = Object.freeze(summary);
  attempts.push(frozen);
  if (typeof onAttemptSettled === 'function') await onAttemptSettled(frozen);
}

export async function runModelStageAttempts({
  attemptsPerStep = 2,
  request,
  invoke,
  validate,
  buildCorrectionRequest,
  resolveDirective = resolveModelRetryDirective,
  sleep = abortableSleep,
  signal = null,
  capacityRecovery = null,
  onAttemptSettled = null
} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('Model attempt policy requires invoke.');
  if (typeof validate !== 'function') throw new TypeError('Model attempt policy requires validate.');

  const limit = normalizeAttempts(attemptsPerStep);
  const attempts = [];
  let currentRequest = request;
  let lastFailure = capacityRecovery?.failure ? classifyModelFailure(capacityRecovery.failure) : null;
  let lastResponse;
  let modelAttempts = 0;
  let rateLimitFailures = Math.max(0, Math.trunc(capacityRecovery?.failure?.rateLimitFailures || 0));
  let transientFailures = 0;
  let retryReason = lastFailure?.code || null;

  if (lastFailure && rateLimitFailures > RATE_LIMIT_RETRY_LIMIT) {
    return { ok: false, failure: lastFailure, attempts };
  }

  for (let attempt = 1; attempt <= limit + RATE_LIMIT_RETRY_LIMIT + TRANSIENT_RETRY_LIMIT; attempt += 1) {
    if (signal?.aborted) {
      lastFailure = normalizeProviderError(Object.assign(new Error('Stopped.'), { name: 'AbortError' }));
      return { ok: false, aborted: true, failure: lastFailure, lastResponse, attempts };
    }

    let response;
    let validationError = null;
    let outcome = 'failed';
    try {
      response = await invoke(currentRequest, { attempt, signal, retryReason });
      lastResponse = response;
      if (signal?.aborted) {
        throw Object.assign(new Error('Provider request was stopped.'), {
          name: 'AbortError',
          code: 'RECURSION_PROVIDER_ABORTED'
        });
      }
      const normalized = normalizeValidation(await validate(response, { attempt, signal }));
      if (normalized.ok) {
        await notifyAttempt(onAttemptSettled, attempts, {
          attempt,
          outcome: 'accepted',
          action: 'stop',
          delayMs: 0,
          diagnosticCode: ''
        });
        return { ok: true, value: normalized.value, response, attempts };
      }
      validationError = normalized.error;
      lastFailure = classifyModelFailure(validationError, { kind: failureKindForRejectedResponse(validationError), signal });
      outcome = 'invalid';
    } catch (error) {
      lastFailure = classifyModelFailure(error, { signal });
      outcome = lastFailure.kind === 'abort' ? 'aborted' : 'failed';
    }

    if (lastFailure.code === 'RECURSION_PROVIDER_RATE_LIMIT') rateLimitFailures += 1;
    else if (lastFailure.code === 'RECURSION_PROVIDER_TRANSIENT') transientFailures += 1;
    else modelAttempts += 1;
    const directive = resolveDirective({
      failure: lastFailure,
      request: currentRequest,
      attempt: modelAttempts,
      limit,
      rateLimitFailures,
      transientFailures
    });
    await notifyAttempt(onAttemptSettled, attempts, {
      attempt,
      outcome,
      failure: lastFailure,
      rateLimitFailures,
      action: directive.action,
      delayMs: directive.delayMs,
      diagnosticCode: directive.diagnosticCode
    });

    if (lastFailure.kind === 'abort') {
      return { ok: false, aborted: true, failure: lastFailure, lastResponse, attempts };
    }
    if (directive.action === 'stop') break;
    retryReason = lastFailure.code;

    if (directive.delayMs > 0) {
      try {
        await sleep(directive.delayMs, signal);
      } catch (error) {
        lastFailure = classifyModelFailure(error, { signal });
        return { ok: false, aborted: lastFailure.kind === 'abort', failure: lastFailure, lastResponse, attempts };
      }
    }

    if (directive.action === 'retry-corrected') {
      if (typeof buildCorrectionRequest !== 'function') break;
      currentRequest = await buildCorrectionRequest({
        request: currentRequest,
        response: lastResponse,
        error: validationError,
        attempt
      });
    } else {
      currentRequest = directive.nextRequest;
    }

    if (!currentRequest || typeof currentRequest !== 'object') break;
  }

  return {
    ok: false,
    failure: lastFailure || classifyModelFailure(new Error('Provider request failed.'), { signal }),
    lastResponse,
    attempts
  };
}
