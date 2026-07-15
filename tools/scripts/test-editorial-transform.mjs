import {
  EDITORIAL_DIAGNOSIS_SCHEMA,
  EDITORIAL_PASS_SCHEMA,
  EDITORIAL_VERIFICATION_SCHEMA,
  buildEditorialEvidence,
  buildEditorialDiagnosisRequest,
  buildEditorialPassRequest,
  buildEditorialVerificationRequest,
  validateEditorialDiagnosis,
  validateEditorialPass,
  validateEditorialVerification,
  applyEditorialArtifact,
  editorialPassKey
} from '../../src/editorial-transform.mjs';
import { assert, assertEqual, assertDeepEqual } from '../../tests/helpers/assert.mjs';
import { hashJson } from '../../src/core.mjs';

const sourceText = 'She smiled. “Who sent you?” He told her the sender’s name, then reached for the latch.';
const snapshot = {
  installedHand: [{ cardId: 'relationship', categoryId: 'relationship', name: 'Relationship', promptText: 'Trust is strained, not broken.', selectionState: 'active' }],
  promptPacket: { constraints: ['Keep the sender unidentified.'], story: 'A tense doorway encounter.' },
  lastBrief: { userTurn: 'She closes the door and asks who sent him.' },
  storyForm: { tense: 'present', pov: 'third-limited' },
  pipeline: 'standard',
  context: {
    messages: [
      { mesid: 17, role: 'user', text: 'Who sent you?' },
      { mesid: 18, role: 'assistant', text: sourceText }
    ]
  },
  antiSlopProfileVersion: 'v1'
};
const evidence = buildEditorialEvidence(snapshot, sourceText);
const sourceHash = 'source-a';
const snapshotHash = 'snapshot-a';
const diagnosis = {
  schema: EDITORIAL_DIAGNOSIS_SCHEMA,
  mode: 'recompose',
  sourceHash,
  snapshotHash,
  decision: 'proceed',
  brief: {
    mode: 'recompose',
    diagnosis: [{ dimension: 'turn-fulfillment', problem: 'The reply answers with unsupported sender identity.', evidenceRefs: ['packet:constraint'] }],
    preserve: [{ claim: 'The sender remains unidentified.', evidenceRefs: ['packet:constraint'] }],
    discard: [{ claim: 'The source reveals the sender without support.', evidenceRefs: ['source:0'] }],
    allowedChanges: ['Rewrite opening and dialogue'],
    forbiddenChanges: ['Resolve the sender identity']
  }
};
const diagnosisHash = hashJson(diagnosis);
const candidate = {
  schema: EDITORIAL_PASS_SCHEMA,
  mode: 'recompose',
  sourceHash,
  snapshotHash,
  diagnosisHash,
  cardOutcomes: [{ cardId: 'relationship', status: 'honored', evidenceRefs: ['card:relationship'] }],
  candidate: {
    text: 'The latch clicked behind her. “Who sent you?” she asked. He looked past her shoulder instead of answering.',
    preservationLedger: [{ claim: 'The sender remains unidentified.', evidenceRefs: ['packet:constraint'] }],
    changeLedger: [{ kind: 'rewrite', summary: 'Made the question the opening pressure.', evidenceRefs: ['user:0'] }],
    riskFlags: ['none']
  }
};

assertEqual(EDITORIAL_DIAGNOSIS_SCHEMA, 'recursion.editorialDiagnosis.v1', 'diagnosis schema is stable');
assertEqual(EDITORIAL_PASS_SCHEMA, 'recursion.editorialPass.v1', 'pass schema is stable');
assertEqual(EDITORIAL_VERIFICATION_SCHEMA, 'recursion.editorialVerification.v1', 'verification schema is stable');
assert(evidence.some((item) => item.id === 'source:0' && item.authority === 'source-draft'), 'source evidence has editable authority');
assert(evidence.some((item) => item.id === 'packet:constraint' && item.authority === 'hard-constraint'), 'packet constraint has hard authority');
assert(evidence.some((item) => item.id === 'user:0' && item.excerpt === 'She closes the door and asks who sent him.'), 'latest user-turn evidence keeps the explicit brief turn');
assert(evidence.some((item) => item.id === 'message:17' && item.excerpt === 'Who sent you?'), 'bounded transcript messages receive provider-citable evidence ids');
assert(!evidence.some((item) => item.id === 'message:18'), 'active assistant draft cannot re-enter preservation evidence as an authoritative context message');
assert(!evidence.find((item) => item.id === 'context:0')?.excerpt.includes(sourceText), 'aggregate context evidence excludes the active assistant draft');

