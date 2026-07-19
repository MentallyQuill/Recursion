import { cloneJson } from './core.mjs';
import { providerConfigHash } from './provider-capability.mjs';
import { PRE_PROCESS_DECK_SETTINGS_VERSION, DEFAULT_PRE_PROCESS_DECK_ID, normalizeCardDeckSettings } from './pre-process-decks.mjs';
import {
  POST_PROCESS_DECK_SETTINGS_VERSION,
  STARTER_POST_PROCESS_DECK_ID,
  normalizePostProcessDeckSettings
} from './post-process-decks.mjs';
import { DEFAULT_RETENTION_SETTINGS, normalizeRetentionSettings } from './retention-policy.mjs';
import { STORY_FORM_OVERRIDE_OPTIONS } from './story-form.mjs';

const MODES = new Set(['auto', 'manual']);
const PIPELINE_MODES = new Set(['standard', 'rapid', 'fused']);
const POST_PROCESS_APPLY_MODES = new Set(['as-swipe', 'replace']);
const POST_PROCESS_REWRITE_FLOWS = new Set(['unified', 'progressive']);
const STRENGTHS = new Set(['light', 'balanced', 'strong']);
const REASONING_LEVELS = new Set(['low', 'medium', 'high', 'ultra']);
const FOOTPRINTS = new Set(['compact', 'normal', 'rich']);
const FOCUS = new Set(['balanced', 'character', 'constraints', 'scene', 'plot']);
const SOURCES = new Set(['host-current-model', 'host-connection-profile', 'openai-compatible']);
const LANES = new Set(['utility', 'reasoner']);
const INJECTION_PLACEMENTS = new Set(['in_prompt', 'in_chat']);
const INJECTION_ROLES = new Set(['system', 'user', 'assistant']);
const UI_PROGRESS_CHILD_MIN = 1;
const UI_PROGRESS_CHILD_MAX = 20;
const UI_PROGRESS_LIST_MIN = 5;
const UI_PROGRESS_LIST_MAX = 80;
const CARD_BUDGET_MIN = 0;
const CARD_BUDGET_MAX = 20;
const POST_PROCESS_CONTEXT_MIN = 0;
const POST_PROCESS_CONTEXT_MAX = 35;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const DEFAULT_RECURSION_SETTINGS = deepFreeze({
  enabled: true,
  mode: 'auto',
  pipelineMode: 'standard',
  preProcessDecks: {
    version: PRE_PROCESS_DECK_SETTINGS_VERSION,
    activeDeckId: DEFAULT_PRE_PROCESS_DECK_ID,
    customDecks: {},
    defaultCardStates: {},
    categoryExpansion: {}
  },
  strength: 'balanced',
  minCards: 3,
  maxCards: 10,
  reasoningLevel: 'medium',
  promptFootprint: 'compact',
  focus: 'balanced',
  reasonerUse: 'auto',
  storyFormOverride: 'auto',
  postProcess: {
    enabled: false,
    applyMode: 'as-swipe',
    rewriteFlow: 'unified',
    contextMessages: 13
  },
  postProcessDecks: {
    version: POST_PROCESS_DECK_SETTINGS_VERSION,
    activeDeckId: STARTER_POST_PROCESS_DECK_ID,
    customDecks: {},
    starterCardStates: {},
    categoryExpansion: {}
  },
  injection: {
    placement: 'in_prompt',
    role: 'system',
    depth: 1
  },
  diagnostics: {
    includeExcerpts: false
  },
  retention: DEFAULT_RETENTION_SETTINGS,
  providers: {
    utility: {
      lane: 'utility',
      source: 'host-current-model',
      hostConnectionProfileId: '',
      openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
      temperature: 0.1,
      topP: 0.95,
      maxTokens: 8192,
      configRevision: 0,
      health: { status: 'not-run' }
    },
    reasoner: {
      lane: 'reasoner',
      source: 'host-current-model',
      hostConnectionProfileId: '',
      openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
      temperature: 0.4,
      topP: 0.95,
      maxTokens: 8192,
      configRevision: 0,
      health: { status: 'not-run' }
    }
  },
  ui: {
    viewerOpen: false,
    tooltipsEnabled: true,
    progressChildVisibleLimit: 5,
    progressListVisibleLimit: 15
  }
});

function enumValue(value, allowed, fallback) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function reasonerUseForReasoningLevel(value) {
  if (value === 'low') return 'off';
  if (value === 'medium' || value === 'high' || value === 'ultra') return 'always';
  return 'auto';
}

