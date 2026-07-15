import * as editorialTransform from '../../src/editorial-transform.mjs';
import {
  EDITORIAL_DIAGNOSIS_SCHEMA,
  EDITORIAL_PASS_SCHEMA,
  EDITORIAL_VERIFICATION_SCHEMA,
  REDIRECT_ERROR_CODES,
  REDIRECT_VERIFICATION_CHECKS,
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

const validRedirectBrief = {
  ...diagnosis.brief,
  mode: 'redirect',
  sourceFailure: {
    category: 'turn-fulfillment',
    problem: 'The source postpones the requested response.',
    establishedEvidenceRefs: ['user:0', 'card:relationship'],
    conflictingSourceRefs: ['source:0']
  },
  replacementObjective: {
    summary: 'Answer the supported question in the current scene.',
    evidenceRefs: ['user:0']
  },
  requiredBeats: [{ summary: 'Visibly engage the supported question.', evidenceRefs: ['user:0'] }],
  forbiddenSourceBeats: [{ summary: 'Do not postpone the answer.', sourceRefs: ['source:0'] }],
  sceneCharacters: [{ character: 'She', evidenceRefs: ['user:0'] }],
  characterPressure: [{
    character: 'She',
    immediateWant: 'Learn who sent him.',
    wantEvidenceRefs: ['user:0'],
    sourcePressureEffect: 'increasing',
    sourceEvidenceRefs: ['source:0'],
    pressureReason: 'The source evades her explicit question.'
  }]
};
const redirectDiagnosis = (brief = validRedirectBrief, decision = 'proceed') => ({
  ...diagnosis,
  mode: 'redirect',
  decision,
  brief
});
const redirectFixture = { mode: 'redirect', sourceText, sourceHash, snapshotHash, snapshot };
const validRedirectDiagnosis = validateEditorialDiagnosis(redirectDiagnosis(), redirectFixture);
assertEqual(validRedirectDiagnosis.ok, true, 'complete Redirect diagnosis passes');
const missingRedirectObjective = validateEditorialDiagnosis(redirectDiagnosis({ ...validRedirectBrief, replacementObjective: null }), redirectFixture);
assertEqual(missingRedirectObjective.error?.code, REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect proceed requires replacement objective');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({ ...validRedirectBrief, requiredBeats: [] }), redirectFixture).error?.code, REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect proceed requires a supported beat');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({ ...validRedirectBrief, forbiddenSourceBeats: [] }), redirectFixture).error?.code, REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect proceed requires a forbidden source beat');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sourceFailure: { ...validRedirectBrief.sourceFailure, establishedEvidenceRefs: ['source:0'] }
}), redirectFixture).error?.code, REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'source draft cannot establish the source failure truth');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sourceFailure: { ...validRedirectBrief.sourceFailure, conflictingSourceRefs: ['user:0'] }
}), redirectFixture).error?.code, REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'source failure conflict must cite source evidence');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  replacementObjective: { ...validRedirectBrief.replacementObjective, evidenceRefs: ['source:0'] }
}), redirectFixture).error?.code, REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'source draft cannot establish a replacement objective');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sceneCharacters: [...validRedirectBrief.sceneCharacters, { character: 'She', evidenceRefs: ['user:0'] }]
}), redirectFixture).error?.code, REDIRECT_ERROR_CODES.CHARACTER_COVERAGE_INVALID, 'Redirect character coverage rejects duplicate characters');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  characterPressure: [{ ...validRedirectBrief.characterPressure[0], character: 'He' }]
}), redirectFixture).error?.code, REDIRECT_ERROR_CODES.CHARACTER_COVERAGE_INVALID, 'Redirect pressure coverage must match scene characters');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sceneCharacters: [{ character: ' ', evidenceRefs: ['user:0'] }],
  characterPressure: [{ ...validRedirectBrief.characterPressure[0], character: ' ' }]
}), redirectFixture).error?.code, REDIRECT_ERROR_CODES.CHARACTER_COVERAGE_INVALID, 'Redirect character names cannot be empty');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  characterPressure: [{ ...validRedirectBrief.characterPressure[0], wantEvidenceRefs: ['source:0'] }]
}), redirectFixture).error?.code, REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'source draft cannot establish a character want');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  characterPressure: [{ ...validRedirectBrief.characterPressure[0], sourceEvidenceRefs: ['user:0'] }]
}), redirectFixture).error?.code, REDIRECT_ERROR_CODES.EVIDENCE_INVALID, 'pressure effect must cite source evidence');
const unclearPressureBrief = {
  ...validRedirectBrief,
  characterPressure: [{
    character: 'She',
    immediateWant: null,
    wantEvidenceRefs: [],
    sourcePressureEffect: 'unclear',
    sourceEvidenceRefs: [],
    pressureReason: 'Frozen evidence does not establish an immediate want.'
  }]
};
assertEqual(validateEditorialDiagnosis(redirectDiagnosis(unclearPressureBrief), redirectFixture).ok, true, 'unclear want remains valid without invention');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...unclearPressureBrief,
  characterPressure: [{ ...unclearPressureBrief.characterPressure[0], sourcePressureEffect: 'increasing' }]
}), redirectFixture).error?.code, REDIRECT_ERROR_CODES.PRESSURE_INVALID, 'unclear want cannot claim a concrete pressure effect');
const noChangeRedirectBrief = {
  ...unclearPressureBrief,
  sourceFailure: null,
  replacementObjective: null,
  requiredBeats: [],
  forbiddenSourceBeats: []
};
assertEqual(validateEditorialDiagnosis(redirectDiagnosis(noChangeRedirectBrief, 'no-change'), redirectFixture).ok, true, 'Redirect no-change permits an unclear pressure map');
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({ ...noChangeRedirectBrief, sourceFailure: validRedirectBrief.sourceFailure }, 'no-change'), redirectFixture).error?.code, REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect no-change cannot carry a source failure');

