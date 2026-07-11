import { UTILITY_ROLE_IDS } from '../../src/providers.mjs';
import {
  CARD_CATALOG,
  applyCardPlan,
  buildCardRequests,
  buildFusedCardBundleRequest,
  cardsFromFusedProviderResult,
  cardsFromProviderResult,
  limitCardJobsForHandBudget,
  normalizeCard,
  selectHand
} from '../../src/cards.mjs';
import { influencePolicyForSettings } from '../../src/settings-policy.mjs';
import { assert, assertDeepEqual, assertEqual, assertRejects } from '../../tests/helpers/assert.mjs';

const EXPECTED_CATALOG = Object.freeze([
  { family: 'Scene Frame', role: 'sceneFrameCard', priority: 100 },
  { family: 'Active Cast', role: 'activeCastCard', priority: 95 },
  { family: 'Scene Constraints', role: 'sceneConstraintsCard', priority: 98 },
  { family: 'Knowledge', role: 'knowledgeSecretsCard', priority: 92 },
  { family: 'Consequences', role: 'clocksConsequencesCard', priority: 90 },
  { family: 'Character Motivation', role: 'characterMotivationCard', priority: 88 },
  { family: 'Relationship', role: 'dialogueRelationshipCard', priority: 84 },
  { family: 'Social Subtext', role: 'socialSubtextCard', priority: 82 },
  { family: 'Items', role: 'possessionsItemsCard', priority: 78 },
  { family: 'Environment', role: 'environmentAffordancesCard', priority: 76 },
  { family: 'Open Threads', role: 'openThreadsCard', priority: 72 }
]);

function deckCard(family, promptText, overrides = {}) {
  return normalizeCard({
    family,
    promptText,
    evidenceRefs: [`message:${family}`],
    ...overrides
  }, { sceneId: 'scene-budget', snapshotHash: 'hash-budget' });
}

assertEqual(CARD_CATALOG.length, 11, 'audited V1 catalog present');
assertDeepEqual(
  CARD_CATALOG.map(({ family, role, priority }) => ({ family, role, priority })),
  EXPECTED_CATALOG,
  'catalog membership and order match V1 plan'
);
for (const entry of CARD_CATALOG) {
  assert(!entry.family.includes('/'), `${entry.family} uses a single-focus category label`);
  assert(UTILITY_ROLE_IDS.includes(entry.role), `${entry.role} exists in provider utility roles`);
}

const allCatalogCardJobs = CARD_CATALOG.map((entry) => ({
  family: entry.family,
  role: entry.role,
  reason: `Generate ${entry.family}.`
}));

const mediumBudgetedJobs = limitCardJobsForHandBudget(allCatalogCardJobs, {
  maxCards: 6,
  behaviorPolicy: influencePolicyForSettings({
    strength: 'strong',
    focus: 'balanced',
    minCards: 5,
    maxCards: 12,
    promptFootprint: 'rich'
  })
});

assertDeepEqual(
  mediumBudgetedJobs.cardJobs.map((job) => job.family),
  ['Scene Frame', 'Scene Constraints', 'Active Cast', 'Knowledge', 'Consequences', 'Character Motivation'],
  'card job budget keeps the same families the hand selector would keep'
);
assertEqual(mediumBudgetedJobs.omitted.length, 5, 'over-budget card jobs are omitted before provider calls');
assert(mediumBudgetedJobs.omitted.every((entry) => entry.reason === 'max-cards'), 'card-job omissions use max-cards reason');
assertEqual(mediumBudgetedJobs.metadata.requestedCount, 11, 'budget metadata records requested job count');
assertEqual(mediumBudgetedJobs.metadata.keptCount, 6, 'budget metadata records kept job count');
assertEqual(mediumBudgetedJobs.metadata.maxCards, 6, 'budget metadata records effective max cards');

const forcedBudgetedJobs = limitCardJobsForHandBudget(allCatalogCardJobs, {
  maxCards: 1,
  forcedFamilies: ['Relationship', 'Open Threads'],
  behaviorPolicy: influencePolicyForSettings({ focus: 'balanced' })
});
assertDeepEqual(
  forcedBudgetedJobs.cardJobs.map((job) => job.family),
  ['Relationship', 'Open Threads'],
  'forced families floor the card job budget before provider calls'
);

const card = normalizeCard({
  family: 'Character Motivation',
  promptText: 'Mara appears guarded after the accusation.',
  inspectorNotes: 'Do not inject this note.',
  evidenceRefs: ['message:4']
}, { sceneId: 'scene-1', snapshotHash: 'hash' });
assertEqual(card.status, 'active', 'card active by default');
assertEqual(card.family, 'Character Motivation', 'family preserved');
assertEqual(card.role, 'characterMotivationCard', 'role derived from family');
assertEqual(card.catalogKey, 'Character-Motivation', 'catalog key derived from family');
assertEqual(card.source.snapshotHash, 'hash', 'snapshot hash preserved in source');
assertEqual(card.freshness.sourceFingerprint, 'hash', 'snapshot hash preserved in freshness');

const longCardText = `Long card start ${'detail '.repeat(260)}LAST-BRIEF-END-MARKER`;
const longCard = normalizeCard({
  family: 'Scene Constraints',
  promptText: longCardText
}, { sceneId: 'scene-long', snapshotHash: 'hash-long' });
assertEqual(longCard.promptText, longCardText.trim(), 'card normalization preserves full prompt text for Last Brief inspection');
assert(longCard.promptText.endsWith('LAST-BRIEF-END-MARKER'), 'long card text is not clipped with ellipsis');

await assertRejects(
  async () => normalizeCard({
    family: 'Character Motivation',
    promptText: 'I secretly want the player to trust me, but I will never reveal it.'
  }, { sceneId: 'scene-1' }),
  /Character Motivation/,
  'character motivation rejects first-person hidden thought text'
);
await assertRejects(
  async () => normalizeCard({
    family: 'Character Motivation',
    promptText: 'Mara secretly plans to betray them once the hatch opens.'
  }, { sceneId: 'scene-1' }),
  /Character Motivation/,
  'character motivation rejects third-person hidden plan text'
);
await assertRejects(
  async () => normalizeCard({
    family: 'Scene Frame',
    promptText: 'Jack Mercer had just landed at Capodichino with no reliable cover and no field readiness. The cargo hold smelled of fuel and wet canvas while the sergeant waited for his answer. He was too exhausted to improvise a clean lie.'
  }, { sceneId: 'scene-1' }),
  /instruction-shaped/,
  'card promptText rejects narrative prose paragraphs'
);

const instructionCard = normalizeCard({
  family: 'Scene Frame',
  promptText: 'Keep Jack at Capodichino immediately after landing.\nPreserve his weak cover and lack of field readiness.\nDo not skip the sergeant response beat.',
  evidenceRefs: ['message:6']
}, { sceneId: 'scene-1', snapshotHash: 'hash-instruction' });
assert(instructionCard.promptText.includes('Do not skip the sergeant response beat.'), 'card promptText accepts instruction-shaped multi-line evidence');

const roleMapped = normalizeCard({
  role: 'sceneConstraintsCard',
  promptText: 'The airlock is open and must be addressed.',
  detailProfile: 'bad-detail',
  emphasis: 'bad-emphasis',
  status: 'candidate'
}, { sceneId: 'scene-2', snapshotHash: 'hash-2' });
assertEqual(roleMapped.family, 'Scene Constraints', 'family derived from role');
assertEqual(roleMapped.detailProfile, 'standard', 'invalid detail profile falls back');
assertEqual(roleMapped.emphasis, 'normal', 'invalid emphasis falls back');
assertEqual(roleMapped.status, 'candidate', 'valid non-default status preserved');
await assertRejects(
  async () => normalizeCard({ role: 'continuity' + 'RiskCard', promptText: 'Old risk role.' }, { sceneId: 'scene-removed' }),
  /Unknown card catalog/,
  'removed risk role is rejected'
);
await assertRejects(
  async () => normalizeCard({ family: 'Pr' + 'ose', promptText: 'Old craft card.' }, { sceneId: 'scene-removed' }),
  /Unknown card catalog/,
  'removed craft family is rejected'
);

await assertRejects(
  async () => normalizeCard({ family: 'Scene Frame', promptText: '   ' }, { sceneId: 'scene-1' }),
  /promptText/,
  'empty promptText rejected'
);
await assertRejects(
  async () => normalizeCard({ family: 'Scene Frame' }, { sceneId: 'scene-1' }),
  /promptText/,
  'missing promptText rejected'
);
await assertRejects(
  async () => normalizeCard({ promptText: 'No catalog identity.' }, { sceneId: 'scene-1' }),
  /family or role/,
  'missing card family or role rejected'
);
await assertRejects(
  async () => normalizeCard({ family: 'Scene Frame', role: 'sceneConstraintsCard', promptText: 'Mismatch.' }, { sceneId: 'scene-1' }),
  /mismatch/,
  'mismatched family and role rejected'
);

const deck = applyCardPlan([], {
  acceptedCards: [card],
  lifecycle: [{ action: 'select', cardId: card.id, reason: 'relevant' }]
});
assertEqual(deck.cards.length, 1, 'deck has card');
assertEqual(deck.cards[0].arbiter.reason, 'relevant', 'arbiter reason applied');
assertEqual(deck.cards[0].status, 'active', 'selected card is active');

const lifecycleBase = [
  deckCard('Scene Frame', 'The bridge is tense.', { id: 'scene-card' }),
  deckCard('Active Cast', 'Mara and Ilya are present.', { id: 'cast-card' }),
  deckCard('Scene Constraints', 'The door was locked.', { id: 'risk-card' }),
  deckCard('Open Threads', 'The distress signal remains unanswered.', { id: 'thread-card' }),
  deckCard('Relationship', 'Keep the accusation tense.', { id: 'relationship-card' })
];
const transitioned = applyCardPlan(lifecycleBase, {
  lifecycle: [
    { action: 'stow', cardId: 'scene-card', reason: 'not immediate' },
    { action: 'discard', cardId: 'cast-card', reason: 'left scene' },
    { action: 'regenerate', cardId: 'risk-card', reason: 'needs refresh' },
    { action: 'emphasize', cardId: 'thread-card', reason: 'urgent' },
    { action: 'discard', cardId: 'risk card', reason: 'mutated id should not match' },
    { action: 'unknown', cardId: 'relationship-card', reason: 'ignored action' },
    { action: 'select', cardId: 'missing-card', reason: 'ignored missing card' }
  ]
});
assertEqual(transitioned.cards.find((entry) => entry.id === 'scene-card').status, 'stowed', 'stow transition applied');
assertEqual(transitioned.cards.find((entry) => entry.id === 'cast-card').status, 'discarded', 'discard transition applied');
assertEqual(transitioned.cards.find((entry) => entry.id === 'risk-card').status, 'stale', 'regenerate transition marks stale');
assertEqual(transitioned.cards.find((entry) => entry.id === 'thread-card').status, 'active', 'emphasize transition activates');
assertEqual(transitioned.cards.find((entry) => entry.id === 'thread-card').emphasis, 'emphasized', 'emphasize transition sets emphasis');
assertEqual(transitioned.cards.find((entry) => entry.id === 'thread-card').arbiter.reason, 'urgent', 'emphasize reason recorded');
assertEqual(transitioned.cards.find((entry) => entry.id === 'relationship-card').status, 'active', 'unknown action is no-op');
assertEqual(transitioned.cards.find((entry) => entry.id === 'risk-card').arbiter.reason, 'needs refresh', 'mutated action id does not retarget normalized id');

