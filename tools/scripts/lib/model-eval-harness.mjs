import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const PACKS = new Set(['smoke', 'core', 'stress']);
const PROFILES = new Set(['auto-normal', 'manual-focused', 'auto-rich-reasoner', 'low-lean', 'ultra-wide']);
const JUDGE_TASKS = Object.freeze(['cards', 'packet', 'output']);
const SECRET_KEY_PATTERN = /api[_-]?key|authorization|bearer|cookie|password|secret|token/i;
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]{6,}|bearer\s+[A-Za-z0-9._-]+|api[_-]?key)\b/i;

function nowIso() {
  return new Date().toISOString();
}

function hashText(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function parsePositiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.round(number));
}

function normalizePack(value) {
  const pack = String(value || 'smoke').trim().toLowerCase();
  return PACKS.has(pack) ? pack : 'smoke';
}

function normalizeProfile(value) {
  const profile = String(value || 'auto-normal').trim().toLowerCase();
  return PROFILES.has(profile) ? profile : 'auto-normal';
}

function camelFlag(name) {
  return String(name || '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function parseEvalArgs(argv = []) {
  const args = {
    live: false,
    dryRun: false,
    writeArtifacts: false,
    strict: false,
    collect: false,
    failFast: false,
    pack: 'smoke',
    profile: 'auto-normal',
    runs: 1,
    user: '',
    baseUrl: '',
    scenario: '',
    traversal: '',
    characterName: '',
    chatFile: '',
    utilityModel: '',
    reasonerModel: '',
    targetModel: '',
    judgeModel: '',
    maxProviderCalls: 0,
    maxEstimatedCost: 0
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index] || '');
    if (!raw.startsWith('--')) continue;
    const flag = raw.slice(2);
    if (['live', 'dry-run', 'write-artifacts', 'strict', 'collect', 'fail-fast'].includes(flag)) {
      args[camelFlag(flag)] = true;
      continue;
    }
    const value = String(argv[index + 1] || '');
    index += 1;
    const key = camelFlag(flag);
    if (key === 'pack') args.pack = normalizePack(value);
    else if (key === 'profile') args.profile = normalizeProfile(value);
    else if (key === 'runs') args.runs = Math.max(1, parsePositiveInt(value, 1));
    else if (key === 'maxProviderCalls') args.maxProviderCalls = parsePositiveInt(value, 0);
    else if (key === 'maxEstimatedCost') args.maxEstimatedCost = Number(value) || 0;
    else if (Object.prototype.hasOwnProperty.call(args, key)) args[key] = value;
  }
  return args;
}

function scenarioRoot(pack) {
  return resolve('tests', 'evaluation', 'scenarios', normalizePack(pack));
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
}

function normalizeScenario(source, filePath) {
  const scenario = source && typeof source === 'object' ? source : {};
  const oracle = scenario.oracle && typeof scenario.oracle === 'object' ? scenario.oracle : {};
  return {
    id: String(scenario.id || '').trim(),
    title: String(scenario.title || '').trim(),
    pack: normalizePack(scenario.pack),
    tags: normalizeStringArray(scenario.tags),
    snapshot: scenario.snapshot && typeof scenario.snapshot === 'object' ? scenario.snapshot : {},
    pendingUserMessage: String(scenario.pendingUserMessage || ''),
    settingsProfile: normalizeProfile(scenario.settingsProfile),
    oracle: {
      expectedFamilies: normalizeStringArray(oracle.expectedFamilies),
      allowedSupportingFamilies: normalizeStringArray(oracle.allowedSupportingFamilies),
      discouragedFamilies: normalizeStringArray(oracle.discouragedFamilies),
      mustUseFacts: normalizeStringArray(oracle.mustUseFacts),
      mustNotReveal: normalizeStringArray(oracle.mustNotReveal),
      mustAvoid: normalizeStringArray(oracle.mustAvoid),
      successCriteria: normalizeStringArray(oracle.successCriteria),
      editorialRedirect: {
        sourceResponse: String(oracle.editorialRedirect?.sourceResponse || ''),
        expectedDecision: String(oracle.editorialRedirect?.expectedDecision || ''),
        replacementObjective: String(oracle.editorialRedirect?.replacementObjective || ''),
        requiredBeats: normalizeStringArray(oracle.editorialRedirect?.requiredBeats),
        forbiddenSourceBeats: normalizeStringArray(oracle.editorialRedirect?.forbiddenSourceBeats),
        pressureExpectations: (Array.isArray(oracle.editorialRedirect?.pressureExpectations)
          ? oracle.editorialRedirect.pressureExpectations
          : []).map((entry) => ({
          character: String(entry?.character || '').trim(),
          effect: String(entry?.effect || '').trim(),
          responseRequired: entry?.responseRequired === true
        })).filter((entry) => entry.character && entry.effect)
      }
    },
    sourceFile: filePath
  };
}

