import { createActivityReporter } from './activity.mjs';
import { CARD_CATALOG, applyCardPlan, buildCardRequests, cardsFromProviderResult, normalizeCard, selectHand } from './cards.mjs';
import {
  cardScopeSummary,
  filterCardJobsForScope,
  filterCardsForScope,
  normalizeCardScope,
  scopePayloadForArbiter
} from './card-scope.mjs';
import { compact, hashJson, makeId, nowIso, redact, truncate } from './core.mjs';
import { composePromptPacket, PROMPT_PACKET_VERSION } from './prompt.mjs';
import { PROVIDER_CONTRACT_HASH } from './providers.mjs';
import { createSettingsStore, normalizeCardBudgetSettings, normalizeSettings } from './settings.mjs';
import { behaviorPolicyPromptLines, influencePolicyForSettings, runPolicyForEffectivePlan } from './settings-policy.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from './storage.mjs';

const UTILITY_ARBITER_SCHEMA = 'recursion.utilityArbiter.v1';
const PROVIDER_TEST_SCHEMA = 'recursion.providerTest.v1';
const STORAGE_SCHEMA_VERSION = 1;
const RUNTIME_CACHE_CONTRACT_VERSION = 1;
const DEFAULT_CHAT_ID = 'chat';
const DEFAULT_SCENE_KEY = 'scene';
const INSTALL_FAILURE_LABEL = 'Prompt install failed. Generation will continue without Recursion.';
const CLEAR_FAILURE_LABEL = 'Prompt clear failed. Recursion skipped without clearing host prompt.';
const STALE_INSTALL_LABEL = 'Recursion skipped: host turn changed before prompt install.';
const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/ig;
const PROVIDER_VISIBLE_MESSAGE_LIMIT = 12;
const PROVIDER_MESSAGE_TEXT_LIMIT = 900;
const PLAN_ACTIONS = new Set(['skip', 'reuse-cache', 'refresh-cards', 'compose-brief']);
const REASONER_DECISION_MODES = new Set(['use', 'skip']);
const PROMPT_FOOTPRINTS = new Set(['compact', 'normal', 'rich']);
const SCENE_STATUSES = new Set(['same-scene', 'soft-shift', 'hard-shift', 'unknown']);
const PROMPT_NEUTRAL_SETTING_KEYS = new Set(['reasoningLevel', 'reasonerUse']);
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
  'providerContractHash'
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function safeText(value, limit = 700) {
  return truncate(compact(String(redact(value, { maxString: limit }) ?? '').replace(SECRET_TEXT_PATTERN, '[redacted]'), limit), limit);
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
    enabled: source.enabled === true,
    source: String(source.source || ''),
    hostConnectionProfileId: String(source.hostConnectionProfileId || ''),
    openAICompatible: {
      baseUrl: String(openAICompatible.baseUrl || ''),
      model: String(openAICompatible.model || ''),
      sessionApiKeyPresent: openAICompatible.sessionApiKeyPresent === true
    },
    temperature: numberOr(source.temperature, 0),
    topP: numberOr(source.topP, 0),
    maxTokens: numberOr(source.maxTokens, 0)
  };
}

function cacheSettingsSignature(settings = {}) {
  const normalized = normalizeSettings(settings);
  return {
    enabled: normalized.enabled,
    mode: normalized.mode,
    cardScope: normalized.cardScope,
    strength: normalized.strength,
    minCards: normalized.minCards,
    maxCards: normalized.maxCards,
    reasoningLevel: normalized.reasoningLevel,
    promptFootprint: normalized.promptFootprint,
    focus: normalized.focus,
    reasonerUse: normalized.reasonerUse,
    providers: {
      utility: cacheProviderSettingsSignature(normalized.providers?.utility),
      reasoner: cacheProviderSettingsSignature(normalized.providers?.reasoner)
    }
  };
}

