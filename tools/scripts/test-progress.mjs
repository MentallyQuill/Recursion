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

const runningPostProcessProgress = createProgressRunModel({
  activityHistory: [{
    runId: 'post-process-running',
    phase: 'postProcessStarted',
    severity: 'info',
    label: 'Post-processing response...',
    providerLane: 'utility',
    detail: {
      rewriteFlow: 'unified',
      applyMode: 'as-swipe',
      categoryCount: 2
    }
  }, {
    runId: 'post-process-running',
    phase: 'postProcessCategory',
    severity: 'info',
    label: 'Unified',
    providerLane: 'utility',
    detail: {
      categoryId: 'unified',
      categoryName: 'Unified',
      state: 'running',
      guidanceAttempts: 0,
      hostAttempts: 0
    }
  }],
  activity: {
    runId: 'post-process-running',
    phase: 'providerCallRunning',
    severity: 'info',
    label: 'Post-process guidance running.',
    providerLane: 'utility',
    detail: {
      roleId: 'postProcessGuidanceUtility'
    }
  }
});
assert(
  runningPostProcessProgress.steps.some((step) => step.state === 'running'),
  'Post-process guidance exposes a running progress row'
);
assert(
  createHeroPixelBlocks(runningPostProcessProgress).some((block) => block.state === 'running'),
  'Post-process guidance exposes a running Hero Pixel Array block'
);

const rewritingPostProcessProgress = createProgressRunModel({
  activityHistory: [{
    runId: 'post-process-rewriting',
    phase: 'postProcessStarted',
    severity: 'info',
    label: 'Post-processing response...',
    providerLane: 'utility'
  }],
  activity: {
    runId: 'post-process-rewriting',
    phase: 'postProcessCategory',
    severity: 'info',
    label: 'Unified',
    providerLane: 'utility',
    detail: {
      categoryId: 'unified',
      categoryName: 'Unified',
      state: 'running',
      activeStage: 'host-rewrite',
      guidanceAttempts: 1,
      hostAttempts: 0
    }
  }
});
const rewritingPostProcessStep = rewritingPostProcessProgress.steps.find((step) => step.id === 'post-process-category-unified');
assertEqual(rewritingPostProcessStep.children[0].state, 'done', 'completed Post-process guidance pixel turns green during host rewrite');
assertEqual(rewritingPostProcessStep.children[1].state, 'running', 'SillyTavern rewrite pixel runs for the writer phase');
assert(
  createHeroPixelBlocks(rewritingPostProcessProgress).some((block) => block.state === 'running'),
  'SillyTavern rewrite keeps a running Hero Pixel Array block'
);

const committingPostProcessProgress = createProgressRunModel({
  activity: {
    runId: 'post-process-committing',
    phase: 'postProcessCommitting',
    severity: 'info',
    label: 'Adding Post-process swipe...',
    providerLane: 'utility',
    detail: { committedApplyMode: 'as-swipe' }
  }
});
assertEqual(committingPostProcessProgress.steps[0].id, 'post-process-commit', 'Post-process commit exposes a dedicated progress pixel');
assertEqual(committingPostProcessProgress.steps[0].state, 'running', 'Post-process commit pixel runs while the swipe is being added');

