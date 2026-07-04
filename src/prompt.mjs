import { compact, hashJson, makeId, nowIso, redact, truncate } from './core.mjs';
import { normalizeInjectionSettings } from './settings.mjs';
import {
  behaviorComposerLines,
  FOOTPRINT_SECTION_BUDGETS,
  influencePolicyForSettings,
  summarizeBehaviorPolicyForDiagnostics
} from './settings-policy.mjs';
import { reasoningRequestMetadata } from './reasoning-policy.mjs';
import { UNKNOWN_STORY_FORM, normalizeStoryForm, storyFormInstruction } from './story-form.mjs';

export const PROMPT_PACKET_VERSION = 3;
export const GUIDANCE_SCHEMA = 'recursion.guidanceComposer.v1';

const PACKET_VERSION = PROMPT_PACKET_VERSION;
const REASONER_SCHEMA = 'recursion.reasonerComposer.v1';
const VALID_FOOTPRINTS = new Set(['compact', 'normal', 'rich']);
const VALID_REASONER_USE = new Set(['off', 'auto', 'always']);
const SECTION_KEYS = Object.freeze(['guidance', 'cardEvidence', 'guardrails']);
const VALID_INJECTION_PLACEMENTS = new Set(['in_prompt', 'in_chat']);
const VALID_INJECTION_ROLES = new Set(['system', 'user', 'assistant']);
const EMPHASIS = new Set(['normal', 'emphasized', 'muted']);
const DETAIL_PROFILES = new Set(['compact', 'standard', 'expanded']);
const MAX_CARD_TEXT = Infinity;
const MAX_EVIDENCE_TEXT = 160;
const MAX_OMISSION_REASON = 160;
const MAX_GUIDANCE_TEXT = 6000;
const MAX_DIAGNOSTIC_TEXT = 180;
const MAX_PACKET_SECTION = 100000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const SAFE_REF_PATTERN = /^(message|card|scene|source|turn):[A-Za-z0-9_.:-]{1,96}$/;
const SAFE_OMISSION_REASONS = new Set(['token-budget', 'max-cards', 'inactive', 'budget_exceeded', 'reasoner_dropped', 'manual-forced-provider-failed', 'unspecified']);
const VALID_GUIDANCE_DROP_REASONS = new Set(['duplicate', 'lower-priority', 'unsupported', 'unsafe']);
const VALID_GUIDANCE_STATUSES = new Set(['used', 'missing', 'fallback-raw-only']);
const VALID_REASONER_DROP_REASONS = new Set(['duplicate', 'lower-priority', 'budget-exceeded', 'unsupported']);
const VALID_FAMILIES = new Set([
  'Scene Frame',
  'Active Cast',
  'Character Motivation',
  'Relationship',
  'Social Subtext',
  'Scene Constraints',
  'Knowledge',
  'Consequences',
  'Environment',
  'Items',
  'Open Threads'
]);
const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|inspector[-_\s]*only|source[-_\s]*should[-_\s]*not[-_\s]*leak|freshness[-_\s]*should[-_\s]*not[-_\s]*leak|arbiter[-_\s]*should[-_\s]*not[-_\s]*leak|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/i;
const FOOTPRINT_BUDGETS = FOOTPRINT_SECTION_BUDGETS;

const STATIC_GUARDRAILS = Object.freeze([
  'Write only the next assistant message; keep Recursion cards, labels, and guidance invisible.',
  'Honor player intent, visible facts, reveal boundaries, and hard card constraints.',
  'Use raw Recursion card evidence as source of truth when guidance and evidence conflict.'
]);

