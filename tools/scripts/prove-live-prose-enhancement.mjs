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
  return async ({ mode }) => {
    const context = () => globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const assistantText = (inputMode) => [
      `Prose Enhancement live ${inputMode} proof.`,
      'Mara was angry. Mara walked across the room. Mara looked at the door.',
      'The silence settled over them for a long moment. The words hung in the air.',
      'She drew in a breath and let out a breath. Her jaw clenched.',
      'She reached the handle, stopped, and waited.'
    ].join(' ');
    const seedAssistant = (inputMode) => {
      const ctx = context();
      if (!Array.isArray(ctx.chat)) ctx.chat = [];
      ctx.chat.length = 0;
      const text = assistantText(inputMode);
      const mesid = 0;
      const message = {
        mesid,
        is_user: false,
        name: 'Recursion Prose Proof',
        mes: text,
        swipe_id: 0,
        swipes: [text]
      };
      ctx.chat.push(message);
      globalThis.__recursionProseProofMessage = message;
      return { mesid, text };
    };
    const messageState = (mesid) => {
      const msg = (context().chat || []).find((entry, index) => Number(entry?.mesid ?? index) === Number(mesid));
      return {
        mesid,
        text: String(msg?.mes || ''),
        swipeId: Number(msg?.swipe_id ?? 0),
        swipes: Array.isArray(msg?.swipes) ? msg.swipes.map((entry) => String(entry || '')) : [],
        swipeInfoLength: Array.isArray(msg?.swipe_info) ? msg.swipe_info.length : 0,
        markerCount: Array.isArray(msg?.__recursionProseEnhancementSwipes) ? msg.__recursionProseEnhancementSwipes.filter(Boolean).length : 0
      };
    };
    const activeRuntime = globalThis.__recursionLiveHarnessRuntime || null;
    if (!activeRuntime) return { ok: false, reason: 'runtime-unavailable' };
    await activeRuntime.updateSettings({ enabled: true, proseEnhancement: { mode, contextMessages: 3 } });
    const seed = seedAssistant(mode);
    const before = messageState(seed.mesid);
    const result = await activeRuntime.enhanceLatestAssistantMessage({ reason: `live-${mode}` });
    const after = messageState(seed.mesid);
    return { ok: result?.ok !== false, mode, seed, result, before, after };
  };
}

const baseUrl = envValue('SILLYTAVERN_BASE_URL', 'http://127.0.0.1:8000');
const user = envValue('RECURSION_SILLYTAVERN_USER', 'recursion-soak-a');
const password = envValue('SILLYTAVERN_PASSWORD', '');
const userValidation = validateSoakUserHandle(user);
if (!userValidation.ok) fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', { user, reason: userValidation.reason });

const runId = createRunId('prove-live-prose-enhancement');
const report = {
  recordType: 'recursion.liveProseEnhancementProof',
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
  if (providerTest?.ok !== true) fail('utility-provider-failed', 'Utility provider live test failed.', providerTest);

  for (const mode of ['off', 'as-swipe', 'replace']) {
    const proof = await page.evaluate(proofScript(), { mode });
    const pass = mode === 'off'
      ? proof.result?.skipped === true && proof.before.text === proof.after.text && proof.after.swipes.length === 1
      : mode === 'as-swipe'
        ? proof.ok === true && proof.after.swipes.length === 2 && proof.after.swipeInfoLength === proof.after.swipes.length && proof.after.swipeId === 1 && proof.after.swipes[0] === proof.before.swipes[0]
        : proof.ok === true && proof.after.swipes.length === 1;
    report.checks.push({
      name: `prose-enhancement-${mode}`,
      status: pass ? 'pass' : 'fail',
      details: {
        ok: proof.ok,
        resultOk: proof.result?.ok,
        skipped: proof.result?.skipped === true,
        resultMode: proof.result?.mode || '',
        beforeSwipeCount: proof.before.swipes.length,
        afterSwipeCount: proof.after.swipes.length,
        afterSwipeInfoLength: proof.after.swipeInfoLength,
        afterSwipeId: proof.after.swipeId,
        changed: proof.before.text !== proof.after.text,
        markerCount: proof.after.markerCount,
        errorCode: proof.result?.error?.code || ''
      }
    });
    if (!pass) fail(`prose-${mode}-failed`, `Prose Enhancement ${mode} proof failed.`, proof);
  }

  report.status = 'pass';
  report.result = 'prose-enhancement-live-pass';
} catch (error) {
  report.status = error?.result ? 'fail' : 'environment-fail';
  report.result = error?.result || 'prose-enhancement-live-error';
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
