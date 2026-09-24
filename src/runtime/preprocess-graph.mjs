import { createExecutionGraph } from '../execution/stage-registry.mjs';
import { summarizeFusedOutcome } from '../fused-recovery.mjs';

function selectedCardKey(card) {
  const source = card && typeof card === 'object' ? card : {};
  const value = typeof card === 'string'
    ? card
    : source.family || source.role || source.roleId || source.id || '';
  return String(value).trim();
}

function stageIdPart(value) {
  const part = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!part) throw new TypeError('Selected card requires a stable family, role, roleId, or id.');
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
      failurePolicy: selectedCard?.forcedBy || selectedCardKey(selectedCard) === 'Scene Constraints' ? 'blocking' : 'continue',
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
      buildCorrectionRequest({ request, error }) {
        return { ...request, prompt: `${request.prompt || ''}\n\nCorrect the previous invalid ${selectedCardKey(selectedCard)} card. Preserve the requested JSON schema and supplied source evidence.\nValidation: ${String(error?.message || 'Card validation failed.').slice(0, 600)}\nReturn only the corrected card; do not include private reasoning or analysis.` };
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
  const cards = value.cards && typeof value.cards === 'object' ? value.cards : {};
  const acceptedFamilies = Object.keys(cards);
  const unresolvedFamilies = selectedCards
    .map(selectedCardKey)
    .filter((family) => family && !cards[family]);
  const outcomes = value.outcomes && typeof value.outcomes === 'object'
    ? value.outcomes
    : Object.fromEntries(selectedCards.map((card) => [
        selectedCardKey(card),
        { state: 'failed', reason: 'invalid-card' }
      ]));
  return {
    ...value,
    cards,
    outcomes,
    acceptedFamilies,
    unresolvedFamilies,
    fallback: {
      mode: 'segmented',
      reason: acceptedFamilies.length
        ? 'unresolved-fused-families'
        : 'zero-useful-fused-cards',
      families: unresolvedFamilies
    }
  };
}

export function createFusedCardStages({
  selectedCards = [],
  createBundleRequest,
  validateBundle,
  generateBundle
} = {}) {
  const cards = Array.isArray(selectedCards) ? [...selectedCards] : [];
  const build = requireFunction(createBundleRequest, 'createBundleRequest');
  const validate = requireFunction(validateBundle, 'validateBundle');
  const generate = requireFunction(generateBundle, 'generateBundle');

  return [Object.freeze({
    id: 'preprocess.cards.fused',
    version: 2,
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
    buildCorrectionRequest({ request, error }) {
      const feedback = [
        'Correct the previous invalid bundle. Return JSON only with shape:',
        '{"items":[{"family":"requested family","promptText":"grounded instruction","evidenceRefs":["message:0"],"coveredSourceCardIds":[]}]}',
        `Requested families: ${cards.map(selectedCardKey).join(', ')}.`,
        `Validation: ${String(error?.message || 'No valid grounded cards were returned.').slice(0, 600)}`,
        'Use one item per requested family and only evidence references from the supplied snapshot.'
      ].join('\n');
      return { ...request, prompt: `${request.prompt || ''}\n\n${feedback}` };
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
    async settleExhausted({
      lastArtifact,
      failure,
      context,
      dependencies
    } = {}) {
      if (['RECURSION_PROVIDER_REFUSAL', 'RECURSION_PROVIDER_CONTENT_FILTER'].includes(failure?.code)
          && !cards.some((card) => card?.forcedBy || selectedCardKey(card) === 'Scene Constraints')) {
        return { ok: true, value: {
          cards: {}, acceptedFamilies: [], unresolvedFamilies: cards.map(selectedCardKey), fallback: null,
          outcomes: Object.fromEntries(cards.map((card) => [selectedCardKey(card), { state: 'failed', reason: failure.code }])),
          diagnostics: [{ code: failure.code, message: 'Optional card work was omitted after a provider refusal.' }]
        } };
      }
      if (['RECURSION_PROVIDER_REFUSAL', 'RECURSION_PROVIDER_CONTENT_FILTER',
        'RECURSION_RECOVERY_BUDGET_EXHAUSTED', 'RECURSION_OPERATION_DEADLINE'].includes(failure?.code)) {
        return { ok: false, failure };
      }
      // Narrower card prompts cannot repair an unavailable provider connection.
      // Only rejected model output may settle into Segmented card repair.
      if (failure?.kind === 'transport' || failure?.category !== 'validation') {
        return { ok: false, failure };
      }
      const validated = validationResult(
        await validate(lastArtifact, {
          context,
          dependencies,
          selectedCards: cards,
          exhausted: true
        }),
        lastArtifact
      );
      return {
        ok: true,
        value: fallbackArtifact(validated, cards)
      };
    },
    summarize(artifact) {
      return summarizeFusedOutcome(artifact);
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