function numberInRange(value, fallback, min, max) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeCardBudgetSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const hasMinCards = Object.prototype.hasOwnProperty.call(source, 'minCards');
  const hasMaxCards = Object.prototype.hasOwnProperty.call(source, 'maxCards');
  const rawMin = Math.round(numberInRange(
    source.minCards,
    DEFAULT_RECURSION_SETTINGS.minCards,
    CARD_BUDGET_MIN,
    CARD_BUDGET_MAX
  ));
  const rawMax = Math.round(numberInRange(
    source.maxCards,
    DEFAULT_RECURSION_SETTINGS.maxCards,
    CARD_BUDGET_MIN,
    CARD_BUDGET_MAX
  ));
  if (hasMaxCards && !hasMinCards && rawMax < rawMin) {
    return {
      minCards: rawMax,
      normalCards: rawMax,
      maxCards: rawMax
    };
  }
  const minCards = Math.min(rawMin, rawMax);
  const maxCards = Math.max(rawMin, rawMax);
  return {
    minCards,
    normalCards: Math.floor((minCards + maxCards) / 2),
    maxCards
  };
}

function normalizeInjectionDepth(value) {
  const fallback = DEFAULT_RECURSION_SETTINGS.injection.depth;
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value) || typeof value === 'boolean' || typeof value === 'object') return fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || trimmed === 'default') return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(10, Math.max(0, number)));
}

export function normalizeInjectionSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    placement: enumValue(source.placement, INJECTION_PLACEMENTS, DEFAULT_RECURSION_SETTINGS.injection.placement),
    role: enumValue(source.role, INJECTION_ROLES, DEFAULT_RECURSION_SETTINGS.injection.role),
    depth: normalizeInjectionDepth(source.depth)
  };
}

export function normalizePostProcessSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled === true,
    applyMode: enumValue(source.applyMode, POST_PROCESS_APPLY_MODES, DEFAULT_RECURSION_SETTINGS.postProcess.applyMode),
    rewriteFlow: enumValue(source.rewriteFlow, POST_PROCESS_REWRITE_FLOWS, DEFAULT_RECURSION_SETTINGS.postProcess.rewriteFlow),
    contextMessages: Math.round(numberInRange(
      source.contextMessages,
      DEFAULT_RECURSION_SETTINGS.postProcess.contextMessages,
      POST_PROCESS_CONTEXT_MIN,
      POST_PROCESS_CONTEXT_MAX
    ))
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergePlainObjects(base, patch) {
  if (!isPlainObject(patch)) return base;
  const result = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? mergePlainObjects(result[key], value)
      : value;
  }
  return result;
}

function mergeSettingsPatch(base, patch) {
  const result = mergePlainObjects(base, patch);
  if (!isPlainObject(patch)) return result;
  if (Object.prototype.hasOwnProperty.call(patch, 'preProcessDecks')) {
    result.preProcessDecks = normalizeCardDeckSettings(patch.preProcessDecks);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'postProcessDecks')) {
    result.postProcessDecks = normalizePostProcessDeckSettings(patch.postProcessDecks);
  }
  const hasMinCards = Object.prototype.hasOwnProperty.call(patch, 'minCards');
  const hasMaxCards = Object.prototype.hasOwnProperty.call(patch, 'maxCards');
  if (hasMaxCards && !hasMinCards) {
    const maxCards = normalizeCardBudgetSettings({ minCards: 0, maxCards: patch.maxCards }).maxCards;
    const currentMin = normalizeCardBudgetSettings(base).minCards;
    if (maxCards < currentMin) result.minCards = maxCards;
  }
  if (hasMinCards && !hasMaxCards) {
    const minCards = normalizeCardBudgetSettings({ minCards: patch.minCards, maxCards: CARD_BUDGET_MAX }).minCards;
    const currentMax = normalizeCardBudgetSettings(base).maxCards;
    if (minCards > currentMax) result.maxCards = minCards;
  }
  return result;
}

