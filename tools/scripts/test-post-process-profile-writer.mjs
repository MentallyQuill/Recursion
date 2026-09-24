import assert from 'node:assert/strict';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';

function fixture({ text = false, response = ' Revised prose. ' } = {}) {
  const calls = [];
  const profile = { id: 'writer', name: 'Prose', model: 'prose-model', preset: 'Prose preset', api: text ? 'textgenerationwebui' : 'openai' };
  const preset = { temperature: 0.7, top_p: 0.91, max_tokens: 4096, prompts: ['Never import narrative prompts'] };
  if (text) preset.max_length = 32768;
  const apiMap = text ? { selected: 'textgenerationwebui', type: 'koboldcpp' } : { selected: 'openai', source: 'openai' };
  const completion = { TYPE: text ? 'text' : 'chat', async presetToGeneratePayload(value) { return structuredClone(value); } };
  const context = {
    chat: [], chatCompletionSettings: { max_tokens: 999, model: 'MAIN' },
    ConnectionManagerRequestService: {
      getSupportedProfiles: () => [profile], getProfile: id => id === profile.id ? profile : null,
      validateProfile: () => apiMap,
      constructPrompt: messages => messages.map(message => `<${message.role}>\n${message.content}`).join('\n'),
      async sendRequest(...args) { calls.push(args); return typeof response === 'function' ? response(...args) : response; }
    },
    getPresetManager: () => ({ getCompletionPresetByName: name => name === profile.preset ? preset : null }),
    ChatCompletionService: completion, TextCompletionService: completion,
    generate: () => { throw new Error('Native generation forbidden'); },
    setExtensionPrompt: () => { throw new Error('Prompt mutation forbidden'); }
  };
  const host = createSillyTavernHost({ contextFactory: () => context, settingsRoot: {}, secretMetadataFactory: async () => null });
  return { host, context, calls, profile, preset, apiMap };
}
const config = { mode: 'profile', connectionProfileId: 'writer', maxOutputTokens: null, samplerMode: 'profile', samplerOverrides: { temperature: 0.3, topP: 0.8 } };
{
  const f = fixture();
  const before = structuredClone(f.context.chatCompletionSettings);
  const writer = await f.host.generation.resolvePostProcessWriter(config);
  assert.equal(writer.maxOutputTokens, 4096);
  assert.equal(writer.model, 'prose-model');
  assert.ok(Object.isFrozen(writer));
  assert.ok(Object.isFrozen(writer.samplerOverrides));
  const result = await f.host.generation.rewriteWithPostProcess({ writer, guidancePacket: 'Complete frozen draft and evidence.', writerDirective: 'Return only revised prose.' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Revised prose.');
  assert.equal(result.writer.profileFingerprint, writer.profileFingerprint);
  const [id, messages, tokens, options, payload] = f.calls[0];
  assert.equal(id, 'writer');
  assert.deepEqual(messages, [{ role: 'system', content: 'Return only revised prose.' }, { role: 'user', content: 'Complete frozen draft and evidence.' }]);
  assert.equal(tokens, 4096);
  assert.equal(options.includePreset, false);
  assert.equal(options.includeInstruct, false);
  assert.equal(options.extractData, false);
  assert.equal(payload.temperature, 0.7);
  assert.equal(payload.top_p, 0.91);
  assert.equal(payload.prompts, undefined);
  assert.equal(payload.json_schema, undefined);
  assert.deepEqual(f.context.chatCompletionSettings, before);
}

for (const response of [{}, { choices: [{ message: { content: '', reasoning_content: 'private reasoning' } }] }, { ok: true }]) {
  const f = fixture({ response });
  const result = await f.host.generation.rewriteWithPostProcess({ writer: config });
  assert.equal(result.ok, false, 'empty transport envelopes are not prose');
  assert.equal(result.error.code, 'RECURSION_POST_PROCESS_WRITER_EMPTY');
}
for (const response of [
  { choices: [{ message: { content: 'Partial prose' }, finish_reason: 'length' }] },
  { candidates: [{ content: { parts: [{ text: 'Partial prose' }] }, finishReason: 'MAX_TOKENS' }] }
]) {
  const f = fixture({ response });
  const result = await f.host.generation.rewriteWithPostProcess({ writer: config });
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.equal(result.error.code, 'provider_token_limit');
}
{
  const f = fixture({ response: { error: { code: 'provider_test_failed', message: 'Request failed' } } });
  const result = await f.host.generation.rewriteWithPostProcess({ writer: config });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'provider_test_failed');
}

for (const writer of [{ ...config, mode: 'invalid' }, { ...config, connectionProfileId: '' }, { ...config, connectionProfileId: 'deleted' }, { ...config, maxOutputTokens: 255 }, { ...config, maxOutputTokens: 4096.5 }, { ...config, samplerMode: 'override', samplerOverrides: { temperature: 3, topP: 0.9 } }]) {
  const f = fixture();
  const result = await f.host.generation.rewriteWithPostProcess({ writer });
  assert.equal(result.ok, false);
  assert.equal(f.calls.length, 0);
  if (writer.mode === 'invalid') assert.equal(result.error.code, 'RECURSION_POST_PROCESS_WRITER_UNAVAILABLE');
}
{
  const f = fixture();
  delete f.preset.max_tokens;
  f.context.ChatCompletionService.presetToGeneratePayload = async () => ({ max_tokens: 999, temperature: 0.7 });
  await assert.rejects(f.host.generation.resolvePostProcessWriter(config), { code: 'RECURSION_POST_PROCESS_WRITER_OUTPUT_LIMIT' });
  const writer = await f.host.generation.resolvePostProcessWriter({ ...config, maxOutputTokens: 2048 });
  assert.equal(writer.maxOutputTokens, 2048);
}
for (const change of [f => { f.profile.model = 'other'; }, f => { f.preset.temperature = 0.1; }, f => { f.preset.max_tokens = 8192; }]) {
  const f = fixture();
  const writer = await f.host.generation.resolvePostProcessWriter(config);
  change(f);
  const result = await f.host.generation.rewriteWithPostProcess({ writer });
  assert.equal(result.error.code, 'RECURSION_POST_PROCESS_WRITER_CHANGED');
  assert.equal(f.calls.length, 0);
}
{
  const f = fixture();
  const result = await f.host.generation.rewriteWithPostProcess({ writer: { ...config, samplerMode: 'override', samplerOverrides: { temperature: 0.2, topP: 0.8 }, maxOutputTokens: 8192 } });
  assert.equal(result.ok, true);
  assert.equal(f.calls[0][2], 8192);
  assert.equal(f.calls[0][4].temperature, 0.2);
  assert.equal(f.calls[0][4].top_p, 0.8);
}
{
  const f = fixture({ text: true });
  f.profile.instruct = 'ChatML';
  const instruct = { name: 'ChatML', input_sequence: '<user>', output_sequence: '<assistant>' };
  f.context.getPresetManager = type => ({ getCompletionPresetByName: () => type === 'instruct' ? instruct : f.preset });
  const writer = await f.host.generation.resolvePostProcessWriter(config);
  const result = await f.host.generation.rewriteWithPostProcess({ writer });
  assert.equal(result.ok, true);
  assert.equal(f.calls[0][3].includeInstruct, true);
  assert.equal(f.calls[0][3].includePreset, false);
  instruct.output_sequence = '<changed>';
  assert.equal((await f.host.generation.rewriteWithPostProcess({ writer })).error.code, 'RECURSION_POST_PROCESS_WRITER_CHANGED');
  assert.equal(f.calls.length, 1);
}
{
  const f = fixture({ response: { choices: [{ message: { content: [{ type: 'text', text: 'Full prose.' }] }, finish_reason: 'stop' }] } });
  assert.equal((await f.host.generation.rewriteWithPostProcess({ writer: config })).text, 'Full prose.');
}
for (const stop of ['preabort', 'abort', 'timeout']) {
  let finish;
  const f = fixture({ response: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController();
  if (stop === 'preabort') controller.abort();
  const pending = f.host.generation.rewriteWithPostProcess({ writer: config, signal: controller.signal, timeoutMs: stop === 'timeout' ? 10 : 1000 });
  if (stop === 'abort') {
    while (!f.calls.length) await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
  }
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, stop === 'timeout' ? 'RECURSION_POST_PROCESS_WRITER_TIMEOUT' : 'RECURSION_PROVIDER_ABORTED');
  if (stop === 'preabort') assert.equal(f.calls.length, 0);
  else {
    assert.equal(f.calls[0][3].signal.aborted, true);
    finish('Late obsolete prose');
    await Promise.resolve();
    assert.equal(result.text, '');
  }
}
{
  const f = fixture();
  f.profile['secret-id'] = 'stale-id';
  const host = createSillyTavernHost({ contextFactory: () => f.context, settingsRoot: {}, secretMetadataFactory: async () => ({
    SECRET_KEYS: { OPENAI: 'api_key_openai' }, chatSources: { OPENAI: 'openai' }, secret_state: { api_key_openai: [{ id: 'active-id', active: true }] }
  }) });
  const result = await host.generation.rewriteWithPostProcess({ writer: config });
  assert.equal(result.ok, true);
  assert.equal(f.calls[0][4].secret_id, 'active-id');
  assert.equal(JSON.stringify(result.writer).includes('active-id'), false);
  assert.equal(JSON.stringify(result.writer).includes('stale-id'), false);
}
{
  const f = fixture();
  f.profile['secret-id'] = 'profile-key';
  const host = createSillyTavernHost({ contextFactory: () => f.context, settingsRoot: {}, secretMetadataFactory: async () => { f.profile.model = 'changed-during-secret-read'; return null; } });
  assert.equal((await host.generation.rewriteWithPostProcess({ writer: config })).error.code, 'RECURSION_POST_PROCESS_WRITER_CHANGED');
  assert.equal(f.calls.length, 0);
}

{
  const f = fixture();
  f.context.ChatCompletionService.presetToGeneratePayload = async preset => ({ ...preset, top_k: 777, max_tokens: 999 });
  await f.host.generation.rewriteWithPostProcess({ writer: config });
  assert.equal(f.calls[0][4].top_k, undefined, 'materialization cannot leak sampler values absent from selected preset');
  assert.equal(f.calls[0][2], 4096, 'materialized main limit never replaces saved profile limit');
}

{
  const f = fixture();
  f.context.ChatCompletionService.presetToGeneratePayload = async preset => { f.profile.model = 'changed-during-materialization'; return preset; };
  const result = await f.host.generation.rewriteWithPostProcess({ writer: config });
  assert.equal(result.error.code, 'RECURSION_POST_PROCESS_WRITER_CHANGED');
  assert.equal(f.calls.length, 0);
}
for (const response of [
  { response: 'Partial prose', done_reason: 'length' },
  { content: 'Partial prose', stopped_limit: true }
]) {
  const f = fixture({ text: true, response });
  const result = await f.host.generation.rewriteWithPostProcess({ writer: config });
  assert.equal(result.ok, false, 'native text backend token exhaustion is rejected');
  assert.equal(result.error.code, 'provider_token_limit');
  assert.equal(result.text, '');
}
{
  const f = fixture({ text: true, response: [{ content: 'Complete prose' }] });
  const result = await f.host.generation.rewriteWithPostProcess({ writer: config });
  assert.equal(result.ok, true, 'text completion array envelopes match SillyTavern extraction');
  assert.equal(result.text, 'Complete prose');
}
{
  const f = fixture({ text: true });
  delete f.preset.temperature;
  f.apiMap.type='ooba';
  Object.assign(f.preset, { temp: 0.4, freq_pen: 0.3, presence_pen: 0.2, encoder_rep_pen: 1.1,
    dynatemp: true, min_temp: 0.2, max_temp: 0.8, dynatemp_exponent: 1.5 });
  f.context.TextCompletionService.presetToGeneratePayload = async (preset, overrides) => {
    const selected = { ...preset, ...overrides };
    const dynamic = selected.dynatemp;
    return {
      temperature: dynamic ? (selected.min_temp + selected.max_temp) / 2 : selected.temp,
      frequency_penalty: selected.freq_pen, presence_penalty: selected.presence_pen,
      encoder_repetition_penalty: selected.encoder_rep_pen,
      dynamic_temperature: dynamic ? true : undefined,
      dynatemp_low: dynamic ? selected.min_temp : undefined,
      dynatemp_high: dynamic ? selected.max_temp : undefined,
      dynatemp_range: dynamic ? (selected.max_temp - selected.min_temp) / 2 : undefined,
      dynatemp_exponent: dynamic ? selected.dynatemp_exponent : undefined,
      dynatemp_mode: dynamic ? 1 : 0,
      dynatemp_min: dynamic ? selected.min_temp : undefined,
      dynatemp_max: dynamic ? selected.max_temp : undefined,
      top_k: 777
    };
  };
  assert.equal((await f.host.generation.rewriteWithPostProcess({ writer: config })).ok, true);
  const payload = f.calls[0][4];
  assert.equal(payload.frequency_penalty, 0.3, 'saved freq_pen maps to frequency_penalty');
  assert.equal(payload.presence_penalty, 0.2, 'saved presence_pen maps to presence_penalty');
  assert.equal(payload.encoder_repetition_penalty, 1.1, 'saved encoder_rep_pen maps to encoder_repetition_penalty');
  assert.equal(payload.temperature, 0.5);
  assert.equal(payload.dynamic_temperature, true);
  assert.equal(payload.dynatemp_low, 0.2);
  assert.equal(payload.dynatemp_high, 0.8);
  assert.ok(Math.abs(payload.dynatemp_range - 0.3) < 1e-10);
  assert.equal(payload.dynatemp_exponent, 1.5);
  assert.equal(payload.dynatemp_mode, undefined, 'ooba does not receive Mancer mode alias');
  assert.equal(payload.dynatemp_min, undefined);
  assert.equal(payload.dynatemp_max, undefined);
  assert.equal(payload.top_k, undefined, 'unrelated global sampler remains excluded');
  await f.host.generation.rewriteWithPostProcess({ writer: { ...config, samplerMode: 'override', samplerOverrides: { temperature: 0.6, topP: 0.9 } } });
  assert.equal(f.calls[1][4].temperature, 0.6);
  assert.equal(f.calls[1][4].dynamic_temperature, undefined, 'explicit temperature overrides profile dynamic temperature');
  assert.equal(f.calls[1][4].dynatemp_range, undefined);
}
for (const text of [false, true]) {
  const f = fixture({ text });
  f.preset[text ? 'max_length' : 'openai_max_context'] = 8192;
  f.context.chatCompletionSettings.openai_max_context = 999;
  const writer = await f.host.generation.resolvePostProcessWriter(config);
  assert.equal(writer.contextTokens, 8192, 'context budget belongs to saved selected preset');
  f.preset[text ? 'max_length' : 'openai_max_context'] = 4096;
  const result = await f.host.generation.rewriteWithPostProcess({ writer: config, guidancePacket: 'Full mandatory draft.' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'RECURSION_PROVIDER_CONTEXT_LIMIT');
  assert.equal(f.calls.length, 0, 'known impossible input/output budget fails before dispatch');
}
{
  const f = fixture({ response: () => { throw new Error('The request exceeds the maximum context length'); } });
  const result = await f.host.generation.rewriteWithPostProcess({ writer: config });
  assert.equal(result.error.code, 'RECURSION_PROVIDER_CONTEXT_LIMIT', 'provider-detected input context failure remains classified');
}
for (const backend of ['ollama','llamacpp']) {
  const f=fixture({text:true}); f.apiMap.type=backend;
  f.preset.genamt=3000; f.preset.max_length=16000;
  f.preset.temp=0.65; f.preset.rep_pen=1.15; f.preset.rep_pen_range=128;
  f.preset.samplers=['top_k','top_p','temperature'];
  let request;
  f.context.ConnectionManagerRequestService.sendRequest=async(_id,prompt,maxTokens,_options,override)=>{
    // Installed TextCompletionService.createRequestData maps the positional budget
    // only to max_tokens/max_new_tokens. Native endpoints consume different fields.
    const body={prompt,max_tokens:maxTokens,max_new_tokens:maxTokens,...override};
    request=backend==='ollama' ? {options:Object.fromEntries(Object.entries(body).filter(([key])=>[
      'num_predict','num_ctx','temperature','repeat_penalty','repeat_last_n','top_p'
    ].includes(key)))} : body;
    return backend==='ollama'?{response:'Complete prose',done_reason:'stop'}:[{content:'Complete prose',stopped_limit:false}];
  };
  const writer=await f.host.generation.resolvePostProcessWriter(config);
  assert.equal(writer.contextTokens,16000,'saved text max_length is selected context limit');
  const result=await f.host.generation.rewriteWithPostProcess({writer});
  assert.equal(result.ok,true);
  if(backend==='ollama') {
    assert.equal(request.options.num_predict,3000,'Ollama native request retains explicit output cap');
    assert.equal(request.options.num_ctx,16000,'Ollama native request retains selected context');
    assert.equal(request.options.repeat_penalty,1.15);
    assert.equal(request.options.repeat_last_n,128);
  } else {
    assert.equal(request.n_predict,3000,'llama.cpp native request retains output cap');
    assert.equal(request.truncation_length,16000);
    assert.deepEqual(request.samplers,f.preset.samplers,'selected llama.cpp sampler order survives active backend mismatch');
  }
}
{
  const f=fixture({text:true}); f.apiMap.type='llamacpp';
  f.preset.samplers=['top_k','top_p']; f.preset.genamt=2000; f.preset.max_length=8000;
  f.context.textCompletionSettings={type:'ooba',temp:1.9,samplers:['temperature']};
  f.context.TextCompletionService.presetToGeneratePayload=()=>{throw new Error('Global text materializer must not be used');};
  const writer=await f.host.generation.resolvePostProcessWriter(config);
  f.context.textCompletionSettings={type:'ollama',temp:0.1,samplers:['min_p']};
  const refreshed=await f.host.generation.resolvePostProcessWriter(config);
  assert.equal(refreshed.profileFingerprint,writer.profileFingerprint,'active main backend does not affect selected writer fingerprint');
  assert.equal((await f.host.generation.rewriteWithPostProcess({writer})).ok,true);
  assert.deepEqual(f.calls[0][4].samplers,['top_k','top_p']);
}
{
  const f=fixture(); f.apiMap.source='claude'; f.preset.top_k=14;
  f.context.ChatCompletionService.presetToGeneratePayload=async(preset,override)=>{
    assert.equal(override.chat_completion_source,'claude','selected chat source overrides main source before sampler projection');
    return {...preset,top_k:override.chat_completion_source==='claude'?14:999};
  };
  await f.host.generation.rewriteWithPostProcess({writer:config});
  assert.equal(f.calls[0][4].top_k,14);
}
{
  const f=fixture({text:true});
  f.preset.max_length=5000;
  const result=await f.host.generation.rewriteWithPostProcess({writer:config,writerDirective:'Keep original.',guidancePacket:'Long mandatory draft '.repeat(300)});
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'RECURSION_PROVIDER_CONTEXT_LIMIT');
  assert.match(result.error.message,/conservative/i);
  assert.equal(f.calls.length,0,'oversized full input is rejected rather than trimmed by text backend');
}
{
  const f=fixture({text:true}); f.profile.instruct='Selected formatting';
  f.context.getPresetManager=type=>({getCompletionPresetByName:()=>type==='instruct'?{name:'Selected formatting'}:f.preset});
  f.preset.max_length=5000;
  f.context.ConnectionManagerRequestService.constructPrompt=()=> 'Template overhead '.repeat(200);
  const result=await f.host.generation.rewriteWithPostProcess({writer:config,guidancePacket:'Small draft'});
  assert.equal(result.error.code,'RECURSION_PROVIDER_CONTEXT_LIMIT','full instruct formatting counts toward capacity');
  assert.equal(f.calls.length,0);
}
for(const unavailable of ['context','formatter']) {
  const f=fixture({text:true});
  if(unavailable==='context') delete f.preset.max_length;
  else delete f.context.ConnectionManagerRequestService.constructPrompt;
  const result=await f.host.generation.rewriteWithPostProcess({writer:config,guidancePacket:'Complete draft'});
  assert.equal(result.ok,false);
  assert.equal(f.calls.length,0,'unprovable text input fit fails before dispatch');
}
console.log('[pass] post-process profile writer');
