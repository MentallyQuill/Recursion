import {
  DEFAULT_RECURSION_SETTINGS,
  createSessionSecretStore,
  createSettingsStore,
  normalizeProviderSettings,
  normalizeSettings
} from '../../src/settings.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

function assertThrows(fn, pattern, message) {
  try {
    fn();
  } catch (error) {
    const actual = String(error?.message || error);
    if (!pattern || pattern.test(actual)) return error;
    throw new Error(`${message}: unexpected error ${actual}`);
  }
  throw new Error(message);
}

const normalized = normalizeSettings({
  mode: 'auto',
  strength: 'strong',
  reasonerUse: 'auto',
  providers: {
    utility: { source: 'openai-compatible', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' }, temperature: 0.3 },
    reasoner: { enabled: true, source: 'host-current-model' }
  }
});
assertEqual(normalized.mode, 'auto', 'mode preserved');
assertEqual(normalized.providers.utility.openAICompatible.model, 'fast', 'utility model preserved');
assertEqual(normalized.providers.reasoner.enabled, true, 'reasoner enabled preserved');

const clamped = normalizeProviderSettings('utility', { temperature: 99, topP: -1, maxTokens: 9999999 });
assertEqual(clamped.temperature, 2, 'temperature clamped');
assertEqual(clamped.topP, 0, 'topP clamped');
assertEqual(clamped.maxTokens, 131072, 'maxTokens clamped');

const blankNumbers = normalizeProviderSettings('utility', { temperature: '', topP: '', maxTokens: '' });
assertEqual(blankNumbers.temperature, DEFAULT_RECURSION_SETTINGS.providers.utility.temperature, 'blank temperature falls back');
assertEqual(blankNumbers.topP, DEFAULT_RECURSION_SETTINGS.providers.utility.topP, 'blank topP falls back');
assertEqual(blankNumbers.maxTokens, DEFAULT_RECURSION_SETTINGS.providers.utility.maxTokens, 'blank maxTokens falls back');

const blankDiagnostics = normalizeSettings({ diagnostics: { maxJournalEntries: '' } });
assertEqual(blankDiagnostics.diagnostics.maxJournalEntries, DEFAULT_RECURSION_SETTINGS.diagnostics.maxJournalEntries, 'blank diagnostics max falls back');

const defaultUi = normalizeSettings({});
assertEqual(defaultUi.ui.progressChildVisibleLimit, 5, 'sub-tier visible item default is five');
assertEqual(defaultUi.ui.progressListVisibleLimit, 15, 'whole progress list visible item default is fifteen');

const clampedUi = normalizeSettings({ ui: { progressChildVisibleLimit: 99, progressListVisibleLimit: -10 } });
assertEqual(clampedUi.ui.progressChildVisibleLimit, 20, 'sub-tier visible item limit clamps high');
assertEqual(clampedUi.ui.progressListVisibleLimit, 5, 'whole progress list visible item limit clamps low');

const root = {};
const secrets = createSessionSecretStore();
const store = createSettingsStore({ root, secretStore: secrets });
store.update({ mode: 'auto' });
store.updateProvider('utility', { source: 'openai-compatible', apiKey: 'secret-key' });
assertEqual(root.recursion.mode, 'auto', 'settings update persisted into root');
assertEqual(root.recursion.providers.utility.apiKey, undefined, 'api key is not persisted');
assertEqual(secrets.get('utility'), 'secret-key', 'api key stored in session secret store');
assertEqual(store.get().providers.utility.openAICompatible.sessionApiKeyPresent, true, 'secret presence reflected');
store.clearApiKey('utility');
assertEqual(secrets.get('utility'), '', 'secret cleared');
assertEqual(store.get().providers.utility.openAICompatible.sessionApiKeyPresent, false, 'secret absence reflected');
assertEqual(root.recursion.providers.utility.openAICompatible.sessionApiKeyPresent, false, 'secret absence persisted');

store.updateProvider('utility', { openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' } });
store.updateProvider('utility', { openAICompatible: { model: 'new-model' } });
assertEqual(root.recursion.providers.utility.openAICompatible.baseUrl, 'http://localhost:1234/v1', 'partial provider update preserves baseUrl');
assertEqual(root.recursion.providers.utility.openAICompatible.model, 'new-model', 'partial provider update changes model');

function markUtilityProviderTestPass() {
  store.updateProvider('utility', {
    resolvedProviderLabel: 'stale-provider',
    resolvedModelLabel: 'stale-model',
    lastTest: {
      status: 'pass',
      checkedAt: '2026-07-01T00:00:00.000Z',
      compactError: 'stale error'
    }
  });
}

function assertUtilityProviderTestReset(message) {
  const provider = store.get().providers.utility;
  assertEqual(provider.lastTest.status, 'not-run', `${message}: status reset`);
  assertEqual(provider.lastTest.checkedAt, undefined, `${message}: checkedAt cleared`);
  assertEqual(provider.lastTest.compactError, undefined, `${message}: compactError cleared`);
  assertEqual(provider.resolvedProviderLabel, '', `${message}: provider label cleared`);
  assertEqual(provider.resolvedModelLabel, '', `${message}: model label cleared`);
}

store.updateProvider('utility', { source: 'openai-compatible', apiKey: 'test-key' });
markUtilityProviderTestPass();
store.clearApiKey('utility');
assertUtilityProviderTestReset('clearing provider session key');

store.updateProvider('utility', { source: 'openai-compatible', apiKey: 'test-key', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' } });
markUtilityProviderTestPass();
store.updateProvider('utility', { openAICompatible: { baseUrl: 'http://localhost:4321/v1' } });
assertUtilityProviderTestReset('changing provider base URL');

store.updateProvider('utility', { source: 'openai-compatible', apiKey: 'test-key', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' } });
markUtilityProviderTestPass();
store.updateProvider('utility', { openAICompatible: { model: 'slower' } });
assertUtilityProviderTestReset('changing provider model');

store.updateProvider('utility', { source: 'openai-compatible', apiKey: 'test-key', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' } });
markUtilityProviderTestPass();
store.updateProvider('utility', { source: 'host-current-model' });
assertUtilityProviderTestReset('changing provider source');

store.updateProvider('utility', { source: 'host-connection-profile', hostConnectionProfileId: 'profile-a' });
markUtilityProviderTestPass();
store.updateProvider('utility', { hostConnectionProfileId: 'profile-b' });
assertUtilityProviderTestReset('changing host connection profile');

store.updateProvider('utility', { source: 'openai-compatible', apiKey: 'test-key', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' }, maxTokens: 4096 });
markUtilityProviderTestPass();
store.updateProvider('utility', { maxTokens: 8192 });
assertUtilityProviderTestReset('changing provider token limit');

store.update({ diagnostics: { maxJournalEntries: 321 } });
store.update({ diagnostics: { includeExcerpts: true } });
assertEqual(root.recursion.diagnostics.maxJournalEntries, 321, 'partial diagnostics update preserves max entries');
assertEqual(root.recursion.diagnostics.includeExcerpts, true, 'partial diagnostics update changes includeExcerpts');

store.update({ ui: { progressChildVisibleLimit: 7 } });
store.update({ ui: { progressListVisibleLimit: 22 } });
assertEqual(root.recursion.ui.progressChildVisibleLimit, 7, 'partial UI update preserves sub-tier limit');
assertEqual(root.recursion.ui.progressListVisibleLimit, 22, 'partial UI update changes progress list limit');

assertThrows(
  () => store.updateProvider('bad-lane', { apiKey: 'x' }),
  /Invalid provider lane/,
  'invalid provider lane is rejected'
);
assertEqual(secrets.get('bad-lane'), '', 'invalid provider lane does not store a secret');

try {
  DEFAULT_RECURSION_SETTINGS.providers.utility.enabled = false;
} catch {
  // Strict ESM may throw when the nested default is frozen.
}
assert(DEFAULT_RECURSION_SETTINGS.providers.utility.enabled, 'utility default enabled');
console.log('[pass] settings');
