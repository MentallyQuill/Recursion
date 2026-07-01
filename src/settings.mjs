import { cloneJson } from './core.mjs';

const MODES = new Set(['off', 'observe', 'auto']);
const STRENGTHS = new Set(['light', 'balanced', 'strong']);
const FOOTPRINTS = new Set(['compact', 'normal', 'rich']);
const FOCUS = new Set(['balanced', 'character', 'continuity', 'prose', 'plot']);
const REASONER_USE = new Set(['off', 'auto', 'always']);
const SOURCES = new Set(['host-current-model', 'host-connection-profile', 'openai-compatible']);
const LANES = new Set(['utility', 'reasoner']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const DEFAULT_RECURSION_SETTINGS = deepFreeze({
  mode: 'observe',
  strength: 'balanced',
  promptFootprint: 'normal',
  focus: 'balanced',
  reasonerUse: 'auto',
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
    viewerOpen: false
  }
});

function enumValue(value, allowed, fallback) {
  const normalized = String(value ?? fallback).trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function numberInRange(value, fallback, min, max) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
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
  return {
    mode: enumValue(source.mode, MODES, DEFAULT_RECURSION_SETTINGS.mode),
    strength: enumValue(source.strength, STRENGTHS, DEFAULT_RECURSION_SETTINGS.strength),
    promptFootprint: enumValue(source.promptFootprint, FOOTPRINTS, DEFAULT_RECURSION_SETTINGS.promptFootprint),
    focus: enumValue(source.focus, FOCUS, DEFAULT_RECURSION_SETTINGS.focus),
    reasonerUse: enumValue(source.reasonerUse, REASONER_USE, DEFAULT_RECURSION_SETTINGS.reasonerUse),
    diagnostics: {
      maxJournalEntries: Math.round(numberInRange(source.diagnostics?.maxJournalEntries, 100, 10, 500)),
      includeExcerpts: source.diagnostics?.includeExcerpts === true
    },
    providers: {
      utility: normalizeProviderSettings('utility', source.providers?.utility, secretStore),
      reasoner: normalizeProviderSettings('reasoner', source.providers?.reasoner, secretStore)
    },
    ui: {
      viewerOpen: source.ui?.viewerOpen === true
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
