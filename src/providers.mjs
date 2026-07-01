import {
  cloneJson,
  compact,
  hashJson,
  makeId,
  nowIso,
  parseJsonObject,
  redact,
  truncate
} from './core.mjs';
import { DEFAULT_RECURSION_SETTINGS } from './settings.mjs';

const LANES = new Set(['utility', 'reasoner']);
const HOST_SOURCES = new Set(['host-current-model', 'host-connection-profile']);
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EPIPE',
  'RECURSION_PROVIDER_TIMEOUT'
]);
export const UTILITY_ROLE_IDS = Object.freeze([
  'utilityArbiter',
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'continuityRiskCard',
  'environmentItemsCard',
  'prosePacingCard',
  'openThreadsCard',
  'briefUtilityComposer',
  'providerTest'
]);
export const REASONER_ROLE_IDS = Object.freeze(['reasonerComposer']);
export const PROVIDER_CONTRACT_VERSION = 1;
export const PROVIDER_CONTRACT_HASH = hashJson({
  providerContractVersion: PROVIDER_CONTRACT_VERSION,
  utilityRoles: UTILITY_ROLE_IDS,
  reasonerRoles: REASONER_ROLE_IDS,
  responseSchemas: {
    card: 'recursion.card.v1',
    utilityArbiter: 'recursion.utilityArbiter.v1',
    briefUtilityComposer: 'recursion.briefUtilityComposer.v1',
    reasonerComposer: 'recursion.reasonerComposer.v1',
    providerTest: 'recursion.providerTest.v1'
  }
});
const UTILITY_ROLES = new Set(UTILITY_ROLE_IDS);
const REASONER_ROLES = new Set(REASONER_ROLE_IDS);
const SECRET_TEXT_PATTERN = /(sk-[a-z0-9_-]+|bearer\s+[a-z0-9._-]+|session-key|secret[-_\s]*value|private[-_\s]*key[-_\s]*material)/ig;
const TOKEN_LIMIT_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
  'token_limit'
]);

function scrubSecretText(value) {
  if (typeof value === 'string') return value.replace(SECRET_TEXT_PATTERN, '[redacted]');
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubSecretText(entry));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrubSecretText(child)]));
}

function sanitize(value, maxString = 500) {
  return scrubSecretText(redact(value, { maxString }));
}

function cloneSafe(value, fallback = undefined) {
  try {
    const cloned = cloneJson(value);
    return cloned === undefined ? fallback : cloned;
  } catch {
    return fallback;
  }
}

function providerError(code, message, { retryable = false, status = undefined, cause = undefined } = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  if (status !== undefined) error.status = status;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function laneName(value, fallback = 'utility') {
  const lane = String(value || '').trim();
  return LANES.has(lane) ? lane : fallback;
}

function sourceName(value) {
  return String(value || 'host-current-model').trim() || 'host-current-model';
}

function readSettings(settingsStore) {
  try {
    return settingsStore?.get?.() || cloneJson(DEFAULT_RECURSION_SETTINGS);
  } catch {
    return cloneJson(DEFAULT_RECURSION_SETTINGS);
  }
}

function providerConfigFor(settingsStore, lane) {
  const settings = readSettings(settingsStore);
  const provider = settings.providers?.[lane] || DEFAULT_RECURSION_SETTINGS.providers[lane];
  return {
    settings,
    config: provider || DEFAULT_RECURSION_SETTINGS.providers.utility
  };
}

function shouldAllowReasoner(settings, config) {
  return settings.reasonerUse !== 'off' && config?.enabled === true;
}

function requestLane(roleId, request = {}) {
  if (LANES.has(request?.lane)) return request.lane;
  return roleLane(roleId);
}

function normalizeBatchRequest(entry) {
  if (!entry || typeof entry !== 'object') {
    throw providerError('RECURSION_PROVIDER_REQUEST_INVALID', 'Provider batch requests must be objects.', { retryable: false });
  }
  const roleId = String(entry.roleId || entry.role || '').trim();
  if (!roleId) {
    throw providerError('RECURSION_PROVIDER_ROLE_MISSING', 'Provider batch request is missing roleId.', { retryable: false });
  }
  const request = { ...entry };
  delete request.roleId;
  delete request.role;
  return { roleId, request };
}

function cleanRequestForDiagnostics(request = {}) {
  const clean = { ...request };
  delete clean.prompt;
  delete clean.messages;
  delete clean.signal;
  if (request.prompt !== undefined) clean.promptHash = hashJson(String(request.prompt));
  if (request.messages !== undefined) clean.messagesHash = hashJson(request.messages);
  return sanitize(clean, 200);
}

function openAiEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/g, '');
  if (!base) {
    throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible base URL is required.', { retryable: false });
  }
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible base URL is invalid.', { retryable: false });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible base URL must use http or https.', { retryable: false });
  }
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function chatMessages(request = {}) {
  if (Array.isArray(request.messages) && request.messages.length > 0) return request.messages;
  return [{ role: 'user', content: String(request.prompt ?? '') }];
}

