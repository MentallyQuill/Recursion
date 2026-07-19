import { compact, hashJson, truncate } from './core.mjs';
import { eligibleGenerationReviewTargets } from './generation-review.mjs';

export const EDITORIAL_DIAGNOSIS_SCHEMA = 'recursion.editorialDiagnosis.v1';
export const EDITORIAL_PASS_SCHEMA = 'recursion.editorialPass.v1';
export const EDITORIAL_VERIFICATION_SCHEMA = 'recursion.editorialVerification.v1';
export const EDITORIAL_EFFECTIVENESS_SCHEMA = 'recursion.redirectEffectivenessJudge.v1';
export const EDITORIAL_EVIDENCE_VERSION = 'v1';
export const REDIRECT_FAILURE_CATEGORIES = Object.freeze([
  'turn-fulfillment',
  'core-direction',
  'hard-constraint',
  'unsupported-outcome',
  'temporal-causal',
  'character-epistemic'
]);
export const REDIRECT_VERIFICATION_CHECKS = Object.freeze([
  'diagnosis-evidence-grounded',
  'source-failure-removed',
  'replacement-objective-fulfilled',
  'required-beats-satisfied',
  'forbidden-source-beats-excluded',
  'character-pressure-coherent',
  'hard-constraints-preserved',
  'user-turn-answered',
  'unsupported-facts-absent'
]);
export const REDIRECT_EFFECTIVENESS_CRITERIA = Object.freeze([
  'replacement-objective',
  'forbidden-source-beats',
  'character-pressure',
  'evidence-and-constraints'
]);
export const REDIRECT_ERROR_CODES = Object.freeze({
  LAYOUT_INVALID: 'RECURSION_EDITORIAL_REDIRECT_LAYOUT_INVALID',
  BRIEF_INVALID: 'RECURSION_EDITORIAL_REDIRECT_BRIEF_INVALID',
  EVIDENCE_INVALID: 'RECURSION_EDITORIAL_REDIRECT_EVIDENCE_INVALID',
  CHARACTER_COVERAGE_INVALID: 'RECURSION_EDITORIAL_REDIRECT_CHARACTER_COVERAGE_INVALID',
  PRESSURE_INVALID: 'RECURSION_EDITORIAL_REDIRECT_PRESSURE_INVALID',
  CHANGE_MISSING: 'RECURSION_EDITORIAL_REDIRECT_MISSING',
  VERIFICATION_CHECKS_INVALID: 'RECURSION_EDITORIAL_REDIRECT_VERIFICATION_CHECKS_INVALID',
  VERIFICATION_ACCEPT_INVALID: 'RECURSION_EDITORIAL_REDIRECT_VERIFICATION_ACCEPT_INVALID',
  VERIFICATION_REJECTED: 'RECURSION_EDITORIAL_VERIFICATION_REJECTED'
});

const MODES = new Set(['repair', 'recompose', 'redirect']);
const REDIRECT_PROVIDER_FIELDS = Object.freeze([
  'sourceFailure',
  'replacementObjective',
  'requiredBeats',
  'forbiddenSourceBeats',
  'sceneCharacters',
  'characterPressure'
]);
const FULL_MODES = new Set(['recompose', 'redirect']);
const DIAGNOSIS_DECISIONS = Object.freeze({
  repair: new Set(['proceed', 'no-change', 'requires-recompose', 'requires-redirect']),
  recompose: new Set(['proceed', 'no-change', 'requires-redirect']),
  redirect: new Set(['proceed'])
});
const CARD_STATUSES = new Set(['honored', 'repaired', 'not-applicable', 'partially-reflected', 'violated']);
const RISK_FLAGS = new Set(['none', 'continuity-risk', 'voice-risk', 'card-interpretation-risk']);
const CHANGE_KINDS = new Set(['remove', 'rewrite', 'reorder', 'add-supported-detail', 'redirect']);
const DOMAINS = new Set(['dialogue', 'narrative-execution', 'anti-slop', 'card-fidelity']);
const SECRET_PATTERN = /(raw[-_\s]*prompt|rawPrompt|provider[-_\s]*response|hidden[-_\s]*reasoning|api[-_\s]*key|authorization\s*[:=]\s*(?:bearer\s+)?[a-z0-9._~+/=-]+|bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]+)/ig;
const MAX_SOURCE = 12000;
const MAX_EVIDENCE = 120;
const MAX_EXCERPT = 600;
const MAX_TOTAL_EVIDENCE = 12000;
const MAX_CANDIDATE = 16000;
const MAX_CLAIM = 280;

function safeText(value, limit = MAX_CLAIM) {
  return truncate(compact(String(value ?? '').replace(SECRET_PATTERN, '[redacted]')), limit);
}

function preservedText(value, limit = MAX_SOURCE) {
  return truncate(String(value ?? '').replace(SECRET_PATTERN, '[redacted]'), limit);
}

function leadingPresentationEnvelope(value) {
  const source = String(value ?? '');
  const match = source.match(/^([^\r\n]+)\r?\n\r?\n/);
  if (!match) return null;
  const line = match[1];
  if (!/^\*[^*\r\n]+\*$/.test(line) && !/^_[^_\r\n]+_$/.test(line)) return null;
  return { leadingLine: line, boundary: 'blank-line' };
}

function preservesPresentationEnvelope(sourceText, candidateText) {
  const envelope = leadingPresentationEnvelope(sourceText);
  if (!envelope) return true;
  const candidate = String(candidateText ?? '');
  return candidate.startsWith(`${envelope.leadingLine}\n\n`)
    || candidate.startsWith(`${envelope.leadingLine}\r\n\r\n`);
}