function requireProviderLane(lane) {
  const resolvedLane = String(lane || '');
  if (!LANES.has(resolvedLane)) {
    throw new Error(`Invalid provider lane: ${resolvedLane || '(empty)'}`);
  }
  return resolvedLane;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function normalizeProviderHealth(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const status = enumValue(source.status, new Set(['pass', 'fail', 'not-run']), 'not-run');
  if (status === 'not-run') return { status };
  return {
    status,
    configHash: String(source.configHash || '').slice(0, 16),
    checkedAt: source.checkedAt ? String(source.checkedAt).slice(0, 80) : undefined,
    source: source.source ? String(source.source).slice(0, 80) : undefined,
    compactError: status === 'fail' && source.compactError
      ? String(source.compactError).slice(0, 300)
      : undefined
  };
}

function providerConfiguration(provider = {}) {
  return {
    source: String(provider.source || ''),
    hostConnectionProfileId: String(provider.hostConnectionProfileId || ''),
    openAICompatible: {
      baseUrl: String(provider.openAICompatible?.baseUrl || ''),
      model: String(provider.openAICompatible?.model || ''),
      sessionApiKeyPresent: provider.openAICompatible?.sessionApiKeyPresent === true
    },
    temperature: Number(provider.temperature),
    topP: Number(provider.topP),
    maxTokens: Number(provider.maxTokens),
    configRevision: nonNegativeInteger(provider.configRevision)
  };
}

function changedProviderConfigKeys(current = {}, next = {}, { secretChanged = false } = {}) {
  const before = providerConfiguration(current);
  const after = providerConfiguration(next);
  const changed = [];
  if (before.source !== after.source) changed.push('source');
  if (before.hostConnectionProfileId !== after.hostConnectionProfileId) changed.push('hostConnectionProfileId');
  if (before.openAICompatible.baseUrl !== after.openAICompatible.baseUrl) changed.push('openAICompatible.baseUrl');
  if (before.openAICompatible.model !== after.openAICompatible.model) changed.push('openAICompatible.model');
  if (before.openAICompatible.sessionApiKeyPresent !== after.openAICompatible.sessionApiKeyPresent || secretChanged) changed.push('apiKey');
  if (before.temperature !== after.temperature) changed.push('temperature');
  if (before.topP !== after.topP) changed.push('topP');
  if (before.maxTokens !== after.maxTokens) changed.push('maxTokens');
  return changed;
}

function pickProviderConfigPatch(patch = {}) {
  const source = isPlainObject(patch) ? patch : {};
  const result = {};
  if (Object.prototype.hasOwnProperty.call(source, 'source')) result.source = source.source;
  if (Object.prototype.hasOwnProperty.call(source, 'hostConnectionProfileId')) {
    result.hostConnectionProfileId = source.hostConnectionProfileId;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'temperature')) result.temperature = source.temperature;
  if (Object.prototype.hasOwnProperty.call(source, 'topP')) result.topP = source.topP;
  if (Object.prototype.hasOwnProperty.call(source, 'maxTokens')) result.maxTokens = source.maxTokens;
  if (isPlainObject(source.openAICompatible)) {
    result.openAICompatible = {};
    if (Object.prototype.hasOwnProperty.call(source.openAICompatible, 'baseUrl')) {
      result.openAICompatible.baseUrl = source.openAICompatible.baseUrl;
    }
    if (Object.prototype.hasOwnProperty.call(source.openAICompatible, 'model')) {
      result.openAICompatible.model = source.openAICompatible.model;
    }
  }
  return result;
}

export function normalizeProviderSettings(lane, value = {}, secretStore = null) {
  const resolvedLane = LANES.has(lane) ? lane : 'utility';
  const defaults = DEFAULT_RECURSION_SETTINGS.providers[resolvedLane];
  const source = value && typeof value === 'object' ? value : {};
  const openAICompatible = source.openAICompatible && typeof source.openAICompatible === 'object'
    ? source.openAICompatible
    : {};
  const hasSecret = Boolean(secretStore?.get?.(resolvedLane));
  const normalized = {
    lane: resolvedLane,
    source: enumValue(source.source, SOURCES, defaults.source),
    hostConnectionProfileId: String(source.hostConnectionProfileId ?? defaults.hostConnectionProfileId).trim(),
    openAICompatible: {
      baseUrl: String(openAICompatible.baseUrl ?? defaults.openAICompatible.baseUrl).trim(),
      model: String(openAICompatible.model ?? defaults.openAICompatible.model).trim(),
      sessionApiKeyPresent: hasSecret
    },
    temperature: numberInRange(source.temperature, defaults.temperature, 0, 2),
    topP: numberInRange(source.topP, defaults.topP, 0, 1),
    maxTokens: Math.round(numberInRange(source.maxTokens, defaults.maxTokens, 64, 131072)),
    configRevision: nonNegativeInteger(source.configRevision),
    health: { status: 'not-run' }
  };
  const health = normalizeProviderHealth(source.health);
  if (
    health.status !== 'not-run'
    && health.configHash
    && health.configHash === providerConfigHash(normalized)
  ) {
    normalized.health = health;
  }
  return normalized;
}

