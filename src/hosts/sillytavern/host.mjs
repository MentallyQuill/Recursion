import { hashJson, safeId } from '../../core.mjs';
import { packetToPromptBlocks } from '../../prompt.mjs';
import { createProviderClient, machineJsonSchemaForRequest } from '../../providers.mjs';
import { normalizeReasoningCategory, normalizeReasoningIntent } from '../../reasoning-policy.mjs';
import { normalizeRetentionSettings, selectBoundedSourceWindow } from '../../retention-policy.mjs';
import { asObject } from '../../safe-values.mjs';
import { createSettingsStore } from '../../settings.mjs';
import { createMemoryStorageAdapter } from '../../storage.mjs';
import { createSillyTavernUserFileStorageAdapter } from './storage.mjs';
import { listSillyTavernConnectionProfiles } from './provider-profiles.mjs';

const KNOWN_RECURSION_PROMPT_KEYS = Object.freeze([
  'recursion.guidance',
  'recursion.cardEvidence',
  'recursion.guardrails'
]);

const PROMPT_TITLES = Object.freeze({
  guidance: 'Recursion Guidance',
  cardEvidence: 'Recursion Card Evidence',
  guardrails: 'Recursion Guardrails'
});
const PROMPT_KEYS = Object.freeze({
  guidance: 'recursion.guidance',
  cardEvidence: 'recursion.cardEvidence',
  guardrails: 'recursion.guardrails'
});

const PLACEMENT_TYPES = Object.freeze({
  before_prompt: 'BEFORE_PROMPT',
  in_prompt: 'IN_PROMPT',
  in_chat: 'IN_CHAT'
});
const SILLYTAVERN_PROMPT_TYPES = Object.freeze({
  NONE: -1,
  IN_PROMPT: 0,
  IN_CHAT: 1,
  BEFORE_PROMPT: 2
});
const SILLYTAVERN_PROMPT_ROLES = Object.freeze({
  SYSTEM: 0,
  USER: 1,
  ASSISTANT: 2
});
const PROMPT_ROLES = new Set(['system', 'user', 'assistant']);
const UNSAFE_PROMPT_TEXT_PATTERN = /\bhidden\s+chain[-\s]of[-\s]thought\b|\bchain[-\s]of[-\s]thought\b|\b(hidden|private|secret|undisclosed)\s+(internal\s+)?thoughts?\b|\b(private|hidden|secret|undisclosed)\s+(character\s+)?motives?\b|\b(secret|hidden|private|undisclosed)\s+future\s+(plans?|plot|story)\b|\breveal\s+future\s+plans?\b|\bfuture[-\s]plot\b|\b(hidden|private|secret|undisclosed)\s+spoilers?\b|\breveal\s+spoilers?\b/i;

function stringValue(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function nonEmptyString(value) {
  return stringValue(value).trim();
}

function currentContext(contextFactory) {
  if (typeof contextFactory === 'function') return asObject(contextFactory());
  if (typeof globalThis.SillyTavern?.getContext === 'function') return asObject(globalThis.SillyTavern.getContext());
  if (typeof globalThis.getContext === 'function') return asObject(globalThis.getContext());
  return asObject(globalThis);
}

function chatMetadataObject(context) {
  return asObject(context?.chatMetadata || context?.chat_metadata || globalThis.chatMetadata);
}

function firstNonEmpty(values) {
  for (const value of values) {
    const text = nonEmptyString(value);
    if (text) return text;
  }
  return '';
}

async function readChatId(context) {
  for (const key of ['chatId', 'chat_id', 'currentChatId']) {
    const value = nonEmptyString(context[key]);
    if (value) return value;
  }
  if (typeof context.getCurrentChatId === 'function') {
    const value = nonEmptyString(await context.getCurrentChatId());
    if (value) return value;
  }
  const metadata = chatMetadataObject(context);
  const metadataChatId = firstNonEmpty([metadata.chat_id, metadata.chatId, metadata.currentChatId]);
  if (metadataChatId) return metadataChatId;
  return 'unknown-chat';
}

function sceneAnchor(context) {
  const metadata = chatMetadataObject(context);
  const groupId = firstNonEmpty([
    context?.groupId,
    context?.group_id,
    context?.selectedGroupId,
    globalThis.selected_group
  ]);
  if (groupId) return { type: 'group', idHash: hashJson(groupId) };

  const characterId = firstNonEmpty([
    context?.characterId,
    context?.character_id,
    context?.this_chid,
    context?.selectedCharacterId,
    globalThis.this_chid
  ]);
  if (characterId) return { type: 'character', idHash: hashJson(characterId) };

  const characterName = firstNonEmpty([
    context?.characterName,
    context?.name2,
    metadata.characterName,
    metadata.name,
    globalThis.name2
  ]);
  if (characterName) return { type: 'character-name', nameHash: hashJson(characterName) };

  return { type: 'chat' };
}

function numericMessageId(message, index) {
  for (const key of ['mesid', 'id', 'index']) {
    const numeric = Number(message?.[key]);
    if (Number.isFinite(numeric)) return numeric;
  }
  return index;
}

function messageRole(message) {
  if (message?.is_system === true) return 'system';
  if (message?.is_user === true) return 'user';
  return 'assistant';
}

function messageText(message) {
  const visible = stringValue(message?.mes ?? message?.text ?? message?.content);
  if (visible) return visible;
  if (message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, '__recursionHeldText')) {
    return stringValue(message.__recursionHeldText);
  }
  return '';
}

function finiteNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.round(numeric));
}

function activeSwipeText(source, fallbackText) {
  const swipeId = finiteNonNegativeInteger(source?.swipe_id);
  if (swipeId === null || !Array.isArray(source?.swipes)) return fallbackText;
  const active = source.swipes[swipeId];
  return active === undefined || active === null ? fallbackText : stringValue(active);
}

function normalizeMessage(message, index) {
  const source = asObject(message);
  const mesid = numericMessageId(source, index);
  const role = messageRole(source);
  const visible = source.visible === false || source.hidden === true || source.is_system === true ? false : true;
  const text = messageText(source);
  const swipeId = finiteNonNegativeInteger(source.swipe_id);
  const swipeCount = Array.isArray(source.swipes) ? source.swipes.length : null;
  const activeText = activeSwipeText(source, text);
  return {
    id: stringValue(source.mesid ?? source.id ?? source.index ?? index),
    mesid,
    index,
    role,
    isUser: role === 'user',
    isSystem: role === 'system',
    visible,
    sender: stringValue(source.name),
    text,
    ...(swipeId !== null ? { swipeId } : {}),
    ...(swipeCount !== null ? { swipeCount } : {}),
    ...(swipeId !== null || swipeCount !== null ? { activeSwipeTextHash: hashJson(activeText) } : {})
  };
}