const progressivePostProcessProgress = createProgressRunModel({
  activityHistory: [
    {
      runId: 'post-process-progressive',
      phase: 'postProcessCategory',
      severity: 'warning',
      label: 'Natural Prose',
      providerLane: 'utility',
      detail: {
        categoryId: 'natural-prose',
        categoryName: 'Natural Prose',
        state: 'success',
        guidanceAttempts: 2,
        hostAttempts: 1,
        cautionReason: 'Post-process stage recovered after retry.'
      }
    },
    {
      runId: 'post-process-progressive',
      phase: 'postProcessCategory',
      severity: 'error',
      label: 'Follow Through',
      providerLane: 'utility',
      detail: {
        categoryId: 'follow-through',
        categoryName: 'Follow Through',
        state: 'failed',
        failureStage: 'guidance',
        guidanceAttempts: 2,
        hostAttempts: 0,
        failure: {
          code: 'RECURSION_POST_PROCESS_GUIDANCE_FAILED',
          stage: 'post-process-guidance',
          category: 'provider-output',
          message: 'Guidance synthesis failed after retry.'
        }
      }
    }
  ],
  activity: {
    runId: 'post-process-progressive',
    phase: 'postProcessCommitted',
    severity: 'warning',
    outcome: 'warning',
    label: 'Post-process swipe added with one failed category.',
    detail: {
      partial: true,
      committedApplyMode: 'as-swipe',
      cautionReason: 'Replace was withheld because at least one Post-process category failed.'
    }
  }
});
assertEqual(progressivePostProcessProgress.steps.length, 3, 'Post-process progress renders two category parents and one commit row');
assertEqual(progressivePostProcessProgress.steps[0].label, 'Natural Prose', 'Post-process category retains its product label');
assertEqual(progressivePostProcessProgress.steps[0].state, 'warning', 'retried Post-process category success is amber');
assertEqual(progressivePostProcessProgress.steps[0].children.length, 2, 'Post-process category has guidance and host children');
assertEqual(progressivePostProcessProgress.steps[0].children[0].state, 'warning', 'retried guidance child is amber');
assertEqual(progressivePostProcessProgress.steps[0].children[1].state, 'done', 'first-attempt host child is green');
assertEqual(progressivePostProcessProgress.steps[1].state, 'failed', 'failed Post-process category is red');
assertEqual(progressivePostProcessProgress.steps[1].children[0].state, 'failed', 'failed guidance child is red');
assertEqual(progressivePostProcessProgress.steps[1].children[1].state, 'skipped', 'unreached host child is muted');
assertEqual(progressivePostProcessProgress.steps[2].state, 'warning', 'committed partial parent is amber');
assert(
  progressivePostProcessProgress.steps[2].reason.includes('Replace was withheld'),
  'committed partial parent explains why Replace was withheld'
);
assert(
  createHeroPixelBlocks(progressivePostProcessProgress).every((block) => block.state !== 'running'),
  'completed Post-process stages leave no running Hero Pixel Array blocks'
);

const explainedFailureProgress = createProgressRunModel({
  progressRun: {
    runId: 'explained-failure',
    steps: [{
      id: 'editorial-diagnosis',
      label: 'Editorial diagnosis',
      state: 'failed',
      failure: {
        code: 'RECURSION_JSON_PARSE_FAILED',
        stage: 'editorial-diagnosis',
        category: 'provider-output',
        message: 'Provider returned malformed JSON.'
      }
    }]
  }
});
assertEqual(
  explainedFailureProgress.steps[0].reason,
  'Provider returned malformed JSON.',
  'progress step uses normalized failure message'
);
assertEqual(
  explainedFailureProgress.currentStepText,
  'Editorial diagnosis: Provider returned malformed JSON.',
  'compact status reports the failed stage and reason'
);

const explainedActivityFailureProgress = createProgressRunModel({
  activityHistory: [{
    runId: 'explained-activity-failure',
    phase: 'providerCallSettled',
    roleId: 'editorialDiagnostician',
    outcome: 'error',
    severity: 'error',
    detail: {
      failure: {
        code: 'RECURSION_JSON_PARSE_FAILED',
        stage: 'editorial-diagnosis',
        category: 'provider-output',
        message: 'Provider returned malformed JSON.'
      }
    },
    recordedAt: '1'
  }],
  activity: {
    runId: 'explained-activity-failure',
    phase: 'providerCallSettled',
    roleId: 'editorialDiagnostician',
    outcome: 'error',
    severity: 'error',
    detail: {
      failure: {
        code: 'RECURSION_JSON_PARSE_FAILED',
        stage: 'editorial-diagnosis',
        category: 'provider-output',
        message: 'Provider returned malformed JSON.'
      }
    },
    recordedAt: '1'
  }
});
assertEqual(
  explainedActivityFailureProgress.steps.find((step) => step.id === 'editorial-diagnosis')?.reason,
  'Provider returned malformed JSON.',
  'activity-derived progress keeps the normalized failure reason'
);

const unexplainedFailureProgress = createProgressRunModel({
  progressRun: {
    runId: 'unexplained-failure',
    steps: [{ id: 'editorial-diagnosis', label: 'Editorial diagnosis', state: 'failed' }]
  }
});
assertEqual(
  unexplainedFailureProgress.steps[0].reason,
  'Unexpected internal failure (RECURSION_PROGRESS_REASON_MISSING).',
  'unexplained failed progress receives an explicit internal reason'
);

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

const tracedCardProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'traced-card-progress', phase: 'cardBatchRunning', label: 'Utility card batch', providerLane: 'utility', recordedAt: '1' },
    {
      runId: 'traced-card-progress',
      phase: 'cardProgress',
      detail: {
        parentStepId: 'fused-card-bundle',
        family: 'Scene Frame',
        roleId: 'sceneFrameCard',
        source: 'generated',
        state: 'done',
        sourceCards: [
          { id: 'scene-location', label: 'location/situation', selectionState: 'priority', state: 'done' },
          { id: 'scene-direction', label: 'immediate direction', selectionState: 'priority', state: 'done' }
        ]
      },
      recordedAt: '2'
    }
  ],
  activity: { runId: 'traced-card-progress', phase: 'cardProgress', recordedAt: '2' }
});
const tracedCard = tracedCardProgress.steps.find((step) => step.id === 'fused-card-bundle').children.find((child) => child.label === 'Scene Frame');
assertEqual(tracedCard.children.length, 2, 'card progress exposes fused source cards');
assertEqual(tracedCard.children[0].label, 'location/situation', 'card progress names first source card');
assertEqual(tracedCard.children[0].reason, 'Priority source card included.', 'card progress explains priority source');
assertEqual(tracedCard.children[0].meta, 'included', 'fused source cards report inclusion rather than category generation');

const unverifiedSourceProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'unverified-source-progress', phase: 'cardBatchRunning', label: 'Utility card batch', providerLane: 'utility', recordedAt: '1' },
    {
      runId: 'unverified-source-progress',
      phase: 'cardProgress',
      detail: {
        parentStepId: 'utility-card-batch',
        family: 'Scene Frame',
        roleId: 'sceneFrameCard',
        source: 'generated',
        state: 'done',
        sourceCards: [
          { id: 'scene-location', label: 'location/situation', selectionState: 'priority', state: 'info', reason: 'Included in fused category result; individual attribution unavailable.' }
        ]
      },
      recordedAt: '2'
    }
  ],
  activity: { runId: 'unverified-source-progress', phase: 'cardProgress', recordedAt: '2' }
});
const includedSourceCard = unverifiedSourceProgress.steps
  .find((step) => step.id === 'utility-card-batch')
  .children.find((child) => child.label === 'Scene Frame').children[0];
assertEqual(includedSourceCard.state, 'done', 'included source coverage is successful');
assertEqual(unverifiedSourceProgress.title, 'Ready', 'included source coverage does not raise a warning title');

const cautionedSourceProgress = createProgressRunModel({
  activityHistory: [{
    runId: 'cautioned-source-progress',
    phase: 'cardProgress',
    detail: {
      parentStepId: 'utility-card-batch',
      family: 'Scene Frame',
      roleId: 'sceneFrameCard',
      state: 'warning',
      sourceCards: [{ id: 'scene-location', label: 'location/situation', state: 'warning', reason: 'JSON repaired.' }]
    },
    recordedAt: '1'
  }],
  activity: { runId: 'cautioned-source-progress', phase: 'cardProgress', recordedAt: '1' }
});
assertEqual(cautionedSourceProgress.steps.find((step) => step.id === 'utility-card-batch').children[0].children[0].state, 'warning', 'source cards inherit category caution');

const runningSourceCardProgress = createProgressRunModel({
  settings: {
    preProcessDecks: {
      activeDeckId: 'source-visible-deck',
      customDecks: {
        'source-visible-deck': {
          id: 'source-visible-deck',
          name: 'Source Visible Deck',
          categoryOrder: ['scene-frame'],
          categories: {
            'scene-frame': { id: 'scene-frame', name: 'Scene Frame' }
          },
          cardOrderByCategory: {
            'scene-frame': [
              'sceneFrameCard:location-situation',
              'sceneFrameCard:immediate-direction',
              'sceneFrameCard:beat-constraint'
            ]
          },
          cards: {
            'sceneFrameCard:location-situation': {
              id: 'sceneFrameCard:location-situation',
              categoryId: 'scene-frame',
              name: 'location/situation',
              promptText: 'Keep current location and situation visible.',
              selectionState: 'priority',
              builtinFamily: 'Scene Frame',
              builtinRoleId: 'sceneFrameCard'
            },
            'sceneFrameCard:immediate-direction': {
              id: 'sceneFrameCard:immediate-direction',
              categoryId: 'scene-frame',
              name: 'immediate direction',
              promptText: 'Track immediate direction.',
              selectionState: 'priority',
              builtinFamily: 'Scene Frame',
              builtinRoleId: 'sceneFrameCard'
            },
            'sceneFrameCard:beat-constraint': {
              id: 'sceneFrameCard:beat-constraint',
              categoryId: 'scene-frame',
              name: 'beat constraint',
              promptText: 'Respect the next beat constraint.',
              selectionState: 'priority',
              builtinFamily: 'Scene Frame',
              builtinRoleId: 'sceneFrameCard'
            }
          }
        }
      }
    }
  },
  activityHistory: [
    { runId: 'running-source-cards', phase: 'cardBatchRunning', label: 'Utility card batch', providerLane: 'utility', cardCounts: { requested: 1 }, recordedAt: '1' }
  ],
  activity: { runId: 'running-source-cards', phase: 'cardBatchRunning', label: 'Utility card batch', providerLane: 'utility', cardCounts: { requested: 1 }, recordedAt: '1' },
  lastPlan: {
    cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard' }]
  }
});
const runningSourceCardCategory = runningSourceCardProgress.steps
  .find((step) => step.id === 'utility-card-batch')
  .children.find((child) => child.label === 'Scene Frame');
