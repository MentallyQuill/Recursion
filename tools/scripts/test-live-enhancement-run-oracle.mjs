import { readFileSync } from 'node:fs';
import { assert, assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';
import { hashJson } from '../../src/core.mjs';

const oracleModule = await import('./lib/live-enhancement-run-oracle.mjs').catch(() => ({}));
const oracleSource = readFileSync('tools/scripts/lib/live-enhancement-run-oracle.mjs', 'utf8');
const evaluate = typeof oracleModule.evaluateLiveEnhancementRun === 'function'
  ? oracleModule.evaluateLiveEnhancementRun
  : () => ({ ok: true, failures: [] });
const journalDeltaSince = oracleModule.journalDeltaSince;
const evaluateMutation = typeof oracleModule.evaluateEnhancementMutation === 'function'
  ? oracleModule.evaluateEnhancementMutation
  : () => ({ ok: true, failures: [] });

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

const sourceText = 'Original response.';
const candidateText = 'Repaired response.';
const beforeMutation = {
  chatKey: 'proof-chat',
  messageId: 7,
  swipeCount: 1,
  swipeId: 0,
  text: sourceText
};
const healthyMarker = {
  schema: 'recursion.editorialMarker.v1',
  chatKey: 'proof-chat',
  messageId: 7,
  swipeId: 0,
  mode: 'repair',
  applyMode: 'as-swipe',
  sourceHash: hashJson(sourceText),
  candidateHash: hashJson(candidateText),
  diagnosisHash: 'diagnosis-hash',
  outcome: 'applied'
};
const afterMutation = {
  ...beforeMutation,
  swipeCount: 2,
  swipeId: 1,
  text: candidateText,
  marker: healthyMarker
};
const healthyEnhancementResult = {
  ok: true,
  partialFailed: false,
  mode: 'repair',
  marker: healthyMarker
};
const healthyEditorialResult = {
  mode: 'repair',
  status: 'success',
  outcome: 'applied',
  applyMode: 'as-swipe'
};
const mutationInput = {
  enhancement: { enabled: true, mode: 'repair', applyMode: 'as-swipe' },
  before: beforeMutation,
  after: afterMutation,
  enhancementResult: healthyEnhancementResult,
  editorialResult: healthyEditorialResult
};

assertEqual(
  evaluateMutation(mutationInput).ok,
  true,
  'mutation oracle accepts exactly one selected, source-bound Enhancement swipe'
);

const mutationNegativeControls = [
  {
    label: 'missing explicit enabled flag',
    input: {
      ...mutationInput,
      enhancement: { mode: 'repair', applyMode: 'as-swipe' }
    },
    failure: 'enhancement-enabled-invalid'
  },
  {
    label: 'unknown Enhancement mode',
    input: {
      ...mutationInput,
      enhancement: { enabled: true, mode: 'unknown', applyMode: 'as-swipe' }
    },
    failure: 'enhancement-mode-invalid'
  },
  {
    label: 'missing source message identity',
    input: {
      ...mutationInput,
      before: { ...beforeMutation, messageId: null }
    },
    failure: 'enhancement-before-state-missing'
  },
  {
    label: 'trusted booleans without concrete evidence',
    input: {
      enhancement: mutationInput.enhancement,
      enhancementMutation: { kind: 'swipe', recursionOwned: true, validated: true }
    },
    failure: 'enhancement-before-state-missing'
  },
  {
    label: 'no appended swipe',
    input: { ...mutationInput, after: { ...afterMutation, swipeCount: 1, swipeId: 0 } },
    failure: 'enhancement-swipe-count-invalid'
  },
  {
    label: 'two appended swipes',
    input: { ...mutationInput, after: { ...afterMutation, swipeCount: 3, swipeId: 2 } },
    failure: 'enhancement-swipe-count-invalid'
  },
  {
    label: 'new swipe not selected',
    input: { ...mutationInput, after: { ...afterMutation, swipeId: 0 } },
    failure: 'enhancement-swipe-selection-invalid'
  },
  {
    label: 'missing marker',
    input: { ...mutationInput, after: { ...afterMutation, marker: null } },
    failure: 'enhancement-marker-missing'
  },
  {
    label: 'stale source identity',
    input: {
      ...mutationInput,
      after: {
        ...afterMutation,
        marker: { ...healthyMarker, chatKey: 'stale-chat', messageId: 6 }
      }
    },
    failure: 'enhancement-marker-identity-mismatch'
  },
  {
    label: 'candidate hash mismatch',
    input: {
      ...mutationInput,
      after: {
        ...afterMutation,
        marker: { ...healthyMarker, candidateHash: hashJson('Different text.') }
      }
    },
    failure: 'enhancement-marker-candidate-mismatch'
  },
  {
    label: 'partial failure',
    input: {
      ...mutationInput,
      enhancementResult: { ...healthyEnhancementResult, partialFailed: true },
      editorialResult: { ...healthyEditorialResult, status: 'partial-failed', outcome: 'partial-failed' }
    },
    failure: 'enhancement-result-partial-failed'
  },
  {
    label: 'skipped result',
    input: {
      ...mutationInput,
      enhancementResult: { ok: true, skipped: true, mode: 'repair' },
      editorialResult: { ...healthyEditorialResult, status: 'skipped', outcome: 'original-kept' }
    },
    failure: 'enhancement-result-skipped'
  },
  {
    label: 'unhealthy Editorial settlement',
    input: {
      ...mutationInput,
      editorialResult: { ...healthyEditorialResult, status: 'error', outcome: 'original-kept' }
    },
    failure: 'enhancement-editorial-result-unhealthy'
  }
];

for (const control of mutationNegativeControls) {
  const result = evaluateMutation(control.input);
  assertEqual(result.ok, false, `mutation oracle rejects ${control.label}`);
  assert(
    result.failures.includes(control.failure),
    `mutation oracle reports ${control.failure} for ${control.label}`
  );
}

const replaceMarker = {
  ...healthyMarker,
  applyMode: 'replace'
};
const healthyReplace = evaluateMutation({
  enhancement: { enabled: true, mode: 'repair', applyMode: 'replace' },
  before: beforeMutation,
  after: {
    ...beforeMutation,
    text: candidateText,
    marker: replaceMarker
  },
  enhancementResult: {
    ...healthyEnhancementResult,
    marker: replaceMarker
  },
  editorialResult: {
    ...healthyEditorialResult,
    applyMode: 'replace'
  }
});
assertEqual(healthyReplace.ok, true, 'mutation oracle accepts a validated in-place replacement');
assertEqual(
  evaluateMutation({
    enhancement: { enabled: true, mode: 'repair', applyMode: 'replace' },
    before: beforeMutation,
    after: { ...beforeMutation, marker: replaceMarker },
    enhancementResult: { ...healthyEnhancementResult, marker: replaceMarker },
    editorialResult: { ...healthyEditorialResult, applyMode: 'replace' }
  }).ok,
  false,
  'mutation oracle rejects a Replace result that did not change text'
);
assertEqual(
  evaluateMutation({
    enhancement: { enabled: false, mode: 'off', applyMode: 'as-swipe' },
    before: beforeMutation,
    after: beforeMutation
  }).ok,
  true,
  'mutation oracle accepts no mutation while Enhancement is off'
);
assertEqual(
  evaluateMutation({
    enhancement: { enabled: false, mode: 'off', applyMode: 'as-swipe' },
    before: beforeMutation,
    after: afterMutation
  }).ok,
  false,
  'mutation oracle rejects Recursion mutation while Enhancement is off'
);

const doneRows = [
  { label: 'Editorial diagnosis', state: 'done' },
  { label: 'Editorial candidate', state: 'done' },
  { label: 'Editorial verification', state: 'done' },
  { label: 'Recursion prompt ready', state: 'done' }
];

const negativeControls = [
  evaluate({
    transitions: [
      { label: 'Editorial candidate', state: 'caution' },
      { label: 'Editorial candidate', state: 'done' }
    ],
    finalRows: doneRows,
    journalDelta: [],
    ...mutationInput
  }),
  evaluate({
    transitions: [
      { label: 'Editorial diagnosis', state: 'failed' },
      { label: 'Editorial diagnosis', state: 'done' }
    ],
    finalRows: doneRows,
    journalDelta: [],
    ...mutationInput
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
    ...mutationInput
  }),
  evaluate({
    transitions: [...doneRows, { label: 'Editorial enhancement', state: 'skipped' }],
    finalRows: [...doneRows, { label: 'Editorial enhancement', state: 'skipped' }],
    journalDelta: [],
    ...mutationInput,
    enhancementResult: { ok: true, skipped: true, mode: 'repair' },
    editorialResult: { ...healthyEditorialResult, status: 'skipped', outcome: 'original-kept' }
  })
];

assertDeepEqual(
  negativeControls.map((result) => result.ok),
  [false, false, false, false],
  'strict live enhancement oracle rejects every false-pass negative control'
);
assert(
  negativeControls[0].failures.includes('progress-unhealthy-reason-missing'),
  'strict live enhancement oracle rejects caution without a visible reason'
);
assert(
  negativeControls[1].failures.includes('progress-unhealthy-reason-missing'),
  'strict live enhancement oracle rejects a replaced failure without a visible reason'
);
assert(
  negativeControls[2].failures.includes('journal-unhealthy-reason-missing'),
  'strict live enhancement oracle rejects journal-only failure without a normalized reason'
);

const explainedUnhealthy = evaluate({
  transitions: [
    { label: 'Editorial candidate', state: 'failed', reason: 'Provider call timed out.' },
    { label: 'Editorial candidate', state: 'done' }
  ],
  finalRows: doneRows,
  journalDelta: [{
    id: 'journal-explained-failure',
    runId: 'editorial-explained',
    severity: 'error',
    event: 'provider.call.failed',
    details: {
      roleId: 'editorialTransformer',
      failure: {
        code: 'RECURSION_PROVIDER_TIMEOUT',
        stage: 'editorial-writer',
        category: 'provider-timeout',
        message: 'Provider call timed out.'
      }
    }
  }],
  ...mutationInput
});
assertEqual(explainedUnhealthy.ok, false, 'explained unhealthy run still cannot pass');
assert(
  !explainedUnhealthy.failures.includes('progress-unhealthy-reason-missing'),
  'concrete progress reason satisfies the explanation contract'
);
assert(
  !explainedUnhealthy.failures.includes('journal-unhealthy-reason-missing'),
  'normalized journal failure satisfies the explanation contract'
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
  ...mutationInput
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
  ...mutationInput
});
assertEqual(healthy.ok, true, 'strict live enhancement oracle accepts a fully healthy concrete enhancement');
const repairRowsWithoutVerifier = doneRows.filter((row) => row.label !== 'Editorial verification');
assertEqual(
  evaluate({
    transitions: repairRowsWithoutVerifier,
    finalRows: repairRowsWithoutVerifier,
    journalDelta: [],
    ...mutationInput
  }).ok,
  true,
  'strict live enhancement oracle does not require a verifier row for Repair'
);
assert(
  evaluate({
    transitions: repairRowsWithoutVerifier,
    finalRows: repairRowsWithoutVerifier,
    journalDelta: [],
    ...mutationInput,
    enhancement: { ...mutationInput.enhancement, mode: 'redirect' },
    enhancementResult: { ...mutationInput.enhancementResult, mode: 'redirect' },
    editorialResult: { ...mutationInput.editorialResult, mode: 'redirect' },
    after: {
      ...mutationInput.after,
      marker: { ...mutationInput.after.marker, mode: 'redirect' }
    }
  }).failures.includes('missing-editorial-verification'),
  'strict live enhancement oracle keeps verifier progress mandatory for Redirect'
);