function rawChatMessages(context = {}) {
  if (Array.isArray(context?.chat)) return context.chat;
  if (Array.isArray(context?.messages)) return context.messages;
  return [];
}

function latestAssistantMessage(context = {}) {
  const messages = rawChatMessages(context);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const normalized = normalizeMessage(messages[index], index);
    if (normalized.visible === false || normalized.isUser || normalized.isSystem || !normalized.text) continue;
    return normalized;
  }
  return null;
}

function findRawAssistantMessage(context = {}, messageId = null) {
  const messages = rawChatMessages(context);
  const hasRequested = messageId !== undefined && messageId !== null && String(messageId).trim() !== '';
  const requested = hasRequested ? Number(messageId) : NaN;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const raw = messages[index];
    const normalized = normalizeMessage(raw, index);
    if (normalized.visible === false || normalized.isUser || normalized.isSystem) continue;
    if (Number.isFinite(requested) && normalized.mesid !== requested && normalized.index !== requested) continue;
    return { raw, normalized, index };
  }
  return null;
}

function setRawAssistantText(message, text) {
  if (!message || typeof message !== 'object') return;
  const next = stringValue(text);
  message.mes = next;
  if (Object.prototype.hasOwnProperty.call(message, 'text')) message.text = next;
  if (Object.prototype.hasOwnProperty.call(message, 'content')) message.content = next;
  const swipeId = finiteNonNegativeInteger(message.swipe_id);
  if (Array.isArray(message.swipes) && swipeId !== null) message.swipes[swipeId] = next;
}

function activeRawAssistantText(message) {
  const active = activeSwipeText(message, messageText(message));
  if (active) return active;
  if (message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, '__recursionHeldText')) {
    return stringValue(message.__recursionHeldText);
  }
  return '';
}

function updateMessageBlockBestEffort(context = {}, index, message) {
  const update = context.updateMessageBlock || globalThis.updateMessageBlock;
  if (typeof update !== 'function') return;
  try {
    update(index, message);
  } catch {
    try {
      update(message);
    } catch {
      // DOM refresh is best effort; chat state is already mutated.
    }
  }
}

function refreshSwipeControlsBestEffort(context = {}) {
  const refresh = context.swipe?.refresh || context.refreshSwipeButtons || globalThis.refreshSwipeButtons;
  if (typeof refresh !== 'function') return;
  try {
    refresh(true, false);
  } catch {
    // Chat state remains authoritative if the host cannot refresh its controls.
  }
}

function cloneJsonSafe(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function swipeInfoFromMessage(message = {}) {
  const extra = cloneJsonSafe(message.extra);
  removeEnhancementMarkerFromExtra(extra);
  return {
    send_date: stringValue(message.send_date || new Date().toISOString()),
    gen_started: message.gen_started ?? null,
    gen_finished: message.gen_finished ?? null,
    extra
  };
}

function enhancedSwipeInfo(marker = {}) {
  return {
    send_date: new Date().toISOString(),
    gen_started: null,
    gen_finished: null,
    extra: {
      api: 'recursion',
      model: 'enhancement',
      recursion: {
        enhancement: cloneJsonSafe(marker)
      }
    }
  };
}

function ensureSwipeInfoArray(message = {}) {
  if (!Array.isArray(message.swipes)) return [];
  if (!Array.isArray(message.swipe_info)) message.swipe_info = [];
  while (message.swipe_info.length < message.swipes.length) {
    message.swipe_info.push(swipeInfoFromMessage(message));
  }
  return message.swipe_info;
}

function alignRootExtraToSwipe(message = {}, swipeIndex = 0) {
  const info = Array.isArray(message.swipe_info) ? message.swipe_info[swipeIndex] : null;
  const extra = info && typeof info === 'object' ? info.extra : null;
  if (extra && typeof extra === 'object') {
    message.extra = cloneJsonSafe(extra);
  }
}

async function saveChatBestEffort(context = {}) {
  const save = context.saveChat || globalThis.saveChat || globalThis.saveChatDebounced;
  if (typeof save !== 'function') return;
  try {
    await save();
  } catch {
    // Saving is best effort here; mutation result still reports local success.
  }
}

async function saveChatRequired(context = {}) {
  const save = context.saveChat || globalThis.saveChat || globalThis.saveChatDebounced;
  if (typeof save !== 'function') {
    return {
      ok: false,
      error: {
        code: 'RECURSION_CHAT_SAVE_UNAVAILABLE',
        message: 'SillyTavern did not expose a chat save function.'
      }
    };
  }
  try {
    await save();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'RECURSION_CHAT_SAVE_FAILED',
        message: stringValue(error?.message || error || 'SillyTavern chat save failed.')
      }
    };
  }
}

function restoreJsonObject(target, snapshot) {
  for (const key of Object.keys(target || {})) delete target[key];
  Object.assign(target, cloneJsonSafe(snapshot));
}

function markerMatches(candidate = {}, marker = {}) {
  const expected = asObject(marker);
  if (!Object.keys(expected).length) return false;
  const source = asObject(candidate);
  return Object.entries(expected).every(([key, value]) => String(source[key] ?? '') === String(value ?? ''));
}

export function latestSillyTavernAssistantMessageIdentity(context = {}) {
  const latestAssistant = latestAssistantMessage(context);
  if (!latestAssistant) return '';
  return [
    stringValue(context?.chatId || context?.chat_id || ''),
    stringValue(latestAssistant.mesid ?? latestAssistant.index)
  ].join('::');
}

function eventPayload(event) {
  if (event && typeof event === 'object' && !Array.isArray(event) && Object.prototype.hasOwnProperty.call(event, 'payload')) {
    return event.payload;
  }
  return event;
}

function eventSourceObject(event) {
  const payload = eventPayload(event);
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function markerMatchesSwipeText(marker = {}, text = '') {
  const candidate = asObject(marker);
  if (candidate.schema === 'recursion.editorialMarker.v1') {
    return stringValue(candidate.candidateHash) === hashJson(stringValue(text));
  }
  if (candidate.schema === 'recursion.generationReviewMarker.v1') {
    return stringValue(candidate.enhancedHash) === hashJson(stringValue(text));
  }
  return false;
}

function removeEnhancementMarkerFromExtra(extra = {}) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return false;
  const recursion = extra.recursion;
  if (!recursion || typeof recursion !== 'object' || Array.isArray(recursion) || !recursion.enhancement) return false;
  delete recursion.enhancement;
  if (!Object.keys(recursion).length) delete extra.recursion;
  return true;
}

function eventPayloadShape(event) {
  const payload = eventPayload(event);
  const payloadType = payload === null ? 'null' : (Array.isArray(payload) ? 'array' : typeof payload);
  const payloadKeys = payloadType === 'object'
    ? Object.keys(payload).map((key) => stringValue(key).slice(0, 80)).sort().slice(0, 40)
    : [];
  return { payloadType, payloadKeys };
}