function parseOpenAiText(payload) {
  const choice = payload?.choices?.[0];
  const finishReason = normalizeFinishReason(choice?.finish_reason ?? choice?.finishReason ?? payload?.finish_reason ?? payload?.finishReason);
  if (TOKEN_LIMIT_FINISH_REASONS.has(finishReason)) {
    throw providerError('RECURSION_PROVIDER_TOKEN_LIMIT', 'Provider response stopped at the token limit before returning complete visible JSON.', {
      retryable: false
    });
  }

  const content = visibleProviderText(choice?.message?.content ?? choice?.text ?? payload?.output_text);
  if (content.trim()) return content;

  if (hasReasoningOnlyText(payload)) {
    throw providerError('RECURSION_PROVIDER_REASONING_ONLY', 'Provider returned hidden reasoning without visible JSON content.', {
      retryable: false
    });
  }

  throw providerError('RECURSION_PROVIDER_EMPTY_RESPONSE', 'Provider response did not include message content.', {
    retryable: false
  });
}

function normalizeFinishReason(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function visibleProviderText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (!entry || typeof entry !== 'object') return '';
        return String(entry.text ?? entry.content ?? entry.value ?? '');
      })
      .join('');
  }
  return String(value.text ?? value.content ?? value.value ?? '');
}

function hasReasoningOnlyText(value) {
  return containsReasoningText(value, false);
}

function containsReasoningText(value, insideReasoningField) {
  if (typeof value === 'string') return insideReasoningField && value.trim().length > 0;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => containsReasoningText(entry, insideReasoningField));
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = String(key || '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
    const nextInsideReasoningField = insideReasoningField
      || normalizedKey.includes('reasoning')
      || normalizedKey.includes('thought');
    if (containsReasoningText(child, nextInsideReasoningField)) return true;
  }
  return false;
}

function normalizeProviderResponse(response, enriched) {
  const output = response && typeof response === 'object' ? { ...response } : { text: String(response ?? '') };
  return {
    ...output,
    text: String(output.text ?? ''),
    roleId: enriched.roleId,
    lane: enriched.lane,
    providerSource: enriched.providerSource,
    providerId: output.providerId || enriched.providerSource,
    model: output.model || enriched.providerConfig?.resolvedModelLabel || enriched.providerConfig?.openAICompatible?.model || '',
    providerConfig: enriched.providerConfig
  };
}

function responseTextHash(text) {
  return hashJson(String(text ?? ''));
}

function retryableError(error) {
  if (error?.retryable === true) return true;
  if (error?.retryable === false) return false;
  if (TRANSIENT_CODES.has(error?.code)) return true;
  const status = Number(error?.status);
  return status === 429 || (status >= 500 && status < 600);
}