assertEqual(
  JSON.stringify((runningSourceCardCategory.children || []).map((child) => [child.label, child.state, child.meta])),
  JSON.stringify([
    ['location/situation', 'pending', 'waiting'],
    ['immediate direction', 'pending', 'waiting'],
    ['beat constraint', 'pending', 'waiting']
  ]),
  'running card batch exposes active source cards under the pending category row'
);

const mergedGeneratedAndPendingCategoryProgress = createProgressRunModel({
  settings: {
    preProcessDecks: {
      activeDeckId: 'source-visible-deck',
      customDecks: {
        'source-visible-deck': {
          id: 'source-visible-deck',
          name: 'Source Visible Deck',
          categoryOrder: ['scene-frame'],
          categories: {
            'scene-frame': { id: 'scene-frame', name: 'Scene Frame' }
          },
          cardOrderByCategory: {
            'scene-frame': [
              'sceneFrameCard:location-situation',
              'sceneFrameCard:immediate-direction',
              'sceneFrameCard:beat-constraint'
            ]
          },
          cards: {
            'sceneFrameCard:location-situation': {
              id: 'sceneFrameCard:location-situation', categoryId: 'scene-frame', name: 'location/situation',
              promptText: 'Keep current location visible.', selectionState: 'active', builtinFamily: 'Scene Frame', builtinRoleId: 'sceneFrameCard'
            },
            'sceneFrameCard:immediate-direction': {
              id: 'sceneFrameCard:immediate-direction', categoryId: 'scene-frame', name: 'immediate direction',
              promptText: 'Track immediate direction.', selectionState: 'active', builtinFamily: 'Scene Frame', builtinRoleId: 'sceneFrameCard'
            },
            'sceneFrameCard:beat-constraint': {
              id: 'sceneFrameCard:beat-constraint', categoryId: 'scene-frame', name: 'beat constraint',
              promptText: 'Respect the beat constraint.', selectionState: 'active', builtinFamily: 'Scene Frame', builtinRoleId: 'sceneFrameCard'
            }
          }
        }
      }
    }
  },
  activityHistory: [
    { runId: 'merged-category-progress', phase: 'cardBatchRunning', label: 'Utility card batch', providerLane: 'utility', recordedAt: '1' },
    {
      runId: 'merged-category-progress', phase: 'cardProgress', detail: {
        parentStepId: 'utility-card-batch', id: 'generated-scene-frame', family: 'Scene Frame', roleId: 'sceneFrameCard',
        source: 'generated', state: 'done'
      }, recordedAt: '2'
    }
  ],
  activity: { runId: 'merged-category-progress', phase: 'cardProgress', recordedAt: '2' },
  lastPlan: { cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard' }] }
});
const mergedCategoryRows = mergedGeneratedAndPendingCategoryProgress.steps
  .find((step) => step.id === 'utility-card-batch').children
  .filter((child) => child.label === 'Scene Frame');
assertEqual(mergedCategoryRows.length, 1, 'generated and pending category progress merge into one category row');
assertEqual(mergedCategoryRows[0].children.length, 3, 'merged category row retains every eligible source card');

const fusedBundleProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'fused-progress', phase: 'started', label: 'Reading current turn...', recordedAt: '1' },
    { runId: 'fused-progress', phase: 'fusedCardBundleRunning', label: 'Generating fused card bundle...', providerLane: 'reasoner', cardCounts: { requested: 2 }, recordedAt: '2' },
    {
      runId: 'fused-progress',
      phase: 'providerCallRunning',
      label: 'fusedCardBundle started',
      providerLane: 'reasoner',
      detail: { roleId: 'fusedCardBundle' },
      recordedAt: '2.5'
    },
    {
      runId: 'fused-progress',
      phase: 'cardProgress',
      severity: 'success',
      detail: {
        parentStepId: 'fused-card-bundle',
        roleId: 'sceneFrameCard',
        family: 'Scene Frame',
        source: 'generated',
        state: 'done',
        providerLane: 'reasoner'
      },
      recordedAt: '3'
    }
  ],
  activity: { runId: 'fused-progress', phase: 'providerCallRunning', label: 'fusedCardBundle started', providerLane: 'reasoner', detail: { roleId: 'fusedCardBundle' }, recordedAt: '2.5' },
  settings: { pipelineMode: 'fused' },
  lastPlan: {
    cardJobs: [
      { role: 'sceneFrameCard', family: 'Scene Frame' },
      { role: 'sceneConstraintsCard', family: 'Scene Constraints' }
    ]
  }
});
const fusedBundleStep = fusedBundleProgress.steps.find((step) => step.id === 'fused-card-bundle');
assert(fusedBundleStep, 'Fused progress renders a Fused card bundle row');
assertEqual(fusedBundleStep.label, 'Fused card bundle', 'Fused progress labels the bundle row');
assertEqual(fusedBundleStep.providerLane, 'reasoner', 'Fused progress keeps Reasoner lane on the bundle row');
assert(fusedBundleStep.children.some((child) => child.id === 'scene-frame-card' && child.state === 'done'), 'Fused progress nests generated card rows under the bundle row');
assert(!fusedBundleStep.children.some((child) => child.sourceRoleId === 'fusedCardBundle'), 'Fused progress does not duplicate the bundle provider call as a child row');
assert(!fusedBundleStep.children.some((child) => child.id === 'scene-constraints-card' && child.state === 'pending'), 'Fused progress does not seed speculative requested siblings under the bundle row');

const fusedSettledProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'fused-settled-progress', phase: 'started', label: 'Reading current turn...', recordedAt: '1' },
    { runId: 'fused-settled-progress', phase: 'fusedCardBundleRunning', label: 'Generating fused card bundle...', providerLane: 'utility', cardCounts: { requested: 2 }, recordedAt: '2' },
    {
      runId: 'fused-settled-progress',
      phase: 'providerCallSettled',
      label: 'fusedCardBundle success',
      outcome: 'success',
      providerLane: 'utility',
      detail: { roleId: 'fusedCardBundle' },
      recordedAt: '3'
    },
    {
      runId: 'fused-settled-progress',
      phase: 'cardProgress',
      severity: 'success',
      detail: {
        parentStepId: 'fused-card-bundle',
        roleId: 'sceneFrameCard',
        family: 'Scene Frame',
        source: 'generated',
        state: 'done'
      },
      recordedAt: '4'
    },
    { runId: 'fused-settled-progress', phase: 'settled', label: 'Recursion prompt ready.', severity: 'success', recordedAt: '5' }
  ],
  activity: { runId: 'fused-settled-progress', phase: 'settled', label: 'Recursion prompt ready.', severity: 'success', recordedAt: '5' },
  settings: { pipelineMode: 'fused' },
  lastPlan: {
    cardJobs: [
      { role: 'sceneFrameCard', family: 'Scene Frame' },
      { role: 'sceneConstraintsCard', family: 'Scene Constraints' }
    ]
  }
});
const fusedSettledStep = fusedSettledProgress.steps.find((step) => step.id === 'fused-card-bundle');
assert(fusedSettledStep, 'settled Fused progress keeps the Fused card bundle parent row');
assertEqual(fusedSettledStep.children.length, 1, 'settled Fused progress shows only actual accepted card child rows');
assertEqual(fusedSettledStep.children[0].id, 'scene-frame-card', 'settled Fused progress keeps the accepted card as the child row');

const fusedRepairProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'fused-repair-progress', phase: 'started', label: 'Reading current turn...', recordedAt: '1' },
    { runId: 'fused-repair-progress', phase: 'fusedCardBundleRunning', label: 'Generating fused card bundle...', providerLane: 'utility', cardCounts: { requested: 2 }, recordedAt: '2' },
    {
      runId: 'fused-repair-progress',
      phase: 'cardProgress',
      providerLane: 'utility',
      detail: {
        parentStepId: 'fused-card-bundle',
        roleId: 'sceneFrameCard',
        family: 'Scene Frame',
        state: 'done'
      },
      recordedAt: '3'
    },
    {
      runId: 'fused-repair-progress',
      phase: 'cardProgress',
      providerLane: 'utility',
      detail: {
        parentStepId: 'utility-card-batch',
        roleId: 'sceneConstraintsCard',
        family: 'Scene Constraints',
        state: 'done',
        source: 'fused-repair'
      },
      recordedAt: '4'
    }
  ],
  activity: { runId: 'fused-repair-progress', phase: 'cardBatchRunning', label: 'Repairing fused cards...', providerLane: 'utility', recordedAt: '4' },
  settings: { pipelineMode: 'fused' }
});
const repairBatch = fusedRepairProgress.steps.find((step) => step.id === 'utility-card-batch');
const repairChild = repairBatch.children.find((child) => child.id === 'scene-constraints-card');
assert(repairChild && repairChild.state === 'done', 'Fused repair progress shows repaired sibling under utility card batch');
assertEqual(repairChild.source, 'fused-repair', 'Fused repair progress preserves repaired-card source');

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