function eventDiagnosticScalar(source, key) {
  const value = source?.[key];
  if (!['string', 'number', 'boolean'].includes(typeof value)) return '';
  return stringValue(value).slice(0, 180);
}

function eventMessageId(event) {
  const source = eventSourceObject(event);
  const payload = eventPayload(event);
  if (Object.prototype.hasOwnProperty.call(source, 'messageId')) return source.messageId;
  if (Object.prototype.hasOwnProperty.call(source, 'mesid')) return source.mesid;
  if (Object.prototype.hasOwnProperty.call(source, 'id')) return source.id;
  if (Object.prototype.hasOwnProperty.call(source, 'message_id')) return source.message_id;
  if (typeof payload === 'number' || typeof payload === 'string') return payload;
  return null;
}

function eventNameOf(event, context = {}) {
  const source = eventSourceObject(event);
  const wrapper = asObject(event);
  return stringValue(
    context.eventName
      || wrapper.eventName
      || wrapper.type
      || wrapper.event
      || source.eventName
      || source.type
      || source.event
  ).toLowerCase();
}

function isLatestAssistantEvent(messageId, context = {}, swiped = false) {
  const explicitLatestId = context.latestAssistantMessageId;
  if (explicitLatestId !== undefined && explicitLatestId !== null && explicitLatestId !== '') {
    return stringValue(messageId) === stringValue(explicitLatestId);
  }
  const latestAssistant = latestAssistantMessage(context.context || context);
  if (!latestAssistant) return false;
  if (messageId === undefined || messageId === null || messageId === '') return Boolean(swiped);
  return stringValue(messageId) === stringValue(latestAssistant.mesid ?? latestAssistant.index);
}

export function normalizeSillyTavernMessageEvent(event = {}, context = {}) {
  const source = eventSourceObject(event);
  const eventName = eventNameOf(event, context);
  const payloadShape = eventPayloadShape(event);
  const rawMessageId = eventMessageId(event);
  const swiped = Boolean(source.swiped || eventName === 'message_swiped');
  const latestAssistant = latestAssistantMessage(context.context || context);
  const messageId = rawMessageId ?? (swiped && latestAssistant ? latestAssistant.mesid : null);
  return {
    eventName,
    messageId,
    ...(Number.isFinite(Number(messageId)) ? { mesid: Number(messageId) } : {}),
    swiped,
    deleted: Boolean(source.deleted || eventName === 'message_deleted'),
    edited: Boolean(source.edited || eventName === 'message_edited' || eventName === 'message_updated'),
    latestAssistant: isLatestAssistantEvent(messageId, context, swiped),
    text: generationResponseText(source.text, source.message, source.content, typeof eventPayload(event) === 'string' ? eventPayload(event) : ''),
    payloadType: payloadShape.payloadType,
    payloadKeys: payloadShape.payloadKeys,
    ...Object.fromEntries(
      ['source', 'reason', 'origin', 'action', 'cause']
        .map((key) => [key, eventDiagnosticScalar(source, key)])
        .filter(([, value]) => Boolean(value))
    )
  };
}

function latestMessageIdFromRawChat(messages) {
  const source = Array.isArray(messages) ? messages : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const numeric = numericMessageId(source[index], index);
    if (Number.isFinite(numeric)) return numeric;
  }
  return -1;
}

function sourceRevisionMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.visible !== false)
    .map((message) => ({
      mesid: message.mesid,
      role: message.role,
      textHash: hashJson(String(message.text ?? '')),
      ...(Number.isFinite(message.swipeId) ? { swipeId: message.swipeId } : {}),
      ...(Number.isFinite(message.swipeCount) ? { swipeCount: message.swipeCount } : {}),
      ...(message.activeSwipeTextHash ? { activeSwipeTextHash: message.activeSwipeTextHash } : {})
    }));
}

function fallbackPromptBlocks(packet) {
  const source = asObject(packet);
  const sections = asObject(source.sections);
  const rawPlan = Array.isArray(source.injectionPlan)
    ? source.injectionPlan
    : (Array.isArray(source.injectionPlan?.blocks) ? source.injectionPlan.blocks : []);

  return rawPlan.map((plan) => {
    const block = asObject(plan);
    const id = stringValue(block.id || block.section).trim();
    const text = stringValue(sections[id] ?? sections[block.section]);
    const promptKey = stringValue(block.promptKey).trim();
    if (!Object.prototype.hasOwnProperty.call(PROMPT_KEYS, id)) {
      throw new Error(`Unknown fallback prompt section: ${id || '(empty)'}`);
    }
    if (promptKey !== PROMPT_KEYS[id]) {
      throw new Error('SillyTavern host only accepts recursion prompt keys.');
    }
    if (UNSAFE_PROMPT_TEXT_PATTERN.test(text)) {
      throw new Error('Fallback prompt packet contains unsafe prompt text.');
    }
    return {
      id,
      promptKey,
      title: stringValue(block.title || PROMPT_TITLES[id] || id),
      packetId: stringValue(source.packetId),
      section: id,
      placement: stringValue(block.placement),
      depth: Number(block.depth) || 0,
      role: stringValue(block.role || 'system'),
      text,
      hash: hashJson(text),
      sourceIds: Array.isArray(block.sourceIds) ? [...block.sourceIds] : []
    };
  });
}

export function promptBlocksFromPacket(packet) {
  try {
    return packetToPromptBlocks(packet);
  } catch (error) {
    if (!Array.isArray(asObject(packet).injectionPlan?.blocks)) throw error;
    return fallbackPromptBlocks(packet);
  }
}

function validatePromptBlocksForInstall(blocks) {
  for (const block of blocks) {
    const key = stringValue(block.promptKey).trim();
    if (!key.startsWith('recursion.')) {
      throw new Error('SillyTavern host only accepts recursion prompt keys.');
    }
    if (UNSAFE_PROMPT_TEXT_PATTERN.test(stringValue(block.text))) {
      throw new Error('SillyTavern host rejected unsafe prompt text.');
    }
  }
}

function promptPosition(context, placement) {
  const key = PLACEMENT_TYPES[String(placement || '').trim().toLowerCase()] || PLACEMENT_TYPES.in_prompt;
  const types = asObject(context.extension_prompt_types);
  const contextualValue = Number(types[key]);
  return Number.isFinite(contextualValue) ? contextualValue : SILLYTAVERN_PROMPT_TYPES[key];
}

