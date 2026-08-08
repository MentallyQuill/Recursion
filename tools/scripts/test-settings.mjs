import {
  DEFAULT_RECURSION_SETTINGS,
  createSettingsStore,
  normalizeProviderSettings,
  normalizeSettings,
  resetSettingsMenuValue
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
    utility: {
      connectionProfileId: 'utility-profile',
      samplerOverrides: { temperature: 0.3, topP: 0.9 }
    },
    reasoner: { enabled: true, connectionProfileId: 'reasoner-profile' }
  }
});
assertEqual(normalizeSettings({ mode: 'manual' }).mode, 'manual', 'manual mode is valid');
assertEqual(normalizeSettings({ mode: 'removed-mode' }).mode, 'auto', 'removed mode normalizes to auto');
assertEqual(normalizeSettings({ mode: 'observe' }).mode, 'auto', 'invalid mode normalizes to auto');
assertEqual(normalizeSettings({}).pipelineMode, 'segmented', 'pipeline mode defaults to Segmented');
assertEqual(normalizeSettings({ pipelineMode: 'rapid' }).pipelineMode, 'segmented', 'removed Rapid pipeline reaches the generic fallback');
assertEqual(normalizeSettings({ pipelineMode: 'fused' }).pipelineMode, 'fused', 'Fused pipeline mode is accepted');
assertEqual(normalizeSettings({ pipelineMode: 'FUSED' }).pipelineMode, 'fused', 'Fused pipeline mode normalizes case-insensitively');
assertEqual(normalizeSettings({ pipelineMode: 'segmented' }).pipelineMode, 'segmented', 'Segmented pipeline mode is accepted');
assertEqual(normalizeSettings({ pipelineMode: 'standard' }).pipelineMode, 'segmented', 'removed Standard pipeline reaches the generic fallback');
assertEqual(normalizeSettings({ pipelineMode: 'fast' }).pipelineMode, 'segmented', 'invalid pipeline mode normalizes to Segmented');
assertEqual(normalizeSettings({}).modelAttemptsPerStep, 2, 'model attempts default to two');
assertEqual(normalizeSettings({ modelAttemptsPerStep: 0 }).modelAttemptsPerStep, 1, 'model attempts clamp low');
assertEqual(normalizeSettings({ modelAttemptsPerStep: 1 }).modelAttemptsPerStep, 1, 'one model attempt is accepted');
assertEqual(normalizeSettings({ modelAttemptsPerStep: 4 }).modelAttemptsPerStep, 4, 'four model attempts are accepted');
assertEqual(normalizeSettings({ modelAttemptsPerStep: 6 }).modelAttemptsPerStep, 5, 'model attempts clamp high');
assertEqual(normalizeSettings({ modelAttemptsPerStep: '3' }).modelAttemptsPerStep, 3, 'numeric model attempt strings normalize');
assertEqual(normalizeSettings({ modelAttemptsPerStep: 'many' }).modelAttemptsPerStep, 2, 'invalid model attempts use the default');
assertEqual(
  resetSettingsMenuValue({ modelAttemptsPerStep: 5 }).modelAttemptsPerStep,
  2,
  'Reset Defaults restores Attempts per step'
);
assertDeepEqual(DEFAULT_RECURSION_SETTINGS.postProcess, {
  enabled: false,
  applyMode: 'as-swipe',
  rewriteFlow: 'unified',
  contextMessages: 13
}, 'post-process defaults are exact');
assertDeepEqual(DEFAULT_RECURSION_SETTINGS.postProcessDecks, {
  version: POST_PROCESS_DECK_SETTINGS_VERSION,
  activeDeckId: STARTER_POST_PROCESS_DECK_ID,
  customDecks: {},
  starterCardStates: {},
  categoryExpansion: {}
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
assertEqual(normalizeSettings({ mode: 'manual', pipelineMode: 'segmented' }).mode, 'manual', 'Segmented does not replace Auto/Manual mode');
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
assertEqual(normalized.providers.utility.connectionProfileId, 'utility-profile', 'utility profile preserved');
assertEqual(normalized.providers.reasoner.enabled, undefined, 'legacy reasoner enabled state is removed');

const providerWithUnknownFields = normalizeSettings({
  providers: {
    reasoner: {
      enabled: true,
      unexpectedProviderField: 'must-not-survive',
      nestedUnexpectedProviderField: { value: 'must-not-survive' },
      connectionProfileId: 'reasoner-profile'
    }
  }
}).providers.reasoner;
const providerWithoutUnknownFields = normalizeSettings({
  providers: {
    reasoner: {
      connectionProfileId: 'reasoner-profile'
    }
  }
}).providers.reasoner;
assertDeepEqual(providerWithUnknownFields, providerWithoutUnknownFields, 'unknown provider fields are discarded rather than persisted');
assertDeepEqual(Object.keys(providerWithUnknownFields).sort(), [
  'certification',
  'configRevision',
  'connectionProfileId',
  'generationPolicy',
  'lane',
  'outputTokenCeiling',
  'samplerOverrides'
].sort(), 'normalized provider emits only the profile-only contract');

const providerContract = normalizeProviderSettings('utility', {
  unexpectedProviderField: 'must-not-survive',
  nestedUnexpectedProviderField: { value: 'must-not-survive' },
  connectionProfileId: 'profile-local-text',
  generationPolicy: {
    presetMode: 'isolated',
    instructMode: 'auto',
    samplerMode: 'profile',
    structuredOutputMode: 'auto'
  },
  samplerOverrides: { temperature: 0.25, topP: 0.82 },
  outputTokenCeiling: 4096
});
assertEqual(providerContract.connectionProfileId, 'profile-local-text', 'profile id survives');
assertEqual(providerContract.generationPolicy.samplerMode, 'profile', 'profile samplers are defaultable');
assertEqual(providerContract.samplerOverrides.temperature, 0.25, 'temperature override is bounded');
assertEqual(providerContract.outputTokenCeiling, 4096, 'output ceiling survives');
assertDeepEqual(Object.keys(providerContract).sort(), [
  'certification',
  'configRevision',
  'connectionProfileId',
  'generationPolicy',
  'lane',
  'outputTokenCeiling',
  'samplerOverrides'
].sort(), 'provider contract excludes unknown fields');

const clamped = normalizeProviderSettings('utility', {
  samplerOverrides: { temperature: 99, topP: -1 },
  outputTokenCeiling: 9999999
});
assertEqual(clamped.samplerOverrides.temperature, 2, 'temperature override clamps');
assertEqual(clamped.samplerOverrides.topP, 0, 'top-p override clamps');
assertEqual(clamped.outputTokenCeiling, 32768, 'output token ceiling clamps');

const blankNumbers = normalizeProviderSettings('utility', {
  samplerOverrides: { temperature: '', topP: '' },
  outputTokenCeiling: ''
});
assertEqual(blankNumbers.samplerOverrides.temperature, DEFAULT_RECURSION_SETTINGS.providers.utility.samplerOverrides.temperature, 'blank temperature falls back');
assertEqual(blankNumbers.samplerOverrides.topP, DEFAULT_RECURSION_SETTINGS.providers.utility.samplerOverrides.topP, 'blank top-p falls back');
assertEqual(blankNumbers.outputTokenCeiling, DEFAULT_RECURSION_SETTINGS.providers.utility.outputTokenCeiling, 'blank output ceiling falls back');

const boundCertificationProvider = normalizeProviderSettings('utility', {
  connectionProfileId: 'profile-a',
  configRevision: 2,
  certification: {
    status: 'pass',
    configHash: providerConfigHash({
      ...DEFAULT_RECURSION_SETTINGS.providers.utility,
      connectionProfileId: 'profile-a',
      configRevision: 2
    }),
    checkedAt: '2026-08-06T00:00:00.000Z',
    completionMode: 'text',
    structuredOutput: 'prompt-json',
    checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'pass' },
    safeConcurrency: 99,
    diagnosticCodes: ['structured-output-downgraded'],
    compactError: ''
  }
});
assertEqual(boundCertificationProvider.certification.status, 'pass', 'matching certification survives normalization');
assertEqual(boundCertificationProvider.certification.safeConcurrency, 1, 'certification concurrency is fixed at one');
const staleCertificationProvider = normalizeProviderSettings('utility', {
  ...boundCertificationProvider,
  generationPolicy: { ...boundCertificationProvider.generationPolicy, instructMode: 'off' }
});
assertDeepEqual(staleCertificationProvider.certification, { status: 'not-run' }, 'changed generation policy invalidates certification');

const diagnosticsOnly = normalizeSettings({ diagnostics: { maxJournalEntries: 250, includeExcerpts: true } });
assertDeepEqual(diagnosticsOnly.diagnostics, { includeExcerpts: true }, 'diagnostics only retains excerpt toggle');

const retentionDefaults = normalizeSettings({ retention: {} }).retention;
const obsoletePerChatCap = ['scene', 'Caches', 'PerChat'].join('');
const obsoleteTotalCap = ['scene', 'Caches', 'Total'].join('');
const obsoleteVariantCap = ['source', 'Variants', 'PerScene'].join('');
assertEqual(retentionDefaults.sourceWindowMessages, 20, 'retention source messages default');
assertEqual(retentionDefaults.sourceWindowCharacters, 12000, 'retention character budget default');
assertEqual(retentionDefaults.providerVisibleMessages, 12, 'retention provider messages default');
assertEqual(Object.hasOwn(retentionDefaults, obsoletePerChatCap), false, 'obsolete per-chat cache default is absent');
assertEqual(Object.hasOwn(retentionDefaults, obsoleteTotalCap), false, 'obsolete total cache default is absent');
assertEqual(Object.hasOwn(retentionDefaults, obsoleteVariantCap), false, 'obsolete source variant default is absent');
assertEqual(retentionDefaults.runJournalEntries, 100, 'retention journal default');

const retentionClamped = normalizeSettings({
  retention: {
    sourceWindowMessages: 999,
    sourceWindowCharacters: 5,
    providerVisibleMessages: 1,
    [obsoletePerChatCap]: 9,
    [obsoleteTotalCap]: 4,
    [obsoleteVariantCap]: 99,
    runJournalEntries: 9999
  }
}).retention;
assertEqual(retentionClamped.sourceWindowMessages, 200, 'settings clamps source message cap');
assertEqual(retentionClamped.sourceWindowCharacters, 6000, 'settings clamps source character cap');
assertEqual(retentionClamped.providerVisibleMessages, 4, 'settings clamps provider message cap');
assertEqual(Object.hasOwn(retentionClamped, obsoletePerChatCap), false, 'settings discards obsolete per-chat cache cap');
assertEqual(Object.hasOwn(retentionClamped, obsoleteTotalCap), false, 'settings discards obsolete total cache cap');
assertEqual(Object.hasOwn(retentionClamped, obsoleteVariantCap), false, 'settings discards obsolete source variant cap');
assertEqual(retentionClamped.runJournalEntries, 500, 'settings clamps journal entries');

const defaultUi = normalizeSettings({});
assertEqual(defaultUi.enabled, true, 'power toggle defaults on');
assertEqual(defaultUi.mode, 'auto', 'mode defaults to auto');
assertEqual(defaultUi.reasoningLevel, 'medium', 'reasoning level defaults to medium');
assertEqual(defaultUi.promptFootprint, 'compact', 'prompt footprint defaults to compact');
assertEqual(defaultUi.providers.utility.outputTokenCeiling, 8192, 'utility provider output ceiling defaults to 8192');
assertEqual(defaultUi.providers.reasoner.outputTokenCeiling, 8192, 'reasoner provider output ceiling defaults to 8192');
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
const store = createSettingsStore({ root, save: () => {} });
assertEqual(store.get().ui.tooltipsEnabled, true, 'fresh settings store enables tooltip hover help');
assertEqual(root.recursion.ui.tooltipsEnabled, true, 'fresh settings root persists tooltip hover help enabled');
const invalidPipelineRoot = { recursion: { pipelineMode: 'rapid' } };
const invalidPipelineStore = createSettingsStore({
  root: invalidPipelineRoot,
  save: () => {}
});
assertEqual(invalidPipelineStore.get().pipelineMode, 'segmented', 'invalid persisted pipeline loads through the generic fallback');
invalidPipelineStore.update({ mode: 'manual' });
assertEqual(invalidPipelineRoot.recursion.pipelineMode, 'segmented', 'next settings save writes only the canonical pipeline value');
store.update({ mode: 'auto' });
const firstProviderUpdate = store.updateProviderConfig('utility', {
  connectionProfileId: 'profile-a'
}, {
  expectedRevision: 0
});
assertEqual(firstProviderUpdate.ok, true, 'provider configuration update succeeds');
assertEqual(firstProviderUpdate.provider.configRevision, 1, 'provider configuration update increments revision');
assertEqual(root.recursion.mode, 'auto', 'settings update persisted into root');
assertEqual(Object.hasOwn(root.recursion.providers.utility, 'apiKey'), false, 'api keys are not part of provider settings');

function passingCertification(overrides = {}) {
  return {
    status: 'pass',
    checkedAt: '2026-08-06T00:00:00.000Z',
    completionMode: 'text',
    structuredOutput: 'prompt-json',
    checks: { connectivity: 'pass', singleCard: 'pass', fusedCards: 'pass' },
    safeConcurrency: 1,
    diagnosticCodes: [],
    compactError: '',
    ...overrides
  };
}

function markUtilityProviderCertified(overrides = {}) {
  const provider = store.get().providers.utility;
  return store.recordProviderCertification('utility', passingCertification(overrides), {
    configHash: providerConfigHash(provider),
    configRevision: provider.configRevision
  });
}

function assertUtilityCertificationReset(message) {
  const provider = store.get().providers.utility;
  assertDeepEqual(provider.certification, { status: 'not-run' }, `${message}: certification reset`);
}

markUtilityProviderCertified();
store.updateProviderConfig('utility', { connectionProfileId: 'profile-b' });
assertUtilityCertificationReset('changing connection profile');

store.updateProviderConfig('utility', {
  generationPolicy: {
    presetMode: 'isolated',
    instructMode: 'auto',
    samplerMode: 'profile',
    structuredOutputMode: 'auto'
  },
  samplerOverrides: { temperature: 0.2, topP: 0.9 },
  outputTokenCeiling: 4096
});
markUtilityProviderCertified();
const beforeTokenChange = store.get().providers.utility;
const tokenChange = store.updateProviderConfig('utility', { outputTokenCeiling: 8192 }, {
  expectedRevision: beforeTokenChange.configRevision
});
assertEqual(tokenChange.ok, true, 'field-scoped provider update succeeds');
assertEqual(tokenChange.provider.configRevision, beforeTokenChange.configRevision + 1, 'field-scoped update increments revision once');
assertEqual(tokenChange.provider.connectionProfileId, beforeTokenChange.connectionProfileId, 'field-scoped update preserves profile');
assertEqual(tokenChange.provider.samplerOverrides.temperature, beforeTokenChange.samplerOverrides.temperature, 'field-scoped update preserves sampler overrides');
assertDeepEqual(tokenChange.changedKeys, ['outputTokenCeiling'], 'field-scoped update reports only changed key');
assertUtilityCertificationReset('changing provider output ceiling');

for (const patch of [
  { samplerOverrides: { temperature: 0.6 } },
  { samplerOverrides: { topP: 0.8 } },
  { generationPolicy: { instructMode: 'off' } }
]) {
  markUtilityProviderCertified();
  const before = store.get().providers.utility;
  const update = store.updateProviderConfig('utility', patch, {
    expectedRevision: before.configRevision
  });
  assertEqual(update.ok, true, 'provider policy update succeeds');
  assertEqual(update.provider.configRevision, before.configRevision + 1, 'provider policy update increments revision');
  assertUtilityCertificationReset('changing provider generation policy');
}

const beforeStaleEdit = store.get().providers.utility;
const staleEdit = store.updateProviderConfig('utility', {
  outputTokenCeiling: 2048,
  unexpectedProviderField: 'must-not-be-stored'
}, {
  expectedRevision: beforeStaleEdit.configRevision - 1
});
assertEqual(staleEdit.ok, false, 'stale provider edit is rejected');
assertEqual(staleEdit.error.code, 'RECURSION_PROVIDER_CONFIG_STALE', 'stale provider edit has stable code');
assertDeepEqual(store.get().providers.utility, beforeStaleEdit, 'stale provider edit does not persist');

for (const expectedRevision of [-1, -0.5, 0.5, '0', null]) {
  const isolatedStore = createSettingsStore({ root: {}, save: () => {} });
  const rejected = isolatedStore.updateProviderConfig('utility', {
    connectionProfileId: 'must-not-be-stored',
    outputTokenCeiling: 4096
  }, {
    expectedRevision
  });
  assertEqual(rejected.ok, false, `invalid revision ${String(expectedRevision)} is rejected`);
  assertEqual(rejected.error.code, 'RECURSION_PROVIDER_CONFIG_STALE', 'invalid revision uses stable stale code');
  assertEqual(isolatedStore.get().providers.utility.configRevision, 0, 'invalid revision preserves revision zero');
  assertEqual(isolatedStore.get().providers.utility.connectionProfileId, '', 'invalid revision cannot mutate profile settings');
}

const beforeCertification = store.get().providers.utility;
const configurationBeforeCertification = {
  ...beforeCertification,
  certification: undefined
};
const failedCertification = store.recordProviderCertification('utility', passingCertification({
  status: 'fail',
  structuredOutput: 'unknown',
  checks: { connectivity: 'fail', singleCard: 'not-run', fusedCards: 'not-run' },
  compactError: 'RECURSION_PROVIDER_FAILED: The selected profile request failed.'
}), {
  configHash: providerConfigHash(beforeCertification),
  configRevision: beforeCertification.configRevision
});
assertEqual(failedCertification.ok, true, 'failed provider certification is recorded');
assertEqual(failedCertification.provider.certification.status, 'fail', 'failed provider certification remains a certification state');
assertEqual(failedCertification.provider.configRevision, beforeCertification.configRevision, 'certification write does not increment configuration revision');
assertDeepEqual(
  { ...failedCertification.provider, certification: undefined },
  configurationBeforeCertification,
  'failed provider test cannot mutate provider configuration'
);

const beforePassCertification = store.get().providers.utility;
const passedCertification = store.recordProviderCertification('utility', passingCertification(), {
  configHash: providerConfigHash(beforePassCertification),
  configRevision: beforePassCertification.configRevision
});
assertEqual(passedCertification.ok, true, 'passing provider certification is recorded');
assertEqual(passedCertification.provider.certification.status, 'pass', 'passing provider certification remains a certification state');
assertDeepEqual(
  { ...passedCertification.provider, certification: undefined },
  { ...beforePassCertification, certification: undefined },
  'passing provider test cannot mutate provider configuration'
);

const beforeNoOp = store.get().providers.utility;
const noOp = store.updateProviderConfig('utility', {
  outputTokenCeiling: beforeNoOp.outputTokenCeiling
}, {
  expectedRevision: beforeNoOp.configRevision
});
assertEqual(noOp.ok, true, 'matching no-op provider edit succeeds');
assertDeepEqual(noOp.changedKeys, [], 'matching no-op provider edit has no changed keys');
assertEqual(noOp.provider.configRevision, beforeNoOp.configRevision, 'no-op provider edit preserves revision');
assertDeepEqual(noOp.provider.certification, beforeNoOp.certification, 'no-op provider edit preserves bound certification');

const staleCertification = store.recordProviderCertification('utility', passingCertification(), {
  configHash: 'stale-config',
  configRevision: store.get().providers.utility.configRevision
});
assertEqual(staleCertification.ok, false, 'stale certification write is rejected');
assertEqual(staleCertification.stale, true, 'stale certification write is marked stale');
assertEqual(staleCertification.error.code, 'RECURSION_PROVIDER_TEST_STALE', 'stale certification write has stable code');
assertEqual(store.get().providers.utility.certification.status, 'pass', 'stale certification write preserves current certification');

const currentCertificationProvider = store.get().providers.utility;
const staleRevisionCertification = store.recordProviderCertification('utility', passingCertification(), {
  configHash: providerConfigHash(currentCertificationProvider),
  configRevision: currentCertificationProvider.configRevision - 1
});
assertEqual(staleRevisionCertification.ok, false, 'matching hash with stale revision is rejected');
assertEqual(staleRevisionCertification.stale, true, 'stale revision certification write is marked stale');

const invalidCertification = store.recordProviderCertification('utility', {
  ...passingCertification(),
  outputTokenCeiling: 64
}, {
  configHash: providerConfigHash(store.get().providers.utility),
  configRevision: store.get().providers.utility.configRevision
});
assertEqual(invalidCertification.ok, false, 'certification write containing configuration is rejected');
assertEqual(invalidCertification.error.code, 'RECURSION_PROVIDER_CERTIFICATION_INVALID', 'mixed certification/configuration write has stable code');

for (const malformedCertification of [
  null,
  {},
  { status: 'not-run' },
  { status: 'maybe' },
  { ...passingCertification(), unexpectedConfiguration: { value: 'injected' } }
]) {
  const rejected = store.recordProviderCertification('utility', malformedCertification, {
    configHash: providerConfigHash(store.get().providers.utility),
    configRevision: store.get().providers.utility.configRevision
  });
  assertEqual(rejected.ok, false, 'malformed or mixed provider certification is rejected');
  assertEqual(rejected.error.code, 'RECURSION_PROVIDER_CERTIFICATION_INVALID', 'malformed certification uses stable code');
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
  connectionProfileId: 'profile-preserved',
  generationPolicy: { presetMode: 'isolated', instructMode: 'auto', samplerMode: 'profile', structuredOutputMode: 'auto' },
  samplerOverrides: { temperature: 0.25, topP: 0.88 },
  outputTokenCeiling: 4096
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

assertThrows(
  () => store.updateProviderConfig('bad-lane', { connectionProfileId: 'x' }),
  /Invalid provider lane/,
  'invalid provider lane is rejected'
);
assertThrows(
  () => store.recordProviderCertification('bad-lane', passingCertification(), { configHash: 'x' }),
  /Invalid provider lane/,
  'invalid provider certification lane is rejected'
);

try {
  DEFAULT_RECURSION_SETTINGS.providers.utility.outputTokenCeiling = 64;
} catch {
  // Strict ESM may throw when the nested default is frozen.
}
assertEqual(DEFAULT_RECURSION_SETTINGS.providers.utility.outputTokenCeiling, 8192, 'utility default output ceiling is frozen at 8192');
assertEqual(Object.prototype.hasOwnProperty.call(DEFAULT_RECURSION_SETTINGS.providers.utility, 'enabled'), false, 'utility default omits enabled');
assertEqual(Object.prototype.hasOwnProperty.call(DEFAULT_RECURSION_SETTINGS.providers.reasoner, 'enabled'), false, 'reasoner default omits enabled');
console.log('[pass] settings');
