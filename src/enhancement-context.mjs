import { compact, truncate } from './core.mjs';
import { dialogueSpans } from './prose-enhancement.mjs';

const CONTEXT_TEXT_LIMIT = 1200;
const CARD_TEXT_LIMIT = 700;
const EXAMPLE_LIMIT = 8;
const ENHANCEMENT_CARD_FAMILIES = new Set([
  'Active Cast',
  'Character Motivation',
  'Dialogue Relationship',
  'Social Subtext',
  'Scene Constraints',
  'Open Threads'
]);
const SECRET_PATTERN = /(raw[-_\s]*prompt|rawPrompt|provider[-_\s]*response|hidden[-_\s]*reasoning|api[-_\s]*key|authorization\s*[:=]\s*(?:bearer\s+)?[a-z0-9._~+/=-]+|bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]+)/ig;

function safeText(value, limit = CONTEXT_TEXT_LIMIT) {
  return truncate(compact(String(value ?? '').replace(SECRET_PATTERN, '[redacted]')), limit);
}

export function speakerLabel(message = {}) {
  const role = ['assistant', 'user', 'system'].includes(String(message.role || '').toLowerCase())
    ? String(message.role).toLowerCase()
    : 'assistant';
  const sender = safeText(message.sender || message.name || '', 120);
  return sender ? `${role}(${sender})` : role;
}

function visibleMessages(messages = [], limit = 13) {
  const bounded = Math.max(0, Math.min(35, Math.round(Number(limit) || 0)));
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.visible !== false)
    .slice(-bounded);
}

export function recentDialogueExamples(messages = [], { activeText = '', limit = EXAMPLE_LIMIT } = {}) {
  const active = String(activeText || '');
  const seen = new Set();
  const examples = [];
  for (const message of messages) {
    if (message?.visible === false) continue;
    const text = String(message.text ?? message.mes ?? message.content ?? '');
    if (!text.trim() || text === active) continue;
    for (const span of dialogueSpans(text)) {
      const example = safeText(span.text, 500);
      if (!example || seen.has(example)) continue;
      seen.add(example);
      examples.push(example);
      if (examples.length >= limit) return examples;
    }
  }
  return examples;
}

export function enhancementCardContextFromHand(hand = {}) {
  return (Array.isArray(hand?.cards) ? hand.cards : [])
    .filter((card) => ENHANCEMENT_CARD_FAMILIES.has(safeText(card?.family || '', 120)))
    .slice(0, 8)
    .map((card) => ({
      family: safeText(card.family, 80),
      text: safeText(card.promptText || card.summary || '', CARD_TEXT_LIMIT)
    }))
    .filter((card) => card.family && card.text);
}

export function enhancementContextFromSnapshot({
  snapshot = {},
  hand = {},
  activeText = '',
  activeSender = '',
  contextMessageLimit = 13
} = {}) {
  const messages = visibleMessages(snapshot.messages, contextMessageLimit);
  const latestAssistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  const sender = safeText(activeSender || latestAssistant?.sender || '', 120);
  return {
    contextMessages: messages,
    characterContext: {
      name: sender || 'assistant',
      description: 'Recent dialogue examples are derived from the bounded Enhancements context window.',
      exampleDialogue: recentDialogueExamples(messages, { activeText })
    },
    cardContext: enhancementCardContextFromHand(hand)
  };
}
