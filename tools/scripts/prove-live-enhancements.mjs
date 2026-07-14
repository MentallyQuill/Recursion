import { chromium } from 'playwright';
import {
  createRunId,
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

function fail(result, message, details = {}) {
  const error = new Error(message);
  error.result = result;
  error.details = details;
  throw error;
}

function envValue(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

function proofScript() {
  return async ({ target, applyMode, pipelineMode }) => {
    const rawContext = () => globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const decorateContext = (ctx = {}) => {
      ctx.saveChat = async () => {};
      ctx.reloadCurrentChat = async () => {};
      return ctx;
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
    const assistantText = [
      'Mara kept her hand on the latch.',
      '"So you are saying you are worried. Are you okay? I can provide support if you want. Do not get the wrong idea, this is purely tactical."'
    ].join(' ');
    const seedAssistant = () => {
      const ctx = context();
      if (!Array.isArray(ctx.chat)) ctx.chat = [];
      ctx.chat.length = 0;
      ctx.chat.push({
        mesid: 0,
        is_user: true,
        name: 'Recursion Enhancement Proof User',
        mes: 'Mara is guarded and dislikes being managed. She just saw the other person flinch.'
      });
      const mesid = 1;
      const message = {
        mesid,
        is_user: false,
        name: 'Mara',
        mes: assistantText,
        swipe_id: 0,
        swipes: [assistantText]
      };
      ctx.chat.push(message);
      return { mesid, text: assistantText };
    };
    const messageState = (mesid) => {
      const msg = (context().chat || []).find((entry, index) => Number(entry?.mesid ?? index) === Number(mesid));
      return {
        mesid,
        text: String(msg?.mes || ''),
        swipeId: Number(msg?.swipe_id ?? 0),
        swipes: Array.isArray(msg?.swipes) ? msg.swipes.map((entry) => String(entry || '')) : [],
        swipeInfoLength: Array.isArray(msg?.swipe_info) ? msg.swipe_info.length : 0,
        markerCount: Array.isArray(msg?.__recursionGenerationReviewSwipes) ? msg.__recursionGenerationReviewSwipes.filter(Boolean).length : 0
      };
    };
    const activeRuntime = globalThis.__recursionLiveHarnessRuntime || null;
    if (!activeRuntime) return { ok: false, reason: 'runtime-unavailable' };
    await activeRuntime.updateSettings({
      enabled: true,
      mode: 'auto',
      pipelineMode,
      reasoningLevel: 'medium',
      reasonerUse: 'always',
      enhancements: { mode: target, applyMode, contextMessages: 3 }
    });
    const seed = seedAssistant();
    const prepared = await activeRuntime.prepareForGeneration({
      userMessage: 'Mara is guarded and dislikes being managed. She just saw the other person flinch.'
    });
    const preparedView = activeRuntime.view?.() || {};
    const preparedHandCardCount = Array.isArray(preparedView.lastHand?.cards)
      ? preparedView.lastHand.cards.length
      : 0;
    const preparedFamilies = new Set((preparedView.lastHand?.cards || []).map((card) => String(card?.family || '')).filter(Boolean));
    const duplicateFamilyOmissions = (preparedView.lastHand?.omitted || []).filter((entry) => (
      entry?.reason === 'max-cards' && preparedFamilies.has(String(entry?.family || ''))
    ));
    const before = messageState(seed.mesid);
    const result = await activeRuntime.enhanceLatestAssistantMessage({ reason: `live-${target}-${applyMode}` });
    const after = messageState(seed.mesid);
    return { ok: result?.ok !== false, target, applyMode, pipelineMode, seed, prepared, preparedHandCardCount, duplicateFamilyOmissions, result, before, after };
  };
}

const SLOP_PATTERNS = Object.freeze([
  /So you are saying/i,
  /Are you okay\?/i,
  /I can provide support/i,
  /Do not get the wrong idea/i,
  /purely tactical/i,
  /What do you want/i,
  /what now/i,
  /your move/i
]);

function editDistance(a = '', b = '') {
  const left = String(a);
  const right = String(b);
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }
  return previous[right.length];
}

function qualityDelta(before = '', after = '') {
  const source = String(before || '');
  const next = String(after || '');
  const beforeSlop = SLOP_PATTERNS.filter((pattern) => pattern.test(source)).length;
  const afterSlop = SLOP_PATTERNS.filter((pattern) => pattern.test(next)).length;
  const distance = editDistance(source, next);
  const ratio = source.length ? distance / source.length : 0;
  return {
    beforeSlop,
    afterSlop,
    distance,
    ratio,
    changed: source !== next,
    significant: source !== next && ratio >= 0.1 && afterSlop < beforeSlop
  };
}

const baseUrl = envValue('SILLYTAVERN_BASE_URL', 'http://127.0.0.1:8000');
const user = envValue('RECURSION_SILLYTAVERN_USER', 'recursion-soak-a');
const password = envValue('SILLYTAVERN_PASSWORD', '');
const selectedCase = envValue('RECURSION_ENHANCEMENT_PROOF_CASE', '');
const userValidation = validateSoakUserHandle(user);
if (!userValidation.ok) fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', { user, reason: userValidation.reason });

const runId = createRunId('prove-live-enhancements');
const report = {
  recordType: 'recursion.liveEnhancementsProof',
  schemaVersion: 1,
  runId,
  baseUrl,
  user,
  startedAt: new Date().toISOString(),
  status: 'running',
  checks: []
};

let browser;
try {
  const session = createSillyTavernHttpSession({ baseUrl, user, password });
  await session.login();
  browser = await chromium.launch({ headless: true });
  const browserContext = await browser.newContext();
  await browserContext.addCookies(session.playwrightCookies());
  await browserContext.addInitScript(() => {
    globalThis.__recursionLiveHarness = true;
  });
  const page = await browserContext.newPage();
  page.setDefaultTimeout(120000);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#recursion-root', { state: 'visible', timeout: 120000 });
  await page.waitForFunction(() => Boolean(globalThis.__recursionLiveHarnessRuntime), null, { timeout: 120000 });

  const providerTest = await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    return runtime?.testProvider ? runtime.testProvider('utility') : { ok: false, reason: 'runtime-testProvider-missing' };
  });
  report.checks.push({
    name: 'utility-provider-live-call',
    status: providerTest?.ok === true ? 'pass' : 'fail',
    details: {
      ok: providerTest?.ok === true,
      code: providerTest?.error?.code || '',
      providerId: providerTest?.diagnostics?.providerId || '',
      model: providerTest?.diagnostics?.model || ''
    }
  });
  if (providerTest?.ok !== true) {
    report.checks.push({
      name: 'utility-provider-live-call-nonfatal',
      status: 'warning',
      details: {
        reason: 'Provider test returned invalid structured output; continuing to direct enhancer calls.',
        code: providerTest?.error?.code || ''
      }
    });
  }

  const testCases = [
    { target: 'recompose', applyMode: 'as-swipe', pipelineMode: 'standard' },
    { target: 'recompose', applyMode: 'as-swipe', pipelineMode: 'rapid' },
    { target: 'recompose', applyMode: 'as-swipe', pipelineMode: 'fused' },
    { target: 'recompose', applyMode: 'replace', pipelineMode: 'standard' },
    { target: 'recompose', applyMode: 'replace', pipelineMode: 'rapid' },
    { target: 'recompose', applyMode: 'replace', pipelineMode: 'fused' }
  ];
  const selectedCases = selectedCase
    ? testCases.filter((testCase) => `${testCase.pipelineMode}-${testCase.applyMode}` === selectedCase)
    : testCases;
  if (!selectedCases.length) fail('invalid-proof-case', 'RECURSION_ENHANCEMENT_PROOF_CASE did not match a live proof case.', { selectedCase });
  for (const testCase of selectedCases) {
    const proof = await page.evaluate(proofScript(), testCase);
    const beforeText = testCase.applyMode === 'as-swipe' ? proof.before.swipes[0] : proof.before.text;
    const afterText = testCase.applyMode === 'as-swipe' ? proof.after.swipes[proof.after.swipeId] : proof.after.text;
    const quality = qualityDelta(beforeText, afterText);
    const cardOutcomes = Array.isArray(proof.result?.marker?.cardOutcomes)
      ? proof.result.marker.cardOutcomes
      : [];
    const outcomeCardIds = cardOutcomes.map((outcome) => String(outcome?.cardId || '')).filter(Boolean);
    const validCardOutcomeLedger = cardOutcomes.length > 0
      && new Set(outcomeCardIds).size === cardOutcomes.length
      && cardOutcomes.every((outcome) => Array.isArray(outcome?.evidenceRefs) && outcome.evidenceRefs.length > 0);
    const validatedEditorialResult = proof.result?.ok === true
      && proof.result?.mode === testCase.target
      && proof.result?.marker?.applyMode === testCase.applyMode
      && proof.result?.artifact?.kind === 'candidate'
      && typeof proof.result?.artifact?.text === 'string'
      && proof.result.artifact.text.length > 0
      && proof.preparedHandCardCount > 0
      && proof.duplicateFamilyOmissions.length === 0
      && validCardOutcomeLedger;
    const pass = testCase.applyMode === 'as-swipe'
      ? proof.prepared?.ok === true
        && proof.ok === true
        && validatedEditorialResult
        && proof.after.swipes.length === 2
        && proof.after.swipeInfoLength === proof.after.swipes.length
        && proof.after.swipeId === 1
        && proof.after.swipes[0] === proof.before.swipes[0]
        && quality.significant === true
      : proof.prepared?.ok === true
        && proof.ok === true
        && validatedEditorialResult
        && proof.after.swipes.length === 1
        && quality.significant === true;
    report.checks.push({
      name: `enhancement-${testCase.pipelineMode}-${testCase.target}-${testCase.applyMode}`,
      status: pass ? 'pass' : 'fail',
      details: {
        ok: proof.ok,
        resultOk: proof.result?.ok,
        skipped: proof.result?.skipped === true,
        resultMode: proof.result?.mode || '',
        preparedOk: proof.prepared?.ok === true,
        preparedHandCardCount: proof.preparedHandCardCount,
        duplicateFamilyOmissions: proof.duplicateFamilyOmissions,
        artifactKind: proof.result?.artifact?.kind || '',
        resultApplyMode: proof.result?.marker?.applyMode || '',
        installedCardCount: proof.preparedHandCardCount,
        outcomeCardCount: cardOutcomes.length,
        validCardOutcomeLedger,
        cardOutcomes,
        beforeSwipeCount: proof.before.swipes.length,
        afterSwipeCount: proof.after.swipes.length,
        afterSwipeInfoLength: proof.after.swipeInfoLength,
        afterSwipeId: proof.after.swipeId,
        changed: proof.before.text !== proof.after.text,
        quality,
        beforePreview: beforeText.slice(0, 500),
        afterPreview: afterText.slice(0, 500),
        markerCount: proof.after.markerCount,
        errorCode: proof.result?.error?.code || '',
        errorActualSchema: proof.result?.error?.actualSchema || '',
        errorResponseFields: proof.result?.error?.responseFields || []
      }
    });
    if (!pass) fail(`enhancement-${testCase.target}-${testCase.applyMode}-failed`, `Enhancement ${testCase.target}/${testCase.applyMode} proof failed.`, proof);
  }

  report.status = 'pass';
  report.result = 'enhancements-live-pass';
} catch (error) {
  report.status = error?.result ? 'fail' : 'environment-fail';
  report.result = error?.result || 'enhancements-live-error';
  report.error = {
    message: String(error?.message || error),
    details: error?.details || null
  };
} finally {
  if (browser) await browser.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
}

console.log(JSON.stringify(report, null, 2));
if (report.status !== 'pass') process.exitCode = 1;
