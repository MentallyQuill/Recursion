import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import {
  listSillyTavernConnectionProfiles,
  requireConnectionManagerService
} from '../../src/hosts/sillytavern/provider-profiles.mjs';
import {
  pickSafeSamplerPayload,
  projectProfileSamplerPayload
} from '../../src/hosts/sillytavern/profile-samplers.mjs';
import { resolveGenerationPolicy } from '../../src/providers/generation-policy.mjs';
import { createGenerationRouter, createProviderClient } from '../../src/providers.mjs';
import { createSettingsStore } from '../../src/settings.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

async function assertRejects(fn, code, message) {
  try {
    await fn();
  } catch (error) {
    assertEqual(error?.code, code, message);
    return error;
  }
  throw new Error(message);
}

const profile = {
  id: 'profile-text',
  name: 'Local Qwen',
  api: 'textgenerationwebui',
  model: 'qwen3-14b',
  preset: 'Local Precise',
  instruct: 'ChatML',
  'secret-id': 'must-not-leak',
  'api-url': 'http://127.0.0.1:5001'
};
const sendCalls = [];
const service = {
  getSupportedProfiles() { return [profile]; },
  getProfile(id) { return id === profile.id ? profile : null; },
  validateProfile() { return { selected: 'textgenerationwebui', type: 'koboldcpp' }; },
  async sendRequest(...args) {
    sendCalls.push(args);
    return { choices: [{ text: JSON.stringify({ schema: 'recursion.providerTest.v1', ok: true }) }] };
  }
};
const context = {
  ConnectionManagerRequestService: service,
  TextCompletionService: {
    TYPE: 'text',
    async presetToGeneratePayload() {
      return {
        temperature: 0.72,
        top_p: 0.88,
        top_k: 40,
        min_p: 0.06,
        rep_pen: 1.08,
        dry_multiplier: 0.4,
        max_tokens: 32768,
        stop: ['SECRET STOP'],
        model: 'private-model-name',
        api_server: 'http://private-host',
        secret_id: 'private-secret-id',
        messages: [{ role: 'system', content: 'poison' }],
        reasoning_effort: 'high'
      };
    }
  },
  getPresetManager() {
    return { getCompletionPresetByName(name) { return name === profile.preset ? { name } : null; } };
  },
  generateRaw() { throw new Error('generateRaw must not be used'); },
  generateQuietPrompt() { throw new Error('generateQuietPrompt must not be used'); }
};

assertEqual(requireConnectionManagerService(context), service, 'service guard returns the supported service');
for (const missing of ['getSupportedProfiles', 'getProfile', 'validateProfile', 'sendRequest']) {
  const partial = { ...service, [missing]: undefined };
  const error = await assertRejects(
    async () => requireConnectionManagerService({ ConnectionManagerRequestService: partial }),
    'RECURSION_CONNECTION_MANAGER_UNAVAILABLE',
    `missing ${missing} is a stable compatibility error`
  );
  assertEqual(error.retryable, false, `missing ${missing} is non-retryable`);
}

const profiles = listSillyTavernConnectionProfiles({ context });
assertDeepEqual(profiles, [{
  id: 'profile-text',
  name: 'Local Qwen',
  model: 'qwen3-14b',
  label: 'Local Qwen / qwen3-14b',
  api: 'textgenerationwebui',
  completionMode: 'text',
  presetName: 'Local Precise',
  instructName: 'ChatML'
}], 'profile list exposes only safe metadata');
assertEqual(JSON.stringify(profiles).includes('must-not-leak'), false, 'secret id is omitted');
assertEqual(JSON.stringify(profiles).includes('127.0.0.1'), false, 'endpoint is omitted');

assertDeepEqual(resolveGenerationPolicy({
  provider: {
    generationPolicy: {
      presetMode: 'isolated',
      instructMode: 'auto',
      samplerMode: 'profile',
      structuredOutputMode: 'auto'
    },
    certification: { structuredOutput: 'prompt-json' }
  },
  completionMode: 'text',
  request: {}
}), {
  includePreset: false,
  includeInstruct: true,
  samplerMode: 'profile',
  structuredOutputMethod: 'prompt-json'
}, 'text auto preserves instruct but not full preset');
assertEqual(resolveGenerationPolicy({
  provider: { generationPolicy: { instructMode: 'auto' } },
  completionMode: 'chat'
}).includeInstruct, false, 'Instruct Auto skips formatting for chat completion');
assertEqual(resolveGenerationPolicy({
  provider: {
    generationPolicy: { structuredOutputMode: 'auto' },
    certification: { structuredOutput: 'unknown' }
  }
}).structuredOutputMethod, 'prompt-json', 'Structured Output Auto is conservative before certification');
assertEqual(resolveGenerationPolicy({
  provider: {
    generationPolicy: { structuredOutputMode: 'auto' },
    certification: { structuredOutput: 'native-schema' }
  }
}).structuredOutputMethod, 'native-schema', 'Structured Output Auto uses certified native schema support');
assertEqual(resolveGenerationPolicy({
  provider: {
    generationPolicy: {
      presetMode: 'full-profile',
      instructMode: 'off',
      samplerMode: 'recursion',
      structuredOutputMode: 'native-schema'
    },
    certification: { structuredOutput: 'unknown' }
  },
  completionMode: 'chat',
  request: {}
}).includePreset, true, 'full profile mode is explicit');
assertEqual(resolveGenerationPolicy({
  provider: { generationPolicy: { structuredOutputMode: 'native-schema' } },
  completionMode: 'chat',
  request: { structuredOutputMethod: 'prompt-json' }
}).structuredOutputMethod, 'prompt-json', 'request retry override does not mutate persisted settings');

