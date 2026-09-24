import { hashJson } from '../../core.mjs';
import { completionModeFromApiMap, requireConnectionManagerService } from './provider-profiles.mjs';
import { pickSafeSamplerPayload } from './profile-samplers.mjs';
import { profileSecretOverride } from './profile-secrets.mjs';

const error = (code, message) => Object.assign(new Error(message), { code, retryable: false });
const changed = () => error('RECURSION_POST_PROCESS_WRITER_CHANGED', 'The selected writer configuration changed. Start a new revision.');
const clone = value => JSON.parse(JSON.stringify(value));
function inspect(context, id) {
  const service = requireConnectionManagerService(context);
  const profile = service.getProfile(id);
  if (!profile) throw error('RECURSION_PROFILE_UNAVAILABLE', 'Select an available Post-process writer profile.');
  const apiMap = service.validateProfile(profile) || {};
  const mode = completionModeFromApiMap(apiMap);
  if (mode === 'unknown' || !String(profile.model || '').trim()) throw error('RECURSION_PROFILE_UNAVAILABLE', 'The selected writer profile is unsupported or has no model.');
  const completion = mode === 'chat' ? context.ChatCompletionService : context.TextCompletionService;
  const preset = context.getPresetManager?.(completion?.TYPE)?.getCompletionPresetByName?.(profile.preset);
  if (!preset || (mode === 'chat' && typeof completion?.presetToGeneratePayload !== 'function')) throw error('RECURSION_PROFILE_PRESET_UNAVAILABLE', 'The selected writer generation preset is unavailable.');
  const instruct = mode === 'text' && profile.instruct
    ? context.getPresetManager?.('instruct')?.getCompletionPresetByName?.(profile.instruct) : null;
  if (mode === 'text' && profile.instruct && !instruct) throw error('RECURSION_PROFILE_PRESET_UNAVAILABLE', 'The selected writer instruct preset is unavailable.');
  return { service, completion, mode, profile: clone(profile), apiMap: clone(apiMap), preset: clone(preset), instruct: clone(instruct) };
}
function sourceHash(value) {
  return hashJson({ profile: value.profile, apiMap: value.apiMap, preset: value.preset, instruct: value.instruct });
}
// The installed text materializer always seeds settings.type from the active
// connection and cannot override it. Project only saved fields using the selected
// backend's public request mappings; never touch global host settings.
function projectTextWriterSamplers(preset, backend, samplerMode) {
  const payload = pickSafeSamplerPayload(preset);
  const copy = (target, source) => {
    if (!Object.hasOwn(preset, source)) return;
    const value = preset[source];
    if (typeof value === 'number' && Number.isFinite(value)) payload[target] = value;
  };
  copy('temperature', 'temp');
  copy('repetition_penalty', 'rep_pen');
  copy('frequency_penalty', 'freq_pen');
  copy('presence_penalty', 'presence_pen');
  if (backend === 'ooba') copy('encoder_repetition_penalty', 'encoder_rep_pen');
  for (const field of ['encoder_repetition_penalty', 'penalty_alpha', 'do_sample', 'num_beams']) {
    if (backend !== 'ooba') delete payload[field];
  }
  if (!['ooba', 'aphrodite'].includes(backend)) delete payload.no_repeat_ngram_size;
  if (backend !== 'ooba') delete payload.sampler_priority;
  if (backend === 'aphrodite' && Array.isArray(preset.samplers_priorities)) {
    payload.sampler_priority = pickSafeSamplerPayload({sampler_priority:preset.samplers_priorities}).sampler_priority;
  }
  if (backend !== 'llamacpp') delete payload.samplers;
  if (['llamacpp', 'ollama'].includes(backend)) {
    copy('repeat_penalty', 'rep_pen');
    copy('repeat_last_n', 'rep_pen_range');
    copy('mirostat', 'mirostat_mode');
  }
  if (backend === 'ollama') copy('tfs_z', 'tfs');
  if (Object.hasOwn(preset, 'rep_pen_range')) copy('repetition_penalty_range', 'rep_pen_range');
  if (backend === 'huggingface' && typeof payload.top_p === 'number') {
    payload.top_p = Math.min(Math.max(payload.top_p, 0), 0.999);
  }
  if (typeof payload.seed === 'number' && payload.seed < 0) delete payload.seed;
  const dynamic = samplerMode === 'profile' && preset.dynatemp === true
    && ['ooba', 'mancer', 'koboldcpp', 'tabby', 'llamacpp', 'aphrodite'].includes(backend)
    && Number.isFinite(preset.min_temp) && Number.isFinite(preset.max_temp);
  delete payload.dynatemp_range;
  delete payload.dynatemp_exponent;
  if (dynamic) {
    payload.temperature = (preset.min_temp + preset.max_temp) / 2;
    copy('dynatemp_exponent', 'dynatemp_exponent');
    if (backend === 'aphrodite') {
      payload.dynatemp_min = preset.min_temp;
      payload.dynatemp_max = preset.max_temp;
    } else {
      payload.dynamic_temperature = true;
      payload.dynatemp_range = (preset.max_temp - preset.min_temp) / 2;
      if (backend === 'mancer') {
        payload.dynatemp_mode = 1;
        payload.dynatemp_min = preset.min_temp;
        payload.dynatemp_max = preset.max_temp;
      } else {
        payload.dynatemp_low = preset.min_temp;
        payload.dynatemp_high = preset.max_temp;
      }
    }
  }
  if (['llamacpp', 'ollama', 'koboldcpp', 'mancer'].includes(backend) && typeof payload.dry_sequence_breakers === 'string') {
    try { payload.dry_sequence_breakers = JSON.parse(payload.dry_sequence_breakers); }
    catch { payload.dry_sequence_breakers = payload.dry_sequence_breakers.split(','); }
    if (!Array.isArray(payload.dry_sequence_breakers)) delete payload.dry_sequence_breakers;
  }
  return payload;
}