const rapidWarmWaitingProgress = createProgressRunModel({
  settings: { pipelineMode: 'rapid' },
  activity: { phase: 'idle' },
  rapidWarm: {
    runId: 'rapid-warm-waiting',
    status: 'waiting',
    phase: 'rapidWarmWaiting',
    reasonLabel: 'Rapid deck still warming; Standard started.'
  }
});
const rapidWarmWaitingStep = rapidWarmWaitingProgress.steps.find((step) => step.id === 'rapid-warm-waiting');
assert(rapidWarmWaitingStep, 'rapid warm waiting status renders a progress row');
assertEqual(rapidWarmWaitingStep.state, 'running', 'rapid warm waiting row is active');
assertEqual(rapidWarmWaitingProgress.currentStepText, 'Waiting for Rapid deck...', 'rapid warm waiting gets compact status text');

const rapidWarmFailedProgress = createProgressRunModel({
  settings: { pipelineMode: 'rapid' },
  activity: { phase: 'idle' },
  rapidWarm: {
    runId: 'rapid-warm-failed',
    status: 'failed',
    phase: 'rapidWarmFailed',
    reasonLabel: 'Rapid warm provider failed.'
  }
});
const rapidWarmFailedStep = rapidWarmFailedProgress.steps.find((step) => step.id === 'rapid-warm-failed');
assert(rapidWarmFailedStep, 'rapid warm failed status renders a progress row');
assertEqual(rapidWarmFailedStep.state, 'failed', 'rapid warm failed row is failed');
assertEqual(rapidWarmFailedStep.reason, 'Rapid warm provider failed.', 'rapid warm failed row keeps safe failure reason');
assertEqual(
  rapidWarmFailedProgress.currentStepText,
  'Rapid warm: Rapid warm provider failed.',
  'rapid warm failure compact status includes its reason'
);

const rapidWarmReadyProgress = createProgressRunModel({
  settings: { pipelineMode: 'rapid' },
  activity: { phase: 'idle' },
  rapidWarm: {
    runId: 'rapid-warm-ready',
    status: 'ready',
    phase: 'rapidWarmReady'
  }
});
const rapidWarmReadyStep = rapidWarmReadyProgress.steps.find((step) => step.id === 'rapid-deck-ready');
assert(rapidWarmReadyStep, 'rapid warm ready status renders a progress row');
assertEqual(rapidWarmReadyStep.state, 'done', 'rapid warm ready row is done');
assertEqual(rapidWarmReadyProgress.heroPixelState, 'done', 'rapid warm ready owns done hero state');

const standardIgnoresRapidWarmProgress = createProgressRunModel({
  settings: { pipelineMode: 'standard' },
  activity: { phase: 'idle' },
  rapidWarm: {
    runId: 'standard-rapid-warm-ready',
    status: 'ready',
    phase: 'rapidWarmReady'
  }
});
assert(!standardIgnoresRapidWarmProgress.steps.some((step) => step.id === 'rapid-deck-ready'), 'Standard pipeline does not render Rapid warm status rows');

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

