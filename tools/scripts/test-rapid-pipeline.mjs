import {
  RAPID_FAST_START_SCHEMA,
  RAPID_PIPELINE_VERSION,
  RAPID_TURN_DELTA_SCHEMA,
  buildRapidFastStartPrompt,
  buildRapidTurnDeltaPrompt,
  chooseRapidHedgeWinner,
  normalizeRapidFastStartPack,
  normalizeRapidTurnDelta,
  rapidCacheKey,
  rapidWarmArtifactIsUsable
} from '../../src/rapid-pipeline.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const snapshot = {
  chatKey: 'rapid-chat',
  sceneKey: 'rapid-scene',
  sourceRevisionHash: 'turn-source',
  turnFingerprint: 'turn-fingerprint',
  latestMesId: 42,
  messages: [{ mesid: 42, role: 'user', text: 'Open the sealed hatch.', visible: true }]
};

const warmArtifact = {
  pipelineVersion: RAPID_PIPELINE_VERSION,
  status: 'ready',
  warmArtifactId: 'rapid-warm-1',
  baseSourceRevisionHash: 'base-source',
  conditionedSceneBrief: 'The sealed hatch blocks the corridor.',
  candidateCardIds: ['card-scene', 'card-constraints'],
  cardIds: ['card-scene', 'card-constraints'],
  settingsHash: 'settings-hash',
  providerContractHash: 'provider-hash',
  cardCatalogHash: 'catalog-hash',
  promptContractHash: 'prompt-hash'
};

assertEqual(RAPID_TURN_DELTA_SCHEMA, 'recursion.rapidTurnDelta.v1', 'rapid turn delta schema id is stable');
assertEqual(RAPID_FAST_START_SCHEMA, 'recursion.rapidFastStartPack.v1', 'rapid fast-start schema id is stable');
assertEqual(
  rapidCacheKey({ chatKey: 'rapid-chat', sceneKey: 'rapid-scene', sourceRevisionHash: 'base-source' }),
  'rapid-chat::rapid-scene::base-source',
  'rapid cache key uses exact source revision'
);

assertEqual(
  rapidWarmArtifactIsUsable(warmArtifact, {
    baseSourceRevisionHash: 'base-source',
    settingsHash: 'settings-hash',
    providerContractHash: 'provider-hash',
    cardCatalogHash: 'catalog-hash',
    promptContractHash: 'prompt-hash'
  }),
  true,
  'matching warm artifact is usable'
);

assertEqual(
  rapidWarmArtifactIsUsable(warmArtifact, {
    baseSourceRevisionHash: 'other-source',
    settingsHash: 'settings-hash',
    providerContractHash: 'provider-hash',
    cardCatalogHash: 'catalog-hash',
    promptContractHash: 'prompt-hash'
  }),
  false,
  'wrong source warm artifact is rejected'
);

const deltaPrompt = buildRapidTurnDeltaPrompt({
  snapshotHash: 'snapshot-hash',
  baseSourceRevisionHash: 'base-source',
  turnSourceRevisionHash: 'turn-source',
  userMessage: 'Open the sealed hatch.',
  warmArtifact,
  candidateCards: [
    { id: 'card-scene', family: 'Scene Frame', summary: 'The sealed hatch blocks the corridor.' },
    { id: 'card-constraints', family: 'Scene Constraints', summary: 'The hatch is sealed until opened.' }
  ]
});
assert(deltaPrompt.includes(RAPID_TURN_DELTA_SCHEMA), 'turn delta prompt names schema');
assert(deltaPrompt.includes('Open the sealed hatch.'), 'turn delta prompt includes user delta');
assert(deltaPrompt.includes('card-constraints'), 'turn delta prompt includes candidate card ids');
assert(deltaPrompt.includes('turnDeltaBrief'), 'turn delta prompt names required brief field');
assert(deltaPrompt.includes('packetInstructions'), 'turn delta prompt names required packet instructions field');

const fastStartPrompt = buildRapidFastStartPrompt({
  snapshotHash: 'snapshot-hash',
  turnSourceRevisionHash: 'turn-source',
  snapshot
});
assert(fastStartPrompt.includes(RAPID_FAST_START_SCHEMA), 'fast-start prompt names schema');
assert(fastStartPrompt.includes('No warm deck is available'), 'fast-start prompt states missing warm deck');
assert(fastStartPrompt.includes('sceneBrief'), 'fast-start prompt names required scene brief field');
assert(fastStartPrompt.includes('turnBrief'), 'fast-start prompt names required turn brief field');

const normalizedDelta = normalizeRapidTurnDelta({
  schema: RAPID_TURN_DELTA_SCHEMA,
  snapshotHash: 'snapshot-hash',
  baseSourceRevisionHash: 'base-source',
  turnSourceRevisionHash: 'turn-source',
  selectedCardIds: ['card-constraints', 'unknown-card'],
  turnDeltaBrief: 'The user tests the hatch directly.',
  packetInstructions: ['Keep the hatch constraint visible.'],
  guardrails: ['Do not imply it opens without an action.'],
  backgroundRefreshRequests: [{ family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'Hatch access changed.' }],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: ['rapid-warm-deck']
}, {
  snapshotHash: 'snapshot-hash',
  baseSourceRevisionHash: 'base-source',
  turnSourceRevisionHash: 'turn-source',
  allowedCardIds: ['card-scene', 'card-constraints']
});
assertDeepEqual(normalizedDelta.selectedCardIds, ['card-constraints'], 'delta keeps only known warm card ids');
assertEqual(normalizedDelta.escalateToStandard, false, 'delta does not escalate by default');

