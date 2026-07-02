import { createHeroPixelBlocks, createProgressRunModel } from '../../src/progress.mjs';
import { assert, assertEqual } from '../../tests/helpers/assert.mjs';

const unsafeProgress = createProgressRunModel({
  progressRun: {
    runId: 'progress-secret-run',
    title: 'Generating',
    subtitle: 'authorization: raw-progress-auth-token',
    steps: [
      {
        id: 'unsafe-explicit-step',
        label: 'headers.authorization=raw-progress-header-token',
        state: 'running',
        children: [
          {
            id: 'unsafe-child',
            label: 'cookie=raw-progress-cookie; sessionId=raw-progress-session; credentials=raw-progress-creds',
            state: 'running'
          }
        ]
      }
    ]
  }
});
const unsafeSerialized = JSON.stringify(unsafeProgress);
for (const value of [
  'raw-progress-auth-token',
  'raw-progress-header-token',
  'raw-progress-cookie',
  'raw-progress-session',
  'raw-progress-creds',
  'authorization',
  'sessionId',
  'credentials'
]) {
  assert(!unsafeSerialized.includes(value), `progress model redacts ${value}`);
}
assertEqual(unsafeProgress.subtitle, '', 'unsafe progress subtitle is omitted');
assertEqual(unsafeProgress.steps[0].label, 'Step 1', 'unsafe progress label falls back');
assertEqual(unsafeProgress.steps[0].children[0].label, 'Item 1', 'unsafe child progress label falls back');

const safeProgress = createProgressRunModel({
  progressRun: {
    runId: 'progress-safe-run',
    title: 'Generating',
    subtitle: '2 model calls running',
    steps: [
      {
        id: 'safe-story-step',
        label: 'Checking token: a brass coin',
        state: 'running',
        providerLane: 'utility'
      }
    ]
  }
});
assertEqual(safeProgress.subtitle, '2 model calls running', 'safe progress subtitle survives');
assertEqual(safeProgress.steps[0].label, 'Checking token: a brass coin', 'safe story token text survives');
const blocks = createHeroPixelBlocks(safeProgress);
assertEqual(blocks[0].label, 'Checking token: a brass coin', 'hero blocks inherit safe labels');

const controlOnlyPromptProgress = createProgressRunModel({
  settings: { enabled: false, mode: 'auto' },
  activity: {
    runId: 'settings-control-only',
    phase: 'promptClearing',
    label: 'Clearing Recursion prompt...',
    chips: ['Prompt']
  }
});
assertEqual(controlOnlyPromptProgress.steps.length, 0, 'successful control-only prompt work does not populate the progress menu');
assertEqual(createHeroPixelBlocks(controlOnlyPromptProgress).length, 0, 'successful control-only prompt work does not create compact hero pixel blocks');

const controlOnlyPromptProgressWithStalePlan = createProgressRunModel({
  settings: { enabled: false, mode: 'auto', reasonerUse: 'always' },
  lastPlan: {
    cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame' }],
    reasonerDecision: { mode: 'use' }
  },
  activityHistory: [
    {
      runId: 'settings-control-stale-plan',
      phase: 'promptClearing',
      label: 'Clearing Recursion prompt...',
      chips: ['Prompt']
    }
  ],
  activity: {
    runId: 'settings-control-stale-plan',
    phase: 'promptClearing',
    label: 'Clearing Recursion prompt...',
    chips: ['Prompt']
  }
});
assertEqual(controlOnlyPromptProgressWithStalePlan.steps.length, 0, 'power/settings prompt clear ignores stale turn plans');
assertEqual(createHeroPixelBlocks(controlOnlyPromptProgressWithStalePlan).length, 0, 'power/settings prompt clear with stale plans does not create hero pixels');

const reasoningSettingOnlyProgress = createProgressRunModel({
  settings: { enabled: true, mode: 'auto', reasonerUse: 'always' },
  activity: { phase: 'idle' }
});
assertEqual(reasoningSettingOnlyProgress.steps.length, 0, 'reasoning setting alone does not create pending progress');
assertEqual(createHeroPixelBlocks(reasoningSettingOnlyProgress).length, 0, 'reasoning setting alone does not create hero pixels');

const reasoningSettingDuringRunProgress = createProgressRunModel({
  settings: { enabled: true, mode: 'auto', reasonerUse: 'always' },
  activityHistory: [
    { runId: 'run-reasoning-click', phase: 'started', label: 'Reading current turn...', providerLane: 'utility' },
    { runId: 'run-reasoning-click', phase: 'cardBatchRunning', label: 'Generating scene cards...', providerLane: 'utility', cardCounts: { requested: 1 } }
  ],
  activity: {
    runId: 'run-reasoning-click',
    phase: 'cardBatchRunning',
    label: 'Generating scene cards...',
    providerLane: 'utility',
    cardCounts: { requested: 1 }
  },
  lastPlan: {
    cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame' }]
  }
});
assert(!reasoningSettingDuringRunProgress.steps.some((step) => step.id === 'reasoner-brief'), 'reasoning setting alone does not add a Reasoner row to an active run');

