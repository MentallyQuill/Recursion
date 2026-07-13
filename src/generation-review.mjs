import { compact, hashJson, truncate } from './core.mjs';
import { BANNED_AI_SLOP_LIST, dialogueSpans } from './prose-enhancement.mjs';

export const GENERATION_REVIEW_SCHEMA = 'recursion.generationReview.v1';
export const ANTI_SLOP_PROFILE_VERSION = 'v1';

const MAX_SOURCE_TEXT = 12000;
const MAX_CONTEXT_TEXT = 12000;
const PATCH_DOMAINS = new Set(['dialogue', 'narrative-execution', 'anti-slop', 'card-fidelity']);
const CARD_OUTCOME_STATUSES = new Set([
  'honored',
  'repaired',
  'not-applicable',
  'partially-reflected',
  'violated',
  'requires-regeneration'
]);
const CARD_OUTCOME_ALIASES = new Map([
  ['not_applicable', 'not-applicable'],
  ['partially_reflected', 'partially-reflected'],
  ['requires_regeneration', 'requires-regeneration'],
  ['partially reflected', 'partially-reflected']
]);
const SECRET_PATTERN = /(raw[-_\s]*prompt|rawPrompt|provider[-_\s]*response|hidden[-_\s]*reasoning|api[-_\s]*key|authorization\s*[:=]\s*(?:bearer\s+)?[a-z0-9._~+/=-]+|bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]+)/ig;

function safeText(value, limit = MAX_CONTEXT_TEXT) {
  return truncate(compact(String(value ?? '').replace(SECRET_PATTERN, '[redacted]')), limit);
}

function target(id, domain, source, start, end) {
  const before = source.slice(start, end);
  return { id, domain, start, end, before };
}

function trimmedRange(source, start, end) {
  let left = start;
  let right = end;
  while (left < right && /\s/.test(source[left])) left += 1;
  while (right > left && /\s/.test(source[right - 1])) right -= 1;
  return left < right ? { start: left, end: right } : null;
}

function narrationRanges(source = '', dialogue = []) {
  const ranges = [];
  let cursor = 0;
  for (const span of [...dialogue].sort((left, right) => left.start - right.start)) {
    const range = trimmedRange(source, cursor, span.start);
    if (range) ranges.push(range);
    cursor = span.end;
  }
  const tail = trimmedRange(source, cursor, source.length);
  if (tail) ranges.push(tail);
  return ranges;
}

function sentenceRanges(source, ranges) {
  const result = [];
  for (const range of ranges) {
    const fragment = source.slice(range.start, range.end);
    const matcher = /[^.!?\n]+(?:[.!?]+(?:["')\]]+)?|$)/g;
    let match;
    while ((match = matcher.exec(fragment))) {
      const sentence = trimmedRange(source, range.start + match.index, range.start + match.index + match[0].length);
      if (sentence) result.push(sentence);
      if (match[0] === '') break;
    }
  }
  return result;
}

function beatRanges(source = '') {
  const result = [];
  const matcher = /(?:^|\n\s*\n)([\s\S]*?)(?=\n\s*\n|$)/g;
  let match;
  while ((match = matcher.exec(source))) {
    const start = match.index + match[0].indexOf(match[1]);
    const range = trimmedRange(source, start, start + match[1].length);
    if (range) result.push(range);
    if (match[0] === '') break;
  }
  return result;
}

export function buildGenerationReviewTargets(text = '') {
  const source = String(text ?? '');
  const dialogue = dialogueSpans(source);
  const narration = narrationRanges(source, dialogue);
  return {
    dialogue: dialogue.map((span, index) => target(`dialogue:${index + 1}`, 'dialogue', source, span.start, span.end)),
    prose: sentenceRanges(source, narration).map((span, index) => target(`prose:${index + 1}`, 'narrative-execution', source, span.start, span.end)),
    beats: beatRanges(source).map((span, index) => target(`beat:${index + 1}`, 'narrative-execution', source, span.start, span.end))
  };
}

export function eligibleGenerationReviewTargets(targets = {}) {
  return [
    ...(Array.isArray(targets?.dialogue) ? targets.dialogue : []),
    ...(Array.isArray(targets?.prose) ? targets.prose : [])
  ];
}

function publicInstalledHand(value = []) {
  return (Array.isArray(value) ? value : []).slice(0, 48).map((card) => ({
    cardId: safeText(card?.cardId || card?.id || '', 160),
    categoryId: safeText(card?.categoryId || '', 160),
    name: safeText(card?.name || '', 120),
    description: safeText(card?.description || '', 600),
    promptText: safeText(card?.promptText || '', 1200),
    kind: safeText(card?.kind || '', 40),
    selectionState: safeText(card?.selectionState || '', 40),
    packetRefs: (Array.isArray(card?.packetRefs) ? card.packetRefs : []).map((entry) => safeText(entry, 120)).filter(Boolean).slice(0, 16),
    sourceCardIds: (Array.isArray(card?.sourceCardIds) ? card.sourceCardIds : []).map((entry) => safeText(entry, 160)).filter(Boolean).slice(0, 32)
  })).filter((card) => card.cardId && card.promptText);
}

export function publicGenerationReviewSnapshot(snapshot = {}) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    deck: {
      id: safeText(source?.deck?.id || '', 160),
      name: safeText(source?.deck?.name || '', 160),
      revisionHash: safeText(source?.deck?.revisionHash || '', 180)
    },
    installedHand: publicInstalledHand(source.installedHand),
    promptPacket: safeText(JSON.stringify(source.promptPacket || {}), 6000),
    lastBrief: safeText(JSON.stringify(source.lastBrief || {}), 1800),
    storyForm: safeText(JSON.stringify(source.storyForm || {}), 600),
    pipeline: safeText(source.pipeline || '', 32),
    context: safeText(JSON.stringify(source.context || {}), 6000),
    antiSlopProfileVersion: safeText(source.antiSlopProfileVersion || ANTI_SLOP_PROFILE_VERSION, 80)
  };
}

export function generationReviewSnapshotHash(snapshot = {}) {
  return hashJson(publicGenerationReviewSnapshot(snapshot));
}

export function generationReviewKey({ chatKey = '', messageId = '', swipeId = '', sourceHash = '', snapshotHash = '' } = {}) {
  return [chatKey, messageId, swipeId, sourceHash, snapshotHash].map((value) => String(value ?? '')).join('::');
}

export function normalizeCardOutcomeStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  return CARD_OUTCOME_ALIASES.get(raw) || raw;
}

