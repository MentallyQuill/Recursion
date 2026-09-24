import { normalizePostProcessWriter, normalizePostProcessEditingScope, validatePostProcessWriter } from './post-process-editing.mjs';
export { normalizePostProcessWriter, normalizePostProcessEditingScope } from './post-process-editing.mjs';
import { cloneJson } from './core.mjs';
import { normalizeCardSelectionSettings } from './card-selection.mjs';
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
const PIPELINE_MODES = new Set(['segmented', 'fused']);
const POST_PROCESS_APPLY_MODES = new Set(['as-swipe', 'replace']);
const POST_PROCESS_REWRITE_FLOWS = new Set(['unified', 'progressive']);
const STRENGTHS = new Set(['light', 'balanced', 'strong']);
const REASONING_LEVELS = new Set(['low', 'medium', 'high', 'ultra']);
const FOOTPRINTS = new Set(['compact', 'normal', 'rich']);
const FOCUS = new Set(['balanced', 'character', 'constraints', 'scene', 'plot']);
const LANES = new Set(['utility', 'reasoner']);
const PROVIDER_PRESET_MODES = new Set(['isolated', 'full-profile']);
const PROVIDER_INSTRUCT_MODES = new Set(['auto', 'on', 'off']);
const PROVIDER_SAMPLER_MODES = new Set(['profile', 'recursion']);
const PROVIDER_STRUCTURED_OUTPUT_MODES = new Set(['auto', 'native-schema', 'prompt-json']);
const CERTIFICATION_STATUS = new Set(['not-run', 'pass', 'partial', 'fail']);
const CHECK_STATUS = new Set(['not-run', 'pass', 'fail']);
const COMPLETION_MODES = new Set(['unknown', 'chat', 'text']);
const STRUCTURED_METHODS = new Set(['unknown', 'native-schema', 'prompt-json']);
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
  pipelineMode: 'segmented',
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
  cardSelection: { variety: 'low', cooldownTurns: 0 },
  modelAttemptsPerStep: 2,
  requestDeadlineSeconds: 180,
  operationDeadlineSeconds: 300,
  reasoningLevel: 'medium',
  promptFootprint: 'compact',
  focus: 'balanced',
  reasonerUse: 'auto',
  storyFormOverride: 'auto',
  postProcess: {
    enabled: false,
    applyMode: 'as-swipe',
    rewriteFlow: 'unified',
    contextMessages: 13,
    writer: normalizePostProcessWriter(),
    editingScope: 'polish',
    reviewBeforeApplying: false
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
      connectionProfileId: '',
      generationPolicy: {
        presetMode: 'isolated',
        instructMode: 'auto',
        samplerMode: 'profile',
        structuredOutputMode: 'auto'
      },
      samplerOverrides: { temperature: 0.1, topP: 0.95 },
      outputTokenCeiling: 8192,
      maxConcurrentRequests: 2,
      configRevision: 0,
      certification: { status: 'not-run' }
    },
    reasoner: {
      lane: 'reasoner',
      connectionProfileId: '',
      generationPolicy: {
        presetMode: 'isolated',
        instructMode: 'auto',
        samplerMode: 'profile',
        structuredOutputMode: 'auto'
      },
      samplerOverrides: { temperature: 0.4, topP: 0.95 },
      outputTokenCeiling: 8192,
      maxConcurrentRequests: 2,
      configRevision: 0,
      certification: { status: 'not-run' }
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

function normalizeModelAttemptsPerStep(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RECURSION_SETTINGS.modelAttemptsPerStep;
  return Math.min(5, Math.max(1, parsed));
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
    writer: normalizePostProcessWriter(source.writer),
    editingScope: normalizePostProcessEditingScope(source.editingScope),
    reviewBeforeApplying: source.reviewBeforeApplying === true,
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
  if (isPlainObject(patch.postProcess) && Object.hasOwn(patch.postProcess, 'writer')) {
    result.postProcess.writer = validatePostProcessWriter(result.postProcess.writer);
  }
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

function normalizeProviderCertification(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const status = enumValue(source.status, CERTIFICATION_STATUS, 'not-run');
  if (status === 'not-run') return { status };
  return {
    status,
    configHash: String(source.configHash || '').slice(0, 16),
    checkedAt: String(source.checkedAt || '').slice(0, 80),
    completionMode: enumValue(source.completionMode, COMPLETION_MODES, 'unknown'),
    structuredOutput: enumValue(source.structuredOutput, STRUCTURED_METHODS, 'unknown'),
    checks: {
      connectivity: enumValue(source.checks?.connectivity, CHECK_STATUS, 'not-run'),
      singleCard: enumValue(source.checks?.singleCard, CHECK_STATUS, 'not-run'),
      fusedCards: enumValue(source.checks?.fusedCards, CHECK_STATUS, 'not-run'),
      concurrency: enumValue(source.checks?.concurrency, CHECK_STATUS, 'not-run')
    },
    safeConcurrency: source.checks?.concurrency === 'pass'
      ? Math.round(numberInRange(source.safeConcurrency, 1, 1, 3)) : 1,
    diagnosticCodes: [...new Set(
      (Array.isArray(source.diagnosticCodes) ? source.diagnosticCodes : [])
        .map((code) => String(code || '').slice(0, 120))
        .filter(Boolean)
    )].slice(0, 12),
    compactError: String(source.compactError || '').slice(0, 300)
  };
}

function providerConfiguration(provider = {}) {
  return {
    connectionProfileId: String(provider.connectionProfileId || ''),
    generationPolicy: {
      presetMode: String(provider.generationPolicy?.presetMode || ''),
      instructMode: String(provider.generationPolicy?.instructMode || ''),
      samplerMode: String(provider.generationPolicy?.samplerMode || ''),
      structuredOutputMode: String(provider.generationPolicy?.structuredOutputMode || '')
    },
    samplerOverrides: {
      temperature: Number(provider.samplerOverrides?.temperature),
      topP: Number(provider.samplerOverrides?.topP)
    },
    outputTokenCeiling: Number(provider.outputTokenCeiling),
    maxConcurrentRequests: Number(provider.maxConcurrentRequests),
    configRevision: nonNegativeInteger(provider.configRevision)
  };
}

function changedProviderConfigKeys(current = {}, next = {}) {
  const before = providerConfiguration(current);
  const after = providerConfiguration(next);
  const changed = [];
  if (before.connectionProfileId !== after.connectionProfileId) changed.push('connectionProfileId');
  for (const key of ['presetMode', 'instructMode', 'samplerMode', 'structuredOutputMode']) {
    if (before.generationPolicy[key] !== after.generationPolicy[key]) changed.push(`generationPolicy.${key}`);
  }
  if (before.samplerOverrides.temperature !== after.samplerOverrides.temperature) changed.push('samplerOverrides.temperature');
  if (before.samplerOverrides.topP !== after.samplerOverrides.topP) changed.push('samplerOverrides.topP');
  if (before.outputTokenCeiling !== after.outputTokenCeiling) changed.push('outputTokenCeiling');
  if (before.maxConcurrentRequests !== after.maxConcurrentRequests) changed.push('maxConcurrentRequests');
  return changed;
}

function pickProviderConfigPatch(patch = {}) {
  const source = isPlainObject(patch) ? patch : {};
  const result = {};
  if (Object.prototype.hasOwnProperty.call(source, 'connectionProfileId')) {
    result.connectionProfileId = source.connectionProfileId;
  }
  if (isPlainObject(source.generationPolicy)) {
    result.generationPolicy = {};
    for (const key of ['presetMode', 'instructMode', 'samplerMode', 'structuredOutputMode']) {
      if (Object.prototype.hasOwnProperty.call(source.generationPolicy, key)) {
        result.generationPolicy[key] = source.generationPolicy[key];
      }
    }
  }
  if (isPlainObject(source.samplerOverrides)) {
    result.samplerOverrides = {};
    if (Object.prototype.hasOwnProperty.call(source.samplerOverrides, 'temperature')) {
      result.samplerOverrides.temperature = source.samplerOverrides.temperature;
    }
    if (Object.prototype.hasOwnProperty.call(source.samplerOverrides, 'topP')) {
      result.samplerOverrides.topP = source.samplerOverrides.topP;
    }
  }
  if (Object.prototype.hasOwnProperty.call(source, 'outputTokenCeiling')) {
    result.outputTokenCeiling = source.outputTokenCeiling;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'maxConcurrentRequests')) {
    result.maxConcurrentRequests = source.maxConcurrentRequests;
  }
  return result;
}

export function normalizeProviderSettings(lane, value = {}) {
  const resolvedLane = LANES.has(lane) ? lane : 'utility';
  const defaults = DEFAULT_RECURSION_SETTINGS.providers[resolvedLane];
  const source = isPlainObject(value) ? value : {};
  const policy = isPlainObject(source.generationPolicy) ? source.generationPolicy : {};
  const samplerOverrides = isPlainObject(source.samplerOverrides) ? source.samplerOverrides : {};
  const normalized = {
    lane: resolvedLane,
    connectionProfileId: String(source.connectionProfileId ?? '').trim(),
    generationPolicy: {
      presetMode: enumValue(policy.presetMode, PROVIDER_PRESET_MODES, defaults.generationPolicy.presetMode),
      instructMode: enumValue(policy.instructMode, PROVIDER_INSTRUCT_MODES, defaults.generationPolicy.instructMode),
      samplerMode: enumValue(policy.samplerMode, PROVIDER_SAMPLER_MODES, defaults.generationPolicy.samplerMode),
      structuredOutputMode: enumValue(
        policy.structuredOutputMode,
        PROVIDER_STRUCTURED_OUTPUT_MODES,
        defaults.generationPolicy.structuredOutputMode
      )
    },
    samplerOverrides: {
      temperature: numberInRange(
        samplerOverrides.temperature,
        defaults.samplerOverrides.temperature,
        0,
        2
      ),
      topP: numberInRange(samplerOverrides.topP, defaults.samplerOverrides.topP, 0, 1)
    },
    outputTokenCeiling: Math.round(numberInRange(source.outputTokenCeiling, defaults.outputTokenCeiling, 128, 32768)),
    maxConcurrentRequests: Math.round(numberInRange(source.maxConcurrentRequests, defaults.maxConcurrentRequests, 1, 3)),
    configRevision: nonNegativeInteger(source.configRevision),
    certification: { status: 'not-run' }
  };
  const certification = normalizeProviderCertification(source.certification);
  if (
    certification.status !== 'not-run'
    && certification.configHash
    && certification.configHash === providerConfigHash(normalized)
  ) {
    normalized.certification = certification;
  }
  return normalized;
}

export function normalizeSettings(value = {}) {
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
    cardSelection: normalizeCardSelectionSettings(source.cardSelection),
    modelAttemptsPerStep: normalizeModelAttemptsPerStep(source.modelAttemptsPerStep),
    requestDeadlineSeconds: Math.min(600, Math.max(30, Math.round(Number(source.requestDeadlineSeconds) || 180))),
    operationDeadlineSeconds: Math.min(1800, Math.max(60, Math.round(Number(source.operationDeadlineSeconds) || 300))),
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
      utility: normalizeProviderSettings('utility', source.providers?.utility),
      reasoner: normalizeProviderSettings('reasoner', source.providers?.reasoner)
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

export function resetSettingsMenuValue(value = {}) {
  const current = normalizeSettings(value);
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
  });
}

