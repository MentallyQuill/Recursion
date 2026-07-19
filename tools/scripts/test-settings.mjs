import {
  DEFAULT_RECURSION_SETTINGS,
  createSessionSecretStore,
  createSettingsStore,
  normalizeProviderSettings,
  normalizeSettings
} from '../../src/settings.mjs';
import { providerConfigHash } from '../../src/provider-capability.mjs';
import {
  PRE_PROCESS_DECK_SETTINGS_VERSION,
  DEFAULT_PRE_PROCESS_DECK_ID,
  createDraftCard,
  createCustomCardDeck,
  deleteCard,
  getActiveCardDeck,
  upsertCustomCardDeck
} from '../../src/pre-process-decks.mjs';
import {
  POST_PROCESS_DECK_SETTINGS_VERSION,
  STARTER_POST_PROCESS_DECK_ID,
  createCustomPostProcessDeck
} from '../../src/post-process-decks.mjs';
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
assertEqual(normalizeSettings({}).pipelineMode, 'standard', 'pipeline mode defaults to Standard');
assertEqual(normalizeSettings({ pipelineMode: 'rapid' }).pipelineMode, 'rapid', 'Rapid pipeline mode is accepted');
assertEqual(normalizeSettings({ pipelineMode: 'fused' }).pipelineMode, 'fused', 'Fused pipeline mode is accepted');
assertEqual(normalizeSettings({ pipelineMode: 'FUSED' }).pipelineMode, 'fused', 'Fused pipeline mode normalizes case-insensitively');
assertEqual(normalizeSettings({ pipelineMode: 'standard' }).pipelineMode, 'standard', 'Standard pipeline mode is accepted');
assertEqual(normalizeSettings({ pipelineMode: 'fast' }).pipelineMode, 'standard', 'invalid pipeline mode normalizes to Standard');
assertDeepEqual(DEFAULT_RECURSION_SETTINGS.postProcess, {
  enabled: false,
  applyMode: 'as-swipe',
  rewriteFlow: 'unified',
  contextMessages: 13
}, 'post-process defaults are exact');
assertDeepEqual(DEFAULT_RECURSION_SETTINGS.postProcessDecks, {
  version: POST_PROCESS_DECK_SETTINGS_VERSION,
  activeDeckId: STARTER_POST_PROCESS_DECK_ID,
  customDecks: {}
}, 'post-process deck defaults are exact');
assertDeepEqual(normalizeSettings({}).postProcess, DEFAULT_RECURSION_SETTINGS.postProcess, 'post-process remains Off by default');
assertEqual(normalizeSettings({}).postProcess.enabled, false, 'post-process feature defaults Off');
assertEqual(normalizeSettings({ postProcess: { enabled: true } }).postProcess.enabled, true, 'post-process feature can be enabled');
assertDeepEqual(
  normalizeSettings({ postProcess: { enabled: true, applyMode: 'REPLACE', rewriteFlow: 'PROGRESSIVE', contextMessages: '35' } }).postProcess,
  { enabled: true, applyMode: 'replace', rewriteFlow: 'progressive', contextMessages: 35 },
  'post-process settings normalize the V1 values'
);
assertDeepEqual(
  normalizeSettings({ postProcess: { enabled: true, applyMode: 'sidecar', rewriteFlow: 'per-card', contextMessages: '' } }).postProcess,
  { ...DEFAULT_RECURSION_SETTINGS.postProcess, enabled: true },
  'invalid post-process apply and flow values fall back safely'
);
assertEqual(normalizeSettings({ postProcess: { contextMessages: -3 } }).postProcess.contextMessages, 0, 'post-process context messages clamp low');
assertEqual(normalizeSettings({ postProcess: { contextMessages: 99 } }).postProcess.contextMessages, 35, 'post-process context messages clamp high');
const ignoredOldContracts = normalizeSettings({
  enhancements: { mode: 'redirect', target: 'on', applyMode: 'replace', contextMessages: 35 },
  cardDecks: { activeCardDeckId: 'legacy-deck', customCardDecks: { 'legacy-deck': { id: 'legacy-deck', name: 'Legacy' } } },
  cardScope: { families: { 'Open Threads': { enabled: false } } },
  postProcess: { target: 'on', mode: 'recompose' }
});
assert(!('enhancements' in ignoredOldContracts), 'old enhancements settings are ignored');
assert(!('cardDecks' in ignoredOldContracts), 'old cardDecks settings are ignored');
assert(!('cardScope' in ignoredOldContracts), 'legacy card scope is ignored');
assertDeepEqual(ignoredOldContracts.postProcess, DEFAULT_RECURSION_SETTINGS.postProcess, 'legacy enhancement targets and modes do not enable post-process');
assertDeepEqual(ignoredOldContracts.preProcessDecks, DEFAULT_RECURSION_SETTINGS.preProcessDecks, 'old cardDecks do not migrate into pre-process decks');
assertEqual(normalizeSettings({ mode: 'manual', pipelineMode: 'rapid' }).mode, 'manual', 'Rapid does not replace Auto/Manual mode');
assertEqual(normalizeSettings({ mode: 'manual', pipelineMode: 'fused' }).mode, 'manual', 'Fused does not replace Auto/Manual mode');
assertEqual(normalized.enabled, false, 'power toggle disabled state preserved');
assertEqual(normalizeSettings({ focus: 'constraints' }).focus, 'constraints', 'constraints focus is accepted');
assertEqual(normalizeSettings({ focus: 'scene' }).focus, 'scene', 'scene focus is accepted');
assertEqual(normalizeSettings({ focus: 'continuity' }).focus, 'balanced', 'removed continuity focus normalizes to balanced');
assertEqual(normalizeSettings({ focus: 'pr' + 'ose' }).focus, 'balanced', 'removed craft focus normalizes to balanced');
const normalizedDefaultDecks = normalizeSettings({}).preProcessDecks;
assertEqual(normalizedDefaultDecks.version, PRE_PROCESS_DECK_SETTINGS_VERSION, 'settings default card decks version is current');
assertEqual(normalizedDefaultDecks.activeDeckId, DEFAULT_PRE_PROCESS_DECK_ID, 'settings default pre-process deck is Default');

