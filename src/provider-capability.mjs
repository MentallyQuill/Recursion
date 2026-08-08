import { hashJson } from './core.mjs';

export const PROVIDER_CAPABILITY_STATES = Object.freeze([
  'unconfigured',
  'uncertified',
  'segmented-ready',
  'fused-ready',
  'unhealthy'
]);

const LANES = new Set(['utility', 'reasoner']);
const REASONING_LEVELS = new Set(['low', 'medium', 'high', 'ultra']);
const OPERATIONS = new Set(['prompt-packet', 'provider-test', 'redirect', 'post-process']);
const CONFIGURATION_REASON_CODES = new Set([
  'provider-profile-missing',
  'provider-profile-unavailable',
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
  const profileId = text(provider.connectionProfileId);
  if (!profileId) {
    return { complete: false, testable: false, reasonCode: 'provider-profile-missing' };
  }
  const profileIds = connectionProfileIds(host);
  if (!profileIds || !profileIds.has(profileId)) {
    return { complete: false, testable: false, reasonCode: 'provider-profile-unavailable' };
  }
  return { complete: true, testable: true, reasonCode: '' };
}

function certificationMatches(provider, configHash) {
  const certification = provider?.certification || {};
  return text(certification.configHash) === configHash;
}

function capabilityState({ configured, certification, hashMatches }) {
  if (!configured) return 'unconfigured';
  if (!hashMatches || certification?.status === 'not-run' || !certification?.status) return 'uncertified';
  if (certification.checks?.singleCard !== 'pass') return 'unhealthy';
  if (certification.checks?.fusedCards === 'pass') return 'fused-ready';
  return 'segmented-ready';
}

function capabilityReasonCode({ lane, state, required, configuration }) {
  if (state === 'unconfigured') return configuration.reasonCode || 'provider-unconfigured';
  if (state === 'uncertified') return `${lane}-uncertified`;
  if (state === 'unhealthy') return `${lane}-unhealthy`;
  if (state === 'fused-ready') return required ? `${lane}-required-fused-ready` : `${lane}-fused-ready`;
  return required ? `${lane}-required-segmented-ready` : `${lane}-segmented-ready`;
}

function laneTitle(lane) {
  return lane === 'reasoner' ? 'Reasoner' : 'Utility';
}

function capabilityMessage({ lane, state, required, configuration }) {
  const title = laneTitle(lane);
  if (state === 'fused-ready') return required ? `${title} is Fused-ready and required for this operation.` : `${title} is Fused-ready.`;
  if (state === 'segmented-ready') return required ? `${title} is Segmented-ready and required for this operation.` : `${title} is Segmented-ready.`;
  if (state === 'uncertified') return `${title} profile is untested.`;
  if (state === 'unhealthy') return `${title} profile has a compatibility issue.`;
  const suffix = configuration.reasonCode === 'provider-profile-unavailable'
    ? 'profile is unavailable.'
    : 'profile is not selected.';
  return `${title} ${suffix}`;
}

export function providerConfigHash(provider = {}) {
  const lane = normalizeLane(provider.lane);
  return hashJson({
    lane,
    connectionProfileId: text(provider.connectionProfileId),
    generationPolicy: {
      presetMode: text(provider.generationPolicy?.presetMode) || 'isolated',
      instructMode: text(provider.generationPolicy?.instructMode) || 'auto',
      samplerMode: text(provider.generationPolicy?.samplerMode) || 'profile',
      structuredOutputMode: text(provider.generationPolicy?.structuredOutputMode) || 'auto'
    },
    samplerOverrides: {
      temperature: finiteNumber(provider.samplerOverrides?.temperature, lane === 'reasoner' ? 0.4 : 0.1),
      topP: finiteNumber(provider.samplerOverrides?.topP, 0.95)
    },
    outputTokenCeiling: Math.max(128, Math.trunc(finiteNumber(provider.outputTokenCeiling, 8192))),
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
  const configHash = providerConfigHash({ ...provider, lane: resolvedLane });
  const configuration = validateProviderRoute(provider, host);
  const certification = provider.certification || { status: 'not-run' };
  const state = capabilityState({
    configured: configuration.complete,
    certification,
    hashMatches: certificationMatches(provider, configHash)
  });
  const reasoningLevel = normalizeReasoningLevel(settings.reasoningLevel);
  const resolvedOperation = normalizeOperation(operation);
  const postProcessLane = reasoningLevel === 'high' || reasoningLevel === 'ultra' ? 'reasoner' : 'utility';
  const required = resolvedOperation === 'post-process'
    ? resolvedLane === postProcessLane
    : resolvedLane === 'reasoner' && resolvedOperation === 'redirect' && reasoningLevel !== 'low';
  const selectedByPolicy = resolvedOperation === 'post-process'
    ? resolvedLane === postProcessLane
    : resolvedLane === 'utility' || reasoningLevel !== 'low';
  const segmentedEligible = configuration.complete && state !== 'unhealthy';
  const fusedEligible = configuration.complete && state === 'fused-ready';
  const eligible = resolvedOperation === 'provider-test'
    ? configuration.testable
    : selectedByPolicy && segmentedEligible;
  const reasonCode = capabilityReasonCode({ lane: resolvedLane, state, required, configuration });

  return Object.freeze({
    lane: resolvedLane,
    state,
    configHash,
    configRevision: Math.max(0, Math.trunc(finiteNumber(provider.configRevision))),
    configured: configuration.complete,
    testable: configuration.testable,
    ready: state === 'segmented-ready' || state === 'fused-ready',
    segmentedEligible,
    fusedEligible,
    completionMode: text(certification.completionMode) || 'unknown',
    structuredOutput: text(certification.structuredOutput) || 'unknown',
    safeConcurrency: 1,
    required,
    selectedByPolicy,
    eligible,
    reasonCode,
    message: capabilityMessage({ lane: resolvedLane, state, required, configuration })
  });
}

export function sanitizeProviderCapability(capability = {}) {
  const lane = normalizeLane(capability.lane);
  const state = PROVIDER_CAPABILITY_STATES.includes(capability.state) ? capability.state : 'unconfigured';
  const required = capability.required === true;
  const configurationReasonCode = CONFIGURATION_REASON_CODES.has(text(capability.reasonCode))
    ? text(capability.reasonCode)
    : 'provider-unconfigured';
  const configuration = { reasonCode: configurationReasonCode };
  const reasonCode = capabilityReasonCode({ lane, state, required, configuration });
  return Object.freeze({
    lane,
    state,
    configHash: text(capability.configHash).slice(0, 16),
    configRevision: Math.max(0, Math.trunc(finiteNumber(capability.configRevision))),
    configured: capability.configured === true,
    testable: capability.testable === true,
    ready: capability.ready === true,
    segmentedEligible: capability.segmentedEligible === true,
    fusedEligible: capability.fusedEligible === true,
    completionMode: ['chat', 'text'].includes(text(capability.completionMode)) ? text(capability.completionMode) : 'unknown',
    structuredOutput: ['native-schema', 'prompt-json'].includes(text(capability.structuredOutput)) ? text(capability.structuredOutput) : 'unknown',
    safeConcurrency: 1,
    required,
    selectedByPolicy: capability.selectedByPolicy === true,
    eligible: capability.eligible === true,
    reasonCode,
    message: capabilityMessage({ lane, state, required, configuration })
  });
}
