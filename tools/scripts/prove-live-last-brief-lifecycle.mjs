import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  createRunId,
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

const DEFAULT_TIMEOUT_MS = 240000;

function fail(result, message, details = {}) {
  const error = new Error(message);
  error.result = result;
  error.details = details;
  throw error;
}

function passwordEnvKey(user) {
  return `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function passwordForUser(user, env) {
  return env[passwordEnvKey(user)] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function assertPreflight(argv, env) {
  if (!argv.includes('--live')) fail('dry-run', 'Pass --live to mutate a dedicated SillyTavern user.');
  if (!env.SILLYTAVERN_BASE_URL) fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  const userResult = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  if (!userResult.ok) {
    fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', userResult);
  }
  return userResult.user;
}

async function waitForRoot(page, timeoutMs) {
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-hand-toggle]', { timeout: timeoutMs });
}

async function forceStandardAuto(page, timeoutMs) {
  await page.evaluate(async () => {
    globalThis.__recursionLiveHarness = true;
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    if (typeof runtime?.updateSettings !== 'function') throw new Error('Recursion live harness runtime unavailable');
    await runtime.updateSettings({
      enabled: true,
      mode: 'auto',
      pipelineMode: 'standard',
      reasonerUse: 'off',
      minCards: 1,
      maxCards: 2
    });
  });
  await page.waitForFunction(() => {
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    return view.settings?.enabled !== false
      && view.settings?.mode === 'auto'
      && view.settings?.pipelineMode === 'standard';
  }, null, { timeout: timeoutMs });
}

async function seedChatTurn(page, runId, timeoutMs) {
  await page.evaluate((marker) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    if (!Array.isArray(context.chat)) context.chat = [];
    const base = context.chat.length;
    context.chat.push({
      mesid: base,
      is_user: false,
      name: 'Recursion Last Brief Proof',
      mes: `Mara kept her hand on the sealed archive door for ${marker}. She felt the ward-lines tighten while the corridor stayed quiet.`
    });
    context.chat.push({
      mesid: base + 1,
      is_user: true,
      name: 'Recursion Last Brief Proof',
      mes: `For ${marker}, keep the archive door scene coherent and concise.`
    });
    globalThis.__recursionLastBriefProof = {
      marker,
      userMesId: base + 1,
      assistantMesId: null
    };
  }, runId);
  await page.waitForFunction((marker) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    return Array.isArray(context.chat) && context.chat.some((message) => String(message?.mes || '').includes(marker) && message?.is_user === true);
  }, runId, { timeout: timeoutMs });
}

async function openLastBrief(page, timeoutMs) {
  const panel = page.locator('[data-recursion-hand-dropdown]').first();
  if (await panel.getAttribute('hidden').catch(() => null) !== null) {
    await page.locator('[data-recursion-hand-toggle]').first().click({ timeout: timeoutMs });
  }
  await page.waitForFunction(() => document.querySelector('[data-recursion-hand-dropdown]')?.hidden === false, null, { timeout: timeoutMs });
}

async function screenshotPanel(page, artifactDir, name, timeoutMs) {
  await page.locator('[data-recursion-hand-dropdown]').first().screenshot({
    path: resolve(artifactDir, `${name}.png`),
    timeout: timeoutMs
  });
  return resolve(artifactDir, `${name}.png`);
}

function readLastBriefDomScript() {
  return () => {
    const panel = document.querySelector('[data-recursion-hand-dropdown]');
    const runtimeView = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    return {
      handText: String(document.querySelector('[data-recursion-hand-count]')?.textContent || ''),
      panelText: String(panel?.textContent || '').replace(/\s+/g, ' ').trim(),
      panelState: String(panel?.dataset?.recursionLastBriefState || ''),
      cardRows: document.querySelectorAll('[data-recursion-brief-card]').length,
      promptButtonDisabled: document.querySelector('[data-recursion-prompt-packet-button]')?.disabled === true,
      runtimeLastBrief: runtimeView.lastBrief || null,
      packetId: String(runtimeView.lastPacket?.packetId || '')
    };
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const env = process.env;
  const user = assertPreflight(argv, env);
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const runId = createRunId('last-brief-proof');
  const artifactDir = resolve('artifacts', 'live-last-brief', runId);
  mkdirSync(artifactDir, { recursive: true });
  const session = createSillyTavernHttpSession({
    baseUrl: env.SILLYTAVERN_BASE_URL,
    user,
    password: passwordForUser(user, env)
  });
  await session.init();
  await session.login();
  const browser = await chromium.launch({ headless: env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
    await context.addCookies(session.playwrightCookies());
    await context.addInitScript(() => {
      globalThis.__recursionLiveHarness = true;
    });
    const page = await context.newPage();
    await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForRoot(page, timeoutMs);
    await forceStandardAuto(page, timeoutMs);
    await seedChatTurn(page, runId, timeoutMs);
    const first = await page.evaluate(() => globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
      userMessage: null,
      hostGeneration: true
    }));
    if (!first?.ok) fail('first-prepare-failed', 'Initial live prepare failed.', { first });
    await page.waitForFunction(() => globalThis.__recursionLiveHarnessRuntime?.view?.()?.lastBrief?.status === 'ready', null, { timeout: timeoutMs });
    await openLastBrief(page, timeoutMs);
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      return panel?.hidden === false
        && panel?.dataset?.recursionLastBriefState === 'ready'
        && document.querySelectorAll('[data-recursion-brief-card]').length > 0;
    }, null, { timeout: timeoutMs });
    const readyBefore = await page.evaluate(readLastBriefDomScript());
    if (readyBefore.cardRows < 1 || readyBefore.runtimeLastBrief?.status !== 'ready' || !readyBefore.packetId) {
      fail('ready-brief-missing', 'Last Brief did not render ready cards after live prepare.', { readyBefore });
    }
    const readyScreenshot = await screenshotPanel(page, artifactDir, '01-ready-before-swipe', timeoutMs);

    await page.evaluate(async () => {
      const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
      if (!Array.isArray(context.chat)) context.chat = [];
      const proof = globalThis.__recursionLastBriefProof || {};
      const mesid = context.chat.length;
      context.chat.push({
        mesid,
        is_user: false,
        name: 'Recursion Last Brief Proof',
        mes: `First assistant response being swiped for ${proof.marker || 'last-brief-proof'}.`,
        swipeId: 1,
        swipe_id: 1,
        swipeCount: 2,
        swipe_count: 2,
        activeSwipeTextHash: 'last-brief-proof-alt'
      });
      proof.assistantMesId = mesid;
      globalThis.__recursionLastBriefProof = proof;
      return globalThis.__recursionLiveHarnessRuntime.handleLatestAssistantSwipeRetry({
        eventName: 'message_swiped',
        messageId: mesid
      });
    });
    await page.waitForFunction(() => globalThis.__recursionLiveHarnessRuntime?.view?.()?.lastBrief?.status === 'clearing', null, { timeout: timeoutMs });
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      return panel?.hidden === false
        && panel?.dataset?.recursionLastBriefState === 'clearing'
        && /Preparing next prompt packet\./.test(String(panel?.textContent || ''))
        && document.querySelectorAll('[data-recursion-brief-card]').length === 0;
    }, null, { timeout: timeoutMs });
    const clearing = await page.evaluate(readLastBriefDomScript());
    if (clearing.cardRows !== 0 || clearing.runtimeLastBrief?.reason !== 'latest-assistant-swipe' || !clearing.promptButtonDisabled) {
      fail('clearing-brief-mismatch', 'Last Brief did not visually clear after latest-assistant swipe marker.', { clearing });
    }
    const clearingScreenshot = await screenshotPanel(page, artifactDir, '02-cleared-after-swipe', timeoutMs);

    const second = await page.evaluate(() => globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
      userMessage: null,
      hostGeneration: true
    }));
    if (!second?.ok || second?.reused !== true || second?.reason !== 'same-turn-swipe-retry') {
      fail('swipe-reuse-failed', 'Latest-assistant swipe did not reuse the previous packet.', { second });
    }
    await page.waitForFunction((packetId) => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      return view.lastBrief?.status === 'ready' && view.lastPacket?.packetId === packetId;
    }, readyBefore.packetId, { timeout: timeoutMs });
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      return panel?.hidden === false
        && panel?.dataset?.recursionLastBriefState === 'ready'
        && document.querySelectorAll('[data-recursion-brief-card]').length > 0;
    }, null, { timeout: timeoutMs });
    const restored = await page.evaluate(readLastBriefDomScript());
    if (restored.packetId !== readyBefore.packetId || restored.cardRows < 1 || restored.runtimeLastBrief?.status !== 'ready') {
      fail('restored-brief-mismatch', 'Last Brief did not restore the reused packet and cards.', { readyBefore, restored });
    }
    const restoredScreenshot = await screenshotPanel(page, artifactDir, '03-restored-after-reuse', timeoutMs);

    console.log(JSON.stringify({
      status: 'pass',
      result: 'live-last-brief-lifecycle-pass',
      user,
      runId,
      first: { ok: first.ok === true },
      second: { ok: second.ok === true, reused: second.reused === true, reason: second.reason || '' },
      packetId: readyBefore.packetId,
      readyBefore: {
        state: readyBefore.panelState,
        cards: readyBefore.cardRows,
        handText: readyBefore.handText
      },
      clearing: {
        state: clearing.panelState,
        cards: clearing.cardRows,
        promptButtonDisabled: clearing.promptButtonDisabled,
        reason: clearing.runtimeLastBrief?.reason || ''
      },
      restored: {
        state: restored.panelState,
        cards: restored.cardRows,
        handText: restored.handText
      },
      screenshots: {
        ready: readyScreenshot,
        clearing: clearingScreenshot,
        restored: restoredScreenshot
      }
    }, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'fail',
    result: error.result || 'live-last-brief-lifecycle-error',
    error: error.message,
    details: error.details || null
  }, null, 2));
  process.exit(1);
});