const INJECTION_TEMPLATE = Object.freeze([
  Object.freeze({ id: 'guidance', promptKey: 'recursion.guidance', title: 'Recursion Guidance', placement: 'in_prompt', depth: 1, role: 'system' }),
  Object.freeze({ id: 'cardEvidence', promptKey: 'recursion.cardEvidence', title: 'Recursion Card Evidence', placement: 'in_prompt', depth: 1, role: 'system' }),
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

function safeTextSource(value, limit) {
  const redacted = redact(value, { maxString: limit });
  if (redacted === undefined || redacted === null) return '';
  if (['string', 'number', 'boolean', 'bigint'].includes(typeof redacted)) return String(redacted);
  try {
    return JSON.stringify(redacted);
  } catch {
    return '';
  }
}

function safeText(value, limit) {
  return cleanText(safeTextSource(value, limit).replace(new RegExp(SECRET_TEXT_PATTERN.source, 'ig'), '[redacted]'), limit);
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
  return VALID_FAMILIES.has(family) ? family : 'Open Threads';
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

function shouldUseReasoner(settings, footprint, generationRouter) {
  if (!generationRouter || typeof generationRouter.generate !== 'function') return false;
  const reasonerUse = normalizeReasonerUse(settings);
  if (reasonerUse === 'off') return false;
  return reasonerUse === 'always' || footprint === 'rich';
}

function behaviorPolicyFrom(settings = {}, behaviorPolicy = null) {
  if (behaviorPolicy && typeof behaviorPolicy === 'object' && !Array.isArray(behaviorPolicy)) return behaviorPolicy;
  if (settings?.behaviorPolicy && typeof settings.behaviorPolicy === 'object' && !Array.isArray(settings.behaviorPolicy)) {
    return settings.behaviorPolicy;
  }
  return influencePolicyForSettings(settings);
}

function footprintForPolicy(settings = {}, behaviorPolicy = null) {
  const policyFootprint = String(behaviorPolicy?.footprint?.effectiveLevel ?? behaviorPolicy?.footprint?.level ?? '').trim();
  return VALID_FOOTPRINTS.has(policyFootprint) ? policyFootprint : normalizeFootprint(settings);
}

function budgetsForPolicy(behaviorPolicy, footprint) {
  const source = asObject(behaviorPolicy?.footprint?.sectionBudgets);
  const valid = Object.fromEntries(SECTION_KEYS.map((section) => {
    const value = Number(source[section]);
    return [section, Number.isFinite(value) && value > 0 ? Math.round(value) : null];
  }));
  if (SECTION_KEYS.every((section) => Number.isFinite(valid[section]) && valid[section] > 0)) return valid;
  return FOOTPRINT_BUDGETS[footprint] || FOOTPRINT_BUDGETS.normal;
}

function safeEvidenceRef(value) {
  const text = safeOptionalText(value, MAX_EVIDENCE_TEXT);
  if (!text) return null;
  return SAFE_REF_PATTERN.test(text) && !SECRET_TEXT_PATTERN.test(text) ? text : null;
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

function safeOmissionReason(value) {
  const reason = safeOptionalText(value, MAX_OMISSION_REASON);
  if (!reason) return '';
  return SAFE_OMISSION_REASONS.has(reason) ? reason : 'unspecified';
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

function promptCard(card) {
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

function cardEvidenceLine(card) {
  const emphasis = card.emphasis === 'normal' ? '' : ` ${card.emphasis}`;
  return `- [${card.family || 'Card'}${emphasis}] ${card.promptText}`;
}

function buildCardEvidenceSection(cards) {
  const lines = [
    'Private Recursion card evidence for the next assistant message.',
    'Use these cards silently as evidence. Preserve their hard constraints, subtext, and open threads while keeping card labels out of final prose.',
    'Card evidence:'
  ];
  for (const card of cards) {
    lines.push(cardEvidenceLine(card));
  }
  return {
    text: lines.join('\n'),
    sourceIds: cards.map((card) => card.id),
    cards: cards.map((card) => promptCard(card))
  };
}

function buildGuardrailsSection() {
  return {
    text: ['Guardrails:', ...STATIC_GUARDRAILS.map((line) => `- ${line}`)].join('\n'),
    sourceIds: []
  };
}

function snapshotField(snapshot, key) {
  return safeText(asObject(snapshot)[key], 200);
}

function snapshotHash(snapshot) {
  return hashJson(asObject(snapshot));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => safePromptId(value, 'guidance-source'))
    .filter(Boolean))];
}

function cleanStringList(value, limit = MAX_DIAGNOSTIC_TEXT, max = 16) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => safeText(entry, limit))
    .filter(Boolean)
    .slice(0, max);
}

function assertTextSafe(label, text) {
  for (const pattern of DYNAMIC_FORBIDDEN_PATTERNS) {
    if (pattern.test(String(text ?? ''))) {
      throw new Error(`${label} contains disallowed hidden reasoning wording.`);
    }
  }
}

function hiddenReasoningDetected(text) {
  try {
    assertTextSafe('guidance', text);
    return false;
  } catch {
    return true;
  }
}

function filterGuidanceIds(value, allowedIds) {
  if (!Array.isArray(value)) return { ids: [], invalidCount: 0, rawCount: 0 };
  const ids = [];
  let invalidCount = 0;
  for (const entry of value) {
    const id = safePromptId(entry, 'guidance-source');
    if (id && allowedIds.has(id)) ids.push(id);
    else invalidCount += 1;
  }
  return { ids: uniqueStrings(ids), invalidCount, rawCount: value.length };
}

function filterGuidanceOmissions(value, allowedIds) {
  if (!Array.isArray(value)) return { omissions: [], invalidCount: 0 };
  const omissions = [];
  let invalidCount = 0;
  for (const entry of value) {
    const source = asObject(entry);
    const id = safePromptId(source.id ?? source.cardId, 'guidance-omitted');
    const reason = cleanEnum(source.reason, VALID_GUIDANCE_DROP_REASONS, '');
    if (id && allowedIds.has(id) && reason) {
      omissions.push({ id, reason });
    } else {
      invalidCount += 1;
    }
  }
  return { omissions, invalidCount };
}

function normalizePrecomposedGuidance(value, allowedIds) {
  const source = asObject(value);
  const text = safeText(source.text ?? source.guidanceText, MAX_GUIDANCE_TEXT);
  if (!text || hiddenReasoningDetected(text)) {
    return guidanceFallback('fallback-raw-only', 'precomposed_guidance_invalid');
  }
  const sourceIds = filterGuidanceIds(source.sourceCardIds, allowedIds);
  const guardrailIds = filterGuidanceIds(source.guardrailCardIds, allowedIds);
  const omitted = filterGuidanceOmissions(source.omittedCardIds, allowedIds);
  return {
    schema: GUIDANCE_SCHEMA,
    status: VALID_GUIDANCE_STATUSES.has(source.status) ? source.status : 'used',
    text,
    sourceCardIds: sourceIds.ids,
    guardrailCardIds: guardrailIds.ids,
    omittedCardIds: omitted.omissions,
    diagnostics: cleanStringList(source.diagnostics, MAX_DIAGNOSTIC_TEXT, 16),
    invalidSourceIdCount: sourceIds.invalidCount + guardrailIds.invalidCount + omitted.invalidCount,
    fallbackReason: ''
  };
}

function guidanceFallback(status, reason) {
  return {
    schema: GUIDANCE_SCHEMA,
    status,
    text: 'Guidance unavailable; use the raw Recursion card evidence directly.',
    sourceCardIds: [],
    guardrailCardIds: [],
    omittedCardIds: [],
    diagnostics: reason ? [safeText(reason, MAX_DIAGNOSTIC_TEXT)] : [],
    invalidSourceIdCount: 0,
    fallbackReason: safeText(reason || status, MAX_DIAGNOSTIC_TEXT)
  };
}

function fallbackReasonFromGuidanceResult(result, expectedSnapshotHash = '') {
  if (!result) return 'guidance_returned_no_result';
  if (result.ok === false) return safeText(result.error?.code || result.error?.message || 'guidance_failed', MAX_DIAGNOSTIC_TEXT);
  if (result.data?.schema !== GUIDANCE_SCHEMA) return 'guidance_schema_mismatch';
  if (expectedSnapshotHash && String(result.data?.snapshotHash || '') !== expectedSnapshotHash) return 'guidance_snapshot_mismatch';
  if (!safeText(result.data?.guidanceText, MAX_GUIDANCE_TEXT)) return 'guidance_text_missing';
  if (hiddenReasoningDetected(result.data?.guidanceText)) return 'guidance_hidden_reasoning';
  return 'guidance_invalid';
}

function validateGuidanceResult(result, allowedIds, expectedSnapshotHash) {
  if (!result?.ok) return { ok: false, reason: fallbackReasonFromGuidanceResult(result, expectedSnapshotHash) };
  if (result.data?.schema !== GUIDANCE_SCHEMA) return { ok: false, reason: fallbackReasonFromGuidanceResult(result, expectedSnapshotHash) };
  if (expectedSnapshotHash && String(result.data?.snapshotHash || '') !== expectedSnapshotHash) {
    return { ok: false, reason: fallbackReasonFromGuidanceResult(result, expectedSnapshotHash) };
  }
  const text = safeText(result.data?.guidanceText, MAX_GUIDANCE_TEXT);
  if (!text) return { ok: false, reason: fallbackReasonFromGuidanceResult(result, expectedSnapshotHash) };
  if (hiddenReasoningDetected(text)) return { ok: false, reason: fallbackReasonFromGuidanceResult(result, expectedSnapshotHash) };
  const sourceIds = filterGuidanceIds(result.data?.sourceCardIds, allowedIds);
  const guardrailIds = filterGuidanceIds(result.data?.guardrailCardIds, allowedIds);
  const omitted = filterGuidanceOmissions(result.data?.omittedCardIds, allowedIds);
  if (sourceIds.rawCount > 0 && sourceIds.ids.length === 0 && allowedIds.size > 0) {
    return { ok: false, reason: 'guidance_source_ids_invalid' };
  }
  return {
    ok: true,
    schema: GUIDANCE_SCHEMA,
    status: 'used',
    text,
    sourceCardIds: sourceIds.ids,
    guardrailCardIds: guardrailIds.ids,
    omittedCardIds: omitted.omissions,
    diagnostics: cleanStringList(result.data?.diagnostics, MAX_DIAGNOSTIC_TEXT, 16),
    invalidSourceIdCount: sourceIds.invalidCount + guardrailIds.invalidCount + omitted.invalidCount,
    fallbackReason: ''
  };
}

function buildGuidancePrompt({ runId, snapshotHash: sourceSnapshotHash, cards, behaviorPolicy = null, storyForm = UNKNOWN_STORY_FORM }) {
  const normalizedStoryForm = normalizeStoryForm(storyForm);
  return [
    'Write Recursion response guidance for the next story generation.',
    `Return one JSON object only using schema "${GUIDANCE_SCHEMA}".`,
    'Use the selected raw cards as evidence. Preserve their nuance, subtext, hard constraints, and response posture.',
    'Do not summarize the cards as a replacement; raw cards will be injected separately.',
    'Do not invent hidden motives, future plot, unrevealed facts, or out-of-character analysis.',
    'Expected JSON shape: {"schema":"recursion.guidanceComposer.v1","snapshotHash":"same snapshot hash","guidanceText":"provider-authored direction","sourceCardIds":["card-id"],"guardrailCardIds":["card-id"],"omittedCardIds":[{"id":"card-id","reason":"duplicate | lower-priority | unsupported | unsafe"}],"diagnostics":["safe-note"]}.',
    `Run id: ${runId}`,
    `Snapshot hash: ${sourceSnapshotHash}`,
    `Story form: ${JSON.stringify(normalizedStoryForm)}`,
    storyFormInstruction(normalizedStoryForm),
    `Behavior policy:\n${behaviorComposerLines(behaviorPolicy).join('\n')}`,
    `Selected raw cards:\n${JSON.stringify(cards.map((card) => promptCard(card)), null, 2)}`
  ].join('\n\n');
}

function buildReasonerPrompt({ runId, snapshotHash: sourceSnapshotHash, footprint, cards, guidance, behaviorPolicy = null, storyForm = UNKNOWN_STORY_FORM }) {
  const normalizedStoryForm = normalizeStoryForm(storyForm);
  return [
    'Compose optional Recursion guidance synthesis.',
    `Return one JSON object only using schema "${REASONER_SCHEMA}".`,
    'Use only the selected raw card objects and current provider guidance below.',
    'Add direction, not replacement evidence. Raw cards remain injected separately.',
    'Expected JSON shape: {"schema":"recursion.reasonerComposer.v1","snapshotHash":"same snapshot hash","instructionPatch":"concise instruction patch","keptCardIds":["card-id"],"droppedCardIds":[{"id":"card-id","reason":"duplicate | lower-priority | budget-exceeded | unsupported"}]}.',
    `Run id: ${runId}`,
    `Snapshot hash: ${sourceSnapshotHash}`,
    `Footprint: ${footprint}`,
    `Story form: ${JSON.stringify(normalizedStoryForm)}`,
    storyFormInstruction(normalizedStoryForm),
    `Behavior policy:\n${behaviorComposerLines(behaviorPolicy).join('\n')}`,
    `Current guidance:\n${safeText(guidance?.text || '', MAX_GUIDANCE_TEXT)}`,
    `Selected raw cards:\n${JSON.stringify(cards.map((card) => promptCard(card)), null, 2)}`
  ].join('\n\n');
}

function fallbackReasonFromReasonerResult(result, expectedSnapshotHash = '') {
  if (!result) return 'reasoner_returned_no_result';
  if (result.ok === false) return safeText(result.error?.code || result.error?.message || 'reasoner_failed', MAX_DIAGNOSTIC_TEXT);
  if (result.data?.schema !== REASONER_SCHEMA) return 'reasoner_schema_mismatch';
  if (expectedSnapshotHash && String(result.data?.snapshotHash || '') !== expectedSnapshotHash) return 'reasoner_snapshot_mismatch';
  if (!safeText(result.data?.instructionPatch, MAX_GUIDANCE_TEXT)) return 'reasoner_patch_missing';
  if (hiddenReasoningDetected(result.data?.instructionPatch)) return 'reasoner_hidden_reasoning';
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

function filterReasonerDroppedCards(value, allowedIds) {
  if (!Array.isArray(value)) return { ids: [], invalidCount: 0 };
  const ids = [];
  let invalidCount = 0;
  for (const entry of value) {
    const drop = asObject(entry);
    const id = safePromptId(drop.id, 'reasoner-source');
    const reason = cleanEnum(drop.reason, VALID_REASONER_DROP_REASONS, '');
    if (id && allowedIds.has(id) && reason) ids.push(id);
    else invalidCount += 1;
  }
  return { ids: uniqueStrings(ids), invalidCount };
}

function validateReasonerResult(result, allowedIds, expectedSnapshotHash) {
  if (!result?.ok) return { ok: false, reason: fallbackReasonFromReasonerResult(result, expectedSnapshotHash) };
  if (result.data?.schema !== REASONER_SCHEMA) return { ok: false, reason: fallbackReasonFromReasonerResult(result, expectedSnapshotHash) };
  if (expectedSnapshotHash && String(result.data?.snapshotHash || '') !== expectedSnapshotHash) {
    return { ok: false, reason: fallbackReasonFromReasonerResult(result, expectedSnapshotHash) };
  }
  const instructionPatch = safeText(result.data?.instructionPatch, MAX_GUIDANCE_TEXT);
  if (!instructionPatch) return { ok: false, reason: fallbackReasonFromReasonerResult(result, expectedSnapshotHash) };
  if (hiddenReasoningDetected(instructionPatch)) return { ok: false, reason: fallbackReasonFromReasonerResult(result, expectedSnapshotHash) };
  const kept = filterReasonerIds(result.data?.keptCardIds, allowedIds);
  const dropped = filterReasonerDroppedCards(result.data?.droppedCardIds, allowedIds);
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
      // Prompt activity is diagnostic only.
    }
  }
}