export function normalizeSettings(value = {}, secretStore = null) {
  const source = value && typeof value === 'object' ? value : {};
  const reasoningLevel = enumValue(source.reasoningLevel, REASONING_LEVELS, DEFAULT_RECURSION_SETTINGS.reasoningLevel);
  const cardBudget = normalizeCardBudgetSettings(source);
  const preProcessDecks = normalizeCardDeckSettings(source.preProcessDecks);
  return {
    enabled: source.enabled !== false,
    mode: enumValue(source.mode, MODES, DEFAULT_RECURSION_SETTINGS.mode),
    pipelineMode: enumValue(source.pipelineMode, PIPELINE_MODES, DEFAULT_RECURSION_SETTINGS.pipelineMode),
    preProcessDecks,
    strength: enumValue(source.strength, STRENGTHS, DEFAULT_RECURSION_SETTINGS.strength),
    minCards: cardBudget.minCards,
    maxCards: cardBudget.maxCards,
    reasoningLevel,
    promptFootprint: enumValue(source.promptFootprint, FOOTPRINTS, DEFAULT_RECURSION_SETTINGS.promptFootprint),
    focus: enumValue(source.focus, FOCUS, DEFAULT_RECURSION_SETTINGS.focus),
    reasonerUse: reasonerUseForReasoningLevel(reasoningLevel),
    storyFormOverride: enumValue(source.storyFormOverride, new Set(STORY_FORM_OVERRIDE_OPTIONS), DEFAULT_RECURSION_SETTINGS.storyFormOverride),
    postProcess: normalizePostProcessSettings(source.postProcess),
    postProcessDecks: normalizePostProcessDeckSettings(source.postProcessDecks),
    injection: normalizeInjectionSettings(source.injection),
    diagnostics: {
      includeExcerpts: source.diagnostics?.includeExcerpts === true
    },
    retention: normalizeRetentionSettings(source.retention),
    providers: {
      utility: normalizeProviderSettings('utility', source.providers?.utility, secretStore),
      reasoner: normalizeProviderSettings('reasoner', source.providers?.reasoner, secretStore)
    },
    ui: {
      viewerOpen: source.ui?.viewerOpen === true,
      tooltipsEnabled: source.ui?.tooltipsEnabled !== false,
      progressChildVisibleLimit: Math.round(numberInRange(
        source.ui?.progressChildVisibleLimit,
        DEFAULT_RECURSION_SETTINGS.ui.progressChildVisibleLimit,
        UI_PROGRESS_CHILD_MIN,
        UI_PROGRESS_CHILD_MAX
      )),
      progressListVisibleLimit: Math.round(numberInRange(
        source.ui?.progressListVisibleLimit,
        DEFAULT_RECURSION_SETTINGS.ui.progressListVisibleLimit,
        UI_PROGRESS_LIST_MIN,
        UI_PROGRESS_LIST_MAX
      ))
    }
  };
}

export function resetSettingsMenuValue(value = {}, secretStore = null) {
  const current = normalizeSettings(value, secretStore);
  const defaults = cloneJson(DEFAULT_RECURSION_SETTINGS);
  return normalizeSettings({
    ...defaults,
    enabled: current.enabled,
    mode: current.mode,
    pipelineMode: current.pipelineMode,
    reasoningLevel: current.reasoningLevel,
    storyFormOverride: current.storyFormOverride,
    preProcessDecks: current.preProcessDecks,
    postProcessDecks: current.postProcessDecks,
    providers: current.providers,
    ui: {
      ...defaults.ui,
      viewerOpen: current.ui.viewerOpen
    }
  }, secretStore);
}

export function createSessionSecretStore() {
  const memory = new Map();
  return {
    get(lane) {
      return memory.get(String(lane || '')) || '';
    },
    set(lane, value) {
      const key = String(lane || '');
      const secret = String(value || '');
      if (secret) memory.set(key, secret);
      else memory.delete(key);
      return Boolean(secret);
    },
    clear(lane) {
      memory.delete(String(lane || ''));
    }
  };
}

