import assert from 'node:assert/strict';
import { progressFromExecution, createProgressRunModel } from '../../src/progress.mjs';

export function recoveredFusedExecution(repairState = 'completed', { graph = true } = {}) {
  return {
    operationId: 'fused-recovery-test', state: repairState === 'completed' ? 'completed' : 'running',
    stageRecords: {
      fused: { stageId: 'preprocess.cards.fused', state: 'completed',
        ...(graph ? { outcomeChildren: ['Scene Frame', 'Character Motivation'].map((family) => ({
          id: `preprocess.cards.fused.${family.toLowerCase().replaceAll(' ', '-')}`, selectedCard: { family }, executable: false
        })) } : {}),
        summary: { acceptedFamilies: ['Scene Frame'], unresolvedFamilies: ['Character Motivation'],
          rejections: [{ family: 'Character Motivation', code: 'private-claim' }], fallback: 'segmented' } },
      repair: { stageId: 'preprocess.cards.segmented.character-motivation', state: repairState,
        summary: { family: 'Character Motivation' } },
      install: { stageId: 'preprocess.install', state: repairState === 'completed' ? 'completed' : 'pending' }
    }
  };
}

for (const graph of [true, false]) {
  const progress = progressFromExecution(recoveredFusedExecution('completed', { graph }));
  const bundle = progress.steps.find((step) => step.id === 'preprocess.cards.fused');
  const child = bundle.children.find((step) => step.label === 'Character Motivation');
  assert.equal(bundle.state, 'done', 'successful repair clears the red Fused parent');
  assert.equal(child.state, 'done', 'successful repair clears the red Fused child');
  assert.equal(child.meta, 'recovered', 'repair remains visible');
  assert.match(child.reason, /private-claim/, 'original rejection remains inspectable');
  assert.ok(!JSON.stringify(progress).includes('unexpected internal error'));
  assert.equal(progress.title, 'Ready');
  const normalized = createProgressRunModel({ execution: recoveredFusedExecution('completed', { graph }) });
  assert.ok(!JSON.stringify(normalized).includes('unexpected internal error'));
}
console.log('[pass] recovered Fused progress survives reload');

for (const graph of [true, false]) for (const repairState of ['pending', 'running']) {
  const progress = progressFromExecution(recoveredFusedExecution(repairState, { graph }));
  const bundle = progress.steps.find((step) => step.id === 'preprocess.cards.fused');
  const child = bundle.children.find((step) => step.label === 'Character Motivation');
  assert.equal(child.state, repairState, 'repair progress replaces the historical failed child');
  assert.equal(child.meta, 'repairing');
  assert.ok(!['failed', 'warning'].includes(bundle.state), 'in-progress repair is not a terminal error');
  assert.match(child.reason, /private-claim/);
}
console.log('[pass] Fused repair in progress');

const awaitingRepair = recoveredFusedExecution('pending');
delete awaitingRepair.stageRecords.repair;
assert.equal(progressFromExecution(awaitingRepair).steps[0].meta, 'repairing', 'the wave transition must not flash a terminal failure');

for (const repairState of ['failed', 'skipped']) {
  const failed = recoveredFusedExecution(repairState);
  failed.state = 'completed'; // Optional failed work may continue, but remains unresolved.
  const progress = progressFromExecution(failed);
  assert.equal(progress.steps[0].state, 'failed');
  assert.equal(progress.title, 'Needs attention');
  assert.match(progress.steps[0].reason, /private-claim/);
  assert.ok(!progress.steps[0].reason.includes('unexpected internal error'));
}
console.log('[pass] Fused repair transition and unresolved failures');

const retriedBundle = recoveredFusedExecution();
retriedBundle.stageRecords.fused.attempts = { total: 2 };
const recoveredAfterRetries = progressFromExecution(retriedBundle);
assert.equal(recoveredAfterRetries.steps[0].state, 'done', 'successful recovery supersedes failed bundle attempts');
assert.equal(recoveredAfterRetries.steps[0].meta, 'recovered');
assert.equal(recoveredAfterRetries.steps[0].retryCount, 1, 'attempt history remains available');
retriedBundle.stageRecords.repair.attempts = { total: 2 };
const repairedAfterRetries = progressFromExecution(retriedBundle);
const repairGroup = repairedAfterRetries.steps.find((step) => step.id === 'preprocess.cards.segmented');
assert.equal(repairGroup.state, 'done', 'a successful targeted repair does not leave its separate group amber');
assert.equal(repairGroup.children[0].meta, 'recovered');
assert.equal(repairGroup.children[0].retryCount, 1);
assert.equal(repairedAfterRetries.heroPixelState, 'done');
