import { createFusedCardStages } from '../../src/runtime/preprocess-graph.mjs';
import { preserveFusedProviderFailure, validateFusedProviderResult } from '../../src/runtime.mjs';
import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

for (const code of [
  'RECURSION_PROVIDER_CONTEXT_LIMIT',
  'RECURSION_STRUCTURED_OUTPUT_UNSUPPORTED',
  'RECURSION_PROVIDER_RATE_LIMIT',
  'RECURSION_PROVIDER_TRANSIENT'
]) {
  const failure = preserveFusedProviderFailure({
    ok: false,
    diagnostics: {
      failure: {
        kind: 'transport',
        category: 'provider',
        code,
        retryable: true,
        message: `${code} from the selected profile.`
      }
    }
  });
  assertEqual(failure.code, code, `Fused preserves provider failure code ${code}`);
}
assertEqual(
  preserveFusedProviderFailure({ ok: true, data: { cards: [] } }),
  null,
  'successful Fused responses do not create provider failures'
);

const runtimeFailure = validateFusedProviderResult({
  ok: false,
  diagnostics: {
    failure: {
      code: 'RECURSION_PROVIDER_RATE_LIMIT',
      category: 'provider',
      retryable: true,
      message: 'The selected profile is rate limited.'
    }
  },
  data: { items: [] }
}, {
  selectedCards: [{ family: 'character' }],
  request: { requestedCards: [{ family: 'character' }] }
});
assertEqual(runtimeFailure.ok, false, 'runtime Fused validation rejects provider failures before card parsing');
assertEqual(runtimeFailure.error.code, 'RECURSION_PROVIDER_RATE_LIMIT', 'runtime Fused validation preserves provider failure identity');

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
  const acceptedFamilies = Object.keys(cards);
  const unresolvedFamilies = selectedCards.filter((family) => !cards[family]);
  return acceptedFamilies.length > 0
    ? {
        ok: true,
        value: {
          cards,
          outcomes,
          acceptedFamilies,
          unresolvedFamilies,
          fallback: unresolvedFamilies.length
            ? {
                mode: 'segmented',
                reason: 'unresolved-fused-families',
                families: unresolvedFamilies
              }
            : null
        }
      }
    : {
        ok: false,
        value: { cards, outcomes },
        error: {
          code: 'RECURSION_FUSED_ZERO_USEFUL_CARDS',
          category: 'validation',
          retryable: true,
          message: 'Fused bundle produced no useful cards.'
        }
      };
}

{
  const [stage] = createFusedCardStages({
    selectedCards: ['character', 'setting'],
    createBundleRequest: () => ({ families: ['character', 'setting'] }),
    validateBundle,
    generateBundle: async () => ({
      cards: {
        character: { family: 'character', valid: true },
        setting: { family: 'setting', valid: false }
      }
    })
  });
  const result = await stage.run({ request: await stage.buildRequest({}, {}) });
  const validated = await stage.validate(result, {});
  assertEqual(validated.ok, true, 'a partially useful Fused bundle is accepted');
  assertEqual(Object.keys(validated.value.cards).length, 1, 'valid Fused sibling survives invalid output');
  assertDeepEqual(validated.value.acceptedFamilies, ['character'], 'accepted family is explicit');
  assertDeepEqual(validated.value.unresolvedFamilies, ['setting'], 'unresolved family is explicit');
  assertDeepEqual(
    validated.value.fallback,
    { mode: 'segmented', reason: 'unresolved-fused-families', families: ['setting'] },
    'partial Fused output carries a targeted repair directive'
  );
  assertEqual(stage.executable, true, 'Fused bundle parent owns its action');
  assertEqual(stage.outcomeChildren.every((child) => child.executable === false), true, 'Fused item children are non-executable outcomes');
}

{
  const fusedCalls = [];
  const [stage] = createFusedCardStages({
    selectedCards: ['character', 'setting'],
    createBundleRequest: () => ({ families: ['character', 'setting'] }),
    validateBundle,
    generateBundle: async (_request, { attempt }) => {
      fusedCalls.push(attempt);
      return { cards: {} };
    }
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

  const settled = await stage.settleExhausted({
    lastArtifact,
    failure: {
      code: 'RECURSION_FUSED_ZERO_USEFUL_CARDS',
      category: 'validation',
      retryable: true
    },
    attempts: 2,
    request: { families: ['character', 'setting'] },
    context: {},
    dependencies: {
      'preprocess.arbiter': { artifact: { selectedCards: ['character', 'setting'] } }
    }
  });

  assertEqual(fusedCalls.length, 2, 'Fused bundle consumes its own two-attempt window');
  assertEqual(settled.ok, true, 'exhausted zero-useful Fused output settles explicitly');
  assertDeepEqual(settled.value.acceptedFamilies, [], 'zero-useful settlement accepts no families');
  assertDeepEqual(settled.value.unresolvedFamilies, ['character', 'setting'], 'zero-useful settlement exposes every unresolved family');
  assertDeepEqual(
    settled.value.fallback,
    {
      mode: 'segmented',
      reason: 'zero-useful-fused-cards',
      families: ['character', 'setting']
    },
    'zero-useful settlement records one complete Segmented fallback directive'
  );
  assertEqual(Object.hasOwn(settled, 'stages'), false, 'settlement hook does not mutate or extend the graph');
}

{
  const selectedCards = [{ family: 'Realism', role: 'realismCard' }];
  const request = { requestedCards: selectedCards };
  const failure = { kind: 'transport', category: 'capacity', code: 'RECURSION_PROVIDER_RATE_LIMIT', retryable: true };
  const [stage] = createFusedCardStages({
    selectedCards,
    createBundleRequest: () => request,
    generateBundle: async () => ({ ok: false, error: failure }),
    validateBundle: (result) => validateFusedProviderResult(result, { selectedCards, request })
  });
  const settled = await stage.settleExhausted({ lastArtifact: { ok: false, error: failure }, failure });
  assertEqual(settled.ok, false, 'rate limiting cannot fan out into card repair');
  assertEqual(settled.failure.code, failure.code, 'exhaustion retains the provider cause');
  assertEqual(settled.value, undefined, 'provider failure cannot commit a successful fallback checkpoint');
}

console.log('fused pipeline tests passed');
