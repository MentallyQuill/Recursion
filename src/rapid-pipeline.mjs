import { hashJson } from './core.mjs';

export const RAPID_PIPELINE_VERSION = 1;
export const RAPID_TURN_DELTA_SCHEMA = 'recursion.rapidTurnDelta.v1';
export const RAPID_FAST_START_SCHEMA = 'recursion.rapidFastStartPack.v1';

const TEXT_LIMIT = 1200;
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

export function rapidWarmArtifactIsUsable(artifact = {}, expected = {}) {
  const source = asObject(artifact);
  const required = asObject(expected);
  return source.pipelineVersion === RAPID_PIPELINE_VERSION
    && source.status === 'ready'
    && cleanText(source.baseSourceRevisionHash, 180) === cleanText(required.baseSourceRevisionHash, 180)
    && cleanText(source.settingsHash, 180) === cleanText(required.settingsHash, 180)
    && cleanText(source.providerContractHash, 180) === cleanText(required.providerContractHash, 180)
    && cleanText(source.cardCatalogHash, 180) === cleanText(required.cardCatalogHash, 180)
    && cleanText(source.promptContractHash, 180) === cleanText(required.promptContractHash, 180)
    && Boolean(cleanText(source.conditionedSceneBrief, TEXT_LIMIT))
    && Array.isArray(source.cardIds)
    && source.cardIds.length > 0;
}

export function buildRapidTurnDeltaPrompt(input = {}) {
  const source = asObject(input);
  return [
    'Return one strict JSON object for Recursion Rapid foreground turn delta.',
    `Schema: ${RAPID_TURN_DELTA_SCHEMA}`,
    `Snapshot hash: ${cleanText(source.snapshotHash, 180)}`,
    `Base source revision hash: ${cleanText(source.baseSourceRevisionHash, 180)}`,
    `Turn source revision hash: ${cleanText(source.turnSourceRevisionHash, 180)}`,
    'Given the warm provider-generated scene guidance and the latest user message, select only what should condition this reply.',
    'Do not invent cards. Missing non-mandatory cards should become backgroundRefreshRequests.',
    'Set escalateToStandard true only when a missing card is mandatory for safe or coherent response guidance.',
    'Required fields: schema, snapshotHash, baseSourceRevisionHash, turnSourceRevisionHash, selectedCardIds, turnDeltaBrief, packetInstructions, guardrails, backgroundRefreshRequests, mandatoryMissingCards, escalateToStandard, diagnostics.',
    `Warm artifact: ${JSON.stringify(asObject(source.warmArtifact))}`,
    `Candidate cards: ${JSON.stringify(Array.isArray(source.candidateCards) ? source.candidateCards : [])}`,
    `User message: ${cleanText(source.userMessage, TEXT_LIMIT)}`
  ].join('\n\n');
}

export function buildRapidFastStartPrompt(input = {}) {
  const source = asObject(input);
  return [
    'Return one strict JSON object for Recursion Rapid fast-start pack.',
    `Schema: ${RAPID_FAST_START_SCHEMA}`,
    `Snapshot hash: ${cleanText(source.snapshotHash, 180)}`,
    `Turn source revision hash: ${cleanText(source.turnSourceRevisionHash, 180)}`,
    'No warm deck is available. Create compact provider-generated scene and turn guidance directly.',
    'Degrade breadth only. Do not return local fallback language, hidden reasoning, markdown, or prose outside JSON.',
    'Required fields: schema, snapshotHash, turnSourceRevisionHash, sceneBrief, turnBrief, guardrails, omissions, backgroundRefreshRequests, mandatoryMissingCards, escalateToStandard, diagnostics.',
    `Snapshot: ${JSON.stringify(asObject(source.snapshot))}`
  ].join('\n\n');
}

export function normalizeRapidTurnDelta(value = {}, expected = {}) {
  const source = asObject(value);
  const allowed = new Set(Array.isArray(expected.allowedCardIds) ? expected.allowedCardIds.map(String) : []);
  if (source.schema !== RAPID_TURN_DELTA_SCHEMA) throw new Error('Invalid Rapid turn delta schema.');
  const snapshotHash = cleanText(expected.snapshotHash, 180) || cleanText(source.snapshotHash, 180);
  const baseSourceRevisionHash = cleanText(expected.baseSourceRevisionHash, 180) || cleanText(source.baseSourceRevisionHash, 180);
  const turnSourceRevisionHash = cleanText(expected.turnSourceRevisionHash, 180) || cleanText(source.turnSourceRevisionHash, 180);
  const brief = asObject(source.brief);
  return {
    schema: RAPID_TURN_DELTA_SCHEMA,
    snapshotHash,
    baseSourceRevisionHash,
    turnSourceRevisionHash,
    selectedCardIds: cleanList(source.selectedCardIds, 180, 20).filter((cardId) => allowed.has(cardId)),
    turnDeltaBrief: firstText([source.turnDeltaBrief, source.turnBrief, source.userMessageDelta, source.deltaBrief, source.delta, brief.turnDeltaBrief, brief.turnBrief], TEXT_LIMIT),
    packetInstructions: firstList([source.packetInstructions, source.instructions, source.promptPacketInstructions, brief.packetInstructions], SHORT_TEXT_LIMIT, 12),
    guardrails: firstList([source.guardrails, source.guardrailInstructions, brief.guardrails], SHORT_TEXT_LIMIT, 12),
    backgroundRefreshRequests: cleanRefreshRequests(source.backgroundRefreshRequests),
    mandatoryMissingCards: cleanRefreshRequests(source.mandatoryMissingCards),
    escalateToStandard: source.escalateToStandard === true,
    diagnostics: cleanList(source.diagnostics, 120, 16)
  };
}

export function normalizeRapidFastStartPack(value = {}, expected = {}) {
  const source = asObject(value);
  if (source.schema !== RAPID_FAST_START_SCHEMA) throw new Error('Invalid Rapid fast-start schema.');
  const snapshotHash = cleanText(expected.snapshotHash, 180) || cleanText(source.snapshotHash, 180);
  const turnSourceRevisionHash = cleanText(expected.turnSourceRevisionHash, 180) || cleanText(source.turnSourceRevisionHash, 180);
  const brief = asObject(source.brief);
  return {
    schema: RAPID_FAST_START_SCHEMA,
    snapshotHash,
    turnSourceRevisionHash,
    sceneBrief: firstText([source.sceneBrief, source.conditionedSceneBrief, source.scene, source.sceneSummary, source.compactSceneBrief, brief.sceneBrief, brief.scene], TEXT_LIMIT),
    turnBrief: firstText([source.turnBrief, source.turnDeltaBrief, source.userMessageDelta, source.turn, source.turnSummary, brief.turnBrief, brief.turn], TEXT_LIMIT),
    guardrails: firstList([source.guardrails, source.guardrailInstructions, source.constraints, brief.guardrails], SHORT_TEXT_LIMIT, 12),
    omissions: firstList([source.omissions, source.omitted, source.omissionReasons, brief.omissions], SHORT_TEXT_LIMIT, 12),
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
    cardIds: artifact.cardIds,
    conditionedSceneBrief: artifact.conditionedSceneBrief
  });
}

export function chooseRapidHedgeWinner(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.result?.ok === true)
    .sort((a, b) => Number(a.settledAtMs || 0) - Number(b.settledAtMs || 0))[0] || null;
}