const diagnosisValidation = validateEditorialDiagnosis(diagnosis, { mode: 'recompose', sourceText, sourceHash, snapshotHash, snapshot });
assertEqual(diagnosisValidation.ok, true, 'valid diagnosis passes');
const sourcePreservation = validateEditorialDiagnosis({
  ...diagnosis,
  brief: { ...diagnosis.brief, preserve: [{ claim: 'Source-only invented fact', evidenceRefs: ['source:0'] }] }
}, { mode: 'recompose', sourceText, sourceHash, snapshotHash, snapshot });
assertEqual(sourcePreservation.ok, false, 'source-draft cannot preserve a fact');
const staleDiagnosis = validateEditorialDiagnosis(diagnosis, { mode: 'recompose', sourceText, sourceHash: 'stale', snapshotHash, snapshot });
assertEqual(staleDiagnosis.error.code, 'RECURSION_EDITORIAL_DIAGNOSIS_STALE', 'stale diagnosis rejected');

const passValidation = validateEditorialPass(candidate, { mode: 'recompose', sourceText, sourceHash, snapshotHash, diagnosisHash, diagnosis, snapshot });
assertEqual(passValidation.ok, true, 'full Recompose candidate passes without edit ratio cap');
const repairCandidate = validateEditorialPass({ ...candidate, mode: 'repair' }, { mode: 'repair', sourceText, sourceHash, snapshotHash, diagnosisHash, diagnosis, snapshot, targets: {} });
assertEqual(repairCandidate.ok, false, 'Repair rejects full candidate');
const badEvidence = validateEditorialPass({ ...candidate, candidate: { ...candidate.candidate, changeLedger: [{ kind: 'rewrite', summary: 'bad', evidenceRefs: ['missing'] }] } }, { mode: 'recompose', sourceText, sourceHash, snapshotHash, diagnosisHash, diagnosis, snapshot });
assertEqual(badEvidence.error.code, 'RECURSION_EDITORIAL_EVIDENCE_INVALID', 'unknown evidence rejected');
const inventedPreservation = validateEditorialPass({ ...candidate, candidate: { ...candidate.candidate, preservationLedger: [{ claim: 'Invented ledger claim.', evidenceRefs: ['user:0'] }] } }, { mode: 'recompose', sourceText, sourceHash, snapshotHash, diagnosisHash, diagnosis, snapshot });
assertEqual(inventedPreservation.error.code, 'RECURSION_EDITORIAL_PRESERVATION_LEDGER_MISMATCH', 'candidate cannot revise the validated diagnosis preservation ledger');
const staleCandidate = validateEditorialPass({ ...candidate, diagnosisHash: 'other' }, { mode: 'recompose', sourceText, sourceHash, snapshotHash, diagnosisHash, diagnosis, snapshot });
assertEqual(staleCandidate.error.code, 'RECURSION_EDITORIAL_DIAGNOSIS_STALE', 'candidate diagnosis mismatch rejected');

const formattedSourceText = '*Tuesday Morning | Diner, Los Angeles(?) | Overcast, 74 F*\n\nO\'Neill set his fork down. The diner stayed quiet.';
const formattedCandidateText = '*Tuesday Morning | Diner, Los Angeles(?) | Overcast, 74 F*\n\nO\'Neill placed his fork beside the plate. The diner stayed quiet.';
const formattedCandidate = {
  ...candidate,
  candidate: { ...candidate.candidate, text: formattedCandidateText }
};
const formattedValidation = validateEditorialPass(formattedCandidate, {
  mode: 'recompose',
  sourceText: formattedSourceText,
  sourceHash,
  snapshotHash,
  diagnosisHash,
  diagnosis,
  snapshot
});
assertEqual(formattedValidation.ok, true, 'Editorial accepts a candidate that preserves the leading scene-header boundary');
const collapsedHeaderValidation = validateEditorialPass({
  ...formattedCandidate,
  candidate: {
    ...formattedCandidate.candidate,
    text: "*Tuesday Morning | Diner, Los Angeles(?) | Overcast, 74 F* O'Neill placed his fork beside the plate."
  }
}, {
  mode: 'recompose',
  sourceText: formattedSourceText,
  sourceHash,
  snapshotHash,
  diagnosisHash,
  diagnosis,
  snapshot
});
assertEqual(collapsedHeaderValidation.ok, false, 'Editorial rejects a candidate that collapses prose into the scene header');
assertEqual(collapsedHeaderValidation.error.code, 'RECURSION_EDITORIAL_PRESENTATION_INVALID', 'Editorial rejects a candidate that collapses prose into the scene header');

