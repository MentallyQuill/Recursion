import { normalizeRetentionSettings } from './retention-policy.mjs';

const ENHANCEMENT_MESSAGE_MIN = 0;
const ENHANCEMENT_MESSAGE_MAX = 35;
const ENHANCEMENT_CONTEXT_CHARACTERS = 9000;
const MESSAGE_TEXT_LIMIT = 1200;

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function buildContextContract(snapshot = {}, settings = {}) {
  const retention = normalizeRetentionSettings(settings.retention);
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const requestedEnhancementMessages = boundedInteger(
    settings.enhancements?.contextMessages,
    13,
    ENHANCEMENT_MESSAGE_MIN,
    ENHANCEMENT_MESSAGE_MAX
  );
  return {
    sourceWindow: {
      configuredMessages: retention.sourceWindowMessages,
      configuredCharacters: retention.sourceWindowCharacters,
      actualMessages: messages.length,
      actualCharacters: messages.reduce((total, message) => total + String(message?.text || '').length, 0),
      firstMesId: snapshot.sourceWindowFirstMesId,
      lastMesId: snapshot.sourceWindowLastMesId,
      truncated: snapshot.sourceWindowTruncated === true,
      limitReason: snapshot.sourceWindowLimitReason || ''
    },
    providerContext: {
      configuredMessages: retention.providerVisibleMessages,
      effectiveMessages: Math.min(retention.providerVisibleMessages, messages.length)
    },
    enhancementContext: {
      configuredMessages: requestedEnhancementMessages,
      effectiveMessages: Math.min(requestedEnhancementMessages, messages.length),
      characterBudget: ENHANCEMENT_CONTEXT_CHARACTERS
    }
  };
}

export function boundEnhancementMessages(messages = [], maxMessages = 13, maxCharacters = ENHANCEMENT_CONTEXT_CHARACTERS) {
  const selected = [];
  let characters = 0;
  const limit = boundedInteger(maxMessages, 13, ENHANCEMENT_MESSAGE_MIN, ENHANCEMENT_MESSAGE_MAX);
  const budget = Math.max(0, Math.round(Number(maxCharacters) || ENHANCEMENT_CONTEXT_CHARACTERS));
  for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
    const text = String(message?.text || '').slice(0, MESSAGE_TEXT_LIMIT);
    if (selected.length >= limit || characters + text.length > budget) break;
    selected.unshift({ ...message, text });
    characters += text.length;
  }
  return { messages: selected, characters };
}

export function contextMessageIdentity(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    mesid: message?.mesid,
    swipeId: message?.swipeId,
    textHash: message?.textHash || String(message?.text || '')
  }));
}

export const ENHANCEMENT_CONTEXT_CHARACTER_BUDGET = ENHANCEMENT_CONTEXT_CHARACTERS;
