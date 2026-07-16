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
import { publicGenerationReviewSnapshot } from '../../src/generation-review.mjs';

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
const longReviewSnapshot = publicGenerationReviewSnapshot({
  installedHand: [{
    cardId: 'source-template-card',
    name: 'Present characters',
    promptText: 'Who can act, observe, interrupt, or be addressed.'
  }],
  promptPacket: {
    packetId: 'packet-sg1-regression',
    cardEvidence: [{
      id: 'card-Active-Cast-generated',
      family: 'Active Cast',
      promptText: "Keep Carter, O'Neill, Daniel, Teal'c, Will, and the EMH seated in the diner booth.",
      evidenceRefs: ['message:31']
    }],
    padding: 'packet-padding-'.repeat(800)
  },
  context: {
    messages: [
      ...Array.from({ length: 12 }, (_, index) => ({
        mesid: index + 10,
        role: index % 2 ? 'assistant' : 'user',
        text: `Bounded SG-1 context ${index} ${'context-padding '.repeat(80)}`
      })),
      {
        mesid: 32,
        role: 'user',
        text: 'Both good questions. The transport still reaches the intended destination.'
      }
    ]
  }
});
const longReviewEvidence = buildEditorialEvidence(longReviewSnapshot, sourceText);
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
assertEqual(typeof longReviewSnapshot.context, 'object', 'public review snapshot keeps bounded context structurally parseable');
assertEqual(typeof longReviewSnapshot.promptPacket, 'object', 'public review snapshot keeps prompt packet evidence structurally parseable');
assert(
  longReviewEvidence.some((item) => item.id === 'user:0' && item.excerpt.includes('Both good questions')),
  'long Editorial context preserves the actual latest user turn instead of the no-user fallback'
);
assert(
  longReviewEvidence.some((item) => item.id === 'card:card-Active-Cast-generated' && item.excerpt.includes("Keep Carter, O'Neill")),
  'Editorial evidence uses generated packet card content'
);
assert(
  !longReviewEvidence.some((item) => item.excerpt.includes('Who can act, observe, interrupt')),
  'generated packet evidence prevents generic source-card templates from poisoning Editorial diagnosis'
);
assert(
  !longReviewEvidence.some((item) => item.id === 'story-form:0'),
  'an absent story-form contract does not become empty authoritative evidence'
);
assert(evidence.some((item) => item.id === 'message:17' && item.excerpt === 'Who sent you?'), 'bounded transcript messages receive provider-citable evidence ids');
assert(!evidence.some((item) => item.id === 'message:18'), 'active assistant draft cannot re-enter preservation evidence as an authoritative context message');
assert(!evidence.some((item) => item.id === 'context:0'), 'Editorial evidence does not duplicate bounded transcript messages inside an aggregate context blob');