const runningProviderTestProgress = createProgressRunModel({
  settings: { enabled: true, mode: 'auto', reasonerUse: 'always' },
  lastPlan: {
    cardJobs: [{ role: 'sceneFrameCard', family: 'Scene Frame' }],
    reasonerDecision: { mode: 'use' }
  },
  activityHistory: [
    {
      runId: 'provider-test-utility-progress',
      phase: 'providerCallStarted',
      label: 'Utility provider test started.',
      providerLane: 'utility',
      recordedAt: '1'
    },
    {
      runId: 'provider-test-utility-progress',
      phase: 'providerCallRunning',
      label: 'Provider call running.',
      providerLane: 'utility',
      detail: { roleId: 'providerTest', lane: 'utility' },
      recordedAt: '2'
    }
  ],
  activity: {
    runId: 'provider-test-utility-progress',
    phase: 'providerCallRunning',
    label: 'Provider call running.',
    providerLane: 'utility',
    detail: { roleId: 'providerTest', lane: 'utility' },
    recordedAt: '2'
  }
});
const runningProviderTestStep = runningProviderTestProgress.steps.find((step) => step.id === 'provider-test');
assert(runningProviderTestStep, 'running provider tests render a provider-test row');
assertEqual(runningProviderTestStep.state, 'running', 'running provider tests keep active provider-test state');
assertEqual(runningProviderTestStep.label, 'Utility provider test', 'running utility provider tests label the utility lane');
assertEqual(runningProviderTestProgress.currentStepText, 'Utility provider test...', 'running provider tests get compact lane-specific status');
assertEqual(runningProviderTestProgress.steps.length, 1, 'provider tests ignore stale turn plans');
assert(!runningProviderTestProgress.steps.some((step) => step.id === 'utility-card-batch'), 'provider tests are not rendered as card batches');

const failedReasonerProviderTestProgress = createProgressRunModel({
  activityHistory: [
    {
      runId: 'provider-test-reasoner-progress',
      phase: 'providerCallStarted',
      label: 'Reasoner provider test started.',
      providerLane: 'reasoner',
      detail: { roleId: 'providerTest', lane: 'reasoner' },
      recordedAt: '1'
    },
    {
      runId: 'provider-test-reasoner-progress',
      phase: 'settled',
      outcome: 'error',
      severity: 'error',
      label: 'Provider call failed.',
      providerLane: 'reasoner',
      detail: { roleId: 'providerTest', lane: 'reasoner', error: { message: 'Reasoner test failed.' } },
      recordedAt: '2'
    },
    {
      runId: 'provider-test-reasoner-progress',
      phase: 'settled',
      outcome: 'warning',
      severity: 'warning',
      label: 'Reasoner provider test failed.',
      providerLane: 'reasoner',
      detail: { status: 'fail', compactError: 'Reasoner test failed.' },
      recordedAt: '3'
    }
  ],
  activity: {
    runId: 'provider-test-reasoner-progress',
    phase: 'settled',
    outcome: 'warning',
    severity: 'warning',
    label: 'Reasoner provider test failed.',
    providerLane: 'reasoner',
    detail: { status: 'fail', compactError: 'Reasoner test failed.' },
    recordedAt: '3'
  }
});
const failedReasonerProviderTestStep = failedReasonerProviderTestProgress.steps.find((step) => step.id === 'provider-test');
assert(failedReasonerProviderTestStep, 'failed provider tests render a provider-test row');
assertEqual(failedReasonerProviderTestStep.state, 'failed', 'router provider-test errors keep failed provider-test state');
assertEqual(failedReasonerProviderTestStep.label, 'Reasoner provider test', 'failed reasoner provider tests label the reasoner lane');
assertEqual(failedReasonerProviderTestStep.reason, 'Reasoner test failed.', 'failed provider test keeps the provider reason');
assertEqual(
  failedReasonerProviderTestProgress.currentStepText,
  'Reasoner provider test: Reasoner test failed.',
  'failed provider tests get compact lane-specific failure status with reason'
);
assert(!failedReasonerProviderTestProgress.steps.some((step) => step.id === 'recursion-prompt-ready'), 'failed provider tests are not rendered as prompt-ready failures');
assertEqual(createHeroPixelBlocks(failedReasonerProviderTestProgress).length, 0, 'provider test failures do not create generation hero pixels');

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

const generationReviewProgress = createProgressRunModel({
  activity: {
    runId: 'generation-review-progress',
    phase: 'generationReviewing',
    label: 'Reviewing generated response...',
    providerLane: 'utility',
    recordedAt: '1'
  }
});
assertEqual(generationReviewProgress.steps.length, 1, 'generation review renders one top-level progress row');
assertEqual(generationReviewProgress.steps[0].id, 'generation-review', 'generation review maps to its own progress row');
assertEqual(generationReviewProgress.steps[0].label, 'Generation review', 'generation review progress row uses product-facing label');
assertEqual(generationReviewProgress.currentStepText, 'Reviewing generated response...', 'generation review gets compact current-step text');
assertEqual(createHeroPixelBlocks(generationReviewProgress).length, 1, 'generation review gets one Hero Pixel block');

