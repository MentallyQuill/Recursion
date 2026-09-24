import { createActivityReporter } from './activity.mjs';
import { createCardRefinementStages, hasCardRefinement, REFINED_HAND_STAGE_ID } from './runtime/card-refinement-stages.mjs';
import { failureFromError } from './failures.mjs';
import { normalizeFusedRejections, fusedRejectionReason } from './fused-recovery.mjs';
import {
  CARD_CATALOG,
  applyCardPlan,
  buildCardRequests,
  buildFusedCardBundleRequest,
  cardsFromFusedProviderResult,
  cardsFromProviderResult,
  limitCardJobsForHandBudget,
  normalizeCard,
  providerCardRejectReason,
  selectHand
} from './cards.mjs';
import {
  CARD_SCOPE_CATALOG,
  cardScopeSummary,
  enforceManualSelectionCap,
  filterCardJobsForScope,
  filterCardsForScope,
  normalizeCardScope,
  scopePayloadForArbiter
} from './card-scope.mjs';
import {
  activeCardDeckRuntimeScope,
  activeCardDeckEligibility,
  activeCardDeckSourceCards,
  activeCardDeckAuthoredCards,
  deckPriorityCardIds,
  deckPriorityFamilies,
  getActiveCardDeck,
  normalizeCardDeckSettings
} from './pre-process-decks.mjs';
import { compact, hashJson, makeId, nowIso, redact, truncate } from './core.mjs';
import { boundEnhancementMessages, buildContextContract, contextMessageIdentity } from './context-contract.mjs';
import { enhancementContextFromSnapshot } from './enhancement-context.mjs';
import { ENHANCEMENT_EDIT_RATIO_MINIMUM, roundedEnhancementEditRatio } from './enhancement-metrics.mjs';
import {
  buildGuidanceCorrectionRequest,
  buildGuidanceStageRequest,
  composeGuidanceForCards,
  composePromptPacket,
  GUIDANCE_SCHEMA as PROMPT_GUIDANCE_SCHEMA,
  PROMPT_PACKET_VERSION,
  validateGuidanceStageResult,
  validatePromptPacket
} from './prompt.mjs';
import { PROVIDER_CONTRACT_HASH } from './providers.mjs';
import { certifyConnectionProfile } from './providers/profile-certification.mjs';
import {
  providerConfigHash,
  resolveProviderCapability,
  sanitizeProviderCapability
} from './provider-capability.mjs';
import { reasoningRequestMetadata } from './reasoning-policy.mjs';
import { createSettingsStore, normalizeCardBudgetSettings, normalizeInjectionSettings, normalizeSettings } from './settings.mjs';
import { behaviorPolicyPromptLines, influencePolicyForSettings, runPolicyForEffectivePlan } from './settings-policy.mjs';
import { STORY_FORM_SCHEMA, UNKNOWN_STORY_FORM, arbiterStoryFormContractLine, forcedStoryForm, normalizeStoryForm, normalizeStoryFormWithHeuristic } from './story-form.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from './storage.mjs';
import { normalizeRetentionSettings } from './retention-policy.mjs';
import { asObject } from './safe-values.mjs';
import { createPostProcessRuntime } from './post-process-runtime.mjs';
import { createPipelineRun } from './execution/checkpoints.mjs';
import { settleOperationClock } from './execution/operation-budget.mjs';
import { createExecutionScheduler } from './execution/scheduler.mjs';
import { createExecutionGraph } from './execution/stage-registry.mjs';
import {
  QUEUED_REPROCESS_SCHEMA,
  bindQueuedReprocess,
  mergeQueuedReprocess,
  normalizeQueuedReprocess
} from './execution/queued-reprocess.mjs';
import { buildRunProvenance, compareRunProvenance } from './execution/provenance.mjs';
import {
  applyGenerationReviewPatches,
  buildGenerationReviewRequest,
  buildGenerationReviewTargets,
  generationReviewKey,
  generationReviewSnapshotHash,
  publicGenerationReviewSnapshot,
  validateGenerationReviewResult
} from './generation-review.mjs';
import {
  REDIRECT_ERROR_CODES,
  applyEditorialArtifact,
  buildRedirectEffectivenessRequest,
  buildEditorialDiagnosisRequest,
  buildEditorialEvidence,
  buildEditorialPassRequest,
  buildEditorialVerificationRequest,
  editorialCardAuditDiagnostics,
  editorialPassKey,
  editorialVerificationRequired,
  mergeRepairCardAudit,
  validateEditorialDiagnosis,
  validateEditorialPass,
  validateEditorialVerification,
  validateRedirectEffectiveness
} from './editorial-transform.mjs';
import { failureFrom } from './failures.mjs';
import { buildDiagnosticsPayload } from './runtime/diagnostics.mjs';
import {
  clearJournalDetails,
  clearJournalSummary,
  clearPromptBestEffort,
  clearWarningDetails,
  installJournalDetails,
  installPrompt,
  promptInstallFailure,
  installSummary,
  sanitizePromptError
} from './runtime/prompt-install.mjs';
import { runFusedCardPipeline } from './runtime/pipelines/fused.mjs';
import { runSegmentedCardPipeline } from './runtime/pipelines/segmented.mjs';
import {
  createFusedCardStages,
  createSegmentedCardStages
} from './runtime/preprocess-graph.mjs';
import {
  PREPARED_GENERATION_VERSION,
  compareGenerationBasis,
  createPreparedGenerationArtifact,
  preparedGenerationIntegrityIsValid,
  validatePreparedGenerationArtifact
} from './runtime/prepared-generation.mjs';
import { createRuntimeRunState } from './runtime/run-state.mjs';
import { resolveEffectivePipelineMode } from './runtime/pipeline-policy.mjs';
import { compactArbiterScope } from './runtime/preprocess-policy.mjs';
import { createTurnTimingTracker } from './runtime/turn-timing.mjs';
import {
  classifyGeneration,
  createTurnIdentity,
  normalizeNativeGenerationType
} from './runtime/turn-scope.mjs';

const UTILITY_ARBITER_SCHEMA = 'recursion.utilityArbiter.v1';
const PROVIDER_TEST_TIMEOUT_MS = 30000;
const STORAGE_SCHEMA_VERSION = 1;
const RUNTIME_CACHE_CONTRACT_VERSION = 4;
const DEFAULT_CHAT_ID = 'chat';
const DEFAULT_SCENE_KEY = 'scene';
const INSTALL_FAILURE_LABEL = 'Prompt install failed. Narration stopped.';
const CLEAR_FAILURE_LABEL = 'Prompt clear failed. Recursion skipped without clearing host prompt.';
const STALE_INSTALL_LABEL = 'Recursion skipped: host turn changed before prompt install.';
const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/ig;
const SNAPSHOT_MESSAGE_TEXT_LIMIT = 1200;
const PROVIDER_MESSAGE_TEXT_LIMIT = 900;
const PLAN_ACTIONS = new Set(['skip', 'reuse-cache', 'refresh-cards', 'compose-brief']);
const REASONER_DECISION_MODES = new Set(['use', 'skip']);
const PROMPT_FOOTPRINTS = new Set(['compact', 'normal', 'rich']);
const SCENE_STATUSES = new Set(['same-scene', 'soft-shift', 'hard-shift', 'unknown']);
const PROMPT_NEUTRAL_SETTING_KEYS = new Set(['reasoningLevel', 'reasonerUse', 'postProcess', 'postProcessDecks', 'enhancements']);
const DEFAULT_LOW_REASONING_MAX_CARDS = 3;
const DEFAULT_NORMAL_REASONING_MAX_CARDS = 6;
const DEFAULT_ULTRA_REASONING_MAX_CARDS = 10;
const HIGH_REASONER_CARD_PRIORITY = 88;
const REASONING_LEVEL_POLICIES = Object.freeze({
  low: {
    level: 'low',
    composer: 'utility',
    arbiterLane: 'utility',
    cardLane: 'utility',
    maxCardsCap: DEFAULT_LOW_REASONING_MAX_CARDS,
    maxCardsFloor: 0,
    prompt: 'Low uses Utility for Arbiter, card generation, and composition. Keep budgets lean and request only the most relevant cards for this scene/message.'
  },
  medium: {
    level: 'medium',
    composer: 'reasoner',
    arbiterLane: 'utility',
    cardLane: 'utility',
    maxCardsCap: 0,
    maxCardsFloor: 0,
    prompt: 'Medium uses Utility for Arbiter and cards, then Reasoner for final prompt composition. Use normal card budgets.'
  },
  high: {
    level: 'high',
    composer: 'reasoner',
    arbiterLane: 'reasoner',
    cardLane: 'priority',
    maxCardsCap: 0,
    maxCardsFloor: 0,
    prompt: 'High uses Reasoner for Arbiter, high-priority card families, and final composition. Keep lower-priority card families on Utility and use normal card budgets.'
  },
  ultra: {
    level: 'ultra',
    composer: 'reasoner',
    arbiterLane: 'reasoner',
    cardLane: 'reasoner',
    maxCardsCap: 0,
    maxCardsFloor: DEFAULT_ULTRA_REASONING_MAX_CARDS,
    prompt: 'Ultra uses Reasoner for Arbiter, card generation, and final composition when the lane is healthy. Bias toward a larger relevant hand when the scene supports it.'
  }
});
const HARD_CACHE_VERSION_FIELDS = Object.freeze([
  'storageSchemaVersion',
  'runtimeCacheContractVersion',
  'cardCatalogHash',
  'promptPacketVersion',
  'promptContractHash',
  'providerContractHash',
  'cardEligibilityHash'
]);

function cleanString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function safeTextSource(value, limit = 700) {
  const redacted = redact(value, { maxString: limit });
  if (redacted === undefined || redacted === null) return '';
  if (['string', 'number', 'boolean', 'bigint'].includes(typeof redacted)) return String(redacted);
  try {
    return JSON.stringify(redacted);
  } catch {
    return '';
  }
}

function safeText(value, limit = 700) {
  return truncate(compact(safeTextSource(value, limit).replace(SECRET_TEXT_PATTERN, '[redacted]'), limit), limit);
}

export function preserveFusedProviderFailure(providerResult = {}) {
  if (!providerResult || providerResult.ok !== false) return null;
  const source = providerResult?.diagnostics?.failure
    || providerResult.failure
    || providerResult.error
    || {};
  const code = safeText(source.code || 'RECURSION_FUSED_PROVIDER_FAILED', 120)
    || 'RECURSION_FUSED_PROVIDER_FAILED';
  return {
    ...(source.kind ? { kind: safeText(source.kind, 80) } : {}),
    code,
    ...(source.category ? { category: safeText(source.category, 100) } : {}),
    retryable: source.retryable === true,
    ...(Number.isFinite(providerResult?.error?.retryAfterMs) ? { retryAfterMs: providerResult.error.retryAfterMs } : {}),
    message: safeText(source.message || 'Fused provider request failed.', 500)
  };
}

export function validateFusedProviderResult(providerResult = {}, {
  selectedCards = [],
  request = null,
  cardContext = {}
} = {}) {
  const providerFailure = preserveFusedProviderFailure(providerResult);
  if (providerFailure) return { ok: false, error: providerFailure };

  const parsed = cardsFromFusedProviderResult(providerResult, {
    ...cardContext,
    expectedSnapshotHash: request?.snapshotHash,
    requestedCards: request?.requestedCards || [],
    providerLane: request?.lane
  });
  const cards = Object.fromEntries(
    parsed.cards.map((card) => [
      safeText(card.family || card.role || card.id, 120),
      sanitizeGeneratedCard(card)
    ])
  );
  const selected = Array.isArray(selectedCards) ? selectedCards : [];
  const rejections = normalizeFusedRejections(parsed.rejections);
  const outcomes = Object.fromEntries(selected.map((selectedCard) => {
    const family = safeText(selectedCard?.family || selectedCard?.role || '', 120);
    return [
      family,
      cards[family]
        ? { state: 'completed', reason: null }
        : { state: 'failed', reason: rejections.find((entry) => entry.family === family)?.code || 'missing-family' }
    ];
  }));
  const acceptedFamilies = Object.keys(cards);
  const unresolvedFamilies = selected
    .map((selectedCard) => safeText(selectedCard?.family || selectedCard?.role || '', 120))
    .filter((family) => family && !cards[family]);
  if (acceptedFamilies.length > 0) {
    return {
      ok: true,
      value: {
        cards,
        outcomes,
        acceptedFamilies,
        unresolvedFamilies,
        rejections,
        fallback: unresolvedFamilies.length
          ? {
              mode: 'segmented',
              reason: 'unresolved-fused-families',
              families: unresolvedFamilies
            }
          : null
      }
    };
  }
  return {
    ok: false,
    value: { cards, outcomes, acceptedFamilies, unresolvedFamilies, rejections },
    error: {
      code: 'RECURSION_FUSED_ZERO_USEFUL_CARDS',
      category: 'validation',
      retryable: true,
      message: `Fused bundle produced no useful cards. ${
        (providerResult?.diagnostics?.bundleItemRejections || [])
          .slice(0, 8).map((item) => `${safeText(item.family, 60)}: ${safeText(item.reason, 60)}`).join('; ')
      } ${parsed.diagnostics.slice(0, 8).map((entry) => safeText(entry, 80)).join('; ')}`.trim()
    }
  };
}

function hasSecretText(value) {
  SECRET_TEXT_PATTERN.lastIndex = 0;
  return SECRET_TEXT_PATTERN.test(String(value ?? ''));
}

function safeIdentifier(value, fallback = '', limit = 180) {
  return cleanString(safeText(value, limit), fallback);
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timestampOrNow(value) {
  const text = String(value ?? '');
  return text && Number.isFinite(Date.parse(text)) ? text : nowIso();
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cacheProviderSettingsSignature(provider = {}) {
  const source = asObject(provider);
  const policy = asObject(source.generationPolicy);
  const samplers = asObject(source.samplerOverrides);
  return {
    connectionProfileId: String(source.connectionProfileId || ''),
    generationPolicy: {
      presetMode: String(policy.presetMode || 'isolated'),
      instructMode: String(policy.instructMode || 'auto'),
      samplerMode: String(policy.samplerMode || 'profile'),
      structuredOutputMode: String(policy.structuredOutputMode || 'auto')
    },
    samplerOverrides: {
      temperature: numberOr(samplers.temperature, 0),
      topP: numberOr(samplers.topP, 0)
    },
    outputTokenCeiling: numberOr(source.outputTokenCeiling, 0),
    maxConcurrentRequests: numberOr(source.maxConcurrentRequests, 2),
    configRevision: numberOr(source.configRevision, 0)
  };
}

function settingsWithRuntimeCardScope(settings = {}, options = {}) {
  const source = options.normalize === true ? normalizeSettings(settings) : asObject(settings);
  const preProcessDecks = normalizeCardDeckSettings(source.preProcessDecks);
  const normalized = {
    ...source,
    preProcessDecks
  };
  return {
    ...normalized,
    cardScope: activeCardDeckRuntimeScope(normalized),
    cardEligibility: activeCardDeckEligibility(normalized)
  };
}

function runtimeScopePayload(settings = {}) {
  return scopePayloadForArbiter(settingsWithRuntimeCardScope(settings));
}

function usesCardDeckEligibility(settings = {}) {
  const preProcessDecks = normalizeCardDeckSettings(settings?.preProcessDecks);
  return settings.mode !== 'manual' || Object.keys(preProcessDecks.customDecks).length > 0;
}

function filterCardJobsForRuntimeScope(cardJobs, settings = {}) {
  const normalized = settingsWithRuntimeCardScope(settings);
  if (usesCardDeckEligibility(settings)) {
    const result = filterPlanForCardEligibility({ cardJobs }, normalized);
    return { cardJobs: result.plan.cardJobs, omitted: result.omitted, scope: runtimeScopePayload(normalized), diagnostics: result.diagnostics };
  }
  return filterCardJobsForScope(cardJobs, normalized);
}

function filterCardsForRuntimeScope(cards, settings = {}) {
  const normalized = settingsWithRuntimeCardScope(settings);
  if (usesCardDeckEligibility(settings)) {
    const entries = Array.isArray(cards) ? cards : [];
    const filtered = filterCardsForCardEligibility(entries, normalized);
    const accepted = new Set(filtered);
    const omitted = entries
      .filter((card) => !accepted.has(card))
      .map((card) => ({
        cardId: String(card?.deckCardId || '').trim(),
        family: String(card?.family || '').trim(),
        reason: 'inactive-card-ineligible'
      }));
    return {
      cards: filtered,
      omitted,
      scope: runtimeScopePayload(normalized),
      diagnostics: omitted.map((entry) => `card-eligibility-rejected:${entry.family || entry.cardId}`)
    };
  }
  return filterCardsForScope(cards, normalized);
}

export function filterPlanForCardEligibility(plan, settings = {}) {
  const normalized = settingsWithRuntimeCardScope(settings);
  const eligibility = normalized.cardEligibility || { allowedCardIds: [], allowedFamilies: [] };
  const allowedIds = new Set(eligibility.allowedCardIds || []);
  const allowedFamilies = new Set(eligibility.allowedFamilies || []);
  const accepted = [];
  const omitted = [];
  for (const job of Array.isArray(plan?.cardJobs) ? plan.cardJobs : []) {
    const cardId = String(job?.cardId || job?.refreshOfCardId || '').trim();
    const family = String(job?.family || CARD_CATALOG.find((entry) => entry.role === job?.role)?.family || '').trim();
    const allowed = cardId ? allowedIds.has(cardId) : allowedFamilies.has(family);
    if (allowed) accepted.push(job);
    else omitted.push({ cardId, family, reason: 'inactive-card-ineligible' });
  }
  return {
    plan: { ...plan, cardJobs: accepted },
    omitted,
    diagnostics: omitted.map((entry) => `card-eligibility-rejected:${entry.family || entry.cardId}`)
  };
}

export function filterCardsForCardEligibility(cards, settings = {}) {
  const normalized = settingsWithRuntimeCardScope(settings);
  const eligibility = normalized.cardEligibility || { allowedCardIds: [], allowedFamilies: [] };
  const allowedIds = new Set(eligibility.allowedCardIds || []);
  const allowedFamilies = new Set(eligibility.allowedFamilies || []);
  return (Array.isArray(cards) ? cards : []).filter((card) => {
    const cardId = String(card?.deckCardId || '').trim();
    const family = String(card?.family || '').trim();
    return cardId ? allowedIds.has(cardId) : allowedFamilies.has(family);
  });
}

function cacheSettingsSignature(settings = {}) {
  const normalized = settingsWithRuntimeCardScope(settings, { normalize: true });
  return {
    enabled: normalized.enabled,
    mode: normalized.mode,
    pipelineMode: normalized.pipelineMode,
    cardScope: normalized.cardScope,
    strength: normalized.strength,
    minCards: normalized.minCards,
    maxCards: normalized.maxCards,
    modelAttemptsPerStep: normalized.modelAttemptsPerStep,
    requestDeadlineSeconds: normalized.requestDeadlineSeconds,
    operationDeadlineSeconds: normalized.operationDeadlineSeconds,
    reasoningLevel: normalized.reasoningLevel,
    promptFootprint: normalized.promptFootprint,
    focus: normalized.focus,
    reasonerUse: normalized.reasonerUse,
    storyFormOverride: normalized.storyFormOverride,
    retention: normalized.retention,
    providers: {
      utility: cacheProviderSettingsSignature(normalized.providers?.utility),
      reasoner: cacheProviderSettingsSignature(normalized.providers?.reasoner)
    }
  };
}

function cardEligibilitySignature(settings = {}) {
  const eligibility = activeCardDeckEligibility(settings);
  return hashJson({
    activeDeckId: eligibility.activeDeckId,
    activeCardIds: [...eligibility.activeCardIds].sort(),
    priorityCardIds: [...eligibility.priorityCardIds].sort(),
    refinementCardIds: [...(eligibility.refinementCardIds || [])].sort(),
    allowedFamilies: [...eligibility.allowedFamilies].sort()
  });
}

export function cacheContractVersions(settings = {}) {
  return {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    runtimeCacheContractVersion: RUNTIME_CACHE_CONTRACT_VERSION,
    cardCatalogHash: hashJson(CARD_CATALOG),
    promptPacketVersion: PROMPT_PACKET_VERSION,
    promptContractHash: hashJson({
      promptPacketVersion: PROMPT_PACKET_VERSION,
      cardSelectionContract: 6,
      guidanceSchema: PROMPT_GUIDANCE_SCHEMA,
      guidanceContract: 2,
      storyFormSchema: STORY_FORM_SCHEMA
    }),
    providerContractHash: PROVIDER_CONTRACT_HASH,
    cardEligibilityHash: cardEligibilitySignature(settings),
    settingsHash: hashJson(cacheSettingsSignature(settings))
  };
}

function cacheContractStatus(cache, settings) {
  const versions = asObject(cache?.versions);
  const expected = cacheContractVersions(settings);
  const missing = [];
  const mismatches = [];
  for (const field of HARD_CACHE_VERSION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(versions, field)) {
      missing.push(field);
      continue;
    }
    if (versions[field] !== expected[field]) mismatches.push(field);
  }
  if (missing.length || mismatches.length) {
    return {
      ok: false,
      hard: true,
      reason: 'contract-mismatch',
      missing,
      mismatches
    };
  }
  const settingsMissing = !Object.prototype.hasOwnProperty.call(versions, 'settingsHash');
  const settingsMismatched = !settingsMissing && versions.settingsHash !== expected.settingsHash;
  if (settingsMissing || settingsMismatched) {
    return {
      ok: true,
      soft: true,
      reason: 'settings-changed',
      missing: settingsMissing ? ['settingsHash'] : [],
      mismatches: settingsMismatched ? ['settingsHash'] : []
    };
  }
  return { ok: true, reason: 'current', missing: [], mismatches: [] };
}

function normalizeMessage(message, index) {
  const source = asObject(message);
  const mesid = numberOr(source.mesid ?? source.id ?? source.messageId, index);
  const rawText = source.text ?? source.mes ?? source.content ?? '';
  const swipeId = Number(source.swipeId ?? source.swipe_id);
  const swipeCount = Number(source.swipeCount ?? (Array.isArray(source.swipes) ? source.swipes.length : NaN));
  const role = cleanString(
    source.role ?? (source.is_user === true ? 'user' : (source.is_system === true ? 'system' : 'assistant')),
    'assistant'
  );
  const sender = safeText(source.sender || source.name || '', 120);
  return {
    mesid,
    role,
    ...(sender ? { sender } : {}),
    text: safeText(rawText, SNAPSHOT_MESSAGE_TEXT_LIMIT),
    textHash: hashJson(String(rawText ?? '')),
    ...(Number.isFinite(swipeId) ? { swipeId: Math.max(0, Math.round(swipeId)) } : {}),
    ...(Number.isFinite(swipeCount) ? { swipeCount: Math.max(0, Math.round(swipeCount)) } : {}),
    ...(source.activeSwipeTextHash ? { activeSwipeTextHash: safeText(source.activeSwipeTextHash, 180) } : {}),
    visible: source.visible === false || source.hidden === true ? false : true
  };
}

function normalizeSnapshot(rawSnapshot = {}) {
  const source = asObject(rawSnapshot);
  const messages = Array.isArray(source.messages)
    ? source.messages.map((message, index) => normalizeMessage(message, index))
    : [];
  const latestMessage = messages.at(-1);
  const latestMesId = numberOr(source.latestMesId ?? latestMessage?.mesid, 0);
  const chatId = safeIdentifier(source.chatId ?? source.chatKey, DEFAULT_CHAT_ID);
  const chatKey = safeIdentifier(source.chatKey ?? source.chatId, chatId);
  const sceneFingerprint = safeIdentifier(source.sceneFingerprint, hashJson(messages));
  const normalized = {
    chatId,
    chatKey,
    sceneKey: safeIdentifier(source.sceneKey ?? source.sceneFingerprint, DEFAULT_SCENE_KEY),
    sceneFingerprint,
    turnFingerprint: safeIdentifier(
      source.turnFingerprint,
      hashJson({ latestMesId, messages: messages.slice(-3) })
    ),
    latestMesId,
    messages,
    sourceWindowTruncated: source.sourceWindowTruncated === true,
    sourceWindowLimitReason: safeText(source.sourceWindowLimitReason || '', 40),
    sourceWindowMessageCount: numberOr(source.sourceWindowMessageCount, messages.length),
    sourceWindowCharacterCount: numberOr(source.sourceWindowCharacterCount, 0)
  };
  return {
    ...normalized,
    latestAssistantExcluded: source.latestAssistantExcluded === true,
    sourceRevisionHash: safeText(source.sourceRevisionHash || sourceWindowFingerprint(normalized), 180)
  };
}

function safeProviderRole(value) {
  const role = cleanString(value, 'assistant').toLowerCase();
  return ['assistant', 'system', 'user'].includes(role) ? role : 'assistant';
}

function providerSafeMessage(message) {
  const source = asObject(message);
  if (source.visible === false) return null;
  const text = safeText(source.text ?? '', PROVIDER_MESSAGE_TEXT_LIMIT);
  if (!text) return null;
  return {
    mesid: numberOr(source.mesid, 0),
    role: safeProviderRole(source.role),
    text
  };
}

function providerSafeSnapshot(snapshot = {}, retention = {}) {
  const source = asObject(snapshot);
  const providerLimit = normalizeRetentionSettings(retention).providerVisibleMessages;
  const messages = Array.isArray(source.messages)
    ? source.messages.map(providerSafeMessage).filter(Boolean).slice(-providerLimit)
    : [];
  return {
    sceneKey: safeText(source.sceneKey || DEFAULT_SCENE_KEY, 120) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(source.sceneFingerprint || '', 180),
    turnFingerprint: safeText(source.turnFingerprint || '', 180),
    sourceRevisionHash: safeText(source.sourceRevisionHash || '', 180),
    latestMesId: numberOr(source.latestMesId, 0),
    messages
  };
}

function viewSnapshot(snapshot) {
  if (!snapshot) return null;
  const source = asObject(snapshot);
  const messages = Array.isArray(source.messages)
    ? source.messages.map(providerSafeMessage).filter(Boolean).map((message) => ({ ...message, visible: true }))
    : [];
  return {
    chatId: safeText(source.chatId || DEFAULT_CHAT_ID, 160) || DEFAULT_CHAT_ID,
    chatKey: safeText(source.chatKey || source.chatId || DEFAULT_CHAT_ID, 160) || DEFAULT_CHAT_ID,
    sceneKey: safeText(source.sceneKey || DEFAULT_SCENE_KEY, 160) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(source.sceneFingerprint || '', 180),
    turnFingerprint: safeText(source.turnFingerprint || '', 180),
    sourceRevisionHash: safeText(source.sourceRevisionHash || '', 180),
    latestMesId: numberOr(source.latestMesId, 0),
    messages,
    sourceWindowTruncated: source.sourceWindowTruncated === true,
    sourceWindowLimitReason: safeText(source.sourceWindowLimitReason || '', 40),
    sourceWindowMessageCount: numberOr(source.sourceWindowMessageCount, messages.length),
    sourceWindowCharacterCount: numberOr(source.sourceWindowCharacterCount, 0)
  };
}

function latestVisibleMessage(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  return messages
    .slice()
    .reverse()
    .find((message) => message?.visible !== false && String(message?.text ?? '').trim());
}

function latestVisibleMessageEntry(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.visible === false) continue;
    if (!String(message?.text ?? '').trim()) continue;
    return { message, index };
  }
  return null;
}

function latestVisibleUserMessage(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  return messages
    .slice()
    .reverse()
    .find((message) => message?.visible !== false && message?.role === 'user' && String(message?.text ?? '').trim());
}

function normalizePendingUserMessage(userMessage) {
  if (typeof userMessage === 'string') {
    return {
      rawText: userMessage,
      text: safeText(userMessage, PROVIDER_MESSAGE_TEXT_LIMIT),
      textHash: hashJson(userMessage)
    };
  }
  const source = asObject(userMessage);
  const rawText = source.text ?? source.mes ?? '';
  const text = safeText(rawText, PROVIDER_MESSAGE_TEXT_LIMIT);
  const mesid = Number(source.mesid ?? source.id ?? source.messageId);
  return {
    rawText: String(rawText ?? ''),
    text,
    textHash: hashJson(String(rawText ?? '')),
    ...(Number.isFinite(mesid) ? { mesid } : {})
  };
}

function snapshotWithPendingUserMessage(snapshot, userMessage) {
  const pending = normalizePendingUserMessage(userMessage);
  const pendingText = pending.text;
  if (!pendingText) return snapshot;
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const latest = latestVisibleMessage(snapshot);
  const currentLatestMesId = numberOr(snapshot?.latestMesId, 0);
  const pendingMesId = Number.isFinite(pending.mesid) && pending.mesid > currentLatestMesId
    ? pending.mesid
    : currentLatestMesId + 1;
  const alreadyVisible = latest?.role === 'user'
    && (
      (latest?.textHash && pending.textHash && latest.textHash === pending.textHash)
      || safeText(latest?.text || '', PROVIDER_MESSAGE_TEXT_LIMIT) === pendingText
    )
    && (!Number.isFinite(pending.mesid) || numberOr(latest?.mesid, null) === pending.mesid);
  if (alreadyVisible) return snapshot;
  const nextMessages = [
    ...messages,
    {
      mesid: pendingMesId,
      role: 'user',
      text: pendingText,
      textHash: pending.textHash,
      visible: true
    }
  ];
  const nextSnapshot = {
    ...snapshot,
    latestMesId: pendingMesId,
    messages: nextMessages,
    sourceRevisionHash: sourceWindowFingerprint({ ...snapshot, latestMesId: pendingMesId, messages: nextMessages })
  };
  return {
    ...nextSnapshot,
    turnFingerprint: hashJson({
      latestMesId: pendingMesId,
      sourceRevisionHash: nextSnapshot.sourceRevisionHash,
      messages: nextMessages.slice(-3)
    })
  };
}

function snapshotWithoutVisiblePendingUserMessage(snapshot, userMessage) {
  const pending = normalizePendingUserMessage(userMessage);
  const pendingText = pending.text;
  if (!pendingText) return snapshot;
  const entry = latestVisibleMessageEntry(snapshot);
  const latest = entry?.message;
  const matchesLatestPending = latest?.role === 'user'
    && (
      (latest?.textHash && pending.textHash && latest.textHash === pending.textHash)
      || safeText(latest?.text || '', PROVIDER_MESSAGE_TEXT_LIMIT) === pendingText
    )
    && (!Number.isFinite(pending.mesid) || numberOr(latest?.mesid, null) === pending.mesid);
  if (!matchesLatestPending) return snapshot;
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const nextMessages = messages.filter((_, index) => index !== entry.index);
  const latestRemaining = nextMessages
    .slice()
    .reverse()
    .find((message) => message?.visible !== false && String(message?.text ?? '').trim());
  if (!latestRemaining) return snapshot;
  const latestMesId = numberOr(latestRemaining?.mesid, 0);
  return normalizeSnapshot({
    ...snapshot,
    latestMesId,
    messages: nextMessages,
    sourceRevisionHash: '',
    turnFingerprint: ''
  });
}

function localFallbackPlan(snapshot, settings) {
  const snapshotHash = hashJson(snapshot);
  const behaviorPolicy = influencePolicyForSettings(settings);
  const footprintPolicy = asObject(behaviorPolicy.footprint);
  const cardBudget = asObject(behaviorPolicy.cardBudget);
  const reasoningPolicy = reasoningPolicyForSettings(settings);
  const promptFootprint = normalizePromptFootprint(footprintPolicy.level, normalizePromptFootprint(settings.promptFootprint, 'normal'));
  const fallbackMaxCards = reasoningPolicy.maxCardsFloor > 0
    ? reasoningPolicy.maxCardsFloor
    : (reasoningPolicy.maxCardsCap > 0 ? reasoningPolicy.maxCardsCap : DEFAULT_NORMAL_REASONING_MAX_CARDS);
  return {
    schema: UTILITY_ARBITER_SCHEMA,
    snapshotHash,
    action: 'compose-brief',
    sceneStatus: 'same-scene',
    promptFootprint,
    cardJobs: [],
    storyForm: UNKNOWN_STORY_FORM,
    reasonerDecision: {
      mode: settings.reasonerUse === 'always' ? 'use' : 'skip',
      reason: 'local fallback',
      signals: []
    },
    budgets: {
      targetBriefTokens: promptFootprint === 'rich' ? 900 : (promptFootprint === 'compact' ? 360 : 500),
      maxCards: fallbackMaxCards
    },
    diagnostics: ['local-fallback-plan'],
    source: { snapshotHash }
  };
}

function normalizeBudget(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.round(number));
}

function mergeDiagnostics(...groups) {
  return [...new Set(groups.flatMap((group) => Array.isArray(group)
    ? group.map((entry) => safeText(entry, 180)).filter(Boolean)
    : []))];
}

function safeStringList(value, limit = 120) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry) => ['string', 'number', 'boolean'].includes(typeof entry))
    .map((entry) => safeText(entry, limit))
    .filter(Boolean))];
}

function normalizePlanAction(value, fallback) {
  const action = cleanString(value, fallback);
  return PLAN_ACTIONS.has(action) ? action : fallback;
}

function normalizePromptFootprint(value, fallback = 'normal') {
  const footprint = cleanString(value, fallback);
  return PROMPT_FOOTPRINTS.has(footprint) ? footprint : fallback;
}

function normalizeReasonerDecision(fallbackDecision, value) {
  const source = asObject(value);
  const fallback = asObject(fallbackDecision);
  const mode = cleanString(source.mode, fallback.mode || 'skip');
  return {
    mode: REASONER_DECISION_MODES.has(mode) ? mode : (fallback.mode || 'skip'),
    reason: safeText(source.reason ?? fallback.reason ?? '', 240),
    signals: safeStringList(source.signals ?? fallback.signals, 120)
  };
}

function providerCapability(settings = {}, lane = 'utility', operation = 'prompt-packet', hostContext = {}) {
  return resolveProviderCapability({
    settings,
    lane,
    operation,
    host: hostContext
  });
}

function enforceReasonerAvailability(plan, settings, capabilityResolver = providerCapability) {
  const decision = asObject(plan?.reasonerDecision);
  if (decision.mode !== 'use') return plan;
  if (reasoningPolicyForSettings(settings).level === 'low') return plan;
  const capability = capabilityResolver(settings, 'reasoner', 'prompt-packet');
  if (capability.eligible) return plan;
  return {
    ...plan,
    reasonerDecision: {
      mode: 'skip',
      reason: capability.reasonCode,
      signals: safeStringList(decision.signals, 120)
    },
    diagnostics: mergeDiagnostics(plan.diagnostics, ['reasoner-unavailable', capability.reasonCode])
  };
}

function reasoningPolicyForSettings(settings = {}) {
  const level = safeText(settings?.reasoningLevel || 'medium', 40).toLowerCase();
  const base = REASONING_LEVEL_POLICIES[level] || REASONING_LEVEL_POLICIES.medium;
  const cardBudget = normalizeCardBudgetSettings(settings);
  if (base.level === 'low') {
    return { ...base, maxCardsCap: cardBudget.minCards, maxCardsFloor: 0, cardBudget };
  }
  if (base.level === 'medium' || base.level === 'high') {
    return { ...base, maxCardsCap: cardBudget.normalCards, maxCardsFloor: 0, cardBudget };
  }
  if (base.level === 'ultra') {
    return { ...base, maxCardsCap: cardBudget.maxCards, maxCardsFloor: cardBudget.maxCards, cardBudget };
  }
  return { ...base, cardBudget };
}

function providerLaneForPolicyLane(policyLane, settings, capabilityResolver = providerCapability) {
  return policyLane === 'reasoner'
    && capabilityResolver(settings, 'reasoner', 'prompt-packet').eligible
    ? 'reasoner'
    : 'utility';
}

function arbiterLaneForSettings(settings, capabilityResolver = providerCapability) {
  return providerLaneForPolicyLane(reasoningPolicyForSettings(settings).arbiterLane, settings, capabilityResolver);
}

function reasoningPolicyPromptLine(settings) {
  const policy = reasoningPolicyForSettings(settings);
  const budget = policy.cardBudget || normalizeCardBudgetSettings(settings);
  return `Reasoning level policy: ${policy.prompt} Runtime-enforced card budgets: lowMinCards=${budget.minCards}; normalCards=${budget.normalCards}; ultraMaxCards=${budget.maxCards}. Runtime-enforced routing: composer=${policy.composer}; arbiterLane=${policy.arbiterLane}; cardLane=${policy.cardLane}.`;
}

function adjustedMaxCardsForPolicy(value, policy) {
  const current = normalizeBudget(value, DEFAULT_NORMAL_REASONING_MAX_CARDS);
  if (current <= 0) return current;
  let next = current;
  if (policy.maxCardsCap > 0) next = Math.min(next, policy.maxCardsCap);
  if (policy.maxCardsFloor > 0) next = Math.max(next, policy.maxCardsFloor);
  return next;
}

function applyReasoningPolicyToPlan(plan, settings) {
  const policy = reasoningPolicyForSettings(settings);
  const budgets = asObject(plan?.budgets);
  const nextMaxCards = adjustedMaxCardsForPolicy(budgets.maxCards, policy);
  if (nextMaxCards === budgets.maxCards) return plan;
  return {
    ...plan,
    budgets: {
      ...budgets,
      maxCards: nextMaxCards
    }
  };
}

function hasHighRiskFootprintReason(plan) {
  const decision = asObject(plan?.reasonerDecision);
  const evidence = [
    decision.reason,
    ...(Array.isArray(decision.signals) ? decision.signals : []),
    ...(Array.isArray(plan?.diagnostics) ? plan.diagnostics : []),
    plan?.sceneStatus
  ].join(' ');
  return /\b(safety|hard-shift|hard shift|continuity|conflict|contradiction|crowded|high[-\s]*risk|risk)\b/i.test(evidence);
}

function applyBehaviorPolicyToPlan(plan, settings) {
  const behaviorPolicy = influencePolicyForSettings(settings);
  const footprintPolicy = asObject(behaviorPolicy.footprint);
  const cardBudget = asObject(behaviorPolicy.cardBudget);
  const allowedFootprints = new Set(Array.isArray(footprintPolicy.allowedProfiles) ? footprintPolicy.allowedProfiles : []);
  const storedFootprint = normalizePromptFootprint(footprintPolicy.level, normalizePromptFootprint(settings.promptFootprint, 'normal'));
  const requestedFootprint = normalizePromptFootprint(plan?.promptFootprint, storedFootprint);
  const diagnostics = [];
  const promptFootprint = allowedFootprints.has(requestedFootprint) || hasHighRiskFootprintReason(plan)
    ? requestedFootprint
    : storedFootprint;
  if (promptFootprint !== requestedFootprint) diagnostics.push('behavior-footprint-clamped');

  const budgets = asObject(plan?.budgets);
  const fallbackMaxCards = normalizeBudget(cardBudget.normalCards, DEFAULT_NORMAL_REASONING_MAX_CARDS);
  const requestedMaxCards = normalizeBudget(budgets.maxCards, fallbackMaxCards);
  const reasoningFloor = normalizeBudget(reasoningPolicyForSettings(settings).maxCardsFloor, 0);
  const ceiling = Math.max(normalizeBudget(cardBudget.maxCards, requestedMaxCards), reasoningFloor);
  const maxCards = requestedMaxCards > 0 && ceiling > 0 ? Math.min(requestedMaxCards, ceiling) : requestedMaxCards;
  if (maxCards !== requestedMaxCards) diagnostics.push('behavior-max-cards-clamped');

  const clampedReasonerUse = promptFootprint !== requestedFootprint
    && asObject(plan?.reasonerDecision).mode === 'use'
    && !hasHighRiskFootprintReason(plan);
  if (clampedReasonerUse) diagnostics.push('behavior-reasoner-clamped');

  if (!diagnostics.length && promptFootprint === plan?.promptFootprint && maxCards === budgets.maxCards) return plan;
  return {
    ...plan,
    promptFootprint,
    ...(clampedReasonerUse
      ? {
          reasonerDecision: {
            mode: 'skip',
            reason: 'Behavior policy clamped non-risk footprint expansion.',
            signals: ['behavior-footprint-clamped']
          }
        }
      : {}),
    budgets: {
      ...budgets,
      maxCards
    },
    diagnostics: mergeDiagnostics(plan.diagnostics, diagnostics)
  };
}

function catalogForCardRequest(request) {
  return catalogForCard({
    role: request?.role,
    roleId: request?.roleId || request?.metadata?.role,
    family: request?.family || request?.metadata?.family
  });
}

function cardLaneForRequest(request, settings, capabilityResolver = providerCapability) {
  const policy = reasoningPolicyForSettings(settings);
  if (policy.cardLane === 'utility') return 'utility';
  if (!capabilityResolver(settings, 'reasoner', 'prompt-packet').eligible) return 'utility';
  if (policy.cardLane === 'reasoner') return 'reasoner';
  if (policy.cardLane === 'priority') {
    const catalog = catalogForCardRequest(request);
    return numberOr(catalog?.priority, 0) >= HIGH_REASONER_CARD_PRIORITY ? 'reasoner' : 'utility';
  }
  return 'utility';
}

function applyReasoningLaneToCardRequest(request, settings, capabilityResolver = providerCapability) {
  const routedRequest = {
    ...request,
    lane: cardLaneForRequest(request, settings, capabilityResolver)
  };
  if (routedRequest.lane !== 'reasoner') return { ...routedRequest, ...reasoningRequestMetadata('low', 'card') };
  return {
    ...routedRequest,
    ...reasoningRequestMetadata(settings, 'card')
  };
}

function fusedCardBundleLaneForSettings(settings, capabilityResolver = providerCapability) {
  const policy = reasoningPolicyForSettings(settings);
  if (
    (policy.level === 'high' || policy.level === 'ultra')
    && capabilityResolver(settings, 'reasoner', 'prompt-packet').fusedEligible
  ) return 'reasoner';
  return 'utility';
}

function enhancementLaneForSettings(settings, capabilityResolver = providerCapability) {
  const policy = reasoningPolicyForSettings(settings);
  if (
    (policy.level === 'high' || policy.level === 'ultra')
    && capabilityResolver(settings, 'reasoner', 'prompt-packet').eligible
  ) return 'reasoner';
  return 'utility';
}

function redirectTransformerLaneForSettings(settings, capabilityResolver = providerCapability) {
  if (reasoningPolicyForSettings(settings).level === 'low') return 'utility';
  return capabilityResolver(settings, 'reasoner', 'redirect').eligible ? 'reasoner' : '';
}

function applyReasoningLaneToFusedCardBundleRequest(request, settings, capabilityResolver = providerCapability) {
  const routedRequest = {
    ...request,
    lane: fusedCardBundleLaneForSettings(settings, capabilityResolver)
  };
  if (routedRequest.lane !== 'reasoner') return { ...routedRequest, ...reasoningRequestMetadata('low', 'card') };
  return {
    ...routedRequest,
    ...reasoningRequestMetadata(settings, 'card')
  };
}

function reasonerRequestMetadata(settings, category, lane) {
  if (lane === 'utility' && category === 'arbiter') return reasoningRequestMetadata('low', category);
  if (lane !== 'reasoner') return {};
  return reasoningRequestMetadata(settings, category);
}

function normalizePlanCardJobs(value) {
  if (!Array.isArray(value)) return null;
  return value.map((job) => {
    const source = asObject(job);
    const output = {};
    const family = safeText(source.family, 120);
    const role = safeText(source.role, 120);
    const roleId = safeText(source.roleId, 120);
    const reason = safeText(source.reason, 240);
    const inferredFamily = family || safeText(
      CARD_CATALOG.find((entry) => entry.role === (role || roleId))?.family || '',
      120
    );
    if (inferredFamily) output.family = inferredFamily;
    if (role) output.role = role;
    if (roleId) output.roleId = roleId;
    if (reason) output.reason = reason;
    const refreshOfCardId = safeIdentifier(source.refreshOfCardId ?? source.replacesCardId ?? '', '', 160);
    if (refreshOfCardId) output.refreshOfCardId = refreshOfCardId;
    return output;
  }).filter((job) => job.family || job.role || job.roleId);
}

function normalizePlanLifecycle(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const source = asObject(entry);
    const action = safeText(source.action ?? source.decision, 60);
    const cardId = safeText(source.cardId ?? source.id, 180);
    const reason = safeText(source.reason, 240);
    const decisionId = safeText(source.decisionId, 180);
    const output = {};
    if (action) output.action = action;
    if (cardId) output.cardId = cardId;
    if (reason) output.reason = reason;
    if (decisionId) output.decisionId = decisionId;
    return output;
  }).filter((entry) => entry.action && entry.cardId);
}

function mergeSource(fallbackSource) {
  const source = asObject(fallbackSource);
  return {
    snapshotHash: safeText(source.snapshotHash || '', 180),
    ...(source.userMessageHash ? { userMessageHash: safeText(source.userMessageHash, 180) } : {}),
    ...(source.catalogHash ? { catalogHash: safeText(source.catalogHash, 180) } : {})
  };
}

function mergePlan(fallbackPlan, arbiterData) {
  const data = asObject(arbiterData);
  const schema = safeText(data.schema, 120);
  if (schema !== UTILITY_ARBITER_SCHEMA) {
    throw new Error(`Invalid Utility Arbiter schema: ${schema || 'missing'}`);
  }
  const expectedSnapshotHash = safeText(fallbackPlan.snapshotHash, 180);
  const actualSnapshotHash = safeText(data.snapshotHash, 180);
  if (!actualSnapshotHash || actualSnapshotHash !== expectedSnapshotHash) {
    throw new Error(`Invalid Utility Arbiter snapshotHash: ${actualSnapshotHash ? 'mismatch' : 'missing'}`);
  }
  const budgets = {
    targetBriefTokens: normalizeBudget(
      asObject(data.budgets).targetBriefTokens,
      fallbackPlan.budgets.targetBriefTokens
    ),
    maxCards: normalizeBudget(
      asObject(data.budgets).maxCards,
      fallbackPlan.budgets.maxCards
    )
  };
  return {
    schema: UTILITY_ARBITER_SCHEMA,
    snapshotHash: fallbackPlan.snapshotHash,
    action: normalizePlanAction(data.action, fallbackPlan.action),
    sceneStatus: normalizeSceneStatus(data.sceneStatus, fallbackPlan.sceneStatus),
    promptFootprint: normalizePromptFootprint(data.promptFootprint, fallbackPlan.promptFootprint || 'normal'),
    cardJobs: normalizePlanCardJobs(data.cardJobs) ?? fallbackPlan.cardJobs,
    selection: {
      source: 'arbiter',
      proposed: (normalizePlanCardJobs(data.cardJobs) || []).map(({ family, reason }) => ({ family, reason: reason || '' })),
      omitted: []
    },
    storyForm: normalizeStoryForm(data.storyForm, fallbackPlan.storyForm),
    lifecycle: normalizePlanLifecycle(data.lifecycle ?? data.cardLifecycle ?? data.cardDecisions),
    reasonerDecision: normalizeReasonerDecision(fallbackPlan.reasonerDecision, data.reasonerDecision),
    budgets,
    diagnostics: mergeDiagnostics(fallbackPlan.diagnostics, data.diagnostics, ['arbiter-model-plan']).filter((entry) => entry !== 'local-fallback-plan'),
    source: {
      ...mergeSource(fallbackPlan.source),
      snapshotHash: fallbackPlan.source?.snapshotHash || fallbackPlan.snapshotHash
    }
  };
}

function markArbiterFallback(plan, reason) {
  return {
    ...plan,
    diagnostics: mergeDiagnostics(plan.diagnostics, ['utility-arbiter-fallback']),
    utilityArbiterFallbackReason: safeText(reason || 'utility arbiter unavailable', 240)
  };
}

function markUtilityUnavailable(plan, reason) {
  return {
    ...plan,
    action: 'reuse-cache',
    cardJobs: [],
    lifecycle: [],
    reasonerDecision: {
      mode: 'skip',
      reason: 'Utility unavailable',
      signals: []
    },
    diagnostics: mergeDiagnostics(['utility-unavailable']),
    utilityUnavailable: true,
    utilityUnavailableReason: safeText(reason || 'utility unavailable', 240)
  };
}

function planAction(plan) {
  const action = cleanString(plan?.action, 'compose-brief');
  return PLAN_ACTIONS.has(action) ? action : 'compose-brief';
}

function settingsForPlan(settings, plan, capabilityResolver = providerCapability) {
  const promptFootprint = normalizePromptFootprint(plan?.promptFootprint, settings.promptFootprint);
  if (Array.isArray(plan?.diagnostics) && plan.diagnostics.includes('behavior-reasoner-clamped')) {
    return { ...settings, promptFootprint, reasonerUse: 'off' };
  }
  if (
    settings.reasonerUse !== 'off'
    && !capabilityResolver(settings, 'reasoner', 'prompt-packet').eligible
  ) {
    return { ...settings, promptFootprint, reasonerUse: 'off' };
  }
  if (settings.reasonerUse === 'auto' && plan?.reasonerDecision?.mode === 'skip') {
    return { ...settings, promptFootprint, reasonerUse: 'off' };
  }
  if (settings.reasonerUse !== 'off' && plan?.reasonerDecision?.mode === 'use') {
    return { ...settings, promptFootprint, reasonerUse: 'always' };
  }
  return { ...settings, promptFootprint };
}

function normalizeSceneStatus(value, fallback = 'same-scene') {
  const text = cleanString(value, fallback);
  if (SCENE_STATUSES.has(text)) return text;
  const fallbackText = cleanString(fallback, 'same-scene');
  if (SCENE_STATUSES.has(fallbackText)) return fallbackText;
  return 'same-scene';
}

function snapshotForPlan(snapshot, plan) {
  const status = normalizeSceneStatus(plan?.sceneStatus);
  if (status !== 'hard-shift') return snapshot;
  const sceneFingerprint = hashJson({
    previousSceneFingerprint: snapshot.sceneFingerprint,
    hardShiftAtMesId: snapshot.latestMesId,
    turnFingerprint: snapshot.turnFingerprint
  });
  return {
    ...snapshot,
    sceneFingerprint,
    sceneKey: safeIdentifier(`${snapshot.chatKey}-${sceneFingerprint}`, snapshot.sceneKey)
  };
}

function promptInstallVisibleMessages(snapshot) {
  const source = asObject(snapshot);
  return Array.isArray(source.messages)
    ? source.messages
        .filter((message) => message?.visible !== false)
        .map((message) => ({
          mesid: numberOr(message?.mesid, 0),
          role: safeProviderRole(message?.role),
          textHash: String(message?.textHash || hashJson(String(message?.text ?? ''))),
          ...(Number.isFinite(Number(message?.swipeId)) ? { swipeId: Math.max(0, Math.round(Number(message.swipeId))) } : {}),
          ...(Number.isFinite(Number(message?.swipeCount)) ? { swipeCount: Math.max(0, Math.round(Number(message.swipeCount))) } : {}),
          ...(message?.activeSwipeTextHash ? { activeSwipeTextHash: safeText(message.activeSwipeTextHash, 180) } : {})
        }))
    : [];
}

function promptInstallContentMessages(snapshot) {
  return promptInstallVisibleMessages(snapshot).map((message) => ({
    mesid: message.mesid,
    role: message.role,
    textHash: message.textHash
  }));
}

function promptInstallFreshnessSignature(snapshot) {
  const source = asObject(snapshot);
  const visibleMessages = promptInstallVisibleMessages(snapshot);
  return {
    chatKey: safeText(source.chatKey || source.chatId || DEFAULT_CHAT_ID, 160) || DEFAULT_CHAT_ID,
    sceneKey: safeText(source.sceneKey || DEFAULT_SCENE_KEY, 160) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(source.sceneFingerprint || '', 180),
    latestMesId: numberOr(source.latestMesId, 0),
    sourceRevisionHash: safeText(source.sourceRevisionHash || sourceWindowFingerprint(source), 180),
    visibleMessagesHash: hashJson(visibleMessages)
  };
}

function sourceWindowMessages(snapshot, firstMesId = null, lastMesId = null) {
  const source = asObject(snapshot);
  const requestedFirst = finiteNumberOrNull(firstMesId);
  const requestedLast = finiteNumberOrNull(lastMesId);
  const first = requestedFirst ?? Number.NEGATIVE_INFINITY;
  const last = requestedLast ?? numberOr(source.latestMesId, Number.POSITIVE_INFINITY);
  return (Array.isArray(source.messages) ? source.messages : [])
    .filter((message) => message?.visible !== false)
    .map((message) => ({
      mesid: numberOr(message?.mesid, 0),
      role: safeProviderRole(message?.role),
      textHash: String(message?.textHash || hashJson(String(message?.text ?? ''))),
      ...(Number.isFinite(Number(message?.swipeId)) ? { swipeId: Math.max(0, Math.round(Number(message.swipeId))) } : {}),
      ...(Number.isFinite(Number(message?.swipeCount)) ? { swipeCount: Math.max(0, Math.round(Number(message.swipeCount))) } : {}),
      ...(message?.activeSwipeTextHash ? { activeSwipeTextHash: safeText(message.activeSwipeTextHash, 180) } : {})
    }))
    .filter((message) => message.mesid >= first && message.mesid <= last);
}

function sourceWindowFingerprint(snapshot, firstMesId = null, lastMesId = null) {
  return hashJson(sourceWindowMessages(snapshot, firstMesId, lastMesId));
}

function sourceWindowRange(snapshot) {
  const messages = sourceWindowMessages(snapshot);
  const first = messages[0]?.mesid ?? 0;
  const last = messages.at(-1)?.mesid ?? numberOr(snapshot?.latestMesId, 0);
  return { firstMesId: first, lastMesId: last };
}

function cardSourceContext(snapshot, overrides = {}) {
  const range = sourceWindowRange(snapshot);
  const firstMesId = finiteNumberOrNull(overrides.firstMesId) ?? range.firstMesId;
  const lastMesId = finiteNumberOrNull(overrides.lastMesId) ?? range.lastMesId;
  return {
    sceneId: snapshot.sceneKey,
    chatId: snapshot.chatId,
    firstMesId,
    lastMesId,
    snapshotHash: sourceWindowFingerprint(snapshot, firstMesId, lastMesId),
    sourceRevisionHash: sourceWindowFingerprint(snapshot, firstMesId, lastMesId)
  };
}

function pendingUserInstallStillCurrent(expected, current, pendingUserMessage, options = {}) {
  const pending = normalizePendingUserMessage(pendingUserMessage);
  if (!pending.text) return false;
  const expectedSignature = promptInstallFreshnessSignature(expected);
  const currentSignature = promptInstallFreshnessSignature(current);
  if (expectedSignature.chatKey !== currentSignature.chatKey) return false;
  if (expectedSignature.sceneKey !== currentSignature.sceneKey) return false;
  if (expectedSignature.sceneFingerprint !== currentSignature.sceneFingerprint) return false;
  if (expectedSignature.latestMesId !== currentSignature.latestMesId) return false;

  const expectedMessages = promptInstallVisibleMessages(expected);
  const currentMessages = promptInstallVisibleMessages(current);
  if (expectedMessages.length !== currentMessages.length || !expectedMessages.length) return false;
  const expectedContentMessages = promptInstallContentMessages(expected);
  const currentContentMessages = promptInstallContentMessages(current);
  const prefixContentMatches = hashJson(expectedContentMessages.slice(0, -1)) === hashJson(currentContentMessages.slice(0, -1));

  const expectedLatest = latestVisibleMessage(expected);
  const currentLatest = latestVisibleMessage(current);
  const latestMatches = (message) => message?.role === 'user'
    && numberOr(message?.mesid, 0) === expectedSignature.latestMesId
    && (
      (message?.textHash && pending.textHash && message.textHash === pending.textHash)
      || (
        String(pending.rawText || '').length <= SNAPSHOT_MESSAGE_TEXT_LIMIT
        && String(message?.text ?? '') === String(pending.rawText || '')
      )
    );
  if (!latestMatches(expectedLatest) || !latestMatches(currentLatest)) return false;
  if (prefixContentMatches) return true;
  if (options.allowPendingUserPrefixDrift === true) return true;

  const expectedBaseSourceRevisionHash = safeText(options.baseSourceRevisionHash || '', 180);
  if (!expectedBaseSourceRevisionHash) return false;
  const currentBaseSnapshot = snapshotWithoutVisiblePendingUserMessage(current, pendingUserMessage);
  return activeSourceRevisionHash(currentBaseSnapshot) === expectedBaseSourceRevisionHash;
}

function snapshotsMatchForPromptInstall(expected, current, pendingUserMessage = null, options = {}) {
  const expectedSignature = promptInstallFreshnessSignature(expected);
  const currentSignature = promptInstallFreshnessSignature(current);
  const exact = expectedSignature.chatKey === currentSignature.chatKey
    && expectedSignature.sourceRevisionHash === currentSignature.sourceRevisionHash
    && expectedSignature.visibleMessagesHash === currentSignature.visibleMessagesHash;
  return exact || pendingUserInstallStillCurrent(expected, current, pendingUserMessage, options);
}

function promptInstallComparisonDiagnostics(expected, current, pendingUserMessage = null, options = {}) {
  const pending = normalizePendingUserMessage(pendingUserMessage);
  const expectedSignature = promptInstallFreshnessSignature(expected);
  const currentSignature = promptInstallFreshnessSignature(current);
  const expectedMessages = promptInstallVisibleMessages(expected);
  const currentMessages = promptInstallVisibleMessages(current);
  const expectedContentMessages = promptInstallContentMessages(expected);
  const currentContentMessages = promptInstallContentMessages(current);
  const expectedBaseSourceRevisionHash = safeText(options.baseSourceRevisionHash || '', 180);
  const currentBaseSnapshot = expectedBaseSourceRevisionHash
    ? snapshotWithoutVisiblePendingUserMessage(current, pendingUserMessage)
    : null;
  const expectedLatest = latestVisibleMessage(expected);
  const currentLatest = latestVisibleMessage(current);
  const rawText = String(pending.rawText || '');
  const rawTextComparable = rawText.length > 0 && rawText.length <= SNAPSHOT_MESSAGE_TEXT_LIMIT;
  const latestDiagnostics = (message) => ({
    role: safeProviderRole(message?.role),
    mesid: numberOr(message?.mesid, -1),
    textHashMatches: Boolean(message?.textHash && pending.textHash && message.textHash === pending.textHash),
    rawTextMatches: Boolean(rawTextComparable && String(message?.text ?? '') === rawText)
  });
  return {
    exact: expectedSignature.chatKey === currentSignature.chatKey
      && expectedSignature.sourceRevisionHash === currentSignature.sourceRevisionHash
      && expectedSignature.visibleMessagesHash === currentSignature.visibleMessagesHash,
    pendingTextPresent: Boolean(pending.text),
    rawTextComparable,
    pendingRawLength: rawText.length,
    chatKeyMatch: expectedSignature.chatKey === currentSignature.chatKey,
    sceneKeyMatch: expectedSignature.sceneKey === currentSignature.sceneKey,
    sceneFingerprintMatch: expectedSignature.sceneFingerprint === currentSignature.sceneFingerprint,
    latestMesIdMatch: expectedSignature.latestMesId === currentSignature.latestMesId,
    messageCountMatch: expectedMessages.length === currentMessages.length,
    prefixHashMatch: hashJson(expectedMessages.slice(0, -1)) === hashJson(currentMessages.slice(0, -1)),
    prefixContentHashMatch: hashJson(expectedContentMessages.slice(0, -1)) === hashJson(currentContentMessages.slice(0, -1)),
    warmBaseHashMatch: expectedBaseSourceRevisionHash
      ? activeSourceRevisionHash(currentBaseSnapshot) === expectedBaseSourceRevisionHash
      : null,
    expectedLatest: latestDiagnostics(expectedLatest),
    currentLatest: latestDiagnostics(currentLatest)
  };
}

function promptSnapshotMetadataMatches(expected, current) {
  return expected?.chatId === current?.chatId
    && expected?.chatKey === current?.chatKey
    && expected?.sceneKey === current?.sceneKey
    && expected?.sceneFingerprint === current?.sceneFingerprint
    && expected?.turnFingerprint === current?.turnFingerprint
    && expected?.sourceRevisionHash === current?.sourceRevisionHash
    && expected?.latestMesId === current?.latestMesId;
}

function rebaseCardsForSnapshot(cards, snapshot) {
  const context = cardSourceContext(snapshot);
  return (Array.isArray(cards) ? cards : []).map((card) => normalizeCard(card, context));
}

function activeSourceRevisionHash(snapshot) {
  return safeText(snapshot?.sourceRevisionHash || sourceWindowFingerprint(snapshot), 180);
}

function latestVisibleAssistantEntry(snapshot, { allowEmpty = false } = {}) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.visible === false) continue;
    if (!allowEmpty && !String(message?.text ?? '').trim()) continue;
    if (safeProviderRole(message?.role) !== 'assistant') return null;
    return { message, index };
  }
  return null;
}

function latestVisibleMesId(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.visible === false) continue;
    if (!String(message?.text ?? '').trim()) continue;
    return numberOr(message?.mesid, index);
  }
  return 0;
}

function snapshotWithoutLatestAssistant(snapshot, entry) {
  if (!entry) return null;
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const nextMessages = messages.filter((_, index) => index !== entry.index);
  return normalizeSnapshot({
    ...snapshot,
    latestMesId: latestVisibleMesId(nextMessages),
    messages: nextMessages,
    sourceRevisionHash: '',
    turnFingerprint: ''
  });
}

export function generationBasisForSnapshot(snapshot, settings = {}) {
  const source = normalizeSnapshot(snapshot);
  const sourceWindow = sourceWindowMessages(source);
  if (!sourceWindow.length) return null;
  const retention = normalizeRetentionSettings(settings?.retention);
  return {
    chatKey: safeText(source.chatKey || DEFAULT_CHAT_ID, 160),
    sceneKey: safeText(source.sceneKey || DEFAULT_SCENE_KEY, 160),
    sceneFingerprint: safeText(source.sceneFingerprint || '', 180),
    latestMesId: numberOr(source.latestMesId, 0),
    sourceRevisionHash: activeSourceRevisionHash(source),
    sourceWindow,
    sourceWindowTruncated: source.sourceWindowTruncated === true,
    sourceWindowLimitReason: safeText(source.sourceWindowLimitReason || '', 40),
    sourceWindowContractHash: hashJson({
      sourceWindowMessages: retention.sourceWindowMessages,
      sourceWindowCharacters: retention.sourceWindowCharacters
    })
  };
}

export function generationBasisForLatestAssistantSwipe(snapshot, messageId = null, settings = {}) {
  const normalizedSnapshot = normalizeSnapshot(snapshot);
  const latestAssistant = latestVisibleAssistantEntry(normalizedSnapshot, { allowEmpty: true });
  if (!latestAssistant) return null;
  const latestMessageId = numberOr(latestAssistant.message?.mesid, latestAssistant.index);
  if (messageId !== null && messageId !== latestMessageId) return null;
  const sourceBeforeAssistant = snapshotWithoutLatestAssistant(normalizedSnapshot, latestAssistant);
  return sourceBeforeAssistant
    ? generationBasisForSnapshot(sourceBeforeAssistant, settings)
    : null;
}

export function preparedGenerationSettingsSignature(settings = {}) {
  const normalized = settingsWithRuntimeCardScope(settings, { normalize: true });
  const retention = normalizeRetentionSettings(normalized.retention);
  const providerSignature = (lane) => cacheProviderSettingsSignature(normalized.providers?.[lane]);
  return {
    enabled: normalized.enabled,
    mode: normalized.mode,
    pipelineMode: normalized.pipelineMode,
    cardScope: normalized.cardScope,
    strength: normalized.strength,
    minCards: normalized.minCards,
    maxCards: normalized.maxCards,
    modelAttemptsPerStep: normalized.modelAttemptsPerStep,
    requestDeadlineSeconds: normalized.requestDeadlineSeconds,
    operationDeadlineSeconds: normalized.operationDeadlineSeconds,
    reasoningLevel: normalized.reasoningLevel,
    promptFootprint: normalized.promptFootprint,
    focus: normalized.focus,
    reasonerUse: normalized.reasonerUse,
    storyFormOverride: normalized.storyFormOverride,
    injection: normalizeInjectionSettings(normalized.injection),
    retention: {
      sourceWindowMessages: retention.sourceWindowMessages,
      sourceWindowCharacters: retention.sourceWindowCharacters,
      providerVisibleMessages: retention.providerVisibleMessages
    },
    providers: {
      utility: providerSignature('utility'),
      reasoner: providerSignature('reasoner')
    }
  };
}

export function activeDeckRevisionHash(settings = {}) {
  const eligibility = activeCardDeckEligibility(settings);
  return hashJson({
    activeDeckId: eligibility.activeDeckId,
    sourceCardsByFamily: activeCardDeckSourceCards(settings),
    authoredCards: activeCardDeckAuthoredCards(settings)
  });
}

export function preparedGenerationContract(settings = {}) {
  const cacheVersions = cacheContractVersions(settings);
  const contract = {
    preparedGenerationVersion: PREPARED_GENERATION_VERSION,
    promptPacketVersion: PROMPT_PACKET_VERSION,
    runtimeCacheContractVersion: RUNTIME_CACHE_CONTRACT_VERSION,
    promptContractHash: cacheVersions.promptContractHash,
    providerContractHash: cacheVersions.providerContractHash,
    cardCatalogHash: cacheVersions.cardCatalogHash,
    activeDeckRevisionHash: activeDeckRevisionHash(settings),
    cardEligibilityHash: cacheVersions.cardEligibilityHash
  };
  return {
    ...contract,
    packetInputHash: hashJson({
      ...contract,
      settings: preparedGenerationSettingsSignature(settings)
    })
  };
}

function durableTurnContracts(settings = {}) {
  const prepared = preparedGenerationContract(settings);
  return {
    pipelineMode: settings.pipelineMode === 'fused' ? 'fused' : 'segmented',
    modelAttemptsPerStep: Math.max(1, Math.round(Number(settings.modelAttemptsPerStep) || 1)),
    deckRevisionHash: activeDeckRevisionHash(settings),
    providerContractHash: prepared.providerContractHash,
    promptContractHash: prepared.promptContractHash,
    packetInputHash: prepared.packetInputHash,
    schemaVersions: {
      pipelineRun: 2,
      checkpoint: 2,
      preparedGeneration: PREPARED_GENERATION_VERSION,
      promptPacket: PROMPT_PACKET_VERSION
    }
  };
}

function preparedTurnBasis({
  basis,
  packet,
  hand,
  contract,
  turnIdentity = null
} = {}) {
  const source = asObject(basis);
  const turn = asObject(turnIdentity);
  const originatingUserMessageId = safeText(
    turn.pendingUserMessageId || source.originatingUserMessageId || source.latestMesId || '',
    180
  );
  const sourceBandHash = safeText(
    turn.sourceBandHash || source.sourceBandHash || hashJson({
      chatKey: source.chatKey,
      sourceWindowContractHash: source.sourceWindowContractHash,
      compatibility: 'observable-source-window'
    }),
    180
  );
  const contractHash = safeText(
    turn.contractHash || source.contractHash || hashJson(contract || {}),
    180
  );
  return {
    ...source,
    turnKeyHash: safeText(
      turn.turnKeyHash || source.turnKeyHash || hashJson({
        chatKey: source.chatKey,
        sourceBandHash,
        originatingUserMessageId,
        contractHash
      }),
      180
    ),
    sourceBandHash,
    originatingUserMessageId,
    packetId: safeText(packet?.packetId || source.packetId || '', 180),
    handId: safeText(hand?.handId || source.handId || '', 180),
    contractHash
  };
}


function promptFootprintFromSettings(settings = {}) {
  const footprint = safeText(settings.promptFootprint || 'compact', 40);
  return PROMPT_FOOTPRINTS.has(footprint) ? footprint : 'compact';
}

function lifecycleForDeck(cards, plan, defaultReason) {
  const explicit = normalizePlanLifecycle(plan?.lifecycle);
  const cardIds = new Set((Array.isArray(cards) ? cards : []).map((card) => card?.id).filter(Boolean));
  const relevantExplicit = explicit.filter((entry) => cardIds.has(entry.cardId));
  if (!explicit.length) {
    return cards.map((card) => ({
      action: 'select',
      cardId: card.id,
      reason: defaultReason(card)
    }));
  }
  if (!relevantExplicit.length) {
    return cards.map((card) => ({
      action: 'select',
      cardId: card.id,
      reason: defaultReason(card)
    }));
  }
  const hasSelection = relevantExplicit.some((entry) => entry.action === 'select' || entry.action === 'emphasize');
  if (!hasSelection) return relevantExplicit;
  const touched = new Set(relevantExplicit.map((entry) => entry.cardId));
  const implicitStows = cards
    .filter((card) => card?.id && !touched.has(card.id))
    .map((card) => ({
      action: 'stow',
      cardId: card.id,
      reason: 'not selected by Utility Arbiter'
    }));
  return [...implicitStows, ...relevantExplicit];
}

function budgetOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function prioritySelectionForSettings(settings = {}) {
  if (settings?.mode === 'manual') {
    const forcedFamilies = runtimeScopePayload(settings).selectedFamilies || [];
    return {
      forcedCardIds: [...new Set([
        ...deckPriorityCardIds(getActiveCardDeck(settings), settings),
        ...activeCardDeckAuthoredCards(settings).map((card) => card.id)
      ])],
      forcedFamilies,
      diagnostics: forcedFamilies.length > 0 ? ['manual-card-scope-active'] : []
    };
  }
  const activeDeck = getActiveCardDeck(settings);
  const forcedCardIds = deckPriorityCardIds(activeDeck, settings);
  const forcedFamilies = deckPriorityFamilies(activeDeck, settings);
  return {
    forcedCardIds,
    forcedFamilies,
    diagnostics: forcedCardIds.length > 0 ? ['priority-cards-active'] : []
  };
}

function reconcileAutoPriorityPlan(plan, settings) {
  const policy = runPolicyForEffectivePlan(settings, plan);
  const deck = getActiveCardDeck(settings);
  const priorityIds = deckPriorityCardIds(deck, settings);
  const units = new Map();
  for (const id of priorityIds) {
    const card = deck.cards[id];
    const key = card.builtinFamily ? `family:${card.builtinFamily}` : `card:${id}`;
    if (!units.has(key)) units.set(key, card);
  }
  const selected = [...units.values()];
  const families = selected.map((card) => card.builtinFamily).filter(Boolean);
  const reserved = selected.filter((card) => !card.builtinFamily).length;
  const jobs = [...(plan.cardJobs || [])];
  for (const family of families) {
    const existing = jobs.findIndex((job) => catalogForCard(job)?.family === family);
    if (existing >= 0) {
      jobs[existing] = { ...jobs[existing], forcedBy: 'priority-selection' };
      continue;
    }
    const catalog = resolveCatalogForFamily(family);
    if (catalog) jobs.push({ family, role: catalog.role, forcedBy: 'priority-selection', reason: 'Priority card selected by the user.' });
  }
  const limited = limitCardJobsForHandBudget(jobs, {
    maxCards: budgetOr(plan.budgets?.maxCards, 6), behaviorPolicy: policy,
    reservedCardSlots: reserved, forcedFamilies: families
  });
  return {
    ...plan,
    action: families.length ? 'refresh-cards' : reserved && planAction(plan) === 'skip' ? 'compose-brief' : plan.action,
    cardJobs: limited.cardJobs,
    selection: {
      source: plan.diagnostics?.includes('arbiter-model-plan') ? 'arbiter' : 'fallback',
      proposed: plan.selection?.proposed || (plan.cardJobs || []).map(({ family, reason }) => ({ family, reason: reason || '' })),
      mandatoryCardIds: priorityIds,
      mandatoryFamilies: families,
      authoredSlots: reserved,
      availableSlots: Math.max(0, limited.metadata.maxCards - families.length),
      retained: limited.cardJobs.map(({ family, reason, forcedBy }) => ({ family, reason: reason || '', mandatory: Boolean(forcedBy) })),
      omitted: [...(plan.selection?.omitted || []), ...limited.omitted]
    },
    diagnostics: mergeDiagnostics(
      plan.diagnostics,
      priorityIds.length ? ['priority-cards-active'] : [],
      limited.omitted.length ? ['card-jobs-budgeted'] : [],
      limited.omitted.map((entry) => `card-job-budgeted:${entry.family}`)
    )
  };
}

function mergeForcedFamilies(...groups) {
  const result = [];
  const seen = new Set();
  for (const group of groups) {
    for (const family of Array.isArray(group) ? group : []) {
      const clean = String(family || '').trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

function budgetCardJobsForGeneration(plan, behaviorPolicy, forcedFamilies = []) {
  const limited = limitCardJobsForHandBudget(plan?.cardJobs, {
    maxCards: budgetOr(plan?.budgets?.maxCards, 6),
    behaviorPolicy,
    forcedFamilies
  });
  if (!limited.omitted.length) {
    return {
      plan: {
        ...plan,
        cardJobs: limited.cardJobs
      },
      omitted: [],
      metadata: limited.metadata
    };
  }
  return {
    plan: {
      ...plan,
      cardJobs: limited.cardJobs,
      diagnostics: mergeDiagnostics(
        plan.diagnostics,
        ['card-jobs-budgeted'],
        limited.omitted.map((entry) => `card-job-budgeted:${entry.family}`)
      )
    },
    omitted: limited.omitted,
    metadata: limited.metadata
  };
}

function cardEvidenceTokenBudget(settings, plan, behaviorPolicy = null) {
  const policy = behaviorPolicy || runPolicyForEffectivePlan(settings, plan);
  const budget = Number(policy?.footprint?.sectionBudgets?.cardEvidence);
  return Number.isFinite(budget) && budget > 0 ? Math.round(budget) : 30000;
}

function autoSelectionBudget(settings) {
  const deck = getActiveCardDeck(settings);
  const ids = settings.mode === 'auto' ? deckPriorityCardIds(deck, settings) : [];
  const families = [...new Set(ids.map((id) => deck.cards[id].builtinFamily).filter(Boolean))];
  const authoredSlots = ids.filter((id) => !deck.cards[id].builtinFamily).length;
  const maxCards = localFallbackPlan({}, settings).budgets.maxCards;
  const limited = limitCardJobsForHandBudget([], {
    maxCards, behaviorPolicy: influencePolicyForSettings(settings), reservedCardSlots: authoredSlots, forcedFamilies: families
  });
  return { maxCards, mandatoryCardIds: ids, mandatoryFamilies: families, authoredSlots,
    availableSlots: Math.max(0, limited.metadata.maxCards - families.length) };
}

function arbiterSafeSettings(settings, capabilityResolver = providerCapability) {
  const source = settingsWithRuntimeCardScope(settings);
  return {
    enabled: source.enabled !== false,
    mode: safeText(source.mode || 'auto', 40),
    cardDeck: {
      activeDeckId: safeText(source.preProcessDecks?.activeDeckId || '', 120),
      activeDeckName: safeText(getActiveCardDeck(source).name || '', 120)
    },
    selectionBudget: autoSelectionBudget(source),
    cardScope: cardScopeSummary(source.cardScope),
    strength: safeText(source.strength || 'balanced', 40),
    minCards: normalizeCardBudgetSettings(source).minCards,
    maxCards: normalizeCardBudgetSettings(source).maxCards,
    reasoningLevel: safeText(source.reasoningLevel || 'medium', 40),
    promptFootprint: safeText(source.promptFootprint || 'compact', 40),
    focus: safeText(source.focus || 'balanced', 80),
    reasonerUse: safeText(source.reasonerUse || 'auto', 40),
    providers: {
      utility: {
        source: safeText(source.providers?.utility?.source || '', 80),
        capability: capabilityResolver(source, 'utility', 'prompt-packet').state
      },
      reasoner: {
        source: safeText(source.providers?.reasoner?.source || '', 80),
        capability: capabilityResolver(source, 'reasoner', 'prompt-packet').state
      }
    }
  };
}

function safeProviderCertification(value) {
  const source = asObject(value);
  const checks = asObject(source.checks);
  const status = ['not-run', 'pass', 'partial', 'fail'].includes(safeText(source.status || '', 40))
    ? safeText(source.status || '', 40)
    : 'not-run';
  return {
    status,
    ...(safeText(source.checkedAt || '', 80) ? { checkedAt: safeText(source.checkedAt || '', 80) } : {}),
    ...(safeText(source.completionMode || '', 40) ? { completionMode: safeText(source.completionMode || '', 40) } : {}),
    ...(safeText(source.structuredOutput || '', 40) ? { structuredOutput: safeText(source.structuredOutput || '', 40) } : {}),
    checks: {
      connectivity: safeText(checks.connectivity || 'not-run', 40) || 'not-run',
      singleCard: safeText(checks.singleCard || 'not-run', 40) || 'not-run',
      fusedCards: safeText(checks.fusedCards || 'not-run', 40) || 'not-run',
      concurrency: safeText(checks.concurrency || 'not-run', 40) || 'not-run'
    },
    safeConcurrency: Math.min(3, Math.max(1, numberOr(source.safeConcurrency, 1))),
    diagnosticCodes: safeStringList(source.diagnosticCodes, 80).slice(0, 12),
    ...(safeText(source.compactError || '', 300) ? { compactError: safeText(source.compactError || '', 300) } : {})
  };
}

function safeProviderSettingsView(provider, settings, lane, capabilityResolver = providerCapability) {
  const source = asObject(provider);
  const generationPolicy = asObject(source.generationPolicy);
  const samplerOverrides = asObject(source.samplerOverrides);
  return {
    lane: safeText(source.lane || lane, 40),
    connectionProfileId: safeText(source.connectionProfileId || '', 160),
    generationPolicy: {
      presetMode: safeText(generationPolicy.presetMode || 'isolated', 40),
      instructMode: safeText(generationPolicy.instructMode || 'auto', 40),
      samplerMode: safeText(generationPolicy.samplerMode || 'profile', 40),
      structuredOutputMode: safeText(generationPolicy.structuredOutputMode || 'auto', 40)
    },
    samplerOverrides: {
      temperature: numberOr(samplerOverrides.temperature, lane === 'reasoner' ? 0.4 : 0.1),
      topP: numberOr(samplerOverrides.topP, 0.95)
    },
    outputTokenCeiling: numberOr(source.outputTokenCeiling, 8192),
    maxConcurrentRequests: numberOr(source.maxConcurrentRequests, 2),
    configRevision: numberOr(source.configRevision, 0),
    certification: safeProviderCertification(source.certification),
    capability: sanitizeProviderCapability(capabilityResolver(settings, lane, 'prompt-packet'))
  };
}

function safeSettingsView(settings, capabilityResolver = providerCapability) {
  const source = settingsWithRuntimeCardScope(settings);
  const cardScope = normalizeCardScope(source.cardScope);
  const cardBudget = normalizeCardBudgetSettings(source);
  const injection = normalizeInjectionSettings(source.injection);
  const normalizedSettings = normalizeSettings(source);
  const preProcessDecks = normalizedSettings.preProcessDecks;
  return {
    enabled: source.enabled !== false,
    mode: safeText(source.mode || 'auto', 40),
    pipelineMode: safeText(source.pipelineMode || 'segmented', 40),
    preProcessDecks,
    cardScopeSummary: cardScopeSummary(cardScope),
    strength: safeText(source.strength || 'balanced', 40),
    minCards: cardBudget.minCards,
    maxCards: cardBudget.maxCards,
    reasoningLevel: safeText(source.reasoningLevel || 'medium', 40),
    modelAttemptsPerStep: normalizedSettings.modelAttemptsPerStep,
    requestDeadlineSeconds: normalizedSettings.requestDeadlineSeconds,
    operationDeadlineSeconds: normalizedSettings.operationDeadlineSeconds,
    promptFootprint: safeText(source.promptFootprint || 'compact', 40),
    focus: safeText(source.focus || 'balanced', 80),
    reasonerUse: safeText(source.reasonerUse || 'auto', 40),
    storyFormOverride: safeText(source.storyFormOverride || 'auto', 40),
    postProcess: {
      enabled: normalizedSettings.postProcess.enabled === true,
      applyMode: safeText(normalizedSettings.postProcess.applyMode, 40),
      rewriteFlow: safeText(normalizedSettings.postProcess.rewriteFlow, 40),
      contextMessages: numberOr(normalizedSettings.postProcess.contextMessages, 13)
    },
    postProcessDecks: normalizedSettings.postProcessDecks,
    injection: {
      placement: safeText(injection.placement, 40),
      role: safeText(injection.role, 40),
      depth: numberOr(injection.depth, 1)
    },
    diagnostics: {
      includeExcerpts: source.diagnostics?.includeExcerpts === true
    },
    retention: normalizeRetentionSettings(source.retention),
    providers: {
      utility: safeProviderSettingsView(source.providers?.utility, source, 'utility', capabilityResolver),
      reasoner: safeProviderSettingsView(source.providers?.reasoner, source, 'reasoner', capabilityResolver)
    },
    providerCapabilities: {
      utility: {
        promptPacket: sanitizeProviderCapability(capabilityResolver(source, 'utility', 'prompt-packet')),
        providerTest: sanitizeProviderCapability(capabilityResolver(source, 'utility', 'provider-test')),
        redirect: sanitizeProviderCapability(capabilityResolver(source, 'utility', 'redirect'))
      },
      reasoner: {
        promptPacket: sanitizeProviderCapability(capabilityResolver(source, 'reasoner', 'prompt-packet')),
        providerTest: sanitizeProviderCapability(capabilityResolver(source, 'reasoner', 'provider-test')),
        redirect: sanitizeProviderCapability(capabilityResolver(source, 'reasoner', 'redirect'))
      }
    },
    ui: {
      viewerOpen: source.ui?.viewerOpen === true,
      tooltipsEnabled: source.ui?.tooltipsEnabled !== false,
      progressChildVisibleLimit: numberOr(source.ui?.progressChildVisibleLimit, 5),
      progressListVisibleLimit: numberOr(source.ui?.progressListVisibleLimit, 15)
    }
  };
}

function providerHealthForArbiter(settings, capabilityResolver = providerCapability) {
  const source = asObject(settings);
  const provider = (lane) => {
    const capability = capabilityResolver(source, lane, 'prompt-packet');
    return {
      status: capability.state,
      completionMode: capability.completionMode || 'unknown',
      structuredOutput: capability.structuredOutput || 'unknown'
    };
  };
  return {
    utility: provider('utility'),
    reasoner: provider('reasoner')
  };
}

function arbiterSafeRef(value, prefix = 'ref', limit = 160) {
  const text = safeText(value || '', limit);
  if (!text) return '';
  if (hasSecretText(text)) return `${prefix}:${hashJson(text)}`;
  if (/\s/.test(text) || text.length > 96) return `${prefix}:${hashJson(text)}`;
  const hyphenParts = text.split('-').filter(Boolean);
  if (!text.startsWith('card-') && hyphenParts.length > 4) return `${prefix}:${hashJson(text)}`;
  return text;
}

function arbiterFingerprintRef(value) {
  const text = safeText(value || '', 180);
  if (!text) return '';
  if (/^hash:[a-f0-9]{8}$/i.test(text)) return text;
  return `hash:${hashJson(text)}`;
}

function arbiterEvidenceRef(value) {
  const text = safeText(value || '', 80);
  if (!text) return '';
  if (/^message:\d+$/i.test(text)) return text;
  return `ref:${hashJson(text)}`;
}

function compactCacheCardForArbiter(card, snapshot) {
  const source = asObject(card);
  let normalized;
  try {
    normalized = normalizeCard(sanitizeGeneratedCard(source), {
      sceneId: snapshot?.sceneKey,
      chatId: snapshot?.chatId,
      snapshotHash: hashJson(snapshot || {}),
      lastMesId: snapshot?.latestMesId
    });
  } catch {
    return null;
  }
  const cardSource = asObject(normalized.source);
  const freshness = asObject(normalized.freshness);
  const id = arbiterSafeRef(normalized.id, 'card');
  const family = safeText(normalized.family || '', 120);
  if (!id || !family) return null;
  const output = {
    id,
    family,
    role: safeText(normalized.role || '', 120),
    status: safeText(normalized.status || 'active', 40),
    emphasis: safeText(normalized.emphasis || 'normal', 40),
    detailProfile: safeText(normalized.detailProfile || 'standard', 40),
    tokenEstimate: normalizeBudget(normalized.tokenEstimate, 0),
    evidenceRefs: safeStringList(normalized.evidenceRefs, 80).map(arbiterEvidenceRef).filter(Boolean).slice(0, 8),
    source: {
      firstMesId: numberOr(cardSource.firstMesId, 0),
      lastMesId: numberOr(cardSource.lastMesId, 0),
      fingerprint: arbiterFingerprintRef(cardSource.fingerprint || cardSource.snapshotHash || freshness.sourceFingerprint)
    },
    freshness: {
      sourceFingerprint: arbiterFingerprintRef(freshness.sourceFingerprint),
      ...(freshness.expiresAfterMesId !== undefined
        ? { expiresAfterMesId: normalizeBudget(freshness.expiresAfterMesId, 0) }
        : {})
    }
  };
  const summary = safeText(source.summary || '', 280);
  if (summary) output.summary = summary;
  return output;
}

function activeSceneCacheVariant(cache, snapshot) {
  const source = asObject(cache);
  const sourceRevisionHash = activeSourceRevisionHash(snapshot);
  const variants = asObject(source.variants);
  const exact = asObject(variants[sourceRevisionHash]);
  if (exact && Array.isArray(exact.cards)) {
    return {
      sourceRevisionHash,
      cards: exact.cards,
      latestHand: exact.latestHand || null,
      exact: true
    };
  }
  if (!Object.keys(variants).length && Array.isArray(source.cards)) {
    return {
      sourceRevisionHash: safeText(source.activeSourceRevisionHash || '', 180),
      cards: source.cards,
      latestHand: source.latestHand || null,
      exact: false
    };
  }
  return {
    sourceRevisionHash,
    cards: [],
    latestHand: null,
    exact: false
  };
}

function compactSceneCacheForArbiter(cache, snapshot, settings = {}) {
  const source = asObject(cache);
  const cacheState = ['active', 'stale', 'retired', 'invalid'].includes(source.cacheState) ? source.cacheState : 'active';
  const invalidation = asObject(source.invalidation);
  const invalidationReason = safeText(invalidation.reason || '', 120);
  const invalidationDetectedAt = safeText(invalidation.detectedAt || '', 80);
  const activeVariant = activeSceneCacheVariant(cache, snapshot);
  const cards = filterCardsForRuntimeScope(activeVariant.cards, settings).cards
    .map((card) => compactCacheCardForArbiter(card, snapshot))
    .filter(Boolean)
    .slice(0, 32);
  const latestHand = asObject(activeVariant.latestHand);
  const eligibleCardIds = new Set(cards.map((card) => String(card?.id || '').trim()).filter(Boolean));
  const handCards = Array.isArray(latestHand.cardIds)
      ? latestHand.cardIds
      .filter((cardId) => !usesCardDeckEligibility(settings) || eligibleCardIds.has(String(cardId || '').trim()))
      .map((cardId) => arbiterSafeRef(cardId || '', 'card')).filter(Boolean).slice(0, 16)
    : [];
  const handId = arbiterSafeRef(latestHand.handId || '', 'hand');
  return {
    available: cards.length > 0,
    sceneKey: safeText(snapshot?.sceneKey || DEFAULT_SCENE_KEY, 160) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(snapshot?.sceneFingerprint || '', 180),
    sourceRevisionHash: activeVariant.sourceRevisionHash,
    variantCount: Object.keys(asObject(source.variants)).length,
    activeVariantAvailable: activeVariant.exact || (!Object.keys(asObject(source.variants)).length && cards.length > 0),
    cacheState,
    ...(invalidationReason
      ? {
          invalidation: {
            reason: invalidationReason,
            ...(invalidationDetectedAt ? { detectedAt: invalidationDetectedAt } : {})
          }
        }
      : {}),
    cardCount: cards.length,
    latestHand: handId
      ? {
          handId,
          cardIds: handCards,
          tokenEstimate: normalizeBudget(latestHand.tokenEstimate, 0),
          selectedCount: handCards.length
        }
      : null,
    cards
  };
}

function runtimeError(error) {
  const wrapped = new Error(safeText(error?.message || error || 'Runtime failed.', 240));
  wrapped.code = safeText(error?.code || 'RECURSION_RUNTIME_FAILED', 120) || 'RECURSION_RUNTIME_FAILED';
  return wrapped;
}

function localCards(snapshot) {
  const latest = latestVisibleMessage(snapshot);
  const latestUser = latestVisibleUserMessage(snapshot);
  const latestText = safeText(latest?.text || '', 700);
  const latestUserText = safeText(latestUser?.text || '', 700);
  const evidenceMesId = latest?.mesid ?? snapshot.latestMesId ?? 0;
  const userEvidenceMesId = latestUser?.mesid ?? evidenceMesId;
  const context = cardSourceContext(snapshot);

  const scene = normalizeCard({
    family: 'Scene Frame',
    promptText: `Current scene context: ${latestText || 'continue the visible scene without broad recap.'}`,
    evidenceRefs: [`message:${evidenceMesId}`],
    emphasis: 'normal'
  }, context);
  const constraints = normalizeCard({
    family: 'Scene Constraints',
    role: 'sceneConstraintsCard',
    promptText: latestUserText
      ? `Respect hard scene constraints from the latest visible user action: ${latestUserText}`
      : 'Respect hard scene constraints from the visible turn: do not contradict stated access, timing, object state, or visible limits.',
    summary: 'Hard scene constraints from latest visible turn.',
    evidenceRefs: [`message:${userEvidenceMesId}`],
    emphasis: 'emphasized'
  }, context);
  return [scene, constraints];
}

function catalogForCard(card) {
  const role = safeText(card?.role || card?.roleId || '', 120);
  const family = safeText(card?.family || '', 120);
  return CARD_CATALOG.find((entry) => entry.role === role || entry.family === family) || null;
}

function scopeOmissionReasons(omissions) {
  return (Array.isArray(omissions) ? omissions : [])
    .map((entry) => safeText(entry?.reason || '', 180))
    .filter(Boolean);
}

function autoScopeExceptionReasons(entries, settings) {
  const scope = runtimeScopePayload(settings);
  if (scope.strictWhitelist) return [];
  const selected = new Set(scope.selectedFamilies);
  const exceptions = new Set(scope.autoExceptionFamilies);
  return [...new Set((Array.isArray(entries) ? entries : [])
    .map((entry) => catalogForCard(entry)?.family || safeText(entry?.family || '', 120))
    .filter((family) => family && !selected.has(family) && exceptions.has(family))
    .map((family) => `auto-scope-exception:${family}`))];
}

function resolveCatalogForFamily(family) {
  return CARD_CATALOG.find((entry) => entry.family === family) || null;
}

function activeCardFamilies(cards = []) {
  return new Set((Array.isArray(cards) ? cards : [])
    .filter((card) => card?.status === 'active' && card.family)
    .map((card) => card.family));
}

function reconcileManualForcedCardJobs({ plan, settings, cacheCards = [], forceContext = null } = {}) {
  const scope = runtimeScopePayload(settings);
  const entries = Array.isArray(plan?.cardJobs) ? plan.cardJobs : [];
  if (!scope.strictWhitelist) {
    return {
      cardJobs: entries,
      diagnostics: [],
      forcedFamilies: [],
      reusedFamilies: [],
      synthesizedFamilies: [],
      omitted: []
    };
  }
  const selectedFamilies = Array.isArray(scope.selectedFamilies) ? scope.selectedFamilies : [];
  const reusableFamilies = forceContext ? new Set() : activeCardFamilies(cacheCards);
  const jobsByFamily = new Map();
  for (const job of entries) {
    const catalog = catalogForCard(job);
    if (catalog && selectedFamilies.includes(catalog.family) && !jobsByFamily.has(catalog.family)) {
      jobsByFamily.set(catalog.family, { ...job, family: catalog.family, role: catalog.role });
    }
  }
  const diagnostics = [];
  const synthesizedFamilies = [];
  const reusedFamilies = [];
  for (const family of selectedFamilies) {
    if (jobsByFamily.has(family)) continue;
    if (reusableFamilies.has(family)) {
      reusedFamilies.push(family);
      diagnostics.push(`manual-forced-cache:${family}`);
      continue;
    }
    const catalog = resolveCatalogForFamily(family);
    if (!catalog) continue;
    synthesizedFamilies.push(family);
    diagnostics.push(`manual-forced-card:${family}`);
    jobsByFamily.set(family, {
      family: catalog.family,
      role: catalog.role,
      reason: 'Manual selected this card; runtime forced coverage because the Arbiter omitted it.',
      forcedBy: 'manual-selection'
    });
  }
  return {
    cardJobs: [...jobsByFamily.values()],
    diagnostics,
    forcedFamilies: selectedFamilies.slice(),
    reusedFamilies,
    synthesizedFamilies,
    omitted: []
  };
}

function cardScopePolicyLine(cardScope) {
  if (cardScope?.strictWhitelist) {
    return 'Manual card scope policy: allowedCatalog is a strict whitelist. Do not request disabled families or sub-items.';
  }
  return 'Auto card scope policy: selected families and sub-items are the preferred focus, not a whitelist. Prefer selected scope when it can satisfy the turn; request unselected families only when they have high relevance to scene constraints, scene coherence, or the current user message.';
}

function arbiterCardJobContractLine() {
  return [
    'Card job contract:',
    '- To create or refresh a card, emit a cardJobs entry.',
    '- Order cardJobs by contribution to this specific next reply, most useful first. This order governs discretionary selection; catalog priority does not.',
    '- Settings.selectionBudget gives mandatory cards and remaining discretionary slots after Priority reservations. Keep budgets.maxCards as the TOTAL hand budget, not remaining slots; choosing a smaller total reduces remaining slots further.',
    '- Mandatory families are covered regardless of your choices. Fit discretionary cardJobs within availableSlots. Fresh turns do not reuse previous-turn scene cards; same-turn swipes reuse the whole prepared packet without another Arbiter call.',
    '- Give each selected family a short reason naming its distinct contribution. Avoid multiple cards repeating the same setting, posture, or restriction. No discretionary family is automatically required.',
    '- Prefer Knowledge, Character Motivation, or Relationship when interpretation, personal stakes, or trust is the unresolved work; prefer physical or consequence families when those are what the scene needs. Do not rotate cards merely for variety.',
    '- Preserve established constraints without inventing delays, withholding ordinary clarification, or freezing progress merely because the larger uncertainty is unresolved.',
    '- Each new turn plans from the current scene snapshot; do not invent cached card ids or issue lifecycle requests for prior turns.',
    '- Do not include raw prompt text, hidden reasoning, provider endpoints, or host prompt instructions in plan fields.'
  ].join('\n');
}

function arbiterOutputContractLine(snapshotHash) {
  const frozenSnapshotHash = safeText(snapshotHash, 180);
  return [
    'Output contract:',
    'Return exactly one JSON object with these required top-level fields:',
    `- "schema": "${UTILITY_ARBITER_SCHEMA}"`,
    `- "snapshotHash": "${frozenSnapshotHash}"`,
    '- "action": "skip" | "reuse-cache" | "refresh-cards" | "compose-brief"',
    '- "sceneStatus": "same-scene" | "soft-shift" | "hard-shift" | "unknown"',
    '- "promptFootprint": "compact" | "normal" | "rich"',
    '- "storyForm": {"schema":"recursion.storyForm.v1","tense":"past|present|mixed|unknown","pov":"first-person|second-person|third-person-limited|third-person-omniscient|mixed|unknown","confidence":"high|medium|low","evidenceRefs":["message:N"],"reason":"string"}',
    '- "cardJobs": []',
    '- "reasonerDecision": {"mode":"use"|"skip","reason":"string","signals":[]}',
    '- "budgets": {"targetBriefTokens":500,"maxCards":6}',
    '- "diagnostics": []',
    'Do not emit reasoning, lifecycleActions, markdown, or prose.'
  ].join('\n');
}

function progressRetryCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(99, Math.floor(count));
}

function cardProgressDetail(card, source, state, options = {}) {
  const catalog = catalogForCard(card);
  const roleId = safeText(catalog?.role || card?.role || card?.roleId || '', 120);
  const family = safeText(catalog?.family || card?.family || '', 120);
  const providerLane = safeText(card?.providerLane || card?.lane || '', 40);
  const retryCount = progressRetryCount(card?.providerRetryCount || card?.retryCount);
  const reason = safeText(card?.providerProgressReason || card?.progressReason || '', 180);
  const expectedSourceCardIds = Array.isArray(card?.sourceCardIds) ? card.sourceCardIds.map(String).filter(Boolean) : [];
  const coveredSourceCardIds = Array.isArray(card?.coveredSourceCardIds) ? card.coveredSourceCardIds.map(String).filter(Boolean) : [];
  const omittedSourceCardIds = new Set(Array.isArray(card?.omittedSourceCardIds) ? card.omittedSourceCardIds.map(String).filter(Boolean) : []);
  const explicitParentStepId = safeText(options.parentStepId || '', 120);
  const sourceCatalog = CARD_SCOPE_CATALOG.find((entry) => entry.family === family || entry.role === roleId);
  const idSourceCards = expectedSourceCardIds.map((id) => {
    const key = String(id).split(':').pop();
    const item = sourceCatalog?.subItems?.find((candidate) => candidate.key === key);
    return { id, name: item?.label || key, selectionState: 'active' };
  });
  const sourceCards = Array.isArray(card?.sourceCards) && card.sourceCards.length
    ? card.sourceCards
    : (Array.isArray(options.sourceCards) && options.sourceCards.length ? options.sourceCards : idSourceCards);
  return {
    parentStepId: explicitParentStepId || (card?.providerRole === 'fusedCardBundle' ? 'fused-card-bundle' : 'utility-card-batch'),
    roleId,
    family,
    source,
    state,
    providerLane: providerLane === 'reasoner' ? 'reasoner' : 'utility',
    cardId: safeIdentifier(card?.id || '', 'card', 160),
    ...(sourceCards.length
      ? {
          sourceCards: sourceCards.map((sourceCard) => ({
            id: safeIdentifier(sourceCard?.id || '', 'source-card', 160),
            label: safeText(sourceCard?.name || sourceCard?.id || '', 120),
            selectionState: safeText(sourceCard?.selectionState || 'active', 40),
            state: omittedSourceCardIds.has(String(sourceCard?.id || ''))
              ? 'failed'
              : (card?.sourceCoverage === 'cached' ? 'cached' : state),
            reason: omittedSourceCardIds.has(String(sourceCard?.id || ''))
              ? 'Provider explicitly omitted this source card.'
              : (card?.inclusionEvidence === 'provider-confirmed'
                ? 'Included and confirmed by provider.'
                : 'Included in category generation.')
          }))
        }
      : {}),
    ...(expectedSourceCardIds.length ? {
      sourceCoverage: card?.sourceCoverage || 'included',
      inclusionEvidence: card?.inclusionEvidence || 'generation-contract',
      coveredSourceCardIds,
      ...(omittedSourceCardIds.size ? { omittedSourceCardIds: [...omittedSourceCardIds] } : {})
    } : {}),
    ...(retryCount ? { retryCount } : {}),
    ...(reason ? { reason } : {})
  };
}

function sanitizeGeneratedCard(card) {
  const rawId = String(card?.id ?? '').trim();
  const safeId = rawId && !hasSecretText(rawId) ? safeText(rawId, 160) : undefined;
  const sanitized = {
    ...card,
    id: safeId || undefined,
    promptText: safeText(card?.promptText || '', Infinity),
    summary: safeText(card?.summary || card?.promptText || '', 400),
    evidenceRefs: Array.isArray(card?.evidenceRefs)
      ? card.evidenceRefs.map((entry) => safeText(entry, 120)).filter(Boolean).slice(0, 12)
      : [],
    arbiter: {
      ...asObject(card?.arbiter),
      reason: safeText(card?.arbiter?.reason || '', 240)
    }
  };
  const retryCount = progressRetryCount(card?.providerRetryCount);
  const progressReason = safeText(card?.providerProgressReason || '', 180);
  if (retryCount) sanitized.providerRetryCount = retryCount;
  if (progressReason) sanitized.providerProgressReason = progressReason;
  if (card?.inspectorNotes) sanitized.inspectorNotes = safeText(card.inspectorNotes, 800);
  return sanitized;
}

function cardsWithOrigin(cards, origin) {
  return (Array.isArray(cards) ? cards : []).map((card) => ({
    ...card,
    origin
  }));
}

function safeActivity(activity, method, input, fallback = null) {
  try {
    const fn = activity?.[method];
    if (typeof fn !== 'function') return fallback;
    const result = fn.call(activity, input);
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return result ?? fallback;
  } catch {
    return fallback;
  }
}

function safeCurrentActivity(activity) {
  try {
    if (typeof activity?.current === 'function') return activity.current();
  } catch {
    return null;
  }
  return null;
}

function safeActivityHistory(activity) {
  try {
    if (typeof activity?.history === 'function') {
      const history = activity.history();
      return Array.isArray(history) ? history : [];
    }
  } catch {
    return [];
  }
  return [];
}

function signalAwareGenerationRouter(router, signal, runId) {
  if (!router || !signal) return router;
  return {
    ...router,
    generate(roleId, request = {}, options = {}) {
      const nextRequest = { ...asObject(request), signal };
      const nextOptions = {
        ...asObject(options),
        runId: options.runId ?? runId,
        signal: options.signal ?? signal
      };
      return router.generate(roleId, nextRequest, nextOptions);
    },
    batch(requests = [], options = {}) {
      if (typeof router.batch !== 'function') return undefined;
      const nextRequests = Array.isArray(requests)
        ? requests.map((request) => ({ ...asObject(request), signal: request?.signal ?? signal }))
        : requests;
      const nextOptions = {
        ...asObject(options),
        runId: options.runId ?? runId,
        signal: options.signal ?? signal
      };
      return router.batch(nextRequests, nextOptions);
    }
  };
}

export function createRecursionRuntime({
  host = {},
  settingsStore = createSettingsStore({ root: {} }),
  storage = createStorageRepository({ storage: createMemoryStorageAdapter() }),
  activity = createActivityReporter(),
  generationRouter = null
} = {}) {
  const runState = createRuntimeRunState();
  const activeProviderOperations = new Map();
  const activeProviderTests = new Map();
  const baseGenerationRouter = generationRouter;
  function providerOperationLane(request = {}) {
    return asObject(request).lane === 'reasoner' ? 'reasoner' : 'utility';
  }

  function beginProviderOperation(lane) {
    activeProviderOperations.set(lane, (activeProviderOperations.get(lane) || 0) + 1);
  }

  function endProviderOperation(lane) {
    const remaining = (activeProviderOperations.get(lane) || 0) - 1;
    if (remaining > 0) activeProviderOperations.set(lane, remaining);
    else activeProviderOperations.delete(lane);
  }

  function providerBusyResult(lane, operation = 'provider-test') {
    return {
      ok: false,
      roleId: operation === 'provider-test' ? 'providerTest' : '',
      lane,
      error: {
        code: 'RECURSION_PROVIDER_BUSY',
        message: `${lane === 'reasoner' ? 'Reasoner' : 'Utility'} is in use. Try again after the current operation finishes.`,
        retryable: true
      }
    };
  }

  if (baseGenerationRouter && typeof baseGenerationRouter.generate === 'function') {
    generationRouter = {
      ...baseGenerationRouter,
      async generate(roleId, request = {}, options = {}) {
        if (request?.certification === true || roleId === 'providerTest') {
          return baseGenerationRouter.generate(roleId, request, options);
        }
        const lane = providerOperationLane(request);
        if (activeProviderTests.has(lane)) return providerBusyResult(lane, 'operation');
        beginProviderOperation(lane);
        try {
          return await baseGenerationRouter.generate(roleId, request, options);
        } finally {
          endProviderOperation(lane);
        }
      },
      ...(typeof baseGenerationRouter.batch === 'function'
        ? {
            async batch(requests = [], options = {}) {
              const entries = Array.isArray(requests) ? requests : [];
              const lanes = [...new Set(entries.map(providerOperationLane))];
              const busyLane = lanes.find((lane) => activeProviderTests.has(lane));
              if (busyLane) return entries.map(() => providerBusyResult(busyLane, 'operation'));
              for (const lane of lanes) beginProviderOperation(lane);
              try {
                return await baseGenerationRouter.batch(entries, options);
              } finally {
                for (const lane of lanes) endProviderOperation(lane);
              }
            }
          }
        : {})
    };
  }
  let hostStopCleanupPromise = null;
  const turnTiming = createTurnTimingTracker();
  let stopGenerationPromise = null;
  let recursionStopRequest = null;
  let lastPreparedGeneration = null;
  let lastBriefPacket = null;
  let lastBriefHand = { cards: [], omitted: [] };
  let lastPlan = null;
  let lastSnapshot = null;
  let lastCacheDecision = null;
  let lastTurnScope = null;
  let lastBrief = {
    status: 'empty',
    reason: 'initial',
    packetId: '',
    handId: '',
    cardCount: 0,
    updatedAt: nowIso()
  };
  let promptInstallTail = Promise.resolve();
  let storageSaveTail = Promise.resolve();
  let pendingProseEnhancement = null;
  let activeProseEnhancementPromise = null;
  let activeProseEnhancementLifecycle = null;
  let canceledProseEnhancement = null;
  let lastEditorialResult = null;
  let executionView = null;
  let queuedReprocessView = null;
  let activeExecutionChatKey = '';
  const preprocessGraphs = new Map();
  const preprocessContexts = new Map();
  const durablePreparePromises = new Map();
  const executionScheduler = createExecutionScheduler({
    repository: storage,
    attemptsPerStep: () => settingsStore.get().modelAttemptsPerStep,
    onViewChanged(manifest) {
      if (!activeExecutionChatKey || manifest?.chatKey === activeExecutionChatKey) {
        executionView = manifest || null;
      }
    }
  });

  async function postProcessSourceStillCurrent(source = {}) {
    if (typeof host?.messages?.postProcessSourceIdentity !== 'function') return false;
    let identity;
    try {
      identity = await host.messages.postProcessSourceIdentity();
    } catch {
      return false;
    }
    if (!identity) return false;
    const expectedChatIdentityHash = safeText(source.chatIdentityHash || '', 180);
    const currentChatIdentityHash = safeText(identity.chatIdentityHash || '', 180);
    const currentHash = safeText(identity.originalHash || hashJson(String(identity.text ?? '')), 180);
    if (
      !expectedChatIdentityHash
      || currentChatIdentityHash !== expectedChatIdentityHash
      || Number(identity.messageId) !== Number(source.sourceMessageId)
      || Number(identity.swipeId ?? 0) !== Number(source.sourceSwipeId ?? 0)
      || currentHash !== safeText(source.sourceHash || '', 180)
    ) {
      return false;
    }
    return safeText(identity.activeCharacterHash || '', 180)
        === safeText(source.activeCharacterHash || '', 180)
      && safeText(identity.activeGroupHash || '', 180)
        === safeText(source.activeGroupHash || '', 180);
  }

  const postProcessRuntime = createPostProcessRuntime({
    host,
    generationRouter,
    settingsStore,
    activity,
    snapshotProvider: async () => ({
      ...(await host.snapshot()),
      preProcessPromptPacket: lastBriefPacket,
      storyForm: lastBriefPacket?.storyForm ?? null
    }),
    sourceGuard: postProcessSourceStillCurrent,
    durableExecution: {
      scheduler: executionScheduler,
      repository: storage,
      onQueuedReprocessChanged(intent) {
        queuedReprocessView = intent || null;
      }
    }
  });

  function createPreparedGenerationCandidate(packet, hand, snapshot, settings, turnIdentity = null) {
    const snapshotBasis = generationBasisForSnapshot(snapshot, settings);
    if (!snapshotBasis) return null;
    const contract = preparedGenerationContract(settings);
    const basis = preparedTurnBasis({
      basis: snapshotBasis,
      packet,
      hand,
      contract,
      turnIdentity
    });
    return createPreparedGenerationArtifact({
      packet,
      hand,
      basis,
      contract
    });
  }

  function commitPreparedGeneration(candidate) {
    if (!preparedGenerationIntegrityIsValid(candidate)) {
      throw new TypeError('Prepared generation candidate is invalid.');
    }
    lastPreparedGeneration = candidate;
    return candidate;
  }

  function clearPreparedGeneration() {
    lastPreparedGeneration = null;
  }

  function preparedPacket() {
    return lastPreparedGeneration?.packet || null;
  }

  function preparedHand() {
    return lastPreparedGeneration?.hand || { cards: [], omitted: [] };
  }

  async function readSnapshot(options = {}) {
    if (typeof host?.snapshot !== 'function') {
      throw new Error('Recursion runtime requires host.snapshot().');
    }
    return normalizeSnapshot(await host.snapshot(options));
  }

  async function readSwipeSourceSnapshot() {
    const snapshot = await readSnapshot({ withoutLatestAssistant: true });
    if (snapshot.latestAssistantExcluded === true) return snapshot;
    const latestAssistant = latestVisibleAssistantEntry(snapshot, { allowEmpty: true });
    return latestAssistant
      ? (snapshotWithoutLatestAssistant(snapshot, latestAssistant) || snapshot)
      : snapshot;
  }

  function isActiveRun(runId) {
    return runState.current().activeRunId === runId;
  }

  function isRuntimeRunCurrent(runId) {
    return isActiveRun(runId);
  }

  function abortActiveRun() {
    try {
      runState.current().activeRunController?.abort?.();
    } catch {
      // Abort notification is best-effort; supersession guards still prevent stale writes.
    }
  }

  function supersedeActiveRun() {
    abortActiveRun();
    runState.clearActiveRun();
  }

  function startRun(runId) {
    abortActiveRun();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    runState.setActiveRun(runId, controller);
    return controller?.signal ?? null;
  }

  function clearActiveRun(runId = null) {
    runState.clearActiveRun(runId);
  }

  function setHostGenerationActive(value) {
    runState.setHostGenerationActive(value);
  }

  function enhancementTarget(settings = settingsStore.get()) {
    const mode = safeText(settings?.enhancements?.mode || 'off', 40);
    if (['repair', 'recompose', 'redirect'].includes(mode)) return mode;
    return mode === 'off' ? safeText(settings?.enhancements?.target || 'off', 40) : 'off';
  }

  function enhancementApplyMode(settings = settingsStore.get()) {
    const mode = safeText(settings?.enhancements?.applyMode || 'as-swipe', 40);
    return mode === 'replace' ? 'replace' : 'as-swipe';
  }

  function proseEnhancementMode(settings = settingsStore.get()) {
    const target = enhancementTarget(settings);
    if (target === 'off') return 'off';
    return enhancementApplyMode(settings);
  }

  function proseEnhancementEnabled(settings = settingsStore.get()) {
    return enhancementTarget(settings) !== 'off';
  }

  function runtimeProviderCapability(settings, lane, operation) {
    return resolveProviderCapability({
      settings,
      lane,
      operation,
      host: {
        currentModelAvailable: Boolean(generationRouter?.generate),
        connectionProfiles: listProviderConnectionProfilesForUi()
      }
    });
  }

  function armProseEnhancementForHostGeneration(settings = settingsStore.get(), runId = '') {
    canceledProseEnhancement = null;
    if (!proseEnhancementEnabled(settings)) {
      pendingProseEnhancement = null;
      return false;
    }
    const target = enhancementTarget(settings);
    const redirectCapability = target === 'redirect'
      ? runtimeProviderCapability(settings, 'reasoner', 'redirect')
      : null;
    pendingProseEnhancement = {
      target,
      applyMode: enhancementApplyMode(settings),
      preparedAt: nowIso(),
      runId: safeText(runId || '', 120),
      ...(redirectCapability?.required
        ? {
            requiredCapability: {
              configHash: redirectCapability.configHash,
              configRevision: redirectCapability.configRevision
            }
          }
        : {}),
      ...(redirectCapability?.required && !redirectCapability.eligible
        ? { blockedCapability: sanitizeProviderCapability(redirectCapability) }
        : {}),
      ...(redirectCapability?.required && redirectCapability.eligible && redirectCapability.state === 'uncertified'
        ? { cautionCapability: sanitizeProviderCapability(redirectCapability) }
        : {})
    };
    return true;
  }

  function clearPendingProseEnhancement() {
    pendingProseEnhancement = null;
  }

  function cancelPendingProseEnhancement(reason = 'prose-enhancement-canceled') {
    canceledProseEnhancement = {
      reason: safeText(reason || 'prose-enhancement-canceled', 80),
      canceledAt: nowIso(),
      runId: safeText(pendingProseEnhancement?.runId || '', 120)
    };
    clearPendingProseEnhancement();
  }

  async function cancelActiveProseEnhancement(reason = 'prose-enhancement-canceled') {
    cancelPendingProseEnhancement(reason);
    const lifecycle = activeProseEnhancementLifecycle;
    if (!lifecycle?.promise) return { ok: true, skipped: true, reason: 'prose-enhancement-not-active' };
    lifecycle.cancelReason = safeText(reason || 'prose-enhancement-canceled', 80);
    try {
      lifecycle.controller?.abort?.();
    } catch {
      // Awaiting the lifecycle still prevents stale host mutation if abort delivery fails.
    }
    try {
      await lifecycle.promise;
    } catch {
      // Enhancement failures are normalized by the enhancement runner.
    }
    return { ok: true, canceled: true, reason: lifecycle.cancelReason };
  }

  function enhancementCancelReason(details = {}) {
    const lifecycle = details.enhancementLifecycle;
    if (!details.enhancementSignal?.aborted) return '';
    return safeText(lifecycle?.cancelReason || canceledProseEnhancement?.reason || 'prose-enhancement-canceled', 80);
  }

  function proseEnhancementPending() {
    return Boolean(pendingProseEnhancement);
  }

  function proseEnhancementRunning() {
    return Boolean(activeProseEnhancementPromise);
  }

  function proseEnhancementActive() {
    return Boolean(pendingProseEnhancement || activeProseEnhancementPromise);
  }

  async function waitForProseEnhancementBarrier() {
    let waited = false;
    while (proseEnhancementActive()) {
      waited = true;
      const active = activeProseEnhancementPromise;
      if (active) {
        await active.catch(() => null);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return { ok: true, waited };
  }

  async function holdPendingProseEnhancementMessage(details = {}) {
    if (!proseEnhancementPending()) return { ok: true, skipped: true, reason: 'prose-enhancement-not-pending' };
    if (!proseEnhancementEnabled()) return { ok: true, skipped: true, reason: 'prose-enhancement-disabled' };
    const messages = asObject(host.messages);
    if (typeof messages.activeAssistantMessageIdentity !== 'function' || typeof messages.holdAssistantMessage !== 'function') {
      return { ok: true, skipped: true, reason: 'host-message-api-unavailable' };
    }
    const identity = messages.activeAssistantMessageIdentity();
    if (!identity?.messageId && identity?.messageId !== 0) return { ok: true, skipped: true, reason: 'assistant-message-unavailable' };
    if (!identity?.text) return { ok: true, skipped: true, reason: 'assistant-message-empty' };
    const hold = await messages.holdAssistantMessage(identity.messageId, details);
    if (hold?.ok === false) return { ok: false, error: hold.error };
    return { ok: true, messageId: identity.messageId };
  }

  async function recoverHeldProseEnhancementMessages(details = {}) {
    if (proseEnhancementPending()) return { ok: true, skipped: true, reason: 'prose-enhancement-pending' };
    const messages = asObject(host.messages);
    if (typeof messages.recoverHeldAssistantMessages !== 'function') {
      return { ok: true, skipped: true, reason: 'host-message-api-unavailable' };
    }
    return messages.recoverHeldAssistantMessages({
      ...asObject(details),
      reason: safeText(details.reason || 'prose-enhancement-recovery', 80)
    });
  }

  function clearPendingLatestAssistantSwipeRetry() {
    runState.clearLatestAssistantSwipeRetry();
  }

  function freshNextGenerationView() {
    if (queuedReprocessView?.mode === 'full-fresh') {
      return {
        pending: true,
        id: '',
        reason: 'full-fresh',
        requestedAt: safeText(queuedReprocessView.queuedAt || '', 80),
        source: 'bar'
      };
    }
    const queuedFullFresh = runState.current().queuedFullFresh;
    if (!queuedFullFresh) {
      return {
        pending: false,
        id: '',
        reason: '',
        requestedAt: '',
        source: ''
      };
    }
    return {
      pending: true,
      id: safeText(queuedFullFresh.id || '', 180),
      reason: safeText(queuedFullFresh.reason || 'user-fresh-next-generation', 120),
      requestedAt: safeText(queuedFullFresh.requestedAt || '', 80),
      source: safeText(queuedFullFresh.source || 'bar', 80)
    };
  }

  function clearPendingFreshNextGeneration() {
    runState.clearQueuedFullFresh();
  }

  function freshNextGenerationDetails(freshContext, snapshot = null) {
    const source = asObject(freshContext);
    return {
      latestMesId: numberOr(snapshot?.latestMesId, 0),
      source: safeText(source.source || 'bar', 80),
      freshNextGenerationId: safeText(source.id || '', 180)
    };
  }

  function freshStaleSceneCache(cache, freshContext, snapshot = null) {
    if (!freshContext || !cache) return cache;
    return {
      ...cache,
      cacheState: 'stale',
      invalidation: {
        reason: 'user-fresh-next-generation',
        detectedAt: safeText(freshContext.requestedAt || nowIso(), 80),
        details: freshNextGenerationDetails(freshContext, snapshot)
      }
    };
  }

  function consumePendingFreshNextGeneration(runId) {
    const queuedFullFresh = runState.current().queuedFullFresh;
    if (!queuedFullFresh) return null;
    const token = {
      ...queuedFullFresh,
      consumeByRunId: safeText(runId || '', 160)
    };
    runState.clearQueuedFullFresh();
    return token;
  }

  async function queueFullFreshSwipe(details = {}) {
    const settings = settingsStore.get();
    if (settings.enabled === false) {
      clearPendingFreshNextGeneration();
      clearPendingLatestAssistantSwipeRetry();
      clearLastBrief({ status: 'empty', reason: 'disabled' });
      return { ok: true, skipped: true, reason: 'disabled' };
    }
    const snapshot = await readSnapshot();
    const chatKey = safeText(snapshot.chatKey || snapshot.chatId || DEFAULT_CHAT_ID, 180) || DEFAULT_CHAT_ID;
    const manifest = await storage.loadPipelineRun(chatKey);
    if (!manifest || manifest.state !== 'completed' || !manifest.turnKeyHash) {
      return { ok: false, reason: 'completed-turn-unavailable' };
    }
    const intent = {
      schema: QUEUED_REPROCESS_SCHEMA,
      chatKey,
      phase: 'preprocess',
      turnKeyHash: manifest.turnKeyHash,
      queuedAt: nowIso(),
      mode: 'full-fresh',
      stageIds: []
    };
    await storage.saveQueuedReprocess(chatKey, intent);
    activeExecutionChatKey = chatKey;
    queuedReprocessView = intent;
    clearPendingLatestAssistantSwipeRetry();
    settleRuntimeActivity({
      runId: makeId('queued-full-fresh'),
      outcome: 'success',
      phase: 'settled',
      severity: 'success',
      label: 'Full fresh generation queued.',
      chips: ['Queued']
    });
    return {
      ok: true,
      queuedReprocess: redact(intent),
      freshNextGeneration: {
        pending: true,
        id: '',
        reason: 'full-fresh',
        requestedAt: nowIso(),
        source: safeText(asObject(details).source || 'bar', 80) || 'bar'
      }
    };
  }

  async function clearQueuedFullFreshSwipe() {
    const snapshot = await readSnapshot();
    const chatKey = safeText(snapshot.chatKey || snapshot.chatId || DEFAULT_CHAT_ID, 180) || DEFAULT_CHAT_ID;
    const intent = await storage.loadQueuedReprocess(chatKey, 'preprocess');
    if (intent?.mode === 'full-fresh') await storage.clearQueuedReprocess(chatKey, 'preprocess');
    queuedReprocessView = intent?.mode === 'full-fresh' ? null : intent;
    settleRuntimeActivity({
      runId: makeId('queued-reprocess-canceled'),
      outcome: 'success',
      phase: 'settled',
      severity: 'success',
      label: 'Queued reprocessing canceled.',
      chips: ['Queued']
    });
    return {
      ok: true,
      queuedReprocess: queuedReprocessView ? redact(queuedReprocessView) : null,
      freshNextGeneration: freshNextGenerationView()
    };
  }

  function readyLastBrief({ runId = '', reason = 'packet-ready' } = {}) {
    const packet = preparedPacket();
    const hand = preparedHand();
    const cards = Array.isArray(hand?.cards) ? hand.cards : [];
    lastBriefPacket = packet || null;
    lastBriefHand = hand || { cards: [], omitted: [] };
    const sourceCardIds = new Set(cards.flatMap((card) => Array.isArray(card?.sourceCardIds) ? card.sourceCardIds : []));
    const missingSourceCardCount = cards.reduce((count, card) => (
      count + (Array.isArray(card?.omittedSourceCardIds) ? card.omittedSourceCardIds.length : 0)
    ), 0);
    const coverageStatus = missingSourceCardCount > 0
      ? 'degraded'
      : (sourceCardIds.size ? 'included' : 'none');
    lastBrief = {
      status: 'ready',
      reason,
      runId: safeText(runId, 160),
      packetId: safeText(packet?.packetId || '', 180),
      handId: safeText(hand?.handId || '', 180),
      cardCount: cards.length,
      sourceCardCount: sourceCardIds.size,
      coverageStatus,
      missingSourceCardCount,
      updatedAt: nowIso()
    };
  }

  function clearLastBrief({ status = 'clearing', reason = 'generation-started', runId = '' } = {}) {
    const previousCards = Array.isArray(lastBriefHand?.cards) ? lastBriefHand.cards : [];
    lastBriefPacket = null;
    lastBriefHand = { cards: [], omitted: [] };
    lastBrief = {
      status: ['clearing', 'empty'].includes(status) ? status : 'clearing',
      reason: safeText(reason, 120),
      runId: safeText(runId, 160),
      packetId: '',
      handId: '',
      cardCount: 0,
      previousPacketId: safeText(preparedPacket()?.packetId || lastBrief.packetId || '', 180),
      previousHandId: safeText(preparedHand()?.handId || lastBrief.handId || '', 180),
      previousCardCount: previousCards.length,
      sourceCardCount: 0,
      coverageStatus: 'none',
      missingSourceCardCount: 0,
      updatedAt: nowIso()
    };
  }

  function updateTurnScope(identity, {
    generationClassification = '',
    operationId = '',
    reused = false,
    invalidated = false,
    diagnosticCodes = []
  } = {}) {
    const source = asObject(identity);
    const sameIdentity = Boolean(
      lastTurnScope?.turnKeyHash
      && lastTurnScope.turnKeyHash === source.turnKeyHash
    );
    lastTurnScope = {
      turnKeyHash: safeText(source.turnKeyHash || '', 180),
      sourceBandHash: safeText(source.sourceBandHash || '', 180),
      sourceBandLimit: Math.max(0, Math.round(Number(source.sourceBandLimit) || 0)),
      sourceBandMessageCount: Math.max(0, Math.round(Number(source.sourceBandMessageCount) || 0)),
      sourceWindowFirstMesId: safeText(source.sourceWindowFirstMesId || '', 180),
      sourceWindowLastMesId: safeText(source.sourceWindowLastMesId || '', 180),
      generationClassification: safeText(generationClassification, 80),
      operationId: safeText(operationId, 180),
      reuseCount: (sameIdentity ? Number(lastTurnScope?.reuseCount || 0) : 0) + (reused ? 1 : 0),
      invalidationCount: Number(lastTurnScope?.invalidationCount || 0) + (invalidated ? 1 : 0),
      diagnosticCodes: [...new Set([
        ...(sameIdentity ? (lastTurnScope?.diagnosticCodes || []) : []),
        ...(Array.isArray(diagnosticCodes) ? diagnosticCodes : [])
      ].map((code) => safeText(code, 120)).filter(Boolean))].slice(0, 20)
    };
    return lastTurnScope;
  }

  function markLatestAssistantSwipeRetry(details = {}) {
    const source = asObject(details);
    const eventName = safeText(source.eventName || source.event || 'message_swiped', 80);
    const messageId = finiteNumberOrNull(source.messageId ?? source.mesid ?? source.id);
    runState.setLatestAssistantSwipeRetry({
      eventName,
      ...(messageId !== null ? { messageId } : {}),
      recordedAtMs: Date.now(),
      recordedAt: nowIso()
    });
    return {
      ok: true,
      skipped: true,
      reason: 'latest-assistant-swipe-retry',
      details: {
        ...(eventName ? { eventName } : {}),
        ...(messageId !== null ? { messageId } : {})
      }
    };
  }

  function clearVolatileSceneState({ preserveLastBrief = false } = {}) {
    clearPendingProseEnhancement();
    clearPreparedGeneration();
    lastPlan = null;
    lastSnapshot = null;
    runState.clearLatestAssistantSwipeRetry();
    runState.clearAttempt?.();
    runState.clearQueuedFullFresh();
    if (!preserveLastBrief) clearLastBrief({ status: 'empty', reason: 'source-cleared' });
  }

  function supersededResult(runId) {
    return { ok: false, superseded: true, runId };
  }

  function startRuntimeActivity(event) {
    return safeActivity(activity, 'start', event);
  }

  function stageRuntimeActivity(event) {
    const result = safeActivity(activity, 'stage', event);
    if (event?.runId && event?.phase && result?.phase !== event.phase) {
      return safeActivity(activity, 'start', event);
    }
    return result;
  }

  function stageCardProgress(runId, cards, { source, state, parentStepId, sourceCardsByFamily } = {}) {
    const list = Array.isArray(cards) ? cards : [];
    for (const card of list) {
      const retryCount = progressRetryCount(card?.providerRetryCount);
      const cardState = source === 'generated' && state === 'done' && retryCount > 0 ? 'warning' : state;
      const severity = cardState === 'failed' ? 'error' : (cardState === 'warning' ? 'warning' : 'success');
      const fallbackSourceCards = Array.isArray(card?.sourceCards) && card.sourceCards.length
        ? card.sourceCards
        : (sourceCardsByFamily?.[card?.family] || []);
      const detail = cardProgressDetail(card, source, cardState, { parentStepId, sourceCards: fallbackSourceCards });
      if (!detail.roleId && !detail.family) continue;
      const providerLane = source === 'generated' ? detail.providerLane : 'utility';
      const progressSource = detail.source || source;
      stageRuntimeActivity({
        runId,
        phase: 'cardProgress',
        severity,
        providerLane,
        composerLane: providerLane,
        label: `${detail.family || 'Card'} ${progressSource === 'cache' ? 'reused from cache' : (progressSource === 'fallback' ? 'fell back locally' : (retryCount > 0 ? 'generated after retry' : 'generated'))}.`,
        detail,
        chips: ['Cards', progressSource]
      });
    }
  }

  function settleRuntimeActivity(event) {
    const result = safeActivity(activity, 'settle', event);
    if (event?.runId && event?.label && result?.label !== event.label) {
      safeActivity(activity, 'start', event);
      return safeActivity(activity, 'settle', event);
    }
    return result;
  }

  function providerLane(value) {
    return cleanString(value).toLowerCase() === 'reasoner' ? 'reasoner' : 'utility';
  }

  function ownsPromptMutationActivity(runId) {
    return runState.current().activePromptMutationId === runId && safeCurrentActivity(activity)?.runId === runId;
  }

  async function clearPromptAfterSupersede({
    successLabel = 'Recursion prompt cleared after settings change.',
    journalReason = 'settings-changed'
  } = {}) {
    const runId = makeId('settings');
    clearPendingLatestAssistantSwipeRetry();
    clearPendingFreshNextGeneration();
    runState.setPromptMutation(runId);
    startRuntimeActivity({
      runId,
      phase: 'promptClearing',
      label: 'Clearing Recursion prompt...',
      chips: ['Prompt']
    });
    const clear = await runPromptMutationSection(null, async () => {
      const result = await clearPromptBestEffort(host);
      await appendPromptClearedJournal(runId, promptClearContext(), result, journalReason);
      return result;
    });
    if (!ownsPromptMutationActivity(runId)) {
      runState.clearPromptMutation(runId);
      return clear;
    }
    if (clear?.ok === false) {
      reportClearWarning(runId, clear);
      runState.clearPromptMutation(runId);
      return clear;
    }
    settleRuntimeActivity({
      runId,
      outcome: 'success',
      phase: 'settled',
      label: successLabel,
      chips: ['Prompt']
    });
    runState.clearPromptMutation(runId);
    return clear;
  }

  function manualTrimPreferenceFamiliesForRuntime(settings = {}) {
    const fromLastHand = Array.isArray(preparedHand()?.cards)
      ? preparedHand().cards.map((card) => safeText(card?.family || '', 120)).filter(Boolean)
      : [];
    const focusFamilies = influencePolicyForSettings(settings).focus?.boostedFamilies || [];
    return [...fromLastHand, ...focusFamilies];
  }

  function shouldEnforceManualSelectionCapForPatch(currentSettings = {}, nextSettings = {}, patch = {}) {
    if (nextSettings?.mode !== 'manual') return false;
    const changedToManual = patch.mode === 'manual' && currentSettings?.mode !== 'manual';
    const changedScope = Object.prototype.hasOwnProperty.call(patch, 'cardScope');
    const changedMaxCards = Object.prototype.hasOwnProperty.call(patch, 'maxCards');
    return changedToManual || changedScope || changedMaxCards;
  }

  function settingValuesEqual(left, right) {
    return hashJson(left) === hashJson(right);
  }

  function changedSettingKeys(patch, before, after) {
    return Object.keys(asObject(patch)).filter((key) => !settingValuesEqual(before?.[key], after?.[key]));
  }

  function isPipelineOnlySettingsChange(keys) {
    return keys.length === 1 && keys[0] === 'pipelineMode';
  }

  async function reconcileDurableExecutionAfterSettingsChange() {
    if (!executionView?.operationId) return null;
    if (executionView.state === 'running') {
      await pauseOperation({ reason: 'settings-changed' });
    }
    return restoreExecutionState();
  }

  async function updateSettings(patch = {}) {
    const cleanPatch = asObject(patch);
    const currentSettings = settingsStore.get();
    let next = settingsStore.update(cleanPatch);
    if (shouldEnforceManualSelectionCapForPatch(currentSettings, next, cleanPatch)) {
      const manualScoped = enforceManualSelectionCap(activeCardDeckRuntimeScope(next), next, {
        preferredFamilies: manualTrimPreferenceFamiliesForRuntime(next)
      });
      if (manualScoped.trimmed) {
        next = settingsStore.update({ cardScope: manualScoped.scope });
      }
    }
    const changedKeys = changedSettingKeys(cleanPatch, currentSettings, next);
    if (changedKeys.length === 0) {
      return { ok: true, settings: next, clear: null };
    }
    const promptNeutralPatch = changedKeys.length > 0
      && changedKeys.every((key) => PROMPT_NEUTRAL_SETTING_KEYS.has(key));
    if (promptNeutralPatch) {
      return { ok: true, settings: next, clear: null };
    }
    if (isPipelineOnlySettingsChange(changedKeys)) {
      supersedeActiveRun();
      const executionReconcile = reconcileDurableExecutionAfterSettingsChange();
      return trackRuntimeMutation(async () => {
        await executionReconcile;
        const clear = await clearPromptAfterSupersede({
          successLabel: 'Recursion prompt cleared after pipeline change.',
          journalReason: 'pipeline-mode-changed'
        });
        return {
          ok: clear?.ok !== false,
          settings: next,
          clear,
          pipelineChange: {
            deferred: true,
            previous: safeText(currentSettings.pipelineMode || 'segmented', 40),
            next: safeText(next.pipelineMode || 'segmented', 40)
          }
        };
      });
    }
    if (changedKeys.length > 0) {
      supersedeActiveRun();
      if (next.enabled === false) clearPreparedGeneration();
      const executionReconcile = reconcileDurableExecutionAfterSettingsChange();
      const result = await trackRuntimeMutation(async () => {
        await executionReconcile;
        const clear = await clearPromptAfterSupersede({
          successLabel: next.enabled === false
            ? 'Recursion disabled. Prompt cleared.'
            : 'Recursion prompt cleared after settings change.',
          journalReason: 'settings-changed'
        });
        return { ok: clear?.ok !== false, settings: next, clear };
      });
      return result;
    }
    return { ok: true, settings: next, clear: null };
  }

  function recordCacheDecision(runId, decision = {}) {
    const sequence = numberOr(lastCacheDecision?.sequence, 0) + 1;
    lastCacheDecision = {
      sequence,
      decision: safeText(decision.decision || '', 40),
      kind: safeText(decision.kind || '', 60),
      reason: safeText(decision.reason || '', 180),
      variant: safeText(decision.variant || '', 40),
      basisMode: safeText(decision.basisMode || '', 40),
      basisReason: safeText(decision.basisReason || '', 120),
      artifactHash: safeText(decision.artifactHash || '', 180),
      packetId: safeText(decision.packetId || '', 180),
      handId: safeText(decision.handId || '', 180),
      reusedCardIds: Array.isArray(decision.reusedCardIds) ? decision.reusedCardIds.map((id) => safeText(id, 160)).filter(Boolean).slice(0, 32) : [],
      providerCallsSkipped: Array.isArray(decision.providerCallsSkipped) ? decision.providerCallsSkipped.map((role) => safeText(role, 80)).filter(Boolean).slice(0, 16) : [],
      recordedAt: nowIso()
    };
    return lastCacheDecision;
  }

  async function resetSettingsMenu() {
    const before = settingsStore.get();
    const next = settingsStore.resetSettingsMenu();
    const resetKeys = [
      'strength',
      'minCards',
      'maxCards',
      'focus',
      'promptFootprint',
      'modelAttemptsPerStep',
      'requestDeadlineSeconds',
      'operationDeadlineSeconds',
      'injection',
      'ui',
      'postProcess',
      'retention',
      'diagnostics'
    ];
    const changedKeys = resetKeys.filter((key) => !settingValuesEqual(before[key], next[key]));
    if (changedKeys.length === 0) {
      return { ok: true, reset: false, settings: next, clear: null };
    }

    supersedeActiveRun();
    return trackRuntimeMutation(async () => {
      await reconcileDurableExecutionAfterSettingsChange();
      const clear = await clearPromptAfterSupersede({
        successLabel: 'Recursion settings reset to defaults. Providers and decks were preserved.',
        journalReason: 'settings-reset'
      });
      return {
        ok: clear?.ok !== false,
        reset: true,
        settings: next,
        clear
      };
    });
  }

  async function updateProviderConfig(lane, patch = {}, options = {}) {
    const resolvedLane = providerLane(lane);
    const beforeSettings = settingsStore.get();
    const beforeCapability = runtimeProviderCapability(beforeSettings, resolvedLane, 'prompt-packet');
    const update = settingsStore.updateProviderConfig(resolvedLane, patch, options);
    if (update.ok !== true || update.changedKeys.length === 0) {
      return { ...update, clear: null };
    }
    const provider = update.provider;
    supersedeActiveRun();
    return trackRuntimeMutation(async () => {
      const afterSettings = settingsStore.get();
      const afterCapability = runtimeProviderCapability(afterSettings, resolvedLane, 'prompt-packet');
      await appendProviderCapabilityMutation({
        lane: resolvedLane,
        kind: 'configuration',
        changedKeys: update.changedKeys,
        before: beforeCapability,
        after: afterCapability
      });
      await reconcileDurableExecutionAfterSettingsChange();
      const clear = await clearPromptAfterSupersede({
        successLabel: 'Recursion prompt cleared after provider change.',
        journalReason: 'provider-changed'
      });
      return { ok: clear?.ok !== false, provider, changedKeys: update.changedKeys, clear };
    });
  }

  function safeProviderProfiles(profiles = []) {
    return Array.isArray(profiles)
      ? profiles.slice(0, 100).map((profile) => ({
        id: safeIdentifier(profile?.id || '', '', 160),
        name: safeText(profile?.name || profile?.label || profile?.id || '', 180),
        model: safeText(profile?.model || '', 180),
        label: safeText(profile?.label || profile?.name || profile?.id || '', 240),
        completionMode: ['chat', 'text'].includes(safeText(profile?.completionMode || '', 20))
          ? safeText(profile?.completionMode, 20)
          : 'unknown',
        presetName: safeText(profile?.presetName || '', 180),
        instructName: safeText(profile?.instructName || '', 180)
      })).filter((profile) => profile.id)
      : [];
  }

  function listProviderConnectionProfilesForUi(options = {}) {
    try {
      if (typeof host?.providerProfiles?.list === 'function') {
        return safeProviderProfiles(host.providerProfiles.list(options));
      }
      if (typeof host?.listConnectionProfiles === 'function') {
        return safeProviderProfiles(host.listConnectionProfiles(options));
      }
      if (typeof host?.providerClient?.listProfiles === 'function') {
        return safeProviderProfiles(host.providerClient.listProfiles(options));
      }
    } catch {
      return [];
    }
    return [];
  }

  function safeRuntimeView() {
    const state = runState.current();
    const activeExecutionGraph = executionView
      ? (
          preprocessGraphs.get(executionView.operationId)
          || postProcessRuntime.executionGraph?.(executionView.operationId)
          || null
        )
      : null;
    const stageForView = (record) => {
      const safeRecord = redact(record);
      const stage = activeExecutionGraph?.getStage?.(record?.stageId);
      if (!stage) return safeRecord;
      return {
        ...safeRecord,
        executable: stage.executable !== false,
        failurePolicy: safeText(stage.failurePolicy || 'blocking', 40),
        dependencies: safeStringList(stage.dependencies, 180),
        outcomeChildren: Array.isArray(stage.outcomeChildren)
          ? stage.outcomeChildren.map((child) => ({
              stageId: safeIdentifier(child?.id || '', 'outcome', 180),
              id: safeIdentifier(child?.id || '', 'outcome', 180),
              kind: safeText(child?.kind || 'validation-outcome', 80),
              executable: false,
              label: safeText(
                child?.selectedCard?.family
                || child?.selectedCard?.name
                || child?.id
                || '',
                120
              )
            }))
          : []
      };
    };
    return {
      activeRunId: state.activeRunId,
      turnTiming: turnTiming.snapshot(),
      hostGenerationActive: state.hostGenerationActive,
      activeAttempt: state.activeAttempt,
      lastPreparedGeneration,
      lastPacket: lastPreparedGeneration?.packet || null,
      lastHand: lastPreparedGeneration?.hand || { cards: [], omitted: [] },
      lastBriefPacket,
      lastBriefHand,
      lastPlan,
      lastCacheDecision,
      lastSnapshot: viewSnapshot(lastSnapshot),
      turnScope: lastTurnScope ? { ...lastTurnScope } : null,
      lastBrief: { ...lastBrief },
      freshNextGeneration: freshNextGenerationView(),
      execution: executionView
        ? {
            operationId: safeIdentifier(executionView.operationId || '', 'operation', 180),
            chatKey: safeText(executionView.chatKey || '', 180),
            phase: safeText(executionView.phase || '', 80),
            state: safeText(executionView.state || '', 40),
            pipelineDecision: executionView.pipelineDecision ? { ...executionView.pipelineDecision } : null,
            recoveryBudget: executionView.recoveryBudget ? { ...executionView.recoveryBudget, reservationIds: undefined } : null,
            frontierStageIds: safeStringList(executionView.frontierStageIds, 180),
            resumable: executionView.state === 'paused'
              && !String(executionView.pauseReason || '').startsWith('stage-failed:')
              && !(executionView.staleChangedFields || []).length,
            staleFields: safeStringList(executionView.staleChangedFields, 120),
            pauseReason: safeText(executionView.pauseReason || '', 160),
            stages: Object.values(asObject(executionView.stageRecords)).map(stageForView),
            stageRecords: redact(executionView.stageRecords || {})
          }
        : null,
      queuedReprocess: queuedReprocessView ? redact(queuedReprocessView) : null,
      activity: safeCurrentActivity(activity),
      activityHistory: safeActivityHistory(activity),
      editorialResult: lastEditorialResult ? { ...lastEditorialResult } : null,
      providerProfiles: listProviderConnectionProfilesForUi(),
      settings: safeSettingsView(settingsStore.get(), runtimeProviderCapability),
      contextContract: buildContextContract(lastSnapshot || {}, settingsStore.get()),
      updatedAt: nowIso()
    };
  }

  function currentDiagnosticsChatKey() {
    const snapshot = viewSnapshot(lastSnapshot);
    return safeText(snapshot?.chatKey || snapshot?.chatId || DEFAULT_CHAT_ID, 160) || DEFAULT_CHAT_ID;
  }

  async function exportDiagnostics() {
    const chatKey = currentDiagnosticsChatKey();
    let index = null;
    let journal = null;
    try {
      index = await storage.readIndex?.();
    } catch {
      index = null;
    }
    try {
      journal = await storage.loadRunJournal?.(chatKey);
    } catch {
      journal = null;
    }
    const settings = settingsStore.get();
    const payload = buildDiagnosticsPayload({
      view: safeRuntimeView(),
      settings,
      cacheContracts: cacheContractVersions(settings),
      journal,
      index,
      chatKey,
      includeExcerpts: Boolean(settings?.diagnostics?.includeExcerpts)
    });
    return { ok: true, diagnostics: payload };
  }

  async function clearRunJournal() {
    const chatKey = currentDiagnosticsChatKey();
    const runId = makeId('journal-clear');
    supersedeActiveRun();
    return trackRuntimeMutation(async () => {
      startRuntimeActivity({
        runId,
        phase: 'storageProgress',
        mode: 'review',
        severity: 'info',
        label: 'Clearing Recursion run journal...',
        chips: ['Diagnostics']
      });
      const result = typeof storage.clearRunJournal === 'function'
        ? await storage.clearRunJournal(chatKey)
        : { ok: false, reason: 'unsupported' };
      if (result?.ok === false) {
        settleRuntimeActivity({
          runId,
          outcome: 'warning',
          phase: 'storageWarning',
          severity: 'warning',
          label: 'Run journal clear failed.',
          chips: ['Diagnostics'],
          detail: redact(result)
        });
        return { ok: false, chatKey, result: redact(result) };
      }
      settleRuntimeActivity({
        runId,
        outcome: 'success',
        phase: 'settled',
        severity: 'success',
        label: 'Run journal cleared.',
        chips: ['Diagnostics']
      });
      return { ok: true, chatKey, result: redact(result) };
    });
  }

  async function resetTurnCache() {
    const runId = makeId('turn-reset');
    supersedeActiveRun();
    postProcessRuntime.cancelPostProcess('reset-turn-cache');
    const operationId = safeText(executionView?.operationId || '', 180);
    return trackRuntimeMutation(async () => {
      startRuntimeActivity({
        runId,
        phase: 'storageProgress',
        mode: 'review',
        severity: 'info',
        label: 'Resetting current-turn Recursion data...',
        chips: ['Turn']
      });
      let snapshot = null;
      try {
        snapshot = await readSnapshot();
      } catch {
        snapshot = lastSnapshot ? normalizeSnapshot(lastSnapshot) : normalizeSnapshot({});
      }
      lastSnapshot = snapshot;
      const chatKey = safeText(snapshot.chatKey || snapshot.chatId || DEFAULT_CHAT_ID, 160) || DEFAULT_CHAT_ID;
      const revoke = operationId
        ? await storage.revokeTurnExecution(chatKey, {
            operationId,
            reason: 'reset-turn-cache'
          })
        : { ok: true, revoked: false, reason: 'missing-operation' };
      if (operationId) {
        preprocessContexts.delete(operationId);
        preprocessGraphs.delete(operationId);
      }
      executionView = null;
      queuedReprocessView = null;
      if (revoke?.ok === false) {
        settleRuntimeActivity({
          runId,
          outcome: 'warning',
          phase: 'storageWarning',
          severity: 'warning',
          label: 'Current-turn Recursion reset failed.',
          chips: ['Turn'],
          detail: redact(revoke)
        });
        return {
          ok: false,
          chatKey,
          revoke: redact(revoke),
          clear: null
        };
      }
      clearPreparedGeneration();
      lastPlan = null;
      runState.clearLatestAssistantSwipeRetry();
      runState.clearQueuedFullFresh();
      clearLastBrief({ status: 'empty', reason: 'reset-turn-cache' });
      stageRuntimeActivity({
        runId,
        phase: 'promptClearing',
        mode: 'review',
        severity: 'info',
        label: 'Clearing Recursion prompt after current-turn reset...',
        chips: ['Turn', 'Prompt']
      });
      const clear = await runPromptMutationSection(null, async () => {
        const clearResult = await clearPromptBestEffort(host);
        await appendPromptClearedJournal(runId, promptClearContext(snapshot), clearResult, 'reset-turn-cache');
        return clearResult;
      });
      if (clear?.ok === false) {
        reportClearWarning(runId, clear);
        return {
          ok: false,
          chatKey,
          revoke: redact(revoke),
          clear
        };
      }
      settleRuntimeActivity({
        runId,
        outcome: 'success',
        phase: 'settled',
        severity: 'success',
        label: 'Current-turn Recursion data reset. Prompt cleared.',
        chips: ['Turn', 'Prompt']
      });
      return {
        ok: true,
        chatKey,
        revoke: redact(revoke),
        clear
      };
    });
  }

  async function requestHostGenerationStop(details = {}) {
    const source = asObject(details);
    if (typeof host?.generation?.stop !== 'function') {
      return {
        ok: false,
        stopped: false,
        eventEmitted: false,
        error: {
          code: 'RECURSION_HOST_STOP_UNAVAILABLE',
          message: 'SillyTavern stop generation API is unavailable.'
        }
      };
    }
    try {
      const result = await host.generation.stop({
        source: safeText(source.source || 'recursion-ui', 80),
        reason: safeText(source.reason || 'stop-generation', 80)
      });
      return asObject(result);
    } catch (error) {
      return {
        ok: false,
        stopped: false,
        eventEmitted: false,
        error: {
          code: safeText(error?.code || error?.name || 'RECURSION_HOST_STOP_FAILED', 120),
          message: safeText(error?.message || error || 'SillyTavern stop generation failed.', 300)
        }
      };
    }
  }

  async function requestHostGenerationStart(details = {}) {
    const source = asObject(details);
    if (typeof host?.generation?.start !== 'function') {
      return {
        ok: false,
        started: false,
        completed: false,
        error: {
          code: 'RECURSION_HOST_GENERATION_UNAVAILABLE',
          message: 'SillyTavern native generation API is unavailable.'
        }
      };
    }
    try {
      const result = await host.generation.start({
        type: safeText(source.type || 'regenerate', 80) || 'regenerate',
        source: safeText(source.source || 'recursion-ui', 80) || 'recursion-ui',
        reason: safeText(source.reason || 'force-regenerate', 80) || 'force-regenerate'
      });
      return asObject(result);
    } catch (error) {
      return {
        ok: false,
        started: false,
        completed: false,
        error: {
          code: safeText(error?.code || error?.name || 'RECURSION_HOST_GENERATION_FAILED', 120),
          message: safeText(error?.message || error || 'SillyTavern native generation failed.', 300)
        }
      };
    }
  }

  async function clearForHostEvent({
    idPrefix,
    reason,
    startLabel,
    successLabel,
    chips,
    outcome = 'success',
    settleSeverity = 'success',
    clearVolatileState = true,
    preserveLastBrief = false,
    clearSwipeRetry = true
  }) {
    postProcessRuntime.cancelPostProcess(reason);
    const runId = makeId(idPrefix);
    if (clearSwipeRetry) clearPendingLatestAssistantSwipeRetry();
    clearPendingFreshNextGeneration();
    await pauseOperation({ reason });
    supersedeActiveRun();
    return trackRuntimeMutation(async () => {
      const clearContext = promptClearContext();
      startRuntimeActivity({
        runId,
        phase: 'promptClearing',
        mode: 'review',
        severity: 'info',
        label: startLabel,
        chips
      });
      if (clearVolatileState) clearVolatileSceneState({ preserveLastBrief });
      const clear = await runPromptMutationSection(null, async () => {
        const clearResult = await clearPromptBestEffort(host);
        await appendPromptClearedJournal(runId, clearContext, clearResult, reason);
        return clearResult;
      });
      if (clear?.ok === false) {
        reportClearWarning(runId, clear);
        return { ok: false, clear };
      }
      settleRuntimeActivity({
        runId,
        outcome,
        phase: 'settled',
        severity: settleSeverity,
        label: successLabel,
        chips
      });
      return { ok: true, clear };
    });
  }

  async function handleChatChanged() {
    turnTiming.mark(turnTiming.snapshot()?.attemptId, 'invalidate', { reason: 'chat-changed' });
    return clearForHostEvent({
      idPrefix: 'chat-change',
      reason: 'chat-changed',
      startLabel: 'Clearing Recursion prompt after chat change...',
      successLabel: 'Chat changed. Recursion prompt cleared.',
      chips: ['Chat', 'Prompt']
    });
  }

  async function handleSourceChanged() {
    turnTiming.mark(turnTiming.snapshot()?.attemptId, 'invalidate', { reason: 'source-changed' });
    return clearForHostEvent({
      idPrefix: 'source-change',
      reason: 'source-changed',
      startLabel: 'Clearing Recursion prompt after source message change...',
      successLabel: 'Source messages changed. Recursion prompt cleared.',
      chips: ['Source', 'Prompt'],
      preserveLastBrief: true
    });
  }

  async function handleHostGenerationStopped(details = {}) {
    turnTiming.mark(turnTiming.snapshot()?.attemptId, 'invalidate', { reason: 'generation-stopped' });
    if (hostStopCleanupPromise) return hostStopCleanupPromise;
    hostStopCleanupPromise = (async () => {
      const source = asObject(details);
      const eventName = safeText(source.eventName || source.event || 'generation_stopped', 80);
      const beforeStop = runState.current();
      const journalContext = promptClearContext(lastSnapshot);
      const recursionRequested = source.recursionRequested === true
        || source.source === 'recursion-ui'
        || eventName === 'recursion_stop_button'
        || Boolean(recursionStopRequest);
      const stopRunId = safeText(beforeStop.activeAttempt?.runId || beforeStop.activeRunId || makeId('host-stop-observation'), 160);
      const stopJournal = journalContext?.chatKey
        ? appendJournalSafe(stopRunId, journalContext.chatKey, {
            event: 'host.generation_stopped',
            severity: recursionRequested ? 'info' : 'warn',
            summary: recursionRequested
              ? 'Host generation stopped after a Recursion stop request.'
              : 'Host generation stopped without a Recursion stop request.',
            runId: stopRunId,
            sceneKey: safeText(journalContext.sceneKey || '', 180),
            details: {
              recursionRequested,
              eventName,
              source: safeText(source.source || 'host-event', 180),
              reason: safeText(source.reason || '', 180),
              origin: safeText(source.origin || '', 180),
              action: safeText(source.action || '', 180),
              cause: safeText(source.cause || '', 180),
              messageId: finiteNumberOrNull(source.messageId ?? source.mesid ?? source.id),
              payloadType: safeText(source.payloadType || '', 40),
              payloadKeys: (Array.isArray(source.payloadKeys) ? source.payloadKeys : [])
                .map((key) => safeText(key, 80))
                .filter(Boolean)
                .slice(0, 40),
              hostGenerationActive: Boolean(beforeStop.hostGenerationActive),
              postProcessPending: postProcessRuntime.postProcessPending(),
              postProcessActive: postProcessRuntime.postProcessRunning(),
              activeRunId: safeText(beforeStop.activeRunId || '', 160),
              activeAttemptKind: safeText(beforeStop.activeAttempt?.kind || '', 80),
              postProcessControlsLocked: source.postProcessControlsLocked === true,
              ...(recursionStopRequest ? { recursionStopRequest: redact(recursionStopRequest) } : {})
            }
          })
        : Promise.resolve(null);
      postProcessRuntime.cancelPostProcess('host-generation-stopped');
      const postProcessSettlement = postProcessRuntime.waitForPostProcessSettlement();
      const cancellation = cancelActiveProseEnhancement('prose-enhancement-canceled');
      await Promise.all([cancellation, stopJournal, postProcessSettlement]);
      try {
        await host.messages?.removeEmptyAssistantSwipePlaceholders?.(source.messageId);
      } catch {
        // Placeholder cleanup is best-effort; stop settlement must still complete.
      }
      const attempt = runState.current().activeAttempt;
      const preserveLastKnownGood = attempt?.kind === 'swipe' && Boolean(lastPreparedGeneration);
      if (preserveLastKnownGood) {
        runState.setLatestAssistantSwipeRetry({
          eventName: 'message_swiped',
          ...(details.messageId !== undefined ? { messageId: details.messageId } : {}),
          reason: 'stopped-swipe-preserve-last-known-good',
          recordedAt: nowIso()
        });
      }
      setHostGenerationActive(false);
      const result = await clearForHostEvent({
        idPrefix: 'host-stop',
        reason: 'host-generation-stopped',
        startLabel: 'Stopping Recursion after generation cancel...',
        successLabel: preserveLastKnownGood
          ? 'Swipe stopped; previous context preserved.'
          : 'Generation canceled. Recursion prompt cleared.',
        chips: ['Stop', 'Prompt'],
        outcome: 'skipped',
        settleSeverity: 'info',
        clearVolatileState: false,
        clearSwipeRetry: false
      });
      runState.clearAttempt?.(attempt?.runId);
      return result;
    })().finally(() => {
      hostStopCleanupPromise = null;
    });
    return hostStopCleanupPromise;
  }

  function recordTurnTiming(event) {
    const timing = turnTiming.snapshot();
    if (!timing?.chatKey) return;
    void appendJournalSafe(timing.attemptId, timing.chatKey, {
      event: `turn.timing.${event}`, severity: 'info', summary: 'Turn latency measured.',
      runId: timing.attemptId, details: timing
    });
  }

  function handleHostGenerationMilestone(event, details = {}) {
    if (details.dryRun || !runState.current().hostGenerationActive || postProcessRuntime.postProcessRunning()) return false;
    if (event !== 'host-request-ready') return false;
    const marked = turnTiming.mark(turnTiming.snapshot()?.attemptId, event, details);
    if (marked) recordTurnTiming(event);
    return marked;
  }

  function handleHostVisibleToken(text) {
    if (typeof text !== 'string' || !text.trim() || !runState.current().hostGenerationActive || postProcessRuntime.postProcessRunning()) return;
    if (turnTiming.mark(turnTiming.snapshot()?.attemptId, 'first-visible-token')) recordTurnTiming('first-visible-token');
  }

  function handleHostGenerationEnded() {
    if (turnTiming.mark(turnTiming.snapshot()?.attemptId, 'completed')) recordTurnTiming('completed');
    clearPendingProseEnhancement();
    setHostGenerationActive(false);
    runState.clearAttempt?.();
    return { ok: true };
  }

  function generationReviewInstalledHand(settings) {
    const deck = getActiveCardDeck(settings);
    const sourceCardsByFamily = activeCardDeckSourceCards(settings);
    const sourceById = new Map(Object.values(sourceCardsByFamily).flat().map((card) => [String(card.id), card]));
    const installed = [];
    const seen = new Set();
    for (const generated of Array.isArray(preparedHand()?.cards) ? preparedHand().cards : []) {
      const sourceCards = Array.isArray(generated?.sourceCards) && generated.sourceCards.length
        ? generated.sourceCards
        : (sourceCardsByFamily?.[generated?.family] || []);
      for (const source of sourceCards) {
        const card = sourceById.get(String(source?.id || '')) || source;
        const cardId = safeText(card?.id || '', 160);
        if (!cardId || seen.has(cardId)) continue;
        seen.add(cardId);
        installed.push({
          cardId,
          categoryId: safeText(card?.categoryId || '', 160),
          name: safeText(card?.name || generated?.name || '', 120),
          description: safeText(card?.description || '', 600),
          promptText: safeText(card?.promptText || generated?.promptText || '', 1200),
          kind: safeText(card?.kind || 'deck-card', 40),
          selectionState: safeText(card?.selectionState || '', 40),
          packetRefs: [safeText(generated?.id || '', 160)].filter(Boolean),
          sourceCardIds: [cardId]
        });
      }
    }
    return {
      deck: {
        id: safeText(deck?.id || '', 160),
        name: safeText(deck?.name || '', 160),
        revisionHash: hashJson({ id: deck?.id || '', cards: deck?.cards || {}, categories: deck?.categories || {} })
      },
      installedHand: installed
    };
  }

  async function runGenerationReview(details = {}) {
    const settings = settingsStore.get();
    const enhancementSettings = asObject(settings.enhancements);
    const mode = enhancementApplyMode(settings);
    const reason = safeText(details.reason || '', 80);
    if (reason === 'assistant-message-landed' && !pendingProseEnhancement && canceledProseEnhancement) {
      return { ok: true, skipped: true, reason: canceledProseEnhancement.reason || 'generation-review-canceled' };
    }
    if (!proseEnhancementEnabled(settings)) {
      clearPendingProseEnhancement();
      return { ok: true, skipped: true, reason: 'enhancement-off' };
    }
    const messages = asObject(host.messages);
    if (typeof messages.activeAssistantMessageIdentity !== 'function') {
      return { ok: true, skipped: true, reason: 'host-message-api-unavailable' };
    }
    const identity = messages.activeAssistantMessageIdentity();
    if (!identity?.text) {
      clearPendingProseEnhancement();
      return { ok: true, skipped: true, reason: 'assistant-message-unavailable' };
    }
    const runId = makeId('generation-review');
    const messageId = identity.messageId;
    const originalText = String(identity.text || '');
    const sourceHash = identity.originalHash || hashJson(originalText);
    const lane = enhancementLaneForSettings(settings, runtimeProviderCapability);
    const snapshot = typeof host.snapshot === 'function' ? await host.snapshot() : {};
    const enhancementContext = enhancementContextFromSnapshot({
      snapshot,
      hand: preparedHand(),
      activeText: originalText,
      activeSender: identity.sender || '',
      contextMessageLimit: enhancementSettings.contextMessages
    });
    const contextContract = buildContextContract(snapshot, settings);
    const contextMessages = boundEnhancementMessages(
      enhancementContext.contextMessages,
      contextContract.enhancementContext.effectiveMessages,
      contextContract.enhancementContext.characterBudget
    ).messages;
    const reviewSnapshot = {
      ...generationReviewInstalledHand(settings),
      promptPacket: preparedPacket() || {},
      lastBrief,
      storyForm: preparedPacket()?.storyForm || lastPlan?.storyForm || {},
      pipeline: settings.pipelineMode,
      context: {
        messages: contextMessages,
        character: enhancementContext.characterContext || {},
        generatedCardContext: enhancementContext.cardContext || {}
      }
    };
    const publicSnapshot = publicGenerationReviewSnapshot(reviewSnapshot);
    const installedCardCount = publicSnapshot.installedHand.length;
    const snapshotHash = generationReviewSnapshotHash(publicSnapshot);
    const marker = {
      schema: 'recursion.generationReviewMarker.v1',
      chatKey: identity.chatKey,
      messageId,
      swipeId: identity.swipeId ?? 0,
      sourceHash,
      snapshotHash,
      applyMode: mode,
      key: generationReviewKey({ chatKey: identity.chatKey, messageId, swipeId: identity.swipeId ?? 0, sourceHash, snapshotHash })
    };
    const existing = await messages.findEnhancedSwipe?.(messageId, marker);
    if (existing && mode === 'as-swipe' && typeof messages.selectAssistantMessageSwipe === 'function') {
      await messages.selectAssistantMessageSwipe(messageId, existing.index, { marker });
      settleRuntimeActivity({ runId, phase: 'settled', severity: 'success', label: 'Generation review reused from cache.', chips: ['Enhancement', 'Cached'] });
      clearPendingProseEnhancement();
      return { ok: true, cached: true, mode, messageId, sourceHash, marker };
    }
    const targets = buildGenerationReviewTargets(originalText);
    if (!generationRouter || typeof generationRouter.generate !== 'function') {
      return { ok: false, error: { code: 'RECURSION_GENERATION_REVIEW_UNAVAILABLE', message: 'Generation review provider is unavailable.' } };
    }
    let held = false;
    let enhanced = false;
    try {
      stageRuntimeActivity({
        runId,
        phase: 'generationReviewing',
        label: 'Reviewing generated response...',
        providerLane: lane,
        composerLane: lane,
        chips: ['Enhancement', 'Cards']
      });
      if (typeof messages.holdAssistantMessage === 'function') {
        const hold = await messages.holdAssistantMessage(messageId);
        held = hold?.ok !== false;
      }
      const baseRequest = buildGenerationReviewRequest({
        sourceText: originalText,
        sourceHash,
        targets,
        reviewSnapshot: publicSnapshot,
        contextContract,
        lane,
        ...reasonerRequestMetadata(settings, 'generation-review', lane)
      });
      const generate = async (request) => {
        const primary = await generationRouter.generate('generationReviewer', request, {
          runId
        });
        if (primary?.ok === true || lane !== 'reasoner') return { result: primary, lane };
        const fallbackRequest = { ...request, lane: 'utility' };
        delete fallbackRequest.reasoningCategory;
        delete fallbackRequest.reasoningIntent;
        const fallback = await generationRouter.generate('generationReviewer', fallbackRequest, {
          runId
        });
        return { result: fallback, lane: fallback?.ok === true ? 'utility' : lane, fallbackFrom: fallback?.ok === true ? 'reasoner' : '' };
      };
      let response = await generate(baseRequest);
      let validation = response.result?.ok === true
        ? validateGenerationReviewResult(response.result.data, { sourceHash, targets, reviewSnapshot: publicSnapshot })
        : { ok: false, error: response.result?.error || { code: 'RECURSION_GENERATION_REVIEW_PROVIDER_FAILED', message: 'Generation review provider failed.' } };
      if (!validation.ok && validation.retryable === true) {
        response = await generate(buildGenerationReviewRequest({
          ...baseRequest,
          sourceText: originalText,
          sourceHash,
          targets,
          reviewSnapshot: publicSnapshot,
          contextContract,
          lane,
          retry: {
            targetIds: validation.invalidTargetIds || Object.values(targets).flat().map((target) => target.id),
            cardIds: validation.invalidCardIds || validation.missingCardIds || []
          },
          ...reasonerRequestMetadata(settings, 'generation-review', lane)
        }));
        validation = response.result?.ok === true
          ? validateGenerationReviewResult(response.result.data, { sourceHash, targets, reviewSnapshot: publicSnapshot })
          : { ok: false, error: response.result?.error || { code: 'RECURSION_GENERATION_REVIEW_PROVIDER_FAILED', message: 'Generation review provider failed.' } };
      }
      const partialFailed = !validation.ok;
      const patches = validation.safePatches || validation.patches || [];
      if ((!validation.ok && !patches.length) || (validation.requiresRegeneration && !patches.length)) {
        const error = validation.error || { code: 'RECURSION_GENERATION_REVIEW_REQUIRES_REGENERATION', message: 'Generation review requires a fresh host generation.' };
        stageRuntimeActivity({ runId, phase: 'generationReviewing', severity: 'error', label: 'Generation review failed. Original kept.', chips: ['Enhancement'], detail: { error, reviewDomains: validation.reviewDomains, cardOutcomes: validation.cardOutcomes } });
        await appendJournalSafe(runId, identity.chatKey, { event: 'generation-review.failed', severity: 'error', summary: error.message, runId, sceneKey: safeText(snapshot?.sceneKey || '', 180), details: { code: error.code, reviewDomains: validation.reviewDomains, cardOutcomes: validation.cardOutcomes } });
        settleRuntimeActivity({ runId, phase: 'settled', outcome: 'success', label: 'Recursion prompt ready. Enhancement failed; original kept.', chips: ['Enhancement', 'Failed'], detail: { error } });
        return { ok: false, mode, error, validation };
      }
      const enhancedText = applyGenerationReviewPatches(originalText, patches, targets);
      if (enhancedText === originalText) {
        return { ok: false, error: { code: 'RECURSION_GENERATION_REVIEW_NO_EFFECT', message: 'Generation review returned no effective revision.' } };
      }
      marker.enhancedHash = hashJson(enhancedText);
      marker.patchHash = hashJson(patches);
      marker.reviewDomains = validation.reviewDomains;
      marker.patches = patches;
      marker.outcome = partialFailed || validation.requiresRegeneration ? 'partial-failed' : 'applied';
      const cardNames = new Map(publicSnapshot.installedHand.map((card) => [card.cardId, card.name]));
      const unresolvedCardOutcomes = (validation.missingCardIds || validation.invalidCardIds || []).map((cardId) => ({
        cardId,
        status: 'unresolved',
        reason: validation.error?.message || 'Card outcome coverage missing.'
      }));
      const cardOutcomes = [...(validation.cardOutcomes || []), ...unresolvedCardOutcomes];
      marker.cardOutcomes = cardOutcomes;
      stageRuntimeActivity({
        runId,
        phase: 'generationReviewing',
        severity: partialFailed || validation.requiresRegeneration ? 'error' : 'success',
        label: partialFailed || validation.requiresRegeneration ? 'Generation review partially applied.' : 'Generation review complete.',
        providerLane: response.lane,
        composerLane: response.lane,
        chips: ['Enhancement', 'Cards'],
        detail: {
          reviewDomains: validation.reviewDomains || {},
          cardOutcomes: cardOutcomes.map((outcome) => ({
            ...outcome,
            name: cardNames.get(String(outcome.cardId || '')) || String(outcome.cardId || '')
          }))
        }
      });
      if (mode === 'replace') {
        const replace = await messages.replaceAssistantMessageText?.(messageId, enhancedText, { marker });
        if (replace?.ok === false) return { ok: false, mode, error: replace.error };
        enhanced = true;
      } else {
        if (held && typeof messages.revealAssistantMessage === 'function') {
          await messages.revealAssistantMessage(messageId);
          held = false;
        }
        const append = await messages.appendAssistantMessageSwipe?.(messageId, enhancedText, { marker, select: true });
        if (append?.ok === false) return { ok: false, mode, error: append.error };
        enhanced = true;
      }
      await appendJournalSafe(runId, identity.chatKey, {
        event: partialFailed || validation.requiresRegeneration ? 'generation-review.partial-failed' : 'generation-review.applied',
        severity: partialFailed || validation.requiresRegeneration ? 'error' : 'info',
        summary: partialFailed || validation.requiresRegeneration ? 'Generation review applied safe revisions with unresolved findings.' : 'Generation review applied bounded revisions.',
        runId,
        sceneKey: safeText(snapshot?.sceneKey || '', 180),
        details: {
          patchCount: patches.length,
          reviewDomains: validation.reviewDomains,
          cardOutcomes,
          lane: response.lane,
          outcome: marker.outcome,
          unresolvedCardIds: validation.missingCardIds || validation.invalidCardIds || []
        }
      });
      settleRuntimeActivity({
        runId,
        phase: 'settled',
        severity: partialFailed || validation.requiresRegeneration ? 'error' : 'success',
        label: partialFailed || validation.requiresRegeneration ? 'Generation review partial result applied.' : 'Generation review applied.',
        chips: partialFailed || validation.requiresRegeneration ? ['Enhancement', 'Partial failed'] : ['Enhancement', 'Applied'],
        detail: { patchCount: patches.length, reviewDomains: validation.reviewDomains, cardOutcomes, outcome: marker.outcome }
      });
      return { ok: true, partialFailed: partialFailed || validation.requiresRegeneration, mode, messageId, sourceHash, enhancedHash: marker.enhancedHash, marker, patches, reviewDomains: validation.reviewDomains, cardOutcomes, installedCardCount };
    } catch (error) {
      settleRuntimeActivity({ runId, phase: 'settled', severity: 'error', label: 'Generation review failed. Original kept.', chips: ['Enhancement'] });
      return { ok: false, mode, error: { code: 'RECURSION_GENERATION_REVIEW_FAILED', message: String(error?.message || error || 'Generation review failed.') } };
    } finally {
      clearPendingProseEnhancement();
      if (held && !enhanced && typeof messages.revealAssistantMessage === 'function') await messages.revealAssistantMessage(messageId);
    }
  }

  async function enhanceLatestAssistantMessage(details = {}) {
    if (activeProseEnhancementLifecycle?.promise) return activeProseEnhancementLifecycle.promise;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const lifecycle = {
      controller,
      signal: controller?.signal ?? null,
      cancelReason: '',
      promise: null
    };
    const run = enhanceLatestAssistantMessageImpl({
      ...asObject(details),
      enhancementSignal: lifecycle.signal,
      enhancementLifecycle: lifecycle
    });
    lifecycle.promise = run;
    activeProseEnhancementLifecycle = lifecycle;
    activeProseEnhancementPromise = run;
    try {
      return await run;
    } finally {
      if (activeProseEnhancementPromise === run) {
        activeProseEnhancementPromise = null;
      }
      if (activeProseEnhancementLifecycle === lifecycle) {
        activeProseEnhancementLifecycle = null;
      }
    }
  }

  async function runEditorialTransform(details = {}) {
    const settings = settingsStore.get();
    const enhancementSignal = details.enhancementSignal || null;
    const enhancementLifecycle = details.enhancementLifecycle || null;
    const enhancementSettings = asObject(settings.enhancements);
    const editorialMode = safeText(enhancementSettings.mode || 'off', 32);
    if (!['repair', 'recompose', 'redirect'].includes(editorialMode)) {
      clearPendingProseEnhancement();
      return { ok: true, skipped: true, reason: 'editorial-off' };
    }
    if (!pendingProseEnhancement) {
      armProseEnhancementForHostGeneration(settings);
    }
    const messages = asObject(host.messages);
    if (typeof messages.activeAssistantMessageIdentity !== 'function') return { ok: true, skipped: true, reason: 'host-message-api-unavailable' };
    const identity = messages.activeAssistantMessageIdentity();
    if (!identity?.text) return { ok: true, skipped: true, reason: 'assistant-message-unavailable' };
    if (safeText(details.reason || '', 80) === 'assistant-message-landed' && identity.enhancementOwned === true) {
      clearPendingProseEnhancement();
      return { ok: true, skipped: true, reason: 'enhancement-owned-source' };
    }
    const redirectCapabilityFailure = () => {
      if (editorialMode !== 'redirect') return null;
      const capability = runtimeProviderCapability(settingsStore.get(), 'reasoner', 'redirect');
      if (!capability.required) return null;
      const preparedCapability = asObject(pendingProseEnhancement?.requiredCapability);
      if (!capability.eligible) return sanitizeProviderCapability(capability);
      if (
        safeText(preparedCapability.configHash, 180) !== capability.configHash
        || Number(preparedCapability.configRevision) !== capability.configRevision
      ) {
        return {
          ...sanitizeProviderCapability(capability),
          eligible: false,
          reasonCode: 'reasoner-configuration-changed',
          message: 'Reasoner settings changed after Redirect was prepared. Generate again.'
        };
      }
      return null;
    };
    const initialRedirectCapabilityFailure = pendingProseEnhancement?.blockedCapability
      || redirectCapabilityFailure();
    if (editorialMode === 'redirect' && initialRedirectCapabilityFailure) {
      const blockedCapability = initialRedirectCapabilityFailure;
      const blockedRunId = makeId('editorial-preflight');
      lastEditorialResult = {
        mode: editorialMode,
        status: 'skipped',
        outcome: 'provider-not-ready',
        applyMode: 'as-swipe',
        reasonCode: blockedCapability.reasonCode
      };
      settleRuntimeActivity({
        runId: blockedRunId,
        phase: 'editorialPreflight',
        severity: 'warning',
        outcome: 'skipped',
        label: blockedCapability.message,
        chips: ['Enhancement', 'Redirect', 'Skipped'],
        detail: blockedCapability
      });
      await appendJournalSafe(blockedRunId, identity.chatKey, {
        event: 'editorial.preflight.skipped',
        severity: 'warn',
        summary: 'Redirect skipped because Reasoner is not ready.',
        runId: blockedRunId,
        details: blockedCapability
      });
      clearPendingProseEnhancement();
      return {
        ok: true,
        skipped: true,
        mode: editorialMode,
        reason: blockedCapability.reasonCode
      };
    }
    const runId = makeId('editorial');
    if (pendingProseEnhancement?.cautionCapability && !pendingProseEnhancement.cautionReported) {
      stageRuntimeActivity({
        runId,
        phase: 'providerCaution',
        severity: 'warning',
        outcome: 'warning',
        label: pendingProseEnhancement.cautionCapability.message,
        chips: ['Enhancement', 'Provider untested'],
        detail: pendingProseEnhancement.cautionCapability
      });
      pendingProseEnhancement.cautionReported = true;
    }
    const messageId = identity.messageId;
    const sourceText = String(identity.text || '');
    const sourceHash = identity.originalHash || hashJson(sourceText);
    const lane = enhancementLaneForSettings(settings, runtimeProviderCapability);
    const snapshot = typeof host.snapshot === 'function' ? await host.snapshot() : {};
    const enhancementContext = enhancementContextFromSnapshot({
      snapshot,
      hand: preparedHand(),
      activeText: sourceText,
      activeSender: identity.sender || '',
      contextMessageLimit: enhancementSettings.contextMessages
    });
    const contextContract = buildContextContract(snapshot, settings);
    const contextMessages = boundEnhancementMessages(
      enhancementContext.contextMessages,
      contextContract.enhancementContext.effectiveMessages,
      contextContract.enhancementContext.characterBudget
    ).messages;
    const reviewSnapshot = {
      ...generationReviewInstalledHand(settings),
      promptPacket: preparedPacket() || {},
      lastBrief,
      storyForm: preparedPacket()?.storyForm || lastPlan?.storyForm || {},
      pipeline: settings.pipelineMode,
      context: {
        messages: contextMessages,
        character: enhancementContext.characterContext || {},
        generatedCardContext: enhancementContext.cardContext || {}
      }
    };
    const publicSnapshot = publicGenerationReviewSnapshot(reviewSnapshot);
    const snapshotHash = generationReviewSnapshotHash(publicSnapshot);
    const applyMode = editorialMode === 'redirect' ? 'as-swipe' : enhancementApplyMode(settings);
    const verificationRequired = editorialVerificationRequired(editorialMode, settings.reasoningLevel);
    const key = editorialPassKey({
      chatKey: identity.chatKey,
      messageId,
      swipeId: identity.swipeId ?? 0,
      sourceHash,
      snapshotHash,
      mode: editorialMode,
      applyMode,
      verificationRequired
    });
    const markerBase = {
      schema: 'recursion.editorialMarker.v1',
      chatKey: identity.chatKey,
      messageId,
      swipeId: identity.swipeId ?? 0,
      mode: editorialMode,
      applyMode,
      sourceHash,
      snapshotHash,
      key
    };
    if (enhancementLifecycle) enhancementLifecycle.runId = runId;
    let editorialSettlement = null;
    let editorialSettlementRecorded = false;
    function setEditorialResult(result = {}) {
      editorialSettlement = { ...asObject(result) };
      lastEditorialResult = editorialSettlement;
      return editorialSettlement;
    }
    async function appendEditorialSettlement() {
      if (editorialSettlementRecorded || !editorialSettlement || editorialSettlement.status === 'running') return null;
      editorialSettlementRecorded = true;
      const status = safeText(editorialSettlement.status || 'error', 40);
      const outcome = safeText(editorialSettlement.outcome || 'original-kept', 80);
      const severity = ['error', 'partial-failed'].includes(status)
        ? 'error'
        : (status === 'warning' ? 'warn' : 'info');
      return appendJournalSafe(runId, identity.chatKey, {
        event: 'editorial.run.settled',
        severity,
        summary: `Editorial ${editorialMode} ${outcome}.`,
        runId,
        sceneKey: safeText(snapshot?.sceneKey || '', 180),
        details: {
          mode: editorialMode,
          applyMode,
          status,
          outcome,
          decision: safeText(editorialSettlement.decision || '', 180),
          reasonCode: safeText(editorialSettlement.errorCode || '', 120),
          verification: safeText(editorialSettlement.verification || '', 80),
          candidateHash: safeText(editorialSettlement.candidateHash || '', 180),
          diagnosisHash: safeText(editorialSettlement.diagnosisHash || '', 180),
          redirectCharacterCount: Number(editorialSettlement.redirectCharacterCount || 0),
          redirectRequiredBeatCount: Number(editorialSettlement.redirectRequiredBeatCount || 0),
          ...(editorialSettlement.failure ? { failure: editorialSettlement.failure } : {})
        }
      });
    }
    setEditorialResult({ mode: editorialMode, status: 'running', outcome: 'diagnosing', applyMode });
    function canceledEditorialResult() {
      const reason = enhancementCancelReason(details) || 'prose-enhancement-canceled';
      setEditorialResult({
        mode: editorialMode,
        status: 'skipped',
        outcome: 'original-kept',
        applyMode,
        decision: reason
      });
      settleRuntimeActivity({
        runId,
        phase: 'settled',
        outcome: 'skipped',
        severity: 'info',
        label: 'Editorial canceled; original kept.',
        chips: ['Enhancement', 'Canceled'],
        detail: { mode: editorialMode, applyMode, reason }
      });
      return { ok: true, skipped: true, mode: editorialMode, reason };
    }
    function failEditorial(error = {}, label = 'Editorial transform failed. Original kept.') {
      const safeError = {
        code: safeText(error?.code || 'RECURSION_EDITORIAL_FAILED', 120),
        message: safeText(error?.message || 'Editorial transform failed.', 300)
      };
      const stage = safeError.code.includes('DIAGNOSIS')
        ? 'editorial-diagnosis'
        : safeError.code.includes('VERIFICATION')
          ? 'editorial-verification'
          : safeError.code.includes('SOURCE_CHANGED')
            ? 'editorial-commit'
            : 'editorial-transform';
      const category = safeError.code.includes('SOURCE_CHANGED')
        ? 'stale-state'
        : /APPEND|SWIPE|REPLACE|MUTATION/.test(safeError.code)
          ? 'host-mutation'
          : 'model-output';
      const failure = failureFrom(safeError, { stage, category });
      setEditorialResult({
        mode: editorialMode,
        status: 'error',
        outcome: 'original-kept',
        applyMode,
        decision: safeError.message,
        errorCode: safeError.code,
        failure
      });
      settleRuntimeActivity({
        runId,
        phase: 'settled',
        severity: 'error',
        label,
        chips: ['Enhancement', 'Failed'],
        detail: { mode: editorialMode, applyMode, reasonCode: safeError.code, failure }
      });
      return { ok: false, mode: editorialMode, error: safeError };
    }
    const existing = await messages.findEnhancedSwipe?.(messageId, markerBase);
    if (existing && applyMode === 'as-swipe' && typeof messages.selectAssistantMessageSwipe === 'function') {
      const persistedMarker = asObject(existing.marker);
      const verifiedForMode = persistedMarker.outcome !== 'partial-failed'
        && (
          editorialMode !== 'redirect'
          || (persistedMarker.verification === 'accept' && safeText(persistedMarker.candidateHash, 180))
        );
      if (verifiedForMode) {
        await messages.selectAssistantMessageSwipe(messageId, existing.index, { marker: persistedMarker });
        setEditorialResult({
          mode: editorialMode,
          status: 'success',
          outcome: 'cached',
          applyMode,
          verification: persistedMarker.verification || 'cached',
          candidateHash: persistedMarker.candidateHash || '',
          diagnosisHash: persistedMarker.diagnosisHash || '',
          redirectCharacterCount: Array.isArray(persistedMarker.redirect?.characterPressure) ? persistedMarker.redirect.characterPressure.length : 0,
          redirectRequiredBeatCount: Array.isArray(persistedMarker.redirect?.requiredBeats) ? persistedMarker.redirect.requiredBeats.length : 0
        });
        settleRuntimeActivity({ runId, phase: 'settled', severity: 'success', label: `${editorialMode} reused from cache.`, chips: ['Enhancement', 'Cached'] });
        await appendEditorialSettlement();
        return { ok: true, cached: true, mode: editorialMode, messageId, sourceHash, marker: persistedMarker };
      }
    }
    if (!generationRouter || typeof generationRouter.generate !== 'function') {
      const unavailable = failEditorial({ code: 'RECURSION_EDITORIAL_UNAVAILABLE', message: 'Editorial provider is unavailable.' });
      await appendEditorialSettlement();
      return unavailable;
    }
    const evidence = buildEditorialEvidence(publicSnapshot, sourceText);
    const targets = editorialMode === 'repair' ? buildGenerationReviewTargets(sourceText) : {};
    const recoveryToken = { spent: false };
    let held = false;
    let enhanced = false;
    let editorialLane = lane;
    let verificationResult = { decision: 'not-required' };
    async function skipIfRedirectCapabilityChanged(stage) {
      const blockedCapability = redirectCapabilityFailure();
      if (!blockedCapability) return null;
      if (held && typeof messages.revealAssistantMessage === 'function') {
        await messages.revealAssistantMessage(messageId);
        held = false;
      }
      setEditorialResult({
        mode: editorialMode,
        status: 'skipped',
        outcome: 'provider-not-ready',
        applyMode,
        decision: blockedCapability.reasonCode,
        errorCode: blockedCapability.reasonCode
      });
      settleRuntimeActivity({
        runId,
        phase: 'editorialPreflight',
        severity: 'warning',
        outcome: 'skipped',
        label: blockedCapability.message,
        chips: ['Enhancement', 'Redirect', 'Skipped'],
        detail: { ...blockedCapability, stage }
      });
      await appendJournalSafe(runId, identity.chatKey, {
        event: 'editorial.preflight.skipped',
        severity: 'warn',
        summary: 'Redirect skipped because Reasoner readiness changed.',
        runId,
        details: { ...blockedCapability, stage }
      });
      clearPendingProseEnhancement();
      return {
        ok: true,
        skipped: true,
        mode: editorialMode,
        reason: blockedCapability.reasonCode
      };
    }
    async function generateEditorialRole(roleId, request, options = {}) {
      if (enhancementSignal?.aborted) {
        return {
          result: { ok: false, error: { code: 'RECURSION_PROVIDER_ABORTED', message: 'Provider generation was aborted.' } },
          lane: request?.lane === 'reasoner' ? 'reasoner' : 'utility'
        };
      }
      const primaryLane = request?.lane === 'reasoner' ? 'reasoner' : 'utility';
      const primary = await generationRouter.generate(roleId, request, {
        runId,
        signal: enhancementSignal
      });
      if (primary?.ok === true || primaryLane !== 'reasoner' || options.allowLaneFallback === false) {
        return { result: primary, lane: primaryLane };
      }
      const fallbackRequest = { ...request, lane: 'utility' };
      delete fallbackRequest.reasoningCategory;
      delete fallbackRequest.reasoningIntent;
      const fallback = await generationRouter.generate(roleId, fallbackRequest, {
        runId,
        signal: enhancementSignal
      });
      return { result: fallback, lane: fallback?.ok === true ? 'utility' : primaryLane };
    }
    try {
      const diagnosisReadinessSkip = await skipIfRedirectCapabilityChanged('before-diagnosis');
      if (diagnosisReadinessSkip) return diagnosisReadinessSkip;
      if (typeof messages.holdAssistantMessage === 'function') {
        const hold = await messages.holdAssistantMessage(messageId);
        held = hold?.ok !== false;
      }
      stageRuntimeActivity({ runId, phase: 'editorialDiagnosing', label: 'Diagnosing response...', providerLane: editorialLane, composerLane: editorialLane, chips: ['Enhancement', editorialMode] });
      const diagnosisRequest = {
        ...buildEditorialDiagnosisRequest({ mode: editorialMode, sourceText, sourceHash, snapshotHash, snapshot: publicSnapshot, targets, lane: editorialLane }),
        ...reasonerRequestMetadata(settings, 'editorial-transform', editorialLane),
        reasoningIntent: 'low'
      };
      let diagnosisResponse = await generateEditorialRole(
        'editorialDiagnostician',
        diagnosisRequest
      );
      if (enhancementSignal?.aborted) return canceledEditorialResult();
      let diagnosisValidation = diagnosisResponse.result?.ok === true
        ? validateEditorialDiagnosis(diagnosisResponse.result.data, { mode: editorialMode, sourceText, sourceHash, snapshotHash, snapshot: publicSnapshot })
        : { ok: false, error: diagnosisResponse.result?.error || { code: 'RECURSION_EDITORIAL_DIAGNOSIS_FAILED', message: 'Editorial diagnosis failed.' } };
      const correctableProviderOutputCodes = new Set([
        'RECURSION_JSON_PARSE_FAILED',
        'RECURSION_JSON_OBJECT_REQUIRED',
        'RECURSION_PROVIDER_EMPTY_RESPONSE',
        'RECURSION_PROVIDER_REASONING_ONLY',
        'RECURSION_PROVIDER_RESPONSE_JSON_INVALID',
        'RECURSION_PROVIDER_SCHEMA_MISMATCH'
      ]);
      const recoverableRepairCardCoverageCodes = new Set([
        'RECURSION_EDITORIAL_CARD_COVERAGE_MISSING',
        'RECURSION_EDITORIAL_CARD_OUTCOME_INVALID'
      ]);
      const runtimeCorrectionAvailable = diagnosisResponse.result?.ok === true
        || editorialMode === 'redirect'
        || (
          recoveryToken.spent !== true
          && correctableProviderOutputCodes.has(safeText(diagnosisResponse.result?.error?.code, 120))
        );
      if (!diagnosisValidation.ok && runtimeCorrectionAvailable && recoveryToken.spent !== true) {
        recoveryToken.spent = true;
        const correctionLane = editorialMode === 'redirect'
          && diagnosisResponse.lane === 'utility'
          && runtimeProviderCapability(settings, 'reasoner', 'prompt-packet').eligible
          ? 'reasoner'
          : editorialLane;
        diagnosisResponse = await generateEditorialRole('editorialDiagnostician', {
          ...buildEditorialDiagnosisRequest({
            mode: editorialMode,
            sourceText,
            sourceHash,
            snapshotHash,
            snapshot: publicSnapshot,
            targets,
            lane: correctionLane,
            retry: diagnosisValidation.error
          }),
          ...reasonerRequestMetadata(settings, 'editorial-transform', correctionLane),
          reasoningIntent: 'low'
        }, { allowLaneFallback: false });
        if (enhancementSignal?.aborted) return canceledEditorialResult();
        diagnosisValidation = diagnosisResponse.result?.ok === true
          ? validateEditorialDiagnosis(diagnosisResponse.result.data, { mode: editorialMode, sourceText, sourceHash, snapshotHash, snapshot: publicSnapshot })
          : { ok: false, error: diagnosisResponse.result?.error || { code: 'RECURSION_EDITORIAL_DIAGNOSIS_FAILED', message: 'Editorial diagnosis failed.' } };
      }
      if (!diagnosisValidation.ok) {
        if (held && typeof messages.revealAssistantMessage === 'function') { await messages.revealAssistantMessage(messageId); held = false; }
        return {
          ...failEditorial(diagnosisValidation.error, 'Editorial diagnosis failed. Original kept.'),
          validation: diagnosisValidation
        };
      }
      editorialLane = diagnosisResponse.lane;
      if (diagnosisValidation.value?.decision !== 'proceed') {
        if (held && typeof messages.revealAssistantMessage === 'function') { await messages.revealAssistantMessage(messageId); held = false; }
        const reason = diagnosisValidation.value?.decision || diagnosisValidation.error?.message || 'editorial-diagnosis-failed';
        const noChange = diagnosisValidation.value?.decision === 'no-change';
        const severity = noChange ? 'success' : (diagnosisValidation.value ? 'warning' : 'error');
        stageRuntimeActivity({ runId, phase: 'editorialDiagnosing', severity, label: noChange ? 'Editorial diagnosis complete.' : `Editorial diagnosis ${reason}.`, providerLane: diagnosisResponse.lane, detail: { mode: editorialMode, decision: reason } });
        settleRuntimeActivity({ runId, phase: 'settled', outcome: noChange ? 'skipped' : undefined, severity: noChange ? 'info' : severity, label: noChange ? 'Editorial complete; no changes needed.' : (diagnosisValidation.value ? `Editorial ${reason}; original kept.` : 'Editorial diagnosis failed. Original kept.'), chips: ['Enhancement', noChange ? 'No change' : (diagnosisValidation.value ? 'Review' : 'Failed')], detail: { mode: editorialMode, decision: reason } });
        setEditorialResult({
          mode: editorialMode,
          status: noChange ? 'skipped' : (diagnosisValidation.value ? 'warning' : 'error'),
          outcome: 'original-kept',
          decision: reason,
          errorCode: diagnosisValidation.error?.code || '',
          applyMode
        });
        return { ok: Boolean(diagnosisValidation.value), skipped: Boolean(diagnosisValidation.value), mode: editorialMode, reason, validation: diagnosisValidation };
      }
      const diagnosisHash = diagnosisValidation.hash;
      const transformLane = editorialMode === 'redirect'
        ? redirectTransformerLaneForSettings(settings, runtimeProviderCapability)
        : editorialLane;
      const strictReasonerWriter = editorialMode === 'redirect' && transformLane === 'reasoner';
      const transformOptions = strictReasonerWriter
        ? { allowLaneFallback: false }
        : {};
      const transformReadinessSkip = strictReasonerWriter
        ? await skipIfRedirectCapabilityChanged('before-transform')
        : null;
      if (transformReadinessSkip) return transformReadinessSkip;
      stageRuntimeActivity({ runId, phase: 'editorialTransforming', label: editorialMode === 'repair' ? 'Applying grounded repairs...' : `${editorialMode === 'redirect' ? 'Redirecting' : 'Recomposing'} response...`, providerLane: transformLane, composerLane: transformLane, chips: ['Enhancement', editorialMode] });
      let transformResponse = await generateEditorialRole('editorialTransformer', {
        ...buildEditorialPassRequest({ mode: editorialMode, sourceText, sourceHash, snapshotHash, diagnosis: diagnosisValidation.value, diagnosisDiagnostics: diagnosisValidation.diagnostics, evidence, snapshot: publicSnapshot, targets, lane: transformLane }),
        ...reasonerRequestMetadata(settings, 'editorial-transform', transformLane)
      }, transformOptions);
      let transformAttemptCount = 1;
      if (enhancementSignal?.aborted) return canceledEditorialResult();
      let validation = transformResponse.result?.ok === true
        ? validateEditorialPass(transformResponse.result.data, { mode: editorialMode, sourceText, sourceHash, snapshotHash, diagnosisHash, diagnosis: diagnosisValidation.value, snapshot: publicSnapshot, targets })
        : { ok: false, error: transformResponse.result?.error || { code: 'RECURSION_EDITORIAL_TRANSFORM_FAILED', message: 'Editorial transform failed.' } };
      if (
        editorialMode === 'repair'
        && transformResponse.result?.ok === true
        && !validation.ok
        && recoverableRepairCardCoverageCodes.has(safeText(validation.error?.code, 120))
      ) {
        validation = validateEditorialPass(transformResponse.result.data, {
          mode: editorialMode,
          sourceText,
          sourceHash,
          snapshotHash,
          diagnosisHash,
          diagnosis: diagnosisValidation.value,
          snapshot: publicSnapshot,
          targets,
          recoverCardCoverage: true
        });
      }
      const transformCorrectionAvailable = strictReasonerWriter
        || (
          recoveryToken.spent !== true
          && (
            transformResponse.result?.ok === true
            || correctableProviderOutputCodes.has(safeText(transformResponse.result?.error?.code, 120))
          )
        );
      if (!validation.ok && transformCorrectionAvailable) {
        if (!strictReasonerWriter) recoveryToken.spent = true;
        transformAttemptCount += 1;
        const correctionReadinessSkip = strictReasonerWriter
          ? await skipIfRedirectCapabilityChanged('before-transform-correction')
          : null;
        if (correctionReadinessSkip) return correctionReadinessSkip;
        transformResponse = await generateEditorialRole('editorialTransformer', {
          ...buildEditorialPassRequest({
            mode: editorialMode,
            sourceText,
            sourceHash,
            snapshotHash,
            diagnosis: diagnosisValidation.value,
            diagnosisDiagnostics: diagnosisValidation.diagnostics,
            evidence,
            snapshot: publicSnapshot,
            targets,
            lane: transformLane,
            retry: validation.error
          }),
          ...reasonerRequestMetadata(settings, 'editorial-transform', transformLane)
        }, {
          ...(strictReasonerWriter ? { allowLaneFallback: false } : {})
        });
        if (enhancementSignal?.aborted) return canceledEditorialResult();
        validation = transformResponse.result?.ok === true
          ? validateEditorialPass(transformResponse.result.data, {
              mode: editorialMode,
              sourceText,
              sourceHash,
              snapshotHash,
              diagnosisHash,
              diagnosis: diagnosisValidation.value,
              snapshot: publicSnapshot,
              targets,
              recoverCardCoverage: editorialMode === 'repair'
            })
          : { ok: false, error: transformResponse.result?.error || { code: 'RECURSION_EDITORIAL_TRANSFORM_FAILED', message: 'Editorial transform failed.' } };
      }
      if (!validation.ok) {
        return {
          ...failEditorial(validation.error),
          validation,
          diagnosisDecision: safeText(diagnosisValidation.value?.decision, 80),
          diagnosisDiagnostics: asObject(diagnosisValidation.diagnostics)
        };
      }
      if (
        editorialMode === 'repair'
        && validation.partialFailed === true
        && Array.isArray(validation.unresolvedCardIds)
        && validation.unresolvedCardIds.length > 0
      ) {
        const repairedCandidateText = applyEditorialArtifact(sourceText, validation.artifact, targets);
        stageRuntimeActivity({
          runId,
          phase: 'editorialVerifying',
          label: 'Auditing installed cards...',
          providerLane: transformResponse.lane,
          composerLane: transformResponse.lane,
          chips: ['Enhancement', 'Repair', 'Card audit']
        });
        const buildRepairAuditRequest = (retry = null) => buildEditorialVerificationRequest({
          mode: 'repair',
          sourceHash,
          snapshotHash,
          diagnosisHash,
          evidence,
          snapshot: publicSnapshot,
          candidate: { text: repairedCandidateText },
          lane: transformResponse.lane,
          retry
        });
        let auditRequest = buildRepairAuditRequest();
        let auditResponse = await generateEditorialRole('editorialVerifier', {
          ...auditRequest,
          ...reasonerRequestMetadata(settings, 'editorial-transform', transformResponse.lane)
        });
        if (enhancementSignal?.aborted) return canceledEditorialResult();
        let auditValidation = auditResponse.result?.ok === true
          ? validateEditorialVerification(auditResponse.result.data, {
              mode: 'repair',
              sourceHash,
              snapshotHash,
              diagnosisHash,
              candidateHash: auditRequest.candidateHash,
              evidence,
              snapshot: publicSnapshot
            })
          : {
              ok: false,
              error: auditResponse.result?.error || {
                code: 'RECURSION_EDITORIAL_CARD_AUDIT_FAILED',
                message: 'Repair card audit failed.'
              }
            };
        const auditFailureCode = safeText(auditValidation.error?.code, 120);
        if (
          !auditValidation.ok
          && (
            recoverableRepairCardCoverageCodes.has(auditFailureCode)
            || auditFailureCode === 'RECURSION_EDITORIAL_VERIFICATION_INVALID'
            || correctableProviderOutputCodes.has(auditFailureCode)
          )
        ) {
          stageRuntimeActivity({
            runId,
            phase: 'editorialVerifying',
            severity: 'warning',
            label: 'Correcting installed-card audit...',
            providerLane: transformResponse.lane,
            composerLane: transformResponse.lane,
            chips: ['Enhancement', 'Repair', 'Card audit'],
            detail: { reason: auditValidation.error?.message || 'Installed-card audit was structurally incomplete.' }
          });
          auditRequest = buildRepairAuditRequest(auditValidation.error);
          auditResponse = await generateEditorialRole('editorialVerifier', {
            ...auditRequest,
            ...reasonerRequestMetadata(settings, 'editorial-transform', transformResponse.lane)
          });
          if (enhancementSignal?.aborted) return canceledEditorialResult();
          auditValidation = auditResponse.result?.ok === true
            ? validateEditorialVerification(auditResponse.result.data, {
                mode: 'repair',
                sourceHash,
                snapshotHash,
                diagnosisHash,
                candidateHash: auditRequest.candidateHash,
                evidence,
                snapshot: publicSnapshot
              })
            : {
                ok: false,
                error: auditResponse.result?.error || {
                  code: 'RECURSION_EDITORIAL_CARD_AUDIT_FAILED',
                  message: 'Repair card audit correction failed.'
                }
              };
        }
        if (auditValidation.ok) {
          validation = mergeRepairCardAudit(validation, auditValidation);
        } else {
          validation = {
            ...validation,
            cardAudit: {
              decision: safeText(auditValidation.decision || 'invalid', 40),
              errorCode: safeText(auditValidation.error?.code, 120),
              diagnostics: editorialCardAuditDiagnostics(auditResponse.result?.data)
            }
          };
        }
      }
      editorialLane = transformResponse.lane;
      let candidateHash = validation.artifact?.kind === 'candidate'
        ? hashJson(String(validation.artifact.candidate?.text || validation.artifact.text || ''))
        : '';
      if (verificationRequired) {
        const verifierLane = editorialMode === 'redirect'
          && runtimeProviderCapability(settings, 'reasoner', 'redirect').eligible
          ? 'reasoner'
          : editorialLane;
        const verifyCandidate = async () => {
          const runVerifier = async (retry = null) => {
            const verifierReadinessSkip = editorialMode === 'redirect'
              ? await skipIfRedirectCapabilityChanged(retry ? 'before-verifier-correction' : 'before-verifier')
              : null;
            if (verifierReadinessSkip) return { skipped: verifierReadinessSkip };
            const verificationRequest = buildEditorialVerificationRequest({
              mode: editorialMode,
              sourceHash,
              snapshotHash,
              diagnosisHash,
              diagnosis: diagnosisValidation.value,
              diagnosisDiagnostics: diagnosisValidation.diagnostics,
              evidence,
              candidate: validation.artifact.candidate,
              lane: verifierLane,
              retry
            });
            const verifierResponse = await generateEditorialRole('editorialVerifier', {
              ...verificationRequest,
              ...reasonerRequestMetadata(settings, 'editorial-verify', verifierLane)
            });
            if (enhancementSignal?.aborted) return { canceled: true };
            return {
              result: verifierResponse.result?.ok === true
                ? validateEditorialVerification(verifierResponse.result.data, {
                    mode: editorialMode,
                    sourceHash,
                    snapshotHash,
                    diagnosisHash,
                    candidateHash: verificationRequest.candidateHash,
                    evidence
                  })
                : { ok: false, decision: 'reject', error: verifierResponse.result?.error || { code: 'RECURSION_EDITORIAL_VERIFICATION_FAILED', message: 'Editorial verification failed.' } }
            };
          };
          stageRuntimeActivity({ runId, phase: 'editorialVerifying', label: 'Verifying editorial candidate...', providerLane: verifierLane, composerLane: verifierLane, chips: ['Enhancement', 'Verify'] });
          let verified = await runVerifier();
          if (verified.skipped) return verified;
          if (verified.canceled) return verified;
          if (editorialMode === 'redirect' && !verified.result.ok && recoveryToken.spent !== true) {
            recoveryToken.spent = true;
            stageRuntimeActivity({ runId, phase: 'editorialVerifying', label: 'Correcting editorial verification...', providerLane: verifierLane, composerLane: verifierLane, chips: ['Enhancement', 'Verify'] });
            verified = await runVerifier(verified.result.error);
            if (verified.skipped) return verified;
          }
          return verified;
        };
        let verified = await verifyCandidate();
        if (verified.skipped) return verified.skipped;
        if (verified.canceled) return canceledEditorialResult();
        verificationResult = verified.result;
        if (editorialMode === 'redirect'
          && verificationResult.ok
          && verificationResult.decision === 'reject'
          && transformAttemptCount < 2) {
          const failedChecks = (verificationResult.checks || [])
            .filter((entry) => entry?.status !== 'pass')
            .map((entry) => entry?.check)
            .filter(Boolean);
          const verifierFeedback = {
            code: REDIRECT_ERROR_CODES.VERIFICATION_REJECTED,
            message: [
              'Editorial verifier rejected candidate.',
              failedChecks.length ? `Failed checks: ${failedChecks.join(', ')}.` : '',
              verificationResult.reason || ''
            ].filter(Boolean).join(' ')
          };
          transformAttemptCount += 1;
          const verifierCorrectionReadinessSkip = strictReasonerWriter
            ? await skipIfRedirectCapabilityChanged('before-verifier-directed-transform')
            : null;
          if (verifierCorrectionReadinessSkip) return verifierCorrectionReadinessSkip;
          stageRuntimeActivity({
            runId,
            phase: 'editorialTransforming',
            label: 'Correcting Redirect candidate...',
            providerLane: transformLane,
            composerLane: transformLane,
            chips: ['Enhancement', 'Redirect']
          });
          transformResponse = await generateEditorialRole('editorialTransformer', {
            ...buildEditorialPassRequest({
              mode: editorialMode,
              sourceText,
              sourceHash,
              snapshotHash,
              diagnosis: diagnosisValidation.value,
              diagnosisDiagnostics: diagnosisValidation.diagnostics,
              evidence,
              snapshot: publicSnapshot,
              targets,
              lane: transformLane,
              retry: verifierFeedback
            }),
            ...reasonerRequestMetadata(settings, 'editorial-transform', transformLane)
          }, {
            ...(strictReasonerWriter ? { allowLaneFallback: false } : {})
          });
          if (enhancementSignal?.aborted) return canceledEditorialResult();
          validation = transformResponse.result?.ok === true
            ? validateEditorialPass(transformResponse.result.data, {
                mode: editorialMode,
                sourceText,
                sourceHash,
                snapshotHash,
                diagnosisHash,
                diagnosis: diagnosisValidation.value,
                snapshot: publicSnapshot,
                targets
              })
            : {
                ok: false,
                error: transformResponse.result?.error
                  || { code: 'RECURSION_EDITORIAL_TRANSFORM_FAILED', message: 'Editorial transform failed.' }
              };
          if (!validation.ok) {
            return {
              ...failEditorial(validation.error),
              validation,
              diagnosisDecision: safeText(diagnosisValidation.value?.decision, 80),
              diagnosisDiagnostics: asObject(diagnosisValidation.diagnostics)
            };
          }
          editorialLane = transformResponse.lane;
          candidateHash = validation.artifact?.kind === 'candidate'
            ? hashJson(String(validation.artifact.candidate?.text || validation.artifact.text || ''))
            : '';
          verified = await verifyCandidate();
          if (verified.canceled) return canceledEditorialResult();
          verificationResult = verified.result;
        }
        if (!verificationResult.ok || verificationResult.decision !== 'accept') {
          return {
            ...failEditorial(verificationResult.error || { code: 'RECURSION_EDITORIAL_VERIFICATION_REJECTED', message: 'Editorial verifier rejected candidate.' }, 'Editorial verification failed. Original kept.'),
            validation: verificationResult
          };
        }
      }
      const transformedText = applyEditorialArtifact(sourceText, validation.artifact, targets);
      if (!transformedText || transformedText === sourceText) {
        return failEditorial({ code: 'RECURSION_EDITORIAL_NO_EFFECT', message: 'Editorial transform returned no effective revision.' });
      }
      const editorialPartialFailed = validation.partialFailed === true;
      const marker = {
        ...markerBase,
        diagnosisHash,
        candidateHash: candidateHash || hashJson(transformedText),
        producerLane: transformResponse.lane,
        verification: verificationResult.decision,
        outcome: editorialPartialFailed ? 'partial-failed' : 'applied',
        cardOutcomes: validation.cardOutcomes,
        unresolvedCardIds: validation.unresolvedCardIds || [],
        preservationLedger: validation.artifact.candidate?.preservationLedger || [],
        changeLedger: validation.artifact.candidate?.changeLedger || [],
        riskFlags: validation.artifact.candidate?.riskFlags || [],
        ...(editorialMode === 'redirect'
          ? {
              redirect: {
                sourceFailure: diagnosisValidation.value.brief.sourceFailure,
                replacementObjective: diagnosisValidation.value.brief.replacementObjective,
                requiredBeats: diagnosisValidation.value.brief.requiredBeats,
                forbiddenSourceBeats: diagnosisValidation.value.brief.forbiddenSourceBeats,
                characterPressure: diagnosisValidation.value.brief.characterPressure
              }
            }
          : {})
      };
      if (enhancementSignal?.aborted) return canceledEditorialResult();
      const currentIdentity = messages.activeAssistantMessageIdentity();
      const sourceChanged = !currentIdentity
        || String(currentIdentity.chatKey ?? '') !== String(identity.chatKey ?? '')
        || String(currentIdentity.messageId ?? '') !== String(messageId ?? '')
        || Number(currentIdentity.swipeId ?? 0) !== Number(identity.swipeId ?? 0)
        || String(currentIdentity.originalHash || hashJson(String(currentIdentity.text || ''))) !== String(sourceHash);
      if (sourceChanged) {
        return failEditorial(
          {
            code: 'RECURSION_EDITORIAL_SOURCE_CHANGED',
            message: 'The active assistant swipe changed before Editorial could commit.'
          },
          'Editorial source changed. Original kept.'
        );
      }
      if (applyMode === 'replace') {
        const replace = await messages.replaceAssistantMessageText?.(messageId, transformedText, { marker });
        if (replace?.ok === false) return failEditorial(replace.error);
      } else {
        if (held && typeof messages.revealAssistantMessage === 'function') { await messages.revealAssistantMessage(messageId); held = false; }
        const append = await messages.appendAssistantMessageSwipe?.(messageId, transformedText, { marker, select: true });
        if (append?.ok === false) return failEditorial(append.error);
      }
      setEditorialResult({
        mode: editorialMode,
        status: editorialPartialFailed ? 'partial-failed' : 'success',
        outcome: editorialPartialFailed ? 'partial-failed' : 'applied',
        applyMode,
        verification: verificationResult.decision,
        candidateHash: marker.candidateHash,
        diagnosisHash: marker.diagnosisHash,
        preservationLedger: marker.preservationLedger,
        changeLedger: marker.changeLedger,
        riskFlags: marker.riskFlags,
        cardOutcomes: marker.cardOutcomes,
        unresolvedCardIds: marker.unresolvedCardIds,
        redirectCharacterCount: Array.isArray(marker.redirect?.characterPressure) ? marker.redirect.characterPressure.length : 0,
        redirectRequiredBeatCount: Array.isArray(marker.redirect?.requiredBeats) ? marker.redirect.requiredBeats.length : 0
      });
      enhanced = true;
      settleRuntimeActivity({
        runId,
        phase: 'settled',
        severity: editorialPartialFailed ? 'error' : 'success',
        label: editorialPartialFailed
          ? `${editorialMode} partially applied; card review remains unresolved.`
          : `${editorialMode} applied.`,
        chips: editorialPartialFailed ? ['Enhancement', 'Partial failed'] : ['Enhancement', editorialMode],
        detail: {
          mode: editorialMode,
          applyMode,
          verification: verificationResult.decision,
          partialFailed: editorialPartialFailed,
          ...(editorialPartialFailed ? { reason: 'Installed-card audit remains unresolved.' } : {}),
          cardOutcomes: marker.cardOutcomes,
          unresolvedCardIds: marker.unresolvedCardIds
        }
      });
      return {
        ok: true,
        runId,
        partialFailed: editorialPartialFailed,
        unresolvedCardIds: marker.unresolvedCardIds,
        mode: editorialMode,
        messageId,
        sourceHash,
        enhancedHash: marker.candidateHash,
        marker,
        artifact: validation.artifact,
        cardAudit: asObject(validation.cardAudit),
        verification: verificationResult
      };
    } catch (error) {
      if (enhancementSignal?.aborted) return canceledEditorialResult();
      return failEditorial({
        code: error?.code || 'RECURSION_EDITORIAL_FAILED',
        message: String(error?.message || error || 'Editorial transform failed.')
      });
    } finally {
      clearPendingProseEnhancement();
      if (held && !enhanced && typeof messages.revealAssistantMessage === 'function') await messages.revealAssistantMessage(messageId);
      await appendEditorialSettlement();
    }
  }

  async function enhanceLatestAssistantMessageImpl(details = {}) {
    if (safeText(details.reason || '', 80) === 'assistant-message-landed' && !pendingProseEnhancement) {
      return { ok: true, skipped: true, reason: 'enhancement-not-pending' };
    }
    if (['repair', 'recompose', 'redirect'].includes(safeText(settingsStore.get()?.enhancements?.mode || '', 32))) {
      return runEditorialTransform(details);
    }
    return runGenerationReview(details);
    /* Legacy dialogue/prose enhancer implementation retained below only until its
       follow-on host harness deletion is completed. It is unreachable. */
    const settings = settingsStore.get();
    const enhancementSettings = asObject(settings.enhancements);
    const target = enhancementTarget(settings);
    const mode = enhancementApplyMode(settings);
    const passSequence = target === 'prose-dialogue' ? ['dialogue', 'prose'] : [target];
    const reason = safeText(details.reason || '', 80);
    if (reason === 'assistant-message-landed' && !pendingProseEnhancement && canceledProseEnhancement) {
      return {
        ok: true,
        skipped: true,
        reason: canceledProseEnhancement.reason || 'prose-enhancement-canceled'
      };
    }
    if (target === 'off') {
      clearPendingProseEnhancement();
      return { ok: true, skipped: true, reason: 'enhancement-off' };
    }
    const messages = asObject(host.messages);
    if (typeof messages.activeAssistantMessageIdentity !== 'function') {
      return { ok: true, skipped: true, reason: 'host-message-api-unavailable' };
    }
    const identity = messages.activeAssistantMessageIdentity();
    if (!identity?.text) {
      clearPendingProseEnhancement();
      return { ok: true, skipped: true, reason: 'assistant-message-unavailable' };
    }
    const runId = makeId('enhance');
    const messageId = identity.messageId;
    const originalText = String(identity.text || '');
    const originalHash = identity.originalHash || hashJson(originalText);
    const marker = {
      chatKey: identity.chatKey,
      messageId,
      swipeId: identity.swipeId ?? 0,
      originalHash,
      target,
      applyMode: mode,
      key: proseEnhancementKey({
        chatKey: identity.chatKey,
        messageId,
        swipeId: identity.swipeId ?? 0,
        originalHash: `${target}:${mode}:${originalHash}`
      })
    };
    const passResults = [];
    let hasPassFailure = false;
    let enhancementSceneKey = '';
    const appendEnhancementPassJournal = async ({ pass, status, reasonCode = '', reason = '', attempt = 1 } = {}) => {
      if (!identity.chatKey) return;
      const passLabel = pass === 'dialogue' ? 'Dialogue Enhancement' : 'Prose Enhancement';
      const statusLabel = status === 'applied'
        ? 'applied'
        : (status === 'unchanged'
          ? 'no safe changes found'
          : (status === 'provider-failed'
            ? 'provider failed'
            : (status === 'validation-failed' ? 'output rejected' : status)));
      stageRuntimeActivity({
        runId,
        phase: pass === 'dialogue' ? 'dialogueEnhancing' : 'proseEnhancing',
        severity: ['provider-failed', 'validation-failed'].includes(status) ? 'error' : 'success',
        label: `${passLabel} ${statusLabel}.`,
        providerLane: enhancementLaneForSettings(settings, runtimeProviderCapability),
        composerLane: enhancementLaneForSettings(settings, runtimeProviderCapability),
        chips: [passLabel],
        detail: { pass, status, attempt, ...(reasonCode ? { reasonCode } : {}), ...(reason ? { reason } : {}) }
      });
      await appendJournalSafe(runId, identity.chatKey, {
        event: 'enhancement.pass',
        severity: ['failed', 'provider-failed', 'validation-failed'].includes(status) ? 'error' : 'info',
        summary: `${pass} enhancement ${status}.`,
        runId,
        sceneKey: enhancementSceneKey,
        details: { pass, status, attempt, ...(reasonCode ? { reasonCode } : {}), ...(reason ? { reason } : {}) }
      });
    };
    const enhancementLane = enhancementLaneForSettings(settings, runtimeProviderCapability);
    const enhancementReasoning = reasonerRequestMetadata(settings, 'enhancement', enhancementLane);
    stageRuntimeActivity({
      runId,
      phase: target === 'dialogue' ? 'dialogueEnhancing' : (target === 'prose-dialogue' ? 'enhancementResponse' : 'proseEnhancing'),
      label: target === 'dialogue' ? 'Enhancing dialogue...' : (target === 'prose-dialogue' ? 'Enhancing response...' : 'Enhancing prose...'),
      providerLane: enhancementLane,
      composerLane: enhancementLane,
      chips: target === 'dialogue' ? ['Dialogue'] : (target === 'prose-dialogue' ? ['Dialogue', 'Prose'] : ['Prose'])
    });
    let held = false;
    let enhanced = false;
    try {
      if (typeof messages.holdAssistantMessage === 'function') {
        const hold = await messages.holdAssistantMessage(messageId);
        held = hold?.ok !== false;
      }
      const snapshot = typeof host.snapshot === 'function' ? await host.snapshot() : null;
      enhancementSceneKey = safeText(snapshot?.sceneKey || '', 180);
      const enhancementContext = enhancementContextFromSnapshot({
        snapshot: snapshot || {},
        hand: preparedHand(),
        activeText: originalText,
        activeSender: identity.sender || '',
        contextMessageLimit: enhancementSettings.contextMessages
      });
      const contextContract = buildContextContract(snapshot || {}, settings);
      const boundedEnhancementContext = boundEnhancementMessages(
        enhancementContext.contextMessages,
        contextContract.enhancementContext.effectiveMessages,
        contextContract.enhancementContext.characterBudget
      );
      const contextMessages = boundedEnhancementContext.messages;
      marker.contextHash = hashJson({
        sourceRevisionHash: snapshot?.sourceRevisionHash || '',
        contextMessages: contextMessageIdentity(contextMessages),
        enhancementContextMessages: contextContract.enhancementContext.configuredMessages,
        cardIds: Array.isArray(preparedHand()?.cards) ? preparedHand().cards.map((card) => card.id) : []
      });
      marker.key = proseEnhancementKey({
        chatKey: identity.chatKey,
        messageId,
        swipeId: identity.swipeId ?? 0,
        originalHash: `${target}:${mode}:${originalHash}`,
        contextHash: marker.contextHash
      });
      const storyForm = preparedPacket()?.storyForm || lastPlan?.storyForm || null;
      let enhancedText = originalText;
      const passHashes = [];
      async function generateEnhancementPass(roleId, request) {
        const primaryLane = safeText(request?.lane || 'utility', 40) === 'reasoner' ? 'reasoner' : 'utility';
        const primary = await generationRouter.generate(roleId, request, {
          runId
        });
        if (primary?.ok === true || primaryLane !== 'reasoner') {
          return { result: primary, lane: primaryLane, fallbackFrom: '' };
        }
        const fallbackRequest = { ...request, lane: 'utility' };
        delete fallbackRequest.reasoningCategory;
        delete fallbackRequest.reasoningIntent;
        const fallback = await generationRouter.generate(roleId, fallbackRequest, {
          runId
        });
        return {
          result: fallback,
          lane: fallback?.ok === true ? 'utility' : primaryLane,
          fallbackFrom: fallback?.ok === true ? 'reasoner' : '',
          primaryError: primary?.error || null
        };
      }
      async function runDialogueEnhancementAttempt({ text, retryReason = '', attempt = 1 } = {}) {
        await appendEnhancementPassJournal({
          pass: 'dialogue',
          status: attempt > 1 ? 'retrying' : 'started',
          reasonCode: retryReason,
          reason: retryReason === 'exact-noop' ? 'Previous dialogue output matched the original.' : '',
          attempt
        });
        const request = buildDialogueEnhancementRequest({
          text,
          contextMessages,
          contextMessageLimit: contextMessages.length,
          contextContract,
          storyForm,
          characterContext: enhancementContext.characterContext,
          cardContext: enhancementContext.cardContext,
          lane: enhancementLane,
          retryReason,
          ...enhancementReasoning
        });
        const generation = await generateEnhancementPass('dialogueEnhancer', request);
        const result = generation.result;
        if (result?.ok !== true) {
          return { ok: false, generation, result, attempt, retryReason };
        }
        const validation = validateDialogueEnhancementResult(result.data, { originalText: text, contextMessages });
        return { ok: validation.ok === true, validation, generation, result, attempt, retryReason };
      }
      function dialogueRetryReason({ originalText: retryOriginalText = '', validation = {} } = {}) {
        if (validation.ok !== true) return '';
        if (validation.text === String(retryOriginalText ?? '')) {
          return 'exact-noop';
        }
        if ((validation.dialogueEditRatio ?? 0) >= ENHANCEMENT_EDIT_RATIO_MINIMUM) return '';
        const strongReasons = dialogueInterventionReasons(retryOriginalText);
        const softReasons = dialogueSuspicionReasons(retryOriginalText);
        const echoReasons = echoedUserPhraseReasons({ sourceText: retryOriginalText, contextMessages });
        return strongReasons.length || softReasons.length || echoReasons.length ? 'low-dialogue-edit-ratio' : '';
      }
      for (const pass of passSequence) {
        const passOriginalText = enhancedText;
        if (pass === 'dialogue') {
          let dialogueAttempt = await runDialogueEnhancementAttempt({ text: enhancedText, attempt: 1 });
          if (dialogueAttempt.result?.ok !== true) {
            const result = dialogueAttempt.result;
            passResults.push({ pass: 'dialogue', status: 'provider-failed', reasonCode: result?.error?.code || 'provider-failed', attempt: dialogueAttempt.attempt });
            await appendEnhancementPassJournal({ pass: 'dialogue', status: 'provider-failed', reasonCode: result?.error?.code || 'provider-failed', reason: result?.error?.message || '', attempt: dialogueAttempt.attempt });
            hasPassFailure = true;
            continue;
          }
          let validation = dialogueAttempt.validation;
          const retryReason = dialogueRetryReason({ originalText: enhancedText, validation });
          if (retryReason) {
            const retry = await runDialogueEnhancementAttempt({ text: enhancedText, retryReason, attempt: 2 });
            if (retry.result?.ok !== true) {
              const result = retry.result;
              passResults.push({ pass: 'dialogue', status: 'provider-failed', reasonCode: retry.result?.error?.code || 'provider-failed', attempt: 2 });
              await appendEnhancementPassJournal({ pass: 'dialogue', status: 'provider-failed', reasonCode: result?.error?.code || 'provider-failed', reason: result?.error?.message || '', attempt: 2 });
              hasPassFailure = true;
              continue;
            }
            dialogueAttempt = retry;
            validation = retry.validation;
          }
          if (validation.ok !== true) {
            passResults.push({ pass: 'dialogue', status: 'validation-failed', reasonCode: validation.error?.code || 'validation-failed', attempt: dialogueAttempt.attempt });
            await appendEnhancementPassJournal({ pass: 'dialogue', status: 'validation-failed', reasonCode: validation.error?.code || 'validation-failed', reason: validation.error?.message || '', attempt: dialogueAttempt.attempt });
            hasPassFailure = true;
            continue;
          }
          if (validation.outcome === 'unchanged' || validation.text === String(enhancedText ?? '')) {
            passResults.push({ pass: 'dialogue', status: 'validation-failed', reasonCode: 'unchanged-after-retry', reason: 'Provider returned unchanged dialogue after the required retry.', attempt: dialogueAttempt.attempt });
            await appendEnhancementPassJournal({ pass: 'dialogue', status: 'validation-failed', reasonCode: 'unchanged-after-retry', reason: 'Provider returned unchanged dialogue after the required retry.', attempt: dialogueAttempt.attempt });
            hasPassFailure = true;
            continue;
          }
          enhancedText = validation.text;
          passResults.push({ pass: 'dialogue', status: 'applied', attempt: dialogueAttempt.attempt });
          await appendEnhancementPassJournal({ pass: 'dialogue', status: 'applied', attempt: dialogueAttempt.attempt });
          passHashes.push({
            pass,
            hash: hashJson(enhancedText),
            editRatio: validation.editRatio ?? roundedEnhancementEditRatio(passOriginalText, enhancedText),
            dialogueEditRatio: validation.dialogueEditRatio ?? roundedDialogueEditRatio(passOriginalText, enhancedText),
            lane: dialogueAttempt.generation.lane,
            attempt: dialogueAttempt.attempt,
            ...(dialogueAttempt.retryReason ? { retryReason: dialogueAttempt.retryReason } : {}),
            ...(dialogueAttempt.generation.fallbackFrom ? { fallbackFrom: dialogueAttempt.generation.fallbackFrom } : {})
          });
          continue;
        }
        if (pass === 'prose') {
          async function runProseEnhancementAttempt({ text, retryReason = '', attempt = 1 } = {}) {
            await appendEnhancementPassJournal({
              pass: 'prose',
              status: attempt > 1 ? 'retrying' : 'started',
              reasonCode: retryReason,
              reason: retryReason === 'exact-noop' ? 'Previous prose output matched the original.' : '',
              attempt
            });
            const request = buildProseEnhancementRequest({
              text,
          contextMessages,
          contextMessageLimit: contextMessages.length,
          contextContract,
              storyForm,
              cardContext: enhancementContext.cardContext,
              lane: enhancementLane,
              retryReason,
              ...enhancementReasoning
            });
            const generation = await generateEnhancementPass('proseEnhancer', request);
            const result = generation.result;
            if (result?.ok !== true) return { ok: false, generation, result, attempt, retryReason };
            const validation = validateProseEnhancementResult(result.data, { originalText: text });
            return { ok: validation.ok === true, validation, generation, result, attempt, retryReason };
          }

          let proseAttempt = await runProseEnhancementAttempt({ text: enhancedText, attempt: 1 });
          let result = proseAttempt.result;
          if (result?.ok !== true) {
            passResults.push({ pass: 'prose', status: 'provider-failed', reasonCode: result?.error?.code || 'provider-failed' });
            await appendEnhancementPassJournal({ pass: 'prose', status: 'provider-failed', reasonCode: result?.error?.code || 'provider-failed', reason: result?.error?.message || '' });
            hasPassFailure = true;
            continue;
          }
          let validation = proseAttempt.validation;
          if (validation?.outcome === 'unchanged' || validation?.text === String(enhancedText ?? '')) {
            proseAttempt = await runProseEnhancementAttempt({ text: enhancedText, retryReason: 'exact-noop', attempt: 2 });
            result = proseAttempt.result;
            if (result?.ok !== true) {
              passResults.push({ pass: 'prose', status: 'provider-failed', reasonCode: result?.error?.code || 'provider-failed', attempt: 2 });
              await appendEnhancementPassJournal({ pass: 'prose', status: 'provider-failed', reasonCode: result?.error?.code || 'provider-failed', reason: result?.error?.message || '', attempt: 2 });
              hasPassFailure = true;
              continue;
            }
            validation = proseAttempt.validation;
          }
          if (validation.ok !== true) {
            passResults.push({ pass: 'prose', status: 'validation-failed', reasonCode: validation.error?.code || 'validation-failed', attempt: proseAttempt.attempt });
            await appendEnhancementPassJournal({ pass: 'prose', status: 'validation-failed', reasonCode: validation.error?.code || 'validation-failed', reason: validation.error?.message || '', attempt: proseAttempt.attempt });
            hasPassFailure = true;
            continue;
          }
          if (validation.outcome === 'unchanged' || validation.text === String(enhancedText ?? '')) {
            passResults.push({ pass: 'prose', status: 'validation-failed', reasonCode: 'unchanged-after-retry', reason: 'Provider returned unchanged prose after the required retry.', attempt: proseAttempt.attempt });
            await appendEnhancementPassJournal({ pass: 'prose', status: 'validation-failed', reasonCode: 'unchanged-after-retry', reason: 'Provider returned unchanged prose after the required retry.', attempt: proseAttempt.attempt });
            hasPassFailure = true;
            continue;
          }
          enhancedText = validation.text;
          passResults.push({ pass: 'prose', status: 'applied', attempt: proseAttempt.attempt });
          await appendEnhancementPassJournal({ pass: 'prose', status: 'applied', attempt: proseAttempt.attempt });
          passHashes.push({
            pass,
            hash: hashJson(enhancedText),
            editRatio: validation.editRatio ?? roundedEnhancementEditRatio(passOriginalText, enhancedText),
            lane: proseAttempt.generation.lane,
            attempt: proseAttempt.attempt,
            ...(proseAttempt.retryReason ? { retryReason: proseAttempt.retryReason } : {}),
            ...(proseAttempt.generation.fallbackFrom ? { fallbackFrom: proseAttempt.generation.fallbackFrom } : {})
          });
        }
      }
      const finalTextChanged = String(enhancedText ?? '') !== originalText;
      if (!finalTextChanged) {
        if (hasPassFailure) {
          settleRuntimeActivity({
            runId,
            phase: 'settled',
            severity: 'error',
            label: 'Enhancement pass failed. Original kept.',
            chips: target === 'prose-dialogue' ? ['Dialogue', 'Prose'] : [target],
            detail: { passResults, outcome: 'failed' }
          });
          return {
            ok: false,
            target,
            mode,
            error: { code: 'RECURSION_ENHANCEMENT_PASS_FAILED', message: 'At least one selected Enhancement pass failed.' },
            passResults
          };
        }
        settleRuntimeActivity({
          runId,
          phase: 'settled',
          severity: 'success',
          label: 'Enhancement complete. No safe changes found.',
          chips: target === 'prose-dialogue' ? ['Dialogue', 'Prose'] : [target],
          detail: { passResults, outcome: 'unchanged' }
        });
        return {
          ok: true,
          unchanged: true,
          target,
          mode,
          messageId,
          originalHash,
          enhancedHash: originalHash,
          passSequence,
          passResults
        };
      }
      marker.passSequence = passSequence;
      marker.passHashes = passHashes;
      marker.passResults = passResults;
      marker.enhancedHash = hashJson(enhancedText);
      marker.editRatio = roundedEnhancementEditRatio(originalText, enhancedText);
      if (passSequence.includes('dialogue')) {
        marker.dialogueEditRatio = roundedDialogueEditRatio(originalText, enhancedText);
      }
      if (mode === 'replace') {
        const replace = await messages.replaceAssistantMessageText?.(messageId, enhancedText, { marker });
        if (replace?.ok === false) return { ok: false, mode, error: replace.error };
        enhanced = true;
      } else if (mode === 'as-swipe') {
        if (held && typeof messages.revealAssistantMessage === 'function') {
          await messages.revealAssistantMessage(messageId);
          held = false;
        }
        const existing = await messages.findEnhancedSwipe?.(messageId, marker);
        if (existing && typeof messages.selectAssistantMessageSwipe === 'function') {
          await messages.selectAssistantMessageSwipe(messageId, existing.index, { marker });
          enhanced = true;
        } else if (!existing) {
          const append = await messages.appendAssistantMessageSwipe?.(messageId, enhancedText, { marker, select: true });
          if (append?.ok === false) return { ok: false, mode, error: append.error };
          enhanced = true;
        } else {
          enhanced = true;
        }
      } else {
        return { ok: true, skipped: true, reason: 'prose-enhancement-mode-invalid' };
      }
      settleRuntimeActivity({
        runId,
        phase: 'settled',
        severity: hasPassFailure ? 'warning' : 'success',
        label: hasPassFailure
          ? 'Enhancement applied with a pass issue.'
          : (target === 'dialogue' ? 'Dialogue enhanced.' : (target === 'prose-dialogue' ? 'Response enhanced.' : 'Prose enhanced.')),
        chips: target === 'dialogue' ? ['Dialogue'] : (target === 'prose-dialogue' ? ['Dialogue', 'Prose'] : ['Prose'])
      });
      return { ok: true, degraded: hasPassFailure, target, mode, messageId, originalHash, enhancedHash: hashJson(enhancedText), editRatio: marker.editRatio, passSequence, passHashes, passResults };
    } catch (error) {
      settleRuntimeActivity({
        runId,
        phase: 'settled',
        severity: 'error',
        label: 'Enhancement failed. Original kept.',
        chips: ['Enhancement']
      });
      return { ok: false, target, mode, error: { code: 'RECURSION_ENHANCEMENT_FAILED', message: String(error?.message || error || 'Enhancement failed.') } };
    } finally {
      clearPendingProseEnhancement();
      if (held && !enhanced && typeof messages.revealAssistantMessage === 'function') {
        await messages.revealAssistantMessage(messageId);
      }
    }
  }

  async function stopGeneration(details = {}) {
    if (stopGenerationPromise) return stopGenerationPromise;
    const task = (async () => {
      postProcessRuntime.cancelPostProcess('stop-generation');
      cancelPendingProseEnhancement('prose-enhancement-canceled');
      recursionStopRequest = {
        source: safeText(details.source || 'recursion-ui', 80),
        requestedAt: nowIso()
      };
      await pauseOperation({ reason: 'user-stop' });
      supersedeActiveRun();
      const hostStop = await requestHostGenerationStop(details);
      const cleanup = await handleHostGenerationStopped({
        source: 'recursion-ui',
        eventName: 'recursion_stop_button',
        recursionRequested: true,
        hostStop
      });
      return {
        ...asObject(cleanup),
        hostStop
      };
    })().finally(() => {
      recursionStopRequest = null;
      if (stopGenerationPromise === task) stopGenerationPromise = null;
    });
    stopGenerationPromise = task;
    return task;
  }

  async function recordProviderCertificationResult(lane, certification, configHash, configRevision) {
    const beforeSettings = settingsStore.get();
    const beforeCapability = runtimeProviderCapability(beforeSettings, lane, 'prompt-packet');
    const result = settingsStore.recordProviderCertification(lane, certification, {
      configHash,
      configRevision
    });
    if (result.ok === true && typeof host?.settings?.flush === 'function') {
      await host.settings.flush();
    }
    const afterSettings = settingsStore.get();
    const afterCapability = runtimeProviderCapability(afterSettings, lane, 'prompt-packet');
    await trackRuntimeMutation(() => appendProviderCapabilityMutation({
      lane,
      kind: result.stale ? 'stale-certification' : 'certification',
      changedKeys: [],
      before: beforeCapability,
      after: afterCapability,
      stale: result.stale === true
    })).catch(() => {});
    return result;
  }

  function testProvider(lane = 'utility', options = {}) {
    const resolvedLane = providerLane(lane);
    const certificationScope = options?.scope === 'segmented' ? 'segmented' : 'full';
    if (activeProviderTests.has(resolvedLane)) return activeProviderTests.get(resolvedLane);
    if (activeProviderOperations.has(resolvedLane)) {
      return Promise.resolve(providerBusyResult(resolvedLane));
    }

    const task = (async () => {
      const runId = makeId(`provider-test-${resolvedLane}`);
      const settings = settingsStore.get();
      const providerSnapshot = settings.providers?.[resolvedLane] || {};
      const configHash = providerConfigHash(providerSnapshot);
      const configRevision = Number(providerSnapshot.configRevision || 0);
      const profiles = listProviderConnectionProfilesForUi();
      const profile = profiles.find((entry) => entry.id === providerSnapshot.connectionProfileId) || null;
      const capability = resolveProviderCapability({
        settings,
        lane: resolvedLane,
        operation: 'provider-test',
        host: { connectionProfiles: profiles }
      });

      startRuntimeActivity({
        runId,
        phase: 'providerCallStarted',
        mode: 'review',
        severity: 'info',
        providerLane: resolvedLane,
        label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} profile certification started.`,
        chips: [resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility', 'Profile']
      });

      let certification;
      if (!capability.testable || !profile) {
        certification = {
          status: 'fail',
          checkedAt: nowIso(),
          completionMode: profile?.completionMode || 'unknown',
          structuredOutput: 'unknown',
          checks: { connectivity: 'fail', singleCard: 'not-run', fusedCards: 'not-run' },
          safeConcurrency: 1,
          diagnosticCodes: ['profile-unavailable'],
          compactError: 'RECURSION_PROFILE_UNAVAILABLE: The selected Connection Profile is unavailable.'
        };
      } else if (!generationRouter || typeof generationRouter.generate !== 'function') {
        certification = {
          status: 'fail',
          checkedAt: nowIso(),
          completionMode: profile.completionMode || 'unknown',
          structuredOutput: 'unknown',
          checks: { connectivity: 'fail', singleCard: 'not-run', fusedCards: 'not-run' },
          safeConcurrency: 1,
          diagnosticCodes: ['provider-router-unavailable'],
          compactError: 'RECURSION_PROVIDER_ROUTER_UNAVAILABLE: Provider certification is unavailable.'
        };
      } else {
        stageRuntimeActivity({
          runId,
          phase: 'providerCallRunning',
          mode: 'review',
          severity: 'info',
          providerLane: resolvedLane,
          label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} profile certification running.`,
          chips: ['Profile']
        });
        certification = await certifyConnectionProfile({
          lane: resolvedLane,
          provider: providerSnapshot,
          profile,
          includeFused: certificationScope !== 'segmented',
          generate: (roleId, request) => generationRouter.generate(roleId, {
            ...request,
            ...reasoningRequestMetadata({}, 'provider-test')
          }, {
            runId,
            timeoutMs: PROVIDER_TEST_TIMEOUT_MS
          })
        });
      }

      const persisted = await recordProviderCertificationResult(
        resolvedLane,
        certification,
        configHash,
        configRevision
      );
      const stale = persisted.stale === true;
      const passed = certification.status !== 'fail';
      const label = stale
        ? `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} profile certification ignored after configuration changed.`
        : certification.status === 'pass'
          ? `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} profile is Fused-certified.`
          : certification.status === 'partial'
            ? `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} profile is Segmented-certified.`
            : `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} profile certification failed.`;
      settleRuntimeActivity({
        runId,
        outcome: stale ? 'neutral' : (passed ? 'success' : 'warning'),
        phase: passed ? 'settled' : 'providerTestFailed',
        severity: stale ? 'info' : (passed ? 'success' : 'warning'),
        providerLane: resolvedLane,
        label,
        chips: ['Profile'],
        detail: {
          status: certification.status,
          checks: certification.checks,
          diagnosticCodes: certification.diagnosticCodes,
          stale
        }
      });

      return {
        ok: passed,
        certification,
        certificationStale: stale,
        ...(passed ? {} : {
          error: {
            code: certification.compactError.split(':')[0] || 'RECURSION_PROVIDER_TEST_FAILED',
            message: certification.compactError || 'Profile certification failed.'
          }
        })
      };
    })();

    activeProviderTests.set(resolvedLane, task);
    task.finally(() => {
      if (activeProviderTests.get(resolvedLane) === task) activeProviderTests.delete(resolvedLane);
    }).catch(() => {});
    return task;
  }

  async function waitForExternalMutations() {
    while (true) {
      const promptTail = promptInstallTail;
      const storageTail = storageSaveTail;
      const mutations = runState.runtimeMutations();
      try {
        await Promise.all([promptTail, storageTail, ...mutations]);
      } catch {
        // Mutation failures are normalized at their source; tails are only sequencing gates.
      }
      if (promptTail === promptInstallTail && storageTail === storageSaveTail && runState.runtimeMutationCount() === 0) {
        return;
      }
    }
  }

  function trackRuntimeMutation(mutationWork) {
    const current = Promise.resolve().then(mutationWork);
    runState.addRuntimeMutation(current);
    current.finally(() => {
      runState.deleteRuntimeMutation(current);
    }).catch(() => {});
    return current;
  }

  async function runPromptMutationSection(runId, mutationWork) {
    const previous = promptInstallTail.catch(() => {});
    const current = previous.then(async () => {
      if (runId && !isActiveRun(runId)) return supersededResult(runId);
      return mutationWork();
    });
    promptInstallTail = current.catch(() => {});
    return current;
  }

  async function runStorageSaveSection(runId, saveWork) {
    const previous = storageSaveTail.catch(() => {});
    const current = previous.then(async () => {
      if (runId && !isRuntimeRunCurrent(runId)) return supersededResult(runId);
      return saveWork();
    });
    storageSaveTail = current.catch(() => {});
    return current;
  }

  function reportStorageWarning(runId, operation, error) {
    if (!isRuntimeRunCurrent(runId)) return;
    stageRuntimeActivity({
      runId,
      phase: 'storageWarning',
      severity: 'warning',
      label: 'Recursion storage warning; continuing in memory.',
      chips: ['Storage'],
      detail: {
        operation,
        message: safeText(error?.message || error || 'Storage operation failed.', 240)
      }
    });
  }


  async function appendJournalSafe(runId, chatKey, entry) {
    try {
      return await storage.appendJournal(chatKey, entry);
    } catch (error) {
      reportStorageWarning(runId, 'appendJournal', error);
      return null;
    }
  }

  function promptClearContext(snapshot = null) {
    if (snapshot?.chatKey) {
      return {
        chatKey: snapshot.chatKey,
        sceneKey: snapshot.sceneKey
      };
    }
    if (lastSnapshot?.chatKey) {
      return {
        chatKey: lastSnapshot.chatKey,
        sceneKey: lastSnapshot.sceneKey
      };
    }
    if (activeExecutionChatKey) return { chatKey: activeExecutionChatKey, sceneKey: '' };
    return null;
  }

  async function appendPromptClearedJournal(runId, context, clear, reason) {
    if (!context?.chatKey) return null;
    return appendJournalSafe(runId, context.chatKey, {
      event: 'prompt.cleared',
      severity: clear?.ok === false ? 'warn' : 'info',
      summary: clearJournalSummary(clear),
      runId,
      sceneKey: context.sceneKey,
      details: clearJournalDetails(clear, reason)
    });
  }

  async function appendHandSelectedJournal(runId, snapshot, hand, packet) {
    const selectedCards = Array.isArray(hand?.cards) ? hand.cards : [];
    const omittedCards = Array.isArray(hand?.omitted) ? hand.omitted : [];
    const packetDiagnostics = asObject(packet?.diagnostics);
    const selectedTokenEstimate = selectedCards.reduce((total, card) => {
      const tokenEstimate = numberOr(card?.tokenEstimate, 0);
      return total + Math.max(0, Math.round(tokenEstimate));
    }, 0);
    return appendJournalSafe(runId, snapshot.chatKey, {
      event: 'hand.selected',
      severity: 'info',
      summary: 'Turn hand selected.',
      runId,
      sceneKey: snapshot.sceneKey,
      details: {
        handId: safeIdentifier(hand?.handId || '', 'hand', 160),
        selection: hand?.metadata?.selection || null,
        selectedCount: selectedCards.length,
        omittedCount: omittedCards.length,
        guidanceStatus: safeText(packetDiagnostics.guidanceStatus || '', 80),
        guidanceFallbackReason: safeText(packetDiagnostics.guidanceFallbackReason || '', 180),
        guidanceInvalidSourceIdCount: Math.max(0, Math.round(numberOr(packetDiagnostics.guidanceInvalidSourceIdCount, 0))),
        guidanceSourceCardCount: Array.isArray(packetDiagnostics.guidanceSourceCardIds)
          ? packetDiagnostics.guidanceSourceCardIds.length
          : 0,
        guidanceGuardrailCardCount: Array.isArray(packetDiagnostics.guidanceGuardrailCardIds)
          ? packetDiagnostics.guidanceGuardrailCardIds.length
          : 0,
        guidanceOmittedCardCount: Array.isArray(packetDiagnostics.guidanceOmittedCardIds)
          ? packetDiagnostics.guidanceOmittedCardIds.length
          : 0,
        listedCount: Math.min(selectedCards.length, 16),
        truncated: selectedCards.length > 16,
        cards: selectedCards.map((card) => ({
          id: safeIdentifier(card?.id || '', 'card', 160),
          family: safeText(card?.family || '', 80),
          role: safeText(card?.role || '', 80),
          emphasis: safeText(card?.emphasis || '', 40),
          detailProfile: safeText(card?.detailProfile || '', 40),
          tokenEstimate: Math.max(0, Math.round(numberOr(card?.tokenEstimate, 0))),
          ...(Array.isArray(card?.sourceCardIds) ? { sourceCardIds: card.sourceCardIds.slice(0, 16) } : {})
        })).slice(0, 16)
      },
      hashes: {
        promptPacketHash: hashJson(packet),
        sourceHash: hashJson({
          chatKey: snapshot.chatKey,
          sceneKey: snapshot.sceneKey,
          sceneFingerprint: snapshot.sceneFingerprint,
          turnFingerprint: snapshot.turnFingerprint,
          latestMesId: snapshot.latestMesId
        })
      },
      metrics: {
        selectedTokenEstimate,
        selectedCount: selectedCards.length,
        omittedCount: omittedCards.length
      }
    });
  }

  function messageIds(snapshot) {
    return new Set(sourceWindowMessages(snapshot).map((message) => message.mesid));
  }

  function messageEvidenceIds(card) {
    const ids = [];
    for (const entry of Array.isArray(card?.evidenceRefs) ? card.evidenceRefs : []) {
      const text = String(entry ?? '');
      for (const match of text.matchAll(/\bmessage:(\d+)\b/ig)) {
        const id = Number(match[1]);
        if (Number.isFinite(id)) ids.push(id);
      }
    }
    return ids;
  }

  function cacheFingerprintCandidates(card) {
    const source = asObject(card?.source);
    const freshness = asObject(card?.freshness);
    return [
      card?.sourceFingerprint,
      card?.sourceRevisionHash,
      source.fingerprint,
      source.snapshotHash,
      source.sourceRevisionHash,
      freshness.sourceRevisionHash,
      freshness.sourceFingerprint
    ]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
  }

  function rawSourceRange(card) {
    const source = asObject(card?.source);
    const hasFirst = Object.prototype.hasOwnProperty.call(source, 'firstMesId')
      || Object.prototype.hasOwnProperty.call(card || {}, 'firstMesId');
    const hasLast = Object.prototype.hasOwnProperty.call(source, 'lastMesId')
      || Object.prototype.hasOwnProperty.call(card || {}, 'lastMesId');
    if (!hasFirst || !hasLast) return null;
    return {
      firstMesId: finiteNumberOrNull(source.firstMesId ?? card?.firstMesId),
      lastMesId: finiteNumberOrNull(source.lastMesId ?? card?.lastMesId)
    };
  }

  function sourceRangeIsVisible(snapshot, firstMesId, lastMesId) {
    if (!Number.isInteger(firstMesId) || !Number.isInteger(lastMesId)) return false;
    const ids = messageIds(snapshot);
    for (let id = firstMesId; id <= lastMesId; id += 1) {
      if (!ids.has(id)) return false;
    }
    return true;
  }

  function staleCacheCardReason(card, normalized, snapshot, options = {}) {
    const source = asObject(card?.source);
    const freshness = asObject(card?.freshness);
    const sourceChatId = String(source.chatId || card?.chatId || '').trim();
    if (sourceChatId) {
      const expectedChatIds = new Set([
        String(snapshot.chatId || '').trim(),
        String(snapshot.chatKey || '').trim(),
        safeIdentifier(snapshot.chatId || ''),
        safeIdentifier(snapshot.chatKey || '')
      ].filter(Boolean));
      if (!expectedChatIds.has(sourceChatId) && !expectedChatIds.has(safeIdentifier(sourceChatId))) {
        return 'source-chat-mismatch';
      }
    }

    const sourceRange = rawSourceRange(card);
    if (!sourceRange) return 'source-range-missing';
    const firstMesId = sourceRange.firstMesId;
    const lastMesId = sourceRange.lastMesId;
    if (!Number.isFinite(firstMesId) || !Number.isFinite(lastMesId)) return 'source-range-missing';
    if (!Number.isInteger(firstMesId) || !Number.isInteger(lastMesId) || firstMesId > lastMesId) return 'source-range-invalid';
    if (lastMesId > numberOr(snapshot.latestMesId, 0)) return 'source-range-future';
    if (!options.allowSparseSourceRange && !sourceRangeIsVisible(snapshot, firstMesId, lastMesId)) return 'source-range-not-visible';

    const expiresAfterMesId = Number(freshness.expiresAfterMesId ?? normalized?.freshness?.expiresAfterMesId);
    if (Number.isFinite(expiresAfterMesId) && numberOr(snapshot.latestMesId, 0) > expiresAfterMesId) {
      return 'source-expired';
    }

    const windowMessages = sourceWindowMessages(snapshot, firstMesId, lastMesId);
    if (!windowMessages.length) return 'source-window-missing';

    const evidenceIds = messageEvidenceIds(normalized);
    if (!evidenceIds.length) return 'evidence-message-missing';
    const visibleMessageIds = messageIds(snapshot);
    for (const evidenceId of evidenceIds) {
      if (!visibleMessageIds.has(evidenceId) && !options.allowCachedEvidenceRefs) return 'evidence-message-missing';
      if (evidenceId < firstMesId || evidenceId > lastMesId) return 'evidence-outside-source-range';
    }

    const candidates = cacheFingerprintCandidates(card);
    if (!candidates.length) return 'source-fingerprint-missing';
    const currentWindow = sourceWindowFingerprint(snapshot, firstMesId, lastMesId);
    if (!candidates.includes(currentWindow) && !options.allowCachedSourceFingerprint) return 'source-fingerprint-mismatch';

    return '';
  }

  function sanitizedCacheCards(runId, snapshot, cards, options = {}) {
    const accepted = [];
    let invalid = 0;
    let stale = 0;
    for (const card of Array.isArray(cards) ? cards : []) {
      const sanitized = sanitizeGeneratedCard(card);
      try {
        const normalized = normalizeCard(sanitized, {
          sceneId: snapshot.sceneKey,
          chatId: snapshot.chatId,
          snapshotHash: hashJson(snapshot),
          sourceRevisionHash: activeSourceRevisionHash(snapshot),
          lastMesId: snapshot.latestMesId
        });
        const staleReason = staleCacheCardReason(sanitized, normalized, snapshot, options);
        if (staleReason) {
          stale += 1;
          if (Array.isArray(options.rejectionReasons)) options.rejectionReasons.push(staleReason);
          continue;
        }
        accepted.push(sanitized);
      } catch (error) {
        invalid += 1;
        if (Array.isArray(options.rejectionReasons)) options.rejectionReasons.push(`invalid:${safeText(error?.message || error, 80)}`);
      }
    }
    if (invalid || stale) {
      stageRuntimeActivity({
        runId,
        phase: 'cacheWarning',
        severity: 'info',
        label: stale
          ? 'Ignored stale cached Recursion cards.'
          : 'Ignored invalid cached Recursion cards.',
        chips: ['Cache'],
        cardCounts: { omitted: invalid + stale, invalid, stale }
      });
    }
    return accepted;
  }

  function reportClearWarning(runId, clear) {
    settleRuntimeActivity({
      runId,
      outcome: 'warning',
      phase: 'promptClearFailed',
      label: CLEAR_FAILURE_LABEL,
      chips: ['Prompt'],
      detail: clearWarningDetails(clear)
    });
  }

  async function recheckPromptInstallSnapshot(runId, expectedSnapshot, plan, pendingUserMessage, options = {}) {
    try {
      const sourceSnapshot = options.withoutLatestAssistant === true
        ? await readSwipeSourceSnapshot()
        : await readSnapshot();
      const currentSnapshot = snapshotForPlan(
        options.withoutLatestAssistant === true
          ? sourceSnapshot
          : snapshotWithPendingUserMessage(sourceSnapshot, pendingUserMessage),
        plan
      );
      if (!snapshotsMatchForPromptInstall(expectedSnapshot, currentSnapshot, pendingUserMessage, options)) {
        const comparison = promptInstallComparisonDiagnostics(expectedSnapshot, currentSnapshot, pendingUserMessage, options);
        const allowPrefixDrift = options.allowPendingUserPrefixDrift === true
          && comparison.pendingTextPresent === true
          && comparison.chatKeyMatch === true
          && comparison.sceneKeyMatch === true
          && comparison.sceneFingerprintMatch === true
          && comparison.latestMesIdMatch === true
          && comparison.messageCountMatch === true
          && comparison.expectedLatest?.role === 'user'
          && comparison.currentLatest?.role === 'user'
          && comparison.expectedLatest?.textHashMatches === true
          && comparison.currentLatest?.textHashMatches === true;
        if (allowPrefixDrift) {
          return { ok: true, snapshot: currentSnapshot, prefixDrift: true };
        }
        return {
          ok: false,
          reason: 'stale-snapshot',
          currentSnapshot,
          comparison
        };
      }
      return { ok: true, snapshot: currentSnapshot };
    } catch (error) {
      return {
        ok: false,
        reason: 'snapshot-recheck-failed',
        error: sanitizePromptError(
          error,
          'RECURSION_PROMPT_SNAPSHOT_RECHECK_FAILED',
          'Prompt install snapshot recheck failed.'
        )
      };
    }
  }

  async function skipPromptInstallAfterFreshnessFailure(runId, {
    reason,
    sceneSnapshot,
    currentSnapshot = null,
    packet = null,
    hand = null,
    plan = null,
    error = null,
    comparison = null
  }) {
    const install = {
      ok: true,
      skipped: true,
      reason,
      ...(error ? { error } : {})
    };
    const details = {
      status: 'skipped',
      reason,
      ...(error ? { error } : {}),
      expected: promptInstallFreshnessSignature(sceneSnapshot),
      ...(currentSnapshot ? { current: promptInstallFreshnessSignature(currentSnapshot) } : {}),
      ...(comparison ? { comparison } : {})
    };
    await appendJournalSafe(runId, sceneSnapshot.chatKey, {
      event: 'prompt.install_skipped',
      severity: 'warn',
      summary: reason === 'snapshot-recheck-failed'
        ? 'Prompt install skipped because the host snapshot could not be rechecked.'
        : 'Prompt install skipped because the host turn changed before write.',
      runId,
      sceneKey: sceneSnapshot.sceneKey,
      details,
      ...(packet ? { hashes: { promptPacketHash: hashJson(packet) } } : {})
    });
    if (!isActiveRun(runId)) return supersededResult(runId);
    settleRuntimeActivity({
      runId,
      outcome: 'warning',
      label: STALE_INSTALL_LABEL,
      chips: ['Prompt'],
      detail: {
        reason,
        ...(error?.message ? { message: error.message } : {})
      }
    });
    return {
      ok: true,
      skipped: true,
      reason,
      ...(packet ? { packet } : {}),
      ...(hand ? { hand } : {}),
      ...(plan ? { plan } : {}),
      install
    };
  }

  async function askUtilityArbiter({ runId, snapshot, settings, fallbackPlan, sceneCache, userMessage, signal }) {
    if (!generationRouter || typeof generationRouter.generate !== 'function') {
      return markUtilityUnavailable(fallbackPlan, 'utility provider unavailable');
    }
    const arbiterLane = arbiterLaneForSettings(settings, runtimeProviderCapability);
    stageRuntimeActivity({
      runId,
      phase: 'arbiterPlanning',
      label: 'Planning card pass...',
      providerLane: arbiterLane,
      chips: [arbiterLane === 'reasoner' ? 'Reasoner' : 'Utility']
    });
    try {
      const cacheView = compactSceneCacheForArbiter(sceneCache, snapshot, settings);
      const cardScope = runtimeScopePayload(settings);
      const eligibility = settingsWithRuntimeCardScope(settings).cardEligibility;
      const catalog = usesCardDeckEligibility(settings)
        ? cardScope.availableCatalog.filter((entry) => eligibility.allowedFamilies.includes(entry.family))
        : (cardScope.strictWhitelist ? cardScope.allowedCatalog : cardScope.availableCatalog);
      const result = await generationRouter.generate('utilityArbiter', {
        lane: arbiterLane,
        runId,
        signal,
        snapshotHash: fallbackPlan.snapshotHash,
        ...reasonerRequestMetadata(settings, 'arbiter', arbiterLane),
        prompt: [
          'Return a Recursion Utility Arbiter plan as strict JSON.',
          `Schema: ${UTILITY_ARBITER_SCHEMA}`,
          arbiterOutputContractLine(fallbackPlan.snapshotHash),
          `Settings: ${JSON.stringify(arbiterSafeSettings(settings, runtimeProviderCapability))}`,
          behaviorPolicyPromptLines(influencePolicyForSettings(settings)),
          `Provider health: ${JSON.stringify(providerHealthForArbiter(settings, runtimeProviderCapability))}`,
          `Card scope: ${JSON.stringify(compactArbiterScope(cardScope))}`,
          cardScopePolicyLine(cardScope),
          ...(usesCardDeckEligibility(settings)
            ? [`Card Deck eligibility is a hard whitelist. Allowed families: ${JSON.stringify(eligibility.allowedFamilies)}. Inactive families are unavailable.`]
            : []),
          arbiterCardJobContractLine(),
          arbiterStoryFormContractLine(),
          reasoningPolicyPromptLine(settings),
          `Catalog: ${JSON.stringify(catalog)}`,
          `Catalog hash: ${hashJson(catalog)}`,
          `Snapshot hash: ${fallbackPlan.snapshotHash}`,
          `User message hash: ${hashJson(userMessage)}`,
          `Scene cache: ${JSON.stringify(cacheView)}`,
          `Snapshot: ${JSON.stringify(providerSafeSnapshot(snapshot, settings.retention))}`
        ].join('\n\n')
      }, { runId, signal });
      if (result?.ok) {
        try {
          return mergePlan(fallbackPlan, result.data);
        } catch (error) {
          return markArbiterFallback(fallbackPlan, error?.message || error);
        }
      }
      return markUtilityUnavailable(fallbackPlan, result?.error?.message || result?.error?.code || 'utility arbiter returned non-ok result');
    } catch (error) {
      return markUtilityUnavailable(fallbackPlan, error?.message || error);
    }
  }

  async function generatePlanCards({ runId, plan, snapshot, settings, signal }) {
    const empty = { cards: [], diagnostics: [] };
    if (!generationRouter) return empty;
    const cardScope = runtimeScopePayload(settings);
    const requestContext = {
      runId,
      snapshotHash: plan.snapshotHash || hashJson(snapshot),
      snapshot: providerSafeSnapshot(snapshot, settings.retention),
      cardScope,
      sourceCardsByFamily: activeCardDeckSourceCards(settings),
      storyForm: plan.storyForm || UNKNOWN_STORY_FORM
    };
    const requests = buildCardRequests(plan, requestContext).map((request) => applyReasoningLaneToCardRequest(request, settings, runtimeProviderCapability));
    if (!requests.length) return empty;
    if (typeof generationRouter.batch !== 'function' && typeof generationRouter.generate !== 'function') return empty;
    const fusedLane = fusedCardBundleLaneForSettings(settings, runtimeProviderCapability);
    const pipelineDecision = resolveEffectivePipelineMode({
      requestedMode: settings.pipelineMode,
      selectedProfileId: settings.providers?.[fusedLane]?.connectionProfileId,
      selectedCapability: runtimeProviderCapability(settings, fusedLane, 'prompt-packet')
    });
    if (pipelineDecision.effectiveMode === 'fused' && typeof generationRouter.generate === 'function') {
      return runFusedCardPipeline({
        runId,
        plan,
        snapshot,
        settings: { ...settings, pipelineMode: pipelineDecision.effectiveMode },
        generationRouter,
        requests,
        requestContext,
        sourceContext: cardSourceContext(snapshot),
        applyFusedRequest: (request, sourceSettings) => applyReasoningLaneToFusedCardBundleRequest(
          request,
          sourceSettings,
          runtimeProviderCapability
        ),
        stageRuntimeActivity,
        signal,
        isCurrent: () => isRuntimeRunCurrent(runId),
        safeText
      });
    }

    return runSegmentedCardPipeline({
      runId,
      plan,
      snapshot,
      settings: { ...settings, pipelineMode: pipelineDecision.effectiveMode },
      generationRouter,
      requests,
      sourceContext: cardSourceContext(snapshot),
      stageRuntimeActivity,
      signal,
      isCurrent: () => isRuntimeRunCurrent(runId)
    });
  }

  function preparedGenerationBasisForAttempt(snapshot, {
    swipe = false,
    sourceAlreadyExcludesLatestAssistant = false,
    swipeMessageId = null,
    pendingUserMessage = null,
    settings,
    packet = null,
    hand = null,
    turnIdentity = null
  } = {}) {
    const snapshotBasis = swipe && !sourceAlreadyExcludesLatestAssistant
      ? generationBasisForLatestAssistantSwipe(snapshot, swipeMessageId, settings)
      : generationBasisForSnapshot(
          snapshotWithPendingUserMessage(snapshot, pendingUserMessage),
          settings
        );
    if (!snapshotBasis) return null;
    return preparedTurnBasis({
      basis: snapshotBasis,
      packet,
      hand,
      contract: preparedGenerationContract(settings),
      turnIdentity
    });
  }

  async function reinstallPreparedGeneration(runId, {
    artifact,
    settings,
    swipe = false,
    swipeMessageId = null,
    pendingUserMessage = null,
    basisMode = 'exact',
    turnIdentity = null
  } = {}) {
    const packet = artifact.packet;
    const hand = artifact.hand;
    const install = await runPromptMutationSection(runId, async () => {
      stageRuntimeActivity({
        runId,
        phase: 'promptInstalling',
        label: 'Reinstalling Recursion prompt for swipe retry...',
        chips: ['Prompt', 'Swipe']
        , detail: {
          cacheDecision: 'hit',
          cacheKind: 'prepared-generation',
          cacheReason: 'prepared-generation-exact-match',
          basisMode
        }
      });
      if (!isActiveRun(runId)) return supersededResult(runId);
      let currentSnapshot;
      let currentBasis;
      try {
        currentSnapshot = swipe
          ? await readSwipeSourceSnapshot()
          : await readSnapshot();
        currentBasis = preparedGenerationBasisForAttempt(currentSnapshot, {
          swipe,
          sourceAlreadyExcludesLatestAssistant: swipe,
          swipeMessageId,
          pendingUserMessage,
          settings,
          packet,
          hand,
          turnIdentity
        });
      } catch (error) {
        recordCacheDecision(runId, {
          decision: 'miss',
          kind: 'prepared-generation',
          reason: 'snapshot-recheck-failed',
          artifactHash: artifact.artifactHash,
          packetId: packet.packetId,
          handId: hand.handId
        });
        return {
          ok: true,
          skipped: true,
          reason: 'snapshot-recheck-failed',
          error: sanitizePromptError(
            error,
            'RECURSION_PREPARED_GENERATION_RECHECK_FAILED',
            'Prepared generation snapshot recheck failed.'
          )
        };
      }
      const comparison = compareGenerationBasis(
        artifact.basis,
        currentBasis,
        { allowBoundedSuffix: swipe }
      );
      if (!comparison.matches) {
        recordCacheDecision(runId, {
          decision: 'miss',
          kind: 'prepared-generation',
          reason: 'stale-generation-basis',
          basisMode: comparison.mode,
          basisReason: comparison.reason,
          artifactHash: artifact.artifactHash,
          packetId: packet.packetId,
          handId: hand.handId
        });
        await appendJournalSafe(runId, artifact.basis.chatKey, {
          event: 'prompt.install_skipped',
          severity: 'warn',
          summary: 'Prepared generation became stale before prompt install.',
          runId,
          sceneKey: artifact.basis.sceneKey,
          details: {
            reason: 'stale-generation-basis',
            basisMode: comparison.mode,
            basisReason: comparison.reason
          },
          hashes: {
            artifactHash: artifact.artifactHash,
            expectedBasisHash: hashJson(artifact.basis),
            currentBasisHash: currentBasis ? hashJson(currentBasis) : ''
          }
        });
        return {
          ok: true,
          skipped: true,
          reason: 'stale-generation-basis',
          comparison
        };
      }
      if (!isActiveRun(runId)) return supersededResult(runId);
      const result = await installPrompt(host, packet);
      if (!isActiveRun(runId)) return supersededResult(runId);
      const installOk = result?.ok !== false;
      if (installOk) {
        recordCacheDecision(runId, {
          decision: 'hit',
          kind: 'prepared-generation',
          reason: 'prepared-generation-exact-match',
          basisMode: comparison.mode,
          basisReason: comparison.reason,
          artifactHash: artifact.artifactHash,
          packetId: packet.packetId,
          handId: hand.handId,
          reusedCardIds: hand.cards?.map((card) => card.id),
          providerCallsSkipped: preparedGenerationSkippedRoles(artifact)
        });
      } else {
        recordCacheDecision(runId, {
          decision: 'miss',
          kind: 'prepared-generation',
          reason: 'prompt-install-failed',
          basisMode: comparison.mode,
          basisReason: comparison.reason,
          artifactHash: artifact.artifactHash,
          packetId: packet.packetId,
          handId: hand.handId
        });
        await appendJournalSafe(runId, artifact.basis.chatKey, {
          event: 'prompt.install_failed',
          severity: 'warn',
          summary: installSummary(result),
          runId,
          sceneKey: artifact.basis.sceneKey,
          details: {
            reason: 'prepared-generation-exact-match',
            basisMode: comparison.mode,
            ...installJournalDetails(result)
          },
          hashes: { promptPacketHash: hashJson(packet) }
        });
      }
      if (!isActiveRun(runId)) return supersededResult(runId);
      settleRuntimeActivity({
        runId,
        outcome: installOk ? 'success' : 'warning',
        label: installOk ? 'Recursion prompt reused for swipe retry.' : INSTALL_FAILURE_LABEL,
        chips: ['Prompt', 'Swipe']
      });
      return { ...result, basisMode: comparison.mode };
    });
    if (install?.superseded) return install;
    if (install?.skipped) {
      settleRuntimeActivity({
        runId,
        outcome: 'warning',
        phase: 'promptInstallSkipped',
        label: STALE_INSTALL_LABEL,
        chips: ['Prompt', 'Swipe']
      });
      return {
        ok: true,
        skipped: true,
        reused: false,
        preparedMatch: true,
        reason: install.reason,
        packet,
        hand,
        install
      };
    }
    const installOk = install?.ok !== false;
    if (installOk) readyLastBrief({ runId, reason: 'prepared-generation-reused' });
    else clearLastBrief({ status: 'empty', reason: 'prompt-install-failed', runId });
    return {
      ok: installOk,
      reused: installOk,
      preparedMatch: true,
      reason: installOk ? 'prepared-generation-exact-match' : 'prompt-install-failed',
      basisMode: install.basisMode || basisMode,
      packet,
      hand,
      install
    };
  }

  function preparedGenerationSkippedRoles(artifact) {
    const pipelineMode = safeText(artifact?.packet?.diagnostics?.pipelineMode || 'segmented', 40);
    const roles = ['utilityArbiter'];
    if (pipelineMode === 'fused') roles.push('fusedCardBundle');
    else if ((artifact?.hand?.cards?.length || 0) > 0) roles.push('segmentedCardCalls');
    if (artifact?.packet?.diagnostics?.composerLane === 'reasoner') roles.push('reasonerComposer');
    return roles;
  }

  async function tryPreparedGenerationReuse(runId, {
    basis,
    settings,
    swipe = false,
    swipeMessageId = null,
    pendingUserMessage = null,
    forceFresh = false,
    turnIdentity = null
  } = {}) {
    const contract = preparedGenerationContract(settings);
    const currentBasis = lastPreparedGeneration
      ? preparedTurnBasis({
          basis,
          packet: lastPreparedGeneration.packet,
          hand: lastPreparedGeneration.hand,
          contract,
          turnIdentity
        })
      : basis;
    const decision = validatePreparedGenerationArtifact(lastPreparedGeneration, {
      basis: currentBasis,
      packetInputHash: contract.packetInputHash,
      forceFresh,
      allowBoundedSuffix: swipe
    });
    if (decision.decision !== 'hit') {
      recordCacheDecision(runId, {
        ...decision,
        kind: 'prepared-generation',
        artifactHash: lastPreparedGeneration?.artifactHash,
        packetId: lastPreparedGeneration?.packet?.packetId,
        handId: lastPreparedGeneration?.hand?.handId
      });
      return { reused: false, ...decision };
    }
    return reinstallPreparedGeneration(runId, {
      artifact: lastPreparedGeneration,
      settings,
      swipe,
      swipeMessageId,
      pendingUserMessage,
      basisMode: decision.basisMode,
      turnIdentity
    });
  }

  function executionSourceIdentity(snapshot = {}) {
    const latest = latestVisibleMessage(snapshot) || {};
    return {
      sourceRevisionHash: activeSourceRevisionHash(snapshot),
      latestMessageId: String(snapshot.latestMesId ?? latest.mesid ?? ''),
      selectedSwipeId: String(latest.swipeId ?? ''),
      characterHash: safeText(snapshot.activeCharacterHash || snapshot.characterHash || '', 180),
      groupHash: safeText(snapshot.activeGroupHash || snapshot.groupHash || '', 180)
    };
  }

  function executionProvenance(snapshot, settings, turnIdentity = null, pipelineDecision = null) {
    const utility = settings?.providers?.utility || {};
    const turn = asObject(turnIdentity);
    return buildRunProvenance({
      chatKey: safeText(snapshot.chatKey || snapshot.chatId || DEFAULT_CHAT_ID, 180) || DEFAULT_CHAT_ID,
      turnKeyHash: safeText(turn.turnKeyHash || '', 180),
      sourceBandHash: safeText(turn.sourceBandHash || '', 180),
      sourceIdentity: executionSourceIdentity(snapshot),
      settingsHash: hashJson(preparedGenerationSettingsSignature(settings)),
      provider: {
        id: utility.connectionProfileId
          ? `profile-${hashJson(utility.connectionProfileId).slice(0, 16)}`
          : 'utility-unconfigured',
        model: ''
      },
      pipelineMode: pipelineDecision?.effectiveMode || (settings.pipelineMode === 'fused' ? 'fused' : 'segmented'),
      promptVersions: {
        promptPacket: PROMPT_PACKET_VERSION,
        preprocessGraph: 5
      },
      providerContractHash: PROVIDER_CONTRACT_HASH,
      deckRevisionHash: activeDeckRevisionHash(settings),
      cardConfigurationHash: hashJson(settingsWithRuntimeCardScope(settings).cardEligibility),
      promptContractHash: preparedGenerationContract(settings).promptContractHash
    });
  }

  async function loadExecutionArtifact(manifest, stageId) {
    const checkpoint = manifest?.stageRecords?.[stageId]?.checkpoint;
    if (!checkpoint) return null;
    return storage.loadPipelineArtifact(
      manifest.chatKey,
      manifest.operationId,
      checkpoint.artifactRef?.artifactId || stageId
    );
  }

  function summarizeExecutionArtifact(artifact) {
    const source = asObject(artifact);
    return {
      keys: Object.keys(source).sort().slice(0, 30),
      ...(Array.isArray(source.cards) ? { cardCount: source.cards.length } : {}),
      ...(source.family ? { family: safeText(source.family, 120) } : {}),
      ...(source.action ? { action: safeText(source.action, 80) } : {})
    };
  }

  function durableSnapshotStage(context) {
    return {
      id: 'preprocess.snapshot',
      version: 1,
      kind: 'local',
      executable: true,
      dependencies: [],
      checkpoint: 'durable',
      failurePolicy: 'blocking',
      buildInputFingerprint() {
        return {
          turnKeyHash: context.turnIdentity?.turnKeyHash || '',
          sourceBandHash: context.turnIdentity?.sourceBandHash || '',
          sourceIdentity: context.provenance.sourceIdentity,
          pendingUserMessageHash: context.pendingUserMessage.textHash
        };
      },
      run() {
        return {
          snapshot: context.snapshot,
          pendingUserMessage: context.pendingUserMessage,
          turnIdentity: context.turnIdentity
        };
      },
      validate(artifact) {
        return artifact?.snapshot?.chatKey === context.snapshot.chatKey
          ? { ok: true, value: artifact }
          : { ok: false, error: { code: 'RECURSION_SNAPSHOT_INVALID' } };
      },
      summarizeArtifact(artifact) {
        return {
          chatKey: safeText(artifact?.snapshot?.chatKey || '', 180),
          latestMesId: numberOr(artifact?.snapshot?.latestMesId, 0),
          sourceRevisionHash: activeSourceRevisionHash(artifact?.snapshot)
        };
      }
    };
  }

  function buildDurableArbiterRequest(context) {
    const {
      runId,
      settings,
      arbiterSnapshot,
      fallbackPlan,
      initialCache,
      pendingUserMessage
    } = context;
    const arbiterLane = arbiterLaneForSettings(settings, runtimeProviderCapability);
    const cacheView = compactSceneCacheForArbiter(initialCache, arbiterSnapshot, settings);
    const cardScope = runtimeScopePayload(settings);
    const eligibility = settingsWithRuntimeCardScope(settings).cardEligibility;
    const catalog = usesCardDeckEligibility(settings)
      ? cardScope.availableCatalog.filter((entry) => eligibility.allowedFamilies.includes(entry.family))
      : (cardScope.strictWhitelist ? cardScope.allowedCatalog : cardScope.availableCatalog);
    return {
      roleId: 'utilityArbiter',
      request: {
        lane: arbiterLane,
        runId,
        snapshotHash: fallbackPlan.snapshotHash,
        ...reasonerRequestMetadata(settings, 'arbiter', arbiterLane),
        prompt: [
          'Return a Recursion Utility Arbiter plan as strict JSON.',
          `Schema: ${UTILITY_ARBITER_SCHEMA}`,
          arbiterOutputContractLine(fallbackPlan.snapshotHash),
          `Settings: ${JSON.stringify(arbiterSafeSettings(settings, runtimeProviderCapability))}`,
          behaviorPolicyPromptLines(influencePolicyForSettings(settings)),
          `Provider health: ${JSON.stringify(providerHealthForArbiter(settings, runtimeProviderCapability))}`,
          `Card scope: ${JSON.stringify(compactArbiterScope(cardScope))}`,
          cardScopePolicyLine(cardScope),
          ...(usesCardDeckEligibility(settings)
            ? [`Card Deck eligibility is a hard whitelist. Allowed families: ${JSON.stringify(eligibility.allowedFamilies)}. Inactive families are unavailable.`]
            : []),
          arbiterCardJobContractLine(),
          arbiterStoryFormContractLine(),
          reasoningPolicyPromptLine(settings),
          `Catalog: ${JSON.stringify(catalog)}`,
          `Catalog hash: ${hashJson(catalog)}`,
          `Snapshot hash: ${fallbackPlan.snapshotHash}`,
          `User message hash: ${hashJson(pendingUserMessage.text)}`,
          `Pending user message: ${JSON.stringify(pendingUserMessage.text)}`,
          `Scene cache: ${JSON.stringify(cacheView)}`,
          `Snapshot: ${JSON.stringify(providerSafeSnapshot(arbiterSnapshot, settings.retention))}`
        ].join('\n\n')
      }
    };
  }

  function normalizeDurableArbiterPlan(context, result) {
    if (result?.ok !== true) {
      return {
        ok: false,
        error: {
          code: safeText(result?.error?.code || 'RECURSION_ARBITER_FAILED', 120),
          category: safeText(result?.error?.category || 'provider', 80),
          retryable: result?.error?.retryable !== false,
          message: safeText(result?.error?.message || 'Utility Arbiter call failed.', 240)
        }
      };
    }
    let plan;
    try {
      plan = mergePlan(context.fallbackPlan, result.data);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'RECURSION_ARBITER_INVALID',
          category: 'validation',
          retryable: true,
          message: safeText(error?.message || 'Utility Arbiter output was invalid.', 240)
        }
      };
    }
    const latestAssistant = latestVisibleAssistantEntry(context.arbiterSnapshot);
    if (context.settings.storyFormOverride && context.settings.storyFormOverride !== 'auto') {
      const forced = forcedStoryForm(context.settings.storyFormOverride);
      if (forced) plan = { ...plan, storyForm: normalizeStoryForm(forced) };
    } else {
      plan = {
        ...plan,
        storyForm: normalizeStoryFormWithHeuristic(
          plan.storyForm,
          UNKNOWN_STORY_FORM,
          latestAssistant?.message?.text || ''
        )
      };
    }
    plan = enforceReasonerAvailability(plan, context.settings, runtimeProviderCapability);
    plan = applyReasoningPolicyToPlan(plan, context.settings);
    plan = applyBehaviorPolicyToPlan(plan, context.settings);
    const scoped = filterCardJobsForRuntimeScope(plan.cardJobs, context.settings);
    plan = {
      ...plan,
      cardJobs: scoped.cardJobs,
      selection: { ...plan.selection, omitted: scoped.omitted },
      diagnostics: mergeDiagnostics(
        plan.diagnostics,
        scopeOmissionReasons(scoped.omitted),
        ...(scoped.diagnostics || [])
      )
    };
    const manualCoverage = reconcileManualForcedCardJobs({
      plan,
      settings: context.settings,
      cacheCards: [],
      forceContext: context.turnIdentity
    });
    plan = {
      ...plan,
      cardJobs: manualCoverage.cardJobs,
      budgets: {
        ...plan.budgets,
        maxCards: Math.max(
          budgetOr(plan.budgets?.maxCards, 0),
          manualCoverage.forcedFamilies.length
        )
      },
      diagnostics: mergeDiagnostics(
        plan.diagnostics,
        manualCoverage.diagnostics
      )
    };
    plan = context.settings.mode === 'auto' ? reconcileAutoPriorityPlan(plan, context.settings) : budgetCardJobsForGeneration(
      plan,
      runPolicyForEffectivePlan(context.settings, plan),
      prioritySelectionForSettings(context.settings).forcedFamilies
    ).plan;
    if (planAction(plan) === 'refresh-cards' && plan.cardJobs.length === 0 && activeCardDeckAuthoredCards(context.settings).length === 0) {
      return {
        ok: false,
        error: {
          code: 'RECURSION_ARBITER_EMPTY_REFRESH',
          category: 'validation',
          retryable: true,
          message: 'refresh-cards requires at least one executable card job.'
        }
      };
    }
    return { ok: true, value: plan };
  }

  function durableArbiterStage(context) {
    return {
      id: 'preprocess.arbiter',
      version: 1,
      kind: 'model',
      executable: true,
      dependencies: ['preprocess.snapshot'],
      checkpoint: 'durable',
      failurePolicy: 'blocking',
      buildInputFingerprint(_runtimeContext, dependencies) {
        return {
          snapshotHash: dependencies['preprocess.snapshot'].checkpoint.outputHash,
          settingsHash: context.provenance.settingsHash,
          providerContractHash: context.provenance.providerContractHash
        };
      },
      buildRequest() {
        return buildDurableArbiterRequest(context);
      },
      run({ request, signal }) {
        if (!generationRouter || typeof generationRouter.generate !== 'function') {
          throw Object.assign(new Error('Utility provider is unavailable.'), {
            code: 'RECURSION_UTILITY_UNAVAILABLE',
            retryable: false
          });
        }
        return generationRouter.generate(
          request.roleId,
          { ...request.request, signal },
          { runId: context.runId, signal }
        );
      },
      validate(result, validationContext = {}) {
        if (
          validationContext.reuse === true
          && result?.schema === UTILITY_ARBITER_SCHEMA
          && result?.snapshotHash === context.fallbackPlan.snapshotHash
        ) {
          return { ok: true, value: result };
        }
        return normalizeDurableArbiterPlan(context, result);
      },
      buildCorrectionRequest({ request, error, attempt }) {
        return {
          ...request,
          request: {
            ...request.request,
            prompt: [
              request.request.prompt,
              'Correction required.',
              `Attempt ${attempt} was rejected: ${safeText(error?.message || error?.code || 'invalid Arbiter plan', 180)}`,
              `Return one corrected JSON object only using schema "${UTILITY_ARBITER_SCHEMA}".`
            ].join('\n\n')
          }
        };
      },
      summarizeArtifact: summarizeExecutionArtifact
    };
  }

  function durableSegmentedStages(context, plan, cardJobs = plan.cardJobs) {
    const selectedCards = Array.isArray(cardJobs) ? cardJobs : [];
    const scopedPlan = { ...plan, cardJobs: selectedCards };
    const requestContext = {
      runId: context.runId,
      snapshotHash: scopedPlan.snapshotHash || hashJson(context.snapshot),
      snapshot: providerSafeSnapshot(context.snapshot, context.settings.retention),
      cardScope: runtimeScopePayload(context.settings),
      sourceCardsByFamily: activeCardDeckSourceCards(context.settings),
      storyForm: scopedPlan.storyForm || UNKNOWN_STORY_FORM
    };
    const requests = buildCardRequests(scopedPlan, requestContext)
      .map((request) => {
        const job = selectedCards.find((entry) => entry.family === request.metadata.family);
        const rejection = normalizeFusedRejections([{ family: request.metadata.family, code: job?.fusedRejectionCode }])[0];
        const corrected = rejection ? {
          ...request,
          prompt: `${request.prompt}\n\nRepair this family from the Fused bundle [${rejection.code}]: ${fusedRejectionReason(rejection.code)}\nReturn only this corrected card; accepted sibling cards are already preserved.`
        } : request;
        return applyReasoningLaneToCardRequest(corrected, context.settings, runtimeProviderCapability);
      });
    const requestByKey = new Map();
    for (const request of requests) {
      for (const key of [request.metadata?.family, request.roleId]) {
        const normalized = safeText(key || '', 120);
        if (normalized) requestByKey.set(normalized, request);
      }
    }
    const requestForSelectedCard = (selectedCard) => requestByKey.get(
      safeText(selectedCard?.family || selectedCard?.role || selectedCard?.roleId || '', 120)
    );
    return createSegmentedCardStages({
      selectedCards,
      createCardRequest(selectedCard) {
        return requestForSelectedCard(selectedCard) || null;
      },
      async generateCard(request, { signal }) {
        if (!request || !generationRouter || typeof generationRouter.generate !== 'function') {
          throw Object.assign(new Error('Card provider request is unavailable.'), {
            code: 'RECURSION_CARD_PROVIDER_UNAVAILABLE',
            retryable: false
          });
        }
        return generationRouter.generate(
          request.roleId,
          { ...request, signal },
          { runId: context.runId, signal }
        );
      },
      validateCard(result, { selectedCard, reuse = false }) {
        const request = requestForSelectedCard(selectedCard);
        if (
          reuse
          && safeText(result?.family || '', 120) === safeText(selectedCard?.family || '', 120)
          && safeText(result?.promptText || '', 1200)
        ) {
          return { ok: true, value: result };
        }
        const family = safeText(selectedCard?.family || request?.metadata?.family || 'Card', 120);
        if (result?.ok !== true) {
          const error = asObject(result?.error);
          const code = safeText(error.code || 'RECURSION_CARD_PROVIDER_FAILED', 120);
          const category = safeText(
            result?.diagnostics?.failure?.category || error.category || 'provider-output',
            80
          );
          const providerSuggestedAction = safeText(
            result?.diagnostics?.failure?.suggestedAction || error.suggestedAction || '',
            180
          );
          const expectedSchema = safeText(error.expectedSchema || 'recursion.card.v1', 120);
          const actualSchema = safeText(error.actualSchema || '', 120);
          const responseFields = Array.isArray(error.responseFields)
            ? error.responseFields.map((field) => safeText(field, 80)).filter(Boolean).slice(0, 24)
            : [];
          const schemaMismatch = code === 'RECURSION_PROVIDER_SCHEMA_MISMATCH';
          const details = schemaMismatch
            ? [
                `${family} provider output did not match ${expectedSchema}.`,
                actualSchema && actualSchema !== '(missing)' ? `Returned schema: ${actualSchema}.` : 'Top-level schema was missing.',
                responseFields.length ? `Returned fields: ${responseFields.join(', ')}.` : ''
              ].filter(Boolean).join(' ')
            : `${family} card provider failed (${code}): ${safeText(error.message || 'The provider response was not usable.', 240)}`;
          return {
            ok: false,
            error: {
              code,
              category,
              retryable: category === 'provider-output' || error.retryable === true,
              message: details,
              suggestedAction: providerSuggestedAction || (
                category === 'provider-output'
                  ? `Retry ${family}. If it repeats, use a model with reliable JSON Schema output.`
                  : `Retry ${family}.`
              )
            }
          };
        }
        const providerCardContext = {
          ...cardSourceContext(context.snapshot),
          expectedSnapshotHash: request?.snapshotHash,
          expectedRole: request?.metadata?.role,
          expectedFamily: request?.metadata?.family,
          sourceCardIds: request?.metadata?.sourceCardIds || [],
          sourceCards: request?.metadata?.sourceCards || []
        };
        const cards = cardsFromProviderResult(result, providerCardContext);
        const card = cards[0];
        const rejection = card ? '' : providerCardRejectReason(result, providerCardContext);
        return card
          ? { ok: true, value: sanitizeGeneratedCard(card) }
          : {
              ok: false,
              error: {
                code: 'RECURSION_CARD_INVALID',
                category: 'validation',
                retryable: true,
                message: `${family} card failed semantic validation (${safeText(rejection || 'unknown', 240)}).`,
                suggestedAction: `Retry ${family}. If it repeats, inspect the card validation reason.`
              }
            };
      }
    }).map((stage) => ({
      ...stage,
      buildCorrectionRequest({ request, error, attempt }) {
        return {
          ...request,
          prompt: [
            request?.prompt || '',
            'Correction required.',
            `Attempt ${attempt} was rejected [${safeText(error?.code || 'RECURSION_CARD_INVALID', 120)}]: ${safeText(error?.message || 'Card response was invalid.', 300)}`,
            'Return one corrected JSON object only with promptText and evidenceRefs.'
          ].filter(Boolean).join('\n\n')
        };
      },
      summarizeArtifact: stage.summarize
    }));
  }

  function durableFusedStages(context, plan) {
    const requestContext = {
      runId: context.runId,
      snapshotHash: plan.snapshotHash || hashJson(context.snapshot),
      snapshot: providerSafeSnapshot(context.snapshot, context.settings.retention),
      cardScope: runtimeScopePayload(context.settings),
      sourceCardsByFamily: activeCardDeckSourceCards(context.settings),
      storyForm: plan.storyForm || UNKNOWN_STORY_FORM
    };
    const selectedCards = Array.isArray(plan.cardJobs) ? plan.cardJobs : [];
    return createFusedCardStages({
      selectedCards,
      createBundleRequest() {
        const request = buildFusedCardBundleRequest(plan, requestContext);
        return request
          ? applyReasoningLaneToFusedCardBundleRequest(
              request,
              context.settings,
              runtimeProviderCapability
            )
          : null;
      },
      async generateBundle(request, { attempt, signal }) {
        if (!request || !generationRouter || typeof generationRouter.generate !== 'function') {
          throw Object.assign(new Error('Fused provider request is unavailable.'), {
            code: 'RECURSION_FUSED_PROVIDER_UNAVAILABLE',
            retryable: false
          });
        }
        const providerResult = await generationRouter.generate(
          'fusedCardBundle',
          { ...request, signal },
          { runId: context.runId, signal }
        );
        return { providerResult, attempt };
      },
      validateBundle(artifact, validationContext = {}) {
        if (
          validationContext.reuse === true
          && artifact?.cards
          && artifact?.outcomes
        ) {
          return { ok: true, value: artifact };
        }
        const request = buildFusedCardBundleRequest(plan, requestContext);
        return validateFusedProviderResult(artifact?.providerResult, {
          selectedCards,
          request,
          cardContext: cardSourceContext(context.snapshot)
        });
      }
    }).map((stage) => ({
      ...stage,
      summarizeArtifact: stage.summarize
    }));
  }

  function durableDeckStage(context, plan, cardStageIds) {
    return {
      id: 'preprocess.deck',
      version: 1,
      kind: 'local',
      executable: true,
      dependencies: ['preprocess.arbiter', ...cardStageIds],
      checkpoint: 'durable',
      failurePolicy: 'blocking',
      buildInputFingerprint(_runtimeContext, dependencies) {
        return {
          planHash: dependencies['preprocess.arbiter'].checkpoint.outputHash,
          cardHashes: Object.fromEntries(cardStageIds.map((stageId) => [
            stageId,
            dependencies[stageId].checkpoint?.outputHash || dependencies[stageId].stateHash
          ])),
          cacheHash: hashJson(context.initialCache || {}),
          fullFresh: Boolean(context.fullFresh)
        };
      },
      run({ dependencies }) {
        const settings = context.settings;
        const snapshot = context.snapshot;
        const action = planAction(plan);
        const scopedDiagnostics = [];
        const filterScopedCards = (cards) => {
          const scoped = filterCardsForRuntimeScope(cards, settings);
          scopedDiagnostics.push(
            ...scopeOmissionReasons(scoped.omitted),
            ...autoScopeExceptionReasons(scoped.cards, settings)
          );
          return scoped.cards;
        };
        const activeCache = activeSceneCacheVariant(context.initialCache, snapshot);
        const cacheCards = context.fullFresh
          ? []
          : filterScopedCards(cardsWithOrigin(
              sanitizedCacheCards(context.runId, snapshot, activeCache.cards),
              'cache'
            ));
        const reuseCacheOnly = !context.fullFresh
          && action === 'reuse-cache'
          && cacheCards.length > 0;
        const providerCards = reuseCacheOnly
          ? []
          : filterScopedCards(cardsWithOrigin(
              cardStageIds
                .flatMap((stageId) => {
                  const artifact = dependencies[stageId]?.artifact;
                  if (artifact?.cards && typeof artifact.cards === 'object') {
                    return Object.values(artifact.cards);
                  }
                  return artifact ? [artifact] : [];
                })
                .filter((card) => card && card.promptText)
                .map(sanitizeGeneratedCard),
              'generated'
            ));
        const generatedCards = !reuseCacheOnly && !cacheCards.length && !providerCards.length
          ? filterScopedCards(cardsWithOrigin(
              localCards(snapshot).map(sanitizeGeneratedCard),
              'fallback'
            ))
          : [];
        const candidateCards = reuseCacheOnly
          ? cacheCards
          : [...cacheCards, ...providerCards, ...generatedCards];
        const deck = applyCardPlan(cacheCards, {
          acceptedCards: [...generatedCards, ...providerCards],
          lifecycle: lifecycleForDeck(
            candidateCards,
            plan,
            (card) => (
              reuseCacheOnly
                ? 'reused scene cache'
                : (providerCards.some((entry) => entry.id === card.id)
                    ? 'utility generated card'
                    : (generatedCards.some((entry) => entry.id === card.id)
                        ? 'current fallback hand'
                        : 'scene cache'))
            )
          )
        });
        return {
          deck,
          cacheCards,
          providerCards,
          generatedCards,
          reuseCacheOnly,
          diagnostics: mergeDiagnostics(plan.diagnostics, scopedDiagnostics)
        };
      },
      validate(artifact) {
        return Array.isArray(artifact?.deck?.cards)
          ? { ok: true, value: artifact }
          : { ok: false, error: { code: 'RECURSION_DECK_INVALID' } };
      },
      summarizeArtifact(artifact) {
        return {
          cardCount: artifact?.deck?.cards?.length || 0,
          cacheCardCount: artifact?.cacheCards?.length || 0,
          providerCardCount: artifact?.providerCards?.length || 0,
          fallbackCardCount: artifact?.generatedCards?.length || 0
        };
      }
    };
  }

  function durableHandStage(context, plan) {
    return {
      id: 'preprocess.hand',
      version: 1,
      kind: 'local',
      executable: true,
      dependencies: ['preprocess.deck'],
      checkpoint: 'durable',
      failurePolicy: 'blocking',
      buildInputFingerprint(_runtimeContext, dependencies) {
        return {
          deckHash: dependencies['preprocess.deck'].checkpoint.outputHash,
          budgetHash: hashJson(plan.budgets || {}),
          policyHash: hashJson(runPolicyForEffectivePlan(context.settings, plan))
        };
      },
      run({ dependencies }) {
        const deckArtifact = dependencies['preprocess.deck'].artifact;
        const behaviorPolicy = runPolicyForEffectivePlan(context.settings, plan);
        const prioritySelection = prioritySelectionForSettings(context.settings);
        return selectHand(
          [...filterCardsForRuntimeScope(deckArtifact.deck.cards, context.settings).cards,
            ...activeCardDeckAuthoredCards(context.settings)],
          {
            maxCards: budgetOr(plan.budgets?.maxCards, 6),
            maxTokens: cardEvidenceTokenBudget(context.settings, plan, behaviorPolicy),
            behaviorPolicy,
            forcedFamilies: context.settings.mode === 'manual' ? prioritySelection.forcedFamilies : [],
            forcedCardIds: prioritySelection.forcedCardIds,
            selectionDiagnostics: plan.selection || null,
            selectionOrder: context.settings.mode === 'auto' ? [
              ...(plan.cardJobs || []).map((job) => job.family),
              ...(plan.lifecycle || []).filter((entry) => ['select', 'emphasize'].includes(entry.action)).map((entry) => entry.cardId)
            ] : null
          }
        );
      },
      validate(artifact) {
        return Array.isArray(artifact?.cards) && Array.isArray(artifact?.omitted)
          ? { ok: true, value: artifact }
          : { ok: false, error: { code: 'RECURSION_HAND_INVALID' } };
      },
      summarizeArtifact(artifact) {
        return {
          handId: safeIdentifier(artifact?.handId || '', 'hand', 160),
          cardCount: artifact?.cards?.length || 0,
          omittedCount: artifact?.omitted?.length || 0,
          authoredCards: (artifact?.cards || []).filter((card) => card.origin === 'authored').map((card) => ({
            id: safeIdentifier(card.id, 'card', 160),
            name: safeText(getActiveCardDeck(context.settings).cards[card.id]?.name || 'Authored card', 120),
            priority: (artifact.metadata?.forcedCardIds || []).includes(card.id)
          }))
        };
      }
    };
  }

  function durableGuidanceStage(context, plan) {
    const handStageId = hasCardRefinement(context.settings) ? REFINED_HAND_STAGE_ID : 'preprocess.hand';
    return {
      id: 'preprocess.guidance',
      version: 4,
      kind: 'model',
      executable: true,
      dependencies: ['preprocess.snapshot', 'preprocess.arbiter', handStageId],
      checkpoint: 'durable',
      failurePolicy: 'blocking',
      buildInputFingerprint(_runtimeContext, dependencies) {
        return {
          snapshotHash: dependencies['preprocess.snapshot'].checkpoint.outputHash,
          planHash: dependencies['preprocess.arbiter'].checkpoint.outputHash,
          handHash: dependencies[handStageId].checkpoint.outputHash,
          promptContractHash: context.provenance.promptContractHash
        };
      },
      buildRequest(_runtimeContext, dependencies) {
        return buildGuidanceStageRequest({
          hand: dependencies[handStageId].artifact,
          snapshot: context.snapshot,
          settings: settingsForPlan(
            context.settings,
            plan,
            runtimeProviderCapability
          ),
          behaviorPolicy: runPolicyForEffectivePlan(context.settings, plan),
          runId: context.runId,
          storyForm: plan.storyForm || UNKNOWN_STORY_FORM
        });
      },
      async run({ request, signal, attempt }) {
        if (!generationRouter || typeof generationRouter.generate !== 'function') {
          return {
            ok: false,
            error: {
              code: 'RECURSION_GUIDANCE_PROVIDER_UNAVAILABLE',
              message: 'Guidance provider is unavailable.'
            }
          };
        }
        try {
          const result = await generationRouter.generate(
            request.roleId,
            { ...request.request, signal },
            { runId: context.runId, signal, stageAttempt: attempt }
          );
          return { ...result, guidanceLane: request.request.lane };
        } catch (error) {
          return {
            ok: false,
            error: sanitizePromptError(
              error,
              'RECURSION_GUIDANCE_PROVIDER_FAILED',
              'Guidance provider failed.'
            ),
            guidanceLane: request.request.lane
          };
        }
      },
      validate(result, validationContext = {}) {
        if (
          validationContext.reuse === true
          && result?.schema === PROMPT_GUIDANCE_SCHEMA
          && result?.status === 'used'
          && safeText(result?.text || '', 6000)
        ) {
          return { ok: true, value: result };
        }
        if (result?.ok === false && !['RECURSION_JSON_OBJECT_REQUIRED', 'RECURSION_JSON_PARSE_FAILED', 'RECURSION_PROVIDER_SCHEMA_MISMATCH'].includes(result?.error?.code)) {
          return { ok: false, error: { ...result.error, kind: 'transport' } };
        }
        const validation = validateGuidanceStageResult(result, {
          hand: validationContext.dependencies?.[handStageId]?.artifact,
          snapshot: context.snapshot
        });
        if (validation.ok === true) return {
          ...validation,
          value: { ...validation.value, lane: result.guidanceLane }
        };
        return validation;
      },
      buildCorrectionRequest({ request, error, attempt }) {
        return {
          ...request,
          request: buildGuidanceCorrectionRequest({
            request: request.request,
            failure: error,
            attempt
          })
        };
      },
      summarizeArtifact(artifact) {
        return {
          status: safeText(artifact?.status || '', 40),
          sourceCardCount: artifact?.sourceCardIds?.length || 0,
          guardrailCardCount: artifact?.guardrailCardIds?.length || 0
        };
      }
    };
  }

  function durablePacketStage(context, plan) {
    const handStageId = hasCardRefinement(context.settings) ? REFINED_HAND_STAGE_ID : 'preprocess.hand';
    return {
      id: 'preprocess.packet',
      version: 1,
      kind: 'local',
      executable: true,
      dependencies: [
        'preprocess.snapshot',
        'preprocess.arbiter',
        handStageId,
        'preprocess.guidance'
      ],
      checkpoint: 'durable',
      failurePolicy: 'blocking',
      buildInputFingerprint(_runtimeContext, dependencies) {
        return {
          handHash: dependencies[handStageId].checkpoint.outputHash,
          guidanceHash: dependencies['preprocess.guidance'].checkpoint.outputHash,
          promptContractHash: context.provenance.promptContractHash
        };
      },
      async run({ dependencies }) {
        const guidance = dependencies['preprocess.guidance'].artifact;
        const effectiveSettings = {
          ...settingsForPlan(context.settings, plan, runtimeProviderCapability),
          reasonerUse: 'off'
        };
        const packet = await composePromptPacket({
          hand: dependencies[handStageId].artifact,
          snapshot: context.snapshot,
          settings: effectiveSettings,
          behaviorPolicy: runPolicyForEffectivePlan(context.settings, plan),
          generationRouter: null,
          runId: context.runId,
          precomposedGuidance: guidance,
          storyForm: plan.storyForm || UNKNOWN_STORY_FORM,
          pipelineMode: context.effectivePipelineMode,
          planDiagnostics: mergeDiagnostics(
            plan.diagnostics,
            context.pipelineDecision.reasonCode ? [context.pipelineDecision.reasonCode] : []
          )
        });
        return {
          ...packet,
          pipelineMode: context.effectivePipelineMode,
          diagnostics: {
            ...packet.diagnostics,
            ...(dependencies[handStageId].artifact.metadata?.refinement
              ? { refinement: dependencies[handStageId].artifact.metadata.refinement } : {}),
            composerLane: guidance.lane || 'utility',
            reasonerStatus: guidance.lane === 'reasoner'
              ? (guidance.status === 'used' ? 'used' : 'fallback')
              : 'skipped',
            requestedPipelineMode: context.pipelineDecision.requestedMode,
            pipelineMode: context.pipelineDecision.effectiveMode,
            pipelineReasonCodes: context.pipelineDecision.reasonCode
              ? [context.pipelineDecision.reasonCode]
              : []
          }
        };
      },
      validate(artifact) {
        try {
          validatePromptPacket(artifact);
          return { ok: true, value: artifact };
        } catch (error) {
          return { ok: false, error };
        }
      },
      summarizeArtifact(artifact) {
        return {
          packetId: safeIdentifier(artifact?.packetId || '', 'packet', 180),
          handId: safeIdentifier(artifact?.handId || '', 'hand', 180),
          cardCount: artifact?.selectedCardRefs?.length || 0
        };
      }
    };
  }

  function durableInstallStage(context, plan) {
    return {
      id: 'preprocess.install',
      version: 1,
      kind: 'host',
      executable: true,
      dependencies: ['preprocess.snapshot', 'preprocess.packet'],
      checkpoint: 'durable',
      failurePolicy: 'continue',
      buildInputFingerprint(_runtimeContext, dependencies) {
        return {
          snapshotHash: dependencies['preprocess.snapshot'].checkpoint.outputHash,
          packetHash: dependencies['preprocess.packet'].checkpoint.outputHash
        };
      },
      async run({ dependencies }) {
        const packet = dependencies['preprocess.packet'].artifact;
        const freshness = await recheckPromptInstallSnapshot(
          context.runId,
          context.snapshot,
          plan,
          context.pendingUserMessage,
          { withoutLatestAssistant: context.generationType === 'swipe' }
        );
        if (freshness.ok === false) {
          return {
            ok: false,
            installed: false,
            settled: true,
            failureClass: 'host-source-stale',
            reason: freshness.reason,
            comparison: freshness.comparison || null,
            continuePrimaryGeneration: false
          };
        }
        const install = await installPrompt(host, packet);
        if (install?.ok === false) {
          await clearPromptBestEffort(host);
          return {
            ok: false,
            installed: false,
            settled: true,
            failureClass: 'host-install-rejected',
            continuePrimaryGeneration: false,
            error: sanitizePromptError(
              install.error,
              'RECURSION_PROMPT_INSTALL_FAILED',
              'Prompt install failed.'
            )
          };
        }
        return {
          ok: true,
          installed: true,
          settled: true,
          failureClass: '',
          continuePrimaryGeneration: true
        };
      },
      validate(artifact) {
        return artifact?.settled === true
          ? { ok: true, value: artifact }
          : { ok: false, error: { code: 'RECURSION_PROMPT_INSTALL_UNSETTLED' } };
      },
      settledFailure(artifact) {
        return artifact?.installed === false
          ? promptInstallFailure(artifact)
          : null;
      },
      summarizeArtifact(artifact) {
        return {
          installed: artifact?.installed === true,
          settled: artifact?.settled === true,
          failureClass: safeText(artifact?.failureClass || '', 120),
          continuePrimaryGeneration: artifact?.continuePrimaryGeneration === true
        };
      }
    };
  }

  function createDurableExecutionGraph(context, { stages }) {
    return createExecutionGraph({
      stages: stages.map((stage) => {
        if (stage.kind !== 'model' || typeof stage.buildRequest !== 'function') return stage;
        return {
          ...stage,
          async buildRequest(...args) {
            const envelope = await stage.buildRequest(...args);
            if (!envelope) return envelope;
            const request = envelope.request || envelope;
            const lane = request.lane === 'reasoner' ? 'reasoner' : 'utility';
            const configuredRequest = {
              ...request,
              providerConfig: { outputTokenCeiling: context.settings.providers?.[lane]?.outputTokenCeiling }
            };
            return envelope.request ? { ...envelope, request: configuredRequest } : configuredRequest;
          }
        };
      })
    });
  }

  function durableBaseGraph(context) {
    return createDurableExecutionGraph(context, {
      stages: [
        durableSnapshotStage(context),
        durableArbiterStage(context)
      ]
    });
  }

  function unresolvedFusedCardJobs(plan, fusedArtifact) {
    const unresolved = new Set(
      Array.isArray(fusedArtifact?.fallback?.families)
        ? fusedArtifact.fallback.families.map((family) => safeText(family, 120))
        : []
    );
    return (Array.isArray(plan?.cardJobs) ? plan.cardJobs : [])
      .filter((job) => unresolved.has(safeText(job?.family || job?.role || '', 120)))
      .map((job) => ({ ...job, fusedRejectionCode: normalizeFusedRejections(fusedArtifact?.rejections)
        .find((entry) => entry.family === job.family)?.code || 'invalid-card' }));
  }

  function durableCardStageSet(context, plan, {
    segmentedFallback = false,
    fallbackCardJobs = []
  } = {}) {
    const cardJobs = Array.isArray(plan?.cardJobs) ? plan.cardJobs : [];
    if (cardJobs.length === 0) {
      return {
        stages: [],
        resultStageIds: [],
        segmentedFallback: false
      };
    }
    if (context.effectivePipelineMode !== 'fused') {
      const stages = durableSegmentedStages(context, plan, cardJobs);
      return {
        stages,
        resultStageIds: stages.map((stage) => stage.id),
        segmentedFallback: false
      };
    }
    const fusedStages = durableFusedStages(context, plan);
    if (!segmentedFallback) {
      return {
        stages: fusedStages,
        resultStageIds: fusedStages.map((stage) => stage.id),
        segmentedFallback: false
      };
    }
    const segmentedStages = durableSegmentedStages(context, plan, fallbackCardJobs);
    return {
      stages: [...fusedStages, ...segmentedStages],
      resultStageIds: [fusedStages[0].id, ...segmentedStages.map((stage) => stage.id)],
      segmentedFallback: true
    };
  }

  function durableCardWaveGraph(context, plan, options = {}) {
    const cardSet = durableCardStageSet(context, plan, options);
    return createDurableExecutionGraph(context, {
      stages: [
        durableSnapshotStage(context),
        durableArbiterStage(context),
        ...cardSet.stages
      ]
    });
  }

  function durableFullGraph(context, plan, options = {}) {
    const cardSet = durableCardStageSet(context, plan, options);
    const refinementStages = createCardRefinementStages({
      settings: context.settings,
      snapshot: providerSafeSnapshot(context.snapshot, context.settings.retention),
      snapshotHash: plan.snapshotHash || hashJson(context.snapshot),
      generate: (roleId, request, options) => generationRouter.generate(roleId, request, {
        ...options, runId: context.runId
      })
    });
    return createDurableExecutionGraph(context, {
      stages: [
        durableSnapshotStage(context),
        durableArbiterStage(context),
        ...cardSet.stages,
        durableDeckStage(context, plan, cardSet.resultStageIds),
        durableHandStage(context, plan),
        ...refinementStages,
        durableGuidanceStage(context, plan),
        durablePacketStage(context, plan),
        durableInstallStage(context, plan)
      ]
    });
  }

  function durableOperationResult(manifest, plan = null) {
    return {
      ok: false,
      continuePrimaryGeneration: false,
      paused: manifest?.state === 'paused',
      execution: manifest,
      ...(plan ? { plan } : {})
    };
  }

  async function startDurableGraph(context, manifest, graph) {
    preprocessGraphs.set(manifest.operationId, graph);
    const next = await executionScheduler.start({
      manifest,
      graph,
      context
    });
    executionView = next;
    queuedReprocessView = await storage.loadQueuedReprocess(manifest.chatKey, manifest.phase);
    return next;
  }

  async function bindDurableQueuedIntent(context, manifest, graph, intentValue = undefined) {
    const intent = intentValue === undefined
      ? await storage.loadQueuedReprocess(manifest.chatKey, manifest.phase)
      : intentValue;
    const normalizedIntent = normalizeQueuedReprocess(intent);
    const binding = bindQueuedReprocess({
      intent: normalizedIntent,
      graph,
      manifest,
      provenance: context.provenance
    });
    const retainedIntent = binding.intent;
    context.fullFresh = normalizedIntent?.mode === 'full-fresh';
    if (retainedIntent) {
      await storage.saveQueuedReprocess(manifest.chatKey, retainedIntent);
    } else if (intent) {
      await storage.clearQueuedReprocess(manifest.chatKey, manifest.phase);
    }
    queuedReprocessView = retainedIntent;
    if (binding.notices.length > 0) {
      settleRuntimeActivity({
        runId: context.runId,
        outcome: 'warning',
        phase: 'storageWarning',
        severity: 'warning',
        label: 'Queued stage is unavailable for this operation.',
        chips: ['Pre-process'],
        detail: redact(binding.notices[0])
      });
    }
    const next = await storage.savePipelineRun(manifest.chatKey, {
      ...binding.manifest,
      revision: Number(manifest.revision || 0) + 1,
      updatedAt: nowIso()
    });
    executionView = next;
    return {
      manifest: next,
      intent: retainedIntent,
      notices: binding.notices
    };
  }

  async function advanceDurablePreprocess(
    context,
    manifest,
    planValue = null,
    { validateDownstream = false } = {}
  ) {
    if (!manifest || manifest.state !== 'completed') {
      return durableOperationResult(manifest, planValue);
    }
    const plan = planValue
      || await loadExecutionArtifact(manifest, 'preprocess.arbiter');
    if (!plan) throw new Error('Durable Arbiter checkpoint artifact is unavailable.');
    lastPlan = plan;

    if (planAction(plan) === 'skip') {
      const clear = await clearPromptBestEffort(host);
      clearPreparedGeneration();
      executionView = manifest;
      await appendJournalSafe(context.runId, context.chatKey, {
        event: 'prompt.install_skipped',
        severity: clear?.ok === false ? 'warn' : 'info',
        summary: 'Utility Arbiter skipped Recursion prompt installation.',
        runId: context.runId,
        sceneKey: context.snapshot.sceneKey,
        details: { reason: 'arbiter-skip' }
      });
      if (clear?.ok === false) {
        reportClearWarning(context.runId, clear);
      } else {
        settleRuntimeActivity({
          runId: context.runId,
          outcome: 'success',
          phase: 'settled',
          severity: 'success',
          label: 'Recursion skipped by Utility Arbiter.'
        });
      }
      clearActiveRun(context.runId);
      return {
        ok: true,
        skipped: true,
        reason: 'arbiter-skip',
        clear,
        plan,
        execution: manifest,
        continuePrimaryGeneration: true,
        recursionPromptInstalled: false
      };
    }

    let segmentedFallback = false;
    let fallbackCardJobs = [];
    if (context.effectivePipelineMode === 'fused') {
      const fusedRecord = manifest.stageRecords?.['preprocess.cards.fused'];
      if (!fusedRecord || validateDownstream) {
        manifest = await startDurableGraph(
          context,
          manifest,
          durableCardWaveGraph(context, plan)
        );
        if (manifest.state !== 'completed') {
          return durableOperationResult(manifest, plan);
        }
      }
      const fusedArtifact = await loadExecutionArtifact(
        manifest,
        'preprocess.cards.fused'
      );
      segmentedFallback = fusedArtifact?.fallback?.mode === 'segmented';
      fallbackCardJobs = segmentedFallback
        ? unresolvedFusedCardJobs(plan, fusedArtifact)
        : [];
      const fallbackStages = durableSegmentedStages(context, plan, fallbackCardJobs);
      if (
        segmentedFallback
        && (validateDownstream || !fallbackStages.every(
          (stage) => manifest.stageRecords?.[stage.id]?.state === 'completed'
        ))
      ) {
        manifest = await startDurableGraph(
          context,
          manifest,
          durableCardWaveGraph(context, plan, {
            segmentedFallback: true,
            fallbackCardJobs
          })
        );
        if (manifest.state !== 'completed') {
          return durableOperationResult(manifest, plan);
        }
      }
    } else if (
      validateDownstream || !durableSegmentedStages(context, plan).every(
        (stage) => manifest.stageRecords?.[stage.id]?.state === 'completed'
      )
    ) {
      manifest = await startDurableGraph(
        context,
        manifest,
        durableCardWaveGraph(context, plan)
      );
      if (manifest.state !== 'completed') {
        return durableOperationResult(manifest, plan);
      }
    }

    if (!manifest.stageRecords?.['preprocess.install'] || validateDownstream) {
      const graphOptions = { segmentedFallback, fallbackCardJobs };
      manifest = await startDurableGraph(
        context,
        manifest,
        durableFullGraph(context, plan, graphOptions)
      );
      if (manifest.state !== 'completed') {
        return durableOperationResult(manifest, plan);
      }
    }
    preprocessGraphs.set(
      manifest.operationId,
      durableFullGraph(context, plan, { segmentedFallback, fallbackCardJobs })
    );
    return finalizeDurablePreprocess(context, manifest, plan);
  }

  async function finalizeDurablePreprocess(context, manifest, plan) {
    const [
      packet,
      hand,
      installSettlement
    ] = await Promise.all([
      loadExecutionArtifact(manifest, 'preprocess.packet'),
      loadExecutionArtifact(manifest, hasCardRefinement(context.settings) ? REFINED_HAND_STAGE_ID : 'preprocess.hand'),
      loadExecutionArtifact(manifest, 'preprocess.install')
    ]);
    if (!packet || !hand) {
      return {
        ok: false,
        paused: manifest.state === 'paused',
        execution: manifest,
        plan
      };
    }
    const candidate = createPreparedGenerationCandidate(
      packet,
      hand,
      context.snapshot,
      context.settings,
      context.turnIdentity
    );
    const installed = installSettlement?.installed === true;
    if (candidate && installed) commitPreparedGeneration(candidate);
    lastPlan = plan;
    lastSnapshot = context.snapshot;
    if (installed) {
      readyLastBrief({ runId: context.runId, reason: 'packet-installed' });
      try {
        await runStorageSaveSection(context.runId, () => storage.saveLastBrief(
          context.chatKey,
          {
            turnKeyHash: context.turnIdentity?.turnKeyHash || manifest.turnKeyHash,
            status: 'ready',
            packet,
            hand,
            committedAt: nowIso()
          }
        ));
      } catch (error) {
        reportStorageWarning(context.runId, 'saveLastBrief', error);
      }
    } else {
      clearLastBrief({
        status: 'empty',
        reason: installSettlement?.failureClass || 'prompt-install-failed',
        runId: context.runId
      });
    }
    await appendHandSelectedJournal(context.runId, context.snapshot, hand, packet);
    await appendJournalSafe(context.runId, context.chatKey, {
      event: installed ? 'prompt.installed' : 'prompt.install_failed',
      severity: installed ? 'info' : 'warn',
      summary: installSummary(installSettlement),
      runId: context.runId,
      sceneKey: context.snapshot.sceneKey,
      details: installJournalDetails(installSettlement),
      hashes: { promptPacketHash: hashJson(packet) }
    });
    settleRuntimeActivity({
      runId: context.runId,
      outcome: installed ? 'success' : 'warning',
      phase: 'settled',
      severity: installed ? 'success' : 'warning',
      label: installed ? 'Recursion prompt ready.' : INSTALL_FAILURE_LABEL
    });
    clearActiveRun(context.runId);
    return {
      ok: installed,
      packet,
      hand,
      plan,
      install: {
        ok: installed,
        ...(installSettlement || {})
      },
      continuePrimaryGeneration: installed,
      recursionPromptInstalled: installed,
      execution: manifest
    };
  }

  async function createDurablePreprocessContext({
    snapshot,
    settings,
    pendingUserMessage = normalizePendingUserMessage(''),
    runId = makeId('preprocess'),
    hostGeneration = false,
    generationType = '',
    turnIdentity = null,
    generationClassification = null
  } = {}) {
    const chatKey = safeText(snapshot.chatKey || snapshot.chatId || DEFAULT_CHAT_ID, 180)
      || DEFAULT_CHAT_ID;
    const initialCache = null;
    const fusedLane = fusedCardBundleLaneForSettings(settings, runtimeProviderCapability);
    const pipelineDecision = resolveEffectivePipelineMode({
      requestedMode: settings.pipelineMode,
      selectedProfileId: settings.providers?.[fusedLane]?.connectionProfileId,
      selectedCapability: runtimeProviderCapability(settings, fusedLane, 'prompt-packet')
    });
    const fallbackPlan = localFallbackPlan(snapshot, settings);
    fallbackPlan.source = {
      ...fallbackPlan.source,
      userMessageHash: hashJson(pendingUserMessage.text),
      catalogHash: hashJson(CARD_CATALOG)
    };
    return {
      runId,
      chatKey,
      snapshot,
      arbiterSnapshot: snapshotWithoutVisiblePendingUserMessage(
        snapshot,
        pendingUserMessage
      ),
      pendingUserMessage,
      settings,
      pipelineDecision,
      effectivePipelineMode: pipelineDecision.effectiveMode,
      initialCache,
      turnIdentity,
      generationClassification,
      fallbackPlan,
      provenance: executionProvenance(snapshot, settings, turnIdentity, pipelineDecision),
      hostGeneration,
      generationType: safeText(generationType, 40)
    };
  }

  async function restoreDurablePreprocessContext(
    manifest,
    currentSnapshot,
    turnIdentity = null,
    generationClassification = null
  ) {
    const snapshotArtifact = await loadExecutionArtifact(
      manifest,
      'preprocess.snapshot'
    );
    const restoredSnapshot = snapshotArtifact?.snapshot || currentSnapshot;
    const pendingUserMessage = normalizePendingUserMessage(
      snapshotArtifact?.pendingUserMessage || ''
    );
    return createDurablePreprocessContext({
      snapshot: restoredSnapshot,
      settings: settingsStore.get(),
      pendingUserMessage,
      runId: safeIdentifier(manifest.operationId, 'preprocess', 180),
      turnIdentity,
      generationClassification
    });
  }

  async function restoreDurablePreprocessGraph(manifest, context) {
    const plan = await loadExecutionArtifact(manifest, 'preprocess.arbiter');
    if (!plan) return durableBaseGraph(context);
    let segmentedFallback = false;
    let fallbackCardJobs = [];
    if (context.effectivePipelineMode === 'fused') {
      const fusedArtifact = await loadExecutionArtifact(
        manifest,
        'preprocess.cards.fused'
      );
      segmentedFallback = fusedArtifact?.fallback?.mode === 'segmented';
      fallbackCardJobs = segmentedFallback
        ? unresolvedFusedCardJobs(plan, fusedArtifact)
        : [];
    }
    return durableFullGraph(context, plan, { segmentedFallback, fallbackCardJobs });
  }

  async function markLastBriefHistorical(chatKey, reason = 'new-user-turn') {
    if (lastBriefPacket || (lastBriefHand?.cards?.length || 0) > 0) {
      lastBrief = {
        ...lastBrief,
        status: 'historical',
        reason: safeText(reason, 120),
        updatedAt: nowIso()
      };
    }
    try {
      const storedBrief = await storage.loadLastBrief?.(chatKey);
      if (storedBrief && storedBrief.status !== 'historical') {
        await storage.saveLastBrief(chatKey, {
          ...storedBrief,
          status: 'historical'
        });
      }
    } catch {
      // Historical Last Brief state is inspection-only and never blocks generation.
    }
  }

  async function revokePreviousTurn({
    chatKey,
    storedManifest,
    reason = 'new-user-turn'
  } = {}) {
    await markLastBriefHistorical(chatKey, reason);
    clearPreparedGeneration();
    clearPendingLatestAssistantSwipeRetry();
    try {
      await clearPromptBestEffort(host);
    } catch {
      // The durable manifest is still revoked even if host prompt cleanup fails.
    }
    const revoked = storedManifest
      ? await storage.revokeTurnExecution(chatKey, {
          operationId: storedManifest.operationId,
          reason
        })
      : { ok: true, revoked: false, eligibilityRevoked: true, cleanupFailures: [] };
    if (!storedManifest) {
      try {
        await storage.clearQueuedReprocess(chatKey);
      } catch {
        // Orphaned queued intent cleanup is best-effort at a new-turn boundary.
      }
    }
    if (storedManifest?.operationId) {
      preprocessContexts.delete(storedManifest.operationId);
      preprocessGraphs.delete(storedManifest.operationId);
    }
    executionView = null;
    queuedReprocessView = null;
    return revoked;
  }

  async function reuseCompletedDurableTurn({
    context,
    manifest,
    plan,
    swipeMessageId
  } = {}) {
    const [packet, hand] = await Promise.all([
      loadExecutionArtifact(manifest, 'preprocess.packet'),
      loadExecutionArtifact(manifest, hasCardRefinement(context.settings) ? REFINED_HAND_STAGE_ID : 'preprocess.hand')
    ]);
    if (!packet || !hand || !plan) return null;
    const candidate = createPreparedGenerationCandidate(
      packet,
      hand,
      context.snapshot,
      context.settings,
      context.turnIdentity
    );
    if (!candidate || !preparedGenerationIntegrityIsValid(candidate)) return null;
    commitPreparedGeneration(candidate);
    executionView = manifest;
    startRun(context.runId);
    runState.beginAttempt?.({
      runId: context.runId,
      kind: 'swipe',
      sourceRevisionHash: activeSourceRevisionHash(context.snapshot),
      turnKeyHash: context.turnIdentity?.turnKeyHash,
      generationClassification: 'same-turn-swipe',
      packetId: packet.packetId
    });
    startRuntimeActivity({
      runId: context.runId,
      label: 'Reusing Recursion prompt for swipe...',
      chips: ['Prompt', 'Swipe']
    });
    const basis = generationBasisForSnapshot(context.snapshot, context.settings);
    const reuse = await tryPreparedGenerationReuse(context.runId, {
      basis,
      settings: context.settings,
      swipe: true,
      swipeMessageId,
      turnIdentity: context.turnIdentity
    });
    return {
      ...reuse,
      execution: manifest,
      plan,
      continuePrimaryGeneration: reuse.ok === true && reuse.reused === true,
      recursionPromptInstalled: reuse.ok === true && reuse.reused === true
    };
  }

  async function startFreshDurablePreprocess(context, {
    queuedIntent = null,
    hostGeneration = false,
    nativeGenerationType = 'normal',
    diagnosticClassification = 'new-user-turn'
  } = {}) {
    const {
      chatKey,
      settings,
      turnIdentity,
      provenance,
      runId
    } = context;
    const operationId = makeId('operation');
    let manifest = createPipelineRun({
      operationId,
      chatKey,
      phase: 'preprocess',
      pipelineMode: context.effectivePipelineMode,
      createdAt: nowIso(),
      sourceIdentity: provenance.sourceIdentity,
      provenance,
      turnKeyHash: turnIdentity.turnKeyHash,
      sourceBandHash: turnIdentity.sourceBandHash,
      hostOwned: hostGeneration === true,
      nativeGenerationType
    });
    manifest.pipelineDecision = context.pipelineDecision;
    updateTurnScope(turnIdentity, {
      generationClassification: diagnosticClassification,
      operationId,
      invalidated: false
    });
    preprocessContexts.set(operationId, context);
    let graph = durableBaseGraph(context);
    preprocessGraphs.set(operationId, graph);
    startRuntimeActivity({ runId, label: 'Reading current turn...', chips: ['Pre-process'] });
    if (
      queuedIntent?.mode === 'full-fresh'
      || queuedIntent?.stageIds?.some((stageId) => (
        stageId === 'preprocess.snapshot'
        || stageId === 'preprocess.arbiter'
      ))
    ) {
      const bound = await bindDurableQueuedIntent(
        context,
        manifest,
        graph,
        queuedIntent
      );
      manifest = bound.manifest;
    }
    manifest = await startDurableGraph(context, manifest, graph);
    if (manifest.state !== 'completed') {
      return { ok: false, paused: manifest.state === 'paused', execution: manifest };
    }
    const remainingIntent = normalizeQueuedReprocess(
      await storage.loadQueuedReprocess(chatKey, 'preprocess')
    );
    if (remainingIntent) {
      const plan = await loadExecutionArtifact(manifest, 'preprocess.arbiter');
      if (!plan) throw new Error('Durable Arbiter checkpoint artifact is unavailable.');
      const bound = await bindDurableQueuedIntent(
        context,
        manifest,
        durableFullGraph(context, plan),
        remainingIntent
      );
      manifest = bound.manifest;
    }
    return advanceDurablePreprocess(context, manifest);
  }

  async function prepareForGenerationDurable({
    userMessage = '',
    hostGeneration = false,
    generationType = ''
  } = {}) {
    const settings = settingsStore.get();
    const nativeGenerationType = normalizeNativeGenerationType(generationType);
    const hostSnapshot = nativeGenerationType === 'swipe'
      ? await readSwipeSourceSnapshot()
      : await readSnapshot();
    let pendingUserMessage = normalizePendingUserMessage(userMessage);
    let explicitSwipeMessageId = null;
    let snapshot = hostSnapshot;
    if (
      nativeGenerationType !== 'swipe'
      && pendingUserMessage.text
      && !Number.isFinite(pendingUserMessage.mesid)
    ) {
      const visibleUser = latestVisibleUserMessage(hostSnapshot);
      if (
        visibleUser
        && safeText(visibleUser.text || '', PROVIDER_MESSAGE_TEXT_LIMIT) === pendingUserMessage.text
      ) {
        pendingUserMessage = normalizePendingUserMessage({
          text: pendingUserMessage.rawText,
          mesid: visibleUser.mesid
        });
      }
    }
    if (nativeGenerationType === 'swipe') {
      const swipeRetry = runState.takeLatestAssistantSwipeRetry();
      explicitSwipeMessageId = finiteNumberOrNull(swipeRetry?.messageId);
      const sourceUser = latestVisibleUserMessage(snapshot);
      pendingUserMessage = sourceUser
        ? normalizePendingUserMessage({ text: sourceUser.text, mesid: sourceUser.mesid })
        : normalizePendingUserMessage('');
    } else if (!pendingUserMessage.text && hostGeneration === true) {
      const latest = latestVisibleMessage(hostSnapshot);
      if (latest?.role === 'user') {
        pendingUserMessage = normalizePendingUserMessage({
          text: latest.text,
          mesid: latest.mesid
        });
      }
    }
    if (nativeGenerationType !== 'swipe') {
      snapshot = snapshotWithPendingUserMessage(hostSnapshot, pendingUserMessage);
    }
    const turnIdentity = await createTurnIdentity({
      snapshot: nativeGenerationType === 'swipe' ? hostSnapshot : snapshot,
      pendingUserMessage,
      generationType: nativeGenerationType,
      // The swipe source has already excluded its target exactly once.
      swipeMessageId: nativeGenerationType === 'swipe' ? null : explicitSwipeMessageId,
      retention: settings.retention,
      contracts: durableTurnContracts(settings)
    });
    lastSnapshot = snapshot;
    const chatKey = safeText(snapshot.chatKey || snapshot.chatId || DEFAULT_CHAT_ID, 180) || DEFAULT_CHAT_ID;
    activeExecutionChatKey = chatKey;
    const existingPrepare = durablePreparePromises.get(chatKey);
    if (existingPrepare) {
      if (existingPrepare.turnKeyHash === turnIdentity.turnKeyHash) {
        return existingPrepare.promise;
      }
      try {
        await existingPrepare.promise;
      } catch {
        // A distinct turn still needs its own attempt after the prior one settles.
      }
      return prepareForGenerationDurable({ userMessage, hostGeneration, generationType });
    }
    const run = (async () => {
      const storedManifest = await storage.loadPipelineRun(chatKey);
      const classification = classifyGeneration({
        nativeGenerationType,
        pendingUserMessage,
        currentTurnKeyHash: turnIdentity.turnKeyHash,
        storedTurnKeyHash: storedManifest?.turnKeyHash,
        storedOperationState: storedManifest?.state
      });
      const queuedEnvelope = await storage.loadQueuedReprocessEnvelope?.(chatKey);
      let queuedIntent = normalizeQueuedReprocess(queuedEnvelope?.preprocess);
      const shouldRevokeStored = Boolean(storedManifest) && (
        classification.kind === 'new-user-turn'
        || classification.kind === 'new-host-generation'
        || classification.kind === 'edited-band-swipe'
        || classification.kind === 'incompatible-paused-operation'
        || storedManifest.turnKeyHash !== turnIdentity.turnKeyHash
      );
      const diagnosticClassification = classification.kind === 'edited-band-swipe'
        ? 'source-band-edited'
        : classification.kind;
      const queuedIntentPresent = Boolean(queuedEnvelope?.preprocess || queuedEnvelope?.postprocess);
      const queueCancellationCode = shouldRevokeStored && queuedIntentPresent
        ? (
            classification.kind === 'edited-band-swipe'
              ? 'queued-reprocess-canceled-edited-band'
              : 'queued-reprocess-canceled-new-turn'
          )
        : '';
      updateTurnScope(turnIdentity, {
        generationClassification: diagnosticClassification,
        operationId: shouldRevokeStored ? '' : storedManifest?.operationId,
        reused: ['same-turn-swipe', 'same-turn-host-retry'].includes(classification.kind)
          && !shouldRevokeStored,
        invalidated: shouldRevokeStored,
        diagnosticCodes: queueCancellationCode ? [queueCancellationCode] : []
      });
      if (shouldRevokeStored) {
        const reason = classification.kind === 'edited-band-swipe'
          ? 'source-band-edited'
          : 'new-user-turn';
        await revokePreviousTurn({ chatKey, storedManifest, reason });
        queuedIntent = null;
      } else if (!storedManifest && classification.kind === 'new-user-turn' && queuedIntent) {
        await storage.clearQueuedReprocess(chatKey);
        queuedIntent = null;
      }
      const context = await createDurablePreprocessContext({
        snapshot,
        pendingUserMessage,
        settings,
        hostGeneration,
        generationType: nativeGenerationType,
        turnIdentity,
        generationClassification: classification.kind
      });
      let activeContext = context;
      let { runId, provenance } = activeContext;
      queuedReprocessView = queuedIntent;
      startRun(runId);
      runState.beginAttempt?.({
        runId,
        kind: nativeGenerationType === 'swipe' ? 'swipe' : 'normal',
        sourceRevisionHash: activeSourceRevisionHash(snapshot),
        turnKeyHash: turnIdentity.turnKeyHash,
        generationClassification: diagnosticClassification,
        packetId: preparedPacket()?.packetId
      });
      if (
        storedManifest
        && !shouldRevokeStored
        && storedManifest.turnKeyHash === turnIdentity.turnKeyHash
        && !['stale', 'abandoned'].includes(storedManifest.state)
      ) {
        activeContext = await restoreDurablePreprocessContext(
          storedManifest,
          snapshot,
          turnIdentity,
          classification.kind
        );
        activeContext.hostGeneration = hostGeneration;
        activeContext.generationType = safeText(generationType, 40);
        ({ runId, provenance } = activeContext);
        startRun(runId);
        const plan = await loadExecutionArtifact(
          storedManifest,
          'preprocess.arbiter'
        );
        const graph = await restoreDurablePreprocessGraph(
          storedManifest,
          activeContext
        );
        preprocessContexts.set(storedManifest.operationId, activeContext);
        preprocessGraphs.set(storedManifest.operationId, graph);
        executionView = storedManifest;
        if (classification.kind === 'compatible-paused-same-turn') {
          return continuePausedPreprocess({
            operationId: storedManifest.operationId,
            graph,
            context: activeContext,
            manifest: storedManifest
          });
        }
        if (!queuedIntent) {
          if (
            classification.kind === 'same-turn-swipe'
            && storedManifest.state === 'completed'
          ) {
            const reuse = plan && storedManifest.stageRecords?.['preprocess.install']
              ? await reuseCompletedDurableTurn({
                  context: activeContext,
                  manifest: storedManifest,
                  plan,
                  swipeMessageId: explicitSwipeMessageId
                })
              : null;
            if (reuse) return reuse;
            await revokePreviousTurn({
              chatKey,
              storedManifest,
              reason: 'prepared-generation-corrupt'
            });
            return startFreshDurablePreprocess(context, {
              queuedIntent: null,
              hostGeneration,
              nativeGenerationType,
              diagnosticClassification: 'same-turn-swipe'
            });
          } else if (
            storedManifest.state === 'completed'
            && plan
            && storedManifest.stageRecords?.['preprocess.install']
          ) {
            return finalizeDurablePreprocess(
              activeContext,
              storedManifest,
              plan
            );
          }
          return durableOperationResult(storedManifest, plan);
        }

        const queuedManifest = (
          hostGeneration === true
          && (
            storedManifest.hostOwned !== true
            || storedManifest.nativeGenerationType !== nativeGenerationType
          )
        )
          ? await storage.savePipelineRun(chatKey, {
              ...storedManifest,
              hostOwned: true,
              nativeGenerationType,
              revision: Number(storedManifest.revision || 0) + 1,
              updatedAt: nowIso()
            })
          : storedManifest;
        executionView = queuedManifest;
        let bound = await bindDurableQueuedIntent(
          activeContext,
          queuedManifest,
          graph,
          queuedIntent
        );
        if (bound.manifest.state === 'stale') {
          return durableOperationResult(bound.manifest, plan);
        }
        if (bound.manifest.queuedStageIds.length === 0) {
          if (
            bound.manifest.state === 'completed'
            && plan
            && bound.manifest.stageRecords?.['preprocess.install']
          ) {
            return finalizeDurablePreprocess(activeContext, bound.manifest, plan);
          }
          return durableOperationResult(bound.manifest, plan);
        }
        const rerunsBase = queuedIntent.mode === 'full-fresh'
          || bound.manifest.queuedStageIds.some((stageId) => (
            stageId === 'preprocess.snapshot'
            || stageId === 'preprocess.arbiter'
          ));
        const rerunGraph = rerunsBase
          ? durableBaseGraph(activeContext)
          : graph;
        let manifest = await startDurableGraph(
          activeContext,
          bound.manifest,
          rerunGraph
        );
        if (manifest.state !== 'completed') {
          return durableOperationResult(manifest, plan);
        }
        return advanceDurablePreprocess(
          activeContext,
          manifest,
          rerunsBase ? null : plan,
          { validateDownstream: rerunsBase }
        );
      }

      return startFreshDurablePreprocess(activeContext, {
        queuedIntent,
        hostGeneration,
        nativeGenerationType,
        diagnosticClassification
      });
    })().finally(() => {
      if (durablePreparePromises.get(chatKey)?.promise === run) {
        durablePreparePromises.delete(chatKey);
      }
    });
    durablePreparePromises.set(chatKey, { turnKeyHash: turnIdentity.turnKeyHash, promise: run });
    return run;
  }

  async function prepareForGeneration({ userMessage = '', refreshReason = '', hostGeneration = false, generationType = '' } = {}) {
    const timingAttemptId = hostGeneration ? makeId('timing') : '';
    if (timingAttemptId) turnTiming.start(timingAttemptId);
    const settings = settingsStore.get();
    const hostGenerationType = safeText(generationType, 40).toLowerCase();
    const explicitSwipe = hostGeneration === true && hostGenerationType === 'swipe';
    const explicitRegenerate = hostGeneration === true && hostGenerationType === 'regenerate';
    if (hostGeneration === true && activeProseEnhancementPromise) {
      await cancelActiveProseEnhancement(explicitSwipe ? 'latest-assistant-swipe' : 'new-host-generation');
    }
    if (hostGeneration === true && postProcessRuntime.postProcessRunning()) {
      postProcessRuntime.cancelPostProcess(explicitSwipe ? 'latest-assistant-swipe' : 'new-host-generation');
      await postProcessRuntime.waitForPostProcessSettlement();
    }
    setHostGenerationActive(hostGeneration);
    if (settings.enabled !== false) {
      await waitForExternalMutations();
      const runId = makeId('run');
      let preGenerationSourceIdentity = null;
      if (hostGeneration === true) {
        try {
          preGenerationSourceIdentity = await host?.messages?.postProcessSourceIdentity?.() || null;
        } catch {
          preGenerationSourceIdentity = null;
        }
        armProseEnhancementForHostGeneration(settings, runId);
        if (pendingProseEnhancement?.blockedCapability) {
          stageRuntimeActivity({
            runId,
            phase: 'editorialPreflight',
            severity: 'warning',
            outcome: 'skipped',
            label: pendingProseEnhancement.blockedCapability.message,
            chips: ['Enhancement', 'Redirect', 'Skipped'],
            detail: pendingProseEnhancement.blockedCapability
          });
        }
        if (pendingProseEnhancement?.cautionCapability) {
          stageRuntimeActivity({
            runId,
            phase: 'providerCaution',
            severity: 'warning',
            outcome: 'warning',
            label: pendingProseEnhancement.cautionCapability.message,
            chips: ['Enhancement', 'Provider untested'],
            detail: pendingProseEnhancement.cautionCapability
          });
          pendingProseEnhancement.cautionReported = true;
        }
      } else {
        postProcessRuntime.cancelPostProcess('not-host-generation');
        clearPendingProseEnhancement();
      }
      if (explicitSwipe && !runState.current().pendingLatestAssistantSwipeRetry) {
        markLatestAssistantSwipeRetry({ eventName: 'host-generation-swipe' });
      }
      let durableResult;
      try {
        durableResult = await prepareForGenerationDurable({
          userMessage: explicitSwipe ? '' : userMessage,
          hostGeneration,
          generationType
        });
      } catch (error) {
        const failure = failureFromError(error, { stage: 'started', category: 'internal' });
        settleRuntimeActivity({
          runId,
          phase: 'settled',
          logicalStage: 'started',
          severity: 'error',
          label: 'Recursion failed before generation.',
          detail: { failure }
        });
        const safeError = new Error(failure.message);
        safeError.code = failure.code;
        throw safeError;
      }
      const preprocessTurnKeyHash = safeText(
        durableResult?.execution?.turnKeyHash || lastTurnScope?.turnKeyHash || '',
        180
      );
      if (
        hostGeneration === true
        && durableResult?.ok === true
        && durableResult?.continuePrimaryGeneration === true
        && preprocessTurnKeyHash
      ) {
        postProcessRuntime.preparePostProcessTrigger({
          preprocessTurnKeyHash,
          preGenerationSourceIdentity,
          generationType: hostGenerationType || 'normal'
        });
      } else if (hostGeneration === true) {
        postProcessRuntime.cancelPostProcess('preprocess-not-ready');
      }
      if (timingAttemptId && durableResult?.continuePrimaryGeneration !== false && durableResult?.ok === true) {
        turnTiming.mark(timingAttemptId, 'prepared', {
          operationId: durableResult.execution?.operationId || executionView?.operationId,
          chatKey: durableResult.execution?.chatKey || executionView?.chatKey,
          turnKeyHash: preprocessTurnKeyHash
        });
        recordTurnTiming('prepared');
      }
      return durableResult;
    }
    if (settings.enabled === false) {
      postProcessRuntime.cancelPostProcess('recursion-disabled');
      clearPendingProseEnhancement();
      clearPendingLatestAssistantSwipeRetry();
      clearPendingFreshNextGeneration();
      await waitForExternalMutations();
      supersedeActiveRun();
      const clearRunId = makeId('run');
      startRuntimeActivity({
        runId: clearRunId,
        phase: 'promptClearing',
        label: 'Clearing Recursion prompt...',
        chips: ['Prompt']
      });
      const clear = await runPromptMutationSection(null, async () => {
        const result = await clearPromptBestEffort(host);
        await appendPromptClearedJournal(clearRunId, promptClearContext(), result, 'disabled');
        return result;
      });
      clearLastBrief({ status: 'empty', reason: 'disabled', runId: clearRunId });
      if (clear?.ok === false) reportClearWarning(clearRunId, clear);
      else safeActivity(activity, 'clear');
      return { ok: true, skipped: true, reason: 'disabled', clear, continuePrimaryGeneration: true };
    }

  }

  async function appendProviderCapabilityMutation({
    lane,
    kind,
    changedKeys = [],
    before,
    after,
    stale = false
  } = {}) {
    const context = promptClearContext();
    if (!context?.chatKey) return null;
    const runId = makeId('provider-capability');
    const safeBefore = sanitizeProviderCapability(before);
    const safeAfter = sanitizeProviderCapability(after);
    return appendJournalSafe(runId, context.chatKey, {
      event: 'provider.capability.changed',
      severity: stale ? 'info' : (safeAfter.state === 'unhealthy' ? 'warn' : 'info'),
      summary: stale
        ? `${providerLane(lane) === 'reasoner' ? 'Reasoner' : 'Utility'} provider health result ignored after configuration changed.`
        : `${providerLane(lane) === 'reasoner' ? 'Reasoner' : 'Utility'} provider capability ${safeBefore.state} to ${safeAfter.state}.`,
      runId,
      sceneKey: context.sceneKey,
      details: {
        lane: providerLane(lane),
        kind: safeText(kind, 40),
        changedKeys: safeStringList(changedKeys, 80),
        beforeState: safeBefore.state,
        afterState: safeAfter.state,
        configRevision: safeAfter.configRevision,
        configHash: safeAfter.configHash,
        stale
      }
    });
  }

  async function recommendCardDraft(draft = {}) {
    const source = asObject(draft);
    const fallback = {
      name: safeText(source.name || 'Scene Rule', 80),
      description: safeText(source.description || 'Focused Recursion rule for the current scene.', 200),
      promptText: safeText(source.promptText || source.description || source.name || 'Keep the current scene coherent.', 1200)
    };
    if (!generationRouter || typeof generationRouter.generate !== 'function') {
      return { ok: true, suggestion: fallback, diagnostics: ['card-authoring-local-fallback'] };
    }
    const settings = settingsStore.get();
    const runId = makeId('card-author');
    const prompt = [
      'Return strict JSON for a Recursion card authoring suggestion.',
      'Schema: {"schema":"recursion.cardAuthoringAssist.v1","name":"short specific card name","description":"hover description","promptText":"high-value Recursion card prompt"}',
      'Improve the user intent as a compact scene-continuity, pressure, constraint, or guidance card.',
      'Do not move content to Author Note or presets. Do not write generic prose style advice.',
      'Make the card useful only when it can affect the next response.',
      `Draft: ${JSON.stringify({
        name: fallback.name,
        description: fallback.description,
        promptText: fallback.promptText
      })}`
    ].join('\n\n');
    try {
      const result = await generationRouter.generate('cardAuthoringAssist', {
        lane: 'utility',
        runId,
        ...reasonerRequestMetadata(settings, 'card-authoring-assist', 'utility'),
        prompt,
        responseLength: 900
      }, { runId, isCurrent: () => true });
      const data = asObject(result?.data);
      const suggestion = {
        name: safeText(data.name || fallback.name, 80),
        description: safeText(data.description || fallback.description, 240),
        promptText: safeText(data.promptText || data.prompt || fallback.promptText, 1400)
      };
      return {
        ok: result?.ok !== false,
        suggestion,
        diagnostics: result?.ok === false
          ? ['card-authoring-provider-fallback', ...(Array.isArray(result?.diagnostics) ? result.diagnostics.map((entry) => safeText(entry, 160)).slice(0, 8) : [])]
          : []
      };
    } catch (error) {
      return {
        ok: false,
        suggestion: fallback,
        diagnostics: ['card-authoring-error-fallback', safeText(error?.message || error, 240)]
      };
    }
  }

  async function evaluateRedirectEffectiveness(input = {}) {
    if (!generationRouter || typeof generationRouter.generate !== 'function') {
      return {
        ok: false,
        error: { code: 'RECURSION_REDIRECT_EFFECTIVENESS_UNAVAILABLE', message: 'Redirect effectiveness judge is unavailable.' },
        diagnostics: {}
      };
    }
    const settings = settingsStore.get();
    const lane = runtimeProviderCapability(settings, 'reasoner', 'prompt-packet').eligible ? 'reasoner' : 'utility';
    const request = buildRedirectEffectivenessRequest({
      ...asObject(input),
      lane,
      ...reasonerRequestMetadata(settings, 'editorial-effectiveness', lane)
    });
    const runId = safeText(input?.runId || makeId('redirect-eval'), 180);
    try {
      const response = await generationRouter.generate('editorialEffectivenessJudge', request, {
        runId
      });
      const diagnostics = {
        providerId: safeText(response?.diagnostics?.providerId || response?.providerId || '', 160),
        model: safeText(response?.diagnostics?.model || response?.model || '', 160)
      };
      if (response?.ok !== true) {
        return {
          ok: false,
          error: response?.error || { code: 'RECURSION_REDIRECT_EFFECTIVENESS_FAILED', message: 'Redirect effectiveness judge failed.' },
          diagnostics
        };
      }
      return {
        ...validateRedirectEffectiveness(response.data, request),
        diagnostics
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: safeText(error?.code || 'RECURSION_REDIRECT_EFFECTIVENESS_FAILED', 120),
          message: safeText(error?.message || error || 'Redirect effectiveness judge failed.', 300)
        },
        diagnostics: {}
      };
    }
  }

  function providerOperationState() {
    return {
      operations: Object.fromEntries(
        [...activeProviderOperations.entries()].map(([lane, count]) => [lane, count])
      ),
      tests: [...activeProviderTests.keys()]
    };
  }

  function providerCapabilityView(lane = 'utility', operation = 'prompt-packet') {
    return sanitizeProviderCapability(runtimeProviderCapability(
      settingsStore.get(),
      providerLane(lane),
      operation
    ));
  }

  async function restoreExecutionState() {
    try {
      await storage.pruneRetiredGeneratedRecords?.();
    } catch {
      // Retired-record cleanup is best effort and must not block host startup.
    }
    const snapshot = await readSnapshot();
    lastSnapshot = snapshot;
    const chatKey = safeText(snapshot.chatKey || snapshot.chatId || DEFAULT_CHAT_ID, 180) || DEFAULT_CHAT_ID;
    activeExecutionChatKey = chatKey;
    let manifest = await storage.loadPipelineRun(chatKey);
    queuedReprocessView = await storage.loadQueuedReprocess(chatKey, manifest?.phase || 'preprocess');
    if (!manifest) {
      executionView = null;
      return null;
    }
    if (manifest.state === 'running') {
      const interruptedStageIds = Object.entries(manifest.stageRecords || {})
        .filter(([, record]) => record?.state === 'running')
        .map(([stageId]) => stageId);
      const stageRecords = Object.fromEntries(
        Object.entries(manifest.stageRecords || {}).map(([stageId, record]) => [
          stageId,
          record?.state === 'running'
            ? {
                ...record,
                state: 'pending',
                checkpoint: null,
                summary: null,
                failure: null,
                executionToken: null,
                updatedAt: nowIso()
              }
            : record
        ])
      );
      manifest = await storage.savePipelineRun(chatKey, {
        ...manifest,
        revision: Number(manifest.revision || 0) + 1,
        state: 'paused',
        pauseReason: 'restored-after-reload',
        recoveryBudget: manifest.recoveryBudget
          ? settleOperationClock(manifest.recoveryBudget, false,
              Number.isFinite(Date.parse(manifest.updatedAt)) ? Date.parse(manifest.updatedAt) : manifest.recoveryBudget.activeSince)
          : null,
        frontierStageIds: interruptedStageIds,
        stageRecords,
        updatedAt: nowIso()
      });
    }
    if (manifest.phase === 'postprocess') {
      const restored = await postProcessRuntime.restoreExecutionState(manifest);
      const status = restored
        ? compareRunProvenance(restored.provenance, manifest.provenance)
        : { reusable: false, changedFields: ['executionContext'] };
      const sourceCurrent = manifest.state === 'completed'
        ? true
        : (restored
            ? await postProcessSourceStillCurrent(
                restored.operation.snapshot,
                restored.operation
              )
            : false);
      if (
        (!status.reusable || !sourceCurrent)
        && manifest.state !== 'stale'
        && manifest.state !== 'abandoned'
      ) {
        manifest = await storage.savePipelineRun(chatKey, {
          ...manifest,
          revision: Number(manifest.revision || 0) + 1,
          state: 'stale',
          pauseReason: 'provenance-changed',
          staleChangedFields: [
            ...new Set([
              ...(status.changedFields || []),
              ...(!sourceCurrent ? ['sourceIdentity'] : [])
            ])
          ],
          frontierStageIds: [],
          updatedAt: nowIso()
        });
      }
      executionView = manifest;
      return redact(manifest);
    }
    const restoreSettings = settingsStore.get();
    const restoreUser = latestVisibleUserMessage(snapshot);
    const restoreAssistant = latestVisibleAssistantEntry(snapshot);
    const restoreSwipeMessageId = (
      restoreAssistant
      && numberOr(restoreAssistant.message?.mesid, -1) > numberOr(restoreUser?.mesid, -1)
    )
      ? finiteNumberOrNull(restoreAssistant.message?.mesid)
      : null;
    const restoreTurnIdentity = await createTurnIdentity({
      snapshot,
      pendingUserMessage: restoreUser
        ? { text: restoreUser.text, mesid: restoreUser.mesid }
        : null,
      generationType: restoreSwipeMessageId === null ? 'normal' : 'swipe',
      swipeMessageId: restoreSwipeMessageId,
      retention: restoreSettings.retention,
      contracts: durableTurnContracts(restoreSettings)
    });
    updateTurnScope(restoreTurnIdentity, {
      generationClassification: restoreSwipeMessageId === null
        ? 'compatible-paused-same-turn'
        : 'same-turn-swipe',
      operationId: manifest.operationId
    });
    const restoreSourceSnapshot = restoreSwipeMessageId === null
      ? snapshot
      : (snapshotWithoutLatestAssistant(snapshot, restoreAssistant) || snapshot);
    const observedProvenance = executionProvenance(
      restoreSourceSnapshot,
      restoreSettings,
      restoreTurnIdentity
    );
    const provenance = manifest.turnKeyHash === restoreTurnIdentity.turnKeyHash
      ? {
          ...observedProvenance,
          sourceIdentity: manifest.provenance?.sourceIdentity || observedProvenance.sourceIdentity
        }
      : observedProvenance;
    const status = compareRunProvenance(provenance, manifest.provenance);
    if (!status.reusable && manifest.state !== 'stale' && manifest.state !== 'abandoned') {
      manifest = await storage.savePipelineRun(chatKey, {
        ...manifest,
        revision: Number(manifest.revision || 0) + 1,
        state: 'stale',
        pauseReason: 'provenance-changed',
        staleChangedFields: status.changedFields,
        frontierStageIds: [],
        updatedAt: nowIso()
      });
    }
    executionView = manifest;
    if (status.reusable && manifest.state !== 'stale' && manifest.state !== 'abandoned') {
      const context = await restoreDurablePreprocessContext(
        manifest,
        snapshot,
        restoreTurnIdentity,
        manifest.state === 'paused' ? 'compatible-paused-same-turn' : 'same-turn-swipe'
      );
      const graph = await restoreDurablePreprocessGraph(manifest, context);
      if (manifest.state === 'paused' && safeStringList(manifest.frontierStageIds, 180).length === 0) {
        const runnablePendingStageIds = Object.values(asObject(manifest.stageRecords))
          .filter((record) => {
            if (record?.state !== 'pending') return false;
            const stage = graph.getStage?.(record.stageId);
            return stage?.executable !== false
              && safeStringList(stage?.dependencies, 180).every((dependencyId) => (
                ['completed', 'cached'].includes(manifest.stageRecords?.[dependencyId]?.state)
              ));
          })
          .map((record) => record.stageId);
        if (runnablePendingStageIds.length) {
          manifest = await storage.savePipelineRun(chatKey, {
            ...manifest,
            revision: Number(manifest.revision || 0) + 1,
            frontierStageIds: runnablePendingStageIds,
            updatedAt: nowIso()
          });
          executionView = manifest;
        }
      }
      preprocessContexts.set(manifest.operationId, context);
      preprocessGraphs.set(manifest.operationId, graph);
    } else {
      preprocessContexts.delete(manifest.operationId);
      preprocessGraphs.delete(manifest.operationId);
    }
    return redact(manifest);
  }

  function executionStageDisplayName(stageId) {
    const id = safeText(stageId || '', 180);
    const canonical = {
      'preprocess.snapshot': 'Reading current turn',
      'preprocess.arbiter': 'Planning card pass',
      'preprocess.cards.fused': 'Fused card bundle',
      'preprocess.deck': 'Updating scene deck',
      'preprocess.hand': 'Selecting turn hand',
      'preprocess.refinement.prepare': 'Preparing card applications',
      'preprocess.refinement.review': 'Reviewing cards',
      'preprocess.refinement.revise': 'Revising cards',
      'preprocess.refinement.verify': 'Checking revisions',
      'preprocess.refinement.hand': 'Refined hand',
      'preprocess.guidance': 'Guidance',
      'preprocess.packet': 'Composing prompt packet',
      'preprocess.install': 'Installing Recursion prompt',
      'postprocess.source-snapshot': 'Reading generated response',
      'postprocess.host-commit': 'Adding Post-process result'
    }[id];
    if (canonical) return canonical;
    const suffix = id.split('.').at(-1) || 'step';
    return suffix
      .split(/[-_]+/)
      .filter(Boolean)
      .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
      .join(' ') || 'Step';
  }

  function resumeStageIdForExecution(manifest) {
    const frontier = safeStringList(manifest?.frontierStageIds, 180);
    if (frontier.length) return frontier[0];
    const failedId = safeText(manifest?.pauseReason || '', 180).replace(/^stage-failed:/, '');
    if (failedId && failedId !== manifest?.pauseReason) return failedId;
    return Object.values(asObject(manifest?.stageRecords))
      .find((record) => record?.state === 'pending')
      ?.stageId || '';
  }

  async function pauseOperation({ reason = 'user' } = {}) {
    const operationId = safeText(executionView?.operationId || '', 180);
    if (!operationId) return null;
    if (executionView?.state !== 'running') return redact(executionView);
    const paused = await executionScheduler.pause({ operationId, reason });
    if (paused) executionView = paused;
    if (paused) {
      settleRuntimeActivity({
        runId: operationId,
        outcome: 'warning',
        phase: 'settled',
        severity: 'warning',
        label: 'Operation paused. Completed work was saved.',
        chips: ['Paused']
      });
    }
    return paused ? redact(paused) : null;
  }

  async function continuePausedPreprocess({ operationId, graph, context, manifest } = {}) {
    const id = safeText(operationId || manifest?.operationId || '', 180);
    if (!id || !graph || !context) {
      throw new Error('Pre-process operation context is unavailable for Resume.');
    }
    const resumeStageId = resumeStageIdForExecution(executionView);
    if (resumeStageId) {
      startRuntimeActivity({
        runId: id,
        phase: 'activity',
        severity: 'info',
        label: `Resuming from ${executionStageDisplayName(resumeStageId)}.`,
        chips: ['Resume']
      });
    }
    const result = await executionScheduler.resume({
      operationId: id,
      graph,
      context,
      provenance: context.provenance
    });
    if (result?.state) executionView = result;
    if (result?.state !== 'completed') return result;
    return advanceDurablePreprocess(context, result);
  }

  async function resumeOperation({ operationId = executionView?.operationId } = {}) {
    const id = safeText(operationId || '', 180);
    if (stopGenerationPromise) await stopGenerationPromise;
    if (executionView?.phase === 'postprocess') {
      const result = await postProcessRuntime.resumeOperation({ operationId: id });
      if (result?.execution) executionView = result.execution;
      return result;
    }
    const manifest = activeExecutionChatKey
      ? await storage.loadPipelineRun(activeExecutionChatKey)
      : null;
    if (
      !id
      || !manifest
      || manifest.operationId !== id
      || manifest.state !== 'paused'
      || manifest.hostOwned !== true
      || !manifest.turnKeyHash
      || !['normal', 'swipe', 'regenerate'].includes(manifest.nativeGenerationType)
    ) {
      return { ok: false, started: false, reason: 'host-owned-resume-unavailable' };
    }
    const started = await requestHostGenerationStart({
      type: manifest.nativeGenerationType,
      source: 'recursion-ui',
      reason: 'resume-operation'
    });
    if (started?.ok !== true || started?.started !== true) {
      updateTurnScope(lastTurnScope, {
        generationClassification: lastTurnScope?.generationClassification || 'compatible-paused-same-turn',
        operationId: id,
        diagnosticCodes: ['host-resume-start-failed']
      });
      settleRuntimeActivity({
        runId: id,
        outcome: 'warning',
        phase: 'settled',
        severity: 'warning',
        label: 'Resume could not start SillyTavern generation.',
        chips: ['Resume'],
        detail: {
          diagnosticCodes: ['host-resume-start-failed'],
          errorCode: safeText(started?.error?.code || 'RECURSION_HOST_GENERATION_FAILED', 120)
        }
      });
      return started;
    }
    settleRuntimeActivity({
      runId: id,
      outcome: 'success',
      phase: 'settled',
      severity: 'success',
      label: 'Resume requested from SillyTavern.',
      chips: ['Resume']
    });
    return { ...started, operationId: id };
  }

  async function retryStage({
    operationId = executionView?.operationId,
    stageId
  } = {}) {
    const id = safeText(operationId || '', 180);
    if (executionView?.phase === 'postprocess') {
      const result = await postProcessRuntime.retryStage({
        operationId: id,
        stageId
      });
      if (result?.execution) executionView = result.execution;
      return result;
    }
    const graph = preprocessGraphs.get(id);
    const context = preprocessContexts.get(id);
    if (!id || !graph || !context) {
      throw new Error('Pre-process operation context is unavailable for Retry.');
    }
    const result = await executionScheduler.retry({
      operationId: id,
      stageId,
      graph,
      context,
      provenance: context.provenance
    });
    if (result?.state) executionView = result;
    if (result?.state !== 'completed') return result;
    const advanced = await advanceDurablePreprocess(context, result);
    if (
      advanced?.ok !== true
      || advanced.continuePrimaryGeneration !== true
      || result.hostOwned !== true
      || !['normal', 'swipe', 'regenerate'].includes(result.nativeGenerationType)
    ) {
      return advanced;
    }
    const started = await requestHostGenerationStart({
      type: result.nativeGenerationType,
      source: 'recursion-ui',
      reason: 'retry-stage'
    });
    if (started?.ok !== true || started?.started !== true) {
      updateTurnScope(lastTurnScope, {
        generationClassification: lastTurnScope?.generationClassification || 'compatible-paused-same-turn',
        operationId: id,
        diagnosticCodes: ['host-retry-start-failed']
      });
      settleRuntimeActivity({
        runId: id,
        outcome: 'warning',
        phase: 'settled',
        severity: 'warning',
        label: 'Retry completed, but SillyTavern generation could not start.',
        chips: ['Retry'],
        detail: {
          diagnosticCodes: ['host-retry-start-failed'],
          errorCode: safeText(started?.error?.code || 'RECURSION_HOST_GENERATION_FAILED', 120)
        }
      });
    }
    return { ...advanced, hostGeneration: started };
  }

  async function queueStageReprocess({ operationId: requestedOperationId, stageId } = {}) {
    const id = safeText(stageId || '', 180);
    const operationId = safeText(executionView?.operationId || '', 180);
    const requestedId = safeText(requestedOperationId || '', 180);
    const graph = preprocessGraphs.get(operationId)
      || postProcessRuntime.executionGraph?.(operationId)
      || null;
    const turnKeyHash = safeText(executionView?.turnKeyHash || lastTurnScope?.turnKeyHash || '', 180);
    if (
      !id
      || !graph
      || executionView?.state !== 'completed'
      || (requestedId && requestedId !== operationId)
      || !turnKeyHash
      || !graph.hasStage(id)
      || !graph.getStage(id).executable
    ) {
      return {
        ok: false,
        notice: {
          code: 'stage-reprocess-inapplicable',
          stageIds: id ? [id] : []
        }
      };
    }
    const phase = id.startsWith('postprocess.') ? 'postprocess' : 'preprocess';
    const current = normalizeQueuedReprocess(
      await storage.loadQueuedReprocess(activeExecutionChatKey, phase)
    );
    const merged = mergeQueuedReprocess(current, {
      schema: QUEUED_REPROCESS_SCHEMA,
      chatKey: activeExecutionChatKey,
      phase,
      turnKeyHash,
      queuedAt: current?.queuedAt || nowIso(),
      mode: 'stage',
      stageIds: [id]
    }, graph);
    const intent = merged;
    if (intent) await storage.saveQueuedReprocess(activeExecutionChatKey, intent);
    queuedReprocessView = intent;
    settleRuntimeActivity({
      runId: operationId || makeId('stage-reprocess-queued'),
      outcome: 'success',
      phase: 'settled',
      severity: 'success',
      label: `${executionStageDisplayName(id)} queued for reprocessing.`,
      chips: ['Queued']
    });
    return { ok: true, queuedReprocess: redact(intent) };
  }

  async function cancelQueuedStageReprocess({ stageId } = {}) {
    const id = safeText(stageId || '', 180);
    const phase = id.startsWith('postprocess.') ? 'postprocess' : 'preprocess';
    const current = normalizeQueuedReprocess(
      await storage.loadQueuedReprocess(activeExecutionChatKey, phase)
    );
    if (!current || current.mode !== 'stage') {
      queuedReprocessView = current;
      return { ok: true, queuedReprocess: current };
    }
    const stageIds = current.stageIds.filter((stageIdValue) => stageIdValue !== id);
    const next = stageIds.length ? { ...current, stageIds } : null;
    if (next) await storage.saveQueuedReprocess(activeExecutionChatKey, next);
    else await storage.clearQueuedReprocess(activeExecutionChatKey, phase);
    queuedReprocessView = next;
    settleRuntimeActivity({
      runId: safeText(executionView?.operationId || makeId('queued-reprocess-canceled'), 180),
      outcome: 'success',
      phase: 'settled',
      severity: 'success',
      label: 'Queued reprocessing canceled.',
      chips: ['Queued']
    });
    return { ok: true, queuedReprocess: next };
  }

  async function runPostProcessForLatestAssistant(details = {}) {
    const rawResult = await postProcessRuntime.runPostProcessForLatestAssistant(details);
    const result = rawResult?.canceled === true && !rawResult.reason
      ? { ...rawResult, reason: 'canceled' }
      : rawResult;
    if (result?.execution) {
      executionView = result.execution;
      activeExecutionChatKey = safeText(result.execution.chatKey || activeExecutionChatKey, 180);
      queuedReprocessView = await storage.loadQueuedReprocess(
        activeExecutionChatKey,
        'postprocess'
      );
    }
    return result;
  }

  return {
    storage,
    prepareForGeneration,
    restoreExecutionState,
    pauseOperation,
    resumeOperation,
    retryStage,
    queueStageReprocess,
    cancelQueuedStageReprocess,
    queueFullFreshSwipe,
    clearQueuedFullFreshSwipe,
    async dispose() {
      await pauseOperation({ reason: 'runtime-disposed' });
      supersedeActiveRun();
      postProcessRuntime.cancelPostProcess('runtime-disposed');
      clearPendingFreshNextGeneration();
      await waitForExternalMutations();
      clearPreparedGeneration();
    },
    async refreshScene() {
      return prepareForGeneration({ refreshReason: 'user-refresh' });
    },
    handleChatChanged,
    handleSourceChanged,
    handleLatestAssistantSwipeRetry: markLatestAssistantSwipeRetry,
    handleHostGenerationStopped,
    handleHostGenerationEnded,
    handleHostGenerationMilestone,
    handleHostVisibleToken,
    postProcessPending: postProcessRuntime.postProcessPending,
    postProcessRunning: postProcessRuntime.postProcessRunning,
    preparePostProcessTrigger: postProcessRuntime.preparePostProcessTrigger,
    runPostProcessForLatestAssistant,
    cancelPostProcess: postProcessRuntime.cancelPostProcess,
    waitForPostProcessSettlement: postProcessRuntime.waitForPostProcessSettlement,
    postProcessFinalTargetReady: postProcessRuntime.postProcessFinalTargetReady,
    postProcessHostRunReady: postProcessRuntime.postProcessHostRunReady,
    postProcessDiagnostics: postProcessRuntime.postProcessDiagnostics,
    enhanceLatestAssistantMessage,
    proseEnhancementPending,
    proseEnhancementRunning,
    holdPendingProseEnhancementMessage,
    recoverHeldProseEnhancementMessages,
    stopGeneration,
    updateSettings,
    resetSettingsMenu,
    updateProviderConfig,
    testProvider,
    providerOperationState,
    providerCapability: providerCapabilityView,
    evaluateRedirectEffectiveness,
    recommendCardDraft,
    listProviderConnectionProfiles: listProviderConnectionProfilesForUi,
    resetTurnCache,
    clearRunJournal,
    exportDiagnostics,
    view() {
      return safeRuntimeView();
    },
    getView: safeRuntimeView
  };
}