const preservedIdCard = {
  ...deckCard('Scene Constraints', 'The exact stored id includes a space.', { id: 'risk-card' }),
  id: 'risk card'
};
const wrongIdTransition = applyCardPlan([preservedIdCard], {
  lifecycle: [{ action: 'discard', cardId: 'risk-card', reason: 'should not match sanitized variant' }]
});
assertEqual(wrongIdTransition.cards[0].id, 'risk card', 'existing deck card id preserved exactly');
assertEqual(wrongIdTransition.cards[0].status, 'active', 'sanitized lifecycle id does not match exact stored id');
const exactIdTransition = applyCardPlan([preservedIdCard], {
  lifecycle: [{ action: 'discard', cardId: 'risk card', reason: 'exact id matches' }]
});
assertEqual(exactIdTransition.cards[0].id, 'risk card', 'exact id remains preserved after lifecycle');
assertEqual(exactIdTransition.cards[0].status, 'discarded', 'exact stored id lifecycle match applies');

const compactCachedTransition = applyCardPlan([{
  id: 'compact-cache-card',
  family: 'Scene Frame',
  status: 'active',
  summary: 'Compact cached summary.',
  promptText: 'Compact cached card should retain provenance.',
  evidenceRefs: ['message:2'],
  tokenEstimate: 20,
  sourceFingerprint: 'cache-fp'
}], {
  lifecycle: [{ action: 'select', cardId: 'compact-cache-card', reason: 'still relevant' }]
});
assertEqual(compactCachedTransition.cards[0].source.snapshotHash, 'cache-fp', 'compact cached card source fingerprint survives deck normalization');
assertEqual(compactCachedTransition.cards[0].freshness.sourceFingerprint, 'cache-fp', 'compact cached card freshness fingerprint survives deck normalization');

