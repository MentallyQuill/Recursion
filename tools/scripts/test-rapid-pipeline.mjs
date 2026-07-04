import {
  RAPID_PIPELINE_VERSION,
  RAPID_TURN_DELTA_SCHEMA,
  buildRapidTurnDeltaPrompt,
  chooseRapidHedgeWinner,
  normalizeRapidTurnDelta,
  rapidArtifactHash,
  rapidCacheKey,
  rapidWarmArtifactIsUsable
} from '../../src/rapid-pipeline.mjs';
import { UNKNOWN_STORY_FORM } from '../../src/story-form.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const snapshot = {
  chatKey: 'rapid-chat',
  sceneKey: 'rapid-scene',
  sourceRevisionHash: 'turn-source',
  turnFingerprint: 'turn-fingerprint',
  latestMesId: 42,
  messages: [{ mesid: 42, role: 'user', text: 'Open the sealed hatch.', visible: true }]
};

const rapidStoryForm = {
  schema: 'recursion.storyForm.v1',
  tense: 'past',
  pov: 'third-person-limited',
  confidence: 'high',
  evidenceRefs: ['message:2'],
  reason: 'Warm assistant narration establishes form.'
};

const rapidV2 = {
  pipelineVersion: 2,
  status: 'ready',
  warmArtifactId: 'rapid-warm-v2',
  baseSourceRevisionHash: 'base-rev',
  baseSnapshotHash: 'base-snapshot',
  selectedCardIds: ['scene-card', 'subtext-card'],
  cardIds: ['scene-card', 'subtext-card', 'constraint-card'],
  guidance: {
    schema: 'recursion.guidanceComposer.v1',
    status: 'used',
    text: 'Warm provider guidance.',
    sourceCardIds: ['scene-card', 'subtext-card'],
    guardrailCardIds: ['constraint-card'],
    diagnostics: []
  },
  storyForm: rapidStoryForm,
  settingsHash: 'settings',
  providerContractHash: 'provider',
  cardCatalogHash: 'catalog',
  promptContractHash: 'prompt',
  builtAt: '2026-07-03T00:00:00.000Z',
  runId: 'rapid-run',
  diagnostics: ['rapid-warm-v2']
};

const expectedRapidV2 = {
  baseSourceRevisionHash: 'base-rev',
  settingsHash: 'settings',
  providerContractHash: 'provider',
  cardCatalogHash: 'catalog',
  promptContractHash: 'prompt',
  storyForm: rapidStoryForm
};

assertEqual(RAPID_PIPELINE_VERSION, 2, 'rapid pipeline v2 is current');
assertEqual(RAPID_TURN_DELTA_SCHEMA, 'recursion.rapidTurnDelta.v2', 'rapid turn delta v2 schema is current');
assertEqual(
  rapidCacheKey({ chatKey: 'rapid-chat', sceneKey: 'rapid-scene', sourceRevisionHash: 'base-source' }),
  'rapid-chat::rapid-scene::base-source',
  'rapid cache key uses exact source revision'
);
assert(rapidWarmArtifactIsUsable(rapidV2, expectedRapidV2), 'Rapid V2 warm artifact is usable');
assert(!rapidWarmArtifactIsUsable({ ...rapidV2, conditionedSceneBrief: 'old brief', pipelineVersion: 1 }, expectedRapidV2), 'Rapid V1 conditionedSceneBrief artifact is invalid');
assert(!rapidWarmArtifactIsUsable({ ...rapidV2, guidance: { ...rapidV2.guidance, text: '' } }, expectedRapidV2), 'Rapid V2 requires provider guidance text');
assert(!rapidWarmArtifactIsUsable({ ...rapidV2, selectedCardIds: [] }, expectedRapidV2), 'Rapid V2 requires selected card ids');
assert(rapidWarmArtifactIsUsable(
  { ...rapidV2, storyForm: { ...UNKNOWN_STORY_FORM, reason: 'missing warm form' } },
  { ...expectedRapidV2, storyForm: { ...UNKNOWN_STORY_FORM, reason: 'missing warm form' } }
), 'Rapid V2 accepts unknown story form when warm guidance is otherwise ready');
assert(!rapidWarmArtifactIsUsable(
  { ...rapidV2, storyForm: { schema: 'recursion.storyForm.v1', tense: 'present', pov: 'first-person', confidence: 'high' } },
  expectedRapidV2
), 'Rapid V2 rejects mismatched story form');

