import {
  ANTI_SLOP_PROFILE_VERSION,
  GENERATION_REVIEW_SCHEMA,
  applyGenerationReviewPatches,
  buildGenerationReviewRequest,
  buildGenerationReviewTargets,
  eligibleGenerationReviewTargets,
  generationReviewKey,
  normalizeCardOutcomeStatus,
  validateGenerationReviewResult
} from '../../src/generation-review.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const sourceText = [
  'Mara felt it like a punch to the chest. "What do you want to do next?"',
  '',
  'She waited by the door, her breath caught.'
].join('\n');

const targets = buildGenerationReviewTargets(sourceText);
assertEqual(GENERATION_REVIEW_SCHEMA, 'recursion.generationReview.v1', 'generation review schema is stable');
assertEqual(ANTI_SLOP_PROFILE_VERSION, 'v1', 'anti-slop profile is versioned');
assertEqual(targets.dialogue.length, 1, 'targets preserve dialogue as a discrete patch target');
assertEqual(targets.prose.length, 2, 'targets split non-dialogue prose into deterministic sentence targets');
assertEqual(targets.beats.length, 2, 'targets preserve paragraph beats for bounded pacing repairs');
assertEqual(targets.dialogue[0].before, '"What do you want to do next?"', 'dialogue target retains exact source text');
assertEqual(eligibleGenerationReviewTargets(targets).some((target) => target.id.startsWith('beat:')), false, 'overlapping beat ranges remain review-only, not patchable');

const reviewSnapshot = {
  deck: { id: 'sg1', name: 'SG-1', revisionHash: 'deck-hash' },
  installedHand: [
    {
      cardId: 'room-boundary',
      categoryId: 'scene-frame',
      name: 'Room boundary',
      promptText: 'Keep the doorway boundary present when it changes the next beat.',
      selectionState: 'priority',
      packetRefs: ['guidance:3'],
      sourceCardIds: ['room-boundary']
    }
  ],
  promptPacket: { guidance: 'Keep the room boundary present.' },
  lastBrief: { summary: 'Mara blocks the exit.' },
  storyForm: { tense: 'past', pov: 'third-person-limited' },
  context: { contextMessages: [{ role: 'user', text: 'Will reaches for the door.' }] },
  antiSlopProfileVersion: ANTI_SLOP_PROFILE_VERSION
};

const request = buildGenerationReviewRequest({
  sourceText,
  sourceHash: 'source-hash',
  targets,
  reviewSnapshot,
  lane: 'reasoner'
});

assertEqual(request.responseSchema, GENERATION_REVIEW_SCHEMA, 'request carries generation-review schema');
assertEqual(request.machineJson, true, 'request requires machine JSON');
assert(request.prompt.includes('installed cards are review obligations'), 'prompt defines installed-card review boundary');
assert(request.prompt.includes('anti-slop'), 'prompt includes anti-slop review domain');
assert(request.prompt.includes('room-boundary'), 'prompt includes installed custom-card identity');
assert(request.prompt.includes('Return replacements only'), 'prompt forbids a full-message rewrite');

const validPatch = {
  schema: GENERATION_REVIEW_SCHEMA,
  sourceHash: 'source-hash',
  assessment: { turnFulfillment: { status: 'pass' } },
  reviewDomains: { turnFulfillment: 'pass', antiSlop: 'revised' },
  cardOutcomes: [{ cardId: 'room-boundary', status: 'honored', evidenceTargetIds: ['prose:2'] }],
  patches: [{
    id: 'prose:2',
    domain: 'anti-slop',
    before: 'She waited by the door, her breath caught.',
    after: 'She held at the doorway, hand still on the frame.',
    reason: 'Replaces a repeated physiological shorthand with visible hesitation.',
    cardRefs: ['room-boundary']
  }]
};

const accepted = validateGenerationReviewResult(validPatch, {
  sourceHash: 'source-hash',
  targets,
  reviewSnapshot
});
assertEqual(accepted.ok, true, 'validator accepts a bounded evidence-backed patch');
assertEqual(
  applyGenerationReviewPatches(sourceText, accepted.patches, targets),
  sourceText.replace('She waited by the door, her breath caught.', 'She held at the doorway, hand still on the frame.'),
  'patch application preserves all source text outside the target'
);

const badCard = validateGenerationReviewResult({
  ...validPatch,
  cardOutcomes: [{ cardId: 'inactive-card', status: 'honored', evidenceTargetIds: [] }]
}, { sourceHash: 'source-hash', targets, reviewSnapshot });
assertEqual(badCard.ok, false, 'validator rejects an outcome for a card not installed in the source packet');
assertEqual(badCard.error.code, 'RECURSION_GENERATION_REVIEW_CARD_NOT_INSTALLED', 'uninstalled-card rejection is explicit');

assertEqual(
  normalizeCardOutcomeStatus('not_applicable'),
  'not-applicable',
  'documented outcome aliases normalize before validation'
);

