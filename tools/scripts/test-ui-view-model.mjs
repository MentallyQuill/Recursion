import { createRecursionViewModel } from '../../src/ui/view-model.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

{
  const interrupted = createRecursionViewModel({settings:{enabled:true},activity:{phase:'idle'},
    execution:{operationId:'restored',state:'paused',pauseReason:'restored-after-reload',
      frontierStageIds:['preprocess.guidance'],stages:[{stageId:'preprocess.guidance',state:'pending',kind:'model',executable:true}]}});
  assertEqual(interrupted.progressRun.title,'Interrupted','reload interruption is distinct from a provider issue');
  assertEqual(interrupted.progressRun.subtitle,'Resume available');
  assertEqual(interrupted.statusSeverity,'info','interruption without a failure is neutral');
}

assertEqual(
  createRecursionViewModel({
    settings: { pipelineMode: 'segmented' }
  }).pipelineLabel,
  'Segmented',
  'view model exposes the canonical Segmented label'
);

assertEqual(
  createRecursionViewModel({
    settings: { pipelineMode: 'rapid' }
  }).pipelineMode,
  'segmented',
  'view model sends removed modes through the generic fallback'
);

const durableModel = createRecursionViewModel({
  settings: { pipelineMode: 'segmented' },
  execution: {
    operationId: 'view-run',
    phase: 'preprocess',
    state: 'paused',
    frontierStageIds: ['preprocess.arbiter'],
    stages: [
      {
        stageId: 'preprocess.snapshot',
        state: 'completed',
        executable: true,
        kind: 'local',
        checkpoint: { outputHash: 'snapshot' }
      },
      {
        stageId: 'preprocess.arbiter',
        state: 'pending',
        executable: true,
        kind: 'model'
      }
    ]
  }
});
assertEqual(durableModel.progressRun.runId, 'view-run', 'view model projects durable operation id');
assert(
  durableModel.progressRun.steps.some((step) => step.action?.kind === 'resume'),
  'view model exposes the contextual Resume action'
);

for (const state of ['running', 'completed', 'paused']) {
  const model = createRecursionViewModel({ execution: {
    operationId: 'recovery-footer', state,
    pipelineDecision: { requestedMode: 'fused', effectiveMode: 'fused', selectedLane: 'utility' },
    recoveryBudget: { recoveryUsed: 1, recoveryLimit: 9 },
    stages: [{ stageId: 'preprocess.cards.fused', state: 'completed' }]
  } });
  assertEqual(model.progressFooterLabel, 'Fused \u00b7 Utility', 'recovery bookkeeping stays out of the progress footer');
}
console.log('ui view-model tests passed');