const diagnosisRequest = buildEditorialDiagnosisRequest({ mode: 'recompose', sourceText, sourceHash, snapshotHash, snapshot, lane: 'reasoner' });
assert(diagnosisRequest.prompt.includes('Return only one valid Recursion Editorial Diagnosis JSON object.'), 'diagnosis prompt names contract');
assert(!diagnosisRequest.prompt.includes('Return a complete candidate'), 'diagnosis prompt cannot request candidate');
assert(diagnosisRequest.prompt.includes('Recompose can replace the entire response'), 'diagnosis prompt defines full-rewrite defects as recompose work');
assert(diagnosisRequest.prompt.includes('Never choose requires-redirect only for repetition'), 'diagnosis prompt prevents slop-only redirect misclassification');
assertEqual(diagnosisRequest.responseLength, undefined, 'diagnosis inherits the selected provider lane max tokens');
assertDeepEqual(diagnosisRequest.validEvidenceIds, evidence.map((entry) => entry.id), 'diagnosis request exposes the frozen evidence ids as structured provider fields');
const passRequest = buildEditorialPassRequest({ mode: 'recompose', sourceText, sourceHash, snapshotHash, diagnosis, evidence, snapshot, lane: 'reasoner' });
assert(passRequest.prompt.includes('The diagnosis below is authoritative.'), 'transform prompt pins diagnosis');
assert(passRequest.prompt.includes('one complete candidate'), 'transform prompt allows full rewrite');
assertEqual(passRequest.responseLength, undefined, 'transform inherits the selected provider lane max tokens');
assertDeepEqual(passRequest.validEvidenceIds, evidence.map((entry) => entry.id), 'transform request exposes the frozen evidence ids as structured provider fields');
assertDeepEqual(passRequest.requiredPreservationLedger, diagnosis.brief.preserve, 'transform freezes the validated diagnosis preservation ledger');
assert(passRequest.prompt.includes('Copy diagnosis.brief.preserve exactly'), 'transform explicitly forbids invented preservation claims or evidence ids');
assertDeepEqual(passRequest.installedCardIds, ['relationship'], 'transform request exposes frozen installed card ids');
const formattedPassRequest = buildEditorialPassRequest({ mode: 'recompose', sourceText: formattedSourceText, sourceHash, snapshotHash, diagnosis, evidence, snapshot, lane: 'reasoner' });
assertEqual(formattedPassRequest.sourceText, formattedSourceText, 'Editorial request preserves source whitespace as structured data');
assert(formattedPassRequest.prompt.includes(JSON.stringify(formattedSourceText)), 'Editorial prompt preserves source line breaks in a JSON string');
assert(formattedPassRequest.prompt.includes('Preserve the presentation envelope exactly'), 'Editorial prompt freezes the leading scene-header boundary');
const redirectRequest = buildEditorialPassRequest({ mode: 'redirect', sourceText, sourceHash, snapshotHash, diagnosis: { ...diagnosis, mode: 'redirect' }, evidence, snapshot });
assert(redirectRequest.prompt.includes('source may be negative evidence'), 'Redirect prompt allows source-negative evidence');
const verifierRequest = buildEditorialVerificationRequest({ mode: 'recompose', sourceHash, snapshotHash, diagnosisHash, evidence, candidate: candidate.candidate });
assert(verifierRequest.prompt.includes('Return only accept or reject'), 'verifier cannot write candidate');
assertEqual(verifierRequest.responseLength, undefined, 'verifier inherits the selected provider lane max tokens');

const verification = validateEditorialVerification({ schema: EDITORIAL_VERIFICATION_SCHEMA, sourceHash, snapshotHash, diagnosisHash, decision: 'accept', evidenceRefs: ['packet:constraint'] }, { sourceHash, snapshotHash, diagnosisHash, evidence });
assertEqual(verification.ok, true, 'accepted verifier result passes');
assertEqual(validateEditorialVerification({ schema: EDITORIAL_VERIFICATION_SCHEMA, sourceHash, snapshotHash, diagnosisHash, decision: 'rewrite' }, { sourceHash, snapshotHash, diagnosisHash, evidence }).ok, false, 'verifier cannot return rewrite');

assertDeepEqual(applyEditorialArtifact(sourceText, { kind: 'candidate', mode: 'recompose', text: candidate.candidate.text }), candidate.candidate.text, 'candidate application returns full text');
assert(editorialPassKey({ chatKey: 'chat', messageId: 1, sourceHash, snapshotHash, mode: 'recompose' }) !== editorialPassKey({ chatKey: 'chat', messageId: 1, sourceHash, snapshotHash, mode: 'repair' }), 'mode changes cache identity');

console.log('[pass] editorial transform');