const passValidation = validateEditorialPass(candidate, { mode: 'recompose', sourceText, sourceHash, snapshotHash, diagnosisHash, diagnosis, snapshot });
assertEqual(passValidation.ok, true, 'full Recompose candidate passes without edit ratio cap');
const redirectDiagnosisHash = validRedirectDiagnosis.hash;
const redirectCandidate = {
  ...candidate,
  mode: 'redirect',
  diagnosisHash: redirectDiagnosisHash,
  candidate: {
    ...candidate.candidate,
    text: 'She blocked the latch with one hand. "Who sent you?" she repeated, holding his gaze until he answered.',
    changeLedger: [{
      kind: 'redirect',
      summary: 'Rebuilt the turn around answering the supported question now.',
      evidenceRefs: ['user:0']
    }]
  }
};
const redirectPassFixture = {
  mode: 'redirect',
  sourceText,
  sourceHash,
  snapshotHash,
  diagnosisHash: redirectDiagnosisHash,
  diagnosis: validRedirectDiagnosis.value,
  snapshot
};
assertEqual(validateEditorialPass(redirectCandidate, redirectPassFixture).ok, true, 'evidence-backed directional Redirect candidate passes');
const ov1MinorRewrite = {
  ...redirectCandidate,
  candidate: {
    ...redirectCandidate.candidate,
    text: 'She smiled. "Who sent you?" He delayed the answer and kept one hand on the latch.',
    changeLedger: [{ kind: 'reorder', summary: 'Condensed the same source direction.', evidenceRefs: ['source:0'] }]
  }
};
assertEqual(
  validateEditorialPass(ov1MinorRewrite, redirectPassFixture).error?.code,
  REDIRECT_ERROR_CODES.CHANGE_MISSING,
  'Redirect rejects a Recompose-style condensation with no directional ledger'
);
const sourceOnlyRedirectLedger = {
  ...redirectCandidate,
  candidate: {
    ...redirectCandidate.candidate,
    changeLedger: [{ kind: 'redirect', summary: 'Claims a redirect using only the source.', evidenceRefs: ['source:0'] }]
  }
};
assertEqual(
  validateEditorialPass(sourceOnlyRedirectLedger, redirectPassFixture).error?.code,
  REDIRECT_ERROR_CODES.EVIDENCE_INVALID,
  'Redirect ledger must cite the replacement objective or required beats'
);
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
const redirectDiagnosisRequest = buildEditorialDiagnosisRequest({ mode: 'redirect', sourceText, sourceHash, snapshotHash, snapshot, lane: 'reasoner' });
assert(redirectDiagnosisRequest.prompt.includes('Redirect is a turn-level correction, not a more aggressive Recompose.'), 'Redirect diagnosis prompt distinguishes trajectory from prose quality');
assert(redirectDiagnosisRequest.prompt.includes('Pair established non-source evidence with the conflicting source passages.'), 'Redirect diagnosis prompt requires paired evidence');
assert(redirectDiagnosisRequest.prompt.includes('Use null and unclear when an immediate want cannot be supported.'), 'Redirect diagnosis prompt forbids invented wants');
assert(redirectDiagnosisRequest.prompt.includes('Character pressure is advisory evidence'), 'Redirect diagnosis prompt keeps pressure advisory');
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
const redirectRequest = buildEditorialPassRequest({ mode: 'redirect', sourceText, sourceHash, snapshotHash, diagnosis: validRedirectDiagnosis.value, evidence, snapshot });
assert(redirectRequest.prompt.includes('source may be negative evidence'), 'Redirect prompt allows source-negative evidence');
assert(redirectRequest.prompt.includes('Rebuild the response around diagnosis.brief.replacementObjective.'), 'Redirect transformer prompt requires a replacement trajectory');
assert(redirectRequest.prompt.includes('Do not preserve any forbidden source beat'), 'Redirect transformer prompt excludes forbidden source beats');
assert(redirectRequest.prompt.includes('Silence, restraint, refusal, and delayed action remain valid'), 'Redirect transformer prompt preserves supported restraint');
assert(redirectRequest.prompt.includes('A lexical rewrite that preserves the source objective or beat plan is not a Redirect.'), 'Redirect transformer prompt rejects minor rewrites');
assertEqual(typeof editorialTransform.editorialVerificationRequired, 'function', 'shared editorial verification policy is exported');
for (const level of ['low', 'medium', 'high', 'ultra']) {
  assertEqual(editorialTransform.editorialVerificationRequired('redirect', level), true, `Redirect verifies at ${level}`);
}
assertEqual(editorialTransform.editorialVerificationRequired('recompose', 'medium'), false, 'Medium Recompose remains direct');
assertEqual(editorialTransform.editorialVerificationRequired('recompose', 'high'), true, 'High Recompose verifies');
assertEqual(editorialTransform.editorialVerificationRequired('repair', 'ultra'), false, 'Repair does not use candidate verification');

