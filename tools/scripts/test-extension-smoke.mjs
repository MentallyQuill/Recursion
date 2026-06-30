import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const RECURSION_PROMPT_KEYS = [
  'recursion.sceneBrief',
  'recursion.turnBrief',
  'recursion.guardrails'
];

await import('../../src/extension/index.js');

assertEqual(typeof globalThis.recursionGenerationInterceptor, 'function', 'generation interceptor is registered globally');
assertEqual(typeof globalThis.recursionOnEnable, 'function', 'enable hook is registered globally');

const chat = await globalThis.recursionGenerationInterceptor('hello');
assertEqual(chat, 'hello', 'generation interceptor returns original chat without host');

const hooks = [
  'recursionOnInstall',
  'recursionOnUpdate',
  'recursionOnEnable',
  'recursionOnDisable',
  'recursionOnDelete',
  'recursionOnClean',
  'recursionOnActivate'
];

for (const hook of hooks) {
  assertEqual(typeof globalThis[hook], 'function', `${hook} is registered globally`);
  assertEqual(await globalThis[hook](), true, `${hook} is fail-soft without host`);
}

function createFakeSillyTavernContext(label) {
  const promptWrites = [];
  const promptState = new Map();
  const fake = {
    promptWrites,
    promptState,
    context: {
      chatId: `${label}-chat`,
      chat: [{ mesid: 0, is_user: true, mes: `${label} user message.` }],
      extension_prompt_types: { IN_CHAT: 'IN_CHAT', IN_PROMPT: 'IN_PROMPT', BEFORE_PROMPT: 'BEFORE_PROMPT' },
      extension_prompt_roles: { SYSTEM: 'SYSTEM' },
      setExtensionPrompt(key, text, position, depth, scan, role) {
        if (fake.throwOnClear && text === '') {
          throw new Error(`${label} clear failed`);
        }
        promptWrites.push({ key, text, position, depth, scan, role });
        promptState.set(key, text);
      },
      async generateRaw() {
        return {
          text: JSON.stringify({
            schema: 'recursion.utilityArbiter.v1',
            action: 'compose-brief',
            cardJobs: [],
            reasonerDecision: { mode: 'skip', reason: 'smoke test', signals: [] },
            budgets: { targetBriefTokens: 500, maxCards: 6 },
            diagnostics: [`${label}-smoke`]
          })
        };
      }
    }
  };
  fake.throwOnClear = false;
  return fake;
}

async function assertLifecycleClearsInstalledPrompt(hookName) {
  const fake = createFakeSillyTavernContext(hookName);
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };

  const originalChat = { payload: `${hookName}-chat-payload` };
  assertEqual(await globalThis.recursionGenerationInterceptor(originalChat), originalChat, `${hookName} setup keeps original chat`);
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(fake.promptState.get(key), `${hookName} setup installs ${key}`);
  }

  const firstLifecycleWrite = fake.promptWrites.length;
  assertEqual(await globalThis[hookName](), true, `${hookName} returns true`);
  const cleanupWrites = fake.promptWrites.slice(firstLifecycleWrite);
  for (const key of RECURSION_PROMPT_KEYS) {
    assert(
      cleanupWrites.some((entry) => entry.key === key && entry.text === ''),
      `${hookName} clears ${key}`
    );
    assertEqual(fake.promptState.get(key), '', `${hookName} leaves ${key} empty`);
  }
}

async function assertLifecycleClearFailureIsFailSoft(hookName) {
  const fake = createFakeSillyTavernContext(`${hookName}-clear-failure`);
  const warnings = [];
  const originalWarn = console.warn;
  globalThis.extension_settings = { recursion: { mode: 'auto', reasonerUse: 'off' } };
  globalThis.SillyTavern = { getContext: () => fake.context };

  try {
    console.warn = (...args) => warnings.push(args);
    assertEqual(await globalThis.recursionGenerationInterceptor(`${hookName}-failure-chat`), `${hookName}-failure-chat`, `${hookName} failure setup keeps original chat`);
    fake.throwOnClear = true;
    assertEqual(await globalThis[hookName](), true, `${hookName} returns true when prompt clear throws`);
    assert(warnings.some((entry) => String(entry[0] || '').includes('clear')), `${hookName} logs prompt clear failure`);
  } finally {
    console.warn = originalWarn;
    fake.throwOnClear = false;
    await globalThis.recursionOnDelete();
  }
}

const previousGlobals = {
  SillyTavern: globalThis.SillyTavern,
  getContext: globalThis.getContext,
  extensionSettings: globalThis.extension_settings
};
const lifecycleFailures = [];
try {
  for (const hookName of ['recursionOnDisable', 'recursionOnDelete']) {
    try {
      await assertLifecycleClearsInstalledPrompt(hookName);
      await assertLifecycleClearFailureIsFailSoft(hookName);
    } catch (error) {
      lifecycleFailures.push(`${hookName}: ${error?.message || error}`);
      await globalThis.recursionOnDelete();
    }
  }
} finally {
  if (previousGlobals.SillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousGlobals.SillyTavern;
  if (previousGlobals.getContext === undefined) delete globalThis.getContext;
  else globalThis.getContext = previousGlobals.getContext;
  if (previousGlobals.extensionSettings === undefined) delete globalThis.extension_settings;
  else globalThis.extension_settings = previousGlobals.extensionSettings;
}
if (lifecycleFailures.length) {
  throw new Error(lifecycleFailures.join('\n'));
}

console.log('[pass] extension smoke');
