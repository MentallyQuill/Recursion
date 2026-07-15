import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

import {
  REDIRECT_EFFECTIVENESS_CRITERIA,
  REDIRECT_VERIFICATION_CHECKS
} from '../../../src/editorial-transform.mjs';
import {
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './sillytavern-live-harness.mjs';
import {
  collectLiveEnhancementRunOracle,
  installLiveEnhancementRunOracle
} from './live-enhancement-run-oracle.mjs';

const UNHEALTHY_STATES = new Set(['caution', 'warning', 'warn', 'failed', 'failure', 'error']);
const UNHEALTHY_JOURNAL = new Set(['warning', 'warn', 'error', 'fatal']);
const ALLOWED_NO_CHANGE_ORACLE_FAILURES = new Set([
  'enhancement-skipped',
  'missing-editorial-candidate',
  'missing-editorial-verification',
  'enhancement-result-missing',
  'enhancement-result-not-recursion-owned',
  'enhancement-result-not-validated'
]);

function text(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function exactCoverage(entries, names, nameKey, { requirePass = true } = {}) {
  if (!Array.isArray(entries) || entries.length !== names.length) return false;
  const seen = new Set();
  for (const entry of entries) {
    const name = text(entry?.[nameKey]);
    if (!names.includes(name) || seen.has(name)) return false;
    if (requirePass && text(entry?.status).toLowerCase() !== 'pass') return false;
    seen.add(name);
  }
  return names.every((name) => seen.has(name));
}

function noChangeOracleHealthy(oracle = {}) {
  const observation = oracle?.observation && typeof oracle.observation === 'object' ? oracle.observation : {};
  const transitions = Array.isArray(observation.transitions) ? observation.transitions : [];
  const journalDelta = Array.isArray(observation.journalDelta) ? observation.journalDelta : [];
  if (transitions.some((entry) => UNHEALTHY_STATES.has(text(entry?.state).toLowerCase()))) return false;
  if (journalDelta.some((entry) => (
    UNHEALTHY_JOURNAL.has(text(entry?.severity).toLowerCase())
    || ['provider.call.failed', 'prompt.install_skipped'].includes(text(entry?.event))
  ))) return false;
  const failures = Array.isArray(oracle?.verdict?.failures) ? oracle.verdict.failures : [];
  return failures.every((failure) => ALLOWED_NO_CHANGE_ORACLE_FAILURES.has(text(failure)));
}

function privateRedirectStrings(marker = {}) {
  const pressure = Array.isArray(marker?.redirect?.characterPressure) ? marker.redirect.characterPressure : [];
  return pressure.flatMap((entry) => [entry?.immediateWant, entry?.pressureReason])
    .map((entry) => String(entry || '').trim())
    .filter((entry) => entry.length >= 8);
}

function leaksPrivateText(value, privateStrings) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return privateStrings.some((entry) => serialized.includes(entry));
}

export function evaluateLiveRedirectScenarioArtifacts(artifacts = {}) {
  const failures = [];
  const scenario = artifacts.scenario && typeof artifacts.scenario === 'object' ? artifacts.scenario : {};
  const expectedDecision = text(scenario?.oracle?.editorialRedirect?.expectedDecision || 'proceed').toLowerCase();
  const noChange = expectedDecision === 'no-change';
  const result = artifacts.enhancementResult && typeof artifacts.enhancementResult === 'object'
    ? artifacts.enhancementResult
    : {};
  const before = artifacts.before && typeof artifacts.before === 'object' ? artifacts.before : {};
  const after = artifacts.after && typeof artifacts.after === 'object' ? artifacts.after : {};
  const marker = result.marker && typeof result.marker === 'object' ? result.marker : {};

  if (noChange) {
    if (result.ok !== true || result.skipped !== true || result.validation?.value?.decision !== 'no-change') {
      failures.push('no-change-decision-missing');
    }
    if (Number(after.swipeCount) !== Number(before.swipeCount) || Number(after.swipeId) !== Number(before.swipeId)) {
      failures.push('no-change-mutated-host');
    }
    if (!noChangeOracleHealthy(artifacts.oracle)) failures.push('no-change-oracle-unhealthy');
  } else {
    if (artifacts.oracle?.verdict?.ok !== true) failures.push('strict-oracle-failed');
    if (result.ok !== true || result.skipped === true || result.mode !== 'redirect') failures.push('redirect-result-invalid');
    if (Number(after.swipeCount) !== Number(before.swipeCount) + 1 || Number(after.swipeId) !== Number(after.swipeCount) - 1) {
      failures.push('redirect-swipe-missing');
    }
    if (marker.mode !== 'redirect' || marker.verification !== 'accept' || !text(marker.candidateHash)) {
      failures.push('redirect-marker-unverified');
    }
    if (!Array.isArray(marker.changeLedger) || !marker.changeLedger.some((entry) => entry?.kind === 'redirect')) {
      failures.push('redirect-ledger-missing');
    }
    if (result.verification?.decision !== 'accept'
      || !exactCoverage(result.verification?.checks, REDIRECT_VERIFICATION_CHECKS, 'check')) {
      failures.push('redirect-verifier-incomplete');
    }
  }

  const judge = artifacts.judge && typeof artifacts.judge === 'object' ? artifacts.judge : {};
  if (judge.ok !== true || judge.decision !== 'pass'
    || !exactCoverage(judge.criteria, REDIRECT_EFFECTIVENESS_CRITERIA, 'criterion')) {
    failures.push('redirect-effectiveness-judge-failed');
  }

  const expectedTarget = text(artifacts.expectedModels?.targetModel);
  const expectedJudge = text(artifacts.expectedModels?.judgeModel);
  if (expectedTarget && text(artifacts.provider?.targetModel) !== expectedTarget) failures.push('target-model-mismatch');
  if (expectedJudge && text(artifacts.provider?.judgeModel) !== expectedJudge) failures.push('judge-model-mismatch');

  const privateStrings = privateRedirectStrings(marker);
  for (const [surface, value] of [
    ['assistant-prose', artifacts.candidateText],
    ['visible-ui', artifacts.visibleText],
    ['runtime-view', artifacts.runtimeView],
    ['prompt-packet', artifacts.promptPacket],
    ['journal', artifacts.journalDelta]
  ]) {
    if (leaksPrivateText(value, privateStrings)) failures.push(`private-redirect-leak-${surface}`);
  }

  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? 'pass' : 'fail',
    scenarioId: text(scenario.id),
    expectedDecision,
    decision: noChange ? text(result.validation?.value?.decision) : text(result.verification?.decision),
    sourceHash: text(result.sourceHash || marker.sourceHash),
    candidateHash: text(marker.candidateHash || judge.candidateHash),
    productionVerification: noChange ? 'not-required' : text(marker.verification),
    verifierChecks: noChange ? [] : (Array.isArray(result.verification?.checks) ? result.verification.checks : []),
    judge,
    provider: artifacts.provider || {},
    oracle: artifacts.oracle?.verdict || {},
    failures
  };
}

