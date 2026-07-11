import { existsSync, readFileSync } from 'node:fs';
import {
  CARD_SCOPE_CATALOG,
  CARD_SCOPE_TOTAL_SUB_ITEMS,
  defaultCardScope,
  setFamilyEnabled,
  setSubItemEnabled
} from '../../src/card-scope.mjs';
import { activityLabel, createRecursionViewModel, mountRecursionUi, providerFromControls } from '../../src/ui.mjs';
import { createUiActionStatus, normalizeUiActionFailure } from '../../src/ui/action-status.mjs';
import { renderCompactBar } from '../../src/ui/bar.mjs';
import { cardsPanelState } from '../../src/ui/cards-panel.mjs';
import { providerSelector, providerStatusClass } from '../../src/ui/provider-panel.mjs';
import { progressPanelState } from '../../src/ui/progress-panel.mjs';
import { createHeroPixelBlocks, createProgressRunModel } from '../../src/progress.mjs';
import { DEFAULT_RECURSION_SETTINGS } from '../../src/settings.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

function fakeProviderControls(values = {}) {
  return {
    querySelector(selector) {
      if (!Object.hasOwn(values, selector)) return null;
      return { value: values[selector] };
    }
  };
}

assertEqual(activityLabel({ phase: 'cardBatchRunning' }), 'Generating scene cards...', 'phase label mapped');
assertEqual(activityLabel({ phase: 'fusedCardBundleRunning' }), 'Generating fused card bundle...', 'Fused phase label mapped');
assertEqual(providerSelector('model', 'utility'), '[data-recursion-provider-model-utility]', 'provider selector helper is stable');
assertEqual(providerStatusClass('Ready'), 'is-ready', 'provider status ready class is stable');
assertEqual(providerStatusClass('Missing model'), 'is-warning', 'provider status warning class is stable');
assertEqual(providerStatusClass('Ready', { baseClass: 'recursion-provider-status' }), 'recursion-provider-status pass', 'provider chrome status class preserves existing shape');
const compactBarPresentation = renderCompactBar({
  viewModel: {
    currentStepText: 'Generating scene cards...',
    standbyStatusText: 'Ready for Recursion.',
    modeLabel: 'Auto',
    generationStopVisible: true,
    freshNextGenerationVisible: false
  },
  tooltipsEnabled: true
});
assertEqual(compactBarPresentation.statusText, 'Generating scene cards...', 'compact bar presenter prefers active step text');
assertEqual(compactBarPresentation.showStop, true, 'compact bar presenter exposes stop visibility');
assertEqual(compactBarPresentation.showFreshNextGeneration, false, 'compact bar presenter hides fresh-next generation during active work');
assertEqual(progressPanelState({ progressRun: { title: 'Generating', steps: [{ id: 's1' }] } }).steps.length, 1, 'progress panel presenter exposes steps');
assertEqual(cardsPanelState({ lastHand: { cards: [{ id: 'c1' }] } }).count, 1, 'cards panel presenter counts hand cards');
const savedProviderDraft = {
  source: 'host-connection-profile',
  hostConnectionProfileId: 'saved-profile',
  openAICompatible: {
    baseUrl: 'https://saved.example/v1',
    model: 'saved-model',
    sessionApiKeyPresent: true
  }
};
const clearedProviderDraft = providerFromControls(fakeProviderControls({
  '[data-recursion-provider-source-utility]': 'openai-compatible',
  '[data-recursion-provider-profile-utility]': '',
  '[data-recursion-provider-base-url-utility]': '',
  '[data-recursion-provider-model-utility]': '',
  '[data-recursion-provider-api-key-utility]': ''
}), 'utility', savedProviderDraft);
assertEqual(clearedProviderDraft.source, 'openai-compatible', 'provider draft uses current source control');
assertEqual(clearedProviderDraft.hostConnectionProfileId, '', 'blank current profile does not fall back to saved profile');
assertEqual(clearedProviderDraft.openAICompatible.baseUrl, '', 'blank current base URL does not fall back to saved base URL');
assertEqual(clearedProviderDraft.openAICompatible.model, '', 'blank current model does not fall back to saved model');
assertEqual(clearedProviderDraft.openAICompatible.sessionApiKeyPresent, false, 'blank current API key is not treated as present');
const missingProviderDraft = providerFromControls(fakeProviderControls({}), 'utility', savedProviderDraft);
assertEqual(missingProviderDraft.hostConnectionProfileId, 'saved-profile', 'missing profile control falls back to saved profile');
assertEqual(missingProviderDraft.openAICompatible.baseUrl, 'https://saved.example/v1', 'missing base URL control falls back to saved base URL');
assertEqual(missingProviderDraft.openAICompatible.model, 'saved-model', 'missing model control falls back to saved model');
const normalizedUiFailure = normalizeUiActionFailure(new Error('Clipboard denied'), 'Copy failed.');
assertEqual(normalizedUiFailure.severity, 'warning', 'UI action failure uses warning severity');
assertEqual(normalizedUiFailure.label, 'Clipboard denied', 'UI action failure preserves concise error message');
const uiActionStatus = createUiActionStatus();
uiActionStatus.setFailure('', 'Copy failed.');
assertEqual(uiActionStatus.current().label, 'Copy failed.', 'UI action status uses fallback for empty failures');
uiActionStatus.set('Card prioritized.', 'success');
assertEqual(uiActionStatus.current().label, 'Card prioritized.', 'UI action status supports non-failure card feedback');
assertEqual(uiActionStatus.current().severity, 'success', 'UI action status preserves safe non-failure severity');
uiActionStatus.clear();
assertEqual(uiActionStatus.current(), null, 'UI action status clears transient state');
const model = createRecursionViewModel({
  settings: { mode: 'auto' },
  lastHand: { cards: [{ id: 'c1' }, { id: 'c2' }] },
  activity: { phase: 'settled', label: 'Recursion prompt ready.', severity: 'success' },
  lastPacket: { diagnostics: { composerLane: 'utility' } }
});
assertEqual(model.runtimeHealthLabel, 'Ready', 'runtime health label built');
assertEqual(model.modeLabel, 'Auto', 'mode label built');
assertEqual(model.statusText, undefined, 'view model does not expose combined runtime/mode status');
assertEqual(model.standbyStatusText, 'Recursion prompt ready.', 'settled prompt-ready activity exposes compact standby text with punctuation');
assertEqual(model.generationStopVisible, false, 'settled prompt-ready view hides the stop generation button');
assertEqual(model.handCount, 2, 'hand count built');
assertEqual(model.composerLabel, 'Utility', 'composer label built');
assertEqual(model.tooltipsEnabled, true, 'view model defaults tooltip hover help on');
assertEqual(createRecursionViewModel({ settings: { ui: { tooltipsEnabled: false } } }).tooltipsEnabled, false, 'view model can disable tooltip hover help');
assertEqual(
  createRecursionViewModel({
    activeRunId: 'run-active-stop',
    settings: { mode: 'auto', enabled: true },
    activity: { phase: 'cardBatchRunning' },
    lastHand: { cards: [] }
  }).generationStopVisible,
  true,
  'active Recursion run exposes stop generation button'
);
assertEqual(
  createRecursionViewModel({
    hostGenerationActive: true,
    settings: { mode: 'auto', enabled: true },
    activity: { phase: 'settled', severity: 'success', label: 'Recursion prompt ready.' },
    lastHand: { cards: [] }
  }).generationStopVisible,
  true,
  'active host generation keeps stop generation button visible after prompt preparation'
);
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true },
    activity: { phase: 'idle' },
    freshNextGeneration: { pending: false },
    lastHand: { cards: [] }
  }).freshNextGenerationVisible,
  true,
  'idle enabled view exposes fresh-next generation in the command slot'
);
assertEqual(
  createRecursionViewModel({
    activeRunId: 'run-active-force-slot',
    settings: { mode: 'auto', enabled: true },
    activity: { phase: 'cardBatchRunning' },
    freshNextGeneration: { pending: false },
    lastHand: { cards: [] }
  }).freshNextGenerationVisible,
  false,
  'active run hides fresh-next generation so stop owns the command slot'
);
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true },
    activity: { phase: 'idle' },
    freshNextGeneration: { pending: true },
    lastHand: { cards: [] }
  }).generationStopVisible,
  false,
  'pending fresh-next generation does not show Stop while idle'
);
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true },
    activity: { phase: 'idle' },
    freshNextGeneration: { pending: true },
    lastHand: { cards: [] }
  }).freshNextGenerationVisible,
  true,
  'pending fresh-next generation keeps Regenerate visible for cancel'
);
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true },
    activity: { phase: 'idle' },
    lastHand: { cards: [] }
  }).standbyStatusText,
  'Ready for Recursion.',
  'fresh enabled idle view exposes first-load standby text with punctuation'
);
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: false },
    activity: { phase: 'idle' },
    lastHand: { cards: [] }
  }).standbyStatusText,
  'Recursion off.',
  'disabled idle view exposes off standby text with punctuation'
);
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'manual', enabled: true },
    activity: { phase: 'idle' },
    lastHand: { cards: [{ id: 'manual-card' }] }
  }).standbyStatusText,
  'Manual scope armed.',
  'manual idle view exposes scoped standby text with punctuation'
);
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true },
    activity: { phase: 'idle' },
    lastHand: { cards: [{ id: 'deck-card' }] }
  }).standbyStatusText,
  'Scene deck standing by.',
  'auto idle view with cards exposes scene deck standby text with punctuation'
);
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true, pipelineMode: 'rapid' },
    activity: { phase: 'rapidWarmReady', severity: 'success', label: 'Rapid deck ready.' },
    lastHand: { cards: [{ id: 'rapid-card' }] }
  }).standbyStatusText,
  'Rapid deck ready.',
  'rapid warm success exposes rapid standby text with punctuation'
);
const rapidWarmingViewModel = createRecursionViewModel({
  settings: { mode: 'auto', enabled: true, pipelineMode: 'rapid' },
  activity: { phase: 'idle' },
  rapidWarm: { runId: 'rapid-ui-warming', status: 'warming', phase: 'rapidWarming' },
  lastHand: { cards: [] }
});
assertEqual(rapidWarmingViewModel.currentStepText, 'Rapid warming scene deck...', 'rapid warm object exposes warming status in the compact bar');
assertEqual(rapidWarmingViewModel.progressRun.steps.some((step) => step.id === 'rapid-warming-scene-deck'), true, 'rapid warm object appears in the progress menu');
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true, pipelineMode: 'rapid' },
    activity: { phase: 'idle' },
    rapidWarm: { runId: 'rapid-ui-ready', status: 'ready', phase: 'rapidWarmReady' },
    lastHand: { cards: [] }
  }).standbyStatusText,
  'Rapid deck ready.',
  'rapid warm ready status persists while idle'
);
assertEqual(
  createRecursionViewModel({
    settings: { mode: 'auto', enabled: true, pipelineMode: 'standard' },
    activity: { phase: 'idle' },
    rapidWarm: { runId: 'rapid-ui-standard', status: 'ready', phase: 'rapidWarmReady' },
    lastHand: { cards: [] }
  }).standbyStatusText,
  'Ready for Recursion.',
  'rapid warm status does not override Standard pipeline status'
);
const clearingBriefModel = createRecursionViewModel({
  settings: { mode: 'auto', enabled: true },
  lastBrief: { status: 'clearing', reason: 'generation-started' },
  activity: { phase: 'cardBatchRunning' },
  lastHand: { cards: [{ id: 'old-card' }] },
  lastPacket: { packetId: 'old-packet', diagnostics: { composerLane: 'utility' } }
});
assertEqual(clearingBriefModel.handCount, 0, 'clearing Last Brief hides old cards from compact hand count');
assertEqual(clearingBriefModel.lastBriefStatus, 'clearing', 'view model exposes Last Brief lifecycle state');

const explicitProgress = createProgressRunModel({
  progressRun: {
    runId: 'run-progress',
    title: 'Generating',
    subtitle: '2 model calls running',
    steps: [
      { id: 'read-turn', label: 'Reading current turn', providerLane: 'utility', state: 'done' },
      { id: 'card-batch', label: 'Utility card batch', providerLane: 'utility', state: 'running' },
      { id: 'reasoner-guidance', label: 'Reasoner guidance', providerLane: 'reasoner', state: 'running' },
      { id: 'compose-packet', label: 'Composing prompt packet', providerLane: 'utility', state: 'pending' },
      { id: 'repair-json', label: 'Repairing card JSON', providerLane: 'utility', state: 'warning' },
      { id: 'provider-failure', label: 'Provider retry exhausted', providerLane: 'reasoner', state: 'failed' }
    ]
  }
});
assertEqual(explicitProgress.runId, 'run-progress', 'progress model keeps run id');
assertEqual(explicitProgress.steps.length, 6, 'progress model keeps visible top-level steps');
assertEqual(explicitProgress.activeCount, 2, 'progress model counts concurrent running steps');
assertEqual(explicitProgress.heroPixelState, 'failed', 'failed progress dominates hero pixel state');
assertEqual(explicitProgress.currentStepText, '2 model calls running...', 'concurrent work gets compact bar text');
assertDeepEqual(
  explicitProgress.steps.map((step) => [step.id, step.providerLane, step.state, step.meta]),
  [
    ['read-turn', 'utility', 'done', 'done'],
    ['card-batch', 'utility', 'running', 'running'],
    ['reasoner-guidance', 'reasoner', 'running', 'running'],
    ['compose-packet', 'utility', 'pending', 'waiting'],
    ['repair-json', 'utility', 'warning', 'caution'],
    ['provider-failure', 'reasoner', 'failed', 'failed']
  ],
  'progress steps normalize provider lanes, states, and meta labels'
);
const heroBlocks = createHeroPixelBlocks(explicitProgress);
assertEqual(heroBlocks.length, 6, 'hero pixel array renders one block per visible progress row');
assertEqual(heroBlocks[0].className, 'hero-block done', 'done block class is stable');
assertEqual(heroBlocks[1].className, 'hero-block running', 'running block class is stable');
assertDeepEqual(
  heroBlocks.map((block) => [block.row, block.column, block.delayMs]),
  [
    [0, 0, 0],
    [1, 0, 24],
    [2, 0, 48],
    [0, 1, 72],
    [1, 1, 96],
    [2, 1, 120]
  ],
  'hero pixel array builds down three rows, then starts the next column to the right'
);
assertEqual(heroBlocks.at(-1).columnCount, 2, 'hero pixel array reports the visible column count for brand movement');

const cachedProgress = createProgressRunModel({
  progressRun: {
    runId: 'cached-progress',
    steps: [
      { id: 'reusing-scene-deck', label: 'Reusing scene deck', providerLane: 'utility', state: 'cached' }
    ]
  }
});
assertEqual(cachedProgress.steps[0].state, 'cached', 'progress model preserves cached state for reused cards');
assertEqual(cachedProgress.steps[0].meta, 'cached', 'cached progress rows use cached meta text');
assertEqual(cachedProgress.heroPixelState, 'cached', 'cached progress can own the compact hero state');
assertEqual(createHeroPixelBlocks(cachedProgress)[0].className, 'hero-block cached', 'cached hero pixel block class is stable');

const nestedChildProgress = createProgressRunModel({
  progressRun: {
    runId: 'nested-child-progress',
    steps: [
      {
        id: 'utility-card-batch',
        label: 'Utility card batch',
        providerLane: 'utility',
        state: 'running',
        children: [
          { id: 'scene-frame-card', label: 'Scene Frame', providerLane: 'utility', state: 'done', source: 'generated', sourceRoleId: 'sceneFrameCard' },
          { id: 'scene-constraints-card', label: 'Scene Constraints', providerLane: 'utility', state: 'cached', source: 'cache', sourceRoleId: 'sceneConstraintsCard' }
        ]
      },
      {
        id: 'reasoner-guidance',
        label: 'Reasoner guidance',
        providerLane: 'reasoner',
        state: 'running',
        children: [
          { id: 'reasoner-synthesis', label: 'Reasoner synthesis', providerLane: 'reasoner', state: 'failed', sourceRoleId: 'reasonerComposer' },
          { id: 'utility-fallback', label: 'Utility fallback', providerLane: 'utility', state: 'warning', source: 'fallback' }
        ]
      },
      {
        id: 'reusing-scene-deck',
        label: 'Reusing scene deck',
        providerLane: 'utility',
        state: 'running',
        children: [
          { id: 'active-cast-card', label: 'Active Cast', providerLane: 'utility', state: 'cached', source: 'cache', sourceRoleId: 'activeCastCard' },
          { id: 'open-threads-card', label: 'Open Threads', providerLane: 'utility', state: 'cached', source: 'cache', sourceRoleId: 'openThreadsCard' }
        ]
      }
    ]
  }
});
const nestedUtilityBatch = nestedChildProgress.steps.find((step) => step.id === 'utility-card-batch');
const nestedReasonerBrief = nestedChildProgress.steps.find((step) => step.id === 'reasoner-guidance');
const nestedCacheDeck = nestedChildProgress.steps.find((step) => step.id === 'reusing-scene-deck');
assertEqual(nestedUtilityBatch.state, 'done', 'mixed generated and cached child success makes the card batch successful');
assertEqual(nestedReasonerBrief.state, 'failed', 'failed child dominates reasoner brief parent state');
assertEqual(nestedCacheDeck.state, 'cached', 'all-cached children make the parent cached');
assertDeepEqual(
  nestedUtilityBatch.children.map((child) => [child.id, child.label, child.state, child.meta, child.sourceRoleId]),
  [
    ['scene-frame-card', 'Scene Frame', 'done', 'generated', 'sceneFrameCard'],
    ['scene-constraints-card', 'Scene Constraints', 'cached', 'cached', 'sceneConstraintsCard']
  ],
  'nested progress normalizes card child rows with source-aware meta text'
);
assertEqual(createHeroPixelBlocks(nestedChildProgress).length, 3, 'hero pixel array renders parent rows only, not nested child rows');
assertDeepEqual(
  createHeroPixelBlocks(nestedChildProgress).map((block) => [block.id, block.state]),
  [
    ['utility-card-batch', 'done'],
    ['reasoner-guidance', 'failed'],
    ['reusing-scene-deck', 'cached']
  ],
  'hero pixel blocks use aggregated parent states for nested progress'
);

const overflowingProgress = createProgressRunModel({
  progressRun: {
    runId: 'overflow-progress',
    steps: Array.from({ length: 40 }, (_, index) => ({
      id: `overflow-step-${index + 1}`,
      label: `Overflow step ${index + 1}`,
      providerLane: index % 2 === 0 ? 'utility' : 'reasoner',
      state: index >= 36 ? ['done', 'failed', 'warning', 'running'][index - 36] : 'done'
    }))
  }
});
const overflowingBlocks = createHeroPixelBlocks(overflowingProgress);
assertEqual(overflowingProgress.steps.length, 40, 'progress menu model keeps every visible step even when the pixel array overflows');
assertEqual(overflowingBlocks.length, 36, 'hero pixel array caps at twelve three-row columns');
assertEqual(overflowingBlocks.at(-1).id, 'overflow-progress', 'hero pixel array uses the last block as the overflow aggregate');
assertEqual(overflowingBlocks.at(-1).state, 'running', 'overflow aggregate prioritizes running hidden work');
assertEqual(overflowingBlocks.at(-1).hiddenStepCount, 5, 'overflow aggregate counts the represented overflow steps');
assertEqual(overflowingBlocks.at(-1).columnCount, 12, 'overflow aggregate keeps the compact array within twelve columns');

const overflowingCachedProgress = createProgressRunModel({
  progressRun: {
    runId: 'overflow-cached-progress',
    steps: Array.from({ length: 38 }, (_, index) => ({
      id: `overflow-cached-step-${index + 1}`,
      label: `Overflow cached step ${index + 1}`,
      providerLane: 'utility',
      state: index === 36 ? 'cached' : 'done'
    }))
  }
});
assertEqual(createHeroPixelBlocks(overflowingCachedProgress).at(-1).state, 'cached', 'overflow aggregate preserves cached hidden work when no higher priority state is hidden');

const derivedProgress = createProgressRunModel({
  settings: { mode: 'auto' },
  activityHistory: [
    { runId: 'run-derived', phase: 'started', label: 'Reading current turn...', providerLane: 'utility' },
    { runId: 'run-derived', phase: 'arbiterPlanning', label: 'Planning card pass...', providerLane: 'utility' },
    { runId: 'run-derived', phase: 'cardBatchRunning', label: 'Generating scene cards...', providerLane: 'utility', cardCounts: { requested: 3 } }
  ],
  activity: { runId: 'run-derived', phase: 'cardBatchRunning', label: 'Generating scene cards...', providerLane: 'utility', cardCounts: { requested: 3 } },
  lastPlan: {
    cardJobs: [{ family: 'Scene Frame' }, { family: 'Motivation' }, { family: 'Scene Constraints' }],
    reasonerDecision: { mode: 'use' }
  }
});
assertDeepEqual(
  derivedProgress.steps.map((step) => [step.id, step.state]),
  [
    ['read-turn', 'done'],
    ['planning-card-pass', 'done'],
    ['utility-card-batch', 'running'],
    ['selecting-turn-hand', 'pending'],
    ['saving-scene-cache', 'pending'],
    ['composing-prompt-packet', 'pending'],
    ['reasoner-guidance', 'pending'],
    ['installing-recursion-prompt', 'pending']
  ],
  'progress model derives top-level pending steps from activity history and plan'
);

const concurrentDerivedProgress = createProgressRunModel({
  settings: { mode: 'auto' },
  activityHistory: [
    { runId: 'run-concurrent', phase: 'providerCallRunning', label: 'Utility call', providerLane: 'utility', detail: { roleId: 'sceneFrameCard' } },
    { runId: 'run-concurrent', phase: 'providerCallRunning', label: 'Reasoner call', providerLane: 'reasoner', detail: { roleId: 'reasonerComposer' } }
  ],
  activity: { runId: 'run-concurrent', phase: 'providerCallRunning', label: 'Reasoner call', providerLane: 'reasoner', detail: { roleId: 'reasonerComposer' } }
});
assertDeepEqual(
  concurrentDerivedProgress.steps
    .filter((step) => ['utility-card-batch', 'reasoner-guidance'].includes(step.id))
    .map((step) => [step.id, step.state]),
  [
    ['utility-card-batch', 'running'],
    ['reasoner-guidance', 'running']
  ],
  'derived progress keeps concurrent provider rows running'
);
assertEqual(concurrentDerivedProgress.currentStepText, '2 model calls running...', 'derived concurrent progress gets compact bar text');

const enhancementProviderProgress = createProgressRunModel({
  settings: { mode: 'auto' },
  activityHistory: [
    { runId: 'run-enhance', phase: 'enhancementResponse', label: 'Enhancing response...', providerLane: 'reasoner' },
    { runId: 'run-enhance', phase: 'providerCallRunning', label: 'Provider call running.', providerLane: 'reasoner', detail: { roleId: 'dialogueEnhancer' } },
    { runId: 'run-enhance', phase: 'providerCallRunning', label: 'Provider call running.', providerLane: 'reasoner', detail: { roleId: 'proseEnhancer' } }
  ],
  activity: { runId: 'run-enhance', phase: 'providerCallRunning', label: 'Provider call running.', providerLane: 'reasoner', detail: { roleId: 'proseEnhancer' } }
});
assertDeepEqual(
  enhancementProviderProgress.steps
    .filter((step) => ['dialogue-enhancement', 'prose-enhancement'].includes(step.id))
    .map((step) => [step.id, step.label, step.providerLane, step.sourceRoleId]),
  [
    ['dialogue-enhancement', 'Dialogue Enhancement', 'reasoner', 'dialogueEnhancer'],
    ['prose-enhancement', 'Prose Enhancement', 'reasoner', 'proseEnhancer']
  ],
  'derived progress labels enhancement provider calls as first-class enhancement rows'
);
assertEqual(enhancementProviderProgress.steps.some((step) => step.id === 'utility-card-batch'), false, 'enhancement provider calls do not create a Utility card batch row');
assertEqual(enhancementProviderProgress.steps.some((step) => step.id === 'enhancement-response'), false, 'derived progress hides generic Enhancement row once concrete enhancement pass rows exist');

const derivedCachedProgress = createProgressRunModel({
  settings: { mode: 'auto' },
  activityHistory: [
    { runId: 'run-cache', phase: 'cacheReusing', label: 'Reusing scene deck...', providerLane: 'utility' }
  ],
  activity: { runId: 'run-cache', phase: 'cacheReusing', label: 'Reusing scene deck...', providerLane: 'utility' }
});
assertEqual(
  derivedCachedProgress.steps.find((step) => step.id === 'reusing-scene-deck')?.state,
  'cached',
  'cache reuse activity derives a cached progress row'
);

const derivedNestedProgress = createProgressRunModel({
  settings: { mode: 'auto' },
  activityHistory: [
    { runId: 'run-nested-derived', phase: 'cardBatchRunning', label: 'Generating scene cards...', providerLane: 'utility', cardCounts: { requested: 4 } },
    { runId: 'run-nested-derived', phase: 'providerCallRunning', label: 'Provider batch call running.', providerLane: 'utility', detail: { roleId: 'sceneFrameCard', batchIndex: 0 } },
    { runId: 'run-nested-derived', phase: 'cardProgress', label: 'Scene Constraints reused from cache.', providerLane: 'utility', severity: 'success', detail: { parentStepId: 'utility-card-batch', roleId: 'sceneConstraintsCard', family: 'Scene Constraints', source: 'cache', state: 'cached' } },
    { runId: 'run-nested-derived', phase: 'cardProgress', label: 'Character Motivation generated.', providerLane: 'utility', severity: 'success', detail: { parentStepId: 'utility-card-batch', roleId: 'characterMotivationCard', family: 'Character Motivation', source: 'generated', state: 'done' } },
    { runId: 'run-nested-derived', phase: 'cardProgress', label: 'Open Threads fell back locally.', providerLane: 'utility', severity: 'warning', detail: { parentStepId: 'utility-card-batch', roleId: 'openThreadsCard', family: 'Open Threads', source: 'fallback', state: 'warning' } }
  ],
  activity: { runId: 'run-nested-derived', phase: 'providerCallRunning', label: 'Provider batch call running.', providerLane: 'utility', detail: { roleId: 'sceneFrameCard', batchIndex: 0 } },
  lastPlan: {
    cardJobs: [
      { family: 'Scene Frame', role: 'sceneFrameCard' },
      { family: 'Scene Constraints', role: 'sceneConstraintsCard' },
      { family: 'Character Motivation', role: 'characterMotivationCard' },
      { family: 'Open Threads', role: 'openThreadsCard' }
    ]
  }
});
const derivedNestedBatch = derivedNestedProgress.steps.find((step) => step.id === 'utility-card-batch');
assertEqual(derivedNestedBatch.state, 'warning', 'derived card batch parent turns yellow when any child has a repairable caution and no child failed');
assertDeepEqual(
  derivedNestedBatch.children.map((child) => [child.label, child.state, child.meta]),
  [
    ['Scene Frame', 'running', 'running'],
    ['Scene Constraints', 'cached', 'cached'],
    ['Character Motivation', 'done', 'generated'],
    ['Open Threads', 'warning', 'fallback']
  ],
  'derived card batch has pending/running/generated/cached/fallback child rows'
);

const fusedMixedSourceProgress = createProgressRunModel({
  settings: { mode: 'auto', pipelineMode: 'fused' },
  activityHistory: [
    { runId: 'run-fused-mixed-source', phase: 'providerCallRunning', label: 'Fused card bundle running.', providerLane: 'utility', detail: { roleId: 'fusedCardBundle' } },
    { runId: 'run-fused-mixed-source', phase: 'providerCallSettled', label: 'Fused card bundle complete.', providerLane: 'utility', outcome: 'success', detail: { roleId: 'fusedCardBundle' } },
    { runId: 'run-fused-mixed-source', phase: 'cardProgress', label: 'Scene Frame generated.', providerLane: 'utility', severity: 'success', detail: { parentStepId: 'fused-card-bundle', roleId: 'sceneFrameCard', family: 'Scene Frame', source: 'generated', state: 'done' } },
    { runId: 'run-fused-mixed-source', phase: 'cardProgress', label: 'Scene Constraints reused from cache.', providerLane: 'utility', severity: 'success', detail: { parentStepId: 'fused-card-bundle', roleId: 'sceneConstraintsCard', family: 'Scene Constraints', source: 'cache', state: 'cached' } }
  ],
  activity: { runId: 'run-fused-mixed-source', phase: 'providerCallSettled', label: 'Fused card bundle complete.', providerLane: 'utility', outcome: 'success', detail: { roleId: 'fusedCardBundle' } }
});
const fusedMixedSourceBundle = fusedMixedSourceProgress.steps.find((step) => step.id === 'fused-card-bundle');
assertEqual(fusedMixedSourceProgress.steps.some((step) => step.id === 'utility-card-batch'), false, 'Fused mixed cache/generated progress does not create a duplicate Utility card batch');
assertDeepEqual(
  fusedMixedSourceBundle.children.map((child) => [child.label, child.state, child.meta]),
  [
    ['Scene Frame', 'done', 'generated'],
    ['Scene Constraints', 'cached', 'cached']
  ],
  'Fused mixed source progress keeps cached child rows purple inside the Fused bundle'
);