function scrubKnownRequestText(value, request = {}) {
  let output = String(value ?? '');
  const needles = [];
  if (typeof request.prompt === 'string') needles.push(request.prompt);
  if (request.messages !== undefined) {
    needles.push(JSON.stringify(request.messages));
    collectStrings(request.messages, needles);
  }
  for (const needle of Array.from(new Set(needles)).sort((a, b) => b.length - a.length)) {
    if (!needle) continue;
    output = output.split(needle).join('[redacted]');
    output = output.split(compact(needle)).join('[redacted]');
  }
  return output;
}

function collectStrings(value, target) {
  if (typeof value === 'string') {
    target.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, target);
    return;
  }
  for (const child of Object.values(value)) collectStrings(child, target);
}

function sanitizedError(error, request = {}) {
  const rawCode = String(error?.code || error?.name || 'RECURSION_PROVIDER_FAILED');
  const message = error?.external === true
    ? 'Provider generation failed.'
    : scrubKnownRequestText(error?.message || 'Provider generation failed.', request);
  return sanitize({
    code: scrubKnownRequestText(rawCode, request),
    message: truncate(compact(message), 300),
    retryable: retryableError(error)
  }, 300);
}

function sanitizedBatchError(error, entries = []) {
  const safeError = { ...sanitizedError(error) };
  for (const entry of entries) {
    safeError.code = scrubKnownRequestText(safeError.code, entry.request);
    safeError.message = scrubKnownRequestText(safeError.message, entry.request);
  }
  return sanitize(safeError, 300);
}

function statusForError(error) {
  if (error?.code === 'RECURSION_JSON_PARSE_FAILED' || error?.code === 'RECURSION_JSON_OBJECT_REQUIRED') {
    return 'validation-failed';
  }
  if (error?.code === 'RECURSION_PROVIDER_TIMEOUT') return 'timeout';
  if (error?.code === 'RECURSION_PROVIDER_ABORTED') return 'aborted';
  return 'provider-failed';
}

function safeInvoke(fn) {
  if (typeof fn !== 'function') return undefined;
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return result;
  } catch {
    return undefined;
  }
}

async function journalAppend(journal, entry) {
  if (!journal) return;
  const safeEntry = sanitize(entry, 300);
  const methods = ['append', 'record', 'write', 'push'];
  for (const method of methods) {
    if (typeof journal?.[method] === 'function') {
      try {
        await journal[method](cloneSafe(safeEntry, safeEntry));
      } catch {
        // Journal writes are diagnostic only.
      }
      return;
    }
  }
  if (typeof journal === 'function') {
    try {
      await journal(cloneSafe(safeEntry, safeEntry));
    } catch {
      // Journal writes are diagnostic only.
    }
  }
}

function activityStart(activity, event) {
  if (!activity || typeof activity.start !== 'function') return event.runId;
  const safeEvent = sanitize(event, 300);
  let runId = event.runId;
  safeInvoke(() => {
    const started = activity.start(cloneSafe(safeEvent, safeEvent));
    if (started?.runId) runId = started.runId;
    return started;
  });
  return runId;
}

function activityStage(activity, event) {
  if (!activity || typeof activity.stage !== 'function') return;
  const safeEvent = sanitize(event, 300);
  safeInvoke(() => activity.stage(cloneSafe(safeEvent, safeEvent)));
}

function activitySettle(activity, event) {
  if (!activity || typeof activity.settle !== 'function') return;
  const safeEvent = sanitize(event, 300);
  safeInvoke(() => activity.settle(cloneSafe(safeEvent, safeEvent)));
}

function abortError() {
  return providerError('RECURSION_PROVIDER_ABORTED', 'Provider generation was aborted.', { retryable: false });
}

function timeoutError(timeoutMs) {
  return providerError('RECURSION_PROVIDER_TIMEOUT', `Provider generation timed out after ${timeoutMs}ms.`, {
    retryable: true
  });
}