const cardDeckStoreRoot = { recursion: { preProcessDecks: createCustomCardDeck({}, { name: 'Delete Merge Test' }) } };
const cardDeckStore = createSettingsStore({ root: cardDeckStoreRoot, save: () => {} });
const seededDeck = createDraftCard(getActiveCardDeck(cardDeckStore.get()), '');
const seededCardId = Object.keys(seededDeck.cards).find((id) => seededDeck.cards[id].name === 'New Card');
cardDeckStore.update({ preProcessDecks: upsertCustomCardDeck(cardDeckStore.get(), seededDeck) });
assert(cardDeckStore.get().preProcessDecks.customDecks[seededDeck.id].cards[seededCardId], 'settings store card deck update can add draft card');
const deletedDeck = deleteCard(getActiveCardDeck(cardDeckStore.get()), seededCardId);
cardDeckStore.update({ preProcessDecks: upsertCustomCardDeck(cardDeckStore.get(), deletedDeck) });
assertEqual(cardDeckStore.get().preProcessDecks.customDecks[deletedDeck.id].cards[seededCardId], undefined, 'settings store replaces preProcessDecks so deleted cards do not survive deep merge');

const normalizedPartial = normalizeSettings({ mode: 'manual', cardScope: defaultCardScope() });
assertEqual(normalizedPartial.mode, 'manual', 'manual mode survives ignored legacy card scope');
assertEqual(normalizedPartial.cardScope, undefined, 'legacy cardScope is removed from normalized settings');
assertDeepEqual(normalizedPartial.preProcessDecks, DEFAULT_RECURSION_SETTINGS.preProcessDecks, 'legacy cardScope is not migrated');
assertDeepEqual(
  normalizeSettings({}).injection,
  { placement: 'in_prompt', role: 'system', depth: 1 },
  'injection defaults use the recommended concrete prompt placement'
);
assertDeepEqual(
  normalizeSettings({ injection: { placement: 'IN_CHAT', role: 'Assistant', depth: '3.6' } }).injection,
  { placement: 'in_chat', role: 'assistant', depth: 4 },
  'injection placement, role, and numeric-like depth normalize'
);
assertDeepEqual(
  normalizeSettings({ injection: { placement: 'bad', role: 'developer', depth: 'deep' } }).injection,
  { placement: 'in_prompt', role: 'system', depth: 1 },
  'invalid injection values fall back safely'
);
assertDeepEqual(
  normalizeSettings({ injection: { placement: 'default', role: 'system', depth: 'default' } }).injection,
  { placement: 'in_prompt', role: 'system', depth: 1 },
  'old default injection sentinels normalize to concrete settings'
);
assertEqual(normalizeSettings({ injection: { depth: -9 } }).injection.depth, 0, 'injection depth clamps low');
assertEqual(normalizeSettings({ injection: { depth: 99 } }).injection.depth, 10, 'injection depth clamps high');
assertEqual(normalizeSettings({ injection: { depth: '' } }).injection.depth, 1, 'blank injection depth falls back');
assertEqual(normalizeSettings({ injection: { depth: null } }).injection.depth, 1, 'null injection depth falls back');
assertEqual(normalizeSettings({ injection: { depth: true } }).injection.depth, 1, 'boolean injection depth falls back');
assertEqual(normalizeSettings({ injection: { depth: [] } }).injection.depth, 1, 'array injection depth falls back');
assertEqual(normalizeSettings({ injection: { depth: {} } }).injection.depth, 1, 'object injection depth falls back');
assertEqual(normalized.mode, 'auto', 'mode preserved');
assertEqual(normalized.reasoningLevel, 'ultra', 'reasoning level preserved');
assertEqual(normalized.reasonerUse, 'always', 'ultra reasoning derives always-on reasoner routing');
assertEqual(normalized.providers.utility.openAICompatible.model, 'fast', 'utility model preserved');
assertEqual(normalized.providers.reasoner.enabled, undefined, 'legacy reasoner enabled state is removed');