function fail(code, message, details = {}) {
  return { ok: false, error: { code, message }, ...details };
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseObject(value) {
  if (typeof value !== 'string') return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function sourceSentences(source = '') {
  return String(source).split(/(?<=[.!?])\s+|\n+/).map((text) => text.trim()).filter(Boolean);
}

function addEvidence(entries, id, kind, authority, excerpt) {
  const clean = safeText(excerpt, MAX_EXCERPT);
  if (!clean || entries.some((entry) => entry.id === id)) return;
  entries.push({ id, kind, authority, excerpt: clean });
}

export function buildEditorialEvidence(snapshot = {}, sourceText = '') {
  const source = String(sourceText ?? '');
  const data = object(snapshot);
  const entries = [];
  const brief = parseObject(data.lastBrief);
  const packet = parseObject(data.promptPacket);
  const storyForm = parseObject(data.storyForm);
  const context = parseObject(data.context);
  const contextMessages = array(context.messages);
  const latestUserMessage = [...contextMessages].reverse().find((message) => message?.role === 'user');
  const messageText = (message) => message?.text ?? message?.mes ?? message?.content ?? '';
  const normalizedSource = compact(source).replace(/\s+/g, ' ');
  const isActiveAssistantDraft = (message) => (
    message?.role === 'assistant'
    && (() => {
      const normalizedMessage = compact(messageText(message)).replace(/\s+/g, ' ');
      if (!normalizedMessage) return false;
      if (normalizedMessage === normalizedSource) return true;
      return normalizedMessage.length >= 200
        && (normalizedSource.startsWith(normalizedMessage) || normalizedMessage.startsWith(normalizedSource));
    })()
  );
  const authoritativeContextMessages = contextMessages.filter((message) => !isActiveAssistantDraft(message));
  const userTurn = brief.userTurn || brief.userMessage || messageText(latestUserMessage);
  addEvidence(entries, 'user:0', 'user-turn', 'continuity-fact', userTurn || 'No explicit user turn supplied.');
  for (const message of authoritativeContextMessages) {
    const messageId = String(message?.mesid ?? message?.messageId ?? message?.id ?? '').trim();
    if (!/^\d+$/.test(messageId)) continue;
    addEvidence(entries, `message:${messageId}`, 'context', 'continuity-fact', messageText(message));
  }
  for (const [index, constraint] of array(packet.constraints || packet.hardConstraints).entries()) {
    addEvidence(entries, `packet:constraint${index ? `:${index}` : ''}`, 'prompt-packet', 'hard-constraint', constraint);
  }
  if (packet.story || packet.scene || packet.summary) addEvidence(entries, 'packet:scene', 'prompt-packet', 'scene-support', packet.story || packet.scene || packet.summary);
  const packetCards = array(packet.cardEvidence);
  const packetCardsById = new Map(packetCards.map((card) => [String(card?.id || ''), card]));
  const installedCards = array(data.installedHand);
  const evidenceCards = installedCards.length ? installedCards : packetCards;
  for (const card of evidenceCards) {
    const cardId = String(card?.cardId || card?.id || '').trim();
    if (!cardId) continue;
    const generated = array(card?.packetRefs)
      .map((packetRef) => packetCardsById.get(String(packetRef)))
      .find(Boolean);
    addEvidence(
      entries,
      `card:${cardId}`,
      'installed-card',
      card?.hardConstraint ? 'hard-constraint' : 'scene-support',
      generated?.promptText || card.promptText || card.description || card.name
    );
  }
  if (brief.userTurn || brief.userMessage) addEvidence(entries, 'brief:turn', 'last-brief', 'continuity-fact', brief.userTurn || brief.userMessage);
  if (Object.keys(storyForm).length) addEvidence(entries, 'story-form:0', 'story-form', 'hard-constraint', JSON.stringify(storyForm));
  for (const [index, sentence] of sourceSentences(source).entries()) addEvidence(entries, `source:${index}`, 'source-draft', 'source-draft', sentence);
  let retainedNonCardEvidence = 0;
  let totalNonCardEvidence = 0;
  return entries.filter((entry) => {
    if (entry.kind === 'installed-card') return true;
    if (retainedNonCardEvidence >= MAX_EVIDENCE) return false;
    if (totalNonCardEvidence + entry.excerpt.length > MAX_TOTAL_EVIDENCE) return false;
    retainedNonCardEvidence += 1;
    totalNonCardEvidence += entry.excerpt.length;
    return true;
  });
}

function evidenceMap(evidence = []) {
  return new Map(array(evidence).map((entry) => [String(entry.id), entry]));
}

function refs(value, known) {
  const list = array(value).map(String).filter(Boolean);
  return list.length > 0 && list.length <= 8 && list.every((id) => known.has(id)) ? list : null;
}

function validateClaimList(value, known, { allowSourceDraft = false } = {}) {
  if (!Array.isArray(value) || value.length > 12) return false;
  return value.every((entry) => {
    const claim = safeText(entry?.claim || '', MAX_CLAIM);
    const evidenceRefs = refs(entry?.evidenceRefs, known);
    if (!claim || !evidenceRefs) return false;
    if (!allowSourceDraft && evidenceRefs.some((id) => ['source-draft', 'source-negative'].includes(known.get(id)?.authority))) return false;
    return true;
  });
}

function validateRedirectBrief(brief = {}, evidence = [], decision = '') {
  const data = { ...object(brief) };
  const known = evidenceMap(evidence);
  const list = (value) => Array.isArray(value) ? value.map(String) : [];
  const referenceIssues = [];
  const structureIssues = [];
  const normalizeKnownRefs = (value, path) => {
    const ids = list(value).slice(0, 8);
    return ids.filter((id, index) => {
      if (id && known.has(id)) return true;
      referenceIssues.push({
        code: 'RECURSION_EDITORIAL_REDIRECT_REFERENCE_DROPPED',
        path: `${path}[${index}]`,
        reference: safeText(id, 180)
      });
      return false;
    });
  };
  if (data.mode !== 'redirect') {
    return fail(REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect diagnosis used the wrong brief mode.');
  }
  if (!Array.isArray(data.requiredBeats) || data.requiredBeats.length > 8
    || !Array.isArray(data.forbiddenSourceBeats) || data.forbiddenSourceBeats.length > 8
    || !Array.isArray(data.sceneCharacters) || data.sceneCharacters.length < 1 || data.sceneCharacters.length > 16
    || !Array.isArray(data.characterPressure) || data.characterPressure.length < 1 || data.characterPressure.length > 16) {
    return fail(REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect diagnosis collections are invalid.');
  }

  const sourceFailure = object(data.sourceFailure);
  if (safeText(sourceFailure.problem, MAX_CLAIM)
    && !REDIRECT_FAILURE_CATEGORIES.includes(sourceFailure.category)) {
    data.sourceFailure = { ...sourceFailure, category: 'core-direction' };
  }
  const incompleteFields = [];
  if (!safeText(data.sourceFailure?.problem, MAX_CLAIM)) {
    incompleteFields.push('sourceFailure.problem');
  }
  if (!object(data.replacementObjective).summary
    || !safeText(data.replacementObjective.summary, MAX_CLAIM)) {
    incompleteFields.push('replacementObjective');
  }
  if (!data.requiredBeats.length
    || data.requiredBeats.some((beat) => !safeText(beat?.summary, MAX_CLAIM))) {
    incompleteFields.push('requiredBeats');
  }
  if (!data.forbiddenSourceBeats.length
    || data.forbiddenSourceBeats.some((beat) => !safeText(beat?.summary, MAX_CLAIM))) {
    incompleteFields.push('forbiddenSourceBeats');
  }
  if (incompleteFields.length) {
    return fail(
      REDIRECT_ERROR_CODES.BRIEF_INVALID,
      `Redirect proceed requires complete structured fields: ${incompleteFields.join(', ')}.`
    );
  }
  data.sourceFailure = {
    ...data.sourceFailure,
    establishedEvidenceRefs: normalizeKnownRefs(
      data.sourceFailure.establishedEvidenceRefs,
      'sourceFailure.establishedEvidenceRefs'
    ),
    conflictingSourceRefs: normalizeKnownRefs(
      data.sourceFailure.conflictingSourceRefs,
      'sourceFailure.conflictingSourceRefs'
    )
  };
  data.replacementObjective = {
    ...data.replacementObjective,
    evidenceRefs: normalizeKnownRefs(
      data.replacementObjective.evidenceRefs,
      'replacementObjective.evidenceRefs'
    )
  };
  data.requiredBeats = data.requiredBeats.map((beat, index) => ({
    ...beat,
    evidenceRefs: normalizeKnownRefs(beat?.evidenceRefs, `requiredBeats[${index}].evidenceRefs`)
  }));
  data.forbiddenSourceBeats = data.forbiddenSourceBeats.map((beat, index) => ({
    ...beat,
    sourceRefs: normalizeKnownRefs(beat?.sourceRefs, `forbiddenSourceBeats[${index}].sourceRefs`)
  }));
  data.sceneCharacters = data.sceneCharacters.map((entry, index) => ({
    ...entry,
    character: safeText(entry?.character, 120),
    evidenceRefs: normalizeKnownRefs(entry?.evidenceRefs, `sceneCharacters[${index}].evidenceRefs`)
  }));
  data.characterPressure = data.characterPressure.map((row, index) => {
    const sourcePressureEffect = safeText(row?.sourcePressureEffect, 80);
    if (!sourcePressureEffect) {
      structureIssues.push({
        code: 'RECURSION_EDITORIAL_REDIRECT_PRESSURE_NORMALIZED',
        path: `characterPressure[${index}].sourcePressureEffect`,
        received: ''
      });
    }
    return {
      ...row,
      character: safeText(row?.character, 120),
      immediateWant: row?.immediateWant === null ? null : safeText(row?.immediateWant, MAX_CLAIM),
      wantEvidenceRefs: normalizeKnownRefs(row?.wantEvidenceRefs, `characterPressure[${index}].wantEvidenceRefs`),
      sourcePressureEffect: sourcePressureEffect || 'unclear',
      sourceEvidenceRefs: normalizeKnownRefs(row?.sourceEvidenceRefs, `characterPressure[${index}].sourceEvidenceRefs`),
      pressureReason: safeText(row?.pressureReason, MAX_CLAIM)
    };
  });

  const characters = data.sceneCharacters.map((entry) => safeText(entry?.character, 120));
  if (!characters.length || characters.some((name) => !name)) {
    return fail(REDIRECT_ERROR_CODES.CHARACTER_COVERAGE_INVALID, 'Redirect character coverage is invalid.');
  }
  if (data.characterPressure.some((row) =>
    !row.character
    || (row.immediateWant !== null && !row.immediateWant)
    || !row.sourcePressureEffect)) {
    return fail(REDIRECT_ERROR_CODES.PRESSURE_INVALID, 'Redirect character-pressure structure is invalid.');
  }
  return {
    ok: true,
    value: data,
    ...(referenceIssues.length || structureIssues.length
      ? {
          diagnostics: {
            ...(referenceIssues.length ? { referenceIssues } : {}),
            ...(structureIssues.length ? { structureIssues } : {})
          }
        }
      : {})
  };
}

function canonicalDiagnosis(result) {
  return {
    schema: result.schema,
    mode: result.mode,
    sourceHash: result.sourceHash,
    snapshotHash: result.snapshotHash,
    decision: result.decision,
    brief: result.brief
  };
}

export function editorialDiagnosisHash(result = {}) {
  return hashJson(canonicalDiagnosis(result));
}

export function validateEditorialBrief(brief = {}, evidence = []) {
  const data = object(brief);
  const known = evidenceMap(evidence);
  if (!MODES.has(String(data.mode))) return fail('RECURSION_EDITORIAL_BRIEF_MODE_INVALID', 'Editorial brief used an invalid mode.');
  if (!validateClaimList(data.preserve, known)) return fail('RECURSION_EDITORIAL_EVIDENCE_INVALID', 'Editorial brief preservation claims cited invalid evidence.');
  if (!validateClaimList(data.discard, known, { allowSourceDraft: true })) return fail('RECURSION_EDITORIAL_EVIDENCE_INVALID', 'Editorial brief discard claims cited invalid evidence.');
  for (const key of ['allowedChanges', 'forbiddenChanges']) {
    if (!Array.isArray(data[key]) || data[key].length > 12 || data[key].some((value) => !safeText(value, MAX_CLAIM))) {
      return fail('RECURSION_EDITORIAL_BRIEF_INVALID', `Editorial brief ${key} is invalid.`);
    }
  }
  if (!Array.isArray(data.diagnosis) || data.diagnosis.length > 10 || data.diagnosis.some((entry) => !safeText(entry?.problem, MAX_CLAIM) || !refs(entry?.evidenceRefs, known))) {
    return fail('RECURSION_EDITORIAL_BRIEF_INVALID', 'Editorial brief diagnosis is invalid.');
  }
  return { ok: true, value: data };
}

export function validateEditorialDiagnosis(result = {}, { mode = '', sourceText = '', sourceHash = '', snapshotHash = '', snapshot = {} } = {}) {
  const raw = object(result);
  if (raw.schema !== EDITORIAL_DIAGNOSIS_SCHEMA) return fail('RECURSION_EDITORIAL_DIAGNOSIS_SCHEMA_MISMATCH', 'Editorial diagnosis returned the wrong schema.');
  if (raw.mode !== mode || raw.sourceHash !== sourceHash || raw.snapshotHash !== snapshotHash) return fail('RECURSION_EDITORIAL_DIAGNOSIS_STALE', 'Editorial diagnosis does not match the frozen source.');
  const data = mode === 'redirect' ? { ...raw, decision: 'proceed' } : raw;
  if (!DIAGNOSIS_DECISIONS[data.mode]?.has(data.decision)) {
    const receivedDecision = safeText(
      typeof data.decision === 'string' ? data.decision : JSON.stringify(data.decision),
      120
    );
    return fail(
      'RECURSION_EDITORIAL_DIAGNOSIS_DECISION_INVALID',
      'Editorial diagnosis returned an invalid decision for this mode.',
      {
        receivedDecision,
        allowedDecisions: [...(DIAGNOSIS_DECISIONS[data.mode] || [])]
      }
    );
  }
  const evidence = buildEditorialEvidence(snapshot, sourceText);
  if (mode === 'redirect') {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(data, key);
    const objectOrNull = (value) => value === null || (value && typeof value === 'object' && !Array.isArray(value));
    const flatLayoutValid = !hasOwn('brief')
      && REDIRECT_PROVIDER_FIELDS.every(hasOwn)
      && objectOrNull(data.sourceFailure)
      && objectOrNull(data.replacementObjective)
      && ['requiredBeats', 'forbiddenSourceBeats', 'sceneCharacters', 'characterPressure'].every((key) => Array.isArray(data[key]));
    if (!flatLayoutValid) {
      return fail(
        REDIRECT_ERROR_CODES.LAYOUT_INVALID,
        'Redirect diagnosis must use the flat top-level Redirect fields and must not return a brief object.'
      );
    }
    const diagnosisBrief = {
      mode: 'redirect',
      diagnosis: [],
      preserve: [],
      discard: [],
      allowedChanges: [],
      forbiddenChanges: [],
      sourceFailure: data.sourceFailure,
      replacementObjective: data.replacementObjective,
      requiredBeats: data.requiredBeats,
      forbiddenSourceBeats: data.forbiddenSourceBeats,
      sceneCharacters: data.sceneCharacters,
      characterPressure: data.characterPressure
    };
    const redirectResult = validateRedirectBrief(diagnosisBrief, evidence, data.decision);
    if (!redirectResult.ok) return redirectResult;
    const value = {
      schema: data.schema,
      mode: data.mode,
      sourceHash: data.sourceHash,
      snapshotHash: data.snapshotHash,
      decision: data.decision,
      brief: redirectResult.value
    };
    return {
      ok: true,
      value,
      hash: editorialDiagnosisHash(value),
      ...(redirectResult.diagnostics ? { diagnostics: redirectResult.diagnostics } : {})
    };
  }
  const diagnosisBrief = data.brief;
  const briefResult = validateEditorialBrief(diagnosisBrief, evidence);
  if (!briefResult.ok) return briefResult;
  const value = { ...data, brief: briefResult.value };
  return {
    ok: true,
    value,
    hash: editorialDiagnosisHash(value),
    ...(mode === 'repair'
      ? { diagnostics: { adjacentRepeatDefect: diagnosisSupportsAdjacentRepeat(value) } }
      : {})
  };
}

function cardOutcomeValidation(cardOutcomes, installedHand, known, {
  recoverMissing = false,
  recoveredStatus = 'partially-reflected'
} = {}) {
  const cards = array(installedHand).map((card) => String(card?.cardId || card?.id || '')).filter(Boolean);
  const seen = new Set();
  const validOutcomes = new Map();
  if (!recoverMissing && (!Array.isArray(cardOutcomes) || cardOutcomes.length !== cards.length)) {
    return fail('RECURSION_EDITORIAL_CARD_COVERAGE_MISSING', 'Editorial pass must report every installed card exactly once.');
  }
  for (const outcome of array(cardOutcomes)) {
    const cardId = String(outcome?.cardId || '');
    const evidenceRefs = refs(outcome?.evidenceRefs, known);
    const valid = cards.includes(cardId)
      && !seen.has(cardId)
      && CARD_STATUSES.has(outcome?.status)
      && evidenceRefs;
    if (!valid) {
      if (recoverMissing) continue;
      return fail('RECURSION_EDITORIAL_CARD_OUTCOME_INVALID', 'Editorial pass returned invalid card outcome coverage.');
    }
    seen.add(cardId);
    validOutcomes.set(cardId, {
      cardId,
      status: outcome.status,
      evidenceRefs
    });
  }
  if (recoverMissing) {
    let partialFailed = false;
    const unresolvedCardIds = [];
    const recovered = cards.map((cardId) => {
      const valid = validOutcomes.get(cardId);
      if (valid) return valid;
      partialFailed = true;
      unresolvedCardIds.push(cardId);
      const evidenceId = `card:${cardId}`;
      return known.has(evidenceId)
        ? { cardId, status: recoveredStatus, evidenceRefs: [evidenceId] }
        : null;
    });
    if (recovered.some((outcome) => !outcome)) {
      return fail('RECURSION_EDITORIAL_CARD_COVERAGE_MISSING', 'Editorial pass could not recover installed-card audit coverage from frozen evidence.');
    }
    return { ok: true, cardOutcomes: recovered, partialFailed, unresolvedCardIds };
  }
  return { ok: true, cardOutcomes: cards.map((cardId) => validOutcomes.get(cardId)) };
}

function maxCandidateLength(sourceLength, mode = '') {
  if (mode === 'redirect') return MAX_CANDIDATE;
  return Math.min(MAX_CANDIDATE, Math.max(1500, Math.ceil(Math.max(1, sourceLength) * 1.75)));
}

const AMBIGUOUS_ADJACENT_REPEAT_TOKENS = new Set([
  'had', 'that', 'is', 'was', 'were', 'do', 'did', 'very', 'no', 'yes', 'bye', 'go'
]);

function removeAdjacentRepeatedWords(value = '') {
  return String(value).replace(/\b([\p{L}\p{N}'’-]+)\s+\1\b/giu, (match, token) => (
    AMBIGUOUS_ADJACENT_REPEAT_TOKENS.has(String(token).toLowerCase()) ? match : token
  ));
}

function diagnosisSupportsAdjacentRepeat(diagnosis = {}, target = null) {
  const signals = array(object(diagnosis).repairSignals)
    .map(object)
    .filter((signal) => (
      signal.kind === 'exact-adjacent-duplicate-proposal'
      && safeText(signal.targetId, 180)
      && safeText(signal.beforeHash, 180)
      && safeText(signal.afterHash, 180)
    ));
  if (!target) return signals.length > 0;
  return signals.some((signal) => (
    signal.targetId === String(target.id || '')
    && signal.beforeHash === hashJson(String(target.before || ''))
    && signal.afterHash === hashJson(String(target.after || ''))
  ));
}

function deterministicAdjacentRepeatPatches(targets = {}, known = new Map(), diagnosis = {}) {
  if (!known.has('source:0')) return [];
  const seenRanges = new Set();
  const candidates = eligibleGenerationReviewTargets(targets).flatMap((entry, order) => {
    const before = String(entry?.before || '');
    const after = removeAdjacentRepeatedWords(before);
    const start = Number(entry?.start);
    const end = Number(entry?.end);
    const rangeKey = `${start}:${end}:${before}`;
    if (
      !before
      || after === before
      || !diagnosisSupportsAdjacentRepeat(diagnosis, { id: entry.id, before, after })
      || !DOMAINS.has(entry?.domain)
      || !Number.isInteger(start)
      || !Number.isInteger(end)
      || start < 0
      || end <= start
      || seenRanges.has(rangeKey)
    ) return [];
    seenRanges.add(rangeKey);
    return [{
      id: String(entry.id),
      domain: entry.domain,
      start,
      end,
      before,
      after,
      evidenceRefs: ['source:0'],
      order
    }];
  });
  const selected = [];
  for (const candidate of candidates.sort((left, right) => (
    (left.end - left.start) - (right.end - right.start)
    || left.start - right.start
    || left.order - right.order
  ))) {
    const overlaps = selected.some((entry) => candidate.start < entry.end && entry.start < candidate.end);
    if (!overlaps) selected.push(candidate);
  }
  return selected
    .sort((left, right) => left.start - right.start || left.order - right.order)
    .map(({ start, end, order, ...patch }) => patch);
}

function overlappingPatchTargetIds(patches = [], byId = new Map()) {
  const overlaps = new Set();
  const ranges = patches.map((patch) => byId.get(String(patch?.id))).filter(Boolean);
  for (let leftIndex = 0; leftIndex < ranges.length; leftIndex += 1) {
    const left = ranges[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < ranges.length; rightIndex += 1) {
      const right = ranges[rightIndex];
      if (Number(left.start) < Number(right.end) && Number(right.start) < Number(left.end)) {
        overlaps.add(String(left.id));
        overlaps.add(String(right.id));
      }
    }
  }
  return [...overlaps];
}

export function validateEditorialPass(result = {}, { mode = '', sourceText = '', sourceHash = '', snapshotHash = '', diagnosisHash = '', diagnosis = {}, snapshot = {}, targets = {}, recoverCardCoverage = false } = {}) {
  const data = object(result);
  if (data.schema !== EDITORIAL_PASS_SCHEMA) return fail('RECURSION_EDITORIAL_SCHEMA_MISMATCH', 'Editorial pass returned the wrong schema.');
  if (data.mode !== mode || data.sourceHash !== sourceHash || data.snapshotHash !== snapshotHash) return fail('RECURSION_EDITORIAL_STALE_SOURCE', 'Editorial pass does not match the frozen source.');
  if (String(data.diagnosisHash || '') !== String(diagnosisHash || '')) return fail('RECURSION_EDITORIAL_DIAGNOSIS_STALE', 'Editorial pass used a different diagnosis.');
  const evidence = buildEditorialEvidence(snapshot, sourceText);
  const known = evidenceMap(evidence);
  const cards = cardOutcomeValidation(data.cardOutcomes, snapshot.installedHand, known, {
    recoverMissing: mode === 'redirect' || (mode === 'repair' && recoverCardCoverage === true),
    recoveredStatus: mode === 'redirect' ? 'not-applicable' : 'partially-reflected'
  });
  if (!cards.ok) return cards;
  const recoveredRepairCoverage = mode === 'repair'
    && recoverCardCoverage === true
    && cards.partialFailed === true;
  if (FULL_MODES.has(mode)) {
    if (data.patches !== undefined || !object(data.candidate).text) return fail('RECURSION_EDITORIAL_CANDIDATE_INVALID', 'Full editorial mode requires one complete candidate and no patches.');
    const text = String(data.candidate.text);
    const normalizedSource = compact(sourceText).replace(/\s+/g, ' ');
    if (compact(text).replace(/\s+/g, ' ') === normalizedSource) return fail('RECURSION_EDITORIAL_NO_EFFECT', 'Editorial candidate did not change the source.');
    if (text.length > maxCandidateLength(String(sourceText).length, mode)) return fail('RECURSION_EDITORIAL_CANDIDATE_TOO_LARGE', 'Editorial candidate exceeded its bounded output budget.');
    if (!preservesPresentationEnvelope(sourceText, text)) return fail('RECURSION_EDITORIAL_PRESENTATION_INVALID', 'Editorial candidate changed or collapsed the leading presentation envelope.');
    if (!validateClaimList(data.candidate.preservationLedger, known)) return fail('RECURSION_EDITORIAL_EVIDENCE_INVALID', 'Candidate preservation ledger cited invalid evidence.');
    if (hashJson(data.candidate.preservationLedger) !== hashJson(array(diagnosis?.brief?.preserve))) {
      return fail('RECURSION_EDITORIAL_PRESERVATION_LEDGER_MISMATCH', 'Candidate preservation ledger must exactly match the validated diagnosis preservation ledger.');
    }
    if (!Array.isArray(data.candidate.changeLedger) || data.candidate.changeLedger.length > 12 || data.candidate.changeLedger.some((entry) => !CHANGE_KINDS.has(entry?.kind) || !safeText(entry?.summary, MAX_CLAIM) || !refs(entry?.evidenceRefs, known))) return fail('RECURSION_EDITORIAL_EVIDENCE_INVALID', 'Candidate change ledger cited invalid evidence.');
    if (mode === 'redirect') {
      const redirects = data.candidate.changeLedger.filter((entry) => entry.kind === 'redirect');
      if (!redirects.length) {
        return fail(REDIRECT_ERROR_CODES.CHANGE_MISSING, 'Redirect candidate did not report a turn-level directional change.');
      }
      const objectiveRefs = new Set([
        ...array(diagnosis?.brief?.replacementObjective?.evidenceRefs).map(String),
        ...array(diagnosis?.brief?.requiredBeats).flatMap((beat) => array(beat?.evidenceRefs).map(String))
      ]);
      if (redirects.some((entry) => !array(entry.evidenceRefs).some((id) => objectiveRefs.has(String(id))))) {
        return fail(REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'Redirect ledger did not cite its replacement objective.');
      }
    }
    const recognizedRiskFlags = [...new Set(array(data.candidate.riskFlags).map(String).filter((flag) => RISK_FLAGS.has(flag)))];
    const riskFlags = recognizedRiskFlags.length > 1
      ? recognizedRiskFlags.filter((flag) => flag !== 'none')
      : recognizedRiskFlags;
    const candidate = { ...data.candidate, riskFlags };
    return {
      ok: true,
      artifact: { kind: 'candidate', mode, text, candidate },
      cardOutcomes: cards.cardOutcomes,
      partialFailed: recoveredRepairCoverage,
      unresolvedCardIds: recoveredRepairCoverage ? (cards.unresolvedCardIds || []) : [],
      evidence
    };
  }
  const targetEntries = eligibleGenerationReviewTargets(targets);
  let recoveredDeterministicPatches = mode === 'repair'
    && data.candidate === undefined
    && Array.isArray(data.patches)
    && data.patches.length === 0
    ? deterministicAdjacentRepeatPatches(targets, known, diagnosis)
    : [];
  const inputPatches = Array.isArray(data.patches) && data.patches.length
    ? data.patches
    : recoveredDeterministicPatches;
  if (data.candidate !== undefined || !Array.isArray(data.patches) || inputPatches.length === 0) {
    const safeFieldNames = (value) => Object.keys(object(value))
      .filter((key) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key))
      .sort()
      .slice(0, 24);
    return fail(
      'RECURSION_EDITORIAL_REPAIR_INVALID',
      'Repair requires bounded patches and cannot return a full candidate.',
      {
        receivedFields: safeFieldNames(data),
        candidateFields: safeFieldNames(data.candidate),
        patchCount: array(data.patches).length
      }
    );
  }
  const byId = new Map(targetEntries.map((entry) => [String(entry.id), entry]));
  const seen = new Set();
  const invalidPatches = [];
  const ignoredNoOpPatchIds = [];
  const patches = [];
  inputPatches.forEach((patch, index) => {
    const entry = byId.get(String(patch?.id));
    const evidenceRefs = refs(patch?.evidenceRefs, known);
    const duplicateTarget = Boolean(entry && seen.has(entry.id));
    const validDomain = DOMAINS.has(patch?.domain);
    const trustedDomainValid = Boolean(entry && DOMAINS.has(entry.domain));
    const hasAfter = Boolean(String(patch?.after || '').trim());
    const changesTarget = Boolean(entry && hasAfter && patch.after !== entry.before);
    if (!entry || duplicateTarget || !trustedDomainValid || !hasAfter || !evidenceRefs) {
      const fields = Object.keys(object(patch))
        .filter((key) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key))
        .sort()
        .slice(0, 16);
      const fieldTypes = Object.fromEntries(fields.map((field) => [
        field,
        Array.isArray(patch[field]) ? 'array' : (patch[field] === null ? 'null' : typeof patch[field])
      ]));
      invalidPatches.push({
        index,
        id: safeText(patch?.id, 120),
        domain: safeText(patch?.domain, 120),
        knownTarget: Boolean(entry),
        duplicateTarget,
        validDomain,
        hasAfter,
        changesTarget,
        validEvidence: Boolean(evidenceRefs),
        fields,
        fieldTypes
      });
      return;
    }
    seen.add(entry.id);
    if (!changesTarget) {
      ignoredNoOpPatchIds.push(entry.id);
      return;
    }
    patches.push({ id: entry.id, domain: entry.domain, before: entry.before, after: String(patch.after), evidenceRefs });
  });
  if (invalidPatches.length) {
    const receivedIds = inputPatches.map((patch) => String(patch?.id || ''));
    const identitiesSafe = receivedIds.length > 0
      && new Set(receivedIds).size === receivedIds.length
      && receivedIds.every((id) => byId.has(id));
    const deterministicFallback = identitiesSafe
      ? deterministicAdjacentRepeatPatches(targets, known, diagnosis)
      : [];
    if (deterministicFallback.length) {
      recoveredDeterministicPatches = deterministicFallback;
      patches.splice(0, patches.length, ...deterministicFallback);
      invalidPatches.splice(0, invalidPatches.length);
      ignoredNoOpPatchIds.splice(0, ignoredNoOpPatchIds.length);
    } else {
      return fail(
        'RECURSION_EDITORIAL_REPAIR_INVALID',
        'Repair returned an unknown, duplicate, or invalid patch target.',
        { invalidPatches }
      );
    }
  }
  if (!patches.length) {
    return fail(
      'RECURSION_EDITORIAL_NO_EFFECT',
      'Editorial repair did not change any bounded target.',
      { ignoredNoOpPatchIds }
    );
  }
  if (recoveredRepairCoverage) {
    const deterministicSafeSubset = deterministicAdjacentRepeatPatches(targets, known, diagnosis);
    if (deterministicSafeSubset.length) {
      recoveredDeterministicPatches = deterministicSafeSubset;
      patches.splice(0, patches.length, ...deterministicSafeSubset);
      ignoredNoOpPatchIds.splice(0, ignoredNoOpPatchIds.length);
    }
  }
  const overlappingPatchIds = overlappingPatchTargetIds(patches, byId);
  if (overlappingPatchIds.length) {
    return fail(
      'RECURSION_EDITORIAL_REPAIR_INVALID',
      'Repair returned overlapping patch targets.',
      { overlappingPatchIds }
    );
  }
  if (!preservesPresentationEnvelope(sourceText, applyEditorialArtifact(sourceText, { kind: 'patches', mode: 'repair', patches }, targets))) {
    return fail('RECURSION_EDITORIAL_PRESENTATION_INVALID', 'Editorial repair changed or collapsed the leading presentation envelope.');
  }
  return {
    ok: true,
    artifact: { kind: 'patches', mode: 'repair', patches },
    cardOutcomes: cards.cardOutcomes,
    partialFailed: recoveredRepairCoverage,
    unresolvedCardIds: recoveredRepairCoverage ? (cards.unresolvedCardIds || []) : [],
    ignoredNoOpPatchIds,
    recoveredDeterministicPatchIds: recoveredDeterministicPatches.map((patch) => patch.id),
    evidence
  };
}

function validateRedirectVerificationChecks(checks, known, decision) {
  if (!Array.isArray(checks) || checks.length !== REDIRECT_VERIFICATION_CHECKS.length) {
    return fail(REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID, 'Redirect verification check coverage is incomplete.');
  }
  const byName = new Map();
  for (const entry of checks) {
    if (!REDIRECT_VERIFICATION_CHECKS.includes(entry?.check) || byName.has(entry.check)) {
      return fail(REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID, 'Redirect verification returned an unknown or duplicate check.');
    }
    if (!['pass', 'fail', 'unclear'].includes(entry?.status)
      || !refs(entry?.evidenceRefs, known)
      || !safeText(entry?.note, MAX_CLAIM)) {
      return fail(REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID, 'Redirect verification returned an invalid status, evidence reference, or note.');
    }
    byName.set(entry.check, {
      check: entry.check,
      status: entry.status,
      evidenceRefs: array(entry.evidenceRefs).map(String),
      note: safeText(entry.note, MAX_CLAIM)
    });
  }
  if (REDIRECT_VERIFICATION_CHECKS.some((check) => !byName.has(check))) {
    return fail(REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID, 'Redirect verification omitted a required check.');
  }
  if (decision === 'accept' && [...byName.values()].some((entry) => entry.status !== 'pass')) {
    return fail(REDIRECT_ERROR_CODES.VERIFICATION_ACCEPT_INVALID, 'Redirect verification cannot accept a failed or unclear check.');
  }
  return { ok: true, checks: [...byName.values()] };
}

export function validateEditorialVerification(result = {}, {
  mode = '', sourceHash = '', snapshotHash = '', diagnosisHash = '', candidateHash = '', evidence = [], snapshot = {}
} = {}) {
  const data = object(result);
  if (data.schema !== EDITORIAL_VERIFICATION_SCHEMA
    || data.mode !== mode
    || data.sourceHash !== sourceHash
    || data.snapshotHash !== snapshotHash
    || data.diagnosisHash !== diagnosisHash
    || data.candidateHash !== candidateHash) {
    return fail('RECURSION_EDITORIAL_VERIFICATION_STALE', 'Editorial verification does not match the candidate.');
  }
  if (!['accept', 'reject'].includes(data.decision)) return fail('RECURSION_EDITORIAL_VERIFICATION_INVALID', 'Editorial verifier must return accept or reject.');
  const known = evidenceMap(evidence);
  if (data.evidenceRefs !== undefined && !refs(data.evidenceRefs, known)) return fail('RECURSION_EDITORIAL_EVIDENCE_INVALID', 'Editorial verification cited unknown evidence.');
  const repairCards = mode === 'repair'
    ? cardOutcomeValidation(data.cardOutcomes, snapshot.installedHand, known)
    : { ok: true, cardOutcomes: [] };
  if (!repairCards.ok) return repairCards;
  if (
    mode === 'repair'
    && data.decision === 'accept'
    && repairCards.cardOutcomes.some((outcome) => ['partially-reflected', 'violated', 'requires-regeneration'].includes(outcome.status))
  ) {
    return fail('RECURSION_EDITORIAL_CARD_AUDIT_ACCEPT_INVALID', 'Repair card audit cannot accept unresolved or violated installed cards.');
  }
  const redirectChecks = mode === 'redirect'
    ? validateRedirectVerificationChecks(data.checks, known, data.decision)
    : { ok: true, checks: [] };
  if (!redirectChecks.ok) return redirectChecks;
  return {
    ok: true,
    decision: data.decision,
    checks: redirectChecks.checks,
    cardOutcomes: repairCards.cardOutcomes,
    evidenceRefs: array(data.evidenceRefs).map(String),
    reason: safeText(data.reason || '', 600)
  };
}

export function editorialCardAuditDiagnostics(result = {}) {
  const data = object(result);
  const rawOutcomes = data.cardOutcomes;
  return {
    responseFields: Object.keys(data)
      .filter((key) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key))
      .sort()
      .slice(0, 24),
    cardOutcomesType: Array.isArray(rawOutcomes)
      ? 'array'
      : rawOutcomes === null
        ? 'null'
        : typeof rawOutcomes,
    cardOutcomeCount: Array.isArray(rawOutcomes) ? rawOutcomes.length : 0,
    rows: array(rawOutcomes).slice(0, 24).map((row) => {
      const value = object(row);
      return {
        fields: Object.keys(value)
          .filter((key) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key))
          .sort()
          .slice(0, 16),
        cardId: safeText(value.cardId, 180),
        status: safeText(value.status, 80),
        evidenceRefs: array(value.evidenceRefs).map((ref) => safeText(ref, 180)).filter(Boolean).slice(0, 8)
      };
    })
  };
}

export function mergeRepairCardAudit(validation = {}, auditValidation = {}) {
  if (auditValidation?.ok !== true || !['accept', 'reject'].includes(auditValidation?.decision)) {
    return validation;
  }
  const cardOutcomes = array(auditValidation.cardOutcomes).map((outcome) => ({
    cardId: String(outcome?.cardId || ''),
    status: String(outcome?.status || ''),
    evidenceRefs: array(outcome?.evidenceRefs).map(String)
  }));
  const unresolvedCardIds = cardOutcomes
    .filter((outcome) => ['partially-reflected', 'violated', 'requires-regeneration'].includes(outcome.status))
    .map((outcome) => outcome.cardId)
    .filter(Boolean);
  const accepted = auditValidation.decision === 'accept';
  return {
    ...validation,
    cardOutcomes,
    partialFailed: !accepted,
    unresolvedCardIds: accepted ? [] : unresolvedCardIds,
    cardAudit: { decision: auditValidation.decision }
  };
}

function requestBase(schema, prompt, lane = '') {
  return {
    prompt,
    systemPrompt: `Return only one valid ${schema} JSON object. Do not emit prose, markdown, reasoning, or an alternate schema.`,
    responseSchema: schema,
    machineJson: true,
    ...(lane ? { lane } : {}),
    reasoningCategory: 'editorial-transform',
    reasoningIntent: 'medium'
  };
}

export function buildEditorialDiagnosisRequest({ mode = '', sourceText = '', sourceHash = '', snapshotHash = '', snapshot = {}, targets = {}, lane = '', retry = null } = {}) {
  const evidence = buildEditorialEvidence(snapshot, sourceText);
  const preservedSource = preservedText(sourceText, MAX_SOURCE);
  const presentationEnvelope = leadingPresentationEnvelope(sourceText);
  const validPreservationEvidenceIds = evidence
    .filter((entry) => !['source-draft', 'source-negative'].includes(entry.authority))
    .map((entry) => entry.id);
  const validSourceEvidenceIds = evidence
    .filter((entry) => ['source-draft', 'source-negative'].includes(entry.authority))
    .map((entry) => entry.id);
  const validEvidenceIds = evidence.map((entry) => entry.id);
  const repairTargets = mode === 'repair'
    ? eligibleGenerationReviewTargets(targets)
        .map((entry) => ({ id: entry.id, domain: entry.domain, before: entry.before }))
        .slice(0, 120)
    : [];
  const correction = retry
    ? mode === 'redirect'
      ? [
          'Editorial diagnosis correction required.',
          `The previous diagnosis could not be accepted: ${safeText(retry?.code || 'RECURSION_EDITORIAL_DIAGNOSIS_INVALID', 120)} - ${safeText(retry?.message || 'Invalid diagnosis.', 360)}`,
          `Every Redirect citation field may use these frozen evidence IDs: ${JSON.stringify(validEvidenceIds)}.`,
          'Use each evidence authority label as semantic context. The independent Verifier, not citation placement, decides whether a claim is supported.',
          'Return one complete corrected flat Redirect diagnosis object; do not discuss the correction.'
        ]
      : [
          'Editorial diagnosis correction required.',
          `The previous diagnosis could not be accepted: ${safeText(retry?.code || 'RECURSION_EDITORIAL_DIAGNOSIS_INVALID', 120)} - ${safeText(retry?.message || 'Invalid diagnosis.', 360)}`,
          `Preservation claims may cite only these evidence IDs: ${JSON.stringify(validPreservationEvidenceIds)}.`,
          'Return one complete corrected diagnosis object; do not discuss the correction.'
        ]
    : [];
  const redirectRules = mode === 'redirect'
    ? [
        'Redirect is a turn-level correction, not a more aggressive Recompose.',
        'An explicit Redirect must return decision proceed. Never return no-change; identify the strongest evidence-supported turn-level correction.',
        `Frozen top-level identity object (copy every value exactly): ${JSON.stringify({
          schema: EDITORIAL_DIAGNOSIS_SCHEMA,
          mode,
          sourceHash: safeText(sourceHash, 180),
          snapshotHash: safeText(snapshotHash, 180),
          decision: 'proceed'
        })}`,
        'Return exactly these Redirect top-level keys: schema, mode, sourceHash, snapshotHash, decision, sourceFailure, replacementObjective, requiredBeats, forbiddenSourceBeats, sceneCharacters, characterPressure.',
        'Do not return a brief object or the generic diagnosis, preserve, discard, allowedChanges, or forbiddenChanges fields.',
        'Never put diagnosis prose, arrays, or Redirect content in schema, mode, sourceHash, snapshotHash, or decision.',
        'sourceFailure must be an object with category, problem, establishedEvidenceRefs, and conflictingSourceRefs.',
        'replacementObjective must be an object with summary and evidenceRefs. It must never be a character map.',
        'requiredBeats and forbiddenSourceBeats must be non-empty arrays of structured objects.',
        'sceneCharacters and characterPressure must be non-empty arrays with exactly one row per established scene character.',
        'Treat the latest user-turn evidence as completed player-authored action or dialogue that the assistant response must answer. Never replay, paraphrase, or assign that completed user content to the candidate response.',
        'Never ask the user to repeat, clarify, or restate information already supplied in the latest user turn; a paraphrased request for the same information is still repetition.',
        'Pair established non-source evidence with the conflicting source passages.',
        'Define one supported replacement objective, required beats, and forbidden source beats.',
        'If the latest user turn proposes or requests an action, moving it behind another task, location change, check, conversation, or future beat is a deferral unless frozen non-source evidence independently requires that delay.',
        'When the source defers an evidence-supported immediate want, identify the deferral in sourceFailure and forbiddenSourceBeats; the replacement objective and required beats must engage the request in the current turn.',
        'List every character established as present by frozen evidence.',
        'sourcePressureEffect must be exactly increasing, decreasing, unchanged, or unclear; never return an empty string.',
        'When an immediate want is unsupported, immediateWant must be null, wantEvidenceRefs and sourceEvidenceRefs must both be empty arrays, and sourcePressureEffect must be unclear.',
        'When an immediate want is supported, immediateWant must be a non-empty string, wantEvidenceRefs must cite established non-source evidence, and sourceEvidenceRefs must cite source-draft evidence.',
        'Character pressure is advisory evidence; do not require every character to speak or act.'
      ]
    : [];
  const repairRules = mode === 'repair'
    ? [
        'For selected Repair, choose proceed whenever at least one supplied bounded target can be safely improved without changing supported intent or direction.',
        'Multiple local defects are still Repair work; do not choose requires-recompose merely because more than one bounded patch is needed.',
        'Choose no-change only when none of the supplied targets needs a safe bounded correction.',
        'Choose requires-recompose only when no safe bounded target can improve the response and the identified defect requires a full rewrite.'
      ]
    : [];
  const decisionRule = mode === 'redirect'
    ? 'Decision must be proceed because Redirect is already selected.'
    : 'Choose proceed, no-change, requires-recompose, or requires-redirect according to the selected mode.';
  const prompt = [
    'Return only one valid Recursion Editorial Diagnosis JSON object.',
    `Selected mode: ${mode}.`,
    'Diagnose the completed response against frozen evidence before any candidate is written.',
    'Return no candidate text. Use source-draft evidence only to identify discardable material, never to preserve a fact.',
    decisionRule,
    'Repair changes only bounded spans. Recompose can replace the entire response while preserving its supported intent and direction. Redirect replaces an unsupported core intent or direction.',
    'For selected Recompose, choose proceed for repetition, slop, pacing, voice, phrasing, scene execution, or any defect fixable by a full rewrite that keeps the supported intent.',
    'Never choose requires-redirect only for repetition, verbosity, awkward execution, or other quality defects that Recompose can remove.',
    ...redirectRules,
    ...repairRules,
    ...(presentationEnvelope ? ['Preserve the presentation envelope exactly: keep the leading scene header unchanged and retain a blank line before body prose.'] : []),
    ...correction,
    `<source_hash>${safeText(sourceHash, 180)}</source_hash>`,
    `<snapshot_hash>${safeText(snapshotHash, 180)}</snapshot_hash>`,
    ...(mode === 'repair' ? [`<repair_targets>${JSON.stringify(repairTargets)}</repair_targets>`] : []),
    `<evidence>${JSON.stringify(evidence)}</evidence>`,
    `<presentation_envelope>${JSON.stringify(presentationEnvelope)}</presentation_envelope>`,
    `<source_json>${JSON.stringify(preservedSource)}</source_json>`
  ].join('\n');
  return {
    ...requestBase(EDITORIAL_DIAGNOSIS_SCHEMA, prompt, lane),
    sourceHash,
    snapshotHash,
    mode,
    sourceText: preservedSource,
    presentationEnvelope,
    validEvidenceIds,
    validPreservationEvidenceIds,
    validSourceEvidenceIds,
    validTargetIds: repairTargets.map((entry) => String(entry.id || '')).filter(Boolean),
    repairTargets
  };
}

function safeDiagnosisDiagnostics(value = {}) {
  const referenceIssues = array(object(value).referenceIssues).slice(0, 24).map((entry) => ({
    code: safeText(entry?.code, 120),
    path: safeText(entry?.path, 240),
    reference: safeText(entry?.reference, 180)
  })).filter((entry) => entry.code && entry.path);
  const structureIssues = array(object(value).structureIssues).slice(0, 24).map((entry) => ({
    code: safeText(entry?.code, 120),
    path: safeText(entry?.path, 240),
    received: safeText(entry?.received, 180)
  })).filter((entry) => entry.code && entry.path);
  return {
    ...(referenceIssues.length ? { referenceIssues } : {}),
    ...(structureIssues.length ? { structureIssues } : {})
  };
}

export function buildEditorialPassRequest({ mode = '', sourceText = '', sourceHash = '', snapshotHash = '', diagnosis = {}, diagnosisDiagnostics = {}, evidence = [], snapshot = {}, targets = {}, lane = '', retry = null } = {}) {
  const full = FULL_MODES.has(mode);
  const preservedSource = preservedText(sourceText, MAX_SOURCE);
  const presentationEnvelope = leadingPresentationEnvelope(sourceText);
  const targetList = eligibleGenerationReviewTargets(targets).map((entry) => ({ id: entry.id, domain: entry.domain, before: entry.before })).slice(0, 120);
  const validPreservationEvidenceIds = array(evidence)
    .filter((entry) => !['source-draft', 'source-negative'].includes(entry?.authority))
    .map((entry) => String(entry?.id || ''))
    .filter(Boolean);
  const requiredPreservationLedger = array(diagnosis?.brief?.preserve).map((entry) => ({
    claim: String(entry?.claim || ''),
    evidenceRefs: array(entry?.evidenceRefs).map(String)
  }));
  const installedCardIds = array(snapshot?.installedHand)
    .map((card) => String(card?.cardId || card?.id || ''))
    .filter(Boolean);
  const redirectChangeEvidenceRefs = mode === 'redirect'
    ? [...new Set([
        ...array(diagnosis?.brief?.replacementObjective?.evidenceRefs).map(String),
        ...array(diagnosis?.brief?.requiredBeats).flatMap((beat) => array(beat?.evidenceRefs).map(String))
      ].filter(Boolean))].slice(0, 8)
    : [];
  const correction = retry
    ? [
        'Editorial pass correction required.',
        `The previous pass failed semantic validation: ${safeText(retry?.code || 'RECURSION_EDITORIAL_PASS_INVALID', 120)} - ${safeText(retry?.message || 'Invalid editorial pass.', 360)}`,
        `Preservation claims may cite only these evidence IDs: ${JSON.stringify(validPreservationEvidenceIds)}.`,
        'Return one complete corrected editorial pass object; do not discuss the correction.'
      ]
    : [];
  const redirectRules = mode === 'redirect'
    ? [
        'Treat the Redirect diagnosis as the proposal to execute in this candidate; the independent Verifier will judge whether it is supported.',
        'Rebuild the response around diagnosis.brief.replacementObjective.',
        'Include the supported substance of every required beat.',
        'Do not weaken an active required beat into passive attention, agreement, observation, or internal feeling.',
        'Do not preserve any forbidden source beat, even with different wording.',
        'Compare every candidate question against the latest user-turn evidence before returning; remove any question that asks for information the user already supplied.',
        'Planning to act after another task, check, location change, or future beat still preserves a forbidden deferral; engage a current-turn required beat directly.',
        'Use diagnosis.brief.characterPressure as advisory dramatic evidence. Rising pressure makes a stronger response more likely but never mandatory.',
        'Silence, restraint, refusal, and delayed action remain valid when supported.',
        'Do not distribute dialogue or action as a checklist, and do not invent a want for an unclear character.',
        'Recursion constructs the Redirect change ledger locally from the proposed diagnosis.',
        'A lexical rewrite that preserves the source objective or beat plan is not a Redirect.'
      ]
    : [];
  const providerShapeRules = mode === 'redirect'
    ? [
        'Return exactly these Redirect top-level keys: schema, mode, sourceHash, snapshotHash, diagnosisHash, text.',
        'Do not return candidate, patches, changeLedger, cardOutcomes, preservationLedger, or riskFlags.',
        'Return candidate prose only in the top-level text field.',
        'Recursion constructs preservation, change-ledger, and audit metadata locally after structural validation.'
      ]
    : mode === 'repair'
      ? [
          'Return exactly these Repair top-level keys: schema, mode, sourceHash, snapshotHash, diagnosisHash, cardOutcomes, patches.',
          'Do not return candidate, preservationLedger, changeLedger, or riskFlags.',
          'For Repair, patches must contain at least one effective row and every row must change its supplied target.',
          'Each patch row must contain exactly id, before, after, domain, and evidenceRefs. Keep domain as one domain string and evidenceRefs as an array of supplied evidence IDs.',
          `Return cardOutcomes in this exact cardId order, once each: ${JSON.stringify(installedCardIds)}.`,
          'Every patch and card outcome must cite only supplied evidence IDs.'
        ]
      : [
          `Copy diagnosis.brief.preserve exactly into candidate.preservationLedger: ${JSON.stringify(requiredPreservationLedger)}. Do not add, remove, or rewrite preservation claims or evidence IDs.`,
          `Return cardOutcomes in this exact cardId order, once each: ${JSON.stringify(installedCardIds)}.`,
          'Every preservation claim, major change, and card outcome must cite only supplied evidence IDs.'
        ];
  const prompt = [
    'Return only one valid Recursion Editorial Pass JSON object.',
    `Selected mode: ${mode}.`,
    full
      ? mode === 'redirect'
        ? 'Return one complete rewritten response in the top-level text field. You may replace every source sentence when the proposed diagnosis calls for it.'
        : 'Return one complete candidate. You may replace every source sentence when the validated diagnosis supports it.'
      : 'Return only exact non-overlapping replacements for supplied targets.',
    mode === 'redirect' ? 'The source may be negative evidence. Preserve only facts supported by frozen evidence.' : 'Preserve supported facts, commitments, constraints, and the user turn while improving execution.',
    mode === 'redirect'
      ? 'Do not rediagnose inside candidate prose; execute the proposal and leave semantic acceptance to the Verifier.'
      : 'The diagnosis below is authoritative. Do not add a new diagnosis or revise its preservation/discard decisions.',
    ...providerShapeRules,
    ...redirectRules,
    ...(presentationEnvelope ? ['Preserve the presentation envelope exactly: keep the leading scene header unchanged and retain a blank line before body prose.'] : []),
    ...correction,
    `<source_hash>${safeText(sourceHash, 180)}</source_hash>`,
    `<snapshot_hash>${safeText(snapshotHash, 180)}</snapshot_hash>`,
    `<diagnosis>${JSON.stringify(diagnosis)}</diagnosis>`,
    ...(mode === 'redirect' && Object.keys(safeDiagnosisDiagnostics(diagnosisDiagnostics)).length
      ? [`<diagnosis_diagnostics>${JSON.stringify(safeDiagnosisDiagnostics(diagnosisDiagnostics))}</diagnosis_diagnostics>`]
      : []),
    `<evidence>${JSON.stringify(evidence)}</evidence>`,
    `<snapshot>${JSON.stringify(snapshot)}</snapshot>`,
    `<targets>${JSON.stringify(targetList)}</targets>`,
    `<presentation_envelope>${JSON.stringify(presentationEnvelope)}</presentation_envelope>`,
    `<source_json>${JSON.stringify(preservedSource)}</source_json>`
  ].join('\n');
  return {
    ...requestBase(EDITORIAL_PASS_SCHEMA, prompt, lane),
    sourceHash,
    snapshotHash,
    mode,
    sourceText: preservedSource,
    presentationEnvelope,
    diagnosisHash: editorialDiagnosisHash(diagnosis),
    validEvidenceIds: array(evidence).map((entry) => String(entry?.id || '')).filter(Boolean),
    validPreservationEvidenceIds,
    requiredPreservationLedger,
    redirectChangeEvidenceRefs,
    installedCardIds,
    validTargetIds: targetList.map((entry) => String(entry.id || '')).filter(Boolean),
    ...(mode === 'repair' ? { repairTargets: targetList } : {})
  };
}

export function buildEditorialVerificationRequest({ mode = '', sourceHash = '', snapshotHash = '', diagnosisHash = '', diagnosis = null, diagnosisDiagnostics = {}, evidence = [], snapshot = {}, candidate = {}, lane = '', retry = null } = {}) {
  const candidateHash = hashJson(String(candidate?.text || ''));
  const validEvidenceIds = array(evidence).map((entry) => String(entry?.id || '')).filter(Boolean);
  const installedCardIds = array(snapshot?.installedHand)
    .map((card) => String(card?.cardId || card?.id || ''))
    .filter(Boolean);
  const verificationEvidenceRefs = mode === 'redirect'
    ? [...new Set([
        ...array(diagnosis?.brief?.replacementObjective?.evidenceRefs).map(String),
        ...array(diagnosis?.brief?.requiredBeats).flatMap((beat) => array(beat?.evidenceRefs).map(String))
      ].filter((id) => validEvidenceIds.includes(id)))].slice(0, 8)
    : [];
  if (mode === 'redirect' && verificationEvidenceRefs.length === 0 && validEvidenceIds.length) {
    verificationEvidenceRefs.push(validEvidenceIds[0]);
  }
  const correction = retry
    ? [
        'Editorial verification correction required.',
        `The previous verification could not be accepted: ${safeText(retry?.code || 'RECURSION_EDITORIAL_VERIFICATION_INVALID', 120)} - ${safeText(retry?.message || 'Invalid verification.', 360)}`,
        ...(mode === 'redirect'
          ? ['failedChecks may use only the required check names listed below.']
          : mode === 'repair'
            ? [`failedCardIds may use only these exact dynamic IDs: ${JSON.stringify(installedCardIds)}.`]
          : [`Check evidenceRefs may use only these evidence IDs: ${JSON.stringify(validEvidenceIds)}.`]),
        'Return a corrected verdict for the same candidate; do not rewrite or replace the candidate.'
      ]
    : [];
  const redirectRules = mode === 'redirect'
    ? [
        'Treat the diagnosis as a proposal, not as established truth.',
        'First judge every diagnosis claim against the complete frozen evidence. Evidence authority labels inform your judgment but do not decide it automatically.',
        'Fail diagnosis-evidence-grounded when the source failure, replacement objective, required beats, forbidden beats, scene cast, or character pressure are unsupported, physically impossible, temporally impossible, or conflict with user intent.',
        'A source-draft citation may identify what the source did, but source prose alone does not make an invented fact canonical. Judge support from the complete evidence rather than citation placement.',
        'Cross-check the diagnosis against frozen evidence and the source failure; reject if its objective or beats merely rename, soften, or preserve the failed trajectory.',
        'Evaluate every required check against both the proposed diagnosis and frozen evidence; do not invent a different objective.',
        `Evaluate all ${REDIRECT_VERIFICATION_CHECKS.length} required checks below.`,
        ...REDIRECT_VERIFICATION_CHECKS.map((check, index) => `${index + 1}. ${check}`),
        'Return failedChecks as the list of every required check that fails or remains unclear. Return an empty list only when every check passes.',
        'Return one short user-safe reason. Do not return decision, checks, evidenceRefs, prose analysis, or a rewritten candidate.',
        'Required beats must be materially explicit in the candidate; adjacent or passive behavior is not equivalent to a required action.',
        'A plan to act after another task, check, location change, or future beat still retains a forbidden deferral, even when the wording differs from the source.',
        'A paraphrased question still fails when it asks for information already supplied by the latest user turn; mark forbidden-source-beats-excluded and user-turn-answered as failed.',
        'Reject if the candidate omits any required beat, retains any forbidden source beat, or contradicts the advisory character-pressure map.'
      ]
    : [];
  const repairRules = mode === 'repair'
    ? [
        `Return failedCardIds using only this exact dynamic ID list: ${JSON.stringify(installedCardIds)}.`,
        'Judge the transformed candidate against each installed card and the complete frozen evidence.',
        'Include every card ID that remains partially reflected, violated, unsupported, or unclear.',
        'Return an empty failedCardIds array only when every installed card is honored, repaired, or genuinely not applicable.',
        'Return one short reason. Do not return decision, cardOutcomes, patches, or rewritten candidate prose.'
      ]
    : [];
  const prompt = [
    mode === 'redirect'
      ? 'Return only one compact Redirect verification result for this candidate.'
      : mode === 'repair'
        ? 'Return only one complete installed-card audit for this repaired candidate.'
      : 'Return only accept or reject for this one editorial candidate.',
    'Do not rewrite, score, compare, rank, or propose another candidate.',
    `Mode: ${mode}.`,
    ...redirectRules,
    ...repairRules,
    ...correction,
    `<source_hash>${safeText(sourceHash, 180)}</source_hash>`,
    `<snapshot_hash>${safeText(snapshotHash, 180)}</snapshot_hash>`,
    `<diagnosis_hash>${safeText(diagnosisHash, 180)}</diagnosis_hash>`,
    `<candidate_hash>${safeText(candidateHash, 180)}</candidate_hash>`,
    ...(mode === 'redirect' ? [`<diagnosis>${JSON.stringify(object(diagnosis))}</diagnosis>`] : []),
    ...(mode === 'redirect' && Object.keys(safeDiagnosisDiagnostics(diagnosisDiagnostics)).length
      ? [`<diagnosis_diagnostics>${JSON.stringify(safeDiagnosisDiagnostics(diagnosisDiagnostics))}</diagnosis_diagnostics>`]
      : []),
    `<evidence>${JSON.stringify(evidence)}</evidence>`,
    `<candidate>${JSON.stringify(candidate)}</candidate>`
  ].join('\n');
  return {
    ...requestBase(EDITORIAL_VERIFICATION_SCHEMA, prompt, lane),
    sourceHash,
    snapshotHash,
    diagnosisHash,
    candidateHash,
    mode,
    candidate,
    ...(mode === 'redirect' ? { diagnosis: object(diagnosis) } : {}),
    validEvidenceIds,
    installedCardIds,
    verificationEvidenceRefs
  };
}

export function editorialVerificationRequired(mode = '', reasoningLevel = '') {
  if (mode === 'redirect') return true;
  return mode === 'recompose' && ['high', 'ultra'].includes(String(reasoningLevel || '').toLowerCase());
}

export function buildRedirectEffectivenessRequest({
  scenarioId = '',
  oracle = {},
  snapshot = {},
  evidence = [],
  sourceText = '',
  candidateText = '',
  marker = {},
  lane = 'utility'
} = {}) {
  const source = preservedText(sourceText, MAX_SOURCE);
  const candidate = preservedText(candidateText, MAX_CANDIDATE);
  const sourceHash = hashJson(source);
  const candidateHash = hashJson(candidate);
  const markerSummary = {
    mode: safeText(marker?.mode, 40),
    verification: safeText(marker?.verification, 40),
    sourceHash: safeText(marker?.sourceHash, 180),
    snapshotHash: safeText(marker?.snapshotHash, 180),
    diagnosisHash: safeText(marker?.diagnosisHash, 180),
    candidateHash: safeText(marker?.candidateHash, 180),
    changeLedger: array(marker?.changeLedger).map((entry) => ({
      kind: safeText(entry?.kind, 80),
      summary: safeText(entry?.summary, MAX_CLAIM),
      evidenceRefs: array(entry?.evidenceRefs).map((id) => safeText(id, 120)).filter(Boolean)
    }))
  };
  const prompt = [
    'Act as an independent effectiveness judge for one Recursion Redirect result.',
    'Evaluate trajectory and frozen evidence, not lexical edit distance or prose polish.',
    'Do not trust the production marker, verifier, or ledger self-report; use them only as identity and audit context.',
    'Return each required criterion exactly once. Decision pass requires every criterion to pass.',
    'For character-pressure, judge contradiction and required response behavior exactly as declared by oracle.pressureExpectations.',
    'responseRequired false means the candidate need not explicitly depict, mention, or intensify that pressure; pass when the candidate does not contradict it.',
    `<scenario_id>${safeText(scenarioId, 180)}</scenario_id>`,
    `<source_hash>${sourceHash}</source_hash>`,
    `<candidate_hash>${candidateHash}</candidate_hash>`,
    `<oracle>${JSON.stringify(object(oracle))}</oracle>`,
    `<frozen_snapshot>${JSON.stringify(object(snapshot))}</frozen_snapshot>`,
    `<frozen_evidence>${JSON.stringify(array(evidence))}</frozen_evidence>`,
    `<production_marker_summary>${JSON.stringify(markerSummary)}</production_marker_summary>`,
    `<source_json>${JSON.stringify(source)}</source_json>`,
    `<candidate_json>${JSON.stringify(candidate)}</candidate_json>`
  ].join('\n');
  return {
    ...requestBase(EDITORIAL_EFFECTIVENESS_SCHEMA, prompt, lane),
    reasoningCategory: 'editorial-effectiveness',
    scenarioId: safeText(scenarioId, 180),
    sourceHash,
    candidateHash,
    oracle: object(oracle),
    snapshot: object(snapshot),
    evidence: array(evidence),
    sourceText: source,
    candidateText: candidate,
    marker: markerSummary
  };
}

export function validateRedirectEffectiveness(result = {}, {
  scenarioId = '', sourceHash = '', candidateHash = ''
} = {}) {
  const data = object(result);
  if (data.schema !== EDITORIAL_EFFECTIVENESS_SCHEMA
    || data.scenarioId !== scenarioId
    || data.sourceHash !== sourceHash
    || data.candidateHash !== candidateHash) {
    return fail('RECURSION_REDIRECT_EFFECTIVENESS_STALE', 'Redirect effectiveness result does not match the judged candidate.');
  }
  if (!['pass', 'fail'].includes(data.decision)) {
    return fail('RECURSION_REDIRECT_EFFECTIVENESS_INVALID', 'Redirect effectiveness decision must be pass or fail.');
  }
  if (!Array.isArray(data.criteria) || data.criteria.length !== REDIRECT_EFFECTIVENESS_CRITERIA.length) {
    return fail('RECURSION_REDIRECT_EFFECTIVENESS_CRITERIA_INVALID', 'Redirect effectiveness criterion coverage is incomplete.');
  }
  const byName = new Map();
  for (const entry of data.criteria) {
    if (!REDIRECT_EFFECTIVENESS_CRITERIA.includes(entry?.criterion)
      || byName.has(entry.criterion)
      || !['pass', 'fail'].includes(entry?.status)
      || !safeText(entry?.reason, 600)) {
      return fail('RECURSION_REDIRECT_EFFECTIVENESS_CRITERIA_INVALID', 'Redirect effectiveness returned an invalid or duplicate criterion.');
    }
    byName.set(entry.criterion, {
      criterion: entry.criterion,
      status: entry.status,
      reason: safeText(entry.reason, 600)
    });
  }
  if (REDIRECT_EFFECTIVENESS_CRITERIA.some((criterion) => !byName.has(criterion))) {
    return fail('RECURSION_REDIRECT_EFFECTIVENESS_CRITERIA_INVALID', 'Redirect effectiveness omitted a required criterion.');
  }
  if (data.decision === 'pass' && [...byName.values()].some((entry) => entry.status !== 'pass')) {
    return fail('RECURSION_REDIRECT_EFFECTIVENESS_ACCEPT_INVALID', 'Redirect effectiveness cannot pass a failed criterion.');
  }
  return {
    ok: true,
    scenarioId: data.scenarioId,
    sourceHash: data.sourceHash,
    candidateHash: data.candidateHash,
    decision: data.decision,
    criteria: [...byName.values()]
  };
}

export function editorialPassKey({ chatKey = '', messageId = '', swipeId = '', sourceHash = '', snapshotHash = '', diagnosisHash = '', mode = '', applyMode = '', verificationRequired = false } = {}) {
  return [chatKey, messageId, swipeId, sourceHash, snapshotHash, diagnosisHash, mode, applyMode, verificationRequired ? 'verify' : 'direct'].map((value) => String(value ?? '')).join('::');
}

export function applyEditorialArtifact(sourceText = '', artifact = {}, targets = {}) {
  if (artifact?.kind === 'candidate') return String(artifact.text ?? '');
  const byId = new Map(Object.values(targets || {}).flat().map((entry) => [String(entry.id), entry]));
  return [...array(artifact?.patches)].sort((left, right) => (byId.get(right.id)?.start || 0) - (byId.get(left.id)?.start || 0)).reduce((text, patch) => {
    const target = byId.get(String(patch.id));
    if (!target) return text;
    return `${text.slice(0, target.start)}${patch.after}${text.slice(target.end)}`;
  }, String(sourceText ?? ''));
}