const requests = buildCardRequests({ cardJobs: [{ role: 'sceneFrameCard' }, { role: 'sceneConstraintsCard' }] }, {
  runId: 'run',
  snapshotHash: 'hash'
});
assertEqual(requests.length, 2, 'card requests built');
assertDeepEqual(requests.map((request) => request.roleId), ['sceneFrameCard', 'sceneConstraintsCard'], 'request role ids built');
assertEqual(requests[0].runId, 'run', 'run id included');
assertEqual(requests[0].snapshotHash, 'hash', 'snapshot hash included');
assertEqual(requests[0].metadata.family, 'Scene Frame', 'request metadata includes family');
assertEqual(requests[1].metadata.reason, '', 'missing request reason defaults empty');
assert(requests[0].prompt.includes('Return one JSON object'), 'request prompt asks for JSON-only output');
assert(requests[0].prompt.includes('Envelope role must be "sceneFrameCard"'), 'request prompt requires envelope role echo');
assert(requests[0].prompt.includes('Envelope family must be "Scene Frame"'), 'request prompt requires envelope family echo');
assert(requests[0].prompt.includes('Envelope snapshotHash must be "hash"'), 'request prompt requires envelope snapshot hash echo');
assert(requests[0].prompt.includes('promptText must be instruction-shaped private evidence'), 'card request prompt requires instruction-shaped promptText');
assert(requests[0].prompt.includes('Do not write narrative prose'), 'card request prompt forbids prose-shaped promptText');
const fusedPlan = {
  cardJobs: [
    { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Frame the sealed doorway.' },
    { family: 'Character Motivation', role: 'characterMotivationCard', reason: 'Track observable pressure.' }
  ],
  storyForm: {
    schema: 'recursion.storyForm.v1',
    tense: 'past',
    pov: 'third-person-limited',
    confidence: 'high',
    evidenceRefs: ['message:8'],
    reason: 'Assistant narration establishes form.'
  }
};
const fusedRequest = buildFusedCardBundleRequest(fusedPlan, {
  runId: 'run-fused-cards',
  snapshotHash: 'snapshot-fused-1',
  snapshot: { messages: [{ mesid: 8, role: 'assistant', text: 'The door stayed shut.' }] },
  cardScope: {
    mode: 'manual',
    strictWhitelist: true,
    selectedSubItemsByFamily: {
      'Scene Frame': ['location-situation'],
      'Character Motivation': ['observable-pressure']
    }
  },
  storyForm: fusedPlan.storyForm
});
assertEqual(fusedRequest.roleId, 'fusedCardBundle', 'Fused request uses fusedCardBundle role');
assertEqual(fusedRequest.snapshotHash, 'snapshot-fused-1', 'Fused request carries snapshot hash');
assertEqual(fusedRequest.requestedCards.length, 2, 'Fused request carries all requested cards');
assert(fusedRequest.prompt.includes('Return one JSON object only.'), 'Fused prompt requires one JSON object');
assert(fusedRequest.prompt.includes('schema "recursion.cardBundle.v1"'), 'Fused prompt names bundle schema');
assert(fusedRequest.prompt.includes('Character Motivation'), 'Fused prompt includes requested family blocks');
assert(fusedRequest.prompt.includes('Do not include first-person internal monologue'), 'Fused prompt includes family safety instructions');
assert(fusedRequest.prompt.includes('promptText must be instruction-shaped private evidence'), 'Fused prompt requires instruction-shaped promptText');
assert(fusedRequest.prompt.includes('Do not write narrative prose'), 'Fused prompt forbids prose-shaped promptText');
const fusedCardContext = {
  chatId: 'chat-fused',
  sceneId: 'scene-fused',
  sceneKey: 'scene-fused',
  sourceRevisionHash: 'source-fused',
  firstMesId: 8,
  lastMesId: 8,
  expectedSnapshotHash: 'snapshot-fused-1',
  requestedCards: fusedRequest.requestedCards
};
const fusedProviderResult = {
  ok: true,
  roleId: 'fusedCardBundle',
  lane: 'reasoner',
  diagnostics: { retryCount: 0 },
  data: {
    schema: 'recursion.cardBundle.v1',
    snapshotHash: 'snapshot-fused-1',
    items: [
      {
        schema: 'recursion.card.v1',
        family: 'Scene Frame',
        role: 'sceneFrameCard',
        promptText: 'The blocked door is the immediate boundary.',
        evidenceRefs: ['message:8'],
        tokenEstimate: 24
      },
      {
        schema: 'recursion.card.v1',
        family: 'Character Motivation',
        role: 'characterMotivationCard',
        promptText: 'She appears under pressure to keep the exit sealed.',
        evidenceRefs: ['message:8'],
        tokenEstimate: 31
      },
      {
        schema: 'recursion.card.v1',
        family: 'Items',
        role: 'possessionsItemsCard',
        promptText: 'This unrequested item should be rejected.',
        evidenceRefs: ['message:8'],
        tokenEstimate: 18
      }
    ],
    omitted: [{ family: 'Items', role: 'possessionsItemsCard', reason: 'provider-skipped' }]
  }
};
const fusedParsed = cardsFromFusedProviderResult(fusedProviderResult, fusedCardContext);
assertEqual(fusedParsed.cards.length, 2, 'Fused validator accepts valid requested siblings');
assertDeepEqual(fusedParsed.cards.map((entry) => entry.family), ['Scene Frame', 'Character Motivation'], 'Fused validator rejects unrequested items');
assertEqual(fusedParsed.cards[0].providerRole, 'fusedCardBundle', 'Fused cards retain provider role metadata');
assertEqual(fusedParsed.cards[0].providerLane, 'reasoner', 'Fused cards retain provider lane metadata');
assert(fusedParsed.diagnostics.includes('fused-item-rejected:Items'), 'Fused validator records rejected unrequested item');
assertDeepEqual(fusedParsed.omissions, [{ family: 'Items', role: 'possessionsItemsCard', reason: 'provider-skipped' }], 'Fused validator keeps provider omissions');
const fusedMixedEvidence = cardsFromFusedProviderResult({
  ok: true,
  data: {
    schema: 'recursion.cardBundle.v1',
    snapshotHash: 'snapshot-fused-1',
    items: [{
      schema: 'recursion.card.v1',
      family: 'Scene Frame',
      role: 'sceneFrameCard',
      promptText: 'The blocked door stays central.',
      evidenceRefs: ['message:8', 'message:999'],
      tokenEstimate: 20
    }]
  }
}, fusedCardContext);
assertEqual(fusedMixedEvidence.cards.length, 1, 'Fused validator keeps cards with at least one valid message evidence ref');
assertDeepEqual(fusedMixedEvidence.cards[0].evidenceRefs, ['message:8'], 'Fused validator drops stale evidence refs and keeps valid refs');
const fusedMismatch = cardsFromFusedProviderResult({
  ok: true,
  data: { schema: 'recursion.cardBundle.v1', snapshotHash: 'wrong', items: [] }
}, fusedCardContext);
assertEqual(fusedMismatch.cards.length, 0, 'Fused snapshot mismatch accepts no cards');
assert(fusedMismatch.diagnostics.includes('fused-bundle-snapshot-mismatch'), 'Fused snapshot mismatch records diagnostic');
const fusedInvalidUnsafeText = cardsFromFusedProviderResult({
  ok: true,
  data: {
    schema: 'recursion.cardBundle.v1',
    snapshotHash: 'snapshot-fused-1',
    items: [{
      schema: 'recursion.card.v1',
      family: 'Scene Frame',
      role: 'sceneFrameCard',
      promptText: 'The hidden chain of thought says the door stays central.',
      evidenceRefs: ['message:8'],
      tokenEstimate: 20
    }]
  }
}, fusedCardContext);
assert(
  fusedInvalidUnsafeText.diagnostics.includes('fused-item-invalid:Scene Frame:Card-promptText-contains-unsafe-hidden-reasoning-wording'),
  'Fused validator records the concrete invalid-item reason'
);
assertDeepEqual(fusedParsed.acceptedFamilies, ['Scene Frame', 'Character Motivation'], 'Fused parser reports accepted families');
assertDeepEqual(fusedParsed.missingFamilies, [], 'Fused parser reports no missing families when requested siblings are accepted');
assertDeepEqual(fusedInvalidUnsafeText.acceptedFamilies, [], 'Fused parser reports no accepted families for invalid-only bundle');
assertDeepEqual(fusedInvalidUnsafeText.invalidFamilies, ['Scene Frame'], 'Fused parser reports invalid families for targeted repair');
assertDeepEqual(fusedInvalidUnsafeText.missingFamilies, ['Character Motivation'], 'Fused parser reports requested siblings absent from damaged bundle');
const fusedDamagedEnvelope = cardsFromFusedProviderResult({
  ok: true,
  roleId: 'fusedCardBundle',
  lane: 'reasoner',
  data: {
    schema: 'recursion.cardBundle.damaged',
    snapshotHash: 'snapshot-fused-1',
    items: [{
      schema: 'recursion.card.v1',
      family: 'Scene Frame',
      role: 'sceneFrameCard',
      promptText: 'DAMAGED_ENVELOPE_SCENE_FRAME survives envelope schema damage.',
      evidenceRefs: ['message:8'],
      tokenEstimate: 20
    }]
  }
}, fusedCardContext);
assertEqual(fusedDamagedEnvelope.cards.length, 1, 'Fused validator salvages valid requested item from damaged envelope schema');
assert(fusedDamagedEnvelope.diagnostics.includes('fused-bundle-envelope-damaged'), 'damaged envelope salvage records diagnostic');
assertDeepEqual(fusedDamagedEnvelope.acceptedFamilies, ['Scene Frame'], 'damaged envelope salvage reports accepted family');
assertDeepEqual(fusedDamagedEnvelope.missingFamilies, ['Character Motivation'], 'damaged envelope salvage reports missing sibling');

const fusedWrongSnapshotEnvelope = cardsFromFusedProviderResult({
  ok: true,
  roleId: 'fusedCardBundle',
  data: {
    schema: 'recursion.cardBundle.damaged',
    snapshotHash: 'wrong-snapshot',
    items: [{
      schema: 'recursion.card.v1',
      family: 'Scene Frame',
      role: 'sceneFrameCard',
      promptText: 'Wrong snapshot must not be salvaged.',
      evidenceRefs: ['message:8']
    }]
  }
}, fusedCardContext);
assertEqual(fusedWrongSnapshotEnvelope.cards.length, 0, 'Fused validator never salvages wrong-snapshot envelope');
assert(fusedWrongSnapshotEnvelope.diagnostics.includes('fused-bundle-snapshot-mismatch'), 'wrong snapshot still records mismatch diagnostic');
const fusedRecoveredFragment = cardsFromFusedProviderResult({
  ok: false,
  roleId: 'fusedCardBundle',
  recoverableText: '{"schema":"recursion.cardBundle.v1","snapshotHash":"snapshot-fused-1","items":[{"schema":"recursion.card.v1","family":"Scene Frame","role":"sceneFrameCard","promptText":"FUSED_FRAGMENT_RECOVERED_SCENE survives truncation.","evidenceRefs":["message:8"]},{"schema":"recursion.card.v1","family":"Scene Constraints","role":"sceneConstraintsCard","promptText":"unfinished"'
}, fusedCardContext);
assertEqual(fusedRecoveredFragment.cards.length, 1, 'Fused validator recovers complete item before malformed tail');
assert(fusedRecoveredFragment.cards[0].promptText.includes('FUSED_FRAGMENT_RECOVERED_SCENE'), 'recovered fragment card text is preserved');
assert(fusedRecoveredFragment.diagnostics.includes('fused-bundle-fragment-recovered'), 'fragment recovery diagnostic recorded');
assertDeepEqual(fusedRecoveredFragment.missingFamilies, ['Character Motivation'], 'fragment recovery still reports missing requested sibling');
const storyFormRequest = buildCardRequests({
  cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Preserve narrative form.' }]
}, {
  runId: 'story-form-card-run',
  snapshotHash: 'story-form-card-hash',
  snapshot: {},
  storyForm: {
    schema: 'recursion.storyForm.v1',
    tense: 'past',
    pov: 'third-person-limited',
    confidence: 'high',
    evidenceRefs: ['message:7'],
    reason: 'Assistant narration establishes form.'
  }
})[0];
assertEqual(storyFormRequest.storyForm.tense, 'past', 'card request metadata carries story tense');
assertEqual(storyFormRequest.storyForm.pov, 'third-person-limited', 'card request metadata carries story pov');
assert(storyFormRequest.prompt.includes('Story form contract for card promptText:'), 'card prompt includes story form block');
assert(storyFormRequest.prompt.includes('Target tense: past.'), 'card prompt includes target tense');
assert(storyFormRequest.prompt.includes('Target POV: third-person-limited.'), 'card prompt includes target pov');
assert(storyFormRequest.prompt.includes('Do not switch to first person'), 'card prompt warns against POV drift');
const motivationRequest = buildCardRequests({ cardJobs: [{ family: 'Character Motivation' }] }, {
  runId: 'run',
  snapshotHash: 'hash'
})[0];
assert(motivationRequest.prompt.includes('Do not include first-person internal monologue'), 'motivation request includes internal-thought safety instruction');
const socialSubtextRequest = buildCardRequests({ cardJobs: [{ family: 'Social Subtext' }] }, {
  runId: 'run',
  snapshotHash: 'hash',
  cardScope: {
    selectedSubItemsByFamily: {
      'Social Subtext': ['humorIrony', 'veiledPressure', 'invitationBoundary', 'statusFace']
    }
  }
})[0];
assertEqual(socialSubtextRequest.roleId, 'socialSubtextCard', 'social subtext request uses dedicated utility role');
assert(socialSubtextRequest.prompt.includes('Selected focus facets for Social Subtext:'), 'social subtext prompt includes selected focus header');
assert(socialSubtextRequest.prompt.includes('humorIrony (humor/irony)'), 'social subtext prompt includes humor/irony facet');
assert(socialSubtextRequest.prompt.includes('veiledPressure (veiled pressure)'), 'social subtext prompt includes veiled pressure facet');
assert(socialSubtextRequest.prompt.includes('invitationBoundary (invitation/boundary)'), 'social subtext prompt includes invitation/boundary facet');
assert(socialSubtextRequest.prompt.includes('statusFace (status/face)'), 'social subtext prompt includes status/face facet');
assert(
  socialSubtextRequest.prompt.includes('Do not turn this into generic dialogue style coaching'),
  'social subtext prompt includes anti-prose-coaching safety instruction'
);
const scopedRequests = buildCardRequests({
  schema: 'recursion.utilityArbiterPlan.v1',
  snapshotHash: 'scope-test',
  cardJobs: [{ family: 'Scene Constraints', role: 'sceneConstraintsCard' }],
  budgets: { targetBriefTokens: 500, maxCards: 4 }
}, {
  runId: 'scope-run',
  snapshotHash: 'scope-test',
  snapshot: {},
  cardScope: {
    selectedSubItemsByFamily: {
      'Scene Constraints': ['hardLimits', 'timelineOrder']
    }
  }
});
assertDeepEqual(scopedRequests[0].cardScope.selectedSubItems, ['hardLimits', 'timelineOrder'], 'card request carries selected sub-item focus');
assert(scopedRequests[0].prompt.includes('Selected focus facets for Scene Constraints:'), 'card prompt includes selected focus header');
assert(scopedRequests[0].prompt.includes('hardLimits (hard limits)'), 'card prompt includes selected hard limits facet');
assert(scopedRequests[0].prompt.includes('timelineOrder (timeline/order)'), 'card prompt includes selected timeline/order facet');
assert(scopedRequests[0].prompt.includes('would make the next response implausible'), 'card prompt includes selected facet description');
assert(scopedRequests[0].prompt.includes('Immediate cause and effect'), 'card prompt includes timeline facet description');
assert(scopedRequests[0].prompt.includes('Do not create separate cards per facet.'), 'card prompt keeps one-card contract clear');
const disabledFocusRequest = buildCardRequests({
  cardJobs: [{ family: 'Environment', role: 'environmentAffordancesCard', reason: 'High relevance scene risk.' }]
}, {
  runId: 'disabled-focus-run',
  snapshotHash: 'disabled-focus-hash',
  snapshot: {},
  cardScope: { selectedSubItemsByFamily: {} }
})[0];
assertDeepEqual(disabledFocusRequest.cardScope.selectedSubItems, [], 'disabled focus request still records empty selected facets');
assert(
  disabledFocusRequest.prompt.includes('Selected focus facets for Environment: none selected.'),
  'disabled focus request tells provider no facets were selected'
);
assert(
  disabledFocusRequest.prompt.includes('Generate this family only because the Arbiter requested it as high-relevance.'),
  'disabled focus request explains Auto exception behavior'
);
const refreshRequest = buildCardRequests({
  cardJobs: [{
    family: 'Scene Constraints',
    role: 'sceneConstraintsCard',
    refreshOfCardId: 'cached-risk-1',
    reason: 'Cached risk is stale after source drift.'
  }]
}, {
  runId: 'refresh-run',
  snapshotHash: 'refresh-hash',
  snapshot: {}
})[0];
assertEqual(refreshRequest.metadata.refreshOfCardId, 'cached-risk-1', 'refresh request metadata preserves safe old card id');
assert(refreshRequest.prompt.includes('Refreshes cached card: cached-risk-1'), 'refresh request prompt tells provider this replaces stale cached card');
assert(!refreshRequest.prompt.includes('Old risk.'), 'refresh request does not expose old card prompt body by id');

const refreshedDeck = applyCardPlan([
  deckCard('Scene Constraints', 'Old risk.', { id: 'cached-risk-1', tokenEstimate: 10 })
], {
  acceptedCards: [
    deckCard('Scene Constraints', 'New risk.', { id: 'fresh-risk-1', tokenEstimate: 10 })
  ],
  lifecycle: [
    { action: 'regenerate', cardId: 'cached-risk-1', reason: 'source drift' },
    { action: 'select', cardId: 'fresh-risk-1', reason: 'fresh replacement' }
  ]
});
assertEqual(refreshedDeck.cards.find((entry) => entry.id === 'cached-risk-1').status, 'stale', 'regenerate marks old cached card stale');
assertEqual(refreshedDeck.cards.find((entry) => entry.id === 'fresh-risk-1').status, 'active', 'fresh replacement remains active');
const truncationRequest = buildCardRequests({
  cardJobs: [{
    role: 'sceneFrameCard',
    reason: `Safe truncation reason ${'x'.repeat(190)} {"apiKey":"leakv-reason-tail"}`
  }]
}, {
  snapshotHash: 'hash',
  snapshot: {
    message: `Safe truncation snapshot ${'x'.repeat(950)} {"apiKey":"leakv-snapshot-tail"}`
  }
})[0];
assert(!truncationRequest.prompt.includes('leakv'), 'request prompt scrubs secret-like text before truncating dynamic strings');
assert(!truncationRequest.prompt.includes('apiKey'), 'request prompt scrubs secret-like keys before truncating dynamic strings');
const malformedJsonRequest = buildCardRequests({
  cardJobs: [{
    role: 'sceneFrameCard',
    reason: 'Safe malformed reason {"apiKey":{"value":"raw-malformed-reason-secret"'
  }]
}, {
  snapshotHash: 'Safe malformed hash {"apiKey":{"value":"raw-malformed-hash-secret"',
  snapshot: {
    message: 'Safe malformed snapshot {"apiKey":{"value":"raw-malformed-snapshot-secret"'
  }
})[0];
assert(malformedJsonRequest.prompt.includes('Safe malformed reason'), 'safe malformed reason prefix survives prompt redaction');
assert(malformedJsonRequest.prompt.includes('Safe malformed hash'), 'safe malformed snapshot hash prefix survives prompt redaction');
assert(malformedJsonRequest.prompt.includes('Safe malformed snapshot'), 'safe malformed snapshot text prefix survives prompt redaction');
assert(!malformedJsonRequest.prompt.includes('raw-malformed-reason-secret'), 'request prompt redacts malformed JSON secret value in reason');
assert(!malformedJsonRequest.prompt.includes('raw-malformed-hash-secret'), 'request prompt redacts malformed JSON secret value in snapshotHash');
assert(!malformedJsonRequest.prompt.includes('raw-malformed-snapshot-secret'), 'request prompt redacts malformed JSON secret value in snapshot text');
assert(!malformedJsonRequest.metadata.reason.includes('raw-malformed-reason-secret'), 'metadata reason redacts malformed JSON secret value');
assert(!malformedJsonRequest.snapshotHash.includes('raw-malformed-hash-secret'), 'request snapshotHash redacts malformed JSON secret value');
const malformedNestedQuotedJsonRequest = buildCardRequests({
  cardJobs: [{
    role: 'sceneFrameCard',
    reason: 'Safe malformed nested reason {"outer":"{"apiKey":"raw-nested-malformed-reason"}"}'
  }]
}, {
  runId: 'Safe malformed nested run {"outer":"{"apiKey":"raw-nested-malformed-run"}"}',
  snapshotHash: 'Safe malformed nested hash {"outer":"{"apiKey":"raw-nested-malformed-hash"}"}',
  snapshot: {
    message: 'Safe malformed nested snapshot {"outer":"{"apiKey":"raw-nested-malformed-snapshot"}"}'
  }
})[0];
for (const value of [
  'raw-nested-malformed-reason',
  'raw-nested-malformed-run',
  'raw-nested-malformed-hash',
  'raw-nested-malformed-snapshot'
]) {
  const payload = JSON.stringify(malformedNestedQuotedJsonRequest);
  assert(!payload.includes(value), `provider-facing request data redacts ${value}`);
}
const idQualifiedRequest = buildCardRequests({
  cardJobs: [{
    role: 'sceneFrameCard',
    reason: 'Safe id reason sessionId=raw-reason-session-id credentialId=raw-reason-credential-id apiKeyId=raw-reason-api-key-id'
  }]
}, {
  runId: 'Safe id run sessionId=raw-run-session-id credentialId=raw-run-credential-id apiKeyId=raw-run-api-key-id',
  snapshotHash: 'Safe id hash sessionId=raw-hash-session-id credentialId=raw-hash-credential-id apiKeyId=raw-hash-api-key-id'
})[0];
assert(idQualifiedRequest.prompt.includes('Safe id reason'), 'safe id-qualified reason text survives prompt redaction');
assert(idQualifiedRequest.prompt.includes('Safe id hash'), 'safe id-qualified snapshot hash text survives prompt redaction');
assert(idQualifiedRequest.runId.includes('Safe id run'), 'safe id-qualified run id text survives request redaction');
assert(idQualifiedRequest.metadata.reason.includes('Safe id reason'), 'safe id-qualified metadata reason text survives redaction');
for (const value of [
  'raw-reason-session-id',
  'raw-reason-credential-id',
  'raw-reason-api-key-id',
  'raw-run-session-id',
  'raw-run-credential-id',
  'raw-run-api-key-id',
  'raw-hash-session-id',
  'raw-hash-credential-id',
  'raw-hash-api-key-id'
]) {
  assert(!idQualifiedRequest.prompt.includes(value), `request prompt redacts ${value}`);
  assert(!idQualifiedRequest.runId.includes(value), `request runId redacts ${value}`);
  assert(!idQualifiedRequest.snapshotHash.includes(value), `request snapshotHash redacts ${value}`);
  assert(!idQualifiedRequest.metadata.reason.includes(value), `metadata reason redacts ${value}`);
}
const multiTokenAssignmentRequest = buildCardRequests({
  cardJobs: [{
    role: 'sceneFrameCard',
    reason: 'Safe multiline reason privateKeyPem=-----BEGIN PRIVATE KEY----- ABCDEF apiKeyValue=raw multi word key'
  }]
}, {
  runId: 'Safe multiline run privateKeyPem=-----BEGIN PRIVATE KEY----- RUNKEY',
  snapshotHash: 'Safe multiline hash privateKeyPem=-----BEGIN PRIVATE KEY----- HASHKEY',
  snapshot: {
    message: 'Safe multiline snapshot privateKeyPem=-----BEGIN PRIVATE KEY----- SNAPKEY'
  }
})[0];
for (const text of ['Safe multiline reason', 'Safe multiline run', 'Safe multiline hash', 'Safe multiline snapshot']) {
  assert(JSON.stringify(multiTokenAssignmentRequest).includes(text), `${text} survives multi-token assignment redaction`);
}
for (const value of [
  'BEGIN PRIVATE KEY',
  'ABCDEF',
  'RUNKEY',
  'HASHKEY',
  'SNAPKEY',
  'raw multi word key'
]) {
  const payload = JSON.stringify(multiTokenAssignmentRequest);
  assert(!payload.includes(value), `provider-facing request data redacts multi-token secret ${value}`);
}
const safeQuotedSnapshotRequest = buildCardRequests({
  cardJobs: [{ role: 'sceneFrameCard' }]
}, {
  snapshotHash: 'hash',
  snapshot: {
    message: 'She said "stay safe" before leaving.',
    literal: String.raw`He typed \"stay safe\" before leaving.`
  }
})[0];
assert(safeQuotedSnapshotRequest.prompt.includes('\\"stay safe\\"'), 'safe quoted snapshot text remains escaped inside provider JSON prompt');
assert(safeQuotedSnapshotRequest.prompt.includes('\\\\\\"stay safe\\\\\\"'), 'safe literal backslash-quote snapshot text keeps its escape layer');
const safeStoryAssignmentRequest = buildCardRequests({
  cardJobs: [{
    role: 'sceneFrameCard',
    reason: 'Safe story token: a brass coin session: evening watch secret: a whispered rumor headers.authorization=raw-safe-story-prop'
  }]
}, {
  runId: 'Safe story run',
  snapshotHash: 'Safe story hash token: a brass coin session: evening watch secret: a whispered rumor headers.authorization=raw-safe-story-hash-prop',
  snapshot: {
    message: 'Safe story snapshot token: a brass coin session: evening watch secret: a whispered rumor headers.authorization=raw-safe-story-snapshot-prop'
  }
})[0];
for (const text of [
  'token: a brass coin',
  'session: evening watch',
  'secret: a whispered rumor'
]) {
  assert(safeStoryAssignmentRequest.prompt.includes(text), `${text} survives provider prompt sanitization`);
  assert(safeStoryAssignmentRequest.snapshotHash.includes(text), `${text} survives snapshotHash sanitization`);
}
for (const value of ['raw-safe-story-prop', 'raw-safe-story-hash-prop', 'raw-safe-story-snapshot-prop']) {
  assert(!JSON.stringify(safeStoryAssignmentRequest).includes(value), `${value} redacted after safe story assignment`);
}
const jsonInStringRequest = buildCardRequests({
  cardJobs: [{
    role: 'sceneFrameCard',
    reason: String.raw`Safe json string reason {"outer":"{\"apiKey\":\"raw-json-string-reason\"}"} {\"outer\":\"{\\\"apiKey\\\":\\\"raw-double-json-string-reason\\\"}\"}`
  }]
}, {
  runId: String.raw`Safe json string run {"outer":"{\"apiKey\":\"raw-json-string-run\"}"} {\"outer\":\"{\\\"apiKey\\\":\\\"raw-double-json-string-run\\\"}\"}`,
  snapshotHash: String.raw`Safe json string hash {"outer":"{\"apiKey\":\"raw-json-string-hash\"}"} {\"outer\":\"{\\\"apiKey\\\":\\\"raw-double-json-string-hash\\\"}\"}`,
  snapshot: {
    message: String.raw`Safe json string snapshot {"outer":"{\"apiKey\":\"raw-json-string-snapshot\"}"} {\"outer\":\"{\\\"apiKey\\\":\\\"raw-double-json-string-snapshot\\\"}\"}`
  }
})[0];
for (const text of ['Safe json string reason', 'Safe json string run', 'Safe json string hash', 'Safe json string snapshot']) {
  assert(JSON.stringify(jsonInStringRequest).includes(text), `${text} survives quoted JSON string sanitization`);
}
for (const value of [
  'raw-json-string-reason',
  'raw-double-json-string-reason',
  'raw-json-string-run',
  'raw-double-json-string-run',
  'raw-json-string-hash',
  'raw-double-json-string-hash',
  'raw-json-string-snapshot',
  'raw-double-json-string-snapshot'
]) {
  const payload = JSON.stringify(jsonInStringRequest);
  assert(!payload.includes(value), `provider-facing request data redacts ${value}`);
}
const laxJsonAndBracketRequest = buildCardRequests({
  cardJobs: [{
    role: 'sceneFrameCard',
    reason: String.raw`Safe escaped reason {'apiKey':{'value':'raw-single-nested-reason'}} {'credentials':['raw-single-array-reason']} {\"apiKey\":\"raw-escaped-reason\"} {'authorizationHeader':'raw-single-quote-reason'} headers[\"authorization\"]=raw-bracket-reason headers.authorization=raw-prop-reason`
  }]
}, {
  runId: String.raw`Safe escaped run {'apiKey':{'value':'raw-single-nested-run'}} {'credentials':['raw-single-array-run']} {\"apiKey\":\"raw-escaped-run\"} headers[\"authorization\"]=raw-bracket-run headers.authorization=raw-prop-run`,
  snapshotHash: String.raw`Safe escaped hash {'apiKey':{'value':'raw-single-nested-hash'}} {'credentials':['raw-single-array-hash']} {\"apiKey\":\"raw-escaped-hash\"} {'authorizationHeader':'raw-single-quote-hash'} headers[\"authorization\"]=raw-bracket-hash headers.authorization=raw-prop-hash`,
  snapshot: {
    message: String.raw`Safe escaped snapshot {'apiKey':{'value':'raw-single-nested-snapshot'}} {'credentials':['raw-single-array-snapshot']} {\"apiKey\":\"raw-escaped-snapshot\"} {'authorizationHeader':'raw-single-quote-snapshot'} headers[\"authorization\"]=raw-bracket-snapshot headers.authorization=raw-prop-snapshot`
  }
})[0];
for (const text of ['Safe escaped reason', 'Safe escaped run', 'Safe escaped hash', 'Safe escaped snapshot']) {
  assert(JSON.stringify(laxJsonAndBracketRequest).includes(text), `${text} survives lax escaped redaction`);
}
for (const value of [
  'raw-escaped-reason',
  'raw-single-nested-reason',
  'raw-single-array-reason',
  'raw-single-quote-reason',
  'raw-bracket-reason',
  'raw-prop-reason',
  'raw-escaped-run',
  'raw-single-nested-run',
  'raw-single-array-run',
  'raw-bracket-run',
  'raw-prop-run',
  'raw-escaped-hash',
  'raw-single-nested-hash',
  'raw-single-array-hash',
  'raw-single-quote-hash',
  'raw-bracket-hash',
  'raw-prop-hash',
  'raw-escaped-snapshot',
  'raw-single-nested-snapshot',
  'raw-single-array-snapshot',
  'raw-single-quote-snapshot',
  'raw-bracket-snapshot',
  'raw-prop-snapshot'
]) {
  const payload = JSON.stringify(laxJsonAndBracketRequest);
  assert(!payload.includes(value), `provider-facing request data redacts ${value}`);
}
const rawProviderUnsafeSnapshotHash = 'hash-redacted Bearer hash-token sk-card-hash private-secret authentication=raw-authentication-value auth: Bearer abc/def+ghi= session: raw-session-hash credential=raw-credential-hash {"authorizationHeader":"hash-json-secret"}';
const rawProviderUnsafeSnapshotHashWithQualified = `${rawProviderUnsafeSnapshotHash} Safe snapshot hash prefix before auth: raw-hash-safe-prefix-secret should remain. authorizationHeader=raw-hash-auth-header passwordHash=raw-hash-password-hash privateKeyPem=raw-hash-private-key-pem apiKeyValue=raw-hash-api-key-value {"apiKey":12345} {"authorizationHeader":false} {"credentials":null} {"apiKey":{"value":"raw-hash-nested-secret"}} {"credentials":["raw-hash-array-secret"]} {"outer":{"apiKey":"raw-hash-deep-secret"}} {"list":[{"credentials":["raw-hash-deep-array-secret"]}]}`;
const redactedRequest = buildCardRequests({
  cardJobs: [{
    role: 'sceneFrameCard',
    reason: 'Safe reason remains. Safe reason prefix before auth: raw-reason-safe-prefix-secret should remain while Bearer card-token sk-card-request private-secret auth: raw-auth-value auth: Bearer abc/def+ghi= session: raw-session-reason credential=raw-credential-reason authorizationHeader=raw-reason-auth-header passwordHash=raw-reason-password-hash privateKeyPem=raw-reason-private-key-pem apiKeyValue=raw-reason-api-key-value and {"apiKey":"reason-json-secret"} {"apiKey":12345} {"authorizationHeader":false} {"credentials":null} {"apiKey":{"value":"raw-reason-nested-secret"}} {"credentials":["raw-reason-array-secret"]} {"outer":{"apiKey":"raw-reason-deep-secret"}} {"list":[{"credentials":["raw-reason-deep-array-secret"]}]} are removed.'
  }]
}, {
  runId: 'run-redacted Bearer run/token+value= apiKeyValue=raw-run-api-key',
  snapshotHash: rawProviderUnsafeSnapshotHashWithQualified,
  snapshot: {
    scene: 'Safe visible snapshot text remains.',
    auth: 'auth-value',
    session: 'raw-session-value',
    credential: 'raw-credential-value',
    passwordHash: 'raw-password-hash',
    privateKeyPem: 'raw-private-key-pem',
    apiKeyValue: 'raw-api-key-value-2',
    authorizationHeader: 'Bearer raw-authorization-header',
    nested: {
      message: 'Safe message text remains while Bearer snapshot-token Bearer abc/def+ghi= sk-snapshot-key {"cookie":"snapshot-json-secret"} {"apiKey":12345} {"apiKey":{"value":"raw-snapshot-nested-secret"}} {"credentials":["raw-snapshot-array-secret"]} {"outer":{"apiKey":"raw-snapshot-deep-secret"}} {"list":[{"credentials":["raw-snapshot-deep-array-secret"]}]} Safe snapshot text prefix before auth: raw-snapshot-safe-prefix-secret should remain and private-secret are removed.',
      apiKey: 'raw-api-key-value',
      authorization: 'Bearer nested-auth-token'
    },
    visibleMessages: [
      {
        text: 'The safe visible message remains.',
        cookie: 'raw-cookie-value'
      }
    ]
  }
})[0];
assert(redactedRequest.snapshotHash, 'provider-facing request snapshotHash survives after sanitization');
assert(redactedRequest.snapshotHash !== rawProviderUnsafeSnapshotHashWithQualified, 'provider-facing request snapshotHash is sanitized when source hash contains unsafe text');
assert(redactedRequest.runId !== 'run-redacted Bearer run/token+value= apiKeyValue=raw-run-api-key', 'provider-facing request runId is sanitized');
assert(redactedRequest.prompt.includes(`Envelope snapshotHash must be "${redactedRequest.snapshotHash}"`), 'provider prompt asks for sanitized snapshot hash echo');
assert(!redactedRequest.snapshotHash.includes('Bearer hash-token'), 'request snapshotHash redacts bearer token');
assert(!redactedRequest.snapshotHash.includes('sk-card-hash'), 'request snapshotHash redacts sk token');
assert(!redactedRequest.snapshotHash.includes('raw-authentication-value'), 'request snapshotHash redacts authentication assignment');
assert(!redactedRequest.snapshotHash.includes('raw-session-hash'), 'request snapshotHash redacts session assignment');
assert(!redactedRequest.snapshotHash.includes('raw-credential-hash'), 'request snapshotHash redacts credential assignment');
assert(!redactedRequest.snapshotHash.includes('hash-json-secret'), 'request snapshotHash redacts JSON-style secret value');
assert(!redactedRequest.snapshotHash.includes('raw-hash-auth-header'), 'request snapshotHash redacts qualified authorizationHeader assignment');
assert(!redactedRequest.snapshotHash.includes('raw-hash-password-hash'), 'request snapshotHash redacts qualified passwordHash assignment');
assert(!redactedRequest.snapshotHash.includes('raw-hash-private-key-pem'), 'request snapshotHash redacts qualified privateKeyPem assignment');
assert(!redactedRequest.snapshotHash.includes('raw-hash-api-key-value'), 'request snapshotHash redacts qualified apiKeyValue assignment');
assert(!redactedRequest.snapshotHash.includes('raw-hash-safe-prefix-secret'), 'request snapshotHash redacts safe-prefix auth assignment value');
assert(!redactedRequest.snapshotHash.includes('raw-hash-nested-secret'), 'request snapshotHash redacts nested object JSON secret value');
assert(!redactedRequest.snapshotHash.includes('raw-hash-array-secret'), 'request snapshotHash redacts array JSON secret value');
assert(!redactedRequest.snapshotHash.includes('raw-hash-deep-secret'), 'request snapshotHash redacts nested secret under safe JSON object key');
assert(!redactedRequest.snapshotHash.includes('raw-hash-deep-array-secret'), 'request snapshotHash redacts nested secret under safe JSON array key');
assert(!redactedRequest.snapshotHash.includes(':12345'), 'request snapshotHash redacts unquoted numeric JSON secret value');
assert(!redactedRequest.snapshotHash.includes(':false'), 'request snapshotHash redacts unquoted boolean JSON secret value');
assert(!redactedRequest.snapshotHash.includes(':null'), 'request snapshotHash redacts null JSON secret value');
assert(!redactedRequest.runId.includes('run/token+value='), 'request runId redacts bearer credential payload');
assert(!redactedRequest.runId.includes('raw-run-api-key'), 'request runId redacts secret assignment payload');
assert(redactedRequest.prompt.includes('Safe reason remains'), 'safe request reason text survives prompt redaction');
assert(redactedRequest.prompt.includes('Safe reason prefix before'), 'safe request reason prefix before auth assignment survives prompt redaction');
assert(redactedRequest.prompt.includes('Safe snapshot hash prefix before'), 'safe snapshot hash prefix before auth assignment survives prompt redaction');
assert(redactedRequest.prompt.includes('Safe visible snapshot text remains.'), 'safe snapshot text survives prompt redaction');
assert(redactedRequest.prompt.includes('Safe message text remains'), 'safe nested snapshot text survives prompt redaction');
assert(redactedRequest.prompt.includes('Safe snapshot text prefix before'), 'safe snapshot text prefix before auth assignment survives prompt redaction');
assert(redactedRequest.prompt.includes('The safe visible message remains.'), 'safe visible message text survives prompt redaction');
assert(redactedRequest.metadata.reason.includes('Safe reason remains'), 'metadata reason preserves safe request reason text');
assert(redactedRequest.metadata.reason.includes('Safe reason prefix before'), 'metadata reason preserves safe prefix before auth assignment');
assert(!redactedRequest.metadata.reason.includes('Bearer card-token'), 'metadata reason redacts bearer token');
assert(!redactedRequest.metadata.reason.includes('abc/def+ghi='), 'metadata reason redacts bearer slash/plus/equals payload');
assert(!redactedRequest.metadata.reason.includes('sk-card-request'), 'metadata reason redacts sk token');
assert(!redactedRequest.metadata.reason.includes('raw-auth-value'), 'metadata reason redacts auth assignment');
assert(!redactedRequest.metadata.reason.includes('raw-session-reason'), 'metadata reason redacts session assignment');
assert(!redactedRequest.metadata.reason.includes('raw-credential-reason'), 'metadata reason redacts credential assignment');
assert(!redactedRequest.metadata.reason.includes('raw-reason-auth-header'), 'metadata reason redacts qualified authorizationHeader assignment');
assert(!redactedRequest.metadata.reason.includes('raw-reason-password-hash'), 'metadata reason redacts qualified passwordHash assignment');
assert(!redactedRequest.metadata.reason.includes('raw-reason-private-key-pem'), 'metadata reason redacts qualified privateKeyPem assignment');
assert(!redactedRequest.metadata.reason.includes('raw-reason-api-key-value'), 'metadata reason redacts qualified apiKeyValue assignment');
assert(!redactedRequest.metadata.reason.includes('raw-reason-safe-prefix-secret'), 'metadata reason redacts safe-prefix auth assignment value');
assert(!redactedRequest.metadata.reason.includes('raw-reason-nested-secret'), 'metadata reason redacts nested object JSON secret value');
assert(!redactedRequest.metadata.reason.includes('raw-reason-array-secret'), 'metadata reason redacts array JSON secret value');
assert(!redactedRequest.metadata.reason.includes('raw-reason-deep-secret'), 'metadata reason redacts nested secret under safe JSON object key');
assert(!redactedRequest.metadata.reason.includes('raw-reason-deep-array-secret'), 'metadata reason redacts nested secret under safe JSON array key');
assert(!redactedRequest.metadata.reason.includes('reason-json-secret'), 'metadata reason redacts JSON-style secret value');
assert(!redactedRequest.metadata.reason.includes(':12345'), 'metadata reason redacts unquoted numeric JSON secret value');
assert(!redactedRequest.metadata.reason.includes(':false'), 'metadata reason redacts unquoted boolean JSON secret value');
assert(!redactedRequest.metadata.reason.includes(':null'), 'metadata reason redacts null JSON secret value');
assert(!redactedRequest.metadata.reason.includes('apiKey'), 'metadata reason does not expose secret-like apiKey field name');
assert(!redactedRequest.metadata.reason.includes('authorizationHeader'), 'metadata reason does not expose secret-like authorizationHeader field name');
assert(!redactedRequest.prompt.includes('Bearer hash-token'), 'request prompt redacts bearer token in snapshotHash display');
assert(!redactedRequest.prompt.includes('sk-card-hash'), 'request prompt redacts sk token in snapshotHash display');
assert(!redactedRequest.prompt.includes('raw-authentication-value'), 'request prompt redacts authentication assignment in snapshotHash display');
assert(!redactedRequest.prompt.includes('raw-session-hash'), 'request prompt redacts session assignment in snapshotHash display');
assert(!redactedRequest.prompt.includes('raw-credential-hash'), 'request prompt redacts credential assignment in snapshotHash display');
assert(!redactedRequest.prompt.includes('hash-json-secret'), 'request prompt redacts JSON-style secret value in snapshotHash display');
assert(!redactedRequest.prompt.includes('Bearer card-token'), 'request prompt redacts bearer token in reason');
assert(!redactedRequest.prompt.includes('abc/def+ghi='), 'request prompt redacts full bearer credential payload with slash/plus/equals');
assert(!redactedRequest.prompt.includes('/def+ghi='), 'request prompt redacts partial bearer credential remainder');
assert(!redactedRequest.prompt.includes('sk-card-request'), 'request prompt redacts sk token in reason');
assert(!redactedRequest.prompt.includes('raw-auth-value'), 'request prompt redacts auth assignment in reason');
assert(!redactedRequest.prompt.includes('raw-session-reason'), 'request prompt redacts session assignment in reason');
assert(!redactedRequest.prompt.includes('raw-credential-reason'), 'request prompt redacts credential assignment in reason');
assert(!redactedRequest.prompt.includes('raw-reason-auth-header'), 'request prompt redacts qualified authorizationHeader assignment in reason');
assert(!redactedRequest.prompt.includes('raw-reason-password-hash'), 'request prompt redacts qualified passwordHash assignment in reason');
assert(!redactedRequest.prompt.includes('raw-reason-private-key-pem'), 'request prompt redacts qualified privateKeyPem assignment in reason');
assert(!redactedRequest.prompt.includes('raw-reason-api-key-value'), 'request prompt redacts qualified apiKeyValue assignment in reason');
assert(!redactedRequest.prompt.includes('raw-reason-safe-prefix-secret'), 'request prompt redacts safe-prefix auth assignment value in reason');
assert(!redactedRequest.prompt.includes('raw-reason-nested-secret'), 'request prompt redacts nested object JSON secret value in reason');
assert(!redactedRequest.prompt.includes('raw-reason-array-secret'), 'request prompt redacts array JSON secret value in reason');
assert(!redactedRequest.prompt.includes('raw-reason-deep-secret'), 'request prompt redacts nested secret under safe JSON object key in reason');
assert(!redactedRequest.prompt.includes('raw-reason-deep-array-secret'), 'request prompt redacts nested secret under safe JSON array key in reason');
assert(!redactedRequest.prompt.includes('reason-json-secret'), 'request prompt redacts JSON-style secret value in reason');
assert(!redactedRequest.prompt.includes('private-secret'), 'request prompt redacts private-secret marker');
assert(!redactedRequest.prompt.includes('Bearer snapshot-token'), 'request prompt redacts bearer token in snapshot text');
assert(!redactedRequest.prompt.includes('sk-snapshot-key'), 'request prompt redacts sk token in snapshot text');
assert(!redactedRequest.prompt.includes('snapshot-json-secret'), 'request prompt redacts JSON-style secret value in snapshot text');
assert(!redactedRequest.prompt.includes('raw-snapshot-safe-prefix-secret'), 'request prompt redacts safe-prefix auth assignment value in snapshot text');
assert(!redactedRequest.prompt.includes('raw-snapshot-nested-secret'), 'request prompt redacts nested object JSON secret value in snapshot text');
assert(!redactedRequest.prompt.includes('raw-snapshot-array-secret'), 'request prompt redacts array JSON secret value in snapshot text');
assert(!redactedRequest.prompt.includes('raw-snapshot-deep-secret'), 'request prompt redacts nested secret under safe JSON object key in snapshot text');
assert(!redactedRequest.prompt.includes('raw-snapshot-deep-array-secret'), 'request prompt redacts nested secret under safe JSON array key in snapshot text');
assert(!redactedRequest.prompt.includes(':12345'), 'request prompt redacts unquoted numeric JSON secret value');
assert(!redactedRequest.prompt.includes(':false'), 'request prompt redacts unquoted boolean JSON secret value');
assert(!redactedRequest.prompt.includes(':null'), 'request prompt redacts null JSON secret value');
assert(!redactedRequest.prompt.includes('auth-value'), 'request prompt redacts plain auth field value');
assert(!redactedRequest.prompt.includes('raw-session-value'), 'request prompt redacts plain session field value');
assert(!redactedRequest.prompt.includes('raw-credential-value'), 'request prompt redacts plain credential field value');
assert(!redactedRequest.prompt.includes('raw-password-hash'), 'request prompt redacts passwordHash field value');
assert(!redactedRequest.prompt.includes('raw-private-key-pem'), 'request prompt redacts privateKeyPem field value');
assert(!redactedRequest.prompt.includes('raw-api-key-value-2'), 'request prompt redacts apiKeyValue field value');
assert(!redactedRequest.prompt.includes('Bearer raw-authorization-header'), 'request prompt redacts authorizationHeader field value');
assert(!redactedRequest.prompt.includes('raw-api-key-value'), 'request prompt redacts apiKey value');
assert(!redactedRequest.prompt.includes('Bearer nested-auth-token'), 'request prompt redacts authorization value');
assert(!redactedRequest.prompt.includes('raw-cookie-value'), 'request prompt redacts cookie value');
assert(!redactedRequest.prompt.includes('apiKey'), 'request prompt does not expose secret-like apiKey field name');
assert(!redactedRequest.prompt.includes('authorization'), 'request prompt does not expose secret-like authorization field name');
assert(!redactedRequest.prompt.includes('"session"'), 'request prompt does not expose secret-like session field name');
assert(!redactedRequest.prompt.includes('"credential"'), 'request prompt does not expose secret-like credential field name');
assert(!redactedRequest.prompt.includes('passwordHash'), 'request prompt does not expose secret-like passwordHash field name');
assert(!redactedRequest.prompt.includes('privateKeyPem'), 'request prompt does not expose secret-like privateKeyPem field name');
assert(!redactedRequest.prompt.includes('apiKeyValue'), 'request prompt does not expose secret-like apiKeyValue field name');
assert(!redactedRequest.prompt.includes('authorizationHeader'), 'request prompt does not expose secret-like authorizationHeader field name');
const redactedEchoCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: redactedRequest.snapshotHash,
    items: [{ promptText: 'Sanitized request hash echo validates without exposing source hash.', evidenceRefs: ['message:9'] }]
  }
}, {
  sceneId: 'scene-redacted-provider',
  snapshotHash: 'source-window-hash-stays-local',
  expectedSnapshotHash: redactedRequest.snapshotHash,
  expectedRole: 'sceneFrameCard',
  expectedFamily: 'Scene Frame'
});
assertEqual(redactedEchoCards.length, 1, 'provider cards validate against sanitized request snapshot hash');
assertEqual(redactedEchoCards[0].source.snapshotHash, 'source-window-hash-stays-local', 'provider card provenance keeps runtime source hash separate from provider echo hash');

const providerCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'hash-provider',
    items: [
      {
        promptText: 'The scene is boxed into a damaged shuttle.',
        inspectorNotes: 'private provider note',
        evidenceRefs: ['message:8']
      }
    ]
  }
}, { sceneId: 'scene-provider', snapshotHash: 'hash-provider', expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' });
assertEqual(providerCards.length, 1, 'valid provider item converted');
assertEqual(providerCards[0].family, 'Scene Frame', 'provider role maps family');
assertEqual(providerCards[0].source.snapshotHash, 'hash-provider', 'provider cards inherit source context');
assertEqual(cardsFromProviderResult({ ok: false, data: { items: [{ promptText: 'ignored' }] } }).length, 0, 'non-ok provider result ignored');
assertEqual(cardsFromProviderResult({ ok: true, data: {} }).length, 0, 'provider result without items ignored');
assertEqual(cardsFromProviderResult({ ok: true, roleId: 'sceneFrameCard', data: { items: [{ promptText: 'missing schema should be ignored' }] } }).length, 0, 'provider result without card schema ignored');
assertEqual(cardsFromProviderResult({ ok: true, roleId: 'sceneFrameCard', data: { schema: 'wrong.schema', items: [{ promptText: 'wrong schema should be ignored' }] } }).length, 0, 'provider result with wrong card schema ignored');
assertEqual(cardsFromProviderResult({ ok: true, data: { schema: 'recursion.card.v1', items: [{ promptText: 'orphan provider item' }] } }).length, 0, 'provider item without request-owned role or family ignored');
assertEqual(cardsFromProviderResult({ ok: true, roleId: 'sceneFrameCard', data: { schema: 'recursion.card.v1', items: [{ promptText: 'missing request-owned expectation' }] } }).length, 0, 'provider envelope ignored without request-owned expected role and family');
const expectedEnvelopeCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    items: [{ promptText: 'Request-owned expected family and role repair missing envelope identity.', evidenceRefs: ['message:8'] }]
  }
}, { expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' });
assertEqual(expectedEnvelopeCards.length, 1, 'request-owned expected family and role repair missing provider envelope identity');
assertEqual(expectedEnvelopeCards[0].family, 'Scene Frame', 'repaired provider envelope uses expected family');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    items: [{ promptText: 'missing request-owned expectation' }]
  }
}).length, 0, 'provider envelope ignored without request-owned expected role and family');
assertEqual(cardsFromProviderResult({
  ok: true,
  data: {
    schema: 'recursion.card.v1',
    roleId: 'sceneFrameCard',
    family: 'Scene Frame',
    items: [{ promptText: 'roleId alias envelope validates.', evidenceRefs: ['message:8'] }]
  }
}, { expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 1, 'provider envelope accepts roleId alias when it matches expected role');
assertEqual(cardsFromProviderResult({
  ok: true,
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    items: [{ promptText: 'items wins when cards alias also appears.', evidenceRefs: ['message:8'] }],
    cards: [{ promptText: 'cards alias should be ignored when items exists.', evidenceRefs: ['message:8'] }]
  }
}, { expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 1, 'provider envelope ignores cards alias when canonical items exists');
assertEqual(cardsFromProviderResult({
  ok: true,
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    cards: [{ promptText: 'cards alias validates under current provider schema.', evidenceRefs: ['message:8'] }]
  }
}, { expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 1, 'provider envelope accepts cards alias when items is absent');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    items: [
      { promptText: 'First card.' },
      { promptText: 'Second card.' }
    ]
  }
}, { expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 0, 'provider result with multiple items ignored');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    items: [{ family: 'Scene Constraints', promptText: 'conflicting provider item' }]
  }
}, { expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 0, 'provider item with conflicting family and role ignored');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneConstraintsCard',
    family: 'Scene Constraints',
    items: [{ promptText: 'conflicting envelope role' }]
  }
}, { expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 0, 'provider envelope with conflicting role ignored');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Constraints',
    items: [{ promptText: 'conflicting envelope family' }]
  }
}, { expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 0, 'provider envelope with conflicting family ignored');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'wrong-provider-hash',
    items: [{ promptText: 'Wrong snapshot hash should be ignored.', evidenceRefs: ['message:8'] }]
  }
}, { snapshotHash: 'hash-provider', expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 0, 'provider envelope with mismatched snapshot hash ignored');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    items: [{ promptText: 'Missing snapshot hash should be ignored.', evidenceRefs: ['message:8'] }]
  }
}, { snapshotHash: 'hash-provider', expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 1, 'provider envelope without snapshot hash accepted under active request guards');
const requestHashContextCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'request-frozen-hash',
    items: [{ promptText: 'Request hash echo should validate while source hash stays local.', evidenceRefs: ['message:8'] }]
  }
}, {
  sceneId: 'scene-provider',
  snapshotHash: 'source-window-hash',
  expectedSnapshotHash: 'request-frozen-hash',
  expectedRole: 'sceneFrameCard',
  expectedFamily: 'Scene Frame'
});
assertEqual(requestHashContextCards.length, 1, 'provider card validates request hash separately from source hash');
assertEqual(requestHashContextCards[0].source.snapshotHash, 'source-window-hash', 'provider card provenance keeps runtime source hash');
const sourceWindowCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'request-frozen-hash',
    items: [{ promptText: 'In-window evidence should validate.', evidenceRefs: ['message:1', 'message:2'] }]
  }
}, {
  sceneId: 'scene-provider',
  chatId: 'chat-provider',
  firstMesId: 1,
  lastMesId: 2,
  snapshotHash: 'source-window-hash',
  expectedSnapshotHash: 'request-frozen-hash',
  expectedRole: 'sceneFrameCard',
  expectedFamily: 'Scene Frame'
});
assertEqual(sourceWindowCards.length, 1, 'provider card with evidence inside frozen source window accepted');
assertDeepEqual(sourceWindowCards[0].evidenceRefs, ['message:1', 'message:2'], 'provider card keeps in-window evidence refs');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'request-frozen-hash',
    items: [{ promptText: 'Nullish bounds should not create a fake source window.', evidenceRefs: ['message:1'] }]
  }
}, {
  sceneId: 'scene-provider',
  chatId: 'chat-provider',
  firstMesId: null,
  lastMesId: '',
  snapshotHash: 'source-window-hash',
  expectedSnapshotHash: 'request-frozen-hash',
  expectedRole: 'sceneFrameCard',
  expectedFamily: 'Scene Frame'
}).length, 1, 'provider card with nullish source bounds keeps old no-window behavior');
const repairedOutOfWindowCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'request-frozen-hash',
    items: [{ promptText: 'Out-of-window message evidence repairs to the active source window.', evidenceRefs: ['message:99'] }]
  }
}, {
  sceneId: 'scene-provider',
  chatId: 'chat-provider',
  firstMesId: 1,
  lastMesId: 2,
  snapshotHash: 'source-window-hash',
  expectedSnapshotHash: 'request-frozen-hash',
  expectedRole: 'sceneFrameCard',
  expectedFamily: 'Scene Frame'
});
assertEqual(repairedOutOfWindowCards.length, 1, 'provider card with only out-of-window message refs repairs to active source window');
assertDeepEqual(repairedOutOfWindowCards[0].evidenceRefs, ['message:2'], 'out-of-window provider message refs repair to latest source-window message');
const mixedEvidenceCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'request-frozen-hash',
    items: [{ promptText: 'Mixed in-window and out-of-window evidence keeps the valid ref.', evidenceRefs: ['message:1', 'message:99'] }]
  }
}, {
  sceneId: 'scene-provider',
  chatId: 'chat-provider',
  firstMesId: 1,
  lastMesId: 2,
  snapshotHash: 'source-window-hash',
  expectedSnapshotHash: 'request-frozen-hash',
  expectedRole: 'sceneFrameCard',
  expectedFamily: 'Scene Frame'
});
assertEqual(mixedEvidenceCards.length, 1, 'provider card with mixed out-of-window evidence keeps valid refs');
assertDeepEqual(mixedEvidenceCards[0].evidenceRefs, ['message:1'], 'mixed out-of-window evidence drops stale refs');
const displayLimitEvidenceCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'request-frozen-hash',
    items: [{
      promptText: 'Out-of-window evidence after normalized display limit keeps valid refs.',
      evidenceRefs: [...Array.from({ length: 12 }, () => 'message:1'), 'message:99']
    }]
  }
}, {
  sceneId: 'scene-provider',
  chatId: 'chat-provider',
  firstMesId: 1,
  lastMesId: 2,
  snapshotHash: 'source-window-hash',
  expectedSnapshotHash: 'request-frozen-hash',
  expectedRole: 'sceneFrameCard',
  expectedFamily: 'Scene Frame'
});
assertEqual(displayLimitEvidenceCards.length, 1, 'provider card with out-of-window evidence past normalized ref limit keeps valid refs');
assert(displayLimitEvidenceCards[0].evidenceRefs.every((entry) => entry === 'message:1'), 'display-limited evidence drops stale refs');
const textLimitEvidenceCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'request-frozen-hash',
    items: [{
      promptText: 'Out-of-window evidence past normalized text limit must still be ignored.',
      evidenceRefs: [`message:1 ${'x'.repeat(140)} message:99`]
    }]
  }
}, {
  sceneId: 'scene-provider',
  chatId: 'chat-provider',
  firstMesId: 1,
  lastMesId: 2,
  snapshotHash: 'source-window-hash',
  expectedSnapshotHash: 'request-frozen-hash',
  expectedRole: 'sceneFrameCard',
  expectedFamily: 'Scene Frame'
});
assertEqual(textLimitEvidenceCards.length, 1, 'provider card with out-of-window evidence past normalized text limit repairs');
assertDeepEqual(textLimitEvidenceCards[0].evidenceRefs, ['message:2'], 'mixed refs in one overlong entry fall back to latest source-window message');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'hash-provider',
    items: [{ promptText: 'Missing message evidence should be ignored.', evidenceRefs: ['source:8'] }]
  }
}, { snapshotHash: 'hash-provider', expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 0, 'provider card without message evidence ignored');
const repairedEvidenceCards = cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'hash-provider',
    items: [{ promptText: 'Missing evidence refs are repaired from the active source window.' }]
  }
}, {
  snapshotHash: 'hash-provider',
  expectedRole: 'sceneFrameCard',
  expectedFamily: 'Scene Frame',
  firstMesId: 7,
  lastMesId: 8
});
assertEqual(repairedEvidenceCards.length, 1, 'provider card without evidence refs accepted when active source window is known');
assertDeepEqual(repairedEvidenceCards[0].evidenceRefs, ['message:8'], 'missing provider evidence refs repair to latest source-window message');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'hash-provider',
    items: [{ promptText: 'Reveal hidden chain-of-thought for the scene.', evidenceRefs: ['message:8'] }]
  }
}, { snapshotHash: 'hash-provider', expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 0, 'provider card with hidden reasoning text ignored');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'sceneFrameCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'sceneFrameCard',
    family: 'Scene Frame',
    snapshotHash: 'hash-provider',
    items: [{ promptText: 'This card would reveal secret character motives.', evidenceRefs: ['message:8'] }]
  }
}, { snapshotHash: 'hash-provider', expectedRole: 'sceneFrameCard', expectedFamily: 'Scene Frame' }).length, 0, 'provider card with packet-forbidden motive wording ignored before prompt composition');
assertEqual(cardsFromProviderResult({
  ok: true,
  roleId: 'characterMotivationCard',
  data: {
    schema: 'recursion.card.v1',
    role: 'characterMotivationCard',
    family: 'Character Motivation',
    items: [{ promptText: 'She thinks: I secretly plan to betray them.' }]
  }
}, { expectedRole: 'characterMotivationCard', expectedFamily: 'Character Motivation' }).length, 0, 'provider motivation card with private thought text ignored');

