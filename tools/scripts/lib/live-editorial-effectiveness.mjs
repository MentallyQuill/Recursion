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

function safeEditorialValidationDiagnostics(validation = {}) {
  const invalidPatches = Array.isArray(validation?.invalidPatches)
    ? validation.invalidPatches.slice(0, 24).map((entry) => {
        const fields = Array.isArray(entry?.fields)
          ? entry.fields.map(text).filter((field) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(field)).sort().slice(0, 16)
          : [];
        const fieldTypes = Object.fromEntries(fields
          .map((field) => [field, text(entry?.fieldTypes?.[field]).slice(0, 20)])
          .filter(([, type]) => type));
        return {
          index: Number(entry?.index),
          id: text(entry?.id).slice(0, 120),
          domain: text(entry?.domain).slice(0, 120),
          knownTarget: entry?.knownTarget === true,
          ...(Object.prototype.hasOwnProperty.call(entry || {}, 'duplicateTarget') ? { duplicateTarget: entry.duplicateTarget === true } : {}),
          ...(Object.prototype.hasOwnProperty.call(entry || {}, 'validDomain') ? { validDomain: entry.validDomain === true } : {}),
          ...(Object.prototype.hasOwnProperty.call(entry || {}, 'hasAfter') ? { hasAfter: entry.hasAfter === true } : {}),
          ...(Object.prototype.hasOwnProperty.call(entry || {}, 'changesTarget') ? { changesTarget: entry.changesTarget === true } : {}),
          ...(Object.prototype.hasOwnProperty.call(entry || {}, 'validEvidence') ? { validEvidence: entry.validEvidence === true } : {}),
          ...(fields.length ? { fields, fieldTypes } : {})
        };
      })
    : [];
  const receivedDecision = text(validation?.receivedDecision).slice(0, 120);
  const allowedDecisions = Array.isArray(validation?.allowedDecisions)
    ? validation.allowedDecisions.map(text).filter(Boolean).slice(0, 8)
    : [];
  const safeFields = (value) => Array.isArray(value)
    ? value.map(text).filter((field) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(field)).sort().slice(0, 24)
    : [];
  const receivedFields = safeFields(validation?.receivedFields);
  const candidateFields = safeFields(validation?.candidateFields);
  const hasPatchCount = Number.isInteger(validation?.patchCount) && validation.patchCount >= 0;
  return {
    ...(receivedDecision ? { receivedDecision } : {}),
    ...(allowedDecisions.length ? { allowedDecisions } : {}),
    ...(invalidPatches.length ? { invalidPatches } : {}),
    ...(receivedFields.length ? { receivedFields } : {}),
    ...(candidateFields.length ? { candidateFields } : {}),
    ...(hasPatchCount ? { patchCount: validation.patchCount } : {})
  };
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

const PRIVATE_REDIRECT_FIELD_PATTERN = /"(?:characterPressure|immediateWant|pressureReason|wantEvidenceRefs|sourcePressureEffect|sourceEvidenceRefs)"\s*:/;
const PRIVATE_REDIRECT_SENTINEL = 'PRIVATE_REDIRECT_PRESSURE_SENTINEL';

function leaksPrivateRedirectStructure(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return PRIVATE_REDIRECT_FIELD_PATTERN.test(serialized) || serialized.includes(PRIVATE_REDIRECT_SENTINEL);
}

function privateRedirectPaths(value, path = '$', output = [], seen = new Set()) {
  if (output.length >= 24 || value === null || value === undefined) return output;
  if (typeof value === 'string') {
    if (value.includes(PRIVATE_REDIRECT_SENTINEL)) output.push(path);
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/^(characterPressure|immediateWant|pressureReason|wantEvidenceRefs|sourcePressureEffect|sourceEvidenceRefs)$/.test(key)) {
      output.push(childPath);
    }
    privateRedirectPaths(child, childPath, output, seen);
  }
  return output;
}