const unsafeExplicitProgress = createProgressRunModel({
  progressRun: {
    runId: 'unsafe-progress',
    title: 'rawPrompt: SYSTEM PROMPT TEXT',
    subtitle: 'Bearer unsafe-progress-token',
    steps: [
      {
        id: 'read-turn',
        label: 'rawPrompt: SYSTEM PROMPT TEXT password: hunter2',
        providerLane: 'utility',
        state: 'running',
        meta: 'password: hunter2'
      }
    ]
  }
});
assertEqual(unsafeExplicitProgress.title, 'Generating', 'unsafe progress title falls back to friendly title');
assertEqual(unsafeExplicitProgress.subtitle, '', 'unsafe progress subtitle is omitted');
assertEqual(unsafeExplicitProgress.steps[0].label, 'Reading current turn', 'unsafe progress label falls back to known step label');
assertEqual(unsafeExplicitProgress.steps[0].meta, 'running', 'unsafe progress meta falls back to state meta');
assert(!JSON.stringify(unsafeExplicitProgress).includes('SYSTEM PROMPT TEXT'), 'progress model omits raw prompt text');
assert(!JSON.stringify(unsafeExplicitProgress).includes('hunter2'), 'progress model omits password text');
assert(!JSON.stringify(unsafeExplicitProgress).includes('unsafe-progress-token'), 'progress model omits bearer token text');

const progressViewModel = createRecursionViewModel({
  settings: { mode: 'auto' },
  progressRun: {
    runId: 'view-progress',
    steps: [
      { id: 'read-turn', label: 'Reading current turn', providerLane: 'utility', state: 'done' },
      { id: 'card-batch', label: 'Utility card batch', providerLane: 'utility', state: 'running' }
    ]
  }
});
assertEqual(progressViewModel.progressRun.currentStepText, 'Utility card batch...', 'view model exposes progress current step text');
assertEqual(progressViewModel.heroPixelBlocks.length, 2, 'view model exposes hero pixel blocks for renderers');
assertEqual(progressViewModel.heroPixelBlocks[1].state, 'running', 'view model keeps active hero pixel block state');
assertEqual(progressViewModel.heroPixelColumnCount, 1, 'view model exposes pixel column count for moving brand layout');
assertEqual(progressViewModel.progressChildVisibleLimit, 5, 'view model defaults to five visible sub-tier rows');
assertEqual(progressViewModel.progressListVisibleLimit, 15, 'view model defaults to fifteen visible progress items');

const pendingProgressViewModel = createRecursionViewModel({
  settings: { mode: 'auto' },
  progressRun: {
    runId: 'pending-progress',
    steps: [
      { id: 'installing-recursion-prompt', label: 'Installing Recursion prompt', providerLane: 'utility', state: 'pending' }
    ]
  }
});
assertEqual(
  pendingProgressViewModel.progressRun.currentStepText,
  '',
  'compact bar hides pending/waiting steps until work is active'
);

const customProgressCapsViewModel = createRecursionViewModel({
  settings: { ui: { progressChildVisibleLimit: 8, progressListVisibleLimit: 24 } }
});
assertEqual(customProgressCapsViewModel.progressChildVisibleLimit, 8, 'view model exposes custom sub-tier row limit');
assertEqual(customProgressCapsViewModel.progressListVisibleLimit, 24, 'view model exposes custom whole-list row limit');