function resolvePromptRole(context, role) {
  const requested = String(role || 'system').trim().toLowerCase();
  const requestedRole = PROMPT_ROLES.has(requested) ? requested : 'system';
  const key = requestedRole.toUpperCase();
  const roles = asObject(context.extension_prompt_roles);
  const contextualValue = Number(roles[key]);
  if (Number.isFinite(contextualValue)) {
    return {
      value: contextualValue,
      requestedRole,
      usedRole: requestedRole,
      fallback: false
    };
  }
  if (Object.keys(roles).length === 0) {
    return {
      value: SILLYTAVERN_PROMPT_ROLES[key],
      requestedRole,
      usedRole: requestedRole,
      fallback: false
    };
  }
  return {
    value: Number.isFinite(Number(roles.SYSTEM)) ? Number(roles.SYSTEM) : SILLYTAVERN_PROMPT_ROLES.SYSTEM,
    requestedRole,
    usedRole: 'system',
    fallback: requestedRole !== 'system'
  };
}

function promptRole(context, role) {
  return resolvePromptRole(context, role).value;
}

function scanValue(block) {
  if (Object.prototype.hasOwnProperty.call(block, 'scan')) return block.scan;
  if (Object.prototype.hasOwnProperty.call(block, 'scanDepth')) return block.scanDepth;
  return false;
}

function inspectablePromptStore(context) {
  const store = context?.extensionPrompts ?? context?.extension_prompts;
  return store && typeof store === 'object' && !Array.isArray(store) ? store : null;
}

function assertPromptStored(context, { key, text, position, depth, role }) {
  const store = inspectablePromptStore(context);
  if (!store) return;
  const stored = asObject(store[key]);
  const valid = stored.value === text
    && Number.isFinite(stored.position)
    && stored.position === position
    && Number.isFinite(stored.depth)
    && stored.depth === depth
    && Number.isFinite(stored.role)
    && stored.role === role;
  if (valid) return;
  const error = new Error(`SillyTavern prompt install rejected ${key}.`);
  error.code = 'RECURSION_PROMPT_INSTALL_REJECTED';
  throw error;
}

function generationResponseText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      const choice = Array.isArray(value.choices) ? value.choices[0] : null;
      const candidate = Array.isArray(value.candidates) ? value.candidates[0] : null;
      const output = Array.isArray(value.outputs) ? value.outputs[0] : (Array.isArray(value.output) ? value.output[0] : null);
      const visible = generationResponseText(
        choice?.message?.content,
        choice?.delta?.content,
        choice?.text,
        candidate?.content,
        candidate?.text,
        output?.content,
        output?.text,
        value.content,
        value.text,
        value.value
      );
      if (visible) return visible;
      try {
        return JSON.stringify(value);
      } catch {
        return stringValue(value);
      }
    }
    return stringValue(value);
  }
  return '';
}

function normalizeGenerationResponse(response) {
  if (response && typeof response === 'object') {
    return { ...response, text: generationResponseText(response.text, response.content, response.message, response) };
  }
  return { text: stringValue(response) };
}

function normalizeGenerationFailure(error) {
  const code = stringValue(error?.code || error?.name || 'RECURSION_HOST_GENERATION_FAILED').trim()
    || 'RECURSION_HOST_GENERATION_FAILED';
  const message = stringValue(error?.message || error || 'Host generation failed.').replace(/\s+/g, ' ').trim()
    || 'Host generation failed.';
  return {
    ok: false,
    text: '',
    error: {
      code: code.slice(0, 120),
      message: message.slice(0, 300),
      retryable: error?.retryable === true,
      ...(error?.status !== undefined ? { status: error.status } : {})
    }
  };
}

function stopUnavailableResult() {
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

function stopFailedResult(error) {
  const code = stringValue(error?.code || error?.name || 'RECURSION_HOST_STOP_FAILED').trim()
    || 'RECURSION_HOST_STOP_FAILED';
  const message = stringValue(error?.message || error || 'SillyTavern stop generation failed.').replace(/\s+/g, ' ').trim()
    || 'SillyTavern stop generation failed.';
  return {
    ok: false,
    stopped: false,
    eventEmitted: false,
    error: {
      code: code.slice(0, 120),
      message: message.slice(0, 300)
    }
  };
}

function nativeGenerationType(value) {
  const type = stringValue(value || 'regenerate').trim().toLowerCase();
  return ['normal', 'regenerate', 'continue', 'swipe'].includes(type) ? type : 'regenerate';
}

function startUnavailableResult() {
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

function startFailedResult(error) {
  const code = stringValue(error?.code || error?.name || 'RECURSION_HOST_GENERATION_FAILED').trim()
    || 'RECURSION_HOST_GENERATION_FAILED';
  const message = stringValue(error?.message || error || 'SillyTavern native generation failed.').replace(/\s+/g, ' ').trim()
    || 'SillyTavern native generation failed.';
  return {
    ok: false,
    started: false,
    completed: false,
    error: {
      code: code.slice(0, 120),
      message: message.slice(0, 300)
    }
  };
}

function findStopButton(context) {
  const documentRef = context?.document || globalThis.document;
  if (typeof documentRef?.querySelector !== 'function') return null;
  return documentRef.querySelector('#mes_stop') || documentRef.querySelector('.mes_stop');
}

function clickStopButton(button) {
  if (!button) return false;
  if (typeof button.click === 'function') {
    button.click();
    return true;
  }
  if (typeof button.dispatchEvent === 'function' && typeof globalThis.Event === 'function') {
    button.dispatchEvent(new globalThis.Event('click', { bubbles: true, cancelable: true }));
    return true;
  }
  return false;
}

function notifyBatchSlotSettled(onSlotSettled, slot) {
  if (typeof onSlotSettled !== 'function') return;
  try {
    const result = onSlotSettled(slot);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // Batch slot observers are advisory; generation results must still resolve.
  }
}

function requestProviderSource(request = {}) {
  return stringValue(request.providerSource ?? request.providerConfig?.source).trim();
}

function requestHostConnectionProfileId(request = {}) {
  return request.hostConnectionProfileId ?? request.providerConfig?.hostConnectionProfileId;
}

function profileGenerationRequested(request = {}) {
  const source = requestProviderSource(request);
  if (source) return source === 'host-connection-profile';
  return Boolean(requestHostConnectionProfileId(request));
}

function requestMaxTokens(request = {}) {
  const positive = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  };
  const configured = positive(request.providerConfig?.maxTokens);
  const requested = positive(request.responseLength) ?? positive(request.maxTokens);
  if (configured && requested) return Math.min(configured, requested);
  return configured ?? requested;
}

function requestTemperature(request = {}) {
  return request.temperature ?? request.providerConfig?.temperature;
}

function requestTopP(request = {}) {
  return request.topP ?? request.providerConfig?.topP;
}

function requestJsonSchema(request = {}) {
  const jsonSchema = machineJsonSchemaForRequest(request);
  return jsonSchema ? { name: jsonSchema.name, value: jsonSchema.schema } : null;
}

function requestMessages(request = {}) {
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    return request.messages
      .map((message) => ({
        role: ['system', 'assistant', 'user'].includes(stringValue(message?.role).trim())
          ? stringValue(message.role).trim()
          : 'user',
        content: stringValue(message?.content ?? message?.text ?? message?.value)
      }))
      .filter((message) => message.content.trim());
  }
  return [
    ...(stringValue(request.systemPrompt).trim() ? [{ role: 'system', content: stringValue(request.systemPrompt) }] : []),
    { role: 'user', content: stringValue(request.prompt) }
  ];
}

