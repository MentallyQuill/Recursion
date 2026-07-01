import { hashJson, safeId } from '../../core.mjs';
import { packetToPromptBlocks } from '../../prompt.mjs';
import { createProviderClient } from '../../providers.mjs';
import { createSettingsStore } from '../../settings.mjs';
import { createMemoryStorageAdapter } from '../../storage.mjs';
import { createSillyTavernUserFileStorageAdapter } from './storage.mjs';

const KNOWN_RECURSION_PROMPT_KEYS = Object.freeze([
  'recursion.sceneBrief',
  'recursion.turnBrief',
  'recursion.guardrails'
]);

const PROMPT_TITLES = Object.freeze({
  sceneBrief: 'Recursion Scene Brief',
  turnBrief: 'Recursion Turn Brief',
  guardrails: 'Recursion Guardrails'
});
const PROMPT_KEYS = Object.freeze({
  sceneBrief: 'recursion.sceneBrief',
  turnBrief: 'recursion.turnBrief',
  guardrails: 'recursion.guardrails'
});

const PLACEMENT_TYPES = Object.freeze({
  before_prompt: 'BEFORE_PROMPT',
  in_prompt: 'IN_PROMPT',
  in_chat: 'IN_CHAT'
});
const UNSAFE_PROMPT_TEXT_PATTERN = /\bhidden\s+chain[-\s]of[-\s]thought\b|\bchain[-\s]of[-\s]thought\b|\b(hidden|private|secret|undisclosed)\s+(internal\s+)?thoughts?\b|\b(private|hidden|secret|undisclosed)\s+(character\s+)?motives?\b|\b(secret|hidden|private|undisclosed)\s+future\s+(plans?|plot|story)\b|\breveal\s+future\s+plans?\b|\bfuture[-\s]plot\b|\b(hidden|private|secret|undisclosed)\s+spoilers?\b|\breveal\s+spoilers?\b/i;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringValue(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function currentContext(contextFactory) {
  if (typeof contextFactory === 'function') return asObject(contextFactory());
  if (typeof globalThis.SillyTavern?.getContext === 'function') return asObject(globalThis.SillyTavern.getContext());
  if (typeof globalThis.getContext === 'function') return asObject(globalThis.getContext());
  return asObject(globalThis);
}

async function readChatId(context) {
  for (const key of ['chatId', 'chat_id', 'currentChatId']) {
    const value = stringValue(context[key]).trim();
    if (value) return value;
  }
  if (typeof context.getCurrentChatId === 'function') {
    const value = stringValue(await context.getCurrentChatId()).trim();
    if (value) return value;
  }
  return 'unknown-chat';
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

function normalizeMessage(message, index) {
  const source = asObject(message);
  const mesId = numericMessageId(source, index);
  const role = messageRole(source);
  const visible = source.visible === false || source.hidden === true || source.is_system === true ? false : true;
  return {
    id: stringValue(source.mesid ?? source.id ?? source.index ?? index),
    mesId,
    index,
    role,
    isUser: role === 'user',
    isSystem: role === 'system',
    visible,
    sender: stringValue(source.name),
    text: messageText(source)
  };
}

function latestMessageId(messages) {
  if (messages.length === 0) return -1;
  return messages.reduce((latest, message) => Math.max(latest, message.mesId), -1);
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

function promptRole(context, role) {
  const key = String(role || 'system').trim().toUpperCase();
  const roles = asObject(context.extension_prompt_roles);
  return roles[key] ?? key;
}

function scanValue(block) {
  if (Object.prototype.hasOwnProperty.call(block, 'scan')) return block.scan;
  if (Object.prototype.hasOwnProperty.call(block, 'scanDepth')) return block.scanDepth;
  return false;
}

function normalizeGenerationResponse(response) {
  if (response && typeof response === 'object') {
    return { ...response, text: stringValue(response.text ?? response.content ?? response.message) };
  }
  return { text: stringValue(response) };
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
  return normalizeGenerationResponse(await service.sendRequest(
    profileId,
    requestMessages(request),
    requestMaxTokens(request),
    {
      stream: false,
      extractData: true,
      includePreset: true,
      includeInstruct: true
    },
    {
      temperature: requestTemperature(request),
      top_p: requestTopP(request),
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

export function createSillyTavernHost({
  contextFactory = null,
  settingsRoot = globalThis.extension_settings || {},
  saveSettings = null,
  storageAdapter = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const installedPromptKeys = new Set();
  const settingsStore = createSettingsStore({ root: settingsRoot, save: saveSettings });
  const storage = storageAdapter || (
    typeof fetchImpl === 'function'
      ? createSillyTavernUserFileStorageAdapter({ contextFactory, fetchImpl })
      : createMemoryStorageAdapter()
  );

  async function snapshot() {
    const context = currentContext(contextFactory);
    const chatId = await readChatId(context);
    const chatKey = safeId(chatId, 'chat');
    const messages = (Array.isArray(context.chat) ? context.chat : []).map((message, index) => normalizeMessage(message, index));
    const latestMesId = latestMessageId(messages);
    const sceneFingerprint = hashJson({
      chatKey
    });
    const turnFingerprint = hashJson({
      chatKey,
      latestMesId,
      latestMessage: messages.at(-1) || null
    });
    const sceneKey = safeId(`${chatKey}-${sceneFingerprint}`, 'scene');

    return {
      hostId: 'sillytavern',
      chatId,
      chatKey,
      sceneFingerprint,
      sceneKey,
      turnFingerprint,
      latestMesId,
      messages
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
        throw new Error('SillyTavern setExtensionPrompt API is unavailable.');
      }

      const blocks = promptBlocksFromPacket(packet);
      validatePromptBlocksForInstall(blocks);
      await this.clear();
      const attemptedPromptKeys = new Set();
      try {
        for (const block of blocks) {
          const key = stringValue(block.promptKey).trim();
          attemptedPromptKeys.add(key);
          context.setExtensionPrompt(
            key,
            stringValue(block.text),
            promptPosition(context, block.placement),
            Number(block.depth) || 0,
            scanValue(block),
            promptRole(context, block.role)
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
      return { ok: true, installed: [...installedPromptKeys] };
    },
    async clear() {
      const context = currentContext(contextFactory);
      const keys = new Set([...KNOWN_RECURSION_PROMPT_KEYS, ...installedPromptKeys]);
      for (const key of keys) clearPromptKey(context, key);
      installedPromptKeys.clear();
      return { ok: true, clearedKeys: [...keys] };
    }
  };

  const generation = {
    async generate(request = {}) {
      const context = currentContext(contextFactory);
      if (profileGenerationRequested(request) && connectionProfileService(context)) {
        return sendViaConnectionProfile(context, request);
      }
      if (typeof context.generateRaw === 'function') {
        const rawRequest = {
          prompt: stringValue(request.prompt),
          systemPrompt: request.systemPrompt,
          responseLength: requestMaxTokens(request),
          temperature: requestTemperature(request),
          topP: requestTopP(request),
          providerSource: request.providerSource,
          jsonSchema: request.jsonSchema,
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
    async batch(requests = []) {
      const responses = [];
      for (const request of requests) responses.push(await this.generate(request));
      return responses;
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
