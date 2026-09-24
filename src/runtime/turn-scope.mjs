import {
  normalizeRetentionSettings,
  selectBoundedSourceWindow
} from '../retention-policy.mjs';
import { stableHash } from '../execution/provenance.mjs';

export const TURN_IDENTITY_SCHEMA = 'recursion.turnIdentity.v1';

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function textValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

function messageText(message) {
  if (typeof message === 'string') return message;
  const source = objectValue(message);
  return textValue(source.mes ?? source.text ?? source.content);
}

function messageId(message, fallback = '') {
  const source = objectValue(message);
  return textValue(
    source.mesid
    ?? source.id
    ?? source.messageId
    ?? source.index
    ?? fallback
  );
}

function messageRole(message) {
  const source = objectValue(message);
  const role = textValue(source.role).trim().toLowerCase();
  if (role) return role;
  if (source.is_user === true) return 'user';
  if (source.is_user === false) return 'assistant';
  return 'unknown';
}

function selectedSwipeId(message) {
  const source = objectValue(message);
  return textValue(source.swipe_id ?? source.swipeId ?? source.selectedSwipeId);
}

function snapshotMessages(snapshot) {
  const source = objectValue(snapshot);
  return Array.isArray(source.messages) ? source.messages : [];
}

function sourceBeforeSwipe(snapshot, swipeMessageId) {
  const messages = snapshotMessages(snapshot);
  const targetId = textValue(swipeMessageId);
  if (!targetId) return messages;
  const targetIndex = messages.findIndex((message, index) => (
    messageId(message, index) === targetId
  ));
  return targetIndex >= 0 ? messages.slice(0, targetIndex) : messages;
}

function identityHash(snapshot, directKey, nestedKey) {
  const source = objectValue(snapshot);
  if (textValue(source[directKey])) return textValue(source[directKey]);
  const nested = objectValue(source[nestedKey]);
  return textValue(nested.hash ?? nested.id ?? nested.key);
}

export function normalizeNativeGenerationType(value) {
  const normalized = textValue(value).trim().toLowerCase();
  return ['normal', 'swipe', 'regenerate'].includes(normalized)
    ? normalized
    : 'normal';
}

export async function createTurnIdentity({
  snapshot,
  pendingUserMessage,
  generationType,
  swipeMessageId,
  retention,
  contracts
} = {}) {
  const source = objectValue(snapshot);
  const pending = objectValue(pendingUserMessage);
  const nativeGenerationType = normalizeNativeGenerationType(generationType);
  const caps = normalizeRetentionSettings(retention);
  const sourceMessages = nativeGenerationType === 'swipe'
    ? sourceBeforeSwipe(source, swipeMessageId)
    : snapshotMessages(source);
  const bounded = selectBoundedSourceWindow(sourceMessages, caps);
  const sourceBand = await Promise.all(bounded.messages.map(async (message, index) => ({
    messageId: messageId(message, index),
    role: messageRole(message),
    selectedSwipeId: selectedSwipeId(message),
    textHash: await stableHash(messageText(message))
  })));
  const pendingUserMessageId = messageId(pending);
  const pendingUserTextHash = await stableHash(messageText(pending));
  const sourceBandHash = await stableHash(sourceBand);
  const contractHash = await stableHash(objectValue(contracts));
  const chatKey = textValue(source.chatKey ?? source.chatId);
  const characterHash = identityHash(source, 'characterHash', 'character');
  const groupHash = identityHash(source, 'groupHash', 'group');
  const lastSource = sourceMessages.at(-1);
  const pendingAlreadyVisible = pendingUserMessageId && messageRole(lastSource) === 'user' && messageId(lastSource) === pendingUserMessageId;
  const selectionPrefix = source.cardSelectionPendingUser === true ? source.cardSelectionSourcePrefixHash
    : pendingAlreadyVisible ? source.cardSelectionPreviousPrefixHash || source.cardSelectionSourcePrefixHash : source.cardSelectionSourcePrefixHash;
  const turnKeyHash = await stableHash({
    chatKey,
    ...(source.cardSelectionSourcePrefixHash ? { selectionSourcePrefixHash: textValue(selectionPrefix) } : {}),
    sourceBandLimit: caps.sourceWindowMessages,
    sourceBand,
    pendingUserMessageId,
    pendingUserTextHash,
    characterHash,
    groupHash,
    contracts: objectValue(contracts)
  });

  return {
    schema: TURN_IDENTITY_SCHEMA,
    turnKeyHash,
    chatKey,
    sourceBandHash,
    sourceBandLimit: caps.sourceWindowMessages,
    sourceBandMessageCount: sourceBand.length,
    sourceWindowFirstMesId: textValue(bounded.metadata.sourceWindowFirstMesId),
    sourceWindowLastMesId: textValue(bounded.metadata.sourceWindowLastMesId),
    pendingUserMessageId,
    pendingUserTextHash,
    nativeGenerationType,
    characterHash,
    groupHash,
    contractHash
  };
}

export function classifyGeneration({
  nativeGenerationType,
  pendingUserMessage,
  currentTurnKeyHash,
  storedTurnKeyHash,
  storedOperationState
} = {}) {
  const generationType = normalizeNativeGenerationType(nativeGenerationType);
  const pending = objectValue(pendingUserMessage);
  const hasPendingUser = Boolean(messageId(pending) || messageText(pending).trim());
  const currentKey = textValue(currentTurnKeyHash);
  const storedKey = textValue(storedTurnKeyHash);
  const sameTurn = Boolean(currentKey && storedKey && currentKey === storedKey);
  const state = textValue(storedOperationState).trim().toLowerCase();

  if (state === 'paused' && sameTurn) {
    return { kind: 'compatible-paused-same-turn', sameTurn: true };
  }
  if (hasPendingUser && generationType === 'normal' && state === 'completed' && sameTurn) {
    return { kind: 'same-turn-host-retry', sameTurn: true };
  }
  if (hasPendingUser && generationType === 'normal') {
    return { kind: 'new-user-turn', sameTurn };
  }
  if (state === 'paused') {
    return {
      kind: 'incompatible-paused-operation',
      sameTurn
    };
  }
  if (generationType === 'swipe' && sameTurn) {
    return { kind: 'same-turn-swipe', sameTurn: true };
  }
  if (generationType === 'swipe' && storedKey && !sameTurn) {
    return { kind: 'edited-band-swipe', sameTurn: false };
  }
  return { kind: 'new-host-generation', sameTurn };
}
