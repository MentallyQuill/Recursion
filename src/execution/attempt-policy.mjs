import { failureFrom } from '../failures.mjs';
import { normalizeProviderError } from '../providers/provider-errors.mjs';
import { minimumOutputBudgetForRole } from '../providers/stage-output-budgets.mjs';

const ATTEMPT_MIN = 1;
const ATTEMPT_MAX = 5;
const MODEL_RETRY_ACTIONS = new Set([
  'stop',
  'downgrade-structured-output',
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

export function resolveModelRetryDirective({ failure, request, attempt, limit }) {
  if (attempt >= limit || failure?.kind === 'abort') return stopDirective();

  if (failure?.code === 'RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED'
      && request?.structuredOutputMethod === 'native-schema') {
    return retryDirective('downgrade-structured-output', {
      diagnosticCode: 'structured-output-downgraded',
      nextRequest: { ...request, structuredOutputMethod: 'prompt-json' }
    });
  }

  if (failure?.code === 'RECURSION_PROVIDER_CONTEXT_LIMIT') {
    const floor = minimumOutputBudgetForRole(request?.roleId);
    const current = Number(request?.responseLength) || floor;
    const reduced = Math.max(floor, Math.floor(current * 0.75));
    if (reduced >= current) return stopDirective('output-budget-at-floor');
    return retryDirective('reduce-output-budget', {
      diagnosticCode: 'output-budget-reduced',
      nextRequest: { ...request, responseLength: reduced }
    });
  }

  if (failure?.kind === 'validation') {
    return retryDirective('retry-corrected', {
      diagnosticCode: 'model-output-corrected'
    });
  }

  if (failure?.code === 'RECURSION_PROVIDER_RATE_LIMIT'
      || failure?.code === 'RECURSION_PROVIDER_TRANSIENT'
      || (failure?.kind === 'transport' && failure?.retryable === true)) {
    const delayMs = attempt === 1 ? 250 : 750;
    const diagnosticCode = failure.code === 'RECURSION_PROVIDER_RATE_LIMIT'
      ? 'provider-rate-limit-retry'
      : failure.code === 'RECURSION_PROVIDER_TRANSIENT'
        ? 'provider-transient-retry'
        : 'provider-retry';
    return retryDirective('retry-same', {
      delayMs,
      diagnosticCode,
      nextRequest: request
    });
  }

  return stopDirective();
}

function abortableSleep(ms, signal) {
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
  onAttemptSettled = null
} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('Model attempt policy requires invoke.');
  if (typeof validate !== 'function') throw new TypeError('Model attempt policy requires validate.');

  const limit = normalizeAttempts(attemptsPerStep);
  const attempts = [];
  let currentRequest = request;
  let lastFailure = null;
  let lastResponse;

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    if (signal?.aborted) {
      lastFailure = normalizeProviderError(Object.assign(new Error('Stopped.'), { name: 'AbortError' }));
      return { ok: false, aborted: true, failure: lastFailure, lastResponse, attempts };
    }

    let response;
    let validationError = null;
    let outcome = 'failed';
    try {
      response = await invoke(currentRequest, { attempt, signal });
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

    const directive = resolveDirective({
      failure: lastFailure,
      request: currentRequest,
      attempt,
      limit
    });
    await notifyAttempt(onAttemptSettled, attempts, {
      attempt,
      outcome,
      failure: lastFailure,
      action: directive.action,
      delayMs: directive.delayMs,
      diagnosticCode: directive.diagnosticCode
    });

    if (lastFailure.kind === 'abort') {
      return { ok: false, aborted: true, failure: lastFailure, lastResponse, attempts };
    }
    if (directive.action === 'stop') break;

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