export async function composeGuidanceForCards({
  hand = {},
  cards: inputCards = null,
  snapshot = {},
  settings = {},
  behaviorPolicy = null,
  generationRouter = null,
  activity = null,
  onActivity = null,
  runId = makeId('prompt-run'),
  precomposedGuidance = null,
  storyForm = UNKNOWN_STORY_FORM
} = {}) {
  const cards = Array.isArray(inputCards) ? inputCards.map((card, index) => normalizeCard(card, index)).filter((card) => card.promptText) : normalizeCards(hand);
  const sourceSnapshotHash = snapshotHash(snapshot);
  const allowedIds = new Set(cards.map((card) => card.id));
  if (precomposedGuidance) return normalizePrecomposedGuidance(precomposedGuidance, allowedIds);
  if (!generationRouter || typeof generationRouter.generate !== 'function') return guidanceFallback('missing', 'guidance_router_missing');

  const promptRunId = safePromptId(runId, 'prompt-run') || makeId('prompt-run');
  const policy = behaviorPolicyFrom(settings, behaviorPolicy);
  try {
    const prompt = buildGuidancePrompt({
      runId: promptRunId,
      snapshotHash: sourceSnapshotHash,
      cards,
      behaviorPolicy: policy,
      storyForm
    });
    const result = await generationRouter.generate('guidanceComposer', {
      lane: 'utility',
      runId: promptRunId,
      snapshotHash: sourceSnapshotHash,
      prompt
    });
    const validated = validateGuidanceResult(result, allowedIds, sourceSnapshotHash);
    if (!validated.ok) {
      emitActivity(activity || onActivity, {
        runId: promptRunId,
        phase: 'promptGuidanceFallback',
        mode: 'background',
        severity: 'warning',
        providerLane: 'utility',
        composerLane: 'guidance',
        label: 'Guidance composer fell back to raw card evidence.',
        fallbackReason: validated.reason,
        recordedAt: nowIso()
      });
      return guidanceFallback('fallback-raw-only', validated.reason);
    }
    return validated;
  } catch (error) {
    const reason = safeText(error?.code || error?.message || error || 'guidance_exception', MAX_DIAGNOSTIC_TEXT);
    return guidanceFallback('fallback-raw-only', reason);
  }
}

