import { createActivityReporter } from './activity.mjs';
import {
  CARD_CATALOG,
  applyCardPlan,
  buildCardRequests,
  limitCardJobsForHandBudget,
  normalizeCard,
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
  deckPriorityCardIds,
  deckPriorityFamilies,
  getActiveCardDeck,
  normalizeCardDeckSettings
} from './card-decks.mjs';
import { compact, hashJson, makeId, nowIso, redact, truncate } from './core.mjs';
import { boundEnhancementMessages, buildContextContract, contextMessageIdentity } from './context-contract.mjs';
import { enhancementContextFromSnapshot } from './enhancement-context.mjs';
import { ENHANCEMENT_EDIT_RATIO_MINIMUM, roundedEnhancementEditRatio } from './enhancement-metrics.mjs';
import { composeGuidanceForCards, composePromptPacket, GUIDANCE_SCHEMA as PROMPT_GUIDANCE_SCHEMA, PROMPT_PACKET_VERSION } from './prompt.mjs';
import { PROVIDER_CONTRACT_HASH, fetchOpenAICompatibleModels } from './providers.mjs';
import {
  providerConfigHash,
  resolveProviderCapability,
  sanitizeProviderCapability
} from './provider-capability.mjs';
import {
  RAPID_PIPELINE_VERSION,
  rapidArtifactHash,
  rapidWarmArtifactIsUsable
} from './rapid-pipeline.mjs';
import {
  RAPID_WARM_JOIN_WAIT_MS,
  rapidWarmMissReason,
  rapidWarmMissSnapshot,
  rapidWarmReasonLabel,
  rapidWarmStatusView
} from './rapid-warm-state.mjs';
import { reasoningRequestMetadata } from './reasoning-policy.mjs';
import { createSettingsStore, normalizeCardBudgetSettings, normalizeInjectionSettings, normalizeSettings } from './settings.mjs';
import { behaviorPolicyPromptLines, influencePolicyForSettings, runPolicyForEffectivePlan } from './settings-policy.mjs';
import { STORY_FORM_SCHEMA, UNKNOWN_STORY_FORM, arbiterStoryFormContractLine, forcedStoryForm, normalizeStoryForm, normalizeStoryFormWithHeuristic } from './story-form.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from './storage.mjs';
import { normalizeRetentionSettings } from './retention-policy.mjs';
import { asObject } from './safe-values.mjs';
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
  editorialPassKey,
  editorialVerificationRequired,
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
  installSummary,
  sanitizePromptError
} from './runtime/prompt-install.mjs';
import { runFusedCardPipeline } from './runtime/pipelines/fused.mjs';
import { runRapidForegroundPipeline, warmRapidPipeline } from './runtime/pipelines/rapid.mjs';
import { runStandardCardPipeline } from './runtime/pipelines/standard.mjs';
import {
  PREPARED_GENERATION_VERSION,
  compareGenerationBasis,
  createPreparedGenerationArtifact,
  preparedGenerationIntegrityIsValid,
  validatePreparedGenerationArtifact
} from './runtime/prepared-generation.mjs';
import { createRuntimeRunState } from './runtime/run-state.mjs';

const UTILITY_ARBITER_SCHEMA = 'recursion.utilityArbiter.v1';
const PROVIDER_TEST_SCHEMA = 'recursion.providerTest.v1';
const PROVIDER_TEST_TIMEOUT_MS = 30000;
const GENERATION_REVIEW_TIMEOUT_MS = 120000;
const GENERATION_REVIEW_BARRIER_TIMEOUT_MS = GENERATION_REVIEW_TIMEOUT_MS + 5000;
const STORAGE_SCHEMA_VERSION = 1;
const RUNTIME_CACHE_CONTRACT_VERSION = 1;
const DEFAULT_CHAT_ID = 'chat';
const DEFAULT_SCENE_KEY = 'scene';
const INSTALL_FAILURE_LABEL = 'Prompt install failed. Generation will continue without Recursion.';
const CLEAR_FAILURE_LABEL = 'Prompt clear failed. Recursion skipped without clearing host prompt.';
const STALE_INSTALL_LABEL = 'Recursion skipped: host turn changed before prompt install.';
const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/ig;
const SNAPSHOT_MESSAGE_TEXT_LIMIT = 1200;
const PROVIDER_MESSAGE_TEXT_LIMIT = 900;
const PLAN_ACTIONS = new Set(['skip', 'reuse-cache', 'refresh-cards', 'compose-brief']);
const REASONER_DECISION_MODES = new Set(['use', 'skip']);
const PROMPT_FOOTPRINTS = new Set(['compact', 'normal', 'rich']);
const SCENE_STATUSES = new Set(['same-scene', 'soft-shift', 'hard-shift', 'unknown']);
const PROMPT_NEUTRAL_SETTING_KEYS = new Set(['reasoningLevel', 'reasonerUse', 'enhancements']);
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
  const openAICompatible = asObject(source.openAICompatible);
  return {
    source: String(source.source || ''),
    hostConnectionProfileId: String(source.hostConnectionProfileId || ''),
    openAICompatible: {
      baseUrl: String(openAICompatible.baseUrl || ''),
      model: String(openAICompatible.model || ''),
      sessionApiKeyPresent: openAICompatible.sessionApiKeyPresent === true
    },
    temperature: numberOr(source.temperature, 0),
    topP: numberOr(source.topP, 0),
    maxTokens: numberOr(source.maxTokens, 0),
    configRevision: numberOr(source.configRevision, 0)
  };
}

function settingsWithRuntimeCardScope(settings = {}, options = {}) {
  const source = options.normalize === true ? normalizeSettings(settings) : asObject(settings);
  const cardDecks = normalizeCardDeckSettings(source.cardDecks);
  const normalized = {
    ...source,
    cardDecks
  };
  return {
    ...normalized,
    cardScope: source.cardDecks ? activeCardDeckRuntimeScope(normalized) : normalizeCardScope(source.cardScope),
    cardEligibility: source.cardDecks ? activeCardDeckEligibility(normalized) : null
  };
}

function runtimeScopePayload(settings = {}) {
  return scopePayloadForArbiter(settingsWithRuntimeCardScope(settings));
}

function usesCardDeckEligibility(settings = {}) {
  return Boolean(settings?.cardDecks)
    && (settings.mode !== 'manual' || Object.keys(settings.cardDecks.customCardDecks || {}).length > 0);
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

function rapidWarmSettingsSignature(settings = {}) {
  const normalized = settingsWithRuntimeCardScope(settings, { normalize: true });
  return {
    enabled: normalized.enabled,
    mode: normalized.mode,
    pipelineMode: normalized.pipelineMode,
    cardScope: normalized.cardScope,
    strength: normalized.strength,
    minCards: normalized.minCards,
    maxCards: normalized.maxCards,
    reasoningLevel: normalized.reasoningLevel,
    promptFootprint: normalized.promptFootprint,
    focus: normalized.focus,
    storyFormOverride: normalized.storyFormOverride,
    utilityProvider: cacheProviderSettingsSignature(normalized.providers?.utility)
  };
}

function cardEligibilitySignature(settings = {}) {
  const eligibility = activeCardDeckEligibility(settings);
  return hashJson({
    activeDeckId: eligibility.activeDeckId,
    activeCardIds: [...eligibility.activeCardIds].sort(),
    priorityCardIds: [...eligibility.priorityCardIds].sort(),
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
      guidanceSchema: PROMPT_GUIDANCE_SCHEMA,
      storyFormSchema: STORY_FORM_SCHEMA
    }),
    providerContractHash: PROVIDER_CONTRACT_HASH,
    cardEligibilityHash: cardEligibilitySignature(settings),
    settingsHash: hashJson(cacheSettingsSignature(settings))
  };
}

