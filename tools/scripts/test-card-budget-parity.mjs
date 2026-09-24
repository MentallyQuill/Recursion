import { runCardBudgetFixture } from '../../tests/helpers/card-budget-fixture.mjs';
import { progressFromExecution } from '../../src/progress.mjs';
import { assert, assertEqual, assertDeepEqual } from '../../tests/helpers/assert.mjs';

const segmented = await runCardBudgetFixture();
assertEqual(segmented.result.ok, true, 'target hand prepares successfully');
assertEqual(segmented.view.lastHand.cards.length, 10, 'Medium 8-12 fills ten total slots despite an Arbiter budget of one');
assertEqual(segmented.view.lastPlan.cardJobs.length, 7, 'three authored Priority cards leave seven generated slots');
assertDeepEqual(segmented.view.lastHand.cards.slice(0, 3).map(card => card.id),
  ['authored-0', 'authored-1', 'authored-2'], 'authored Priority stays in deck order');
assertEqual(segmented.view.lastPlan.cardJobs[0].family, 'Knowledge', 'Arbiter ranking remains first among ordinary families');
assert(segmented.installed, 'target hand reaches prompt installation');
for (const partial of [false, true]) {
  const fused = await runCardBudgetFixture({ pipelineMode: 'fused', partial });
  assertEqual(fused.result.ok, true, 'complete or repaired Fused hand prepares');
  assertDeepEqual(fused.view.lastPlan.cardJobs, segmented.view.lastPlan.cardJobs, 'workflow does not alter finalized selection');
  assertDeepEqual(fused.view.lastHand.cards.map(card => card.id), segmented.view.lastHand.cards.map(card => card.id), 'Fused and Segmented deliver identical card identities');
  const repairs = fused.calls.filter(call => call.request.metadata?.family);
  assertEqual(repairs.length, partial ? 6 : 0, 'only missing Fused siblings get individual repairs');
  const composer = fused.calls.find(call => call.roleId === 'guidanceComposer');
  for (const card of fused.view.lastHand.cards) {
    assert(composer.request.prompt.includes(card.promptText), 'each selected card reaches composition');
    assert(fused.installed.selectedCardRefs.some(ref => ref.id === card.id || ref.cardId === card.id), 'each selected card is represented in the installed packet');
  }
  const beforeReuse = fused.calls.length;
  const reuse = await fused.runtime.prepareForGeneration({ userMessage: { text: 'I ask what she remembers.', mesid: 2 } });
  assertEqual(reuse.ok, true, 'same-turn cached preparation succeeds');
  assertEqual(fused.calls.length, beforeReuse, 'same-turn reuse does not generate again');
  const reusedProgress = progressFromExecution(fused.runtime.view().execution);
  assert(reusedProgress.steps.find(step => step.id === 'preprocess.hand').reason.includes('10 cards included'), 'cached hand keeps its count summary');
  assertEqual(reusedProgress.steps.find(step => step.id === 'preprocess.cards.fused').children.length, 7, 'cached Fused outcomes remain visible');
}
for (const reasoningLevel of ['low', 'medium', 'high', 'ultra']) {
  const expected = reasoningLevel === 'low' ? 8 : reasoningLevel === 'ultra' ? 12 : 10;
  const fixture = await runCardBudgetFixture({ reasoningLevel, strength: 'light' });
  assertEqual(fixture.result.ok, true, 'reasoning target prepares');
  assertEqual(fixture.view.lastHand.cards.length, expected, 'reasoning determines target and Light does not subtract a card');
}
const scarce = await runCardBudgetFixture({ allowedFamilies: ['Knowledge'], authoredCount: 1 });
assertEqual(scarce.view.lastHand.cards.length, 2, 'insufficient eligible families never invent cards');
assertEqual(scarce.view.lastPlan.selection.shortfallReason, 'insufficient-eligible-cards', 'selection records why it cannot fill the target');
assertEqual(scarce.view.lastHand.metadata.selection.shortfallCount, 8, 'delivered hand quantifies the shortfall');
const handStep = fixture => progressFromExecution(fixture.view.execution).steps.find(step => step.id === 'preprocess.hand');
assert((handStep(segmented).reason || '').includes('10 cards included · 3 authored · 7 generated'), 'progress explains the total and its contributions');
assert((handStep(scarce).reason || '').includes('8 below target: not enough eligible cards'), 'progress explains an eligibility shortfall');
assertEqual(handStep(scarce).state, 'warning', 'shortfall remains visible even when authored children succeeded');
for (const pipelineMode of ['fused', 'segmented']) {
  const duplicate = await runCardBudgetFixture({ pipelineMode, proposed: Array(7).fill('Knowledge') });
  assertEqual(duplicate.result.ok, true, 'duplicate rankings prepare successfully');
  assertDeepEqual(duplicate.view.lastHand.cards.map(card => card.id), segmented.view.lastHand.cards.map(card => card.id), 'duplicate rankings preserve first preference and fill distinct slots');
  const overflow = await runCardBudgetFixture({ pipelineMode, minCards: 1, maxCards: 1, authoredCount: 3, priorityFamily: 'Environment' });
  assertEqual(overflow.result.ok, true, 'mandatory overflow prepares');
  assertEqual(overflow.view.lastHand.cards.length, 4, 'all four Priority units survive a target of one');
  assertDeepEqual(overflow.view.lastPlan.cardJobs.map(job => job.family), ['Environment'], 'overflow schedules no ordinary work');
  const empty = await runCardBudgetFixture({ pipelineMode, minCards: 0, maxCards: 0, authoredCount: 0 });
  assertEqual(empty.result.ok, true, 'explicit zero target prepares without cards');
  assertEqual(empty.view.lastHand.cards.length, 0, 'zero target retains no cards');
  assert(!empty.calls.some(call => call.roleId === 'fusedCardBundle' || call.request.metadata?.family), 'zero target creates no card provider calls');
  const failed = await runCardBudgetFixture({ pipelineMode, failedFamily: 'Knowledge' });
  assertEqual(failed.result.ok, true, 'ordinary failure preserves useful sibling work');
  assertEqual(failed.view.lastHand.cards.length, 9, 'failed selected family is not replaced with invented fallback content');
  assert(failed.view.lastHand.metadata.selection.shortfallReasons.includes('card-generation-failed'), 'failed generation is distinguished from eligibility');
  assert(handStep(failed).reason.includes('selected cards failed generation'), 'progress explains provider shortfall');
  const saved = await failed.storage.loadPipelineRun('budget');
  assertDeepEqual(progressFromExecution(saved).steps.find(step => step.id === 'preprocess.hand').reason,
    handStep(failed).reason, 'saved manifest restores the same hand summary');
}

console.log('[pass] card budget parity');