const candidateHash = hashJson(candidate.candidate.text);
const verifierRequest = buildEditorialVerificationRequest({ mode: 'recompose', sourceHash, snapshotHash, diagnosisHash, evidence, candidate: candidate.candidate });
assert(verifierRequest.prompt.includes('Return only accept or reject'), 'verifier cannot write candidate');
assertEqual(verifierRequest.responseLength, undefined, 'verifier inherits the selected provider lane max tokens');
assertEqual(verifierRequest.candidateHash, candidateHash, 'verifier request binds exact candidate text');
assert(verifierRequest.prompt.includes(`<candidate_hash>${candidateHash}</candidate_hash>`), 'verifier prompt includes candidate identity');

const verification = validateEditorialVerification({ schema: EDITORIAL_VERIFICATION_SCHEMA, mode: 'recompose', sourceHash, snapshotHash, diagnosisHash, candidateHash, decision: 'accept', evidenceRefs: ['packet:constraint'] }, { mode: 'recompose', sourceHash, snapshotHash, diagnosisHash, candidateHash, evidence });
assertEqual(verification.ok, true, 'accepted verifier result passes');
assertEqual(validateEditorialVerification({ schema: EDITORIAL_VERIFICATION_SCHEMA, mode: 'recompose', sourceHash, snapshotHash, diagnosisHash, candidateHash, decision: 'rewrite' }, { mode: 'recompose', sourceHash, snapshotHash, diagnosisHash, candidateHash, evidence }).ok, false, 'verifier cannot return rewrite');