export function rapidWarmContractVersions(settings = {}) {
  const base = cacheContractVersions(settings);
  return {
    providerContractHash: base.providerContractHash,
    cardCatalogHash: base.cardCatalogHash,
    promptContractHash: base.promptContractHash,
    settingsHash: hashJson(rapidWarmSettingsSignature(settings))
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
  if (routedRequest.lane !== 'reasoner') return routedRequest;
  return {
    ...routedRequest,
    ...reasoningRequestMetadata(settings, 'card')
  };
}

function fusedCardBundleLaneForSettings(settings, capabilityResolver = providerCapability) {
  const policy = reasoningPolicyForSettings(settings);
  if (
    (policy.level === 'high' || policy.level === 'ultra')
    && capabilityResolver(settings, 'reasoner', 'prompt-packet').eligible
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
  if (routedRequest.lane !== 'reasoner') return routedRequest;
  return {
    ...routedRequest,
    ...reasoningRequestMetadata(settings, 'card')
  };
}

function reasonerRequestMetadata(settings, category, lane) {
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
    if (family) output.family = family;
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
    storyForm: normalizeStoryForm(data.storyForm, fallbackPlan.storyForm),
    lifecycle: normalizePlanLifecycle(data.lifecycle ?? data.cardLifecycle ?? data.cardDecisions),
    reasonerDecision: normalizeReasonerDecision(fallbackPlan.reasonerDecision, data.reasonerDecision),
    budgets,
    diagnostics: mergeDiagnostics(fallbackPlan.diagnostics, data.diagnostics),
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

function sceneCacheLatestHand(hand, packet = null) {
  const selectedCards = Array.isArray(hand?.cards) ? hand.cards : [];
  const omittedCards = Array.isArray(hand?.omitted) ? hand.omitted : [];
  return {
    handId: safeIdentifier(hand?.handId || '', 'hand', 160),
    composedAt: timestampOrNow(hand?.composedAt),
    cardIds: selectedCards
      .map((card) => safeIdentifier(card?.id || card?.cardId || '', 'card', 160))
      .filter(Boolean)
      .slice(0, 32),
    omitted: omittedCards
      .map((entry) => {
        const cardId = safeIdentifier(entry?.cardId || entry?.id || '', 'card', 160);
        const reason = safeText(entry?.reason || '', 160);
        return cardId && reason ? { cardId, reason } : null;
      })
      .filter(Boolean)
      .slice(0, 32),
    promptPacketHash: packet ? hashJson(packet) : safeIdentifier(hand?.promptPacketHash || '', '', 160)
  };
}

function activeSourceRevisionHash(snapshot) {
  return safeText(snapshot?.sourceRevisionHash || sourceWindowFingerprint(snapshot), 180);
}

function latestVisibleAssistantEntry(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.visible === false) continue;
    if (!String(message?.text ?? '').trim()) continue;
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
  const latestAssistant = latestVisibleAssistantEntry(normalizedSnapshot);
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
  const source = asObject(settings);
  const retention = normalizeRetentionSettings(normalized.retention);
  const providerSignature = (lane) => {
    const provider = asObject(normalized.providers?.[lane]);
    const rawProvider = asObject(source.providers?.[lane]);
    const rawOpenAICompatible = asObject(rawProvider.openAICompatible);
    return cacheProviderSettingsSignature({
      ...provider,
      openAICompatible: {
        ...asObject(provider.openAICompatible),
        sessionApiKeyPresent: rawOpenAICompatible.sessionApiKeyPresent === true
      }
    });
  };
  return {
    enabled: normalized.enabled,
    mode: normalized.mode,
    pipelineMode: normalized.pipelineMode,
    cardScope: normalized.cardScope,
    strength: normalized.strength,
    minCards: normalized.minCards,
    maxCards: normalized.maxCards,
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
    sourceCardsByFamily: activeCardDeckSourceCards(settings)
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

function cloneCacheVariants(cache) {
  const source = asObject(cache);
  const variants = asObject(source.variants);
  const output = {};
  for (const [key, value] of Object.entries(variants)) {
    const variantKey = safeText(value?.sourceRevisionHash || key, 180);
    if (!variantKey) continue;
    output[variantKey] = {
      ...asObject(value),
      sourceRevisionHash: variantKey,
      cards: Array.isArray(value?.cards) ? value.cards : [],
      latestHand: value?.latestHand || null
    };
  }
  return output;
}

function sceneCachePayload(snapshot, deck, hand, plan, packet = null, settings = {}, previousCache = null, options = {}) {
  const sourceRevisionHash = activeSourceRevisionHash(snapshot);
  const range = sourceWindowRange(snapshot);
  const variantLimit = normalizeRetentionSettings(settings.retention).sourceVariantsPerScene;
  const variants = cloneCacheVariants(previousCache);
  const existingOrder = Array.isArray(previousCache?.variantOrder)
    ? previousCache.variantOrder.map((key) => safeText(key, 180)).filter(Boolean)
    : Object.keys(variants);
  const latestHand = sceneCacheLatestHand(hand, packet);
  const source = {
    chatIdHash: hashJson(snapshot.chatId),
    firstMesId: range.firstMesId,
    lastMesId: range.lastMesId,
    latestMesId: snapshot.latestMesId,
    sceneFingerprint: snapshot.sceneFingerprint,
    chatWindowHash: hashJson(snapshot.messages),
    sourceRevisionHash,
    sourceWindowHash: sourceWindowFingerprint(snapshot, range.firstMesId, range.lastMesId),
    sceneStatus: plan.sceneStatus
  };
  variants[sourceRevisionHash] = {
    sourceRevisionHash,
    source,
    cards: deck.cards,
    latestHand,
    updatedAt: nowIso()
  };
  if (options.rapid) variants[sourceRevisionHash].rapid = options.rapid;
  const variantOrder = [...existingOrder.filter((key) => key !== sourceRevisionHash), sourceRevisionHash]
    .filter((key) => variants[key])
    .slice(-variantLimit);
  const prunedVariants = {};
  for (const key of variantOrder) prunedVariants[key] = variants[key];
  return {
    cacheState: 'active',
    versions: cacheContractVersions(settings),
    source,
    activeSourceRevisionHash: sourceRevisionHash,
    variantOrder,
    variants: prunedVariants,
    cards: deck.cards,
    latestHand
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
  if (settings?.mode === 'manual') return { forcedCardIds: [], forcedFamilies: [], diagnostics: [] };
  const activeDeck = getActiveCardDeck(settings);
  const forcedCardIds = deckPriorityCardIds(activeDeck, settings);
  const forcedFamilies = deckPriorityFamilies(activeDeck, settings);
  return {
    forcedCardIds,
    forcedFamilies,
    diagnostics: forcedCardIds.length > 0 ? ['priority-cards-active'] : []
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

function arbiterSafeSettings(settings, capabilityResolver = providerCapability) {
  const source = settingsWithRuntimeCardScope(settings);
  return {
    enabled: source.enabled !== false,
    mode: safeText(source.mode || 'auto', 40),
    cardDeck: {
      activeCardDeckId: safeText(source.cardDecks?.activeCardDeckId || '', 120),
      activeDeckName: safeText(getActiveCardDeck(source).name || '', 120)
    },
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

function safeProviderHealth(value) {
  const source = asObject(value);
  const output = {
    status: safeText(source.status || 'not-run', 40) || 'not-run'
  };
  const checkedAt = safeText(source.checkedAt || '', 80);
  const compactError = safeText(source.compactError || '', 300);
  if (checkedAt) output.checkedAt = checkedAt;
  if (compactError) output.compactError = compactError;
  return output;
}

function safeProviderSettingsView(provider, settings, lane, capabilityResolver = providerCapability) {
  const source = asObject(provider);
  return {
    lane: safeText(source.lane || '', 40),
    source: safeText(source.source || '', 80),
    hostConnectionProfileId: safeText(source.hostConnectionProfileId || '', 160),
    openAICompatible: {
      baseUrl: safeText(source.openAICompatible?.baseUrl || '', 300),
      model: safeText(source.openAICompatible?.model || '', 160),
      sessionApiKeyPresent: source.openAICompatible?.sessionApiKeyPresent === true
    },
    temperature: numberOr(source.temperature, 0),
    topP: numberOr(source.topP, 0),
    maxTokens: numberOr(source.maxTokens, 0),
    configRevision: numberOr(source.configRevision, 0),
    health: safeProviderHealth(source.health),
    capability: sanitizeProviderCapability(capabilityResolver(settings, lane, 'prompt-packet'))
  };
}

function safeSettingsView(settings, capabilityResolver = providerCapability) {
  const source = settingsWithRuntimeCardScope(settings);
  const cardScope = normalizeCardScope(source.cardScope);
  const cardBudget = normalizeCardBudgetSettings(source);
  const injection = normalizeInjectionSettings(source.injection);
  const enhancements = normalizeSettings(source).enhancements;
  const cardDecks = normalizeCardDeckSettings(source.cardDecks);
  return {
    enabled: source.enabled !== false,
    mode: safeText(source.mode || 'auto', 40),
    pipelineMode: safeText(source.pipelineMode || 'standard', 40),
    cardDecks,
    cardScopeSummary: cardScopeSummary(cardScope),
    strength: safeText(source.strength || 'balanced', 40),
    minCards: cardBudget.minCards,
    maxCards: cardBudget.maxCards,
    reasoningLevel: safeText(source.reasoningLevel || 'medium', 40),
    promptFootprint: safeText(source.promptFootprint || 'compact', 40),
    focus: safeText(source.focus || 'balanced', 80),
    reasonerUse: safeText(source.reasonerUse || 'auto', 40),
    storyFormOverride: safeText(source.storyFormOverride || 'auto', 40),
    enhancements: {
      mode: safeText(enhancements.mode || 'off', 40),
      applyMode: safeText(enhancements.applyMode, 40),
      contextMessages: numberOr(enhancements.contextMessages, 13)
    },
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
    const config = asObject(source.providers?.[lane]);
    const capability = capabilityResolver(source, lane, 'prompt-packet');
    return {
      source: safeText(config.source || '', 80),
      status: capability.state
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
      rapid: exact.rapid || null,
      exact: true
    };
  }
  if (!Object.keys(variants).length && Array.isArray(source.cards)) {
    return {
      sourceRevisionHash: safeText(source.activeSourceRevisionHash || '', 180),
      cards: source.cards,
      latestHand: source.latestHand || null,
      rapid: source.rapid || null,
      exact: false
    };
  }
  return {
    sourceRevisionHash,
    cards: [],
    latestHand: null,
    rapid: null,
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
    '- For refreshes, include refreshOfCardId when replacing a cached card.',
    '- Use lifecycle actions only for cached or accepted card ids: select, emphasize, stow, discard, regenerate.',
    '- Lifecycle regenerate marks an old cached card stale; it does not create a replacement without cardJobs.',
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
  const progressSource = card?.providerProgressSource === 'fused-repair' ? 'fused-repair' : source;
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
    parentStepId: explicitParentStepId || (progressSource === 'fused-repair'
      ? 'utility-card-batch'
      : (card?.providerRole === 'fusedCardBundle' ? 'fused-card-bundle' : 'utility-card-batch')),
    roleId,
    family,
    source: progressSource,
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

function signalAwareGenerationRouter(router, signal, runId, isCurrent = null) {
  if (!router || !signal) return router;
  function retryCurrentGuard(options = {}) {
    const callerGuard = options.isRetryCurrent || options.isCurrent;
    return async (context) => {
      if (signal?.aborted === true) return false;
      if (typeof isCurrent === 'function' && (await isCurrent(runId, context)) === false) return false;
      if (typeof callerGuard === 'function') {
        return (await callerGuard(context)) !== false;
      }
      return true;
    };
  }
  return {
    ...router,
    generate(roleId, request = {}, options = {}) {
      const nextRequest = { ...asObject(request), signal };
      const retryGuard = retryCurrentGuard(options);
      const nextOptions = {
        ...asObject(options),
        runId: options.runId ?? runId,
        signal: options.signal ?? signal,
        isCurrent: retryGuard,
        isRetryCurrent: retryGuard
      };
      return router.generate(roleId, nextRequest, nextOptions);
    },
    batch(requests = [], options = {}) {
      if (typeof router.batch !== 'function') return undefined;
      const nextRequests = Array.isArray(requests)
        ? requests.map((request) => ({ ...asObject(request), signal: request?.signal ?? signal }))
        : requests;
      const retryGuard = retryCurrentGuard(options);
      const nextOptions = {
        ...asObject(options),
        runId: options.runId ?? runId,
        signal: options.signal ?? signal,
        isCurrent: retryGuard,
        isRetryCurrent: retryGuard
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
  generationRouter = null,
  fetchImpl = globalThis.fetch,
  rapidHedgeDelayMs = 4000,
  rapidWarmJoinWaitMs = RAPID_WARM_JOIN_WAIT_MS
} = {}) {
  const runState = createRuntimeRunState();
  const activeProviderOperations = new Map();
  const activeProviderTests = new Map();
  const baseGenerationRouter = generationRouter;
  const previousProviderAuthFailureHandler = host?.handleProviderAuthFailure;

  if (host && typeof host === 'object') {
    host.handleProviderAuthFailure = async ({ lane, configHash, configRevision } = {}) => {
      const resolvedLane = providerLane(lane);
      const provider = settingsStore.get().providers?.[resolvedLane] || {};
      if (
        Number(provider.configRevision || 0) !== Number(configRevision)
        || providerConfigHash(provider) !== String(configHash || '')
      ) {
        return {
          ok: false,
          stale: true,
          error: {
            code: 'RECURSION_PROVIDER_AUTH_STALE',
            message: 'Provider settings changed before the authentication failure settled.'
          }
        };
      }
      return clearProviderKey(resolvedLane, {
        expectedRevision: Number(configRevision)
      });
    };
  }

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
        if (roleId === 'providerTest') {
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
  let recursionStopRequest = null;
  let lastPreparedGeneration = null;
  let lastBriefPacket = null;
  let lastBriefHand = { cards: [], omitted: [] };
  let lastPlan = null;
  let lastSnapshot = null;
  let lastCacheDecision = null;
  let lastBrief = {
    status: 'empty',
    reason: 'initial',
    packetId: '',
    handId: '',
    cardCount: 0,
    updatedAt: nowIso()
  };
  let lastRapidWarmView = rapidWarmStatusView({ pipelineMode: settingsStore.get().pipelineMode });
  let lastSavedSceneCacheRef = null;
  let promptInstallTail = Promise.resolve();
  let storageSaveTail = Promise.resolve();
  let pendingProseEnhancement = null;
  let activeProseEnhancementPromise = null;
  let activeProseEnhancementLifecycle = null;
  let canceledProseEnhancement = null;
  let lastEditorialResult = null;

  function createPreparedGenerationCandidate(packet, hand, snapshot, settings) {
    const basis = generationBasisForSnapshot(snapshot, settings);
    if (!basis) return null;
    return createPreparedGenerationArtifact({
      packet,
      hand,
      basis,
      contract: preparedGenerationContract(settings)
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

  async function readSnapshot() {
    if (typeof host?.snapshot !== 'function') {
      throw new Error('Recursion runtime requires host.snapshot().');
    }
    return normalizeSnapshot(await host.snapshot());
  }

  function isActiveRun(runId) {
    return runState.current().activeRunId === runId;
  }

  function isActiveRapidWarmRun(runId) {
    return runState.current().activeRapidWarmRun?.runId === runId;
  }

  function isRuntimeRunCurrent(runId) {
    return isActiveRun(runId) || isActiveRapidWarmRun(runId);
  }

  function abortActiveRun() {
    try {
      runState.current().activeRunController?.abort?.();
    } catch {
      // Abort notification is best-effort; supersession guards still prevent stale writes.
    }
  }

  function abortActiveRapidWarmRun(reasonCode = 'stale') {
    const current = runState.current().activeRapidWarmRun;
    if (!current) return;
    try {
      current.controller?.abort?.();
    } catch {
      // Abort notification is best-effort; supersession guards still prevent stale writes.
    }
    lastRapidWarmView = rapidWarmStatusView({
      ...lastRapidWarmView,
      status: reasonCode === 'warm-failed' ? 'failed' : 'stale',
      reasonCode,
      reasonLabel: rapidWarmReasonLabel(reasonCode),
      joinable: false
    });
    runState.clearRapidWarmRun(current.runId);
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

  function startRapidWarmRun(runId, context = {}) {
    abortActiveRapidWarmRun('stale');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let resolvePromise = null;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    const warmRun = {
      runId,
      controller,
      signal: controller?.signal ?? null,
      baseSourceRevisionHash: safeText(context.baseSourceRevisionHash || '', 180),
      contract: asObject(context.contract),
      startedAt: nowIso(),
      promise,
      resolve: resolvePromise
    };
    runState.setRapidWarmRun(warmRun);
    lastRapidWarmView = rapidWarmStatusView({
      status: 'warming',
      pipelineMode: settingsStore.get().pipelineMode,
      runId,
      baseSourceRevisionHash: context.baseSourceRevisionHash,
      startedAt: warmRun.startedAt,
      reasonCode: 'warming',
      joinable: true
    });
    return warmRun.signal;
  }

  function clearActiveRun(runId = null) {
    runState.clearActiveRun(runId);
  }

  function clearRapidWarmRun(runId = null) {
    runState.clearRapidWarmRun(runId);
  }

  function rapidWarmRunMatchesSource(warm, baseSourceRevisionHash, expectedContracts = {}) {
    if (!warm?.promise) return null;
    if (warm.signal?.aborted === true) return null;
    if (safeText(warm.baseSourceRevisionHash || '', 180) !== safeText(baseSourceRevisionHash || '', 180)) return null;
    const contract = asObject(warm.contract);
    for (const key of ['settingsHash', 'providerContractHash', 'cardCatalogHash', 'promptContractHash']) {
      if (safeText(contract[key] || '', 180) !== safeText(expectedContracts[key] || '', 180)) return null;
    }
    return warm;
  }

  function exactWarmRunForSource(baseSourceRevisionHash, expectedContracts = {}) {
    return rapidWarmRunMatchesSource(runState.current().activeRapidWarmRun, baseSourceRevisionHash, expectedContracts);
  }

  async function waitForRapidWarmBaseSource(runId, expectedContracts = {}, timeoutMs = 250) {
    const warm = runState.current().activeRapidWarmRun;
    if (!warm?.promise || warm.signal?.aborted === true) return null;
    const contract = asObject(warm.contract);
    for (const key of ['settingsHash', 'providerContractHash', 'cardCatalogHash', 'promptContractHash']) {
      if (safeText(contract[key] || '', 180) !== safeText(expectedContracts[key] || '', 180)) return null;
    }
    if (safeText(warm.baseSourceRevisionHash || '', 180)) return warm;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!isActiveRun(runId)) return null;
      if (safeText(warm.baseSourceRevisionHash || '', 180)) return warm;
      const activeWarm = runState.current().activeRapidWarmRun;
      if (!activeWarm || activeWarm.runId !== warm.runId) return null;
      if (safeText(activeWarm.baseSourceRevisionHash || '', 180)) return activeWarm;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  }

  function rapidWarmElapsedFromView() {
    const explicitElapsedMs = Number(lastRapidWarmView?.elapsedMs);
    const startedMs = Date.parse(lastRapidWarmView?.startedAt || '');
    if (Number.isFinite(startedMs)) return Math.max(0, Date.now() - startedMs);
    return Number.isFinite(explicitElapsedMs) ? Math.max(0, Math.round(explicitElapsedMs)) : 0;
  }

  async function waitForRapidWarm(runId, warmRun, timeoutMs = RAPID_WARM_JOIN_WAIT_MS) {
    const joinWaitMs = Math.max(0, Number(timeoutMs) || 0);
    lastRapidWarmView = rapidWarmStatusView({
      ...lastRapidWarmView,
      status: 'waiting',
      reasonCode: 'warming',
      reasonLabel: 'Waiting for Rapid deck...',
      joinable: true
    });
    stageRuntimeActivity({
      runId,
      phase: 'rapidWarmWaiting',
      label: 'Waiting for Rapid deck...',
      chips: ['Rapid'],
      detail: { joinWaitMs }
    });
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, timeout: true }), joinWaitMs);
    });
    const result = await Promise.race([warmRun.promise, timeout]);
    if (result?.ok === true && result?.rapid?.status === 'ready') return result;
    if (result?.timeout) return { ok: false, reasonCode: 'warm-timeout' };
    return { ok: false, reasonCode: 'warm-failed' };
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
      armedAt: nowIso(),
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

  async function waitForProseEnhancementBarrier(timeoutMs = GENERATION_REVIEW_BARRIER_TIMEOUT_MS) {
    const startedAt = Date.now();
    let waited = false;
    while (proseEnhancementActive()) {
      waited = true;
      const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
      if (remainingMs <= 0) return { ok: false, timeout: true, waited };
      const active = activeProseEnhancementPromise;
      const tick = new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingMs)));
      if (active) {
        await Promise.race([active.catch(() => null), tick]);
      } else {
        await tick;
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
    const pendingFreshNextGeneration = runState.current().pendingFreshNextGeneration;
    if (!pendingFreshNextGeneration) {
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
      id: safeText(pendingFreshNextGeneration.id || '', 180),
      reason: safeText(pendingFreshNextGeneration.reason || 'user-fresh-next-generation', 120),
      requestedAt: safeText(pendingFreshNextGeneration.requestedAt || '', 80),
      source: safeText(pendingFreshNextGeneration.source || 'bar', 80)
    };
  }

  function clearPendingFreshNextGeneration() {
    runState.clearFreshNextGeneration();
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
    const pendingFreshNextGeneration = runState.current().pendingFreshNextGeneration;
    if (!pendingFreshNextGeneration) return null;
    const token = {
      ...pendingFreshNextGeneration,
      consumeByRunId: safeText(runId || '', 160)
    };
    runState.clearFreshNextGeneration();
    return token;
  }

  async function requestFreshNextGeneration(details = {}) {
    const settings = settingsStore.get();
    if (settings.enabled === false) {
      clearPendingFreshNextGeneration();
      clearPendingLatestAssistantSwipeRetry();
      clearLastBrief({ status: 'empty', reason: 'disabled' });
      return { ok: true, skipped: true, reason: 'disabled' };
    }
    const source = asObject(details);
    runState.setFreshNextGeneration({
      id: makeId('fresh-next-generation'),
      reason: 'user-fresh-next-generation',
      requestedAt: nowIso(),
      consumeByRunId: '',
      source: safeText(source.source || 'bar', 80) || 'bar'
    });
    clearPendingLatestAssistantSwipeRetry();
    return {
      ok: true,
      freshNextGeneration: freshNextGenerationView()
    };
  }

  async function clearFreshNextGeneration() {
    clearPendingFreshNextGeneration();
    return {
      ok: true,
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
    abortActiveRapidWarmRun('stale');
    clearPendingProseEnhancement();
    clearPreparedGeneration();
    lastPlan = null;
    lastSnapshot = null;
    lastSavedSceneCacheRef = null;
    runState.clearLatestAssistantSwipeRetry();
    runState.clearAttempt?.();
    runState.clearFreshNextGeneration();
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
      abortActiveRapidWarmRun('pipeline-mode-changed');
      return trackRuntimeMutation(async () => {
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
            previous: safeText(currentSettings.pipelineMode || 'standard', 40),
            next: safeText(next.pipelineMode || 'standard', 40)
          }
        };
      });
    }
    const shouldWarmRapidAfterSettingsChange = changedKeys.length > 0
      && next.enabled !== false
      && next.pipelineMode === 'rapid';
    if (changedKeys.length > 0) {
      supersedeActiveRun();
      abortActiveRapidWarmRun('settings-mismatch');
      if (next.enabled === false) clearPreparedGeneration();
      const result = await trackRuntimeMutation(async () => {
        await invalidateActiveSceneCacheBestEffort('settings-changed', {
          changedKeys
        });
        const clear = await clearPromptAfterSupersede({
          successLabel: next.enabled === false
            ? 'Recursion disabled. Prompt cleared.'
            : 'Recursion prompt cleared after settings change.',
          journalReason: 'settings-changed'
        });
        return { ok: clear?.ok !== false, settings: next, clear };
      });
      if (!shouldWarmRapidAfterSettingsChange) return result;
      Promise.resolve()
        .then(() => warmRapidScene({ reason: 'settings-changed' }))
        .catch(() => {});
      return { ...result, warm: { queued: true, reason: 'settings-changed' } };
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
      'injection',
      'ui',
      'enhancements',
      'retention',
      'diagnostics'
    ];
    const changedKeys = resetKeys.filter((key) => !settingValuesEqual(before[key], next[key]));
    if (changedKeys.length === 0) {
      return { ok: true, reset: false, settings: next, clear: null };
    }

    supersedeActiveRun();
    abortActiveRapidWarmRun('settings-reset');
    return trackRuntimeMutation(async () => {
      await invalidateActiveSceneCacheBestEffort('settings-reset', { changedKeys });
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
    const beforeCapability = providerCapability(beforeSettings, resolvedLane, 'prompt-packet');
    const update = settingsStore.updateProviderConfig(resolvedLane, patch, options);
    if (update.ok !== true || update.changedKeys.length === 0) {
      return { ...update, clear: null };
    }
    const provider = update.provider;
    supersedeActiveRun();
    abortActiveRapidWarmRun('provider-contract-mismatch');
    return trackRuntimeMutation(async () => {
      const afterSettings = settingsStore.get();
      const afterCapability = providerCapability(afterSettings, resolvedLane, 'prompt-packet');
      await appendProviderCapabilityMutation({
        lane: resolvedLane,
        kind: 'configuration',
        changedKeys: update.changedKeys,
        before: beforeCapability,
        after: afterCapability
      });
      await invalidateActiveSceneCacheBestEffort('provider-changed', {
        lane: resolvedLane,
        changedKeys: update.changedKeys
      });
      const clear = await clearPromptAfterSupersede({
        successLabel: 'Recursion prompt cleared after provider change.',
        journalReason: 'provider-changed'
      });
      return { ok: clear?.ok !== false, provider, changedKeys: update.changedKeys, clear };
    });
  }

  async function clearProviderKey(lane, options = {}) {
    const resolvedLane = providerLane(lane);
    const beforeSettings = settingsStore.get();
    const beforeCapability = providerCapability(beforeSettings, resolvedLane, 'prompt-packet');
    const update = settingsStore.clearApiKey(resolvedLane, options);
    if (update.ok !== true || update.changedKeys.length === 0) {
      return { ...update, clear: null };
    }
    const provider = update.provider;
    supersedeActiveRun();
    abortActiveRapidWarmRun('provider-contract-mismatch');
    return trackRuntimeMutation(async () => {
      const afterSettings = settingsStore.get();
      const afterCapability = providerCapability(afterSettings, resolvedLane, 'prompt-packet');
      await appendProviderCapabilityMutation({
        lane: resolvedLane,
        kind: 'configuration',
        changedKeys: update.changedKeys,
        before: beforeCapability,
        after: afterCapability
      });
      await invalidateActiveSceneCacheBestEffort('provider-key-cleared', {
        lane: resolvedLane
      });
      const clear = await clearPromptAfterSupersede({
        successLabel: 'Recursion prompt cleared after provider key change.',
        journalReason: 'provider-key-cleared'
      });
      return { ok: clear?.ok !== false, provider, changedKeys: update.changedKeys, clear };
    });
  }

  async function fetchProviderModels(lane = 'utility', patch = {}) {
    const resolvedLane = providerLane(lane);
    const current = settingsStore.get().providers?.[resolvedLane] || {};
    const cleanPatch = asObject(patch);
    const provider = {
      ...current,
      ...cleanPatch,
      openAICompatible: {
        ...asObject(current.openAICompatible),
        ...asObject(cleanPatch.openAICompatible)
      }
    };
    if (provider.source !== 'openai-compatible') {
      return {
        ok: false,
        lane: resolvedLane,
        error: {
          code: 'RECURSION_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED',
          message: 'Model discovery is only available for OpenAI-compatible endpoints.'
        }
      };
    }
    try {
      const result = await fetchOpenAICompatibleModels({
        baseUrl: provider.openAICompatible?.baseUrl,
        apiKey: String(cleanPatch.apiKey || settingsStore.getApiKey(resolvedLane) || '').trim(),
        fetchImpl,
        signal: cleanPatch.signal
      });
      return {
        ok: true,
        lane: resolvedLane,
        endpoint: safeText(result.endpoint || '', 300),
        models: Array.isArray(result.models)
          ? result.models.map((entry) => ({
            id: safeText(entry?.id || '', 200),
            label: safeText(entry?.label || entry?.id || '', 240)
          })).filter((entry) => entry.id)
          : []
      };
    } catch (error) {
      return {
        ok: false,
        lane: resolvedLane,
        error: {
          code: safeText(error?.code || 'RECURSION_PROVIDER_MODEL_DISCOVERY_FAILED', 120),
          message: safeText(error?.message || 'Provider model discovery failed.', 300)
        }
      };
    }
  }

  function safeProviderProfiles(profiles = []) {
    return Array.isArray(profiles)
      ? profiles.slice(0, 100).map((profile) => ({
        id: safeIdentifier(profile?.id || '', '', 160),
        name: safeText(profile?.name || profile?.label || profile?.id || '', 180),
        model: safeText(profile?.model || '', 180),
        label: safeText(profile?.label || profile?.name || profile?.id || '', 240)
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
    return {
      activeRunId: state.activeRunId,
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
      lastBrief: { ...lastBrief },
      freshNextGeneration: freshNextGenerationView(),
      rapidWarm: rapidWarmStatusView({
        ...lastRapidWarmView,
        pipelineMode: settingsStore.get().pipelineMode
      }),
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

  async function resetSceneCache() {
    const runId = makeId('scene-reset');
    supersedeActiveRun();
    return trackRuntimeMutation(async () => {
      startRuntimeActivity({
        runId,
        phase: 'storageProgress',
        mode: 'review',
        severity: 'info',
        label: 'Resetting Recursion scene cache...',
        chips: ['Cache']
      });
      try {
        await storageSaveTail.catch(() => {});
      } catch {
        // Storage save failures are already reported by their source.
      }
      let snapshot = null;
      try {
        snapshot = await readSnapshot();
      } catch {
        snapshot = lastSnapshot ? normalizeSnapshot(lastSnapshot) : normalizeSnapshot({});
      }
      lastSnapshot = snapshot;
      const chatKey = safeText(snapshot.chatKey || snapshot.chatId || DEFAULT_CHAT_ID, 160) || DEFAULT_CHAT_ID;
      const sceneKey = safeText(snapshot.sceneKey || DEFAULT_SCENE_KEY, 160) || DEFAULT_SCENE_KEY;
      const result = typeof storage.clearSceneCache === 'function'
        ? await storage.clearSceneCache(chatKey, sceneKey)
        : { ok: false, reason: 'unsupported' };
      if (result?.ok === false) {
        settleRuntimeActivity({
          runId,
          outcome: 'warning',
          phase: 'storageWarning',
          severity: 'warning',
          label: 'Scene cache reset failed.',
          chips: ['Cache'],
          detail: redact(result)
        });
        return { ok: false, chatKey, sceneKey, result: redact(result), clear: null };
      }
      clearPreparedGeneration();
      lastPlan = null;
      lastSavedSceneCacheRef = null;
      runState.clearLatestAssistantSwipeRetry();
      runState.clearFreshNextGeneration();
      clearLastBrief({ status: 'empty', reason: 'scene-cache-reset' });
      stageRuntimeActivity({
        runId,
        phase: 'promptClearing',
        mode: 'review',
        severity: 'info',
        label: 'Clearing Recursion prompt after scene cache reset...',
        chips: ['Cache', 'Prompt']
      });
      const clear = await runPromptMutationSection(null, async () => {
        const clearResult = await clearPromptBestEffort(host);
        await appendPromptClearedJournal(runId, promptClearContext(snapshot), clearResult, 'scene-cache-reset');
        return clearResult;
      });
      if (clear?.ok === false) {
        reportClearWarning(runId, clear);
        return { ok: false, chatKey, sceneKey, result: redact(result), clear };
      }
      settleRuntimeActivity({
        runId,
        outcome: 'success',
        phase: 'settled',
        severity: 'success',
        label: 'Scene cache reset. Prompt cleared.',
        chips: ['Cache', 'Prompt']
      });
      return { ok: true, chatKey, sceneKey, result: redact(result), clear };
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
    invalidationDetails = {},
    startLabel,
    successLabel,
    chips,
    outcome = 'success',
    settleSeverity = 'success',
    clearVolatileState = true,
    preserveLastBrief = false,
    invalidateCache = true,
    clearSwipeRetry = true
  }) {
    const runId = makeId(idPrefix);
    if (clearSwipeRetry) clearPendingLatestAssistantSwipeRetry();
    clearPendingFreshNextGeneration();
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
      if (invalidateCache) await invalidateActiveSceneCacheBestEffort(reason, invalidationDetails);
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
    return clearForHostEvent({
      idPrefix: 'chat-change',
      reason: 'chat-changed',
      invalidationDetails: { source: 'host-event' },
      startLabel: 'Clearing Recursion prompt after chat change...',
      successLabel: 'Chat changed. Recursion prompt cleared.',
      chips: ['Chat', 'Prompt']
    });
  }

  async function handleSourceChanged(details = {}) {
    const source = asObject(details);
    const eventName = safeText(source.eventName || source.event || '', 80);
    const messageId = finiteNumberOrNull(source.messageId ?? source.mesid ?? source.id);
    return clearForHostEvent({
      idPrefix: 'source-change',
      reason: 'source-changed',
      invalidationDetails: {
        source: 'host-event',
        ...(eventName ? { eventName } : {}),
        ...(messageId !== null ? { messageId } : {})
      },
      startLabel: 'Clearing Recursion prompt after source message change...',
      successLabel: 'Source messages changed. Recursion prompt cleared.',
      chips: ['Source', 'Prompt'],
      preserveLastBrief: true
    });
  }

  async function handleHostGenerationStopped(details = {}) {
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
              enhancementPending: Boolean(pendingProseEnhancement),
              enhancementActive: Boolean(activeProseEnhancementPromise),
              activeRunId: safeText(beforeStop.activeRunId || '', 160),
              activeAttemptKind: safeText(beforeStop.activeAttempt?.kind || '', 80),
              enhancementControlsLocked: source.enhancementControlsLocked === true,
              ...(recursionStopRequest ? { recursionStopRequest: redact(recursionStopRequest) } : {})
            }
          })
        : Promise.resolve(null);
      const cancellation = cancelActiveProseEnhancement('prose-enhancement-canceled');
      await Promise.all([cancellation, stopJournal]);
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
        invalidationDetails: {
          source: safeText(source.source || 'host-event', 80),
          ...(eventName ? { eventName } : {}),
          ...(source.hostStop ? { hostStop: redact(source.hostStop) } : {})
        },
        startLabel: 'Stopping Recursion after generation cancel...',
        successLabel: preserveLastKnownGood
          ? 'Swipe stopped; previous context preserved.'
          : 'Generation canceled. Recursion prompt cleared.',
        chips: ['Stop', 'Prompt'],
        outcome: 'skipped',
        settleSeverity: 'info',
        clearVolatileState: false,
        invalidateCache: false,
        clearSwipeRetry: false
      });
      runState.clearAttempt?.(attempt?.runId);
      return result;
    })().finally(() => {
      hostStopCleanupPromise = null;
    });
    return hostStopCleanupPromise;
  }

  function handleHostGenerationEnded() {
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
      const generate = async (request, routerOptions = {}) => {
        const primary = await generationRouter.generate('generationReviewer', request, {
          runId,
          timeoutMs: GENERATION_REVIEW_TIMEOUT_MS,
          ...routerOptions
        });
        if (primary?.ok === true || lane !== 'reasoner') return { result: primary, lane };
        if (primary?.recoverySpent === true) return { result: primary, lane };
        const fallbackRequest = { ...request, lane: 'utility' };
        delete fallbackRequest.reasoningCategory;
        delete fallbackRequest.reasoningIntent;
        const fallback = await generationRouter.generate('generationReviewer', fallbackRequest, {
          runId,
          timeoutMs: GENERATION_REVIEW_TIMEOUT_MS,
          ...routerOptions
        });
        return { result: fallback, lane: fallback?.ok === true ? 'utility' : lane, fallbackFrom: fallback?.ok === true ? 'reasoner' : '' };
      };
      let response = await generate(baseRequest);
      let validation = response.result?.ok === true
        ? validateGenerationReviewResult(response.result.data, { sourceHash, targets, reviewSnapshot: publicSnapshot })
        : { ok: false, error: response.result?.error || { code: 'RECURSION_GENERATION_REVIEW_PROVIDER_FAILED', message: 'Generation review provider failed.' } };
      if (!validation.ok && validation.retryable === true && response.result?.recoverySpent !== true) {
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
        }), { allowStructuredRecovery: false });
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
      const armed = asObject(pendingProseEnhancement?.requiredCapability);
      if (!capability.eligible) return sanitizeProviderCapability(capability);
      if (
        safeText(armed.configHash, 180) !== capability.configHash
        || Number(armed.configRevision) !== capability.configRevision
      ) {
        return {
          ...sanitizeProviderCapability(capability),
          eligible: false,
          reasonCode: 'reasoner-configuration-changed',
          message: 'Reasoner settings changed after Redirect was armed. Generate again.'
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
        timeoutMs: GENERATION_REVIEW_TIMEOUT_MS,
        signal: enhancementSignal,
        allowStructuredRecovery: options.allowStructuredRecovery !== false && recoveryToken.spent !== true,
        ...(options.maxAttempts === 1 ? { maxAttempts: 1 } : {})
      });
      const primaryRecoverySpent = primary?.recoverySpent === true
        && !(options.allowStructuredRecovery === false && options.preserveRecoveryBudget === true);
      if (primaryRecoverySpent) recoveryToken.spent = true;
      if (primary?.ok === true || primaryLane !== 'reasoner' || options.allowLaneFallback === false) {
        return { result: primary, lane: primaryLane };
      }
      if (primaryRecoverySpent) return { result: primary, lane: primaryLane };
      const fallbackRequest = { ...request, lane: 'utility' };
      delete fallbackRequest.reasoningCategory;
      delete fallbackRequest.reasoningIntent;
      const fallback = await generationRouter.generate(roleId, fallbackRequest, {
        runId,
        timeoutMs: GENERATION_REVIEW_TIMEOUT_MS,
        signal: enhancementSignal,
        allowStructuredRecovery: options.allowStructuredRecovery !== false && recoveryToken.spent !== true
      });
      if (fallback?.recoverySpent === true) recoveryToken.spent = true;
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
        ...buildEditorialDiagnosisRequest({ mode: editorialMode, sourceText, sourceHash, snapshotHash, snapshot: publicSnapshot, lane: editorialLane }),
        ...reasonerRequestMetadata(settings, 'editorial-transform', editorialLane),
        reasoningIntent: 'low'
      };
      let diagnosisResponse = await generateEditorialRole(
        'editorialDiagnostician',
        diagnosisRequest,
        {
          allowStructuredRecovery: editorialMode !== 'redirect',
          preserveRecoveryBudget: editorialMode === 'redirect'
        }
      );
      if (enhancementSignal?.aborted) return canceledEditorialResult();
      let diagnosisValidation = diagnosisResponse.result?.ok === true
        ? validateEditorialDiagnosis(diagnosisResponse.result.data, { mode: editorialMode, sourceText, sourceHash, snapshotHash, snapshot: publicSnapshot })
        : { ok: false, error: diagnosisResponse.result?.error || { code: 'RECURSION_EDITORIAL_DIAGNOSIS_FAILED', message: 'Editorial diagnosis failed.' } };
      const runtimeCorrectionAvailable = diagnosisResponse.result?.ok === true || editorialMode === 'redirect';
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
            lane: correctionLane,
            retry: diagnosisValidation.error
          }),
          ...reasonerRequestMetadata(settings, 'editorial-transform', correctionLane),
          reasoningIntent: 'low'
        }, { allowStructuredRecovery: false, allowLaneFallback: false });
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
        ? { allowStructuredRecovery: false, allowLaneFallback: false, maxAttempts: 1 }
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
      const transformCorrectionAvailable = strictReasonerWriter
        || (transformResponse.result?.ok === true && recoveryToken.spent !== true);
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
          allowStructuredRecovery: false,
          ...(strictReasonerWriter ? { allowLaneFallback: false, maxAttempts: 1 } : {})
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
      if (!validation.ok) return { ...failEditorial(validation.error), validation };
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
            }, { allowStructuredRecovery: false });
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
            allowStructuredRecovery: false,
            ...(strictReasonerWriter ? { allowLaneFallback: false, maxAttempts: 1 } : {})
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
          if (!validation.ok) return { ...failEditorial(validation.error), validation };
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
          cardOutcomes: marker.cardOutcomes,
          unresolvedCardIds: marker.unresolvedCardIds
        }
      });
      return {
        ok: true,
        partialFailed: editorialPartialFailed,
        unresolvedCardIds: marker.unresolvedCardIds,
        mode: editorialMode,
        messageId,
        sourceHash,
        enhancedHash: marker.candidateHash,
        marker,
        artifact: validation.artifact,
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
      return { ok: true, skipped: true, reason: 'enhancement-not-armed' };
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
          runId,
          timeoutMs: PROSE_ENHANCEMENT_TIMEOUT_MS
        });
        if (primary?.ok === true || primaryLane !== 'reasoner') {
          return { result: primary, lane: primaryLane, fallbackFrom: '' };
        }
        const fallbackRequest = { ...request, lane: 'utility' };
        delete fallbackRequest.reasoningCategory;
        delete fallbackRequest.reasoningIntent;
        const fallback = await generationRouter.generate(roleId, fallbackRequest, {
          runId,
          timeoutMs: PROSE_ENHANCEMENT_TIMEOUT_MS
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
    cancelPendingProseEnhancement('prose-enhancement-canceled');
    supersedeActiveRun();
    recursionStopRequest = {
      source: safeText(details.source || 'recursion-ui', 80),
      requestedAt: nowIso()
    };
    try {
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
    } finally {
      recursionStopRequest = null;
    }
  }

  function providerTestPrompt(lane) {
    return [
      'Return strict JSON for a Recursion provider connectivity test.',
      'Do not include prose outside JSON.',
      `Lane: ${lane}.`,
      '{"schema":"recursion.providerTest.v1","ok":true}'
    ].join('\n');
  }

  async function recordProviderTestHealth(lane, status, checkedAt, configHash, configRevision, error = null) {
    const beforeSettings = settingsStore.get();
    const beforeCapability = providerCapability(beforeSettings, lane, 'prompt-packet');
    const compactError = safeText(error?.message || error?.code || error || 'Provider test failed.', 300);
    const result = settingsStore.recordProviderHealth(lane, {
      status,
      checkedAt,
      source: 'provider-test',
      ...(status === 'fail' ? { compactError } : {})
    }, {
      configHash,
      configRevision
    });
    if (result.ok === true && typeof host?.settings?.flush === 'function') {
      await host.settings.flush();
    }
    const afterSettings = settingsStore.get();
    const afterCapability = providerCapability(afterSettings, lane, 'prompt-packet');
    await trackRuntimeMutation(() => appendProviderCapabilityMutation({
      lane,
      kind: result.stale ? 'stale-health' : 'health',
      changedKeys: [],
      before: beforeCapability,
      after: afterCapability,
      stale: result.stale === true
    })).catch(() => {});
    return result;
  }

  function validProviderTestResult(result) {
    const data = asObject(result?.data);
    return result?.ok === true
      && data.schema === PROVIDER_TEST_SCHEMA
      && data.ok === true;
  }

  function testProvider(lane = 'utility') {
    const resolvedLane = providerLane(lane);
    if (activeProviderTests.has(resolvedLane)) return activeProviderTests.get(resolvedLane);
    if (activeProviderOperations.has(resolvedLane)) {
      return Promise.resolve(providerBusyResult(resolvedLane));
    }

    const task = (async () => {
      const checkedAt = nowIso();
      const runId = makeId(`provider-test-${resolvedLane}`);
      const settings = settingsStore.get();
      const providerSnapshot = settings.providers?.[resolvedLane] || {};
      const configHash = providerConfigHash(providerSnapshot);
      const configRevision = Number(providerSnapshot.configRevision || 0);
      const capability = resolveProviderCapability({
        settings,
        lane: resolvedLane,
        operation: 'provider-test',
        host: {
          currentModelAvailable: Boolean(generationRouter?.generate),
          connectionProfiles: listProviderConnectionProfilesForUi()
        }
      });
      startRuntimeActivity({
        runId,
        phase: 'providerCallStarted',
        mode: 'review',
        severity: 'info',
        providerLane: resolvedLane,
        label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test started.`,
        chips: [resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility', 'Provider']
      });

      if (!capability.testable) {
        const error = {
          code: 'RECURSION_PROVIDER_NOT_READY',
          message: capability.message
        };
        await recordProviderTestHealth(resolvedLane, 'fail', checkedAt, configHash, configRevision, error);
        settleRuntimeActivity({
          runId,
          outcome: 'warning',
          phase: 'providerTestFailed',
          severity: 'warning',
          providerLane: resolvedLane,
          label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test unavailable.`,
          chips: ['Provider'],
          detail: sanitizeProviderCapability(capability)
        });
        return { ok: false, error };
      }

      if (!generationRouter || typeof generationRouter.generate !== 'function') {
        const error = {
          code: 'RECURSION_PROVIDER_ROUTER_UNAVAILABLE',
          message: 'Provider test is unavailable.'
        };
        await recordProviderTestHealth(resolvedLane, 'fail', checkedAt, configHash, configRevision, error);
        return { ok: false, error };
      }

      try {
        stageRuntimeActivity({
          runId,
          phase: 'providerCallRunning',
          mode: 'review',
          severity: 'info',
          providerLane: resolvedLane,
          label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test running.`,
          chips: ['Provider']
        });
        const configuredMaxTokens = Number(providerSnapshot.maxTokens) || 8192;
        const result = await generationRouter.generate('providerTest', {
          runId,
          lane: resolvedLane,
          ...reasoningRequestMetadata({}, 'provider-test'),
          responseLength: configuredMaxTokens,
          prompt: providerTestPrompt(resolvedLane)
        }, { timeoutMs: PROVIDER_TEST_TIMEOUT_MS });
        if (validProviderTestResult(result)) {
          const health = await recordProviderTestHealth(resolvedLane, 'pass', checkedAt, configHash, configRevision);
          settleRuntimeActivity({
            runId,
            outcome: health.stale ? 'neutral' : 'success',
            phase: 'settled',
            severity: health.stale ? 'info' : 'success',
            providerLane: resolvedLane,
            label: health.stale
              ? `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test result ignored after configuration changed.`
              : `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test passed.`,
            chips: ['Provider'],
            detail: { configHash, stale: health.stale === true }
          });
          return { ...result, healthStale: health.stale === true };
        }

        const failure = result?.ok
          ? {
              code: 'RECURSION_PROVIDER_TEST_INVALID',
              message: 'Provider test returned an invalid structured response.'
            }
          : (result?.error || {
              code: 'RECURSION_PROVIDER_TEST_FAILED',
              message: 'Provider test failed.'
            });
        const health = await recordProviderTestHealth(resolvedLane, 'fail', checkedAt, configHash, configRevision, failure);
        settleRuntimeActivity({
          runId,
          outcome: health.stale ? 'neutral' : 'warning',
          phase: 'providerTestFailed',
          severity: health.stale ? 'info' : 'warning',
          providerLane: resolvedLane,
          label: health.stale
            ? `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test result ignored after configuration changed.`
            : `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test failed.`,
          chips: ['Provider'],
          detail: { configHash, stale: health.stale === true }
        });
        return result?.ok ? { ok: false, error: failure } : (result || { ok: false, error: failure });
      } catch (error) {
        const health = await recordProviderTestHealth(resolvedLane, 'fail', checkedAt, configHash, configRevision, error);
        settleRuntimeActivity({
          runId,
          outcome: health.stale ? 'neutral' : 'warning',
          phase: 'providerTestFailed',
          severity: health.stale ? 'info' : 'warning',
          providerLane: resolvedLane,
          label: health.stale
            ? `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test result ignored after configuration changed.`
            : `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test failed.`,
          chips: ['Provider'],
          detail: { configHash, stale: health.stale === true }
        });
        return {
          ok: false,
          healthStale: health.stale === true,
          error: {
            code: safeText(error?.code || 'RECURSION_PROVIDER_TEST_FAILED', 120),
            message: safeText(error?.message || 'Provider test failed.', 300)
          }
        };
      }
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

  function reportCacheContractStatus(runId, status) {
    if (!isActiveRun(runId)) return;
    stageRuntimeActivity({
      runId,
      phase: 'cacheWarning',
      severity: 'info',
      label: status.hard
        ? 'Scene cache contract changed; rebuilding cache.'
        : 'Scene cache settings changed; reviewing cached cards.',
      chips: ['Cache'],
      detail: {
        reason: status.reason,
        ...(status.missing?.length ? { missing: status.missing.slice(0, 12) } : {}),
        ...(status.mismatches?.length ? { mismatches: status.mismatches.slice(0, 12) } : {})
      }
    });
  }

  async function invalidateLoadedSceneCache(runId, snapshot, status, cacheState) {
    if (typeof storage.invalidateSceneCache !== 'function') return null;
    try {
      return await storage.invalidateSceneCache(snapshot.chatKey, snapshot.sceneKey, {
        reason: status.reason,
        cacheState,
        runId,
        details: {
          ...(status.missing?.length ? { missing: status.missing.slice(0, 12) } : {}),
          ...(status.mismatches?.length ? { mismatches: status.mismatches.slice(0, 12) } : {})
        }
      });
    } catch (error) {
      reportStorageWarning(runId, 'invalidateSceneCache', error);
      return null;
    }
  }

  async function loadSceneCacheSafe(runId, snapshot, settings) {
    try {
      const cache = await storage.loadSceneCache(snapshot.chatKey, snapshot.sceneKey);
      if (!cache) return null;
      const cacheState = cleanString(cache.cacheState, 'active');
      if (cacheState === 'invalid' || cacheState === 'retired') {
        return null;
      }
      const status = cacheContractStatus(cache, settings);
      if (status.hard) {
        reportCacheContractStatus(runId, status);
        await invalidateLoadedSceneCache(runId, snapshot, status, 'invalid');
        return null;
      }
      if (status.soft) {
        reportCacheContractStatus(runId, status);
        const invalidation = {
          reason: status.reason,
          detectedAt: nowIso(),
          details: {
            ...(status.missing?.length ? { missing: status.missing.slice(0, 12) } : {}),
            ...(status.mismatches?.length ? { mismatches: status.mismatches.slice(0, 12) } : {})
          }
        };
        await invalidateLoadedSceneCache(runId, snapshot, status, 'stale');
        return {
          ...cache,
          cacheState: 'stale',
          invalidation
        };
      }
      return cache;
    } catch (error) {
      reportStorageWarning(runId, 'loadSceneCache', error);
      return null;
    }
  }

  async function saveSceneCacheSafe(runId, snapshot, value) {
    try {
      const result = await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, value);
      if (result?.storageStatus?.persisted === false) {
        lastSavedSceneCacheRef = null;
      } else {
        lastSavedSceneCacheRef = {
          chatKey: snapshot.chatKey,
          sceneKey: snapshot.sceneKey
        };
        await maintainRetentionSafe(runId, snapshot);
      }
      return result;
    } catch (error) {
      reportStorageWarning(runId, 'saveSceneCache', error);
      return null;
    }
  }

  async function maintainRetentionSafe(runId, snapshot) {
    if (typeof storage.maintainRetention !== 'function') return null;
    try {
      return await storage.maintainRetention({
        activeScene: { chatKey: snapshot.chatKey, sceneKey: snapshot.sceneKey }
      });
    } catch (error) {
      reportStorageWarning(runId, 'maintainRetention', error);
      return null;
    }
  }

  async function appendJournalSafe(runId, chatKey, entry) {
    try {
      return await storage.appendJournal(chatKey, entry);
    } catch (error) {
      reportStorageWarning(runId, 'appendJournal', error);
      return null;
    }
  }

  async function saveRapidWarmStatus(runId, snapshot, cache, rapidPatch = {}, settings = settingsStore.get()) {
    const activeVariant = activeSceneCacheVariant(cache, snapshot);
    const warmArtifactId = safeIdentifier(rapidPatch.warmArtifactId || makeId('rapid-warm-artifact'), 'rapid-warm-artifact', 160);
    const rapid = {
      pipelineVersion: RAPID_PIPELINE_VERSION,
      status: safeText(rapidPatch.status || 'warming', 40),
      warmArtifactId,
      baseSourceRevisionHash: activeSourceRevisionHash(snapshot),
      baseSnapshotHash: hashJson(snapshot),
      selectedCardIds: Array.isArray(rapidPatch.selectedCardIds) ? rapidPatch.selectedCardIds : [],
      cardIds: Array.isArray(rapidPatch.cardIds) ? rapidPatch.cardIds : [],
      guidance: rapidPatch.guidance || {
        schema: PROMPT_GUIDANCE_SCHEMA,
        status: 'missing',
        text: '',
        sourceCardIds: [],
        guardrailCardIds: [],
        omittedCardIds: [],
        diagnostics: []
      },
      storyForm: rapidPatch.storyForm || UNKNOWN_STORY_FORM,
      ...rapidWarmContractVersions(settings),
      startedAt: safeText(rapidPatch.startedAt || nowIso(), 80),
      builtAt: safeText(rapidPatch.builtAt || '', 80),
      failedAt: safeText(rapidPatch.failedAt || '', 80),
      failureReasonCode: safeText(rapidPatch.failureReasonCode || '', 80),
      failureReasonLabel: safeText(rapidPatch.failureReasonLabel || '', 240),
      runId,
      diagnostics: mergeDiagnostics(rapidPatch.diagnostics, [`rapid-warm-${safeText(rapidPatch.status || 'warming', 40)}`])
    };
    if (rapid.status === 'ready') rapid.artifactHash = rapidArtifactHash(rapid);
    const payload = sceneCachePayload(
      snapshot,
      { cards: Array.isArray(activeVariant.cards) ? activeVariant.cards : [] },
      { cards: [], omitted: [] },
      { sceneStatus: 'same-scene' },
      null,
      settings,
      cache,
      { rapid }
    );
    if (activeVariant.latestHand) {
      payload.latestHand = activeVariant.latestHand;
      payload.variants[payload.activeSourceRevisionHash].latestHand = activeVariant.latestHand;
    }
    await runStorageSaveSection(runId, () => saveSceneCacheSafe(runId, snapshot, payload));
    return rapid;
  }

  function promptClearContext(snapshot = null) {
    if (snapshot?.chatKey) {
      return {
        chatKey: snapshot.chatKey,
        sceneKey: snapshot.sceneKey
      };
    }
    if (lastSavedSceneCacheRef?.chatKey) {
      return {
        chatKey: lastSavedSceneCacheRef.chatKey,
        sceneKey: lastSavedSceneCacheRef.sceneKey
      };
    }
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

  async function invalidateActiveSceneCacheBestEffort(reason, details = {}) {
    try {
      await storageSaveTail.catch(() => {});
    } catch {
      // Storage save failures are already normalized by their source.
    }
    if (!lastSavedSceneCacheRef || typeof storage.invalidateSceneCache !== 'function') return null;
    try {
      return await storage.invalidateSceneCache(lastSavedSceneCacheRef.chatKey, lastSavedSceneCacheRef.sceneKey, {
        reason,
        details
      });
    } catch {
      return null;
    }
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
      const currentSnapshot = snapshotForPlan(
        snapshotWithPendingUserMessage(await readSnapshot(), pendingUserMessage),
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
          `Card scope: ${JSON.stringify(cardScope)}`,
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
      }, { runId, signal, isCurrent: () => isRuntimeRunCurrent(runId) });
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
    if (settings.pipelineMode === 'fused' && typeof generationRouter.generate === 'function') {
      return runFusedCardPipeline({
        runId,
        plan,
        snapshot,
        settings,
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

    return runStandardCardPipeline({
      runId,
      plan,
      snapshot,
      settings,
      generationRouter,
      requests,
      sourceContext: cardSourceContext(snapshot),
      stageRuntimeActivity,
      signal,
      isCurrent: () => isRuntimeRunCurrent(runId)
    });
  }

  async function warmRapidSceneImpl({ reason = 'idle' } = {}) {
    const settings = settingsStore.get();
    if (settings.enabled === false || settings.pipelineMode !== 'rapid') {
      return { ok: true, skipped: true, reason: 'rapid-disabled' };
    }
    if (!generationRouter || typeof generationRouter.generate !== 'function') {
      return { ok: true, skipped: true, reason: 'rapid-utility-unavailable' };
    }
    const proseBarrier = await waitForProseEnhancementBarrier();
    if (proseBarrier?.timeout) {
      return { ok: true, skipped: true, reason: 'prose-enhancement-pending' };
    }
    await waitForExternalMutations();
    const runId = makeId('rapid-warm');
    const warmStartedAtMs = Date.now();
    let warmOutcome = supersededResult(runId);
    let snapshot = null;
    let cache = null;
    let warmingRapid = null;
    const signal = startRapidWarmRun(runId, {
      contract: rapidWarmContractVersions(settings)
    });
    startRuntimeActivity({
      runId,
      phase: 'rapidWarming',
      label: 'Rapid warming scene deck...',
      chips: ['Rapid']
    });
    try {
      snapshot = await readSnapshot();
      const warmBaseSourceRevisionHash = activeSourceRevisionHash(snapshot);
      if (runState.current().activeRapidWarmRun?.runId === runId) {
        runState.mutateRapidWarmRun((warm) => {
          warm.baseSourceRevisionHash = warmBaseSourceRevisionHash;
        });
        lastRapidWarmView = rapidWarmStatusView({
          ...lastRapidWarmView,
          baseSourceRevisionHash: warmBaseSourceRevisionHash,
          joinable: true
        });
      }
      if (!isActiveRapidWarmRun(runId)) {
        warmOutcome = supersededResult(runId);
        return warmOutcome;
      }
      lastSnapshot = snapshot;
      const fallbackPlan = localFallbackPlan(snapshot, settings);
      cache = await loadSceneCacheSafe(runId, snapshot, settings);
      if (!isActiveRapidWarmRun(runId)) {
        warmOutcome = supersededResult(runId);
        return warmOutcome;
      }
      warmingRapid = await saveRapidWarmStatus(runId, snapshot, cache, {
        status: 'warming',
        startedAt: runState.current().activeRapidWarmRun?.startedAt || nowIso(),
        diagnostics: [`rapid-warm-started:${safeText(reason, 80)}`]
      }, settings);
      if (!isActiveRapidWarmRun(runId)) {
        warmOutcome = supersededResult(runId);
        return warmOutcome;
      }
      lastRapidWarmView = rapidWarmStatusView({
        ...lastRapidWarmView,
        status: 'warming',
        warmArtifactId: warmingRapid.warmArtifactId,
        baseSourceRevisionHash: warmingRapid.baseSourceRevisionHash,
        startedAt: warmingRapid.startedAt,
        reasonCode: 'warming',
        joinable: true
      });
      let plan = await askUtilityArbiter({
        runId,
        snapshot,
        settings,
        fallbackPlan,
        sceneCache: cache,
        userMessage: '',
        signal
      });
      if (settings.storyFormOverride && settings.storyFormOverride !== 'auto') {
        const forced = forcedStoryForm(settings.storyFormOverride);
        if (forced) plan = { ...plan, storyForm: normalizeStoryForm(forced) };
      } else {
        const latestAssistant = latestVisibleAssistantEntry(snapshot);
        const latestAssistantText = latestAssistant?.message?.text || '';
        plan = { ...plan, storyForm: normalizeStoryFormWithHeuristic(plan.storyForm, UNKNOWN_STORY_FORM, latestAssistantText) };
      }
      plan = enforceReasonerAvailability(plan, settings, runtimeProviderCapability);
      plan = applyReasoningPolicyToPlan(plan, settings);
      plan = applyBehaviorPolicyToPlan(plan, settings);
      if (plan.utilityUnavailable) {
        throw new Error(plan.utilityUnavailableReason || 'Utility provider unavailable.');
      }
      const scopedCardJobs = filterCardJobsForRuntimeScope(plan.cardJobs, settings);
      const activeCacheForManual = activeSceneCacheVariant(cache, snapshot);
      const manualReconciled = reconcileManualForcedCardJobs({
        plan: { ...plan, cardJobs: scopedCardJobs.cardJobs },
        settings,
        cacheCards: cardsWithOrigin(sanitizedCacheCards(runId, snapshot, activeCacheForManual.cards), 'cache'),
        snapshot
      });
      const manualForcedFamilies = manualReconciled.forcedFamilies;
      const prioritySelection = prioritySelectionForSettings(settings);
      const forcedFamiliesForSelection = mergeForcedFamilies(prioritySelection.forcedFamilies, manualForcedFamilies);
      plan = {
        ...plan,
        cardJobs: manualReconciled.cardJobs,
        ...(manualReconciled.synthesizedFamilies.length && planAction(plan) === 'reuse-cache' ? { action: 'compose-brief' } : {}),
        budgets: settings.mode === 'manual'
          ? {
              ...asObject(plan.budgets),
              maxCards: Math.max(budgetOr(plan.budgets?.maxCards, 6), manualForcedFamilies.length)
            }
          : plan.budgets,
        diagnostics: mergeDiagnostics(
          plan.diagnostics,
          scopeOmissionReasons(scopedCardJobs.omitted),
          ...(scopedCardJobs.diagnostics || []),
          autoScopeExceptionReasons(scopedCardJobs.cardJobs, settings),
          prioritySelection.diagnostics,
          manualReconciled.diagnostics
        )
      };
      plan = budgetCardJobsForGeneration(
        plan,
        runPolicyForEffectivePlan(settings, plan),
        forcedFamiliesForSelection
      ).plan;
      lastPlan = plan;
      const warmGeneratedCardResult = await generatePlanCards({ runId, plan, snapshot, settings, signal });
      if (warmGeneratedCardResult.diagnostics.length) {
        plan = {
          ...plan,
          diagnostics: mergeDiagnostics(plan.diagnostics, warmGeneratedCardResult.diagnostics)
        };
        lastPlan = plan;
      }
      const providerCards = cardsWithOrigin(warmGeneratedCardResult.cards.map(sanitizeGeneratedCard), 'generated');
      if (!isActiveRapidWarmRun(runId)) {
        warmOutcome = supersededResult(runId);
        return warmOutcome;
      }
      const activeCache = activeSceneCacheVariant(cache, snapshot);
      const cacheCards = cardsWithOrigin(sanitizedCacheCards(runId, snapshot, activeCache.cards), 'cache');
      const fallbackCards = !cacheCards.length && !providerCards.length
        ? cardsWithOrigin(localCards(snapshot).map(sanitizeGeneratedCard), 'fallback')
        : [];
      if (fallbackCards.length) {
        plan = {
          ...plan,
          diagnostics: mergeDiagnostics(plan.diagnostics, ['rapid-warm-local-fallback-cards'])
        };
        lastPlan = plan;
      }
      const candidateCards = [...cacheCards, ...providerCards, ...fallbackCards];
      if (!candidateCards.length) {
        const failedAt = nowIso();
        const failureReasonCode = 'no-candidate-cards';
        const failureReasonLabel = rapidWarmReasonLabel(failureReasonCode);
        warmingRapid = await saveRapidWarmStatus(runId, snapshot, cache, {
          status: 'failed',
          startedAt: warmingRapid?.startedAt || runState.current().activeRapidWarmRun?.startedAt || failedAt,
          failedAt,
          failureReasonCode,
          failureReasonLabel,
          diagnostics: mergeDiagnostics(plan.diagnostics, ['rapid-warm-failed:no-candidate-cards'])
        }, settings);
        settleRuntimeActivity({
          runId,
          outcome: 'warning',
          phase: 'rapidWarmFailed',
          label: 'Rapid warm failed.',
          chips: ['Rapid']
        });
        lastRapidWarmView = rapidWarmStatusView({
          ...lastRapidWarmView,
          status: 'failed',
          warmArtifactId: warmingRapid?.warmArtifactId,
          failedAt,
          elapsedMs: Date.now() - warmStartedAtMs,
          reasonCode: failureReasonCode,
          reasonLabel: failureReasonLabel,
          joinable: false
        });
        warmOutcome = { ok: true, skipped: true, reason: 'rapid-warm-failed', plan };
        return warmOutcome;
      }
      const deck = applyCardPlan(cacheCards, {
        acceptedCards: [...fallbackCards, ...providerCards],
        lifecycle: lifecycleForDeck(
          candidateCards,
          plan,
          (card) => (providerCards.some((entry) => entry.id === card.id)
            ? 'utility generated card'
            : (fallbackCards.some((entry) => entry.id === card.id) ? 'rapid fallback warm hand' : 'rapid background warm'))
        )
      });
      const behaviorPolicy = runPolicyForEffectivePlan(settings, plan);
      const hand = selectHand(filterCardsForRuntimeScope(deck.cards, settings).cards, {
        maxCards: budgetOr(plan.budgets?.maxCards, 6),
        maxTokens: cardEvidenceTokenBudget(settings, plan, behaviorPolicy),
        behaviorPolicy,
        forcedFamilies: forcedFamiliesForSelection,
        forcedCardIds: prioritySelection.forcedCardIds
      });
      const guidance = await composeGuidanceForCards({
        hand,
        snapshot,
        settings,
        behaviorPolicy,
        generationRouter: signalAwareGenerationRouter(generationRouter, signal, runId, isActiveRapidWarmRun),
        activity,
        runId,
        storyForm: plan.storyForm || UNKNOWN_STORY_FORM
      });
      if (!isActiveRapidWarmRun(runId)) {
        warmOutcome = supersededResult(runId);
        return warmOutcome;
      }
      const rapid = {
        pipelineVersion: RAPID_PIPELINE_VERSION,
        status: 'ready',
        warmArtifactId: warmingRapid.warmArtifactId,
        baseSourceRevisionHash: activeSourceRevisionHash(snapshot),
        baseSnapshotHash: hashJson(snapshot),
        selectedCardIds: hand.cards.map((card) => card.id),
        cardIds: deck.cards.map((card) => card.id),
        guidance: {
          schema: guidance.schema,
          status: guidance.status,
          text: guidance.text,
          sourceCardIds: guidance.sourceCardIds,
          guardrailCardIds: guidance.guardrailCardIds,
          omittedCardIds: guidance.omittedCardIds,
          diagnostics: guidance.diagnostics
        },
        storyForm: plan.storyForm || UNKNOWN_STORY_FORM,
        ...rapidWarmContractVersions(settings),
        startedAt: warmingRapid.startedAt,
        builtAt: nowIso(),
        runId,
        diagnostics: mergeDiagnostics(plan.diagnostics, [`rapid-warm-v2:${safeText(reason, 80)}`])
      };
      rapid.artifactHash = rapidArtifactHash(rapid);
      await runStorageSaveSection(runId, () => saveSceneCacheSafe(
        runId,
        snapshot,
        sceneCachePayload(snapshot, deck, hand, plan, null, settings, cache, { rapid })
      ));
      if (!isActiveRapidWarmRun(runId)) {
        warmOutcome = supersededResult(runId);
        return warmOutcome;
      }
      settleRuntimeActivity({
        runId,
        outcome: 'success',
        phase: 'rapidWarmReady',
        label: 'Rapid deck ready.',
        chips: ['Rapid']
      });
      const completedAt = nowIso();
      lastRapidWarmView = rapidWarmStatusView({
        ...lastRapidWarmView,
        status: 'ready',
        warmArtifactId: rapid.warmArtifactId,
        selectedCardCount: hand.cards.length,
        cardCount: deck.cards.length,
        completedAt,
        elapsedMs: Date.now() - warmStartedAtMs,
        reasonCode: 'ready',
        reasonLabel: 'Rapid deck ready.',
        joinable: false
      });
      warmOutcome = { ok: true, rapid, hand, plan };
      return warmOutcome;
    } catch (error) {
      if (!isActiveRapidWarmRun(runId)) {
        warmOutcome = supersededResult(runId);
        return warmOutcome;
      }
      const safeError = runtimeError(error);
      let failedRapid = null;
      const failedAt = nowIso();
      if (snapshot) {
        failedRapid = await saveRapidWarmStatus(runId, snapshot, cache, {
          status: 'failed',
          warmArtifactId: warmingRapid?.warmArtifactId,
          startedAt: warmingRapid?.startedAt || lastRapidWarmView.startedAt || nowIso(),
          failedAt,
          failureReasonCode: 'warm-failed',
          failureReasonLabel: rapidWarmReasonLabel('warm-failed'),
          diagnostics: ['rapid-warm-failed']
        }, settings);
      }
      settleRuntimeActivity({
        runId,
        outcome: 'warning',
        phase: 'rapidWarmFailed',
        label: 'Rapid warm failed.',
        chips: ['Rapid'],
        detail: { message: safeError.message }
      });
      lastRapidWarmView = rapidWarmStatusView({
        ...lastRapidWarmView,
        status: 'failed',
        warmArtifactId: failedRapid?.warmArtifactId || lastRapidWarmView.warmArtifactId,
        failedAt,
        elapsedMs: Date.now() - warmStartedAtMs,
        reasonCode: 'warm-failed',
        reasonLabel: rapidWarmReasonLabel('warm-failed'),
        joinable: false
      });
      warmOutcome = { ok: true, skipped: true, reason: 'rapid-warm-failed', error: safeError };
      return warmOutcome;
    } finally {
      const activeWarm = runState.current().activeRapidWarmRun;
      if (activeWarm?.runId === runId) {
        activeWarm.resolve?.(warmOutcome);
      }
      clearRapidWarmRun(runId);
    }
  }

  async function warmRapidScene(options = {}) {
    return warmRapidPipeline({
      reason: options?.reason || 'idle',
      execute: () => warmRapidSceneImpl(options)
    });
  }

  async function installRapidPacket({
    runId,
    baseSnapshot,
    turnSnapshot,
    pendingUserMessage,
    settings,
    rapid,
    baseSourceRevisionHash,
    candidateCards,
    normalized,
    usableWarm
  }) {
    const requestedCardIds = normalized.selectedCardIds.length
      ? normalized.selectedCardIds
      : (Array.isArray(rapid?.selectedCardIds) ? rapid.selectedCardIds : []);
    const selectedCards = candidateCards.filter((card) => requestedCardIds.includes(card.id));
    const guidanceParts = [
      rapid?.guidance?.text,
      normalized.turnGuidanceText,
      ...(Array.isArray(normalized.packetInstructions) ? normalized.packetInstructions : [])
    ].map((entry) => safeText(entry, 2000)).filter(Boolean);
    const plan = {
      schema: UTILITY_ARBITER_SCHEMA,
      snapshotHash: hashJson(turnSnapshot),
      action: 'compose-brief',
      sceneStatus: 'same-scene',
      promptFootprint: promptFootprintFromSettings(settings),
      cardJobs: [],
      storyForm: rapid?.storyForm || UNKNOWN_STORY_FORM,
      budgets: {
        targetBriefTokens: 1800,
        maxCards: selectedCards.length
      },
      reasonerDecision: { mode: 'skip', reason: 'Rapid foreground uses Utility delta.', signals: ['rapid'] },
      diagnostics: mergeDiagnostics(
        ['rapid-foreground', 'rapid-warm-v2'],
        normalized.diagnostics
      )
    };
    lastPlan = plan;
    const hand = {
      handId: makeId('rapid-hand'),
      composedAt: nowIso(),
      cards: selectedCards,
      omitted: []
    };
    const freshness = await recheckPromptInstallSnapshot(runId, turnSnapshot, plan, pendingUserMessage, {
      baseSourceRevisionHash,
      allowPendingUserPrefixDrift: true
    });
    if (!isActiveRun(runId)) return supersededResult(runId);
    if (freshness.ok === false) {
      return skipPromptInstallAfterFreshnessFailure(runId, {
        reason: freshness.reason,
        sceneSnapshot: turnSnapshot,
        currentSnapshot: freshness.currentSnapshot,
        packet: null,
        hand,
        plan,
        error: freshness.error,
        comparison: freshness.comparison
      });
    }
    const promptSnapshot = freshness.snapshot;
    const packet = await composePromptPacket({
      hand,
      snapshot: promptSnapshot,
      settings,
      behaviorPolicy: runPolicyForEffectivePlan(settings, plan),
      generationRouter: null,
      activity,
      runId,
      precomposedGuidance: {
        status: 'used',
        text: guidanceParts.join('\n'),
        sourceCardIds: selectedCards.map((card) => card.id),
        guardrailCardIds: normalized.guardrailCardIds,
        diagnostics: mergeDiagnostics(rapid?.guidance?.diagnostics, normalized.diagnostics)
      },
      storyForm: rapid?.storyForm || plan.storyForm || UNKNOWN_STORY_FORM,
      pipelineMode: 'rapid',
      rapidPath: 'warm-v2',
      planDiagnostics: plan.diagnostics
    });
    if (!isActiveRun(runId)) return supersededResult(runId);
    const candidate = createPreparedGenerationCandidate(packet, hand, promptSnapshot, settings);
    if (!candidate) {
      return skipPromptInstallAfterFreshnessFailure(runId, {
        reason: 'prepared-generation-basis-unavailable',
        sceneSnapshot: promptSnapshot,
        currentSnapshot: promptSnapshot,
        packet,
        hand,
        plan
      });
    }
    const installedResult = await runPromptMutationSection(runId, async () => {
      stageRuntimeActivity({
        runId,
        phase: 'promptInstalling',
        label: 'Installing Recursion prompt...',
        chips: ['Prompt', 'Rapid']
      });
      if (!isActiveRun(runId)) return supersededResult(runId);
      const install = await installPrompt(host, packet);
      if (!isActiveRun(runId)) return supersededResult(runId);
      const installOk = install?.ok !== false;
      lastSnapshot = promptSnapshot;
      if (installOk && candidate) {
        commitPreparedGeneration(candidate);
        readyLastBrief({ runId, reason: 'rapid-packet-installed' });
      }
      else clearLastBrief({ status: 'empty', reason: 'prompt-install-failed', runId });
      await appendHandSelectedJournal(runId, promptSnapshot, hand, packet);
      await appendJournalSafe(runId, promptSnapshot.chatKey, {
        event: installOk ? 'prompt.installed' : 'prompt.install_failed',
        severity: installOk ? 'info' : 'warn',
        summary: installSummary(install),
        runId,
        sceneKey: promptSnapshot.sceneKey,
        details: {
          ...installJournalDetails(install),
          pipelineMode: 'rapid',
          rapidPath: 'warm-v2',
          baseSourceRevisionHash: safeText(rapid?.baseSourceRevisionHash || activeSourceRevisionHash(baseSnapshot), 180)
        },
        hashes: { promptPacketHash: hashJson(packet) }
      });
      if (!isActiveRun(runId)) return supersededResult(runId);
      settleRuntimeActivity({
        runId,
        outcome: installOk ? 'success' : 'warning',
        label: installOk ? 'Recursion prompt ready.' : INSTALL_FAILURE_LABEL,
        chips: ['Rapid']
      });
      return { ok: true, packet, hand, plan, install };
    });
    return installedResult;
  }

  async function prepareRapidForGeneration({
    runId,
    baseSnapshot,
    turnSnapshot,
    pendingUserMessage,
    initialCache,
    settings,
    signal
  }) {
    if (!generationRouter || typeof generationRouter.generate !== 'function') {
      settleRuntimeActivity({
        runId,
        outcome: 'warning',
        label: 'Rapid warm packet unavailable; using Standard.',
        chips: ['Rapid']
      });
      return { ok: false, escalateToStandard: true, diagnostics: ['rapid-warm-miss-standard', 'rapid-provider-unavailable'] };
    }

    const snapshotHash = hashJson(turnSnapshot);
    let baseSourceRevisionHash = activeSourceRevisionHash(baseSnapshot);
    const turnSourceRevisionHash = activeSourceRevisionHash(turnSnapshot);
    let activeVariant = activeSceneCacheVariant(initialCache, baseSnapshot);
    let rapid = activeVariant.rapid;
    let candidateCards = sanitizedCacheCards(runId, turnSnapshot, activeVariant.cards, {
      allowSparseSourceRange: true
    });
    const expectedContracts = rapidWarmContractVersions(settings);
    const rapidVariantIsUsable = (artifact, cards, expectedBaseSourceRevisionHash) => rapidWarmArtifactIsUsable(artifact, {
      baseSourceRevisionHash: expectedBaseSourceRevisionHash,
      ...expectedContracts,
      storyForm: artifact?.storyForm || UNKNOWN_STORY_FORM
    }) && cards.length > 0;
    const alternateWarmDiagnostics = [];
    function findValidatedReadyRapidVariant() {
      const variants = asObject(initialCache?.variants);
      for (const [variantHash, rawVariant] of Object.entries(variants)) {
        if (variantHash === activeVariant.sourceRevisionHash) continue;
        const variant = asObject(rawVariant);
        const artifact = variant.rapid;
        const artifactBaseSourceRevisionHash = safeText(artifact?.baseSourceRevisionHash || variantHash, 180);
        const rejectionReasons = [];
        const cards = sanitizedCacheCards(runId, turnSnapshot, variant.cards, {
          allowSparseSourceRange: true,
          allowCachedSourceFingerprint: true,
          allowCachedEvidenceRefs: true,
          rejectionReasons
        });
        const artifactUsable = rapidWarmArtifactIsUsable(artifact, {
          baseSourceRevisionHash: artifactBaseSourceRevisionHash,
          ...expectedContracts,
          storyForm: artifact?.storyForm || UNKNOWN_STORY_FORM
        });
        alternateWarmDiagnostics.push([
          'rapid-alternate',
          safeText(variantHash, 12),
          `status:${safeText(artifact?.status || '', 24)}`,
          `base:${safeText(artifactBaseSourceRevisionHash, 12)}`,
          `raw:${Array.isArray(variant.cards) ? variant.cards.length : 0}`,
          `cards:${cards.length}`,
          `artifact:${artifactUsable ? 'usable' : 'miss'}`,
          ...(rejectionReasons.length ? [`reject:${safeText(rejectionReasons[0], 80)}`] : [])
        ].join(':'));
        if (!artifactUsable || cards.length <= 0) continue;
        return {
          activeVariant: {
            sourceRevisionHash: variantHash,
            cards: Array.isArray(variant.cards) ? variant.cards : [],
            latestHand: variant.latestHand || null,
            rapid: artifact,
            exact: false
          },
          rapid: artifact,
          candidateCards: cards,
          baseSourceRevisionHash: artifactBaseSourceRevisionHash
        };
      }
      return null;
    }
    const warmMissDiagnostics = () => [
      'rapid-warm-miss-standard',
      `rapid-variant:${activeVariant.exact ? 'exact' : 'miss'}`,
      `rapid-candidate-cards:${candidateCards.length}`,
      `rapid-base:${safeText(baseSourceRevisionHash, 40)}`,
      `rapid-artifact-base:${safeText(rapid?.baseSourceRevisionHash || '', 40)}`,
      `rapid-settings:${safeText(rapid?.settingsHash || '', 12)}:${safeText(expectedContracts.settingsHash || '', 12)}`,
      `rapid-provider-contract:${safeText(rapid?.providerContractHash || '', 12)}:${safeText(expectedContracts.providerContractHash || '', 12)}`,
      `rapid-card-catalog:${safeText(rapid?.cardCatalogHash || '', 12)}:${safeText(expectedContracts.cardCatalogHash || '', 12)}`,
      `rapid-prompt-contract:${safeText(rapid?.promptContractHash || '', 12)}:${safeText(expectedContracts.promptContractHash || '', 12)}`,
      ...alternateWarmDiagnostics.slice(0, 8)
    ];
    function buildRapidWarmMissSnapshot({
      reasonCode,
      reasonLabel,
      joinAttempted = false,
      joinTimedOut = false
    } = {}) {
      return rapidWarmMissSnapshot({
        reasonCode,
        reasonLabel,
        exactVariant: activeVariant.exact,
        joinAttempted,
        joinTimedOut,
        activeWarmRunPresent: Boolean(runState.current().activeRapidWarmRun),
        activeWarmRunBaseKnown: Boolean(runState.current().activeRapidWarmRun?.baseSourceRevisionHash),
        candidateCardCount: candidateCards.length,
        selectedCardCount: Array.isArray(rapid?.selectedCardIds) ? rapid.selectedCardIds.length : 0,
        diagnostics: warmMissDiagnostics()
      });
    }
    async function appendRapidWarmMissJournal(missSnapshot) {
      await appendJournalSafe(runId, turnSnapshot.chatKey, {
        event: 'rapid.warm_missed',
        severity: 'warn',
        summary: 'Rapid warm missed; Standard started.',
        runId,
        sceneKey: turnSnapshot.sceneKey,
        details: missSnapshot,
        hashes: {
          baseSourceRevisionHash: safeText(baseSourceRevisionHash, 180),
          turnSourceRevisionHash: safeText(turnSourceRevisionHash, 180)
        }
      });
    }
    let usableWarm = rapidVariantIsUsable(rapid, candidateCards, baseSourceRevisionHash);
    if (!usableWarm) {
      const alternateWarm = findValidatedReadyRapidVariant();
      if (alternateWarm) {
        activeVariant = alternateWarm.activeVariant;
        rapid = alternateWarm.rapid;
        candidateCards = alternateWarm.candidateCards;
        baseSourceRevisionHash = alternateWarm.baseSourceRevisionHash;
        usableWarm = true;
      }
    }
    if (!usableWarm) {
      const miss = rapidWarmMissReason({
        activeVariant,
        rapid,
        candidateCards,
        expectedContracts,
        baseSourceRevisionHash
      });
      const waitedWarm = await waitForRapidWarmBaseSource(runId, expectedContracts);
      if (!isActiveRun(runId)) return supersededResult(runId);
      const joinableWarm = exactWarmRunForSource(baseSourceRevisionHash, expectedContracts)
        || rapidWarmRunMatchesSource(waitedWarm, baseSourceRevisionHash, expectedContracts);
      if (joinableWarm) {
        const joined = await waitForRapidWarm(runId, joinableWarm, rapidWarmJoinWaitMs);
        if (!isActiveRun(runId)) return supersededResult(runId);
        if (joined?.ok === true) {
          const reloadedCache = await loadSceneCacheSafe(runId, baseSnapshot, settings);
          if (!isActiveRun(runId)) return supersededResult(runId);
          return prepareRapidForGeneration({
            runId,
            baseSnapshot,
            turnSnapshot,
            pendingUserMessage,
            initialCache: reloadedCache,
            settings,
            signal
          });
        }
        const missSnapshot = buildRapidWarmMissSnapshot({
          reasonCode: joined.reasonCode || 'warm-failed',
          reasonLabel: rapidWarmReasonLabel(joined.reasonCode || 'warm-failed'),
          joinAttempted: true,
          joinTimedOut: joined.reasonCode === 'warm-timeout'
        });
        lastRapidWarmView = rapidWarmStatusView({
          ...lastRapidWarmView,
          status: 'missed',
          reasonCode: missSnapshot.reasonCode,
          reasonLabel: missSnapshot.reasonLabel,
          elapsedMs: rapidWarmElapsedFromView(),
          joinable: false
        });
        stageRuntimeActivity({
          runId,
          phase: 'rapidWarmMissStandard',
          label: 'Rapid warm missed; Standard started.',
          chips: ['Rapid', 'Standard'],
          detail: missSnapshot
        });
        await appendRapidWarmMissJournal(missSnapshot);
        return {
          ok: false,
          escalateToStandard: true,
          diagnostics: [...missSnapshot.diagnostics, `rapid-warm-miss:${missSnapshot.reasonCode}`]
        };
      }
      const missSnapshot = buildRapidWarmMissSnapshot({
        reasonCode: miss.code,
        reasonLabel: miss.label,
        joinAttempted: Boolean(joinableWarm),
        joinTimedOut: false
      });
      lastRapidWarmView = rapidWarmStatusView({
        ...lastRapidWarmView,
        status: 'missed',
        reasonCode: missSnapshot.reasonCode,
        reasonLabel: missSnapshot.reasonLabel,
        elapsedMs: rapidWarmElapsedFromView(),
        joinable: false
      });
      stageRuntimeActivity({
        runId,
        phase: 'rapidWarmMissStandard',
        label: 'Rapid warm missed; Standard started.',
        chips: ['Rapid', 'Standard'],
        detail: missSnapshot
      });
      await appendRapidWarmMissJournal(missSnapshot);
      return {
        ok: false,
        escalateToStandard: true,
        diagnostics: [...missSnapshot.diagnostics, `rapid-warm-miss:${missSnapshot.reasonCode}`]
      };
    }
    const selectedWarmCards = candidateCards.filter((card) => (rapid.selectedCardIds || []).includes(card.id));
    if (!selectedWarmCards.length) {
      const missSnapshot = buildRapidWarmMissSnapshot({
        reasonCode: 'selected-card-miss',
        reasonLabel: rapidWarmReasonLabel('selected-card-miss')
      });
      lastRapidWarmView = rapidWarmStatusView({
        ...lastRapidWarmView,
        status: 'missed',
        reasonCode: missSnapshot.reasonCode,
        reasonLabel: missSnapshot.reasonLabel,
        elapsedMs: rapidWarmElapsedFromView(),
        joinable: false
      });
      stageRuntimeActivity({
        runId,
        phase: 'rapidWarmMissStandard',
        label: 'Rapid warm missed; Standard started.',
        chips: ['Rapid', 'Standard'],
        detail: missSnapshot
      });
      await appendRapidWarmMissJournal(missSnapshot);
      return {
        ok: false,
        escalateToStandard: true,
        diagnostics: [...missSnapshot.diagnostics, 'rapid-selected-card-miss']
      };
    }
    const rapidForegroundResult = await runRapidForegroundPipeline({
      generationRouter,
      hedgeDelayMs: rapidHedgeDelayMs,
      runId,
      snapshotHash,
      baseSourceRevisionHash,
      turnSourceRevisionHash,
      pendingUserMessage,
      rapid,
      selectedWarmCards,
      storyForm: rapid?.storyForm || UNKNOWN_STORY_FORM,
      stageRuntimeActivity,
      settleRuntimeActivity,
      signal,
      isCurrent: () => isActiveRun(runId),
      safeText
    });
    if (!isActiveRun(runId)) return supersededResult(runId);
    if (rapidForegroundResult?.escalateToStandard === true || rapidForegroundResult?.ok !== true) return rapidForegroundResult;
    return installRapidPacket({
      runId,
      baseSnapshot,
      turnSnapshot,
      pendingUserMessage,
      settings,
      rapid,
      baseSourceRevisionHash,
      candidateCards: selectedWarmCards,
      normalized: rapidForegroundResult.normalized,
      usableWarm
    });
  }

  function preparedGenerationBasisForAttempt(snapshot, {
    swipe = false,
    swipeMessageId = null,
    pendingUserMessage = null,
    settings
  } = {}) {
    return swipe
      ? generationBasisForLatestAssistantSwipe(snapshot, swipeMessageId, settings)
      : generationBasisForSnapshot(
          snapshotWithPendingUserMessage(snapshot, pendingUserMessage),
          settings
        );
  }

  async function reinstallPreparedGeneration(runId, {
    artifact,
    settings,
    swipe = false,
    swipeMessageId = null,
    pendingUserMessage = null,
    basisMode = 'exact'
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
        currentSnapshot = await readSnapshot();
        currentBasis = preparedGenerationBasisForAttempt(currentSnapshot, {
          swipe,
          swipeMessageId,
          pendingUserMessage,
          settings
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
    const pipelineMode = safeText(artifact?.packet?.diagnostics?.pipelineMode || 'standard', 40);
    if (pipelineMode === 'rapid') return ['rapidTurnDelta'];
    const roles = ['utilityArbiter'];
    if (pipelineMode === 'fused') roles.push('fusedCardBundle');
    else if ((artifact?.hand?.cards?.length || 0) > 0) roles.push('standardCardCalls');
    if (artifact?.packet?.diagnostics?.composerLane === 'reasoner') roles.push('reasonerComposer');
    return roles;
  }

  async function tryPreparedGenerationReuse(runId, {
    basis,
    settings,
    swipe = false,
    swipeMessageId = null,
    pendingUserMessage = null,
    forceFresh = false
  } = {}) {
    const contract = preparedGenerationContract(settings);
    const decision = validatePreparedGenerationArtifact(lastPreparedGeneration, {
      basis,
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
      basisMode: decision.basisMode
    });
  }

  async function prepareForGeneration({ userMessage = '', refreshReason = '', hostGeneration = false, generationType = '' } = {}) {
    const settings = settingsStore.get();
    const hostGenerationType = safeText(generationType, 40).toLowerCase();
    const explicitSwipe = hostGeneration === true && hostGenerationType === 'swipe';
    const explicitRegenerate = hostGeneration === true && hostGenerationType === 'regenerate';
    if (hostGeneration === true && activeProseEnhancementPromise) {
      await cancelActiveProseEnhancement(explicitSwipe ? 'latest-assistant-swipe' : 'new-host-generation');
    }
    setHostGenerationActive(hostGeneration);
    if (settings.enabled === false) {
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
      return { ok: true, skipped: true, reason: 'disabled', clear };
    }

    await waitForExternalMutations();
    let pendingUserMessage = normalizePendingUserMessage(userMessage);
    const runId = makeId('run');
    if (hostGeneration === true) armProseEnhancementForHostGeneration(settings, runId);
    else clearPendingProseEnhancement();
    const signal = startRun(runId);
    if (explicitSwipe) {
      // SillyTavern's swipe interceptor payload can end on the preceding user row
      // while the authoritative host snapshot still contains the assistant row.
      pendingUserMessage = normalizePendingUserMessage('');
    }
    const freshContext = hostGeneration === true
      ? consumePendingFreshNextGeneration(runId)
      : null;
    const freshReason = freshContext
      ? 'user-fresh-next-generation'
      : (explicitRegenerate ? 'host-regenerate' : '');
    const modeChip = settings.mode === 'manual' ? 'Manual' : 'Auto';
    startRuntimeActivity({ runId, label: 'Reading current turn...', chips: [modeChip] });
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
    if (explicitSwipe && !runState.current().pendingLatestAssistantSwipeRetry) {
      // SillyTavern passes `swipe` directly to the interceptor after changing the active swipe.
      // This is the authoritative signal; MESSAGE_SWIPED remains only a UI/navigation fallback.
      markLatestAssistantSwipeRetry({ eventName: 'host-generation-swipe' });
    }
    const hasSwipeRetry = explicitSwipe || Boolean(runState.current().pendingLatestAssistantSwipeRetry);
    if (lastBrief.status !== 'clearing') {
      clearLastBrief({
        status: 'clearing',
        reason: freshReason || (hasSwipeRetry ? 'latest-assistant-swipe' : (refreshReason || 'generation-started')),
        runId
      });
    }
    try {
      const hostSnapshot = await readSnapshot();
      if (!pendingUserMessage.text && hostGeneration === true) {
        const latest = latestVisibleMessage(hostSnapshot);
        if (latest?.role === 'user' && safeText(latest.text || '', PROVIDER_MESSAGE_TEXT_LIMIT)) {
          pendingUserMessage = normalizePendingUserMessage({
            text: latest.text,
            mesid: latest.mesid
          });
        }
      }
      const bypassSwipeReuse = Boolean(refreshReason || freshContext || explicitRegenerate);
      const baseSnapshot = settings.pipelineMode === 'rapid' && !bypassSwipeReuse
        ? snapshotWithoutVisiblePendingUserMessage(hostSnapshot, pendingUserMessage)
        : hostSnapshot;
      const snapshot = snapshotWithPendingUserMessage(baseSnapshot, pendingUserMessage);
      if (!isActiveRun(runId)) return supersededResult(runId);
      runState.beginAttempt?.({
        runId,
        kind: (freshContext || explicitRegenerate) ? 'fresh' : (hasSwipeRetry ? 'swipe' : 'normal'),
        sourceRevisionHash: activeSourceRevisionHash(snapshot),
        packetId: preparedPacket()?.packetId
      });
      const swipeRetry = hasSwipeRetry && !bypassSwipeReuse
        ? runState.takeLatestAssistantSwipeRetry()
        : null;
      if (bypassSwipeReuse) {
        clearPendingLatestAssistantSwipeRetry();
        recordCacheDecision(runId, {
          decision: 'bypassed',
          kind: 'prepared-generation',
          reason: explicitRegenerate ? 'explicit-regenerate' : 'force-fresh'
        });
      } else if (hasSwipeRetry) {
        const swipeMessageId = finiteNumberOrNull(swipeRetry?.messageId);
        const swipeBasis = generationBasisForLatestAssistantSwipe(
          hostSnapshot,
          swipeMessageId,
          settings
        );
        if (!swipeBasis) {
          recordCacheDecision(runId, {
            decision: 'miss',
            kind: 'prepared-generation',
            reason: 'swipe-basis-unavailable'
          });
        } else {
          const reuse = await tryPreparedGenerationReuse(runId, {
            basis: swipeBasis,
            settings,
            swipe: true,
            swipeMessageId
          });
          if (reuse.reused || reuse.preparedMatch) return reuse;
        }
      } else {
        const directBasis = generationBasisForSnapshot(snapshot, settings);
        const reuse = await tryPreparedGenerationReuse(runId, {
          basis: directBasis,
          settings,
          pendingUserMessage
        });
        if (reuse.reused || reuse.preparedMatch) return reuse;
      }
      clearPendingLatestAssistantSwipeRetry();
      lastSnapshot = snapshot;
      const invalidationReason = freshReason || refreshReason;
      if (invalidationReason && typeof storage.invalidateSceneCache === 'function') {
        await runStorageSaveSection(runId, async () => {
          try {
            return await storage.invalidateSceneCache(snapshot.chatKey, snapshot.sceneKey, {
              reason: invalidationReason,
              runId,
              details: freshContext
                ? freshNextGenerationDetails(freshContext, snapshot)
                : { latestMesId: snapshot.latestMesId }
            });
          } catch {
            // Refresh invalidation is best-effort; missing caches and storage failures should not block preparation.
            return null;
          }
        });
        if (!isActiveRun(runId)) return supersededResult(runId);
      }
      const rapidForeground = settings.pipelineMode === 'rapid' && !bypassSwipeReuse;
      const rapidCacheSnapshot = rapidForeground ? baseSnapshot : snapshot;
      let initialCache = freshStaleSceneCache(await loadSceneCacheSafe(runId, rapidCacheSnapshot, settings), freshContext, rapidCacheSnapshot);
      if (!isActiveRun(runId)) return supersededResult(runId);
      let rapidEscalationDiagnostics = [];
      if (rapidForeground) {
        const rapidResult = await prepareRapidForGeneration({
          runId,
          baseSnapshot,
          turnSnapshot: snapshot,
          pendingUserMessage,
          initialCache,
          settings,
          signal
        });
        if (!isActiveRun(runId)) return supersededResult(runId);
        if (rapidResult?.escalateToStandard !== true) return rapidResult;
        rapidEscalationDiagnostics = Array.isArray(rapidResult.diagnostics)
          ? rapidResult.diagnostics
          : ['rapid-escalated-standard:mandatory-gap'];
        initialCache = freshStaleSceneCache(await loadSceneCacheSafe(runId, snapshot, settings), freshContext, snapshot);
        if (!isActiveRun(runId)) return supersededResult(runId);
      }
      const freshDiagnostics = freshContext
        ? [
            'fresh-next-generation:user-requested',
            'fresh-next-generation:cache-bypassed',
            ...(settings.pipelineMode === 'rapid' ? ['fresh-next-generation:rapid-bypassed'] : [])
          ]
        : [];
      const fallbackPlan = localFallbackPlan(snapshot, settings);
      fallbackPlan.source = {
        ...fallbackPlan.source,
        userMessageHash: hashJson(pendingUserMessage.text),
        catalogHash: hashJson(CARD_CATALOG)
      };
      const arbiterSnapshot = snapshotWithoutVisiblePendingUserMessage(snapshot, pendingUserMessage);
      const latestAssistant = latestVisibleAssistantEntry(arbiterSnapshot);
      const latestAssistantText = latestAssistant?.message?.text || '';
      let plan = await askUtilityArbiter({
        runId,
        snapshot: arbiterSnapshot,
        settings,
        fallbackPlan,
        sceneCache: initialCache,
        userMessage: pendingUserMessage.text,
        signal
      });
      if (settings.storyFormOverride && settings.storyFormOverride !== 'auto') {
        const forced = forcedStoryForm(settings.storyFormOverride);
        if (forced) plan = { ...plan, storyForm: normalizeStoryForm(forced) };
      } else {
        plan = { ...plan, storyForm: normalizeStoryFormWithHeuristic(plan.storyForm, UNKNOWN_STORY_FORM, latestAssistantText) };
      }
      plan = enforceReasonerAvailability(plan, settings, runtimeProviderCapability);
      plan = applyReasoningPolicyToPlan(plan, settings);
      plan = applyBehaviorPolicyToPlan(plan, settings);
      const scopedCardJobs = filterCardJobsForRuntimeScope(plan.cardJobs, settings);
      const activeCacheForManual = activeSceneCacheVariant(initialCache, snapshot);
      const manualReconciled = reconcileManualForcedCardJobs({
        plan: { ...plan, cardJobs: scopedCardJobs.cardJobs },
        settings,
        cacheCards: cardsWithOrigin(sanitizedCacheCards(runId, snapshot, activeCacheForManual.cards), 'cache'),
        forceContext: freshContext,
        snapshot
      });
      const manualForcedFamilies = manualReconciled.forcedFamilies;
      const prioritySelection = prioritySelectionForSettings(settings);
      const forcedFamiliesForSelection = mergeForcedFamilies(prioritySelection.forcedFamilies, manualForcedFamilies);
      plan = {
        ...plan,
        cardJobs: manualReconciled.cardJobs,
        ...(manualReconciled.synthesizedFamilies.length && planAction(plan) === 'reuse-cache' ? { action: 'compose-brief' } : {}),
        budgets: settings.mode === 'manual'
          ? {
              ...asObject(plan.budgets),
              maxCards: Math.max(budgetOr(plan.budgets?.maxCards, 6), manualForcedFamilies.length)
            }
          : plan.budgets,
        diagnostics: mergeDiagnostics(
          plan.diagnostics,
          rapidEscalationDiagnostics,
          freshDiagnostics,
          scopeOmissionReasons(scopedCardJobs.omitted),
          ...(scopedCardJobs.diagnostics || []),
          autoScopeExceptionReasons(scopedCardJobs.cardJobs, settings),
          prioritySelection.diagnostics,
          manualReconciled.diagnostics
        )
      };
      plan = budgetCardJobsForGeneration(
        plan,
        runPolicyForEffectivePlan(settings, plan),
        forcedFamiliesForSelection
      ).plan;
      if (!isActiveRun(runId)) return supersededResult(runId);
      lastPlan = plan;
      const sceneSnapshot = snapshotForPlan(snapshot, plan);
      if (sceneSnapshot !== snapshot) {
        lastSnapshot = sceneSnapshot;
      }
      if (freshContext && planAction(plan) === 'reuse-cache') {
        plan = {
          ...plan,
          action: 'compose-brief',
          diagnostics: mergeDiagnostics(plan.diagnostics, ['fresh-next-generation:reuse-cache-overridden'])
        };
        lastPlan = plan;
      }
      const action = planAction(plan);
      if (action === 'skip') {
        const clear = await runPromptMutationSection(runId, async () => {
          const result = await clearPromptBestEffort(host);
          if (result?.superseded) return result;
          if (!isActiveRun(runId)) return supersededResult(runId);
          await appendPromptClearedJournal(runId, promptClearContext(sceneSnapshot), result, 'arbiter-skip');
          return result;
        });
        if (clear?.superseded) return clear;
        if (!isActiveRun(runId)) return supersededResult(runId);
        if (clear?.ok === false) {
          reportClearWarning(runId, clear);
        } else {
          settleRuntimeActivity({
            runId,
            outcome: 'success',
            label: 'Recursion skipped by Utility Arbiter.'
          });
        }
        return { ok: true, skipped: true, reason: 'arbiter-skip', plan, clear };
      }

      const cache = sceneSnapshot.chatKey === snapshot.chatKey && sceneSnapshot.sceneKey === snapshot.sceneKey
        ? initialCache
        : freshStaleSceneCache(await loadSceneCacheSafe(runId, sceneSnapshot, settings), freshContext, sceneSnapshot);
      if (!isActiveRun(runId)) return supersededResult(runId);
      const scopedCardOmissionDiagnostics = [];
      const filterScopedCards = (cards) => {
        const scoped = filterCardsForRuntimeScope(cards, settings);
        scopedCardOmissionDiagnostics.push(
          ...scopeOmissionReasons(scoped.omitted),
          ...autoScopeExceptionReasons(scoped.cards, settings)
        );
        return scoped.cards;
      };
      const activeCache = activeSceneCacheVariant(cache, sceneSnapshot);
      const cacheCards = freshContext
        ? []
        : filterScopedCards(cardsWithOrigin(sanitizedCacheCards(runId, sceneSnapshot, activeCache.cards), 'cache'));
      const reuseCacheOnly = !freshContext && action === 'reuse-cache' && cacheCards.length > 0;
      stageRuntimeActivity({
        runId,
        phase: reuseCacheOnly ? 'cacheReusing' : 'cardBatchRunning',
        label: reuseCacheOnly ? 'Reusing scene deck...' : 'Generating scene cards...',
        cardCounts: { requested: plan.cardJobs?.length || 0 },
        chips: ['Cards']
      });
      recordCacheDecision(runId, {
        decision: reuseCacheOnly ? 'hit' : 'miss',
        kind: 'scene-cards',
        reason: reuseCacheOnly ? 'arbiter-reuse-cache' : (action === 'reuse-cache' ? 'cache-unavailable' : 'card-generation-required'),
        variant: activeSceneCacheVariant(cache, sceneSnapshot).exact ? 'exact' : 'miss',
        reusedCardIds: reuseCacheOnly ? cacheCards.map((card) => card.id) : [],
        providerCallsSkipped: reuseCacheOnly
          ? settings.pipelineMode === 'fused'
            ? ['standardCardCalls', 'fusedCardBundle', 'guidanceComposer']
            : ['standardCardCalls', 'guidanceComposer']
          : []
      });
      const generatedCardResult = reuseCacheOnly
        ? { cards: [], diagnostics: [] }
        : await generatePlanCards({ runId, plan, snapshot: sceneSnapshot, settings, signal });
      if (generatedCardResult.diagnostics.length) {
        plan = {
          ...plan,
          diagnostics: mergeDiagnostics(plan.diagnostics, generatedCardResult.diagnostics)
        };
        lastPlan = plan;
      }
      const providerCards = reuseCacheOnly ? [] : filterScopedCards(
        cardsWithOrigin(generatedCardResult.cards.map(sanitizeGeneratedCard), 'generated')
      );
      if (!isActiveRun(runId)) return supersededResult(runId);
      const useLocalFallbackCards = !reuseCacheOnly && !cacheCards.length && !providerCards.length;
      const generatedCards = useLocalFallbackCards ? filterScopedCards(cardsWithOrigin(localCards(sceneSnapshot).map(sanitizeGeneratedCard), 'fallback')) : [];
      if (scopedCardOmissionDiagnostics.length) {
        plan = {
          ...plan,
          diagnostics: mergeDiagnostics(plan.diagnostics, scopedCardOmissionDiagnostics)
        };
        lastPlan = plan;
      }
      const sourceCardsByFamily = activeCardDeckSourceCards(settings);
      stageCardProgress(runId, cacheCards, {
        source: 'cache',
        state: 'cached',
        sourceCardsByFamily,
        parentStepId: settings.pipelineMode === 'fused' && !reuseCacheOnly ? 'fused-card-bundle' : undefined
      });
      stageCardProgress(runId, providerCards, { source: 'generated', state: 'done', sourceCardsByFamily });
      stageCardProgress(runId, generatedCards, { source: 'fallback', state: 'warning', sourceCardsByFamily });
      if (action === 'reuse-cache' && !cacheCards.length) {
        const clear = await runPromptMutationSection(runId, async () => {
          const result = await clearPromptBestEffort(host);
          if (result?.superseded) return result;
          if (!isActiveRun(runId)) return supersededResult(runId);
          await appendPromptClearedJournal(runId, promptClearContext(sceneSnapshot), result, 'cache-unavailable');
          return result;
        });
        if (clear?.superseded) return clear;
        if (!isActiveRun(runId)) return supersededResult(runId);
        if (clear?.ok === false) {
          reportClearWarning(runId, clear);
        } else {
          settleRuntimeActivity({
            runId,
            outcome: 'warning',
            label: plan.utilityUnavailable
              ? 'Utility unavailable. Recursion skipped.'
              : 'Recursion skipped: no reusable scene hand.'
          });
        }
        return { ok: true, skipped: true, reason: plan.utilityUnavailable ? 'utility-unavailable' : 'cache-unavailable', plan, clear };
      }
      const candidateCards = reuseCacheOnly ? cacheCards : [...cacheCards, ...providerCards, ...generatedCards];
      const deck = applyCardPlan(cacheCards, {
        acceptedCards: [...generatedCards, ...providerCards],
        lifecycle: lifecycleForDeck(
          candidateCards,
          plan,
          (card) => (reuseCacheOnly
            ? 'reused scene cache'
            : (providerCards.some((entry) => entry.id === card.id)
                ? 'utility generated card'
                : (generatedCards.some((entry) => entry.id === card.id) ? 'current fallback hand' : 'scene cache')))
        )
      });
      if (!isActiveRun(runId)) return supersededResult(runId);
      const effectiveSettings = settingsForPlan(settings, plan, runtimeProviderCapability);
      const behaviorPolicy = runPolicyForEffectivePlan(settings, plan);

      stageRuntimeActivity({
        runId,
        phase: 'handSelected',
        label: 'Selecting turn hand...',
        cardCounts: { selected: Math.min(deck.cards.length, budgetOr(plan.budgets?.maxCards, 6)) }
      });
      let promptSnapshot = sceneSnapshot;
      let promptDeck = deck;
      let hand = selectHand(filterCardsForRuntimeScope(deck.cards, settings).cards, {
        maxCards: budgetOr(plan.budgets?.maxCards, 6),
        maxTokens: cardEvidenceTokenBudget(settings, plan, behaviorPolicy),
        behaviorPolicy,
        forcedFamilies: forcedFamiliesForSelection,
        forcedCardIds: prioritySelection.forcedCardIds
      });

      const freshness = await recheckPromptInstallSnapshot(runId, sceneSnapshot, plan, pendingUserMessage);
      if (!isActiveRun(runId)) return supersededResult(runId);
      if (freshness.ok === false) {
        return await skipPromptInstallAfterFreshnessFailure(runId, {
          reason: freshness.reason,
          sceneSnapshot,
          currentSnapshot: freshness.currentSnapshot,
          hand,
          plan,
          error: freshness.error,
          comparison: freshness.comparison
        });
      }
      promptSnapshot = freshness.snapshot;
      if (promptSnapshot.sceneKey !== sceneSnapshot.sceneKey || promptSnapshot.sceneFingerprint !== sceneSnapshot.sceneFingerprint) {
        promptDeck = {
          ...deck,
          cards: rebaseCardsForSnapshot(deck.cards, promptSnapshot, plan)
        };
        hand = selectHand(filterCardsForRuntimeScope(promptDeck.cards, settings).cards, {
          maxCards: budgetOr(plan.budgets?.maxCards, 6),
          maxTokens: cardEvidenceTokenBudget(settings, plan, behaviorPolicy),
          behaviorPolicy,
          forcedFamilies: forcedFamiliesForSelection,
          forcedCardIds: prioritySelection.forcedCardIds
        });
      }
      lastSnapshot = promptSnapshot;

      await runStorageSaveSection(runId, () => saveSceneCacheSafe(
        runId,
        promptSnapshot,
        sceneCachePayload(promptSnapshot, promptDeck, hand, plan, null, settings, cache)
      ));
      if (!isActiveRun(runId)) return supersededResult(runId);

      let packet = await composePromptPacket({
        hand,
        snapshot: promptSnapshot,
        settings: effectiveSettings,
        behaviorPolicy,
        generationRouter: signalAwareGenerationRouter(generationRouter, signal, runId, isActiveRun),
        activity,
        runId,
        signal,
        storyForm: plan.storyForm || UNKNOWN_STORY_FORM,
        pipelineMode: settings.pipelineMode === 'fused' ? 'fused' : 'standard',
        planDiagnostics: plan.diagnostics
      });
      if (!isActiveRun(runId)) return supersededResult(runId);

      if (!isActiveRun(runId)) return supersededResult(runId);
      const installedResult = await runPromptMutationSection(runId, async () => {
        stageRuntimeActivity({
          runId,
          phase: 'promptInstalling',
          label: 'Installing Recursion prompt...',
          chips: ['Prompt']
        });
        if (!isActiveRun(runId)) return supersededResult(runId);
        let recomposeAttempts = 0;
        while (true) {
          const freshness = await recheckPromptInstallSnapshot(runId, promptSnapshot, plan, pendingUserMessage);
          if (!isActiveRun(runId)) return supersededResult(runId);
          if (freshness.ok === false) {
            return skipPromptInstallAfterFreshnessFailure(runId, {
              reason: freshness.reason,
              sceneSnapshot: promptSnapshot,
              currentSnapshot: freshness.currentSnapshot,
              packet,
              hand,
              plan,
              error: freshness.error,
              comparison: freshness.comparison
            });
          }
          if (promptSnapshotMetadataMatches(promptSnapshot, freshness.snapshot)) break;
          recomposeAttempts += 1;
          if (recomposeAttempts > 3) {
            return skipPromptInstallAfterFreshnessFailure(runId, {
              reason: 'stale-snapshot',
              sceneSnapshot: promptSnapshot,
              currentSnapshot: freshness.snapshot,
              packet,
              hand,
              plan
            });
          }
          promptSnapshot = freshness.snapshot;
          promptDeck = {
            ...promptDeck,
            cards: rebaseCardsForSnapshot(promptDeck.cards, promptSnapshot, plan)
          };
          hand = selectHand(filterCardsForRuntimeScope(promptDeck.cards, settings).cards, {
            maxCards: budgetOr(plan.budgets?.maxCards, 6),
            maxTokens: cardEvidenceTokenBudget(settings, plan, behaviorPolicy),
            behaviorPolicy,
            forcedFamilies: forcedFamiliesForSelection,
            forcedCardIds: prioritySelection.forcedCardIds
          });
          await runStorageSaveSection(runId, () => saveSceneCacheSafe(
            runId,
            promptSnapshot,
            sceneCachePayload(promptSnapshot, promptDeck, hand, plan, null, settings, cache)
          ));
          if (!isActiveRun(runId)) return supersededResult(runId);
          packet = await composePromptPacket({
            hand,
            snapshot: promptSnapshot,
            settings: effectiveSettings,
            behaviorPolicy,
            generationRouter: signalAwareGenerationRouter(generationRouter, signal, runId, isActiveRun),
            activity,
            runId,
            signal,
            storyForm: plan.storyForm || UNKNOWN_STORY_FORM,
            pipelineMode: settings.pipelineMode === 'fused' ? 'fused' : 'standard',
            planDiagnostics: plan.diagnostics
          });
          if (!isActiveRun(runId)) return supersededResult(runId);
          lastSnapshot = promptSnapshot;
        }
        const candidate = createPreparedGenerationCandidate(packet, hand, promptSnapshot, settings);
        if (!candidate) {
          return skipPromptInstallAfterFreshnessFailure(runId, {
            reason: 'prepared-generation-basis-unavailable',
            sceneSnapshot: promptSnapshot,
            currentSnapshot: promptSnapshot,
            packet,
            hand,
            plan
          });
        }
        const install = await installPrompt(host, packet);
        if (!isActiveRun(runId)) return supersededResult(runId);
        const installOk = install?.ok !== false;
        if (installOk && candidate) {
          commitPreparedGeneration(candidate);
          readyLastBrief({
            runId,
            reason: freshContext ? 'fresh-next-generation-installed' : 'packet-installed'
          });
        } else {
          clearLastBrief({ status: 'empty', reason: 'prompt-install-failed', runId });
        }
        await appendHandSelectedJournal(runId, promptSnapshot, hand, packet);
        await appendJournalSafe(runId, promptSnapshot.chatKey, {
          event: installOk ? 'prompt.installed' : 'prompt.install_failed',
          severity: installOk ? 'info' : 'warn',
          summary: installSummary(install),
          runId,
          sceneKey: promptSnapshot.sceneKey,
          details: installJournalDetails(install),
          hashes: { promptPacketHash: hashJson(packet) }
        });
        await runStorageSaveSection(runId, () => saveSceneCacheSafe(
          runId,
          promptSnapshot,
          sceneCachePayload(promptSnapshot, promptDeck, hand, plan, packet, settings, cache)
        ));
        if (!isActiveRun(runId)) return supersededResult(runId);
        settleRuntimeActivity({
          runId,
          outcome: installOk ? 'success' : 'warning',
          label: installOk ? 'Recursion prompt ready.' : INSTALL_FAILURE_LABEL
        });
        return { ok: true, packet, hand, plan, install };
      });
      return installedResult;
    } catch (error) {
      if (!isActiveRun(runId)) return supersededResult(runId);
      const safeError = runtimeError(error);
      settleRuntimeActivity({
        runId,
        outcome: 'error',
        label: 'Recursion runtime failed.',
        detail: { message: safeError.message }
      });
      throw safeError;
    } finally {
      clearActiveRun(runId);
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
        runId,
        timeoutMs: GENERATION_REVIEW_TIMEOUT_MS,
        retryCount: 0
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

  return {
    storage,
    prepareForGeneration,
    warmRapidScene,
    requestFreshNextGeneration,
    clearFreshNextGeneration,
    async dispose() {
      supersedeActiveRun();
      abortActiveRapidWarmRun('stale');
      clearPendingFreshNextGeneration();
      await waitForExternalMutations();
      clearPreparedGeneration();
      if (host && typeof host === 'object') {
        if (previousProviderAuthFailureHandler === undefined) delete host.handleProviderAuthFailure;
        else host.handleProviderAuthFailure = previousProviderAuthFailureHandler;
      }
    },
    async refreshScene() {
      return prepareForGeneration({ refreshReason: 'user-refresh' });
    },
    handleChatChanged,
    handleSourceChanged,
    handleLatestAssistantSwipeRetry: markLatestAssistantSwipeRetry,
    handleHostGenerationStopped,
    handleHostGenerationEnded,
    enhanceLatestAssistantMessage,
    proseEnhancementPending,
    proseEnhancementRunning,
    holdPendingProseEnhancementMessage,
    recoverHeldProseEnhancementMessages,
    stopGeneration,
    updateSettings,
    resetSettingsMenu,
    updateProviderConfig,
    clearProviderKey,
    fetchProviderModels,
    testProvider,
    providerOperationState,
    providerCapability: providerCapabilityView,
    evaluateRedirectEffectiveness,
    recommendCardDraft,
    listProviderConnectionProfiles: listProviderConnectionProfilesForUi,
    resetSceneCache,
    clearRunJournal,
    exportDiagnostics,
    view() {
      return safeRuntimeView();
    }
  };
}
