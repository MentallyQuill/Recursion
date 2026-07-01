import { compact, hashJson, makeId, nowIso, redact, truncate } from './core.mjs';

export const PROMPT_PACKET_VERSION = 1;
const PACKET_VERSION = PROMPT_PACKET_VERSION;
const REASONER_SCHEMA = 'recursion.reasonerComposer.v1';
const VALID_FOOTPRINTS = new Set(['compact', 'normal', 'rich']);
const VALID_REASONER_USE = new Set(['off', 'auto', 'always']);
const SECTION_KEYS = Object.freeze(['sceneBrief', 'turnBrief', 'guardrails']);
const SCENE_BRIEF_FAMILIES = new Set(['Scene Frame', 'Active Cast', 'Environment/Items']);
const GUARDRAIL_FAMILIES = new Set(['Continuity Risk']);
const EMPHASIS = new Set(['normal', 'emphasized', 'muted']);
const DETAIL_PROFILES = new Set(['compact', 'standard', 'expanded']);
const MAX_CARD_TEXT = 1200;
const MAX_EVIDENCE_TEXT = 160;
const MAX_OMISSION_REASON = 160;
const MAX_REASONER_PATCH = 900;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const SAFE_REF_PATTERN = /^(message|card|scene|source|turn):[A-Za-z0-9_.:-]{1,96}$/;
const SAFE_OMISSION_REASONS = new Set(['token-budget', 'max-cards', 'inactive', 'budget_exceeded', 'reasoner_dropped', 'unspecified']);
const VALID_FAMILIES = new Set([
  'Scene Frame',
  'Active Cast',
  'Character Motivation',
  'Dialogue/Relationship',
  'Continuity Risk',
  'Environment/Items',
  'Prose/Pacing',
  'Open Threads'
]);
const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|inspector[-_\s]*only|source[-_\s]*should[-_\s]*not[-_\s]*leak|freshness[-_\s]*should[-_\s]*not[-_\s]*leak|arbiter[-_\s]*should[-_\s]*not[-_\s]*leak|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/i;

const FOOTPRINT_BUDGETS = Object.freeze({
  compact: Object.freeze({ sceneBrief: 240, turnBrief: 240, guardrails: 520 }),
  normal: Object.freeze({ sceneBrief: 900, turnBrief: 900, guardrails: 900 }),
  rich: Object.freeze({ sceneBrief: 1600, turnBrief: 1600, guardrails: 1200 })
});

const STATIC_GUARDRAILS = Object.freeze([
  'Respect the player message: preserve stated player intent, spoken content, and choices.',
  'Keep out-of-character analysis, unrevealed information, and future story plans out of the response.',
  'Resolve conflicts by preserving continuity constraints before style suggestions.'
]);

const INJECTION_TEMPLATE = Object.freeze([
  Object.freeze({ id: 'sceneBrief', promptKey: 'recursion.sceneBrief', title: 'Recursion Scene Brief', placement: 'in_prompt', depth: 4, role: 'system' }),
  Object.freeze({ id: 'turnBrief', promptKey: 'recursion.turnBrief', title: 'Recursion Turn Brief', placement: 'in_chat', depth: 2, role: 'system' }),
  Object.freeze({ id: 'guardrails', promptKey: 'recursion.guardrails', title: 'Recursion Guardrails', placement: 'in_prompt', depth: 1, role: 'system' })
]);

