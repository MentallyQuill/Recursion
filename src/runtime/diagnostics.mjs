import { asArray, compact, hashJson, nowIso, redact, truncate } from '../core.mjs';
import { summarizePreparedGenerationArtifact } from './prepared-generation.mjs';

const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/ig;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeText(value, limit = 200) {
  const text = truncate(compact(String(value ?? '').replace(SECRET_TEXT_PATTERN, '[redacted]'), limit), limit);
  return text;
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function scrubSecretText(value, limit = 500) {
  if (typeof value === 'string') return truncate(value.replace(SECRET_TEXT_PATTERN, '[redacted]'), limit);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubSecretText(entry, limit));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubSecretText(entry, limit)]));
}

function safeDiagnosticValue(value, limit = 500) {
  return scrubSecretText(redact(value, { maxString: limit }), limit);
}

function mapPacketDiagnostics(diagnostics) {
  const source = asObject(diagnostics);
  return safeDiagnosticValue({
    runId: safeText(source.runId, 160),
    composerLane: safeText(source.composerLane, 80),
    reasonerStatus: safeText(source.reasonerStatus, 80),
    guidanceStatus: safeText(source.guidanceStatus, 80),
    guidanceFallbackReason: safeText(source.guidanceFallbackReason, 160),
    guidanceInvalidSourceIdCount: numberOr(source.guidanceInvalidSourceIdCount, 0),
    guidanceSourceCardIds: asArray(source.guidanceSourceCardIds).slice(0, 24).map((entry) => safeText(entry, 160)),
    guidanceGuardrailCardIds: asArray(source.guidanceGuardrailCardIds).slice(0, 24).map((entry) => safeText(entry, 160)),
    guidanceOmittedCardIds: asArray(source.guidanceOmittedCardIds).slice(0, 24).map((entry) => safeText(entry, 160)),
    guidanceDiagnostics: asArray(source.guidanceDiagnostics).slice(0, 24).map((entry) => safeText(entry, 160)),
    snapshotHash: safeText(source.snapshotHash, 160),
    sectionBudgets: source.sectionBudgets || null,
    selectedCardCount: numberOr(source.selectedCardCount, 0),
    omissionCount: numberOr(source.omissionCount, 0),
    selectedTokenEstimate: numberOr(source.selectedTokenEstimate, 0),
    sectionHashes: source.sectionHashes || null,
    footprint: safeText(source.footprint, 40),
    pipelineMode: safeText(source.pipelineMode, 40),
    rapidPath: safeText(source.rapidPath, 80),
    planDiagnostics: asArray(source.planDiagnostics).slice(0, 24).map((entry) => safeText(entry, 160)),
    storyFormTense: safeText(source.storyFormTense, 80),
    storyFormPov: safeText(source.storyFormPov, 80),
    storyFormConfidence: numberOr(source.storyFormConfidence, 0),
    behaviorPolicy: source.behaviorPolicy || null
  }, 500);
}

function mapPacketSummary(packet) {
  const source = asObject(packet);
  if (!source.packetId && !source.packetVersion && !source.diagnostics) return null;
  return safeDiagnosticValue({
    packetId: safeText(source.packetId, 160),
    packetVersion: numberOr(source.packetVersion, 0),
    footprint: safeText(source.footprint, 40),
    selectedCardCount: asArray(source.selectedCardRefs).length,
    omissionCount: asArray(source.omissions).length,
    injectionBlockCount: asArray(source.injectionPlan).length,
    diagnostics: mapPacketDiagnostics(source.diagnostics),
    promptPacketHash: hashJson(source)
  }, 500);
}

function mapHandSummary(hand) {
  const source = asObject(hand);
  const cards = asArray(source.cards);
  if (!source.handId && cards.length <= 0) return null;
  return safeDiagnosticValue({
    handId: safeText(source.handId, 160),
    selectedCount: cards.length,
    omittedCount: asArray(source.omitted).length,
    families: [...new Set(cards.map((card) => safeText(card?.family, 80)).filter(Boolean))].slice(0, 24),
    roles: cards.slice(0, 24).map((card) => ({
      id: safeText(card?.id, 160),
      family: safeText(card?.family, 80),
      role: safeText(card?.role, 80),
      status: safeText(card?.status, 40),
      emphasis: safeText(card?.emphasis, 40),
      tokenEstimate: numberOr(card?.tokenEstimate, 0)
    }))
  }, 500);
}

function mapPlanSummary(plan) {
  const source = asObject(plan);
  if (!source.action && !source.sceneStatus && !source.promptFootprint && !source.reasonerDecision && !source.diagnostics) {
    return null;
  }
  return safeDiagnosticValue({
    action: safeText(source.action, 40),
    sceneStatus: safeText(source.sceneStatus, 40),
    promptFootprint: safeText(source.promptFootprint, 40),
    reasonerDecision: {
      mode: safeText(source.reasonerDecision?.mode, 40),
      reason: safeText(source.reasonerDecision?.reason, 160)
    },
    diagnostics: asArray(source.diagnostics).slice(0, 24).map((entry) => safeText(entry, 160))
  }, 500);
}