async function applyReasonerGuidance({
  packet,
  cards,
  behaviorPolicy,
  settings,
  generationRouter,
  activity,
  storyForm = UNKNOWN_STORY_FORM
}) {
  const runId = packet.diagnostics.runId;
  const allowedIds = new Set(cards.map((card) => card.id));
  try {
    const prompt = buildReasonerPrompt({
      runId,
      snapshotHash: packet.snapshotHash,
      footprint: packet.footprint,
      cards,
      guidance: packet.guidance,
      behaviorPolicy,
      storyForm
    });
    const result = await generationRouter.generate('reasonerComposer', {
      lane: 'reasoner',
      runId,
      snapshotHash: packet.snapshotHash,
      ...reasoningRequestMetadata(settings, 'final-brief'),
      prompt
    });
    const validated = validateReasonerResult(result, allowedIds, packet.snapshotHash);
    if (!validated.ok) {
      emitActivity(activity, {
        runId,
        phase: 'promptReasonerFallback',
        mode: 'background',
        severity: 'warning',
        providerLane: 'reasoner',
        composerLane: 'guidance',
        label: 'Reasoner composer fell back to guidance packet.',
        fallbackReason: validated.reason,
        recordedAt: nowIso()
      });
      return withSectionHashes({
        ...packet,
        diagnostics: {
          ...packet.diagnostics,
          reasonerStatus: 'fallback',
          fallbackReason: validated.reason
        }
      });
    }
    const reasonerLine = `Reasoner synthesis: ${validated.instructionPatch}`;
    const guidanceText = safeText(`${packet.guidance.text}\n${reasonerLine}`, MAX_GUIDANCE_TEXT);
    const sections = {
      ...packet.sections,
      guidance: buildGuidanceSection({ ...packet.guidance, text: guidanceText }, storyForm)
    };
    const injectionPlan = packet.injectionPlan.map((block) => block.id === 'guidance'
      ? { ...block, sourceIds: uniqueStrings([...(block.sourceIds || []), ...validated.keptCardIds]) }
      : block);
    const reasonerPacket = withSectionHashes({
      ...packet,
      guidance: {
        ...packet.guidance,
        text: guidanceText,
        sourceCardIds: uniqueStrings([...packet.guidance.sourceCardIds, ...validated.keptCardIds]),
        diagnostics: [...packet.guidance.diagnostics, 'reasoner-guidance-used']
      },
      sections,
      injectionPlan,
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
    const reason = safeText(error?.code || error?.message || error || 'reasoner_exception', MAX_DIAGNOSTIC_TEXT);
    return withSectionHashes({
      ...packet,
      diagnostics: {
        ...packet.diagnostics,
        reasonerStatus: 'fallback',
        fallbackReason: reason
      }
    });
  }
}

function buildGuidanceSection(guidance, storyForm = UNKNOWN_STORY_FORM) {
  const text = safeText(guidance?.text, MAX_GUIDANCE_TEXT);
  return [
    'Private Recursion guidance for the next assistant message.',
    storyFormInstruction(storyForm),
    'Guidance:',
    text || 'Guidance unavailable; use the raw Recursion card evidence directly.'
  ].join('\n');
}

function buildInjectionPlan(sectionSources, budgets, injectionSettings = {}) {
  const injection = normalizeInjectionSettings(injectionSettings);
  return INJECTION_TEMPLATE.map((block) => ({
    ...block,
    placement: injection.placement,
    depth: injection.depth,
    role: injection.role,
    section: block.id,
    sourceIds: [...(sectionSources?.[block.id] || [])],
    maxChars: Math.min(MAX_PACKET_SECTION, budgets[block.id] || MAX_PACKET_SECTION)
  }));
}

function baseDiagnostics({
  runId,
  snapshotHash: sourceSnapshotHash,
  footprint,
  budgets,
  cards,
  omissions,
  behaviorPolicy = null,
  guidance,
  storyForm = UNKNOWN_STORY_FORM,
  pipelineMode = 'standard',
  rapidPath = '',
  planDiagnostics = []
}) {
  const normalizedStoryForm = normalizeStoryForm(storyForm);
  return {
    runId,
    composerLane: guidance?.status === 'used' ? 'guidance' : 'utility',
    reasonerStatus: 'skipped',
    guidanceStatus: guidance?.status || 'missing',
    guidanceFallbackReason: guidance?.fallbackReason || '',
    guidanceInvalidSourceIdCount: Number(guidance?.invalidSourceIdCount || 0),
    guidanceSourceCardIds: [...(guidance?.sourceCardIds || [])],
    guidanceGuardrailCardIds: [...(guidance?.guardrailCardIds || [])],
    guidanceOmittedCardIds: [...(guidance?.omittedCardIds || [])],
    guidanceDiagnostics: [...(guidance?.diagnostics || [])],
    snapshotHash: sourceSnapshotHash,
    sectionBudgets: { ...budgets },
    selectedCardCount: cards.length,
    omissionCount: omissions.length,
    selectedTokenEstimate: cards.reduce((sum, card) => sum + card.tokenEstimate, 0),
    sectionHashes: null,
    footprint,
    pipelineMode,
    rapidPath,
    planDiagnostics: uniqueStrings(planDiagnostics).slice(0, 24),
    storyFormTense: normalizedStoryForm.tense,
    storyFormPov: normalizedStoryForm.pov,
    storyFormConfidence: normalizedStoryForm.confidence,
    behaviorPolicy: summarizeBehaviorPolicyForDiagnostics(behaviorPolicy, {
      effectiveFootprint: footprint,
      selectedFamilies: cards.map((card) => card.family)
    })
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
  guidance,
  sections,
  sectionSources,
  injectionSettings,
  behaviorPolicy,
  diagnostics,
  planDiagnostics,
  composedAt,
  storyForm = UNKNOWN_STORY_FORM,
  pipelineMode = 'standard',
  rapidPath = ''
}) {
  const sourceSnapshotHash = snapshotHash(snapshot);
  const normalizedStoryForm = normalizeStoryForm(storyForm);
  return withSectionHashes({
    packetId,
    packetVersion: PACKET_VERSION,
    packetKind: 'recursion.cardPacket.v1',
    snapshotHash: sourceSnapshotHash,
    chatId: snapshotField(snapshot, 'chatId'),
    sceneFingerprint: snapshotField(snapshot, 'sceneFingerprint'),
    turnFingerprint: snapshotField(snapshot, 'turnFingerprint'),
    footprint,
    pipelineMode,
    storyForm: normalizedStoryForm,
    guidance: {
      schema: GUIDANCE_SCHEMA,
      status: guidance.status,
      text: guidance.text,
      sourceCardIds: [...guidance.sourceCardIds],
      guardrailCardIds: [...guidance.guardrailCardIds],
      omittedCardIds: [...guidance.omittedCardIds],
      diagnostics: [...guidance.diagnostics]
    },
    cardEvidence: cards.map((card) => promptCard(card)),
    packetGuardrails: {
      staticText: STATIC_GUARDRAILS.join(' '),
      sourceCardIds: [...guidance.guardrailCardIds]
    },
    sections,
    selectedCardRefs: cards.map((card) => selectedCardRef(card)),
    omissions,
    injectionPlan: buildInjectionPlan(sectionSources, budgets, injectionSettings),
    diagnostics: diagnostics || baseDiagnostics({
      runId,
      snapshotHash: sourceSnapshotHash,
      footprint,
      budgets,
      cards,
      omissions,
      behaviorPolicy,
      guidance,
      storyForm: normalizedStoryForm,
      pipelineMode,
      rapidPath,
      planDiagnostics
    }),
    composedAt
  });
}

export async function composePromptPacket({
  hand = {},
  snapshot = {},
  settings = {},
  behaviorPolicy = null,
  generationRouter = null,
  activity = null,
  onActivity = null,
  runId = makeId('prompt-run'),
  precomposedGuidance = null,
  storyForm = UNKNOWN_STORY_FORM,
  pipelineMode = 'standard',
  rapidPath = '',
  planDiagnostics = []
} = {}) {
  const policy = behaviorPolicyFrom(settings, behaviorPolicy);
  const normalizedStoryForm = normalizeStoryForm(storyForm);
  const footprint = footprintForPolicy(settings, policy);
  const budgets = budgetsForPolicy(policy, footprint);
  const injectionSettings = normalizeInjectionSettings(settings?.injection);
  const cards = normalizeCards(hand);
  const promptRunId = safePromptId(runId, 'prompt-run') || makeId('prompt-run');
  const omissions = normalizeOmissions(hand);
  const packetId = makeId('prompt-packet');
  const composedAt = nowIso();

  const evidence = buildCardEvidenceSection(cards);
  const guardrails = buildGuardrailsSection();
  const guidance = await composeGuidanceForCards({
    hand,
    cards,
    snapshot,
    settings,
    behaviorPolicy: policy,
    generationRouter,
    activity,
    onActivity,
    runId: promptRunId,
    precomposedGuidance,
    storyForm: normalizedStoryForm
  });

  const sections = {
    guidance: buildGuidanceSection(guidance, normalizedStoryForm),
    cardEvidence: evidence.text,
    guardrails: guardrails.text
  };
  const sectionSources = {
    guidance: guidance.sourceCardIds,
    cardEvidence: evidence.sourceIds,
    guardrails: uniqueStrings([...guardrails.sourceIds, ...guidance.guardrailCardIds])
  };
  let packet = buildPacket({
    packetId,
    runId: promptRunId,
    snapshot,
    footprint,
    budgets,
    cards,
    omissions,
    guidance,
    sections,
    sectionSources,
    injectionSettings,
    behaviorPolicy: policy,
    planDiagnostics,
    composedAt,
    storyForm: normalizedStoryForm,
    pipelineMode,
    rapidPath
  });

  validatePromptPacket(packet);
  if (shouldUseReasoner(settings, footprint, generationRouter)) {
    packet = await applyReasonerGuidance({
      packet,
      cards,
      behaviorPolicy: policy,
      settings,
      generationRouter,
      activity: activity || onActivity,
      storyForm: normalizedStoryForm
    });
  }
  validatePromptPacket(packet);
  return packet;
}

function assertRequiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
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
    if (!VALID_INJECTION_PLACEMENTS.has(block.placement)) throw new Error('injectionPlan.placement is invalid.');
    if (!VALID_INJECTION_ROLES.has(block.role)) throw new Error('injectionPlan.role is invalid.');
    if (Array.isArray(block.depth) || typeof block.depth === 'boolean' || typeof block.depth === 'object') {
      throw new Error('injectionPlan.depth is invalid.');
    }
    const depth = Number(block.depth);
    if (!Number.isInteger(depth) || depth < 0 || depth > 10) throw new Error('injectionPlan.depth is invalid.');
    const maxChars = Number(block.maxChars);
    if (!Number.isInteger(maxChars) || maxChars < 0 || maxChars > MAX_PACKET_SECTION) throw new Error('injectionPlan.maxChars is invalid.');
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

export function validatePromptPacket(packet) {
  const source = asObject(packet);
  assertRequiredString(source.packetId, 'packetId');
  if (source.packetVersion !== PACKET_VERSION) throw new Error('packetVersion is invalid.');
  assertRequiredString(source.snapshotHash, 'snapshotHash');
  assertRequiredString(source.chatId, 'chatId');
  assertRequiredString(source.sceneFingerprint, 'sceneFingerprint');
  assertRequiredString(source.turnFingerprint, 'turnFingerprint');
  if (!VALID_FOOTPRINTS.has(source.footprint)) throw new Error('footprint is invalid.');
  assertRequiredString(source.composedAt, 'composedAt');

  const sections = asObject(source.sections);
  for (const section of SECTION_KEYS) {
    assertRequiredString(sections[section], `sections.${section}`);
    assertTextSafe(`Prompt packet ${section}`, sections[section]);
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
  assertRequiredString(source.diagnostics.guidanceStatus, 'diagnostics.guidanceStatus');
  if (!VALID_GUIDANCE_STATUSES.has(source.diagnostics.guidanceStatus)) throw new Error('diagnostics.guidanceStatus is invalid.');
  return source;
}

export function packetToPromptBlocks(packet) {
  const source = validatePromptPacket(packet);
  const budgets = asObject(source.diagnostics?.sectionBudgets);
  return source.injectionPlan.map((plan) => {
    const rawText = String(source.sections[plan.id] ?? '');
    const maxChars = numberInRange(plan.maxChars ?? budgets[plan.id], rawText.length, 0, MAX_PACKET_SECTION);
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