async function executeScenarioInPage(scenario) {
  const rawContext = () => globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
  const decorateContext = (context = {}) => {
    context.saveChat = async () => {};
    context.reloadCurrentChat = async () => {};
    return context;
  };
  if (!globalThis.__recursionSyntheticEnhancementContextHooks) {
    globalThis.__recursionSyntheticEnhancementContextHooks = true;
    const originalSillyGetContext = globalThis.SillyTavern?.getContext;
    const originalGlobalGetContext = globalThis.getContext;
    if (globalThis.SillyTavern && typeof originalSillyGetContext === 'function') {
      globalThis.SillyTavern.getContext = (...args) => decorateContext(originalSillyGetContext.apply(globalThis.SillyTavern, args));
    }
    if (typeof originalGlobalGetContext === 'function') {
      globalThis.getContext = (...args) => decorateContext(originalGlobalGetContext.apply(globalThis, args));
    }
    globalThis.saveChat = async () => {};
    globalThis.saveChatDebounced = async () => {};
    globalThis.reloadCurrentChat = async () => {};
  }
  const context = () => decorateContext(rawContext());
  const runtime = globalThis.__recursionLiveHarnessRuntime;
  if (!runtime) return { environmentFailure: 'runtime-unavailable' };
  const redirectOracle = scenario?.oracle?.editorialRedirect || {};
  const sourceText = String(redirectOracle.sourceResponse || '');
  const ctx = context();
  if (!Array.isArray(ctx.chat)) ctx.chat = [];
  ctx.chat.length = 0;
  let mesid = 0;
  for (const message of Array.isArray(scenario?.snapshot?.messages) ? scenario.snapshot.messages : []) {
    const isUser = String(message?.role || '').toLowerCase() === 'user';
    const text = String(message?.text || message?.mes || '');
    ctx.chat.push({ mesid, is_user: isUser, name: isUser ? 'User' : 'Story', mes: text, ...(isUser ? {} : { swipe_id: 0, swipes: [text] }) });
    mesid += 1;
  }
  const pendingUserMessage = String(scenario?.pendingUserMessage || '');
  ctx.chat.push({ mesid, is_user: true, name: 'Recursion Redirect Proof User', mes: pendingUserMessage });
  mesid += 1;
  const sourceMesId = mesid;
  ctx.chat.push({ mesid: sourceMesId, is_user: false, name: 'Story', mes: sourceText, swipe_id: 0, swipes: [sourceText] });

  const state = () => {
    const message = (context().chat || []).find((entry, index) => Number(entry?.mesid ?? index) === Number(sourceMesId));
    const swipeId = Number(message?.swipe_id ?? 0);
    const marker = Array.isArray(message?.__recursionGenerationReviewSwipes)
      ? message.__recursionGenerationReviewSwipes[swipeId] || null
      : message?.__recursionGenerationReview || null;
    return {
      swipeCount: Array.isArray(message?.swipes) ? message.swipes.length : 0,
      swipeId,
      text: String(message?.mes || ''),
      marker
    };
  };

  await runtime.updateSettings({
    enabled: true,
    mode: 'auto',
    pipelineMode: String(scenario?.pipelineMode || 'standard'),
    reasoningLevel: 'medium',
    reasonerUse: 'always',
    enhancements: { mode: 'redirect', applyMode: 'as-swipe', contextMessages: 13 }
  });
  const prepared = await runtime.prepareForGeneration({ userMessage: pendingUserMessage });
  const before = state();
  const enhancementResult = await runtime.enhanceLatestAssistantMessage({ reason: `live-redirect-${scenario.id}` });
  const after = state();
  const expectedNoChange = String(redirectOracle.expectedDecision || '').toLowerCase() === 'no-change';
  const candidateText = expectedNoChange ? sourceText : String(after.text || '');
  const judge = await runtime.evaluateRedirectEffectiveness({
    scenarioId: String(scenario.id || ''),
    oracle: redirectOracle,
    snapshot: scenario.snapshot || {},
    sourceText,
    candidateText,
    marker: enhancementResult?.marker || {}
  });
  const runtimeView = runtime.view?.() || {};
  return {
    prepared,
    before,
    after,
    enhancementResult,
    candidateText,
    judge,
    runtimeView,
    promptPacket: runtimeView.lastPacket || null,
    visibleText: String(document.body?.innerText || '')
  };
}