const redirectCandidateHash = hashJson(redirectCandidate.candidate.text);
const passingRedirectChecks = REDIRECT_VERIFICATION_CHECKS.map((check) => ({
  check,
  status: 'pass',
  evidenceRefs: ['user:0'],
  note: 'Supported by frozen evidence.'
}));
const redirectVerification = {
  schema: EDITORIAL_VERIFICATION_SCHEMA,
  mode: 'redirect',
  sourceHash,
  snapshotHash,
  diagnosisHash: redirectDiagnosisHash,
  candidateHash: redirectCandidateHash,
  decision: 'accept',
  checks: passingRedirectChecks
};
const redirectVerificationFixture = {
  mode: 'redirect',
  sourceHash,
  snapshotHash,
  diagnosisHash: redirectDiagnosisHash,
  candidateHash: redirectCandidateHash,
  evidence
};
assertEqual(validateEditorialVerification(redirectVerification, redirectVerificationFixture).ok, true, 'complete Redirect verification passes');
assertEqual(validateEditorialVerification({ ...redirectVerification, candidateHash: 'stale' }, redirectVerificationFixture).error?.code, 'RECURSION_EDITORIAL_VERIFICATION_STALE', 'verification binds exact candidate');
assertEqual(validateEditorialVerification({ ...redirectVerification, checks: passingRedirectChecks.slice(1) }, redirectVerificationFixture).error?.code, REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID, 'missing Redirect verifier check fails');
assertEqual(validateEditorialVerification({ ...redirectVerification, checks: [...passingRedirectChecks.slice(0, -1), passingRedirectChecks[0]] }, redirectVerificationFixture).error?.code, REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID, 'duplicate Redirect verifier check fails');
assertEqual(validateEditorialVerification({ ...redirectVerification, checks: passingRedirectChecks.map((entry, index) => index ? entry : { ...entry, check: 'unknown-check' }) }, redirectVerificationFixture).error?.code, REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID, 'unknown Redirect verifier check fails');
assertEqual(validateEditorialVerification({ ...redirectVerification, checks: passingRedirectChecks.map((entry, index) => index ? entry : { ...entry, evidenceRefs: ['missing'] }) }, redirectVerificationFixture).error?.code, REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID, 'Redirect verifier check rejects unknown evidence');
assertEqual(validateEditorialVerification({ ...redirectVerification, checks: passingRedirectChecks.map((entry, index) => index ? entry : { ...entry, note: '' }) }, redirectVerificationFixture).error?.code, REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID, 'Redirect verifier check requires a concise note');
const unclearRedirectChecks = passingRedirectChecks.map((entry, index) => index ? entry : { ...entry, status: 'unclear' });
assertEqual(validateEditorialVerification({ ...redirectVerification, checks: unclearRedirectChecks }, redirectVerificationFixture).error?.code, REDIRECT_ERROR_CODES.VERIFICATION_ACCEPT_INVALID, 'accept cannot contain unclear checks');
const rejectedRedirectVerification = validateEditorialVerification({ ...redirectVerification, decision: 'reject', checks: unclearRedirectChecks }, redirectVerificationFixture);
assertEqual(rejectedRedirectVerification.ok, true, 'structurally valid Redirect rejection remains a valid verifier result');
assertEqual(rejectedRedirectVerification.decision, 'reject', 'Redirect rejection preserves verifier decision');

assertDeepEqual(applyEditorialArtifact(sourceText, { kind: 'candidate', mode: 'recompose', text: candidate.candidate.text }), candidate.candidate.text, 'candidate application returns full text');
assert(editorialPassKey({ chatKey: 'chat', messageId: 1, sourceHash, snapshotHash, mode: 'recompose' }) !== editorialPassKey({ chatKey: 'chat', messageId: 1, sourceHash, snapshotHash, mode: 'repair' }), 'mode changes cache identity');

console.log('[pass] editorial transform');