const longActiveDraft = `*Tuesday Morning | Diner | Overcast*\n\n${'Will continued drawing while Carter watched the pattern. '.repeat(80)}`;
const truncatedActiveDraftEvidence = buildEditorialEvidence({
  context: {
    messages: [
      { mesid: 31, role: 'user', text: 'We should test it.' },
      { mesid: 32, role: 'assistant', text: longActiveDraft.slice(0, 1800) }
    ]
  }
}, longActiveDraft);
assert(
  !truncatedActiveDraftEvidence.some((item) => item.id === 'message:32'),
  'a bounded prefix of the active assistant draft cannot re-enter authoritative context evidence'
);

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
const unsafeRedirectPreservation = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  preserve: [{ claim: 'Preserve a source-authored beat.', evidenceRefs: ['source:0'] }]
}), redirectFixture);
assertEqual(unsafeRedirectPreservation.ok, true, 'Redirect drops preservation claims that rely on source-draft evidence');
assertDeepEqual(unsafeRedirectPreservation.value?.brief?.preserve, [], 'Redirect never forwards an unsupported preservation claim to candidate generation');
const redundantRedirectDiagnosisList = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  diagnosis: [{ problem: '', evidenceRefs: ['missing:evidence'] }]
}), redirectFixture);
assertEqual(redundantRedirectDiagnosisList.ok, true, 'Redirect ignores the redundant generic diagnosis list');
assertDeepEqual(redundantRedirectDiagnosisList.value?.brief?.diagnosis, [], 'Redirect relies on the stricter sourceFailure contract instead of generic diagnosis entries');
const redundantRedirectDecision = validateEditorialDiagnosis(redirectDiagnosis(validRedirectBrief, 'requires-redirect'), redirectFixture);
assertEqual(redundantRedirectDecision.ok, true, 'explicit Redirect accepts requires-redirect as a proceed synonym');
assertEqual(redundantRedirectDecision.value?.decision, 'proceed', 'explicit Redirect canonicalizes requires-redirect to proceed');
for (const noisyDecision of ['no-change', 'requires-recompose', 'unexpected-value']) {
  const normalizedDecision = validateEditorialDiagnosis(redirectDiagnosis(validRedirectBrief, noisyDecision), redirectFixture);
  assertEqual(normalizedDecision.ok, true, `explicit Redirect ignores noisy diagnosis decision ${noisyDecision}`);
  assertEqual(normalizedDecision.value?.decision, 'proceed', `explicit Redirect freezes ${noisyDecision} to proceed`);
}
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
assertEqual(
  validateEditorialDiagnosis(redirectDiagnosis(noChangeRedirectBrief, 'no-change'), redirectFixture).error?.code,
  REDIRECT_ERROR_CODES.BRIEF_INVALID,
  'explicit Redirect rejects an empty no-change brief through required Redirect semantics'
);

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
assert(redirectDiagnosisRequest.prompt.includes('Decision must be proceed because Redirect is already selected.'), 'Redirect diagnosis prompt gives one unambiguous valid decision');
assert(!redirectDiagnosisRequest.prompt.includes('Choose proceed, no-change, requires-recompose, or requires-redirect according to the selected mode.'), 'Redirect diagnosis prompt omits the contradictory generic decision list');
assert(
  redirectDiagnosisRequest.prompt.includes('Treat the latest user-turn evidence as completed player-authored action or dialogue that the assistant response must answer'),
  'Redirect diagnosis prompt forbids replaying the completed user turn as candidate content'
);
assert(redirectDiagnosisRequest.prompt.includes('Pair established non-source evidence with the conflicting source passages.'), 'Redirect diagnosis prompt requires paired evidence');
assert(
  redirectDiagnosisRequest.prompt.includes('moving it behind another task, location change, check, conversation, or future beat is a deferral'),
  'Redirect diagnosis prompt treats renamed prerequisites as continued deferral'
);
assert(
  redirectDiagnosisRequest.prompt.includes('immediateWant must be null, wantEvidenceRefs and sourceEvidenceRefs must both be empty arrays, and sourcePressureEffect must be unclear'),
  'Redirect diagnosis prompt states the complete unknown-pressure tuple'
);
assert(redirectDiagnosisRequest.prompt.includes('Character pressure is advisory evidence'), 'Redirect diagnosis prompt keeps pressure advisory');
const redirectDiagnosisCorrectionRequest = buildEditorialDiagnosisRequest({
  mode: 'redirect',
  sourceText,
  sourceHash,
  snapshotHash,
  snapshot,
  retry: {
    code: REDIRECT_ERROR_CODES.PRESSURE_INVALID,
    message: 'Unclear character pressure cannot claim concrete evidence or effect.'
  }
});
assert(
  redirectDiagnosisCorrectionRequest.prompt.includes('immediateWant must be null, wantEvidenceRefs and sourceEvidenceRefs must both be empty arrays, and sourcePressureEffect must be unclear'),
  'Redirect diagnosis correction repeats the complete unknown-pressure tuple'
);
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
assert(
  redirectRequest.prompt.includes('Planning to act after another task, check, location change, or future beat still preserves a forbidden deferral'),
  'Redirect transformer prompt forbids paraphrased postponement'
);
assert(
  redirectRequest.prompt.includes('candidate.changeLedger must contain at least one entry with kind redirect'),
  'Redirect transformer prompt states the required directional ledger contract'
);
assert(
  redirectRequest.prompt.includes('Do not weaken an active required beat into passive attention, agreement, observation, or internal feeling'),
  'Redirect transformer preserves the action strength of an active required beat'
);
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
const redirectVerifierRequest = buildEditorialVerificationRequest({
  mode: 'redirect',
  sourceHash,
  snapshotHash,
  diagnosisHash: redirectDiagnosisHash,
  diagnosis: validRedirectDiagnosis.value,
  evidence,
  candidate: redirectCandidate.candidate
});
assert(
  redirectVerifierRequest.prompt.includes(`<diagnosis>${JSON.stringify(validRedirectDiagnosis.value)}</diagnosis>`),
  'Redirect verifier receives the complete validated diagnosis it must enforce'
);
assert(
  redirectVerifierRequest.prompt.includes('Cross-check the diagnosis against frozen evidence and the source failure'),
  'Redirect verifier independently checks that the diagnosis and candidate reverse the frozen source failure'
);
assert(
  redirectVerifierRequest.prompt.includes('A plan to act after another task, check, location change, or future beat still retains a forbidden deferral'),
  'Redirect verifier rejects renamed prerequisites and delayed-action paraphrases'
);
assert(
  redirectVerifierRequest.prompt.includes('Required beats must be materially explicit in the candidate; adjacent or passive behavior is not equivalent to a required action'),
  'Redirect verifier rejects passive substitutes for active required beats'
);
assert(
  redirectVerifierRequest.prompt.includes(`Return exactly ${REDIRECT_VERIFICATION_CHECKS.length} check results, one for each name below, in this order.`),
  'Redirect verifier makes the schema check cardinality explicit'
);
for (const [index, check] of REDIRECT_VERIFICATION_CHECKS.entries()) {
  assert(
    redirectVerifierRequest.prompt.includes(`${index + 1}. ${check}`),
    `Redirect verifier explicitly names required check ${check}`
  );
}

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

