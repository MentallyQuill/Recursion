import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  createRunId,
  createSillyTavernHttpSession,
  validateSoakUserHandle,
  writeReportArtifacts
} from './lib/sillytavern-live-harness.mjs';

const DEFAULT_TIMEOUT_MS = 240000;

function nowIso() {
  return new Date().toISOString();
}

function hasArg(name) {
  return process.argv.slice(2).includes(name);
}

function passwordEnvKey(user) {
  return `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function passwordForUser(user, env) {
  return env[passwordEnvKey(user)] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function reportBase(runId, mode, dryRun) {
  const startedAt = nowIso();
  return {
    recordType: 'recursion.liveHarnessReport',
    schemaVersion: 1,
    runId,
    scriptName: 'prove-card-system-assist',
    status: 'pass',
    result: dryRun ? 'dry-run-pass' : 'card-system-assist-pass',
    startedAt,
    generatedAt: startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    mode,
    dryRun,
    strict: hasArg('--strict'),
    checks: [],
    warnings: [],
    failures: [],
    environment: {
      baseUrlConfigured: Boolean(process.env.SILLYTAVERN_BASE_URL),
      userConfigured: Boolean(process.env.RECURSION_SILLYTAVERN_USER),
      liveGeneration: hasArg('--real-model')
    },
    nextAction: dryRun ? 'Run with --live --real-model against a dedicated recursion-soak-* user.' : 'Card System Authoring Assist proof passed.'
  };
}

function addCheck(report, name, status, summary, details = {}) {
  const check = { name, status, summary, details };
  report.checks.push(check);
  if (status !== 'pass') {
    report.status = status === 'unsafe-user' ? 'unsafe-user' : 'fail';
    report.result = status;
    report.failures.push(check);
  }
}

function finish(report) {
  report.generatedAt = nowIso();
  report.finishedAt = report.generatedAt;
  report.durationMs = Math.max(0, Date.parse(report.finishedAt) - Date.parse(report.startedAt));
  return report;
}

function fail(report, name, summary, details = {}) {
  addCheck(report, name, 'fail', summary, details);
  throw Object.assign(new Error(summary), { report });
}

function assertLivePreflight(report, env) {
  if (!hasArg('--real-model')) fail(report, 'real-model-required', 'Pass --real-model to prove Authoring Assist with a real Utility model call.');
  if (!env.SILLYTAVERN_BASE_URL) fail(report, 'base-url', 'SILLYTAVERN_BASE_URL is required.');
  const userResult = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  if (!userResult.ok) {
    addCheck(report, 'dedicated-user-policy', userResult.status, 'Configured user is not safe for live Card System Assist proof.', userResult);
    const error = new Error('Unsafe or missing dedicated live-test user.');
    error.report = report;
    throw error;
  }
  addCheck(report, 'dedicated-user-policy', 'pass', 'Dedicated recursion soak user accepted.', userResult);
  return userResult.user;
}

function qualityCheck(suggestion) {
  const name = String(suggestion?.name || '').trim();
  const description = String(suggestion?.description || '').trim();
  const promptText = String(suggestion?.promptText || '').trim();
  const lowValue = /(author'?s note|preset|generic style|always write|purple prose)/i.test(`${description}\n${promptText}`);
  return {
    namePresent: name.length >= 3 && name !== 'New Card',
    descriptionPresent: description.length >= 10,
    promptPresent: promptText.length >= 60,
    recursionFocused: /(scene|constraint|pressure|continuity|next response|next beat|visible|boundary|pending)/i.test(promptText),
    avoidsLowValuePlacement: !lowValue,
    promptLength: promptText.length
  };
}

async function waitForRecursion(page, timeoutMs) {
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForFunction(() => typeof globalThis.__recursionLiveHarnessRuntime?.recommendCardDraft === 'function', null, { timeout: timeoutMs });
}

function writeJsonArtifact(artifactDir, relativePath, value) {
  const target = resolve(artifactDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return relativePath.replace(/\\/g, '/');
}

async function runAssist(page, report, artifactDir, writeArtifacts, timeoutMs) {
  const result = await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    return runtime.recommendCardDraft({
      name: 'New Card',
      description: '',
      promptText: 'NPC keeps ignoring locked door and forgets current pressure'
    });
  });
  const suggestion = result?.suggestion || {};
  const quality = qualityCheck(suggestion);
  const evidence = {
    roleId: 'cardAuthoringAssist',
    ok: result?.ok !== false,
    diagnostics: Array.isArray(result?.diagnostics) ? result.diagnostics.slice(0, 12) : [],
    suggestionShape: {
      nameLength: String(suggestion.name || '').length,
      descriptionLength: String(suggestion.description || '').length,
      promptTextLength: String(suggestion.promptText || '').length
    },
    quality
  };
  if (!evidence.ok || !quality.namePresent || !quality.descriptionPresent || !quality.promptPresent || !quality.recursionFocused || !quality.avoidsLowValuePlacement) {
    fail(report, 'authoring-assist-quality', 'Authoring Assist did not return a high-value runnable card shape.', evidence);
  }
  addCheck(report, 'authoring-assist-quality', 'pass', 'Real Utility Authoring Assist returned high-value card shape.', evidence);
  if (writeArtifacts) {
    report.artifacts = {
      ...(report.artifacts || {}),
      modelCall: writeJsonArtifact(artifactDir, 'model-calls/card-authoring-assist.json', evidence),
      liveLog: writeJsonArtifact(artifactDir, 'live-log.jsonl', {
        recordType: 'recursion.cardSystemAssistProof',
        generatedAt: nowIso(),
        roleId: 'cardAuthoringAssist',
        quality
      })
    };
  }
}

async function main() {
  const live = hasArg('--live');
  const writeArtifacts = hasArg('--write-artifacts');
  const runId = createRunId('card-system-assist');
  const report = reportBase(runId, live ? 'live' : 'dry-run', !live);
  const artifactRoot = process.env.RECURSION_ARTIFACT_DIR || resolve('artifacts');
  if (!live) {
    addCheck(report, 'dry-run', 'pass', 'Dry run did not contact SillyTavern or call a model.');
    const finished = finish(report);
    if (writeArtifacts) writeReportArtifacts(finished, { artifactRoot, family: 'live-smoke/card-system' });
    return finished;
  }

  let browser = null;
  try {
    const user = assertLivePreflight(report, process.env);
    const timeoutMs = Number(process.env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    const session = createSillyTavernHttpSession({
      baseUrl: process.env.SILLYTAVERN_BASE_URL,
      user,
      password: passwordForUser(user, process.env)
    });
    await session.init();
    await session.login();
    browser = await chromium.launch({ headless: process.env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
    const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
    await context.addCookies(session.playwrightCookies());
    await context.addInitScript(() => { globalThis.__recursionLiveHarness = true; });
    const page = await context.newPage();
    await page.goto(process.env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForRecursion(page, timeoutMs);
    await runAssist(page, report, resolve(artifactRoot, 'live-smoke/card-system', runId), writeArtifacts, timeoutMs);
    const finished = finish(report);
    if (writeArtifacts) writeReportArtifacts(finished, { artifactRoot, family: 'live-smoke/card-system' });
    return finished;
  } catch (error) {
    const failed = finish(error.report || report);
    if (!failed.failures.length) addCheck(failed, 'card-system-assist-error', 'fail', error?.message || 'Card System Assist proof failed.');
    if (writeArtifacts) writeReportArtifacts(failed, { artifactRoot, family: 'live-smoke/card-system' });
    return failed;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const report = await main();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === 'pass' ? 0 : 1;