async function withTimeout(operation, request, timeoutMs, externalSignal = null) {
  if (externalSignal?.aborted) throw abortError();

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const requestWithSignal = controller ? { ...request, signal: controller.signal } : { ...request };
  let timeoutId = null;
  let removeAbortListener = () => {};

  const timeoutPromise = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort?.();
        reject(timeoutError(timeoutMs));
      }, timeoutMs);
    })
    : null;

  const abortPromise = externalSignal
    ? new Promise((_, reject) => {
      const onAbort = () => {
        controller?.abort?.();
        reject(abortError());
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => externalSignal.removeEventListener('abort', onAbort);
    })
    : null;

  try {
    const generation = operation(requestWithSignal);
    const racers = [generation];
    if (timeoutPromise) racers.push(timeoutPromise);
    if (abortPromise) racers.push(abortPromise);
    return await Promise.race(racers);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener();
  }
}

function composeAbortSignal(signals = []) {
  const activeSignals = signals.filter((signal) => signal && typeof signal.addEventListener === 'function');
  if (activeSignals.length === 0) return { signal: undefined, cleanup: () => {} };
  if (activeSignals.length === 1) return { signal: activeSignals[0], cleanup: () => {} };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (!controller) return { signal: activeSignals[0], cleanup: () => {} };

  const cleanupHandlers = [];
  const abort = () => controller.abort();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      continue;
    }
    signal.addEventListener('abort', abort, { once: true });
    cleanupHandlers.push(() => signal.removeEventListener('abort', abort));
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const cleanup of cleanupHandlers) cleanup();
    }
  };
}

async function withBatchTimeout(operation, requests, timeoutMs, externalSignal = null) {
  if (externalSignal?.aborted) throw abortError();

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeoutId = null;
  let removeAbortListener = () => {};
  const signalCleanups = [];

  const timeoutPromise = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort?.();
        reject(timeoutError(timeoutMs));
      }, timeoutMs);
    })
    : null;

  const abortPromise = externalSignal
    ? new Promise((_, reject) => {
      const onAbort = () => {
        controller?.abort?.();
        reject(abortError());
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => externalSignal.removeEventListener('abort', onAbort);
    })
    : null;

  const requestsWithSignals = requests.map((request) => {
    const composed = composeAbortSignal([controller?.signal, request.signal]);
    signalCleanups.push(composed.cleanup);
    return composed.signal ? { ...request, signal: composed.signal } : { ...request };
  });

  try {
    const generation = operation(requestsWithSignals);
    const racers = [generation];
    if (timeoutPromise) racers.push(timeoutPromise);
    if (abortPromise) racers.push(abortPromise);
    return await Promise.race(racers);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener();
    for (const cleanup of signalCleanups) cleanup();
  }
}

function diagnosticsBase({ roleId, lane, request, runId, startedAt }) {
  return sanitize({
    runId,
    roleId,
    lane,
    requestHash: hashJson({ roleId, lane, request: cleanRequestForDiagnostics(request) }),
    startedAt
  }, 300);
}

export function roleLane(roleId) {
  const id = String(roleId || '').trim();
  if (REASONER_ROLES.has(id)) return 'reasoner';
  if (UTILITY_ROLES.has(id)) return 'utility';
  return 'utility';
}

export function parseStructuredOutput(text) {
  return parseJsonObject(text);
}

function parseProviderStructuredOutput(text) {
  try {
    return parseStructuredOutput(text);
  } catch (error) {
    if (error?.code === 'RECURSION_JSON_PARSE_FAILED' || error?.code === 'RECURSION_JSON_OBJECT_REQUIRED') {
      throw providerError(error.code, 'Provider output was not a valid JSON object.', { retryable: false, cause: error });
    }
    throw error;
  }
}