async function createBrowserExecutor({ baseUrl, user, password, timeoutMs, artifactRoot }) {
  const session = createSillyTavernHttpSession({ baseUrl, user, password });
  await session.login();
  const browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext();
  await browserContext.addCookies(session.playwrightCookies());
  await browserContext.addInitScript(() => { globalThis.__recursionLiveHarness = true; });
  const page = await browserContext.newPage();
  page.setDefaultTimeout(timeoutMs);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForSelector('#recursion-root', { state: 'visible', timeout: timeoutMs });
  await page.waitForFunction(() => Boolean(globalThis.__recursionLiveHarnessRuntime), null, { timeout: timeoutMs });
  const providerTest = await page.evaluate(async () => globalThis.__recursionLiveHarnessRuntime?.testProvider?.('utility'));
  if (providerTest?.ok !== true) {
    const error = new Error('Utility provider test failed before Redirect effectiveness run.');
    error.code = providerTest?.error?.code || 'utility-provider-live-call-failed';
    throw error;
  }
  if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });

  return {
    async execute({ scenario, targetModel, judgeModel }) {
      await installLiveEnhancementRunOracle(page);
      const artifacts = await page.evaluate(executeScenarioInPage, scenario);
      if (artifacts?.environmentFailure) throw new Error(artifacts.environmentFailure);
      await page.waitForFunction((expectedDecision) => {
        const rows = [...document.querySelectorAll('[data-recursion-status-popover] [data-recursion-progress-row]')];
        const active = rows.some((row) => ['running', 'pending', 'waiting'].includes(String(row.dataset.recursionProgressState || '').toLowerCase()));
        if (active) return false;
        if (expectedDecision === 'no-change') return true;
        const stateFor = (label) => rows
          .filter((row) => String(row.dataset.recursionProgressLabel || '').trim().toLowerCase() === label)
          .map((row) => String(row.dataset.recursionProgressState || '').trim().toLowerCase());
        return ['editorial diagnosis', 'editorial candidate', 'editorial verification', 'recursion prompt ready']
          .every((label) => stateFor(label).includes('done'));
      }, String(scenario?.oracle?.editorialRedirect?.expectedDecision || 'proceed').toLowerCase(), { timeout: timeoutMs });
      const oracle = await collectLiveEnhancementRunOracle(page);
      const journalDelta = Array.isArray(oracle?.observation?.journalDelta) ? oracle.observation.journalDelta : [];
      const screenshotPath = artifactRoot
        ? join(artifactRoot, `${String(scenario.id || 'redirect').replace(/[^a-z0-9_-]+/gi, '-')}.png`)
        : '';
      if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
      return {
        ...artifacts,
        scenario,
        oracle,
        journalDelta,
        provider: {
          targetModel: text(providerTest?.diagnostics?.model || providerTest?.provider?.resolvedModelLabel),
          judgeModel: text(artifacts?.judge?.diagnostics?.model)
        },
        expectedModels: { targetModel, judgeModel },
        screenshotPath
      };
    },
    async close() {
      await browser.close();
    }
  };
}

