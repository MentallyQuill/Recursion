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

const REQUIRED_LIVE_RUNTIME_METHODS = Object.freeze([
  'enhanceLatestAssistantMessage',
  'evaluateRedirectEffectiveness',
  'view'
]);

function text(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function validateLiveEditorialRuntime(runtime = {}) {
  const missing = REQUIRED_LIVE_RUNTIME_METHODS
    .filter((method) => typeof runtime?.[method] !== 'function');
  return { ok: missing.length === 0, missing };
}

export function liveEditorialStageTimeoutMs(stage, timeoutMs = 120000) {
  const configured = Math.max(10000, Number(timeoutMs) || 120000);
  if (stage === 'settings') return 15000;
  if (stage === 'warm' || stage === 'enhance') return configured * 3;
  return configured;
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

const PRIVATE_REDIRECT_FIELD_PATTERN = /"(?:redirect|characterPressure|immediateWant|pressureReason|wantEvidenceRefs|sourcePressureEffect|sourceEvidenceRefs)"\s*:/;
const PRIVATE_REDIRECT_SENTINEL = 'PRIVATE_REDIRECT_PRESSURE_SENTINEL';

function leaksPrivateRedirectStructure(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return PRIVATE_REDIRECT_FIELD_PATTERN.test(serialized) || serialized.includes(PRIVATE_REDIRECT_SENTINEL);
}

export function evaluateLiveRedirectScenarioArtifacts(artifacts = {}) {
  const failures = [];
  const scenario = artifacts.scenario && typeof artifacts.scenario === 'object' ? artifacts.scenario : {};
  const expectedDecision = text(scenario?.oracle?.editorialRedirect?.expectedDecision || 'proceed').toLowerCase();
  const result = artifacts.enhancementResult && typeof artifacts.enhancementResult === 'object'
    ? artifacts.enhancementResult
    : {};
  const before = artifacts.before && typeof artifacts.before === 'object' ? artifacts.before : {};
  const after = artifacts.after && typeof artifacts.after === 'object' ? artifacts.after : {};
  const marker = result.marker && typeof result.marker === 'object' ? result.marker : {};

  if (expectedDecision !== 'proceed') failures.push('redirect-expected-decision-invalid');
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

  const judge = artifacts.judge && typeof artifacts.judge === 'object' ? artifacts.judge : {};
  if (judge.ok !== true || judge.decision !== 'pass'
    || !exactCoverage(judge.criteria, REDIRECT_EFFECTIVENESS_CRITERIA, 'criterion')) {
    failures.push('redirect-effectiveness-judge-failed');
  }

  const expectedTarget = text(artifacts.expectedModels?.targetModel);
  const expectedJudge = text(artifacts.expectedModels?.judgeModel);
  if (expectedTarget && text(artifacts.provider?.targetModel) !== expectedTarget) failures.push('target-model-mismatch');
  if (expectedJudge && text(artifacts.provider?.judgeModel) !== expectedJudge) failures.push('judge-model-mismatch');

  for (const [surface, value] of [
    ['assistant-prose', artifacts.candidateText],
    ['visible-ui', artifacts.visibleText],
    ['runtime-view', artifacts.runtimeView],
    ['prompt-packet', artifacts.promptPacket],
    ['journal', artifacts.journalDelta]
  ]) {
    if (leaksPrivateRedirectStructure(value)) failures.push(`private-redirect-leak-${surface}`);
  }

  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? 'pass' : 'fail',
    scenarioId: text(scenario.id),
    expectedDecision,
    decision: text(result.verification?.decision),
    sourceHash: text(result.sourceHash || marker.sourceHash),
    candidateHash: text(marker.candidateHash || judge.candidateHash),
    productionVerification: text(marker.verification),
    errorCode: text(result.error?.code || result.validation?.error?.code || artifacts.runtimeView?.editorialResult?.errorCode),
    errorMessage: text(result.error?.message || result.validation?.error?.message || artifacts.runtimeView?.editorialResult?.reason),
    verifierChecks: Array.isArray(result.verification?.checks) ? result.verification.checks : [],
    judge,
    provider: artifacts.provider || {},
    oracle: artifacts.oracle?.verdict || {},
    failures
  };
}

async function executeScenarioInPage(input) {
  const scenario = input?.scenario || {};
  const stageTimeouts = input?.stageTimeouts || {};
  const runStage = async (stage, operation) => {
    globalThis.__recursionLiveRedirectProofStage = stage;
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`live-stage-timeout:${stage}`)), Number(stageTimeouts[stage]) || 120000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
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

  await runStage('settings', () => runtime.updateSettings({
    enabled: true,
    mode: 'auto',
    pipelineMode: String(scenario?.pipelineMode || 'standard'),
    reasoningLevel: 'medium',
    reasonerUse: 'always',
    enhancements: { mode: 'redirect', applyMode: 'as-swipe', contextMessages: 13 }
  }));
  if (String(scenario?.pipelineMode || '').toLowerCase() === 'rapid') {
    const warm = await runStage('warm', () => runtime.warmRapidScene({ reason: `live-redirect-warm-${scenario.id}` }));
    if (warm?.ok !== true || warm?.rapid?.status !== 'ready') {
      throw new Error(`live-rapid-warm-failed:${warm?.rapid?.failureReasonCode || warm?.reason || 'not-ready'}`);
    }
  }
  const prepared = await runStage('prepare', () => runtime.prepareForGeneration({ userMessage: pendingUserMessage }));
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const poll = () => {
      const transitions = globalThis.__recursionLiveEnhancementRunOracle?.transitions || [];
      const ready = transitions.some((entry) => (
        String(entry?.label || '').trim().toLowerCase() === 'recursion prompt ready'
        && String(entry?.state || '').trim().toLowerCase() === 'done'
      ));
      if (ready) return resolve();
      if (Date.now() >= deadline) return reject(new Error('live-prompt-ready-not-rendered'));
      setTimeout(poll, 50);
    };
    poll();
  });
  ctx.chat.push({ mesid: sourceMesId, is_user: false, name: 'Story', mes: sourceText, swipe_id: 0, swipes: [sourceText] });
  const before = state();
  const enhancementResult = await runStage('enhance', () => runtime.enhanceLatestAssistantMessage({ reason: `live-redirect-${scenario.id}` }));
  const after = state();
  const candidateText = String(after.text || '');
  const runtimeView = runtime.view?.() || {};
  globalThis.__recursionLiveRedirectProofStage = 'complete';
  return {
    prepared,
    before,
    after,
    enhancementResult,
    candidateText,
    sourceText,
    runtimeView,
    promptPacket: runtimeView.lastPacket || null,
    visibleText: String(document.body?.innerText || '')
  };
}

