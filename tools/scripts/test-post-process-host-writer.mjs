import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const POST_PROCESS_PROMPT_KEY = 'recursion.postProcessGuidance';
const WRITER_DIRECTIVE = [
  'Rewrite the supplied source draft.',
  'Follow the Post-process packet.',
  'Use frozen evidence only to preserve continuity.',
  'Do not continue beyond the response.',
  'Do not mention the editing process.',
  'Return only the revised assistant response.'
].join('\n');

function createWriterContext({ generateImpl }) {
  const calls = [];
  const extensionPrompts = {
    'recursion.guidance': {
      value: 'Existing guidance.',
      position: 0,
      depth: 1,
      scan: false,
      role: 0
    },
    'recursion.cardEvidence': {
      value: 'Existing card evidence.',
      position: 0,
      depth: 1,
      scan: false,
      role: 0
    },
    'recursion.guardrails': {
      value: 'Existing guardrails.',
      position: 0,
      depth: 1,
      scan: false,
      role: 0
    }
  };
  const context = {
    chatId: 'post-process-writer-chat',
    chat: [{
      mesid: 4,
      is_user: false,
      mes: 'Original assistant response.',
      swipe_id: 0,
      swipes: ['Original assistant response.'],
      swipe_info: [{ extra: { api: 'native-host' } }]
    }],
    extensionPrompts,
    extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 0, BEFORE_PROMPT: 2 },
    extension_prompt_roles: { SYSTEM: 0 },
    setExtensionPrompt(key, text, position, depth, scan, role) {
      calls.push(['prompt', key, text, position, depth, scan, role]);
      extensionPrompts[key] = {
        value: String(text),
        position: Number(position),
        depth: Number(depth),
        scan: Boolean(scan),
        role: Number(role)
      };
    },
    async generate(type, options) {
      calls.push(['generate', type, options]);
      return generateImpl(type, options);
    },
    generateRaw() {
      calls.push(['generateRaw']);
      throw new Error('raw writer forbidden');
    },
    generateQuietPrompt() {
      calls.push(['generateQuietPrompt']);
      throw new Error('quiet helper writer forbidden');
    },
    ConnectionManagerRequestService: {
      sendRequest() {
        calls.push(['connectionProfile']);
        throw new Error('connection profile writer forbidden');
      }
    },
    saveReply() {
      calls.push(['saveReply']);
      throw new Error('writer must not persist a reply');
    },
    saveChat() {
      calls.push(['saveChat']);
      throw new Error('writer must not save chat');
    }
  };
  return { calls, context };
}

{
  const signal = new AbortController().signal;
  const fixture = createWriterContext({
    generateImpl: async () => ' \n  Rewritten assistant response.  \n '
  });
  const originalChat = structuredClone(fixture.context.chat);
  const existingPromptState = structuredClone(fixture.context.extensionPrompts);
  const host = createSillyTavernHost({
    contextFactory: () => fixture.context,
    settingsRoot: {}
  });

  const result = await host.generation.rewriteWithPostProcess({
    guidancePacket: 'Frozen Post-process guidance packet.',
    writerDirective: WRITER_DIRECTIVE,
    signal
  });

  assertDeepEqual(
    result,
    { ok: true, text: 'Rewritten assistant response.' },
    'native Post-process writer returns normalized text'
  );
  const generateCall = fixture.calls.find((entry) => entry[0] === 'generate');
  assertDeepEqual(
    generateCall,
    ['generate', 'quiet', {
      automatic_trigger: true,
      quiet_prompt: WRITER_DIRECTIVE,
      quietToLoud: true,
      skipWIAN: false,
      signal: generateCall[2].signal
    }],
    'native Post-process writer uses the exact non-persisting SillyTavern generation contract'
  );
  assertEqual(
    fixture.calls.some((entry) => ['generateRaw', 'generateQuietPrompt', 'connectionProfile'].includes(entry[0])),
    false,
    'native Post-process writer does not use forbidden provider or helper APIs'
  );
  assertEqual(
    fixture.calls.some((entry) => ['saveReply', 'saveChat'].includes(entry[0])),
    false,
    'native Post-process writer does not call persistence APIs'
  );
  const postProcessPromptCalls = fixture.calls.filter(
    (entry) => entry[0] === 'prompt' && entry[1] === POST_PROCESS_PROMPT_KEY
  );
  assertEqual(postProcessPromptCalls.length, 2, 'transient Post-process prompt has one install and one clear');
  assertDeepEqual(
    postProcessPromptCalls[0].slice(1),
    [
      POST_PROCESS_PROMPT_KEY,
      'Frozen Post-process guidance packet.',
      0,
      0,
      false,
      0
    ],
    'Post-process guidance is installed as a targeted in-prompt system prompt'
  );
  assertEqual(postProcessPromptCalls[1][2], '', 'Post-process prompt is cleared after successful generation');
  assert(
    fixture.calls.indexOf(postProcessPromptCalls[0]) < fixture.calls.indexOf(generateCall)
      && fixture.calls.indexOf(generateCall) < fixture.calls.indexOf(postProcessPromptCalls[1]),
    'Post-process prompt surrounds only the native writer call'
  );
  assertDeepEqual(fixture.context.chat, originalChat, 'native Post-process writer leaves original chat and swipes unchanged');
  assertEqual(fixture.context.chat[0].swipes.length, 1, 'native Post-process writer does not add a swipe');
  for (const [key, value] of Object.entries(existingPromptState)) {
    assertDeepEqual(
      fixture.context.extensionPrompts[key],
      value,
      `targeted Post-process cleanup preserves ${key}`
    );
  }
  assertEqual(
    fixture.calls.some((entry) => entry[0] === 'prompt' && Object.hasOwn(existingPromptState, entry[1])),
    false,
    'targeted Post-process lifecycle never rewrites normal Recursion prompt keys'
  );
}

