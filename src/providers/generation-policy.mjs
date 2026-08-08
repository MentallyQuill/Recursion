const PRESET_MODES = new Set(['isolated', 'full-profile']);
const INSTRUCT_MODES = new Set(['auto', 'on', 'off']);
const SAMPLER_MODES = new Set(['profile', 'recursion']);
const STRUCTURED_MODES = new Set(['auto', 'native-schema', 'prompt-json']);
const REQUEST_STRUCTURED_MODES = new Set(['native-schema', 'prompt-json']);

function enumOr(value, allowed, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

export function resolveGenerationPolicy({ provider = {}, completionMode = 'unknown', request = {} } = {}) {
  const configured = provider?.generationPolicy || {};
  const presetMode = enumOr(configured.presetMode, PRESET_MODES, 'isolated');
  const instructMode = enumOr(configured.instructMode, INSTRUCT_MODES, 'auto');
  const samplerMode = enumOr(configured.samplerMode, SAMPLER_MODES, 'profile');
  const configuredStructured = enumOr(configured.structuredOutputMode, STRUCTURED_MODES, 'auto');
  const certifiedStructured = provider?.certification?.structuredOutput === 'native-schema'
    ? 'native-schema'
    : 'prompt-json';
  const requestStructured = enumOr(request?.structuredOutputMethod, REQUEST_STRUCTURED_MODES, '');
  return Object.freeze({
    includePreset: presetMode === 'full-profile',
    includeInstruct: instructMode === 'on'
      || (instructMode === 'auto' && completionMode === 'text'),
    samplerMode,
    structuredOutputMethod: requestStructured
      || (configuredStructured === 'auto' ? certifiedStructured : configuredStructured)
  });
}
