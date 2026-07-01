import { createActivityReporter } from './activity.mjs';
import { CARD_CATALOG, applyCardPlan, buildCardRequests, cardsFromProviderResult, normalizeCard, selectHand } from './cards.mjs';
import { compact, hashJson, makeId, nowIso, redact, truncate } from './core.mjs';
import { composePromptPacket } from './prompt.mjs';
import { createSettingsStore } from './settings.mjs';
import { createMemoryStorageAdapter, createStorageRepository } from './storage.mjs';

const UTILITY_ARBITER_SCHEMA = 'recursion.utilityArbiter.v1';
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

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  return {
    schema: UTILITY_ARBITER_SCHEMA,
    snapshotHash,
    action: 'compose-brief',
    sceneStatus: 'same-scene',
    promptFootprint: normalizePromptFootprint(settings.promptFootprint, 'normal'),
    cardJobs: [],
    reasonerDecision: {
      mode: settings.reasonerUse === 'always' ? 'use' : 'skip',
      reason: 'local fallback',
      signals: []
    },
    budgets: {
      targetBriefTokens: settings.promptFootprint === 'rich' ? 900 : 500,
      maxCards: 6
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

function planAction(plan) {
  const action = cleanString(plan?.action, 'compose-brief');
  return PLAN_ACTIONS.has(action) ? action : 'compose-brief';
}

function settingsForPlan(settings, plan) {
  const promptFootprint = normalizePromptFootprint(plan?.promptFootprint, settings.promptFootprint);
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

function sceneCachePayload(snapshot, deck, hand, plan) {
  return {
    cacheState: 'active',
    source: {
      chatIdHash: hashJson(snapshot.chatId),
      latestMesId: snapshot.latestMesId,
      sceneFingerprint: snapshot.sceneFingerprint,
      chatWindowHash: hashJson(snapshot.messages),
      sceneStatus: plan.sceneStatus
    },
    cards: deck.cards,
    latestHand: hand
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
    mode: safeText(source.mode || 'auto', 40),
    strength: safeText(source.strength || 'balanced', 40),
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
  return {
    mode: safeText(source.mode || 'observe', 40),
    strength: safeText(source.strength || 'balanced', 40),
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
      viewerOpen: source.ui?.viewerOpen === true
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
  const cards = (Array.isArray(source.cards) ? source.cards : [])
    .map((card) => compactCacheCardForArbiter(card, snapshot))
    .filter(Boolean)
    .slice(0, 32);
  const latestHand = asObject(source.latestHand);
  const handCards = Array.isArray(latestHand.cards)
    ? latestHand.cards.map((card) => arbiterSafeRef(card?.id || card?.cardId || '', 'card')).filter(Boolean).slice(0, 16)
    : [];
  const handId = arbiterSafeRef(latestHand.handId || '', 'hand');
  return {
    available: cards.length > 0,
    sceneKey: safeText(snapshot?.sceneKey || DEFAULT_SCENE_KEY, 160) || DEFAULT_SCENE_KEY,
    sceneFingerprint: safeText(snapshot?.sceneFingerprint || '', 180),
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

function signalAwareGenerationRouter(router, signal, runId) {
  if (!router || !signal) return router;
  return {
    ...router,
    generate(roleId, request = {}, options = {}) {
      const nextRequest = { ...asObject(request), signal };
      const nextOptions = { ...asObject(options), runId: options.runId ?? runId, signal: options.signal ?? signal };
      return router.generate(roleId, nextRequest, nextOptions);
    },
    batch(requests = [], options = {}) {
      if (typeof router.batch !== 'function') return undefined;
      const nextRequests = Array.isArray(requests)
        ? requests.map((request) => ({ ...asObject(request), signal: request?.signal ?? signal }))
        : requests;
      const nextOptions = { ...asObject(options), runId: options.runId ?? runId, signal: options.signal ?? signal };
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
  let promptInstallTail = Promise.resolve();
  let storageSaveTail = Promise.resolve();
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

  async function clearPromptAfterSupersede({ successLabel = 'Recursion prompt cleared after settings change.' } = {}) {
    const runId = makeId('settings');
    activePromptMutationId = runId;
    startRuntimeActivity({
      runId,
      phase: 'promptClearing',
      label: 'Clearing Recursion prompt...',
      chips: ['Prompt']
    });
    const clear = await runPromptMutationSection(null, () => clearPromptBestEffort(host));
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
    if (Object.keys(cleanPatch).length > 0) {
      supersedeActiveRun();
      const clear = await clearPromptAfterSupersede({
        successLabel: next.mode === 'off'
          ? 'Recursion Off. Prompt cleared.'
          : 'Recursion prompt cleared after settings change.'
      });
      return { ok: clear?.ok !== false, settings: next, clear };
    }
    return { ok: true, settings: next, clear: null };
  }

  async function updateProvider(lane, patch = {}) {
    const provider = settingsStore.updateProvider(providerLane(lane), patch);
    supersedeActiveRun();
    const clear = await clearPromptAfterSupersede({
      successLabel: 'Recursion prompt cleared after provider change.'
    });
    return { ok: clear?.ok !== false, provider, clear };
  }

  async function clearProviderKey(lane) {
    const provider = settingsStore.clearApiKey(providerLane(lane));
    supersedeActiveRun();
    const clear = await clearPromptAfterSupersede({
      successLabel: 'Recursion prompt cleared after provider key change.'
    });
    return { ok: clear?.ok !== false, provider, clear };
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
      lastTest: {
        status: 'fail',
        checkedAt,
        compactError
      }
    });
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
      if (result?.ok) {
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
    try {
      await Promise.all([promptInstallTail, storageSaveTail]);
    } catch {
      // Mutation failures are normalized at their source; tails are only sequencing gates.
    }
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

  async function loadSceneCacheSafe(runId, snapshot) {
    try {
      return await storage.loadSceneCache(snapshot.chatKey, snapshot.sceneKey);
    } catch (error) {
      reportStorageWarning(runId, 'loadSceneCache', error);
      return null;
    }
  }

  async function saveSceneCacheSafe(runId, snapshot, value) {
    try {
      return await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, value);
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
    if (!generationRouter || typeof generationRouter.generate !== 'function') return fallbackPlan;
    stageRuntimeActivity({
      runId,
      phase: 'arbiterPlanning',
      label: 'Planning card pass...',
      providerLane: 'utility',
      chips: ['Utility']
    });
    try {
      const cacheView = compactSceneCacheForArbiter(sceneCache, snapshot);
      const result = await generationRouter.generate('utilityArbiter', {
        runId,
        signal,
        prompt: [
          'Return a Recursion Utility Arbiter plan as strict JSON.',
          `Schema: ${UTILITY_ARBITER_SCHEMA}`,
          `Settings: ${JSON.stringify(arbiterSafeSettings(settings))}`,
          `Provider health: ${JSON.stringify(providerHealthForArbiter(settings))}`,
          `Catalog: ${JSON.stringify(CARD_CATALOG)}`,
          `Catalog hash: ${hashJson(CARD_CATALOG)}`,
          `Snapshot hash: ${fallbackPlan.snapshotHash}`,
          `User message hash: ${hashJson(userMessage)}`,
          `Scene cache: ${JSON.stringify(cacheView)}`,
          `Snapshot: ${JSON.stringify(providerSafeSnapshot(snapshot))}`
        ].join('\n\n')
      }, { runId, signal });
      if (result?.ok) return mergePlan(fallbackPlan, result.data);
      return markArbiterFallback(fallbackPlan, result?.error?.message || result?.error?.code || 'utility arbiter returned non-ok result');
    } catch (error) {
      return markArbiterFallback(fallbackPlan, error?.message || error);
    }
  }

  async function generatePlanCards({ runId, plan, snapshot, signal }) {
    if (!generationRouter || typeof generationRouter.batch !== 'function') return [];
    const requests = buildCardRequests(plan, {
      runId,
      snapshotHash: plan.snapshotHash || hashJson(snapshot),
      snapshot: providerSafeSnapshot(snapshot)
    });
    if (!requests.length) return [];
    stageRuntimeActivity({
      runId,
      phase: 'cardBatchRunning',
      label: 'Generating scene cards...',
      cardCounts: { requested: requests.length },
      providerLane: 'utility',
      chips: ['Cards', String(requests.length)]
    });
    try {
      const signalRequests = signal
        ? requests.map((request) => ({ ...request, signal }))
        : requests;
      const results = await generationRouter.batch(signalRequests, { runId, signal });
      return results.flatMap((result, index) => cardsFromProviderResult(result, {
        ...cardSourceContext(snapshot),
        expectedRole: requests[index]?.metadata?.role,
        expectedFamily: requests[index]?.metadata?.family
      }));
    } catch {
      return [];
    }
  }

  async function prepareForGeneration({ userMessage = '' } = {}) {
    const settings = settingsStore.get();
    if (settings.mode === 'off') {
      await waitForExternalMutations();
      supersedeActiveRun();
      const clearRunId = makeId('run');
      startRuntimeActivity({
        runId: clearRunId,
        phase: 'promptClearing',
        label: 'Clearing Recursion prompt...',
        chips: ['Prompt']
      });
      const clear = await runPromptMutationSection(null, () => clearPromptBestEffort(host));
      if (clear?.ok === false) reportClearWarning(clearRunId, clear);
      else safeActivity(activity, 'clear');
      return { ok: true, skipped: true, reason: 'off', clear };
    }

    await waitForExternalMutations();
    const pendingUserMessage = normalizePendingUserMessage(userMessage);
    const runId = makeId('run');
    const signal = startRun(runId);
    startRuntimeActivity({ runId, label: 'Reading current turn...', chips: ['Auto'] });
    try {
      const snapshot = snapshotWithPendingUserMessage(await readSnapshot(), pendingUserMessage);
      if (!isActiveRun(runId)) return supersededResult(runId);
      lastSnapshot = snapshot;
      const fallbackPlan = localFallbackPlan(snapshot, settings);
      fallbackPlan.source = {
        ...fallbackPlan.source,
        userMessageHash: hashJson(pendingUserMessage.text),
        catalogHash: hashJson(CARD_CATALOG)
      };
      const initialCache = await loadSceneCacheSafe(runId, snapshot);
      if (!isActiveRun(runId)) return supersededResult(runId);
      const plan = await askUtilityArbiter({
        runId,
        snapshot,
        settings,
        fallbackPlan,
        sceneCache: initialCache,
        userMessage: pendingUserMessage.text,
        signal
      });
      if (!isActiveRun(runId)) return supersededResult(runId);
      lastPlan = plan;
      const sceneSnapshot = snapshotForPlan(snapshot, plan);
      if (sceneSnapshot !== snapshot) {
        lastSnapshot = sceneSnapshot;
      }
      const action = planAction(plan);
      if (action === 'skip') {
        const clear = await runPromptMutationSection(runId, () => clearPromptBestEffort(host));
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
        : await loadSceneCacheSafe(runId, sceneSnapshot);
      if (!isActiveRun(runId)) return supersededResult(runId);
      const cacheCards = sanitizedCacheCards(runId, sceneSnapshot, cache?.cards);
      const reuseCacheOnly = action === 'reuse-cache' && cacheCards.length > 0;
      const providerCards = reuseCacheOnly ? [] : (await generatePlanCards({ runId, plan, snapshot: sceneSnapshot, signal })).map(sanitizeGeneratedCard);
      if (!isActiveRun(runId)) return supersededResult(runId);
      const useLocalFallbackCards = !reuseCacheOnly && !cacheCards.length && !providerCards.length;
      const generatedCards = useLocalFallbackCards ? localCards(sceneSnapshot).map(sanitizeGeneratedCard) : [];
      if (action === 'reuse-cache' && !cacheCards.length) {
        const clear = await runPromptMutationSection(runId, () => clearPromptBestEffort(host));
        if (clear?.superseded) return clear;
        if (!isActiveRun(runId)) return supersededResult(runId);
        if (clear?.ok === false) {
          reportClearWarning(runId, clear);
        } else {
          settleRuntimeActivity({
            runId,
            outcome: 'warning',
            label: 'Recursion skipped: no reusable scene hand.'
          });
        }
        return { ok: true, skipped: true, reason: 'cache-unavailable', plan, clear };
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
        maxTokens: budgetOr(plan.budgets?.targetBriefTokens, 700)
      });

      if (settings.mode !== 'observe') {
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
            maxTokens: budgetOr(plan.budgets?.targetBriefTokens, 700)
          });
        }
        lastSnapshot = promptSnapshot;
      }

      await runStorageSaveSection(runId, () => saveSceneCacheSafe(
        runId,
        promptSnapshot,
        sceneCachePayload(promptSnapshot, promptDeck, hand, plan)
      ));
      if (!isActiveRun(runId)) return supersededResult(runId);

      let packet = await composePromptPacket({
        hand,
        snapshot: promptSnapshot,
        settings: settingsForPlan(settings, plan),
        generationRouter: signalAwareGenerationRouter(generationRouter, signal, runId),
        activity,
        runId,
        signal
      });
      if (!isActiveRun(runId)) return supersededResult(runId);
      lastHand = hand;
      lastPacket = packet;

      if (settings.mode === 'observe') {
        const clear = await runPromptMutationSection(runId, () => clearPromptBestEffort(host));
        if (clear?.superseded) return clear;
        if (!isActiveRun(runId)) return supersededResult(runId);
        if (clear?.ok === false) {
          reportClearWarning(runId, clear);
        } else {
          settleRuntimeActivity({
            runId,
            outcome: 'success',
            label: 'Observe mode: hand preview ready. No prompt injected.'
          });
        }
        return { ok: true, observe: true, packet, hand, plan, clear };
      }

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
            maxTokens: budgetOr(plan.budgets?.targetBriefTokens, 700)
          });
          await runStorageSaveSection(runId, () => saveSceneCacheSafe(
            runId,
            promptSnapshot,
            sceneCachePayload(promptSnapshot, promptDeck, hand, plan)
          ));
          if (!isActiveRun(runId)) return supersededResult(runId);
          packet = await composePromptPacket({
            hand,
            snapshot: promptSnapshot,
            settings: settingsForPlan(settings, plan),
            generationRouter: signalAwareGenerationRouter(generationRouter, signal, runId),
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
        if (!isActiveRun(runId)) return supersededResult(runId);
        const installOk = install?.ok !== false;
        await appendJournalSafe(runId, promptSnapshot.chatKey, {
          event: installOk ? 'prompt.installed' : 'prompt.install_failed',
          severity: installOk ? 'info' : 'warn',
          summary: installSummary(install),
          runId,
          sceneKey: promptSnapshot.sceneKey,
          details: installJournalDetails(install),
          hashes: { promptPacketHash: hashJson(packet) }
        });
        if (!isActiveRun(runId)) return supersededResult(runId);
        settleRuntimeActivity({
          runId,
          outcome: installOk ? 'success' : 'warning',
          label: installOk ? 'Recursion prompt ready.' : INSTALL_FAILURE_LABEL
        });
        return { ok: installOk, packet, hand, plan, install };
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
      return prepareForGeneration({ userMessage: 'manual refresh' });
    },
    updateSettings,
    updateProvider,
    clearProviderKey,
    testProvider,
    view() {
      return {
        activeRunId,
        lastPacket,
        lastHand,
        lastPlan,
        lastSnapshot: viewSnapshot(lastSnapshot),
        activity: safeCurrentActivity(activity),
        settings: safeSettingsView(settingsStore.get()),
        updatedAt: nowIso()
      };
    }
  };
}