export function createSettingsStore({ root = globalThis.extension_settings || {}, secretStore = createSessionSecretStore(), save = null } = {}) {
  if (!root.recursion || typeof root.recursion !== 'object') root.recursion = cloneJson(DEFAULT_RECURSION_SETTINGS);
  root.recursion = normalizeSettings(root.recursion, secretStore);

  function persist(next) {
    root.recursion = normalizeSettings(next, secretStore);
    if (typeof save === 'function') save();
    else if (typeof globalThis.saveSettingsDebounced === 'function') globalThis.saveSettingsDebounced();
    return cloneJson(root.recursion);
  }

  return {
    get() {
      root.recursion = normalizeSettings(root.recursion, secretStore);
      return cloneJson(root.recursion);
    },
    update(patch = {}) {
      return persist(mergeSettingsPatch(root.recursion, patch));
    },
    resetSettingsMenu() {
      return persist(resetSettingsMenuValue(root.recursion, secretStore));
    },
    updateProviderConfig(lane, patch = {}, options = {}) {
      const resolvedLane = requireProviderLane(lane);
      const current = this.get();
      const currentProvider = current.providers[resolvedLane];
      const revisionRequired = Object.prototype.hasOwnProperty.call(options, 'expectedRevision');
      const expectedRevision = options.expectedRevision;
      if (
        revisionRequired
        && (
          !Number.isInteger(expectedRevision)
          || expectedRevision < 0
          || expectedRevision !== currentProvider.configRevision
        )
      ) {
        return {
          ok: false,
          error: {
            code: 'RECURSION_PROVIDER_CONFIG_STALE',
            message: 'Provider settings changed before this edit was saved.'
          }
        };
      }

      const apiKeyPatched = Object.prototype.hasOwnProperty.call(patch, 'apiKey');
      const nextApiKey = apiKeyPatched ? String(patch.apiKey || '') : secretStore.get(resolvedLane);
      const secretChanged = apiKeyPatched && nextApiKey !== secretStore.get(resolvedLane);
      const configPatch = pickProviderConfigPatch(patch);
      const merged = mergePlainObjects(currentProvider, configPatch);
      const previewSecretStore = {
        get(candidateLane) {
          return candidateLane === resolvedLane ? nextApiKey : secretStore.get(candidateLane);
        }
      };
      const previewProvider = normalizeProviderSettings(resolvedLane, merged, previewSecretStore);
      const changedKeys = changedProviderConfigKeys(currentProvider, previewProvider, { secretChanged });
      if (changedKeys.length === 0) {
        return { ok: true, provider: currentProvider, changedKeys };
      }

      if (apiKeyPatched) secretStore.set(resolvedLane, nextApiKey);
      const nextProvider = {
        ...merged,
        configRevision: currentProvider.configRevision + 1,
        health: { status: 'not-run' }
      };
      const provider = persist({
        ...current,
        providers: {
          ...current.providers,
          [resolvedLane]: nextProvider
        }
      }).providers[resolvedLane];
      return { ok: true, provider, changedKeys };
    },
    recordProviderHealth(lane, result = {}, { configHash = '', configRevision = -1 } = {}) {
      const resolvedLane = requireProviderLane(lane);
      const current = this.get();
      const provider = current.providers[resolvedLane];
      const forbiddenKeys = [
        'lane',
        'enabled',
        'hostConnectionProfileId',
        'openAICompatible',
        'temperature',
        'topP',
        'maxTokens',
        'configRevision',
        'health',
        'lastTest',
        'apiKey'
      ];
      if (
        !isPlainObject(result)
        || !new Set(['pass', 'fail']).has(result.status)
        || forbiddenKeys.some((key) => Object.prototype.hasOwnProperty.call(result, key))
      ) {
        return {
          ok: false,
          error: {
            code: 'RECURSION_PROVIDER_HEALTH_INVALID',
            message: 'Provider health results cannot change provider configuration.'
          }
        };
      }
      const currentHash = providerConfigHash(provider);
      if (
        !Number.isInteger(configRevision)
        || configRevision !== provider.configRevision
        || String(configHash || '') !== currentHash
      ) {
        return {
          ok: false,
          stale: true,
          error: {
            code: 'RECURSION_PROVIDER_TEST_STALE',
            message: 'Provider settings changed before the test completed.'
          }
        };
      }
      const health = normalizeProviderHealth({
        status: result.status,
        checkedAt: result.checkedAt,
        source: result.source,
        compactError: result.compactError,
        configHash: currentHash
      });
      const persistedProvider = persist({
        ...current,
        providers: {
          ...current.providers,
          [resolvedLane]: {
            ...provider,
            health
          }
        }
      }).providers[resolvedLane];
      return { ok: true, provider: persistedProvider };
    },
    getApiKey(lane) {
      return secretStore.get(requireProviderLane(lane));
    },
    clearApiKey(lane, options = {}) {
      const resolvedLane = requireProviderLane(lane);
      return this.updateProviderConfig(resolvedLane, { apiKey: '' }, options);
    }
  };
}