const controlOnlyWarningProgress = createProgressRunModel({
  settings: { enabled: false, mode: 'auto' },
  activity: {
    runId: 'settings-control-warning',
    phase: 'promptClearFailed',
    severity: 'warning',
    label: 'Prompt clear failed.',
    chips: ['Prompt']
  }
});
assertEqual(controlOnlyWarningProgress.steps.length, 1, 'control-only prompt warnings remain visible in the progress menu');
assertEqual(controlOnlyWarningProgress.steps[0].state, 'warning', 'control-only prompt warning keeps warning state');
assertEqual(createHeroPixelBlocks(controlOnlyWarningProgress).length, 0, 'control-only prompt warnings still do not create compact hero pixel blocks');

const stalePendingProgress = createProgressRunModel({
  activity: { phase: 'idle' },
  progressRun: {
    runId: 'stale-pending-progress',
    title: 'Ready',
    steps: [
      { id: 'clearing-recursion-prompt', label: 'Clearing Recursion prompt', state: 'pending' }
    ]
  }
});
assertEqual(stalePendingProgress.title, 'Ready', 'idle pending-only progress keeps a ready title');
assertEqual(stalePendingProgress.steps.length, 0, 'idle pending-only progress is discarded as stale planned work');

const readyPendingProgress = createProgressRunModel({
  progressRun: {
    runId: 'ready-pending-progress',
    title: 'Ready',
    steps: [
      { id: 'clearing-recursion-prompt', label: 'Clearing Recursion prompt', state: 'pending' }
    ]
  }
});
assertEqual(readyPendingProgress.steps.length, 0, 'ready pending-only progress is discarded even without raw activity');

const derivedIdlePromptClearProgress = createProgressRunModel({
  settings: { mode: 'semi-auto' },
  activity: { phase: 'idle' }
});
assertEqual(derivedIdlePromptClearProgress.title, 'Ready', 'derived idle semi-auto progress keeps a ready title');
assertEqual(derivedIdlePromptClearProgress.steps.length, 0, 'derived idle semi-auto progress does not render stale waiting rows');
assertEqual(createHeroPixelBlocks(derivedIdlePromptClearProgress).length, 0, 'derived idle semi-auto progress clears hero pixel blocks between turns');

const settledDoneProgress = createProgressRunModel({
  activity: { phase: 'idle' },
  progressRun: {
    runId: 'settled-done-progress',
    title: 'Ready',
    steps: [
      { id: 'installing-recursion-prompt', label: 'Installing Recursion prompt', state: 'done' }
    ]
  }
});
assertEqual(settledDoneProgress.steps.length, 1, 'idle completed progress remains visible');
assertEqual(settledDoneProgress.steps[0].state, 'done', 'idle completed progress keeps its terminal state');

const semiAutoSettledWarningProgress = createProgressRunModel({
  settings: { mode: 'semi-auto' },
  lastPlan: { cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame' }] },
  activityHistory: [
    { runId: 'semi-auto-settled-warning', phase: 'started', label: 'Reading current turn', recordedAt: '1' },
    { runId: 'semi-auto-settled-warning', phase: 'cardBatchRunning', label: 'Utility card batch', recordedAt: '2' },
    {
      runId: 'semi-auto-settled-warning',
      phase: 'cardProgress',
      detail: { parentStepId: 'utility-card-batch', roleId: 'sceneFrameCard', state: 'warning', source: 'fallback' },
      recordedAt: '3'
    },
    { runId: 'semi-auto-settled-warning', phase: 'handSelected', label: 'Selecting turn hand', severity: 'success', recordedAt: '4' },
    { runId: 'semi-auto-settled-warning', phase: 'storageComplete', label: 'Saving scene cache', severity: 'success', recordedAt: '5' },
    { runId: 'semi-auto-settled-warning', phase: 'settled', label: 'Recursion prompt ready.', severity: 'success', recordedAt: '6' }
  ],
  activity: {
    runId: 'semi-auto-settled-warning',
    phase: 'settled',
    label: 'Recursion prompt ready.',
    severity: 'success',
    recordedAt: '6'
  }
});
const semiAutoSettledStepIds = semiAutoSettledWarningProgress.steps.map((step) => step.id);
assert(!semiAutoSettledStepIds.includes('composing-prompt-packet'), 'settled semi-auto progress drops planned compose step that never ran');
assert(!semiAutoSettledStepIds.includes('installing-recursion-prompt'), 'settled semi-auto progress drops planned prompt-install step that never ran');
assert(semiAutoSettledWarningProgress.steps.some((step) => step.id === 'utility-card-batch' && step.state === 'warning'), 'settled semi-auto progress keeps material warning rows');
assertEqual(createHeroPixelBlocks(semiAutoSettledWarningProgress).some((block) => block.state === 'pending'), false, 'settled semi-auto progress does not leave empty hero pixels after ready');

console.log('[pass] progress');
