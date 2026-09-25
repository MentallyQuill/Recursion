import assert from 'node:assert/strict';
import { progressFromExecution, createProgressRunModel } from '../../src/progress.mjs';
import { summarizeExecutionForDiagnostics } from '../../src/runtime/diagnostics.mjs';

{
  const failure = { code: 'RECURSION_PROVIDER_RATE_LIMIT', failureClass: 'capacity', retryable: true,
    message: 'The selected profile is rate limited.' };
  for (const state of ['running', 'failed']) {
    const execution = { operationId: 'limited', state: state === 'running' ? 'running' : 'paused', stageRecords: {
      fused: { stageId: 'preprocess.cards.fused', state, failure,
        outcomeChildren: [{ id: 'preprocess.cards.fused.realism', family: 'Realism' }] }
    } };
    const progress = progressFromExecution(execution);
    assert.ok(!JSON.stringify(progress).includes('invalid-card'), 'provider failure cannot invent a card rejection');
    assert.match(progress.steps[0].reason, /rate limited/i, 'bundle displays the provider cause');
    if (state === 'failed') assert.match(progress.steps[0].children[0].reason, /rate limited/i);
  }
}

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
  assert.equal(child.meta, 'done', 'successful repair reads as normal completion');
  assert.equal(child.reason, null, 'resolved rejection stays out of ordinary progress');
  assert.equal(bundle.meta, 'done');
  assert.equal(bundle.reason, null);
  const repairGroup = progress.steps.find((step) => step.id === 'preprocess.cards.segmented');
  assert.equal(repairGroup.meta, 'done');
  assert.equal(repairGroup.children[0].meta, 'done');
  assert.equal(repairGroup.children[0].reason, null);
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

{
  const execution = recoveredFusedExecution('pending');
  execution.state = 'paused';
  execution.pauseReason = 'operation-deadline';
  execution.frontierStageIds = ['preprocess.cards.segmented.character-motivation'];
  execution.stageRecords.repair.failure = { code: 'RECURSION_PROVIDER_RATE_LIMIT',
    message: 'The selected profile is rate limited.' };
  const progress = createProgressRunModel({ execution });
  const bundle = progress.steps.find(step => step.id === 'preprocess.cards.fused');
  const group = progress.steps.find(step => step.id === 'preprocess.cards.segmented');
  const repair = group.children[0];
  assert.equal(bundle.meta, 'paused', 'deadline must not claim repairs are still running');
  assert.equal(bundle.children.find(step => step.label === 'Scene Frame').state, 'done');
  assert.equal(group.meta, 'paused');
  assert.match(group.reason, /rate limited/i, 'paused group must show the actual cause, not an invented internal error');
  assert.equal(repair.meta, 'paused');
  assert.match(repair.reason, /time limit/i);
  assert.match(repair.reason, /rate limited/i, 'current provider cause supersedes historical validation rejection');
  assert.equal(repair.action.kind, 'retry', 'an exhausted operation needs a new recovery window');
  assert.ok(!JSON.stringify(progress).includes('Repairing this card'));
  assert.equal(progress.activeCount, 0);
}
console.log('[pass] deadline-paused Fused repairs show cause and Retry');

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
assert.equal(recoveredAfterRetries.steps[0].meta, 'done');
assert.equal(recoveredAfterRetries.steps[0].retryCount, 1, 'attempt history remains available');
retriedBundle.stageRecords.repair.attempts = { total: 2 };
const repairedAfterRetries = progressFromExecution(retriedBundle);
const repairGroup = repairedAfterRetries.steps.find((step) => step.id === 'preprocess.cards.segmented');
assert.equal(repairGroup.state, 'done', 'a successful targeted repair does not leave its separate group amber');
assert.equal(repairGroup.children[0].meta, 'done');
assert.equal(repairGroup.children[0].retryCount, 1);
assert.equal(repairedAfterRetries.heroPixelState, 'done');

for (const graph of [true, false]) for (const operationState of ['running', 'completed', 'stale']) {
  const execution = recoveredFusedExecution('cached', { graph });
  execution.state = operationState;
  execution.recoveryBudget = { recoveryUsed: 1, recoveryLimit: 9 };
  execution.stageRecords.fused.state = 'cached';
  execution.stageRecords.install.state = operationState === 'running' ? 'running' : 'completed';
  const progress = progressFromExecution(execution);
  const bundle = progress.steps.find((step) => step.id === 'preprocess.cards.fused');
  const repaired = bundle.children.find((step) => step.label === 'Character Motivation');
  assert.equal(bundle.state, 'cached', 'restored successful recovery remains cached');
  assert.equal(bundle.meta, 'cached');
  assert.equal(bundle.reason, null);
  assert.equal(repaired.meta, 'cached');
  assert.equal(repaired.reason, null);
  const diagnostics = summarizeExecutionForDiagnostics(execution);
  assert.equal(diagnostics.recoveryBudget.recoveryUsed, 1, 'quiet UI retains recovery accounting');
  assert.deepEqual(diagnostics.stages.find((stage) => stage.stageId === 'preprocess.cards.fused').fused.rejections,
    [{ family: 'Character Motivation', code: 'private-claim' }], 'quiet UI retains original diagnostic rejection');
}
console.log('[pass] cached recovery remains quiet with diagnostics intact');
