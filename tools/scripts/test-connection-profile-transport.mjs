import {
  listSillyTavernConnectionProfiles,
  requireConnectionManagerService
} from '../../src/hosts/sillytavern/provider-profiles.mjs';
import { createSillyTavernHost } from '../../src/hosts/sillytavern/host.mjs';
import { createMemoryStorageAdapter } from '../../src/storage.mjs';
import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

function assertThrows(fn, code, message) {
  try {
    fn();
  } catch (error) {
    assertEqual(error.code, code, message);
    assertEqual(error.retryable, false, `${message} is non-retryable`);
    return error;
  }
  throw new Error(message);
}

const calls = [];
const profiles = [{
  id: 'profile-text',
  name: 'Local Qwen',
  api: 'textgenerationwebui',
  model: 'qwen3-14b',
  preset: 'Local Precise',
  instruct: 'ChatML',
  'secret-id': 'must-not-leak',
  'api-url': 'http://127.0.0.1:5001'
}];
const service = {
  getSupportedProfiles() {
    return profiles;
  },
  getProfile(id) {
    return profiles.find((profile) => profile.id === id) || null;
  },
  validateProfile() {
    return { selected: 'textgenerationwebui', type: 'koboldcpp' };
  },
  async sendRequest(...args) {
    calls.push(args);
    return { choices: [{ text: '{"ok":true}' }] };
  }
};
const context = {
  ConnectionManagerRequestService: service,
  generateRawCalls: 0,
  generateQuietPromptCalls: 0,
  async generateRaw() {
    this.generateRawCalls += 1;
    return 'must-not-run';
  },
  async generateQuietPrompt() {
    this.generateQuietPromptCalls += 1;
    return 'must-not-run';
  }
};

assertEqual(requireConnectionManagerService(context), service, 'strict service guard returns the service');
assertDeepEqual(listSillyTavernConnectionProfiles({ context }), [{
  id: 'profile-text',
  name: 'Local Qwen',
  model: 'qwen3-14b',
  label: 'Local Qwen / qwen3-14b',
  api: 'textgenerationwebui',
  completionMode: 'text',
  presetName: 'Local Precise',
  instructName: 'ChatML'
}], 'profile list exposes only safe metadata');
assertEqual(JSON.stringify(listSillyTavernConnectionProfiles({ context })).includes('must-not-leak'), false, 'secret id is omitted');
assertEqual(JSON.stringify(listSillyTavernConnectionProfiles({ context })).includes('127.0.0.1'), false, 'endpoint is omitted');

for (const missing of ['getSupportedProfiles', 'getProfile', 'validateProfile', 'sendRequest']) {
  const invalidService = { ...service };
  delete invalidService[missing];
  assertThrows(
    () => requireConnectionManagerService({ ConnectionManagerRequestService: invalidService }),
    'RECURSION_CONNECTION_MANAGER_UNAVAILABLE',
    `missing ${missing} fails closed`
  );
}

const host = createSillyTavernHost({
  contextFactory: () => context,
  settingsRoot: {},
  saveSettings: () => {},
  storageAdapter: createMemoryStorageAdapter()
});
const controller = new AbortController();
const response = await host.generation.generate({
  connectionProfileId: 'profile-text',
  prompt: 'Return JSON.',
  systemPrompt: 'System.',
  responseLength: 128,
  signal: controller.signal
});
assertEqual(response.profile.id, 'profile-text', 'host response identifies the selected profile safely');
assertEqual(response.profile.completionMode, 'text', 'host response identifies completion mode');
assertEqual(calls.length, 1, 'Connection Manager is called once');
assertEqual(calls[0][0], 'profile-text', 'profile id is the first sendRequest argument');
assertEqual(calls[0][2], 128, 'bounded output length is passed');
assertEqual(calls[0][3].signal, controller.signal, 'abort signal is in Connection Manager options');
assertEqual(calls[0][3].extractData, false, 'raw provider envelope is preserved');
assertEqual(calls[0][3].includePreset, false, 'behavioral preset is isolated');
assertEqual(calls[0][3].includeInstruct, true, 'text instruct formatting is retained');
assertEqual(context.generateRawCalls, 0, 'Recursion never falls back to generateRaw');
assertEqual(context.generateQuietPromptCalls, 0, 'Recursion never falls back to quiet prompt');

let missingProfileError = null;
try {
  await host.generation.generate({ prompt: 'Missing profile.' });
} catch (error) {
  missingProfileError = error;
}
assertEqual(missingProfileError?.code, 'RECURSION_PROFILE_MISSING', 'missing profile is explicit');
assertEqual(context.generateRawCalls, 0, 'missing profile does not invoke generateRaw');
assertEqual(context.generateQuietPromptCalls, 0, 'missing profile does not invoke quiet prompt');

console.log('[pass] connection profile transport');
