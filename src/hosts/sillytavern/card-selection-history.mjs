import { hashJson } from '../../core.mjs';

const SCHEMA = 'recursion.cardSelectionUsage.v1';
const clean = (value, limit = 180) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export function cardSelectionMessageText(message = {}) {
  const index = Number(message.swipe_id);
  if (Number.isInteger(index) && index >= 0 && Array.isArray(message.swipes)) {
    return String(message.swipes[index] ?? '');
  }
  return String(message.mes ?? message.text ?? message.content ?? message.__recursionHeldText ?? '');
}
function activeExtra(message = {}) {
  const index = Number(message.swipe_id);
  if (Number.isInteger(index) && index >= 0 && Array.isArray(message.swipes)) {
    return object(message.swipe_info?.[index]?.extra);
  }
  return object(message.extra);
}
export function normalizeCardSelectionReceipt(value = {}) {
  const source = object(value);
  const seen = new Set();
  const cards = [];
  for (const card of Array.isArray(source.cards) ? source.cards : []) {
    const cardId = clean(card?.cardId);
    if (!cardId || seen.has(cardId)) continue;
    seen.add(cardId);
    cards.push({ cardId, categoryId: clean(card?.categoryId), reason: clean(card?.reason, 240) });
  }
  return {
    schema: SCHEMA,
    turnKeyHash: clean(source.turnKeyHash), sourcePrefixHash: clean(source.sourcePrefixHash),
    textHash: clean(source.textHash), deckId: clean(source.deckId),
    generationType: clean(source.generationType, 40), cards
  };
}
export function validCardSelectionReceipt(message, sourcePrefixHash) {
  const value = activeExtra(message)?.recursion?.cardSelection;
  if (value?.schema !== SCHEMA) return null;
  const receipt = normalizeCardSelectionReceipt(value);
  return receipt.turnKeyHash && receipt.deckId
    && receipt.sourcePrefixHash === sourcePrefixHash
    && receipt.textHash === hashJson(cardSelectionMessageText(message)) ? receipt : null;
}
export function setCardSelectionReceipt(extra, receipt) {
  const result = object(extra);
  result.recursion = { ...object(result.recursion), cardSelection: normalizeCardSelectionReceipt(receipt) };
  delete result.recursion.cardSelectionIncomplete;
  return result;
}
export function cardSelectionGenerationStartedAt(message = {}) {
  const index = Number(message.swipe_id);
  const activeInfo = Number.isInteger(index) && index >= 0 && Array.isArray(message.swipes)
    ? message.swipe_info?.[index] : null;
  const started = activeInfo?.gen_started ?? message.gen_started;
  const timestamp = started instanceof Date ? started.getTime()
    : typeof started === 'number' ? started
      : typeof started === 'string' && started.trim() ? Date.parse(started) : NaN;
  return Number.isFinite(timestamp) ? String(timestamp) : '';
}
export function setCardSelectionIncomplete(extra, marker) {
  const result = object(extra);
  result.recursion = { ...object(result.recursion), cardSelectionIncomplete: {
    schema: 'recursion.cardSelectionIncomplete.v1', sourcePrefixHash: clean(marker.sourcePrefixHash),
    textHash: clean(marker.textHash), generationStartedAt: clean(marker.generationStartedAt)
  } };
  delete result.recursion.cardSelection;
  return result;
}
function incompleteResponse(message, sourcePrefixHash, textHash) {
  const marker = activeExtra(message)?.recursion?.cardSelectionIncomplete;
  return marker?.schema === 'recursion.cardSelectionIncomplete.v1'
    && marker.sourcePrefixHash === sourcePrefixHash
    // Native stream finalization rewrites partial text after Stop while retaining
    // gen_started and copying root extra into the finalized swipe metadata.
    // A later generation changes this timestamp, even when its text is identical.
    && (marker.generationStartedAt
      ? marker.generationStartedAt === cardSelectionGenerationStartedAt(message)
      : marker.textHash === textHash);
}
export function cardSelectionCompletionStatus(context = {}, targetIndex = null) {
  const processor = context.streamingProcessor;
  if (!processor || (targetIndex !== null && Number(processor.messageId) !== Number(targetIndex))) {
    return { completed: true, reason: 'non-streaming-response' };
  }
  if (processor.isStopped === true || processor.abortController?.signal?.aborted === true) {
    return { completed: false, reason: 'streaming-stopped' };
  }
  if (processor.isFinished !== true) return { completed: false, reason: 'streaming-unfinished' };
  return { completed: true, reason: 'streaming-completed' };
}
export function cardSelectionHistoryForChat(chat = [], { context = {} } = {}) {
  let prefixHash = hashJson({ schema: 'recursion.cardSelectionBranch.v1' });
  let previousPrefixHash = prefixHash;
  const history = [];
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (!message || message.visible === false || message.hidden === true || message.is_system === true) continue;
    const text = cardSelectionMessageText(message);
    if (!text.trim()) continue;
    const textHash = hashJson(text);
    if (message.is_user !== true && cardSelectionCompletionStatus(context, index).completed && !incompleteResponse(message, prefixHash, textHash)) {
      const receipt = validCardSelectionReceipt(message, prefixHash);
      history.push({
        messageId: Number(message.mesid ?? message.id ?? message.index ?? index),
        swipeId: Number.isInteger(Number(message.swipe_id)) ? Number(message.swipe_id) : 0,
        textHash, sourcePrefixHash: prefixHash,
        turnKeyHash: receipt?.turnKeyHash || '', deckId: receipt?.deckId || '', cards: receipt?.cards || []
      });
    }
    previousPrefixHash = prefixHash;
    prefixHash = hashJson({ prefixHash, role: message.is_user === true ? 'user' : 'assistant', sender: String(message.name || ''), textHash });
  }
  return {
    cardSelectionHistory: history.slice(-10),
    cardSelectionSourcePrefixHash: prefixHash,
    cardSelectionPreviousPrefixHash: previousPrefixHash
  };
}