export function buildGenerationReviewRequest({
  sourceText = '',
  sourceHash = '',
  targets = {},
  reviewSnapshot = {},
  contextContract = null,
  retry = null,
  lane = '',
  reasoningCategory = 'generation-review',
  reasoningIntent = 'minimal'
} = {}) {
  const source = truncate(String(sourceText ?? '').replace(SECRET_PATTERN, '[redacted]'), MAX_SOURCE_TEXT);
  const snapshot = publicGenerationReviewSnapshot(reviewSnapshot);
  const targetList = eligibleGenerationReviewTargets(targets).map(({ id, domain, before }) => ({ id, domain, before })).slice(0, 120);
  const retryTargetIds = Array.isArray(retry?.targetIds) ? retry.targetIds.map(String).filter(Boolean).slice(0, 120) : [];
  const retryCardIds = Array.isArray(retry?.cardIds) ? retry.cardIds.map(String).filter(Boolean).slice(0, 120) : [];
  const installedCardIds = snapshot.installedHand.map((card) => card.cardId).filter(Boolean);
  const cardOutcomeSkeleton = installedCardIds.map((cardId) => ({
    cardId,
    status: 'honored',
    evidenceTargetIds: []
  }));
  const prompt = [
    'Return a Recursion Generation Review and Enhancement result as strict JSON.',
    'Review the completed assistant response against its frozen generation context.',
    'Return replacements only for listed target IDs. Never return a full rewritten message. Target IDs are authoritative; copy their before text exactly when supplied.',
    'Assess turn fulfillment, installed card and scene fidelity, narrative execution, and anti-slop.',
    'Only installed cards are review obligations. Do not force every card into visible prose.',
    'Return exactly one cardOutcomes object for every installed card in the frozen review snapshot. cardId values must match exactly.',
    `Allowed card outcome statuses: ${[...CARD_OUTCOME_STATUSES].join(', ')}.`,
    'Use dialogue, prose, or beat targets only when the change is locally supported by the frozen context.',
    'Do not invent facts, resolve pressure, add a new outcome, or force inactive or irrelevant cards into the response.',
    'Anti-slop is contextual: remove canned interaction traps and repeated generic shorthand, but preserve card-, character-, or genre-supported language.',
    'Do not replace one cliche with a neighboring cliche.',
    'If a material defect cannot be repaired within a bounded target, report requires-regeneration. Otherwise return at least one valid patch.',
    retryTargetIds.length ? `Mandatory retry: return a valid patch using one of these target IDs: ${retryTargetIds.join(', ')}.` : '',
    retryCardIds.length ? `Mandatory retry: correct the status for these card IDs: ${retryCardIds.join(', ')}. Still return the complete cardOutcomes array for every installed card.` : '',
    `<source_hash>${safeText(sourceHash, 180)}</source_hash>`,
    `<review_snapshot>${JSON.stringify(snapshot)}</review_snapshot>`,
    `<targets>${JSON.stringify(targetList)}</targets>`,
    `<card_outcomes_template>${JSON.stringify(cardOutcomeSkeleton)}</card_outcomes_template>`,
    `<anti_slop_profile>${BANNED_AI_SLOP_LIST}</anti_slop_profile>`,
    contextContract ? `<context_contract>${safeText(JSON.stringify(contextContract), 1800)}</context_contract>` : '',
    `<source>${source}</source>`,
    `Return {"schema":"${GENERATION_REVIEW_SCHEMA}","sourceHash":"${safeText(sourceHash, 180)}","assessment":{},"reviewDomains":{},"cardOutcomes":${JSON.stringify(cardOutcomeSkeleton)},"patches":[]}.`
  ].filter(Boolean).join('\n');
  return {
    prompt,
    systemPrompt: 'Return only one valid Recursion Generation Review JSON object. Do not emit prose, markdown, reasoning, or an alternate schema.',
    responseSchema: GENERATION_REVIEW_SCHEMA,
    responseLength: 3200,
    machineJson: true,
    ...(lane ? { lane } : {}),
    reasoningCategory,
    reasoningIntent,
    reviewSnapshot: snapshot,
    ...(contextContract ? { contextContract } : {})
  };
}