assertEqual(editorialTransform.EDITORIAL_EFFECTIVENESS_SCHEMA, 'recursion.redirectEffectivenessJudge.v1', 'Redirect effectiveness schema is stable');
assertDeepEqual(
  editorialTransform.REDIRECT_EFFECTIVENESS_CRITERIA,
  ['replacement-objective', 'forbidden-source-beats', 'character-pressure', 'evidence-and-constraints'],
  'Redirect effectiveness judge uses four independent criteria'
);
assertEqual(typeof editorialTransform.buildRedirectEffectivenessRequest, 'function', 'Redirect effectiveness request builder is exported');
assertEqual(typeof editorialTransform.validateRedirectEffectiveness, 'function', 'Redirect effectiveness validator is exported');
const effectivenessRequest = editorialTransform.buildRedirectEffectivenessRequest({
  scenarioId: 'redirect-turn-deferral',
  oracle: {
    expectedDecision: 'proceed',
    replacementObjective: 'Begin the supported test now.',
    requiredBeats: ['Carter engages the test.'],
    forbiddenSourceBeats: ['Postpone the test.'],
    pressureExpectations: [{ character: 'Carter', effect: 'increasing', responseRequired: false }]
  },
  snapshot,
  evidence,
  sourceText,
  candidateText: redirectCandidate.candidate.text,
  marker: { mode: 'redirect', verification: 'accept', candidateHash: redirectCandidateHash }
});
assertEqual(effectivenessRequest.sourceHash, hashJson(sourceText), 'effectiveness request hashes the frozen source');
assertEqual(effectivenessRequest.candidateHash, redirectCandidateHash, 'effectiveness request hashes the judged candidate');
assert(effectivenessRequest.prompt.includes('independent effectiveness judge'), 'effectiveness prompt does not replay the production verifier');
assert(effectivenessRequest.prompt.includes('Do not trust the production marker'), 'effectiveness prompt treats marker claims as untrusted evidence');
const passingEffectivenessCriteria = editorialTransform.REDIRECT_EFFECTIVENESS_CRITERIA.map((criterion) => ({
  criterion,
  status: 'pass',
  reason: 'The candidate meets this independent criterion.'
}));
const validEffectiveness = {
  schema: editorialTransform.EDITORIAL_EFFECTIVENESS_SCHEMA,
  scenarioId: effectivenessRequest.scenarioId,
  sourceHash: effectivenessRequest.sourceHash,
  candidateHash: effectivenessRequest.candidateHash,
  decision: 'pass',
  criteria: passingEffectivenessCriteria
};
assertEqual(editorialTransform.validateRedirectEffectiveness(validEffectiveness, effectivenessRequest).ok, true, 'complete independent judge result passes');
assertEqual(editorialTransform.validateRedirectEffectiveness({ ...validEffectiveness, criteria: passingEffectivenessCriteria.slice(1) }, effectivenessRequest).ok, false, 'missing effectiveness criterion fails');
assertEqual(editorialTransform.validateRedirectEffectiveness({ ...validEffectiveness, candidateHash: 'stale' }, effectivenessRequest).ok, false, 'effectiveness judge binds candidate hash');
assertEqual(editorialTransform.validateRedirectEffectiveness({ ...validEffectiveness, criteria: [...passingEffectivenessCriteria.slice(0, -1), passingEffectivenessCriteria[0]] }, effectivenessRequest).ok, false, 'duplicate effectiveness criterion fails');
assertEqual(editorialTransform.validateRedirectEffectiveness({ ...validEffectiveness, criteria: passingEffectivenessCriteria.map((entry, index) => index ? entry : { ...entry, status: 'fail' }) }, effectivenessRequest).ok, false, 'judge cannot report pass with a failed criterion');

assertDeepEqual(applyEditorialArtifact(sourceText, { kind: 'candidate', mode: 'recompose', text: candidate.candidate.text }), candidate.candidate.text, 'candidate application returns full text');
assert(editorialPassKey({ chatKey: 'chat', messageId: 1, sourceHash, snapshotHash, mode: 'recompose' }) !== editorialPassKey({ chatKey: 'chat', messageId: 1, sourceHash, snapshotHash, mode: 'repair' }), 'mode changes cache identity');

console.log('[pass] editorial transform');
