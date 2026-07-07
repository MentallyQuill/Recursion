export const DEFAULT_RETENTION_SETTINGS = Object.freeze({
  sourceWindowMessages: 20,
  sourceWindowCharacters: 12000,
  providerVisibleMessages: 12,
  sceneCachesPerChat: 3,
  sceneCachesTotal: 24,
  sourceVariantsPerScene: 4,
  runJournalEntries: 100
});

export const RETENTION_LIMITS = Object.freeze({
  sourceWindowMessages: { min: 12, max: 200, step: 4 },
  sourceWindowCharacters: { min: 6000, max: 100000, step: 1000 },
  providerVisibleMessages: { min: 4, max: 32, step: 1 },
  sceneCachesPerChat: { min: 1, max: 12, step: 1 },
  sceneCachesTotal: { min: 4, max: 100, step: 4 },
  sourceVariantsPerScene: { min: 1, max: 8, step: 1 },
  runJournalEntries: { min: 10, max: 500, step: 10 }
});

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function integerInRange(value, fallback, limits) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.max(limits.min, Math.min(limits.max, Math.round(number)));
}

function rawMessageText(message) {
  if (message === undefined || message === null) return '';
  if (typeof message === 'string') return message;
  if (typeof message !== 'object') return '';
  return String(message.mes ?? message.text ?? message.content ?? '');
}

function messageIsVisibleSource(message) {
  if (!message || typeof message !== 'object') return typeof message === 'string';
  const role = String(message.role || '').toLowerCase();
  return message.visible !== false
    && message.hidden !== true
    && message.is_system !== true
    && role !== 'system';
}

function numericMessageId(message, index) {
  if (!message || typeof message !== 'object') return index;
  const numeric = Number(message.mesid ?? message.id ?? message.messageId ?? message.index);
  return Number.isFinite(numeric) ? numeric : index;
}

function limitReason(hitMessageCap, hitCharacterBudget) {
  if (hitMessageCap && hitCharacterBudget) return 'both';
  if (hitMessageCap) return 'message-cap';
  if (hitCharacterBudget) return 'character-budget';
  return undefined;
}

export function normalizeRetentionSettings(value = {}) {
  const source = objectValue(value);
  const normalized = {
    sourceWindowMessages: integerInRange(
      source.sourceWindowMessages,
      DEFAULT_RETENTION_SETTINGS.sourceWindowMessages,
      RETENTION_LIMITS.sourceWindowMessages
    ),
    sourceWindowCharacters: integerInRange(
      source.sourceWindowCharacters,
      DEFAULT_RETENTION_SETTINGS.sourceWindowCharacters,
      RETENTION_LIMITS.sourceWindowCharacters
    ),
    providerVisibleMessages: integerInRange(
      source.providerVisibleMessages,
      DEFAULT_RETENTION_SETTINGS.providerVisibleMessages,
      RETENTION_LIMITS.providerVisibleMessages
    ),
    sceneCachesPerChat: integerInRange(
      source.sceneCachesPerChat,
      DEFAULT_RETENTION_SETTINGS.sceneCachesPerChat,
      RETENTION_LIMITS.sceneCachesPerChat
    ),
    sceneCachesTotal: integerInRange(
      source.sceneCachesTotal,
      DEFAULT_RETENTION_SETTINGS.sceneCachesTotal,
      RETENTION_LIMITS.sceneCachesTotal
    ),
    sourceVariantsPerScene: integerInRange(
      source.sourceVariantsPerScene,
      DEFAULT_RETENTION_SETTINGS.sourceVariantsPerScene,
      RETENTION_LIMITS.sourceVariantsPerScene
    ),
    runJournalEntries: integerInRange(
      source.runJournalEntries,
      DEFAULT_RETENTION_SETTINGS.runJournalEntries,
      RETENTION_LIMITS.runJournalEntries
    )
  };
  normalized.sceneCachesTotal = Math.max(normalized.sceneCachesTotal, normalized.sceneCachesPerChat);
  return normalized;
}

export function selectBoundedSourceWindow(messages = [], retention = {}) {
  const caps = normalizeRetentionSettings(retention);
  const source = Array.isArray(messages) ? messages : [];
  const kept = [];
  let sourceWindowCharacterCount = 0;
  let hitMessageCap = false;
  let hitCharacterBudget = false;

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (!messageIsVisibleSource(message)) continue;
    const textLength = rawMessageText(message).length;
    const nextCharacters = sourceWindowCharacterCount + textLength;
    hitMessageCap = kept.length >= caps.sourceWindowMessages;
    hitCharacterBudget = kept.length > 0 && nextCharacters > caps.sourceWindowCharacters;
    if (hitMessageCap || hitCharacterBudget) break;
    kept.push({ message, index });
    sourceWindowCharacterCount = nextCharacters;
  }

  const orderedEntries = kept.reverse();
  const ordered = orderedEntries.map((entry) => entry.message);
  const sourceWindowLimitReason = limitReason(hitMessageCap, hitCharacterBudget);
  const firstEntry = orderedEntries[0];
  const lastEntry = orderedEntries.at(-1);
  const firstMesId = numericMessageId(firstEntry?.message, firstEntry?.index ?? 0);
  const lastMesId = numericMessageId(lastEntry?.message, lastEntry?.index ?? firstMesId);
  return {
    messages: ordered,
    metadata: {
      sourceWindowFirstMesId: Number.isFinite(firstMesId) ? firstMesId : 0,
      sourceWindowLastMesId: Number.isFinite(lastMesId) ? lastMesId : 0,
      sourceWindowMessageCount: ordered.length,
      sourceWindowCharacterCount,
      sourceWindowTruncated: Boolean(sourceWindowLimitReason),
      ...(sourceWindowLimitReason ? { sourceWindowLimitReason } : {})
    }
  };
}
