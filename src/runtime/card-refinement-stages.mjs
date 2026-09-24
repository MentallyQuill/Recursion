import { hashJson } from '../core.mjs';
import { getActiveCardDeck, getDeckCardStatus } from '../pre-process-decks.mjs';
import {
  collectRefinementTargets,
  buildRefinementRequest,
  validateRefinementResult,
  applyRefinementDraft,
  finalizeRefinementHand
} from '../card-refinement.mjs';

export const REFINED_HAND_STAGE_ID = 'preprocess.refinement.hand';
const STAGE_SCHEMA = 'recursion.cardRefinementStage.v1';
const PHASE_IDS = Object.freeze({
  prepare: 'preprocess.refinement.prepare',
  review: 'preprocess.refinement.review',
  revise: 'preprocess.refinement.revise',
  verify: 'preprocess.refinement.verify'
});

export function hasCardRefinement(settings = {}) {
  return Object.values(getActiveCardDeck(settings).cards).some(card =>
    card.selectionState === 'refinement' && getDeckCardStatus(card).runnable);
}

function failure(code, message) {
  return { ok: false, error: { code, message, retryable: false,
    suggestedAction: 'Inspect the Refinement result and retry, or change the card state.' } };
}

function refinementSummary(value) {
  return {
    status: value.status,
    targetCount: value.targets.length,
    reviewCount: value.reviews.length,
    revisionCount: value.revisedCardIds.length ? 1 : 0,
    revisedCardCount: value.revisedCardIds.length,
    targets: value.targets.map(target => ({
      id: target.id, cardId: target.cardId, name: target.name,
      outcome: value.reviews.at(-1)?.items.find(item => item.targetId === target.id)?.verdict || 'pending'
    }))
  };
}

