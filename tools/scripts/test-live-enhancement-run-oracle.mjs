import { readFileSync } from 'node:fs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';

const oracleModule = await import('./lib/live-enhancement-run-oracle.mjs').catch(() => ({}));
const oracleSource = readFileSync('tools/scripts/lib/live-enhancement-run-oracle.mjs', 'utf8');
const evaluate = typeof oracleModule.evaluateLiveEnhancementRun === 'function'
  ? oracleModule.evaluateLiveEnhancementRun
  : () => ({ ok: true, failures: [] });
const journalDeltaSince = oracleModule.journalDeltaSince;

assertEqual(typeof journalDeltaSince, 'function', 'live oracle exposes timestamp-bounded journal delta filtering');
assertDeepEqual(
  journalDeltaSince([
    { id: 'old-failure', recordedAt: '2026-07-14T14:44:54.983Z', event: 'provider.call.failed' },
    { id: 'baseline-entry', recordedAt: '2026-07-14T15:33:00.000Z', event: 'provider.call.completed' },
    { id: 'new-failure', recordedAt: '2026-07-14T15:33:02.000Z', event: 'provider.call.failed' }
  ], {
    baselineIds: ['baseline-entry'],
    startedAt: '2026-07-14T15:33:01.000Z'
  }).map((entry) => entry.id),
  ['new-failure'],
  'live oracle excludes stale retained journal failures but preserves current-run failures'
);

const doneRows = [
  { label: 'Editorial diagnosis', state: 'done' },
  { label: 'Editorial candidate', state: 'done' },
  { label: 'Editorial verification', state: 'done' },
  { label: 'Recursion prompt ready', state: 'done' }
];
const mutation = { kind: 'swipe', recursionOwned: true, validated: true };

const negativeControls = [
  evaluate({
    transitions: [
      { label: 'Editorial candidate', state: 'caution' },
      { label: 'Editorial candidate', state: 'done' }
    ],
    finalRows: doneRows,
    journalDelta: [],
    enhancementMutation: mutation
  }),
  evaluate({
    transitions: [
      { label: 'Editorial diagnosis', state: 'failed' },
      { label: 'Editorial diagnosis', state: 'done' }
    ],
    finalRows: doneRows,
    journalDelta: [],
    enhancementMutation: mutation
  }),
  evaluate({
    transitions: doneRows,
    finalRows: doneRows,
    journalDelta: [{
      id: 'journal-failed',
      runId: 'editorial-1',
      severity: 'error',
      event: 'provider.call.failed',
      details: { roleId: 'editorialTransformer' }
    }],
    enhancementMutation: mutation
  }),
  evaluate({
    transitions: [...doneRows, { label: 'Editorial enhancement', state: 'skipped' }],
    finalRows: [...doneRows, { label: 'Editorial enhancement', state: 'skipped' }],
    journalDelta: [],
    enhancementMutation: { kind: 'none', recursionOwned: false, validated: false }
  })
];

assertDeepEqual(
  negativeControls.map((result) => result.ok),
  [false, false, false, false],
  'strict live enhancement oracle rejects every false-pass negative control'
);

const unmatchedProvider = evaluate({
  transitions: doneRows,
  finalRows: doneRows,
  journalDelta: [{
    id: 'journal-started',
    runId: 'editorial-2',
    severity: 'info',
    event: 'provider.call.started',
    details: { roleId: 'editorialDiagnostician' },
    hashes: { requestHash: 'request-1' }
  }],
  enhancementMutation: mutation
});
assertEqual(unmatchedProvider.ok, false, 'strict live enhancement oracle rejects unmatched provider starts');

const healthy = evaluate({
  transitions: [
    { label: 'Editorial diagnosis', state: 'running' },
    { label: 'Editorial diagnosis', state: 'done' },
    { label: 'Editorial candidate', state: 'running' },
    { label: 'Editorial candidate', state: 'done' },
    { label: 'Editorial verification', state: 'running' },
    { label: 'Editorial verification', state: 'done' },
    { label: 'Recursion prompt ready', state: 'done' }
  ],
  finalRows: doneRows,
  journalDelta: [
    {
      id: 'journal-started',
      runId: 'editorial-3',
      severity: 'info',
      event: 'provider.call.started',
      details: { roleId: 'editorialDiagnostician' },
      hashes: { requestHash: 'request-2' }
    },
    {
      id: 'journal-completed',
      runId: 'editorial-3',
      severity: 'info',
      event: 'provider.call.completed',
      details: { roleId: 'editorialDiagnostician' },
      hashes: { requestHash: 'request-2' }
    }
  ],
  enhancementMutation: mutation
});
assertEqual(healthy.ok, true, 'strict live enhancement oracle accepts a fully healthy concrete enhancement');

