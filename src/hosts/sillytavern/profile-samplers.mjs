export const SAFE_PROFILE_SAMPLER_FIELDS = Object.freeze([
  'temperature', 'top_p', 'top_k', 'min_p', 'top_a', 'typical_p', 'tfs',
  'repetition_penalty', 'rep_pen', 'rep_pen_range', 'rep_pen_slope',
  'frequency_penalty', 'presence_penalty', 'penalty_alpha',
  'no_repeat_ngram_size', 'encoder_repetition_penalty',
  'seed', 'do_sample', 'num_beams',
  'mirostat_mode', 'mirostat_tau', 'mirostat_eta',
  'smoothing_factor', 'smoothing_curve',
  'dynatemp_range', 'dynatemp_exponent',
  'dry_multiplier', 'dry_base', 'dry_allowed_length', 'dry_sequence_breakers',
  'xtc_threshold', 'xtc_probability', 'sampler_priority', 'samplers'
]);

function cloneSamplerValue(value) {
  if (typeof value === 'string') return value.slice(0, 400);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 64)
      .map(cloneSamplerValue)
      .filter((entry) => entry !== undefined);
  }
  return undefined;
}

export function pickSafeSamplerPayload(payload = {}) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return Object.fromEntries(SAFE_PROFILE_SAMPLER_FIELDS.flatMap((field) => {
    if (!Object.hasOwn(source, field)) return [];
    const value = cloneSamplerValue(source[field]);
    return value === undefined ? [] : [[field, value]];
  }));
}

function profilePresetError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

export async function projectProfileSamplerPayload({ context = {}, profile = {}, apiMap = {} } = {}) {
  const completionService = apiMap?.selected === 'openai'
    ? context?.ChatCompletionService
    : context?.TextCompletionService;
  if (typeof completionService?.presetToGeneratePayload !== 'function'
      || typeof completionService?.TYPE !== 'string') {
    throw profilePresetError(
      'RECURSION_PROFILE_PRESET_API_UNAVAILABLE',
      'SillyTavern preset materialization is unavailable.'
    );
  }
  const presetManager = context?.getPresetManager?.(completionService.TYPE);
  const preset = presetManager?.getCompletionPresetByName?.(profile?.preset);
  if (!preset) {
    throw profilePresetError(
      'RECURSION_PROFILE_PRESET_UNAVAILABLE',
      'Connection Profile generation preset was not found.'
    );
  }
  const basePayload = apiMap?.selected === 'openai'
    ? { model: profile?.model, messages: [], chat_completion_source: apiMap?.source }
    : { model: profile?.model, prompt: '', api_type: apiMap?.type };
  const payload = await completionService.presetToGeneratePayload(preset, {}, basePayload);
  return pickSafeSamplerPayload(payload);
}