// Semantic rounds are separate durable stages. Transport retries stay inside each stage.
export function createCardRefinementStages({ settings, snapshot, snapshotHash, generate }) {
  if (!hasCardRefinement(settings)) return [];
  const inputs = (phase, dependencies) => {
    if (phase === 'prepare') {
      const hand = dependencies['preprocess.hand'].artifact;
      const { targets } = collectRefinementTargets(settings, hand);
      return { schema: STAGE_SCHEMA, hand, targets, reviews: [], revisedCardIds: [], status: 'pending' };
    }
    const previous = { review: 'prepare', revise: 'review', verify: 'revise' }[phase];
    return dependencies[PHASE_IDS[previous]].artifact;
  };
  const requestFor = (phase, dependencies) => {
    const input = inputs(phase, dependencies);
    let targets = input.targets;
    if (phase === 'prepare') targets = targets.filter(target => target.authored);
    if (phase === 'revise') {
      const rejected = new Set(input.reviews[0].items.filter(item => item.verdict === 'revise').map(item => item.targetId));
      const affected = new Set(targets.filter(target => rejected.has(target.id)).map(target => target.cardId));
      targets = targets.filter(target => affected.has(target.cardId));
    }
    if (phase === 'verify') targets = targets.filter(target => input.revisedCardIds.includes(target.cardId));
    if (!targets.length) return null;
    return buildRefinementRequest({
      phase, snapshot, snapshotHash, hand: input.hand, targets,
      review: input.reviews[0] || null
    });
  };
  const phases = Object.keys(PHASE_IDS).map(phase => ({
    id: PHASE_IDS[phase], version: 1, kind: 'model', executable: true,
    dependencies: phase === 'prepare'
      ? ['preprocess.hand', 'preprocess.snapshot']
      : [PHASE_IDS[{ review: 'prepare', revise: 'review', verify: 'revise' }[phase]]],
    checkpoint: 'durable', failurePolicy: 'blocking', providerLane: 'reasoner',
    buildInputFingerprint(_context, dependencies) {
      return { snapshotHash, settingsHash: hashJson(settings.preProcessDecks),
        inputs: Object.fromEntries(Object.entries(dependencies).map(([id, entry]) => [id, entry.checkpoint?.outputHash])) };
    },
    buildRequest(_context, dependencies) {
      return requestFor(phase, dependencies) || { skipRefinementCall: true };
    },
    async run({ request, signal, attempt }) {
      if (request.skipRefinementCall) return { skipped: true };
      return { response: await generate(request.roleId, { ...request, signal }, { signal, stageAttempt: attempt }) };
    },
    validate(result, { dependencies, reuse = false } = {}) {
      if (reuse) {
        return result?.schema === STAGE_SCHEMA && Array.isArray(result?.hand?.cards)
          && Array.isArray(result.targets) && Array.isArray(result.reviews) && Array.isArray(result.revisedCardIds)
          ? { ok: true, value: result }
          : failure('RECURSION_REFINEMENT_CHECKPOINT_INVALID', 'The saved Refinement result is incomplete.');
      }
      const input = inputs(phase, dependencies);
      const request = requestFor(phase, dependencies);
      if (!request) return { ok: true, value: { ...input, status: 'not-needed' } };
      if (result?.response?.ok === false && !['RECURSION_JSON_OBJECT_REQUIRED', 'RECURSION_JSON_PARSE_FAILED',
        'RECURSION_PROVIDER_SCHEMA_MISMATCH'].includes(result.response.error?.code)) {
        return { ok: false, error: { ...result.response.error, kind: 'transport' } };
      }
      const checked = validateRefinementResult(result?.response, request);
      if (!checked.ok) return checked;
      if (phase === 'prepare' || phase === 'revise') {
        return { ok: true, value: { ...input,
          hand: applyRefinementDraft(input.hand, checked.value),
          revisedCardIds: phase === 'revise' ? checked.value.items.map(item => item.cardId) : [],
          status: phase === 'prepare' ? 'prepared' : 'revised'
        } };
      }
      return { ok: true, value: { ...input,
        reviews: [...input.reviews, checked.value],
        status: checked.value.items.some(item => item.verdict === 'revise') ? 'changes-requested' : 'accepted'
      } };
    },
    buildCorrectionRequest({ request, error }) {
      return { ...request, prompt: `${request.prompt}\n\nCorrect the invalid structured result. Preserve the original task, requested IDs, and supplied evidence. Validation: ${String(error?.message || 'Invalid result').slice(0, 600)}` };
    },
    summarizeArtifact: refinementSummary
  }));
  return [...phases, {
    id: REFINED_HAND_STAGE_ID, version: 1, kind: 'local', executable: true,
    retryFromStageId: PHASE_IDS.review,
    dependencies: ['preprocess.hand', PHASE_IDS.verify], checkpoint: 'durable', failurePolicy: 'blocking',
    buildInputFingerprint(_context, dependencies) {
      return Object.fromEntries(Object.entries(dependencies).map(([id, entry]) => [id, entry.checkpoint.outputHash]));
    },
    run({ dependencies }) {
      const value = dependencies[PHASE_IDS.verify].artifact;
      // Reject an unresolved semantic review here, outside transport correction retries.
      const verdicts = new Map(value.reviews.flatMap(review => review.items).map(item => [item.targetId, item.verdict]));
      if (!value.targets.length || value.targets.some(target => verdicts.get(target.id) !== 'accept')) {
        throw Object.assign(new Error('Refinement still found unresolved issues after the allowed revision. Retry starts a fresh review cycle.'), {
          code: 'RECURSION_REFINEMENT_UNRESOLVED', retryable: false,
          suggestedAction: 'Retry to review the marked cards again, or change their instructions or state.'
        });
      }
      return finalizeRefinementHand(dependencies['preprocess.hand'].artifact,
        value.hand, value.targets, value.reviews);
    },
    validate(result) {
      return result?.metadata?.refinement?.targetCount > 0 && Array.isArray(result.cards)
        ? { ok: true, value: result }
        : failure('RECURSION_REFINEMENT_HAND_INVALID', 'Refinement did not produce an accepted hand.');
    },
    summarizeArtifact(result) {
      return { status: result.metadata.refinement.revisionCount ? 'reviewed-revised' : 'reviewed-unchanged',
        ...result.metadata.refinement };
    }
  }];
}