const migratedEnabledReasoner = normalizeSettings({
  providers: {
    reasoner: {
      enabled: true,
      source: 'host-connection-profile',
      hostConnectionProfileId: 'reasoner-profile'
    }
  }
}).providers.reasoner;
const migratedDisabledReasoner = normalizeSettings({
  providers: {
    reasoner: {
      enabled: false,
      source: 'host-connection-profile',
      hostConnectionProfileId: 'reasoner-profile'
    }
  }
}).providers.reasoner;
assertDeepEqual(migratedEnabledReasoner, migratedDisabledReasoner, 'legacy enabled values migrate to one provider contract');
assertEqual(Object.prototype.hasOwnProperty.call(migratedEnabledReasoner, 'enabled'), false, 'migrated provider omits enabled');
assertDeepEqual(
  normalizeSettings({
    providers: {
      reasoner: {
        source: 'host-connection-profile',
        hostConnectionProfileId: 'reasoner-profile',
        lastTest: { status: 'pass', checkedAt: '2026-07-01T00:00:00.000Z' }
      }
    }
  }).providers.reasoner.health,
  { status: 'not-run' },
  'legacy unbound test health migrates to not-run'
);

const clamped = normalizeProviderSettings('utility', { temperature: 99, topP: -1, maxTokens: 9999999 });
assertEqual(clamped.temperature, 2, 'temperature clamped');
assertEqual(clamped.topP, 0, 'topP clamped');
assertEqual(clamped.maxTokens, 131072, 'maxTokens clamped');

const blankNumbers = normalizeProviderSettings('utility', { temperature: '', topP: '', maxTokens: '' });
assertEqual(blankNumbers.temperature, DEFAULT_RECURSION_SETTINGS.providers.utility.temperature, 'blank temperature falls back');
assertEqual(blankNumbers.topP, DEFAULT_RECURSION_SETTINGS.providers.utility.topP, 'blank topP falls back');
assertEqual(blankNumbers.maxTokens, DEFAULT_RECURSION_SETTINGS.providers.utility.maxTokens, 'blank maxTokens falls back');

const diagnosticsOnly = normalizeSettings({ diagnostics: { maxJournalEntries: 250, includeExcerpts: true } });
assertDeepEqual(diagnosticsOnly.diagnostics, { includeExcerpts: true }, 'diagnostics only retains excerpt toggle');

const retentionDefaults = normalizeSettings({ retention: {} }).retention;
assertEqual(retentionDefaults.sourceWindowMessages, 20, 'retention source messages default');
assertEqual(retentionDefaults.sourceWindowCharacters, 12000, 'retention character budget default');
assertEqual(retentionDefaults.providerVisibleMessages, 12, 'retention provider messages default');
assertEqual(retentionDefaults.sceneCachesPerChat, 3, 'retention per-chat scene cache default');
assertEqual(retentionDefaults.sceneCachesTotal, 24, 'retention total scene cache default');
assertEqual(retentionDefaults.sourceVariantsPerScene, 4, 'retention source variant default');
assertEqual(retentionDefaults.runJournalEntries, 100, 'retention journal default');