for (const scenario of [
  {
    label: 'empty output',
    generateImpl: async () => ' \n\t ',
    expectedCode: 'RECURSION_POST_PROCESS_WRITER_EMPTY'
  },
  {
    label: 'thrown generation failure',
    generateImpl: async () => {
      const error = new Error('native writer failed');
      error.code = 'RECURSION_TEST_NATIVE_WRITER_FAILED';
      throw error;
    },
    expectedCode: 'RECURSION_TEST_NATIVE_WRITER_FAILED'
  },
  {
    label: 'abort',
    abort: true,
    generateImpl: async () => {
      const error = new Error('native writer aborted');
      error.name = 'AbortError';
      throw error;
    },
    expectedCode: 'RECURSION_PROVIDER_ABORTED'
  }
]) {
  const controller = new AbortController();
  if (scenario.abort) controller.abort();
  const fixture = createWriterContext({ generateImpl: scenario.generateImpl });
  const originalChat = structuredClone(fixture.context.chat);
  const host = createSillyTavernHost({
    contextFactory: () => fixture.context,
    settingsRoot: {}
  });

  const result = await host.generation.rewriteWithPostProcess({
    guidancePacket: `Packet for ${scenario.label}.`,
    writerDirective: WRITER_DIRECTIVE,
    signal: controller.signal
  });

  if (scenario.abort) assertEqual(fixture.calls.length, 0, 'pre-aborted writer dispatches nothing');
  assertEqual(result.ok, false, `${scenario.label} fails safely`);
  assertEqual(result.text, '', `${scenario.label} cannot expose a usable draft`);
  assertEqual(result.error?.code, scenario.expectedCode, `${scenario.label} exposes a stable error code`);
  assertEqual(
    fixture.calls.filter(
      (entry) => entry[0] === 'prompt'
        && entry[1] === POST_PROCESS_PROMPT_KEY
        && entry[2] === ''
    ).length,
    scenario.abort ? 0 : 1,
    `${scenario.label} clears the transient Post-process prompt in finally`
  );
  assertEqual(
    fixture.calls.some((entry) => ['generateRaw', 'generateQuietPrompt', 'connectionProfile', 'saveReply', 'saveChat'].includes(entry[0])),
    false,
    `${scenario.label} does not fall back to forbidden generation or persistence APIs`
  );
  assertDeepEqual(fixture.context.chat, originalChat, `${scenario.label} leaves chat and swipes unchanged`);
}

{
  const promptCalls = [];
  const context = {
    chat: [],
    setExtensionPrompt(...args) {
      promptCalls.push(args);
    },
    generateRaw() {
      throw new Error('raw writer forbidden');
    },
    generateQuietPrompt() {
      throw new Error('quiet helper writer forbidden');
    }
  };
  const host = createSillyTavernHost({ contextFactory: () => context, settingsRoot: {} });
  const result = await host.generation.rewriteWithPostProcess({
    guidancePacket: 'Packet.',
    writerDirective: WRITER_DIRECTIVE
  });
  assertEqual(result.ok, false, 'missing native writer API fails safely');
  assertEqual(
    result.error?.code,
    'RECURSION_POST_PROCESS_WRITER_UNAVAILABLE',
    'missing native writer API exposes a stable unavailable code'
  );
  assertEqual(promptCalls.length, 0, 'missing native writer API does not install a transient prompt');
}