const DYNAMIC_FORBIDDEN_PATTERNS = Object.freeze([
  /\bhidden\s+chain[-\s]of[-\s]thought\b/i,
  /\bchain[-\s]of[-\s]thought\b/i,
  /\b(hidden|private|secret|undisclosed)\s+(internal\s+)?thoughts?\b/i,
  /\b(private|hidden|secret|undisclosed)\s+(character\s+)?motives?\b/i,
  /\b(secret|hidden|private|undisclosed)\s+future\s+(plans?|plot|story)\b/i,
  /\breveal\s+future\s+plans?\b/i,
  /\bfuture[-\s]plot\b/i,
  /\b(hidden|private|secret|undisclosed)\s+spoilers?\b/i,
  /\breveal\s+spoilers?\b/i
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, limit) {
  return truncate(compact(value ?? '', limit), limit);
}

function safeText(value, limit) {
  return cleanText(String(redact(value, { maxString: limit }) ?? '').replace(new RegExp(SECRET_TEXT_PATTERN.source, 'ig'), '[redacted]'), limit);
}

function cleanOptionalText(value, limit) {
  const text = cleanText(value, limit);
  return text || undefined;
}

function safeOptionalText(value, limit) {
  const text = safeText(value, limit);
  return text || undefined;
}

function safePromptId(value, fallbackPrefix = 'id') {
  const text = safeOptionalText(value, 120);
  if (!text) return '';
  if (SAFE_ID_PATTERN.test(text) && !SECRET_TEXT_PATTERN.test(text)) return text;
  return `${fallbackPrefix}-${hashJson(text).slice(0, 12)}`;
}

function safeFamily(value) {
  const family = cleanText(value, 120);
  return VALID_FAMILIES.has(family) ? family : 'Prose/Pacing';
}

function safeEvidenceRef(value) {
  const text = safeOptionalText(value, MAX_EVIDENCE_TEXT);
  if (!text) return null;
  return SAFE_REF_PATTERN.test(text) && !SECRET_TEXT_PATTERN.test(text) ? text : null;
}

function safeOmissionReason(value) {
  const reason = safeOptionalText(value, MAX_OMISSION_REASON);
  if (!reason) return '';
  return SAFE_OMISSION_REASONS.has(reason) ? reason : 'unspecified';
}

function cleanEnum(value, allowed, fallback) {
  const text = String(value ?? '').trim();
  return allowed.has(text) ? text : fallback;
}

function numberInRange(value, fallback, min, max) {
  const number = Number(value);
  const resolved = Number.isFinite(number) ? number : fallback;
  return Math.min(max, Math.max(min, Math.round(resolved)));
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function normalizeFootprint(settings = {}) {
  const footprint = String(settings?.promptFootprint ?? '').trim();
  return VALID_FOOTPRINTS.has(footprint) ? footprint : 'normal';
}

function normalizeReasonerUse(settings = {}) {
  const mode = String(settings?.reasonerUse ?? 'auto').trim();
  return VALID_REASONER_USE.has(mode) ? mode : 'auto';
}

function normalizeEvidenceRefs(value) {
  const source = Array.isArray(value)
    ? value
    : (value === undefined || value === null || value === '' ? [] : [value]);
  return source
    .map((entry) => safeEvidenceRef(entry))
    .filter(Boolean)
    .slice(0, 12);
}

function cardId(card, index) {
  const raw = safePromptId(card.id ?? card.cardId, 'card');
  if (raw) return raw;
  return `card-${index + 1}-${hashJson(card.promptText ?? '')}`;
}

function normalizeCard(card, index) {
  const source = asObject(card);
  const promptText = safeText(source.promptText, MAX_CARD_TEXT);
  const id = cardId(source, index);
  const tokenEstimate = numberInRange(source.tokenEstimate, estimateTokens(promptText), 0, 100000);
  return {
    id,
    family: safeFamily(source.family),
    promptText,
    emphasis: cleanEnum(source.emphasis, EMPHASIS, 'normal'),
    tokenEstimate,
    detailProfile: cleanEnum(source.detailProfile, DETAIL_PROFILES, 'standard'),
    evidenceRefs: normalizeEvidenceRefs(source.evidenceRefs)
  };
}

function normalizeCards(hand = {}) {
  return (Array.isArray(hand?.cards) ? hand.cards : [])
    .map((card, index) => normalizeCard(card, index))
    .filter((card) => card.promptText);
}

function normalizeOmissions(hand = {}) {
  return (Array.isArray(hand?.omitted) ? hand.omitted : [])
    .map((omission) => {
      const source = asObject(omission);
      const cardIdValue = safePromptId(source.cardId ?? source.id, 'omitted');
      const reason = safeOmissionReason(source.reason);
      if (!cardIdValue && !reason) return null;
      return {
        cardId: cardIdValue || '',
        family: safeFamily(source.family),
        reason: reason || '',
        tokenEstimate: numberInRange(source.tokenEstimate, 0, 0, 100000)
      };
    })
    .filter(Boolean);
}

function selectedCardRef(card) {
  return {
    cardId: card.id,
    family: card.family,
    emphasis: card.emphasis,
    tokenEstimate: card.tokenEstimate,
    detailProfile: card.detailProfile,
    evidenceRefs: [...card.evidenceRefs]
  };
}

function reasonerCard(card) {
  return {
    id: card.id,
    family: card.family,
    promptText: card.promptText,
    emphasis: card.emphasis,
    tokenEstimate: card.tokenEstimate,
    detailProfile: card.detailProfile,
    evidenceRefs: [...card.evidenceRefs]
  };
}

function sectionForCard(card) {
  if (GUARDRAIL_FAMILIES.has(card.family)) return 'guardrails';
  if (SCENE_BRIEF_FAMILIES.has(card.family)) return 'sceneBrief';
  return 'turnBrief';
}

function cardLine(card) {
  const emphasis = card.emphasis === 'normal' ? '' : ` ${card.emphasis}`;
  return `- [${card.family || 'Card'}${emphasis}] ${card.promptText}`;
}

function buildUtilitySections(cards, budgets) {
  const entries = {
    sceneBrief: [],
    turnBrief: [],
    guardrails: STATIC_GUARDRAILS.map((text) => ({ text, sourceId: null, family: '' }))
  };

  for (const card of cards) {
    const section = sectionForCard(card);
    entries[section].push({ text: cardLine(card), sourceId: card.id, family: card.family });
  }

  const scene = budgetSection('Scene brief:', entries.sceneBrief, budgets.sceneBrief, 'sceneBrief');
  const turn = budgetSection('Turn brief:', entries.turnBrief, budgets.turnBrief, 'turnBrief');
  const guardrails = budgetSection('Guardrails:', entries.guardrails, budgets.guardrails, 'guardrails');

  return {
    sections: {
      sceneBrief: scene.text || 'Scene brief: No scene-facing card guidance selected.',
      turnBrief: turn.text || 'Turn brief: No turn-specific card guidance selected.',
      guardrails: guardrails.text
    },
    sectionSources: {
      sceneBrief: scene.sourceIds,
      turnBrief: turn.sourceIds,
      guardrails: guardrails.sourceIds
    },
    budgetOmissions: [...scene.omissions, ...turn.omissions, ...guardrails.omissions]
  };
}

function budgetSection(header, entries, limit, section) {
  const output = [header];
  const sourceIds = [];
  const omissions = [];
  let used = header.length;

  for (const entry of entries) {
    const text = normalizeSectionLine(entry.text);
    if (!text) continue;
    const line = text.startsWith('- ') ? text : `- ${text}`;
    const nextLength = used + 1 + line.length;
    if (nextLength > limit) {
      const available = limit - used - 1;
      if (entry.sourceId && output.length === 1 && available > 3) {
        output.push(truncate(line, available));
        sourceIds.push(entry.sourceId);
        used = limit;
        continue;
      }
      if (entry.sourceId) {
        omissions.push({
          cardId: entry.sourceId,
          family: safeFamily(entry.family),
          reason: 'budget_exceeded',
          section
        });
      }
      continue;
    }
    output.push(line);
    used = nextLength;
    if (entry.sourceId) sourceIds.push(entry.sourceId);
  }

  return {
    text: output.join('\n'),
    sourceIds,
    omissions
  };
}

function normalizeSectionLine(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => safeText(line, 500))
    .filter(Boolean)
    .join(' ');
}

function applySectionBudgets(sections, budgets) {
  return Object.fromEntries(SECTION_KEYS.map((section) => [
    section,
    truncateSection(sections?.[section] ?? '', budgets[section])
  ]));
}

function truncateSection(value, limit) {
  return truncate(String(value ?? '').replace(/\r\n/g, '\n').trim(), limit);
}

function buildInjectionPlan(sectionSources, budgets) {
  return INJECTION_TEMPLATE.map((block) => ({
    ...block,
    section: block.id,
    sourceIds: [...(sectionSources?.[block.id] || [])],
    maxChars: budgets[block.id]
  }));
}

function snapshotField(snapshot, key) {
  return safeText(asObject(snapshot)[key], 200);
}

function baseDiagnostics({ runId, footprint, budgets, cards, omissions, composerLane = 'utility', reasonerStatus = 'skipped' }) {
  return {
    runId,
    composerLane,
    reasonerStatus,
    sectionBudgets: { ...budgets },
    selectedCardCount: cards.length,
    omissionCount: omissions.length,
    selectedTokenEstimate: cards.reduce((sum, card) => sum + card.tokenEstimate, 0),
    sectionHashes: null,
    footprint
  };
}

function withSectionHashes(packet) {
  return {
    ...packet,
    diagnostics: {
      ...packet.diagnostics,
      sectionHashes: Object.fromEntries(SECTION_KEYS.map((section) => [section, hashJson(packet.sections[section])]))
    }
  };
}

function buildPacket({
  packetId,
  runId,
  snapshot,
  footprint,
  budgets,
  cards,
  omissions,
  sections,
  sectionSources,
  diagnostics,
  composedAt
}) {
  return withSectionHashes({
    packetId,
    packetVersion: PACKET_VERSION,
    chatId: snapshotField(snapshot, 'chatId'),
    sceneFingerprint: snapshotField(snapshot, 'sceneFingerprint'),
    turnFingerprint: snapshotField(snapshot, 'turnFingerprint'),
    footprint,
    sections,
    selectedCardRefs: cards.map((card) => selectedCardRef(card)),
    omissions,
    injectionPlan: buildInjectionPlan(sectionSources, budgets),
    diagnostics: diagnostics || baseDiagnostics({ runId, footprint, budgets, cards, omissions }),
    composedAt
  });
}

function shouldUseReasoner(settings, footprint, generationRouter) {
  if (!generationRouter || typeof generationRouter.generate !== 'function') return false;
  const reasonerUse = normalizeReasonerUse(settings);
  if (reasonerUse === 'off') return false;
  return reasonerUse === 'always' || footprint === 'rich';
}

function buildReasonerPrompt({ runId, footprint, cards, sections }) {
  return [
    'Compose an optional Recursion prompt packet synthesis.',
    `Return one JSON object only using schema "${REASONER_SCHEMA}".`,
    'Use only the selected card objects below; do not invent facts or inspect hidden fields.',
    'Expected JSON shape: {"schema":"recursion.reasonerComposer.v1","instructionPatch":"concise instruction patch","keptCardIds":["card-id"],"droppedCardIds":[]}.',
    `Run id: ${runId}`,
    `Footprint: ${footprint}`,
    `Selected cards:\n${JSON.stringify(cards.map((card) => reasonerCard(card)), null, 2)}`,
    `Utility sections:\n${JSON.stringify(sections, null, 2)}`
  ].join('\n\n');
}

function safeFallbackReason(value, fallback = 'reasoner_fallback') {
  const redacted = safeText(value || fallback, 180);
  return redacted || fallback;
}

function fallbackReasonFromResult(result) {
  if (!result) return 'Reasoner returned no result.';
  if (result.ok === false) {
    return safeFallbackReason(result.error?.code || result.error?.message || 'reasoner_failed');
  }
  const schema = result.data?.schema;
  if (schema !== REASONER_SCHEMA) return 'reasoner_schema_mismatch';
  if (!cleanOptionalText(result.data?.instructionPatch, MAX_REASONER_PATCH)) {
    return 'reasoner_patch_missing';
  }
  return 'reasoner_invalid';
}

function filterReasonerIds(value, allowedIds) {
  if (!Array.isArray(value)) return { ids: [], invalidCount: 0 };
  const ids = [];
  let invalidCount = 0;
  for (const entry of value) {
    const id = safePromptId(entry, 'reasoner-source');
    if (id && allowedIds.has(id)) ids.push(id);
    else invalidCount += 1;
  }
  return { ids: uniqueStrings(ids), invalidCount };
}

function validateReasonerResult(result, allowedIds) {
  if (!result?.ok) return { ok: false, reason: fallbackReasonFromResult(result) };
  if (result.data?.schema !== REASONER_SCHEMA) return { ok: false, reason: fallbackReasonFromResult(result) };
  const instructionPatch = safeOptionalText(result.data?.instructionPatch, MAX_REASONER_PATCH);
  if (!instructionPatch) return { ok: false, reason: fallbackReasonFromResult(result) };
  const kept = filterReasonerIds(result.data?.keptCardIds, allowedIds);
  const dropped = filterReasonerIds(result.data?.droppedCardIds, allowedIds);
  return {
    ok: true,
    instructionPatch,
    keptCardIds: kept.ids,
    droppedCardIds: dropped.ids,
    invalidSourceIdCount: kept.invalidCount + dropped.invalidCount
  };
}

function emitActivity(activity, event) {
  const targets = [];
  if (typeof activity === 'function') targets.push(activity);
  if (typeof activity?.stage === 'function') targets.push((entry) => activity.stage(entry));
  if (typeof activity?.record === 'function') targets.push((entry) => activity.record(entry));
  if (typeof activity?.onEvent === 'function') targets.push((entry) => activity.onEvent(entry));

  for (const target of targets) {
    try {
      const result = target({ ...event });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Prompt activity is diagnostic only; observer failures must not break composition.
    }
  }
}

function emitFallbackActivity(activity, { runId, reason }) {
  emitActivity(activity, {
    runId,
    phase: 'promptReasonerFallback',
    mode: 'background',
    severity: 'warning',
    providerLane: 'reasoner',
    composerLane: 'utility',
    label: 'Reasoner composer fell back to Utility.',
    fallbackReason: cleanText(reason, 240),
    detail: { reasonerStatus: 'fallback' },
    recordedAt: nowIso()
  });
}

async function applyReasonerPatch({
  packet,
  cards,
  budgets,
  generationRouter,
  activity
}) {
  const runId = packet.diagnostics.runId;
  const allowedIds = new Set(cards.map((card) => card.id));
  try {
    const prompt = buildReasonerPrompt({
      runId,
      footprint: packet.footprint,
      cards,
      sections: packet.sections
    });
    const result = await generationRouter.generate('reasonerComposer', { runId, prompt });
    const validated = validateReasonerResult(result, allowedIds);
    if (!validated.ok) {
      emitFallbackActivity(activity, { runId, reason: validated.reason });
      return {
        ...packet,
        diagnostics: {
          ...packet.diagnostics,
          composerLane: 'utility',
          reasonerStatus: 'fallback',
          fallbackReason: validated.reason
        }
      };
    }

    const sectionSources = Object.fromEntries(packet.injectionPlan.map((block) => [block.section, block.sourceIds || []]));
    sectionSources.turnBrief = uniqueStrings([
      ...(sectionSources.turnBrief || []),
      ...validated.keptCardIds
    ]);
    const reasonerLine = `Reasoner synthesis: ${validated.instructionPatch}`;
    const turnBrief = appendRequiredLine(packet.sections.turnBrief, reasonerLine, budgets.turnBrief);
    if (!turnBrief.includes(reasonerLine)) {
      emitFallbackActivity(activity, { runId, reason: 'reasoner_patch_budget_exceeded' });
      return {
        ...packet,
        diagnostics: {
          ...packet.diagnostics,
          composerLane: 'utility',
          reasonerStatus: 'fallback',
          fallbackReason: 'reasoner_patch_budget_exceeded'
        }
      };
    }
    const sections = applySectionBudgets({
      ...packet.sections,
      turnBrief
    }, budgets);
    const reasonerPacket = withSectionHashes({
      ...packet,
      sections,
      injectionPlan: buildInjectionPlan(sectionSources, budgets),
      diagnostics: {
        ...packet.diagnostics,
        composerLane: 'reasoner',
        reasonerStatus: 'used',
        reasonerKeptCardIds: validated.keptCardIds,
        reasonerDroppedCardIds: validated.droppedCardIds,
        reasonerInvalidSourceIdCount: validated.invalidSourceIdCount
      }
    });
    validatePromptPacket(reasonerPacket);
    return reasonerPacket;
  } catch (error) {
    const reason = safeFallbackReason(error?.code || error?.message || error || 'reasoner_exception');
    emitFallbackActivity(activity, { runId, reason });
    return {
      ...packet,
      diagnostics: {
        ...packet.diagnostics,
        composerLane: 'utility',
        reasonerStatus: 'fallback',
        fallbackReason: reason
      }
    };
  }
}

function appendRequiredLine(existingText, requiredLine, limit) {
  const line = truncateSection(requiredLine, limit);
  if (!line) return truncateSection(existingText, limit);
  const existing = truncateSection(existingText, limit);
  const joined = existing ? `${existing}\n${line}` : line;
  if (joined.length <= limit) return joined;
  const remaining = limit - line.length - 1;
  if (remaining <= 0) return line.length <= limit ? line : truncateSection(line, limit);
  return `${truncateSection(existing, remaining)}\n${line}`;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => cleanText(value, 120)).filter(Boolean))];
}

function assertRequiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
}

function assertSectionTextSafe(section, text) {
  for (const pattern of DYNAMIC_FORBIDDEN_PATTERNS) {
    if (pattern.test(String(text ?? ''))) {
      throw new Error(`Prompt packet ${section} contains disallowed hidden reasoning wording.`);
    }
  }
}

function validateInjectionPlan(packet) {
  assertArray(packet.injectionPlan, 'injectionPlan');
  const seen = new Set();
  const templateById = new Map(INJECTION_TEMPLATE.map((block) => [block.id, block]));
  for (const block of packet.injectionPlan) {
    assertRequiredString(block?.id, 'injectionPlan.id');
    assertRequiredString(block?.promptKey, 'injectionPlan.promptKey');
    assertRequiredString(block?.title, 'injectionPlan.title');
    assertRequiredString(block?.placement, 'injectionPlan.placement');
    assertRequiredString(block?.role, 'injectionPlan.role');
    if (!SECTION_KEYS.includes(block.id)) throw new Error(`Unknown injection plan section: ${block.id}`);
    if (seen.has(block.id)) throw new Error(`Duplicate injection plan section: ${block.id}`);
    const expected = templateById.get(block.id);
    if (block.section !== block.id) throw new Error('injectionPlan.section must match id.');
    if (block.promptKey !== expected.promptKey) throw new Error('injectionPlan.promptKey is invalid.');
    if (block.title !== expected.title) throw new Error('injectionPlan.title is invalid.');
    if (block.placement !== expected.placement) throw new Error('injectionPlan.placement is invalid.');
    if (block.role !== expected.role) throw new Error('injectionPlan.role is invalid.');
    const depth = Number(block.depth);
    if (!Number.isInteger(depth) || depth < 0 || depth > 10) throw new Error('injectionPlan.depth is invalid.');
    if (depth !== expected.depth) throw new Error('injectionPlan.depth does not match template.');
    const maxChars = Number(block.maxChars);
    if (!Number.isInteger(maxChars) || maxChars < 0 || maxChars > 100000) throw new Error('injectionPlan.maxChars is invalid.');
    assertArray(block?.sourceIds, 'injectionPlan.sourceIds');
    for (const sourceId of block.sourceIds) {
      if (typeof sourceId !== 'string' || !SAFE_ID_PATTERN.test(sourceId)) throw new Error('injectionPlan.sourceIds must be safe strings.');
    }
    seen.add(block.id);
  }
  for (const section of SECTION_KEYS) {
    if (!seen.has(section)) throw new Error(`Missing injection plan section: ${section}`);
  }
}