export function loadScenarioPack(pack = 'smoke', { scenario = '' } = {}) {
  const root = scenarioRoot(pack);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const filePath = join(root, file);
      return normalizeScenario(JSON.parse(readFileSync(filePath, 'utf8')), filePath);
    })
    .filter((entry) => !scenario || entry.id === scenario);
}

export function estimateModelCalls({ scenarioCount = 0, runs = 1, profile = 'auto-normal', judgeTasks = JUDGE_TASKS } = {}) {
  const count = Math.max(0, Number(scenarioCount) || 0);
  const samples = count * Math.max(1, parsePositiveInt(runs, 1));
  const reasonerEligible = ['auto-rich-reasoner', 'ultra-wide'].includes(normalizeProfile(profile));
  return {
    utility: samples * 2,
    reasoner: reasonerEligible ? samples : 0,
    target: samples * 2,
    judge: samples * normalizeStringArray(judgeTasks).length,
    total: samples * (4 + normalizeStringArray(judgeTasks).length + (reasonerEligible ? 1 : 0))
  };
}

function family(entry) {
  return String(entry?.family || '').trim();
}

function id(entry) {
  return String(entry?.id || entry?.cardId || '').trim();
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function normalizeTextFingerprint(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function selectedSourceIds(packet = {}) {
  const ids = new Set();
  for (const block of Array.isArray(packet.injectionPlan) ? packet.injectionPlan : []) {
    for (const sourceId of normalizeStringArray(block?.sourceIds)) ids.add(sourceId);
  }
  return ids;
}

function omissionIds(packet = {}) {
  const ids = new Set();
  for (const omission of Array.isArray(packet.omissions) ? packet.omissions : []) {
    const omittedId = id(omission);
    if (omittedId) ids.add(omittedId);
  }
  return ids;
}

function entropy(values) {
  const total = values.length;
  if (!total) return 0;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const raw = [...counts.values()].reduce((sum, count) => {
    const p = count / total;
    return sum - (p * Math.log2(p));
  }, 0);
  const max = Math.log2(Math.max(2, counts.size));
  return max > 0 ? raw / max : 0;
}

export function computeCardSelectionMetrics(samples = []) {
  const selectedFamilies = [];
  let expectedRepresented = 0;
  let expectedTotal = 0;
  let discouragedSelected = 0;
  let selectedTotal = 0;
  let evidenceCards = 0;
  let generatedTotal = 0;
  let duplicateGenerated = 0;
  let selectedLost = 0;
  let selectedPromptTotal = 0;

  for (const sample of Array.isArray(samples) ? samples : []) {
    const scenario = sample?.scenario || {};
    const expected = new Set(normalizeStringArray(scenario.oracle?.expectedFamilies));
    const discouraged = new Set(normalizeStringArray(scenario.oracle?.discouragedFamilies));
    const selected = Array.isArray(sample?.selectedCardRefs) ? sample.selectedCardRefs : [];
    const selectedFamilySet = new Set(selected.map(family).filter(Boolean));
    for (const expectedFamily of expected) {
      expectedTotal += 1;
      if (selectedFamilySet.has(expectedFamily)) expectedRepresented += 1;
    }
    for (const card of selected) {
      const cardFamily = family(card);
      if (!cardFamily) continue;
      selectedFamilies.push(cardFamily);
      selectedTotal += 1;
      if (discouraged.has(cardFamily)) discouragedSelected += 1;
    }

    const fingerprints = new Map();
    for (const card of Array.isArray(sample?.generatedCards) ? sample.generatedCards : []) {
      generatedTotal += 1;
      if (Array.isArray(card?.evidenceRefs) && card.evidenceRefs.length > 0) evidenceCards += 1;
      const fingerprint = normalizeTextFingerprint(card?.promptText);
      if (!fingerprint) continue;
      fingerprints.set(fingerprint, (fingerprints.get(fingerprint) || 0) + 1);
    }
    duplicateGenerated += [...fingerprints.values()].reduce((sum, count) => sum + (count > 1 ? count : 0), 0);

    const packet = sample?.promptPacket || {};
    const sourceIds = selectedSourceIds(packet);
    const omittedIds = omissionIds(packet);
    const packetSelected = Array.isArray(packet.selectedCardRefs) ? packet.selectedCardRefs : selected;
    for (const card of packetSelected) {
      const cardId = id(card);
      if (!cardId) continue;
      selectedPromptTotal += 1;
      if (!sourceIds.has(cardId) && !omittedIds.has(cardId)) selectedLost += 1;
    }
  }

  const familyCounts = new Map();
  for (const selectedFamily of selectedFamilies) familyCounts.set(selectedFamily, (familyCounts.get(selectedFamily) || 0) + 1);
  const topFamilyCount = Math.max(0, ...familyCounts.values());

  return {
    scenarioCount: Array.isArray(samples) ? samples.length : 0,
    expectedFamilyCoverage: {
      selectedHand: safeRatio(expectedRepresented, expectedTotal)
    },
    discouragedFamilyRate: safeRatio(discouragedSelected, selectedTotal),
    selectedFamilyEntropy: entropy(selectedFamilies),
    topFamilyConcentration: safeRatio(topFamilyCount, selectedTotal),
    nearDuplicateCardRate: safeRatio(duplicateGenerated, generatedTotal),
    evidenceCoverage: safeRatio(evidenceCards, generatedTotal),
    compositionLossRate: safeRatio(selectedLost, selectedPromptTotal)
  };
}

function scanValue(value, path, failures) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (SECRET_KEY_PATTERN.test(key)) failures.push({ path: childPath, reason: 'secret-key' });
      scanValue(child, childPath, failures);
    }
    return;
  }
  if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) {
    failures.push({ path, reason: 'secret-value' });
  }
}