export function createProviderClient({ host = null, settingsStore = null, fetchImpl = globalThis.fetch } = {}) {
  function enrich(roleId, request = {}) {
    const resolvedRoleId = String(roleId || '').trim();
    if (!resolvedRoleId) {
      throw providerError('RECURSION_PROVIDER_ROLE_MISSING', 'Provider request is missing roleId.', { retryable: false });
    }

    const lane = laneName(requestLane(resolvedRoleId, request));
    const { settings, config } = providerConfigFor(settingsStore, lane);
    if (lane === 'reasoner' && !shouldAllowReasoner(settings, config)) {
      throw providerError('RECURSION_REASONER_DISABLED', 'Reasoner provider lane is disabled.', { retryable: false });
    }

    return {
      ...request,
      roleId: resolvedRoleId,
      lane,
      providerSource: sourceName(config.source),
      providerConfig: cloneJson(config)
    };
  }

  async function generate(roleId, request = {}) {
    const enriched = enrich(roleId, request);
    const source = enriched.providerSource;

    if (HOST_SOURCES.has(source)) {
      if (typeof host?.generation?.generate !== 'function') {
        throw providerError('RECURSION_HOST_GENERATION_UNAVAILABLE', 'Host generation API is unavailable.', {
          retryable: false
        });
      }
      const response = await host.generation.generate(enriched);
      return normalizeProviderResponse(response, enriched);
    }

    if (source !== 'openai-compatible') {
      throw providerError('RECURSION_PROVIDER_SOURCE_UNSUPPORTED', `Unsupported provider source: ${source}`, {
        retryable: false
      });
    }

    if (typeof fetchImpl !== 'function') {
      throw providerError('RECURSION_PROVIDER_FETCH_UNAVAILABLE', 'Fetch is unavailable for OpenAI-compatible provider calls.', {
        retryable: false
      });
    }

    const apiKey = settingsStore?.getApiKey?.(enriched.lane) || '';
    if (!apiKey) {
      throw providerError('RECURSION_PROVIDER_KEY_MISSING', 'OpenAI-compatible provider key is missing for this session.', {
        retryable: false
      });
    }

    const model = String(enriched.providerConfig?.openAICompatible?.model || '').trim();
    if (!model) {
      throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible model is required.', { retryable: false });
    }

    const body = {
      model,
      messages: chatMessages(enriched),
      temperature: enriched.providerConfig.temperature,
      top_p: enriched.providerConfig.topP,
      max_tokens: enriched.providerConfig.maxTokens,
      response_format: { type: 'json_object' },
      stream: false
    };

    let response;
    try {
      const endpoint = openAiEndpoint(enriched.providerConfig?.openAICompatible?.baseUrl);
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: enriched.signal
      });
    } catch (error) {
      if (error?.code === 'RECURSION_PROVIDER_CONFIG_INVALID') throw error;
      if (error?.name === 'AbortError') throw abortError();
      throw providerError('RECURSION_PROVIDER_TRANSPORT_FAILED', 'Provider transport failed.', {
        retryable: true,
        cause: error
      });
    }

    if (!response?.ok) {
      const status = Number(response?.status || 0);
      throw providerError('RECURSION_PROVIDER_HTTP_ERROR', `Provider request failed with HTTP ${status || 'error'}.`, {
        retryable: status === 429 || (status >= 500 && status < 600),
        status
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw providerError('RECURSION_PROVIDER_RESPONSE_JSON_INVALID', 'Provider response was not valid JSON.', {
        retryable: false,
        cause: error
      });
    }
    return normalizeProviderResponse({
      text: parseOpenAiText(payload),
      providerId: 'openai-compatible',
      model: payload?.model || model,
      responseId: payload?.id || ''
    }, enriched);
  }

  async function batch(requests = []) {
    const normalized = requests.map((entry) => normalizeBatchRequest(entry));
    const enriched = normalized.map(({ roleId, request }) => enrich(roleId, request));
    const canUseHostBatch = typeof host?.generation?.batch === 'function'
      && enriched.every((request) => HOST_SOURCES.has(request.providerSource));

    if (canUseHostBatch) {
      const responses = await host.generation.batch(enriched);
      if (!Array.isArray(responses) || responses.length !== enriched.length) {
        throw providerError('RECURSION_PROVIDER_BATCH_INVALID', 'Host batch response shape did not match request batch.', {
          retryable: false
        });
      }
      return responses.map((response, index) => normalizeProviderResponse(response, enriched[index]));
    }

    return Promise.all(normalized.map(({ roleId, request }) => generate(roleId, request)));
  }

  return { generate, batch };
}

