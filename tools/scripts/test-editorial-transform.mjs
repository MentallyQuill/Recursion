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
import { buildGenerationReviewTargets, publicGenerationReviewSnapshot } from '../../src/generation-review.mjs';

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
    promptText: 'Who can act, observe, interrupt, or be addressed.',
    packetRefs: ['card-Active-Cast-generated']
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
const emptyConfiguredReviewSnapshot = publicGenerationReviewSnapshot({
  installedHand: [],
  promptPacket: {
    cardEvidence: [{
      id: 'generated-evidence-only',
      family: 'Scene Frame',
      promptText: 'Generated packet evidence without a configured installed-card obligation.'
    }]
  }
});
assertDeepEqual(
  emptyConfiguredReviewSnapshot.installedHand,
  [],
  'an explicitly empty configured hand never promotes generated packet IDs into Editorial obligations'
);
const largeConfiguredCards = Array.from({ length: 52 }, (_, index) => ({
  cardId: `configured-card-${index + 1}`,
  name: `Configured Card ${index + 1}`,
  promptText: `Generic configured prompt ${index + 1}.`,
  packetRefs: [`generated-card-${(index % 20) + 1}`]
}));
const largePacketCards = Array.from({ length: 20 }, (_, index) => ({
  id: `generated-card-${index + 1}`,
  family: `Generated Family ${index + 1}`,
  promptText: `Generated scene-specific evidence ${index + 1}.`
}));
const largeConfiguredReviewSnapshot = publicGenerationReviewSnapshot({
  installedHand: largeConfiguredCards,
  promptPacket: { cardEvidence: largePacketCards }
});
assertEqual(largeConfiguredReviewSnapshot.installedHand.length, 52, 'Editorial snapshot preserves every configured card that contributed to the frozen hand');
assertEqual(largeConfiguredReviewSnapshot.promptPacket.cardEvidence.length, 20, 'Editorial snapshot preserves the complete supported generated packet ledger');
assert(
  largeConfiguredReviewSnapshot.installedHand[51].promptText.includes('Generated scene-specific evidence 12'),
  'configured cards beyond the old truncation boundary still receive generated packet evidence through packetRefs'
);
assertEqual(
  buildEditorialEvidence(largeConfiguredReviewSnapshot, sourceText).filter((entry) => entry.kind === 'installed-card').length,
  52,
  'Editorial evidence preserves every dynamic configured-card obligation beyond the old fixed boundary'
);
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
  longReviewEvidence.some((item) => item.id === 'card:source-template-card' && item.excerpt.includes("Keep Carter, O'Neill")),
  'Editorial evidence keeps the configured installed-card identity while using its generated packet content'
);
assert(
  !longReviewEvidence.some((item) => item.id === 'card:card-Active-Cast-generated'),
  'generated packet card IDs do not replace configured installed-card obligations'
);
assert(
  !longReviewEvidence.some((item) => item.id === 'card:source-template-card' && item.excerpt.includes('Who can act, observe, interrupt')),
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
  mode: 'redirect',
  diagnosis: [],
  preserve: [],
  discard: [],
  allowedChanges: [],
  forbiddenChanges: [],
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
  schema: diagnosis.schema,
  mode: 'redirect',
  sourceHash: diagnosis.sourceHash,
  snapshotHash: diagnosis.snapshotHash,
  decision,
  sourceFailure: brief.sourceFailure,
  replacementObjective: brief.replacementObjective,
  requiredBeats: brief.requiredBeats,
  forbiddenSourceBeats: brief.forbiddenSourceBeats,
  sceneCharacters: brief.sceneCharacters,
  characterPressure: brief.characterPressure
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
assert(missingRedirectObjective.error?.message.includes('replacementObjective'), 'Redirect objective failure names the exact invalid field');
const missingRequiredBeats = validateEditorialDiagnosis(redirectDiagnosis({ ...validRedirectBrief, requiredBeats: [] }), redirectFixture);
assertEqual(missingRequiredBeats.error?.code, REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect proceed requires a supported beat');
assert(missingRequiredBeats.error?.message.includes('requiredBeats'), 'Redirect required-beat failure names the exact invalid field');
const missingForbiddenBeats = validateEditorialDiagnosis(redirectDiagnosis({ ...validRedirectBrief, forbiddenSourceBeats: [] }), redirectFixture);
assertEqual(missingForbiddenBeats.error?.code, REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect proceed requires a forbidden source beat');
assert(missingForbiddenBeats.error?.message.includes('forbiddenSourceBeats'), 'Redirect forbidden-beat failure names the exact invalid field');
const normalizedRedirectCategory = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sourceFailure: { ...validRedirectBrief.sourceFailure, category: 'immediate-test-deferred' }
}), redirectFixture);
assertEqual(normalizedRedirectCategory.ok, true, 'Redirect accepts an evidence-complete source failure with a noisy audit category');
assertEqual(normalizedRedirectCategory.value?.brief?.sourceFailure?.category, 'core-direction', 'Redirect canonicalizes an unknown audit category');
const missingSourceFailureProblem = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sourceFailure: { ...validRedirectBrief.sourceFailure, problem: '' }
}), redirectFixture);
assertEqual(missingSourceFailureProblem.error?.code, REDIRECT_ERROR_CODES.BRIEF_INVALID, 'Redirect still rejects a source failure without substantive problem text');
assert(missingSourceFailureProblem.error?.message.includes('sourceFailure.problem'), 'Redirect source-failure error identifies missing problem text');
const sourceGroundedFailure = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sourceFailure: { ...validRedirectBrief.sourceFailure, establishedEvidenceRefs: ['source:0'] }
}), redirectFixture);
assertEqual(sourceGroundedFailure.ok, true, 'known source evidence reaches the semantic verifier instead of failing deterministically');
assertDeepEqual(sourceGroundedFailure.value?.brief?.sourceFailure?.establishedEvidenceRefs, ['source:0'], 'diagnosis preserves source-grounded claims for verifier review');
const authoritativeConflict = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sourceFailure: { ...validRedirectBrief.sourceFailure, conflictingSourceRefs: ['user:0'] }
}), redirectFixture);
assertEqual(authoritativeConflict.ok, true, 'known authoritative evidence in a conflict field reaches the semantic verifier');
assertDeepEqual(authoritativeConflict.value?.brief?.sourceFailure?.conflictingSourceRefs, ['user:0'], 'diagnosis does not rewrite conflict citations before verification');
const sourceGroundedObjective = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  replacementObjective: { ...validRedirectBrief.replacementObjective, evidenceRefs: ['source:0'] }
}), redirectFixture);
assertEqual(sourceGroundedObjective.ok, true, 'source-grounded replacement objective reaches the semantic verifier');
assertDeepEqual(sourceGroundedObjective.value?.brief?.replacementObjective?.evidenceRefs, ['source:0'], 'diagnosis preserves objective citations for verifier judgment');
const fabricatedObjectiveReference = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  replacementObjective: { ...validRedirectBrief.replacementObjective, evidenceRefs: ['fabricated:0'] }
}), redirectFixture);
assertEqual(fabricatedObjectiveReference.ok, true, 'fabricated evidence id is recoverable bookkeeping before verification');
assertDeepEqual(
  fabricatedObjectiveReference.value?.brief?.replacementObjective?.evidenceRefs,
  [],
  'fabricated objective reference is removed without substitution'
);
assertEqual(
  fabricatedObjectiveReference.diagnostics?.referenceIssues?.[0]?.path,
  'replacementObjective.evidenceRefs[0]',
  'fabricated objective reference reports its exact field path'
);
assertEqual(
  fabricatedObjectiveReference.diagnostics?.referenceIssues?.[0]?.reference,
  'fabricated:0',
  'fabricated objective reference diagnostic preserves the bounded identifier'
);
const fabricatedRequiredBeatReference = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  requiredBeats: [{
    ...validRedirectBrief.requiredBeats[0],
    evidenceRefs: ['missing:beat']
  }]
}), redirectFixture);
assertEqual(fabricatedRequiredBeatReference.ok, true, 'unknown required-beat reference reaches the verifier');
assertDeepEqual(fabricatedRequiredBeatReference.value?.brief?.requiredBeats[0]?.evidenceRefs, [], 'unknown required-beat reference is removed');
assertEqual(
  fabricatedRequiredBeatReference.diagnostics?.referenceIssues?.[0]?.path,
  'requiredBeats[0].evidenceRefs[0]',
  'unknown required-beat reference reports its exact nested path'
);
const mixedAuthorityRedirect = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sourceFailure: {
    ...validRedirectBrief.sourceFailure,
    establishedEvidenceRefs: ['user:0', 'source:0'],
    conflictingSourceRefs: ['source:0', 'user:0']
  },
  replacementObjective: {
    ...validRedirectBrief.replacementObjective,
    evidenceRefs: ['user:0', 'source:0']
  },
  requiredBeats: [{
    ...validRedirectBrief.requiredBeats[0],
    evidenceRefs: ['user:0', 'source:0']
  }],
  forbiddenSourceBeats: [{
    ...validRedirectBrief.forbiddenSourceBeats[0],
    sourceRefs: ['source:0', 'user:0']
  }],
  sceneCharacters: [{
    ...validRedirectBrief.sceneCharacters[0],
    evidenceRefs: ['user:0', 'source:0']
  }]
}), redirectFixture);
assertEqual(mixedAuthorityRedirect.ok, true, 'Redirect preserves known mixed-authority citations for semantic verification');
assertDeepEqual(
  mixedAuthorityRedirect.value?.brief?.sourceFailure?.establishedEvidenceRefs,
  ['user:0', 'source:0'],
  'Redirect source failure citations remain unfiltered'
);
assertDeepEqual(
  mixedAuthorityRedirect.value?.brief?.sourceFailure?.conflictingSourceRefs,
  ['source:0', 'user:0'],
  'Redirect source conflict citations remain unfiltered'
);
assertDeepEqual(
  mixedAuthorityRedirect.value?.brief?.replacementObjective?.evidenceRefs,
  ['user:0', 'source:0'],
  'Redirect objective citations remain unfiltered'
);
assertDeepEqual(
  mixedAuthorityRedirect.value?.brief?.requiredBeats[0]?.evidenceRefs,
  ['user:0', 'source:0'],
  'Redirect required-beat citations remain unfiltered'
);
assertDeepEqual(
  mixedAuthorityRedirect.value?.brief?.forbiddenSourceBeats[0]?.sourceRefs,
  ['source:0', 'user:0'],
  'Redirect forbidden-beat citations remain unfiltered'
);
assertDeepEqual(
  mixedAuthorityRedirect.value?.brief?.sceneCharacters[0]?.evidenceRefs,
  ['user:0', 'source:0'],
  'Redirect scene-character citations remain unfiltered'
);
const recoveredSceneCharacterEvidence = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sceneCharacters: [{
    character: 'She',
    evidenceRefs: ['source:0']
  }]
}), redirectFixture);
assertEqual(recoveredSceneCharacterEvidence.ok, true, 'Redirect leaves a known scene-character citation for semantic verification');
assertDeepEqual(
  recoveredSceneCharacterEvidence.value?.brief?.sceneCharacters[0]?.evidenceRefs,
  ['source:0'],
  'Redirect does not replace provider-authored scene-character evidence'
);
const unsupportedSceneCharacter = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sceneCharacters: [{
    character: 'Unmentioned Character',
    evidenceRefs: ['source:0']
  }],
  characterPressure: [{
    ...validRedirectBrief.characterPressure[0],
    character: 'Unmentioned Character'
  }]
}), redirectFixture);
assertEqual(unsupportedSceneCharacter.ok, true, 'scene-character relevance is judged by the verifier rather than deterministic name matching');
const duplicateSceneCharacter = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sceneCharacters: [...validRedirectBrief.sceneCharacters, { character: 'She', evidenceRefs: ['user:0'] }]
}), redirectFixture);
assertEqual(duplicateSceneCharacter.ok, true, 'duplicate semantic character coverage reaches the verifier');
const mismatchedPressureCharacter = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  characterPressure: [{ ...validRedirectBrief.characterPressure[0], character: 'He' }]
}), redirectFixture);
assertEqual(mismatchedPressureCharacter.ok, true, 'Redirect preserves a mismatched advisory pressure row for verifier judgment');
assertDeepEqual(
  mismatchedPressureCharacter.value?.brief?.characterPressure[0],
  { ...validRedirectBrief.characterPressure[0], character: 'He' },
  'Redirect does not deterministically rewrite semantic pressure evidence'
);
assertEqual(validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  sceneCharacters: [{ character: ' ', evidenceRefs: ['user:0'] }],
  characterPressure: [{ ...validRedirectBrief.characterPressure[0], character: ' ' }]
}), redirectFixture).error?.code, REDIRECT_ERROR_CODES.CHARACTER_COVERAGE_INVALID, 'Redirect character names cannot be empty');
const unsupportedWantPressure = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  characterPressure: [{ ...validRedirectBrief.characterPressure[0], wantEvidenceRefs: ['source:0'] }]
}), redirectFixture);
assertEqual(unsupportedWantPressure.ok, true, 'known source-side want evidence reaches the verifier');
assertEqual(unsupportedWantPressure.value?.brief?.characterPressure[0].immediateWant, 'Learn who sent him.', 'runtime preserves the provider-authored immediate want');
const unsupportedEffectPressure = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  characterPressure: [{ ...validRedirectBrief.characterPressure[0], sourceEvidenceRefs: ['user:0'] }]
}), redirectFixture);
assertEqual(unsupportedEffectPressure.ok, true, 'known authoritative pressure-effect evidence reaches the verifier');
assertEqual(unsupportedEffectPressure.value?.brief?.characterPressure[0].sourcePressureEffect, 'increasing', 'runtime preserves the provider-authored pressure effect');
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
const noisyUnknownPressure = validateEditorialDiagnosis(redirectDiagnosis({
  ...unclearPressureBrief,
  characterPressure: [{ ...unclearPressureBrief.characterPressure[0], sourcePressureEffect: 'increasing' }]
}), redirectFixture);
assertEqual(noisyUnknownPressure.ok, true, 'inconsistent advisory pressure reaches semantic verification');
assertEqual(noisyUnknownPressure.value?.brief?.characterPressure[0].sourcePressureEffect, 'increasing', 'runtime does not canonicalize semantic pressure claims');
const blankPressureEffect = validateEditorialDiagnosis(redirectDiagnosis({
  ...validRedirectBrief,
  characterPressure: [{
    character: 'She',
    immediateWant: 'Learn who sent him.',
    wantEvidenceRefs: ['user:0'],
    sourcePressureEffect: '',
    sourceEvidenceRefs: [],
    pressureReason: ''
  }]
}), redirectFixture);
assertEqual(blankPressureEffect.ok, true, 'blank advisory pressure effect does not invalidate an otherwise usable Redirect diagnosis');
assertEqual(
  blankPressureEffect.value?.brief?.characterPressure[0].sourcePressureEffect,
  'unclear',
  'blank advisory pressure effect normalizes to explicit uncertainty without inventing semantics'
);
assertDeepEqual(
  blankPressureEffect.diagnostics?.structureIssues,
  [{
    code: 'RECURSION_EDITORIAL_REDIRECT_PRESSURE_NORMALIZED',
    path: 'characterPressure[0].sourcePressureEffect',
    received: ''
  }],
  'blank advisory pressure normalization emits a path-specific verifier diagnostic'
);
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
    preservationLedger: [],
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
const expandedRedirectCandidate = {
  ...redirectCandidate,
  candidate: {
    ...redirectCandidate.candidate,
    text: `She answered the supported question directly. ${'The replacement turn advanced the scene with grounded detail. '.repeat(32)}`
  }
};
assert(
  expandedRedirectCandidate.candidate.text.length > Math.max(1500, Math.ceil(sourceText.length * 1.75)),
  'expanded Redirect fixture exceeds the proportional Recompose budget'
);
assertEqual(
  validateEditorialPass(expandedRedirectCandidate, redirectPassFixture).ok,
  true,
  'Redirect may expand beyond the source-relative Recompose cap while remaining inside the absolute candidate bound'
);
const oversizedRedirectCandidate = {
  ...redirectCandidate,
  candidate: {
    ...redirectCandidate.candidate,
    text: `She answered the supported question directly. ${'Grounded replacement detail. '.repeat(700)}`
  }
};
assertEqual(
  validateEditorialPass(oversizedRedirectCandidate, redirectPassFixture).error?.code,
  'RECURSION_EDITORIAL_CANDIDATE_TOO_LARGE',
  'Redirect still rejects candidates above the absolute candidate bound'
);
const redirectWithoutCardOutcomes = validateEditorialPass({
  ...redirectCandidate,
  cardOutcomes: []
}, redirectPassFixture);
assertEqual(redirectWithoutCardOutcomes.ok, true, 'Redirect does not discard a valid candidate because its audit-only card ledger is missing');
assertEqual(redirectWithoutCardOutcomes.partialFailed, false, 'Redirect audit reconstruction does not become a Repair partial-failed result');
assertDeepEqual(redirectWithoutCardOutcomes.unresolvedCardIds, [], 'Redirect audit reconstruction exposes no unresolved Repair rows');
assertDeepEqual(
  redirectWithoutCardOutcomes.cardOutcomes,
  [{
    cardId: 'relationship',
    status: 'partially-reflected',
    evidenceRefs: ['card:relationship']
  }],
  'Redirect canonicalizes missing card audit rows from the frozen installed hand'
);
const redirectWithInvalidCardOutcome = validateEditorialPass({
  ...redirectCandidate,
  cardOutcomes: [{
    cardId: 'relationship',
    status: 'invented-status',
    evidenceRefs: ['missing:evidence']
  }]
}, redirectPassFixture);
assertEqual(redirectWithInvalidCardOutcome.ok, true, 'Redirect replaces an invalid audit-only card row instead of rejecting the verified candidate');
assertDeepEqual(
  redirectWithInvalidCardOutcome.cardOutcomes,
  redirectWithoutCardOutcomes.cardOutcomes,
  'Redirect uses the same explicit fallback for malformed and missing card audit rows'
);
const redirectWithValidCardOutcome = validateEditorialPass(redirectCandidate, redirectPassFixture);
assertDeepEqual(
  redirectWithValidCardOutcome.cardOutcomes,
  redirectCandidate.cardOutcomes,
  'Redirect preserves valid provider-reported card outcomes unchanged'
);
const redirectWithInvalidRiskFlags = validateEditorialPass({
  ...redirectCandidate,
  candidate: {
    ...redirectCandidate.candidate,
    riskFlags: ['low-risk', 'continuity-risk']
  }
}, redirectPassFixture);
assertEqual(redirectWithInvalidRiskFlags.ok, true, 'invalid audit-only risk labels do not reject an otherwise valid Redirect candidate');
assertDeepEqual(
  redirectWithInvalidRiskFlags.artifact.candidate.riskFlags,
  ['continuity-risk'],
  'Editorial candidate validation retains recognized risk labels and drops unknown labels'
);
const redirectWithoutRiskFlags = validateEditorialPass({
  ...redirectCandidate,
  candidate: {
    ...redirectCandidate.candidate,
    riskFlags: undefined
  }
}, redirectPassFixture);
assertEqual(redirectWithoutRiskFlags.ok, true, 'missing audit-only risk labels do not reject an otherwise valid Redirect candidate');
assertDeepEqual(redirectWithoutRiskFlags.artifact.candidate.riskFlags, [], 'missing risk labels canonicalize to an empty audit list');
const recomposeWithoutCardOutcomes = validateEditorialPass({
  ...candidate,
  cardOutcomes: []
}, { mode: 'recompose', sourceText, sourceHash, snapshotHash, diagnosisHash, diagnosis, snapshot });
assertEqual(recomposeWithoutCardOutcomes.ok, false, 'Recompose retains strict installed-card coverage');
assertEqual(
  recomposeWithoutCardOutcomes.error?.code,
  'RECURSION_EDITORIAL_CARD_COVERAGE_MISSING',
  'Recompose still reports missing card coverage as a validation failure'
);
const duplicateCoverageSnapshot = {
  ...snapshot,
  installedHand: [
    ...snapshot.installedHand,
    {
      cardId: 'scene-constraint',
      categoryId: 'scene-constraint',
      name: 'Scene Constraint',
      promptText: 'Keep the sender unidentified.',
      selectionState: 'active'
    }
  ]
};
const duplicateCoverageTarget = buildGenerationReviewTargets(sourceText).prose[1];
const duplicateCoverageCandidate = {
  schema: EDITORIAL_PASS_SCHEMA,
  mode: 'repair',
  sourceHash,
  snapshotHash,
  diagnosisHash,
  cardOutcomes: [
    candidate.cardOutcomes[0],
    {
      ...candidate.cardOutcomes[0],
      status: 'repaired'
    }
  ],
  patches: [{
    id: duplicateCoverageTarget.id,
    before: duplicateCoverageTarget.before,
    after: 'He withheld the sender’s name and kept one hand near the latch.',
    domain: duplicateCoverageTarget.domain,
    evidenceRefs: ['source:0']
  }]
};
const recoveredRepairCoverage = validateEditorialPass(duplicateCoverageCandidate, {
  mode: 'repair',
  sourceText,
  sourceHash,
  snapshotHash,
  diagnosisHash,
  diagnosis,
  snapshot: duplicateCoverageSnapshot,
  targets: buildGenerationReviewTargets(sourceText),
  recoverCardCoverage: true
});
assertEqual(recoveredRepairCoverage.ok, true, 'post-correction Editorial pass preserves a safe candidate with incomplete card audit coverage');
assertEqual(recoveredRepairCoverage.partialFailed, true, 'recovered card audit coverage remains explicitly partial-failed');
assertDeepEqual(
  recoveredRepairCoverage.unresolvedCardIds,
  ['scene-constraint'],
  'post-correction recovery identifies only dynamically missing installed-card outcomes as unresolved'
);
assertDeepEqual(
  recoveredRepairCoverage.cardOutcomes,
  [
    candidate.cardOutcomes[0],
    {
      cardId: 'scene-constraint',
      status: 'partially-reflected',
      evidenceRefs: ['card:scene-constraint']
    }
  ],
  'post-correction recovery keeps one valid outcome and reconstructs the missing installed-card audit row'
);
assertEqual(
  validateEditorialPass({
    ...candidate,
    cardOutcomes: duplicateCoverageCandidate.cardOutcomes
  }, {
    mode: 'recompose',
    sourceText,
    sourceHash,
    snapshotHash,
    diagnosisHash,
    diagnosis,
    snapshot: duplicateCoverageSnapshot,
    recoverCardCoverage: true
  }).error?.code,
  'RECURSION_EDITORIAL_CARD_OUTCOME_INVALID',
  'Recompose never recovers incomplete card coverage because a full rewrite cannot apply partially'
);
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
assertDeepEqual(
  redirectDiagnosisRequest.validSourceEvidenceIds,
  evidence.filter((entry) => ['source-draft', 'source-negative'].includes(entry.authority)).map((entry) => entry.id),
  'Redirect diagnosis request exposes source-only evidence ids separately'
);
assert(redirectDiagnosisRequest.prompt.includes('Redirect is a turn-level correction, not a more aggressive Recompose.'), 'Redirect diagnosis prompt distinguishes trajectory from prose quality');
assert(redirectDiagnosisRequest.prompt.includes('Decision must be proceed because Redirect is already selected.'), 'Redirect diagnosis prompt gives one unambiguous valid decision');
assert(!redirectDiagnosisRequest.prompt.includes('Choose proceed, no-change, requires-recompose, or requires-redirect according to the selected mode.'), 'Redirect diagnosis prompt omits the contradictory generic decision list');
const redirectDiagnosisEnvelope = JSON.stringify({
  schema: 'recursion.editorialDiagnosis.v1',
  mode: 'redirect',
  sourceHash,
  snapshotHash,
  decision: 'proceed'
});
assert(
  redirectDiagnosisRequest.prompt.includes(redirectDiagnosisEnvelope),
  'Redirect diagnosis prompt shows the exact frozen top-level identity layout'
);
assert(
  redirectDiagnosisRequest.prompt.includes('Return exactly these Redirect top-level keys: schema, mode, sourceHash, snapshotHash, decision, sourceFailure, replacementObjective, requiredBeats, forbiddenSourceBeats, sceneCharacters, characterPressure.'),
  'Redirect diagnosis prompt names the complete flat provider contract'
);
assert(
  redirectDiagnosisRequest.prompt.includes('Do not return a brief object or the generic diagnosis, preserve, discard, allowedChanges, or forbiddenChanges fields.'),
  'Redirect diagnosis prompt excludes the unstable mixed-mode brief fields'
);
assert(
  redirectDiagnosisRequest.prompt.includes('Never put diagnosis prose, arrays, or Redirect content in schema, mode, sourceHash, snapshotHash, or decision.'),
  'Redirect diagnosis prompt protects frozen identity fields from field-shifted content'
);
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
assert(
  redirectDiagnosisRequest.prompt.includes('sourcePressureEffect must be exactly increasing, decreasing, unchanged, or unclear'),
  'Redirect diagnosis prompt enumerates the preferred advisory pressure effects'
);
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
assert(
  redirectDiagnosisCorrectionRequest.prompt.includes(redirectDiagnosisEnvelope),
  'Redirect diagnosis correction repeats the exact frozen top-level identity layout'
);
assert(
  redirectDiagnosisCorrectionRequest.prompt.includes('Never put diagnosis prose, arrays, or Redirect content in schema, mode, sourceHash, snapshotHash, or decision.'),
  'Redirect diagnosis correction repeats the identity-field protection'
);
assert(
  redirectDiagnosisCorrectionRequest.prompt.includes(`Every Redirect citation field may use these frozen evidence IDs: ${JSON.stringify(evidence.map((entry) => entry.id))}.`),
  'Redirect diagnosis correction exposes one complete known-id provenance set'
);
assert(
  !redirectDiagnosisCorrectionRequest.prompt.includes('Established evidenceRefs may use only these IDs:'),
  'Redirect diagnosis correction does not restore deterministic authority partitioning'
);
const passRequest = buildEditorialPassRequest({ mode: 'recompose', sourceText, sourceHash, snapshotHash, diagnosis, evidence, snapshot, lane: 'reasoner' });
assert(passRequest.prompt.includes('The diagnosis below is authoritative.'), 'transform prompt pins diagnosis');
assert(passRequest.prompt.includes('one complete candidate'), 'transform prompt allows full rewrite');
assertEqual(passRequest.responseLength, undefined, 'transform inherits the selected provider lane max tokens');
assertDeepEqual(passRequest.validEvidenceIds, evidence.map((entry) => entry.id), 'transform request exposes the frozen evidence ids as structured provider fields');
assertDeepEqual(passRequest.requiredPreservationLedger, diagnosis.brief.preserve, 'transform freezes the validated diagnosis preservation ledger');
assert(passRequest.prompt.includes('Copy diagnosis.brief.preserve exactly'), 'transform explicitly forbids invented preservation claims or evidence ids');
assertDeepEqual(passRequest.installedCardIds, ['relationship'], 'transform request exposes frozen installed card ids');
const cardCoverageCorrectionRequest = buildEditorialPassRequest({
  mode: 'recompose',
  sourceText,
  sourceHash,
  snapshotHash,
  diagnosis,
  evidence: buildEditorialEvidence(duplicateCoverageSnapshot, sourceText),
  snapshot: duplicateCoverageSnapshot,
  lane: 'reasoner',
  retry: {
    code: 'RECURSION_EDITORIAL_CARD_COVERAGE_MISSING',
    message: 'Editorial pass must report every installed card exactly once.'
  }
});
assert(
  cardCoverageCorrectionRequest.prompt.includes(
    'Return cardOutcomes in this exact cardId order, once each: ["relationship","scene-constraint"].'
  ),
  'Editorial correction names the complete frozen card ledger and exact output order'
);
const redirectPassRequest = buildEditorialPassRequest({
  mode: 'redirect',
  sourceText,
  sourceHash,
  snapshotHash,
  diagnosis: validRedirectDiagnosis.value,
  evidence,
  snapshot,
  lane: 'utility'
});
assert(
  redirectPassRequest.prompt.includes('Return exactly these Redirect top-level keys: schema, mode, sourceHash, snapshotHash, diagnosisHash, text.'),
  'Redirect transform prompt names the minimal flat pass contract'
);
const redirectReferenceDiagnostics = {
  referenceIssues: [{
    code: 'RECURSION_EDITORIAL_REDIRECT_REFERENCE_DROPPED',
    path: 'requiredBeats[0].evidenceRefs[0]',
    reference: 'missing:beat'
  }]
};
const redirectPassWithReferenceDiagnostics = buildEditorialPassRequest({
  mode: 'redirect',
  sourceText,
  sourceHash,
  snapshotHash,
  diagnosis: validRedirectDiagnosis.value,
  diagnosisDiagnostics: redirectReferenceDiagnostics,
  evidence,
  snapshot,
  lane: 'reasoner'
});
assert(
  redirectPassWithReferenceDiagnostics.prompt.includes('<diagnosis_diagnostics>'),
  'Redirect writer receives unresolved diagnosis-reference diagnostics'
);
assert(
  redirectPassWithReferenceDiagnostics.prompt.includes('requiredBeats[0].evidenceRefs[0]'),
  'Redirect writer receives the exact unresolved reference path'
);
assert(
  redirectPassRequest.prompt.includes('Do not return candidate, patches, changeLedger, cardOutcomes, preservationLedger, or riskFlags.'),
  'Redirect transform prompt excludes shared-mode and audit fields'
);
assert(
  redirectPassRequest.prompt.includes('Return candidate prose only in the top-level text field.'),
  'Redirect transform prompt prevents candidate prose from shifting into a nested object'
);
assertDeepEqual(
  redirectPassRequest.redirectChangeEvidenceRefs,
  ['user:0'],
  'Redirect transform request freezes objective evidence for the runtime-owned directional ledger'
);
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
  redirectRequest.prompt.includes('Recursion constructs the Redirect change ledger locally from the proposed diagnosis.'),
  'Redirect transformer prompt excludes provider-authored audit ledger work'
);
assert(
  redirectRequest.prompt.includes('the independent Verifier will judge whether it is supported'),
  'Redirect transformer executes the proposal without treating it as established semantic truth'
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
const redirectVerifierWithReferenceDiagnostics = buildEditorialVerificationRequest({
  mode: 'redirect',
  sourceHash,
  snapshotHash,
  diagnosisHash: redirectDiagnosisHash,
  diagnosis: validRedirectDiagnosis.value,
  diagnosisDiagnostics: redirectReferenceDiagnostics,
  evidence,
  candidate: redirectCandidate.candidate
});
assert(
  redirectVerifierWithReferenceDiagnostics.prompt.includes('requiredBeats[0].evidenceRefs[0]'),
  'Redirect verifier receives unresolved diagnosis-reference diagnostics'
);
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
  redirectVerifierRequest.prompt.includes('Return failedChecks as the list of every required check that fails or remains unclear. Return an empty list only when every check passes.'),
  'Redirect verifier prompt defines the compact failed-check contract'
);
assert(
  redirectVerifierRequest.prompt.includes('Treat the diagnosis as a proposal, not as established truth.'),
  'Redirect verifier owns semantic judgment over the proposed diagnosis'
);
assert(
  redirectVerifierRequest.prompt.includes('Fail diagnosis-evidence-grounded'),
  'Redirect verifier explicitly judges diagnosis evidence, feasibility, and user intent'
);
assertDeepEqual(
  redirectVerifierRequest.verificationEvidenceRefs,
  ['user:0'],
  'Redirect verifier request freezes authoritative evidence for locally constructed check rows'
);
const correctedRedirectVerifierRequest = buildEditorialVerificationRequest({
  mode: 'redirect',
  sourceHash,
  snapshotHash,
  diagnosisHash: redirectDiagnosisHash,
  diagnosis: validRedirectDiagnosis.value,
  evidence,
  candidate: redirectCandidate.candidate,
  retry: {
    code: REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID,
    message: 'Redirect verification returned an invalid status, evidence reference, or note.'
  }
});
assert(
  correctedRedirectVerifierRequest.prompt.includes('Editorial verification correction required.'),
  'Redirect verifier correction explicitly identifies the correction pass'
);
assert(
  correctedRedirectVerifierRequest.prompt.includes(REDIRECT_ERROR_CODES.VERIFICATION_CHECKS_INVALID),
  'Redirect verifier correction includes the precise validation error'
);
assert(
  correctedRedirectVerifierRequest.prompt.includes('failedChecks may use only the required check names listed below.'),
  'Redirect verifier correction freezes the allowed failed-check names'
);
assert(
  correctedRedirectVerifierRequest.prompt.includes('Return a corrected verdict for the same candidate; do not rewrite or replace the candidate.'),
  'Redirect verifier correction cannot mutate candidate content'
);
assert(
  redirectVerifierRequest.prompt.includes(`Evaluate all ${REDIRECT_VERIFICATION_CHECKS.length} required checks below.`),
  'Redirect verifier makes the semantic check coverage explicit'
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
