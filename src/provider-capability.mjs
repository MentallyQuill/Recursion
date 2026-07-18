import { hashJson } from './core.mjs';

export const PROVIDER_CAPABILITY_STATES = Object.freeze([
  'unconfigured',
  'untested',
  'ready',
  'unhealthy'
]);

const LANES = new Set(['utility', 'reasoner']);
const REASONING_LEVELS = new Set(['low', 'medium', 'high', 'ultra']);
const HEALTH_STATES = new Set(['pass', 'fail']);
const OPERATIONS = new Set(['prompt-packet', 'provider-test', 'redirect']);
const CONFIGURATION_REASON_CODES = new Set([
  'provider-current-model-unavailable',
  'provider-profile-missing',
  'provider-profile-unavailable',
  'provider-base-url-missing',
  'provider-model-missing',
  'provider-session-key-missing',
  'provider-source-unsupported',
  'provider-unconfigured'
]);

function text(value) {
  return String(value ?? '').trim();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeLane(value) {
  const lane = text(value) || 'utility';
  if (!LANES.has(lane)) throw new Error(`Invalid provider lane: ${lane}`);
  return lane;
}

function normalizeOperation(value) {
  const operation = text(value) || 'prompt-packet';
  if (!OPERATIONS.has(operation)) throw new Error(`Invalid provider operation: ${operation}`);
  return operation;
}

function normalizeReasoningLevel(value) {
  const level = text(value).toLowerCase();
  return REASONING_LEVELS.has(level) ? level : 'medium';
}

function connectionProfileIds(host = {}) {
  const entries = Array.isArray(host.connectionProfiles)
    ? host.connectionProfiles
    : Array.isArray(host.availableConnectionProfiles)
      ? host.availableConnectionProfiles
      : null;
  if (!entries) return null;
  return new Set(entries
    .map((entry) => text(typeof entry === 'string' ? entry : entry?.id))
    .filter(Boolean));
}

function validateProviderRoute(provider = {}, host = {}) {
  const source = text(provider.source) || 'host-current-model';

  if (source === 'host-current-model') {
    const available = host.currentModelAvailable !== false;
    return {
      complete: available,
      testable: available,
      reasonCode: available ? '' : 'provider-current-model-unavailable'
    };
  }

  if (source === 'host-connection-profile') {
    const profileId = text(provider.hostConnectionProfileId);
    if (!profileId) {
      return {
        complete: false,
        testable: false,
        reasonCode: 'provider-profile-missing'
      };
    }
    const profileIds = connectionProfileIds(host);
    if (!profileIds || !profileIds.has(profileId)) {
      return {
        complete: false,
        testable: false,
        reasonCode: 'provider-profile-unavailable'
      };
    }
    return { complete: true, testable: true, reasonCode: '' };
  }

  if (source === 'openai-compatible') {
    const direct = provider.openAICompatible || {};
    if (!text(direct.baseUrl)) {
      return {
        complete: false,
        testable: false,
        reasonCode: 'provider-base-url-missing'
      };
    }
    if (!text(direct.model)) {
      return {
        complete: false,
        testable: false,
        reasonCode: 'provider-model-missing'
      };
    }
    if (direct.sessionApiKeyPresent !== true) {
      return {
        complete: false,
        testable: false,
        reasonCode: 'provider-session-key-missing'
      };
    }
    return { complete: true, testable: true, reasonCode: '' };
  }

  return {
    complete: false,
    testable: false,
    reasonCode: 'provider-source-unsupported'
  };
}

function capabilityReasonCode({ lane, state, required, configuration }) {
  if (state === 'unconfigured') return configuration.reasonCode || 'provider-unconfigured';
  if (state === 'untested') return `${lane}-untested`;
  if (state === 'unhealthy') return `${lane}-unhealthy`;
  if (required) return `${lane}-required-ready`;
  return `${lane}-ready`;
}

function laneTitle(lane) {
  return lane === 'reasoner' ? 'Reasoner' : 'Utility';
}

function capabilityMessage({ lane, state, required, configuration }) {
  const title = laneTitle(lane);
  if (state === 'ready') {
    return required ? `${title} is ready and required for Redirect.` : `${title} is ready.`;
  }
  if (state === 'untested') return `${title} is untested.`;
  if (state === 'unhealthy') return `${title} is unhealthy.`;

  const suffix = {
    'provider-current-model-unavailable': 'current model is unavailable.',
    'provider-profile-missing': 'profile is not selected.',
    'provider-profile-unavailable': 'profile is unavailable.',
    'provider-base-url-missing': 'base URL is missing.',
    'provider-model-missing': 'model is missing.',
    'provider-session-key-missing': 'session API key is missing.',
    'provider-source-unsupported': 'source is unsupported.'
  }[configuration.reasonCode] || 'configuration is incomplete.';
  return `${title} ${suffix}`;
}

export function providerConfigHash(provider = {}) {
  return hashJson({
    lane: normalizeLane(provider.lane),
    source: text(provider.source) || 'host-current-model',
    hostConnectionProfileId: text(provider.hostConnectionProfileId),
    openAICompatible: {
      baseUrl: text(provider.openAICompatible?.baseUrl),
      model: text(provider.openAICompatible?.model),
      sessionApiKeyPresent: provider.openAICompatible?.sessionApiKeyPresent === true
    },
    temperature: finiteNumber(provider.temperature),
    topP: finiteNumber(provider.topP),
    maxTokens: finiteNumber(provider.maxTokens),
    configRevision: Math.max(0, Math.trunc(finiteNumber(provider.configRevision)))
  });
}

export function resolveProviderCapability({
  settings = {},
  lane = 'utility',
  operation = 'prompt-packet',
  host = {}
} = {}) {
  const resolvedLane = normalizeLane(lane);
  const provider = settings.providers?.[resolvedLane] || {};
  const configHash = providerConfigHash({
    ...provider,
    lane: resolvedLane
  });
  const configuration = validateProviderRoute(provider, host);
  const health = provider.health || {};
  const healthMatches = text(health.configHash) === configHash;
  const state = !configuration.complete
    ? 'unconfigured'
    : !healthMatches || !HEALTH_STATES.has(text(health.status))
      ? 'untested'
      : health.status === 'pass'
        ? 'ready'
        : 'unhealthy';
  const reasoningLevel = normalizeReasoningLevel(settings.reasoningLevel);
  const resolvedOperation = normalizeOperation(operation);
  const required = resolvedLane === 'reasoner'
    && resolvedOperation === 'redirect'
    && reasoningLevel !== 'low';
  const selectedByPolicy = resolvedLane === 'utility' || reasoningLevel !== 'low';
  const eligible = resolvedOperation === 'provider-test'
    ? configuration.testable
    : selectedByPolicy && state === 'ready';
  const reasonCode = capabilityReasonCode({
    lane: resolvedLane,
    state,
    required,
    configuration
  });

  return Object.freeze({
    lane: resolvedLane,
    state,
    configHash,
    configRevision: Math.max(0, Math.trunc(finiteNumber(provider.configRevision))),
    configured: configuration.complete,
    testable: configuration.testable,
    ready: state === 'ready',
    required,
    selectedByPolicy,
    eligible,
    reasonCode,
    message: capabilityMessage({
      lane: resolvedLane,
      state,
      required,
      configuration
    })
  });
}

export function sanitizeProviderCapability(capability = {}) {
  const lane = normalizeLane(capability.lane);
  const state = PROVIDER_CAPABILITY_STATES.includes(capability.state)
    ? capability.state
    : 'unconfigured';
  const required = capability.required === true;
  const configurationReasonCode = CONFIGURATION_REASON_CODES.has(text(capability.reasonCode))
    ? text(capability.reasonCode)
    : 'provider-unconfigured';
  const configuration = { reasonCode: configurationReasonCode };
  const reasonCode = capabilityReasonCode({
    lane,
    state,
    required,
    configuration
  });
  return Object.freeze({
    lane,
    state,
    configHash: text(capability.configHash).slice(0, 16),
    configRevision: Math.max(0, Math.trunc(finiteNumber(capability.configRevision))),
    configured: capability.configured === true,
    testable: capability.testable === true,
    ready: capability.ready === true,
    required,
    selectedByPolicy: capability.selectedByPolicy === true,
    eligible: capability.eligible === true,
    reasonCode,
    message: capabilityMessage({
      lane,
      state,
      required,
      configuration
    })
  });
}