const stampedDelta = normalizeRapidTurnDelta({
  schema: RAPID_TURN_DELTA_SCHEMA,
  snapshotHash: 'model-echoed-wrong-snapshot',
  baseSourceRevisionHash: 'model-echoed-wrong-base',
  turnSourceRevisionHash: 'model-echoed-wrong-turn',
  selectedCardIds: ['card-scene'],
  turnDeltaBrief: 'The user keeps moving.',
  packetInstructions: [],
  guardrails: [],
  backgroundRefreshRequests: [],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: []
}, {
  snapshotHash: 'trusted-snapshot',
  baseSourceRevisionHash: 'trusted-base',
  turnSourceRevisionHash: 'trusted-turn',
  allowedCardIds: ['card-scene']
});
assertEqual(stampedDelta.snapshotHash, 'trusted-snapshot', 'delta stamps trusted snapshot hash instead of model echo');
assertEqual(stampedDelta.baseSourceRevisionHash, 'trusted-base', 'delta stamps trusted base source hash');
assertEqual(stampedDelta.turnSourceRevisionHash, 'trusted-turn', 'delta stamps trusted turn source hash');

const aliasedDelta = normalizeRapidTurnDelta({
  schema: RAPID_TURN_DELTA_SCHEMA,
  brief: {
    turnBrief: 'Nested turn guidance from provider.',
    packetInstructions: ['Nested packet instruction.'],
    guardrails: ['Nested guardrail.']
  },
  selectedCardIds: ['card-scene']
}, {
  snapshotHash: 'trusted-snapshot',
  baseSourceRevisionHash: 'trusted-base',
  turnSourceRevisionHash: 'trusted-turn',
  allowedCardIds: ['card-scene']
});
assertEqual(aliasedDelta.turnDeltaBrief, 'Nested turn guidance from provider.', 'delta accepts nested provider turn brief alias');
assertDeepEqual(aliasedDelta.packetInstructions, ['Nested packet instruction.'], 'delta accepts nested packet instructions alias');
assertDeepEqual(aliasedDelta.guardrails, ['Nested guardrail.'], 'delta accepts nested guardrails alias');

const normalizedFastStart = normalizeRapidFastStartPack({
  schema: RAPID_FAST_START_SCHEMA,
  snapshotHash: 'snapshot-hash',
  turnSourceRevisionHash: 'turn-source',
  sceneBrief: 'The sealed hatch blocks the corridor.',
  turnBrief: 'The user tries the hatch.',
  guardrails: ['Keep access constraints intact.'],
  omissions: ['No warm scene deck was ready.'],
  backgroundRefreshRequests: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Warm next turn.' }],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: ['rapid-fast-start']
}, {
  snapshotHash: 'snapshot-hash',
  turnSourceRevisionHash: 'turn-source'
});
assertEqual(normalizedFastStart.sceneBrief.includes('sealed hatch'), true, 'fast-start preserves provider scene brief');

const stampedFastStart = normalizeRapidFastStartPack({
  schema: RAPID_FAST_START_SCHEMA,
  snapshotHash: 'model-echoed-wrong-snapshot',
  turnSourceRevisionHash: 'model-echoed-wrong-turn',
  sceneBrief: 'The provider still generated scene guidance.',
  turnBrief: 'The provider still generated turn guidance.',
  guardrails: [],
  omissions: [],
  backgroundRefreshRequests: [],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: []
}, {
  snapshotHash: 'trusted-fast-snapshot',
  turnSourceRevisionHash: 'trusted-fast-turn'
});
assertEqual(stampedFastStart.snapshotHash, 'trusted-fast-snapshot', 'fast-start stamps trusted snapshot hash instead of model echo');
assertEqual(stampedFastStart.turnSourceRevisionHash, 'trusted-fast-turn', 'fast-start stamps trusted turn source hash');

const aliasedFastStart = normalizeRapidFastStartPack({
  schema: RAPID_FAST_START_SCHEMA,
  brief: {
    scene: 'Nested provider scene guidance.',
    turn: 'Nested provider turn guidance.',
    guardrails: ['Nested fast-start guardrail.'],
    omissions: ['Nested omission.']
  }
}, {
  snapshotHash: 'trusted-fast-snapshot',
  turnSourceRevisionHash: 'trusted-fast-turn'
});
assertEqual(aliasedFastStart.sceneBrief, 'Nested provider scene guidance.', 'fast-start accepts nested scene alias');
assertEqual(aliasedFastStart.turnBrief, 'Nested provider turn guidance.', 'fast-start accepts nested turn alias');
assertDeepEqual(aliasedFastStart.guardrails, ['Nested fast-start guardrail.'], 'fast-start accepts nested guardrails alias');
assertDeepEqual(aliasedFastStart.omissions, ['Nested omission.'], 'fast-start accepts nested omissions alias');

const hedgeWinner = chooseRapidHedgeWinner([
  { source: 'primary', result: { ok: false, error: { code: 'invalid' } }, settledAtMs: 9000 },
  { source: 'backup', result: { ok: true, data: { schema: RAPID_TURN_DELTA_SCHEMA } }, settledAtMs: 6500 }
]);
assertEqual(hedgeWinner.source, 'backup', 'first valid hedge result wins');

console.log('[pass] rapid-pipeline');
