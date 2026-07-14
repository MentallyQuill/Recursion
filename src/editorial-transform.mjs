import { compact, hashJson, truncate } from './core.mjs';

export const EDITORIAL_DIAGNOSIS_SCHEMA = 'recursion.editorialDiagnosis.v1';
export const EDITORIAL_PASS_SCHEMA = 'recursion.editorialPass.v1';
export const EDITORIAL_VERIFICATION_SCHEMA = 'recursion.editorialVerification.v1';
export const EDITORIAL_EVIDENCE_VERSION = 'v1';

const MODES = new Set(['repair', 'recompose', 'redirect']);
const FULL_MODES = new Set(['recompose', 'redirect']);
const DIAGNOSIS_DECISIONS = Object.freeze({
  repair: new Set(['proceed', 'no-change', 'requires-recompose', 'requires-redirect']),
  recompose: new Set(['proceed', 'no-change', 'requires-redirect']),
  redirect: new Set(['proceed', 'no-change'])
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
  const userTurn = brief.userTurn || brief.userMessage || array(context.messages).find((message) => message?.role === 'user')?.content;
  addEvidence(entries, 'user:0', 'user-turn', 'continuity-fact', userTurn || 'No explicit user turn supplied.');
  for (const [index, constraint] of array(packet.constraints || packet.hardConstraints).entries()) {
    addEvidence(entries, `packet:constraint${index ? `:${index}` : ''}`, 'prompt-packet', 'hard-constraint', constraint);
  }
  if (packet.story || packet.scene || packet.summary) addEvidence(entries, 'packet:scene', 'prompt-packet', 'scene-support', packet.story || packet.scene || packet.summary);
  for (const [index, card] of array(data.installedHand).slice(0, 48).entries()) {
    const cardId = String(card?.cardId || card?.id || '').trim();
    if (!cardId) continue;
    addEvidence(entries, `card:${cardId}`, 'installed-card', card?.hardConstraint ? 'hard-constraint' : 'scene-support', card.promptText || card.description || card.name);
    if (index >= 47) break;
  }
  if (brief.userTurn || brief.userMessage) addEvidence(entries, 'brief:turn', 'last-brief', 'continuity-fact', brief.userTurn || brief.userMessage);
  if (Object.keys(storyForm).length) addEvidence(entries, 'story-form:0', 'story-form', 'hard-constraint', JSON.stringify(storyForm));
  for (const [index, sentence] of sourceSentences(source).entries()) addEvidence(entries, `source:${index}`, 'source-draft', 'source-draft', sentence);
  if (Object.keys(context).length) addEvidence(entries, 'context:0', 'context', 'continuity-fact', JSON.stringify(context));
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
  const data = object(result);
  if (data.schema !== EDITORIAL_DIAGNOSIS_SCHEMA) return fail('RECURSION_EDITORIAL_DIAGNOSIS_SCHEMA_MISMATCH', 'Editorial diagnosis returned the wrong schema.');
  if (data.mode !== mode || data.sourceHash !== sourceHash || data.snapshotHash !== snapshotHash) return fail('RECURSION_EDITORIAL_DIAGNOSIS_STALE', 'Editorial diagnosis does not match the frozen source.');
  if (!DIAGNOSIS_DECISIONS[data.mode]?.has(data.decision)) return fail('RECURSION_EDITORIAL_DIAGNOSIS_DECISION_INVALID', 'Editorial diagnosis returned an invalid decision for this mode.');
  const briefResult = validateEditorialBrief(data.brief, buildEditorialEvidence(snapshot, sourceText));
  if (!briefResult.ok) return briefResult;
  return { ok: true, value: { ...data, brief: briefResult.value }, hash: editorialDiagnosisHash({ ...data, brief: briefResult.value }) };
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
    if (!validateClaimList(data.candidate.preservationLedger, known)) return fail('RECURSION_EDITORIAL_EVIDENCE_INVALID', 'Candidate preservation ledger cited invalid evidence.');
    if (!Array.isArray(data.candidate.changeLedger) || data.candidate.changeLedger.length > 12 || data.candidate.changeLedger.some((entry) => !CHANGE_KINDS.has(entry?.kind) || !safeText(entry?.summary, MAX_CLAIM) || !refs(entry?.evidenceRefs, known))) return fail('RECURSION_EDITORIAL_EVIDENCE_INVALID', 'Candidate change ledger cited invalid evidence.');
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
  return { ok: true, artifact: { kind: 'patches', mode: 'repair', patches }, cardOutcomes: data.cardOutcomes, evidence };
}

export function validateEditorialVerification(result = {}, { sourceHash = '', snapshotHash = '', diagnosisHash = '', evidence = [] } = {}) {
  const data = object(result);
  if (data.schema !== EDITORIAL_VERIFICATION_SCHEMA || data.sourceHash !== sourceHash || data.snapshotHash !== snapshotHash || data.diagnosisHash !== diagnosisHash) return fail('RECURSION_EDITORIAL_VERIFICATION_STALE', 'Editorial verification does not match the candidate.');
  if (!['accept', 'reject'].includes(data.decision)) return fail('RECURSION_EDITORIAL_VERIFICATION_INVALID', 'Editorial verifier must return accept or reject.');
  if (data.evidenceRefs !== undefined && !refs(data.evidenceRefs, evidenceMap(evidence))) return fail('RECURSION_EDITORIAL_EVIDENCE_INVALID', 'Editorial verification cited unknown evidence.');
  return { ok: true, decision: data.decision, evidenceRefs: array(data.evidenceRefs).map(String), reason: safeText(data.reason || '', 600) };
}

function requestBase(schema, prompt, lane = '') {
  return {
    prompt,
    systemPrompt: `Return only one valid ${schema} JSON object. Do not emit prose, markdown, reasoning, or an alternate schema.`,
    responseSchema: schema,
    responseLength: 5000,
    machineJson: true,
    ...(lane ? { lane } : {}),
    reasoningCategory: 'editorial-transform',
    reasoningIntent: 'medium'
  };
}

export function buildEditorialDiagnosisRequest({ mode = '', sourceText = '', sourceHash = '', snapshotHash = '', snapshot = {}, lane = '' } = {}) {
  const evidence = buildEditorialEvidence(snapshot, sourceText);
  const prompt = [
    'Return only one valid Recursion Editorial Diagnosis JSON object.',
    `Selected mode: ${mode}.`,
    'Diagnose the completed response against frozen evidence before any candidate is written.',
    'Return no candidate text. Use source-draft evidence only to identify discardable material, never to preserve a fact.',
    'Choose proceed, no-change, requires-recompose, or requires-redirect according to the selected mode.',
    `<source_hash>${safeText(sourceHash, 180)}</source_hash>`,
    `<snapshot_hash>${safeText(snapshotHash, 180)}</snapshot_hash>`,
    `<evidence>${JSON.stringify(evidence)}</evidence>`,
    `<source>${safeText(sourceText, MAX_SOURCE)}</source>`
  ].join('\n');
  return { ...requestBase(EDITORIAL_DIAGNOSIS_SCHEMA, prompt, lane), sourceHash, snapshotHash, mode };
}

export function buildEditorialPassRequest({ mode = '', sourceText = '', sourceHash = '', snapshotHash = '', diagnosis = {}, evidence = [], snapshot = {}, targets = {}, lane = '' } = {}) {
  const full = FULL_MODES.has(mode);
  const targetList = Object.values(targets || {}).flat().map((entry) => ({ id: entry.id, domain: entry.domain, before: entry.before })).slice(0, 120);
  const prompt = [
    'Return only one valid Recursion Editorial Pass JSON object.',
    `Selected mode: ${mode}.`,
    full ? 'Return one complete candidate. You may replace every source sentence when the validated diagnosis supports it.' : 'Return only exact non-overlapping replacements for supplied targets.',
    mode === 'redirect' ? 'The source may be negative evidence. Preserve only facts supported by frozen evidence.' : 'Preserve supported facts, commitments, constraints, and the user turn while improving execution.',
    'The diagnosis below is authoritative. Do not add a new diagnosis or revise its preservation/discard decisions.',
    'Every preservation claim, major change, patch, and card outcome must cite only supplied evidence IDs.',
    `<source_hash>${safeText(sourceHash, 180)}</source_hash>`,
    `<snapshot_hash>${safeText(snapshotHash, 180)}</snapshot_hash>`,
    `<diagnosis>${JSON.stringify(diagnosis)}</diagnosis>`,
    `<evidence>${JSON.stringify(evidence)}</evidence>`,
    `<snapshot>${JSON.stringify(snapshot)}</snapshot>`,
    `<targets>${JSON.stringify(targetList)}</targets>`,
    `<source>${safeText(sourceText, MAX_SOURCE)}</source>`
  ].join('\n');
  return { ...requestBase(EDITORIAL_PASS_SCHEMA, prompt, lane), sourceHash, snapshotHash, mode, diagnosisHash: editorialDiagnosisHash(diagnosis) };
}

export function buildEditorialVerificationRequest({ mode = '', sourceHash = '', snapshotHash = '', diagnosisHash = '', evidence = [], candidate = {}, lane = '' } = {}) {
  const prompt = [
    'Return only accept or reject for this one editorial candidate.',
    'Do not rewrite, score, compare, rank, or propose another candidate.',
    `Mode: ${mode}.`,
    `<source_hash>${safeText(sourceHash, 180)}</source_hash>`,
    `<snapshot_hash>${safeText(snapshotHash, 180)}</snapshot_hash>`,
    `<diagnosis_hash>${safeText(diagnosisHash, 180)}</diagnosis_hash>`,
    `<evidence>${JSON.stringify(evidence)}</evidence>`,
    `<candidate>${JSON.stringify(candidate)}</candidate>`
  ].join('\n');
  return { ...requestBase(EDITORIAL_VERIFICATION_SCHEMA, prompt, lane), sourceHash, snapshotHash, diagnosisHash, mode };
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