for (const [roleId, expectedId, expectedLabel] of [
  ['editorialDiagnostician', 'editorial-diagnosis', 'Editorial diagnosis'],
  ['editorialTransformer', 'editorial-candidate', 'Editorial candidate'],
  ['editorialVerifier', 'editorial-verification', 'Editorial verification']
]) {
  const editorialProgress = createProgressRunModel({
    settings: { enabled: true },
    lastPlan: { cardJobs: [{ roleId: 'sceneFrameCard', family: 'Scene Frame' }] },
    activity: { runId: `editorial-${roleId}`, phase: 'providerCallRunning', label: expectedLabel, providerLane: 'utility', detail: { roleId }, recordedAt: '1' }
  });
  assertEqual(editorialProgress.steps.length, 1, `${roleId} renders only its active Editorial stage`);
  assertEqual(editorialProgress.steps[0].id, expectedId, `${roleId} maps to editorial progress row`);
  assertEqual(editorialProgress.steps[0].label, expectedLabel, `${roleId} uses product-facing editorial label`);
  assertEqual(editorialProgress.steps[0].children?.length || 0, 0, `${roleId} does not repeat its label as a provider-call child`);
  assert(
    !editorialProgress.steps.some((step) => ['selecting-turn-hand', 'saving-scene-cache', 'composing-prompt-packet', 'installing-recursion-prompt'].includes(step.id)),
    `${roleId} does not inherit pending pre-generation pipeline rows`
  );
}

const editorialNoChangeProgress = createProgressRunModel({
  settings: { enabled: true },
  lastPlan: { cardJobs: [{ roleId: 'sceneFrameCard', family: 'Scene Frame' }] },
  activityHistory: [
    { runId: 'editorial-no-change-progress', phase: 'providerCallRunning', label: 'Editorial diagnosis', providerLane: 'utility', detail: { roleId: 'editorialDiagnostician' }, recordedAt: '1' },
    { runId: 'editorial-no-change-progress', phase: 'providerCallSettled', outcome: 'success', severity: 'success', label: 'Editorial diagnosis', providerLane: 'utility', detail: { roleId: 'editorialDiagnostician' }, recordedAt: '2' }
  ],
  activity: {
    runId: 'editorial-no-change-progress',
    phase: 'settled',
    outcome: 'skipped',
    severity: 'info',
    label: 'Editorial complete; no changes needed.',
    detail: { mode: 'redirect', decision: 'no-change' },
    recordedAt: '3'
  }
});
assertEqual(editorialNoChangeProgress.heroPixelState, 'skipped', 'Editorial no-change is visibly distinct from an applied Enhancement');
assert(editorialNoChangeProgress.steps.some((step) => step.id === 'editorial-result' && step.state === 'skipped'), 'Editorial no-change renders a skipped terminal result');
assert(!editorialNoChangeProgress.steps.some((step) => ['selecting-turn-hand', 'saving-scene-cache', 'composing-prompt-packet', 'installing-recursion-prompt', 'recursion-prompt-ready'].includes(step.id)), 'Editorial no-change renders no pre-generation or prompt-ready rows');

const editorialPartialFailedProgress = createProgressRunModel({
  activity: {
    runId: 'editorial-partial-failed-progress',
    phase: 'settled',
    outcome: 'success',
    severity: 'error',
    label: 'Repair partially applied; card review remains unresolved.',
    detail: {
      mode: 'repair',
      partialFailed: true,
      unresolvedCardIds: ['custom-card-b'],
      cardOutcomes: [
        { cardId: 'custom-card-a', status: 'honored' },
        { cardId: 'custom-card-b', status: 'partially-reflected' }
      ]
    },
    recordedAt: '1'
  }
});
const editorialPartialFailedResult = editorialPartialFailedProgress.steps.find((step) => step.id === 'editorial-result');
const editorialPartialFailedCards = editorialPartialFailedResult?.children?.find((child) => child.id === 'editorial-result-cards');
assertEqual(editorialPartialFailedResult?.state, 'failed', 'partial-failed Editorial result remains red');
assertEqual(editorialPartialFailedCards?.children?.length, 2, 'partial-failed Editorial result lists every dynamic installed-card outcome');
assertEqual(editorialPartialFailedCards?.children?.[0]?.state, 'done', 'valid Editorial card outcome remains resolved');
assertEqual(editorialPartialFailedCards?.children?.[1]?.state, 'failed', 'reconstructed missing Editorial card outcome renders red');
assertEqual(
  editorialPartialFailedCards?.reason,
  'Provider did not return one valid outcome for this installed card.',
  'failed installed-card parent surfaces its concrete failed-child reason'
);

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