export function createGenerationRouter({ client, activity = null, journal = null, timeoutMs = 45000, isCurrent = null } = {}) {
  if (!client || typeof client.generate !== 'function') {
    throw new Error('createGenerationRouter requires a client with generate(roleId, request).');
  }

  let journalQueue = Promise.resolve();
  function queueJournalAppend(entry) {
    const write = journalQueue.then(() => journalAppend(journal, entry));
    journalQueue = write.catch(() => {});
    return write;
  }

  function retryFreshnessGuard(options = {}) {
    return options.isRetryCurrent || options.isCurrent || isCurrent;
  }

  async function checkRetryFreshness(context, options = {}, signals = []) {
    if (signals.some((signal) => signal?.aborted === true)) {
      return { ok: false, reason: 'aborted' };
    }
    const guard = retryFreshnessGuard(options);
    if (typeof guard !== 'function') return { ok: true };
    try {
      const current = await guard(sanitize(context, 300));
      if (current === false) return { ok: false, reason: 'stale-current-guard' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'current-guard-failed' };
    }
  }

  async function generate(roleId, request = {}, options = {}) {
    const lane = laneName(requestLane(roleId, request));
    const started = Date.now();
    const startedAt = nowIso();
    let runId = String(options.runId || request.runId || makeId('provider'));
    let retryCount = 0;
    let lastDiagnostics = diagnosticsBase({ roleId, lane, request, runId, startedAt });

    runId = activityStart(activity, {
      runId,
      phase: 'providerCallStarted',
      mode: 'background',
      severity: 'info',
      providerLane: lane,
      composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
      label: `${lane === 'reasoner' ? 'Reasoner' : 'Utility'} provider call started.`,
      detail: lastDiagnostics
    }) || runId;
    lastDiagnostics = diagnosticsBase({ roleId, lane, request, runId, startedAt });
    queueJournalAppend({
      ...lastDiagnostics,
      status: 'started',
      recordedAt: nowIso()
    });

    const composedExternalSignal = composeAbortSignal([options.signal, request.signal]);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        activityStage(activity, {
          runId,
          phase: attempt === 0 ? 'providerCallRunning' : 'providerCallRetrying',
          severity: attempt === 0 ? 'info' : 'warning',
          providerLane: lane,
          composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
          label: attempt === 0 ? 'Provider call running.' : 'Retrying provider call.',
          detail: { roleId, lane, attempt }
        });

        try {
          const raw = await withTimeout(
            (requestWithSignal) => client.generate(roleId, requestWithSignal),
            request,
            options.timeoutMs ?? timeoutMs,
            composedExternalSignal.signal || null
          );
          const data = parseProviderStructuredOutput(raw.text);
          const latencyMs = Date.now() - started;
          const diagnostics = sanitize({
            ...lastDiagnostics,
            providerSource: raw.providerSource,
            providerId: raw.providerId,
            model: raw.model,
            responseId: raw.responseId,
            responseHash: responseTextHash(raw.text),
            schema: data.schema,
            retryCount,
            latencyMs,
            completedAt: nowIso()
          }, 300);

          await queueJournalAppend({
            ...diagnostics,
            status: 'success',
            recordedAt: nowIso()
          });
          activitySettle(activity, {
            runId,
            phase: 'settled',
            outcome: 'success',
            providerLane: lane,
            composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
            label: 'Provider call completed.',
            detail: diagnostics
          });

          return {
            ok: true,
            roleId,
            lane,
            data,
            text: String(raw.text ?? ''),
            diagnostics
          };
        } catch (error) {
          const canRetry = attempt === 0 && retryableError(error);
          let retrySkippedReason = '';
          const latencyMs = Date.now() - started;
          if (canRetry) {
            const retryFreshness = await checkRetryFreshness({
              roleId,
              lane,
              runId,
              attempt: attempt + 1,
              batch: false,
              retryCount: retryCount + 1,
              error: sanitizedError(error, request),
              request: cleanRequestForDiagnostics(request)
            }, options, [options.signal, request.signal]);
            if (retryFreshness.ok) {
              retryCount = 1;
              continue;
            }
            retrySkippedReason = retryFreshness.reason;
          }
          lastDiagnostics = sanitize({
            ...lastDiagnostics,
            retryCount,
            latencyMs,
            error: sanitizedError(error, request),
            failedAt: nowIso(),
            ...(retrySkippedReason ? { retrySkippedReason } : {})
          }, 300);

          const safeError = sanitizedError(error, request);
          const diagnostics = sanitize({
            ...lastDiagnostics,
            retryCount,
            error: safeError,
            status: statusForError(error)
          }, 300);
          await queueJournalAppend({
            ...diagnostics,
            status: statusForError(error),
            recordedAt: nowIso()
          });
          activitySettle(activity, {
            runId,
            phase: 'settled',
            outcome: 'error',
            providerLane: lane,
            composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
            label: 'Provider call failed.',
            detail: diagnostics
          });

          return {
            ok: false,
            roleId,
            lane,
            error: safeError,
            diagnostics
          };
        }
      }
    } finally {
      composedExternalSignal.cleanup();
    }

    return {
      ok: false,
      roleId,
      lane,
      error: { code: 'RECURSION_PROVIDER_FAILED', message: 'Provider generation failed.', retryable: false },
      diagnostics: lastDiagnostics
    };
  }

  async function batch(requests = [], options = {}) {
    if (typeof client.batch !== 'function') {
      const results = [];
      for (const entry of requests) {
        const { roleId, request } = normalizeBatchRequest(entry);
        results.push(await generate(roleId, request, options));
      }
      return results;
    }

    const batchRunId = String(options.runId || makeId('provider-batch'));
    const entries = requests.map((entry, index) => {
      const { roleId, request } = normalizeBatchRequest(entry);
      const lane = laneName(requestLane(roleId, request));
      const started = Date.now();
      const startedAt = nowIso();
      const diagnostics = diagnosticsBase({ roleId, lane, request, runId: batchRunId, startedAt });
      activityStart(activity, {
        runId: batchRunId,
        phase: 'providerCallStarted',
        mode: 'background',
        severity: 'info',
        providerLane: lane,
        composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
        label: `${lane === 'reasoner' ? 'Reasoner' : 'Utility'} provider batch call started.`,
        detail: diagnostics
      });
      return { index, roleId, request, lane, started, startedAt, diagnostics };
    });
    const results = new Array(entries.length);

    async function failureResult(entry, error, retryCount = 0, extraDiagnostics = {}) {
      const safeError = sanitizedError(error, entry.request);
      const diagnostics = sanitize({
        ...entry.diagnostics,
        retryCount,
        latencyMs: Date.now() - entry.started,
        error: safeError,
        status: statusForError(error),
        failedAt: nowIso(),
        ...extraDiagnostics
      }, 300);
      await queueJournalAppend({
        ...diagnostics,
        status: statusForError(error),
        recordedAt: nowIso()
      });
      return {
        ok: false,
        roleId: entry.roleId,
        lane: entry.lane,
        error: safeError,
        diagnostics
      };
    }

    async function successResult(entry, raw, retryCount = 0) {
      const data = parseProviderStructuredOutput(raw?.text);
      const diagnostics = sanitize({
        ...entry.diagnostics,
        providerSource: raw?.providerSource,
        providerId: raw?.providerId,
        model: raw?.model,
        responseId: raw?.responseId,
        responseHash: responseTextHash(raw?.text),
        schema: data.schema,
        retryCount,
        latencyMs: Date.now() - entry.started,
        completedAt: nowIso()
      }, 300);

      await queueJournalAppend({
        ...diagnostics,
        status: 'success',
        recordedAt: nowIso()
      });

      return {
        ok: true,
        roleId: entry.roleId,
        lane: entry.lane,
        data,
        text: String(raw?.text ?? ''),
        diagnostics
      };
    }

    function settleBatchActivity() {
      if (!results.length) return;
      const completed = results.filter(Boolean);
      const failed = completed.filter((entry) => entry.ok === false).length;
      const succeeded = completed.filter((entry) => entry.ok === true).length;
      const outcome = failed === 0 ? 'success' : (succeeded > 0 ? 'warning' : 'error');
      const representative = completed.find((entry) => entry.ok === false) || completed[0];
      activitySettle(activity, {
        runId: batchRunId,
        phase: 'settled',
        outcome,
        providerLane: representative?.lane || null,
        composerLane: representative?.lane === 'reasoner' ? 'reasoner' : 'utility',
        label: failed === 0 ? 'Provider batch call completed.' : 'Provider batch completed with warnings.',
        detail: {
          total: completed.length,
          succeeded,
          failed
        }
      });
    }

    const pendingEntries = [];
    for (const entry of entries) {
      if (entry.request.signal?.aborted) {
        results[entry.index] = await failureResult(entry, abortError());
        continue;
      }
      pendingEntries.push(entry);
      queueJournalAppend({
        ...entry.diagnostics,
        status: 'started',
        recordedAt: nowIso()
      });
      activityStage(activity, {
        runId: batchRunId,
        phase: 'providerCallRunning',
        severity: 'info',
        providerLane: entry.lane,
        composerLane: entry.lane === 'reasoner' ? 'reasoner' : 'utility',
        label: 'Provider batch call running.',
        detail: { roleId: entry.roleId, lane: entry.lane, batchIndex: entry.index }
      });
    }

    if (pendingEntries.length === 0) {
      settleBatchActivity();
      return results;
    }

    let rawResponses;
    let batchRetryCount = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        rawResponses = await withBatchTimeout(
          (requestsWithSignals) => client.batch(requestsWithSignals),
          pendingEntries.map((entry) => ({ roleId: entry.roleId, ...entry.request })),
          options.timeoutMs ?? timeoutMs,
          options.signal || null
        );
        if (!Array.isArray(rawResponses) || rawResponses.length !== pendingEntries.length) {
          throw providerError('RECURSION_PROVIDER_BATCH_INVALID', 'Provider batch response shape did not match request batch.', {
            retryable: false
          });
        }
        break;
      } catch (error) {
        const canRetry = attempt === 0 && retryableError(error);
        let retrySkippedReason = '';
        if (canRetry) {
          const retryFreshness = await checkRetryFreshness({
            runId: batchRunId,
            attempt: attempt + 1,
            batch: true,
            retryCount: batchRetryCount + 1,
            error: sanitizedBatchError(error, pendingEntries),
            entries: pendingEntries.map((entry) => ({
              index: entry.index,
              roleId: entry.roleId,
              lane: entry.lane,
              request: cleanRequestForDiagnostics(entry.request)
            }))
          }, options, [options.signal, ...pendingEntries.map((entry) => entry.request.signal)]);
          if (!retryFreshness.ok) {
            retrySkippedReason = retryFreshness.reason;
          }
        }
        if (canRetry && !retrySkippedReason) {
          batchRetryCount = 1;
          activityStage(activity, {
            runId: batchRunId,
            phase: 'providerCallRetrying',
            severity: 'warning',
            providerLane: pendingEntries[0]?.lane || 'utility',
            composerLane: pendingEntries[0]?.lane === 'reasoner' ? 'reasoner' : 'utility',
            label: 'Retrying provider batch call.',
            detail: { attempt: 1 }
          });
          continue;
        }
        for (const entry of pendingEntries) {
          results[entry.index] = await failureResult(entry, error, batchRetryCount, retrySkippedReason ? { retrySkippedReason } : {});
        }
        settleBatchActivity();
        return results;
      }
    }

    for (let batchIndex = 0; batchIndex < rawResponses.length; batchIndex += 1) {
      const raw = rawResponses[batchIndex];
      const entry = pendingEntries[batchIndex];
      try {
        results[entry.index] = await successResult(entry, raw, batchRetryCount);
      } catch (error) {
        results[entry.index] = await failureResult(entry, error, batchRetryCount);
      }
    }

    settleBatchActivity();
    return results;
  }

  return { generate, batch };
}
