import { createPreprocessCardGraph } from '../../src/runtime/preprocess-graph.mjs';
import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const arbiterStage = {
  id: 'preprocess.arbiter',
  dependencies: [],
  executable: true,
  run: async () => ({ selectedCards: ['character'] })
};

const segmented = createPreprocessCardGraph({
  pipelineMode: 'segmented',
  arbiterStage,
  selectedCards: ['character'],
  segmented: {
    createCardRequest: (family) => ({ family }),
    validateCard: (card) => ({ ok: true, value: card }),
    generateCard: async (request) => request
  }
});
assertDeepEqual(segmented.topologicalStageIds, [
  'preprocess.arbiter',
  'preprocess.cards.segmented.character'
], 'Segmented preprocess graph includes Arbiter and independent card stage');
const cardCorrection = segmented.getStage('preprocess.cards.segmented.character').buildCorrectionRequest({
  request: { prompt: 'Original source' }, error: { message: 'Missing evidence reference' }
});
assertEqual(cardCorrection.prompt.includes('supplied source evidence'), true, 'segmented correction includes safe evidence feedback');
assertEqual(cardCorrection.prompt.includes('Original source'), true, 'segmented correction keeps source');

const fused = createPreprocessCardGraph({
  pipelineMode: 'fused',
  arbiterStage,
  selectedCards: ['character'],
  fused: {
    createBundleRequest: () => ({ families: ['character'] }),
    validateBundle: (bundle) => ({ ok: true, value: bundle }),
    generateBundle: async () => ({ cards: {} })
  }
});
assertEqual(fused.getStage('preprocess.cards.fused').executable, true, 'Fused graph has one executable bundle parent');
assertEqual(fused.getStage('preprocess.cards.fused').outcomeChildren[0].executable, false, 'Fused card child is a validation outcome');
const fusedStage = fused.getStage('preprocess.cards.fused');
const corrected = fusedStage.buildCorrectionRequest({ request: { prompt: 'Original snapshot' }, error: { message: 'Missing evidenceRefs' } });
assertEqual(corrected.prompt.includes('evidence references from the supplied snapshot'), true, 'correction includes safe evidence feedback');
assertEqual(corrected.prompt.includes('Original snapshot'), true, 'correction preserves source context');
const omitted = await fusedStage.settleExhausted({ failure: { code: 'RECURSION_PROVIDER_REFUSAL' } });
assertEqual(omitted.ok, true, 'optional refusal permits downstream work');
assertEqual(omitted.value.fallback, null, 'explicit refusal never becomes a segmented fallback');
assertEqual(omitted.value.outcomes.character.reason, 'RECURSION_PROVIDER_REFUSAL', 'omission remains visible');
const narrowed = await fusedStage.settleExhausted({ failure: { code: 'RECURSION_PROVIDER_CONTEXT_LIMIT', kind: 'transport', category: 'capacity' } });
assertEqual(narrowed.ok, true, 'exhausted Fused context capacity narrows to individual families');
assertDeepEqual(narrowed.value.fallback.families, ['character']);
assertEqual(narrowed.value.outcomes.character.reason, 'RECURSION_PROVIDER_CONTEXT_LIMIT', 'capacity exhaustion does not invent semantic rejection');

console.log('preprocess graph tests passed');