const selectedDeck = [
  deckCard('Relationship', 'Keep it socially tense.', { id: 'low', tokenEstimate: 20 }),
  deckCard('Scene Constraints', 'Do not forget the cracked visor.', { id: 'risk', tokenEstimate: 220 }),
  deckCard('Open Threads', 'The signal is unanswered.', { id: 'emph', tokenEstimate: 120, emphasis: 'emphasized', origin: 'cache' }),
  deckCard('Scene Frame', 'The bay is sealed.', { id: 'scene', tokenEstimate: 80, inspectorNotes: 'private' }),
  deckCard('Active Cast', 'Mara waits outside.', { id: 'stowed', status: 'stowed', tokenEstimate: 30 })
];
const budgetHand = selectHand(selectedDeck, { maxCards: 2, maxTokens: 300 });
assertDeepEqual(budgetHand.cards.map((entry) => entry.id), ['emph', 'scene'], 'hand sorts by emphasis then catalog priority');
assertEqual(budgetHand.cards.length, 2, 'maxCards enforced');
assertEqual(budgetHand.tokenEstimate, 200, 'token estimate sums selected cards');
assert(!budgetHand.cards.some((entry) => entry.inspectorNotes), 'hand excludes inspector notes');
assert(!budgetHand.cards.some((entry) => entry.arbiter || entry.source || entry.freshness || entry.summary), 'hand uses prompt-facing allowlist shape');
assertDeepEqual(Object.keys(budgetHand.cards[0]), ['id', 'family', 'role', 'status', 'promptText', 'tokenEstimate', 'detailProfile', 'emphasis', 'evidenceRefs', 'origin'], 'hand card shape is allowlisted');
assertEqual(budgetHand.cards[0].origin, 'cache', 'hand preserves safe card origin for Last Brief provenance');
assert(budgetHand.omitted.some((entry) => entry.cardId === 'risk' && entry.reason === 'max-cards'), 'full hand reports maxCards omissions first');
assert(budgetHand.omitted.some((entry) => entry.cardId === 'low' && entry.reason === 'max-cards'), 'maxCards omissions recorded');
assert(budgetHand.omitted.some((entry) => entry.cardId === 'stowed' && entry.reason === 'inactive'), 'inactive omissions recorded');
assertEqual(budgetHand.metadata.maxCards, 2, 'hand metadata includes maxCards');
assertEqual(budgetHand.metadata.maxTokens, 300, 'hand metadata includes maxTokens');

