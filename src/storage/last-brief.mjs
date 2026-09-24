import { nowIso, redact, safeId } from '../core.mjs';
import { normalizeGuidanceOmissions } from '../guidance-omissions.mjs';

export const LAST_BRIEF_SCHEMA = 'recursion.lastBrief.v1';

const MAX_DISPLAY_CARDS = 20;
const MAX_OMISSIONS = 32;
const MAX_LIST_ITEMS = 32;
const MAX_PACKET_TEXT = 20_000;
const MAX_CARD_TEXT = 5_000;
const EMBEDDED_SECRET_PATTERN = /(bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]{8,}|(?:api[-_\s]*key|authorization|password|secret|token)\s*[:=]\s*[^\s,;]+)/gi;

export function lastBriefKey(chatKey) {
  return `recursion-last-brief-${safeId(chatKey, 'chat')}.v1.json`;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeText(value, limit = 500, fallback = '') {
  if (!['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return fallback;
  const redacted = String(redact(String(value), { maxString: limit }) ?? '')
    .replace(EMBEDDED_SECRET_PATTERN, '[redacted]');
  return redacted || fallback;
}

function safeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

function safeStringList(value, limit = MAX_LIST_ITEMS, itemLimit = 180) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => safeText(entry, itemLimit))
    .filter(Boolean)
    .slice(0, limit);
}

function safeTimestamp(value) {
  const text = safeText(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? text : nowIso();
}

function normalizeInspectionCard(value) {
  const source = object(value);
  const id = safeText(source.id || source.cardId, 180);
  const promptText = safeText(source.promptText || source.text || source.claim, MAX_CARD_TEXT);
  if (!id && !promptText) return null;
  const card = {
    id: id || safeId(`card-${promptText.slice(0, 40)}`, 'card'),
    family: safeText(source.family || source.name, 120, 'Unknown'),
    role: safeText(source.role || source.target, 80),
    status: safeText(source.status, 40),
    summary: safeText(source.summary || promptText, 500),
    promptText,
    evidenceRefs: safeStringList(source.evidenceRefs, 12, 160),
    tokenEstimate: safeInteger(source.tokenEstimate),
    emphasis: safeText(source.emphasis, 40),
    detailProfile: safeText(source.detailProfile, 40),
    origin: safeText(source.origin || source.source || source.provider || source.provenance, 80),
    selectedReason: safeText(source.selectedReason || source.selectionReason || source.whySelected, 300),
    omittedReason: safeText(source.omittedReason || source.omissionReason || source.whyOmitted, 300),
    inspectorNotes: safeText(source.inspectorNotes || source.inspectorNote, 900),
    sourceCardIds: safeStringList(source.sourceCardIds, 32, 180),
    coveredSourceCardIds: safeStringList(source.coveredSourceCardIds, 32, 180),
    omittedSourceCardIds: safeStringList(source.omittedSourceCardIds, 32, 180)
  };
  return Object.fromEntries(Object.entries(card).filter(([, entry]) => (
    entry !== '' && entry !== 0 && (!Array.isArray(entry) || entry.length > 0)
  )));
}

function normalizeOmission(value) {
  const source = object(value);
  const cardId = safeText(source.cardId || source.id, 180);
  const family = safeText(source.family, 120);
  const reason = safeText(source.reason || source.omissionReason, 300);
  if (!cardId && !family && !reason) return null;
  return {
    ...(cardId ? { cardId } : {}),
    ...(family ? { family } : {}),
    ...(reason ? { reason } : {})
  };
}

function normalizeInspectionHand(value) {
  const source = object(value);
  return {
    handId: safeText(source.handId, 180),
    cards: (Array.isArray(source.cards) ? source.cards : [])
      .map(normalizeInspectionCard)
      .filter(Boolean)
      .slice(0, MAX_DISPLAY_CARDS),
    omitted: (Array.isArray(source.omitted) ? source.omitted : [])
      .map(normalizeOmission)
      .filter(Boolean)
      .slice(0, MAX_OMISSIONS),
    tokenEstimate: safeInteger(source.tokenEstimate),
    composedAt: safeText(source.composedAt, 80)
  };
}

function normalizePacketCardRef(value) {
  const source = object(value);
  const id = safeText(source.id || source.cardId, 180);
  if (!id) return null;
  return {
    id,
    family: safeText(source.family || source.name, 120),
    role: safeText(source.role || source.target, 80),
    promptText: safeText(source.promptText, 1_600),
    emphasis: safeText(source.emphasis, 40),
    detailProfile: safeText(source.detailProfile, 40),
    tokenEstimate: safeInteger(source.tokenEstimate),
    evidenceRefs: safeStringList(source.evidenceRefs, 16, 160)
  };
}

function normalizePacketOmission(value) {
  return normalizeOmission(value);
}

function normalizeInjectionPlan(value) {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const source = object(entry);
    const id = safeText(source.id || source.section, 80);
    if (!id) return null;
    return {
      id,
      section: safeText(source.section || id, 80),
      promptKey: safeText(source.promptKey, 120),
      title: safeText(source.title, 160),
      placement: safeText(source.placement, 80),
      depth: safeInteger(source.depth),
      role: safeText(source.role, 80),
      sourceIds: safeStringList(source.sourceIds, 32, 180),
      maxChars: safeInteger(source.maxChars)
    };
  }).filter(Boolean).slice(0, 12);
}

