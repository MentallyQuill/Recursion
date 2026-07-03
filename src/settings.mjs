import { cloneJson } from './core.mjs';
import { defaultCardScope, normalizeCardScope } from './card-scope.mjs';

const MODES = new Set(['auto', 'manual']);
const PIPELINE_MODES = new Set(['standard', 'rapid']);
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const DEFAULT_RECURSION_SETTINGS = deepFreeze({
  enabled: true,
  mode: 'auto',
  pipelineMode: 'standard',
  cardScope: defaultCardScope(),
  strength: 'balanced',
  minCards: 3,
  maxCards: 10,
  reasoningLevel: 'high',
  promptFootprint: 'normal',
  focus: 'balanced',
  reasonerUse: 'auto',
  injection: {
    placement: 'in_prompt',
    role: 'system',
    depth: 1
  },
  diagnostics: {
    maxJournalEntries: 100,
    includeExcerpts: false
  },
  providers: {
    utility: {
      lane: 'utility',
      enabled: true,
      source: 'host-current-model',
      hostConnectionProfileId: '',
      openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
      temperature: 0.1,
      topP: 0.95,
      maxTokens: 4096,
      lastTest: { status: 'not-run' }
    },
    reasoner: {
      lane: 'reasoner',
      enabled: false,
      source: 'host-current-model',
      hostConnectionProfileId: '',
      openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
      temperature: 0.4,
      topP: 0.95,
      maxTokens: 4096,
      lastTest: { status: 'not-run' }
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

function requireProviderLane(lane) {
  const resolvedLane = String(lane || '');
  if (!LANES.has(resolvedLane)) {
    throw new Error(`Invalid provider lane: ${resolvedLane || '(empty)'}`);
  }
  return resolvedLane;
}

function providerTestSignature(provider = {}) {
  return JSON.stringify({
    enabled: provider.enabled === true,
    source: String(provider.source || ''),
    hostConnectionProfileId: String(provider.hostConnectionProfileId || ''),
    baseUrl: String(provider.openAICompatible?.baseUrl || ''),
    model: String(provider.openAICompatible?.model || ''),
    sessionApiKeyPresent: provider.openAICompatible?.sessionApiKeyPresent === true,
    maxTokens: Number(provider.maxTokens) || 0
  });
}

function resetProviderTestState(provider) {
  return {
    ...provider,
    resolvedProviderLabel: '',
    resolvedModelLabel: '',
    lastTest: { status: 'not-run' }
  };
}

export function normalizeProviderSettings(lane, value = {}, secretStore = null) {
  const resolvedLane = LANES.has(lane) ? lane : 'utility';
  const defaults = DEFAULT_RECURSION_SETTINGS.providers[resolvedLane];
  const source = value && typeof value === 'object' ? value : {};
  const openAICompatible = source.openAICompatible && typeof source.openAICompatible === 'object'
    ? source.openAICompatible
    : {};
  const hasSecret = Boolean(secretStore?.get?.(resolvedLane));
  return {
    lane: resolvedLane,
    enabled: resolvedLane === 'utility' ? true : source.enabled === true,
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
    resolvedProviderLabel: String(source.resolvedProviderLabel || '').trim(),
    resolvedModelLabel: String(source.resolvedModelLabel || '').trim(),
    lastTest: {
      status: enumValue(source.lastTest?.status, new Set(['pass', 'fail', 'not-run']), 'not-run'),
      checkedAt: source.lastTest?.checkedAt ? String(source.lastTest.checkedAt) : undefined,
      compactError: source.lastTest?.compactError ? String(source.lastTest.compactError).slice(0, 300) : undefined
    }
  };
}

export function normalizeSettings(value = {}, secretStore = null) {
  const source = value && typeof value === 'object' ? value : {};
  const reasoningLevel = enumValue(source.reasoningLevel, REASONING_LEVELS, DEFAULT_RECURSION_SETTINGS.reasoningLevel);
  const cardBudget = normalizeCardBudgetSettings(source);
  return {
    enabled: source.enabled !== false,
    mode: enumValue(source.mode, MODES, DEFAULT_RECURSION_SETTINGS.mode),
    pipelineMode: enumValue(source.pipelineMode, PIPELINE_MODES, DEFAULT_RECURSION_SETTINGS.pipelineMode),
    cardScope: normalizeCardScope(source.cardScope),
    strength: enumValue(source.strength, STRENGTHS, DEFAULT_RECURSION_SETTINGS.strength),
    minCards: cardBudget.minCards,
    maxCards: cardBudget.maxCards,
    reasoningLevel,
    promptFootprint: enumValue(source.promptFootprint, FOOTPRINTS, DEFAULT_RECURSION_SETTINGS.promptFootprint),
    focus: enumValue(source.focus, FOCUS, DEFAULT_RECURSION_SETTINGS.focus),
    reasonerUse: reasonerUseForReasoningLevel(reasoningLevel),
    injection: normalizeInjectionSettings(source.injection),
    diagnostics: {
      maxJournalEntries: Math.round(numberInRange(source.diagnostics?.maxJournalEntries, 100, 10, 500)),
      includeExcerpts: source.diagnostics?.includeExcerpts === true
    },
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
      return persist(mergePlainObjects(root.recursion, patch));
    },
    updateProvider(lane, patch = {}) {
      const resolvedLane = requireProviderLane(lane);
      const current = this.get();
      const cleanPatch = { ...patch };
      const secretWasPatched = Object.prototype.hasOwnProperty.call(cleanPatch, 'apiKey');
      if (Object.prototype.hasOwnProperty.call(cleanPatch, 'apiKey')) {
        secretStore.set(resolvedLane, cleanPatch.apiKey);
        delete cleanPatch.apiKey;
      }
      let nextProvider = mergePlainObjects(current.providers[resolvedLane], cleanPatch);
      const normalizedNextProvider = normalizeProviderSettings(resolvedLane, nextProvider, secretStore);
      const providerConnectionChanged = providerTestSignature(current.providers[resolvedLane]) !== providerTestSignature(normalizedNextProvider);
      if (secretWasPatched || providerConnectionChanged) {
        nextProvider = resetProviderTestState(nextProvider);
      }
      return persist({
        ...current,
        providers: {
          ...current.providers,
          [resolvedLane]: nextProvider
        }
      }).providers[resolvedLane];
    },
    getApiKey(lane) {
      return secretStore.get(requireProviderLane(lane));
    },
    clearApiKey(lane) {
      const resolvedLane = requireProviderLane(lane);
      const current = this.get();
      secretStore.clear(resolvedLane);
      const nextProvider = resetProviderTestState(current.providers[resolvedLane]);
      return persist({
        ...current,
        providers: {
          ...current.providers,
          [resolvedLane]: nextProvider
        }
      }).providers[resolvedLane];
    }
  };
}
