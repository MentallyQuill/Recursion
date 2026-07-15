import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  computeCardSelectionMetrics,
  estimateModelCalls,
  loadScenarioPack,
  parseEvalArgs,
  runModelEval,
  scanModelEvalRedactions
} from './lib/model-eval-harness.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

const parsed = parseEvalArgs([
  '--live',
  '--pack', 'smoke',
  '--profile', 'manual-focused',
  '--runs', '2',
  '--user', 'recursion-soak-a',
  '--target-model', 'target-model',
  '--judge-model', 'judge-model',
  '--character-name', 'Story',
  '--chat-file', 'Branch #790 - 2025-08-28@18h02m24s',
  '--max-provider-calls', '30',
  '--write-artifacts'
]);
assertEqual(parsed.live, true, 'parseEvalArgs records live flag');
assertEqual(parsed.pack, 'smoke', 'parseEvalArgs records pack');
assertEqual(parsed.profile, 'manual-focused', 'parseEvalArgs records profile');
assertEqual(parsed.runs, 2, 'parseEvalArgs records numeric runs');
assertEqual(parsed.user, 'recursion-soak-a', 'parseEvalArgs records soak user');
assertEqual(parsed.targetModel, 'target-model', 'parseEvalArgs records target model');
assertEqual(parsed.judgeModel, 'judge-model', 'parseEvalArgs records judge model');
assertEqual(parsed.characterName, 'Story', 'parseEvalArgs records live seed character');
assertEqual(parsed.chatFile, 'Branch #790 - 2025-08-28@18h02m24s', 'parseEvalArgs records live seed chat file');
assertEqual(parsed.maxProviderCalls, 30, 'parseEvalArgs records provider-call cap');

const smokeScenarios = loadScenarioPack('smoke');
assertEqual(smokeScenarios.length, 6, 'smoke pack ships six checked-in scenarios');
assertDeepEqual(
  smokeScenarios.map((scenario) => scenario.oracle.expectedFamilies.length > 0),
  [true, true, true, true, true, true],
  'each smoke scenario has expected-family oracle metadata'
);
assert(smokeScenarios.every((scenario) => scenario.oracle.mustNotReveal.length > 0), 'each smoke scenario has forbidden reveal metadata');

const coreRedirectScenarios = loadScenarioPack('core');
assertEqual(coreRedirectScenarios.length, 6, 'core pack ships six Redirect effectiveness scenarios');
assert(coreRedirectScenarios.every((scenario) => scenario.tags.includes('editorial') && scenario.tags.includes('redirect')), 'every Redirect core scenario carries both routing tags');
assert(coreRedirectScenarios.every((scenario) => scenario.oracle.editorialRedirect.sourceResponse), 'every Redirect core scenario freezes a flawed source response');
assert(coreRedirectScenarios.every((scenario) => scenario.oracle.editorialRedirect.expectedDecision === 'proceed'), 'every explicit Redirect scenario requires a directional replacement');
assert(coreRedirectScenarios.every((scenario) => scenario.oracle.editorialRedirect.replacementObjective), 'every Redirect core scenario defines a replacement objective');
assert(coreRedirectScenarios.every((scenario) => scenario.oracle.editorialRedirect.pressureExpectations.length > 0), 'every Redirect core scenario defines pressure expectations');

const callEstimate = estimateModelCalls({
  scenarioCount: smokeScenarios.length,
  runs: 2,
  profile: 'manual-focused',
  judgeTasks: ['cards', 'packet', 'output']
});
assertDeepEqual(callEstimate, {
  utility: 24,
  reasoner: 0,
  target: 24,
  judge: 36,
  total: 84
}, 'call estimate separates Utility, Reasoner, target, and judge calls');