const healthyReplacedTree = evaluate({
  transitions: doneRows.map((row) => ({ ...row, source: 'removed' })),
  finalRows: [
    { label: 'Utility card batch', state: 'done' },
    { label: 'Recursion prompt ready', state: 'done' }
  ],
  journalDelta: [],
  ...mutationInput
});
assertEqual(
  healthyReplacedTree.ok,
  true,
  'strict live enhancement oracle accepts required done rows that were later replaced while retaining historical health'
);
assert(oracleSource.includes('attributeOldValue: true'), 'browser oracle requests progress attribute old values');
assert(oracleSource.includes('mutation.oldValue'), 'browser oracle records transient progress states from mutation old values');
assert(oracleSource.includes('data-recursion-progress-reason'), 'browser oracle records visible progress reasons');

for (const scriptPath of [
  'tools/scripts/lib/live-editorial-effectiveness.mjs',
  'tools/scripts/prove-live-card-progress.mjs'
]) {
  const source = readFileSync(scriptPath, 'utf8');
  assert(source.includes('installLiveEnhancementRunOracle'), `${scriptPath} installs the strict live enhancement oracle before generation`);
  assert(source.includes('collectLiveEnhancementRunOracle'), `${scriptPath} collects the strict live enhancement oracle before reporting pass`);
  assert(
    source.includes('collectLiveEnhancementRunOracle(page, {'),
    `${scriptPath} supplies concrete before/after certification evidence to the strict oracle`
  );
  assert(
    !source.includes('enhancementMutation:'),
    `${scriptPath} does not supply trusted Enhancement mutation booleans`
  );
  assert(/oracle(?:\?\.|\.)verdict(?:\?\.|\.)ok/.test(source), `${scriptPath} gates its pass result on the strict oracle verdict`);
}
const cardProgressSource = readFileSync('tools/scripts/prove-live-card-progress.mjs', 'utf8');
assert(
  cardProgressSource.includes('__recursionLiveCardProgressInitialAssistant'),
  'card-progress proof captures the actual initial assistant state at the host boundary'
);
assert(
  !cardProgressSource.includes('swipeCount: assistant ? 1 : 0'),
  'card-progress proof does not manufacture a one-swipe before state after Enhancement settles'
);

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
  proofSource.includes("enhancementMode: 'repair'"),
  'live Enhancement proof includes a real-provider Repair scenario'
);
assert(
  proofSource.includes('repair-bounded-patches'),
  'live Enhancement proof names its bounded-patch Repair certification case'
);
assert(
  effectivenessSource.includes("reasoningLevel: scenario?.forceUtilityEnhancement === true ? 'low' : 'medium'"),
  'Utility-only live proof selects the explicit Low policy lane without mutating provider capability'
);
assert(
  effectivenessSource.includes('scenario: { ...scenario, forceUtilityEnhancement }'),
  'Utility-only live proof passes the explicit policy override into the production scenario'
);
assert(
  !effectivenessSource.includes("updateProvider('reasoner'"),
  'Utility-only live proof never mutates Reasoner configuration'
);
assert(
  effectivenessSource.includes("document.querySelector('[data-recursion-status-popover]')?.hidden === false"),
  'live Redirect proof opens the progress popover before visual capture'
);
const progressOpenIndex = effectivenessSource.indexOf('await ensureProgressPopoverOpen(page);');
assert(
  progressOpenIndex >= 0
    && progressOpenIndex < effectivenessSource.indexOf('await installLiveEnhancementRunOracle(page);'),
  'live Enhancement proof renders the progress surface before installing its transition observer'
);
assert(effectivenessSource.includes('phoneScreenshotPath'), 'live Redirect proof records a compact-phone visual confirmation');
assert(
  /catch \(error\) \{\s*await browser\.close\(\)\.catch/.test(effectivenessSource),
  'live Redirect proof closes Chromium when browser setup or provider preflight fails'
);
const rapidWarmCall = "runtime.warmRapidScene({ reason: `live-${enhancementMode}-warm-${scenario.id}` })";
assert(effectivenessSource.includes(rapidWarmCall), 'live Enhancement proof explicitly primes Rapid background warm');
assert(
  effectivenessSource.indexOf(rapidWarmCall)
    < effectivenessSource.indexOf("runtime.prepareForGeneration({ userMessage: pendingUserMessage })"),
  'live Redirect proof awaits Rapid background warm before the strict foreground preparation'
);
const preparationCallIndex = effectivenessSource.indexOf("runtime.prepareForGeneration({ userMessage: pendingUserMessage })");
const preparationPopoverIndex = effectivenessSource.indexOf('live-progress-popover-not-rendered');
assert(
  preparationPopoverIndex >= 0 && preparationPopoverIndex < preparationCallIndex,
  'live Enhancement proof remounts progress after settings changes and before preparation'
);
const preparationRenderIndex = effectivenessSource.indexOf('live-prompt-ready-not-rendered', preparationCallIndex);
const enhancementCallIndex = effectivenessSource.indexOf("runtime.enhanceLatestAssistantMessage({ reason: `live-${enhancementMode}-${scenario.id}` })");
assert(
  preparationCallIndex >= 0 && preparationRenderIndex > preparationCallIndex && preparationRenderIndex < enhancementCallIndex,
  'live Redirect proof gives prompt-ready one browser render boundary before post-generation Enhancement begins'
);

console.log('[pass] live enhancement run oracle');