const projected = pickSafeSamplerPayload(await context.TextCompletionService.presetToGeneratePayload());
assertDeepEqual(projected, {
  temperature: 0.72,
  top_p: 0.88,
  top_k: 40,
  min_p: 0.06,
  rep_pen: 1.08,
  dry_multiplier: 0.4
}, 'only allowlisted sampler fields survive');
assertDeepEqual(await projectProfileSamplerPayload({
  context,
  profile,
  apiMap: service.validateProfile(profile)
}), projected, 'profile sampler projection materializes and projects the preset');

const host = createSillyTavernHost({
  contextFactory: () => context,
  settingsRoot: {},
  saveSettings: () => {}
});
const controller = new AbortController();
const response = await host.generation.generate({
  connectionProfileId: profile.id,
  prompt: 'Return JSON.',
  roleId: 'providerTest',
  responseSchema: 'recursion.providerTest.v1',
  providerConfig: {
    connectionProfileId: profile.id,
    generationPolicy: {
      presetMode: 'isolated',
      instructMode: 'auto',
      samplerMode: 'profile',
      structuredOutputMode: 'prompt-json'
    },
    samplerOverrides: { temperature: 0.1, topP: 0.95 },
    outputTokenCeiling: 128,
    certification: { status: 'not-run' }
  },
  responseLength: 128,
  structuredOutputMethod: 'prompt-json',
  signal: controller.signal
});
assert(response.raw || response.text, 'host returns a provider response envelope');
assertEqual(sendCalls.length, 1, 'Connection Manager is the only model transport');
assertEqual(sendCalls[0][0], profile.id, 'profile id is passed to Connection Manager');
assertEqual(sendCalls[0][3].signal, controller.signal, 'abort signal is in Connection Manager options');
assertEqual(sendCalls[0][3].includePreset, false, 'isolated mode excludes the full preset');
assertEqual(sendCalls[0][3].includeInstruct, true, 'text completion keeps instruct formatting');
assertEqual(sendCalls[0][3].extractData, false, 'Recursion owns structured recovery');
assertEqual(Object.hasOwn(sendCalls[0][4], 'json_schema'), false, 'prompt JSON omits native schema payload');
assertEqual(Object.hasOwn(sendCalls[0][4], 'messages'), false, 'override payload does not contain profile prompt content');

await assertRejects(
  () => host.generation.generate({ prompt: 'missing profile' }),
  'RECURSION_PROFILE_MISSING',
  'missing profile fails before fallback generation'
);

const settingsStore = createSettingsStore({
  root: { recursion: { providers: { utility: { connectionProfileId: profile.id } } } },
  save: () => {}
});
const client = createProviderClient({ host, settingsStore, fetchImpl: () => { throw new Error('direct HTTP forbidden'); } });
const providerResult = await client.generate('providerTest', { prompt: 'Return the provider test object.' });
assertEqual(Number.isFinite(providerResult.timings.hostPreparationMs), true, 'host setup has its own timing');
assertEqual(Number.isFinite(providerResult.timings.transportMs), true, 'transport time excludes queue and setup');
assertEqual(JSON.parse(providerResult.text).ok, true, 'provider client uses the host profile transport');
assertEqual(Object.hasOwn(client, 'fetchModels'), false, 'provider client exposes no direct model discovery');

const failureJournal = [];
const failingHost = createSillyTavernHost({
  contextFactory: () => ({ ...context, ConnectionManagerRequestService: {
    ...service,
    async sendRequest() {
      throw Object.assign(new Error('API request failed'), {
        status: 500,
        cause: Object.assign(new Error('Bearer PRIVATE_TOKEN http://private-endpoint PRIVATE_PROMPT PRIVATE_BODY'), {
          response: { status: 401, body: 'PRIVATE_BODY' },
          code: 'PRIVATE_UPSTREAM_CODE'
        })
      });
    }
  } }),
  settingsRoot: {}, saveSettings() {}
});
const failureRouter = createGenerationRouter({
  client: createProviderClient({ host: failingHost, settingsStore }),
  journal: entry => failureJournal.push(entry)
});
const failureResult = await failureRouter.generate('providerTest', { prompt: 'PRIVATE_PROMPT' });
assertEqual(failureResult.ok, false, 'failed host transport reaches router result');
assertEqual(failureResult.error.status, 401, 'nested HTTP status survives router sanitization');
assertEqual(failureResult.error.code, 'RECURSION_PROVIDER_AUTH_FAILED', 'nested authentication cause remains actionable');
assertEqual(failureResult.error.retryable, false, 'confirmed authentication failure cannot retry');
assertEqual(failureResult.diagnostics.model, 'qwen3-14b', 'failed transport retains configured model');
assertEqual(failureResult.diagnostics.providerSource, 'koboldcpp', 'failed transport retains configured provider');
const journalFailure = failureJournal.find(entry => entry.status === 'provider-failed');
assertEqual(journalFailure.error.status, 401, 'journal retains safe HTTP status');
assertEqual(journalFailure.model, 'qwen3-14b', 'journal retains configured model');
assertEqual(journalFailure.providerSource, 'koboldcpp', 'journal retains configured provider');
assert(Number.isFinite(journalFailure.timings.transportMs), 'failed transport retains duration');
const serializedFailure = JSON.stringify({ failureResult, failureJournal });
for (const secret of ['PRIVATE_TOKEN', 'private-endpoint', 'PRIVATE_PROMPT', 'PRIVATE_BODY', 'PRIVATE_UPSTREAM_CODE', 'must-not-leak', '127.0.0.1']) {
  assertEqual(serializedFailure.includes(secret), false, `failed result and journal exclude ${secret}`);
}

console.log('[pass] profile transport v1');