async function resolve(context, config = {}) {
  const id = String(config.connectionProfileId || '').trim();
  if (!id) throw error('RECURSION_PROFILE_MISSING', 'Select a Post-process writer Connection Profile.');
  const state = inspect(context, id);
  const originalHash = sourceHash(state);
  const { profile, apiMap, preset, mode, completion } = state;
  // Read the saved preset itself: host materialization may fill absent limits from the active main connection.
  const inherited = mode === 'chat' ? (preset.openai_max_tokens ?? preset.max_tokens) : (preset.genamt ?? preset.max_tokens);
  const tokens = config.maxOutputTokens ?? inherited;
  if (!Number.isInteger(tokens) || tokens < 256 || tokens > 65536) throw error('RECURSION_POST_PROCESS_WRITER_OUTPUT_LIMIT', 'Set a writer output limit from 256 to 65536 tokens; the selected preset must expose a valid limit to inherit.');
  const savedContextTokens = mode === 'chat' ? preset.openai_max_context : (preset.max_length ?? preset.max_context);
  const contextTokens = Number.isInteger(savedContextTokens) && savedContextTokens > 0 ? savedContextTokens : null;
  if (mode === 'text' && contextTokens === null) throw error('RECURSION_PROVIDER_CONTEXT_LIMIT',
    'Save a context limit in the selected text generation preset before using it as a writer. The conservative input check requires that limit.');
  if (mode === 'text' && typeof state.service.constructPrompt !== 'function') throw error('RECURSION_PROFILE_PRESET_UNAVAILABLE',
    'The selected text writer requires Connection Manager prompt formatting for its conservative input check. Update SillyTavern or choose a chat profile.');
  if (contextTokens !== null && tokens >= contextTokens) throw error('RECURSION_PROVIDER_CONTEXT_LIMIT',
    'The selected writer output limit leaves no room for the required draft and editing instructions.');
  // Host token counters use the active main tokenizer. Text requests use a
  // conservative formatted UTF-8 bound below, never that unrelated tokenizer.
  const samplerMode = config.samplerMode ?? 'profile';
  if (!['profile', 'override'].includes(samplerMode)) throw error('RECURSION_POST_PROCESS_WRITER_SAMPLERS', 'Select profile sampling or valid writer overrides.');
  const base = mode === 'chat' ? { model: profile.model, messages: [], chat_completion_source: apiMap.source } : { model: profile.model, prompt: '', api_type: apiMap.type };
  let payload;
  if (mode === 'text') {
    payload = projectTextWriterSamplers(preset, apiMap.type, samplerMode);
  } else {
    // Unlike the text helper, the chat helper accepts a source override before
    // materialization. Force the selected source instead of inheriting the main one.
    const materialized = await completion.presetToGeneratePayload(clone(preset),
      { chat_completion_source: apiMap.source }, base);
    payload = pickSafeSamplerPayload(materialized);
    for (const key of Object.keys(payload)) {
      if (!Object.hasOwn(preset, key)) delete payload[key];
    }
  }
  if (samplerMode === 'override') {
    const { temperature, topP } = config.samplerOverrides || {};
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2
      || typeof topP !== 'number' || !Number.isFinite(topP) || topP < 0 || topP > 1) throw error('RECURSION_POST_PROCESS_WRITER_SAMPLERS', 'Writer temperature must be 0 to 2 and Top P must be 0 to 1.');
    payload.temperature = temperature;
    payload.top_p = topP;
  }
  if (sourceHash(inspect(context, id)) !== originalHash) throw changed();
  const writer = Object.freeze({
    mode: 'profile', connectionProfileId: id, model: String(profile.model),
    label: `${profile.name || profile.label || id} / ${profile.model}`,
    maxOutputTokens: tokens, contextTokens, samplerMode,
    samplerOverrides: Object.freeze({ temperature: payload.temperature ?? null, topP: payload.top_p ?? null }),
    profileFingerprint: hashJson({ source: originalHash, payload, tokens, contextTokens, samplerMode, contract: 'post-process-prose-v1' })
  });
  if (config.profileFingerprint && config.profileFingerprint !== writer.profileFingerprint) throw changed();
  return { ...state, writer, payload, originalHash };
}