const forcedHand = selectHand(selectedDeck, {
  maxCards: 1,
  maxTokens: 300,
  forcedFamilies: ['Relationship', 'Scene Constraints']
});
assertDeepEqual(forcedHand.cards.map((entry) => entry.family), ['Relationship', 'Scene Constraints'], 'forced families select first and floor maxCards');
assertDeepEqual(forcedHand.metadata.forcedFamilies, ['Relationship', 'Scene Constraints'], 'hand metadata records forced families');
assertDeepEqual(forcedHand.metadata.selectedForcedFamilies, ['Relationship', 'Scene Constraints'], 'hand metadata records selected forced families');
const missingForcedHand = selectHand(selectedDeck, {
  maxCards: 2,
  maxTokens: 300,
  forcedFamilies: ['Open Threads', 'Environment']
});
assert(missingForcedHand.cards.some((entry) => entry.family === 'Open Threads'), 'available forced family is still selected');
assert(missingForcedHand.omitted.some((entry) => entry.family === 'Environment' && entry.reason === 'manual-forced-provider-failed'), 'missing forced family records explicit omission');

const priorityHand = selectHand(selectedDeck, {
  maxCards: 2,
  maxTokens: 300,
  forcedCardIds: ['low', 'risk']
});
assertDeepEqual(priorityHand.cards.map((entry) => entry.id), ['low', 'risk'], 'forced card ids select before normal emphasis and catalog priority');
assertDeepEqual(priorityHand.metadata.forcedCardIds, ['low', 'risk'], 'hand metadata records forced card ids');
assertDeepEqual(priorityHand.metadata.selectedForcedCardIds, ['low', 'risk'], 'hand metadata records selected forced card ids');

