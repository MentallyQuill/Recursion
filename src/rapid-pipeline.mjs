import { hashJson } from './core.mjs';
import { normalizeStoryForm, storyFormInstruction } from './story-form.mjs';

export const RAPID_PIPELINE_VERSION = 2;
export const RAPID_TURN_DELTA_SCHEMA = 'recursion.rapidTurnDelta.v2';
export const GUIDANCE_SCHEMA = 'recursion.guidanceComposer.v1';

const TEXT_LIMIT = 6000;
const SHORT_TEXT_LIMIT = 240;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, limit = TEXT_LIMIT) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function textCandidate(value, limit = TEXT_LIMIT) {
  if (Array.isArray(value)) return cleanText(value.join(' '), limit);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return cleanText(value, limit);
  return '';
}

function firstText(values = [], limit = TEXT_LIMIT) {
  for (const value of values) {
    const text = textCandidate(value, limit);
    if (text) return text;
  }
  return '';
}

function cleanList(value, limit = SHORT_TEXT_LIMIT, max = 16) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => cleanText(entry, limit))
    .filter(Boolean)
    .slice(0, max);
}

function cleanRefreshRequests(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = asObject(entry);
      const family = cleanText(source.family, 120);
      const role = cleanText(source.role, 120);
      const reason = cleanText(source.reason, 240);
      if (!family && !role) return null;
      return {
        ...(family ? { family } : {}),
        ...(role ? { role } : {}),
        ...(reason ? { reason } : {}),
        priority: cleanText(source.priority || 'soon', 40) || 'soon'
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function firstList(values = [], limit = SHORT_TEXT_LIMIT, max = 16) {
  for (const value of values) {
    const list = cleanList(value, limit, max);
    if (list.length) return list;
  }
  return [];
}

export function rapidCacheKey(snapshot = {}) {
  const source = asObject(snapshot);
  return [
    cleanText(source.chatKey || source.chatId || 'unknown-chat', 180),
    cleanText(source.sceneKey || 'default-scene', 180),
    cleanText(source.sourceRevisionHash || '', 180)
  ].join('::');
}

function guidanceIsUsable(guidance = {}) {
  const source = asObject(guidance);
  return source.schema === GUIDANCE_SCHEMA
    && cleanText(source.text, TEXT_LIMIT)
    && ['used', 'missing', 'fallback-raw-only'].includes(cleanText(source.status || 'used', 80));
}

function storyFormKey(value = {}) {
  const form = normalizeStoryForm(value);
  return [form.tense, form.pov, form.confidence].join('|');
}

export function rapidWarmArtifactIsUsable(artifact = {}, expected = {}) {
  const source = asObject(artifact);
  const required = asObject(expected);
  const sourceStoryForm = normalizeStoryForm(source.storyForm);
  const expectedStoryForm = required.storyForm ? normalizeStoryForm(required.storyForm) : null;
  return source.pipelineVersion === RAPID_PIPELINE_VERSION
    && source.status === 'ready'
    && cleanText(source.baseSourceRevisionHash, 180) === cleanText(required.baseSourceRevisionHash, 180)
    && cleanText(source.settingsHash, 180) === cleanText(required.settingsHash, 180)
    && cleanText(source.providerContractHash, 180) === cleanText(required.providerContractHash, 180)
    && cleanText(source.cardCatalogHash, 180) === cleanText(required.cardCatalogHash, 180)
    && cleanText(source.promptContractHash, 180) === cleanText(required.promptContractHash, 180)
    && Array.isArray(source.selectedCardIds)
    && source.selectedCardIds.length > 0
    && Array.isArray(source.cardIds)
    && source.cardIds.length > 0
    && sourceStoryForm.tense !== 'unknown'
    && sourceStoryForm.pov !== 'unknown'
    && (!expectedStoryForm || storyFormKey(sourceStoryForm) === storyFormKey(expectedStoryForm))
    && guidanceIsUsable(source.guidance);
}

export function buildRapidTurnDeltaPrompt(input = {}) {
  const source = asObject(input);
  const storyForm = normalizeStoryForm(source.storyForm || asObject(source.warmArtifact).storyForm);
  const selectedCards = Array.isArray(source.selectedCards)
    ? source.selectedCards
    : (Array.isArray(source.candidateCards) ? source.candidateCards : []);
  return [
    'Return one strict JSON object for Recursion Rapid foreground turn delta.',
    `Schema: ${RAPID_TURN_DELTA_SCHEMA}`,
    `Snapshot hash: ${cleanText(source.snapshotHash, 180)}`,
    `Base source revision hash: ${cleanText(source.baseSourceRevisionHash, 180)}`,
    `Turn source revision hash: ${cleanText(source.turnSourceRevisionHash, 180)}`,
    'Given the warm provider-authored guidance, full selected raw cards, and the latest user message, select the cards and write turn guidance for this reply.',
    storyFormInstruction(storyForm),
    `Story form: ${JSON.stringify(storyForm)}`,
    'Do not invent cards. Missing non-mandatory cards should become backgroundRefreshRequests.',
    'Set escalateToStandard true only when a missing card is mandatory for safe or coherent response guidance.',
    'Required fields: schema, snapshotHash, baseSourceRevisionHash, turnSourceRevisionHash, selectedCardIds, turnGuidanceText, guardrailCardIds, packetInstructions, backgroundRefreshRequests, mandatoryMissingCards, escalateToStandard, diagnostics.',
    `Warm artifact: ${JSON.stringify(asObject(source.warmArtifact))}`,
    `Warm guidance: ${JSON.stringify(asObject(source.warmGuidance))}`,
    `Selected raw cards: ${JSON.stringify(selectedCards)}`,
    `User message: ${cleanText(source.userMessage, TEXT_LIMIT)}`
  ].join('\n\n');
}

export function normalizeRapidTurnDelta(value = {}, expected = {}) {
  const source = asObject(value);
  const allowed = new Set(Array.isArray(expected.allowedCardIds) ? expected.allowedCardIds.map(String) : []);
  if (source.schema !== RAPID_TURN_DELTA_SCHEMA) throw new Error('Invalid Rapid turn delta schema.');
  const snapshotHash = cleanText(expected.snapshotHash, 180) || cleanText(source.snapshotHash, 180);
  const baseSourceRevisionHash = cleanText(expected.baseSourceRevisionHash, 180) || cleanText(source.baseSourceRevisionHash, 180);
  const turnSourceRevisionHash = cleanText(expected.turnSourceRevisionHash, 180) || cleanText(source.turnSourceRevisionHash, 180);
  return {
    schema: RAPID_TURN_DELTA_SCHEMA,
    snapshotHash,
    baseSourceRevisionHash,
    turnSourceRevisionHash,
    selectedCardIds: cleanList(source.selectedCardIds, 180, 20).filter((cardId) => allowed.has(cardId)),
    turnGuidanceText: firstText([source.turnGuidanceText, source.userMessageDelta, source.deltaBrief, source.delta], TEXT_LIMIT),
    guardrailCardIds: cleanList(source.guardrailCardIds, 180, 20).filter((cardId) => allowed.has(cardId)),
    packetInstructions: firstList([source.packetInstructions, source.instructions, source.promptPacketInstructions], SHORT_TEXT_LIMIT, 12),
    backgroundRefreshRequests: cleanRefreshRequests(source.backgroundRefreshRequests),
    mandatoryMissingCards: cleanRefreshRequests(source.mandatoryMissingCards),
    escalateToStandard: source.escalateToStandard === true,
    diagnostics: cleanList(source.diagnostics, 120, 16)
  };
}

export function rapidArtifactHash(artifact = {}) {
  return hashJson({
    version: RAPID_PIPELINE_VERSION,
    warmArtifactId: artifact.warmArtifactId,
    baseSourceRevisionHash: artifact.baseSourceRevisionHash,
    selectedCardIds: artifact.selectedCardIds,
    cardIds: artifact.cardIds,
    storyForm: normalizeStoryForm(artifact.storyForm),
    guidance: artifact.guidance
  });
}

export function chooseRapidHedgeWinner(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.result?.ok === true)
    .sort((a, b) => Number(a.settledAtMs || 0) - Number(b.settledAtMs || 0))[0] || null;
}
