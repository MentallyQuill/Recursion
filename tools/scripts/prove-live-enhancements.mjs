import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadScenarioPack } from './lib/model-eval-harness.mjs';
import { runLiveEditorialEffectiveness } from './lib/live-editorial-effectiveness.mjs';
import { createRunId } from './lib/sillytavern-live-harness.mjs';

function envValue(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

const baseUrl = envValue('SILLYTAVERN_BASE_URL', 'http://127.0.0.1:8000');
const user = envValue('RECURSION_SILLYTAVERN_USER', 'recursion-soak-a');
const password = envValue('SILLYTAVERN_PASSWORD');
const targetModel = envValue('RECURSION_TARGET_MODEL', envValue('RECURSION_MODEL_EVAL_TARGET_MODEL'));
const judgeModel = envValue('RECURSION_JUDGE_MODEL', envValue('RECURSION_MODEL_EVAL_JUDGE_MODEL', targetModel));
const selectedCase = envValue('RECURSION_ENHANCEMENT_PROOF_CASE');
const forceUtilityEnhancement = ['1', 'true', 'yes', 'on']
  .includes(envValue('RECURSION_FORCE_UTILITY_ENHANCEMENT').toLowerCase());
const timeoutMs = Math.max(10000, Number(envValue('RECURSION_LIVE_TIMEOUT_MS', '120000')) || 120000);
const runId = createRunId('prove-live-enhancements');
const artifactRoot = join('artifacts', 'live-enhancements', runId);

const baseScenario = loadScenarioPack('core')
  .find((scenario) => scenario.id === 'redirect-turn-deferral');
if (!baseScenario) throw new Error('Core Redirect proof scenario redirect-turn-deferral is missing.');

const selectedParts = selectedCase.toLowerCase().split('-').filter(Boolean);
const pipelineModes = selectedCase ? [selectedParts[0]] : ['standard', 'rapid', 'fused'];
const validModes = new Set(['standard', 'rapid', 'fused']);
if (pipelineModes.some((mode) => !validModes.has(mode))) {
  throw new Error(`RECURSION_ENHANCEMENT_PROOF_CASE must select standard, rapid, or fused; got ${selectedCase}.`);
}

const selectedEnhancementMode = selectedParts.find((part) => ['repair', 'redirect'].includes(part)) || '';
const enhancementModes = selectedEnhancementMode ? [selectedEnhancementMode] : ['redirect', 'repair'];
const repairScenario = {
  ...baseScenario,
  id: 'repair-bounded-patches',
  title: 'Repair duplicated words through bounded patches',
  tags: ['editorial', 'repair'],
  enhancementMode: 'repair',
  enhancementSource: [
    'Carter leaned leaned forward over the diner table.',
    '"We should begin the test now," she said said.',
    'O\'Neill nodded, his nod nodding once as he reached for the notebook.'
  ].join(' ')
};
const scenarios = pipelineModes.flatMap((pipelineMode) => enhancementModes.map((enhancementMode) => {
  const scenario = enhancementMode === 'repair' ? repairScenario : baseScenario;
  return {
    ...scenario,
    id: `${scenario.id}-${pipelineMode}`,
    enhancementMode,
    pipelineMode
  };
}));

mkdirSync(artifactRoot, { recursive: true });
const result = await runLiveEditorialEffectiveness({
  scenarios,
  baseUrl,
  user,
  password,
  targetModel,
  judgeModel,
  forceUtilityEnhancement,
  timeoutMs,
  failFast: false,
  artifactRoot
});

const report = {
  recordType: 'recursion.liveEnhancementsProof',
  schemaVersion: 3,
  runId,
  baseUrl,
  user,
  evidenceClass: 'served-runtime-synthetic-message-real-provider',
  artifactRoot,
  finishedAt: new Date().toISOString(),
  ...result
};

console.log(JSON.stringify(report, null, 2));
if (report.status !== 'pass') process.exitCode = 1;