const priorityOverflowHand = selectHand(selectedDeck, {
  maxCards: 1,
  maxTokens: 300,
  forcedCardIds: ['low', 'risk', 'emph']
});
assertDeepEqual(priorityOverflowHand.cards.map((entry) => entry.id), ['low'], 'over-cap forced card ids keep deck order winner first');
assert(priorityOverflowHand.metadata.diagnostics.includes('priority-card-cap'), 'priority overflow records diagnostic');
assert(priorityOverflowHand.omitted.some((entry) => entry.cardId === 'risk' && entry.reason === 'priority-over-max-cards'), 'priority overflow uses priority omission reason');
assert(priorityOverflowHand.omitted.some((entry) => entry.cardId === 'emph' && entry.reason === 'priority-over-max-cards'), 'every overflow priority card records priority omission reason');

const characterFocusHand = selectHand([
  deckCard('Character Motivation', 'Mara seems guarded.', { id: 'motivation-tie', tokenEstimate: 20 }),
  deckCard('Scene Frame', 'The room stays sealed.', { id: 'scene-tie', tokenEstimate: 20 }),
  deckCard('Open Threads', 'The unanswered signal waits.', { id: 'thread-tie', tokenEstimate: 20 })
], {
  maxCards: 2,
  maxTokens: 300,
  behaviorPolicy: influencePolicyForSettings({ focus: 'character' })
});
assertDeepEqual(characterFocusHand.cards.map((entry) => entry.id), ['motivation-tie', 'scene-tie'], 'focus boosts matching families before catalog priority');
assertEqual(characterFocusHand.metadata.behaviorPolicy.focus, 'character', 'hand metadata records focus policy');
assertEqual(characterFocusHand.metadata.behaviorPolicy.selectedBoostedCards, 1, 'hand metadata counts selected boosted cards');