export function scanModelEvalRedactions(value) {
  const failures = [];
  scanValue(value, '', failures);
  return { ok: failures.length === 0, failures };
}

function validateSoakUser(user) {
  const normalized = String(user || '').trim().toLowerCase();
  return /^recursion-soak-[a-z0-9-]+$/.test(normalized)
    ? { ok: true, user: normalized }
    : { ok: false, user: normalized, reason: 'unsafe-user' };
}

function reportStatus(report, status, result) {
  report.status = status;
  report.result = result;
  return report;
}

async function defaultLiveSmokeRunner(options) {
  const { runSillyTavernLiveSmoke } = await import('./sillytavern-live-harness.mjs');
  return runSillyTavernLiveSmoke(options);
}

async function defaultEditorialEffectivenessRunner(options) {
  const { runLiveEditorialEffectiveness } = await import('./live-editorial-effectiveness.mjs');
  return runLiveEditorialEffectiveness(options);
}

function createRunId() {
  return `model-eval-${Date.now().toString(36)}-${hashText(Math.random()).slice(0, 6)}`;
}

function timeoutFloor(value, floorMs) {
  return String(Math.max(floorMs, parsePositiveInt(value, floorMs)));
}

function traversalDefectFromSmoke(smoke = {}, args = {}) {
  const result = String(smoke?.result || 'playwright-traversal-failed');
  const generation = smoke?.browser?.snapshot?.generation || {};
  const visibleSend = generation.visibleSend && typeof generation.visibleSend === 'object' ? generation.visibleSend : {};
  const layer = result.includes('host-continuation') ? 'live-host' : 'runtime';
  const severity = result.includes('secret') || result.includes('prompt-clear') || result.includes('host-continuation')
    ? 'high'
    : 'medium';
  const command = [
    'node tools\\scripts\\eval-recursion-models.mjs',
    '--live',
    '--pack', args.pack,
    '--profile', args.profile,
    '--runs', String(args.runs),
    '--user', args.user,
    '--target-model', args.targetModel || '<model-id>',
    '--judge-model', args.judgeModel || '<model-id>',
    '--max-provider-calls', String(args.maxProviderCalls || 0)
  ].filter(Boolean).join(' ');
  return {
    id: `defect-${result}`,
    severity,
    layer,
    status: 'open',
    traversalId: args.traversal || 'traversal-smoke',
    scenarioId: args.scenario || '',
    result,
    expected: 'Live Playwright traversal completes Recursion prompt install and host continuation checks.',
    actual: `Live Playwright traversal failed with ${result}.`,
    reproduction: { command },
    evidence: {
      triggerSource: String(generation.triggerSource || ''),
      promptInstalled: generation.promptInstalled === true,
      hostGenerationContinued: generation.hostGenerationContinued === null ? null : generation.hostGenerationContinued === true,
      visibleSend: {
        inputMethod: String(visibleSend.inputMethod || ''),
        inputValueLength: Number(visibleSend.inputValueLength) || 0,
        acceptedAfter: String(visibleSend.acceptedAfter || ''),
        activationAttempts: Array.isArray(visibleSend.activationAttempts)
          ? visibleSend.activationAttempts.map((entry) => ({
              method: String(entry?.method || ''),
              chatLength: typeof entry?.chatLength === 'number' ? entry.chatLength : null,
              accepted: entry?.accepted === true
            })).slice(0, 5)
          : []
      }
    },
    regressionTarget: 'tools/scripts/test-live-harness.mjs'
  };
}

