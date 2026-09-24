import assert from 'node:assert/strict';
import { createCardRefinementStages } from '../../src/runtime/card-refinement-stages.mjs';
import { runModelStageAttempts } from '../../src/execution/attempt-policy.mjs';

const settings = { preProcessDecks: { activeDeckId: 'default', defaultCardStates: {
  'realismCard:claimsNeedCorroboration': 'refinement'
} } };
const hand = { cards: [{ id: 'realism', family: 'Realism', promptText: 'Track the claim.',
  sourceCardIds: ['realismCard:claimsNeedCorroboration'], evidenceRefs: ['message:1'] }] };
const dependencies = { 'preprocess.hand': { artifact: hand }, 'preprocess.snapshot': { artifact: {} } };
const options = { settings, snapshot: { messages: [{ mesid: 1, text: 'She claims another world exists.' }] }, snapshotHash: 'scene' };
assert.deepEqual(createCardRefinementStages({ ...options, settings: {} }), [], 'ordinary cards add no stages');
let calls = 0;
const stages = createCardRefinementStages({ ...options, generate: async () => {
  calls++;
  return { ok: false, error: { code: 'RECURSION_PROVIDER_RATE_LIMIT', retryable: true, retryAfterMs: 0 } };
} });
const prepare = stages[0];
const prepared = prepare.validate(await prepare.run({ request: prepare.buildRequest({}, dependencies) }), { dependencies });
assert.equal(calls, 0, 'generated analysis needs no preparation call');
assert.equal(prepared.ok, true);
dependencies[prepare.id] = { artifact: prepared.value };
const review = stages[1];
const request = review.buildRequest({}, dependencies);
const rateResult = await runModelStageAttempts({ request, attemptsPerStep: 2,
  invoke: request => review.run({ request }),
  validate: result => review.validate(result, { dependencies }),
  buildCorrectionRequest: review.buildCorrectionRequest, sleep: async () => {}
});
assert.equal(rateResult.ok, false);
assert.equal(calls, 2);
assert.equal(rateResult.attempts[0].action, 'retry-same', 'provider failure remains transport, not a semantic correction');
assert.equal(rateResult.attempts[0].diagnosticCode, 'provider-rate-limit-retry');

const accepted = { schema: request.responseSchema, snapshotHash: request.snapshotHash,
  items: request.refinementTargetIds.map(targetId => ({ targetId, verdict: 'accept', findings: [] })) };
dependencies[review.id] = { artifact: review.validate({ response: { ok: true, data: accepted } }, { dependencies }).value };
for (const stage of stages.slice(2, 4)) {
  const nextRequest = stage.buildRequest({}, dependencies);
  assert.equal(nextRequest.skipRefinementCall, true, 'accepted analysis does not get unnecessary model work');
  dependencies[stage.id] = { artifact: stage.validate(await stage.run({ request: nextRequest }), { dependencies }).value };
}
const final = stages.at(-1).run({ dependencies });
assert.equal(final.metadata.refinement.targetCount, 1);
assert.equal(final.cards[0], hand.cards[0], 'accepted original remains unchanged');
console.log('[pass] card-refinement durable stages');
