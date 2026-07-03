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

const renamedCardProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'renamed-card-progress', phase: 'cardBatchRunning', label: 'Utility card batch', providerLane: 'utility', cardCounts: { requested: 1 }, recordedAt: '1' },
    { runId: 'renamed-card-progress', phase: 'providerCallSettled', roleId: 'sceneConstraintsCard', outcome: 'success', providerLane: 'utility', recordedAt: '2' },
    { runId: 'renamed-card-progress', phase: 'providerCallSettled', roleId: 'socialSubtextCard', outcome: 'success', providerLane: 'utility', recordedAt: '3' }
  ],
  activity: { runId: 'renamed-card-progress', phase: 'providerCallSettled', roleId: 'socialSubtextCard', outcome: 'success', providerLane: 'utility', recordedAt: '3' }
});
const progressText = JSON.stringify(renamedCardProgress);
assert(progressText.includes('Scene Constraints'), 'progress labels Scene Constraints card rows');
assert(progressText.includes('Social Subtext'), 'progress labels Social Subtext card rows');
assert(progressText.includes('social-subtext-card'), 'progress gives Social Subtext a stable child id');
assert(!progressText.includes('Continuity ' + 'Risk'), 'progress no longer labels legacy risk rows');
assert(!progressText.includes('Pr' + 'ose'), 'progress no longer labels legacy craft cards');

const retriedGeneratedCardProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'retried-generated-card', phase: 'cardBatchRunning', label: 'Utility card batch', providerLane: 'utility', cardCounts: { requested: 1 }, recordedAt: '1' },
    {
      runId: 'retried-generated-card',
      phase: 'cardProgress',
      severity: 'success',
      detail: {
        parentStepId: 'utility-card-batch',
        roleId: 'sceneFrameCard',
        family: 'Scene Frame',
        source: 'generated',
        state: 'done',
        retryCount: 1,
        reason: 'Provider batch retried once before this card completed.'
      },
      recordedAt: '2'
    },
    { runId: 'retried-generated-card', phase: 'settled', label: 'Recursion prompt ready.', severity: 'success', recordedAt: '3' }
  ],
  activity: {
    runId: 'retried-generated-card',
    phase: 'settled',
    label: 'Recursion prompt ready.',
    severity: 'success',
    recordedAt: '3'
  }
});
const retriedGeneratedBatch = retriedGeneratedCardProgress.steps.find((step) => step.id === 'utility-card-batch');
const retriedGeneratedChild = retriedGeneratedBatch.children.find((child) => child.id === 'scene-frame-card');
assertEqual(retriedGeneratedChild.state, 'warning', 'generated card success after retry stays caution-colored');
assertEqual(retriedGeneratedChild.meta, 'retried', 'generated card retry has visible retried meta');
assert(retriedGeneratedChild.reason.includes('retried once'), 'generated card retry keeps a safe visible reason');
assertEqual(retriedGeneratedBatch.state, 'warning', 'retried generated child keeps batch caution-colored');

const swipeFreshRunProgress = createProgressRunModel({
  activityHistory: [
    {
      runId: 'swipe-old-cautioned-run',
      phase: 'cardProgress',
      severity: 'warning',
      detail: {
        parentStepId: 'utility-card-batch',
        roleId: 'sceneFrameCard',
        family: 'Scene Frame',
        source: 'generated',
        state: 'warning',
        reason: 'Provider card batch retried once before this card completed.'
      },
      recordedAt: '1'
    },
    {
      runId: 'swipe-new-run',
      phase: 'started',
      label: 'Reading current turn...',
      recordedAt: '2'
    },
    {
      runId: 'swipe-new-run',
      phase: 'cacheWarning',
      severity: 'warning',
      label: 'Ignored stale cached Recursion cards.',
      detail: { reason: 'source-changed' },
      recordedAt: '3'
    },
    {
      runId: 'swipe-new-run',
      phase: 'providerCallStarted',
      roleId: 'utilityArbiter',
      providerLane: 'utility',
      label: 'Utility Arbiter started.',
      recordedAt: '4'
    }
  ],
  activity: {
    runId: 'swipe-new-run',
    phase: 'providerCallStarted',
    roleId: 'utilityArbiter',
    providerLane: 'utility',
    label: 'Utility Arbiter started.',
    recordedAt: '4'
  }
});
assertEqual(swipeFreshRunProgress.title, 'Generating', 'fresh swipe run does not inherit previous caution title');
assert(!swipeFreshRunProgress.steps.some((step) => step.state === 'warning' || step.state === 'failed'), 'fresh swipe run does not retain old warning or failed rows');
assert(!swipeFreshRunProgress.steps.some((step) => step.id === 'reusing-scene-deck' && step.state === 'warning'), 'cache hygiene is not rendered as yellow scene-deck reuse');
const swipeCacheCheck = swipeFreshRunProgress.steps.find((step) => step.id === 'checking-scene-cache');
assert(swipeCacheCheck, 'fresh swipe run shows neutral cache inspection instead of reused caution');
assertEqual(swipeCacheCheck.state, 'done', 'stale cache inspection is completed neutral work');

const cacheReuseProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'cache-reuse-purple-run', phase: 'started', label: 'Reading current turn...', recordedAt: '1' },
    { runId: 'cache-reuse-purple-run', phase: 'cacheReusing', label: 'Reusing scene deck...', providerLane: 'utility', recordedAt: '2' }
  ],
  activity: { runId: 'cache-reuse-purple-run', phase: 'cacheReusing', label: 'Reusing scene deck...', providerLane: 'utility', recordedAt: '2' }
});
const cacheReuseStep = cacheReuseProgress.steps.find((step) => step.id === 'reusing-scene-deck');
assert(cacheReuseStep, 'cache reuse renders the scene deck reuse row');
assertEqual(cacheReuseStep.state, 'cached', 'scene deck reuse is purple cached state');
assertEqual(cacheReuseStep.meta, 'cached', 'scene deck reuse uses cached meta');

const rapidWarmProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'rapid-warm', phase: 'rapidWarming', label: 'Rapid warming scene deck...', chips: ['Rapid'], recordedAt: '1' }
  ],
  activity: { runId: 'rapid-warm', phase: 'rapidWarming', label: 'Rapid warming scene deck...', chips: ['Rapid'], recordedAt: '1' }
});
assert(
  JSON.stringify(rapidWarmProgress).includes('Rapid warming scene deck'),
  'progress includes Rapid warming row'
);

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
assert(!reasoningSettingDuringRunProgress.steps.some((step) => step.id === 'reasoner-guidance'), 'reasoning setting alone does not add a Reasoner row to an active run');

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

const hostStoppedProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'host-stopped-progress', phase: 'started', label: 'Reading current turn...', recordedAt: '1' },
    { runId: 'host-stopped-progress', phase: 'promptClearing', label: 'Stopping Recursion after generation cancel...', recordedAt: '2' },
    { runId: 'host-stopped-progress', phase: 'settled', outcome: 'skipped', severity: 'info', label: 'Generation canceled. Recursion prompt cleared.', recordedAt: '3' }
  ],
  activity: {
    runId: 'host-stopped-progress',
    phase: 'settled',
    outcome: 'skipped',
    severity: 'info',
    label: 'Generation canceled. Recursion prompt cleared.',
    recordedAt: '3'
  }
});
const hostStoppedSettledStep = hostStoppedProgress.steps.find((step) => step.id === 'recursion-prompt-ready');
assert(hostStoppedSettledStep, 'host generation stop renders a settled progress row');
assertEqual(hostStoppedSettledStep.state, 'skipped', 'host generation stop renders cancellation as skipped');
assertEqual(hostStoppedProgress.heroPixelState, 'skipped', 'host generation stop hero pixel state is skipped');
assertEqual(createHeroPixelBlocks(hostStoppedProgress).some((block) => block.id === 'recursion-prompt-ready' && block.state === 'done'), false, 'host generation stop does not create a green done pixel for cancellation');

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
  settings: { mode: 'manual' },
  activity: { phase: 'idle' }
});
assertEqual(derivedIdlePromptClearProgress.title, 'Ready', 'derived idle manual progress keeps a ready title');
assertEqual(derivedIdlePromptClearProgress.steps.length, 0, 'derived idle manual progress does not render stale waiting rows');
assertEqual(createHeroPixelBlocks(derivedIdlePromptClearProgress).length, 0, 'derived idle manual progress clears hero pixel blocks between turns');

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

const manualSettledWarningProgress = createProgressRunModel({
  settings: { mode: 'manual' },
  lastPlan: { cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame' }] },
  activityHistory: [
    { runId: 'manual-settled-warning', phase: 'started', label: 'Reading current turn', recordedAt: '1' },
    { runId: 'manual-settled-warning', phase: 'cardBatchRunning', label: 'Utility card batch', recordedAt: '2' },
    {
      runId: 'manual-settled-warning',
      phase: 'cardProgress',
      detail: { parentStepId: 'utility-card-batch', roleId: 'sceneFrameCard', state: 'warning', source: 'fallback' },
      recordedAt: '3'
    },
    { runId: 'manual-settled-warning', phase: 'handSelected', label: 'Selecting turn hand', severity: 'success', recordedAt: '4' },
    { runId: 'manual-settled-warning', phase: 'storageComplete', label: 'Saving scene cache', severity: 'success', recordedAt: '5' },
    { runId: 'manual-settled-warning', phase: 'settled', label: 'Recursion prompt ready.', severity: 'success', recordedAt: '6' }
  ],
  activity: {
    runId: 'manual-settled-warning',
    phase: 'settled',
    label: 'Recursion prompt ready.',
    severity: 'success',
    recordedAt: '6'
  }
});
const manualSettledStepIds = manualSettledWarningProgress.steps.map((step) => step.id);
assert(!manualSettledStepIds.includes('composing-prompt-packet'), 'settled manual progress drops planned compose step that never ran');
assert(!manualSettledStepIds.includes('installing-recursion-prompt'), 'settled manual progress drops planned prompt-install step that never ran');
assert(manualSettledWarningProgress.steps.some((step) => step.id === 'utility-card-batch' && step.state === 'warning'), 'settled manual progress keeps material warning rows');
assertEqual(createHeroPixelBlocks(manualSettledWarningProgress).some((block) => block.state === 'pending'), false, 'settled manual progress does not leave empty hero pixels after ready');

console.log('[pass] progress');