function requestReasoning(request = {}) {
  const intent = normalizeReasoningIntent(request.reasoningIntent);
  if (!intent) return null;
  const category = normalizeReasoningCategory(request.reasoningCategory);
  return {
    intent,
    ...(category ? { category } : {}),
    exclude: true
  };
}

function connectionProfileService(context) {
  const service = context.ConnectionManagerRequestService || globalThis.ConnectionManagerRequestService;
  return typeof service?.sendRequest === 'function' ? service : null;
}

async function sendViaConnectionProfile(context, request = {}) {
  const profileId = stringValue(requestHostConnectionProfileId(request)).trim();
  if (!profileId) {
    const error = new Error('Host connection profile id is missing.');
    error.code = 'RECURSION_HOST_PROFILE_MISSING';
    error.retryable = false;
    throw error;
  }
  const service = connectionProfileService(context);
  if (!service) throw hostProfileUnsupportedError();
  const reasoning = requestReasoning(request);
  return normalizeGenerationResponse(await service.sendRequest(
    profileId,
    requestMessages(request),
    requestMaxTokens(request),
    {
      stream: false,
      // Connection Manager collapses a malformed structured reply to `{}` when it
      // extracts it itself. Keep the raw provider envelope so Recursion's parser
      // can apply its bounded recovery policy.
      extractData: request.machineJson !== true,
      includePreset: request.machineJson === true ? false : true,
      includeInstruct: request.machineJson === true ? false : true
    },
    {
      temperature: requestTemperature(request),
      top_p: requestTopP(request),
      ...(requestJsonSchema(request) ? { json_schema: requestJsonSchema(request) } : {}),
      ...(reasoning ? {
        reasoning,
        reasoning_effort: reasoning.intent,
        include_reasoning: !reasoning.exclude
      } : {}),
      signal: request.signal
    }
  ));
}

function hostProfileUnsupportedError() {
  const error = new Error('Host connection profile generation requires the SillyTavern raw generation API.');
  error.code = 'RECURSION_HOST_PROFILE_UNSUPPORTED';
  error.retryable = false;
  return error;
}

function createLiveSettingsRoot(resolveRoot) {
  const fallbackRoot = {};
  function currentRoot() {
    const root = resolveRoot?.();
    return root && typeof root === 'object' ? root : fallbackRoot;
  }
  return {
    get recursion() {
      return currentRoot().recursion;
    },
    set recursion(value) {
      currentRoot().recursion = value;
    }
  };
}

