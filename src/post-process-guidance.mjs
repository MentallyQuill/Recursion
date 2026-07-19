import {
  normalizeReasoningLevel,
  reasoningRequestMetadata
} from './reasoning-policy.mjs';

export const POST_PROCESS_GUIDANCE_SCHEMA = 'recursion.postProcessGuidance.v1';
export const MAX_POST_PROCESS_GUIDANCE_LENGTH = 6000;

export const POST_PROCESS_GUIDANCE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    schema: Object.freeze({ const: POST_PROCESS_GUIDANCE_SCHEMA }),
    snapshotHash: Object.freeze({ type: 'string', minLength: 1, maxLength: 180 }),
    sourceHash: Object.freeze({ type: 'string', minLength: 1, maxLength: 180 }),
    guidanceText: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: MAX_POST_PROCESS_GUIDANCE_LENGTH
    })
  }),
  required: Object.freeze(['schema', 'snapshotHash', 'sourceHash', 'guidanceText']),
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

function safeJson(value, maxLength = 12000) {
  try {
    return boundedText(JSON.stringify(value ?? {}, null, 2), maxLength);
  } catch {
    return '{}';
  }
}

function renderFrozenEvidence(input = {}) {
  const evidence = plainObject(input.supportingContext)
    ? input.supportingContext
    : plainObject(input.snapshot?.supportingContext)
      ? input.snapshot.supportingContext
      : {};
  return `Frozen supporting evidence:\n${safeJson(evidence)}`;
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
  return `Current writable draft (evidence only; do not rewrite it):\n${boundedText(draft, 24000)}`;
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
    snapshotHash: boundedText(input.snapshotHash, 180),
    sourceHash: boundedText(input.sourceHash, 180),
    reasoningLevel,
    prompt: [
      `Return only ${POST_PROCESS_GUIDANCE_SCHEMA} JSON.`,
      'Analyze where the selected revision cards apply.',
      'Do not rewrite the story response.',
      'Preserve unsupported material and user agency.',
      'Return concise revision guidance for the host writer, never revised story prose.',
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
  const keys = Object.keys(data).sort();
  const expectedKeys = ['guidanceText', 'schema', 'snapshotHash', 'sourceHash'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw guidanceError('Post-process guidance output must contain only the minimal guidance envelope.');
  }

  const schema = boundedText(data.schema, 180);
  if (schema !== POST_PROCESS_GUIDANCE_SCHEMA) {
    throw guidanceError(
      'Provider output schema did not match the requested role.',
      'RECURSION_PROVIDER_SCHEMA_MISMATCH'
    );
  }

  const expectedSnapshotHash = boundedText(request.snapshotHash, 180);
  const snapshotHash = boundedText(data.snapshotHash, 180);
  if (!expectedSnapshotHash || snapshotHash !== expectedSnapshotHash) {
    throw guidanceError('Post-process guidance snapshot hash did not match the frozen request.');
  }

  const expectedSourceHash = boundedText(request.sourceHash, 180);
  const sourceHash = boundedText(data.sourceHash, 180);
  if (!expectedSourceHash || sourceHash !== expectedSourceHash) {
    throw guidanceError('Post-process guidance source hash did not match the frozen request.');
  }

  const guidanceText = boundedText(data.guidanceText, MAX_POST_PROCESS_GUIDANCE_LENGTH);
  if (!guidanceText) {
    throw guidanceError('Post-process guidance text must be nonempty.');
  }

  return {
    schema: POST_PROCESS_GUIDANCE_SCHEMA,
    snapshotHash,
    sourceHash,
    guidanceText
  };
}
