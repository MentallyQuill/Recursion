import { existsSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
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

async function routeExtensionSource(context, sourceRoot) {
  if (!sourceRoot) return false;
  const root = resolve(sourceRoot);
  if (!existsSync(root)) fail('source-root-missing', 'Recursion source override does not exist.', { root });
  const routePrefix = '/scripts/extensions/third-party/Recursion/';
  await context.route('**/scripts/extensions/third-party/Recursion/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const relativePath = decodeURIComponent(pathname.slice(pathname.indexOf(routePrefix) + routePrefix.length));
    const localPath = resolve(root, relativePath);
    if (localPath !== root && !localPath.startsWith(`${root}${sep}`)) {
      await route.abort('blockedbyclient');
      return;
    }
    if (!existsSync(localPath)) {
      await route.continue();
      return;
    }
    await route.fulfill({ path: localPath });
  });
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const env = process.env;
  const user = assertPreflight(argv, env);
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const sourceRoot = String(env.RECURSION_LIVE_SOURCE_ROOT || '').trim();
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
    const sourceOverride = await routeExtensionSource(context, sourceRoot);
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
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      return panel?.hidden === false
        && panel?.dataset?.recursionLastBriefState === 'ready'
        && document.querySelectorAll('[data-recursion-brief-card]').length > 0;
    }, null, { timeout: timeoutMs });
    const preserved = await page.evaluate(readLastBriefDomScript());
    if (
      preserved.cardRows !== readyBefore.cardRows
      || preserved.packetId !== readyBefore.packetId
      || preserved.runtimeLastBrief?.status !== 'ready'
      || preserved.promptButtonDisabled
    ) {
      fail('preserved-brief-mismatch', 'Last Brief changed before the swipe generation interceptor started.', {
        readyBefore,
        preserved
      });
    }
    const preservedScreenshot = await screenshotPanel(page, artifactDir, '02-preserved-after-swipe-marker', timeoutMs);

    await page.evaluate(() => {
      const proof = globalThis.__recursionLastBriefProof || {};
      proof.observedLastBriefStates = [];
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      const recordState = () => {
        const state = String(panel?.dataset?.recursionLastBriefState || '');
        if (state && proof.observedLastBriefStates.at(-1) !== state) proof.observedLastBriefStates.push(state);
      };
      recordState();
      proof.lastBriefObserver = new MutationObserver(recordState);
      proof.lastBriefObserver.observe(panel, {
        attributes: true,
        attributeFilter: ['data-recursion-last-brief-state'],
        childList: true,
        subtree: true
      });
      proof.preparePromise = globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
        userMessage: null,
        hostGeneration: true,
        generationType: 'swipe'
      });
      globalThis.__recursionLastBriefProof = proof;
    });
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      return panel?.dataset?.recursionLastBriefState === 'clearing'
        && document.querySelectorAll('[data-recursion-brief-card]').length === 0;
    }, null, { timeout: timeoutMs });
    const clearing = await page.evaluate(readLastBriefDomScript());
    if (
      clearing.runtimeLastBrief?.status !== 'clearing'
      || clearing.cardRows !== 0
      || !clearing.promptButtonDisabled
    ) {
      fail('generation-boundary-clear-mismatch', 'Last Brief did not clear when swipe generation began.', { clearing });
    }
    const clearingScreenshot = await screenshotPanel(page, artifactDir, '03-clearing-after-swipe-generation-start', timeoutMs);
    const second = await page.evaluate(async () => {
      const proof = globalThis.__recursionLastBriefProof || {};
      const result = await proof.preparePromise;
      proof.lastBriefObserver?.disconnect?.();
      return {
        ok: result?.ok === true,
        reused: result?.reused === true,
        reason: String(result?.reason || ''),
        observedStates: Array.isArray(proof.observedLastBriefStates) ? proof.observedLastBriefStates : []
      };
    });
    if (!second.ok) {
      fail('swipe-generation-failed', 'Swipe generation preparation did not settle successfully.', { second });
    }
    if (!second.observedStates.includes('clearing')) {
      fail('clearing-transition-unobserved', 'Live DOM never observed the Last Brief clearing transition.', { second });
    }
    await page.waitForFunction(() => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      return view.lastBrief?.status === 'ready' && Boolean(view.lastPacket?.packetId);
    }, null, { timeout: timeoutMs });
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      return panel?.hidden === false
        && panel?.dataset?.recursionLastBriefState === 'ready'
        && document.querySelectorAll('[data-recursion-brief-card]').length > 0;
    }, null, { timeout: timeoutMs });
    const readyAfter = await page.evaluate(readLastBriefDomScript());
    if (readyAfter.cardRows < 1 || readyAfter.runtimeLastBrief?.status !== 'ready' || !readyAfter.packetId) {
      fail('ready-after-swipe-mismatch', 'Last Brief did not become ready after swipe generation preparation settled.', {
        readyBefore,
        readyAfter,
        second
      });
    }
    if (second.reused && readyAfter.packetId !== readyBefore.packetId) {
      fail('reused-packet-identity-mismatch', 'Same-turn swipe reuse changed packet identity.', {
        before: readyBefore.packetId,
        after: readyAfter.packetId
      });
    }
    const readyAfterScreenshot = await screenshotPanel(page, artifactDir, '04-ready-after-swipe-generation', timeoutMs);

    console.log(JSON.stringify({
      status: 'pass',
      result: 'live-last-brief-lifecycle-pass',
      user,
      runId,
      sourceOverride,
      sourceRoot: sourceOverride ? resolve(sourceRoot) : '',
      first: { ok: first.ok === true },
      second,
      packetId: readyBefore.packetId,
      readyBefore: {
        state: readyBefore.panelState,
        cards: readyBefore.cardRows,
        handText: readyBefore.handText
      },
      preserved: {
        state: preserved.panelState,
        cards: preserved.cardRows,
        promptButtonDisabled: preserved.promptButtonDisabled,
        reason: preserved.runtimeLastBrief?.reason || ''
      },
      clearing: {
        state: clearing.panelState,
        cards: clearing.cardRows,
        promptButtonDisabled: clearing.promptButtonDisabled,
        reason: clearing.runtimeLastBrief?.reason || ''
      },
      readyAfter: {
        state: readyAfter.panelState,
        cards: readyAfter.cardRows,
        handText: readyAfter.handText,
        packetId: readyAfter.packetId
      },
      screenshots: {
        ready: readyScreenshot,
        preserved: preservedScreenshot,
        clearing: clearingScreenshot,
        readyAfter: readyAfterScreenshot
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