const healthyReplacedTree = evaluate({
  transitions: doneRows.map((row) => ({ ...row, source: 'removed' })),
  finalRows: [
    { label: 'Utility card batch', state: 'done' },
    { label: 'Recursion prompt ready', state: 'done' }
  ],
  journalDelta: [],
  enhancementMutation: mutation
});
assertEqual(
  healthyReplacedTree.ok,
  true,
  'strict live enhancement oracle accepts required done rows that were later replaced while retaining historical health'
);
assert(oracleSource.includes('attributeOldValue: true'), 'browser oracle requests progress attribute old values');
assert(oracleSource.includes('mutation.oldValue'), 'browser oracle records transient progress states from mutation old values');

for (const scriptPath of [
  'tools/scripts/lib/live-editorial-effectiveness.mjs',
  'tools/scripts/prove-live-card-progress.mjs'
]) {
  const source = readFileSync(scriptPath, 'utf8');
  assert(source.includes('installLiveEnhancementRunOracle'), `${scriptPath} installs the strict live enhancement oracle before generation`);
  assert(source.includes('collectLiveEnhancementRunOracle'), `${scriptPath} collects the strict live enhancement oracle before reporting pass`);
  assert(/oracle(?:\?\.|\.)verdict(?:\?\.|\.)ok/.test(source), `${scriptPath} gates its pass result on the strict oracle verdict`);
}

const effectivenessSource = readFileSync('tools/scripts/lib/live-editorial-effectiveness.mjs', 'utf8');
const proofSource = readFileSync('tools/scripts/prove-live-enhancements.mjs', 'utf8');
assert(
  !effectivenessSource.includes('page.waitForFunction((expectedDecision)'),
  'live Redirect proof uses historical oracle transitions instead of requiring replaced preparation and Editorial rows to coexist'
);
assert(
  effectivenessSource.indexOf('const oracle = await collectLiveEnhancementRunOracle(page)')
    < effectivenessSource.indexOf('page.evaluate(executeJudgeInPage'),
  'live Redirect proof settles and collects production progress before the test-only effectiveness judge can replace it'
);
assert(
  proofSource.includes("envValue('RECURSION_FORCE_UTILITY_ENHANCEMENT'"),
  'live Redirect proof exposes an explicit Utility-only Enhancement switch'
);
assert(
  effectivenessSource.indexOf("runtime.updateProvider('reasoner', { enabled: false })")
    < effectivenessSource.indexOf('await installLiveEnhancementRunOracle(page)'),
  'Utility-only live proof disables Reasoner before installing the production-run oracle'
);
assert(
  effectivenessSource.indexOf('const oracle = await collectLiveEnhancementRunOracle(page)')
    < effectivenessSource.indexOf("runtime.updateProvider('reasoner', { enabled: true })")
    && effectivenessSource.indexOf("runtime.updateProvider('reasoner', { enabled: true })")
      < effectivenessSource.indexOf('page.evaluate(executeJudgeInPage'),
  'Utility-only live proof restores Reasoner after production evidence capture and before the independent judge'
);
assert(
  /finally\s*\{[\s\S]*restoreReasonerAfterEnhancement/.test(effectivenessSource),
  'Utility-only live proof restores Reasoner on exceptional exits'
);
assert(
  effectivenessSource.includes("document.querySelector('[data-recursion-status-popover]')?.hidden === false"),
  'live Redirect proof opens the progress popover before visual capture'
);
assert(effectivenessSource.includes('phoneScreenshotPath'), 'live Redirect proof records a compact-phone visual confirmation');
assert(
  /catch \(error\) \{\s*await browser\.close\(\)\.catch/.test(effectivenessSource),
  'live Redirect proof closes Chromium when browser setup or provider preflight fails'
);
const rapidWarmCall = "runtime.warmRapidScene({ reason: `live-redirect-warm-${scenario.id}` })";
assert(effectivenessSource.includes(rapidWarmCall), 'live Redirect proof explicitly primes Rapid background warm');
assert(
  effectivenessSource.indexOf(rapidWarmCall)
    < effectivenessSource.indexOf("runtime.prepareForGeneration({ userMessage: pendingUserMessage })"),
  'live Redirect proof awaits Rapid background warm before the strict foreground preparation'
);
const preparationCallIndex = effectivenessSource.indexOf("runtime.prepareForGeneration({ userMessage: pendingUserMessage })");
const preparationRenderIndex = effectivenessSource.indexOf('live-prompt-ready-not-rendered', preparationCallIndex);
const enhancementCallIndex = effectivenessSource.indexOf("runtime.enhanceLatestAssistantMessage({ reason: `live-redirect-${scenario.id}` })");
assert(
  preparationCallIndex >= 0 && preparationRenderIndex > preparationCallIndex && preparationRenderIndex < enhancementCallIndex,
  'live Redirect proof gives prompt-ready one browser render boundary before post-generation Enhancement begins'
);

console.log('[pass] live enhancement run oracle');