function fail(code, message, details = {}) {
  return { ok: false, error: { code, message }, ...details };
}

function hasRequiresRegeneration(result = {}) {
  const domainValues = Object.values(result?.reviewDomains || {});
  const cardOutcomes = Array.isArray(result?.cardOutcomes) ? result.cardOutcomes : [];
  const assessmentValues = Object.values(result?.assessment || {});
  return domainValues.includes('requires-regeneration')
    || cardOutcomes.some((outcome) => outcome?.status === 'requires-regeneration')
    || assessmentValues.some((entry) => entry?.status === 'requires-regeneration');
}

export function validateGenerationReviewResult(result = {}, { sourceHash = '', targets = {}, reviewSnapshot = {} } = {}) {
  const data = result && typeof result === 'object' ? result : {};
  if (data.schema !== GENERATION_REVIEW_SCHEMA) {
    return fail('RECURSION_GENERATION_REVIEW_SCHEMA_MISMATCH', 'Generation review returned the wrong schema.');
  }
  if (String(data.sourceHash || '') !== String(sourceHash || '')) {
    return fail('RECURSION_GENERATION_REVIEW_STALE_SOURCE', 'Generation review was produced for a different source response.');
  }
  const targetById = new Map(eligibleGenerationReviewTargets(targets).map((entry) => [entry.id, entry]));
  const installedCardIds = new Set(publicInstalledHand(reviewSnapshot.installedHand).map((card) => card.cardId));
  const patches = Array.isArray(data.patches) ? data.patches : [];
  const targetEntries = [...targetById.values()];
  const retryTargetIds = targetEntries.map((entry) => entry.id);
  const resolvedPatches = [];
  const seen = new Set();
  for (const patch of patches) {
    const before = String(patch?.before ?? '');
    const declaredDomain = String(patch?.domain || '');
    const exactCandidates = targetEntries.filter((candidate) => candidate.before === before && (candidate.domain === declaredDomain || PATCH_DOMAINS.has(declaredDomain)));
    const rawId = String(patch?.id || '');
    const normalizedId = rawId.replace(/[\s_-]+/g, ':').replace(/:+/g, ':');
    const entry = targetById.get(rawId)
      || targetById.get(normalizedId)
      || (exactCandidates.length === 1 ? exactCandidates[0] : null);
    const domain = PATCH_DOMAINS.has(declaredDomain) ? declaredDomain : entry?.domain;
    if (!entry || seen.has(entry.id) || !PATCH_DOMAINS.has(domain)) {
      return fail('RECURSION_GENERATION_REVIEW_TARGET_INVALID', 'Generation review used an unknown or duplicate patch target.', {
        retryable: true,
        invalidTargetIds: retryTargetIds,
        safePatches: resolvedPatches
      });
    }
    // The target ID selects the immutable source range. Models often normalize the echoed
    // `before` text; it must not invalidate an otherwise bounded replacement.
    if (!String(patch.after ?? '').trim() || String(patch.after) === entry.before) {
      return fail('RECURSION_GENERATION_REVIEW_PATCH_INVALID', 'Generation review returned an invalid patch replacement.', {
        retryable: true,
        invalidTargetIds: [entry.id],
        safePatches: resolvedPatches
      });
    }
    for (const cardId of Array.isArray(patch?.cardRefs) ? patch.cardRefs : []) {
      if (!installedCardIds.has(String(cardId))) {
        return fail('RECURSION_GENERATION_REVIEW_CARD_NOT_INSTALLED', 'Generation review referenced a card that was not installed for this response.', {
          retryable: true,
          invalidTargetIds: [entry.id],
          safePatches: resolvedPatches
        });
      }
    }
    seen.add(entry.id);
    resolvedPatches.push({ ...patch, id: entry.id, domain, before: entry.before });
  }
  const patchTargets = resolvedPatches.map((patch) => targetById.get(String(patch.id))).sort((left, right) => left.start - right.start);
  for (let index = 1; index < patchTargets.length; index += 1) {
    if (patchTargets[index].start < patchTargets[index - 1].end) {
      return fail('RECURSION_GENERATION_REVIEW_PATCH_OVERLAP', 'Generation review returned overlapping patches.', {
        retryable: true,
        invalidTargetIds: [patchTargets[index - 1].id, patchTargets[index].id],
        safePatches: []
      });
    }
  }
  const cardOutcomes = Array.isArray(data.cardOutcomes) ? data.cardOutcomes : [];
  const reportedCardIds = new Set();
  const normalizedOutcomes = [];
  for (const outcome of cardOutcomes) {
    const cardId = String(outcome?.cardId || '');
    if (!installedCardIds.has(cardId)) {
      return fail('RECURSION_GENERATION_REVIEW_CARD_NOT_INSTALLED', 'Generation review reported a card that was not installed for this response.');
    }
    if (reportedCardIds.has(cardId)) {
      return fail('RECURSION_GENERATION_REVIEW_CARD_OUTCOME_DUPLICATE', 'Generation review reported an installed card more than once.', {
        retryable: true,
        invalidCardIds: [cardId],
        safePatches: resolvedPatches
      });
    }
    reportedCardIds.add(cardId);
    const status = normalizeCardOutcomeStatus(outcome?.status);
    if (!CARD_OUTCOME_STATUSES.has(status)) {
      return fail('RECURSION_GENERATION_REVIEW_CARD_OUTCOME_INVALID', 'Generation review returned an unknown card outcome.', {
        retryable: true,
        invalidCardIds: [cardId],
        safePatches: resolvedPatches
      });
    }
    for (const targetId of Array.isArray(outcome?.evidenceTargetIds) ? outcome.evidenceTargetIds : []) {
      if (!targetById.has(String(targetId))) {
        return fail('RECURSION_GENERATION_REVIEW_CARD_EVIDENCE_INVALID', 'Generation review cited an unknown card evidence target.', {
          retryable: true,
          invalidCardIds: [cardId],
          safePatches: resolvedPatches
        });
      }
    }
    normalizedOutcomes.push({
      ...outcome,
      cardId,
      status,
      evidenceTargetIds: (Array.isArray(outcome?.evidenceTargetIds) ? outcome.evidenceTargetIds : []).map(String)
    });
  }
  const missingCardIds = [...installedCardIds].filter((cardId) => !reportedCardIds.has(cardId));
  if (missingCardIds.length) {
    return fail('RECURSION_GENERATION_REVIEW_CARD_COVERAGE_MISSING', 'Generation review did not report every installed card.', {
      retryable: true,
      missingCardIds,
      safePatches: resolvedPatches
    });
  }
  const requiresRegeneration = hasRequiresRegeneration(data);
  if (patches.length === 0 && !requiresRegeneration) {
    return fail('RECURSION_GENERATION_REVIEW_NO_PATCH', 'Generation review returned no bounded revision.', { retryable: true });
  }
  return {
    ok: true,
    patches: resolvedPatches.map((patch) => ({
      id: String(patch.id),
      domain: String(patch.domain),
      before: String(patch.before),
      after: String(patch.after),
      reason: safeText(patch.reason || '', 600),
      cardRefs: (Array.isArray(patch.cardRefs) ? patch.cardRefs : []).map(String)
    })),
    assessment: data.assessment && typeof data.assessment === 'object' ? data.assessment : {},
    reviewDomains: data.reviewDomains && typeof data.reviewDomains === 'object' ? data.reviewDomains : {},
    cardOutcomes: normalizedOutcomes,
    requiresRegeneration
  };
}

export function applyGenerationReviewPatches(sourceText = '', patches = [], targets = {}) {
  const source = String(sourceText ?? '');
  const targetById = new Map(eligibleGenerationReviewTargets(targets).map((entry) => [entry.id, entry]));
  return [...(Array.isArray(patches) ? patches : [])]
    .sort((left, right) => targetById.get(right.id).start - targetById.get(left.id).start)
    .reduce((text, patch) => {
      const entry = targetById.get(patch.id);
      return `${text.slice(0, entry.start)}${patch.after}${text.slice(entry.end)}`;
    }, source);
}