const metrics = computeCardSelectionMetrics([
  {
    scenario: smokeScenarios[0],
    selectedCardRefs: [
      { id: 'card-items', family: 'Items' },
      { id: 'card-active-cast', family: 'Active Cast' }
    ],
    generatedCards: [
      { id: 'card-items', family: 'Items', promptText: 'Mara has the only keycard.', evidenceRefs: ['message:2'] },
      { id: 'card-active-cast', family: 'Active Cast', promptText: 'Mara blocks the hatch.', evidenceRefs: ['message:3'] }
    ],
    promptPacket: {
      selectedCardRefs: [
        { id: 'card-items', family: 'Items' },
        { id: 'card-active-cast', family: 'Active Cast' }
      ],
      injectionPlan: [
        { section: 'cardEvidence', sourceIds: ['card-items', 'card-active-cast'] }
      ],
      omissions: []
    }
  },
  {
    scenario: smokeScenarios[1],
    selectedCardRefs: [
      { id: 'card-knowledge', family: 'Knowledge' },
      { id: 'card-knowledge-2', family: 'Knowledge' }
    ],
    generatedCards: [
      { id: 'card-knowledge', family: 'Knowledge', promptText: 'Do not reveal the sealed order.', evidenceRefs: [] },
      { id: 'card-knowledge-2', family: 'Knowledge', promptText: 'Do not reveal the sealed order.', evidenceRefs: [] }
    ],
    promptPacket: {
      selectedCardRefs: [
        { id: 'card-knowledge', family: 'Knowledge' },
        { id: 'card-knowledge-2', family: 'Knowledge' }
      ],
      injectionPlan: [
        { section: 'guardrails', sourceIds: ['card-knowledge'] }
      ],
      omissions: []
    }
  }
]);
assertEqual(metrics.scenarioCount, 2, 'metrics record scenario count');
assert(metrics.expectedFamilyCoverage.selectedHand < 1, 'metrics detect missing expected selected families');
assert(metrics.selectedFamilyEntropy > 0, 'metrics compute selected-family entropy');
assert(metrics.topFamilyConcentration >= 0.5, 'metrics compute top family concentration');
assertEqual(metrics.nearDuplicateCardRate, 0.5, 'metrics detect near-duplicate generated card text');
assertEqual(metrics.evidenceCoverage, 0.5, 'metrics detect missing evidence refs');
assertEqual(metrics.compositionLossRate, 0.25, 'metrics detect selected card lost from prompt packet sources');

const redaction = scanModelEvalRedactions({
  ok: { nested: 'safe synthetic text' },
  bad: { apiKey: 'sk-secret' }
});
assertEqual(redaction.ok, false, 'redaction scan rejects secret-like keys and values');
assert(redaction.failures.some((failure) => failure.path.includes('apiKey')), 'redaction failure names secret path');

const artifactRoot = mkdtempSync(join(tmpdir(), 'recursion-model-eval-'));
try {
  const report = await runModelEval({
    argv: ['--dry-run', '--pack', 'smoke', '--profile', 'auto-normal', '--runs', '1', '--write-artifacts'],
    env: {},
    artifactRoot
  });
  assertEqual(report.recordType, 'recursion.modelEvalReport', 'dry-run report has model eval record type');
  assertEqual(report.status, 'skipped', 'dry-run does not make model calls');
  assertEqual(report.result, 'dry-run', 'dry-run result explicit');
  assertEqual(report.scenarioCount, 6, 'dry-run loads smoke pack');
  assertEqual(report.callEstimate.judge, 18, 'dry-run estimates judge calls');
  assertEqual(report.artifacts.report, 'report.json', 'dry-run writes report artifact path');
  assertEqual(report.artifacts.summary, 'summary.md', 'dry-run writes summary artifact path');
  assertEqual(report.artifacts.redactionCheck, 'redaction-check.json', 'dry-run writes standalone redaction-check artifact path');
  const persisted = JSON.parse(readFileSync(join(artifactRoot, report.runId, 'report.json'), 'utf8'));
  assertEqual(persisted.runId, report.runId, 'artifact report persisted under run root');
  const redactionCheck = JSON.parse(readFileSync(join(artifactRoot, report.runId, 'redaction-check.json'), 'utf8'));
  assertEqual(redactionCheck.ok, true, 'standalone redaction check persisted');
  const summary = readFileSync(join(artifactRoot, report.runId, 'summary.md'), 'utf8');
  assert(summary.includes('## Call Estimate'), 'summary records provider-call estimate');
} finally {
  rmSync(artifactRoot, { recursive: true, force: true });
}