const deltaPrompt = buildRapidTurnDeltaPrompt({
  snapshotHash: 'snapshot-hash',
  baseSourceRevisionHash: 'base-rev',
  turnSourceRevisionHash: 'turn-rev',
  userMessage: 'Open the sealed hatch.',
  warmArtifact: rapidV2,
  warmGuidance: rapidV2.guidance,
  storyForm: rapidStoryForm,
  selectedCards: [
    { id: 'scene-card', family: 'Scene Frame', promptText: 'SCENE_CARD_MARKER full raw scene card.' },
    { id: 'subtext-card', family: 'Social Subtext', promptText: 'SOCIAL_SUBTEXT_MARKER full raw subtext card.' }
  ]
});
assert(deltaPrompt.includes(RAPID_TURN_DELTA_SCHEMA), 'turn delta prompt names v2 schema');
assert(deltaPrompt.includes('Warm provider guidance.'), 'turn delta prompt includes warm guidance');
assert(deltaPrompt.includes('past tense, third-person-limited POV'), 'turn delta prompt includes story form instruction');
assert(deltaPrompt.includes('SOCIAL_SUBTEXT_MARKER'), 'turn delta prompt includes full raw selected cards');
assert(deltaPrompt.includes('turnGuidanceText'), 'turn delta prompt names required turn guidance field');
assert(!deltaPrompt.includes('turnDeltaBrief'), 'turn delta prompt omits old turnDeltaBrief field');
assert(!deltaPrompt.includes('conditionedSceneBrief'), 'turn delta prompt omits conditionedSceneBrief');

const normalized = normalizeRapidTurnDelta({
  schema: 'recursion.rapidTurnDelta.v2',
  snapshotHash: 'turn',
  baseSourceRevisionHash: 'base',
  turnSourceRevisionHash: 'turn-rev',
  selectedCardIds: ['scene-card', 'unknown-card'],
  turnGuidanceText: 'Use Rhya rest boundary as current beat close.',
  guardrailCardIds: ['constraint-card', 'unknown-guardrail'],
  packetInstructions: ['Keep Hermione as escort.'],
  backgroundRefreshRequests: [],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: ['delta-v2']
}, {
  snapshotHash: 'turn',
  baseSourceRevisionHash: 'base',
  turnSourceRevisionHash: 'turn-rev',
  allowedCardIds: ['scene-card', 'constraint-card']
});
assertDeepEqual(normalized.selectedCardIds, ['scene-card'], 'unknown card id is rejected');
assertEqual(normalized.turnGuidanceText, 'Use Rhya rest boundary as current beat close.', 'turn guidance preserved');
assertDeepEqual(normalized.guardrailCardIds, ['constraint-card'], 'guardrail card ids preserved');
assertDeepEqual(normalized.packetInstructions, ['Keep Hermione as escort.'], 'packet instructions preserved');

const refreshOnlyDelta = normalizeRapidTurnDelta({
  schema: RAPID_TURN_DELTA_SCHEMA,
  selectedCardIds: ['scene-card'],
  turnGuidanceText: 'Use the warm scene card.',
  backgroundRefreshRequests: [{ family: 'Open Threads', reason: 'Refresh soon' }],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: ['refresh-only']
}, {
  snapshotHash: 'trusted-snapshot',
  baseSourceRevisionHash: 'trusted-base',
  turnSourceRevisionHash: 'trusted-turn',
  allowedCardIds: ['scene-card']
});
assertEqual(refreshOnlyDelta.escalateToStandard, false, 'background refresh requests do not escalate Rapid');
assertEqual(refreshOnlyDelta.backgroundRefreshRequests.length, 1, 'background refresh request is preserved');

const aliasedDelta = normalizeRapidTurnDelta({
  schema: RAPID_TURN_DELTA_SCHEMA,
  brief: {
    turnGuidanceText: 'Nested turn guidance from provider.',
    packetInstructions: ['Nested packet instruction.']
  },
  selectedCardIds: ['scene-card']
}, {
  snapshotHash: 'trusted-snapshot',
  baseSourceRevisionHash: 'trusted-base',
  turnSourceRevisionHash: 'trusted-turn',
  allowedCardIds: ['scene-card']
});
assertEqual(aliasedDelta.turnGuidanceText, '', 'delta ignores old nested guidance alias');
assertEqual(aliasedDelta.snapshotHash, 'trusted-snapshot', 'delta stamps trusted snapshot hash');

assertEqual(
  rapidArtifactHash(rapidV2),
  rapidArtifactHash({ ...rapidV2, conditionedSceneBrief: 'ignored old field' }),
  'rapid artifact hash ignores conditionedSceneBrief'
);

const hedgeWinner = chooseRapidHedgeWinner([
  { source: 'primary', result: { ok: false, error: { code: 'invalid' } }, settledAtMs: 9000 },
  { source: 'backup', result: { ok: true, data: { schema: RAPID_TURN_DELTA_SCHEMA } }, settledAtMs: 6500 }
]);
assertEqual(hedgeWinner.source, 'backup', 'first valid hedge result wins');

console.log('[pass] rapid-pipeline');