export function createSettingsStore({ root = globalThis.extension_settings || {}, save = null } = {}) {
  if (!root.recursion || typeof root.recursion !== 'object') root.recursion = cloneJson(DEFAULT_RECURSION_SETTINGS);
  root.recursion = normalizeSettings(root.recursion);

  function persist(next) {
    root.recursion = normalizeSettings(next);
    if (typeof save === 'function') save();
    else if (typeof globalThis.saveSettingsDebounced === 'function') globalThis.saveSettingsDebounced();
    return cloneJson(root.recursion);
  }

  return {
    get() {
      root.recursion = normalizeSettings(root.recursion);
      return cloneJson(root.recursion);
    },
    update(patch = {}) {
      return persist(mergeSettingsPatch(root.recursion, patch));
    },
    resetSettingsMenu() {
      return persist(resetSettingsMenuValue(root.recursion));
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

      const configPatch = pickProviderConfigPatch(patch);
      const merged = mergePlainObjects(currentProvider, configPatch);
      const previewProvider = normalizeProviderSettings(resolvedLane, merged);
      const changedKeys = changedProviderConfigKeys(currentProvider, previewProvider);
      if (changedKeys.length === 0) {
        return { ok: true, provider: currentProvider, changedKeys };
      }

      const nextProvider = {
        ...merged,
        configRevision: currentProvider.configRevision + 1,
        certification: { status: 'not-run' }
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
    recordProviderCertification(lane, result = {}, { configHash = '', configRevision = -1 } = {}) {
      const resolvedLane = requireProviderLane(lane);
      const current = this.get();
      const provider = current.providers[resolvedLane];
      const allowedResultKeys = new Set([
        'status',
        'checkedAt',
        'completionMode',
        'structuredOutput',
        'checks',
        'safeConcurrency',
        'diagnosticCodes',
        'compactError'
      ]);
      if (
        !isPlainObject(result)
        || !new Set(['pass', 'partial', 'fail']).has(result.status)
        || Object.keys(result).some((key) => !allowedResultKeys.has(key))
      ) {
        return {
          ok: false,
          error: {
            code: 'RECURSION_PROVIDER_CERTIFICATION_INVALID',
            message: 'Provider certification results cannot change provider configuration.'
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
      const certification = normalizeProviderCertification({
        ...result,
        configHash: currentHash
      });
      const persistedProvider = persist({
        ...current,
        providers: {
          ...current.providers,
          [resolvedLane]: {
            ...provider,
            certification
          }
        }
      }).providers[resolvedLane];
      return { ok: true, provider: persistedProvider };
    }
  };
}