export function cacheContractVersions(settings = {}) {
  return {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    runtimeCacheContractVersion: RUNTIME_CACHE_CONTRACT_VERSION,
    cardCatalogHash: hashJson(CARD_CATALOG),
    promptPacketVersion: PROMPT_PACKET_VERSION,
    providerContractHash: PROVIDER_CONTRACT_HASH,
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
  const role = cleanString(
    source.role ?? (source.is_user === true ? 'user' : (source.is_system === true ? 'system' : 'assistant')),
    'assistant'
  );
  return {
    mesid,
    role,
    text: safeText(rawText, 1200),
    textHash: hashJson(String(rawText ?? '')),
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
  return {
    chatId,
    chatKey,
    sceneKey: safeIdentifier(source.sceneKey ?? source.sceneFingerprint, DEFAULT_SCENE_KEY),
    sceneFingerprint,
    turnFingerprint: safeIdentifier(
      source.turnFingerprint,
      hashJson({ latestMesId, messages: messages.slice(-3) })
    ),
    latestMesId,
    messages
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

function providerSafeSnapshot(snapshot = {}) {
  const source = asObject(snapshot);
  const messages = Array.isArray(source.messages)
    ? source.messages.map(providerSafeMessage).filter(Boolean).slice(-PROVIDER_VISIBLE_MESSAGE_LIMIT)
    : [];
  return {
    sceneKey: safeText(source.sceneKey || DEFAULT_SCENE_KEY, 120) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(source.sceneFingerprint || '', 180),
    turnFingerprint: safeText(source.turnFingerprint || '', 180),
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
    latestMesId: numberOr(source.latestMesId, 0),
    messages
  };
}

function latestVisibleMessage(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  return messages
    .slice()
    .reverse()
    .find((message) => message?.visible !== false && String(message?.text ?? '').trim());
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
      text: safeText(userMessage, PROVIDER_MESSAGE_TEXT_LIMIT),
      textHash: hashJson(userMessage)
    };
  }
  const source = asObject(userMessage);
  const rawText = source.text ?? source.mes ?? '';
  const text = safeText(rawText, PROVIDER_MESSAGE_TEXT_LIMIT);
  const mesid = Number(source.mesid ?? source.id ?? source.messageId);
  return {
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
  return {
    ...snapshot,
    latestMesId: pendingMesId,
    messages: nextMessages,
    turnFingerprint: hashJson({
      latestMesId: pendingMesId,
      messages: nextMessages.slice(-3)
    })
  };
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

function reasonerUnavailableReason(settings = {}) {
  const provider = asObject(settings?.providers?.reasoner);
  if (provider.enabled !== true) return 'reasoner-disabled';
  const lastTestStatus = safeProviderLastTest(provider.lastTest).status;
  if (lastTestStatus !== 'pass') {
    return lastTestStatus === 'not-run' ? 'reasoner-not-tested' : 'reasoner-unhealthy';
  }
  const source = safeText(provider.source || 'host-current-model', 80) || 'host-current-model';
  if (source === 'openai-compatible') {
    const openAICompatible = asObject(provider.openAICompatible);
    if (openAICompatible.sessionApiKeyPresent !== true) return 'reasoner-key-missing';
    if (!safeText(openAICompatible.baseUrl || '', 300) || !safeText(openAICompatible.model || '', 160)) {
      return 'reasoner-config-missing';
    }
  }
  if (source === 'host-connection-profile' && !safeText(provider.hostConnectionProfileId || '', 160)) {
    return 'reasoner-profile-missing';
  }
  return '';
}

function enforceReasonerAvailability(plan, settings) {
  const decision = asObject(plan?.reasonerDecision);
  if (decision.mode !== 'use') return plan;
  const reason = reasonerUnavailableReason(settings);
  if (!reason) return plan;
  return {
    ...plan,
    reasonerDecision: {
      mode: 'skip',
      reason,
      signals: safeStringList(decision.signals, 120)
    },
    diagnostics: mergeDiagnostics(plan.diagnostics, ['reasoner-unavailable', reason])
  };
}

function reasoningPolicyForSettings(settings = {}) {
  const level = safeText(settings?.reasoningLevel || 'high', 40).toLowerCase();
  const base = REASONING_LEVEL_POLICIES[level] || REASONING_LEVEL_POLICIES.high;
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

function reasonerLaneAvailable(settings) {
  return !reasonerUnavailableReason(settings);
}

function providerLaneForPolicyLane(policyLane, settings) {
  return policyLane === 'reasoner' && reasonerLaneAvailable(settings) ? 'reasoner' : 'utility';
}

function arbiterLaneForSettings(settings) {
  return providerLaneForPolicyLane(reasoningPolicyForSettings(settings).arbiterLane, settings);
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

function cardLaneForRequest(request, settings) {
  const policy = reasoningPolicyForSettings(settings);
  if (policy.cardLane === 'utility') return 'utility';
  if (!reasonerLaneAvailable(settings)) return 'utility';
  if (policy.cardLane === 'reasoner') return 'reasoner';
  if (policy.cardLane === 'priority') {
    const catalog = catalogForCardRequest(request);
    return numberOr(catalog?.priority, 0) >= HIGH_REASONER_CARD_PRIORITY ? 'reasoner' : 'utility';
  }
  return 'utility';
}

function applyReasoningLaneToCardRequest(request, settings) {
  return {
    ...request,
    lane: cardLaneForRequest(request, settings)
  };
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

function settingsForPlan(settings, plan) {
  const promptFootprint = normalizePromptFootprint(plan?.promptFootprint, settings.promptFootprint);
  if (Array.isArray(plan?.diagnostics) && plan.diagnostics.includes('behavior-reasoner-clamped')) {
    return { ...settings, promptFootprint, reasonerUse: 'off' };
  }
  if (settings.reasonerUse !== 'off' && reasonerUnavailableReason(settings)) {
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

function promptInstallFreshnessSignature(snapshot) {
  const source = asObject(snapshot);
  const visibleMessages = Array.isArray(source.messages)
    ? source.messages
        .filter((message) => message?.visible !== false)
        .map((message) => ({
          mesid: numberOr(message?.mesid, 0),
          role: safeProviderRole(message?.role),
          textHash: String(message?.textHash || hashJson(String(message?.text ?? '')))
        }))
    : [];
  return {
    chatKey: safeText(source.chatKey || source.chatId || DEFAULT_CHAT_ID, 160) || DEFAULT_CHAT_ID,
    sceneKey: safeText(source.sceneKey || DEFAULT_SCENE_KEY, 160) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(source.sceneFingerprint || '', 180),
    latestMesId: numberOr(source.latestMesId, 0),
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
      textHash: String(message?.textHash || hashJson(String(message?.text ?? '')))
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
    snapshotHash: sourceWindowFingerprint(snapshot, firstMesId, lastMesId)
  };
}

function snapshotsMatchForPromptInstall(expected, current) {
  const expectedSignature = promptInstallFreshnessSignature(expected);
  const currentSignature = promptInstallFreshnessSignature(current);
  return expectedSignature.chatKey === currentSignature.chatKey
    && expectedSignature.visibleMessagesHash === currentSignature.visibleMessagesHash;
}

function promptSnapshotMetadataMatches(expected, current) {
  return expected?.chatId === current?.chatId
    && expected?.chatKey === current?.chatKey
    && expected?.sceneKey === current?.sceneKey
    && expected?.sceneFingerprint === current?.sceneFingerprint
    && expected?.turnFingerprint === current?.turnFingerprint
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

function sceneCachePayload(snapshot, deck, hand, plan, packet = null, settings = {}) {
  return {
    cacheState: 'active',
    versions: cacheContractVersions(settings),
    source: {
      chatIdHash: hashJson(snapshot.chatId),
      latestMesId: snapshot.latestMesId,
      sceneFingerprint: snapshot.sceneFingerprint,
      chatWindowHash: hashJson(snapshot.messages),
      sceneStatus: plan.sceneStatus
    },
    cards: deck.cards,
    latestHand: sceneCacheLatestHand(hand, packet)
  };
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

function arbiterSafeSettings(settings) {
  const source = asObject(settings);
  return {
    enabled: source.enabled !== false,
    mode: safeText(source.mode || 'auto', 40),
    cardScope: cardScopeSummary(source.cardScope),
    strength: safeText(source.strength || 'balanced', 40),
    minCards: normalizeCardBudgetSettings(source).minCards,
    maxCards: normalizeCardBudgetSettings(source).maxCards,
    reasoningLevel: safeText(source.reasoningLevel || 'high', 40),
    promptFootprint: safeText(source.promptFootprint || 'normal', 40),
    focus: safeText(source.focus || 'balanced', 80),
    reasonerUse: safeText(source.reasonerUse || 'auto', 40),
    providers: {
      utility: {
        enabled: source.providers?.utility?.enabled === true,
        source: safeText(source.providers?.utility?.source || '', 80)
      },
      reasoner: {
        enabled: source.providers?.reasoner?.enabled === true,
        source: safeText(source.providers?.reasoner?.source || '', 80)
      }
    }
  };
}

function safeProviderLastTest(value) {
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

function safeProviderSettingsView(provider) {
  const source = asObject(provider);
  return {
    lane: safeText(source.lane || '', 40),
    enabled: source.enabled === true,
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
    resolvedProviderLabel: safeText(source.resolvedProviderLabel || '', 120),
    resolvedModelLabel: safeText(source.resolvedModelLabel || '', 120),
    lastTest: safeProviderLastTest(source.lastTest)
  };
}

function safeSettingsView(settings) {
  const source = asObject(settings);
  const cardScope = normalizeCardScope(source.cardScope);
  const cardBudget = normalizeCardBudgetSettings(source);
  return {
    enabled: source.enabled !== false,
    mode: safeText(source.mode || 'auto', 40),
    cardScope,
    cardScopeSummary: cardScopeSummary(cardScope),
    strength: safeText(source.strength || 'balanced', 40),
    minCards: cardBudget.minCards,
    maxCards: cardBudget.maxCards,
    reasoningLevel: safeText(source.reasoningLevel || 'high', 40),
    promptFootprint: safeText(source.promptFootprint || 'normal', 40),
    focus: safeText(source.focus || 'balanced', 80),
    reasonerUse: safeText(source.reasonerUse || 'auto', 40),
    diagnostics: {
      maxJournalEntries: numberOr(source.diagnostics?.maxJournalEntries, 100),
      includeExcerpts: source.diagnostics?.includeExcerpts === true
    },
    providers: {
      utility: safeProviderSettingsView(source.providers?.utility),
      reasoner: safeProviderSettingsView(source.providers?.reasoner)
    },
    ui: {
      viewerOpen: source.ui?.viewerOpen === true,
      progressChildVisibleLimit: numberOr(source.ui?.progressChildVisibleLimit, 5),
      progressListVisibleLimit: numberOr(source.ui?.progressListVisibleLimit, 15)
    }
  };
}

function providerHealthForArbiter(settings) {
  const source = asObject(settings);
  const provider = (lane) => {
    const config = asObject(source.providers?.[lane]);
    return {
      enabled: config.enabled === true,
      source: safeText(config.source || '', 80),
      status: safeProviderLastTest(config.lastTest).status
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

function compactSceneCacheForArbiter(cache, snapshot) {
  const source = asObject(cache);
  const cacheState = ['active', 'stale', 'retired', 'invalid'].includes(source.cacheState) ? source.cacheState : 'active';
  const invalidation = asObject(source.invalidation);
  const invalidationReason = safeText(invalidation.reason || '', 120);
  const invalidationDetectedAt = safeText(invalidation.detectedAt || '', 80);
  const cards = (Array.isArray(source.cards) ? source.cards : [])
    .map((card) => compactCacheCardForArbiter(card, snapshot))
    .filter(Boolean)
    .slice(0, 32);
  const latestHand = asObject(source.latestHand);
  const handCards = Array.isArray(latestHand.cardIds)
    ? latestHand.cardIds.map((cardId) => arbiterSafeRef(cardId || '', 'card')).filter(Boolean).slice(0, 16)
    : [];
  const handId = arbiterSafeRef(latestHand.handId || '', 'hand');
  return {
    available: cards.length > 0,
    sceneKey: safeText(snapshot?.sceneKey || DEFAULT_SCENE_KEY, 160) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(snapshot?.sceneFingerprint || '', 180),
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
  const continuity = normalizeCard({
    family: 'Continuity Risk',
    promptText: latestUserText
      ? `Keep the next response consistent with the latest visible user action: ${latestUserText}`
      : 'Keep the next response consistent with the latest visible user action and current scene state.',
    evidenceRefs: [`message:${userEvidenceMesId}`],
    emphasis: 'emphasized'
  }, context);
  return [scene, continuity];
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
  const scope = scopePayloadForArbiter(settings);
  if (scope.strictWhitelist) return [];
  const selected = new Set(scope.selectedFamilies);
  const exceptions = new Set(scope.autoExceptionFamilies);
  return [...new Set((Array.isArray(entries) ? entries : [])
    .map((entry) => catalogForCard(entry)?.family || safeText(entry?.family || '', 120))
    .filter((family) => family && !selected.has(family) && exceptions.has(family))
    .map((family) => `auto-scope-exception:${family}`))];
}

function cardScopePolicyLine(cardScope) {
  if (cardScope?.strictWhitelist) {
    return 'Manual card scope policy: allowedCatalog is a strict whitelist. Do not request disabled families or sub-items.';
  }
  return 'Auto card scope policy: selected families and sub-items are the preferred focus, not a whitelist. Prefer selected scope when it can satisfy the turn; request unselected families only when they have high relevance to continuity, scene coherence, or the current user message.';
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

function cardProgressDetail(card, source, state) {
  const catalog = catalogForCard(card);
  const roleId = safeText(catalog?.role || card?.role || card?.roleId || '', 120);
  const family = safeText(catalog?.family || card?.family || '', 120);
  const providerLane = safeText(card?.providerLane || card?.lane || '', 40);
  return {
    parentStepId: 'utility-card-batch',
    roleId,
    family,
    source,
    state,
    providerLane: providerLane === 'reasoner' ? 'reasoner' : 'utility',
    cardId: safeIdentifier(card?.id || '', 'card', 160)
  };
}

function sanitizeGeneratedCard(card) {
  const rawId = String(card?.id ?? '').trim();
  const safeId = rawId && !hasSecretText(rawId) ? safeText(rawId, 160) : undefined;
  const sanitized = {
    ...card,
    id: safeId || undefined,
    promptText: safeText(card?.promptText || '', 1000),
    summary: safeText(card?.summary || card?.promptText || '', 400),
    evidenceRefs: Array.isArray(card?.evidenceRefs)
      ? card.evidenceRefs.map((entry) => safeText(entry, 120)).filter(Boolean).slice(0, 12)
      : [],
    arbiter: {
      ...asObject(card?.arbiter),
      reason: safeText(card?.arbiter?.reason || '', 240)
    }
  };
  if (card?.inspectorNotes) sanitized.inspectorNotes = safeText(card.inspectorNotes, 800);
  return sanitized;
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

function sanitizePromptError(error, fallbackCode, fallbackMessage) {
  const source = asObject(error);
  return {
    code: safeText(source.code || fallbackCode, 120) || fallbackCode,
    message: safeText(source.message || error?.message || error || fallbackMessage, 240) || fallbackMessage
  };
}

function sanitizePromptOutcome(value, { fallbackCode, fallbackMessage } = {}) {
  const source = asObject(value);
  const ok = source.ok !== false;
  const output = { ok };
  if (source.skipped !== undefined) output.skipped = Boolean(source.skipped);
  if (source.cleared !== undefined) output.cleared = Boolean(source.cleared);
  if (Array.isArray(source.installed)) {
    output.installed = source.installed.map((entry) => safeText(entry, 120)).filter(Boolean).slice(0, 16);
  } else if (source.installed === true) {
    output.installed = true;
  }
  if (!ok) {
    output.error = sanitizePromptError(source.error, fallbackCode, fallbackMessage);
  }
  return output;
}

async function installPrompt(host, packet) {
  const install = host?.prompt?.install;
  if (typeof install !== 'function') {
    return sanitizePromptOutcome({
      ok: false,
      error: {
        code: 'RECURSION_PROMPT_INSTALL_UNAVAILABLE',
        message: 'Host prompt install is unavailable.'
      }
    }, {
      fallbackCode: 'RECURSION_PROMPT_INSTALL_UNAVAILABLE',
      fallbackMessage: 'Host prompt install is unavailable.'
    });
  }
  try {
    const result = await install.call(host.prompt, packet);
    if (result && typeof result === 'object') {
      return sanitizePromptOutcome(result, {
        fallbackCode: 'RECURSION_PROMPT_INSTALL_FAILED',
        fallbackMessage: 'Prompt install failed.'
      });
    }
    return sanitizePromptOutcome({ ok: true }, {
      fallbackCode: 'RECURSION_PROMPT_INSTALL_FAILED',
      fallbackMessage: 'Prompt install failed.'
    });
  } catch (error) {
    return sanitizePromptOutcome({
      ok: false,
      error: {
        code: error?.code ? String(error.code) : 'RECURSION_PROMPT_INSTALL_FAILED',
        message: String(error?.message || error || 'Prompt install failed.')
      }
    }, {
      fallbackCode: 'RECURSION_PROMPT_INSTALL_FAILED',
      fallbackMessage: 'Prompt install failed.'
    });
  }
}

function installSummary(install) {
  if (install?.ok !== false) return 'Prompt installed';
  return safeText(install.error?.message || install.error?.code || 'Prompt install failed', 300);
}

function installJournalDetails(install) {
  if (install?.ok !== false) {
    return {
      status: 'installed',
      installedCount: Array.isArray(install?.installed) ? install.installed.length : undefined
    };
  }
  return {
    status: 'failed',
    code: safeText(install?.error?.code || 'RECURSION_PROMPT_INSTALL_FAILED', 120),
    message: safeText(install?.error?.message || 'Prompt install failed.', 240)
  };
}

async function clearPromptBestEffort(host) {
  const clear = host?.prompt?.clear;
  if (typeof clear !== 'function') {
    return sanitizePromptOutcome({
      ok: false,
      error: {
        code: 'RECURSION_PROMPT_CLEAR_UNAVAILABLE',
        message: 'Host prompt clear is unavailable.'
      }
    }, {
      fallbackCode: 'RECURSION_PROMPT_CLEAR_UNAVAILABLE',
      fallbackMessage: 'Host prompt clear is unavailable.'
    });
  }
  try {
    const result = await clear.call(host.prompt);
    return sanitizePromptOutcome(result && typeof result === 'object' ? result : { ok: true }, {
      fallbackCode: 'RECURSION_PROMPT_CLEAR_FAILED',
      fallbackMessage: 'Prompt clear failed.'
    });
  } catch (error) {
    return sanitizePromptOutcome({
      ok: false,
      error: {
        code: error?.code ? String(error.code) : 'RECURSION_PROMPT_CLEAR_FAILED',
        message: safeText(error?.message || error || 'Prompt clear failed.', 240)
      }
    }, {
      fallbackCode: 'RECURSION_PROMPT_CLEAR_FAILED',
      fallbackMessage: 'Prompt clear failed.'
    });
  }
}

function clearWarningDetails(clear) {
  return {
    code: safeText(clear?.error?.code || 'RECURSION_PROMPT_CLEAR_FAILED', 120),
    message: safeText(clear?.error?.message || 'Prompt clear failed.', 240)
  };
}

function clearJournalSummary(clear) {
  if (clear?.ok !== false) return 'Prompt cleared';
  return 'Prompt clear failed';
}

function clearJournalDetails(clear, reason) {
  const ok = clear?.ok !== false;
  const details = {
    status: ok ? 'cleared' : 'failed'
  };
  const safeReason = safeText(reason || '', 120);
  if (safeReason) details.reason = safeReason;
  if (clear?.cleared !== undefined) details.cleared = Boolean(clear.cleared);
  if (!ok) {
    details.code = promptClearJournalCode(clear);
  }
  return details;
}

function promptClearJournalCode(clear) {
  const code = safeText(clear?.error?.code || '', 120);
  if (code === 'RECURSION_PROMPT_CLEAR_UNAVAILABLE') return code;
  return 'RECURSION_PROMPT_CLEAR_FAILED';
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
  generationRouter = null
} = {}) {
  let activeRunId = null;
  let activeRunController = null;
  let lastPacket = null;
  let lastHand = { cards: [], omitted: [] };
  let lastPlan = null;
  let lastSnapshot = null;
  let lastSavedSceneCacheRef = null;
  let promptInstallTail = Promise.resolve();
  let storageSaveTail = Promise.resolve();
  const activeRuntimeMutations = new Set();
  let activePromptMutationId = null;

  async function readSnapshot() {
    if (typeof host?.snapshot !== 'function') {
      throw new Error('Recursion runtime requires host.snapshot().');
    }
    return normalizeSnapshot(await host.snapshot());
  }

  function isActiveRun(runId) {
    return activeRunId === runId;
  }

  function abortActiveRun() {
    try {
      activeRunController?.abort?.();
    } catch {
      // Abort notification is best-effort; supersession guards still prevent stale writes.
    }
  }

  function supersedeActiveRun() {
    abortActiveRun();
    activeRunId = null;
    activeRunController = null;
  }

  function startRun(runId) {
    abortActiveRun();
    activeRunController = typeof AbortController === 'function' ? new AbortController() : null;
    activeRunId = runId;
    return activeRunController?.signal ?? null;
  }

  function clearActiveRun(runId = null) {
    if (runId && activeRunId !== runId) return;
    activeRunId = null;
    activeRunController = null;
  }

  function clearVolatileSceneState() {
    lastPacket = null;
    lastHand = { cards: [], omitted: [] };
    lastPlan = null;
    lastSnapshot = null;
    lastSavedSceneCacheRef = null;
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

  function stageCardProgress(runId, cards, { source, state }) {
    const list = Array.isArray(cards) ? cards : [];
    const severity = state === 'failed' ? 'error' : (state === 'warning' ? 'warning' : 'success');
    for (const card of list) {
      const detail = cardProgressDetail(card, source, state);
      if (!detail.roleId && !detail.family) continue;
      const providerLane = source === 'generated' ? detail.providerLane : 'utility';
      stageRuntimeActivity({
        runId,
        phase: 'cardProgress',
        severity,
        providerLane,
        composerLane: providerLane,
        label: `${detail.family || 'Card'} ${source === 'cache' ? 'reused from cache' : (source === 'fallback' ? 'fell back locally' : 'generated')}.`,
        detail,
        chips: ['Cards', source]
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
    return activePromptMutationId === runId && safeCurrentActivity(activity)?.runId === runId;
  }

  async function clearPromptAfterSupersede({
    successLabel = 'Recursion prompt cleared after settings change.',
    journalReason = 'settings-changed'
  } = {}) {
    const runId = makeId('settings');
    activePromptMutationId = runId;
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
      if (activePromptMutationId === runId) activePromptMutationId = null;
      return clear;
    }
    if (clear?.ok === false) {
      reportClearWarning(runId, clear);
      if (activePromptMutationId === runId) activePromptMutationId = null;
      return clear;
    }
    settleRuntimeActivity({
      runId,
      outcome: 'success',
      phase: 'settled',
      label: successLabel,
      chips: ['Prompt']
    });
    if (activePromptMutationId === runId) activePromptMutationId = null;
    return clear;
  }

  async function updateSettings(patch = {}) {
    const cleanPatch = asObject(patch);
    const next = settingsStore.update(cleanPatch);
    const changedKeys = Object.keys(cleanPatch);
    const promptNeutralPatch = changedKeys.length > 0
      && changedKeys.every((key) => PROMPT_NEUTRAL_SETTING_KEYS.has(key));
    if (promptNeutralPatch) {
      return { ok: true, settings: next, clear: null };
    }
    if (changedKeys.length > 0) {
      supersedeActiveRun();
      return trackRuntimeMutation(async () => {
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
    }
    return { ok: true, settings: next, clear: null };
  }

  async function updateProvider(lane, patch = {}) {
    const resolvedLane = providerLane(lane);
    const provider = settingsStore.updateProvider(resolvedLane, patch);
    supersedeActiveRun();
    return trackRuntimeMutation(async () => {
      await invalidateActiveSceneCacheBestEffort('provider-changed', {
        lane: resolvedLane,
        changedKeys: Object.keys(asObject(patch))
      });
      const clear = await clearPromptAfterSupersede({
        successLabel: 'Recursion prompt cleared after provider change.',
        journalReason: 'provider-changed'
      });
      return { ok: clear?.ok !== false, provider, clear };
    });
  }

  async function clearProviderKey(lane) {
    const resolvedLane = providerLane(lane);
    const provider = settingsStore.clearApiKey(resolvedLane);
    supersedeActiveRun();
    return trackRuntimeMutation(async () => {
      await invalidateActiveSceneCacheBestEffort('provider-key-cleared', {
        lane: resolvedLane
      });
      const clear = await clearPromptAfterSupersede({
        successLabel: 'Recursion prompt cleared after provider key change.',
        journalReason: 'provider-key-cleared'
      });
      return { ok: clear?.ok !== false, provider, clear };
    });
  }

  function currentDiagnosticsChatKey() {
    const snapshot = viewSnapshot(lastSnapshot);
    return safeText(snapshot?.chatKey || snapshot?.chatId || DEFAULT_CHAT_ID, 160) || DEFAULT_CHAT_ID;
  }

  function diagnosticsPacket(packet) {
    const source = asObject(packet);
    if (!source.packetId && !source.packetVersion) return null;
    return redact({
      packetId: safeText(source.packetId || '', 160),
      packetVersion: numberOr(source.packetVersion, PROMPT_PACKET_VERSION),
      footprint: safeText(source.footprint || '', 40),
      selectedCardRefs: Array.isArray(source.selectedCardRefs)
        ? source.selectedCardRefs.slice(0, 24).map((entry) => ({
          cardId: safeIdentifier(entry?.cardId || entry?.id || '', '', 160),
          family: safeText(entry?.family || '', 80),
          emphasis: safeText(entry?.emphasis || '', 40),
          tokenEstimate: numberOr(entry?.tokenEstimate, 0)
        }))
        : [],
      omissions: Array.isArray(source.omissions)
        ? source.omissions.slice(0, 24).map((entry) => ({
          cardId: safeIdentifier(entry?.cardId || entry?.id || '', '', 160),
          reason: safeText(entry?.reason || '', 120)
        }))
        : [],
      injectionPlan: Array.isArray(source.injectionPlan)
        ? source.injectionPlan.slice(0, 12).map((block) => ({
          id: safeText(block?.id || '', 80),
          promptKey: safeText(block?.promptKey || '', 160),
          placement: safeText(block?.placement || '', 40),
          depth: numberOr(block?.depth, 0),
          role: safeText(block?.role || '', 40)
        }))
        : [],
      diagnostics: source.diagnostics || {},
      composedAt: safeText(source.composedAt || '', 80),
      promptPacketHash: hashJson(source)
    }, { maxString: 700 });
  }

  function diagnosticsHand(hand) {
    const source = asObject(hand);
    const cards = Array.isArray(source.cards) ? source.cards : [];
    return redact({
      handId: safeIdentifier(source.handId || '', '', 160),
      selectedCount: cards.length,
      cards: cards.slice(0, 24).map((card) => ({
        id: safeIdentifier(card?.id || '', '', 160),
        family: safeText(card?.family || '', 80),
        role: safeText(card?.role || '', 80),
        status: safeText(card?.status || '', 40),
        emphasis: safeText(card?.emphasis || '', 40),
        tokenEstimate: numberOr(card?.tokenEstimate, 0),
        source: safeText(card?.source || card?.provider || '', 80)
      })),
      omittedCount: Array.isArray(source.omitted) ? source.omitted.length : 0
    }, { maxString: 700 });
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
    const payload = redact({
      schema: 'recursion.diagnosticsExport.v1',
      exportedAt: nowIso(),
      activeRunId: safeIdentifier(activeRunId || '', '', 160),
      chatKey: safeIdentifier(chatKey, 'chat', 160),
      snapshot: lastSnapshot ? {
        chatId: safeIdentifier(lastSnapshot.chatId || '', '', 160),
        chatKey: safeIdentifier(lastSnapshot.chatKey || lastSnapshot.chatId || '', '', 160),
        sceneKey: safeIdentifier(lastSnapshot.sceneKey || '', '', 160),
        sceneFingerprint: safeText(lastSnapshot.sceneFingerprint || '', 180),
        turnFingerprint: safeText(lastSnapshot.turnFingerprint || '', 180),
        latestMesId: numberOr(lastSnapshot.latestMesId, 0),
        visibleMessageCount: Array.isArray(lastSnapshot.messages)
          ? lastSnapshot.messages.filter((message) => message?.visible !== false).length
          : 0
      } : null,
      packet: diagnosticsPacket(lastPacket),
      hand: diagnosticsHand(lastHand),
      plan: lastPlan ? {
        action: safeText(lastPlan.action || '', 40),
        sceneStatus: safeText(lastPlan.sceneStatus || '', 40),
        promptFootprint: safeText(lastPlan.promptFootprint || '', 40),
        reasonerDecision: {
          mode: safeText(lastPlan.reasonerDecision?.mode || '', 40),
          reason: safeText(lastPlan.reasonerDecision?.reason || '', 160)
        },
        diagnostics: Array.isArray(lastPlan.diagnostics) ? lastPlan.diagnostics.slice(0, 24).map((entry) => safeText(entry, 160)) : []
      } : null,
      activity: safeCurrentActivity(activity),
      activityHistory: safeActivityHistory(activity),
      settings: safeSettingsView(settingsStore.get()),
      storage: {
        indexRecordCount: index?.records ? Object.keys(index.records).length : 0,
        journalEntryCount: Array.isArray(journal?.entries) ? journal.entries.length : 0,
        journal: journal ? {
          chatKey: safeIdentifier(journal.chatKey || chatKey, 'chat', 160),
          maxEntries: numberOr(journal.maxEntries, 0),
          updatedAt: safeText(journal.updatedAt || '', 80),
          entries: Array.isArray(journal.entries) ? journal.entries.slice(-50) : []
        } : null
      }
    }, { maxString: 900 });
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
      lastPacket = null;
      lastHand = { cards: [], omitted: [] };
      lastPlan = null;
      lastSavedSceneCacheRef = null;
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

  async function clearForHostEvent({
    idPrefix,
    reason,
    invalidationDetails = {},
    startLabel,
    successLabel,
    chips
  }) {
    const runId = makeId(idPrefix);
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
      await invalidateActiveSceneCacheBestEffort(reason, invalidationDetails);
      clearVolatileSceneState();
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
        outcome: 'success',
        phase: 'settled',
        severity: 'success',
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
      chips: ['Source', 'Prompt']
    });
  }

  function providerTestPrompt(lane) {
    return [
      'Return strict JSON for a Recursion provider connectivity test.',
      'Do not include prose outside JSON.',
      `Lane: ${lane}.`,
      '{"schema":"recursion.providerTest.v1","ok":true}'
    ].join('\n');
  }

  function providerTestFailure(lane, checkedAt, error) {
    const compactError = safeText(error?.message || error?.code || error || 'Provider test failed.', 300);
    return settingsStore.updateProvider(lane, {
      resolvedProviderLabel: '',
      resolvedModelLabel: '',
      lastTest: {
        status: 'fail',
        checkedAt,
        compactError
      }
    });
  }

  function validProviderTestResult(result) {
    const data = asObject(result?.data);
    return result?.ok === true
      && data.schema === PROVIDER_TEST_SCHEMA
      && data.ok === true;
  }

  async function testProvider(lane = 'utility') {
    supersedeActiveRun();
    const resolvedLane = providerLane(lane);
    const checkedAt = nowIso();
    const runId = makeId(`provider-test-${resolvedLane}`);
    startRuntimeActivity({
      runId,
      phase: 'providerCallStarted',
      mode: 'review',
      severity: 'info',
      providerLane: resolvedLane,
      label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test started.`,
      chips: [resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility', 'Provider']
    });

    if (!generationRouter || typeof generationRouter.generate !== 'function') {
      const provider = providerTestFailure(resolvedLane, checkedAt, {
        code: 'RECURSION_PROVIDER_ROUTER_UNAVAILABLE',
        message: 'Provider test is unavailable because the generation router is not configured.'
      });
      settleRuntimeActivity({
        runId,
        outcome: 'warning',
        phase: 'providerTestFailed',
        severity: 'warning',
        providerLane: resolvedLane,
        label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test failed.`,
        chips: ['Provider'],
        detail: provider.lastTest
      });
      return {
        ok: false,
        error: {
          code: 'RECURSION_PROVIDER_ROUTER_UNAVAILABLE',
          message: 'Provider test is unavailable.'
        }
      };
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
      const result = await generationRouter.generate('providerTest', {
        runId,
        lane: resolvedLane,
        prompt: providerTestPrompt(resolvedLane)
      });
      if (validProviderTestResult(result)) {
        const provider = settingsStore.updateProvider(resolvedLane, {
          resolvedProviderLabel: safeText(result.diagnostics?.providerId || result.providerId || '', 120),
          resolvedModelLabel: safeText(result.diagnostics?.model || result.model || '', 120),
          lastTest: {
            status: 'pass',
            checkedAt
          }
        });
        settleRuntimeActivity({
          runId,
          outcome: 'success',
          phase: 'settled',
          severity: 'success',
          providerLane: resolvedLane,
          label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test passed.`,
          chips: ['Provider'],
          detail: {
            provider: provider.resolvedProviderLabel,
            model: provider.resolvedModelLabel
          }
        });
        return result;
      }

      if (result?.ok) {
        const invalid = {
          code: 'RECURSION_PROVIDER_TEST_INVALID',
          message: 'Provider test returned an invalid structured response.'
        };
        const provider = providerTestFailure(resolvedLane, checkedAt, invalid);
        settleRuntimeActivity({
          runId,
          outcome: 'warning',
          phase: 'providerTestFailed',
          severity: 'warning',
          providerLane: resolvedLane,
          label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test failed.`,
          chips: ['Provider'],
          detail: provider.lastTest
        });
        return { ok: false, error: invalid };
      }

      const provider = providerTestFailure(resolvedLane, checkedAt, result?.error || 'Provider test failed.');
      settleRuntimeActivity({
        runId,
        outcome: 'warning',
        phase: 'providerTestFailed',
        severity: 'warning',
        providerLane: resolvedLane,
        label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test failed.`,
        chips: ['Provider'],
        detail: provider.lastTest
      });
      return result || { ok: false, error: { code: 'RECURSION_PROVIDER_TEST_FAILED', message: 'Provider test failed.' } };
    } catch (error) {
      const provider = providerTestFailure(resolvedLane, checkedAt, error);
      settleRuntimeActivity({
        runId,
        outcome: 'warning',
        phase: 'providerTestFailed',
        severity: 'warning',
        providerLane: resolvedLane,
        label: `${resolvedLane === 'reasoner' ? 'Reasoner' : 'Utility'} provider test failed.`,
        chips: ['Provider'],
        detail: provider.lastTest
      });
      return {
        ok: false,
        error: {
          code: safeText(error?.code || 'RECURSION_PROVIDER_TEST_FAILED', 120),
          message: safeText(error?.message || 'Provider test failed.', 300)
        }
      };
    }
  }

  async function waitForExternalMutations() {
    while (true) {
      const promptTail = promptInstallTail;
      const storageTail = storageSaveTail;
      const mutations = [...activeRuntimeMutations];
      try {
        await Promise.all([promptTail, storageTail, ...mutations]);
      } catch {
        // Mutation failures are normalized at their source; tails are only sequencing gates.
      }
      if (promptTail === promptInstallTail && storageTail === storageSaveTail && activeRuntimeMutations.size === 0) {
        return;
      }
    }
  }

  function trackRuntimeMutation(mutationWork) {
    const current = Promise.resolve().then(mutationWork);
    activeRuntimeMutations.add(current);
    current.finally(() => {
      activeRuntimeMutations.delete(current);
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
      if (!isActiveRun(runId)) return supersededResult(runId);
      return saveWork();
    });
    storageSaveTail = current.catch(() => {});
    return current;
  }

  function reportStorageWarning(runId, operation, error) {
    if (!isActiveRun(runId)) return;
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
      severity: 'warning',
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
      lastSavedSceneCacheRef = {
        chatKey: snapshot.chatKey,
        sceneKey: snapshot.sceneKey
      };
      return result;
    } catch (error) {
      reportStorageWarning(runId, 'saveSceneCache', error);
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
        listedCount: Math.min(selectedCards.length, 16),
        truncated: selectedCards.length > 16,
        cards: selectedCards.map((card) => ({
          id: safeIdentifier(card?.id || '', 'card', 160),
          family: safeText(card?.family || '', 80),
          role: safeText(card?.role || '', 80),
          emphasis: safeText(card?.emphasis || '', 40),
          detailProfile: safeText(card?.detailProfile || '', 40),
          tokenEstimate: Math.max(0, Math.round(numberOr(card?.tokenEstimate, 0)))
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
      source.fingerprint,
      source.snapshotHash,
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

  function staleCacheCardReason(card, normalized, snapshot) {
    const source = asObject(card?.source);
    const freshness = asObject(card?.freshness);
    const sourceChatId = String(source.chatId || card?.chatId || '').trim();
    if (sourceChatId && sourceChatId !== snapshot.chatId) return 'source-chat-mismatch';

    const sourceRange = rawSourceRange(card);
    if (!sourceRange) return 'source-range-missing';
    const firstMesId = sourceRange.firstMesId;
    const lastMesId = sourceRange.lastMesId;
    if (!Number.isFinite(firstMesId) || !Number.isFinite(lastMesId)) return 'source-range-missing';
    if (!Number.isInteger(firstMesId) || !Number.isInteger(lastMesId) || firstMesId > lastMesId) return 'source-range-invalid';
    if (lastMesId > numberOr(snapshot.latestMesId, 0)) return 'source-range-future';
    if (!sourceRangeIsVisible(snapshot, firstMesId, lastMesId)) return 'source-range-not-visible';

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
      if (!visibleMessageIds.has(evidenceId)) return 'evidence-message-missing';
      if (evidenceId < firstMesId || evidenceId > lastMesId) return 'evidence-outside-source-range';
    }

    const candidates = cacheFingerprintCandidates(card);
    if (!candidates.length) return 'source-fingerprint-missing';
    const currentWindow = sourceWindowFingerprint(snapshot, firstMesId, lastMesId);
    if (!candidates.includes(currentWindow)) return 'source-fingerprint-mismatch';

    return '';
  }

  function sanitizedCacheCards(runId, snapshot, cards) {
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
          lastMesId: snapshot.latestMesId
        });
        const staleReason = staleCacheCardReason(sanitized, normalized, snapshot);
        if (staleReason) {
          stale += 1;
          continue;
        }
        accepted.push(sanitized);
      } catch {
        invalid += 1;
      }
    }
    if (invalid || stale) {
      stageRuntimeActivity({
        runId,
        phase: 'cacheWarning',
        severity: 'warning',
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

  async function recheckPromptInstallSnapshot(runId, expectedSnapshot, plan, pendingUserMessage) {
    try {
      const currentSnapshot = snapshotForPlan(
        snapshotWithPendingUserMessage(await readSnapshot(), pendingUserMessage),
        plan
      );
      if (!snapshotsMatchForPromptInstall(expectedSnapshot, currentSnapshot)) {
        return { ok: false, reason: 'stale-snapshot', currentSnapshot };
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
    error = null
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
      ...(currentSnapshot ? { current: promptInstallFreshnessSignature(currentSnapshot) } : {})
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
    const arbiterLane = arbiterLaneForSettings(settings);
    stageRuntimeActivity({
      runId,
      phase: 'arbiterPlanning',
      label: 'Planning card pass...',
      providerLane: arbiterLane,
      chips: [arbiterLane === 'reasoner' ? 'Reasoner' : 'Utility']
    });
    try {
      const cacheView = compactSceneCacheForArbiter(sceneCache, snapshot);
      const cardScope = scopePayloadForArbiter(settings);
      const catalog = cardScope.strictWhitelist ? cardScope.allowedCatalog : cardScope.availableCatalog;
      const result = await generationRouter.generate('utilityArbiter', {
        lane: arbiterLane,
        runId,
        signal,
        snapshotHash: fallbackPlan.snapshotHash,
        prompt: [
          'Return a Recursion Utility Arbiter plan as strict JSON.',
          `Schema: ${UTILITY_ARBITER_SCHEMA}`,
          `Settings: ${JSON.stringify(arbiterSafeSettings(settings))}`,
          behaviorPolicyPromptLines(influencePolicyForSettings(settings)),
          `Provider health: ${JSON.stringify(providerHealthForArbiter(settings))}`,
          `Card scope: ${JSON.stringify(cardScope)}`,
          cardScopePolicyLine(cardScope),
          arbiterCardJobContractLine(),
          reasoningPolicyPromptLine(settings),
          `Catalog: ${JSON.stringify(catalog)}`,
          `Catalog hash: ${hashJson(catalog)}`,
          `Snapshot hash: ${fallbackPlan.snapshotHash}`,
          `User message hash: ${hashJson(userMessage)}`,
          `Scene cache: ${JSON.stringify(cacheView)}`,
          `Snapshot: ${JSON.stringify(providerSafeSnapshot(snapshot))}`
        ].join('\n\n')
      }, { runId, signal, isCurrent: () => isActiveRun(runId) });
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
    if (!generationRouter) return [];
    const cardScope = scopePayloadForArbiter(settings);
    const requests = buildCardRequests(plan, {
      runId,
      snapshotHash: plan.snapshotHash || hashJson(snapshot),
      snapshot: providerSafeSnapshot(snapshot),
      cardScope
    }).map((request) => applyReasoningLaneToCardRequest(request, settings));
    if (!requests.length) return [];
    if (typeof generationRouter.batch !== 'function' && typeof generationRouter.generate !== 'function') return [];
    const lanes = new Set(requests.map((request) => request.lane));
    const batchLane = lanes.size === 1 && lanes.has('reasoner') ? 'reasoner' : 'utility';
    stageRuntimeActivity({
      runId,
      phase: 'cardBatchRunning',
      label: 'Generating scene cards...',
      cardCounts: { requested: requests.length },
      providerLane: batchLane,
      chips: [
        'Cards',
        String(requests.length),
        ...(lanes.has('utility') && lanes.has('reasoner') ? ['Utility', 'Reasoner'] : [batchLane === 'reasoner' ? 'Reasoner' : 'Utility'])
      ]
    });
    try {
      const signalRequests = signal
        ? requests.map((request) => ({ ...request, signal }))
        : requests;
      const options = { runId, signal, isCurrent: () => isActiveRun(runId) };
      const results = typeof generationRouter.batch === 'function'
        ? await generationRouter.batch(signalRequests, options)
        : [];
      if (typeof generationRouter.batch !== 'function') {
        for (const request of signalRequests) {
          if (signal?.aborted === true || !isActiveRun(runId)) break;
          try {
            results.push(await generationRouter.generate(request.roleId, request, options));
          } catch {
            if (signal?.aborted === true || !isActiveRun(runId)) break;
            results.push({ ok: false });
          }
        }
      }
      return results.flatMap((result, index) => cardsFromProviderResult(result, {
        ...cardSourceContext(snapshot),
        expectedSnapshotHash: requests[index]?.snapshotHash,
        expectedRole: requests[index]?.metadata?.role,
        expectedFamily: requests[index]?.metadata?.family
      }).map((card) => ({
        ...card,
        providerLane: result?.lane || requests[index]?.lane || 'utility'
      })));
    } catch {
      return [];
    }
  }

  async function prepareForGeneration({ userMessage = '', refreshReason = '' } = {}) {
    const settings = settingsStore.get();
    if (settings.enabled === false) {
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
      if (clear?.ok === false) reportClearWarning(clearRunId, clear);
      else safeActivity(activity, 'clear');
      return { ok: true, skipped: true, reason: 'disabled', clear };
    }

    await waitForExternalMutations();
    const pendingUserMessage = normalizePendingUserMessage(userMessage);
    const runId = makeId('run');
    const signal = startRun(runId);
    const modeChip = settings.mode === 'manual' ? 'Manual' : 'Auto';
    startRuntimeActivity({ runId, label: 'Reading current turn...', chips: [modeChip] });
    try {
      const snapshot = snapshotWithPendingUserMessage(await readSnapshot(), pendingUserMessage);
      if (!isActiveRun(runId)) return supersededResult(runId);
      lastSnapshot = snapshot;
      if (refreshReason && typeof storage.invalidateSceneCache === 'function') {
        await runStorageSaveSection(runId, async () => {
          try {
            return await storage.invalidateSceneCache(snapshot.chatKey, snapshot.sceneKey, {
              reason: refreshReason,
              runId,
              details: { latestMesId: snapshot.latestMesId }
            });
          } catch {
            // Refresh invalidation is best-effort; missing caches and storage failures should not block preparation.
            return null;
          }
        });
        if (!isActiveRun(runId)) return supersededResult(runId);
      }
      const fallbackPlan = localFallbackPlan(snapshot, settings);
      fallbackPlan.source = {
        ...fallbackPlan.source,
        userMessageHash: hashJson(pendingUserMessage.text),
        catalogHash: hashJson(CARD_CATALOG)
      };
      const initialCache = await loadSceneCacheSafe(runId, snapshot, settings);
      if (!isActiveRun(runId)) return supersededResult(runId);
      let plan = await askUtilityArbiter({
        runId,
        snapshot,
        settings,
        fallbackPlan,
        sceneCache: initialCache,
        userMessage: pendingUserMessage.text,
        signal
      });
      plan = enforceReasonerAvailability(plan, settings);
      plan = applyReasoningPolicyToPlan(plan, settings);
      plan = applyBehaviorPolicyToPlan(plan, settings);
      const scopedCardJobs = filterCardJobsForScope(plan.cardJobs, settings);
      plan = {
        ...plan,
        cardJobs: scopedCardJobs.cardJobs,
        diagnostics: mergeDiagnostics(
          plan.diagnostics,
          scopeOmissionReasons(scopedCardJobs.omitted),
          autoScopeExceptionReasons(scopedCardJobs.cardJobs, settings)
        )
      };
      if (!isActiveRun(runId)) return supersededResult(runId);
      lastPlan = plan;
      const sceneSnapshot = snapshotForPlan(snapshot, plan);
      if (sceneSnapshot !== snapshot) {
        lastSnapshot = sceneSnapshot;
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

      stageRuntimeActivity({
        runId,
        phase: 'cardBatchRunning',
        label: plan.cardJobs?.length ? 'Generating scene cards...' : 'Reusing scene deck...',
        cardCounts: { requested: plan.cardJobs?.length || 0 },
        chips: ['Cards']
      });
      const cache = sceneSnapshot.chatKey === snapshot.chatKey && sceneSnapshot.sceneKey === snapshot.sceneKey
        ? initialCache
        : await loadSceneCacheSafe(runId, sceneSnapshot, settings);
      if (!isActiveRun(runId)) return supersededResult(runId);
      const scopedCardOmissionDiagnostics = [];
      const filterScopedCards = (cards) => {
        const scoped = filterCardsForScope(cards, settings);
        scopedCardOmissionDiagnostics.push(
          ...scopeOmissionReasons(scoped.omitted),
          ...autoScopeExceptionReasons(scoped.cards, settings)
        );
        return scoped.cards;
      };
      const cacheCards = filterScopedCards(sanitizedCacheCards(runId, sceneSnapshot, cache?.cards));
      const reuseCacheOnly = action === 'reuse-cache' && cacheCards.length > 0;
      const providerCards = reuseCacheOnly ? [] : filterScopedCards(
        (await generatePlanCards({ runId, plan, snapshot: sceneSnapshot, settings, signal })).map(sanitizeGeneratedCard)
      );
      if (!isActiveRun(runId)) return supersededResult(runId);
      const useLocalFallbackCards = !reuseCacheOnly && !cacheCards.length && !providerCards.length;
      const generatedCards = useLocalFallbackCards ? filterScopedCards(localCards(sceneSnapshot).map(sanitizeGeneratedCard)) : [];
      if (scopedCardOmissionDiagnostics.length) {
        plan = {
          ...plan,
          diagnostics: mergeDiagnostics(plan.diagnostics, scopedCardOmissionDiagnostics)
        };
        lastPlan = plan;
      }
      stageCardProgress(runId, cacheCards, { source: 'cache', state: 'cached' });
      stageCardProgress(runId, providerCards, { source: 'generated', state: 'done' });
      stageCardProgress(runId, generatedCards, { source: 'fallback', state: 'warning' });
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
      const effectiveSettings = settingsForPlan(settings, plan);
      const behaviorPolicy = runPolicyForEffectivePlan(settings, plan);

      stageRuntimeActivity({
        runId,
        phase: 'handSelected',
        label: 'Selecting turn hand...',
        cardCounts: { selected: Math.min(deck.cards.length, budgetOr(plan.budgets?.maxCards, 6)) }
      });
      let promptSnapshot = sceneSnapshot;
      let promptDeck = deck;
      let hand = selectHand(deck.cards, {
        maxCards: budgetOr(plan.budgets?.maxCards, 6),
        maxTokens: budgetOr(plan.budgets?.targetBriefTokens, 700),
        behaviorPolicy
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
          error: freshness.error
        });
      }
      promptSnapshot = freshness.snapshot;
      if (promptSnapshot.sceneKey !== sceneSnapshot.sceneKey || promptSnapshot.sceneFingerprint !== sceneSnapshot.sceneFingerprint) {
        promptDeck = {
          ...deck,
          cards: rebaseCardsForSnapshot(deck.cards, promptSnapshot, plan)
        };
        hand = selectHand(promptDeck.cards, {
          maxCards: budgetOr(plan.budgets?.maxCards, 6),
          maxTokens: budgetOr(plan.budgets?.targetBriefTokens, 700),
          behaviorPolicy
        });
      }
      lastSnapshot = promptSnapshot;

      await runStorageSaveSection(runId, () => saveSceneCacheSafe(
        runId,
        promptSnapshot,
        sceneCachePayload(promptSnapshot, promptDeck, hand, plan, null, settings)
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
        signal
      });
      if (!isActiveRun(runId)) return supersededResult(runId);
      lastHand = hand;
      lastPacket = packet;

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
              error: freshness.error
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
          hand = selectHand(promptDeck.cards, {
            maxCards: budgetOr(plan.budgets?.maxCards, 6),
            maxTokens: budgetOr(plan.budgets?.targetBriefTokens, 700),
            behaviorPolicy
          });
          await runStorageSaveSection(runId, () => saveSceneCacheSafe(
            runId,
            promptSnapshot,
            sceneCachePayload(promptSnapshot, promptDeck, hand, plan, null, settings)
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
            signal
          });
          if (!isActiveRun(runId)) return supersededResult(runId);
          lastSnapshot = promptSnapshot;
          lastHand = hand;
          lastPacket = packet;
        }
        const install = await installPrompt(host, packet);
        const installOk = install?.ok !== false;
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
          sceneCachePayload(promptSnapshot, promptDeck, hand, plan, packet, settings)
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

  return {
    storage,
    prepareForGeneration,
    async dispose() {
      supersedeActiveRun();
      await waitForExternalMutations();
    },
    async refreshScene() {
      return prepareForGeneration({ refreshReason: 'user-refresh' });
    },
    handleChatChanged,
    handleSourceChanged,
    updateSettings,
    updateProvider,
    clearProviderKey,
    testProvider,
    resetSceneCache,
    clearRunJournal,
    exportDiagnostics,
    view() {
      return {
        activeRunId,
        lastPacket,
        lastHand,
        lastPlan,
        lastSnapshot: viewSnapshot(lastSnapshot),
        activity: safeCurrentActivity(activity),
        activityHistory: safeActivityHistory(activity),
        settings: safeSettingsView(settingsStore.get()),
        updatedAt: nowIso()
      };
    }
  };
}
