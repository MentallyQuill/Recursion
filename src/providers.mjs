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
  'sceneConstraintsCard',
  'knowledgeSecretsCard',
  'clocksConsequencesCard',
  'environmentAffordancesCard',
  'possessionsItemsCard',
  'openThreadsCard',
  'briefUtilityComposer',
  'providerTest'
]);
export const REASONER_ROLE_IDS = Object.freeze(['reasonerComposer']);
export const PROVIDER_CONTRACT_VERSION = 2;
const ROLE_RESPONSE_SCHEMAS = Object.freeze({
  utilityArbiter: 'recursion.utilityArbiter.v1',
  sceneFrameCard: 'recursion.card.v1',
  activeCastCard: 'recursion.card.v1',
  characterMotivationCard: 'recursion.card.v1',
  dialogueRelationshipCard: 'recursion.card.v1',
  sceneConstraintsCard: 'recursion.card.v1',
  knowledgeSecretsCard: 'recursion.card.v1',
  clocksConsequencesCard: 'recursion.card.v1',
  environmentAffordancesCard: 'recursion.card.v1',
  possessionsItemsCard: 'recursion.card.v1',
  openThreadsCard: 'recursion.card.v1',
  briefUtilityComposer: 'recursion.briefUtilityComposer.v1',
  reasonerComposer: 'recursion.reasonerComposer.v1',
  providerTest: 'recursion.providerTest.v1'
});
export const PROVIDER_CONTRACT_HASH = hashJson({
  providerContractVersion: PROVIDER_CONTRACT_VERSION,
  utilityRoles: UTILITY_ROLE_IDS,
  reasonerRoles: REASONER_ROLE_IDS,
  responseSchemas: ROLE_RESPONSE_SCHEMAS
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

function markOpenAiAuthFailure(settingsStore, lane) {
  try {
    if (typeof settingsStore?.clearApiKey === 'function') settingsStore.clearApiKey(lane);
    if (typeof settingsStore?.updateProvider === 'function') {
      settingsStore.updateProvider(lane, {
        resolvedProviderLabel: '',
        resolvedModelLabel: '',
        lastTest: {
          status: 'fail',
          checkedAt: nowIso(),
          compactError: 'OpenAI-compatible authentication failed.'
        }
      });
    }
  } catch {
    // Provider health metadata is advisory; the provider call still fails with a stable auth error.
  }
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
  return roleLane(roleId) || 'utility';
}

function isProviderRole(roleId) {
  const id = String(roleId || '').trim();
  return UTILITY_ROLES.has(id) || REASONER_ROLES.has(id);
}

function unsupportedRoleError(roleId) {
  const id = String(roleId || '').trim();
  if (!id) {
    return providerError('RECURSION_PROVIDER_ROLE_MISSING', 'Provider request is missing roleId.', { retryable: false });
  }
  return providerError(
    'RECURSION_PROVIDER_ROLE_UNSUPPORTED',
    `Unsupported provider role: ${id}.`,
    { retryable: false }
  );
}

function expectedResponseSchema(roleId) {
  return ROLE_RESPONSE_SCHEMAS[String(roleId || '').trim()] || '';
}

function validateRoleResponseSchema(roleId, data) {
  const expected = expectedResponseSchema(roleId);
  if (!expected) throw unsupportedRoleError(roleId);
  const actual = String(data?.schema || '').trim();
  if (actual !== expected) {
    throw providerError(
      'RECURSION_PROVIDER_SCHEMA_MISMATCH',
      'Provider output schema did not match the requested role.',
      { retryable: false }
    );
  }
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

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function controlOptions(options = {}) {
  const source = plainObject(options) ? options : {};
  return {
    context: source.context ?? null,
    globals: source.globals ?? globalThis
  };
}

function hostContext(globals = globalThis) {
  try {
    return globals?.SillyTavern?.getContext?.() || globals?.getContext?.() || null;
  } catch {
    return null;
  }
}

function connectionProfileService(context = null, globals = globalThis) {
  return context?.ConnectionManagerRequestService
    || globals?.ConnectionManagerRequestService
    || null;
}

function profileId(profile = {}) {
  return textValue(
    profile.id
      || profile.profileId
      || profile.profile_id
      || profile.uuid
      || profile.key
      || profile.name
      || profile.label
  );
}

function profileName(profile = {}, fallback = '') {
  return textValue(
    profile.label
      || profile.name
      || profile.profileName
      || profile.profile_name
      || profile.title
      || profile.displayName,
    fallback
  );
}

const MODEL_KEY_PATTERN = /(^|_|\b)(model|modelid|model_id|modelname|model_name|selectedmodel|selected_model|chatmodel|chat_model|completionmodel|completion_model)$/i;

function modelFromProfile(profile = {}) {
  const seen = new Set();
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return '';
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (child === null || child === undefined) continue;
      if (typeof child !== 'object' && MODEL_KEY_PATTERN.test(String(key).replace(/[^a-z0-9_]/ig, ''))) {
        const model = textValue(child);
        if (model) return model;
      }
    }
    for (const key of ['settings', 'generationSettings', 'generation_settings', 'provider', 'completion', 'chatCompletion', 'chat_completion', 'config', 'data']) {
      const model = visit(value[key], depth + 1);
      if (model) return model;
    }
    return '';
  }
  return visit(profile);
}

function profileLike(value, path = '') {
  if (!plainObject(value)) return false;
  const id = profileId(value);
  if (!id) return false;
  return Boolean(
    /profile|connection/i.test(path)
      || profileName(value)
      || modelFromProfile(value)
      || value.sendRequest
      || value.api
  );
}

function collectProfileCandidates(root, path = '', depth = 0, seen = new Set(), out = []) {
  if (!root || typeof root !== 'object' || seen.has(root) || depth > 6) return out;
  seen.add(root);
  if (Array.isArray(root)) {
    if (root.some((entry) => profileLike(entry, path))) {
      for (const entry of root) {
        if (profileLike(entry, path)) out.push(entry);
      }
    }
    for (const entry of root) collectProfileCandidates(entry, path, depth + 1, seen, out);
    return out;
  }
  if (profileLike(root, path)) out.push(root);
  for (const [key, child] of Object.entries(root)) {
    const childPath = path ? `${path}.${key}` : key;
    if (Array.isArray(child) && /profile|connection/i.test(key)) {
      for (const entry of child) {
        if (profileLike(entry, childPath)) out.push(entry);
      }
    } else if (plainObject(child) && /profile|connection/i.test(key)) {
      for (const entry of Object.values(child)) {
        if (profileLike(entry, childPath)) out.push(entry);
      }
    }
    collectProfileCandidates(child, childPath, depth + 1, seen, out);
  }
  return out;
}

function normalizeConnectionProfile(profile = {}) {
  const id = profileId(profile);
  if (!id) return null;
  const name = profileName(profile, id);
  const model = modelFromProfile(profile);
  return {
    id,
    name,
    model,
    label: model ? `${name} / ${model}` : name,
    raw: profile
  };
}

export function listProviderConnectionProfiles(options = {}) {
  const { globals } = controlOptions(options);
  const context = options?.context ?? hostContext(globals);
  let supportedProfiles = [];
  try {
    const service = connectionProfileService(context, globals);
    const result = service?.getSupportedProfiles?.();
    if (Array.isArray(result)) supportedProfiles = result;
    else if (plainObject(result)) supportedProfiles = Object.values(result);
  } catch {
    supportedProfiles = [];
  }
  const roots = [
    { connectionProfiles: supportedProfiles },
    context,
    context?.ConnectionManagerRequestService,
    globals?.connectionManager,
    globals?.ConnectionManager,
    globals?.extension_settings,
    globals?.power_user
  ];
  const byId = new Map();
  for (const root of roots) {
    for (const candidate of collectProfileCandidates(root)) {
      const normalized = normalizeConnectionProfile(candidate);
      if (normalized && !byId.has(normalized.id)) byId.set(normalized.id, normalized);
    }
  }
  return [...byId.values()];
}

function currentHostModel(options = {}) {
  const { globals } = controlOptions(options);
  const context = options?.context ?? hostContext(globals);
  const roots = [
    context?.chatCompletionSettings,
    context?.completionSettings,
    context?.settings,
    context?.power_user,
    globals?.power_user,
    globals?.oai_settings,
    globals?.nai_settings,
    globals?.textgenerationwebui_settings
  ];
  for (const root of roots) {
    const model = modelFromProfile(root);
    if (model) return model;
  }
  return '';
}

function sourceLabel(source) {
  const normalized = sourceName(source);
  if (normalized === 'host-connection-profile') return 'Host Connection Profile';
  if (normalized === 'openai-compatible') return 'OpenAI-Compatible Endpoint';
  return 'Current Host Model';
}

export function validateProviderConfiguration(provider = {}, options = {}) {
  const source = sourceName(provider.source);
  const missing = [];
  let ready = true;
  let message = 'Ready.';
  if (source === 'host-current-model') {
    if (options.hostGenerationAvailable === false) {
      ready = false;
      missing.push('hostGeneration');
      message = 'Host generation API unavailable.';
    } else {
      message = 'Uses the active SillyTavern model.';
    }
  } else if (source === 'host-connection-profile') {
    const profile = textValue(provider.hostConnectionProfileId);
    const profiles = Array.isArray(options.profiles)
      ? options.profiles
      : listProviderConnectionProfiles(options);
    if (!profile) {
      ready = false;
      missing.push('hostConnectionProfileId');
      message = profiles.length ? 'Select a host connection profile.' : 'No host connection profiles detected.';
    } else if (!profiles.some((entry) => entry.id === profile)) {
      ready = false;
      missing.push('connectionProfile');
      message = profiles.length ? 'Saved profile was not detected.' : 'Connection profile service unavailable.';
    } else {
      message = 'Uses the selected SillyTavern connection profile.';
    }
  } else if (source === 'openai-compatible') {
    const direct = plainObject(provider.openAICompatible) ? provider.openAICompatible : {};
    if (!textValue(direct.baseUrl)) missing.push('baseUrl');
    if (!textValue(direct.model)) missing.push('model');
    if (!textValue(options.apiKey) && direct.sessionApiKeyPresent !== true) missing.push('sessionApiKey');
    ready = missing.length === 0;
    message = ready ? 'Direct endpoint configured for this session.' : `Missing ${missing.join(', ')}.`;
  } else {
    ready = false;
    missing.push('source');
    message = 'Unsupported provider source.';
  }
  return {
    ready,
    missing,
    source,
    sourceLabel: sourceLabel(source),
    message
  };
}

export function providerModelStatus(provider = {}, options = {}) {
  const source = sourceName(provider.source);
  const profiles = Array.isArray(options.profiles) ? options.profiles : listProviderConnectionProfiles(options);
  const validation = validateProviderConfiguration(provider, { ...options, profiles });
  if (source === 'host-connection-profile') {
    const selected = profiles.find((entry) => entry.id === textValue(provider.hostConnectionProfileId));
    return {
      ...validation,
      model: selected?.model || '',
      label: selected?.label || (provider.hostConnectionProfileId ? `${provider.hostConnectionProfileId} (saved)` : sourceLabel(source)),
      profileId: selected?.id || textValue(provider.hostConnectionProfileId),
      profileLabel: selected?.name || ''
    };
  }
  if (source === 'openai-compatible') {
    const model = textValue(provider.openAICompatible?.model);
    return {
      ...validation,
      model,
      label: model ? `OpenAI-Compatible / ${model}` : 'OpenAI-Compatible Endpoint'
    };
  }
  const model = currentHostModel(options);
  return {
    ...validation,
    model,
    label: model ? `Current Host Model / ${model}` : 'Current Host Model'
  };
}

export function providerRouteSummary(settings = {}) {
  const level = String(settings?.reasoningLevel || 'high').toLowerCase();
  const normalizedLevel = ['low', 'medium', 'high', 'ultra'].includes(level) ? level : 'high';
  const reasoner = settings?.providers?.reasoner || {};
  const reasonerHealthy = reasoner.enabled === true && reasoner.lastTest?.status === 'pass';
  const reasonerLabel = reasonerHealthy ? 'Reasoner' : 'Utility fallback';
  const summary = normalizedLevel === 'low'
    ? { arbiter: 'Utility', cards: 'Utility', composer: 'Utility' }
    : normalizedLevel === 'medium'
      ? { arbiter: 'Utility', cards: 'Utility', composer: reasonerLabel }
      : normalizedLevel === 'high'
        ? { arbiter: reasonerLabel, cards: reasonerHealthy ? 'Priority Reasoner, Utility lower priority' : 'Utility fallback', composer: reasonerLabel }
        : { arbiter: reasonerLabel, cards: reasonerLabel, composer: reasonerLabel };
  return {
    level: normalizedLevel,
    reasonerHealthy,
    ...summary,
    text: `Arbiter: ${summary.arbiter}; Cards: ${summary.cards}; Composer: ${summary.composer}`
  };
}

function normalizeOpenAiBaseUrl(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/g, '');
  if (!base) {
    throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible base URL is required.', { retryable: false });
  }
  try {
    const parsed = new URL(base);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
  } catch {
    throw providerError('RECURSION_PROVIDER_CONFIG_INVALID', 'OpenAI-compatible base URL is invalid.', { retryable: false });
  }
  base = base.replace(/\/chat\/completions$/i, '');
  base = base.replace(/\/responses$/i, '');
  base = base.replace(/\/models$/i, '');
  return base.replace(/\/+$/g, '');
}