const barImplementationReference = readFileSync(new URL('../../docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md', import.meta.url), 'utf8');
const uiSpec = readFileSync(new URL('../../docs/design/UI_SPEC.md', import.meta.url), 'utf8');
const recursionCss = readFileSync(new URL('../../styles/recursion.css', import.meta.url), 'utf8');
assert(recursionCss.includes('recursion-enhancement-capture-active'), 'enhancement capture CSS hides the class toggled by the extension');
const recursionUi = readFileSync(new URL('../../src/ui.mjs', import.meta.url), 'utf8');
const regenerateIconPath = new URL('../../assets/icons/regenerate.svg', import.meta.url);
for (const section of [
  '/* Recursion root and compact bar */',
  '/* Progress panel */',
  '/* Cards and Last Brief */',
  '/* Settings shell */',
  '/* Provider panel */'
]) {
  assert(recursionCss.includes(section), `CSS includes ${section}`);
}
assert(!recursionUi.includes('save and test it'), 'provider tooltip copy does not mention a removed save action');
assert(recursionUi.includes('changes auto-save'), 'provider tooltip copy explains autosave behavior');
assert(existsSync(regenerateIconPath), 'Regenerate uses a named SVG asset');
const regenerateIconSvg = existsSync(regenerateIconPath) ? readFileSync(regenerateIconPath, 'utf8') : '';
const activityTriggerCss = barImplementationReference.match(/\.activity-trigger\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const referenceHostCss = barImplementationReference.match(/\.recursion-topbar-host\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const referenceBarCss = barImplementationReference.match(/\.recursion-bar\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const heroBlockCss = barImplementationReference.match(/\.hero-block\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const heroBlockEnterCss = barImplementationReference.match(/@keyframes hero-block-enter\s*\{([\s\S]*?)\n\}\n\n@keyframes hero-block-active/)?.[1] ?? '';
const heroBlockActiveCss = barImplementationReference.match(/@keyframes hero-block-active\s*\{([\s\S]*?)\n\}\n\n@keyframes hero-block-wipe/)?.[1] ?? '';
const reasoningChainCss = barImplementationReference.match(/\.reasoning-chain\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const reasoningNodeCss = barImplementationReference.match(/\.reasoning-node\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const reasoningLitNodeCss = barImplementationReference.match(/\.reasoning-node\.is-lit\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const regenerateIconCss = recursionCss.match(/\.recursion-fresh-next-generation-icon\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
assert(/<svg\b/i.test(regenerateIconSvg), 'regenerate.svg is an SVG asset');
assert(/\bviewBox="0 0 512 512"/.test(regenerateIconSvg), 'regenerate.svg preserves the attached full-size scalable viewBox');
assert(/<path\b/i.test(regenerateIconSvg), 'regenerate.svg contains vector path data');
assert(!/source=rotate\.png; sourceSize=512x512; alphaTrace=horizontal-runs/.test(regenerateIconSvg), 'regenerate.svg is not the generated alpha-run approximation');
assert(!/kind === 'restart'/.test(recursionUi), 'Regenerate uses the regenerate.svg asset instead of the old inline SVG branch');
assert(/background:\s*currentColor;/.test(regenerateIconCss), 'Regenerate icon mask paints with inherited currentColor');
assert(/mask:\s*url\('\.\.\/assets\/icons\/regenerate\.svg'\)\s*center\s*\/\s*12px 12px\s*no-repeat;/.test(regenerateIconCss), 'Regenerate icon mask is centered and visually scaled to match the surrounding icons');
assert(/padding:\s*0 8px 0 2px;/.test(barImplementationReference), 'recursion bar uses a tighter left inset than right controls');
assert(/--hero-running:\s*var\(--cyan\);/.test(barImplementationReference), 'hero pixel running blocks use the active blue token');
assert(/--hero-done:\s*var\(--green\);/.test(barImplementationReference), 'hero pixel done blocks use the success green token');
assert(/--hero-cached:\s*var\(--purple\);/.test(barImplementationReference), 'hero pixel cached blocks use the cache purple token');
assert(/--hero-warning:\s*var\(--amber\);/.test(barImplementationReference), 'hero pixel warning blocks use the caution yellow token');
assert(/--hero-failed:\s*var\(--red\);/.test(barImplementationReference), 'hero pixel failed blocks use the failure red token');
assert(/--hero-block-gap:\s*2px;/.test(barImplementationReference), 'hero pixel blocks use a 2px row and column gap');
assert(/grid-template-rows:\s*repeat\(3,\s*var\(--hero-block-size\)\);/.test(barImplementationReference), 'hero pixel array uses three rows per column');
assert(/class="power-toggle is-on"/.test(barImplementationReference), 'reference bar starts with a dedicated power toggle');
assert(/class="activity-trigger status-array-button"/.test(barImplementationReference), 'hero pixel array and current status share one activity trigger after mode');
assert(!/class="brand-stage/.test(barImplementationReference), 'reference bar no longer renders the Recursion wordmark stage');
assert(/\.power-toggle\s*\{[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/.test(barImplementationReference), 'reference power toggle keeps compact 24px control geometry');
assert(/data-recursion-mode-arrow-fan/.test(barImplementationReference), 'reference Auto mode icon uses divergent three-arrow geometry');
assert(/data-recursion-mode-arrow-parallel/.test(barImplementationReference), 'reference Manual mode icon uses parallel three-arrow geometry');
assert(/Cards Selection button owns the stacked-cards icon/.test(uiSpec), 'UI spec assigns stacked cards to card scope selection, not mode');
assert(/open-eye action sets every runnable card/.test(uiSpec), 'UI spec documents the Cards dropdown activate-all action');
assert(/slashed-eye action sets every runnable card/.test(uiSpec), 'UI spec documents the Cards dropdown deactivate-all action');
assert(/data-mode="manual"/.test(barImplementationReference), 'reference mode menu includes Manual');
const removedModeValue = ['semi', 'auto'].join('-');
assert(!barImplementationReference.includes(`data-mode="${removedModeValue}"`), 'reference mode menu removes the old named mode');
assert(!/data-mode="observe"/.test(barImplementationReference), 'reference mode menu removes Observe only');
assert(!/data-mode="off"/.test(barImplementationReference), 'reference mode menu removes Off');
assert(/\.hero-pixel-array\s*\{[\s\S]*?position:\s*relative;[\s\S]*?width:\s*max\(0px,/.test(barImplementationReference), 'hero pixel blocks render inline after mode with a zero-width reset state');
assert(/\.activity-trigger\s*\{[\s\S]*?gap:\s*7px;[\s\S]*?transition:\s*color \.14s ease;/.test(barImplementationReference), 'activity trigger keeps a stable visual gap between blocks and status');
assert(/text-align:\s*left;/.test(activityTriggerCss), 'activity trigger keeps status text visually attached to the pixel blocks');
assert(!/\.brand-block\.is-resetting \.brand-fade/.test(barImplementationReference), 'fixed brand fade is not wiped by turn reset');
assert(/\.activity-trigger\.is-resetting \.hero-block/.test(barImplementationReference), 'activity reset state wipes old pixel blocks outside the brand stage');
assert(!/transform:\s*scale/.test(heroBlockCss), 'hero blocks do not scale inside grid cells');
assert(!/transform:\s*scale/.test(heroBlockEnterCss), 'hero block entry animation does not change visual grid gaps');
assert(!/transform:\s*scale/.test(heroBlockActiveCss), 'hero block running animation does not change visual grid gaps');
assert(/display:\s*block;/.test(heroBlockCss), 'hero pixel blocks render as block boxes, not inline spans');
assert(/aspect-ratio:\s*1\s*\/\s*1;/.test(heroBlockCss), 'hero pixel blocks explicitly preserve a square aspect ratio');
assert(/border-radius:\s*0;/.test(heroBlockCss), 'hero pixel blocks use sharp square corners');
assert(/class="reasoning-chain"/.test(barImplementationReference), 'right tools include a compact reasoning level chain');
assert(/role="radiogroup"/.test(barImplementationReference), 'reasoning level chain is exposed as a radio group');
assert(/data-selected="high"/.test(barImplementationReference), 'mock defaults the reasoning chain to High');
assert(/data-level="low"[\s\S]*?title="Low/.test(barImplementationReference), 'reasoning chain includes Low tooltip copy');
assert(/data-level="medium"[\s\S]*?title="Medium/.test(barImplementationReference), 'reasoning chain includes Medium tooltip copy');
assert(/data-level="high"[\s\S]*?title="High/.test(barImplementationReference), 'reasoning chain includes High tooltip copy');
assert(/data-level="ultra"[\s\S]*?title="Ultra/.test(barImplementationReference), 'reasoning chain includes Ultra tooltip copy');
assert(/border-radius:\s*2px;/.test(reasoningNodeCss), 'reasoning nodes use 2px radius square boxes');
assert(!/rgba\(101,\s*216,\s*232/.test(reasoningLitNodeCss), 'lit reasoning nodes do not use cyan after moving to SillyTavern grey-white theme');
assert(/\.reasoning-line-fill\s*\{[\s\S]*?rgba\(220,\s*220,\s*210,\s*\.52\)/.test(barImplementationReference), 'reasoning chain fill uses SillyTavern grey-white theme color');
assert(/\.reasoning-node\.is-lit\s*\{[\s\S]*?rgba\(220,\s*220,\s*210,\s*\.62\)/.test(barImplementationReference), 'lit reasoning nodes use muted SillyTavern grey-white fill');
assert(/\.recursion-reasoning-line-fill\s*\{[\s\S]*?var\(--SmartThemeBodyColor/.test(recursionCss), 'production reasoning fill derives from SillyTavern body color');
assert(/assets\/icons\/prose\.svg/.test(recursionCss), 'Enhancements target rows use the prose.svg mask icon');
assert(/assets\/icons\/dialogue\.svg/.test(recursionCss), 'Enhancements target rows use the dialogue.svg mask icon');
assert(/\.recursion-enhancements-choice\.is-combo \.recursion-enhancements-choice-icon\s*\{[\s\S]*?height:\s*42px;/.test(recursionCss), 'Prose + Dialogue row centers the full-height combo icon stack in its own slot');
assert(!/recursion-settings-reasoning/.test(recursionCss), 'settings panel does not keep a duplicate reasoning chain stylesheet');
assert(!/settingsReasoningLevelRow|recursionSettingReasoningChoice|MODE_OPTIONS/.test(recursionUi), 'settings panel does not keep duplicate mode or reasoning handlers');
assert(/\.reasoning-chain::before/.test(barImplementationReference), 'reasoning nodes are connected by a chain line');
assert(/--chain-start:\s*5px;/.test(reasoningChainCss), 'reasoning chain defines the first node center');
assert(/--chain-step:\s*15px;/.test(reasoningChainCss), 'reasoning chain defines exact node-center spacing');
assert(/--chain-span:\s*calc\(var\(--chain-step\) \* 3\);/.test(reasoningChainCss), 'reasoning chain line spans exact node centers');
assert(!/--chain-fill:\s*\d+%;/.test(barImplementationReference), 'reasoning chain fill does not use approximate percentage stops');
assert(!/justify-content:\s*space-between;/.test(reasoningChainCss), 'reasoning nodes do not rely on space-between geometry');
assert(/\.reasoning-chain\[data-selected="high"\]\s*\{[\s\S]*?--chain-fill:\s*calc\(var\(--chain-step\) \* 2\);/.test(barImplementationReference), 'High reasoning fill ends on the High node center');
assert(/\.reasoning-line-fill\s*\{[\s\S]*?left:\s*var\(--chain-start\);[\s\S]*?width:\s*var\(--chain-fill\);/.test(barImplementationReference), 'reasoning fill starts and ends from explicit node-center geometry');
assert(/\.reasoning-node\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*var\(--node-x\);[\s\S]*?transform:\s*translate\(-50%,\s*-50%\);/.test(barImplementationReference), 'reasoning nodes are centered on explicit x coordinates');
assert(/\.reasoning-node\[data-level="ultra"\]\s*\{[\s\S]*?--node-x:\s*calc\(var\(--chain-start\) \+ \(var\(--chain-step\) \* 3\)\);/.test(barImplementationReference), 'Ultra reasoning node shares the final chain endpoint');
assert(/\.reasoning-node\[data-level="low"\]\s*\{[\s\S]*?--node-size:\s*5px;/.test(barImplementationReference), 'Low reasoning node is the smallest box');
assert(/\.reasoning-node\[data-level="ultra"\]\s*\{[\s\S]*?--node-size:\s*11px;/.test(barImplementationReference), 'Ultra reasoning node is the largest box');
assert(/function setReasoningLevel/.test(barImplementationReference), 'turn animation preview lets reasoning nodes update selection');
assert(/font:\s*12\.5px\/1/.test(referenceHostCss), 'reference topbar host pins compact typography for detached popovers');
assert(/height:\s*30px;/.test(referenceBarCss), 'reference bar height matches the production compact SillyTavern bar');
assert(/\.power-toggle\s*\{[\s\S]*?color:\s*rgba\(224,\s*224,\s*224,\s*\.72\);/.test(barImplementationReference), 'reference power toggle uses the grey-white SillyTavern theme color');
assert(!/\.recursion-mode-icon::before/.test(recursionCss), 'production mode button uses inline SVG, not CSS pseudo icons');
assert(!/\.recursion-mode-choice-icon::before/.test(recursionCss), 'production mode menu uses inline SVG, not CSS pseudo icons');
assert(/\.recursion-mode-icon\s*\{[\s\S]*?pointer-events:\s*none;/.test(recursionCss), 'production mode icon container does not become an independent click target');
assert(/\.recursion-mode-icon \*\s*\{[\s\S]*?pointer-events:\s*none;/.test(recursionCss), 'production mode icon graphics do not become independent click targets');
assert(/\.recursion-brief-card\s*\{[\s\S]*?grid-template-columns:\s*138px minmax\(0,\s*1fr\);/.test(recursionCss), 'production Last Brief cards use the reference two-column card grid');
assert(/\.recursion-card-text\s*\{[\s\S]*?-webkit-line-clamp:\s*1;/.test(recursionCss), 'production Last Brief cards clamp text to one line while compact');
assert(/\.recursion-brief-card\[aria-expanded="true"\] \.recursion-card-text\s*\{[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;[\s\S]*?white-space:\s*normal;[\s\S]*?-webkit-line-clamp:\s*unset;/.test(recursionCss), 'expanded Last Brief cards grow to full text without nested scroll or ellipsis');
assert(/\.status-popover\s*\{[\s\S]*?left:\s*-3px;/.test(barImplementationReference), 'status popover aligns to the visible left edge of the bar');
assert(/const PROGRESS_CHILD_VISIBLE_LIMIT = 5;/.test(barImplementationReference), 'turn animation preview defaults to five visible sub-tier rows');
assert(/const PROGRESS_LIST_VISIBLE_LIMIT = 15;/.test(barImplementationReference), 'turn animation preview defaults to fifteen visible progress items');
assert(/--child-visible-limit:\s*5;/.test(barImplementationReference), 'child row groups define the default visible sub-tier cap');
assert(/--progress-list-visible-limit:\s*15;/.test(barImplementationReference), 'status list defines the default whole-list cap');
assert(/\.step-children\[data-overflow="true"\]:not\(\[data-at-end="true"\]\)::after/.test(barImplementationReference), 'overflowing child groups show a bottom fade until scrolled to the end');
assert(/\.step-children::?-webkit-scrollbar|\.step-children::-webkit-scrollbar/.test(barImplementationReference), 'child row groups hide webkit scrollbars');
assert(/function updateChildGroupScrollState/.test(barImplementationReference), 'turn animation preview updates child group scroll fade state');
assert(/function updateStatusListScrollState/.test(barImplementationReference), 'turn animation preview updates whole progress list scroll state');
assert(/\.step-row\.is-entering/.test(barImplementationReference), 'progress rows have an insertion animation class');
assert(/@keyframes step-row-enter/.test(barImplementationReference), 'progress row insertion animation is defined');
assert(/\.status-popover\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/.test(barImplementationReference), 'reference progress popover uses the same mobile flex shell as production');
assert(/\.status-list\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/.test(barImplementationReference), 'reference progress list flex-shrinks and scrolls inside the popover');
assert(/\.recursion-step-row\.is-entering/.test(recursionCss), 'production progress rows have an insertion animation class');
assert(/\.recursion-step-row\.is-updating/.test(recursionCss), 'production progress rows have an update animation class');
assert(/@keyframes recursion-step-row-enter/.test(recursionCss), 'production progress row insertion animation is defined');
assert(/@keyframes recursion-step-row-update/.test(recursionCss), 'production progress row update animation is defined');
assert(/\.recursion-step-children\s*\{[\s\S]*?--recursion-progress-child-row-height:\s*25px;[\s\S]*?padding:\s*0 0 3px 22px;/.test(recursionCss), 'production progress child rows match the compact indented reference geometry');
assert(/\.recursion-step-row\.child-row\s*\{[\s\S]*?height:\s*var\(--recursion-progress-child-row-height\);/.test(recursionCss), 'production child progress rows use the reference fixed child height');
assert(/\.recursion-step-row\.running \.recursion-step-icon\s*\{[\s\S]*?height:\s*12px;[\s\S]*?width:\s*12px;/.test(recursionCss), 'production running progress spinner uses the 12px reference ring size');
assert(/\.recursion-step-row\.running \.recursion-step-icon::after/.test(recursionCss), 'production running progress spinner uses an inner cutout like the reference ring');
assert(/\.recursion-status-popover\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/.test(recursionCss), 'production progress popover uses a flex column shell so mobile height clamps constrain its contents');
assert(/\.recursion-status-popover\[hidden\]\s*\{[\s\S]*?display:\s*none !important;/.test(recursionCss), 'production progress popover hidden state survives the flex display rule');
assert(/\.recursion-status-head\s*\{[\s\S]*?min-height:\s*34px;[\s\S]*?padding:\s*7px 9px;/.test(recursionCss), 'production progress popover header uses the reference 34px compactness');
assert(/\.recursion-status-head,\s*[\r\n]+\.recursion-status-foot\s*\{[\s\S]*?flex:\s*0 0 auto;/.test(recursionCss), 'production progress header and footer stay fixed while the list scrolls');
assert(!/\.recursion-status-subtitle\s*\{[^}]*margin-left:\s*auto;/.test(recursionCss), 'production progress subtitle stays beside the title instead of pinning to the right edge');
assert(/\.recursion-status-list\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?max-height:\s*calc\(var\(--recursion-progress-list-limit, 15\) \* 30px\);[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/.test(recursionCss), 'production progress list flex-shrinks inside the viewport-clamped popover');
assert(/\.recursion-status-list\s*\{[\s\S]*?-webkit-overflow-scrolling:\s*touch;/.test(recursionCss), 'production progress list keeps touch momentum scrolling on mobile');
assert(!/\.recursion-settings-panel\.is-beside-progress/.test(recursionCss), 'production settings panel no longer carries obsolete side-by-side progress styling');
assert(!/\.recursion-settings-panel\s*\{[\s\S]*?left:\s*360px;/.test(recursionCss), 'production settings panel CSS fallback is full-width, not side-by-side');
assert(/\.recursion-status-foot \.recursion-mini-chip\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?padding:\s*2px 5px 3px;/.test(recursionCss), 'production progress footer Live chip uses the reference tiny-chip compactness');
assert(/\.recursion-hand-dropdown\s*\{[\s\S]*?display:\s*block;[\s\S]*?overflow:\s*hidden;[\s\S]*?padding:\s*0;/.test(recursionCss), 'production Last Brief dropdown removes the old padded grid shell');
assert(/\.recursion-hand-dropdown\.is-clearing \.recursion-brief-scroll/.test(recursionCss), 'production Last Brief dropdown fades old cards while clearing');
assert(/\.recursion-hand-dropdown::before/.test(recursionCss), 'production Last Brief dropdown keeps the reference top accent line');
assert(/\.recursion-brief-head\s*\{[\s\S]*?min-height:\s*34px;[\s\S]*?padding:\s*7px 9px;/.test(recursionCss), 'production Last Brief header uses the reference 34px compactness');
assert(/\.recursion-brief-foot \.recursion-mini-chip\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?padding:\s*2px 5px 3px;/.test(recursionCss), 'production Last Brief footer Esc chip uses the reference tiny-chip compactness');
assert(/\.recursion-packet-meta\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?gap:\s*4px;/.test(recursionCss), 'production Prompt Packet header renders compact meta chips');
assert(/function promptPacketText\(packet, hand = \{\}\)/.test(recursionUi), 'production Last Brief prompt packet view can render injected prompt text directly');
assert(/## Turn Animation Preview Script/.test(barImplementationReference), 'implementation reference includes a turn animation preview script');
assert(/const TURN_ANIMATION_STEPS = \[/.test(barImplementationReference), 'turn animation preview declares deterministic step data');
assert(/cached:\s*'cached'/.test(barImplementationReference), 'turn animation preview supports cached progress state');
assert(/const MAX_COLUMNS = 12;/.test(barImplementationReference), 'turn animation preview caps the Hero Pixel Array at twelve columns');
assert(/const MAX_BLOCKS = ROWS_PER_COLUMN \* MAX_COLUMNS;/.test(barImplementationReference), 'turn animation preview derives the block cap from rows and columns');
assert(/function visibleHeroSteps/.test(barImplementationReference), 'turn animation preview has a capped Hero Pixel Array projection');
assert(/overflow-progress/.test(barImplementationReference), 'turn animation preview uses an overflow aggregate block');
assert(/function renderHeroBlocks/.test(barImplementationReference), 'turn animation preview renders hero blocks from step state');
assert(/function renderProgressRows/.test(barImplementationReference), 'turn animation preview renders progress rows from step state');
assert(/class="step-children"/.test(barImplementationReference), 'implementation reference includes nested progress child row markup');
assert(/\.step-row\.child-row/.test(barImplementationReference), 'implementation reference includes nested child row styling');
assert(/function aggregateChildState/.test(barImplementationReference), 'turn animation preview aggregates child progress states');
assert(/function syncChildGroup/.test(barImplementationReference), 'turn animation preview renders child progress groups in place');
assert(/child-add/.test(barImplementationReference), 'turn animation preview animates child progress row insertion');
assert(/function preserveScrollPosition/.test(barImplementationReference), 'turn animation preview preserves scroll offsets across progress refreshes');
assert(/function placeAfter/.test(barImplementationReference), 'turn animation preview reorders rows without unconditional append moves');
assert(/preserveScrollPosition\(group,/.test(barImplementationReference), 'turn animation preview preserves sub-tier scroll position during child updates');
assert(/preserveScrollPosition\(list,/.test(barImplementationReference), 'turn animation preview preserves whole-list scroll position during row updates');
assert(!/classList\.add\('is-resetting'\);[\s\S]*?#current-step'\)\.textContent = 'Ready';[\s\S]*?await wait\(260\);/.test(barImplementationReference), 'turn animation preview does not show Ready while old progress rows are still wiping');
assert(/children:\s*\[/.test(uiSpec), 'UI spec documents progress child rows in the normalized view model');
assert(/Parent row aggregation:/.test(uiSpec), 'UI spec documents nested parent aggregation rules');
assert(/cardProgress/.test(uiSpec), 'UI spec documents sanitized card progress activity events');
assert(/\.recursion-status-popover\s*\{[\s\S]*?left:\s*-3px;/.test(uiSpec), 'UI spec anchors the status popover to the visible bar edge');
assert(/header and footer stay visible/.test(uiSpec), 'UI spec documents mobile progress header and footer visibility');
assert(/\.recursion-status-list` flex-shrinks/.test(uiSpec), 'UI spec documents the mobile progress list flex-shrink contract');
assert(/progressChildVisibleLimit:\s*5/.test(uiSpec), 'UI spec documents the sub-tier visible row default');
assert(/progressListVisibleLimit:\s*15/.test(uiSpec), 'UI spec documents the whole progress list visible row default');
assert(/Play, Provider, and Advanced setting controls auto-save on committed changes/.test(uiSpec), 'UI spec documents broad settings autosave instead of a Save Settings button');
assert(/bottom fade/.test(uiSpec), 'UI spec documents the sub-tier overflow fade affordance');
assert(/\.settings-row input\[type="checkbox"\]\s*\{[\s\S]*?appearance:\s*none;[\s\S]*?background:\s*rgba\(255, 255, 255, \.035\);/.test(barImplementationReference), 'reference settings checkbox uses the compact dark mockup skin');
assert(/Checkboxes inside Recursion settings must use the compact dark Recursion control skin/.test(uiSpec), 'UI spec documents host checkbox override requirement');
assert(/Provider Source changes the field context inside each lane immediately/.test(uiSpec), 'UI spec documents source-specific provider field contexts');
assert(/Provider lane fields auto-save on committed changes/.test(uiSpec), 'UI spec documents provider autosave instead of a Save Provider button');
assert(/Clear Session Key appears only for OpenAI-compatible endpoints/.test(uiSpec), 'UI spec documents source-scoped provider key clearing');
assert(!/array\.innerHTML\s*=\s*steps\.map/.test(barImplementationReference), 'turn animation preview does not recreate all hero blocks on every tick');
assert(!/list\.innerHTML\s*=\s*rows\.map/.test(barImplementationReference), 'turn animation preview does not recreate all progress rows on every tick');
assert(!/list\.appendChild\(parentRow\);/.test(barImplementationReference), 'turn animation preview does not unconditionally move parent rows on every refresh');
assert(!/const before = list\.children\[index\];[\s\S]*?list\.insertBefore\(row, before \|\| null\);/.test(barImplementationReference), 'turn animation preview does not index parent rows against child group siblings');
assert(/dataset\.stepId/.test(barImplementationReference), 'turn animation preview keys hero blocks and progress rows by stable step id');
assert(/function syncHeroBlock/.test(barImplementationReference), 'turn animation preview updates hero blocks in place');
assert(/function syncProgressRow/.test(barImplementationReference), 'turn animation preview updates progress rows in place');
assert(!/id="power-toggle"[\s\S]*?<\/button>\s*<span class="sep" aria-hidden="true"><\/span>\s*<section class="status-popover"/.test(barImplementationReference), 'implementation reference has no separator between Power and Mode');
assert(!/cards-button-label/.test(barImplementationReference), 'implementation reference Cards button is icon-only');
assert(/<button class="icon-button cards-button"[\s\S]*?<span class="sep" aria-hidden="true"><\/span>\s*<button class="activity-trigger status-array-button"/.test(barImplementationReference), 'implementation reference places icon-only Cards before the Hero Pixel Array trigger');
assert(/\.recursion-power-toggle\s*\{[\s\S]*?flex:\s*0 0 24px;[\s\S]*?height:\s*24px;[\s\S]*?width:\s*24px;/.test(recursionCss), 'production power toggle uses the same compact geometry as the reference');
assert(/\.recursion-cards-button\s*\{[\s\S]*?flex:\s*0 0 24px;[\s\S]*?width:\s*24px;/.test(recursionCss), 'production Cards scope button stays icon-only in the compact bar');
assert(!/recursion-cards-button-label/.test(recursionUi), 'production Cards scope button has no visible label node');
assert(/recursionCardDeckActivateAll:\s*''/.test(recursionUi), 'production Cards dropdown renders an activate-all deck action');
assert(/recursionCardDeckDeactivateAll:\s*''/.test(recursionUi), 'production Cards dropdown renders a deactivate-all deck action');
assert(!/recursionCardScopeFamilyToggle/.test(recursionUi), 'production Cards dropdown removes legacy Card Scope family controls');
assert(!/recursionCardScopeSubItemToggle/.test(recursionUi), 'production Cards dropdown removes legacy Card Scope sub-item controls');
assert(/function activateAllRunnableDeckCards/.test(recursionUi), 'production Cards activate-all action returns runnable cards to normal Active');
assert(/function deactivateAllRunnableDeckCards/.test(recursionUi), 'production Cards deactivate-all action turns runnable cards inactive');
assert(/function isDeckDeleteConfirmationValid\(value\)[\s\S]*?toLowerCase\(\) === 'delete'/.test(recursionUi), 'production Card Deck delete confirmation accepts the word delete case-insensitively');
assert(/recursionCardDeckDeleteText/.test(recursionUi) && /recursionCardDeckDeleteConfirm/.test(recursionUi) && /recursionCardDeckDeleteCancel/.test(recursionUi), 'production Card Deck delete uses typed inline confirmation controls');
assert(/recursion-card-deck-delete-hint[\s\S]*?type delete/.test(recursionUi), 'production Card Deck delete confirmation shows visible inline type-delete instruction text');
assert(/deckDeleteConfirm:\s*deckDeleteState \? \{\s*deckId:\s*deckDeleteState\.deckId\s*\} : null/.test(recursionUi), 'production Card Deck delete typing does not enter the Cards panel render key and steal input focus');
assert(/deckDeleteConfirmState = \{ deckId:[\s\S]*?value: '' \}/.test(recursionUi), 'production Card Deck delete trash arms typed confirmation instead of deleting immediately');
assert(!/applyCardDeckSettings\(deleteCustomCardDeck\(currentView\(\)\.settings, deckDelete\.dataset\.recursionCardDeckDelete\), 'Card Deck deleted\.'\);/.test(recursionUi), 'production Card Deck delete trash does not immediately delete the deck');
assert(/\.recursion-card-deck-delete-confirm\s*\{[\s\S]*?display:\s*flex;/.test(recursionCss), 'production Card Deck delete confirmation has compact inline styling');
assert(/recursionCardCategoryNew/.test(recursionUi), 'production Card System exposes add-category control');
assert(/recursionCardCategoryMoveUp/.test(recursionUi) && /recursionCardCategoryMoveDown/.test(recursionUi), 'production Card System exposes category reorder controls');
assert(/recursionCardDuplicate/.test(recursionUi) && /recursionCardDeleteArm/.test(recursionUi), 'production Card System exposes card duplicate/delete-arm controls');
assert(/recursionCardMove/.test(recursionUi) && /moveCard\(/.test(recursionUi), 'production Card System exposes card move control');
assert(/recursionCardMoveTarget/.test(recursionUi) && /recursionCardMoveCancel/.test(recursionUi), 'production Card System exposes explicit move-mode target and cancel controls');
assert(/const movingCard = moveState\?\.cardId \? asObject\(activeDeck\.cards\)\[moveState\.cardId\] : null;/.test(recursionUi), 'production Card System resolves the currently moving card before rendering move targets');
assert(/visible:\s*moveState\?\.deckId === activeDeck\.id && Boolean\(moveState\.cardId\) && movingCard\?\.categoryId !== category\.id/.test(recursionUi), 'production Card System hides move target for the card current category');
assert(/let expandedCardCategoryKeys = new Set\(\)/.test(recursionUi), 'production Card System tracks category expansion as local UI state');
assert(/function cardCategoryExpansionKey\(deckId, categoryId\)/.test(recursionUi), 'production Card System keys category expansion by deck and category');
assert(/recursionCardCategoryToggle/.test(recursionUi) && /aria-expanded/.test(recursionUi), 'production Card System category headers are full-row disclosure toggles');
assert(/recursion-card-deck-category-arrow/.test(recursionUi) && /categoryExpanded \? 'chevron-up' : 'chevron-down'/.test(recursionUi), 'production Card System renders down/up category disclosure arrows');
assert(/if \(categoryExpanded\) \{[\s\S]*?for \(const card of categoryCards\)/.test(recursionUi), 'production Card System hides category cards while collapsed');
assert(/recursionCardCategoryAction/.test(recursionUi), 'production Card System marks category action buttons so they do not toggle disclosure');
assert(/Object\.hasOwn\(target\.dataset,\s*'recursionCardDeckSelect'\)/.test(recursionUi), 'production Card System deck selector handles empty-string data marker values');
assert(/value === undefined \|\| value === null \|\| value === false/.test(recursionUi), 'production element helper omits undefined attrs so select options do not all become selected');
assert(/function cardSystemIconButton/.test(recursionUi), 'production Card System uses a dedicated icon-only button helper');
assert(!/className: 'recursion-mini-button'[^)\n]*text:/.test(recursionUi), 'production Card System mini buttons do not render visible command text');
assert(/title:\s*label/.test(recursionUi) && /'aria-label':\s*label/.test(recursionUi), 'production Card System icon buttons expose hover text and accessible labels');
assert(/\.recursion-mini-button\s*\{[\s\S]*?appearance:\s*none;[\s\S]*?background:\s*color-mix\(in srgb, var\(--SmartThemeBodyColor/.test(recursionCss), 'production Card System mini buttons use graphite Recursion skin instead of native white buttons');
assert(/recursionCardDeckDuplicate:[\s\S]*recursionCardDeckEdit:[\s\S]*recursionCardDeckDelete:/.test(recursionUi), 'production Card Deck edit action sits with duplicate and delete deck controls');
assert(/recursion-card-deck-tools'[\s\S]*?recursionCardNew:[\s\S]*?recursionCardCategoryNew:[\s\S]*?recursion-card-move-cancel-slot/.test(recursionUi), 'production card/category tools row contains add-card, add-category, and move-cancel controls');
assert(/CARD_LONG_PRESS_MS/.test(recursionUi), 'production Card System defines explicit long-press threshold');
assert(/pointermove/.test(recursionUi) && /CARD_LONG_PRESS_MOVE_PX/.test(recursionUi), 'production Card System cancels long-press when mobile scroll movement starts');
assert(/recursionCardToggleRow/.test(recursionUi), 'production Card row tap toggles active state instead of opening edit');
assert(/nextCardSelectionState\(card,\s*normalizeMode\(view\.settings\?\.mode\)\)/.test(recursionUi), 'production Card row tap uses mode-specific three-state selection cycle');
assert(!/dataset:\s*\{\s*recursionCardEdit:\s*card\.id\s*\}/.test(recursionUi), 'production Card row main button no longer opens edit on tap');
assert(/function cardDeckCardStatePresentation\(card,\s*mode = 'auto'\)/.test(recursionUi), 'production Card System centralizes card state presentation');
assert(/state === 'priority'[\s\S]*?icon:\s*'eye-priority'/.test(recursionUi), 'production Card System shows priority cards with eye-plus status icons');
assert(/state === 'off'[\s\S]*?icon:\s*'eye-inactive'/.test(recursionUi), 'production Card System shows inactive cards with slashed-eye status icons');
assert(/state:\s*'active'[\s\S]*?icon:\s*'eye-active'/.test(recursionUi), 'production Card System shows active cards with open-eye status icons');
assert(!/state === 'priority'[\s\S]*?icon:\s*'arrow-up'/.test(recursionUi), 'production Card System no longer uses up-arrow as the Priority state icon');
assert(!/state === 'off'[\s\S]*?icon:\s*'x'/.test(recursionUi), 'production Card System no longer uses X as the inactive state icon');
assert(/cardSystemIconButton\('pencil',\s*'Edit category'[\s\S]*recursionCardCategoryEdit:\s*category\.id/.test(recursionUi), 'production Card System renders visible category edit icons');
assert(/cardSystemIconButton\('pencil',\s*'Edit card'[\s\S]*recursionCardEdit:\s*card\.id/.test(recursionUi), 'production Card System renders visible card edit icons');
assert(/const cardEdit = control\('recursionCardEdit'\)[\s\S]*editCard\(/.test(recursionUi), 'production Card System wires visible card edit icons to the inline card editor');
assert(/function renderCardEditorInline/.test(recursionUi), 'production Card System renders card editor inline at the card row');
assert(/function renderCategoryEditorInline/.test(recursionUi), 'production Card System renders category editor inline under the category header');
assert(/recursion-card-editor-preview-instruction[\s\S]*?Checked fields replace the current card/.test(recursionUi), 'production Card wand preview explains that checked fields will replace current card content');
assert(/className:\s*'recursion-card-preview-checkbox'[\s\S]*recursionCardPreviewName/.test(recursionUi), 'production Card wand preview uses Recursion-styled checkboxes for name suggestions');
assert(/className:\s*'recursion-card-preview-checkbox'[\s\S]*recursionCardPreviewDescription/.test(recursionUi), 'production Card wand preview uses Recursion-styled checkboxes for description suggestions');
assert(/className:\s*'recursion-card-preview-checkbox'[\s\S]*recursionCardPreviewPrompt/.test(recursionUi), 'production Card wand preview uses Recursion-styled checkboxes for prompt suggestions');
assert(/recursion-card-editor-preview-actions[\s\S]*recursionCardPreviewAccept[\s\S]*recursionCardPreviewClose/.test(recursionUi), 'production Card wand preview groups accept and close controls side by side');
assert(/\.recursion-card-preview-checkbox\[type="checkbox"\]\s*\{[\s\S]*?appearance:\s*none;[\s\S]*?background:\s*color-mix\(in srgb, var\(--SmartThemeBodyColor/.test(recursionCss), 'production Card wand preview checkboxes use Recursion graphite styling');
assert(/\.recursion-card-editor-preview-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*end;/.test(recursionCss), 'production Card wand preview actions render side by side');
assert(/recursionCategoryEditorSave/.test(recursionUi), 'production Category editor has icon-only save action');
assert(/recursion-category-editor-inline/.test(recursionCss), 'production Category inline editor has compact graphite styling');
assert(/recursion-card-deck-category-actions/.test(recursionCss), 'production Category actions are grouped to prevent mobile arrow wrapping');
assert(/recursion-card-deck-category-copy/.test(recursionCss), 'production Category copy and actions use separate layout areas');
assert(/--recursion-card-action-rail-width:\s*108px;/.test(recursionCss), 'production Card System defines a shared action rail width for card and category rows');
assert(/\.recursion-card-deck-category-head\s*\{[\s\S]*?cursor:\s*pointer;[\s\S]*?grid-template-columns:\s*24px minmax\(0,\s*1fr\) var\(--recursion-card-action-rail-width\);/.test(recursionCss), 'production Category headers expose a full-row disclosure target with a left arrow column');
assert(/\.recursion-card-deck-category-arrow\s*\{[\s\S]*?height:\s*22px;[\s\S]*?width:\s*22px;/.test(recursionCss), 'production Category disclosure arrows are larger than mini row actions');
assert(/\.recursion-card-deck-card\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) var\(--recursion-card-action-rail-width\);/.test(recursionCss), 'production Card rows align actions to the same rail as category rows');
assert(/viewBox:\s*'0 0 24 24'[\s\S]*recursionEditIcon:\s*''[\s\S]*M21\.2799 6\.40005L11\.7399 15\.94/.test(recursionUi), 'production Card System uses the supplied stroked SVG Repo edit icon for edit actions');
assert(/svg\[data-recursion-edit-icon\],[\s\S]*?svg\[data-recursion-wand-icon\]\s*\{[\s\S]*?height:\s*13px;[\s\S]*?opacity:\s*\.82;[\s\S]*?width:\s*13px;/.test(recursionCss), 'production Card System normalizes supplied edit and wand SVG size and color weight');
assert(/viewBox:\s*'0 0 24 24'[\s\S]*recursionWandIcon:\s*''[\s\S]*M4\.9996 7V11M9\.9996 2V6/.test(recursionUi), 'production Card System uses the supplied SVG Repo wand icon for card suggestions');
assert(/recursion-card-action-slot/.test(recursionCss), 'production Card System reserves fixed action slots for transient move/delete states');
assert(/recursion-card-delete-slot/.test(recursionCss) && /recursion-card-move-target-slot/.test(recursionCss), 'production Card System has stable delete and move target action slots');
assert(/actionSlot\(`recursion-card-delete-slot \$\{pending \? 'is-delete-pending' : ''\}`/.test(recursionUi), 'production Card System marks delete slots as pending only during delete confirmation');
assert(/\.recursion-card-delete-slot\s*\{[\s\S]*?flex-basis:\s*24px;[\s\S]*?width:\s*24px;/.test(recursionCss), 'production Card System delete slot is compact when it only shows the trash action');
assert(/\.recursion-card-delete-slot\.is-delete-pending\s*\{[\s\S]*?flex-basis:\s*52px;[\s\S]*?width:\s*52px;/.test(recursionCss), 'production Card System delete slot expands only for confirm/cancel actions');
assert(!/dataset:\s*\{\s*recursionCardMoveMode:\s*''\s*\}/.test(recursionUi), 'production Card move mode does not insert a notice row above the deck list');
assert(!/cardScopeNotice = 'Confirm card delete\.'/.test(recursionUi), 'production Card delete arm does not reveal a notice row that shifts the panel');
assert(!/cardScopeNotice = 'Move mode active\. Choose a target category\.'/.test(recursionUi), 'production Card move arm does not reveal a notice row that shifts the panel');
assert(/let cardsPanelRenderKey = ''/.test(recursionUi), 'production Cards panel tracks render keys so heartbeat refreshes do not close the deck selector');
assert(/function cardsPanelViewKey/.test(recursionUi), 'production Cards panel computes a focused render key for card/deck state');
assert(/if \(cardsPanelRenderKey === nextRenderKey\) return/.test(recursionUi), 'production Cards panel skips unchanged heartbeat renders while the deck selector is open');
assert(/recursionCardDeleteConfirm/.test(recursionUi) && /recursionCardDeleteCancel/.test(recursionUi), 'production Card delete uses explicit confirm and cancel icon actions');
assert(/recursionCardCategoryDeleteArm/.test(recursionUi) && /recursionCardCategoryDeleteConfirm/.test(recursionUi), 'production Category delete uses explicit confirm action');
assert(/is-delete-pending/.test(recursionCss), 'production Card System styles pending delete state');
assert(/cardsPanel\.addEventListener\?\.\('pointerdown'/.test(recursionUi), 'production Card System listens for press-hold pointer starts');
assert(/function cardHaptic/.test(recursionUi), 'production Card System centralizes mobile haptic feedback');
assert(/navigator\?\.vibrate/.test(recursionUi), 'production Card System can trigger mobile vibration feedback');
assert(/prefers-reduced-motion:\s*reduce/.test(recursionUi) || /prefers-reduced-motion:\s*reduce/.test(recursionCss), 'production Card System respects reduced-motion for haptics or motion styling');
assert(!/recursionCardToggle:\s*card\.id/.test(recursionUi), 'production Card System does not render a separate eye visibility toggle');
assert(/is-active/.test(recursionCss) && /is-inactive/.test(recursionCss) && /is-priority/.test(recursionCss), 'production Card System visually distinguishes active, inactive, and priority cards');
assert(/\.recursion-card-deck-card\.is-active \.recursion-card-deck-card-status\s*\{[\s\S]*?color:\s*color-mix\(in srgb, var\(--recursion-accent\) 68%, transparent\);/.test(recursionCss), 'production Card System active eye uses the same toned cyan as the active card rail');
assert(/svg\[data-recursion-card-state-icon="eye-priority"\]\s*\{[\s\S]*?transform:\s*translateY\(1px\);/.test(recursionCss), 'production Card System nudges the priority eye down to align with active and inactive eyes');
assert(!/className:\s*'recursion-card-scope-notice'/.test(recursionUi), 'production Cards dropdown does not render transient local notice rows');
assert(/showCardSystemStatus/.test(recursionUi), 'production Card System routes action feedback through the main bar status area');
assert(/cardEditorState \|\| categoryEditorState \|\| cardMoveState \|\| cardDeleteConfirmState/.test(recursionUi), 'production Escape handling clears Card System editor, move, or pending delete state before closing the panel');
assert(/\.recursion-cards-all-button\s*\{[\s\S]*?font-size:\s*10px;[\s\S]*?min-height:\s*20px;/.test(recursionCss), 'production Cards All action uses compact SillyTavern-native button sizing');
assert(/\.recursion-activity-trigger\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?padding:\s*0;/.test(recursionCss), 'production activity trigger keeps reference spacing around pixel blocks');
assert(/\.recursion-hero-pixel-array\s*\{[\s\S]*?width:\s*max\(0px,/.test(recursionCss), 'production Hero Pixel Array uses column-based width animation');
assert(/\.recursion-options-button:hover,[\s\S]*?\.recursion-options-button\[aria-expanded="true"\]\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?outline:\s*none\s*!important;/.test(recursionCss), 'production options button stays icon-only while focused or open');
assert(/select\.recursion-input\.recursion-select\s*\{[\s\S]*?background-image:[\s\S]*?linear-gradient\(45deg,[\s\S]*?padding-right:\s*24px\s*!important;/.test(recursionCss), 'production settings selects draw their own dropdown chevron under SillyTavern globals');
assert(/\.recursion-hand-dropdown\s*>\s*\.recursion-empty\s*\{[\s\S]*?margin:\s*0;[\s\S]*?padding:\s*8px 9px 7px;/.test(recursionCss), 'production empty Last Brief state keeps aligned native dropdown padding');
assert(/\.recursion-root\s+input\.recursion-checkbox\[type="checkbox"\]\s*\{[\s\S]*?appearance:\s*none !important;[\s\S]*?background:[\s\S]*?var\(--SmartThemeBlurTintColor/.test(recursionCss), 'production settings checkbox uses a Recursion-scoped selector strong enough to beat SillyTavern globals');
assert(/\.recursion-root\s+input\.recursion-checkbox\[type="checkbox"\]\[hidden\]\s*\{[\s\S]*?display:\s*none !important;/.test(recursionCss), 'hidden provider state checkboxes stay hidden despite Recursion checkbox skin');
assert(/\.recursion-root\s+input\.recursion-checkbox\[type="checkbox"\]:checked\s*\{[\s\S]*?background:[\s\S]*?var\(--recursion-accent\)/.test(recursionCss), 'production settings checkbox uses Recursion cyan when checked');
assert(!/input\.recursion-checkbox\[type="checkbox"\]:checked::before/.test(recursionCss), 'production settings checkbox does not draw a pseudo-element artifact inside checked boxes');
assert(/\.recursion-settings-disclosure-body\[hidden\]\s*\{[\s\S]*?display:\s*none\s*!important;/.test(recursionCss), 'settings disclosure bodies stay hidden despite author display rules');
assert(/\.recursion-provider-body\[hidden\]\s*\{[\s\S]*?display:\s*none\s*!important;/.test(recursionCss), 'provider disclosure bodies stay hidden despite author display rules');
assert(/\.recursion-provider-field\[hidden\]\s*\{[\s\S]*?display:\s*none\s*!important;/.test(recursionCss), 'provider source-specific fields stay hidden despite grid display rules');
assert(/\.recursion-provider-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/.test(recursionCss), 'production Providers pane uses the reference two-column provider grid');
assert(/\.recursion-provider-grid\s*\{[\s\S]*?align-items:\s*start;/.test(recursionCss), 'provider grid does not stretch short fields beside taller model tools');
assert(!/\.recursion-provider-context-fields\s*\{[\s\S]*?display:\s*contents;/.test(recursionCss), 'provider source-specific fields are grouped instead of flattened into auto-placement');
assert(/\.recursion-provider-context-fields\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;/.test(recursionCss), 'provider source-specific field groups span the provider grid');
assert(/\.recursion-provider-openai-fields\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\);/.test(recursionCss), 'OpenAI provider fields align as a stable two-column block');
assert(/\.recursion-provider-context-fields\[hidden\]\s*\{[\s\S]*?display:\s*none\s*!important;/.test(recursionCss), 'hidden provider source-specific field groups stay hidden despite grouped provider layout');
const providerProfileListCss = recursionCss.match(/\.recursion-provider-profile-list\s*\{[\s\S]*?\n\}/)?.[0] || '';
assert(providerProfileListCss, 'production Providers pane styles the connection profile combobox list');
assert(/max-height:\s*168px;[\s\S]*?overflow-y:\s*auto;/.test(providerProfileListCss), 'connection profile combobox uses a bounded scrollable option list');
assert(!/position:\s*absolute;/.test(providerProfileListCss), 'connection profile combobox list stays in provider layout flow so settings disclosures do not clip it');
assert(/width:\s*100%;/.test(providerProfileListCss), 'connection profile combobox list uses the field width when it opens in flow');
assert(/\.recursion-provider-status\.pass\s*\{[\s\S]*?var\(--recursion-success\)/.test(recursionCss), 'production provider success status uses the defined success token');
assert(/const progressTop = Math\.max\(viewportTop,\s*rect\.bottom \+ 3\);/.test(recursionUi), 'production progress popover uses the reference vertical gap with visual viewport top clamping');
assert(/const settingsTop = Math\.max\(viewportTop,\s*rect\.bottom \+ 5\);/.test(recursionUi), 'production settings and brief popovers use the reference desktop vertical gap with visual viewport top clamping');
assert(/globalThis\.visualViewport\?\.height/.test(recursionUi), 'production popover geometry clamps to the mobile visual viewport height');
assert(/element\.style\.maxHeight = `\$\{maxHeight\}px`;/.test(recursionUi), 'production popover geometry uses pixel max-height instead of layout viewport units');
assert(!/element\.style\.maxHeight = `calc\(100vh/.test(recursionUi), 'production popover geometry avoids mobile-clipping 100vh max-height');
assert(/visualViewport\?\.addEventListener\?\.\('resize', handleViewportChange\)/.test(recursionUi), 'production UI resyncs popover geometry on visual viewport resize');
assert(/visualViewport\?\.addEventListener\?\.\('scroll', handleViewportChange\)/.test(recursionUi), 'production UI resyncs popover geometry when mobile browser chrome shifts the visual viewport');
assert(/setFixedPanelGeometry\(settingsPanel,[\s\S]*?zIndex:\s*10022/.test(recursionUi), 'production settings panel stays above progress when compact layouts overlap');
assert(/setFixedPanelGeometry\(settingsPanel,\s*\{\s*left:\s*rootLeft,\s*top:\s*settingsTop,\s*width:\s*rootWidth,\s*zIndex:\s*10022\s*\}\)/.test(recursionUi), 'production settings panel spans the full Recursion Bar width');
assert(/const mobilePanel = viewportWidth <= 720 \|\| rootWidth <= 720;/.test(recursionUi), 'production panel geometry detects the mobile panel breakpoint from visual viewport and bar width');
assert(/const progressWidth = mobilePanel \? rootWidth : Math\.min\(352,\s*rootWidth\);/.test(recursionUi), 'production progress popover becomes full-width on mobile while keeping the desktop cap');
assert(/data-recursion-mobile-status-drawer/.test(recursionUi), 'production root renders a mobile status drawer');
assert(/syncMobileStatusDrawer/.test(recursionUi), 'production UI has one drawer sync path tied to current-step rendering');
assert(!/is-beside-progress/.test(recursionUi), 'production UI no longer toggles obsolete side-by-side settings class');
assert(/function eventWithin\(event, elements\)/.test(recursionUi), 'outside-click handling keeps original event path for rerendered popover controls');
assert(/!eventWithin\(event, \[/.test(recursionUi), 'document click handling uses event path containment before closing popovers');
assert(/recursionSettingsTab[\s\S]*?event\?\.stopPropagation\?\.\(\)/.test(recursionUi), 'settings tab clicks do not bubble into outside-click closers after rerender');
assert(!/recursionSettingsSave/.test(recursionUi), 'settings panel has no broad Save Settings action because settings controls auto-save');
assert(!/recursionSettingsClose/.test(recursionUi), 'settings panel has no redundant header close button');
assert(!/settings-close/.test(barImplementationReference), 'implementation reference settings panel has no redundant close button');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(recursionCss), 'production CSS honors reduced-motion preferences');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.recursion-root \*[\s\S]*?animation:\s*none\s*!important;[\s\S]*?transition:\s*none\s*!important;/.test(recursionCss), 'reduced-motion rule disables Recursion animations and transitions');
assert(/\.recursion-mobile-status-drawer\s*\{[\s\S]*?display:\s*none;/.test(recursionCss), 'mobile status drawer is hidden by default on desktop');
assert(/\.recursion-mobile-status-drawer\s*\{[\s\S]*?min-height:\s*14px;/.test(recursionCss), 'mobile status drawer uses a reduced low-profile height');
assert(/\.recursion-mobile-status-drawer\s*\{[\s\S]*?padding:\s*1px 9px 1px 2px;/.test(recursionCss), 'mobile status drawer aligns text with the compact bar left edge');
assert(/\.recursion-mobile-status-drawer\s*\{[\s\S]*?align-items:\s*center;/.test(recursionCss), 'mobile status drawer vertically centers its text');
assert(/\.recursion-mobile-status-drawer\[hidden\]\s*\{[\s\S]*?display:\s*none\s*!important;/.test(recursionCss), 'mobile status drawer hidden state wins over mobile display rules');
assert(/@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.recursion-bar\s*\{[\s\S]*?flex-wrap:\s*nowrap;/.test(recursionCss), 'mobile Recursion bar stays on one row');
assert(/@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.recursion-current-step\s*\{[\s\S]*?display:\s*none;/.test(recursionCss), 'mobile bar hides inline current-step text');
assert(/\.recursion-story-form-button\s*\{[\s\S]*?min-width:\s*fit-content;/.test(recursionCss), 'desktop story form button expands to fit long selected labels');
assert(!/\.recursion-story-form-button\s*\{[\s\S]*?max-width:\s*88px;/.test(recursionCss), 'desktop story form button does not cap long labels');
assert(/\.recursion-story-form-text\s*\{[\s\S]*?max-width:\s*none;/.test(recursionCss), 'desktop story form text is not ellipsized');
assert(/@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.recursion-story-form-button\s*\{[\s\S]*?min-width:\s*36px;/.test(recursionCss), 'mobile story form button uses a compact fixed shorthand width');
assert(/@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.recursion-mobile-status-drawer:not\(\[hidden\]\)\s*\{[\s\S]*?display:\s*flex;/.test(recursionCss), 'mobile status drawer displays below the bar when status text is active');
assert(/@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.recursion-card-deck-category-head\s*\{[\s\S]*?grid-template-columns:\s*24px minmax\(0,\s*1fr\)\s+auto;/.test(recursionCss), 'mobile Cards panel keeps category disclosure arrows and action clusters attached to category headers');
assert(/@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.recursion-brief-card\s*\{[\s\S]*?grid-template-columns:\s*1fr;/.test(recursionCss), 'mobile Last Brief cards use one-column rows');
assert(/@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.recursion-provider-openai-fields\s*\{[\s\S]*?grid-template-columns:\s*1fr;/.test(recursionCss), 'mobile provider endpoint fields collapse to one column');
assert(/mobile status drawer/.test(uiSpec), 'UI spec documents the mobile status drawer');
assert(/Progress should be full-width on mobile/.test(uiSpec), 'UI spec documents mobile full-width progress popover');
assert(/\.recursion-viewer-card-list\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*8px;/.test(recursionCss), 'full viewer deck renders structured cards in a compact grid');
assert(/\.recursion-viewer-card\s*\{[\s\S]*?border:\s*1px solid[\s\S]*?border-radius:\s*6px;/.test(recursionCss), 'full viewer card details use bounded native panel styling');
assert(/\.recursion-viewer-inspector-note\s*\{[\s\S]*?border-left:\s*2px solid/.test(recursionCss), 'full viewer inspector-only notes are visually labeled');
assert(/function renderHeroPixelArray\(container, blocks = \[\]\) \{[\s\S]*?querySelectorAll\('\[data-recursion-hero-block\]'\)[\s\S]*?insertBefore\(node, before\);/.test(recursionUi), 'production renderer updates Hero Pixel Array blocks in place');
assert(/window\.playRecursionTurnAnimation/.test(barImplementationReference), 'turn animation preview exposes a replay hook');
assert(/\.step-row\.done \.step-icon\s*\{[\s\S]*?background:\s*var\(--green\);[\s\S]*?border-color:\s*var\(--green\);/.test(barImplementationReference), 'progress menu done dots use the same success green token');
assert(/\.step-row\.running \.step-icon\s*\{[\s\S]*?var\(--cyan\) 0 82deg/.test(barImplementationReference), 'progress menu running spinners use the same active blue token');
assert(/\.step-row\.cached \.step-icon\s*\{[\s\S]*?background:\s*var\(--purple\);[\s\S]*?border-color:\s*var\(--purple\);/.test(barImplementationReference), 'progress menu cached dots use the cache purple token');
assert(/\.step-row\.warn \.step-icon\s*\{[\s\S]*?background:\s*var\(--amber\);[\s\S]*?border-color:\s*var\(--amber\);/.test(barImplementationReference), 'progress menu warning dots use the same caution yellow token');
assert(/\.step-row\.fail \.step-icon\s*\{[\s\S]*?background:\s*var\(--red\);[\s\S]*?border-color:\s*var\(--red\);/.test(barImplementationReference), 'progress menu failed dots use the same failure red token');

assertEqual(activityLabel({ phase: 'promptInstalling' }), 'Installing Recursion prompt...', 'prompt phase label mapped');
assertEqual(activityLabel({ phase: 'idle' }), '', 'idle phase has no working label');
assertEqual(activityLabel({ label: 'Custom visible label.', phase: 'unknown' }), 'Custom visible label.', 'activity label overrides phase');
assertEqual(activityLabel({ phase: 'unknown' }), 'Recursion is working...', 'unknown phase label falls back');

const fallbackModel = createRecursionViewModel({});
assertEqual(fallbackModel.runtimeHealthLabel, 'Ready', 'missing view defaults to ready runtime health');
assertEqual(fallbackModel.modeLabel, 'Auto', 'missing view defaults to auto mode');
assertEqual(fallbackModel.handCount, 0, 'missing hand defaults to zero');
assertEqual(fallbackModel.composerLabel, 'Utility', 'missing composer defaults to Utility');
assertEqual(fallbackModel.reasonerState, 'Unavailable', 'missing reasoner provider is unavailable');

const activeModel = createRecursionViewModel({
  settings: { mode: 'auto', providers: { reasoner: { enabled: false, lastTest: { status: 'failed' } } } },
  lastHand: { cards: 'not-cards' },
  activity: {
    phase: 'reasonerComposing',
    severity: 'warning',
    chips: [' Reasoner ', '', null, 'Cards', 'Cards', 3],
    providerLane: 'reasoner'
  },
  lastPacket: { diagnostics: { composerLane: 'reasoner' } }
});
assertEqual(activeModel.runtimeHealthLabel, 'Working', 'non-settled status is working');
assertEqual(activeModel.modeLabel, 'Auto', 'mode label is separate from runtime health');
assertEqual(activeModel.activitySeverity, 'warning', 'activity severity is preserved');
assertDeepEqual(activeModel.activityChips, ['Reasoner', 'Cards', '3'], 'activity chips are normalized and deduped');
assertEqual(activeModel.composerLabel, 'Reasoner', 'reasoner composer label built');
assertEqual(activeModel.reasonerState, 'Disabled', 'disabled reasoner state built');

const settledWarningModel = createRecursionViewModel({
  settings: { mode: 'manual' },
  activity: { phase: 'settled', severity: 'warning', label: 'Observe fallback ready.' },
  progressRun: {
    title: 'Needs attention',
    steps: [
      { id: 'read-turn', label: 'Reading current turn', providerLane: 'utility', state: 'done' },
      { id: 'card-batch', label: 'Utility card batch', providerLane: 'utility', state: 'warning' }
    ]
  }
});
assertEqual(settledWarningModel.runtimeHealthLabel, 'Needs attention', 'settled warning progress is not announced as ready');

const reasonerAvailable = createRecursionViewModel({
  settings: { mode: 'auto', providers: { reasoner: { enabled: true, lastTest: { status: 'ok' } } } },
  activity: { phase: 'idle' }
});
assertEqual(reasonerAvailable.reasonerState, 'Available', 'available reasoner state built');

const mixedLaneProgressModel = createRecursionViewModel({
  settings: { mode: 'auto', providers: { reasoner: { enabled: true, lastTest: { status: 'ok' } } } },
  activity: { phase: 'cardBatchRunning' },
  lastPacket: { diagnostics: { composerLane: 'utility' } },
  progressRun: {
    title: 'Generating',
    steps: [
      { id: 'card-batch', label: 'Utility card batch', providerLane: 'utility', state: 'running' },
      { id: 'reasoner-guidance', label: 'Reasoner guidance', providerLane: 'reasoner', state: 'running' }
    ]
  }
});
assertEqual(mixedLaneProgressModel.progressFooterLabel, 'Auto - Utility and Reasoner lanes', 'progress footer summarizes all visible active provider lanes');

const reasonerPassAvailable = createRecursionViewModel({
  settings: { mode: 'auto', providers: { reasoner: { enabled: true, lastTest: { status: 'pass' } } } },
  activity: { phase: 'idle' }
});
assertEqual(reasonerPassAvailable.reasonerState, 'Available', 'pass reasoner test status is available');

const reasonerFailIssue = createRecursionViewModel({
  settings: { mode: 'auto', providers: { reasoner: { enabled: true, lastTest: { status: 'fail' } } } },
  activity: { phase: 'idle' }
});
assertEqual(reasonerFailIssue.reasonerState, 'Issue', 'fail reasoner test status is an issue');

const sensitiveView = {
  settings: {
    mode: 'auto',
    providers: {
      utility: {
        lastTest: { compactError: 'Bearer ui-token and sk-ui-secret' },
        privateKey: 'plain-private-key',
        sessionKey: 'plain-session-key',
        authHeader: 'plain-auth-header',
        credentials: 'plain-credentials',
        sessionApiKey: 'plain-session-api-key'
      }
    }
  },
  lastHand: {
    cards: [{ id: 'card-secret', family: 'Scene Frame', promptText: 'Prompt card with private-secret' }]
  },
  activity: {
    phase: 'promptInstalling',
    stack: 'STACK_TRACE_SENTINEL',
    trace: 'TRACE_SENTINEL',
    detail: { message: 'Bearer activity-token' }
  },
  lastPacket: {
    sections: { guidance: 'Raw prompt text with sk-ui-packet and private-secret' },
    diagnostics: { composerLane: 'utility', promptPacketHash: 'packet-hash' }
  },
  circular: null,
  big: 2n
};
sensitiveView.circular = sensitiveView;

const noDocumentMount = mountRecursionUi({ runtime: { view: () => ({}) } });
assertEqual(typeof noDocumentMount.update, 'function', 'no-document mount returns update function');
assertEqual(typeof noDocumentMount.destroy, 'function', 'no-document mount returns destroy function');
noDocumentMount.update();
noDocumentMount.destroy();

function createFakeDocument() {
  const documentListeners = {};

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.eventListeners = {};
      this.hidden = false;
      this.parentNode = null;
      this.id = '';
      this.className = '';
      this.textContent = '';
      this.type = '';
      this.role = '';
      this.ariaLabel = '';
      this.open = false;
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.tabIndex = 0;
      this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      this.classList = {
        toggle: (className, force) => {
          const classes = new Set(String(this.className || '').split(/\s+/).filter(Boolean));
          const shouldHave = force === undefined ? !classes.has(className) : Boolean(force);
          if (shouldHave) classes.add(className);
          else classes.delete(className);
          this.className = [...classes].join(' ');
          this.attributes.class = this.className;
          return shouldHave;
        }
      };
      this.style = {
        props: {},
        setProperty(name, value) {
          this.props[name] = String(value);
        }
      };
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    insertBefore(child, before = null) {
      child.parentNode = this;
      const index = before ? this.children.indexOf(before) : -1;
      if (index >= 0) this.children.splice(index, 0, child);
      else this.children.push(child);
      return child;
    }

    remove() {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    }

    replaceChildren(...children) {
      for (const child of this.children) {
        child.parentNode = null;
      }
      this.children = [];
      for (const child of children) this.appendChild(child);
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'id') this.id = String(value);
      if (name === 'class') this.className = String(value);
      if (name === 'role') this.role = String(value);
      if (name === 'aria-label') this.ariaLabel = String(value);
      if (name === 'value') this.value = String(value);
      if (name === 'type') this.type = String(value);
      if (name === 'tabindex') this.tabIndex = Number(value);
      if (name === 'disabled') this.disabled = true;
      if (name === 'checked') this.checked = true;
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        this.dataset[key] = String(value);
      }
    }

    getAttribute(name) {
      return this.attributes[name] ?? null;
    }

    addEventListener(type, listener) {
      if (!this.eventListeners[type]) this.eventListeners[type] = [];
      this.eventListeners[type].push(listener);
    }

    dispatchEvent(eventInit = {}) {
      const event = {
        ...eventInit,
        type: eventInit.type || '',
        target: eventInit.target || this,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.propagationStopped = true;
        },
        stopImmediatePropagation() {
          this.propagationStopped = true;
          this.immediatePropagationStopped = true;
        }
      };
      let node = this;
      while (node) {
        for (const listener of node.eventListeners[event.type] || []) listener(event);
        if (event.propagationStopped) break;
        node = node.parentNode;
      }
      if (!event.propagationStopped) {
        for (const listener of documentListeners[event.type] || []) listener(event);
      }
      return !event.defaultPrevented;
    }

    focus() {
      fakeDocument.activeElement = this;
    }

    click(eventInit = {}) {
      const event = {
        target: this,
        isTrusted: eventInit.isTrusted ?? true,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.propagationStopped = true;
        },
        stopImmediatePropagation() {
          this.propagationStopped = true;
          this.immediatePropagationStopped = true;
        }
      };
      let node = this;
      while (node) {
        for (const listener of node.eventListeners.click || []) listener(event);
        if (event.propagationStopped && !eventInit.ignoreStopPropagation) break;
        node = node.parentNode;
      }
      if (!event.propagationStopped || eventInit.ignoreStopPropagation) {
        for (const listener of documentListeners.click || []) listener(event);
      }
    }

    keydown(eventInit = {}) {
      const event = {
        target: this,
        key: eventInit.key || '',
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.propagationStopped = true;
        },
        stopImmediatePropagation() {
          this.propagationStopped = true;
          this.immediatePropagationStopped = true;
        }
      };
      let node = this;
      while (node) {
        for (const listener of node.eventListeners.keydown || []) listener(event);
        if (event.propagationStopped && !eventInit.ignoreStopPropagation) break;
        node = node.parentNode;
      }
      if (!event.propagationStopped || eventInit.ignoreStopPropagation) {
        for (const listener of documentListeners.keydown || []) listener(event);
      }
      return event;
    }

    showModal() {
      this.open = true;
    }

    close() {
      this.open = false;
    }

    setBoundingClientRect(rect = {}) {
      const left = Number(rect.left ?? rect.x ?? 0);
      const top = Number(rect.top ?? rect.y ?? 0);
      const width = Number(rect.width ?? rect.w ?? Math.max(0, Number(rect.right ?? left) - left));
      const height = Number(rect.height ?? rect.h ?? Math.max(0, Number(rect.bottom ?? top) - top));
      this.rect = {
        left,
        top,
        x: left,
        y: top,
        width,
        height,
        right: Number(rect.right ?? left + width),
        bottom: Number(rect.bottom ?? top + height)
      };
    }

    getBoundingClientRect() {
      return { ...this.rect };
    }

    querySelector(selector) {
      return findFirst(this, selector);
    }

    querySelectorAll(selector) {
      return findAll(this, selector);
    }
  }

  function matches(element, selector) {
    if (selector.startsWith('#')) return element.id === selector.slice(1);
    const dataMatch = selector.match(/^\[data-([a-z0-9-]+)\]$/i);
    if (dataMatch) {
      const key = dataMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return Object.prototype.hasOwnProperty.call(element.dataset, key);
    }
    return element.tagName.toLowerCase() === selector.toLowerCase();
  }

  function findFirst(element, selector) {
    for (const child of element.children) {
      if (matches(child, selector)) return child;
      const nested = findFirst(child, selector);
      if (nested) return nested;
    }
    return null;
  }

  function findAll(element, selector) {
    const matchesList = [];
    for (const child of element.children) {
      if (matches(child, selector)) matchesList.push(child);
      matchesList.push(...findAll(child, selector));
    }
    return matchesList;
  }

  function textTree(element) {
    return [
      element.textContent,
      ...element.children.map((child) => textTree(child))
    ].join(' ');
  }

  const body = new FakeElement('body');
  const fakeDocument = {
    body,
    activeElement: body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => findFirst(body, `#${id}`),
    addEventListener(type, listener) {
      if (!documentListeners[type]) documentListeners[type] = [];
      documentListeners[type].push(listener);
    },
    removeEventListener(type, listener) {
      if (!documentListeners[type]) return;
      documentListeners[type] = documentListeners[type].filter((entry) => entry !== listener);
    },
    textTree
  };
  return fakeDocument;
}

const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
const previousNavigator = globalThis.navigator;
const previousSetTimeout = globalThis.setTimeout;
const previousClearTimeout = globalThis.clearTimeout;
const previousSetInterval = globalThis.setInterval;
const previousClearInterval = globalThis.clearInterval;
const previousInnerWidth = globalThis.innerWidth;
const previousInnerHeight = globalThis.innerHeight;
const previousVisualViewport = globalThis.visualViewport;
const previousConnectionManagerRequestService = globalThis.ConnectionManagerRequestService;
const previousSillyTavern = globalThis.SillyTavern;
try {
  let timerId = 0;
  const timers = [];
  const fakeSetTimeout = (callback, delay) => {
    const timer = { id: ++timerId, kind: 'timeout', callback, delay, active: true };
    timers.push(timer);
    return timer;
  };
  const fakeClearTimeout = (timer) => {
    if (timer) timer.active = false;
  };
  const fakeSetInterval = (callback, delay) => {
    const timer = { id: ++timerId, kind: 'interval', callback, delay, active: true };
    timers.push(timer);
    return timer;
  };
  const fakeClearInterval = (timer) => {
    if (timer) timer.active = false;
  };
  const runNextTimeout = (delay) => {
    const timer = timers.find((entry) => entry.kind === 'timeout' && entry.delay === delay && entry.active);
    assert(timer, `expected active timeout for ${delay}ms`);
    timer.active = false;
    timer.callback();
  };
  const flushMicrotasks = async (count = 6) => {
    for (let index = 0; index < count; index += 1) {
      await Promise.resolve();
    }
  };

  const fakeDocument = createFakeDocument();
  globalThis.document = fakeDocument;
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = fakeClearTimeout;
  globalThis.setInterval = fakeSetInterval;
  globalThis.clearInterval = fakeClearInterval;
  globalThis.window = {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval
  };
  delete globalThis.ConnectionManagerRequestService;
  let providerProfileServiceCalls = 0;
  globalThis.SillyTavern = {
    getContext() {
      return {
        power_user: { model: 'gpt-4-turbo' },
        ConnectionManagerRequestService: {
          getSupportedProfiles() {
            providerProfileServiceCalls += 1;
            return [
              { id: 'quiet-profile-a', label: 'Quiet Utility', model: 'glm-fast' },
              { profileId: 'deep-profile-b', label: 'Deep Reasoner', model_name: 'o-reasoner' },
              ...Array.from({ length: 28 }, (_, index) => ({
                id: `archive-profile-${String(index + 1).padStart(2, '0')}`,
                label: `Archive Utility ${String(index + 1).padStart(2, '0')}`,
                model: `archive-model-${index + 1}`
              }))
            ];
          }
        }
      };
    }
  };
  globalThis.innerWidth = 640;
  globalThis.innerHeight = 720;
  const visualViewportListeners = { resize: [], scroll: [] };
  globalThis.visualViewport = {
    width: 640,
    height: 520,
    offsetLeft: 0,
    offsetTop: 0,
    addEventListener(type, listener) {
      if (!visualViewportListeners[type]) visualViewportListeners[type] = [];
      visualViewportListeners[type].push(listener);
    },
    removeEventListener(type, listener) {
      if (!visualViewportListeners[type]) return;
      visualViewportListeners[type] = visualViewportListeners[type].filter((entry) => entry !== listener);
    },
    emit(type) {
      for (const listener of visualViewportListeners[type] || []) listener();
    }
  };
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text) => {
          copied.push(String(text));
        }
      }
    }
  });
  function titleAttributes(node, titles = []) {
    if (!node) return titles;
    const title = node.getAttribute?.('title');
    if (title) titles.push(title);
    for (const child of node.children || []) titleAttributes(child, titles);
    return titles;
  }
  const pendingSettingsUpdates = [];
  const pendingTooltipUi = mountRecursionUi({
    runtime: {
      view: () => ({
        settings: { mode: 'auto', ui: { tooltipsEnabled: true } },
        activity: { phase: 'settled', severity: 'success', label: 'Ready' }
      }),
      updateSettings: (patch) => {
        pendingSettingsUpdates.push(patch);
        return new Promise(() => {});
      }
    },
    mountPoint: fakeDocument.body
  });
  const pendingTooltipRoot = fakeDocument.getElementById('recursion-root');
  pendingTooltipRoot.querySelector('[data-recursion-actions]').click();
  pendingTooltipRoot.querySelector('[data-recursion-settings-tab-advanced]').click({ ignoreStopPropagation: true });
  assert(titleAttributes(pendingTooltipRoot).length > 0, 'pending tooltip regression starts with hover titles enabled');
  const pendingTooltipToggle = pendingTooltipRoot.querySelector('[data-recursion-setting-tooltips-enabled]');
  pendingTooltipToggle.checked = false;
  for (const listener of pendingTooltipRoot.querySelector('[data-recursion-settings-panel]').eventListeners.change || []) {
    listener({ target: pendingTooltipToggle });
  }
  assertEqual(pendingSettingsUpdates.length, 1, 'tooltip checkbox still sends one settings update while prompt cleanup is pending');
  assertEqual(pendingTooltipRoot.dataset.recursionTooltips, 'off', 'tooltip checkbox disables hover help immediately before runtime update resolves');
  assertDeepEqual(titleAttributes(pendingTooltipRoot), [], 'tooltip checkbox removes hover title attributes immediately before runtime update resolves');
  pendingTooltipUi.destroy();

  let failingDiagnosticsCalls = 0;
  const failingActionUi = mountRecursionUi({
    runtime: {
      view: () => ({
        settings: { mode: 'auto', enabled: true, ui: { tooltipsEnabled: true } },
        activity: { phase: 'idle' },
        lastHand: { cards: [] }
      }),
      exportDiagnostics: () => {
        failingDiagnosticsCalls += 1;
        return Promise.reject(new Error('Diagnostics denied'));
      }
    },
    mountPoint: fakeDocument.body
  });
  const failingActionRoot = fakeDocument.getElementById('recursion-root');
  failingActionRoot.querySelector('[data-recursion-actions]').click();
  failingActionRoot.querySelector('[data-recursion-settings-tab-advanced]').click({ ignoreStopPropagation: true });
  failingActionRoot.querySelector('[data-recursion-export-diagnostics]').click();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assertEqual(failingDiagnosticsCalls, 1, 'failed Export Diagnostics action calls runtime once');
  assert(fakeDocument.textTree(failingActionRoot).includes('Diagnostics denied'), 'failed UI action surfaces concise failure text in the Recursion UI');
  failingActionUi.destroy();

  const configuredReasonerUi = mountRecursionUi({
    runtime: {
      view: () => ({
        settings: {
          mode: 'auto',
          enabled: true,
          ui: { tooltipsEnabled: true },
          providers: {
            reasoner: {
              ...DEFAULT_RECURSION_SETTINGS.providers.reasoner,
              enabled: false,
              source: 'host-connection-profile',
              hostConnectionProfileId: 'deepseek-profile',
              lastTest: { status: 'pass' },
              resolvedModelLabel: 'deepseek-v4-pro'
            }
          }
        },
        activity: { phase: 'idle' },
        lastHand: { cards: [] }
      }),
      listProviderConnectionProfiles: () => [{
        id: 'deepseek-profile',
        name: 'deepseek-v4-pro - Provider',
        model: 'deepseek-v4-pro',
        label: 'deepseek-v4-pro - Provider / deepseek-v4-pro'
      }]
    },
    mountPoint: fakeDocument.body
  });
  const configuredReasonerRoot = fakeDocument.getElementById('recursion-root');
  configuredReasonerRoot.querySelector('[data-recursion-actions]').click();
  configuredReasonerRoot.querySelector('[data-recursion-settings-tab-providers]').click({ ignoreStopPropagation: true });
  assertEqual(
    configuredReasonerRoot.querySelector('[data-recursion-provider-status-reasoner]').textContent.toLowerCase().includes('pass'),
    true,
    'configured disabled Reasoner provider header shows passing provider-test health instead of optional route eligibility'
  );
  assertEqual(
    configuredReasonerRoot.querySelector('[data-recursion-provider-status-reasoner]').textContent.toLowerCase().includes('optional'),
    false,
    'configured disabled Reasoner provider header does not replace provider-test health with optional copy'
  );
  assert(
    fakeDocument.textTree(configuredReasonerRoot.querySelector('[data-recursion-provider-route-summary]')).includes('Utility fallback'),
    'disabled Reasoner route eligibility stays visible in the route summary'
  );
  assertEqual(
    configuredReasonerRoot.querySelector('[data-recursion-provider-body-reasoner]').hidden,
    false,
    'configured Reasoner profile section defaults open on a fresh settings render'
  );
  configuredReasonerRoot.querySelector('[data-recursion-provider-toggle-reasoner]').click();
  configuredReasonerRoot.querySelector('[data-recursion-settings-tab-advanced]').click({ ignoreStopPropagation: true });
  configuredReasonerRoot.querySelector('[data-recursion-settings-tab-providers]').click({ ignoreStopPropagation: true });
  assertEqual(
    configuredReasonerRoot.querySelector('[data-recursion-provider-body-reasoner]').hidden,
    true,
    'explicitly collapsed configured Reasoner profile section stays collapsed during the UI session'
  );
  configuredReasonerUi.destroy();

  let refreshed = 0;
  let closeCount = 0;
  const settingsUpdates = [];
  const providerUpdates = [];
  const providerTests = [];
  const providerTestGates = [];
  const providerClears = [];
  const providerModelFetches = [];
  let resetSceneCacheCalls = 0;
  let clearRunJournalCalls = 0;
  let exportDiagnosticsCalls = 0;
  let stopGenerationCalls = 0;
  let freshNextGenerationCalls = 0;
  const freshNextGenerationDetails = [];
  let clearFreshNextGenerationCalls = 0;
  const clearFreshNextGenerationDetails = [];
  function fakeRuntimeConnectionProfiles() {
    return globalThis.SillyTavern.getContext().ConnectionManagerRequestService.getSupportedProfiles().map((profile) => {
      const id = profile.id || profile.profileId;
      const name = profile.name || profile.label || id;
      const model = profile.model || profile.model_name || '';
      return {
        id,
        name,
        model,
        label: model ? `${name} / ${model}` : name
      };
    });
  }
  let view = {
    settings: {
      mode: 'auto',
      enabled: true,
      cardScope: defaultCardScope(),
      strength: 'balanced',
      promptFootprint: 'normal',
      focus: 'balanced',
      reasonerUse: 'auto',
      storyFormOverride: 'present-third-omniscient',
      ui: {
        viewerOpen: false,
        progressChildVisibleLimit: 5,
        progressListVisibleLimit: 15
      },
      providers: {
        utility: {
          lane: 'utility',
          enabled: true,
          source: 'host-current-model',
          hostConnectionProfileId: '',
          openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
          temperature: 0.1,
          topP: 0.95,
          maxTokens: DEFAULT_RECURSION_SETTINGS.providers.utility.maxTokens,
          lastTest: { status: 'not-run' }
        },
        reasoner: {
          lane: 'reasoner',
          enabled: true,
          source: 'host-current-model',
          hostConnectionProfileId: '',
          openAICompatible: { baseUrl: '', model: '', sessionApiKeyPresent: false },
          temperature: 0.4,
          topP: 0.95,
          maxTokens: DEFAULT_RECURSION_SETTINGS.providers.reasoner.maxTokens,
          lastTest: { status: 'pass' }
        }
      }
    },
    freshNextGeneration: { pending: false },
    lastHand: {
      handId: 'hand-ui',
      cards: [{
        id: 'card-a',
        family: 'Scene Frame',
        role: 'sceneFrameCard',
        status: 'active',
        origin: 'generated',
        detailProfile: 'standard',
        provenance: 'provider',
        target: 'blocked door',
        sceneKey: 'scene-ui',
        turnId: 'turn-ui',
        promptText: 'Door stays blocked and the brass lock remains warped.',
        summary: 'Door stays blocked.',
        emphasis: 'emphasized',
        evidenceRefs: ['turn:42', 'scene-hash:abc123'],
        inspectorNotes: 'Inspector-only: player has not seen the brass lock flaw.',
        lifecycle: [
          { state: 'generated', reason: 'scene opening required fresh frame', at: '2026-07-01T00:00:00.000Z' },
          { state: 'selected', reason: 'highest scene relevance' }
        ],
        selectedReason: 'anchors the blocked exit',
        omittedReason: ''
      }, {
        id: 'card-b',
        family: 'Scene Constraints',
        role: 'sceneConstraintsCard',
        status: 'active',
        origin: 'cache',
        detailProfile: 'compact',
        promptText: 'Cached constraint keeps the warped brass lock in view.',
        summary: 'Cached lock constraint.',
        emphasis: 'normal',
        evidenceRefs: ['turn:42'],
        selectedReason: 'cached source still matches'
      }]
    },
    activity: { phase: 'cardBatchRunning', severity: 'info', chips: ['Utility', 'Cards'] },
    progressRun: {
      runId: 'ui-progress',
      steps: [
        {
          id: 'utility-card-batch',
          label: 'Utility card batch',
          providerLane: 'utility',
          state: 'running',
          children: [
            { id: 'scene-frame-card', label: 'Scene Frame', providerLane: 'utility', state: 'running' },
            { id: 'scene-constraints-card', label: 'Scene Constraints', providerLane: 'utility', state: 'pending' },
            { id: 'motivation-card', label: 'Motivation', providerLane: 'utility', state: 'pending' },
            { id: 'threads-card', label: 'Open Threads', providerLane: 'utility', state: 'pending' },
            { id: 'cast-card', label: 'Active Cast', providerLane: 'utility', state: 'pending' },
            { id: 'environment-card', label: 'Environment', providerLane: 'utility', state: 'pending' }
          ]
        }
      ]
    },
    lastPacket: {
      packetId: 'packet-ui',
      packetVersion: 3,
      chatId: 'chat-ui',
      sceneKey: 'scene-ui',
      sceneFingerprint: 'scene-ui',
      turnFingerprint: 'turn-ui',
      footprint: 'normal',
      sections: {
        guidance: 'Guidance:\nGUIDANCE_UI_MARKER keep Dumbledore protective but controlled.',
        cardEvidence: 'Card evidence:\n- [Scene Frame] Door stays blocked and the brass lock remains warped.\n- [Social Subtext] SOCIAL_SUBTEXT_UI_MARKER courtesy carries veiled pressure.',
        guardrails: 'Guardrails:\n- Respect the player message.'
      },
      selectedCardRefs: [{ cardId: 'card-a', family: 'Social Subtext', emphasis: 'emphasized', tokenEstimate: 12, detailProfile: 'standard', evidenceRefs: [] }],
      omissions: [],
      injectionPlan: [
        { id: 'guidance', section: 'guidance', promptKey: 'recursion.guidance', title: 'Recursion Guidance', placement: 'in_prompt', depth: 4, role: 'system', maxChars: 1800, sourceIds: ['card-a'] },
        { id: 'cardEvidence', section: 'cardEvidence', promptKey: 'recursion.cardEvidence', title: 'Recursion Card Evidence', placement: 'in_prompt', depth: 4, role: 'system', maxChars: 30000, sourceIds: ['card-a'] },
        { id: 'guardrails', section: 'guardrails', promptKey: 'recursion.guardrails', title: 'Recursion Guardrails', placement: 'in_prompt', depth: 1, role: 'system', maxChars: 900, sourceIds: [] }
      ],
      diagnostics: { runId: 'run-ui', composerLane: 'guidance', reasonerStatus: 'skipped', guidanceStatus: 'used', pipelineMode: 'rapid', rapidPath: 'warm-v2', sectionBudgets: { guidance: 1800, cardEvidence: 30000, guardrails: 900 } },
      composedAt: '2026-07-01T00:00:00.000Z'
    }
  };
  const ui = mountRecursionUi({
    runtime: {
      view: () => view,
      listProviderConnectionProfiles: fakeRuntimeConnectionProfiles,
      refreshScene: () => {
        refreshed += 1;
      },
      updateSettings: (patch) => {
        settingsUpdates.push(patch);
        view = { ...view, settings: { ...view.settings, ...patch } };
        if (patch?.enabled === false) {
          view = {
            ...view,
            activity: {
              phase: 'promptClearing',
              severity: 'info',
              label: 'Clearing Recursion prompt...',
              chips: ['Prompt']
            }
          };
          return new Promise((resolve) => {
            view = {
              ...view,
              activity: {
                phase: 'settled',
                severity: 'warning',
                label: 'Prompt clear failed. Recursion skipped without clearing host prompt.',
                chips: ['Prompt']
              }
            };
            resolve({ ok: false, settings: view.settings, clear: { ok: false } });
          });
        }
        return view.settings;
      },
      updateProvider: (lane, patch) => {
        providerUpdates.push({ lane, patch });
        view = {
          ...view,
          settings: {
            ...view.settings,
            providers: {
              ...view.settings.providers,
              [lane]: {
                ...view.settings.providers[lane],
                ...patch,
                openAICompatible: {
                  ...view.settings.providers[lane].openAICompatible,
                  ...(patch.openAICompatible || {}),
                  sessionApiKeyPresent: Boolean(patch.apiKey) || view.settings.providers[lane].openAICompatible.sessionApiKeyPresent
                }
              }
            }
          }
        };
        return view.settings.providers[lane];
      },
      testProvider: (lane) => {
        providerTests.push(lane);
        const gate = {};
        gate.promise = new Promise((resolve) => {
          gate.resolve = resolve;
        });
        providerTestGates.push(gate);
        return gate.promise;
      },
      clearProviderKey: (lane) => {
        providerClears.push(lane);
        view = {
          ...view,
          settings: {
            ...view.settings,
            providers: {
              ...view.settings.providers,
              [lane]: {
                ...view.settings.providers[lane],
                openAICompatible: {
                  ...view.settings.providers[lane].openAICompatible,
                  sessionApiKeyPresent: false
                }
              }
            }
          }
        };
        return view.settings.providers[lane];
      },
      fetchProviderModels: async (lane, patch) => {
        providerModelFetches.push({ lane, patch });
        return {
          ok: true,
          models: [
            { id: 'alpha-model', label: 'Alpha Model' },
            { id: 'beta-model', label: 'beta-model' }
          ]
        };
      },
      resetSceneCache: () => {
        resetSceneCacheCalls += 1;
        return { ok: true };
      },
      clearRunJournal: () => {
        clearRunJournalCalls += 1;
        return { ok: true };
      },
      exportDiagnostics: () => {
        exportDiagnosticsCalls += 1;
        return {
          ok: true,
          diagnostics: {
            schema: 'recursion.diagnostics.v1',
            promptPacketHash: 'packet-hash'
          }
        };
      },
      stopGeneration: (details = {}) => {
        stopGenerationCalls += 1;
        return { ok: true, details };
      },
      requestFreshNextGeneration: (details = {}) => {
        freshNextGenerationCalls += 1;
        freshNextGenerationDetails.push(details);
        view = {
          ...view,
          freshNextGeneration: {
            pending: true,
            id: 'fresh-ui',
            reason: 'user-fresh-next-generation',
            source: details.source || 'bar'
          }
        };
        return { ok: true, freshNextGeneration: view.freshNextGeneration };
      },
      clearFreshNextGeneration: (details = {}) => {
        clearFreshNextGenerationCalls += 1;
        clearFreshNextGenerationDetails.push(details);
        view = {
          ...view,
          freshNextGeneration: { pending: false }
        };
        return { ok: true, freshNextGeneration: view.freshNextGeneration };
      }
    },
    mountPoint: fakeDocument.body
  });

  const root = fakeDocument.getElementById('recursion-root');
  assert(root, 'root is rendered');
  assert(root.querySelector('[data-recursion-bar]'), 'bar selector is rendered');
  root.querySelector('[data-recursion-bar]').setBoundingClientRect({ left: 0, top: 0, width: 640, height: 30, right: 640, bottom: 30 });
  assert(root.querySelector('[data-recursion-power-toggle]'), 'compact bar renders the dedicated power toggle');
  assert(root.querySelector('[data-recursion-power-toggle]').querySelector('svg'), 'power toggle uses the reference power SVG');
  assert(!fakeDocument.textTree(root.querySelector('[data-recursion-bar]')).includes('RECURSION'), 'compact bar does not render the Recursion wordmark');
  assert(root.querySelector('[data-recursion-mode-button]'), 'compact bar renders an icon-only mode button');
  assert(root.querySelector('[data-recursion-mode-menu]'), 'compact bar renders the mode selector menu');
  assert(root.querySelector('[data-recursion-pipeline-button]'), 'compact bar renders an icon-only pipeline button');
  assert(root.querySelector('[data-recursion-pipeline-menu]'), 'compact bar renders the pipeline selector menu');
  assertDeepEqual(
    root.querySelector('[data-recursion-bar]').children
      .map((child) => {
        if (child.querySelector?.('[data-recursion-pipeline-button]')) return 'pipeline';
        if (child.querySelector?.('[data-recursion-mode-button]')) return 'mode';
        if (child.dataset?.recursionCardsButton !== undefined || child.querySelector?.('[data-recursion-cards-button]')) return 'cards';
        if (child.querySelector?.('[data-recursion-enhancements-button]')) return 'enhancements';
        if (child.querySelector?.('[data-recursion-story-form-button]')) return 'storyForm';
        return '';
      })
      .filter(Boolean),
    ['pipeline', 'mode', 'cards', 'enhancements', 'storyForm'],
    'compact bar places Enhancements immediately after Cards and before Tense & PoV'
  );
  assert(root.querySelector('[data-recursion-pipeline-icon]').querySelector('svg'), 'pipeline button renders an inline SVG icon');
  assert(root.querySelector('[data-recursion-pipeline-icon]').querySelector('[data-recursion-pipeline-standard]'), 'Standard pipeline button uses the standard pipeline icon');
  assertEqual(root.querySelectorAll('[data-recursion-pipeline-choice-icon]').length, 3, 'pipeline selector renders icons only for Standard, Rapid, and Fused');
  assertEqual(root.querySelectorAll('[data-recursion-pipeline-choice-tip]').length, 3, 'pipeline selector renders tips only for Standard, Rapid, and Fused');
  assert(root.querySelector('[data-recursion-pipeline-choice-standard]').querySelector('[data-recursion-pipeline-standard]'), 'Standard pipeline row uses the standard pipeline icon');
  assert(root.querySelector('[data-recursion-pipeline-choice-rapid]').querySelector('[data-recursion-pipeline-rapid]'), 'Rapid pipeline row uses the rapid pipeline icon');
  assert(root.querySelector('[data-recursion-pipeline-choice-fused]').querySelector('[data-recursion-pipeline-fused]'), 'Fused pipeline row uses the fused pipeline icon');
  assertDeepEqual(
    root.querySelectorAll('[data-recursion-pipeline-choice]').map((choice) => choice.dataset.recursionPipelineChoice),
    ['standard', 'rapid', 'fused'],
    'pipeline selector uses the Standard/Rapid/Fused order'
  );
  assertEqual(
    root.querySelector('[data-recursion-pipeline-button]').getAttribute('aria-label'),
    'Pipeline: Standard Pipeline',
    'pipeline button exposes the current pipeline label'
  );
  assertEqual(root.querySelector('[data-recursion-pipeline-button]').getAttribute('title'), 'Pipeline: Standard Pipeline', 'pipeline button exposes compact hover tip');
  assert(root.querySelector('[data-recursion-mode-icon]').querySelector('svg'), 'mode button renders the reference inline SVG icon');
  assert(root.querySelector('[data-recursion-mode-icon]').querySelector('[data-recursion-mode-arrow-fan]'), 'Auto mode button uses the divergent three-arrow mode icon');
  assertEqual(root.querySelector('[data-recursion-mode-icon]').querySelectorAll('[data-recursion-mode-arrow]').length, 3, 'Auto mode icon keeps three equal-weight arrows');
  assertEqual(root.querySelectorAll('[data-recursion-mode-choice-icon]').length, 2, 'mode selector renders icons only for Auto and Manual');
  assertEqual(root.querySelectorAll('[data-recursion-mode-choice-tip]').length, 2, 'mode selector renders tips only for Auto and Manual');
  assert(root.querySelector('[data-recursion-mode-choice-auto]').querySelector('[data-recursion-mode-arrow-fan]'), 'Auto mode row uses the divergent three-arrow icon');
  assert(root.querySelector('[data-recursion-mode-choice-manual]').querySelector('[data-recursion-mode-arrow-parallel]'), 'Manual mode row uses the parallel three-arrow icon');
  assertEqual(root.querySelector('[data-recursion-mode-choice-manual]').querySelectorAll('[data-recursion-mode-arrow]').length, 3, 'Manual mode row keeps three equal-weight arrows');
  assert(!root.querySelector(`[data-recursion-mode-choice-${removedModeValue}]`), 'old named mode is removed from the compact mode menu');
  assert(!root.querySelector('[data-recursion-mode-choice-observe]'), 'Observe only mode is removed from the compact mode menu');
  assert(!root.querySelector('[data-recursion-mode-choice-off]'), 'Off mode is removed from the compact mode menu');
  assertDeepEqual(
    root.querySelectorAll('[data-recursion-mode-choice]').map((choice) => choice.dataset.recursionModeChoice),
    ['auto', 'manual'],
    'mode selector uses the Auto/Manual mode order'
  );
  assertEqual(
    root.querySelector('[data-recursion-mode-button]').getAttribute('aria-label'),
    'Mode: Auto',
    'mode button exposes the current mode label'
  );
  assertEqual(root.querySelector('[data-recursion-mode-button]').getAttribute('title'), 'Mode: Auto', 'mode button exposes compact hover tip');
  assert(root.querySelector('[data-recursion-enhancements-button]'), 'compact bar renders the Enhancements button');
  assert(root.querySelector('[data-recursion-enhancements-menu]'), 'compact bar renders the Enhancements selector menu');
  assert(root.querySelector('[data-recursion-enhancements-icon]'), 'Enhancements button renders the upgrade.svg mask icon');
  assertEqual(root.querySelector('[data-recursion-enhancements-icon]').children.length, 0, 'Enhancements icon uses the upgrade.svg asset mask instead of inline SVG');
  assert(root.querySelector('[data-recursion-enhancements-button]').className.includes('is-off'), 'Enhancements button greys out when Off');
  assertDeepEqual(
    root.querySelectorAll('[data-recursion-enhancement-apply-choice]').map((choice) => choice.dataset.recursionEnhancementApplyChoice),
    ['as-swipe', 'replace'],
    'Enhancements selector uses As Swipe/Replace apply order'
  );
  assertDeepEqual(
    root.querySelectorAll('[data-recursion-enhancement-target-choice]').map((choice) => choice.dataset.recursionEnhancementTargetChoice),
    ['off', 'prose', 'dialogue', 'prose-dialogue'],
    'Enhancements selector uses Off/Prose/Dialogue/Prose + Dialogue target order'
  );
  assertDeepEqual(
    root.querySelectorAll('[data-recursion-enhancement-target-icon]').map((icon) => icon.dataset.recursionEnhancementTargetIcon),
    ['off', 'prose', 'dialogue', 'prose-dialogue'],
    'Enhancements selector renders one icon slot for each target option'
  );
  const proseTargetIcon = root.querySelector('[data-recursion-enhancement-target-choice-prose]').querySelector('[data-recursion-enhancement-target-icon]');
  const dialogueTargetIcon = root.querySelector('[data-recursion-enhancement-target-choice-dialogue]').querySelector('[data-recursion-enhancement-target-icon]');
  const combinedTargetChoice = root.querySelector('[data-recursion-enhancement-target-choice-prose-dialogue]');
  const combinedTargetIcon = combinedTargetChoice.querySelector('[data-recursion-enhancement-target-icon]');
  assert(proseTargetIcon.className.includes('is-prose'), 'Prose target row uses prose icon');
  assert(dialogueTargetIcon.className.includes('is-dialogue'), 'Dialogue target row uses dialogue icon');
  assert(combinedTargetChoice.className.includes('is-combo'), 'Prose + Dialogue target row owns combo icon slot layout');
  assert(combinedTargetIcon.className.includes('is-combo'), 'Prose + Dialogue target row uses stacked combo icon');
  assertEqual(combinedTargetIcon.children.length, 2, 'Prose + Dialogue target row stacks two compact icons');
  assert(combinedTargetIcon.children[0].className.includes('is-prose'), 'Prose + Dialogue target row places prose icon first');
  assert(combinedTargetIcon.children[1].className.includes('is-dialogue'), 'Prose + Dialogue target row places dialogue icon second');
  assertEqual(root.querySelectorAll('[data-recursion-enhancement-target-choice-tip]').length, 4, 'Enhancements selector renders mini descriptions for all target options');
  assertEqual(
    root.querySelector('[data-recursion-enhancements-button]').getAttribute('aria-label'),
    'Enhancements: Off',
    'Enhancements button exposes the current target'
  );
  const storyFormMenuText = fakeDocument.textTree(root.querySelector('[data-recursion-story-form-menu]'));
  assert(storyFormMenuText.includes('Auto'), 'story form menu includes Auto');
  assert(storyFormMenuText.includes('Tense'), 'story form menu includes Tense section');
  assert(storyFormMenuText.includes('Past'), 'story form menu includes Past tense');
  assert(storyFormMenuText.includes('Present'), 'story form menu includes Present tense');
  assert(storyFormMenuText.includes('Point of View'), 'story form menu includes POV section');
  assert(storyFormMenuText.includes('1st'), 'story form menu includes first-person POV');
  assert(storyFormMenuText.includes('2nd'), 'story form menu includes second-person POV');
  assert(storyFormMenuText.includes('3rd Ltd'), 'story form menu includes third-person limited POV');
  assert(storyFormMenuText.includes('3rd Omni'), 'story form menu includes third-person omniscient POV');
  assert(storyFormMenuText.includes('Mixed'), 'story form menu includes mixed POV');
  const storyFormPovList = root.querySelector('[data-recursion-story-form-pov-list]');
  assert(storyFormPovList, 'story form menu renders POV choices as a vertical list');
  assertEqual(storyFormPovList.querySelectorAll('[data-recursion-story-form-pov]').length, 5, 'story form POV list contains all five POV choices');
  assert(!/\.recursion-story-form-axis-grid-pov\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3/.test(recursionCss), 'story form POV choices are not laid out as a three-column grid');
  assertEqual(root.querySelectorAll('[data-recursion-story-form-choice]').length, 0, 'story form menu no longer renders flat combined choices');
  assertEqual(root.querySelector('[data-recursion-story-form-auto-choice]').getAttribute('aria-pressed'), 'false', 'Auto is not selected for forced story form');
  assertEqual(root.querySelector('[data-recursion-story-form-tense-present]').getAttribute('aria-pressed'), 'true', 'present tense is selected');
  assertEqual(root.querySelector('[data-recursion-story-form-pov-third-omniscient]').getAttribute('aria-pressed'), 'true', 'third omniscient POV is selected');
  assertEqual(root.querySelector('[data-recursion-story-form]').textContent, 'Pr3O', 'mobile story form button uses compact shorthand for long labels');
  root.querySelector('[data-recursion-story-form-button]').click();
  root.querySelector('[data-recursion-story-form-tense-past]').click();
  assertEqual(settingsUpdates.at(-1).storyFormOverride, 'past-third-omniscient', 'clicking Past preserves current POV');
  assertEqual(root.querySelector('[data-recursion-story-form-menu]').hidden, false, 'forced tense click keeps story form menu open');
  root.querySelector('[data-recursion-story-form-pov-mixed]').click();
  assertEqual(settingsUpdates.at(-1).storyFormOverride, 'past-mixed', 'clicking Mixed preserves current tense');
  assertEqual(root.querySelector('[data-recursion-story-form-menu]').hidden, false, 'forced POV click keeps story form menu open');
  root.querySelector('[data-recursion-story-form-auto-choice]').click();
  assertEqual(settingsUpdates.at(-1).storyFormOverride, 'auto', 'clicking Auto saves auto story form');
  assertEqual(root.querySelector('[data-recursion-story-form-menu]').hidden, true, 'clicking Auto closes story form menu');
  view = { ...view, settings: { ...view.settings, storyFormOverride: 'auto' } };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-story-form-auto-choice]').getAttribute('aria-pressed'), 'true', 'Auto is selected for automatic story form');
  assertEqual(root.querySelector('[data-recursion-story-form-tense-present]').getAttribute('aria-pressed'), 'false', 'no forced tense selected in Auto');
  assertEqual(root.querySelector('[data-recursion-story-form-pov-mixed]').getAttribute('aria-pressed'), 'false', 'no forced POV selected in Auto');
  root.querySelector('[data-recursion-story-form-button]').click();
  root.querySelector('[data-recursion-story-form-pov-mixed]').click();
  assertEqual(settingsUpdates.at(-1).storyFormOverride, 'past-mixed', 'clicking Mixed from Auto uses default past tense');
  root.querySelector('[data-recursion-story-form-auto-choice]').click();
  view = { ...view, settings: { ...view.settings, storyFormOverride: 'past-mixed' } };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-story-form]').textContent, 'PaM', 'mobile story form button uses compact shorthand for Past Mixed');
  view = { ...view, settings: { ...view.settings, storyFormOverride: 'present-mixed' } };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-story-form]').textContent, 'PrM', 'mobile story form button uses compact shorthand for Present Mixed');
  view = { ...view, settings: { ...view.settings, storyFormOverride: 'present-third-omniscient' } };
  ui.update();
  globalThis.innerWidth = 920;
  globalThis.visualViewport.width = 920;
  ui.update();
  assertEqual(root.querySelector('[data-recursion-story-form]').textContent, 'Present 3rd Omni', 'desktop story form button uses the full selected label');
  globalThis.innerWidth = 640;
  globalThis.visualViewport.width = 640;
  ui.update();
  const stableAutoModeSvg = root.querySelector('[data-recursion-mode-icon]').querySelector('svg');
  ui.update();
  assertEqual(
    root.querySelector('[data-recursion-mode-icon]').querySelector('svg'),
    stableAutoModeSvg,
    'mode refresh preserves the current icon node so rapid pointer clicks are not lost to DOM replacement'
  );
  assertEqual(
    root.querySelector('[data-recursion-mode-choice-auto]').getAttribute('title'),
    'Selects cards and injects composed prompt context automatically.',
    'Auto mode tooltip matches the reference copy'
  );
  assert(
    fakeDocument.textTree(root.querySelector('[data-recursion-mode-choice-manual]')).includes('Forces selected card families up to Max Cards.'),
    'Manual mode tip explains forced card-family selection'
  );
  assert(
    root.querySelector('[data-recursion-mode-choice-auto]').className.includes('is-selected'),
    'mode selector marks the current mode'
  );
  assert(
    root.querySelector('[data-recursion-pipeline-choice-standard]').className.includes('is-selected'),
    'pipeline selector marks the current pipeline'
  );
  assertEqual(
    root.querySelector('[data-recursion-mode-choice-auto]').getAttribute('aria-current'),
    'true',
    'mode selector exposes the current mode to assistive tech'
  );
  assertEqual(
    root.querySelector('[data-recursion-pipeline-choice-standard]').getAttribute('aria-current'),
    'true',
    'pipeline selector exposes the current pipeline to assistive tech'
  );
  assert(root.querySelector('[data-recursion-status-trigger]'), 'compact bar renders the progress activity trigger');
  assert(root.querySelector('[data-recursion-hero-array]'), 'compact bar renders the Hero Pixel Array');
  assert(root.querySelector('[data-recursion-stop-generation]'), 'compact bar renders the active stop generation button');
  assertEqual(root.querySelector('[data-recursion-stop-generation]').hidden, false, 'active run shows stop generation button');
  assert(root.querySelector('[data-recursion-stop-generation]').querySelector('[data-recursion-stop-icon]'), 'stop generation button uses a square stop icon');
  assert(root.querySelector('[data-recursion-fresh-next-generation]'), 'compact bar renders the fresh-next generation command slot button');
  assertEqual(root.querySelector('[data-recursion-fresh-next-generation]').hidden, true, 'active run hides fresh-next generation while stop is visible');
  assert(root.querySelector('[data-recursion-status-popover]'), 'compact bar renders the progress popover');
  assert(root.querySelector('[data-recursion-current-step]'), 'compact bar renders one current-step status text');
  assert(root.querySelector('[data-recursion-mobile-status-drawer]'), 'compact root renders the mobile status drawer');
  assert(root.querySelector('[data-recursion-mobile-status-text]'), 'mobile status drawer renders a dedicated status text node');
  assert(root.querySelector('[data-recursion-reasoning-chain]'), 'compact bar renders the reasoning level chain');
  assert(root.querySelector('[data-recursion-reasoning-level-high]'), 'reasoning chain defaults to the High node');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-low]').getAttribute('aria-label'), 'Low reasoning level. Low: Utility-only, reduced cards.', 'Low reasoning node has explicit accessible label');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-medium]').getAttribute('aria-label'), 'Medium reasoning level. Medium: Utility checks, Reasoner guidance.', 'Medium reasoning node has explicit accessible label');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-high]').getAttribute('aria-label'), 'High reasoning level. High: Reasoner Arbiter, priority cards, and guidance.', 'High reasoning node has explicit accessible label');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-ultra]').getAttribute('aria-label'), 'Ultra reasoning level. Ultra: Reasoner-heavy calls with a larger card bias.', 'Ultra reasoning node has explicit accessible label');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-high]').getAttribute('tabindex'), '0', 'selected reasoning node is the roving tab stop');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-low]').getAttribute('tabindex'), '-1', 'unselected reasoning node leaves the tab sequence');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-low]').getAttribute('title'), 'Low: Utility-only, reduced cards.', 'Low reasoning tooltip matches the reference copy');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-medium]').getAttribute('title'), 'Medium: Utility checks, Reasoner guidance.', 'Medium reasoning tooltip matches the reference copy');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-high]').getAttribute('title'), 'High: Reasoner Arbiter, priority cards, and guidance.', 'High reasoning tooltip matches the reference copy');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-ultra]').getAttribute('title'), 'Ultra: Reasoner-heavy calls with a larger card bias.', 'Ultra reasoning tooltip matches the reference copy');
  assert(root.querySelector('[data-recursion-brief-arrow]'), 'compact bar renders a dedicated last-brief dropdown arrow');
  assert(root.querySelector('[data-recursion-cards-button]'), 'compact bar renders the Cards scope button');
  assertEqual(root.querySelector('[data-recursion-cards-button]').querySelectorAll('rect').length, 3, 'Cards scope button owns the stacked-cards SVG');
  const barChildren = root.querySelector('[data-recursion-bar]').children;
  const powerButton = root.querySelector('[data-recursion-power-toggle]');
  const pipelineCluster = root.querySelector('[data-recursion-pipeline-button]').parentNode;
  const modeCluster = root.querySelector('[data-recursion-mode-button]').parentNode;
  const cardsButton = root.querySelector('[data-recursion-cards-button]');
  const enhancementsCluster = root.querySelector('[data-recursion-enhancements-button]').parentNode;
  const storyFormCluster = root.querySelector('[data-recursion-story-form-button]').parentNode;
  const statusTrigger = root.querySelector('[data-recursion-status-trigger]');
  const rightTools = root.querySelector('[data-recursion-reasoning-chain]').parentNode;
  assertEqual(barChildren.indexOf(pipelineCluster), barChildren.indexOf(powerButton) + 1, 'Pipeline sits immediately to the right of Power');
  assertEqual(barChildren.indexOf(modeCluster), barChildren.indexOf(pipelineCluster) + 1, 'Mode sits immediately to the right of Pipeline');
  assertEqual(cardsButton.parentNode, root.querySelector('[data-recursion-bar]'), 'Cards button lives in the left bar flow');
  assert(barChildren.indexOf(modeCluster) < barChildren.indexOf(cardsButton), 'Cards button sits to the right of Mode');
  assertEqual(barChildren.indexOf(enhancementsCluster), barChildren.indexOf(cardsButton) + 1, 'Enhancements sits immediately to the right of Cards');
  assertEqual(barChildren.indexOf(storyFormCluster), barChildren.indexOf(enhancementsCluster) + 1, 'Tense & PoV sits immediately to the right of Enhancements');
  assert(barChildren.indexOf(cardsButton) < barChildren.indexOf(statusTrigger), 'Cards button sits to the left of the Hero Pixel Array progress trigger');
  assert(!rightTools.children.includes(cardsButton), 'Cards button is not part of the right tool cluster');
  assert(!root.querySelector('[data-recursion-cards-label]'), 'Cards button is icon-only with no visible label node');
  assertEqual(fakeDocument.textTree(cardsButton).trim(), '', 'Cards button renders no visible text');
  assertEqual(root.querySelector('[data-recursion-cards-button]').getAttribute('aria-expanded'), 'false', 'Cards button starts collapsed');
  assert(root.querySelector('[data-recursion-arrow-down]'), 'last-brief dropdown arrow uses a drawn icon instead of text');
  assert(root.querySelector('[data-recursion-options-button]'), 'compact bar renders a dedicated ellipsis options button');
  assert(root.querySelector('[data-recursion-ellipsis]'), 'options button uses drawn ellipsis dots instead of text');
  assertEqual(
    fakeDocument.textTree(root.querySelector('[data-recursion-options-button]')).trim(),
    '',
    'options button does not render a literal ellipsis glyph'
  );
  assertEqual(root.querySelector('[data-recursion-power-toggle]').getAttribute('aria-pressed'), 'true', 'power toggle starts pressed when Recursion is enabled');
  assertEqual(root.querySelector('[data-recursion-power-toggle]').getAttribute('title'), 'Turn Recursion off', 'power toggle exposes hover tip copy');
  assertEqual(root.querySelector('[data-recursion-pipeline-button]').getAttribute('aria-expanded'), 'false', 'pipeline menu trigger starts collapsed');
  assertEqual(root.querySelector('[data-recursion-status-trigger]').getAttribute('aria-expanded'), 'false', 'progress activity trigger starts collapsed');
  assertEqual(root.querySelector('[data-recursion-status-trigger]').getAttribute('title'), 'Open generation progress', 'progress activity trigger exposes hover tip copy');
  assertEqual(root.querySelector('[data-recursion-stop-generation]').getAttribute('title'), 'Stop generation', 'stop generation button exposes hover tip copy');
  assertEqual(root.querySelector('[data-recursion-stop-generation]').getAttribute('aria-label'), 'Stop generation', 'stop generation button exposes accessible copy');
  assertEqual(root.querySelector('[data-recursion-hand-toggle]').getAttribute('aria-expanded'), 'false', 'brief dropdown trigger starts collapsed');
  assertEqual(root.querySelector('[data-recursion-hand-toggle]').getAttribute('title'), 'Open last brief preview', 'brief dropdown trigger exposes hover tip copy');
  assertEqual(root.querySelector('[data-recursion-mode-button]').getAttribute('aria-expanded'), 'false', 'mode menu trigger starts collapsed');
  assertEqual(root.querySelector('[data-recursion-options-button]').getAttribute('title'), 'Open Recursion settings', 'options button exposes hover tip copy');
  assertEqual(root.querySelector('[data-recursion-viewer-toggle]').getAttribute('tabindex'), '-1', 'hidden viewer toggle is not an invisible tab stop');
  assertEqual(root.querySelector('[data-recursion-viewer-toggle]').getAttribute('aria-hidden'), 'true', 'hidden viewer toggle is removed from assistive navigation');
  assertEqual(root.dataset.recursionRoot, '', 'root exposes stable recursion capture selector');
  assert(root.querySelector('[data-recursion-activity-ribbon]'), 'activity ribbon selector is rendered');
  assert(!root.querySelector('[data-recursion-action-menu]'), 'legacy action menu is not rendered');
  assert(root.querySelector('[data-recursion-hand-dropdown]'), 'hand dropdown selector is rendered');
  assert(root.querySelector('[data-recursion-settings-panel]'), 'settings panel selector is rendered');
  assert(root.querySelector('[data-recursion-viewer]'), 'viewer selector is rendered');
  const promptPacketNode = root.querySelector('[data-recursion-prompt-packet]');
  assert(promptPacketNode, 'prompt packet metadata selector is rendered');
  const promptPacketMetadata = JSON.parse(promptPacketNode.textContent);
  assertEqual(promptPacketMetadata.packetId, 'packet-ui', 'prompt packet metadata includes packet id');
  assertEqual(promptPacketMetadata.handId, 'hand-ui', 'prompt packet metadata includes hand id from the last hand');
  assertDeepEqual(promptPacketMetadata.selectedCardRefs.map((entry) => entry.cardId), ['card-a'], 'prompt packet metadata includes selected card refs');
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, true, 'foreground ribbon waits briefly before revealing working activity');
  assertEqual(root.querySelector('[data-recursion-status]').textContent, 'Working', 'rendered runtime health');
  assertEqual(root.querySelector('[data-recursion-mode]').textContent, 'Auto', 'rendered separate mode text');
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, 'Utility card batch...', 'rendered compact current progress step');
  assertEqual(root.querySelector('[data-recursion-mobile-status-drawer]').hidden, false, 'mobile status drawer shows while current progress text exists');
  assertEqual(root.querySelector('[data-recursion-mobile-status-text]').textContent, 'Utility card batch...', 'mobile status drawer mirrors the current progress step');
  assert(root.querySelector('[data-recursion-hero-array]').children.length >= 1, 'hero array renders visible progress blocks');
  assertEqual(root.querySelector('[data-recursion-status-trigger]').style.props['--columns'], '1', 'activity trigger exposes column count for width animation');
  assertEqual(root.querySelector('[data-recursion-hero-array]').style.props['--columns'], '1', 'hero array exposes column count for width animation');
  assertEqual(root.querySelector('[data-recursion-hero-array]').style.props['--block-count'], '1', 'hero array exposes top-level block count for animation timing');
  assertEqual(root.querySelector('[data-recursion-hand-count]').textContent, 'Hand 2', 'rendered hand count');
  assertEqual(root.querySelector('[data-recursion-composer]').textContent, 'Guidance', 'rendered composer');

  root.querySelector('[data-recursion-pipeline-button]').setBoundingClientRect({ left: 32, top: 3, width: 24, height: 24, right: 56, bottom: 27 });
  root.querySelector('[data-recursion-pipeline-button]').click();
  assertEqual(root.querySelector('[data-recursion-pipeline-menu]').hidden, false, 'pipeline button opens pipeline selector');
  assertEqual(root.querySelector('[data-recursion-pipeline-button]').getAttribute('aria-expanded'), 'true', 'pipeline button reflects open menu');
  assertEqual(root.querySelector('[data-recursion-pipeline-menu]').style.left, '38px', 'pipeline menu follows reference 6px inset from pipeline cluster');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-pipeline-choice-standard]')).includes('Standard'), 'Standard row has visible short name');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-pipeline-choice-rapid]')).includes('Rapid'), 'Rapid row has visible short name');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-pipeline-choice-fused]')).includes('Fused'), 'Fused row has visible short name');
  root.querySelector('[data-recursion-pipeline-choice-rapid]').querySelector('[data-recursion-pipeline-choice-name]').click();
  assertDeepEqual(settingsUpdates.at(-1), { pipelineMode: 'rapid' }, 'pipeline menu switches Standard to Rapid from nested row content clicks');
  assertEqual(root.querySelector('[data-recursion-pipeline-button]').getAttribute('aria-expanded'), 'false', 'pipeline button reflects closed menu after selection');
  ui.update();
  assert(root.querySelector('[data-recursion-pipeline-icon]').querySelector('[data-recursion-pipeline-rapid]'), 'Rapid pipeline button uses the rapid pipeline icon after selection');
  assert(
    root.querySelector('[data-recursion-pipeline-button]').getAttribute('title').includes('Rapid Pipeline'),
    'Rapid pipeline tooltip explains current pipeline'
  );
  root.querySelector('[data-recursion-pipeline-button]').click();
  root.querySelector('[data-recursion-pipeline-choice-fused]').querySelector('[data-recursion-pipeline-choice-tip]').click();
  assertDeepEqual(settingsUpdates.at(-1), { pipelineMode: 'fused' }, 'pipeline menu switches to Fused from nested row content clicks');
  view = { ...view, settings: { ...view.settings, pipelineMode: 'fused' } };
  ui.update();
  assert(root.querySelector('[data-recursion-pipeline-icon]').querySelector('[data-recursion-pipeline-fused]'), 'Fused pipeline button uses the fused pipeline icon after selection');
  assert(root.querySelector('[data-recursion-pipeline-button]').getAttribute('title').includes('Fused Pipeline'), 'Fused pipeline tooltip explains current pipeline');

  root.querySelector('[data-recursion-enhancements-button]').setBoundingClientRect({ left: 118, top: 3, width: 24, height: 24, right: 142, bottom: 27 });
  root.querySelector('[data-recursion-enhancements-button]').click();
  assertEqual(root.querySelector('[data-recursion-enhancements-menu]').hidden, false, 'Enhancements button opens selector');
  assertEqual(root.querySelector('[data-recursion-enhancements-button]').getAttribute('aria-expanded'), 'true', 'Enhancements button reflects open menu');
  root.querySelector('[data-recursion-enhancement-apply-choice-replace]').querySelector('[data-recursion-enhancement-apply-choice-name]').click();
  assertDeepEqual(settingsUpdates.at(-1), { enhancements: { applyMode: 'replace' } }, 'Enhancements menu switches apply mode from nested row content clicks');
  assertEqual(root.querySelector('[data-recursion-enhancements-button]').getAttribute('aria-expanded'), 'true', 'Enhancements menu stays open after apply mode selection');
  root.querySelector('[data-recursion-enhancement-target-choice-dialogue]').querySelector('[data-recursion-enhancement-target-choice-tip]').click();
  assertDeepEqual(settingsUpdates.at(-1), { enhancements: { target: 'dialogue' } }, 'Enhancements menu switches target from nested row content clicks');
  assertEqual(root.querySelector('[data-recursion-enhancements-button]').getAttribute('aria-expanded'), 'true', 'Enhancements button keeps menu open after target selection');
  assertEqual(root.querySelector('[data-recursion-enhancements-menu]').hidden, false, 'Enhancements menu stays open after target selection');
  assert(root.querySelector('[data-recursion-enhancement-target-choice-dialogue]').className.includes('is-selected'), 'Enhancements target selection highlights immediately');
  view = { ...view, settings: { ...view.settings, enhancements: { target: 'dialogue', applyMode: 'replace', contextMessages: 13 } } };
  ui.update();
  assert(!root.querySelector('[data-recursion-enhancements-button]').className.includes('is-off'), 'Enhancements button is no longer grey when enabled');

  root.querySelector('[data-recursion-mode-button]').setBoundingClientRect({ left: 63, top: 3, width: 24, height: 24, right: 87, bottom: 27 });
  let bubbledModeClicks = 0;
  root.addEventListener('click', (event) => {
    if (event.target === root.querySelector('[data-recursion-mode-button]')) bubbledModeClicks += 1;
  });
  root.querySelector('[data-recursion-mode-button]').click();
  assertEqual(bubbledModeClicks, 0, 'mode button consumes its own click instead of letting the bar/document outside-click handlers capture the first open');
  assertEqual(root.querySelector('[data-recursion-mode-menu]').hidden, false, 'mode button opens mode selector');
  assertEqual(root.querySelector('[data-recursion-mode-button]').getAttribute('aria-expanded'), 'true', 'mode button reflects open menu');
  assertEqual(root.querySelector('[data-recursion-mode-menu]').style.left, '69px', 'mode menu follows reference 6px inset from mode cluster');
  root.querySelector('[data-recursion-mode-choice-manual]').querySelector('[data-recursion-mode-choice-name]').click();
  assertEqual(settingsUpdates.at(-1).mode, 'manual', 'mode menu updates Manual from nested row content clicks');
  assertEqual(
    CARD_SCOPE_CATALOG.filter((entry) => settingsUpdates.at(-1).cardScope?.families?.[entry.family]?.enabled === true).length,
    10,
    'Manual mode switch trims default all-scope to the Manual Max Cards cap'
  );
  assertEqual(root.querySelector('[data-recursion-mode-button]').getAttribute('aria-expanded'), 'false', 'mode button reflects closed menu after selection');
  ui.update();
  assert(root.querySelector('[data-recursion-mode-icon]').querySelector('[data-recursion-mode-arrow-parallel]'), 'Manual mode button uses the parallel three-arrow mode icon after selection');
  assertEqual(root.querySelector('[data-recursion-mode-icon]').querySelectorAll('[data-recursion-mode-arrow]').length, 3, 'Manual mode icon keeps three equal-weight arrows');
  root.querySelector('[data-recursion-power-toggle]').click();
  assertDeepEqual(settingsUpdates.at(-1), { enabled: false }, 'power toggle disables Recursion without changing mode');
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, true, 'power toggle does not open progress popover');
  root.querySelector('[data-recursion-stop-generation]').click();
  assertEqual(stopGenerationCalls, 1, 'stop generation button calls unified runtime stop action');
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, true, 'stop generation button does not open progress popover');
  root.querySelector('[data-recursion-status-trigger]').click();
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, false, 'activity trigger opens progress popover');
  assertEqual(root.querySelector('[data-recursion-status-trigger]').getAttribute('aria-expanded'), 'true', 'activity trigger reflects open progress popover');
  assertEqual(fakeDocument.activeElement, root.querySelector('[data-recursion-status-popover]'), 'opening progress moves focus into the progress popover');
  root.querySelector('[data-recursion-status-trigger]').click();
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, true, 'activity trigger closes progress popover');
  assertEqual(root.querySelector('[data-recursion-status-trigger]').getAttribute('aria-expanded'), 'false', 'activity trigger reflects closed progress popover');
  assertEqual(fakeDocument.activeElement, root.querySelector('[data-recursion-status-trigger]'), 'closing progress restores focus to the trigger');
  root.querySelector('[data-recursion-status-trigger]').click();
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, false, 'activity trigger opens progress popover');
  assertEqual(root.querySelector('[data-recursion-status-trigger]').getAttribute('aria-expanded'), 'true', 'activity trigger reflects open progress popover');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-status-popover]')).includes('Utility card batch'), 'progress popover renders progress rows');
  const originalActivity = view.activity;
  const originalProgressRun = view.progressRun;
  const retryReason = 'Provider card batch retried once before this card completed.';
  view = {
    ...view,
    activity: { phase: 'settled', severity: 'warning', label: 'Recursion prompt ready.' },
    progressRun: {
      runId: 'ui-progress-retried',
      title: 'Needs attention',
      steps: [
        {
          id: 'utility-card-batch',
          label: 'Utility card batch',
          providerLane: 'utility',
          state: 'warning',
          children: [
            {
              id: 'scene-frame-card',
              label: 'Scene Frame',
              providerLane: 'utility',
              state: 'warning',
              source: 'generated',
              retryCount: 1,
              reason: retryReason
            }
          ]
        }
      ]
    }
  };
  ui.update();
  const retriedProgressRow = root.querySelectorAll('[data-recursion-progress-row]')
    .find((row) => row.dataset.recursionProgressStepId === 'scene-frame-card');
  assert(fakeDocument.textTree(retriedProgressRow).includes('retried'), 'retried generated card row shows visible retried meta');
  assertEqual(retriedProgressRow.dataset.recursionProgressReason, retryReason, 'retried generated card row carries safe reason metadata');
  assert(retriedProgressRow.getAttribute('title').includes(`Reason: ${retryReason}`), 'retried generated card row tooltip explains why it is yellow');
  view = {
    ...view,
    activity: originalActivity,
    progressRun: originalProgressRun
  };
  ui.update();
  root.querySelector('[data-recursion-actions]').click();
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, false, 'narrow options click opens settings panel');
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, true, 'narrow options click closes progress instead of hiding it behind settings');
  assertEqual(root.querySelector('[data-recursion-mobile-status-drawer]').hidden, true, 'opening settings hides the mobile status drawer');
  root.querySelector('[data-recursion-status-trigger]').click();
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, false, 'narrow status click reopens progress popover');
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, true, 'narrow status click closes settings instead of overlapping it');
  assertEqual(root.querySelector('[data-recursion-status-popover]').style.width, '640px', 'mobile progress popover spans the visible Recursion bar width');
  assertEqual(root.querySelector('[data-recursion-mobile-status-drawer]').hidden, true, 'opening progress hides the mobile status drawer');
  root.querySelector('[data-recursion-mode-button]').click();
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, true, 'mode menu closes progress popover to avoid left-lane overlap');
  assertEqual(root.querySelector('[data-recursion-mode-menu]').hidden, false, 'mode menu opens after closing progress popover');
  assertEqual(root.querySelector('[data-recursion-mobile-status-drawer]').hidden, true, 'opening mode menu keeps the mobile status drawer hidden');
  root.querySelector('[data-recursion-mode-choice-auto]').click();
  view = { ...view, settings: { ...view.settings, mode: 'auto', cardScope: defaultCardScope() } };
  ui.update();
  root.querySelector('[data-recursion-cards-button]').click();
  assertEqual(root.querySelector('[data-recursion-cards-panel]').hidden, false, 'Cards button opens card scope dropdown');
  assertEqual(root.querySelector('[data-recursion-mobile-status-drawer]').hidden, true, 'opening Cards hides the mobile status drawer');
  root.querySelector('[data-recursion-mode-button]').click({ ignoreStopPropagation: true });
  assertEqual(root.querySelector('[data-recursion-cards-panel]').hidden, true, 'mode button closes Cards dropdown on the same first click');
  assertEqual(root.querySelector('[data-recursion-mode-menu]').hidden, false, 'mode button opens mode selector on first click even when document outside-click also receives the event');
  root.querySelector('[data-recursion-mode-button]').click();
  assertEqual(root.querySelector('[data-recursion-mode-menu]').hidden, true, 'second mode button click closes mode selector after protected first-open behavior');
  root.querySelector('[data-recursion-cards-button]').click();
  assertEqual(root.querySelector('[data-recursion-cards-panel]').hidden, false, 'Cards button reopens card scope dropdown');
  assertEqual(root.querySelector('[data-recursion-cards-button]').getAttribute('aria-expanded'), 'true', 'Cards button reflects open scope dropdown');
  assertEqual(root.querySelector('[data-recursion-cards-panel]').style.left, '0px', 'Cards dropdown aligns to the full bar left edge');
  assertEqual(root.querySelector('[data-recursion-cards-panel]').style.width, '640px', 'Cards dropdown spans the full bar width');
  assertEqual(root.querySelector('[data-recursion-cards-panel]').style.maxHeight, '471px', 'Cards dropdown clamps to mobile visual viewport height with bottom gutter');
  assertEqual(
    fakeDocument.activeElement,
    root.querySelector('[data-recursion-card-deck-select]'),
    'opening Cards moves focus to the first enabled dropdown control'
  );
  globalThis.visualViewport.height = 360;
  globalThis.visualViewport.emit('resize');
  assertEqual(root.querySelector('[data-recursion-cards-panel]').style.maxHeight, '311px', 'Cards dropdown reclamps when mobile visual viewport height changes');
  globalThis.visualViewport.offsetTop = 40;
  globalThis.visualViewport.height = 360;
  globalThis.visualViewport.emit('scroll');
  assertEqual(root.querySelector('[data-recursion-cards-panel]').style.top, '40px', 'Cards dropdown top clamps to visualViewport offsetTop');
  assertEqual(root.querySelector('[data-recursion-cards-panel]').style.maxHeight, '346px', 'Cards dropdown includes visualViewport offsetTop in mobile clipping');
  globalThis.visualViewport.offsetLeft = 12;
  globalThis.visualViewport.width = 320;
  globalThis.visualViewport.emit('scroll');
  assertEqual(root.querySelector('[data-recursion-cards-panel]').style.left, '12px', 'Cards dropdown left edge clamps to visualViewport offsetLeft');
  assertEqual(root.querySelector('[data-recursion-cards-panel]').style.width, '320px', 'Cards dropdown right edge clamps inside the offset visual viewport');
  globalThis.visualViewport.offsetLeft = 0;
  globalThis.visualViewport.offsetTop = 0;
  globalThis.visualViewport.width = 640;
  globalThis.visualViewport.height = 520;
  globalThis.visualViewport.emit('resize');
  assert(root.querySelector('[data-recursion-card-deck-activate-all]'), 'Cards dropdown renders an activate-all deck action');
  assert(root.querySelector('[data-recursion-card-deck-deactivate-all]'), 'Cards dropdown renders a deactivate-all deck action');
  assertEqual(root.querySelector('[data-recursion-card-deck-activate-all]').disabled, true, 'Activate-all action is disabled when every runnable deck card is normal active');
  assertEqual(root.querySelector('[data-recursion-card-deck-deactivate-all]').disabled, true, 'Deactivate-all action is disabled on the read-only Default deck');
  assertEqual(root.querySelector('[data-recursion-card-deck-activate-all]').textContent, '', 'Cards deck activate-all action is icon-only');
  assertEqual(root.querySelector('[data-recursion-card-deck-deactivate-all]').textContent, '', 'Cards deck deactivate-all action is icon-only');
  assertEqual(root.querySelector('[data-recursion-card-deck-activate-all]').getAttribute('aria-label'), 'Duplicate this read-only Card Deck to edit cards.', 'read-only activate-all action explains the edit guard');
  assertEqual(root.querySelector('[data-recursion-card-deck-activate-all]').getAttribute('title'), 'Duplicate this read-only Card Deck to edit cards.', 'read-only activate-all title explains the edit guard');
  assertEqual(root.querySelector('[data-recursion-card-deck-deactivate-all]').getAttribute('aria-label'), 'Duplicate this read-only Card Deck to edit cards.', 'read-only deactivate-all action explains the edit guard');
  assertEqual(root.querySelectorAll('[data-recursion-card-scope-family]').length, 0, 'Cards dropdown removes legacy Card Scope family rows');
  assertEqual(root.querySelectorAll('[data-recursion-card-scope-sub-item-toggle]').length, 0, 'Cards dropdown removes legacy Card Scope sub-item rows');
  assertEqual(root.querySelectorAll('[data-recursion-card-deck-category]').length, CARD_SCOPE_CATALOG.length, 'Cards dropdown renders Default deck categories as the primary surface');
  assertEqual(root.querySelectorAll('[data-recursion-card-id]').length, 0, 'Cards dropdown defaults categories to collapsed instead of rendering every card');
  assertEqual(root.querySelector('[data-recursion-card-category-toggle]').getAttribute('aria-expanded'), 'false', 'collapsed category headers expose aria-expanded false');
  assert(root.querySelector('[data-recursion-card-category-toggle]').children[0]?.className.includes('recursion-card-deck-category-arrow'), 'collapsed category headers render a disclosure arrow');
  const defaultDeckText = fakeDocument.textTree(root.querySelector('[data-recursion-cards-panel]'));
  assert(defaultDeckText.includes('34/34 active'), 'Cards header summarizes active cards in the active deck');
  assert(!defaultDeckText.includes('Default is read-only'), 'Cards dropdown removes read-only status notice rows');
  root.querySelector('[data-recursion-card-category-toggle]').click();
  assertEqual(root.querySelector('[data-recursion-card-category-toggle]').getAttribute('aria-expanded'), 'true', 'clicking the category header expands the category');
  assert(root.querySelectorAll('[data-recursion-card-id]').length > 0, 'expanded category renders its cards');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-cards-panel]')).includes('beat constraint'), 'expanded category renders Default deck card names');

  root.querySelector('[data-recursion-card-deck-duplicate]').click();
  const duplicatedDeckId = settingsUpdates.at(-1).cardDecks.activeCardDeckId;
  let duplicatedDeck = settingsUpdates.at(-1).cardDecks.customCardDecks[duplicatedDeckId];
  const disableCardId = Object.keys(duplicatedDeck.cards)[0];
  duplicatedDeck = {
    ...duplicatedDeck,
    cards: {
      ...duplicatedDeck.cards,
      [disableCardId]: {
        ...duplicatedDeck.cards[disableCardId],
        selectionState: 'off'
      }
    }
  };
  view = {
    ...view,
    settings: {
      ...view.settings,
      cardDecks: {
        ...settingsUpdates.at(-1).cardDecks,
        customCardDecks: {
          ...settingsUpdates.at(-1).cardDecks.customCardDecks,
          [duplicatedDeckId]: duplicatedDeck
        }
      }
    }
  };
  ui.update();
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-cards-panel]')).includes('33/34 active'), 'Cards header reflects inactive cards in the active deck');
  assertEqual(root.querySelector('[data-recursion-card-deck-activate-all]').disabled, false, 'Activate-all action enables when any runnable deck card is inactive');
  assertEqual(root.querySelector('[data-recursion-card-deck-activate-all]').getAttribute('title'), 'Set all runnable cards to Active.', 'enabled activate-all action explains active deck restoration');
  root.querySelector('[data-recursion-card-deck-activate-all]').click();
  const allDeckUpdate = settingsUpdates.at(-1).cardDecks;
  assertEqual(allDeckUpdate.customCardDecks[duplicatedDeckId].cards[disableCardId].selectionState, 'active', 'Activate-all action enables inactive runnable cards');
  assert(!settingsUpdates.at(-1).cardScope, 'Deck All action does not write legacy cardScope');
  view = { ...view, settings: { ...view.settings, cardDecks: allDeckUpdate }, activity: { phase: 'idle' }, progressRun: null };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-card-deck-activate-all]').disabled, true, 'Activate-all action disables again after all runnable cards are normal active');
  root.querySelector('[data-recursion-card-category-toggle]').click();
  root.querySelector('[data-recursion-card-toggle-row]').click();
  const priorityUpdate = settingsUpdates.at(-1).cardDecks;
  assertEqual(priorityUpdate.customCardDecks[duplicatedDeckId].cards[disableCardId].selectionState, 'priority', 'Auto row tap promotes active card to Priority');
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, 'Card prioritized.', 'Card System action feedback routes through main bar status');
  view = { ...view, settings: { ...view.settings, cardDecks: priorityUpdate }, activity: { phase: 'idle' }, progressRun: null };
  ui.update();
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-cards-panel]')).includes('1 priority'), 'Cards header reports Priority count when cards are prioritized');
  assertEqual(root.querySelector('[data-recursion-card-deck-activate-all]').disabled, false, 'Activate-all action enables when it can clear Priority states');
  root.querySelector('[data-recursion-card-deck-activate-all]').click();
  const priorityClearedUpdate = settingsUpdates.at(-1).cardDecks;
  assertEqual(priorityClearedUpdate.customCardDecks[duplicatedDeckId].cards[disableCardId].selectionState, 'active', 'Activate-all action clears Priority back to normal Active');
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, 'All cards set Active.', 'Activate-all action reports through main bar status');
  view = { ...view, settings: { ...view.settings, cardDecks: priorityClearedUpdate }, activity: { phase: 'idle' }, progressRun: null };
  ui.update();
  root.querySelector('[data-recursion-card-deck-deactivate-all]').click();
  const deactivatedUpdate = settingsUpdates.at(-1).cardDecks;
  assertEqual(deactivatedUpdate.customCardDecks[duplicatedDeckId].cards[disableCardId].selectionState, 'off', 'Deactivate-all action turns runnable cards inactive');
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, 'All cards disabled.', 'Deactivate-all action reports through main bar status');
  view = { ...view, activity: originalActivity, progressRun: originalProgressRun };
  ui.update();

  root.querySelector('[data-recursion-reasoning-level-high]').keydown({ key: 'ArrowRight' });
  assertEqual(settingsUpdates.at(-1).reasoningLevel, 'ultra', 'ArrowRight advances reasoning roving selection');
  assertEqual(fakeDocument.activeElement, root.querySelector('[data-recursion-reasoning-level-ultra]'), 'ArrowRight moves focus to the next reasoning node');
  view = { ...view, settings: { ...view.settings, reasoningLevel: 'ultra' } };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-reasoning-level-ultra]').getAttribute('tabindex'), '0', 'roving tab stop follows selected reasoning level after update');
  root.querySelector('[data-recursion-reasoning-level-ultra]').keydown({ key: 'Home' });
  assertEqual(settingsUpdates.at(-1).reasoningLevel, 'low', 'Home moves reasoning roving selection to Low');
  assertEqual(fakeDocument.activeElement, root.querySelector('[data-recursion-reasoning-level-low]'), 'Home moves focus to the Low reasoning node');
  assertEqual(
    root.querySelector('[data-recursion-progress-list]').style.props['--recursion-progress-list-limit'],
    '15',
    'progress popover applies visible progress list limit'
  );
  assertEqual(
    root.querySelector('[data-recursion-progress-children]').style.props['--recursion-progress-child-limit'],
    '5',
    'progress popover applies visible child row limit'
  );
  root.querySelector('[data-recursion-reasoning-level-low]').click();
  assertDeepEqual(
    settingsUpdates.at(-1),
    { reasoningLevel: 'low', reasonerUse: 'off' },
    'reasoning chain maps Low to Utility-only routing'
  );
  root.querySelector('[data-recursion-reasoning-level-medium]').click();
  assertDeepEqual(
    settingsUpdates.at(-1),
    { reasoningLevel: 'medium', reasonerUse: 'always' },
    'reasoning chain maps Medium to Reasoner composition routing'
  );
  root.querySelector('[data-recursion-reasoning-level-ultra]').click();
  assertDeepEqual(
    settingsUpdates.at(-1),
    { reasoningLevel: 'ultra', reasonerUse: 'always' },
    'reasoning chain maps Ultra to Reasoner-heavy routing'
  );
  root.querySelector('[data-recursion-reasoning-level-high]').click();
  assertDeepEqual(
    settingsUpdates.at(-1),
    { reasoningLevel: 'high', reasonerUse: 'always' },
    'reasoning chain maps High to Reasoner-priority routing'
  );
  assertEqual(
    root.querySelector('[data-recursion-current-step]').textContent,
    'Reasoning Level: High',
    'reasoning chain prints a brief current-step acknowledgement'
  );
  assertEqual(
    root.querySelector('[data-recursion-hero-array]').children.length,
    1,
    'reasoning acknowledgement does not add Hero Pixel Array progress blocks'
  );
  runNextTimeout(2000);
  assertEqual(
    root.querySelector('[data-recursion-current-step]').textContent,
    'Utility card batch...',
    'reasoning acknowledgement clears after two seconds when no new status arrives'
  );

  globalThis.innerWidth = 920;
  globalThis.visualViewport.width = 920;
  root.querySelector('[data-recursion-bar]').setBoundingClientRect({ left: 0, top: 0, width: 920, height: 30, right: 920, bottom: 30 });
  root.querySelector('[data-recursion-actions]').click();
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, false, 'options button opens settings panel directly');
  assertEqual(root.querySelector('[data-recursion-actions]').getAttribute('aria-expanded'), 'true', 'options button reflects open settings state');
  assertEqual(root.querySelector('[data-recursion-settings-panel]').style.left, '0px', 'settings panel aligns to full bar left edge on wide desktop');
  assertEqual(root.querySelector('[data-recursion-settings-panel]').style.width, '920px', 'settings panel spans the full bar width on wide desktop');
  assert(!root.querySelector('[data-recursion-settings-panel]').className.includes('is-beside-progress'), 'settings panel no longer uses side-by-side progress layout');
  root.querySelector('[data-recursion-actions]').click({ isTrusted: false });
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, false, 'scripted options staging click cannot close an open settings panel');
  assertEqual(root.querySelector('[data-recursion-actions]').getAttribute('aria-expanded'), 'true', 'scripted options staging click preserves open settings state');
  assert(root.querySelector('[data-recursion-settings-tabs]'), 'settings menu renders tab controls');
  assert(root.querySelector('[data-recursion-settings-play]'), 'settings menu renders Play pane');
  assert(root.querySelector('[data-recursion-settings-providers]'), 'settings menu renders Providers pane');
  assert(root.querySelector('[data-recursion-settings-advanced]'), 'settings menu renders Advanced pane');
  assert(root.querySelector('[data-recursion-settings-panel]').querySelector('[data-recursion-viewer-toggle]'), 'settings menu renders visible Full Viewer entry point');
  assert(!root.querySelector('[data-recursion-settings-save]'), 'settings menu does not render a Save Settings button');
  assert(!root.querySelector('[data-recursion-settings-close]'), 'settings menu does not render a redundant close button');
  assertEqual(root.querySelector('[data-recursion-settings-play]').hidden, false, 'Play pane is the default settings tab');
  assertEqual(root.querySelector('[data-recursion-settings-providers]').hidden, true, 'Providers pane starts tucked behind a tab');
  assert(!root.querySelector('[data-recursion-setting-mode]'), 'Play settings remove redundant mode control owned by compact bar');
  assert(!root.querySelector('[data-recursion-setting-reasoning-chain]'), 'Play settings remove redundant reasoning control owned by compact bar');
  assert(root.querySelector('[data-recursion-settings-section-play-behavior]'), 'Play settings groups behavior controls in one disclosure section');
  assertEqual(root.querySelector('[data-recursion-settings-section-body-play-behavior]').hidden, false, 'Play behavior section defaults open');
  root.querySelector('[data-recursion-settings-section-toggle-play-behavior]').click();
  assertEqual(root.querySelector('[data-recursion-settings-section-body-play-behavior]').hidden, true, 'Play behavior section collapses');
  root.querySelector('[data-recursion-settings-section-toggle-play-behavior]').click();
  assertEqual(root.querySelector('[data-recursion-settings-section-body-play-behavior]').hidden, false, 'Play behavior section expands');
  providerProfileServiceCalls = 0;
  root.querySelector('[data-recursion-settings-tab-providers]').click();
  assertEqual(providerProfileServiceCalls, 1, 'Providers pane renders both lane profile comboboxes from one host profile lookup');
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, false, 'settings tab click keeps settings panel open');
  assertEqual(root.querySelector('[data-recursion-settings-play]').hidden, true, 'clicking Providers hides Play pane');
  assertEqual(root.querySelector('[data-recursion-settings-providers]').hidden, false, 'clicking Providers shows provider controls');
  assert(root.querySelector('[data-recursion-provider-status-reasoner]').textContent.toLowerCase().includes('pass'), 'enabled Reasoner provider renders its test status instead of optional');
  assertEqual(root.querySelector('[data-recursion-provider-body-utility]').hidden, false, 'Utility provider section defaults open');
  assertEqual(root.querySelector('[data-recursion-provider-body-reasoner]').hidden, true, 'Reasoner provider section defaults collapsed');
  root.querySelector('[data-recursion-provider-toggle-utility]').click();
  assertEqual(root.querySelector('[data-recursion-provider-body-utility]').hidden, true, 'Utility provider section collapses');
  root.querySelector('[data-recursion-provider-toggle-utility]').click();
  assertEqual(root.querySelector('[data-recursion-provider-body-utility]').hidden, false, 'Utility provider section expands');
  root.querySelector('[data-recursion-provider-toggle-reasoner]').click();
  assertEqual(root.querySelector('[data-recursion-provider-body-reasoner]').hidden, false, 'Reasoner provider section expands');
  assert(root.querySelector('[data-recursion-provider-model-reasoner]'), 'Reasoner provider expansion exposes model setting');
  const reasonerSourceBeforeAutosave = root.querySelector('[data-recursion-provider-source-reasoner]');
  const providerUpdatesBeforeReasonerAutosave = providerUpdates.length;
  reasonerSourceBeforeAutosave.value = 'host-connection-profile';
  for (const listener of root.querySelector('[data-recursion-settings-panel]').eventListeners.change || []) {
    listener({ target: reasonerSourceBeforeAutosave });
  }
  await Promise.resolve();
  await Promise.resolve();
  assertEqual(providerUpdates.length, providerUpdatesBeforeReasonerAutosave + 1, 'Reasoner provider autosave runs from expanded section');
  assertEqual(providerUpdates.at(-1).lane, 'reasoner', 'Reasoner provider autosave targets reasoner lane');
  assertEqual(root.querySelector('[data-recursion-provider-body-reasoner]').hidden, false, 'Reasoner provider stays expanded after provider autosave rerender');
  assertEqual(root.querySelector('[data-recursion-provider-toggle-reasoner]').getAttribute('aria-expanded'), 'true', 'Reasoner provider toggle keeps expanded state after provider autosave rerender');
  const utilitySource = root.querySelector('[data-recursion-provider-source-utility]');
  const utilityProfileContext = root.querySelector('[data-recursion-provider-context-profile-utility]');
  const utilityOpenAiContext = root.querySelector('[data-recursion-provider-context-open-ai-utility]');
  const utilityClearKey = root.querySelector('[data-recursion-utility-provider-clear-key]');
  assertEqual(utilitySource.getAttribute('title'), 'Choose where this lane sends Recursion model calls. Current Host Model follows the active chat model; Host Connection Profile uses a saved SillyTavern profile; OpenAI-Compatible uses the endpoint fields below. Changes auto-save; hidden alternate-source fields keep their values.', 'provider Source control explains autosave and hidden field persistence');
  assertEqual(root.querySelector('[data-recursion-provider-base-url-utility]').getAttribute('title'), 'Base /v1 URL for a direct OpenAI-compatible endpoint. Only used when Source is OpenAI-Compatible.', 'provider Base URL explains source-specific endpoint use');
  assertEqual(root.querySelector('[data-recursion-provider-api-key-utility]').getAttribute('title'), 'Session-only key for the OpenAI-compatible endpoint. Recursion keeps it in memory and never writes it to settings or diagnostics.', 'provider API key tooltip explains secret boundary');
  assert(utilityClearKey, 'Utility provider renders a clear session key action for OpenAI sources');
  assert(root.querySelector('[data-recursion-provider-readiness-utility]'), 'Utility provider renders compact readiness status before test');
  const utilityReadinessText = fakeDocument.textTree(root.querySelector('[data-recursion-provider-readiness-utility]'));
  assert(utilityReadinessText.includes('Source: Current Host Model'), 'readiness status names the active source as a source');
  assert(utilityReadinessText.includes('Host model: gpt-4-turbo'), 'readiness status keeps the current host model separate from provider identity');
  assert(!utilityReadinessText.includes('Current Host Model /'), 'readiness status does not combine source and model with a provider-like slash label');
  assert(root.querySelector('[data-recursion-provider-route-summary]'), 'Providers pane renders compact route summary instead of hidden deep routing');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-provider-route-summary]')).includes('Arbiter'), 'route summary exposes Arbiter routing');
  assert(utilityProfileContext, 'Utility provider renders a profile-specific field context');
  assert(utilityOpenAiContext, 'Utility provider renders an OpenAI-specific field context');
  assertEqual(utilityProfileContext.hidden, true, 'Current Host Model hides Utility profile fields');
  assertEqual(utilityOpenAiContext.hidden, true, 'Current Host Model hides Utility OpenAI endpoint fields');
  assertEqual(utilityClearKey.hidden, true, 'Current Host Model hides Utility clear session key action');
  const utilityProfileValue = root.querySelector('[data-recursion-provider-profile-utility]');
  const utilityProfileFilter = root.querySelector('[data-recursion-provider-profile-filter-utility]');
  const utilityProfileList = root.querySelector('[data-recursion-provider-profile-list-utility]');
  assertEqual(utilityProfileValue.tagName, 'INPUT', 'Host Connection Profile stores a committed hidden profile id, not the typed filter text');
  assertEqual(utilityProfileValue.getAttribute('type'), 'hidden', 'committed profile id stays hidden from the search field');
  assertEqual(utilityProfileFilter.tagName, 'INPUT', 'Host Connection Profile renders a searchable profile input');
  assertEqual(utilityProfileFilter.getAttribute('role'), 'combobox', 'searchable profile input exposes combobox semantics');
  assertEqual(utilityProfileFilter.getAttribute('aria-expanded'), 'false', 'profile combobox starts collapsed');
  assertEqual(utilityProfileFilter.getAttribute('title'), 'Saved SillyTavern Connection Profile for this lane. Type to filter detected profiles; selection saves only when a listed profile is chosen. Profiles keep routing, preset, and keys in SillyTavern.', 'profile combobox tooltip explains filter and selection behavior');
  assert(utilityProfileList, 'profile combobox renders a scrollable option list');
  assert(utilityProfileList.className.includes('recursion-provider-profile-list'), 'profile combobox list owns the scrollable list class');
  utilitySource.value = 'host-connection-profile';
  for (const listener of utilitySource.eventListeners.change || []) listener({ target: utilitySource });
  assertEqual(utilityProfileContext.hidden, false, 'Host Connection Profile shows Utility profile fields');
  assertEqual(utilityOpenAiContext.hidden, true, 'Host Connection Profile hides Utility OpenAI endpoint fields');
  assertEqual(utilityClearKey.hidden, true, 'Host Connection Profile hides Utility clear session key action');
  const providerUpdatesBeforeProfileSearch = providerUpdates.length;
  utilityProfileFilter.focus();
  utilityProfileFilter.value = 'deep';
  utilityProfileFilter.dispatchEvent({ type: 'input', target: utilityProfileFilter });
  assertEqual(utilityProfileValue.value, '', 'typing in profile combobox does not autosave a partial profile id');
  assertEqual(providerUpdates.length, providerUpdatesBeforeProfileSearch, 'typing in profile combobox does not send a provider autosave');
  assertEqual(utilityProfileFilter.getAttribute('aria-expanded'), 'true', 'typing opens the filtered profile list');
  assertEqual(utilityProfileList.hidden, false, 'typing shows filtered profile matches');
  assertDeepEqual(
    utilityProfileList.children.map((option) => option.textContent),
    ['Deep Reasoner / o-reasoner'],
    'profile combobox filters visible options by typed profile text'
  );
  utilityProfileList.children[0].click();
  assertEqual(utilityProfileValue.value, 'deep-profile-b', 'choosing a filtered profile commits the detected profile id');
  assertEqual(utilityProfileFilter.value, 'Deep Reasoner / o-reasoner', 'choosing a filtered profile restores the selected profile label');
  assertEqual(utilityProfileFilter.getAttribute('aria-expanded'), 'false', 'choosing a profile closes the filtered list');
  const filteredProfileReadiness = fakeDocument.textTree(root.querySelector('[data-recursion-provider-readiness-utility]'));
  assertEqual(filteredProfileReadiness.includes('Profile: Deep Reasoner'), true, 'choosing a filtered profile updates readiness profile copy');
  assertEqual(filteredProfileReadiness.includes('Model: o-reasoner'), true, 'choosing a filtered profile updates readiness model copy');
  assertEqual(providerUpdates.length, providerUpdatesBeforeProfileSearch + 1, 'choosing a filtered profile autosaves once');
  assertEqual(providerUpdates.at(-1).patch.hostConnectionProfileId, 'deep-profile-b', 'profile autosave records the selected detected profile id');
  const selectedProfileFilter = root.querySelector('[data-recursion-provider-profile-filter-utility]');
  const selectedProfileList = root.querySelector('[data-recursion-provider-profile-list-utility]');
  selectedProfileFilter.click();
  assertEqual(selectedProfileFilter.getAttribute('aria-expanded'), 'true', 'clicking selected profile opens the dropdown');
  assert(selectedProfileList.children.length > 20, 'clicking selected profile shows the full scrollable profile dropdown instead of only the selected profile');
  const currentUtilitySource = root.querySelector('[data-recursion-provider-source-utility]');
  const currentUtilityProfileContext = root.querySelector('[data-recursion-provider-context-profile-utility]');
  const currentUtilityOpenAiContext = root.querySelector('[data-recursion-provider-context-open-ai-utility]');
  const currentUtilityClearKey = root.querySelector('[data-recursion-utility-provider-clear-key]');
  currentUtilitySource.value = 'openai-compatible';
  for (const listener of currentUtilitySource.eventListeners.change || []) listener({ target: currentUtilitySource });
  assertEqual(currentUtilityProfileContext.hidden, true, 'OpenAI-Compatible hides Utility profile fields');
  assertEqual(currentUtilityOpenAiContext.hidden, false, 'OpenAI-Compatible shows Utility endpoint/model/key fields');
  assertEqual(currentUtilityClearKey.hidden, false, 'OpenAI-Compatible shows Utility clear session key action');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-provider-readiness-utility]')).includes('OpenAI-Compatible Endpoint'), 'readiness status follows unsaved provider source changes');
  assert(root.querySelector('[data-recursion-provider-fetch-models-utility]'), 'OpenAI-Compatible settings expose Fetch Models control');
  assert(root.querySelector('[data-recursion-provider-model-list-utility]'), 'OpenAI-Compatible settings expose fetched model selector');
  assert(!root.querySelector('[data-recursion-utility-provider-save]'), 'Providers pane does not render a needless Save Provider button');
  root.querySelector('[data-recursion-provider-base-url-utility]').value = 'https://models.example/v1';
  root.querySelector('[data-recursion-provider-api-key-utility]').value = 'sk-ui-secret';
  root.querySelector('[data-recursion-provider-fetch-models-utility]').click();
  await Promise.resolve();
  await Promise.resolve();
  assertEqual(providerModelFetches.at(-1).lane, 'utility', 'Fetch Models targets Utility lane');
  assertEqual(providerModelFetches.at(-1).patch.openAICompatible.baseUrl, 'https://models.example/v1', 'Fetch Models forwards current endpoint field');
  assertEqual(providerModelFetches.at(-1).patch.apiKey, 'sk-ui-secret', 'Fetch Models forwards current session key without rendering it');
  assertDeepEqual(
    root.querySelector('[data-recursion-provider-model-list-utility]').children.map((option) => [option.value, option.textContent]),
    [
      ['', 'Select fetched model'],
      ['alpha-model', 'Alpha Model'],
      ['beta-model', 'beta-model']
    ],
    'Fetch Models populates direct model selector'
  );
  root.querySelector('[data-recursion-provider-model-list-utility]').value = 'alpha-model';
  for (const listener of root.querySelector('[data-recursion-provider-model-list-utility]').eventListeners.change || []) {
    listener({ target: root.querySelector('[data-recursion-provider-model-list-utility]') });
  }
  assertEqual(root.querySelector('[data-recursion-provider-model-utility]').value, 'alpha-model', 'fetched model selector writes selected model id into model input');
  const reasonerSource = root.querySelector('[data-recursion-provider-source-reasoner]');
  const reasonerProfileContext = root.querySelector('[data-recursion-provider-context-profile-reasoner]');
  const reasonerOpenAiContext = root.querySelector('[data-recursion-provider-context-open-ai-reasoner]');
  reasonerSource.value = 'host-connection-profile';
  for (const listener of reasonerSource.eventListeners.change || []) listener({ target: reasonerSource });
  assertEqual(reasonerProfileContext.hidden, false, 'Host Connection Profile shows Reasoner profile fields');
  assertEqual(reasonerOpenAiContext.hidden, true, 'Host Connection Profile hides Reasoner OpenAI endpoint fields');
  root.querySelector('[data-recursion-settings-tab-advanced]').click({ ignoreStopPropagation: true });
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, false, 'settings tab click keeps settings panel open even when document outside-click also receives the rerendered event');
  assertEqual(root.querySelector('[data-recursion-settings-advanced]').hidden, false, 'clicking Advanced shows advanced controls');
  assert(root.querySelector('[data-recursion-settings-section-injection]'), 'Advanced settings groups injection controls');
  assert(root.querySelector('[data-recursion-settings-section-ui]'), 'Advanced settings groups UI controls');
  assert(root.querySelector('[data-recursion-settings-section-retention]'), 'Advanced settings groups retention controls');
  assert(root.querySelector('[data-recursion-settings-section-diagnostics]'), 'Advanced settings groups diagnostics controls');
  assertEqual(root.querySelector('[data-recursion-settings-section-body-injection]').hidden, false, 'Injection section defaults open');
  assertEqual(root.querySelector('[data-recursion-settings-section-body-ui]').hidden, false, 'UI section defaults open');
  assertEqual(root.querySelector('[data-recursion-settings-section-body-retention]').hidden, false, 'Retention section defaults open');
  assertEqual(root.querySelector('[data-recursion-settings-section-body-diagnostics]').hidden, false, 'Diagnostics section defaults open');
  root.querySelector('[data-recursion-settings-section-toggle-injection]').click();
  assertEqual(root.querySelector('[data-recursion-settings-section-body-injection]').hidden, true, 'Injection section collapses');
  root.querySelector('[data-recursion-settings-section-toggle-injection]').click();
  assertEqual(root.querySelector('[data-recursion-settings-section-body-injection]').hidden, false, 'Injection section expands');
  assertEqual(root.querySelector('[data-recursion-clear-run-journal]').disabled, false, 'Clear Run Journal is enabled when runtime handler exists');
  assertEqual(root.querySelector('[data-recursion-export-diagnostics]').disabled, false, 'Export Diagnostics is enabled when runtime handler exists');
  assertEqual(root.querySelector('[data-recursion-reset-scene-cache]').disabled, false, 'Reset Scene Cache is enabled when runtime handler exists');
  assert(root.querySelector('[data-recursion-setting-injection-placement]'), 'Advanced settings render injection placement control');
  assert(root.querySelector('[data-recursion-setting-injection-role]'), 'Advanced settings render injection role control');
  assert(root.querySelector('[data-recursion-setting-injection-depth]'), 'Advanced settings render injection depth control');
  assert(root.querySelector('[data-recursion-setting-source-window-messages]'), 'Retention renders source message cap');
  assert(root.querySelector('[data-recursion-setting-source-window-characters]'), 'Retention renders source character budget');
  assert(root.querySelector('[data-recursion-setting-provider-visible-messages]'), 'Retention renders provider message cap');
  assert(root.querySelector('[data-recursion-setting-scene-caches-per-chat]'), 'Retention renders per-chat scene cache cap');
  assert(root.querySelector('[data-recursion-setting-scene-caches-total]'), 'Retention renders total scene cache cap');
  assert(root.querySelector('[data-recursion-setting-source-variants-per-scene]'), 'Retention renders source variant cap');
  assert(root.querySelector('[data-recursion-setting-run-journal-entries]'), 'Retention renders journal entry cap');
  const typedIntegerSettingSelectors = [
    '[data-recursion-setting-min-cards]',
    '[data-recursion-setting-max-cards]',
    '[data-recursion-setting-progress-child-limit]',
    '[data-recursion-setting-progress-list-limit]',
    '[data-recursion-setting-source-window-messages]',
    '[data-recursion-setting-source-window-characters]',
    '[data-recursion-setting-provider-visible-messages]',
    '[data-recursion-setting-scene-caches-per-chat]',
    '[data-recursion-setting-scene-caches-total]',
    '[data-recursion-setting-source-variants-per-scene]',
    '[data-recursion-setting-run-journal-entries]',
    '[data-recursion-provider-max-tokens-utility]',
    '[data-recursion-provider-max-tokens-reasoner]'
  ];
  assertDeepEqual(
    typedIntegerSettingSelectors.map((selector) => root.querySelector(selector)?.getAttribute('type')),
    typedIntegerSettingSelectors.map(() => 'text'),
    'visible numeric settings render as typed integer text boxes instead of native number spinners'
  );
  assertDeepEqual(
    typedIntegerSettingSelectors.map((selector) => root.querySelector(selector)?.getAttribute('inputmode')),
    typedIntegerSettingSelectors.map(() => 'numeric'),
    'visible numeric settings request numeric keyboard input without native spinner controls'
  );
  assertDeepEqual(
    typedIntegerSettingSelectors.map((selector) => root.querySelector(selector)?.getAttribute('pattern')),
    typedIntegerSettingSelectors.map(() => '[0-9]*'),
    'visible numeric settings constrain typed values to integer-shaped input'
  );
  assertEqual(
    root.querySelector('[data-recursion-setting-source-window-messages]').getAttribute('min'),
    '12',
    'source message cap min exposed'
  );
  assertEqual(
    root.querySelector('[data-recursion-setting-run-journal-entries]').getAttribute('max'),
    '500',
    'journal entry cap max exposed'
  );
  assertEqual(root.querySelector('[data-recursion-setting-injection-placement]').getAttribute('title'), 'Choose the SillyTavern prompt lane for the composed Recursion packet. In Prompt is the recommended default; In Chat can help presets that weight recent chat harder.', 'Injection placement tooltip explains what it changes and why');
  assertEqual(root.querySelector('[data-recursion-setting-tooltips-enabled]').getAttribute('title'), 'Show hover help across Recursion. Turn off once the controls are familiar; hidden text never affects model calls.', 'Tooltip setting explains its effect and safety boundary');
  assertDeepEqual(
    root.querySelector('[data-recursion-setting-injection-placement]').children.map((option) => option.value),
    ['in_prompt', 'in_chat'],
    'injection placement omits the Default sentinel option'
  );
  assertDeepEqual(
    root.querySelector('[data-recursion-setting-injection-depth]').children.map((option) => option.value),
    Array.from({ length: 11 }, (_, index) => String(index)),
    'injection depth omits the Default sentinel option'
  );
  assertEqual(root.querySelector('[data-recursion-setting-injection-placement]').value, 'in_prompt', 'injection placement defaults to the concrete prompt lane');
  assertEqual(root.querySelector('[data-recursion-setting-injection-role]').value, 'system', 'injection role defaults to system');
  assertEqual(root.querySelector('[data-recursion-setting-injection-depth]').value, '1', 'injection depth defaults to the concrete recommended depth');
  root.querySelector('[data-recursion-reset-scene-cache]').click();
  assertEqual(resetSceneCacheCalls, 1, 'Reset Scene Cache action calls runtime');
  root.querySelector('[data-recursion-clear-run-journal]').click();
  assertEqual(clearRunJournalCalls, 1, 'Clear Run Journal action calls runtime');
  root.querySelector('[data-recursion-export-diagnostics]').click();
  await Promise.resolve();
  assertEqual(exportDiagnosticsCalls, 1, 'Export Diagnostics action calls runtime');
  assert(copied.at(-1).includes('recursion.diagnostics.v1'), 'Export Diagnostics copies sanitized diagnostics JSON');
  assert(root.querySelector('[data-recursion-provider-grid]'), 'Providers pane renders the compact reference provider grid');
  assertEqual(root.querySelectorAll('[data-recursion-provider-section]').length, 2, 'Providers pane renders Utility plus collapsed Reasoner sections');
  assert(root.querySelector('[data-recursion-provider-model-reasoner]'), 'Reasoner provider section owns complete provider settings when expanded');
  assertEqual(root.querySelector('[data-recursion-provider-temperature-utility]').getAttribute('type'), 'hidden', 'provider temperature stays hidden from the compact mockup UI');
  assertEqual(root.querySelector('[data-recursion-provider-top-p-utility]').getAttribute('type'), 'hidden', 'provider top-p stays hidden from the compact mockup UI');
  fakeDocument.body.click();
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, true, 'outside click closes settings panel without a header close button');
  assertEqual(root.querySelector('[data-recursion-actions]').getAttribute('aria-expanded'), 'false', 'options button reflects closed settings state');
  assertEqual(fakeDocument.activeElement, root.querySelector('[data-recursion-actions]'), 'outside click close restores focus to the settings trigger');

  root.querySelector('[data-recursion-hand-toggle]').click();
  assertEqual(root.querySelector('[data-recursion-hand-dropdown]').hidden, false, 'brief dropdown button opens Last Brief');
  assertEqual(root.querySelector('[data-recursion-hand-toggle]').getAttribute('aria-expanded'), 'true', 'brief dropdown trigger reflects open state');
  assertEqual(fakeDocument.activeElement, root.querySelector('[data-recursion-prompt-packet-button]'), 'opening Last Brief moves focus to its first control');
  const briefCard = root.querySelector('[data-recursion-brief-card]');
  assert(briefCard.dataset.recursionBriefCardId, 'brief card keeps per-card id for expansion persistence');
  assertEqual(briefCard.getAttribute('aria-expanded'), 'false', 'brief card starts compact');
  assert(briefCard.getAttribute('title').includes('Scene Frame'), 'brief card hover identifies the card family');
  assert(briefCard.getAttribute('title').includes('anchors the blocked exit'), 'brief card hover explains why the card was included');
  assert(briefCard.querySelector('[data-recursion-brief-card-icon]').querySelector('svg'), 'brief card uses category SVG icon');
  assert(briefCard.querySelector('[data-recursion-brief-card-text]'), 'brief card renders text in the mockup card body');
  assert(briefCard.querySelector('[data-recursion-brief-card-meta]'), 'brief card renders compact meta chip row');
  const briefCardChips = Array.from(briefCard.querySelector('[data-recursion-brief-card-meta]').children)
    .map((chip) => chip.textContent);
  assertDeepEqual(briefCardChips, ['strong'], 'clean generated Last Brief card shows only meaningful priority chip');
  assert(!briefCardChips.includes('active'), 'Last Brief card omits redundant active chip');
  assert(!briefCardChips.includes('standard'), 'Last Brief card omits detail profile chip from compact rows');
  assert(!briefCardChips.includes('generated'), 'Last Brief card omits routine generated chip');
  const cachedBriefCard = root.querySelectorAll('[data-recursion-brief-card]')[1];
  const cachedBriefCardChips = Array.from(cachedBriefCard.querySelector('[data-recursion-brief-card-meta]').children)
    .map((chip) => chip.textContent);
  assertDeepEqual(cachedBriefCardChips, ['cached'], 'cached Last Brief card uses a high-value cached chip');
  briefCard.click();
  assertEqual(briefCard.getAttribute('aria-expanded'), 'true', 'brief card expands on click');
  assert(fakeDocument.textTree(briefCard).includes('Door stays blocked and the brass lock remains warped.'), 'expanded brief card exposes full card text');
  assert(!fakeDocument.textTree(briefCard).includes('standard'), 'expanded brief card still keeps detail profile out of compact trust chips');
  const packetButton = root.querySelector('[data-recursion-prompt-packet-button]');
  assert(packetButton, 'last brief renders Prompt Packet button');
  packetButton.click();
  assertEqual(root.querySelector('[data-recursion-prompt-packet-panel]').hidden, false, 'Prompt Packet button opens composed packet panel');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('Guidance composed'), 'prompt packet panel renders composer lane meta chip');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('1 card'), 'prompt packet panel renders card count meta chip');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('Recursion Guidance'), 'prompt packet panel renders guidance block title');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('Recursion Card Evidence'), 'prompt packet panel renders card evidence block title');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('GUIDANCE_UI_MARKER'), 'prompt packet panel renders provider guidance');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('SOCIAL_SUBTEXT_UI_MARKER'), 'prompt packet panel renders raw Social Subtext evidence');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('Door stays blocked and the brass lock remains warped.'), 'prompt packet panel renders actual injected prompt text');
  assert(!root.querySelector('[data-recursion-prompt-packet-preview]').textContent.includes('"packetId"'), 'prompt packet panel does not show the packet JSON wrapper');
  assert(root.querySelector('[data-recursion-prompt-packet-preview]').textContent.includes('Card evidence:\n- [Scene Frame]'), 'prompt packet panel preserves injected prompt line breaks');
  const progressList = root.querySelector('[data-recursion-progress-list]');
  const progressRow = root.querySelector('[data-recursion-progress-row]');
  const progressChildren = root.querySelector('[data-recursion-progress-children]');
  const briefScroll = root.querySelector('[data-recursion-brief-scroll]');
  const packetPreview = root.querySelector('[data-recursion-prompt-packet-preview]');
  const packetPreviewParent = packetPreview.parentNode;
  progressList.scrollTop = 48;
  progressChildren.scrollTop = 36;
  briefScroll.scrollTop = 44;
  packetPreview.scrollTop = 52;
  ui.update();
  assertEqual(root.querySelector('[data-recursion-progress-list]'), progressList, 'progress list node is preserved across rerender');
  assertEqual(root.querySelector('[data-recursion-progress-row]'), progressRow, 'progress row node is preserved across rerender');
  assertEqual(root.querySelector('[data-recursion-prompt-packet-preview]'), packetPreview, 'prompt packet preview node is preserved across rerender');
  assertEqual(root.querySelector('[data-recursion-prompt-packet-preview]').parentNode, packetPreviewParent, 'prompt packet preview parent is preserved across rerender');
  assertEqual(root.querySelector('[data-recursion-progress-list]').scrollTop, 48, 'progress list preserves scroll position across rerender');
  assertEqual(root.querySelector('[data-recursion-progress-children]').scrollTop, 36, 'progress child list preserves scroll position across rerender');
  assertEqual(root.querySelector('[data-recursion-brief-scroll]').scrollTop, 44, 'brief card list preserves scroll position across rerender');
  assertEqual(root.querySelector('[data-recursion-prompt-packet-preview]').scrollTop, 52, 'prompt packet preview preserves scroll position across rerender');
  assertEqual(root.querySelector('[data-recursion-prompt-packet-panel]').hidden, false, 'prompt packet panel stays open across rerender');
  assertEqual(root.querySelector('[data-recursion-brief-card]').getAttribute('aria-expanded'), 'true', 'expanded brief card stays expanded across rerender');
  const readyBriefView = view;
  const handPanel = root.querySelector('[data-recursion-hand-dropdown]');
  view = {
    ...readyBriefView,
    lastBrief: { status: 'clearing', reason: 'generation-started', previousPacketId: 'packet-ui' }
  };
  ui.update();
  assertEqual(handPanel.dataset.recursionLastBriefState, 'clearing', 'open Last Brief marks clearing lifecycle state');
  assert(handPanel.className.includes('is-clearing'), 'open Last Brief applies fade-out class while clearing');
  assert(fakeDocument.textTree(handPanel).includes('Door stays blocked and the brass lock remains warped.'), 'open Last Brief keeps old cards visible during fade-out');
  runNextTimeout(160);
  assert(!fakeDocument.textTree(handPanel).includes('Door stays blocked and the brass lock remains warped.'), 'old Last Brief cards are removed after fade-out');
  assert(fakeDocument.textTree(handPanel).includes('Preparing next prompt packet.'), 'Last Brief shows preparing empty state after fade-out');
  assertEqual(root.querySelectorAll('[data-recursion-brief-card]').length, 0, 'Last Brief has no card rows after clearing fade');
  view = {
    ...readyBriefView,
    lastBrief: { status: 'ready', packetId: 'packet-ui', handId: 'hand-ui', cardCount: 2 }
  };
  ui.update();
  assert(fakeDocument.textTree(handPanel).includes('Door stays blocked and the brass lock remains warped.'), 'ready Last Brief cards return after packet promotion');
  root.querySelector('[data-recursion-hand-toggle]').click();
  assertEqual(handPanel.hidden, true, 'brief dropdown closes before closed-state clearing test');
  view = {
    ...readyBriefView,
    lastBrief: { status: 'clearing', reason: 'latest-assistant-swipe', previousPacketId: 'packet-ui' }
  };
  ui.update();
  root.querySelector('[data-recursion-hand-toggle]').click();
  assertEqual(handPanel.hidden, false, 'brief dropdown reopens during clearing state');
  assert(!fakeDocument.textTree(handPanel).includes('Door stays blocked and the brass lock remains warped.'), 'closed Last Brief does not show stale cards when opened after clearing starts');
  assert(fakeDocument.textTree(handPanel).includes('Preparing next prompt packet.'), 'closed Last Brief opens directly to preparing state');
  view = {
    ...readyBriefView,
    lastBrief: { status: 'ready', packetId: 'packet-ui', handId: 'hand-ui', cardCount: 2 }
  };
  ui.update();
  view = {
    ...view,
    progressRun: {
      ...view.progressRun,
      steps: view.progressRun.steps.map((step) => (
        step.id === 'utility-card-batch'
          ? {
            ...step,
            state: 'done',
            children: step.children.map((child) => ({ ...child, state: 'done' }))
          }
          : step
      ))
    }
  };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-progress-row]'), progressRow, 'progress row node is updated in place when status changes');
  assert(root.querySelector('[data-recursion-progress-row]').className.includes('is-updating'), 'progress row update animation class is applied on status changes');
  const rerenderedChildren = root.querySelector('[data-recursion-progress-children]');
  rerenderedChildren.scrollHeight = 180;
  rerenderedChildren.clientHeight = 90;
  rerenderedChildren.scrollTop = 42;
  for (const listener of rerenderedChildren.eventListeners.scroll || []) listener({ target: rerenderedChildren });
  assert(!rerenderedChildren.className.includes('is-at-end'), 'child progress fade remains active before scroll end');
  rerenderedChildren.scrollTop = 90;
  for (const listener of rerenderedChildren.eventListeners.scroll || []) listener({ target: rerenderedChildren });
  assert(rerenderedChildren.className.includes('is-at-end'), 'child progress fade clears at scroll end');

  root.querySelector('[data-recursion-setting-strength]').value = 'strong';
  root.querySelector('[data-recursion-setting-min-cards]').value = '4';
  root.querySelector('[data-recursion-setting-max-cards]').value = '12';
  root.querySelector('[data-recursion-setting-footprint]').value = 'rich';
  root.querySelector('[data-recursion-setting-focus]').value = 'character';
  root.querySelector('[data-recursion-setting-progress-child-limit]').value = '7';
  root.querySelector('[data-recursion-setting-progress-list-limit]').value = '22';
  root.querySelector('[data-recursion-setting-enhancement-context-messages]').value = '21';
  root.querySelector('[data-recursion-setting-tooltips-enabled]').checked = false;
  root.querySelector('[data-recursion-setting-source-window-messages]').value = '64';
  root.querySelector('[data-recursion-setting-source-window-characters]').value = '36000';
  root.querySelector('[data-recursion-setting-provider-visible-messages]').value = '6';
  root.querySelector('[data-recursion-setting-scene-caches-per-chat]').value = '5';
  root.querySelector('[data-recursion-setting-scene-caches-total]').value = '20';
  root.querySelector('[data-recursion-setting-source-variants-per-scene]').value = '6';
  root.querySelector('[data-recursion-setting-run-journal-entries]').value = '120';
  root.querySelector('[data-recursion-setting-include-excerpts]').checked = true;
  root.querySelector('[data-recursion-setting-injection-placement]').value = 'in_chat';
  root.querySelector('[data-recursion-setting-injection-role]').value = 'assistant';
  root.querySelector('[data-recursion-setting-injection-depth]').value = '7';
  const autoSaveBefore = settingsUpdates.length;
  const tooltipToggle = root.querySelector('[data-recursion-setting-tooltips-enabled]');
  for (const listener of root.querySelector('[data-recursion-settings-panel]').eventListeners.change || []) listener({ target: tooltipToggle });
  assertEqual(settingsUpdates.length, autoSaveBefore + 1, 'settings controls auto-save as soon as a value changes');
  assertDeepEqual(settingsUpdates.at(-1), {
    strength: 'strong',
    minCards: 4,
    maxCards: 12,
    promptFootprint: 'rich',
    focus: 'character',
    ui: {
      progressChildVisibleLimit: 7,
      progressListVisibleLimit: 22,
      tooltipsEnabled: false
    },
    enhancements: {
      target: 'dialogue',
      applyMode: 'replace',
      contextMessages: 21
    },
    diagnostics: {
      includeExcerpts: true
    },
    retention: {
      sourceWindowMessages: 64,
      sourceWindowCharacters: 36000,
      providerVisibleMessages: 6,
      sceneCachesPerChat: 5,
      sceneCachesTotal: 20,
      sourceVariantsPerScene: 6,
      runJournalEntries: 120
    },
    injection: {
      placement: 'in_chat',
      role: 'assistant',
      depth: 7
    }
  }, 'settings panel saves broad behavior controls without owning the power state');
  ui.update();
  assertDeepEqual(titleAttributes(root), [], 'disabling tooltips removes all hover title attributes from the rendered Recursion UI');
  if (root.querySelector('[data-recursion-settings-panel]').hidden === true) {
    root.querySelector('[data-recursion-actions]').click({ isTrusted: false });
  }
  root.querySelector('[data-recursion-settings-tab-providers]').click({ ignoreStopPropagation: true });
  assertDeepEqual(titleAttributes(root), [], 'disabled tooltips stay removed after settings tab rerender');

  root.querySelector('[data-recursion-provider-source-utility]').value = 'openai-compatible';
  root.querySelector('[data-recursion-provider-profile-utility]').value = 'utility-profile';
  root.querySelector('[data-recursion-provider-profile-filter-utility]').value = 'Utility Profile / utility-model';
  root.querySelector('[data-recursion-provider-base-url-utility]').value = 'https://utility.example/v1';
  root.querySelector('[data-recursion-provider-model-utility]').value = 'utility-model';
  root.querySelector('[data-recursion-provider-api-key-utility]').value = 'sk-ui-secret';
  root.querySelector('[data-recursion-provider-temperature-utility]').value = '0.2';
  root.querySelector('[data-recursion-provider-top-p-utility]').value = '0.8';
  root.querySelector('[data-recursion-provider-max-tokens-utility]').value = '2048';
  const providerUpdatesBeforeAutoSave = providerUpdates.length;
  for (const listener of root.querySelector('[data-recursion-settings-panel]').eventListeners.change || []) {
    listener({ target: root.querySelector('[data-recursion-provider-model-utility]') });
  }
  assertEqual(providerUpdates.length, providerUpdatesBeforeAutoSave + 1, 'provider controls auto-save as soon as a committed value changes');
  assertEqual(providerUpdates.at(-1).lane, 'utility', 'utility provider autosave targets utility lane');
  assertEqual(providerUpdates.at(-1).patch.source, 'openai-compatible', 'provider autosave records source');
  assertEqual(providerUpdates.at(-1).patch.openAICompatible.model, 'utility-model', 'provider autosave records model');
  assertEqual(providerUpdates.at(-1).patch.apiKey, 'sk-ui-secret', 'provider autosave forwards session key without writing it into text');
  assert(!fakeDocument.textTree(root).includes('sk-ui-secret'), 'provider controls do not render session api key text');

  let hostGenerationClicks = 0;
  fakeDocument.addEventListener('click', (event) => {
    if (event.target === root.querySelector('[data-recursion-utility-provider-test]')) hostGenerationClicks += 1;
  });
  root.querySelector('[data-recursion-utility-provider-test]').click();
  const busyProviderTestButton = root.querySelector('[data-recursion-utility-provider-test]');
  assertEqual(busyProviderTestButton.textContent, 'Testing...', 'utility provider test shows busy label before runtime work starts');
  assertEqual(busyProviderTestButton.getAttribute('aria-busy'), 'true', 'utility provider test exposes busy state before runtime work starts');
  assertEqual(busyProviderTestButton.getAttribute('disabled'), 'disabled', 'utility provider test is disabled while the request is pending');
  assertDeepEqual(providerTests, [], 'utility provider test yields one microtask so busy state can paint before runtime work');
  await flushMicrotasks(1);
  assertDeepEqual(providerTests, ['utility'], 'utility provider test action calls runtime');
  assertEqual(hostGenerationClicks, 0, 'utility provider test consumes its click before host generation handlers can see it');
  providerTestGates[0].resolve({ ok: true });
  await flushMicrotasks();
  const settledProviderTestButton = root.querySelector('[data-recursion-utility-provider-test]');
  assertEqual(settledProviderTestButton.textContent, 'Test Provider', 'utility provider test restores label after completion');
  assertEqual(settledProviderTestButton.getAttribute('aria-busy'), 'false', 'utility provider test clears busy state after completion');
  assertEqual(settledProviderTestButton.getAttribute('disabled'), null, 'utility provider test enables again after completion');
  if (root.querySelector('[data-recursion-provider-body-reasoner]').hidden === true) {
    root.querySelector('[data-recursion-provider-toggle-reasoner]').click();
  }
  root.querySelector('[data-recursion-reasoner-provider-test]').click();
  const busyReasonerProviderTestButton = root.querySelector('[data-recursion-reasoner-provider-test]');
  assertEqual(busyReasonerProviderTestButton.textContent, 'Testing...', 'reasoner provider test shows busy label before runtime work starts');
  assertEqual(root.querySelector('[data-recursion-provider-body-reasoner]').hidden, false, 'Reasoner provider stays expanded while provider test is pending');
  assertEqual(root.querySelector('[data-recursion-provider-toggle-reasoner]').getAttribute('aria-expanded'), 'true', 'Reasoner provider toggle stays expanded while provider test is pending');
  await flushMicrotasks(1);
  assertDeepEqual(providerTests, ['utility', 'reasoner'], 'reasoner provider test action calls runtime after busy state paints');
  providerTestGates[1].resolve({ ok: true });
  await flushMicrotasks();
  const settledReasonerProviderTestButton = root.querySelector('[data-recursion-reasoner-provider-test]');
  assertEqual(settledReasonerProviderTestButton.textContent, 'Test Provider', 'reasoner provider test restores label after completion');
  assertEqual(root.querySelector('[data-recursion-provider-body-reasoner]').hidden, false, 'Reasoner provider stays expanded after provider test completion');
  assertEqual(root.querySelector('[data-recursion-provider-toggle-reasoner]').getAttribute('aria-expanded'), 'true', 'Reasoner provider toggle stays expanded after provider test completion');
  root.querySelector('[data-recursion-utility-provider-clear-key]').click();
  assertDeepEqual(providerClears, ['utility'], 'utility clear session key action calls runtime');
  if (root.querySelector('[data-recursion-settings-panel]').hidden === false) {
    root.querySelector('[data-recursion-actions]').click();
  }
  if (root.querySelector('[data-recursion-hand-dropdown]').hidden !== false) {
    root.querySelector('[data-recursion-hand-toggle]').click();
  }
  if (root.querySelector('[data-recursion-prompt-packet-panel]').hidden !== false) {
    root.querySelector('[data-recursion-prompt-packet-button]').click();
  }
  const copiedBeforePromptPacket = copied.length;
  root.querySelector('[data-recursion-copy-prompt-packet]').click();
  await Promise.resolve();
  const copiedPromptPacket = copied.at(-1);
  assertEqual(copied.length, copiedBeforePromptPacket + 1, 'copy prompt packet writes a fresh clipboard item');
  assert(copiedPromptPacket.includes('Recursion Card Evidence'), 'copy prompt packet writes the injected prompt text');
  assert(!copiedPromptPacket.includes('"packetId"'), 'copy prompt packet omits packet JSON wrapper');
  assert(copiedPromptPacket.includes('Door stays blocked and the brass lock remains warped.'), 'copy prompt packet includes actual injected prompt text');

  const viewer = root.querySelector('[data-recursion-viewer]');
  let showModalCount = 0;
  viewer.showModal = () => {
    showModalCount += 1;
    if (viewer.open) throw new Error('showModal called while viewer already open');
    viewer.open = true;
  };
  root.querySelector('[data-recursion-viewer-toggle]').click();
  assertEqual(showModalCount, 1, 'viewer toggle opens dialog once per click');
  assertEqual(fakeDocument.activeElement, root.querySelector('[data-recursion-viewer-close]'), 'opening viewer focuses the close control');
  viewer.close = () => {
    closeCount += 1;
    viewer.open = false;
  };
  const cardDetail = root.querySelector('[data-recursion-viewer-card]');
  assert(cardDetail, 'full viewer renders structured card detail rows');
  const cardDetailText = fakeDocument.textTree(cardDetail);
  assert(cardDetailText.includes('Scene Frame'), 'viewer card detail includes card family');
  assert(cardDetailText.includes('active'), 'viewer card detail includes lifecycle state');
  assert(cardDetailText.includes('emphasized'), 'viewer card detail includes emphasis');
  assert(cardDetailText.includes('standard'), 'viewer card detail includes detail profile');
  assert(cardDetailText.includes('generated'), 'viewer card detail includes provider/source state');
  assert(cardDetailText.includes('turn:42'), 'viewer card detail includes evidence refs');
  assert(cardDetailText.includes('anchors the blocked exit'), 'viewer card detail includes selection reason');
  assert(cardDetailText.includes('Inspector-only'), 'viewer card detail labels inspector notes');
  assert(cardDetailText.includes('scene opening required fresh frame'), 'viewer card detail includes lifecycle history');

  view = {
    ...view,
    settings: { ...view.settings, enabled: true, mode: 'auto' },
    activity: { phase: 'settled', severity: 'success', label: 'Recursion prompt ready.' }
  };
  ui.update();
  ui.update();
  assertEqual(root.querySelector('[data-recursion-status]').textContent, 'Ready', 'update refreshes runtime health');
  assertEqual(root.querySelector('[data-recursion-mode]').textContent, 'Auto', 'update refreshes mode text');
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, 'Recursion prompt ready.', 'settled prompt ready renders compact standby text with punctuation');
  assertEqual(root.querySelector('[data-recursion-mobile-status-text]').textContent, 'Recursion prompt ready.', 'mobile status drawer mirrors settled standby text');
  assertEqual(root.querySelector('[data-recursion-mobile-status-drawer]').hidden, false, 'mobile status drawer shows settled standby text while it is visible');
  runNextTimeout(2000);
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, true, 'success ribbon collapses after the success timeout');
  ui.update();
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, true, 'success ribbon stays collapsed while the same success activity is polled');
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, 'Recursion prompt ready.', 'settled standby text survives success ribbon collapse');
  runNextTimeout(4000);
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, '', 'settled standby text clears after four seconds');
  assertEqual(root.querySelector('[data-recursion-mobile-status-drawer]').hidden, true, 'mobile status drawer hides when standby text expires');
  ui.update();
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, '', 'same settled standby text does not reappear after the four-second expiry');
  view = { ...view, activity: { phase: 'providerIssue', severity: 'warning', label: 'Provider test failed.' } };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, false, 'warning ribbon appears immediately and persists');
  root.querySelector('[data-recursion-viewer-close]').click();
  assertEqual(closeCount, 1, 'viewer close listener is not duplicated across updates');

  view = {
    ...readyBriefView,
    settings: { ...readyBriefView.settings, mode: 'auto', enabled: true },
    activeRunId: null,
    hostGenerationActive: false,
    activity: { phase: 'idle' },
    progressRun: null,
    freshNextGeneration: { pending: false },
    lastBrief: { status: 'ready', packetId: 'packet-ui', handId: 'hand-ui', cardCount: 2 }
  };
  ui.update();
  if (root.querySelector('[data-recursion-hand-dropdown]').hidden === false) {
    root.querySelector('[data-recursion-hand-toggle]').click();
  }
  assertEqual(root.querySelector('[data-recursion-stop-generation]').hidden, true, 'idle view hides stop generation button');
  assertEqual(root.querySelector('[data-recursion-fresh-next-generation]').hidden, false, 'idle view shows fresh-next generation button in command slot');
  assertEqual(root.querySelector('[data-recursion-fresh-next-generation]').getAttribute('aria-label'), 'Force next generation fresh', 'fresh-next button exposes accessible copy');
  assertEqual(root.querySelector('[data-recursion-fresh-next-generation]').getAttribute('title'), 'Force the next send or swipe to rebuild fresh cards and prompt guidance without using cached cards, Rapid warm, or same-turn packet reuse.', 'fresh-next button exposes hover tip copy');
  assert(root.querySelector('[data-recursion-fresh-next-generation-icon]'), 'fresh-next button renders the Regenerate icon');
  assertEqual(root.querySelector('[data-recursion-fresh-next-generation-icon]').children.length, 0, 'fresh-next icon uses the regenerate.svg asset mask instead of inline SVG');
  assertEqual(fakeDocument.textTree(root.querySelector('[data-recursion-fresh-next-generation]')).includes('Regenerate'), false, 'fresh-next button is icon-only when idle');
  root.querySelector('[data-recursion-fresh-next-generation]').click();
  assertEqual(freshNextGenerationCalls, 1, 'fresh-next button queues the next generation override');
  assertDeepEqual(freshNextGenerationDetails.at(-1), { source: 'bar' }, 'fresh-next button identifies bar as source');
  ui.update();
  assertEqual(root.querySelector('[data-recursion-stop-generation]').hidden, true, 'queued fresh-next state does not show Stop while idle');
  assertEqual(root.querySelector('[data-recursion-fresh-next-generation]').getAttribute('aria-pressed'), 'true', 'queued fresh-next state renders armed button state');
  assertEqual(root.querySelector('[data-recursion-fresh-next-generation]').getAttribute('aria-label'), 'Fresh next generation armed', 'armed fresh-next button exposes armed copy');
  root.querySelector('[data-recursion-hand-toggle]').click();
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-hand-dropdown]')).includes('Door stays blocked and the brass lock remains warped.'), 'fresh-next armed state keeps previous Last Brief cards visible until send or swipe');
  assert(!fakeDocument.textTree(root.querySelector('[data-recursion-hand-dropdown]')).includes('Next generation will be fresh.'), 'fresh-next armed state does not spend the Last Brief clearing copy before generation');
  root.querySelector('[data-recursion-hand-toggle]').click();
  root.querySelector('[data-recursion-fresh-next-generation]').click();
  assertEqual(clearFreshNextGenerationCalls, 1, 'clicking armed fresh-next button clears the override');
  assertDeepEqual(clearFreshNextGenerationDetails.at(-1), { source: 'bar' }, 'fresh-next clear identifies bar as source');
  view = { settings: { mode: 'auto' }, activeRunId: 'run-active-force-slot', activity: { phase: 'cardBatchRunning' }, lastHand: { cards: [] }, freshNextGeneration: { pending: false } };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-stop-generation]').hidden, false, 'active view restores stop generation button');
  assertEqual(root.querySelector('[data-recursion-fresh-next-generation]').hidden, true, 'active view hides fresh-next generation so stop takes priority');
  view = { settings: { mode: 'auto' }, activity: { phase: 'idle' }, lastHand: { cards: [] }, freshNextGeneration: { pending: false } };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, 'Ready for Recursion.', 'fresh idle view renders first-load standby text with punctuation');
  assertEqual(root.querySelector('[data-recursion-mobile-status-text]').textContent, 'Ready for Recursion.', 'mobile status drawer mirrors first-load standby text');
  runNextTimeout(4000);
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, '', 'fresh idle standby text clears after four seconds');
  assertEqual(root.querySelector('[data-recursion-mobile-status-drawer]').hidden, true, 'mobile status drawer hides when first-load standby expires');
  ui.update();
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, '', 'same fresh idle standby text does not reappear after expiry');
  view = { settings: { mode: 'manual' }, activity: { phase: 'idle' }, lastHand: { cards: [] } };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-current-step]').textContent, 'Manual scope armed.', 'new standby text appears when standby key changes');
  const idleViewerText = fakeDocument.textTree(viewer);
  assert(!idleViewerText.includes('Recursion is working...'), 'idle viewer does not report active work');

  view = sensitiveView;
  ui.update();
  const viewerText = fakeDocument.textTree(viewer);
  assert(!viewerText.includes('Raw prompt text'), 'viewer omits raw prompt sections');
  assert(!viewerText.includes('sk-ui-packet'), 'viewer redacts packet secrets');
  assert(!viewerText.includes('private-secret'), 'viewer redacts private secret text');
  assert(!viewerText.includes('Bearer ui-token'), 'viewer redacts settings secrets');
  assert(!viewerText.includes('STACK_TRACE_SENTINEL'), 'viewer redacts stack traces from activity surfaces');
  assert(!viewerText.includes('TRACE_SENTINEL'), 'viewer redacts trace payloads from activity surfaces');
  assert(!viewerText.includes('plain-private-key'), 'viewer redacts privateKey values');
  assert(!viewerText.includes('plain-session-key'), 'viewer redacts sessionKey values');
  assert(!viewerText.includes('plain-auth-header'), 'viewer redacts authHeader values');
  assert(!viewerText.includes('plain-credentials'), 'viewer redacts credentials values');
  assert(!viewerText.includes('plain-session-api-key'), 'viewer redacts sessionApiKey values');
  assert(viewerText.includes('packet-hash'), 'viewer keeps safe prompt packet diagnostics');

  ui.destroy();
  assertEqual(fakeDocument.getElementById('recursion-root'), null, 'destroy removes root');
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
  if (previousNavigator === undefined) delete globalThis.navigator;
  else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
  globalThis.setTimeout = previousSetTimeout;
  globalThis.clearTimeout = previousClearTimeout;
  globalThis.setInterval = previousSetInterval;
  globalThis.clearInterval = previousClearInterval;
  if (previousInnerWidth === undefined) delete globalThis.innerWidth;
  else globalThis.innerWidth = previousInnerWidth;
  if (previousInnerHeight === undefined) delete globalThis.innerHeight;
  else globalThis.innerHeight = previousInnerHeight;
  if (previousVisualViewport === undefined) delete globalThis.visualViewport;
  else globalThis.visualViewport = previousVisualViewport;
  if (previousConnectionManagerRequestService === undefined) delete globalThis.ConnectionManagerRequestService;
  else globalThis.ConnectionManagerRequestService = previousConnectionManagerRequestService;
  if (previousSillyTavern === undefined) delete globalThis.SillyTavern;
  else globalThis.SillyTavern = previousSillyTavern;
}

console.log('[pass] ui');