function normalizeInjectedBlock(value) {
  const source = object(value);
  const text = safeText(source.text, MAX_PACKET_TEXT);
  if (!text) return null;
  return {
    promptKey: safeText(source.promptKey, 120),
    title: safeText(source.title, 160),
    placement: safeText(source.placement, 80),
    depth: safeInteger(source.depth),
    role: safeText(source.role, 80),
    sourceIds: safeStringList(source.sourceIds, 32, 180),
    text,
    hash: safeText(source.hash, 180)
  };
}

function normalizeInspectionPacket(value) {
  const source = object(value);
  const sections = object(source.sections);
  const diagnostics = object(source.diagnostics);
  const guidance = object(source.guidance);
  const guardrails = object(source.packetGuardrails);
  const storyForm = object(source.storyForm);
  return {
    packetId: safeText(source.packetId, 180),
    handId: safeText(source.handId, 180),
    packetVersion: safeInteger(source.packetVersion),
    packetKind: safeText(source.packetKind, 120),
    snapshotHash: safeText(source.snapshotHash, 180),
    chatId: safeText(source.chatId, 180),
    sceneKey: safeText(source.sceneKey, 180),
    sceneFingerprint: safeText(source.sceneFingerprint, 180),
    turnFingerprint: safeText(source.turnFingerprint, 180),
    footprint: safeText(source.footprint, 40),
    pipelineMode: safeText(source.pipelineMode, 40),
    prompt: safeText(source.prompt, MAX_PACKET_TEXT),
    injectedText: safeText(source.injectedText, MAX_PACKET_TEXT),
    injectedBlocks: (Array.isArray(source.injectedBlocks) ? source.injectedBlocks : [])
      .map(normalizeInjectedBlock)
      .filter(Boolean)
      .slice(0, 12),
    sections: {
      guidance: safeText(sections.guidance, MAX_PACKET_TEXT),
      cardEvidence: safeText(sections.cardEvidence, MAX_PACKET_TEXT),
      guardrails: safeText(sections.guardrails, MAX_PACKET_TEXT)
    },
    storyForm: {
      schema: safeText(storyForm.schema, 120),
      tense: safeText(storyForm.tense, 40),
      pov: safeText(storyForm.pov, 80),
      confidence: safeText(storyForm.confidence, 40),
      evidenceRefs: safeStringList(storyForm.evidenceRefs, 16, 160)
    },
    guidance: {
      schema: safeText(guidance.schema, 120),
      status: safeText(guidance.status, 40),
      text: safeText(guidance.text, 3_000),
      sourceCardIds: safeStringList(guidance.sourceCardIds, 32, 180),
      guardrailCardIds: safeStringList(guidance.guardrailCardIds, 32, 180),
      omittedCardIds: normalizeGuidanceOmissions(guidance.omittedCardIds, { sanitizeId: (id) => safeText(id, 160) })
    },
    cardEvidence: (Array.isArray(source.cardEvidence) ? source.cardEvidence : [])
      .map(normalizePacketCardRef)
      .filter(Boolean)
      .slice(0, MAX_DISPLAY_CARDS),
    packetGuardrails: {
      staticText: safeText(guardrails.staticText, 1_600),
      sourceCardIds: safeStringList(guardrails.sourceCardIds, 32, 180)
    },
    selectedCardRefs: (Array.isArray(source.selectedCardRefs) ? source.selectedCardRefs : [])
      .map(normalizePacketCardRef)
      .filter(Boolean)
      .slice(0, MAX_DISPLAY_CARDS),
    omissions: (Array.isArray(source.omissions) ? source.omissions : [])
      .map(normalizePacketOmission)
      .filter(Boolean)
      .slice(0, MAX_OMISSIONS),
    injectionPlan: normalizeInjectionPlan(source.injectionPlan),
    diagnostics: {
      runId: safeText(diagnostics.runId, 180),
      composerLane: safeText(diagnostics.composerLane, 80),
      reasonerStatus: safeText(diagnostics.reasonerStatus, 80),
      guidanceStatus: safeText(diagnostics.guidanceStatus, 80),
      selectedCardCount: safeInteger(diagnostics.selectedCardCount),
      omissionCount: safeInteger(diagnostics.omissionCount),
      footprint: safeText(diagnostics.footprint, 40),
      pipelineMode: safeText(diagnostics.pipelineMode, 40)
    },
    composedAt: safeText(source.composedAt, 80)
  };
}

export function normalizeLastBriefRecord(value) {
  const source = object(value);
  const chatKey = safeId(source.chatKey, 'chat');
  const turnKeyHash = safeText(source.turnKeyHash, 180);
  if (!turnKeyHash) return null;
  return {
    schema: LAST_BRIEF_SCHEMA,
    recordType: 'recursion.lastBrief',
    chatKey,
    turnKeyHash,
    status: source.status === 'historical' ? 'historical' : 'ready',
    packet: normalizeInspectionPacket(source.packet),
    hand: normalizeInspectionHand(source.hand),
    committedAt: safeTimestamp(source.committedAt)
  };
}
