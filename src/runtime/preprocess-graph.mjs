import { createExecutionGraph } from '../execution/stage-registry.mjs';

function selectedCardKey(card) {
  const source = card && typeof card === 'object' ? card : {};
  const value = typeof card === 'string'
    ? card
    : source.family || source.roleId || source.id || '';
  return String(value).trim();
}

function stageIdPart(value) {
  const part = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!part) throw new TypeError('Selected card requires a stable family, roleId, or id.');
  return part;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function.`);
  return value;
}

function validationResult(result, artifact) {
  if (result === true || result === undefined) return { ok: true, value: artifact };
  if (result === false) return { ok: false, error: { code: 'invalid-card' } };
  if (result?.ok === true) {
    return {
      ...result,
      value: result.value === undefined ? artifact : result.value
    };
  }
  if (result?.ok === false) return result;
  return { ok: true, value: result };
}

function cardSummary(card, selectedCard) {
  const source = card && typeof card === 'object' ? card : {};
  return {
    family: String(source.family || selectedCardKey(selectedCard)).slice(0, 120),
    cardId: String(source.id || source.cardId || '').slice(0, 160)
  };
}

export function createSegmentedCardStages({
  selectedCards = [],
  createCardRequest,
  validateCard,
  generateCard
} = {}) {
  const build = requireFunction(createCardRequest, 'createCardRequest');
  const validate = requireFunction(validateCard, 'validateCard');
  const generate = requireFunction(generateCard, 'generateCard');
  const seen = new Set();

  return (Array.isArray(selectedCards) ? selectedCards : []).map((selectedCard) => {
    const key = stageIdPart(selectedCardKey(selectedCard));
    if (seen.has(key)) throw new TypeError(`Duplicate Segmented card stage "${key}".`);
    seen.add(key);
    return Object.freeze({
      id: `preprocess.cards.segmented.${key}`,
      version: 1,
      kind: 'model',
      executable: true,
      dependencies: Object.freeze(['preprocess.arbiter']),
      checkpoint: 'durable',
      failurePolicy: 'continue',
      selectedCard,
      buildInputFingerprint(context, dependencies) {
        return {
          turnKeyHash: String(context?.turnIdentity?.turnKeyHash || ''),
          sourceBandHash: String(context?.turnIdentity?.sourceBandHash || ''),
          dependencies
        };
      },
      buildRequest(context, dependencies) {
        return build(selectedCard, { context, dependencies });
      },
      run({ request, ...attemptContext }) {
        return generate(request, {
          ...attemptContext,
          selectedCard
        });
      },
      async validate(artifact, validationContext) {
        return validationResult(
          await validate(artifact, {
            ...validationContext,
            selectedCard
          }),
          artifact
        );
      },
      summarize(artifact) {
        return cardSummary(artifact, selectedCard);
      }
    });
  });
}

function fusedOutcomes(selectedCards) {
  return Object.freeze(selectedCards.map((selectedCard) => Object.freeze({
    id: `preprocess.cards.fused.${stageIdPart(selectedCardKey(selectedCard))}`,
    selectedCard,
    executable: false,
    kind: 'validation-outcome'
  })));
}

function fallbackArtifact(validated, selectedCards) {
  const value = validated?.value && typeof validated.value === 'object'
    ? validated.value
    : {};
  const outcomes = value.outcomes && typeof value.outcomes === 'object'
    ? value.outcomes
    : Object.fromEntries(selectedCards.map((card) => [
        selectedCardKey(card),
        { state: 'failed', reason: 'invalid-card' }
      ]));
  return {
    ...value,
    cards: value.cards && typeof value.cards === 'object' ? value.cards : {},
    outcomes,
    fallback: {
      mode: 'segmented',
      reason: 'zero-useful-fused-cards'
    }
  };
}

export function createFusedCardStages({
  selectedCards = [],
  createBundleRequest,
  validateBundle,
  generateBundle,
  createSegmentedFallbackStages
} = {}) {
  const cards = Array.isArray(selectedCards) ? [...selectedCards] : [];
  const build = requireFunction(createBundleRequest, 'createBundleRequest');
  const validate = requireFunction(validateBundle, 'validateBundle');
  const generate = requireFunction(generateBundle, 'generateBundle');
  const createFallback = requireFunction(
    createSegmentedFallbackStages,
    'createSegmentedFallbackStages'
  );

  return [Object.freeze({
    id: 'preprocess.cards.fused',
    version: 1,
    kind: 'model',
    executable: true,
    dependencies: Object.freeze(['preprocess.arbiter']),
    checkpoint: 'durable',
    failurePolicy: 'fallback',
    outcomeChildren: fusedOutcomes(cards),
    buildInputFingerprint(context, dependencies) {
      return {
        turnKeyHash: String(context?.turnIdentity?.turnKeyHash || ''),
        sourceBandHash: String(context?.turnIdentity?.sourceBandHash || ''),
        dependencies
      };
    },
    buildRequest(context, dependencies) {
      return build({
        selectedCards: cards,
        context,
        dependencies
      });
    },
    run({ request, ...attemptContext }) {
      return generate(request, {
        ...attemptContext,
        selectedCards: cards
      });
    },
    async validate(artifact, validationContext) {
      return validationResult(
        await validate(artifact, {
          ...validationContext,
          selectedCards: cards
        }),
        artifact
      );
    },
    async onAttemptsExhausted({
      lastArtifact,
      context,
      dependencies
    } = {}) {
      const validated = validationResult(
        await validate(lastArtifact, {
          context,
          dependencies,
          selectedCards: cards,
          exhausted: true
        }),
        lastArtifact
      );
      const stages = await createFallback({
        selectedCards: cards,
        context,
        dependencies,
        fusedArtifact: fallbackArtifact(validated, cards)
      });
      return {
        artifact: fallbackArtifact(validated, cards),
        stages: Array.isArray(stages) ? stages : [],
        dependencies
      };
    },
    summarize(artifact) {
      return {
        acceptedFamilies: Object.keys(artifact?.cards || {}).slice(0, 40),
        fallback: artifact?.fallback?.mode || null
      };
    }
  })];
}

export function createPreprocessCardGraph({
  pipelineMode = 'segmented',
  arbiterStage,
  selectedCards = [],
  segmented = {},
  fused = {}
} = {}) {
  if (!arbiterStage || arbiterStage.id !== 'preprocess.arbiter') {
    throw new TypeError('Pre-process graph requires the canonical preprocess.arbiter stage.');
  }
  const cardStages = pipelineMode === 'fused'
    ? createFusedCardStages({ selectedCards, ...fused })
    : createSegmentedCardStages({ selectedCards, ...segmented });
  return createExecutionGraph({
    stages: [arbiterStage, ...cardStages]
  });
}
