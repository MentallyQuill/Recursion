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

const fused = createPreprocessCardGraph({
  pipelineMode: 'fused',
  arbiterStage,
  selectedCards: ['character'],
  fused: {
    createBundleRequest: () => ({ families: ['character'] }),
    validateBundle: (bundle) => ({ ok: true, value: bundle }),
    generateBundle: async () => ({ cards: {} }),
    createSegmentedFallbackStages: () => []
  }
});
assertEqual(fused.getStage('preprocess.cards.fused').executable, true, 'Fused graph has one executable bundle parent');
assertEqual(fused.getStage('preprocess.cards.fused').outcomeChildren[0].executable, false, 'Fused card child is a validation outcome');

console.log('preprocess graph tests passed');
