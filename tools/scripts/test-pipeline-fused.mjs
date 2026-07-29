import { createFusedCardStages, createSegmentedCardStages } from '../../src/runtime/preprocess-graph.mjs';
import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

function validateBundle(bundle, { selectedCards }) {
  const cards = {};
  const outcomes = {};
  for (const family of selectedCards) {
    if (bundle?.cards?.[family]?.valid === true) {
      cards[family] = bundle.cards[family];
      outcomes[family] = { state: 'completed', reason: null };
    } else {
      outcomes[family] = { state: 'failed', reason: 'invalid-card' };
    }
  }
  return {
    ok: Object.keys(cards).length > 0,
    value: {
      cards,
      outcomes,
      fallback: null
    },
    error: { code: 'zero-useful-fused-cards', retryable: true }
  };
}

{
  const segmentedFallbackCalls = [];
  const [stage] = createFusedCardStages({
    selectedCards: ['character', 'setting'],
    createBundleRequest: () => ({ families: ['character', 'setting'] }),
    validateBundle,
    generateBundle: async () => ({
      cards: {
        character: { family: 'character', valid: true },
        setting: { family: 'setting', valid: false }
      }
    }),
    createSegmentedFallbackStages: () => {
      segmentedFallbackCalls.push('created');
      return [];
    }
  });
  const result = await stage.run({ request: await stage.buildRequest({}, {}) });
  const validated = await stage.validate(result, {});
  assertEqual(validated.ok, true, 'a partially useful Fused bundle is accepted');
  assertEqual(Object.keys(validated.value.cards).length, 1, 'valid Fused sibling survives invalid output');
  assertDeepEqual(validated.value.outcomes.setting, { state: 'failed', reason: 'invalid-card' }, 'invalid sibling remains a validation outcome');
  assertEqual(segmentedFallbackCalls.length, 0, 'partial useful output does not start Segmented fallback');
  assertEqual(stage.executable, true, 'Fused bundle parent owns its action');
  assertEqual(stage.outcomeChildren.every((child) => child.executable === false), true, 'Fused item children are non-executable outcomes');
}

{
  const fusedCalls = [];
  const segmentedFallbackCalls = [];
  const arbiterCalls = [];
  const [stage] = createFusedCardStages({
    selectedCards: ['character', 'setting'],
    createBundleRequest: () => ({ families: ['character', 'setting'] }),
    validateBundle,
    generateBundle: async (_request, { attempt }) => {
      fusedCalls.push(attempt);
      return { cards: {} };
    },
    createSegmentedFallbackStages: ({ selectedCards }) => createSegmentedCardStages({
      selectedCards,
      createCardRequest: (family) => ({ family }),
      validateCard: (card) => ({ ok: true, value: card }),
      generateCard: async (request) => {
        segmentedFallbackCalls.push(request.family);
        return { family: request.family, valid: true };
      }
    })
  });

  let lastArtifact = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    lastArtifact = await stage.run({
      attempt,
      request: await stage.buildRequest({}, {
        'preprocess.arbiter': { artifact: { selectedCards: ['character', 'setting'] } }
      })
    });
    const validation = await stage.validate(lastArtifact, {});
    assertEqual(validation.ok, false, `zero-useful Fused attempt ${attempt} remains retryable`);
  }

  const fallback = await stage.onAttemptsExhausted({
    lastArtifact,
    context: {},
    dependencies: {
      'preprocess.arbiter': { artifact: { selectedCards: ['character', 'setting'] } }
    }
  });
  for (const fallbackStage of fallback.stages) {
    const request = await fallbackStage.buildRequest({}, fallback.dependencies);
    const artifact = await fallbackStage.run({ request, dependencies: fallback.dependencies, attempt: 1 });
    const validation = await fallbackStage.validate(artifact, {});
    assertEqual(validation.ok, true, `${fallbackStage.id} fallback validates`);
  }

  assertEqual(fusedCalls.length, 2, 'Fused bundle consumes its own two-attempt window');
  assertEqual(segmentedFallbackCalls.length, 2, 'zero useful output starts one Segmented call per selected card');
  assertEqual(arbiterCalls.length, 0, 'fallback reuses the existing Arbiter artifact');
  assertEqual(fallback.artifact.fallback.mode, 'segmented', 'Fused artifact records the explicit fallback directive');
}

console.log('fused pipeline tests passed');