const missingCoverage = validateGenerationReviewResult({
  ...validPatch,
  cardOutcomes: []
}, { sourceHash: 'source-hash', targets, reviewSnapshot });
assertEqual(missingCoverage.ok, false, 'missing installed-card coverage is not accepted');
assertEqual(missingCoverage.error.code, 'RECURSION_GENERATION_REVIEW_CARD_COVERAGE_MISSING', 'missing coverage has a stable code');
assertEqual(missingCoverage.retryable, true, 'missing coverage is eligible for the one semantic correction');
assertEqual(missingCoverage.safePatches.length, 1, 'independently safe patch remains available for partial application');

const invalidTarget = validateGenerationReviewResult({
  ...validPatch,
  patches: [{ id: 'outside:target', domain: 'prose', before: 'Mara waited.', after: 'Mara held her ground.' }]
}, { sourceHash: 'source-hash', targets, reviewSnapshot });
assertEqual(invalidTarget.error.code, 'RECURSION_GENERATION_REVIEW_TARGET_INVALID', 'invalid patch target has a stable code');
assertEqual(invalidTarget.retryable, true, 'invalid patch target is eligible for the one semantic correction');
assert(invalidTarget.invalidTargetIds.includes(targets.prose[0].id), 'invalid patch target correction receives eligible targets');

const normalizedBefore = validateGenerationReviewResult({
  ...validPatch,
  patches: [{ ...validPatch.patches[0], before: 'She waited by the door.' }]
}, { sourceHash: 'source-hash', targets, reviewSnapshot });
assertEqual(normalizedBefore.ok, true, 'target ID remains authoritative when a model normalizes echoed before text');
assertEqual(normalizedBefore.patches[0].before, validPatch.patches[0].before, 'accepted patches retain the frozen target before text');

const normalizedOutcome = validateGenerationReviewResult({
  ...validPatch,
  cardOutcomes: [{ cardId: 'room-boundary', status: 'not_applicable', evidenceTargetIds: [] }]
}, { sourceHash: 'source-hash', targets, reviewSnapshot });
assertEqual(normalizedOutcome.ok, true, 'documented outcome alias validates');
assertEqual(normalizedOutcome.cardOutcomes[0].status, 'not-applicable', 'validator returns canonical outcome status');

const overlap = validateGenerationReviewResult({
  ...validPatch,
  patches: [
    validPatch.patches[0],
    {
      id: 'beat:2',
      domain: 'narrative-execution',
      before: targets.beats[1].before,
      after: 'Mara held the exit.',
      reason: 'Tightens the beat.',
      cardRefs: []
    }
  ]
}, { sourceHash: 'source-hash', targets, reviewSnapshot });
assertEqual(overlap.ok, false, 'validator rejects overlapping sentence and beat patches');
assertEqual(overlap.error.code, 'RECURSION_GENERATION_REVIEW_TARGET_INVALID', 'review-only beat targets cannot be patched');

const requiresRegeneration = validateGenerationReviewResult({
  schema: GENERATION_REVIEW_SCHEMA,
  sourceHash: 'source-hash',
  assessment: { turnFulfillment: { status: 'requires-regeneration' } },
  reviewDomains: { turnFulfillment: 'requires-regeneration' },
  cardOutcomes: [{ cardId: 'room-boundary', status: 'requires-regeneration', evidenceTargetIds: [] }],
  patches: []
}, { sourceHash: 'source-hash', targets, reviewSnapshot });
assertEqual(requiresRegeneration.ok, true, 'material review result may omit a patch');
assertEqual(requiresRegeneration.requiresRegeneration, true, 'material review result is explicitly typed');

const noPatch = validateGenerationReviewResult({
  schema: GENERATION_REVIEW_SCHEMA,
  sourceHash: 'source-hash',
  assessment: {},
  reviewDomains: {},
  cardOutcomes: [],
  patches: []
}, { sourceHash: 'source-hash', targets, reviewSnapshot });
assertEqual(noPatch.ok, false, 'ordinary no-patch review is rejected for targeted retry');
assertEqual(noPatch.error.code, 'RECURSION_GENERATION_REVIEW_CARD_COVERAGE_MISSING', 'ordinary no-patch review must account for every installed card');

assertEqual(
  generationReviewKey({ chatKey: 'chat-a', messageId: 4, swipeId: 1, sourceHash: 'source', snapshotHash: 'snapshot-a' }),
  'chat-a::4::1::source::snapshot-a',
  'review duplicate key includes source snapshot identity'
);
assertDeepEqual(
  generationReviewKey({ chatKey: 'chat-a', messageId: 4, swipeId: 1, sourceHash: 'source', snapshotHash: 'snapshot-a' }) !==
    generationReviewKey({ chatKey: 'chat-a', messageId: 4, swipeId: 1, sourceHash: 'source', snapshotHash: 'snapshot-b' }),
  true,
  'review duplicate key changes with generation snapshot'
);

console.log('[pass] generation review');