const compactFootprintHand = selectHand([
  deckCard('Scene Frame', 'Scene one.', { id: 'scene-compact', tokenEstimate: 20 }),
  deckCard('Active Cast', 'Cast one.', { id: 'cast-compact', tokenEstimate: 20 }),
  deckCard('Open Threads', 'Thread one.', { id: 'thread-compact', tokenEstimate: 20 }),
  deckCard('Relationship', 'Relationship one.', { id: 'relationship-compact', tokenEstimate: 20 }),
  deckCard('Items', 'Item one.', { id: 'item-compact', tokenEstimate: 20 }),
  deckCard('Environment', 'Environment one.', { id: 'environment-compact', tokenEstimate: 20 })
], {
  maxCards: 10,
  maxTokens: 500,
  behaviorPolicy: influencePolicyForSettings({ promptFootprint: 'compact' })
});
assertEqual(compactFootprintHand.cards.length, 6, 'compact footprint no longer owns card count after configured card budgets were added');
assertEqual(compactFootprintHand.metadata.behaviorPolicy.effectiveMaxCards, 10, 'hand metadata records requested card budget when footprint is compact');

const lightStrengthHand = selectHand([
  deckCard('Scene Frame', 'Scene one.', { id: 'scene-light', tokenEstimate: 20 }),
  deckCard('Active Cast', 'Cast one.', { id: 'cast-light', tokenEstimate: 20 }),
  deckCard('Open Threads', 'Thread one.', { id: 'thread-light', tokenEstimate: 20 }),
  deckCard('Relationship', 'Relationship one.', { id: 'relationship-light', tokenEstimate: 20 }),
  deckCard('Items', 'Item one.', { id: 'item-light', tokenEstimate: 20 }),
  deckCard('Environment', 'Environment one.', { id: 'environment-light', tokenEstimate: 20 })
], {
  maxCards: 6,
  maxTokens: 500,
  behaviorPolicy: influencePolicyForSettings({ strength: 'light', promptFootprint: 'normal' })
});
assertEqual(lightStrengthHand.cards.length, 5, 'light strength reduces normal hand pressure by one inside caps');
assertEqual(lightStrengthHand.metadata.behaviorPolicy.strength, 'light', 'hand metadata records strength policy');

const tokenOnlyHand = selectHand([
  deckCard('Scene Constraints', 'Oversized risk.', { id: 'too-big', tokenEstimate: 301 }),
  deckCard('Scene Frame', 'Small scene.', { id: 'small', tokenEstimate: 20 })
], { maxCards: 5, maxTokens: 300 });
assertEqual(tokenOnlyHand.cards.length, 2, 'token budget no longer drops active card evidence');
assert(tokenOnlyHand.cards.some((entry) => entry.id === 'too-big'), 'oversized card evidence survives token budget');
assert(tokenOnlyHand.cards.some((entry) => entry.id === 'small'), 'small card evidence survives token budget');
assertEqual(tokenOnlyHand.metadata.tokenBudgetExceeded, true, 'token overage is diagnostic metadata');

const hand = selectHand(deck.cards, { maxCards: 4, maxTokens: 500 });
assertEqual(hand.cards.length, 1, 'hand selected card');
assert(!hand.cards[0].inspectorNotes, 'hand excludes inspector notes');
console.log('[pass] cards');