export function createSillyTavernHost({
  contextFactory = null,
  settingsRoot = null,
  saveSettings = null,
  storageAdapter = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const installedPromptKeys = new Set();
  const resolvedSettingsRoot = settingsRoot || createLiveSettingsRoot(() => {
    const context = currentContext(contextFactory);
    return context.extensionSettings || globalThis.extension_settings || null;
  });
  const resolvedSaveSettings = saveSettings || (() => {
    const context = currentContext(contextFactory);
    const save = context.saveSettingsDebounced || globalThis.saveSettingsDebounced;
    if (typeof save === 'function') save();
  });
  const settingsStore = createSettingsStore({ root: resolvedSettingsRoot, save: resolvedSaveSettings });
  const storage = storageAdapter || (
    typeof fetchImpl === 'function'
      ? createSillyTavernUserFileStorageAdapter({ contextFactory, fetchImpl })
      : createMemoryStorageAdapter()
  );

  async function snapshot() {
    const context = currentContext(contextFactory);
    const chatId = await readChatId(context);
    const chatKey = safeId(chatId, 'chat');
    const retention = normalizeRetentionSettings(settingsStore.get().retention);
    const rawChat = Array.isArray(context.chat) ? context.chat : [];
    const bounded = selectBoundedSourceWindow(rawChat, retention);
    const messages = bounded.messages.map((message, index) => normalizeMessage(message, index));
    const latestMesId = latestMessageIdFromRawChat(rawChat);
    const sourceRevisionHash = hashJson(sourceRevisionMessages(messages));
    const sceneFingerprint = hashJson({
      chatKey,
      sceneAnchor: sceneAnchor(context)
    });
    const turnFingerprint = hashJson({
      chatKey,
      latestMesId,
      sourceRevisionHash,
      latestMessage: messages.at(-1) || null
    });
    const sceneKey = safeId(`${chatKey}-${sceneFingerprint}`, 'scene');

    return {
      hostId: 'sillytavern',
      chatId,
      chatKey,
      sceneFingerprint,
      sceneKey,
      sourceRevisionHash,
      turnFingerprint,
      latestMesId,
      messages,
      ...bounded.metadata
    };
  }

  function clearPromptKey(context, key) {
    if (typeof context.setExtensionPrompt !== 'function') return;
    context.setExtensionPrompt(key, '', promptPosition(context, 'in_prompt'), 0, false, promptRole(context, 'system'));
  }

  const prompt = {
    async install(packet) {
      const context = currentContext(contextFactory);
      if (typeof context.setExtensionPrompt !== 'function') {
        return {
          ok: false,
          error: {
            code: 'RECURSION_PROMPT_INSTALL_UNAVAILABLE',
            message: 'SillyTavern setExtensionPrompt API is unavailable.'
          }
        };
      }

      const blocks = promptBlocksFromPacket(packet);
      validatePromptBlocksForInstall(blocks);
      const clearResult = await this.clear();
      if (clearResult?.ok === false) {
        const error = new Error('Prompt clear failed before install.');
        error.code = 'RECURSION_PROMPT_CLEAR_FAILED';
        error.clear = clearResult;
        throw error;
      }
      const attemptedPromptKeys = new Set();
      const warnings = [];
      try {
        for (const block of blocks) {
          const key = stringValue(block.promptKey).trim();
          const roleResolution = resolvePromptRole(context, block.role);
          if (roleResolution.fallback) {
            warnings.push({
              code: 'RECURSION_PROMPT_ROLE_FALLBACK',
              promptKey: key,
              requestedRole: roleResolution.requestedRole,
              fallbackRole: roleResolution.usedRole
            });
          }
          attemptedPromptKeys.add(key);
          const text = stringValue(block.text);
          const position = promptPosition(context, block.placement);
          const depth = Number(block.depth) || 0;
          context.setExtensionPrompt(
            key,
            text,
            position,
            depth,
            scanValue(block),
            roleResolution.value
          );
          assertPromptStored(context, {
            key,
            text,
            position,
            depth,
            role: roleResolution.value
          });
          installedPromptKeys.add(key);
        }
      } catch (error) {
        const rollbackKeys = new Set([...KNOWN_RECURSION_PROMPT_KEYS, ...installedPromptKeys, ...attemptedPromptKeys]);
        for (const key of rollbackKeys) {
          try {
            clearPromptKey(context, key);
          } catch {
            // Rollback is best effort; preserve the original install failure.
          }
        }
        installedPromptKeys.clear();
        throw error;
      }
      return {
        ok: true,
        installed: [...installedPromptKeys],
        ...(warnings.length ? { warnings } : {})
      };
    },
    async clear() {
      const context = currentContext(contextFactory);
      const keys = new Set([...KNOWN_RECURSION_PROMPT_KEYS, ...installedPromptKeys]);
      if (typeof context.setExtensionPrompt !== 'function') {
        return {
          ok: false,
          clearedKeys: [],
          failedKeys: [...keys],
          error: {
            code: 'RECURSION_PROMPT_CLEAR_UNAVAILABLE',
            message: 'SillyTavern setExtensionPrompt API is unavailable.'
          }
        };
      }
      const clearedKeys = [];
      const failedKeys = [];
      for (const key of keys) {
        try {
          clearPromptKey(context, key);
          clearedKeys.push(key);
        } catch {
          failedKeys.push(key);
        }
      }
      installedPromptKeys.clear();
      for (const key of failedKeys) {
        if (!KNOWN_RECURSION_PROMPT_KEYS.includes(key)) installedPromptKeys.add(key);
      }
      if (failedKeys.length) {
        return {
          ok: false,
          clearedKeys,
          failedKeys,
          error: {
            code: 'RECURSION_PROMPT_CLEAR_FAILED',
            message: 'One or more Recursion prompt keys failed to clear.'
          }
        };
      }
      return { ok: true, clearedKeys };
    }
  };

  const generation = {
    async lockControls() {
      const context = currentContext(contextFactory);
      try {
        if (typeof context.deactivateSendButtons === 'function') context.deactivateSendButtons();
        if (typeof context.swipe?.hide === 'function') context.swipe.hide();
        return { ok: true, locked: true };
      } catch (error) {
        return {
          ok: false,
          locked: false,
          error: {
            code: 'RECURSION_HOST_CONTROL_LOCK_FAILED',
            message: stringValue(error?.message || error || 'SillyTavern controls could not be locked.').slice(0, 300)
          }
        };
      }
    },
    async unlockControls() {
      const context = currentContext(contextFactory);
      try {
        if (typeof context.activateSendButtons === 'function') context.activateSendButtons();
        return { ok: true, locked: false };
      } catch (error) {
        return {
          ok: false,
          locked: true,
          error: {
            code: 'RECURSION_HOST_CONTROL_UNLOCK_FAILED',
            message: stringValue(error?.message || error || 'SillyTavern controls could not be unlocked.').slice(0, 300)
          }
        };
      }
    },
    async start(details = {}) {
      const context = currentContext(contextFactory);
      const type = nativeGenerationType(details?.type);
      const options = asObject(details?.options);
      try {
        if (typeof context.generate === 'function') {
          await context.generate(type, options);
          return {
            ok: true,
            started: true,
            completed: true,
            type,
            source: 'context.generate'
          };
        }
        return startUnavailableResult();
      } catch (error) {
        return startFailedResult(error);
      }
    },
    async stop(details = {}) {
      const context = currentContext(contextFactory);
      try {
        if (typeof context.stopGeneration === 'function') {
          context.stopGeneration(details);
          return {
            ok: true,
            stopped: true,
            eventEmitted: true,
            source: 'context.stopGeneration'
          };
        }
        if (clickStopButton(findStopButton(context))) {
          return {
            ok: true,
            stopped: true,
            eventEmitted: true,
            source: 'dom.mes_stop'
          };
        }
        return stopUnavailableResult();
      } catch (error) {
        return stopFailedResult(error);
      }
    },
    async generate(request = {}) {
      const context = currentContext(contextFactory);
      if (profileGenerationRequested(request) && connectionProfileService(context)) {
        return sendViaConnectionProfile(context, request);
      }
      if (typeof context.generateRaw === 'function') {
        const reasoning = requestReasoning(request);
        const rawRequest = {
          prompt: stringValue(request.prompt),
          systemPrompt: request.systemPrompt,
          responseLength: requestMaxTokens(request),
          temperature: requestTemperature(request),
          topP: requestTopP(request),
          providerSource: request.providerSource,
          jsonSchema: request.jsonSchema,
          ...(reasoning
            ? {
                reasoning,
                reasoningIntent: reasoning.intent,
                ...(reasoning.category ? { reasoningCategory: reasoning.category } : {})
              }
            : {}),
          signal: request.signal
        };
        if (profileGenerationRequested(request)) {
          rawRequest.hostConnectionProfileId = requestHostConnectionProfileId(request);
        }
        return normalizeGenerationResponse(await context.generateRaw(rawRequest));
      }
      if (typeof context.generateQuietPrompt === 'function') {
        if (profileGenerationRequested(request)) {
          throw hostProfileUnsupportedError();
        }
        return normalizeGenerationResponse(await context.generateQuietPrompt(stringValue(request.prompt)));
      }
      throw new Error('SillyTavern generation API is unavailable.');
    },
    async batch(requests = [], options = {}) {
      const onSlotSettled = typeof options?.onSlotSettled === 'function' ? options.onSlotSettled : null;
      const slots = requests.map((request, index) => Promise.resolve()
        .then(() => this.generate(request))
        .then((response) => {
          notifyBatchSlotSettled(onSlotSettled, { index, request, response });
          return response;
        }, (error) => {
          const response = normalizeGenerationFailure(error);
          notifyBatchSlotSettled(onSlotSettled, { index, request, response, error: response.error });
          return response;
        }));
      return Promise.all(slots);
    }
  };
  generation.capabilities = {
    batch: {
      mode: 'concurrent',
      maxConcurrency: 4,
      slotIsolation: true,
      supportsAbortSignal: true,
      source: 'sillytavern-host-adapter'
    },
    stop: {
      source: 'sillytavern-host-adapter',
      event: 'generation_stopped'
    },
    start: {
      source: 'sillytavern-host-adapter',
      type: 'regenerate'
    }
  };

  const messagesApi = {
    activeAssistantMessageIdentity() {
      const context = currentContext(contextFactory);
      const found = findRawAssistantMessage(context);
      if (!found) return null;
      const text = activeRawAssistantText(found.raw);
      const swipeId = found.normalized.swipeId ?? finiteNonNegativeInteger(found.raw?.swipe_id) ?? 0;
      const swipeInfo = Array.isArray(found.raw?.swipe_info) ? found.raw.swipe_info[swipeId] : null;
      const swipeMarker = asObject(swipeInfo?.extra?.recursion?.enhancement);
      const indexedMarker = Array.isArray(found.raw?.__recursionGenerationReviewSwipes)
        ? asObject(found.raw.__recursionGenerationReviewSwipes[swipeId])
        : {};
      const marker = Object.keys(swipeMarker).length ? swipeMarker : indexedMarker;
      return {
        chatKey: stringValue(context?.chatId || context?.chat_id || context?.currentChatId || 'chat'),
        messageId: found.normalized.mesid,
        swipeId,
        text,
        originalHash: hashJson(text),
        enhancementOwned: markerMatchesSwipeText(marker, text)
      };
    },
    async holdAssistantMessage(messageId) {
      const context = currentContext(contextFactory);
      const found = findRawAssistantMessage(context, messageId);
      if (!found) return { ok: false, error: { code: 'RECURSION_MESSAGE_NOT_FOUND', message: 'Assistant message not found.' } };
      const activeText = activeRawAssistantText(found.raw);
      if (activeText) {
        found.raw.__recursionHeldText = activeText;
        found.raw.__recursionHeldSwipeId = finiteNonNegativeInteger(found.raw.swipe_id) ?? 0;
      }
      updateMessageBlockBestEffort(context, found.index, found.raw);
      return { ok: true, messageId: found.normalized.mesid };
    },
    async revealAssistantMessage(messageId) {
      const context = currentContext(contextFactory);
      const found = findRawAssistantMessage(context, messageId);
      if (!found) return { ok: false, error: { code: 'RECURSION_MESSAGE_NOT_FOUND', message: 'Assistant message not found.' } };
      if (found.raw.__recursionHeldText !== undefined) {
        const heldSwipeId = finiteNonNegativeInteger(found.raw.__recursionHeldSwipeId);
        if (heldSwipeId !== null && Array.isArray(found.raw.swipes) && heldSwipeId < found.raw.swipes.length) {
          found.raw.swipe_id = heldSwipeId;
        }
        setRawAssistantText(found.raw, found.raw.__recursionHeldText);
        delete found.raw.__recursionHeldText;
        delete found.raw.__recursionHeldSwipeId;
      }
      updateMessageBlockBestEffort(context, found.index, found.raw);
      await saveChatBestEffort(context);
      return { ok: true, messageId: found.normalized.mesid };
    },
    async replaceAssistantMessageText(messageId, text, options = {}) {
      const context = currentContext(contextFactory);
      const found = findRawAssistantMessage(context, messageId);
      if (!found) return { ok: false, error: { code: 'RECURSION_MESSAGE_NOT_FOUND', message: 'Assistant message not found.' } };
      const original = cloneJsonSafe(found.raw);
      if (Array.isArray(found.raw.swipes)) ensureSwipeInfoArray(found.raw);
      setRawAssistantText(found.raw, text);
      delete found.raw.__recursionHeldText;
      delete found.raw.__recursionHeldSwipeId;
      found.raw.__recursionGenerationReview = asObject(options.marker);
      const saved = await saveChatRequired(context);
      if (!saved.ok) {
        restoreJsonObject(found.raw, original);
        return saved;
      }
      updateMessageBlockBestEffort(context, found.index, found.raw);
      return { ok: true, messageId: found.normalized.mesid, text: stringValue(text) };
    },
    async appendAssistantMessageSwipe(messageId, text, options = {}) {
      const context = currentContext(contextFactory);
      const found = findRawAssistantMessage(context, messageId);
      if (!found) return { ok: false, error: { code: 'RECURSION_MESSAGE_NOT_FOUND', message: 'Assistant message not found.' } };
      const original = cloneJsonSafe(found.raw);
      if (!Array.isArray(found.raw.swipes)) found.raw.swipes = [activeRawAssistantText(found.raw)];
      ensureSwipeInfoArray(found.raw);
      const marker = asObject(options.marker);
      const index = found.raw.swipes.length;
      const swipeInfo = enhancedSwipeInfo(marker);
      found.raw.swipes.push(stringValue(text));
      found.raw.swipe_info.push(swipeInfo);
      if (!Array.isArray(found.raw.__recursionGenerationReviewSwipes)) found.raw.__recursionGenerationReviewSwipes = [];
      found.raw.__recursionGenerationReviewSwipes[index] = marker;
      if (options.select !== false) {
        found.raw.swipe_id = index;
        setRawAssistantText(found.raw, text);
        found.raw.extra = cloneJsonSafe(swipeInfo.extra);
      }
      delete found.raw.__recursionHeldText;
      delete found.raw.__recursionHeldSwipeId;
      const saved = await saveChatRequired(context);
      if (!saved.ok) {
        restoreJsonObject(found.raw, original);
        return saved;
      }
      updateMessageBlockBestEffort(context, found.index, found.raw);
      refreshSwipeControlsBestEffort(context);
      return { ok: true, messageId: found.normalized.mesid, index, text: stringValue(text) };
    },
    async findEnhancedSwipe(messageId, marker = {}) {
      const context = currentContext(contextFactory);
      const found = findRawAssistantMessage(context, messageId);
      if (!found || !Array.isArray(found.raw?.__recursionGenerationReviewSwipes)) return null;
      const markers = found.raw.__recursionGenerationReviewSwipes;
      for (let index = 0; index < markers.length; index += 1) {
        const text = Array.isArray(found.raw.swipes) ? stringValue(found.raw.swipes[index]) : '';
        if (markerMatchesSwipeText(markers[index], text) && markerMatches(markers[index], marker)) {
          return { index, text, marker: cloneJsonSafe(markers[index]) };
        }
      }
      return null;
    },
    async sanitizeAssistantEnhancementMarker(messageId) {
      const context = currentContext(contextFactory);
      const found = findRawAssistantMessage(context, messageId);
      if (!found) return { ok: false, error: { code: 'RECURSION_MESSAGE_NOT_FOUND', message: 'Assistant message not found.' } };
      const index = finiteNonNegativeInteger(found.raw.swipe_id) ?? 0;
      const text = activeRawAssistantText(found.raw);
      const swipeInfo = Array.isArray(found.raw.swipe_info) ? found.raw.swipe_info[index] : null;
      const swipeMarker = asObject(swipeInfo?.extra?.recursion?.enhancement);
      const indexedMarker = Array.isArray(found.raw.__recursionGenerationReviewSwipes)
        ? asObject(found.raw.__recursionGenerationReviewSwipes[index])
        : {};
      const marker = Object.keys(swipeMarker).length ? swipeMarker : indexedMarker;
      if (!Object.keys(marker).length || markerMatchesSwipeText(marker, text)) {
        return { ok: true, removed: false, messageId: found.normalized.mesid, index };
      }
      removeEnhancementMarkerFromExtra(swipeInfo?.extra);
      removeEnhancementMarkerFromExtra(found.raw.extra);
      if (Array.isArray(found.raw.__recursionGenerationReviewSwipes)) {
        delete found.raw.__recursionGenerationReviewSwipes[index];
      }
      if (!markerMatchesSwipeText(found.raw.__recursionGenerationReview, text)) {
        delete found.raw.__recursionGenerationReview;
      }
      updateMessageBlockBestEffort(context, found.index, found.raw);
      await saveChatBestEffort(context);
      return { ok: true, removed: true, messageId: found.normalized.mesid, index, reason: 'candidate-hash-mismatch' };
    },
    async selectAssistantMessageSwipe(messageId, swipeIndex, options = {}) {
      const context = currentContext(contextFactory);
      const found = findRawAssistantMessage(context, messageId);
      if (!found) return { ok: false, error: { code: 'RECURSION_MESSAGE_NOT_FOUND', message: 'Assistant message not found.' } };
      if (!Array.isArray(found.raw.swipes)) return { ok: false, error: { code: 'RECURSION_SWIPE_UNAVAILABLE', message: 'Swipes array not found.' } };
      ensureSwipeInfoArray(found.raw);
      const index = Math.max(0, Math.min(Number(swipeIndex), found.raw.swipes.length - 1));
      found.raw.swipe_id = index;
      const text = stringValue(found.raw.swipes[index]);
      setRawAssistantText(found.raw, text);
      alignRootExtraToSwipe(found.raw, index);
      delete found.raw.__recursionHeldText;
      delete found.raw.__recursionHeldSwipeId;
      if (options.marker) found.raw.__recursionGenerationReview = asObject(options.marker);
      updateMessageBlockBestEffort(context, found.index, found.raw);
      refreshSwipeControlsBestEffort(context);
      await saveChatBestEffort(context);
      return { ok: true, messageId: found.normalized.mesid, index, text };
    },
    async removeEmptyAssistantSwipePlaceholders(messageId) {
      const context = currentContext(contextFactory);
      const found = findRawAssistantMessage(context, messageId);
      if (!found) return { ok: false, removed: 0, error: { code: 'RECURSION_MESSAGE_NOT_FOUND', message: 'Assistant message not found.' } };
      if (!Array.isArray(found.raw.swipes) || found.raw.swipes.length <= 1) return { ok: true, removed: 0 };
      ensureSwipeInfoArray(found.raw);
      const originalSwipes = [...found.raw.swipes];
      const originalSwipeInfo = [...found.raw.swipe_info];
      const originalMarkers = Array.isArray(found.raw.__recursionGenerationReviewSwipes)
        ? [...found.raw.__recursionGenerationReviewSwipes]
        : null;
      const activeIndex = Math.max(0, Math.min(finiteNonNegativeInteger(found.raw.swipe_id) ?? 0, originalSwipes.length - 1));
      let keptIndices = originalSwipes
        .map((text, index) => (stringValue(text).trim() ? index : null))
        .filter((index) => index !== null);
      if (!keptIndices.length) keptIndices = [0];
      const removed = originalSwipes.length - keptIndices.length;
      if (!removed) return { ok: true, removed: 0 };
      const selectedOriginalIndex = keptIndices.includes(activeIndex)
        ? activeIndex
        : ([...keptIndices].reverse().find((candidate) => candidate < activeIndex) ?? keptIndices[0]);
      found.raw.swipes = keptIndices.map((index) => originalSwipes[index]);
      found.raw.swipe_info = keptIndices.map((index) => originalSwipeInfo[index]);
      if (originalMarkers) {
        found.raw.__recursionGenerationReviewSwipes = keptIndices.map((index) => originalMarkers[index]);
      }
      const index = keptIndices.indexOf(selectedOriginalIndex);
      found.raw.swipe_id = index;
      setRawAssistantText(found.raw, found.raw.swipes[index]);
      alignRootExtraToSwipe(found.raw, index);
      delete found.raw.__recursionHeldText;
      delete found.raw.__recursionHeldSwipeId;
      updateMessageBlockBestEffort(context, found.index, found.raw);
      refreshSwipeControlsBestEffort(context);
      await saveChatBestEffort(context);
      return { ok: true, removed, messageId: found.normalized.mesid, index };
    },
    async recoverHeldAssistantMessages(details = {}) {
      const context = currentContext(contextFactory);
      const messages = rawChatMessages(context);
      let recovered = 0;
      for (let index = 0; index < messages.length; index += 1) {
        const raw = messages[index];
        const normalized = normalizeMessage(raw, index);
        if (normalized.visible === false || normalized.isUser || normalized.isSystem) continue;
        if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, '__recursionHeldText')) continue;
        const heldText = stringValue(raw.__recursionHeldText);
        if (!heldText) {
          delete raw.__recursionHeldText;
          delete raw.__recursionHeldSwipeId;
          continue;
        }
        const heldSwipeId = finiteNonNegativeInteger(raw.__recursionHeldSwipeId);
        if (heldSwipeId !== null && Array.isArray(raw.swipes) && heldSwipeId < raw.swipes.length) {
          raw.swipe_id = heldSwipeId;
        }
        setRawAssistantText(raw, heldText);
        delete raw.__recursionHeldText;
        delete raw.__recursionHeldSwipeId;
        updateMessageBlockBestEffort(context, index, raw);
        recovered += 1;
      }
      if (recovered > 0) await saveChatBestEffort(context);
      return { ok: true, recovered, reason: stringValue(details.reason || '') };
    }
  };

  const host = {
    id: 'sillytavern',
    settingsStore,
    storageAdapter: storage,
    generation,
    messages: messagesApi,
    providerProfiles: {
      list(options = {}) {
        return listSillyTavernConnectionProfiles({
          context: currentContext(contextFactory),
          globals: options.globals ?? globalThis
        });
      }
    },
    normalizeMessageEvent(event = {}, options = {}) {
      return normalizeSillyTavernMessageEvent(event, {
        ...asObject(options),
        context: currentContext(contextFactory)
      });
    },
    latestAssistantMessageIdentity() {
      return latestSillyTavernAssistantMessageIdentity(currentContext(contextFactory));
    },
    providerClient: null,
    prompt,
    snapshot
  };
  host.providerClient = createProviderClient({ host, settingsStore, fetchImpl });
  return host;
}
