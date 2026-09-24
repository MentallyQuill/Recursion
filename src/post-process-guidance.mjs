import { buildPostProcessEditingInstructions } from './post-process-editing.mjs';
import {
  normalizeReasoningLevel,
  reasoningRequestMetadata
} from './reasoning-policy.mjs';

export const POST_PROCESS_GUIDANCE_SCHEMA = 'recursion.postProcessGuidance.v1';
export const MAX_POST_PROCESS_GUIDANCE_LENGTH = 6000;

export const POST_PROCESS_GUIDANCE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    guidanceText: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: MAX_POST_PROCESS_GUIDANCE_LENGTH
    })
  }),
  required: Object.freeze(['guidanceText']),
  additionalProperties: false
});

function boundedText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function guidanceError(message, code = 'RECURSION_POST_PROCESS_GUIDANCE_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Budget complete fields and messages, never a sliced JSON document. Omission
// metadata lets the model distinguish absent evidence from negative evidence.
function renderFrozenEvidence(input = {}) {
  const source = plainObject(input.supportingContext)
    ? input.supportingContext
    : plainObject(input.snapshot?.supportingContext)
      ? input.snapshot.supportingContext
      : {};
  const evidence = {};
  const omissions = [];
  const budget = 12000;
  const size = (value) => JSON.stringify(value).length;
  for (const [field, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      evidence[field] = [];
      for (const [index, message] of value.entries()) {
        const candidate = { ...evidence, [field]: [...evidence[field], message] };
        if (size(candidate) <= budget) evidence[field].push(message);
        else omissions.push({ path: `${field}[${index}]`, reason: 'evidence-budget' });
      }
    } else {
      const candidate = { ...evidence, [field]: value };
      if (size(candidate) <= budget) evidence[field] = value;
      else omissions.push({ path: field, reason: 'evidence-budget' });
    }
  }
  return `Frozen supporting evidence:\n${JSON.stringify({ evidence, omissions })}`;
}

function categoryCards(category = {}) {
  if (Array.isArray(category.cards)) return category.cards;
  if (plainObject(category.cards)) return Object.values(category.cards);
  return [];
}

function renderOrderedCards(categories = []) {
  const lines = ['Ordered revision categories and cards:'];
  for (const [categoryIndex, categoryValue] of (Array.isArray(categories) ? categories : []).entries()) {
    const category = plainObject(categoryValue) ? categoryValue : { name: categoryValue };
    const categoryName = boundedText(category.name || category.id || `Category ${categoryIndex + 1}`, 240);
    lines.push(`${categoryIndex + 1}. ${categoryName}`);
    const cards = categoryCards(category);
    for (const [cardIndex, cardValue] of cards.entries()) {
      const card = plainObject(cardValue) ? cardValue : { promptText: cardValue };
      const cardName = boundedText(card.name || card.id || `Card ${cardIndex + 1}`, 240);
      const promptText = boundedText(card.promptText || card.prompt || card.description, 6000);
      lines.push(`   ${cardIndex + 1}. ${cardName}${promptText ? `\n      ${promptText}` : ''}`);
    }
  }
  return lines.join('\n');
}

function renderWritableDraft(draft) {
  return `Current writable draft (evidence only; do not rewrite it):\n${typeof draft === 'string' ? draft : ''}`;
}

export function postProcessGuidanceRoute(reasoningLevel) {
  const level = normalizeReasoningLevel(reasoningLevel);
  if (level === 'high' || level === 'ultra') {
    return { lane: 'reasoner', roleId: 'postProcessGuidanceReasoner' };
  }
  return { lane: 'utility', roleId: 'postProcessGuidanceUtility' };
}

export function buildPostProcessGuidanceRequest(input = {}) {
  const reasoningLevel = normalizeReasoningLevel(input.reasoningLevel);
  return {
    snapshotHash: input.snapshotHash,
    sourceHash: input.sourceHash,
    reasoningLevel,
    prompt: [
      'Return exactly one JSON object with only a nonempty string guidanceText field.',
      'Response example: {"guidanceText":"Apply the selected card to the repeated warning."}',
      `guidanceText must be at most ${MAX_POST_PROCESS_GUIDANCE_LENGTH} characters. No other fields or prose outside JSON.`,
      'Analyze where the selected revision cards apply.',
      'Do not rewrite the story response.',
      'Preserve unsupported material and user agency.',
      'Return concise revision guidance for the host writer, never revised story prose.',
      buildPostProcessEditingInstructions(input),
      renderFrozenEvidence(input),
      renderOrderedCards(input.categories),
      renderWritableDraft(input.draft)
    ].join('\n\n'),
    jsonSchema: POST_PROCESS_GUIDANCE_JSON_SCHEMA,
    ...reasoningRequestMetadata(reasoningLevel, 'post-process')
  };
}

export function normalizePostProcessGuidanceResponse(data, request = {}) {
  if (!plainObject(data)) {
    throw guidanceError('Post-process guidance output must be a JSON object.');
  }
  if (Object.keys(data).length !== 1 || !Object.hasOwn(data, 'guidanceText')) {
    throw guidanceError('Post-process guidance output must contain only guidanceText.');
  }
  if (typeof data.guidanceText !== 'string') {
    throw guidanceError('Post-process guidance guidanceText must be a string.');
  }
  if (data.guidanceText.length > MAX_POST_PROCESS_GUIDANCE_LENGTH) {
    throw guidanceError('Post-process guidance exceeds the maximum length.');
  }
  const guidanceText = data.guidanceText.trim();
  if (!guidanceText) throw guidanceError('Post-process guidance text must be nonempty.');
  for (const field of ['snapshotHash', 'sourceHash']) {
    if (typeof request[field] !== 'string' || !request[field].trim() || request[field].length > 180) {
      throw guidanceError(`Post-process guidance request ${field} must be a nonempty bounded string.`);
    }
  }
  return {
    schema: POST_PROCESS_GUIDANCE_SCHEMA,
    snapshotHash: request.snapshotHash,
    sourceHash: request.sourceHash,
    guidanceText
  };
}