{
  const fixture = createWriterContext({ generateImpl: () => new Promise(() => {}) });
  const host = createSillyTavernHost({ contextFactory: () => fixture.context, settingsRoot: {} });
  const result = await host.generation.rewriteWithPostProcess({ guidancePacket: 'Timed packet', timeoutMs: 10 });
  assertEqual(result.error.code, 'RECURSION_POST_PROCESS_WRITER_TIMEOUT', 'hung writer has finite deadline');
  assertEqual(result.error.retryable, true, 'deadline failure preserves retryability');
  assertEqual(fixture.calls.find((entry) => entry[0] === 'generate')[2].signal.aborted, true, 'deadline aborts writer signal');
  assertEqual(fixture.context.extensionPrompts[POST_PROCESS_PROMPT_KEY].value, '', 'timed writer clears its prompt');
}

{
  let finishOld;
  let finishNew;
  let calls = 0;
  const fixture = createWriterContext({ generateImpl: () => new Promise((resolve) => {
    if (++calls === 1) finishOld = resolve;
    else finishNew = resolve;
  }) });
  const host = createSillyTavernHost({ contextFactory: () => fixture.context, settingsRoot: {} });
  const oldController = new AbortController();
  const old = host.generation.rewriteWithPostProcess({ guidancePacket: 'Old packet', signal: oldController.signal });
  await Promise.resolve();
  const current = host.generation.rewriteWithPostProcess({ guidancePacket: 'New packet' });
  await Promise.resolve();
  oldController.abort();
  assertEqual((await old).error.code, 'RECURSION_PROVIDER_ABORTED', 'abort returns even when host ignores it');
  assertEqual(fixture.context.extensionPrompts[POST_PROCESS_PROMPT_KEY].value, 'New packet', 'old abort cleanup preserves newer prompt');
  finishOld('Late obsolete text');
  await Promise.resolve();
  assertEqual(fixture.context.extensionPrompts[POST_PROCESS_PROMPT_KEY].value, 'New packet', 'late host completion preserves newer prompt');
  finishNew('Current text');
  assertEqual((await current).text, 'Current text', 'new writer completes normally');
  assertEqual(fixture.context.extensionPrompts[POST_PROCESS_PROMPT_KEY].value, '', 'new writer clears its own prompt');
}

{
  const fixture = createWriterContext({ generateImpl: async () => {
    throw Object.assign(new Error('Provider unavailable'), { code: 'RECURSION_PROVIDER_RATE_LIMIT', retryable: true, category: 'provider' });
  } });
  const host = createSillyTavernHost({ contextFactory: () => fixture.context, settingsRoot: {} });
  const result = await host.generation.rewriteWithPostProcess();
  assertEqual(result.error.code, 'RECURSION_PROVIDER_RATE_LIMIT', 'provider code survives host boundary');
  assertEqual(result.error.retryable, true, 'provider retryability survives host boundary');
  assertEqual(result.error.category, 'provider', 'provider category survives host boundary');
}

for (const returned of [false, true]) {
  const fixture = createWriterContext({ generateImpl: async () => {
    const error = Object.assign(new Error('HTTP 401'), { status: 401 });
    if (returned) return { ok: false, error };
    throw error;
  } });
  const host = createSillyTavernHost({ contextFactory: () => fixture.context, settingsRoot: {} });
  const result = await host.generation.rewriteWithPostProcess();
  assertEqual(result.error.code, 'RECURSION_PROVIDER_AUTH_FAILED', 'native authentication failure retains provider classification');
  assertEqual(result.error.retryable, false, 'authentication failure cannot retry');
  assertEqual(result.error.kind, 'transport', 'writer provider failure is transport rather than validation');
}

{
  const fixture = createWriterContext({ generateImpl: async () => ({ choices: [{ message: { content: 'Partial prose' }, finish_reason: 'length' }] }) });
  const host = createSillyTavernHost({ contextFactory: () => fixture.context, settingsRoot: {} });
  const result = await host.generation.rewriteWithPostProcess({ writer: { mode: 'native' } });
  assertEqual(result.ok, false, 'native known truncation is not accepted');
  assertEqual(result.error.code, 'provider_token_limit', 'native truncation keeps provider classification');
  assertEqual(result.text, '', 'partial native prose cannot be committed');
}

console.log('[pass] post-process host writer');