export async function composePromptPacket({
  hand = {},
  snapshot = {},
  settings = {},
  generationRouter = null,
  activity = null,
  onActivity = null,
  runId = makeId('prompt-run')
} = {}) {
  const footprint = normalizeFootprint(settings);
  const budgets = FOOTPRINT_BUDGETS[footprint];
  const cards = normalizeCards(hand);
  const promptRunId = safePromptId(runId, 'prompt-run') || makeId('prompt-run');
  const handOmissions = normalizeOmissions(hand);
  const packetId = makeId('prompt-packet');
  const composedAt = nowIso();
  const utility = buildUtilitySections(cards, budgets);
  const omissions = [...handOmissions, ...utility.budgetOmissions];
  let packet = buildPacket({
    packetId,
    runId: promptRunId,
    snapshot,
    footprint,
    budgets,
    cards,
    omissions,
    sections: utility.sections,
    sectionSources: utility.sectionSources,
    composedAt
  });

  validatePromptPacket(packet);

  const activityTarget = activity || onActivity;
  if (shouldUseReasoner(settings, footprint, generationRouter)) {
    packet = await applyReasonerPatch({
      packet,
      cards,
      budgets,
      generationRouter,
      activity: activityTarget
    });
  }

  validatePromptPacket(packet);
  return packet;
}