export function openAiModelsEndpoint(baseUrl) {
  return `${normalizeOpenAiBaseUrl(baseUrl)}/models`;
}

function normalizeModelList(payload = {}) {
  const source = Array.isArray(payload?.data)
    ? payload.data
    : (Array.isArray(payload?.models) ? payload.models : []);
  const byId = new Map();
  for (const entry of source) {
    const id = textValue(typeof entry === 'string' ? entry : (entry?.id || entry?.model || entry?.name));
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      label: textValue(typeof entry === 'string' ? entry : (entry?.name || entry?.label || entry?.id || entry?.model), id)
    });
  }
  return [...byId.values()];
}

export async function fetchOpenAICompatibleModels({
  baseUrl,
  apiKey = '',
  fetchImpl = globalThis.fetch,
  signal = undefined
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw providerError('RECURSION_PROVIDER_FETCH_UNAVAILABLE', 'Fetch is unavailable for OpenAI-compatible model discovery.', {
      retryable: false
    });
  }
  const key = String(apiKey || '').trim();
  if (!key) {
    throw providerError('RECURSION_PROVIDER_KEY_MISSING', 'OpenAI-compatible provider key is missing for model discovery.', {
      retryable: false
    });
  }
  const endpoint = openAiModelsEndpoint(baseUrl);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      credentials: 'omit',
      signal
    });
  } catch (error) {
    if (error?.code === 'RECURSION_PROVIDER_CONFIG_INVALID') throw error;
    if (error?.name === 'AbortError') throw abortError();
    throw providerError('RECURSION_PROVIDER_TRANSPORT_FAILED', 'Provider model discovery transport failed.', {
      retryable: true,
      cause: error
    });
  }
  if (!response?.ok) {
    const status = Number(response?.status || 0);
    throw providerError('RECURSION_PROVIDER_HTTP_ERROR', `Provider model discovery failed with HTTP ${status || 'error'}.`, {
      retryable: status === 429 || (status >= 500 && status < 600),
      status
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw providerError('RECURSION_PROVIDER_RESPONSE_JSON_INVALID', 'Provider model discovery response was not valid JSON.', {
      retryable: false,
      cause: error
    });
  }
  return {
    ok: true,
    endpoint,
    models: normalizeModelList(payload)
  };
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

function diagnosticsTimeout(timeoutMs) {
  const number = Number(timeoutMs);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function diagnosticsSnapshotHash(request = {}) {
  const snapshotHash = compact(String(request.snapshotHash || ''));
  return snapshotHash ? truncate(snapshotHash, 180) : undefined;
}

function diagnosticsBase({ roleId, lane, request, runId, startedAt, timeoutMs }) {
  const snapshotHash = diagnosticsSnapshotHash(request);
  return sanitize({
    runId,
    roleId,
    lane,
    timeoutMs: diagnosticsTimeout(timeoutMs),
    ...(snapshotHash ? { snapshotHash } : {}),
    requestHash: hashJson({ roleId, lane, request: cleanRequestForDiagnostics(request) }),
    startedAt
  }, 300);
}

export function roleLane(roleId) {
  const id = String(roleId || '').trim();
  if (REASONER_ROLES.has(id)) return 'reasoner';
  if (UTILITY_ROLES.has(id)) return 'utility';
  return '';
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
    if (!isProviderRole(resolvedRoleId)) {
      throw unsupportedRoleError(resolvedRoleId);
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
      if (status === 401 || status === 403) {
        markOpenAiAuthFailure(settingsStore, enriched.lane);
        throw providerError('RECURSION_PROVIDER_AUTH_FAILED', 'OpenAI-compatible authentication failed.', {
          retryable: false,
          status
        });
      }
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

  function listProfiles(options = {}) {
    return listProviderConnectionProfiles(options);
  }

  function status(lane = 'utility', options = {}) {
    const resolvedLane = laneName(lane);
    const { config } = providerConfigFor(settingsStore, resolvedLane);
    return providerModelStatus(config, {
      ...options,
      apiKey: settingsStore?.getApiKey?.(resolvedLane) || options.apiKey || ''
    });
  }

  async function fetchModels(lane = 'utility', patch = {}) {
    const resolvedLane = laneName(lane);
    const { config } = providerConfigFor(settingsStore, resolvedLane);
    const cleanPatch = plainObject(patch) ? patch : {};
    const provider = {
      ...config,
      ...cleanPatch,
      openAICompatible: {
        ...(config.openAICompatible || {}),
        ...(plainObject(cleanPatch.openAICompatible) ? cleanPatch.openAICompatible : {})
      }
    };
    if (sourceName(provider.source) !== 'openai-compatible') {
      throw providerError(
        'RECURSION_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED',
        'Model discovery is only available for OpenAI-compatible endpoints.',
        { retryable: false }
      );
    }
    return fetchOpenAICompatibleModels({
      baseUrl: provider.openAICompatible?.baseUrl,
      apiKey: cleanPatch.apiKey || settingsStore?.getApiKey?.(resolvedLane) || '',
      fetchImpl,
      signal: cleanPatch.signal
    });
  }

  return { generate, batch, listProfiles, status, fetchModels };
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
    const providerRoleKnown = isProviderRole(roleId);
    const lane = laneName(requestLane(roleId, request));
    const started = Date.now();
    const startedAt = nowIso();
    const effectiveTimeoutMs = options.timeoutMs ?? timeoutMs;
    let runId = String(options.runId || request.runId || makeId('provider'));
    let retryCount = 0;
    let lastDiagnostics = diagnosticsBase({ roleId, lane, request, runId, startedAt, timeoutMs: effectiveTimeoutMs });

    const activityRunId = activityStart(activity, {
      runId,
      phase: 'providerCallStarted',
      mode: 'background',
      severity: 'info',
      providerLane: lane,
      composerLane: lane === 'reasoner' ? 'reasoner' : 'utility',
      label: `${lane === 'reasoner' ? 'Reasoner' : 'Utility'} provider call started.`,
      detail: lastDiagnostics
    });
    if (options.lockRunId !== true) runId = activityRunId || runId;
    lastDiagnostics = diagnosticsBase({ roleId, lane, request, runId, startedAt, timeoutMs: effectiveTimeoutMs });
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
          if (!providerRoleKnown) throw unsupportedRoleError(roleId);
          const raw = await withTimeout(
            (requestWithSignal) => client.generate(roleId, requestWithSignal),
            request,
            effectiveTimeoutMs,
            composedExternalSignal.signal || null
          );
          const data = parseProviderStructuredOutput(raw.text);
          validateRoleResponseSchema(roleId, data);
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
    const rawRequests = Array.isArray(requests) ? requests : [];
    const batchRunId = String(options.runId || makeId('provider-batch'));
    const effectiveTimeoutMs = options.timeoutMs ?? timeoutMs;
    const results = new Array(rawRequests.length);

    function fallbackBatchRequest(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { roleId: '', request: {} };
      const request = { ...entry };
      const roleId = String(request.roleId || request.role || '').trim();
      delete request.roleId;
      delete request.role;
      return { roleId, request };
    }

    function makeBatchEntry(entry, index) {
      let roleId = '';
      let request = {};
      let normalizationError = null;
      try {
        ({ roleId, request } = normalizeBatchRequest(entry));
      } catch (error) {
        normalizationError = error;
        ({ roleId, request } = fallbackBatchRequest(entry));
      }
      const lane = laneName(requestLane(roleId, request));
      const started = Date.now();
      const startedAt = nowIso();
      const diagnostics = diagnosticsBase({ roleId, lane, request, runId: batchRunId, startedAt, timeoutMs: effectiveTimeoutMs });
      return {
        index,
        roleId,
        request,
        lane,
        started,
        startedAt,
        diagnostics,
        providerRoleKnown: isProviderRole(roleId),
        normalizationError
      };
    }

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

    if (typeof client.batch !== 'function') {
      const entries = rawRequests.map(makeBatchEntry);
      for (const entry of entries) {
        if (entry.normalizationError) {
          results[entry.index] = await failureResult(entry, entry.normalizationError);
          continue;
        }
        results[entry.index] = await generate(entry.roleId, entry.request, {
          ...options,
          runId: batchRunId,
          lockRunId: true
        });
      }
      return results;
    }

    const entries = rawRequests.map((entry, index) => {
      const batchEntry = makeBatchEntry(entry, index);
      activityStart(activity, {
        runId: batchRunId,
        phase: 'providerCallStarted',
        mode: 'background',
        severity: 'info',
        providerLane: batchEntry.lane,
        composerLane: batchEntry.lane === 'reasoner' ? 'reasoner' : 'utility',
        label: `${batchEntry.lane === 'reasoner' ? 'Reasoner' : 'Utility'} provider batch call started.`,
        detail: batchEntry.diagnostics
      });
      return batchEntry;
    });

    async function successResult(entry, raw, retryCount = 0) {
      const data = parseProviderStructuredOutput(raw?.text);
      validateRoleResponseSchema(entry.roleId, data);
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
      if (entry.normalizationError) {
        results[entry.index] = await failureResult(entry, entry.normalizationError);
        continue;
      }
      if (!entry.providerRoleKnown) {
        results[entry.index] = await failureResult(entry, unsupportedRoleError(entry.roleId));
        continue;
      }
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
          effectiveTimeoutMs,
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