export async function resolvePostProcessWriter(context, config = {}) {
  if (!config.mode || config.mode === 'native') return Object.freeze({ mode: 'native', label: 'Current SillyTavern model' });
  if (config.mode !== 'profile') throw error('RECURSION_POST_PROCESS_WRITER_UNAVAILABLE', 'Select a supported Post-process writer.');
  return (await resolve(context, config)).writer;
}

export async function sendPostProcessProfileWriter(context, { writer, guidancePacket, writerDirective, signal }, readSecretMetadata) {
  if (signal?.aborted) throw Object.assign(new Error('Writer stopped.'), { name: 'AbortError' });
  const state = await resolve(context, writer);
  const secrets = await profileSecretOverride(state.profile, state.apiMap, readSecretMetadata);
  if (signal?.aborted) throw Object.assign(new Error('Writer stopped.'), { name: 'AbortError' });
  if (sourceHash(inspect(context, state.writer.connectionProfileId)) !== state.originalHash) throw changed();
  const messages = [
    { role: 'system', content: String(writerDirective || 'Return only the revised assistant response.') },
    { role: 'user', content: String(guidancePacket || '') }
  ];
  if (state.mode === 'text') {
    // Match processRequest: named instruct templates format the complete message
    // array, while a profile without instruct uses a plain double-newline join.
    const formatted = state.profile.instruct
      ? await state.service.constructPrompt(messages, state.writer.connectionProfileId)
      : messages.map(message => message.content).join('\n\n');
    if (typeof formatted !== 'string') throw error('RECURSION_PROFILE_PRESET_UNAVAILABLE',
      'The selected text writer could not format the full input for its conservative context check.');
    const inputBytes = new TextEncoder().encode(formatted).byteLength;
    const framingReserve = 128;
    if (inputBytes + state.writer.maxOutputTokens + framingReserve > state.writer.contextTokens) {
      throw error('RECURSION_PROVIDER_CONTEXT_LIMIT',
        'The full input exceeds the conservative text-writer context check. Increase the saved context limit in the selected generation preset or reduce optional evidence; the draft was not shortened.');
    }
  }
  if (signal?.aborted) throw Object.assign(new Error('Writer stopped.'), { name: 'AbortError' });
  if (sourceHash(inspect(context, state.writer.connectionProfileId)) !== state.originalHash) throw changed();
  const response = await state.service.sendRequest(state.writer.connectionProfileId, messages, state.writer.maxOutputTokens, {
    stream: false, signal, extractData: false, includePreset: false, includeInstruct: state.mode === 'text'
  }, {
    ...state.payload,
    ...(state.mode === 'text' && state.apiMap.type === 'llamacpp' ? { n_predict: state.writer.maxOutputTokens } : {}),
    ...(state.mode === 'text' && state.apiMap.type === 'ollama' ? { num_predict: state.writer.maxOutputTokens } : {}),
    ...(state.mode === 'text' && state.writer.contextTokens !== null ? {
      truncation_length: state.writer.contextTokens,
      ...(['llamacpp', 'ollama'].includes(state.apiMap.type) ? { num_ctx: state.writer.contextTokens } : {})
    } : {}),
    ...secrets
  });
  return { response, writer: state.writer };
}