async function executeJudgeInPage(input = {}) {
  const runtime = globalThis.__recursionLiveHarnessRuntime;
  if (!runtime?.evaluateRedirectEffectiveness) return { ok: false, error: { code: 'served-runtime-stale' } };
  return runtime.evaluateRedirectEffectiveness({
    scenarioId: String(input?.scenario?.id || ''),
    oracle: input?.scenario?.oracle?.editorialRedirect || {},
    snapshot: input?.scenario?.snapshot || {},
    sourceText: String(input?.sourceText || ''),
    candidateText: String(input?.candidateText || ''),
    marker: input?.marker || {}
  });
}

async function createBrowserExecutor({ baseUrl, user, password, timeoutMs, artifactRoot }) {
  const session = createSillyTavernHttpSession({ baseUrl, user, password });
  await session.login();
  const browser = await chromium.launch({ headless: true });
  try {
  const browserContext = await browser.newContext();
  await browserContext.addCookies(session.playwrightCookies());
  await browserContext.addInitScript(() => { globalThis.__recursionLiveHarness = true; });
  const page = await browserContext.newPage();
  page.setDefaultTimeout(timeoutMs);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForSelector('#recursion-root', { state: 'visible', timeout: timeoutMs });
  await page.waitForFunction(() => Boolean(globalThis.__recursionLiveHarnessRuntime), null, { timeout: timeoutMs });
  const runtimeCapabilities = await page.evaluate(() => {
    const runtime = globalThis.__recursionLiveHarnessRuntime || {};
    return Object.fromEntries([
      'enhanceLatestAssistantMessage',
      'evaluateRedirectEffectiveness',
      'view'
    ].map((method) => [method, typeof runtime[method]]));
  });
  const runtimeValidation = validateLiveEditorialRuntime(Object.fromEntries(
    Object.entries(runtimeCapabilities).map(([method, type]) => [method, type === 'function' ? () => {} : null])
  ));
  if (!runtimeValidation.ok) {
    const error = new Error(`Served Recursion runtime is stale; missing ${runtimeValidation.missing.join(', ')}.`);
    error.code = 'served-runtime-stale';
    throw error;
  }
  const providerTest = await page.evaluate(async () => globalThis.__recursionLiveHarnessRuntime?.testProvider?.('utility'));
  if (providerTest?.ok !== true) {
    const error = new Error('Utility provider test failed before Redirect effectiveness run.');
    error.code = providerTest?.error?.code || 'utility-provider-live-call-failed';
    throw error;
  }
  if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });

  return {
    async execute({ scenario, targetModel, judgeModel, forceUtilityEnhancement = false }) {
      let restoreReasonerAfterEnhancement = false;
      try {
        await page.setViewportSize({ width: 1280, height: 720 });
        if (forceUtilityEnhancement) {
          restoreReasonerAfterEnhancement = await page.evaluate(async () => {
            const runtime = globalThis.__recursionLiveHarnessRuntime;
            const wasEnabled = runtime?.view?.()?.settings?.providers?.reasoner?.enabled === true;
            if (wasEnabled) {
              const result = await runtime.updateProvider('reasoner', { enabled: false });
              if (result?.ok !== true) throw new Error('live-reasoner-disable-failed');
            }
            return wasEnabled;
          });
        }
        await installLiveEnhancementRunOracle(page);
        const artifacts = await page.evaluate(executeScenarioInPage, {
          scenario,
          stageTimeouts: Object.fromEntries(['settings', 'warm', 'prepare', 'enhance', 'judge']
            .map((stage) => [stage, liveEditorialStageTimeoutMs(stage, timeoutMs)]))
        });
        if (artifacts?.environmentFailure) throw new Error(artifacts.environmentFailure);
        await page.waitForFunction(() => {
          const rows = [...document.querySelectorAll('[data-recursion-status-popover] [data-recursion-progress-row]')];
          return !rows.some((row) => ['running', 'pending', 'waiting'].includes(String(row.dataset.recursionProgressState || '').toLowerCase()));
        }, null, { timeout: 15000 }).catch(() => {});
        const oracle = await collectLiveEnhancementRunOracle(page);
        const journalDelta = Array.isArray(oracle?.observation?.journalDelta) ? oracle.observation.journalDelta : [];
        const screenshotPath = artifactRoot
          ? join(artifactRoot, `${String(scenario.id || 'redirect').replace(/[^a-z0-9_-]+/gi, '-')}.png`)
          : '';
        const phoneScreenshotPath = screenshotPath ? screenshotPath.replace(/\.png$/i, '-phone.png') : '';
        if (screenshotPath) {
          if (!await page.evaluate(() => document.querySelector('[data-recursion-status-popover]')?.hidden === false)) {
            await page.locator('[data-recursion-status-trigger]').first().click();
          }
          await page.waitForFunction(() => document.querySelector('[data-recursion-status-popover]')?.hidden === false, null, { timeout: 5000 });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.screenshot({ path: phoneScreenshotPath, fullPage: true });
          await page.setViewportSize({ width: 1280, height: 720 });
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.screenshot({ path: screenshotPath, fullPage: true });
        }
        if (restoreReasonerAfterEnhancement) {
          const restored = await page.evaluate(async () => {
            const runtime = globalThis.__recursionLiveHarnessRuntime;
            const update = await runtime.updateProvider('reasoner', { enabled: true });
            const test = update?.ok === true ? await runtime.testProvider('reasoner') : null;
            return { update, test };
          });
          if (restored?.update?.ok !== true || restored?.test?.ok !== true) throw new Error('live-reasoner-restore-failed');
          restoreReasonerAfterEnhancement = false;
        }
        const judge = await page.evaluate(executeJudgeInPage, {
          scenario,
          sourceText: artifacts.sourceText,
          candidateText: artifacts.candidateText,
          marker: artifacts.enhancementResult?.marker || {}
        });
        return {
          ...artifacts,
          scenario,
          oracle,
          journalDelta,
          judge,
          provider: {
            targetModel: text(providerTest?.diagnostics?.model || providerTest?.provider?.resolvedModelLabel),
            judgeModel: text(judge?.diagnostics?.model)
          },
          expectedModels: { targetModel, judgeModel },
          screenshotPath,
          phoneScreenshotPath
        };
      } finally {
        if (restoreReasonerAfterEnhancement) {
          await page.evaluate(async () => {
            const runtime = globalThis.__recursionLiveHarnessRuntime;
            const update = await runtime.updateProvider('reasoner', { enabled: true });
            if (update?.ok === true) await runtime.testProvider('reasoner');
            return update;
          }).catch(() => {});
        }
      }
    },
    async close() {
      await browser.close();
    }
  };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function runLiveEditorialEffectiveness({
  scenarios = [],
  baseUrl = '',
  user = '',
  password = '',
  targetModel = '',
  judgeModel = '',
  forceUtilityEnhancement = false,
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
      const artifacts = await execute({ scenario, targetModel, judgeModel, forceUtilityEnhancement });
      const result = evaluateLiveRedirectScenarioArtifacts({
        ...artifacts,
        scenario: artifacts?.scenario || scenario,
        expectedModels: artifacts?.expectedModels || { targetModel, judgeModel }
      });
      if (artifacts?.screenshotPath) result.screenshotPath = artifacts.screenshotPath;
      if (artifacts?.phoneScreenshotPath) result.phoneScreenshotPath = artifacts.phoneScreenshotPath;
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