const unsafe = await runModelEval({
  argv: ['--live', '--pack', 'smoke', '--user', 'default-user'],
  env: { SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000' }
});
assertEqual(unsafe.status, 'unsafe-user', 'live eval rejects default-user before mutation');
assertEqual(unsafe.result, 'unsafe-user', 'unsafe-user result explicit');

const missingModelConfig = await runModelEval({
  argv: ['--live', '--pack', 'smoke', '--user', 'recursion-soak-a'],
  env: { SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000' }
});
assertEqual(missingModelConfig.status, 'environment-fail', 'live eval rejects missing target or judge model before calls');
assertEqual(missingModelConfig.result, 'missing-model-config', 'missing model config result explicit');

let smokeRunnerEnv = null;
const traversalOnly = await runModelEval({
  argv: [
    '--live',
    '--pack', 'smoke',
    '--user', 'recursion-soak-a',
    '--target-model', 'target-model',
    '--judge-model', 'judge-model',
    '--character-name', 'Story',
    '--chat-file', 'Branch #790 - 2025-08-28@18h02m24s',
    '--max-provider-calls', '100'
  ],
  env: { SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000' },
  liveSmokeRunner: async ({ argv, env }) => {
    smokeRunnerEnv = env;
    return {
      status: 'pass',
      result: 'generation-live-smoke',
      checks: [{ name: 'generation-live-smoke', status: 'pass' }],
      browser: {
        snapshot: {
          served: { status: 'served-extension-match' },
          generation: { triggerSource: 'ui-send', promptInstalled: true }
        }
      },
      argv
    };
  }
});
assertEqual(smokeRunnerEnv.RECURSION_LIVE_REASONER, '1', 'live eval enables Reasoner model-call smoke for Playwright traversal');
assertEqual(smokeRunnerEnv.RECURSION_LIVE_TIMEOUT_MS, '120000', 'live eval gives real model calls a longer traversal timeout');
assertEqual(smokeRunnerEnv.RECURSION_SILLYTAVERN_USER, 'recursion-soak-a', 'live eval passes dedicated user to Playwright traversal');
assertEqual(smokeRunnerEnv.RECURSION_LIVE_CHARACTER_NAME, 'Story', 'live eval forwards seeded story character to Playwright traversal');
assertEqual(smokeRunnerEnv.RECURSION_LIVE_CHAT_FILE, 'Branch #790 - 2025-08-28@18h02m24s', 'live eval forwards seeded story chat to Playwright traversal');
assertEqual(traversalOnly.status, 'skipped', 'live eval does not claim full pass before model-effectiveness judging exists');
assertEqual(traversalOnly.result, 'model-effectiveness-not-implemented', 'live eval records pending model-effectiveness lane');
assertEqual(traversalOnly.live.servedStatus, 'served-extension-match', 'live eval records served extension status from Playwright smoke');
assertEqual(traversalOnly.live.triggerSource, 'ui-send', 'live eval records Playwright trigger source');

const traversalFailure = await runModelEval({
  argv: [
    '--live',
    '--pack', 'smoke',
    '--user', 'recursion-soak-a',
    '--target-model', 'target-model',
    '--judge-model', 'judge-model',
    '--max-provider-calls', '100'
  ],
  env: { SILLYTAVERN_BASE_URL: 'http://127.0.0.1:8000' },
  liveSmokeRunner: async () => ({
    status: 'fail',
    result: 'generation-host-continuation-failed',
    checks: [{ name: 'browser-live-smoke', status: 'fail' }],
    browser: {
      snapshot: {
        served: { status: 'served-extension-match' },
        generation: {
          triggerSource: 'ui-send',
          promptInstalled: true,
          hostGenerationContinued: false,
          visibleSend: {
            inputMethod: 'fill+button-click+keyboard-enter+dom-click',
            inputValueLength: 73,
            acceptedAfter: '',
            activationAttempts: [{ method: 'button-click', chatLength: 2, accepted: false }]
          }
        }
      }
    }
  })
});
assertEqual(traversalFailure.status, 'fail', 'live eval propagates traversal failure status');
assertEqual(traversalFailure.defects.length, 1, 'live eval emits repair-ready defect record for traversal failure');
assertEqual(traversalFailure.defects[0].layer, 'live-host', 'traversal failure defect classifies live-host layer');
assertEqual(traversalFailure.defects[0].severity, 'high', 'host continuation traversal defect is high severity');
assert(traversalFailure.defects[0].reproduction.command.includes('eval-recursion-models.mjs'), 'defect includes reproduction command');
assert(traversalFailure.defects[0].regressionTarget.includes('test-live-harness'), 'defect names regression target');
assertEqual(traversalFailure.defects[0].evidence.visibleSend.inputValueLength, 73, 'defect includes visible-send diagnostic evidence');
assertEqual(traversalFailure.defects[0].evidence.visibleSend.acceptedAfter, '', 'defect records that visible send was not accepted');
assertEqual(traversalFailure.repairSummary.openDefects, 1, 'live eval summarizes open defects');

const passingTraversalRunner = async () => ({
  status: 'pass',
  result: 'generation-live-smoke',
  checks: [{ name: 'generation-live-smoke', status: 'pass' }],
  browser: {
    snapshot: {
      served: { status: 'served-extension-match' },
      generation: { triggerSource: 'ui-send', promptInstalled: true }
    }
  }
});
const coreLiveArgs = [
  '--live', '--strict', '--pack', 'core', '--user', 'recursion-soak-a',
  '--base-url', 'http://127.0.0.1:8000', '--target-model', 'target-model', '--judge-model', 'judge-model',
  '--max-provider-calls', '100'
];
let effectivenessOptions = null;
const passingEffectiveness = await runModelEval({
  argv: coreLiveArgs,
  env: {},
  liveSmokeRunner: passingTraversalRunner,
  editorialEffectivenessRunner: async (options) => {
    effectivenessOptions = options;
    return {
      status: 'pass',
      result: 'redirect-effectiveness-passed',
      scenarios: options.scenarios.map((scenario) => ({ scenarioId: scenario.id, status: 'pass' }))
    };
  }
});
assertEqual(passingEffectiveness.status, 'pass', 'strict core eval passes only with healthy Redirect effectiveness evidence');
assertEqual(passingEffectiveness.result, 'redirect-effectiveness-passed', 'strict core eval exposes Redirect effectiveness result');
assertEqual(passingEffectiveness.modelEffectiveness.redirect.scenarios.length, 6, 'strict core eval retains per-scenario effectiveness evidence');
assertEqual(effectivenessOptions.user, 'recursion-soak-a', 'effectiveness runner receives dedicated user');
assertEqual(effectivenessOptions.targetModel, 'target-model', 'effectiveness runner receives expected target model');
assertEqual(effectivenessOptions.judgeModel, 'judge-model', 'effectiveness runner receives expected judge model');

for (const control of [
  { name: 'skipped', result: { status: 'skipped', result: 'judge-not-run', scenarios: [] }, expected: 'redirect-effectiveness-skipped' },
  { name: 'malformed', result: null, expected: 'redirect-effectiveness-malformed' },
  { name: 'empty', result: { status: 'pass', result: 'redirect-effectiveness-passed', scenarios: [] }, expected: 'redirect-effectiveness-empty' },
  { name: 'semantic failure', result: { status: 'fail', result: 'redirect-semantic-failure', scenarios: [{ scenarioId: 'redirect-turn-deferral', status: 'fail' }] }, expected: 'redirect-semantic-failure' }
]) {
  const report = await runModelEval({
    argv: coreLiveArgs,
    env: {},
    liveSmokeRunner: passingTraversalRunner,
    editorialEffectivenessRunner: async () => control.result
  });
  assertEqual(report.status, 'fail', `strict core eval rejects ${control.name} effectiveness output`);
  assertEqual(report.result, control.expected, `strict core eval records ${control.name} result`);
}

let emptyCorpusRunnerCalls = 0;
const emptyCorpus = await runModelEval({
  argv: [...coreLiveArgs, '--scenario', 'missing-redirect-scenario'],
  env: {},
  liveSmokeRunner: passingTraversalRunner,
  editorialEffectivenessRunner: async () => {
    emptyCorpusRunnerCalls += 1;
    return { status: 'pass', result: 'redirect-effectiveness-passed', scenarios: [] };
  }
});
assertEqual(emptyCorpus.status, 'fail', 'strict core eval rejects an empty tagged corpus');
assertEqual(emptyCorpus.result, 'redirect-effectiveness-empty-corpus', 'empty core corpus has an explicit result');
assertEqual(emptyCorpusRunnerCalls, 0, 'empty core corpus fails before launching effectiveness runner');

let failFastForwarded = false;
await runModelEval({
  argv: [...coreLiveArgs, '--fail-fast'],
  env: {},
  liveSmokeRunner: passingTraversalRunner,
  editorialEffectivenessRunner: async (options) => {
    failFastForwarded = options.failFast === true;
    return { status: 'fail', result: 'redirect-semantic-failure', scenarios: [{ scenarioId: 'redirect-turn-deferral', status: 'fail' }] };
  }
});
assertEqual(failFastForwarded, true, 'model eval forwards fail-fast policy to Redirect effectiveness runner');

console.log('[pass] model eval harness');