export function evaluateLiveRedirectScenarioArtifacts(artifacts = {}) {
  const failures = [];
  const privateLeakSurfaces = {};
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
    if (leaksPrivateRedirectStructure(value)) {
      failures.push(`private-redirect-leak-${surface}`);
      privateLeakSurfaces[surface] = privateRedirectPaths(value);
    }
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
    privateLeakSurfaces,
    evidenceClass: text(artifacts.evidenceClass),
    failures
  };
}

export function evaluateLiveRepairScenarioArtifacts(artifacts = {}) {
  const failures = [];
  const scenario = artifacts.scenario && typeof artifacts.scenario === 'object' ? artifacts.scenario : {};
  const result = artifacts.enhancementResult && typeof artifacts.enhancementResult === 'object'
    ? artifacts.enhancementResult
    : {};
  const before = artifacts.before && typeof artifacts.before === 'object' ? artifacts.before : {};
  const after = artifacts.after && typeof artifacts.after === 'object' ? artifacts.after : {};
  const marker = result.marker && typeof result.marker === 'object' ? result.marker : {};
  const editorialResult = artifacts.runtimeView?.editorialResult && typeof artifacts.runtimeView.editorialResult === 'object'
    ? artifacts.runtimeView.editorialResult
    : {};

  if (artifacts.oracle?.verdict?.ok !== true) failures.push('strict-oracle-failed');
  if (
    result.ok !== true
    || result.skipped === true
    || result.partialFailed === true
    || result.mode !== 'repair'
  ) {
    failures.push('repair-result-invalid');
  }
  if (
    Number(after.swipeCount) !== Number(before.swipeCount) + 1
    || Number(after.swipeId) !== Number(after.swipeCount) - 1
  ) {
    failures.push('repair-swipe-missing');
  }
  if (
    marker.mode !== 'repair'
    || marker.applyMode !== 'as-swipe'
    || marker.outcome !== 'applied'
    || !text(marker.candidateHash)
    || !text(marker.diagnosisHash)
  ) {
    failures.push('repair-marker-invalid');
  }
  if (
    result.artifact?.kind !== 'patches'
    || !Array.isArray(result.artifact?.patches)
    || result.artifact.patches.length === 0
  ) {
    failures.push('repair-bounded-patches-missing');
  }
  if (
    editorialResult.mode !== 'repair'
    || editorialResult.status !== 'success'
    || editorialResult.outcome !== 'applied'
    || editorialResult.applyMode !== 'as-swipe'
  ) {
    failures.push('repair-editorial-settlement-unhealthy');
  }

  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? 'pass' : 'fail',
    scenarioId: text(scenario.id),
    sourceHash: text(result.sourceHash || marker.sourceHash),
    candidateHash: text(marker.candidateHash),
    patchCount: Array.isArray(result.artifact?.patches) ? result.artifact.patches.length : 0,
    cardAudit: {
      decision: text(result.cardAudit?.decision).slice(0, 40),
      errorCode: text(result.cardAudit?.errorCode).slice(0, 120),
      diagnostics: result.cardAudit?.diagnostics || {}
    },
    errorCode: text(result.error?.code || result.validation?.error?.code || editorialResult.errorCode),
    errorMessage: text(result.error?.message || result.validation?.error?.message || editorialResult.reason),
    diagnosisDecision: text(result.diagnosisDecision || result.validation?.value?.decision || result.reason).slice(0, 80),
    diagnosisDiagnostics: {
      adjacentRepeatDefect: result.diagnosisDiagnostics?.adjacentRepeatDefect === true
        || result.validation?.diagnostics?.adjacentRepeatDefect === true
    },
    validationDiagnostics: safeEditorialValidationDiagnostics(result.validation),
    oracle: artifacts.oracle?.verdict || {},
    evidenceClass: text(artifacts.evidenceClass),
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
  const decorateContext = (context = {}) => {
    context.saveChat = async () => {};
    context.reloadCurrentChat = async () => {};
    return context;
  };
  const originalContext = () => {
    const originalSillyGetContext = globalThis.__recursionSyntheticEnhancementOriginalSillyGetContext;
    if (typeof originalSillyGetContext === 'function') {
      return originalSillyGetContext.call(globalThis.SillyTavern) || {};
    }
    const originalGlobalGetContext = globalThis.__recursionSyntheticEnhancementOriginalGlobalGetContext;
    if (typeof originalGlobalGetContext === 'function') {
      return originalGlobalGetContext.call(globalThis) || {};
    }
    return globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
  };
  if (!globalThis.__recursionSyntheticEnhancementContextHooks) {
    globalThis.__recursionSyntheticEnhancementContextHooks = true;
    const originalSillyGetContext = globalThis.SillyTavern?.getContext;
    const originalGlobalGetContext = globalThis.getContext;
    globalThis.__recursionSyntheticEnhancementOriginalSillyGetContext = originalSillyGetContext;
    globalThis.__recursionSyntheticEnhancementOriginalGlobalGetContext = originalGlobalGetContext;
    if (globalThis.SillyTavern && typeof originalSillyGetContext === 'function') {
      globalThis.SillyTavern.getContext = (...args) => decorateContext(
        globalThis.__recursionSyntheticEnhancementPinnedContext
        || originalSillyGetContext.apply(globalThis.SillyTavern, args)
      );
    }
    if (typeof originalGlobalGetContext === 'function') {
      globalThis.getContext = (...args) => decorateContext(
        globalThis.__recursionSyntheticEnhancementPinnedContext
        || originalGlobalGetContext.apply(globalThis, args)
      );
    }
    globalThis.saveChat = async () => {};
    globalThis.saveChatDebounced = async () => {};
    globalThis.reloadCurrentChat = async () => {};
  }
  const liveContext = originalContext();
  const pinnedContext = Object.create(liveContext);
  Object.defineProperty(pinnedContext, 'chat', {
    value: [],
    writable: true,
    configurable: true,
    enumerable: true
  });
  globalThis.__recursionSyntheticEnhancementPinnedContext = decorateContext(pinnedContext);
  const context = () => decorateContext(globalThis.__recursionSyntheticEnhancementPinnedContext || originalContext());
  const runtime = globalThis.__recursionLiveHarnessRuntime;
  if (!runtime) return { environmentFailure: 'runtime-unavailable' };
  const enhancementMode = String(scenario?.enhancementMode || 'redirect').toLowerCase() === 'repair'
    ? 'repair'
    : 'redirect';
  const redirectOracle = scenario?.oracle?.editorialRedirect || {};
  const sourceText = String(scenario?.enhancementSource || redirectOracle.sourceResponse || '');
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
    const currentContext = context();
    const message = (currentContext.chat || []).find((entry, index) => Number(entry?.mesid ?? index) === Number(sourceMesId));
    const swipeId = Number(message?.swipe_id ?? 0);
    const marker = Array.isArray(message?.__recursionGenerationReviewSwipes)
      ? message.__recursionGenerationReviewSwipes[swipeId] || null
      : message?.__recursionGenerationReview || null;
    return {
      chatKey: String(currentContext?.chatId || currentContext?.chat_id || currentContext?.currentChatId || 'chat'),
      messageId: Number(message?.mesid ?? sourceMesId),
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
    reasoningLevel: scenario?.forceUtilityEnhancement === true ? 'low' : 'medium',
    reasonerUse: 'always',
    enhancements: { mode: enhancementMode, applyMode: 'as-swipe', contextMessages: 13 }
  }));
  if (String(scenario?.pipelineMode || '').toLowerCase() === 'rapid') {
    const warm = await runStage('warm', () => runtime.warmRapidScene({ reason: `live-${enhancementMode}-warm-${scenario.id}` }));
    if (warm?.ok !== true || warm?.rapid?.status !== 'ready') {
      throw new Error(`live-rapid-warm-failed:${warm?.rapid?.failureReasonCode || warm?.reason || 'not-ready'}`);
    }
  }
  if (document.querySelector('[data-recursion-status-popover]')?.hidden !== false) {
    document.querySelector('[data-recursion-status-trigger]')?.click();
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (document.querySelector('[data-recursion-status-popover]')?.hidden !== false) {
    throw new Error('live-progress-popover-not-rendered');
  }
  const prepared = await runStage('prepare', () => runtime.prepareForGeneration({ userMessage: pendingUserMessage }));
  if (prepared?.ok !== true) {
    throw new Error(`live-prepared-generation-failed:${prepared?.error?.code || prepared?.reason || 'not-ready'}`);
  }
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      const transitions = globalThis.__recursionLiveEnhancementRunOracle?.transitions || [];
      const ready = transitions.some((entry) => (
        String(entry?.label || '').trim().toLowerCase() === 'recursion prompt ready'
        && String(entry?.state || '').trim().toLowerCase() === 'done'
      )) || [...document.querySelectorAll('[data-recursion-status-popover] [data-recursion-progress-row]')].some((row) => (
        String(row.dataset.recursionProgressLabel || row.querySelector('[data-recursion-progress-label]')?.textContent || '').trim().toLowerCase() === 'recursion prompt ready'
        && String(row.dataset.recursionProgressState || '').trim().toLowerCase() === 'done'
      ));
      if (ready) return resolve();
      if (Date.now() >= deadline) return reject(new Error('live-prompt-ready-not-rendered'));
      setTimeout(poll, 50);
    };
    poll();
  });
  const sourceContext = context();
  if (!Array.isArray(sourceContext.chat)) sourceContext.chat = [];
  sourceContext.chat.push({ mesid: sourceMesId, is_user: false, name: 'Story', mes: sourceText, swipe_id: 0, swipes: [sourceText] });
  const before = state();
  if (before.swipeCount !== 1 || before.swipeId !== 0 || before.text !== sourceText) {
    throw new Error('live-source-context-drift');
  }
  const enhancementResult = await runStage('enhance', () => runtime.enhanceLatestAssistantMessage({ reason: `live-${enhancementMode}-${scenario.id}` }));
  const after = state();
  const candidateText = String(after.text || '');
  const runtimeView = runtime.view?.() || {};
  globalThis.__recursionLiveRedirectProofStage = 'complete';
  return {
    evidenceClass: 'served-runtime-synthetic-message-real-provider',
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

async function ensureProgressPopoverOpen(page) {
  const open = await page.evaluate(() => (
    document.querySelector('[data-recursion-status-popover]')?.hidden === false
  ));
  if (!open) {
    await page.locator('[data-recursion-status-trigger]').first().click();
  }
  await page.waitForFunction(() => (
    document.querySelector('[data-recursion-status-popover]')?.hidden === false
  ), null, { timeout: 5000 });
}

async function createBrowserExecutor({ baseUrl, user, password, timeoutMs, artifactRoot, forceUtilityEnhancement = false }) {
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
  let reasonerProviderTest = null;
  let reasonerReadiness = null;
  if (!forceUtilityEnhancement) {
    const reasonerSetup = await page.evaluate(async () => {
      const runtime = globalThis.__recursionLiveHarnessRuntime;
      const before = runtime?.view?.()?.settings?.providers?.reasoner || {};
      const update = await runtime?.updateProviderConfig?.('reasoner', {
        maxTokens: 8192
      }, {
        expectedRevision: Number(before.configRevision || 0)
      });
      return {
        update,
        provider: runtime?.view?.()?.settings?.providers?.reasoner || null
      };
    });
    if (reasonerSetup?.update?.ok !== true) {
      const error = new Error(reasonerSetup?.update?.error?.message || 'Reasoner configuration could not be prepared for live proof.');
      error.code = reasonerSetup?.update?.error?.code || 'reasoner-provider-live-setup-failed';
      throw error;
    }
    reasonerProviderTest = await page.evaluate(async () => globalThis.__recursionLiveHarnessRuntime?.testProvider?.('reasoner'));
    if (reasonerProviderTest?.ok !== true) {
      const error = new Error('Reasoner provider test failed before Medium+ Redirect effectiveness run.');
      error.code = reasonerProviderTest?.error?.code || 'reasoner-provider-live-call-failed';
      throw error;
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector('#recursion-root', { state: 'visible', timeout: timeoutMs });
    await page.waitForFunction(() => Boolean(globalThis.__recursionLiveHarnessRuntime), null, { timeout: timeoutMs });
    reasonerReadiness = await page.evaluate(() => {
      const runtime = globalThis.__recursionLiveHarnessRuntime;
      return {
        provider: runtime?.view?.()?.settings?.providers?.reasoner || null,
        capability: runtime?.providerCapability?.('reasoner', 'redirect') || null
      };
    });
    if (
      Number(reasonerReadiness?.provider?.maxTokens) !== 8192
      || reasonerReadiness?.capability?.state !== 'ready'
    ) {
      const error = new Error([
        'Reasoner readiness did not survive reload for the live Redirect proof.',
        `state=${text(reasonerReadiness?.capability?.state || 'missing')}`,
        `maxTokens=${Number(reasonerReadiness?.provider?.maxTokens || 0)}`,
        `revision=${Number(reasonerReadiness?.provider?.configRevision || 0)}`,
        `health=${text(reasonerReadiness?.provider?.health?.status || 'missing')}`
      ].join(' '));
      error.code = 'reasoner-provider-live-reload-failed';
      throw error;
    }
  }
  if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });

  return {
    async execute({ scenario, targetModel, judgeModel, forceUtilityEnhancement = false }) {
      await page.setViewportSize({ width: 1280, height: 720 });
      await ensureProgressPopoverOpen(page);
      await installLiveEnhancementRunOracle(page);
      const artifacts = await page.evaluate(executeScenarioInPage, {
        scenario: { ...scenario, forceUtilityEnhancement },
        stageTimeouts: Object.fromEntries(['settings', 'warm', 'prepare', 'enhance', 'judge']
          .map((stage) => [stage, liveEditorialStageTimeoutMs(stage, timeoutMs)]))
      });
        if (artifacts?.environmentFailure) throw new Error(artifacts.environmentFailure);
        await page.waitForFunction(() => {
          const rows = [...document.querySelectorAll('[data-recursion-status-popover] [data-recursion-progress-row]')];
          return !rows.some((row) => ['running', 'pending', 'waiting'].includes(String(row.dataset.recursionProgressState || '').toLowerCase()));
        }, null, { timeout: 15000 }).catch(() => {});
        const enhancementMode = String(scenario?.enhancementMode || 'redirect').toLowerCase();
        const oracle = await collectLiveEnhancementRunOracle(page, {
          enhancement: {
            enabled: true,
            mode: enhancementMode,
            applyMode: 'as-swipe'
          },
          before: artifacts.before,
          after: artifacts.after,
          prepared: artifacts.prepared,
          enhancementResult: artifacts.enhancementResult,
          editorialResult: artifacts.runtimeView?.editorialResult
        });
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
        const judge = enhancementMode === 'redirect'
          ? await page.evaluate(executeJudgeInPage, {
              scenario,
              sourceText: artifacts.sourceText,
              candidateText: artifacts.candidateText,
              marker: artifacts.enhancementResult?.marker || {}
            })
          : { ok: true, decision: 'not-required', criteria: [] };
      return {
        ...artifacts,
        scenario,
        oracle,
        journalDelta,
        judge,
        provider: {
          targetModel: text(providerTest?.diagnostics?.model || providerTest?.provider?.resolvedModelLabel),
          judgeModel: text(judge?.diagnostics?.model),
          reasonerModel: text(reasonerProviderTest?.diagnostics?.model || reasonerProviderTest?.provider?.resolvedModelLabel),
          reasonerMaxTokens: Number(reasonerReadiness?.provider?.maxTokens || 0),
          reasonerCapability: text(reasonerReadiness?.capability?.state)
        },
        expectedModels: { targetModel, judgeModel },
        screenshotPath,
        phoneScreenshotPath
      };
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
        artifactRoot,
        forceUtilityEnhancement
      });
    }
    for (const scenario of scenarioList) {
      const artifacts = await execute({ scenario, targetModel, judgeModel, forceUtilityEnhancement });
      const evaluateScenario = String(scenario?.enhancementMode || 'redirect').toLowerCase() === 'repair'
        ? evaluateLiveRepairScenarioArtifacts
        : evaluateLiveRedirectScenarioArtifacts;
      const result = evaluateScenario({
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
