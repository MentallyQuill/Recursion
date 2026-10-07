import assert from 'node:assert/strict';
import { runCardBudgetFixture } from '../../tests/helpers/card-budget-fixture.mjs';
import { createStorageRepository, createMemoryStorageAdapter } from '../../src/storage.mjs';

const writeFailureRepo = createStorageRepository({ storage: createMemoryStorageAdapter() });
const saveArtifact = writeFailureRepo.savePipelineArtifact.bind(writeFailureRepo);
writeFailureRepo.savePipelineArtifact = async (...args) => {
  if (String(args[2]).startsWith('preprocess.cards.segmented.knowledge')) throw new Error('Artifact storage unavailable.');
  return saveArtifact(...args);
};
const writeFailed = await runCardBudgetFixture({ storage: writeFailureRepo, authoredCount: 0, cardsPerTurn: 2,
  allowedFamilies: ['Scene Frame', 'Knowledge'], proposed: ['Scene Frame', 'Knowledge'] });
assert.equal(writeFailed.result.ok, false, 'optional cards cannot mask an artifact storage failure');
assert.equal(writeFailed.installed, null, 'a storage failure stops installation');

for (const pipelineMode of ['segmented', 'fused']) {
  const fixture = await runCardBudgetFixture({ pipelineMode, authoredCount: 0, cardsPerTurn: 2,
    allowedFamilies: ['Scene Frame', 'Knowledge'], proposed: ['Scene Frame', 'Knowledge'], failedFamily: 'Knowledge' });
  assert.equal(fixture.result.ok, true, 'optional generation exhaustion installs a smaller grounded hand');
  assert.deepEqual(fixture.view.lastHand.cards.map(card => card.family), ['Scene Frame']);
  assert.equal(fixture.installed.selectedCardRefs.length, 1, 'only validated surviving cards reach installation');
  assert.equal(fixture.view.execution.state, 'completed', 'optional stage failure settles the durable operation');
  assert.equal(fixture.runtime.view().activity.severity, 'warning', 'smaller hand is visibly degraded');
  assert.equal(fixture.view.execution.stageRecords['preprocess.cards.segmented.knowledge'].recoveryCounts.shapeFailures, 2, 'counts come from observed failed attempts');
}
const successful = await runCardBudgetFixture({ authoredCount: 0, cardsPerTurn: 1, allowedFamilies: ['Knowledge'], proposed: ['Knowledge'] });
const lost = await runCardBudgetFixture({ authoredCount: 0, cardsPerTurn: 1, allowedFamilies: ['Knowledge'], proposed: ['Knowledge'],
  lifecycle: [{ action: 'stow', cardId: successful.view.lastHand.cards[0].id }] });
assert.equal(lost.result.ok, false, 'a successfully generated card lost downstream still blocks hand coverage');
for (const options of [
  { allowedFamilies: ['Scene Constraints'], proposed: ['Scene Constraints'], failedFamily: 'Scene Constraints' },
  { allowedFamilies: ['Knowledge'], proposed: ['Knowledge'], failedFamily: 'Knowledge', priorityFamily: 'Knowledge' },
  { mode: 'manual', allowedFamilies: ['Knowledge'], proposed: ['Knowledge'], failedFamily: 'Knowledge' },
  { allowedFamilies: ['Knowledge'], proposed: ['Knowledge'], failedFamily: 'Knowledge',
    configureDeck: deck => { for (const card of Object.values(deck.cards)) if (card.builtinFamily === 'Knowledge') card.selectionState = 'refinement'; } }
]) {
  const required = await runCardBudgetFixture({ ...options, authoredCount: 0, cardsPerTurn: 1 });
  assert.equal(required.result.ok, false, 'required Scene Constraints, Priority, Manual, and Refinement cannot be omitted');
  assert.equal(required.installed, null, 'required failure stops installation');
}
const truncated = await runCardBudgetFixture({ pipelineMode: 'fused', authoredCount: 0, cardsPerTurn: 2,
  allowedFamilies: ['Scene Frame', 'Knowledge'], proposed: ['Scene Frame', 'Knowledge'],
  providerOverride: (roleId) => roleId === 'fusedCardBundle' ? { ok: false,
    error: { code: 'RECURSION_PROVIDER_TOKEN_LIMIT', category: 'provider-length' },
    recoverableItems: [{ family: 'Scene Frame', promptText: 'Keep the archive doorway visible.', evidenceRefs: ['message:2'] }]
  } : undefined
});
assert.equal(truncated.result.ok, true, 'truncated Fused response completes through a narrow repair');
assert.equal(truncated.calls.filter(call => call.roleId === 'knowledgeSecretsCard').length, 1, 'only unresolved Knowledge is regenerated');
assert.equal(truncated.calls.filter(call => call.roleId === 'sceneFrameCard').length, 0, 'validated Scene Frame sibling is preserved');
assert.equal(truncated.view.execution.stageRecords['preprocess.cards.fused'].recoveryCounts.salvagedItems, 1, 'validated salvage is counted from the accepted artifact');
const contextLimited = await runCardBudgetFixture({ pipelineMode: 'fused', authoredCount: 0, cardsPerTurn: 2,
  allowedFamilies: ['Scene Frame', 'Knowledge'], proposed: ['Scene Frame', 'Knowledge'],
  providerOverride: roleId => roleId === 'fusedCardBundle' ? { ok: false,
    error: { code: 'RECURSION_PROVIDER_CONTEXT_LIMIT', category: 'capacity', kind: 'transport' }
  } : undefined
});
assert.equal(contextLimited.result.ok, true, 'exhausted Fused capacity narrows and completes');
const capacityCalls = contextLimited.calls.filter(call => call.roleId === 'fusedCardBundle');
assert.equal(capacityCalls.length, 2, 'capacity uses the bounded attempt window');
assert(capacityCalls[1].request.responseLength < (capacityCalls[0].request.responseLength || capacityCalls[0].request.providerConfig.outputTokenCeiling), 'capacity retry reduces actual output reservation');
assert(contextLimited.calls.some(call => call.roleId === 'knowledgeSecretsCard'), 'capacity fallback creates individual work');
assert(!contextLimited.calls.some(call => call.request.prompt?.includes('[invalid-card]')), 'capacity fallback does not invent a semantic rejection');
const refusal = await runCardBudgetFixture({ pipelineMode: 'fused', authoredCount: 0, cardsPerTurn: 2,
  allowedFamilies: ['Scene Frame', 'Knowledge'], proposed: ['Scene Frame', 'Knowledge'],
  providerOverride: roleId => roleId === 'fusedCardBundle' ? { ok: false,
    error: { code: 'RECURSION_PROVIDER_REFUSAL', category: 'provider-request', kind: 'transport' }
  } : undefined
});
assert.equal(refusal.result.ok, true, 'optional-only refusal produces an explicit smaller hand');
assert.equal(refusal.view.execution.stageRecords['preprocess.cards.fused'].recoveryCounts.optionalOmissions, 2, 'explicit refusal counts the omitted requested families');
assert.equal(refusal.view.execution.stageRecords['preprocess.cards.fused'].summary.omissionCause, 'RECURSION_PROVIDER_REFUSAL', 'refusal remains identifiable without salvage');
console.log('Durable card recovery tests passed.');
