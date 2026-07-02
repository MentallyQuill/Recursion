import {
  DEFAULT_RECURSION_SETTINGS,
  createSessionSecretStore,
  createSettingsStore,
  normalizeProviderSettings,
  normalizeSettings
} from '../../src/settings.mjs';
import {
  CARD_SCOPE_TOTAL_SUB_ITEMS,
  cardScopeCounts,
  defaultCardScope
} from '../../src/card-scope.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

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
  enabled: false,
  mode: 'auto',
  strength: 'strong',
  reasoningLevel: 'ultra',
  reasonerUse: 'auto',
  providers: {
    utility: { source: 'openai-compatible', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' }, temperature: 0.3 },
    reasoner: { enabled: true, source: 'host-current-model' }
  }
});
assertEqual(normalizeSettings({ mode: 'manual' }).mode, 'manual', 'manual mode is valid');
assertEqual(normalizeSettings({ mode: 'removed-mode' }).mode, 'auto', 'removed mode normalizes to auto');
assertEqual(normalizeSettings({ mode: 'observe' }).mode, 'auto', 'invalid mode normalizes to auto');
assertEqual(normalized.enabled, false, 'power toggle disabled state preserved');
const normalizedDefaultScope = normalizeSettings({}).cardScope;
assertEqual(cardScopeCounts(normalizedDefaultScope).selectedSubItems, CARD_SCOPE_TOTAL_SUB_ITEMS, 'settings default enables all card scope');

const partialScope = defaultCardScope();
partialScope.families['Prose/Pacing'].enabled = false;
for (const key of Object.keys(partialScope.families['Prose/Pacing'].subItems)) {
  partialScope.families['Prose/Pacing'].subItems[key] = false;
}
const normalizedPartial = normalizeSettings({ mode: 'manual', cardScope: partialScope });
assertEqual(normalizedPartial.mode, 'manual', 'manual mode survives card-scope normalization');
assertEqual(normalizedPartial.cardScope.families['Prose/Pacing'].enabled, false, 'disabled family persists');
assertDeepEqual(
  normalizeSettings({}).injection,
  { placement: 'default', role: 'system', depth: 'default' },
  'injection defaults preserve the packet template plan'
);
assertDeepEqual(
  normalizeSettings({ injection: { placement: 'IN_CHAT', role: 'Assistant', depth: '3.6' } }).injection,
  { placement: 'in_chat', role: 'assistant', depth: 4 },
  'injection placement, role, and numeric-like depth normalize'
);
assertDeepEqual(
  normalizeSettings({ injection: { placement: 'bad', role: 'developer', depth: 'deep' } }).injection,
  { placement: 'default', role: 'system', depth: 'default' },
  'invalid injection values fall back safely'
);
assertEqual(normalizeSettings({ injection: { depth: -9 } }).injection.depth, 0, 'injection depth clamps low');
assertEqual(normalizeSettings({ injection: { depth: 99 } }).injection.depth, 10, 'injection depth clamps high');
assertEqual(normalizeSettings({ injection: { depth: '' } }).injection.depth, 'default', 'blank injection depth falls back');
assertEqual(normalizeSettings({ injection: { depth: null } }).injection.depth, 'default', 'null injection depth falls back');
assertEqual(normalizeSettings({ injection: { depth: true } }).injection.depth, 'default', 'boolean injection depth falls back');
assertEqual(normalizeSettings({ injection: { depth: [] } }).injection.depth, 'default', 'array injection depth falls back');
assertEqual(normalizeSettings({ injection: { depth: {} } }).injection.depth, 'default', 'object injection depth falls back');
assertEqual(normalized.mode, 'auto', 'mode preserved');
assertEqual(normalized.reasoningLevel, 'ultra', 'reasoning level preserved');
assertEqual(normalized.reasonerUse, 'always', 'ultra reasoning derives always-on reasoner routing');
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
assertEqual(defaultUi.enabled, true, 'power toggle defaults on');
assertEqual(defaultUi.mode, 'auto', 'mode defaults to auto');
assertEqual(defaultUi.reasoningLevel, 'high', 'reasoning level defaults to high');
assertEqual(defaultUi.ui.progressChildVisibleLimit, 5, 'sub-tier visible item default is five');
assertEqual(defaultUi.ui.progressListVisibleLimit, 15, 'whole progress list visible item default is fifteen');
assertEqual(defaultUi.ui.tooltipsEnabled, true, 'tooltips default on');
assertEqual(normalizeSettings({ ui: { tooltipsEnabled: false } }).ui.tooltipsEnabled, false, 'tooltip setting can disable hover help');

const invalidReasoning = normalizeSettings({ reasoningLevel: 'maximum' });
assertEqual(invalidReasoning.reasoningLevel, 'high', 'invalid reasoning level falls back to high');
assertEqual(normalizeSettings({ reasoningLevel: 'low', reasonerUse: 'always' }).reasonerUse, 'off', 'low reasoning disables reasoner routing even when stale reasonerUse differs');
assertEqual(normalizeSettings({ reasoningLevel: 'medium', reasonerUse: 'off' }).reasonerUse, 'always', 'medium reasoning requires reasoner composition even when stale reasonerUse differs');
assertEqual(normalizeSettings({ reasoningLevel: 'high', reasonerUse: 'off' }).reasonerUse, 'always', 'high reasoning requires mixed reasoner routing even when stale reasonerUse differs');
assertEqual(normalizeSettings({ reasoningLevel: 'ultra', reasonerUse: 'off' }).reasonerUse, 'always', 'ultra reasoning keeps reasoner-heavy routing even when stale reasonerUse differs');

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

store.update({ reasoningLevel: 'medium' });
store.update({ strength: 'light' });
assertEqual(root.recursion.reasoningLevel, 'medium', 'partial settings update preserves reasoning level');
assertEqual(root.recursion.strength, 'light', 'partial settings update changes strength');

store.update({ ui: { progressChildVisibleLimit: 7 } });
store.update({ ui: { progressListVisibleLimit: 22 } });
store.update({ ui: { tooltipsEnabled: false } });
assertEqual(root.recursion.ui.progressChildVisibleLimit, 7, 'partial UI update preserves sub-tier limit');
assertEqual(root.recursion.ui.progressListVisibleLimit, 22, 'partial UI update changes progress list limit');
assertEqual(root.recursion.ui.tooltipsEnabled, false, 'partial UI update changes tooltip setting');

store.update({ injection: { placement: 'in_chat', role: 'assistant', depth: 8 } });
store.update({ injection: { depth: 2 } });
assertEqual(root.recursion.injection.placement, 'in_chat', 'partial injection update preserves placement');
assertEqual(root.recursion.injection.role, 'assistant', 'partial injection update preserves role');
assertEqual(root.recursion.injection.depth, 2, 'partial injection update changes depth');

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