function summarizeRepairs(defects = []) {
  const entries = Array.isArray(defects) ? defects : [];
  return {
    openDefects: entries.filter((entry) => entry?.status !== 'closed').length,
    highSeverityDefects: entries.filter((entry) => entry?.severity === 'high').length,
    repairReadyDefectRate: entries.length > 0
      ? entries.filter((entry) => entry?.reproduction?.command && entry?.expected && entry?.actual && entry?.regressionTarget).length / entries.length
      : 1
  };
}

function writeArtifacts(report, artifactRoot) {
  const runRoot = join(artifactRoot || join('artifacts', 'model-evals'), report.runId);
  mkdirSync(runRoot, { recursive: true });
  report.artifacts = {
    ...(report.artifacts || {}),
    report: 'report.json',
    redactionCheck: 'redaction-check.json',
    summary: 'summary.md'
  };
  const redaction = scanModelEvalRedactions(report);
  report.redaction = redaction;
  writeFileSync(join(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(runRoot, 'redaction-check.json'), `${JSON.stringify(redaction, null, 2)}\n`, 'utf8');
  writeFileSync(join(runRoot, 'summary.md'), modelEvalSummary(report), 'utf8');
}

function modelEvalSummary(report) {
  return [
    '# Recursion Model Evaluation',
    '',
    `Status: ${report.status}`,
    `Result: ${report.result}`,
    `Pack: ${report.pack}`,
    `Scenarios: ${report.scenarioCount}`,
    '',
    '## Call Estimate',
    '',
    `Utility: ${report.callEstimate?.utility ?? 0}`,
    `Reasoner: ${report.callEstimate?.reasoner ?? 0}`,
    `Target: ${report.callEstimate?.target ?? 0}`,
    `Judge: ${report.callEstimate?.judge ?? 0}`,
    `Total: ${report.callEstimate?.total ?? 0}`,
    ''
  ].join('\n');
}

export async function runModelEval({
  argv = [],
  env = process.env,
  artifactRoot = null,
  liveSmokeRunner = defaultLiveSmokeRunner,
  editorialEffectivenessRunner = defaultEditorialEffectivenessRunner
} = {}) {
  const args = parseEvalArgs(argv);
  if (env.SILLYTAVERN_BASE_URL && !args.baseUrl) args.baseUrl = env.SILLYTAVERN_BASE_URL;
  if (env.RECURSION_SILLYTAVERN_USER && !args.user) args.user = env.RECURSION_SILLYTAVERN_USER;
  const scenarios = loadScenarioPack(args.pack, { scenario: args.scenario });
  const report = {
    recordType: 'recursion.modelEvalReport',
    schemaVersion: 1,
    runId: createRunId(),
    generatedAt: nowIso(),
    status: 'skipped',
    result: 'dry-run',
    pack: args.pack,
    settingsProfiles: [args.profile],
    models: {
      target: args.targetModel || '',
      judge: args.judgeModel || ''
    },
    live: {
      baseUrlHash: args.baseUrl ? hashText(args.baseUrl) : '',
      user: args.user || '',
      servedStatus: '',
      triggerSource: ''
    },
    scenarioCount: scenarios.length,
    sampleCount: scenarios.length * args.runs,
    callEstimate: estimateModelCalls({ scenarioCount: scenarios.length, runs: args.runs, profile: args.profile, judgeTasks: JUDGE_TASKS }),
    metrics: {},
    judgeSummary: {},
    modelEffectiveness: {},
    defects: [],
    failures: [],
    warnings: []
  };

  if (args.live) {
    const user = validateSoakUser(args.user);
    if (!user.ok) {
      report.failures.push({ name: 'dedicated-user-policy', status: 'unsafe-user', summary: 'Live model eval requires recursion-soak-* user.' });
      return reportStatus(report, 'unsafe-user', 'unsafe-user');
    }
    if (!args.baseUrl) {
      report.failures.push({ name: 'base-url', status: 'environment-fail', summary: 'SILLYTAVERN_BASE_URL or --base-url is required.' });
      return reportStatus(report, 'environment-fail', 'missing-base-url');
    }
    if (!args.dryRun && (!args.targetModel || !args.judgeModel)) {
      report.failures.push({
        name: 'model-config',
        status: 'environment-fail',
        summary: 'Live model eval requires explicit --target-model and --judge-model.'
      });
      return reportStatus(report, 'environment-fail', 'missing-model-config');
    }
  }

  if (args.maxProviderCalls > 0 && report.callEstimate.total > args.maxProviderCalls) {
    report.failures.push({ name: 'provider-call-cap', status: 'environment-fail', summary: 'Estimated provider calls exceed cap.' });
    return reportStatus(report, 'environment-fail', 'provider-call-cap-exceeded');
  }

  if (args.live && !args.dryRun) {
    const redirectScenarios = scenarios.filter((scenario) => (
      scenario.tags.includes('editorial') && scenario.tags.includes('redirect')
    ));
    if (args.strict && args.pack === 'core' && redirectScenarios.length === 0) {
      report.failures.push({
        name: 'redirect-effectiveness-corpus',
        status: 'fail',
        summary: 'Strict Redirect effectiveness requires a non-empty tagged core corpus.'
      });
      return reportStatus(report, 'fail', 'redirect-effectiveness-empty-corpus');
    }
    const smokeEnv = {
      ...env,
      SILLYTAVERN_BASE_URL: args.baseUrl,
      RECURSION_SILLYTAVERN_USER: args.user,
      RECURSION_LIVE_TIMEOUT_MS: timeoutFloor(env.RECURSION_LIVE_TIMEOUT_MS, 120000),
      RECURSION_LIVE_REASONER: '1',
      RECURSION_LIVE_CHARACTER_NAME: args.characterName || env.RECURSION_LIVE_CHARACTER_NAME || '',
      RECURSION_LIVE_CHAT_FILE: args.chatFile || env.RECURSION_LIVE_CHAT_FILE || ''
    };
    const smoke = await liveSmokeRunner({
      argv: ['--live', '--strict', ...(args.writeArtifacts ? ['--write-artifacts'] : [])],
      env: smokeEnv,
      artifactRoot
    });
    report.traversal = {
      status: smoke?.status || 'fail',
      result: smoke?.result || 'unknown',
      checks: Array.isArray(smoke?.checks)
        ? smoke.checks.map((check) => ({
            name: String(check?.name || ''),
            status: String(check?.status || '')
          }))
        : []
    };
    report.live.servedStatus = String(smoke?.browser?.snapshot?.served?.status || '');
    report.live.triggerSource = String(smoke?.browser?.snapshot?.generation?.triggerSource || '');
    if (smoke?.status !== 'pass') {
      report.defects.push(traversalDefectFromSmoke(smoke, args));
      report.failures.push({
        name: 'playwright-traversal',
        status: smoke?.status || 'fail',
        summary: `Live Playwright traversal failed: ${smoke?.result || 'unknown'}`
      });
      reportStatus(report, smoke?.status || 'fail', smoke?.result || 'playwright-traversal-failed');
    } else if (redirectScenarios.length > 0) {
      const redirectEffectiveness = await editorialEffectivenessRunner({
        scenarios: redirectScenarios,
        task: 'output',
        baseUrl: args.baseUrl,
        user: args.user,
        targetModel: args.targetModel,
        judgeModel: args.judgeModel,
        strict: args.strict,
        failFast: args.failFast,
        timeoutMs: parsePositiveInt(smokeEnv.RECURSION_LIVE_TIMEOUT_MS, 120000),
        env: smokeEnv,
        artifactRoot
      });
      report.modelEffectiveness.redirect = redirectEffectiveness;
      const resultObject = redirectEffectiveness && typeof redirectEffectiveness === 'object'
        ? redirectEffectiveness
        : null;
      const resultScenarios = Array.isArray(resultObject?.scenarios) ? resultObject.scenarios : null;
      if (!resultObject || !resultScenarios) {
        report.failures.push({ name: 'redirect-effectiveness', status: 'fail', summary: 'Redirect effectiveness output was malformed.' });
        reportStatus(report, 'fail', 'redirect-effectiveness-malformed');
      } else if (resultObject.status === 'skipped') {
        report.failures.push({ name: 'redirect-effectiveness', status: 'fail', summary: 'Redirect effectiveness judge was skipped.' });
        reportStatus(report, 'fail', 'redirect-effectiveness-skipped');
      } else if (resultObject.status !== 'pass') {
        report.failures.push({ name: 'redirect-effectiveness', status: 'fail', summary: `Redirect effectiveness failed: ${resultObject.result || 'unknown'}.` });
        reportStatus(report, 'fail', resultObject.result || 'redirect-model-effectiveness-failed');
      } else if (resultScenarios.length === 0) {
        report.failures.push({ name: 'redirect-effectiveness', status: 'fail', summary: 'Redirect effectiveness returned no scenario evidence.' });
        reportStatus(report, 'fail', 'redirect-effectiveness-empty');
      } else if (resultScenarios.length !== redirectScenarios.length) {
        report.failures.push({ name: 'redirect-effectiveness', status: 'fail', summary: 'Redirect effectiveness omitted scenario evidence.' });
        reportStatus(report, 'fail', 'redirect-effectiveness-incomplete');
      } else {
        reportStatus(report, 'pass', resultObject.result || 'redirect-effectiveness-passed');
      }
    } else {
      report.warnings.push({
        name: 'model-effectiveness',
        status: 'skipped',
        summary: 'Live Playwright traversal passed; judge-scored model-effectiveness execution is not implemented in this slice.'
      });
      reportStatus(report, 'skipped', 'model-effectiveness-not-implemented');
    }
  }

  report.repairSummary = summarizeRepairs(report.defects);
  const redaction = scanModelEvalRedactions(report);
  report.redaction = redaction;
  if (!redaction.ok) reportStatus(report, 'fail', 'redaction-failed');
  if (args.writeArtifacts) writeArtifacts(report, artifactRoot);
  return report;
}
