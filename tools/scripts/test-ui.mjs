import { readFileSync } from 'node:fs';
import { activityLabel, createRecursionViewModel, mountRecursionUi } from '../../src/ui.mjs';
import { createHeroPixelBlocks, createProgressRunModel } from '../../src/progress.mjs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

assertEqual(activityLabel({ phase: 'cardBatchRunning' }), 'Generating scene cards...', 'phase label mapped');
const model = createRecursionViewModel({
  settings: { mode: 'auto' },
  lastHand: { cards: [{ id: 'c1' }, { id: 'c2' }] },
  activity: { phase: 'settled', label: 'Recursion prompt ready.', severity: 'success' },
  lastPacket: { diagnostics: { composerLane: 'utility' } }
});
assertEqual(model.runtimeHealthLabel, 'Ready', 'runtime health label built');
assertEqual(model.modeLabel, 'Auto', 'mode label built');
assertEqual(model.statusText, undefined, 'view model does not expose combined runtime/mode status');
assertEqual(model.handCount, 2, 'hand count built');
assertEqual(model.composerLabel, 'Utility', 'composer label built');

const explicitProgress = createProgressRunModel({
  progressRun: {
    runId: 'run-progress',
    title: 'Generating',
    subtitle: '2 model calls running',
    steps: [
      { id: 'read-turn', label: 'Reading current turn', providerLane: 'utility', state: 'done' },
      { id: 'card-batch', label: 'Utility card batch', providerLane: 'utility', state: 'running' },
      { id: 'reasoner-brief', label: 'Reasoner brief', providerLane: 'reasoner', state: 'running' },
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
    ['reasoner-brief', 'reasoner', 'running', 'running'],
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
          { id: 'continuity-risk-card', label: 'Continuity Risk', providerLane: 'utility', state: 'cached', source: 'cache', sourceRoleId: 'continuityRiskCard' }
        ]
      },
      {
        id: 'reasoner-brief',
        label: 'Reasoner brief',
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
const nestedReasonerBrief = nestedChildProgress.steps.find((step) => step.id === 'reasoner-brief');
const nestedCacheDeck = nestedChildProgress.steps.find((step) => step.id === 'reusing-scene-deck');
assertEqual(nestedUtilityBatch.state, 'done', 'mixed generated and cached child success makes the card batch successful');
assertEqual(nestedReasonerBrief.state, 'failed', 'failed child dominates reasoner brief parent state');
assertEqual(nestedCacheDeck.state, 'cached', 'all-cached children make the parent cached');
assertDeepEqual(
  nestedUtilityBatch.children.map((child) => [child.id, child.label, child.state, child.meta, child.sourceRoleId]),
  [
    ['scene-frame-card', 'Scene Frame', 'done', 'generated', 'sceneFrameCard'],
    ['continuity-risk-card', 'Continuity Risk', 'cached', 'cached', 'continuityRiskCard']
  ],
  'nested progress normalizes card child rows with source-aware meta text'
);
assertEqual(createHeroPixelBlocks(nestedChildProgress).length, 3, 'hero pixel array renders parent rows only, not nested child rows');
assertDeepEqual(
  createHeroPixelBlocks(nestedChildProgress).map((block) => [block.id, block.state]),
  [
    ['utility-card-batch', 'done'],
    ['reasoner-brief', 'failed'],
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
    cardJobs: [{ family: 'Scene Frame' }, { family: 'Motivation' }, { family: 'Continuity Risk' }],
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
    ['reasoner-brief', 'pending'],
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
    .filter((step) => ['utility-card-batch', 'reasoner-brief'].includes(step.id))
    .map((step) => [step.id, step.state]),
  [
    ['utility-card-batch', 'running'],
    ['reasoner-brief', 'running']
  ],
  'derived progress keeps concurrent provider rows running'
);
assertEqual(concurrentDerivedProgress.currentStepText, '2 model calls running...', 'derived concurrent progress gets compact bar text');

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
    { runId: 'run-nested-derived', phase: 'cardProgress', label: 'Continuity Risk reused from cache.', providerLane: 'utility', severity: 'success', detail: { parentStepId: 'utility-card-batch', roleId: 'continuityRiskCard', family: 'Continuity Risk', source: 'cache', state: 'cached' } },
    { runId: 'run-nested-derived', phase: 'cardProgress', label: 'Character Motivation generated.', providerLane: 'utility', severity: 'success', detail: { parentStepId: 'utility-card-batch', roleId: 'characterMotivationCard', family: 'Character Motivation', source: 'generated', state: 'done' } },
    { runId: 'run-nested-derived', phase: 'cardProgress', label: 'Open Threads fell back locally.', providerLane: 'utility', severity: 'warning', detail: { parentStepId: 'utility-card-batch', roleId: 'openThreadsCard', family: 'Open Threads', source: 'fallback', state: 'warning' } }
  ],
  activity: { runId: 'run-nested-derived', phase: 'providerCallRunning', label: 'Provider batch call running.', providerLane: 'utility', detail: { roleId: 'sceneFrameCard', batchIndex: 0 } },
  lastPlan: {
    cardJobs: [
      { family: 'Scene Frame', role: 'sceneFrameCard' },
      { family: 'Continuity Risk', role: 'continuityRiskCard' },
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
    ['Continuity Risk', 'cached', 'cached'],
    ['Character Motivation', 'done', 'generated'],
    ['Open Threads', 'warning', 'fallback']
  ],
  'derived card batch has pending/running/generated/cached/fallback child rows'
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
const recursionUi = readFileSync(new URL('../../src/ui.mjs', import.meta.url), 'utf8');
const activityTriggerCss = barImplementationReference.match(/\.activity-trigger\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const referenceHostCss = barImplementationReference.match(/\.recursion-topbar-host\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const referenceBarCss = barImplementationReference.match(/\.recursion-bar\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const heroBlockCss = barImplementationReference.match(/\.hero-block\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const heroBlockEnterCss = barImplementationReference.match(/@keyframes hero-block-enter\s*\{([\s\S]*?)\n\}\n\n@keyframes hero-block-active/)?.[1] ?? '';
const heroBlockActiveCss = barImplementationReference.match(/@keyframes hero-block-active\s*\{([\s\S]*?)\n\}\n\n@keyframes hero-block-wipe/)?.[1] ?? '';
const reasoningChainCss = barImplementationReference.match(/\.reasoning-chain\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const reasoningNodeCss = barImplementationReference.match(/\.reasoning-node\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const reasoningLitNodeCss = barImplementationReference.match(/\.reasoning-node\.is-lit\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const settingsReasoningLitNodeCss = recursionCss.match(/\.recursion-settings-reasoning-node\.is-lit\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
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
assert(/data-mode="semi-auto"/.test(barImplementationReference), 'reference mode menu includes Semi-Auto');
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
assert(/\.recursion-settings-reasoning-line-fill\s*\{[\s\S]*?var\(--SmartThemeBodyColor/.test(recursionCss), 'settings reasoning fill derives from SillyTavern body color');
assert(!/var\(--recursion-accent/.test(settingsReasoningLitNodeCss), 'settings reasoning nodes do not use cyan after moving to SillyTavern grey-white theme');
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
assert(/\.recursion-brief-card\s*\{[\s\S]*?grid-template-columns:\s*138px minmax\(0,\s*1fr\);/.test(recursionCss), 'production Last Brief cards use the reference two-column card grid');
assert(/\.recursion-card-text\s*\{[\s\S]*?-webkit-line-clamp:\s*1;/.test(recursionCss), 'production Last Brief cards clamp text to one line while compact');
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
assert(/\.recursion-step-row\.is-entering/.test(recursionCss), 'production progress rows have an insertion animation class');
assert(/\.recursion-step-row\.is-updating/.test(recursionCss), 'production progress rows have an update animation class');
assert(/@keyframes recursion-step-row-enter/.test(recursionCss), 'production progress row insertion animation is defined');
assert(/@keyframes recursion-step-row-update/.test(recursionCss), 'production progress row update animation is defined');
assert(/\.recursion-step-children\s*\{[\s\S]*?--recursion-progress-child-row-height:\s*25px;[\s\S]*?padding:\s*0 0 3px 22px;/.test(recursionCss), 'production progress child rows match the compact indented reference geometry');
assert(/\.recursion-step-row\.child-row\s*\{[\s\S]*?height:\s*var\(--recursion-progress-child-row-height\);/.test(recursionCss), 'production child progress rows use the reference fixed child height');
assert(/\.recursion-step-row\.running \.recursion-step-icon\s*\{[\s\S]*?height:\s*12px;[\s\S]*?width:\s*12px;/.test(recursionCss), 'production running progress spinner uses the 12px reference ring size');
assert(/\.recursion-step-row\.running \.recursion-step-icon::after/.test(recursionCss), 'production running progress spinner uses an inner cutout like the reference ring');
assert(/\.recursion-status-head\s*\{[\s\S]*?min-height:\s*34px;[\s\S]*?padding:\s*7px 9px;/.test(recursionCss), 'production progress popover header uses the reference 34px density');
assert(!/\.recursion-status-subtitle\s*\{[^}]*margin-left:\s*auto;/.test(recursionCss), 'production progress subtitle stays beside the title instead of pinning to the right edge');
assert(!/\.recursion-settings-panel\.is-beside-progress/.test(recursionCss), 'production settings panel no longer carries obsolete side-by-side progress styling');
assert(!/\.recursion-settings-panel\s*\{[\s\S]*?left:\s*360px;/.test(recursionCss), 'production settings panel CSS fallback is full-width, not side-by-side');
assert(/\.recursion-status-foot \.recursion-mini-chip\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?padding:\s*2px 5px 3px;/.test(recursionCss), 'production progress footer Live chip uses the reference tiny-chip density');
assert(/\.recursion-hand-dropdown\s*\{[\s\S]*?display:\s*block;[\s\S]*?overflow:\s*hidden;[\s\S]*?padding:\s*0;/.test(recursionCss), 'production Last Brief dropdown removes the old padded grid shell');
assert(/\.recursion-hand-dropdown::before/.test(recursionCss), 'production Last Brief dropdown keeps the reference top accent line');
assert(/\.recursion-brief-head\s*\{[\s\S]*?min-height:\s*34px;[\s\S]*?padding:\s*7px 9px;/.test(recursionCss), 'production Last Brief header uses the reference 34px density');
assert(/\.recursion-brief-foot \.recursion-mini-chip\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?padding:\s*2px 5px 3px;/.test(recursionCss), 'production Last Brief footer Esc chip uses the reference tiny-chip density');
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
assert(/progressChildVisibleLimit:\s*5/.test(uiSpec), 'UI spec documents the sub-tier visible row default');
assert(/progressListVisibleLimit:\s*15/.test(uiSpec), 'UI spec documents the whole progress list visible row default');
assert(/bottom fade/.test(uiSpec), 'UI spec documents the sub-tier overflow fade affordance');
assert(/\.settings-row input\[type="checkbox"\]\s*\{[\s\S]*?appearance:\s*none;[\s\S]*?background:\s*rgba\(255, 255, 255, \.035\);/.test(barImplementationReference), 'reference settings checkbox uses the compact dark mockup skin');
assert(/Checkboxes inside Recursion settings must use the compact dark Recursion control skin/.test(uiSpec), 'UI spec documents host checkbox override requirement');
assert(!/array\.innerHTML\s*=\s*steps\.map/.test(barImplementationReference), 'turn animation preview does not recreate all hero blocks on every tick');
assert(!/list\.innerHTML\s*=\s*rows\.map/.test(barImplementationReference), 'turn animation preview does not recreate all progress rows on every tick');
assert(!/list\.appendChild\(parentRow\);/.test(barImplementationReference), 'turn animation preview does not unconditionally move parent rows on every refresh');
assert(!/const before = list\.children\[index\];[\s\S]*?list\.insertBefore\(row, before \|\| null\);/.test(barImplementationReference), 'turn animation preview does not index parent rows against child group siblings');
assert(/dataset\.stepId/.test(barImplementationReference), 'turn animation preview keys hero blocks and progress rows by stable step id');
assert(/function syncHeroBlock/.test(barImplementationReference), 'turn animation preview updates hero blocks in place');
assert(/function syncProgressRow/.test(barImplementationReference), 'turn animation preview updates progress rows in place');
assert(/\.recursion-power-toggle\s*\{[\s\S]*?flex:\s*0 0 24px;[\s\S]*?height:\s*24px;[\s\S]*?width:\s*24px;/.test(recursionCss), 'production power toggle uses the same compact geometry as the reference');
assert(/\.recursion-activity-trigger\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?padding:\s*0;/.test(recursionCss), 'production activity trigger keeps reference spacing around pixel blocks');
assert(/\.recursion-hero-pixel-array\s*\{[\s\S]*?width:\s*max\(0px,/.test(recursionCss), 'production Hero Pixel Array uses column-based width animation');
assert(/\.recursion-options-button:hover,[\s\S]*?\.recursion-options-button\[aria-expanded="true"\]\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?outline:\s*none\s*!important;/.test(recursionCss), 'production options button stays icon-only while focused or open');
assert(/select\.recursion-input\.recursion-select\s*\{[\s\S]*?background-image:[\s\S]*?linear-gradient\(45deg,[\s\S]*?padding-right:\s*24px\s*!important;/.test(recursionCss), 'production settings selects draw their own dropdown chevron under SillyTavern globals');
assert(/\.recursion-hand-dropdown\s*>\s*\.recursion-empty\s*\{[\s\S]*?margin:\s*0;[\s\S]*?padding:\s*8px 9px 7px;/.test(recursionCss), 'production empty Last Brief state keeps aligned native dropdown padding');
assert(/\.recursion-root\s+input\.recursion-checkbox\[type="checkbox"\]\s*\{[\s\S]*?appearance:\s*none !important;[\s\S]*?background:[\s\S]*?var\(--SmartThemeBlurTintColor/.test(recursionCss), 'production settings checkbox uses a Recursion-scoped selector strong enough to beat SillyTavern globals');
assert(/\.recursion-root\s+input\.recursion-checkbox\[type="checkbox"\]:checked\s*\{[\s\S]*?background:[\s\S]*?var\(--recursion-accent\)/.test(recursionCss), 'production settings checkbox uses Recursion cyan when checked');
assert(/\.recursion-provider-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/.test(recursionCss), 'production Providers pane uses the reference two-column provider grid');
assert(/\.recursion-provider-status\.pass\s*\{[\s\S]*?var\(--recursion-success\)/.test(recursionCss), 'production provider success status uses the defined success token');
assert(/const progressTop = rect\.bottom \+ 3;/.test(recursionUi), 'production progress popover uses the reference vertical gap below the compact bar');
assert(/const settingsTop = rect\.bottom \+ 5;/.test(recursionUi), 'production settings and brief popovers use the reference desktop vertical gap');
assert(/setFixedPanelGeometry\(settingsPanel,[\s\S]*?zIndex:\s*10022/.test(recursionUi), 'production settings panel stays above progress when compact layouts overlap');
assert(/setFixedPanelGeometry\(settingsPanel,\s*\{\s*left:\s*rootLeft,\s*top:\s*settingsTop,\s*width:\s*rootWidth,\s*zIndex:\s*10022\s*\}\)/.test(recursionUi), 'production settings panel spans the full Recursion Bar width');
assert(!/is-beside-progress/.test(recursionUi), 'production UI no longer toggles obsolete side-by-side settings class');
assert(/function eventWithin\(event, elements\)/.test(recursionUi), 'outside-click handling keeps original event path for rerendered popover controls');
assert(/!eventWithin\(event, \[/.test(recursionUi), 'document click handling uses event path containment before closing popovers');
assert(/recursionSettingsTab[\s\S]*?event\?\.stopPropagation\?\.\(\)/.test(recursionUi), 'settings tab clicks do not bubble into outside-click closers after rerender');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(recursionCss), 'production CSS honors reduced-motion preferences');
assert(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.recursion-root \*[\s\S]*?animation:\s*none\s*!important;[\s\S]*?transition:\s*none\s*!important;/.test(recursionCss), 'reduced-motion rule disables Recursion animations and transitions');
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
  settings: { mode: 'semi-auto' },
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
      { id: 'reasoner-brief', label: 'Reasoner brief', providerLane: 'reasoner', state: 'running' }
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
    detail: { message: 'Bearer activity-token' }
  },
  lastPacket: {
    sections: { turnBrief: 'Raw prompt text with sk-ui-packet and private-secret' },
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
  return {
    body,
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
}

const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
const previousNavigator = globalThis.navigator;
const previousSetTimeout = globalThis.setTimeout;
const previousClearTimeout = globalThis.clearTimeout;
const previousSetInterval = globalThis.setInterval;
const previousClearInterval = globalThis.clearInterval;
const previousInnerWidth = globalThis.innerWidth;
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
  globalThis.innerWidth = 640;
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
  let refreshed = 0;
  let closeCount = 0;
  const settingsUpdates = [];
  const providerUpdates = [];
  const providerTests = [];
  const providerClears = [];
  let clearRunJournalCalls = 0;
  let exportDiagnosticsCalls = 0;
  let view = {
    settings: {
      mode: 'auto',
      enabled: true,
      strength: 'balanced',
      promptFootprint: 'normal',
      focus: 'balanced',
      reasonerUse: 'auto',
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
          maxTokens: 4096,
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
          maxTokens: 4096,
          lastTest: { status: 'not-run' }
        }
      }
    },
    lastHand: {
      handId: 'hand-ui',
      cards: [{
        id: 'card-a',
        family: 'Scene Frame',
        role: 'sceneFrameCard',
        status: 'fresh',
        source: 'generated',
        detailProfile: 'standard',
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
            { id: 'continuity-risk-card', label: 'Continuity Risk', providerLane: 'utility', state: 'pending' },
            { id: 'motivation-card', label: 'Motivation', providerLane: 'utility', state: 'pending' },
            { id: 'threads-card', label: 'Open Threads', providerLane: 'utility', state: 'pending' },
            { id: 'cast-card', label: 'Active Cast', providerLane: 'utility', state: 'pending' },
            { id: 'prose-card', label: 'Prose Pacing', providerLane: 'utility', state: 'pending' }
          ]
        }
      ]
    },
    lastPacket: {
      packetId: 'packet-ui',
      packetVersion: 1,
      chatId: 'chat-ui',
      sceneKey: 'scene-ui',
      sceneFingerprint: 'scene-ui',
      turnFingerprint: 'turn-ui',
      footprint: 'normal',
      sections: {
        sceneBrief: 'Scene brief:\n- [Scene Frame] Door stays blocked and the brass lock remains warped.',
        turnBrief: 'Turn brief: No turn-specific card guidance selected.',
        guardrails: 'Guardrails:\n- Respect the player message.'
      },
      selectedCardRefs: [{ cardId: 'card-a', family: 'Scene Frame', emphasis: 'emphasized', tokenEstimate: 12, detailProfile: 'standard', evidenceRefs: [] }],
      omissions: [],
      injectionPlan: [
        { id: 'sceneBrief', section: 'sceneBrief', promptKey: 'recursion.sceneBrief', title: 'Recursion Scene Brief', placement: 'in_prompt', depth: 4, role: 'system', maxChars: 900, sourceIds: ['card-a'] },
        { id: 'turnBrief', section: 'turnBrief', promptKey: 'recursion.turnBrief', title: 'Recursion Turn Brief', placement: 'in_chat', depth: 2, role: 'system', maxChars: 900, sourceIds: [] },
        { id: 'guardrails', section: 'guardrails', promptKey: 'recursion.guardrails', title: 'Recursion Guardrails', placement: 'in_prompt', depth: 1, role: 'system', maxChars: 900, sourceIds: [] }
      ],
      diagnostics: { runId: 'run-ui', composerLane: 'utility', reasonerStatus: 'skipped', sectionBudgets: { sceneBrief: 900, turnBrief: 900, guardrails: 900 } },
      composedAt: '2026-07-01T00:00:00.000Z'
    }
  };
  const ui = mountRecursionUi({
    runtime: {
      view: () => view,
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
      testProvider: async (lane) => {
        providerTests.push(lane);
        return { ok: true };
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
      clearRunJournal: () => {
        clearRunJournalCalls += 1;
        return { ok: true };
      },
      exportDiagnostics: () => {
        exportDiagnosticsCalls += 1;
        return {
          ok: true,
          diagnostics: {
            schema: 'recursion.diagnosticsExport.v1',
            promptPacketHash: 'packet-hash'
          }
        };
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
  assert(root.querySelector('[data-recursion-mode-icon]').querySelector('svg'), 'mode button renders the reference inline SVG icon');
  assertEqual(root.querySelector('[data-recursion-mode-icon]').querySelectorAll('rect').length, 3, 'Auto mode button uses the reference stacked-cards SVG');
  assertEqual(root.querySelectorAll('[data-recursion-mode-choice-icon]').length, 2, 'mode selector renders icons only for Auto and Semi-Auto');
  assertEqual(root.querySelectorAll('[data-recursion-mode-choice-tip]').length, 2, 'mode selector renders tips only for Auto and Semi-Auto');
  assertEqual(root.querySelector('[data-recursion-mode-choice-auto]').querySelectorAll('rect').length, 3, 'Auto mode row uses the reference stacked-cards SVG');
  assert(root.querySelector('[data-recursion-mode-choice-semi-auto]').querySelectorAll('rect').length >= 2, 'Semi-Auto mode row uses the reference stacked-cards SVG');
  assert(!root.querySelector('[data-recursion-mode-choice-observe]'), 'Observe only mode is removed from the compact mode menu');
  assert(!root.querySelector('[data-recursion-mode-choice-off]'), 'Off mode is removed from the compact mode menu');
  assertDeepEqual(
    root.querySelectorAll('[data-recursion-mode-choice]').map((choice) => choice.dataset.recursionModeChoice),
    ['auto', 'semi-auto'],
    'mode selector uses the Auto/Semi-Auto mode order'
  );
  assertEqual(
    root.querySelector('[data-recursion-mode-button]').getAttribute('aria-label'),
    'Mode: Auto',
    'mode button exposes the current mode label'
  );
  assertEqual(
    root.querySelector('[data-recursion-mode-choice-auto]').getAttribute('title'),
    'Selects cards and injects composed prompt context automatically.',
    'Auto mode tooltip matches the reference copy'
  );
  assert(
    fakeDocument.textTree(root.querySelector('[data-recursion-mode-choice-semi-auto]')).includes('Constrains card generation to selected card types.'),
    'Semi-Auto mode tip explains future card-type subset constraints'
  );
  assert(
    root.querySelector('[data-recursion-mode-choice-auto]').className.includes('is-selected'),
    'mode selector marks the current mode'
  );
  assertEqual(
    root.querySelector('[data-recursion-mode-choice-auto]').getAttribute('aria-current'),
    'true',
    'mode selector exposes the current mode to assistive tech'
  );
  assert(root.querySelector('[data-recursion-status-trigger]'), 'compact bar renders the progress activity trigger');
  assert(root.querySelector('[data-recursion-hero-array]'), 'compact bar renders the Hero Pixel Array');
  assert(root.querySelector('[data-recursion-status-popover]'), 'compact bar renders the progress popover');
  assert(root.querySelector('[data-recursion-current-step]'), 'compact bar renders one current-step status text');
  assert(root.querySelector('[data-recursion-reasoning-chain]'), 'compact bar renders the reasoning level chain');
  assert(root.querySelector('[data-recursion-reasoning-level-high]'), 'reasoning chain defaults to the High node');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-low]').getAttribute('title'), 'Low: Utility-only, reduced cards.', 'Low reasoning tooltip matches the reference copy');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-medium]').getAttribute('title'), 'Medium: mostly Utility, Reasoner eligible for the brief.', 'Medium reasoning tooltip matches the reference copy');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-high]').getAttribute('title'), 'High: mixed Utility and Reasoner checks.', 'High reasoning tooltip matches the reference copy');
  assertEqual(root.querySelector('[data-recursion-reasoning-level-ultra]').getAttribute('title'), 'Ultra: Reasoner-heavy synthesis with a larger card bias.', 'Ultra reasoning tooltip matches the reference copy');
  assert(root.querySelector('[data-recursion-brief-arrow]'), 'compact bar renders a dedicated last-brief dropdown arrow');
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
  assertEqual(root.querySelector('[data-recursion-status-trigger]').getAttribute('aria-expanded'), 'false', 'progress activity trigger starts collapsed');
  assertEqual(root.querySelector('[data-recursion-hand-toggle]').getAttribute('aria-expanded'), 'false', 'brief dropdown trigger starts collapsed');
  assertEqual(root.querySelector('[data-recursion-mode-button]').getAttribute('aria-expanded'), 'false', 'mode menu trigger starts collapsed');
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
  assert(root.querySelector('[data-recursion-hero-array]').children.length >= 1, 'hero array renders visible progress blocks');
  assertEqual(root.querySelector('[data-recursion-status-trigger]').style.props['--columns'], '1', 'activity trigger exposes column count for width animation');
  assertEqual(root.querySelector('[data-recursion-hero-array]').style.props['--columns'], '1', 'hero array exposes column count for width animation');
  assertEqual(root.querySelector('[data-recursion-hero-array]').style.props['--block-count'], '1', 'hero array exposes top-level block count for animation timing');
  assertEqual(root.querySelector('[data-recursion-hand-count]').textContent, 'Hand 1', 'rendered hand count');
  assertEqual(root.querySelector('[data-recursion-composer]').textContent, 'Utility', 'rendered composer');

  root.querySelector('[data-recursion-mode-button]').click();
  assertEqual(root.querySelector('[data-recursion-mode-menu]').hidden, false, 'mode button opens mode selector');
  assertEqual(root.querySelector('[data-recursion-mode-button]').getAttribute('aria-expanded'), 'true', 'mode button reflects open menu');
  root.querySelector('[data-recursion-mode-choice-semi-auto]').querySelector('[data-recursion-mode-choice-name]').click();
  assertDeepEqual(settingsUpdates.at(-1), { mode: 'semi-auto' }, 'mode menu updates Semi-Auto from nested row content clicks');
  assertEqual(root.querySelector('[data-recursion-mode-button]').getAttribute('aria-expanded'), 'false', 'mode button reflects closed menu after selection');
  root.querySelector('[data-recursion-power-toggle]').click();
  assertDeepEqual(settingsUpdates.at(-1), { enabled: false }, 'power toggle disables Recursion without changing mode');
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, true, 'power toggle does not open progress popover');
  root.querySelector('[data-recursion-status-trigger]').click();
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, false, 'activity trigger opens progress popover');
  assertEqual(root.querySelector('[data-recursion-status-trigger]').getAttribute('aria-expanded'), 'true', 'activity trigger reflects open progress popover');
  root.querySelector('[data-recursion-status-trigger]').click();
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, true, 'activity trigger closes progress popover');
  assertEqual(root.querySelector('[data-recursion-status-trigger]').getAttribute('aria-expanded'), 'false', 'activity trigger reflects closed progress popover');
  root.querySelector('[data-recursion-status-trigger]').click();
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, false, 'activity trigger opens progress popover');
  assertEqual(root.querySelector('[data-recursion-status-trigger]').getAttribute('aria-expanded'), 'true', 'activity trigger reflects open progress popover');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-status-popover]')).includes('Utility card batch'), 'progress popover renders progress rows');
  root.querySelector('[data-recursion-actions]').click();
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, false, 'narrow options click opens settings panel');
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, true, 'narrow options click closes progress instead of hiding it behind settings');
  root.querySelector('[data-recursion-status-trigger]').click();
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, false, 'narrow status click reopens progress popover');
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, true, 'narrow status click closes settings instead of overlapping it');
  root.querySelector('[data-recursion-mode-button]').click();
  assertEqual(root.querySelector('[data-recursion-status-popover]').hidden, true, 'mode menu closes progress popover to avoid left-lane overlap');
  assertEqual(root.querySelector('[data-recursion-mode-menu]').hidden, false, 'mode menu opens after closing progress popover');
  root.querySelector('[data-recursion-mode-choice-auto]').click();
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
  root.querySelector('[data-recursion-reasoning-level-ultra]').click();
  assertDeepEqual(
    settingsUpdates.at(-1),
    { reasoningLevel: 'ultra', reasonerUse: 'always' },
    'reasoning chain updates reasoning level and derived reasoner use'
  );

  globalThis.innerWidth = 920;
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
  assertEqual(root.querySelector('[data-recursion-settings-play]').hidden, false, 'Play pane is the default settings tab');
  assertEqual(root.querySelector('[data-recursion-settings-providers]').hidden, true, 'Providers pane starts tucked behind a tab');
  assert(root.querySelector('[data-recursion-setting-reasoning-chain]'), 'settings play tab renders the compact reasoning level chain');
  assertEqual(root.querySelector('[data-recursion-setting-reasoning-level]').getAttribute('type'), 'hidden', 'settings reasoning level stores a hidden form value');
  assertEqual(root.querySelectorAll('[data-recursion-setting-reasoning-choice]').length, 4, 'settings reasoning chain renders four selectable levels');
  root.querySelector('[data-recursion-setting-reasoning-choice-ultra]').click();
  assertEqual(root.querySelector('[data-recursion-setting-reasoning-level]').value, 'ultra', 'settings reasoning chain updates the saved value');
  root.querySelector('[data-recursion-settings-tab-providers]').click();
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, false, 'settings tab click keeps settings panel open');
  assertEqual(root.querySelector('[data-recursion-settings-play]').hidden, true, 'clicking Providers hides Play pane');
  assertEqual(root.querySelector('[data-recursion-settings-providers]').hidden, false, 'clicking Providers shows provider controls');
  root.querySelector('[data-recursion-settings-tab-advanced]').click({ ignoreStopPropagation: true });
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, false, 'settings tab click keeps settings panel open even when document outside-click also receives the rerendered event');
  assertEqual(root.querySelector('[data-recursion-settings-advanced]').hidden, false, 'clicking Advanced shows advanced controls');
  assertEqual(root.querySelector('[data-recursion-clear-run-journal]').disabled, false, 'Clear Run Journal is enabled when runtime handler exists');
  assertEqual(root.querySelector('[data-recursion-export-diagnostics]').disabled, false, 'Export Diagnostics is enabled when runtime handler exists');
  assertEqual(root.querySelector('[data-recursion-reset-scene-cache]').disabled, true, 'Reset Scene Cache stays disabled until runtime handler exists');
  assert(root.querySelector('[data-recursion-setting-injection-placement]'), 'Advanced settings render injection placement control');
  assert(root.querySelector('[data-recursion-setting-injection-role]'), 'Advanced settings render injection role control');
  assert(root.querySelector('[data-recursion-setting-injection-depth]'), 'Advanced settings render injection depth control');
  assertEqual(root.querySelector('[data-recursion-setting-injection-placement]').value, 'default', 'injection placement defaults to template plan');
  assertEqual(root.querySelector('[data-recursion-setting-injection-role]').value, 'system', 'injection role defaults to system');
  assertEqual(root.querySelector('[data-recursion-setting-injection-depth]').value, 'default', 'injection depth defaults to template plan');
  root.querySelector('[data-recursion-clear-run-journal]').click();
  assertEqual(clearRunJournalCalls, 1, 'Clear Run Journal action calls runtime');
  root.querySelector('[data-recursion-export-diagnostics]').click();
  await Promise.resolve();
  assertEqual(exportDiagnosticsCalls, 1, 'Export Diagnostics action calls runtime');
  assert(copied.at(-1).includes('recursion.diagnosticsExport.v1'), 'Export Diagnostics copies sanitized diagnostics JSON');
  assert(root.querySelector('[data-recursion-provider-grid]'), 'Providers pane renders the compact reference provider grid');
  assertEqual(root.querySelectorAll('[data-recursion-provider-section]').length, 2, 'Providers pane renders Utility plus collapsed Reasoner sections');
  assert(!root.querySelector('[data-recursion-provider-model-reasoner]'), 'Reasoner provider stays collapsed to the reference summary row');
  assertEqual(root.querySelector('[data-recursion-provider-temperature-utility]').getAttribute('type'), 'hidden', 'provider temperature stays hidden from the compact mockup UI');
  assertEqual(root.querySelector('[data-recursion-provider-top-p-utility]').getAttribute('type'), 'hidden', 'provider top-p stays hidden from the compact mockup UI');
  assertDeepEqual(
    root.querySelector('[data-recursion-setting-mode]').children.map((child) => child.textContent),
    ['Auto', 'Semi-Auto'],
    'mode settings options use the Auto/Semi-Auto reference order'
  );
  root.querySelector('[data-recursion-settings-close]').click();
  assertEqual(root.querySelector('[data-recursion-settings-panel]').hidden, true, 'settings close button closes options panel');
  assertEqual(root.querySelector('[data-recursion-actions]').getAttribute('aria-expanded'), 'false', 'options button reflects closed settings state');

  root.querySelector('[data-recursion-hand-toggle]').click();
  assertEqual(root.querySelector('[data-recursion-hand-dropdown]').hidden, false, 'brief dropdown button opens Last Brief');
  assertEqual(root.querySelector('[data-recursion-hand-toggle]').getAttribute('aria-expanded'), 'true', 'brief dropdown trigger reflects open state');
  const briefCard = root.querySelector('[data-recursion-brief-card]');
  assert(briefCard.dataset.recursionBriefCardId, 'brief card keeps per-card id for expansion persistence');
  assertEqual(briefCard.getAttribute('aria-expanded'), 'false', 'brief card starts compact');
  assert(briefCard.querySelector('[data-recursion-brief-card-icon]').querySelector('svg'), 'brief card uses category SVG icon');
  assert(briefCard.querySelector('[data-recursion-brief-card-text]'), 'brief card renders text in the mockup card body');
  assert(briefCard.querySelector('[data-recursion-brief-card-meta]'), 'brief card renders compact meta chip row');
  briefCard.click();
  assertEqual(briefCard.getAttribute('aria-expanded'), 'true', 'brief card expands on click');
  assert(fakeDocument.textTree(briefCard).includes('Door stays blocked and the brass lock remains warped.'), 'expanded brief card exposes full card text');
  assert(fakeDocument.textTree(briefCard).includes('fresh'), 'expanded brief card exposes bounded meta chips');
  const packetButton = root.querySelector('[data-recursion-prompt-packet-button]');
  assert(packetButton, 'last brief renders Prompt Packet button');
  packetButton.click();
  assertEqual(root.querySelector('[data-recursion-prompt-packet-panel]').hidden, false, 'Prompt Packet button opens composed packet panel');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('Utility composed'), 'prompt packet panel renders composer lane meta chip');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('1 card'), 'prompt packet panel renders card count meta chip');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('Recursion Scene Brief'), 'prompt packet panel renders injected block titles');
  assert(fakeDocument.textTree(root.querySelector('[data-recursion-prompt-packet-panel]')).includes('Door stays blocked and the brass lock remains warped.'), 'prompt packet panel renders actual injected prompt text');
  assert(!root.querySelector('[data-recursion-prompt-packet-preview]').textContent.includes('"packetId"'), 'prompt packet panel does not show the packet JSON wrapper');
  const progressList = root.querySelector('[data-recursion-progress-list]');
  const progressRow = root.querySelector('[data-recursion-progress-row]');
  const progressChildren = root.querySelector('[data-recursion-progress-children]');
  const briefScroll = root.querySelector('[data-recursion-brief-scroll]');
  const packetPreview = root.querySelector('[data-recursion-prompt-packet-preview]');
  progressList.scrollTop = 48;
  progressChildren.scrollTop = 36;
  briefScroll.scrollTop = 44;
  packetPreview.scrollTop = 52;
  ui.update();
  assertEqual(root.querySelector('[data-recursion-progress-list]'), progressList, 'progress list node is preserved across rerender');
  assertEqual(root.querySelector('[data-recursion-progress-row]'), progressRow, 'progress row node is preserved across rerender');
  assertEqual(root.querySelector('[data-recursion-progress-list]').scrollTop, 48, 'progress list preserves scroll position across rerender');
  assertEqual(root.querySelector('[data-recursion-progress-children]').scrollTop, 36, 'progress child list preserves scroll position across rerender');
  assertEqual(root.querySelector('[data-recursion-brief-scroll]').scrollTop, 44, 'brief card list preserves scroll position across rerender');
  assertEqual(root.querySelector('[data-recursion-prompt-packet-preview]').scrollTop, 52, 'prompt packet preview preserves scroll position across rerender');
  assertEqual(root.querySelector('[data-recursion-prompt-packet-panel]').hidden, false, 'prompt packet panel stays open across rerender');
  assertEqual(root.querySelector('[data-recursion-brief-card]').getAttribute('aria-expanded'), 'true', 'expanded brief card stays expanded across rerender');
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

  root.querySelector('[data-recursion-setting-mode]').value = 'semi-auto';
  root.querySelector('[data-recursion-setting-reasoning-level]').value = 'medium';
  root.querySelector('[data-recursion-setting-strength]').value = 'strong';
  root.querySelector('[data-recursion-setting-footprint]').value = 'rich';
  root.querySelector('[data-recursion-setting-focus]').value = 'character';
  root.querySelector('[data-recursion-setting-progress-child-limit]').value = '7';
  root.querySelector('[data-recursion-setting-progress-list-limit]').value = '22';
  root.querySelector('[data-recursion-setting-journal-limit]').value = '120';
  root.querySelector('[data-recursion-setting-include-excerpts]').checked = true;
  root.querySelector('[data-recursion-setting-injection-placement]').value = 'in_chat';
  root.querySelector('[data-recursion-setting-injection-role]').value = 'assistant';
  root.querySelector('[data-recursion-setting-injection-depth]').value = '7';
  root.querySelector('[data-recursion-settings-save]').click();
  assertDeepEqual(settingsUpdates.at(-1), {
    mode: 'semi-auto',
    reasoningLevel: 'medium',
    strength: 'strong',
    promptFootprint: 'rich',
    focus: 'character',
    reasonerUse: 'auto',
    ui: {
      progressChildVisibleLimit: 7,
      progressListVisibleLimit: 22
    },
    diagnostics: {
      maxJournalEntries: 120,
      includeExcerpts: true
    },
    injection: {
      placement: 'in_chat',
      role: 'assistant',
      depth: 7
    }
  }, 'settings panel saves broad behavior controls without owning the power state');

  root.querySelector('[data-recursion-provider-source-utility]').value = 'openai-compatible';
  root.querySelector('[data-recursion-provider-profile-utility]').value = 'utility-profile';
  root.querySelector('[data-recursion-provider-base-url-utility]').value = 'https://utility.example/v1';
  root.querySelector('[data-recursion-provider-model-utility]').value = 'utility-model';
  root.querySelector('[data-recursion-provider-api-key-utility]').value = 'sk-ui-secret';
  root.querySelector('[data-recursion-provider-temperature-utility]').value = '0.2';
  root.querySelector('[data-recursion-provider-top-p-utility]').value = '0.8';
  root.querySelector('[data-recursion-provider-max-tokens-utility]').value = '2048';
  root.querySelector('[data-recursion-utility-provider-save]').click();
  assertEqual(providerUpdates.at(-1).lane, 'utility', 'utility provider save targets utility lane');
  assertEqual(providerUpdates.at(-1).patch.source, 'openai-compatible', 'provider save records source');
  assertEqual(providerUpdates.at(-1).patch.openAICompatible.model, 'utility-model', 'provider save records model');
  assertEqual(providerUpdates.at(-1).patch.apiKey, 'sk-ui-secret', 'provider save forwards session key without writing it into text');
  assert(!fakeDocument.textTree(root).includes('sk-ui-secret'), 'provider controls do not render session api key text');

  root.querySelector('[data-recursion-utility-provider-test]').click();
  await Promise.resolve();
  assertDeepEqual(providerTests, ['utility'], 'utility provider test action calls runtime');
  root.querySelector('[data-recursion-utility-provider-clear-key]').click();
  assertDeepEqual(providerClears, ['utility'], 'utility clear session key action calls runtime');
  if (root.querySelector('[data-recursion-settings-panel]').hidden === false) {
    root.querySelector('[data-recursion-settings-close]').click();
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
  assert(copiedPromptPacket.includes('Recursion Scene Brief'), 'copy prompt packet writes the injected prompt text');
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
  viewer.close = () => {
    closeCount += 1;
    viewer.open = false;
  };
  const cardDetail = root.querySelector('[data-recursion-viewer-card]');
  assert(cardDetail, 'full viewer renders structured card detail rows');
  const cardDetailText = fakeDocument.textTree(cardDetail);
  assert(cardDetailText.includes('Scene Frame'), 'viewer card detail includes card family');
  assert(cardDetailText.includes('fresh'), 'viewer card detail includes lifecycle state');
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
  runNextTimeout(2000);
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, true, 'success ribbon collapses after the success timeout');
  ui.update();
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, true, 'success ribbon stays collapsed while the same success activity is polled');
  view = { ...view, activity: { phase: 'providerIssue', severity: 'warning', label: 'Provider test failed.' } };
  ui.update();
  assertEqual(root.querySelector('[data-recursion-activity-ribbon]').hidden, false, 'warning ribbon appears immediately and persists');
  root.querySelector('[data-recursion-viewer-close]').click();
  assertEqual(closeCount, 1, 'viewer close listener is not duplicated across updates');

  view = { settings: { mode: 'auto' }, activity: { phase: 'idle' }, lastHand: { cards: [] } };
  ui.update();
  const idleViewerText = fakeDocument.textTree(viewer);
  assert(!idleViewerText.includes('Recursion is working...'), 'idle viewer does not report active work');

  view = sensitiveView;
  ui.update();
  const viewerText = fakeDocument.textTree(viewer);
  assert(!viewerText.includes('Raw prompt text'), 'viewer omits raw prompt sections');
  assert(!viewerText.includes('sk-ui-packet'), 'viewer redacts packet secrets');
  assert(!viewerText.includes('private-secret'), 'viewer redacts private secret text');
  assert(!viewerText.includes('Bearer ui-token'), 'viewer redacts settings secrets');
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
}

console.log('[pass] ui');