export function validatePromptPacket(packet) {
  const source = asObject(packet);
  assertRequiredString(source.packetId, 'packetId');
  if (source.packetVersion !== PACKET_VERSION) throw new Error('packetVersion is invalid.');
  assertRequiredString(source.chatId, 'chatId');
  assertRequiredString(source.sceneFingerprint, 'sceneFingerprint');
  assertRequiredString(source.turnFingerprint, 'turnFingerprint');
  if (!VALID_FOOTPRINTS.has(source.footprint)) throw new Error('footprint is invalid.');
  assertRequiredString(source.composedAt, 'composedAt');

  const sections = asObject(source.sections);
  for (const section of SECTION_KEYS) {
    assertRequiredString(sections[section], `sections.${section}`);
    assertSectionTextSafe(`sections.${section}`, sections[section]);
  }

  assertArray(source.selectedCardRefs, 'selectedCardRefs');
  assertArray(source.omissions, 'omissions');
  validateInjectionPlan(source);
  if (!source.diagnostics || typeof source.diagnostics !== 'object' || Array.isArray(source.diagnostics)) {
    throw new Error('diagnostics must be an object.');
  }
  assertRequiredString(source.diagnostics.runId, 'diagnostics.runId');
  assertRequiredString(source.diagnostics.composerLane, 'diagnostics.composerLane');
  assertRequiredString(source.diagnostics.reasonerStatus, 'diagnostics.reasonerStatus');
  return source;
}

export function packetToPromptBlocks(packet) {
  const source = validatePromptPacket(packet);
  const budgets = asObject(source.diagnostics?.sectionBudgets);
  return source.injectionPlan.map((plan) => {
    const rawText = String(source.sections[plan.id] ?? '');
    const maxChars = numberInRange(plan.maxChars ?? budgets[plan.id], rawText.length, 0, 100000);
    const text = truncate(rawText, maxChars);
    return {
      id: plan.id,
      promptKey: plan.promptKey,
      title: plan.title,
      packetId: source.packetId,
      section: plan.id,
      placement: plan.placement,
      depth: Number(plan.depth),
      role: plan.role,
      text,
      hash: hashJson(text),
      sourceIds: [...plan.sourceIds]
    };
  });
}