export async function runLiveEditorialEffectiveness({
  scenarios = [],
  baseUrl = '',
  user = '',
  password = '',
  targetModel = '',
  judgeModel = '',
  timeoutMs = 120000,
  failFast = false,
  artifactRoot = null,
  env = process.env,
  scenarioExecutor = null
} = {}) {
  const userValidation = validateSoakUserHandle(user);
  if (!userValidation.ok) {
    return { status: 'unsafe-user', result: 'unsafe-user', scenarios: [], failures: [userValidation.reason] };
  }
  const scenarioList = Array.isArray(scenarios) ? scenarios : [];
  if (!scenarioList.length) {
    return { status: 'fail', result: 'redirect-effectiveness-empty-corpus', scenarios: [], failures: ['empty-corpus'] };
  }

  let browserExecutor = null;
  const execute = scenarioExecutor || (async (input) => browserExecutor.execute(input));
  const results = [];
  try {
    if (!scenarioExecutor) {
      const resolvedBaseUrl = text(baseUrl || env.SILLYTAVERN_BASE_URL);
      if (!resolvedBaseUrl) return { status: 'environment-fail', result: 'missing-base-url', scenarios: [], failures: ['missing-base-url'] };
      browserExecutor = await createBrowserExecutor({
        baseUrl: resolvedBaseUrl,
        user: userValidation.user,
        password: password || env.SILLYTAVERN_PASSWORD || '',
        timeoutMs: Math.max(10000, Number(timeoutMs) || 120000),
        artifactRoot
      });
    }
    for (const scenario of scenarioList) {
      const artifacts = await execute({ scenario, targetModel, judgeModel });
      const result = evaluateLiveRedirectScenarioArtifacts({
        ...artifacts,
        scenario: artifacts?.scenario || scenario,
        expectedModels: artifacts?.expectedModels || { targetModel, judgeModel }
      });
      if (artifacts?.screenshotPath) result.screenshotPath = artifacts.screenshotPath;
      results.push(result);
      if (!result.ok && failFast) break;
    }
  } catch (error) {
    return {
      status: 'environment-fail',
      result: text(error?.code || 'redirect-effectiveness-environment-failed'),
      scenarios: results,
      failures: [text(error?.message || error)]
    };
  } finally {
    await browserExecutor?.close().catch(() => {});
  }
  const failed = results.filter((result) => !result.ok);
  return {
    status: failed.length ? 'fail' : 'pass',
    result: failed.length ? 'redirect-effectiveness-failed' : 'redirect-effectiveness-passed',
    scenarios: results,
    failures: failed.flatMap((result) => result.failures.map((failure) => `${result.scenarioId}:${failure}`))
  };
}
