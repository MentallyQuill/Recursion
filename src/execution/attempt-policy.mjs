import { providerFailure } from '../failures.mjs';

const ATTEMPT_MIN = 1;
const ATTEMPT_MAX = 5;

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

function safeCode(value, fallback) {
  const code = String(value || fallback)
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return code || fallback;
}

export function classifyModelFailure(error, { kind = 'transport', signal = null } = {}) {
  if (isAbort(error, signal)) {
    return Object.freeze({
      kind: 'abort',
      code: 'RECURSION_MODEL_ATTEMPT_ABORTED',
      category: 'stale-state',
      message: 'The model attempt was stopped.',
      retryable: false
    });
  }
  if (kind === 'validation') {
    return Object.freeze({
      kind: 'validation',
      code: safeCode(error?.code, 'RECURSION_MODEL_OUTPUT_INVALID'),
      category: 'validation',
      message: 'The model response did not pass validation.',
      retryable: true
    });
  }
  const failure = providerFailure(error, { stage: 'model-attempt' });
  return Object.freeze({
    kind: 'transport',
    code: failure.code,
    category: failure.category,
    message: failure.message,
    retryable: failure.retryable
  });
}

function normalizeValidation(value) {
  if (value?.ok === true) {
    return { ok: true, value: value.value };
  }
  if (value?.ok === false) {
    return { ok: false, error: value.error };
  }
  return { ok: true, value };
}

async function notifyAttempt(onAttemptSettled, attempts, summary) {
  const frozen = Object.freeze(summary);
  attempts.push(frozen);
  if (typeof onAttemptSettled === 'function') {
    await onAttemptSettled(frozen);
  }
}

export async function runModelStageAttempts({
  attemptsPerStep = 2,
  request,
  invoke,
  validate,
  buildCorrectionRequest,
  signal = null,
  onAttemptSettled = null
} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('Model attempt policy requires invoke.');
  if (typeof validate !== 'function') throw new TypeError('Model attempt policy requires validate.');

  const limit = normalizeAttempts(attemptsPerStep);
  const attempts = [];
  let currentRequest = request;
  let lastFailure = null;

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    if (signal?.aborted === true) {
      lastFailure = classifyModelFailure(null, { signal });
      return { ok: false, aborted: true, failure: lastFailure, attempts };
    }

    let response;
    try {
      response = await invoke(currentRequest, {
        attempt,
        signal
      });
    } catch (error) {
      lastFailure = classifyModelFailure(error, { signal });
      await notifyAttempt(onAttemptSettled, attempts, {
        attempt,
        outcome: lastFailure.kind === 'abort' ? 'aborted' : 'failed',
        failure: lastFailure
      });
      if (lastFailure.kind === 'abort') {
        return { ok: false, aborted: true, failure: lastFailure, attempts };
      }
      continue;
    }

    if (signal?.aborted === true) {
      lastFailure = classifyModelFailure(null, { signal });
      await notifyAttempt(onAttemptSettled, attempts, {
        attempt,
        outcome: 'aborted',
        failure: lastFailure
      });
      return { ok: false, aborted: true, failure: lastFailure, attempts };
    }

    let validation;
    try {
      validation = normalizeValidation(await validate(response, {
        attempt,
        signal
      }));
    } catch (error) {
      validation = { ok: false, error };
    }

    if (validation.ok) {
      await notifyAttempt(onAttemptSettled, attempts, {
        attempt,
        outcome: 'accepted'
      });
      return {
        ok: true,
        value: validation.value,
        response,
        attempts
      };
    }

    lastFailure = classifyModelFailure(validation.error, { kind: 'validation', signal });
    await notifyAttempt(onAttemptSettled, attempts, {
      attempt,
      outcome: 'invalid',
      failure: lastFailure
    });
    if (attempt < limit && typeof buildCorrectionRequest === 'function') {
      currentRequest = await buildCorrectionRequest({
        request: currentRequest,
        response,
        error: validation.error,
        attempt
      });
    }
  }

  return {
    ok: false,
    failure: lastFailure || classifyModelFailure(null),
    attempts
  };
}