const retentionClamped = normalizeSettings({
  retention: {
    sourceWindowMessages: 999,
    sourceWindowCharacters: 5,
    providerVisibleMessages: 1,
    sceneCachesPerChat: 9,
    sceneCachesTotal: 4,
    sourceVariantsPerScene: 99,
    runJournalEntries: 9999
  }
}).retention;
assertEqual(retentionClamped.sourceWindowMessages, 200, 'settings clamps source message cap');
assertEqual(retentionClamped.sourceWindowCharacters, 6000, 'settings clamps source character cap');
assertEqual(retentionClamped.providerVisibleMessages, 4, 'settings clamps provider message cap');
assertEqual(retentionClamped.sceneCachesTotal, 9, 'settings keeps total at least per-chat cap');
assertEqual(retentionClamped.sourceVariantsPerScene, 8, 'settings clamps source variants');
assertEqual(retentionClamped.runJournalEntries, 500, 'settings clamps journal entries');

const defaultUi = normalizeSettings({});
assertEqual(defaultUi.enabled, true, 'power toggle defaults on');
assertEqual(defaultUi.mode, 'auto', 'mode defaults to auto');
assertEqual(defaultUi.reasoningLevel, 'medium', 'reasoning level defaults to medium');
assertEqual(defaultUi.promptFootprint, 'compact', 'prompt footprint defaults to compact');
assertEqual(defaultUi.providers.utility.maxTokens, 8192, 'utility provider max tokens default to 8192');
assertEqual(defaultUi.providers.reasoner.maxTokens, 8192, 'reasoner provider max tokens default to 8192');
assertEqual(defaultUi.minCards, 3, 'minimum cards defaults to low reasoning card budget');
assertEqual(defaultUi.maxCards, 10, 'maximum cards defaults to ultra reasoning card budget');
assertEqual(defaultUi.ui.progressChildVisibleLimit, 5, 'sub-tier visible item default is five');
assertEqual(defaultUi.ui.progressListVisibleLimit, 15, 'whole progress list visible item default is fifteen');
assertEqual(defaultUi.ui.tooltipsEnabled, true, 'tooltips default on');
assertEqual(normalizeSettings({ ui: { tooltipsEnabled: false } }).ui.tooltipsEnabled, false, 'tooltip setting can disable hover help');
assertEqual(normalizeSettings({ minCards: '5', maxCards: '11' }).minCards, 5, 'minimum cards numeric strings normalize');
assertEqual(normalizeSettings({ minCards: '5', maxCards: '11' }).maxCards, 11, 'maximum cards numeric strings normalize');
assertDeepEqual(
  { minCards: normalizeSettings({ minCards: 14, maxCards: 4 }).minCards, maxCards: normalizeSettings({ minCards: 14, maxCards: 4 }).maxCards },
  { minCards: 4, maxCards: 14 },
  'card budget settings sort inverted min and max'
);
assertEqual(normalizeSettings({ minCards: -20, maxCards: 99 }).minCards, 0, 'minimum cards clamps low');
assertEqual(normalizeSettings({ minCards: -20, maxCards: 99 }).maxCards, 20, 'maximum cards clamps high');
const zeroMaxManual = normalizeSettings({ mode: 'manual', maxCards: 0 });
assertEqual(zeroMaxManual.maxCards, 0, 'stored Max Cards can remain zero for existing card budget semantics');
assert(zeroMaxManual.preProcessDecks, 'manual settings still normalize card decks');
const highMax = normalizeSettings({ mode: 'manual', maxCards: 50 });
assertEqual(highMax.maxCards, 20, 'Max Cards remains capped at twenty');

const invalidReasoning = normalizeSettings({ reasoningLevel: 'maximum' });
assertEqual(invalidReasoning.reasoningLevel, 'medium', 'invalid reasoning level falls back to medium');
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
assertEqual(store.get().ui.tooltipsEnabled, true, 'fresh settings store enables tooltip hover help');
assertEqual(root.recursion.ui.tooltipsEnabled, true, 'fresh settings root persists tooltip hover help enabled');
store.update({ mode: 'auto' });
const firstProviderUpdate = store.updateProviderConfig('utility', {
  source: 'openai-compatible',
  apiKey: 'secret-key'
}, {
  expectedRevision: 0
});
assertEqual(firstProviderUpdate.ok, true, 'provider configuration update succeeds');
assertEqual(firstProviderUpdate.provider.configRevision, 1, 'provider configuration update increments revision');
assertEqual(root.recursion.mode, 'auto', 'settings update persisted into root');
assertEqual(root.recursion.providers.utility.apiKey, undefined, 'api key is not persisted');
assertEqual(secrets.get('utility'), 'secret-key', 'api key stored in session secret store');
assertEqual(store.get().providers.utility.openAICompatible.sessionApiKeyPresent, true, 'secret presence reflected');
const clearedKey = store.clearApiKey('utility', { expectedRevision: 1 });
assertEqual(clearedKey.ok, true, 'session key clear uses configuration transaction');
assertEqual(clearedKey.provider.configRevision, 2, 'session key clear increments revision');
assertEqual(secrets.get('utility'), '', 'secret cleared');
assertEqual(store.get().providers.utility.openAICompatible.sessionApiKeyPresent, false, 'secret absence reflected');
assertEqual(root.recursion.providers.utility.openAICompatible.sessionApiKeyPresent, false, 'secret absence persisted');

