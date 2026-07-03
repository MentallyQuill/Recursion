import { hashJson, safeId } from '../../core.mjs';
import { packetToPromptBlocks } from '../../prompt.mjs';
import { createProviderClient, machineJsonSchemaForRequest } from '../../providers.mjs';
import { normalizeReasoningCategory, normalizeReasoningIntent } from '../../reasoning-policy.mjs';
import { normalizeRetentionSettings, selectBoundedSourceWindow } from '../../retention-policy.mjs';
import { createSettingsStore } from '../../settings.mjs';
import { createMemoryStorageAdapter } from '../../storage.mjs';
import { createSillyTavernUserFileStorageAdapter } from './storage.mjs';

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
const PROMPT_ROLES = new Set(['system', 'user', 'assistant']);
const UNSAFE_PROMPT_TEXT_PATTERN = /\bhidden\s+chain[-\s]of[-\s]thought\b|\bchain[-\s]of[-\s]thought\b|\b(hidden|private|secret|undisclosed)\s+(internal\s+)?thoughts?\b|\b(private|hidden|secret|undisclosed)\s+(character\s+)?motives?\b|\b(secret|hidden|private|undisclosed)\s+future\s+(plans?|plot|story)\b|\breveal\s+future\s+plans?\b|\bfuture[-\s]plot\b|\b(hidden|private|secret|undisclosed)\s+spoilers?\b|\breveal\s+spoilers?\b/i;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

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
  return stringValue(message?.mes ?? message?.text ?? message?.content);
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
  const mesId = numericMessageId(source, index);
  const role = messageRole(source);
  const visible = source.visible === false || source.hidden === true || source.is_system === true ? false : true;
  const text = messageText(source);
  const swipeId = finiteNonNegativeInteger(source.swipe_id);
  const swipeCount = Array.isArray(source.swipes) ? source.swipes.length : null;
  const activeText = activeSwipeText(source, text);
  return {
    id: stringValue(source.mesid ?? source.id ?? source.index ?? index),
    mesId,
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
      mesid: message.mesId,
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
  return types[key] ?? key;
}

function resolvePromptRole(context, role) {
  const requested = String(role || 'system').trim().toLowerCase();
  const requestedRole = PROMPT_ROLES.has(requested) ? requested : 'system';
  const key = requestedRole.toUpperCase();
  const roles = asObject(context.extension_prompt_roles);
  if (Object.prototype.hasOwnProperty.call(roles, key)) {
    return {
      value: roles[key],
      requestedRole,
      usedRole: requestedRole,
      fallback: false
    };
  }
  return {
    value: Object.prototype.hasOwnProperty.call(roles, 'SYSTEM') ? roles.SYSTEM : 'SYSTEM',
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

function generationResponseText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
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
    return { ...response, text: generationResponseText(response.text, response.content, response.message) };
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
  return request.responseLength ?? request.maxTokens ?? request.providerConfig?.maxTokens;
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
      extractData: true,
      includePreset: request.machineJson === true ? false : true,
      includeInstruct: request.machineJson === true ? false : true
    },
    {
      temperature: requestTemperature(request),
      top_p: requestTopP(request),
      ...(requestJsonSchema(request) ? { json_schema: requestJsonSchema(request) } : {}),
      ...(reasoning ? { reasoning } : {}),
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
          context.setExtensionPrompt(
            key,
            stringValue(block.text),
            promptPosition(context, block.placement),
            Number(block.depth) || 0,
            scanValue(block),
            roleResolution.value
          );
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

  const host = {
    id: 'sillytavern',
    settingsStore,
    storageAdapter: storage,
    generation,
    providerClient: null,
    prompt,
    snapshot
  };
  host.providerClient = createProviderClient({ host, settingsStore, fetchImpl });
  return host;
}
