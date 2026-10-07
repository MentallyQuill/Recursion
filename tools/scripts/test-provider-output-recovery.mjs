import assert from 'node:assert/strict';
import { createGenerationRouter, createProviderClient } from '../../src/providers.mjs';
import { createSettingsStore } from '../../src/settings.mjs';

const store = createSettingsStore({ root: {} });
store.updateProviderConfig('utility', { connectionProfileId: 'profile-utility' });
const completeCard = { family: 'Scene Frame', promptText: 'Keep the doorway visible.', evidenceRefs: ['message:8'] };
const partialText = '{"items":[' + JSON.stringify(completeCard) + ',{"family":';
const request = { requestedCards: [{ family: 'Scene Frame' }] };
const profiles = [{ id: 'profile-utility', name: 'Utility', model: 'synthetic-model', api: 'openai', completionMode: 'chat' }];
function routerFor(response) {
  return createGenerationRouter({ client: createProviderClient({ settingsStore: store,
    host: { connectionProfiles: { list: () => profiles }, generation: { generate: async () => response } }
  }) });
}
const tokenResult = await routerFor({ choices: [{ finish_reason: 'length', message: { content: partialText } }] })
  .generate('fusedCardBundle', request);
assert.equal(tokenResult.error.code, 'RECURSION_PROVIDER_TOKEN_LIMIT', 'token fragments retain their provider cause');
assert.deepEqual(tokenResult.recoverableItems, [completeCard], 'normalized token-limit visible content reaches transient salvage');
for (const response of [
  { choices: [{ finish_reason: 'length', message: { content: partialText, refusal: 'Declined' } }] },
  { choices: [{ finish_reason: 'content_filter', message: { content: partialText } }] }
]) {
  assert.deepEqual((await routerFor(response).generate('fusedCardBundle', request)).recoverableItems, [],
    'refusal and filtered visible content never becomes salvage');
}
for (const code of ['RECURSION_PROVIDER_AUTH_FAILED', 'RECURSION_PROVIDER_ABORTED', 'RECURSION_PROVIDER_RATE_LIMIT']) {
  const fake = createGenerationRouter({ client: { generate: async () => { throw Object.assign(new Error('Provider failed.'), { code, recoverableText: partialText }); } } });
  assert.deepEqual((await fake.generate('fusedCardBundle', request)).recoverableItems, [], 'ineligible failure codes cannot salvage apparently valid content');
}
const journalRecords = [];
const journalRouter = createGenerationRouter({ client: { generate: async () => ({ text: partialText }) },
  journal: { append: async (record) => journalRecords.push(record) }
});
await journalRouter.generate('fusedCardBundle', request);
assert.equal(journalRecords.length, 2, 'provider start and failure actually reached the journal boundary');
assert.equal(JSON.stringify(journalRecords).includes('Keep the doorway visible.'), false, 'transient items never enter the provider journal');
const structuredTooDeep = JSON.parse('{"nested":'.repeat(65) + 'true' + '}'.repeat(65));
const structuredFailure = await createGenerationRouter({ client: { generate: async () => ({ structured: structuredTooDeep }) } }).generate('utilityArbiter', {});
assert.equal(structuredFailure.error.code, 'RECURSION_JSON_DEPTH_LIMIT', 'already parsed transport output cannot bypass structural bounds');
const batchRouter = createGenerationRouter({ client: { generate: async () => ({ text: partialText }), batch: async () => [{ text: partialText }] } });
const batchResult = await batchRouter.batch([{ roleId: 'fusedCardBundle', ...request }]);
assert.deepEqual(batchResult[0].recoverableItems, [completeCard], 'batch failures use the same transient fragment boundary');
const tokenBatchClient = routerFor({ choices: [{ finish_reason: 'length', message: { content: partialText } }] });
const tokenBatchResult = await tokenBatchClient.batch([{ roleId: 'fusedCardBundle', ...request }]);
assert.deepEqual(tokenBatchResult[0].recoverableItems, [completeCard], 'profile client preserves token fragments independently in each batch slot');
console.log('[pass] provider output recovery');