store.updateProviderConfig('utility', {
  openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' }
});
store.updateProviderConfig('utility', { openAICompatible: { model: 'new-model' } });
assertEqual(root.recursion.providers.utility.openAICompatible.baseUrl, 'http://localhost:1234/v1', 'partial provider update preserves baseUrl');
assertEqual(root.recursion.providers.utility.openAICompatible.model, 'new-model', 'partial provider update changes model');

function markUtilityProviderTestPass() {
  const provider = store.get().providers.utility;
  return store.recordProviderHealth('utility', {
    status: 'pass',
    checkedAt: '2026-07-01T00:00:00.000Z',
    source: 'provider-test'
  }, {
    configHash: providerConfigHash(provider),
    configRevision: provider.configRevision
  });
}

function assertUtilityProviderHealthReset(message) {
  const provider = store.get().providers.utility;
  assertDeepEqual(provider.health, { status: 'not-run' }, `${message}: health reset`);
}

store.updateProviderConfig('utility', { source: 'openai-compatible', apiKey: 'test-key' });
markUtilityProviderTestPass();
store.clearApiKey('utility');
assertUtilityProviderHealthReset('clearing provider session key');

store.updateProviderConfig('utility', { source: 'openai-compatible', apiKey: 'test-key', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' } });
markUtilityProviderTestPass();
store.updateProviderConfig('utility', { openAICompatible: { baseUrl: 'http://localhost:4321/v1' } });
assertUtilityProviderHealthReset('changing provider base URL');

store.updateProviderConfig('utility', { source: 'openai-compatible', apiKey: 'test-key', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' } });
markUtilityProviderTestPass();
store.updateProviderConfig('utility', { openAICompatible: { model: 'slower' } });
assertUtilityProviderHealthReset('changing provider model');

store.updateProviderConfig('utility', { source: 'openai-compatible', apiKey: 'test-key', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' } });
markUtilityProviderTestPass();
store.updateProviderConfig('utility', { source: 'host-current-model' });
assertUtilityProviderHealthReset('changing provider source');

store.updateProviderConfig('utility', { source: 'host-connection-profile', hostConnectionProfileId: 'profile-a' });
markUtilityProviderTestPass();
store.updateProviderConfig('utility', { hostConnectionProfileId: 'profile-b' });
assertUtilityProviderHealthReset('changing host connection profile');

store.updateProviderConfig('utility', { source: 'openai-compatible', apiKey: 'test-key', openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'fast' }, maxTokens: 4096 });
markUtilityProviderTestPass();
const beforeTokenChange = store.get().providers.utility;
const tokenChange = store.updateProviderConfig('utility', { maxTokens: 8192 }, {
  expectedRevision: beforeTokenChange.configRevision
});
assertEqual(tokenChange.ok, true, 'field-scoped provider update succeeds');
assertEqual(tokenChange.provider.configRevision, beforeTokenChange.configRevision + 1, 'field-scoped update increments revision once');
assertEqual(tokenChange.provider.openAICompatible.model, beforeTokenChange.openAICompatible.model, 'field-scoped update preserves unrelated model');
assertEqual(tokenChange.provider.temperature, beforeTokenChange.temperature, 'field-scoped update preserves unrelated temperature');
assertDeepEqual(tokenChange.changedKeys, ['maxTokens'], 'field-scoped update reports only changed key');
assertUtilityProviderHealthReset('changing provider token limit');

for (const patch of [{ temperature: 0.6 }, { topP: 0.8 }]) {
  markUtilityProviderTestPass();
  const before = store.get().providers.utility;
  const update = store.updateProviderConfig('utility', patch, {
    expectedRevision: before.configRevision
  });
  assertEqual(update.ok, true, 'sampling configuration update succeeds');
  assertEqual(update.provider.configRevision, before.configRevision + 1, 'sampling configuration increments revision');
  assertUtilityProviderHealthReset('changing provider sampling configuration');
}

const beforeStaleEdit = store.get().providers.utility;
const secretBeforeStaleEdit = secrets.get('utility');
const staleEdit = store.updateProviderConfig('utility', {
  maxTokens: 2048,
  apiKey: 'must-not-be-stored'
}, {
  expectedRevision: beforeStaleEdit.configRevision - 1
});
assertEqual(staleEdit.ok, false, 'stale provider edit is rejected');
assertEqual(staleEdit.error.code, 'RECURSION_PROVIDER_CONFIG_STALE', 'stale provider edit has stable code');
assertDeepEqual(store.get().providers.utility, beforeStaleEdit, 'stale provider edit does not persist');
assertEqual(secrets.get('utility'), secretBeforeStaleEdit, 'stale provider edit does not mutate session secret');

for (const expectedRevision of [-1, -0.5, 0.5, '0', null]) {
  const isolatedSecrets = createSessionSecretStore();
  const isolatedStore = createSettingsStore({
    root: {},
    secretStore: isolatedSecrets,
    save: () => {}
  });
  const rejected = isolatedStore.updateProviderConfig('utility', {
    apiKey: 'must-not-be-stored',
    maxTokens: 4096
  }, {
    expectedRevision
  });
  assertEqual(rejected.ok, false, `invalid revision ${String(expectedRevision)} is rejected`);
  assertEqual(rejected.error.code, 'RECURSION_PROVIDER_CONFIG_STALE', 'invalid revision uses stable stale code');
  assertEqual(isolatedStore.get().providers.utility.configRevision, 0, 'invalid revision preserves revision zero');
  assertEqual(isolatedSecrets.get('utility'), '', 'invalid revision cannot mutate session secret');
}

const beforeHealth = store.get().providers.utility;
const configurationBeforeHealth = {
  ...beforeHealth,
  health: undefined
};
const failedHealth = store.recordProviderHealth('utility', {
  status: 'fail',
  checkedAt: '2026-07-17T21:00:39.857Z',
  compactError: 'Provider response reached its token ceiling.',
  source: 'provider-test'
}, {
  configHash: providerConfigHash(beforeHealth),
  configRevision: beforeHealth.configRevision
});
assertEqual(failedHealth.ok, true, 'failed provider health is recorded');
assertEqual(failedHealth.provider.health.status, 'fail', 'failed provider health remains a health state');
assertEqual(failedHealth.provider.configRevision, beforeHealth.configRevision, 'health write does not increment configuration revision');
assertDeepEqual(
  { ...failedHealth.provider, health: undefined },
  configurationBeforeHealth,
  'failed provider test cannot mutate provider configuration'
);

const beforePassHealth = store.get().providers.utility;
const passedHealth = store.recordProviderHealth('utility', {
  status: 'pass',
  checkedAt: '2026-07-17T21:00:59.857Z',
  source: 'provider-test'
}, {
  configHash: providerConfigHash(beforePassHealth),
  configRevision: beforePassHealth.configRevision
});
assertEqual(passedHealth.ok, true, 'passing provider health is recorded');
assertEqual(passedHealth.provider.health.status, 'pass', 'passing provider health remains a health state');
assertDeepEqual(
  { ...passedHealth.provider, health: undefined },
  { ...beforePassHealth, health: undefined },
  'passing provider test cannot mutate provider configuration'
);

const beforeNoOp = store.get().providers.utility;
const noOp = store.updateProviderConfig('utility', {
  maxTokens: beforeNoOp.maxTokens
}, {
  expectedRevision: beforeNoOp.configRevision
});
assertEqual(noOp.ok, true, 'matching no-op provider edit succeeds');
assertDeepEqual(noOp.changedKeys, [], 'matching no-op provider edit has no changed keys');
assertEqual(noOp.provider.configRevision, beforeNoOp.configRevision, 'no-op provider edit preserves revision');
assertDeepEqual(noOp.provider.health, beforeNoOp.health, 'no-op provider edit preserves bound health');

const staleHealth = store.recordProviderHealth('utility', {
  status: 'pass',
  checkedAt: '2026-07-17T21:01:00.000Z'
}, {
  configHash: 'stale-config',
  configRevision: store.get().providers.utility.configRevision
});
assertEqual(staleHealth.ok, false, 'stale health write is rejected');
assertEqual(staleHealth.stale, true, 'stale health write is marked stale');
assertEqual(staleHealth.error.code, 'RECURSION_PROVIDER_TEST_STALE', 'stale health write has stable code');
assertEqual(store.get().providers.utility.health.status, 'pass', 'stale health write preserves current health');

const currentHealthProvider = store.get().providers.utility;
const staleRevisionHealth = store.recordProviderHealth('utility', {
  status: 'fail',
  checkedAt: '2026-07-17T21:01:01.000Z'
}, {
  configHash: providerConfigHash(currentHealthProvider),
  configRevision: currentHealthProvider.configRevision - 1
});
assertEqual(staleRevisionHealth.ok, false, 'matching hash with stale revision is rejected');
assertEqual(staleRevisionHealth.stale, true, 'stale revision health write is marked stale');

const invalidHealth = store.recordProviderHealth('utility', {
  status: 'pass',
  maxTokens: 64
}, {
  configHash: providerConfigHash(store.get().providers.utility),
  configRevision: store.get().providers.utility.configRevision
});
assertEqual(invalidHealth.ok, false, 'health write containing configuration is rejected');
assertEqual(invalidHealth.error.code, 'RECURSION_PROVIDER_HEALTH_INVALID', 'mixed health/configuration write has stable code');

for (const malformedHealth of [
  null,
  {},
  { status: 'not-run' },
  { status: 'maybe' },
  { status: 'pass', openAICompatible: { model: 'injected-model' } }
]) {
  const rejected = store.recordProviderHealth('utility', malformedHealth, {
    configHash: providerConfigHash(store.get().providers.utility),
    configRevision: store.get().providers.utility.configRevision
  });
  assertEqual(rejected.ok, false, 'malformed or mixed provider health is rejected');
  assertEqual(rejected.error.code, 'RECURSION_PROVIDER_HEALTH_INVALID', 'malformed provider health uses stable code');
}

store.update({ diagnostics: { includeExcerpts: true } });
assertEqual(root.recursion.diagnostics.includeExcerpts, true, 'partial diagnostics update changes includeExcerpts');

store.update({ retention: { sourceWindowMessages: 64, runJournalEntries: 120 } });
assertEqual(root.recursion.retention.sourceWindowMessages, 64, 'partial retention update preserves source cap');
assertEqual(root.recursion.retention.runJournalEntries, 120, 'partial retention update preserves journal cap');

store.update({ reasoningLevel: 'medium' });
store.update({ strength: 'light' });
store.update({ minCards: 4 });
store.update({ maxCards: 12 });
assertEqual(root.recursion.reasoningLevel, 'medium', 'partial settings update preserves reasoning level');
assertEqual(root.recursion.strength, 'light', 'partial settings update changes strength');
assertEqual(root.recursion.minCards, 4, 'partial settings update changes minimum cards');
assertEqual(root.recursion.maxCards, 12, 'partial settings update preserves minimum cards and changes maximum cards');

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

store.update({ postProcess: { enabled: true } });
store.update({ postProcess: { applyMode: 'replace' } });
store.update({ postProcess: { rewriteFlow: 'progressive' } });
store.update({ postProcess: { contextMessages: 21 } });
assertDeepEqual(
  root.recursion.postProcess,
  { enabled: true, applyMode: 'replace', rewriteFlow: 'progressive', contextMessages: 21 },
  'partial post-process updates preserve the rest of the clean contract'
);

const preservedDecks = cardDeckStore.get().preProcessDecks;
const preservedPostProcessDecks = createCustomPostProcessDeck({}, {
  name: 'Reset Preserve Test',
  now: '2026-07-18T00:00:00.000Z'
});
store.update({
  enabled: false,
  mode: 'manual',
  pipelineMode: 'rapid',
  reasoningLevel: 'high',
  storyFormOverride: 'present-third-limited',
  preProcessDecks: preservedDecks,
  strength: 'strong',
  minCards: 8,
  maxCards: 16,
  focus: 'plot',
  promptFootprint: 'rich',
  injection: { placement: 'in_chat', role: 'assistant', depth: 8 },
  ui: { tooltipsEnabled: false, progressChildVisibleLimit: 12, progressListVisibleLimit: 40 },
  postProcess: { enabled: true, applyMode: 'replace', rewriteFlow: 'progressive', contextMessages: 30 },
  postProcessDecks: preservedPostProcessDecks,
  retention: { sourceWindowMessages: 80 },
  diagnostics: { includeExcerpts: true }
});
store.updateProviderConfig('utility', {
  source: 'openai-compatible',
  hostConnectionProfileId: 'profile-preserved',
  openAICompatible: { baseUrl: 'http://localhost:1234/v1', model: 'preserved-model' },
  apiKey: 'preserved-secret'
});
const beforeMenuReset = store.get();
const resetSettings = store.resetSettingsMenu();
assertDeepEqual(resetSettings.providers, beforeMenuReset.providers, 'menu reset preserves provider settings');
assertDeepEqual(resetSettings.preProcessDecks, beforeMenuReset.preProcessDecks, 'menu reset preserves custom pre-process decks');
assertDeepEqual(resetSettings.postProcessDecks, beforeMenuReset.postProcessDecks, 'menu reset preserves custom post-process decks');
assertEqual(resetSettings.preProcessDecks.activeDeckId, beforeMenuReset.preProcessDecks.activeDeckId, 'menu reset preserves active pre-process deck id');
assertEqual(resetSettings.postProcessDecks.activeDeckId, beforeMenuReset.postProcessDecks.activeDeckId, 'menu reset preserves active post-process deck id');
assertEqual(resetSettings.enabled, beforeMenuReset.enabled, 'menu reset preserves compact-bar enabled state');
assertEqual(resetSettings.mode, beforeMenuReset.mode, 'menu reset preserves compact-bar mode');
assertEqual(resetSettings.pipelineMode, beforeMenuReset.pipelineMode, 'menu reset preserves compact-bar pipeline');
assertEqual(resetSettings.reasoningLevel, beforeMenuReset.reasoningLevel, 'menu reset preserves reasoning level');
assertEqual(resetSettings.storyFormOverride, beforeMenuReset.storyFormOverride, 'menu reset preserves story form');
assertEqual(resetSettings.strength, DEFAULT_RECURSION_SETTINGS.strength, 'menu reset restores Play strength');
assertEqual(resetSettings.minCards, DEFAULT_RECURSION_SETTINGS.minCards, 'menu reset restores minimum cards');
assertEqual(resetSettings.maxCards, DEFAULT_RECURSION_SETTINGS.maxCards, 'menu reset restores maximum cards');
assertDeepEqual(resetSettings.injection, DEFAULT_RECURSION_SETTINGS.injection, 'menu reset restores injection settings');
assertDeepEqual(resetSettings.ui, { ...DEFAULT_RECURSION_SETTINGS.ui, viewerOpen: beforeMenuReset.ui.viewerOpen }, 'menu reset restores UI settings while preserving viewer state');
assertDeepEqual(resetSettings.postProcess, DEFAULT_RECURSION_SETTINGS.postProcess, 'menu reset restores post-process settings');
assertDeepEqual(resetSettings.retention, DEFAULT_RECURSION_SETTINGS.retention, 'menu reset restores retention settings');
assertDeepEqual(resetSettings.diagnostics, DEFAULT_RECURSION_SETTINGS.diagnostics, 'menu reset restores diagnostic settings');
assertEqual(secrets.get('utility'), 'preserved-secret', 'menu reset preserves provider session secret');

assertThrows(
  () => store.updateProviderConfig('bad-lane', { apiKey: 'x' }),
  /Invalid provider lane/,
  'invalid provider lane is rejected'
);
assertThrows(
  () => store.recordProviderHealth('bad-lane', { status: 'pass' }, { configHash: 'x' }),
  /Invalid provider lane/,
  'invalid provider health lane is rejected'
);
assertEqual(secrets.get('bad-lane'), '', 'invalid provider lane does not store a secret');

try {
  DEFAULT_RECURSION_SETTINGS.providers.utility.maxTokens = 64;
} catch {
  // Strict ESM may throw when the nested default is frozen.
}
assertEqual(DEFAULT_RECURSION_SETTINGS.providers.utility.maxTokens, 8192, 'utility default max tokens is frozen at 8192');
assertEqual(Object.prototype.hasOwnProperty.call(DEFAULT_RECURSION_SETTINGS.providers.utility, 'enabled'), false, 'utility default omits enabled');
assertEqual(Object.prototype.hasOwnProperty.call(DEFAULT_RECURSION_SETTINGS.providers.reasoner, 'enabled'), false, 'reasoner default omits enabled');
console.log('[pass] settings');