function mapCardDeckSettings(settings) {
  const preProcessDecks = asObject(settings?.preProcessDecks);
  const customDecks = asObject(preProcessDecks.customDecks);
  return safeDiagnosticValue({
    version: numberOr(preProcessDecks.version, 0),
    activeDeckId: safeText(preProcessDecks.activeDeckId, 120),
    customDeckCount: Object.keys(customDecks).length,
    customDecks: Object.fromEntries(Object.entries(customDecks).slice(0, 24).map(([deckId, deck]) => {
      const source = asObject(deck);
      const cards = asObject(source.cards);
      const categories = asObject(source.categories);
      const runnableCount = Object.values(cards).filter((card) => {
        const cardSource = asObject(card);
        return cardSource.enabled !== false
          && safeText(cardSource.name, 120)
          && safeText(cardSource.name, 120) !== 'New Card'
          && safeText(cardSource.promptText, 1);
      }).length;
      return [safeText(deckId, 120), {
        id: safeText(source.id, 120),
        name: safeText(source.name, 120),
        readonly: source.readonly === true,
        bundled: source.bundled === true,
        categoryCount: Object.keys(categories).length,
        cardCount: Object.keys(cards).length,
        runnableCardCount: runnableCount,
        categoryOrderHash: hashJson(source.categoryOrder || []),
        cardOrderHash: hashJson(source.cardOrderByCategory || {})
      }];
    }))
  }, 500);
}

function mapSettingsSummary(settings) {
  const source = asObject(settings);
  return safeDiagnosticValue({
    enabled: source.enabled !== false,
    mode: safeText(source.mode, 40),
    pipelineMode: safeText(source.pipelineMode, 40),
    strength: safeText(source.strength, 40),
    minCards: numberOr(source.minCards, 0),
    maxCards: numberOr(source.maxCards, 0),
    reasoningLevel: safeText(source.reasoningLevel, 40),
    promptFootprint: safeText(source.promptFootprint, 40),
    focus: safeText(source.focus, 80),
    reasonerUse: safeText(source.reasonerUse, 40),
    storyFormOverride: safeText(source.storyFormOverride, 80),
    postProcess: source.postProcess || null,
    injection: source.injection || null,
    retention: source.retention || null,
    preProcessDecks: mapCardDeckSettings(source),
    postProcessDecks: mapCardDeckSettings({ preProcessDecks: source.postProcessDecks })
  }, 500);
}

function mapJournalEntry(entry) {
  const source = asObject(entry);
  return safeDiagnosticValue({
    id: safeText(source.id, 120),
    runId: safeText(source.runId, 160),
    event: safeText(source.event, 120),
    phase: safeText(source.phase, 120),
    severity: safeText(source.severity, 40),
    label: safeText(source.label || source.summary, 240),
    recordedAt: safeText(source.recordedAt || source.createdAt || source.updatedAt, 80),
    details: source.details,
    hashes: source.hashes
  }, 500);
}

function mapCacheDecision(decision) {
  const source = asObject(decision);
  if (!source.decision && !source.kind && !source.reason) return null;
  return safeDiagnosticValue({
    sequence: numberOr(source.sequence, 0),
    decision: safeText(source.decision, 40),
    kind: safeText(source.kind, 60),
    reason: safeText(source.reason, 180),
    basisMode: safeText(source.basisMode, 40),
    basisReason: safeText(source.basisReason, 120),
    artifactHash: safeText(source.artifactHash, 180),
    packetId: safeText(source.packetId, 180),
    handId: safeText(source.handId, 180),
    reusedCardIds: asArray(source.reusedCardIds).slice(0, 32).map((entry) => safeText(entry, 160)),
    providerCallsSkipped: asArray(source.providerCallsSkipped).slice(0, 16).map((entry) => safeText(entry, 80)),
    recordedAt: safeText(source.recordedAt, 80)
  }, 500);
}

export function buildDiagnosticsPayload({
  view,
  settings,
  cacheContracts,
  journal,
  index,
  chatKey,
  includeExcerpts = false,
  createdAt = nowIso()
} = {}) {
  const sourceEntries = asArray(journal?.entries);
  const runtime = asObject(view);
  const payload = {
    schema: 'recursion.diagnostics.v1',
    createdAt,
    settings: mapSettingsSummary(settings),
    runtime: {
      activeRunId: runtime.activeRunId || null,
      hostGenerationActive: Boolean(runtime.hostGenerationActive),
      activity: runtime.activity || null,
      activityHistory: asArray(runtime.activityHistory).slice(-20),
      freshNextGeneration: runtime.freshNextGeneration || null,
      rapidWarm: runtime.rapidWarm || null,
      cacheDecision: mapCacheDecision(runtime.lastCacheDecision),
      preparedGeneration: runtime.lastPreparedGeneration
        ? safeDiagnosticValue(summarizePreparedGenerationArtifact(runtime.lastPreparedGeneration), 500)
        : null,
      packet: mapPacketSummary(runtime.lastPacket),
      hand: mapHandSummary(runtime.lastHand),
      plan: mapPlanSummary(runtime.lastPlan)
    },
    cacheContracts,
    storage: {
      chatKey: safeText(journal?.chatKey || chatKey, 160),
      indexRecordCount: index?.records ? Object.keys(index.records).length : 0,
      journalEntryCount: sourceEntries.length,
      journalMaxEntries: numberOr(journal?.maxEntries, 0),
      journalUpdatedAt: safeText(journal?.updatedAt, 80)
    },
    journal: sourceEntries.slice(-50).map(mapJournalEntry),
    excerpts: includeExcerpts ? safeDiagnosticValue({
      lastPacket: runtime.lastPacket || null,
      lastHand: runtime.lastHand || null,
      lastPlan: runtime.lastPlan || null
    }, 900) : null
  };
  return safeDiagnosticValue(payload, includeExcerpts ? 900 : 500);
}
