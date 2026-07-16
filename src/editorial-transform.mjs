import { compact, hashJson, truncate } from './core.mjs';

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
export const REDIRECT_PRESSURE_EFFECTS = Object.freeze([
  'increasing',
  'decreasing',
  'unchanged',
  'unclear'
]);
export const REDIRECT_VERIFICATION_CHECKS = Object.freeze([
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
  const installedCards = packetCards.length ? packetCards : array(data.installedHand);
  for (const [index, card] of installedCards.slice(0, 48).entries()) {
    const cardId = String(card?.cardId || card?.id || '').trim();
    if (!cardId) continue;
    addEvidence(entries, `card:${cardId}`, 'installed-card', card?.hardConstraint ? 'hard-constraint' : 'scene-support', card.promptText || card.description || card.name);
    if (index >= 47) break;
  }
  if (brief.userTurn || brief.userMessage) addEvidence(entries, 'brief:turn', 'last-brief', 'continuity-fact', brief.userTurn || brief.userMessage);
  if (Object.keys(storyForm).length) addEvidence(entries, 'story-form:0', 'story-form', 'hard-constraint', JSON.stringify(storyForm));
  for (const [index, sentence] of sourceSentences(source).entries()) addEvidence(entries, `source:${index}`, 'source-draft', 'source-draft', sentence);
  let total = 0;
  return entries.filter((entry) => {
    if (entries.indexOf(entry) >= MAX_EVIDENCE) return false;
    if (total + entry.excerpt.length > MAX_TOTAL_EVIDENCE) return false;
    total += entry.excerpt.length;
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

function supportedRedirectPreservationClaims(value, evidence = []) {
  const known = evidenceMap(evidence);
  return array(value).filter((entry) => {
    const claim = safeText(entry?.claim || '', MAX_CLAIM);
    const evidenceRefs = refs(entry?.evidenceRefs, known);
    return Boolean(claim && evidenceRefs
      && evidenceRefs.every((id) => !['source-draft', 'source-negative'].includes(known.get(id)?.authority)));
  });
}

function validateRedirectBrief(brief = {}, evidence = [], decision = '') {
  const data = object(brief);
  const known = evidenceMap(evidence);
  const isSource = (id) => ['source-draft', 'source-negative'].includes(known.get(id)?.authority);
  const list = (value) => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  const authoritative = (value) => {
    const ids = list(value);
    return ids.length > 0 && ids.length <= 8 && ids.every((id) => known.has(id) && !isSource(id));
  };
  const sourceOnly = (value) => {
    const ids = list(value);
    return ids.length > 0 && ids.length <= 8 && ids.every((id) => known.has(id) && isSource(id));
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

  if (!object(data.sourceFailure).category
    || !REDIRECT_FAILURE_CATEGORIES.includes(data.sourceFailure.category)
    || !safeText(data.sourceFailure.problem, MAX_CLAIM)
    || !object(data.replacementObjective).summary
    || !safeText(data.replacementObjective.summary, MAX_CLAIM)
    || !data.requiredBeats.length
    || !data.forbiddenSourceBeats.length
    || data.requiredBeats.some((beat) => !safeText(beat?.summary, MAX_CLAIM))
    || data.forbiddenSourceBeats.some((beat) => !safeText(beat?.summary, MAX_CLAIM))) {
    return fail(REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect proceed requires a complete turn-level correction.');
  }
  if (!authoritative(data.sourceFailure.establishedEvidenceRefs)
    || !sourceOnly(data.sourceFailure.conflictingSourceRefs)
    || !authoritative(data.replacementObjective.evidenceRefs)
    || data.requiredBeats.some((beat) => !authoritative(beat?.evidenceRefs))
    || data.forbiddenSourceBeats.some((beat) => !sourceOnly(beat?.sourceRefs))) {
    return fail(REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'Redirect evidence authority is invalid.');
  }

  const characters = data.sceneCharacters.map((entry) => safeText(entry?.character, 120));
  const pressureCharacters = data.characterPressure.map((entry) => safeText(entry?.character, 120));
  if (characters.some((name) => !name)
    || pressureCharacters.some((name) => !name)
    || new Set(characters).size !== characters.length
    || new Set(pressureCharacters).size !== pressureCharacters.length
    || hashJson([...characters].sort()) !== hashJson([...pressureCharacters].sort())) {
    return fail(REDIRECT_ERROR_CODES.CHARACTER_COVERAGE_INVALID, 'Redirect character coverage is invalid.');
  }
  if (data.sceneCharacters.some((entry) => !authoritative(entry?.evidenceRefs))) {
    return fail(REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'Redirect scene character cited invalid evidence.');
  }

  for (const row of data.characterPressure) {
    if (!safeText(row?.pressureReason, MAX_CLAIM) || !REDIRECT_PRESSURE_EFFECTS.includes(row?.sourcePressureEffect)) {
      return fail(REDIRECT_ERROR_CODES.PRESSURE_INVALID, 'Redirect character pressure is invalid.');
    }
    if (row.immediateWant === null) {
      if (list(row.wantEvidenceRefs).length
        || list(row.sourceEvidenceRefs).length
        || row.sourcePressureEffect !== 'unclear') {
        return fail(REDIRECT_ERROR_CODES.PRESSURE_INVALID, 'Unclear character pressure cannot claim concrete evidence or effect.');
      }
      continue;
    }
    if (!safeText(row.immediateWant, MAX_CLAIM)) {
      return fail(REDIRECT_ERROR_CODES.PRESSURE_INVALID, 'Redirect immediate want is invalid.');
    }
    if (!authoritative(row.wantEvidenceRefs) || !sourceOnly(row.sourceEvidenceRefs)) {
      return fail(REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'Redirect character pressure cited invalid evidence.');
    }
  }
  return { ok: true, value: data };
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
  if (!DIAGNOSIS_DECISIONS[data.mode]?.has(data.decision)) return fail('RECURSION_EDITORIAL_DIAGNOSIS_DECISION_INVALID', 'Editorial diagnosis returned an invalid decision for this mode.');
  const evidence = buildEditorialEvidence(snapshot, sourceText);
  const diagnosisBrief = mode === 'redirect'
    ? {
        ...object(data.brief),
        diagnosis: [],
        preserve: supportedRedirectPreservationClaims(data.brief?.preserve, evidence)
      }
    : data.brief;
  const briefResult = validateEditorialBrief(diagnosisBrief, evidence);
  if (!briefResult.ok) return briefResult;
  const redirectResult = data.mode === 'redirect'
    ? validateRedirectBrief(briefResult.value, evidence, data.decision)
    : briefResult;
  if (!redirectResult.ok) return redirectResult;
  return { ok: true, value: { ...data, brief: redirectResult.value }, hash: editorialDiagnosisHash({ ...data, brief: redirectResult.value }) };
}

function cardOutcomeValidation(cardOutcomes, installedHand, known) {
  const cards = array(installedHand).map((card) => String(card?.cardId || card?.id || '')).filter(Boolean);
  const seen = new Set();
  if (!Array.isArray(cardOutcomes) || cardOutcomes.length !== cards.length) return fail('RECURSION_EDITORIAL_CARD_COVERAGE_MISSING', 'Editorial pass must report every installed card exactly once.');
  for (const outcome of cardOutcomes) {
    const cardId = String(outcome?.cardId || '');
    const evidenceRefs = refs(outcome?.evidenceRefs, known);
    if (!cards.includes(cardId) || seen.has(cardId) || !CARD_STATUSES.has(outcome?.status) || !evidenceRefs) return fail('RECURSION_EDITORIAL_CARD_OUTCOME_INVALID', 'Editorial pass returned invalid card outcome coverage.');
    seen.add(cardId);
  }
  return { ok: true };
}

function maxCandidateLength(sourceLength) {
  return Math.min(MAX_CANDIDATE, Math.max(1500, Math.ceil(Math.max(1, sourceLength) * 1.75)));
}

export function validateEditorialPass(result = {}, { mode = '', sourceText = '', sourceHash = '', snapshotHash = '', diagnosisHash = '', diagnosis = {}, snapshot = {}, targets = {} } = {}) {
  const data = object(result);
  if (data.schema !== EDITORIAL_PASS_SCHEMA) return fail('RECURSION_EDITORIAL_SCHEMA_MISMATCH', 'Editorial pass returned the wrong schema.');
  if (data.mode !== mode || data.sourceHash !== sourceHash || data.snapshotHash !== snapshotHash) return fail('RECURSION_EDITORIAL_STALE_SOURCE', 'Editorial pass does not match the frozen source.');
  if (String(data.diagnosisHash || '') !== String(diagnosisHash || '')) return fail('RECURSION_EDITORIAL_DIAGNOSIS_STALE', 'Editorial pass used a different diagnosis.');
  const evidence = buildEditorialEvidence(snapshot, sourceText);
  const known = evidenceMap(evidence);
  const cards = cardOutcomeValidation(data.cardOutcomes, snapshot.installedHand, known);
  if (!cards.ok) return cards;
  if (FULL_MODES.has(mode)) {
    if (data.patches !== undefined || !object(data.candidate).text) return fail('RECURSION_EDITORIAL_CANDIDATE_INVALID', 'Full editorial mode requires one complete candidate and no patches.');
    const text = String(data.candidate.text);
    const normalizedSource = compact(sourceText).replace(/\s+/g, ' ');
    if (compact(text).replace(/\s+/g, ' ') === normalizedSource) return fail('RECURSION_EDITORIAL_NO_EFFECT', 'Editorial candidate did not change the source.');
    if (text.length > maxCandidateLength(String(sourceText).length)) return fail('RECURSION_EDITORIAL_CANDIDATE_TOO_LARGE', 'Editorial candidate exceeded its bounded output budget.');
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
    if (!Array.isArray(data.candidate.riskFlags) || data.candidate.riskFlags.some((flag) => !RISK_FLAGS.has(flag))) return fail('RECURSION_EDITORIAL_CANDIDATE_INVALID', 'Candidate risk flags are invalid.');
    return { ok: true, artifact: { kind: 'candidate', mode, text, candidate: data.candidate }, cardOutcomes: data.cardOutcomes, evidence };
  }
  if (data.candidate !== undefined || !Array.isArray(data.patches) || data.patches.length === 0) return fail('RECURSION_EDITORIAL_REPAIR_INVALID', 'Repair requires bounded patches and cannot return a full candidate.');
  const targetEntries = Object.values(targets || {}).flat().filter(Boolean);
  const byId = new Map(targetEntries.map((entry) => [String(entry.id), entry]));
  const seen = new Set();
  const patches = data.patches.map((patch) => {
    const entry = byId.get(String(patch?.id));
    const evidenceRefs = refs(patch?.evidenceRefs, known);
    if (!entry || seen.has(entry.id) || !DOMAINS.has(patch?.domain) || !String(patch?.after || '').trim() || patch.after === entry.before || !evidenceRefs) return null;
    seen.add(entry.id);
    return { id: entry.id, domain: patch.domain, before: entry.before, after: String(patch.after), evidenceRefs };
  });
  if (patches.some((patch) => !patch)) return fail('RECURSION_EDITORIAL_REPAIR_INVALID', 'Repair returned an unknown, duplicate, or invalid patch target.');
  if (!preservesPresentationEnvelope(sourceText, applyEditorialArtifact(sourceText, { kind: 'patches', mode: 'repair', patches }, targets))) {
    return fail('RECURSION_EDITORIAL_PRESENTATION_INVALID', 'Editorial repair changed or collapsed the leading presentation envelope.');
  }
  return { ok: true, artifact: { kind: 'patches', mode: 'repair', patches }, cardOutcomes: data.cardOutcomes, evidence };
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
  mode = '', sourceHash = '', snapshotHash = '', diagnosisHash = '', candidateHash = '', evidence = []
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
  const redirectChecks = mode === 'redirect'
    ? validateRedirectVerificationChecks(data.checks, known, data.decision)
    : { ok: true, checks: [] };
  if (!redirectChecks.ok) return redirectChecks;
  return {
    ok: true,
    decision: data.decision,
    checks: redirectChecks.checks,
    evidenceRefs: array(data.evidenceRefs).map(String),
    reason: safeText(data.reason || '', 600)
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

export function buildEditorialDiagnosisRequest({ mode = '', sourceText = '', sourceHash = '', snapshotHash = '', snapshot = {}, lane = '', retry = null } = {}) {
  const evidence = buildEditorialEvidence(snapshot, sourceText);
  const preservedSource = preservedText(sourceText, MAX_SOURCE);
  const presentationEnvelope = leadingPresentationEnvelope(sourceText);
  const validPreservationEvidenceIds = evidence
    .filter((entry) => !['source-draft', 'source-negative'].includes(entry.authority))
    .map((entry) => entry.id);
  const correction = retry
    ? [
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
        'Treat the latest user-turn evidence as completed player-authored action or dialogue that the assistant response must answer. Never replay, paraphrase, or assign that completed user content to the candidate response.',
        'Pair established non-source evidence with the conflicting source passages.',
        'Define one supported replacement objective, required beats, and forbidden source beats.',
        'If the latest user turn proposes or requests an action, moving it behind another task, location change, check, conversation, or future beat is a deferral unless frozen non-source evidence independently requires that delay.',
        'When the source defers an evidence-supported immediate want, identify the deferral in sourceFailure and forbiddenSourceBeats; the replacement objective and required beats must engage the request in the current turn.',
        'List every character established as present by frozen evidence.',
        'When an immediate want is unsupported, immediateWant must be null, wantEvidenceRefs and sourceEvidenceRefs must both be empty arrays, and sourcePressureEffect must be unclear.',
        'When an immediate want is supported, immediateWant must be a non-empty string, wantEvidenceRefs must cite established non-source evidence, and sourceEvidenceRefs must cite source-draft evidence.',
        'Character pressure is advisory evidence; do not require every character to speak or act.'
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
    ...(presentationEnvelope ? ['Preserve the presentation envelope exactly: keep the leading scene header unchanged and retain a blank line before body prose.'] : []),
    ...correction,
    `<source_hash>${safeText(sourceHash, 180)}</source_hash>`,
    `<snapshot_hash>${safeText(snapshotHash, 180)}</snapshot_hash>`,
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
    validEvidenceIds: evidence.map((entry) => entry.id),
    validPreservationEvidenceIds
  };
}

export function buildEditorialPassRequest({ mode = '', sourceText = '', sourceHash = '', snapshotHash = '', diagnosis = {}, evidence = [], snapshot = {}, targets = {}, lane = '', retry = null } = {}) {
  const full = FULL_MODES.has(mode);
  const preservedSource = preservedText(sourceText, MAX_SOURCE);
  const presentationEnvelope = leadingPresentationEnvelope(sourceText);
  const targetList = Object.values(targets || {}).flat().map((entry) => ({ id: entry.id, domain: entry.domain, before: entry.before })).slice(0, 120);
  const validPreservationEvidenceIds = array(evidence)
    .filter((entry) => !['source-draft', 'source-negative'].includes(entry?.authority))
    .map((entry) => String(entry?.id || ''))
    .filter(Boolean);
  const requiredPreservationLedger = array(diagnosis?.brief?.preserve).map((entry) => ({
    claim: String(entry?.claim || ''),
    evidenceRefs: array(entry?.evidenceRefs).map(String)
  }));
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
        'The validated Redirect diagnosis is authoritative.',
        'Rebuild the response around diagnosis.brief.replacementObjective.',
        'Include the supported substance of every required beat.',
        'Do not weaken an active required beat into passive attention, agreement, observation, or internal feeling.',
        'Do not preserve any forbidden source beat, even with different wording.',
        'Planning to act after another task, check, location change, or future beat still preserves a forbidden deferral; engage a current-turn required beat directly.',
        'Use diagnosis.brief.characterPressure as advisory dramatic evidence. Rising pressure makes a stronger response more likely but never mandatory.',
        'Silence, restraint, refusal, and delayed action remain valid when supported.',
        'Do not distribute dialogue or action as a checklist, and do not invent a want for an unclear character.',
        'candidate.changeLedger must contain at least one entry with kind redirect, and each Redirect ledger entry must cite the replacement objective or a required beat.',
        'A lexical rewrite that preserves the source objective or beat plan is not a Redirect.'
      ]
    : [];
  const prompt = [
    'Return only one valid Recursion Editorial Pass JSON object.',
    `Selected mode: ${mode}.`,
    full ? 'Return one complete candidate. You may replace every source sentence when the validated diagnosis supports it.' : 'Return only exact non-overlapping replacements for supplied targets.',
    mode === 'redirect' ? 'The source may be negative evidence. Preserve only facts supported by frozen evidence.' : 'Preserve supported facts, commitments, constraints, and the user turn while improving execution.',
    'The diagnosis below is authoritative. Do not add a new diagnosis or revise its preservation/discard decisions.',
    `Copy diagnosis.brief.preserve exactly into candidate.preservationLedger: ${JSON.stringify(requiredPreservationLedger)}. Do not add, remove, or rewrite preservation claims or evidence IDs.`,
    'Every preservation claim, major change, patch, and card outcome must cite only supplied evidence IDs.',
    ...redirectRules,
    ...(presentationEnvelope ? ['Preserve the presentation envelope exactly: keep the leading scene header unchanged and retain a blank line before body prose.'] : []),
    ...correction,
    `<source_hash>${safeText(sourceHash, 180)}</source_hash>`,
    `<snapshot_hash>${safeText(snapshotHash, 180)}</snapshot_hash>`,
    `<diagnosis>${JSON.stringify(diagnosis)}</diagnosis>`,
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
    installedCardIds: array(snapshot?.installedHand).map((card) => String(card?.cardId || card?.id || '')).filter(Boolean),
    validTargetIds: targetList.map((entry) => String(entry.id || '')).filter(Boolean)
  };
}

export function buildEditorialVerificationRequest({ mode = '', sourceHash = '', snapshotHash = '', diagnosisHash = '', diagnosis = null, evidence = [], candidate = {}, lane = '' } = {}) {
  const candidateHash = hashJson(String(candidate?.text || ''));
  const redirectRules = mode === 'redirect'
    ? [
        'Cross-check the diagnosis against frozen evidence and the source failure; reject if its objective or beats merely rename, soften, or preserve the failed trajectory.',
        'Evaluate every required check against both the validated diagnosis and frozen evidence; do not invent a different objective.',
        `Return exactly ${REDIRECT_VERIFICATION_CHECKS.length} check results, one for each name below, in this order.`,
        ...REDIRECT_VERIFICATION_CHECKS.map((check, index) => `${index + 1}. ${check}`),
        'Required beats must be materially explicit in the candidate; adjacent or passive behavior is not equivalent to a required action.',
        'A plan to act after another task, check, location change, or future beat still retains a forbidden deferral, even when the wording differs from the source.',
        'Reject if the candidate omits any required beat, retains any forbidden source beat, or contradicts the advisory character-pressure map.'
      ]
    : [];
  const prompt = [
    'Return only accept or reject for this one editorial candidate.',
    'Do not rewrite, score, compare, rank, or propose another candidate.',
    `Mode: ${mode}.`,
    ...redirectRules,
    `<source_hash>${safeText(sourceHash, 180)}</source_hash>`,
    `<snapshot_hash>${safeText(snapshotHash, 180)}</snapshot_hash>`,
    `<diagnosis_hash>${safeText(diagnosisHash, 180)}</diagnosis_hash>`,
    `<candidate_hash>${safeText(candidateHash, 180)}</candidate_hash>`,
    ...(mode === 'redirect' ? [`<diagnosis>${JSON.stringify(object(diagnosis))}</diagnosis>`] : []),
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
    validEvidenceIds: array(evidence).map((entry) => String(entry?.id || '')).filter(Boolean)
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
