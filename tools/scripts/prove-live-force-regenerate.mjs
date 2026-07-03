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
  await page.waitForSelector('[data-recursion-force-regenerate]', { timeout: timeoutMs });
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

async function seedChatTurn(page, marker, timeoutMs) {
  await page.evaluate((runMarker) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    if (!Array.isArray(context.chat)) context.chat = [];
    const base = context.chat.length;
    const assistantMes = `For ${runMarker}, the sealed gate glowed blue while Mara held the brass key.`;
    const userMes = `For ${runMarker}, keep the gate scene coherent and brief.`;
    context.chat.push({
      mesid: base,
      is_user: false,
      name: 'Recursion Force Proof',
      mes: assistantMes,
      swipe_id: 0,
      swipes: [assistantMes]
    });
    context.chat.push({
      mesid: base + 1,
      is_user: true,
      name: 'Recursion Force Proof',
      mes: userMes,
      swipe_id: 0,
      swipes: [userMes]
    });
    globalThis.__recursionForceProof = {
      marker: runMarker,
      userMesId: base + 1
    };
  }, marker);
  await page.waitForFunction((runMarker) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    return Array.isArray(context.chat)
      && context.chat.some((message) => String(message?.mes || '').includes(runMarker) && message?.is_user === true);
  }, marker, { timeout: timeoutMs });
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

function readDomStateScript() {
  return () => {
    const panel = document.querySelector('[data-recursion-hand-dropdown]');
    const runtimeView = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const forceButton = document.querySelector('[data-recursion-force-regenerate]');
    const stopButton = document.querySelector('[data-recursion-stop-generation]');
    return {
      panelText: String(panel?.textContent || '').replace(/\s+/g, ' ').trim(),
      panelState: String(panel?.dataset?.recursionLastBriefState || ''),
      cardRows: document.querySelectorAll('[data-recursion-brief-card]').length,
      forceButtonHidden: forceButton?.hidden === true,
      forceButtonDisabled: forceButton?.disabled === true,
      forceButtonText: String(forceButton?.textContent || '').replace(/\s+/g, ' ').trim(),
      forceButtonAriaLabel: String(forceButton?.getAttribute('aria-label') || ''),
      forceButtonHasRestartIcon: Boolean(forceButton?.querySelector('[data-recursion-force-regenerate-icon]')),
      stopButtonHidden: stopButton?.hidden === true,
      stopButtonDisabled: stopButton?.disabled === true,
      currentStepText: String(document.querySelector('[data-recursion-current-step]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      runtimeLastBrief: runtimeView.lastBrief || null,
      forceRegenerate: runtimeView.forceRegenerate || null,
      activeRunId: String(runtimeView.activeRunId || ''),
      hostGenerationActive: runtimeView.hostGenerationActive === true,
      progressRun: runtimeView.progressRun || null,
      packetId: String(runtimeView.lastPacket?.packetId || ''),
      packetDiagnostics: runtimeView.lastPacket?.diagnostics || null,
      hostProbe: globalThis.__recursionForceProof?.hostProbe || null
    };
  };
}

async function installHostGenerationProbe(page, timeoutMs) {
  await page.evaluate(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    if (typeof context.generate !== 'function') {
      throw new Error('SillyTavern context Generate function is unavailable');
    }
    if (!globalThis.__recursionForceProof) globalThis.__recursionForceProof = {};
    const originalGenerate = context.generate.bind(context);
    const originalStopGeneration = typeof context.stopGeneration === 'function'
      ? context.stopGeneration.bind(context)
      : null;
    const probe = {
      generateCalls: [],
      stopCalls: [],
      released: false
    };
    let releaseGenerate = null;
    context.generate = async (type, options = {}) => {
      probe.generateCalls.push({ type: String(type || ''), options });
      return await new Promise((resolve) => {
        releaseGenerate = (value = { ok: true, stopped: true }) => {
          probe.released = true;
          resolve(value);
        };
      });
    };
    context.stopGeneration = (details = {}) => {
      probe.stopCalls.push(details);
      if (releaseGenerate) releaseGenerate({ ok: true, stopped: true });
      if (originalStopGeneration) {
        try {
          return originalStopGeneration(details);
        } catch {
          return true;
        }
      }
      return true;
    };
    globalThis.__recursionForceProof.hostProbe = probe;
    globalThis.__recursionForceProof.restoreHostProbe = () => {
      context.generate = originalGenerate;
      if (originalStopGeneration) context.stopGeneration = originalStopGeneration;
      else delete context.stopGeneration;
    };
  });
  await page.waitForFunction(() => Boolean(globalThis.__recursionForceProof?.hostProbe), null, { timeout: timeoutMs });
}

async function restoreHostGenerationProbe(page) {
  await page.evaluate(() => {
    globalThis.__recursionForceProof?.restoreHostProbe?.();
  }).catch(() => {});
}

async function main() {
  const argv = process.argv.slice(2);
  const env = process.env;
  const user = assertPreflight(argv, env);
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const runId = createRunId('force-regenerate-proof');
  const artifactDir = resolve('artifacts', 'live-force-regenerate', runId);
  mkdirSync(artifactDir, { recursive: true });
  const session = createSillyTavernHttpSession({
    baseUrl: env.SILLYTAVERN_BASE_URL,
    user,
    password: passwordForUser(user, env)
  });
  await session.init();
  await session.login();
  const browser = await chromium.launch({ headless: env.RECURSION_SILLYTAVERN_HEADLESS !== '0' });
  let page = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
    await context.addCookies(session.playwrightCookies());
    await context.addInitScript(() => {
      globalThis.__recursionLiveHarness = true;
    });
    page = await context.newPage();
    await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForRoot(page, timeoutMs);
    await forceStandardAuto(page, timeoutMs);
    await seedChatTurn(page, runId, timeoutMs);

    const first = await page.evaluate(() => globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
      userMessage: null,
      hostGeneration: false
    }));
    if (!first?.ok || !first?.packet?.packetId) fail('first-prepare-failed', 'Initial live prepare failed.', { first });
    await page.waitForFunction(() => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      return view.lastBrief?.status === 'ready' && view.lastPacket?.packetId;
    }, null, { timeout: timeoutMs });
    await openLastBrief(page, timeoutMs);
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      return panel?.hidden === false
        && panel?.dataset?.recursionLastBriefState === 'ready'
        && document.querySelectorAll('[data-recursion-brief-card]').length > 0;
    }, null, { timeout: timeoutMs });
    const readyBefore = await page.evaluate(readDomStateScript());
    if (readyBefore.forceButtonHidden || !readyBefore.stopButtonHidden || !readyBefore.packetId) {
      fail('idle-command-slot-mismatch', 'Regenerate was not visible in the idle bar command slot.', { readyBefore });
    }
    if (!readyBefore.forceButtonHasRestartIcon || readyBefore.forceButtonText) {
      fail('idle-regenerate-icon-mismatch', 'Idle Regenerate command was not an icon-only restart button.', { readyBefore });
    }
    const readyScreenshot = await screenshotPanel(page, artifactDir, '01-ready-before-force', timeoutMs);

    await installHostGenerationProbe(page, timeoutMs);
    await page.locator('[data-recursion-force-regenerate]').first().click({ timeout: timeoutMs });
    await page.waitForFunction(() => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      const stopButton = document.querySelector('[data-recursion-stop-generation]');
      const forceButton = document.querySelector('[data-recursion-force-regenerate]');
      return (view.forceRegenerate?.pending === true || view.activeRunId || view.hostGenerationActive === true)
        && view.lastBrief?.reason === 'user-force-regenerate'
        && panel?.dataset?.recursionLastBriefState === 'clearing'
        && /Preparing fresh prompt packet\./.test(String(panel?.textContent || ''))
        && stopButton?.hidden === false
        && forceButton?.hidden === true;
    }, null, { timeout: timeoutMs });
    const clearing = await page.evaluate(readDomStateScript());
    if (clearing.runtimeLastBrief?.reason !== 'user-force-regenerate') {
      fail('force-not-running', 'Regenerate click did not start a forced turn and clear Last Brief.', { clearing });
    }
    if (!clearing.forceButtonHidden || clearing.stopButtonHidden || clearing.stopButtonDisabled) {
      fail('force-stop-slot-mismatch', 'Forced regeneration did not replace Regenerate with Stop.', { clearing });
    }
    if (!clearing.currentStepText && !clearing.activeRunId && clearing.forceRegenerate?.pending !== true) {
      fail('force-progress-missing', 'Forced regeneration did not expose progress/status feedback.', { clearing });
    }
    const clearingScreenshot = await screenshotPanel(page, artifactDir, '02-cleared-after-force', timeoutMs);

    await page.waitForFunction((oldPacketId) => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      const probe = globalThis.__recursionForceProof?.hostProbe;
      return Array.isArray(probe?.generateCalls)
        && probe.generateCalls.some((call) => call.type === 'regenerate')
        && view.forceRegenerate?.pending === false
        && view.lastBrief?.status === 'ready'
        && view.lastPacket?.packetId
        && view.lastPacket.packetId !== oldPacketId
        && view.hostGenerationActive === true;
    }, readyBefore.packetId, { timeout: timeoutMs });
    const readyAfter = await page.evaluate(readDomStateScript());
    if (readyAfter.packetId === readyBefore.packetId || readyAfter.runtimeLastBrief?.reason !== 'force-regenerate-installed') {
      fail('force-ready-mismatch', 'Forced run did not restore Last Brief with a fresh packet.', { readyBefore, readyAfter });
    }
    if (!readyAfter.hostProbe?.generateCalls?.some((call) => call.type === 'regenerate')) {
      fail('host-regenerate-missing', 'Forced run did not call SillyTavern native regenerate.', { readyAfter });
    }
    if (readyAfter.stopButtonHidden || !readyAfter.forceButtonHidden || readyAfter.hostGenerationActive !== true) {
      fail('host-regenerate-stop-mismatch', 'Stop was not visible while forced host regeneration was active.', { readyAfter });
    }
    const packetText = JSON.stringify(readyAfter.packetDiagnostics || {});
    if (!packetText.includes('force-regenerate:user-force-regenerate') || !packetText.includes('force-regenerate:cache-bypassed')) {
      fail('force-diagnostics-missing', 'Forced packet did not record force-regenerate diagnostics.', { packetDiagnostics: readyAfter.packetDiagnostics });
    }
    const readyAfterScreenshot = await screenshotPanel(page, artifactDir, '03-ready-after-force', timeoutMs);

    await page.locator('[data-recursion-stop-generation]').first().click({ timeout: timeoutMs });
    await page.waitForFunction(() => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      const probe = globalThis.__recursionForceProof?.hostProbe;
      return Array.isArray(probe?.stopCalls)
        && probe.stopCalls.length > 0
        && view.hostGenerationActive === false
        && !view.activeRunId;
    }, null, { timeout: timeoutMs });
    const stoppedAfter = await page.evaluate(readDomStateScript());
    if (!stoppedAfter.hostProbe?.stopCalls?.length || stoppedAfter.hostGenerationActive) {
      fail('force-stop-failed', 'Recursion Stop did not call SillyTavern stop during forced regeneration.', { stoppedAfter });
    }

    console.log(JSON.stringify({
      status: 'pass',
      result: 'live-force-regenerate-pass',
      user,
      runId,
      first: { ok: first.ok === true, packetId: readyBefore.packetId },
      second: {
        packetId: readyAfter.packetId
      },
      clearing: {
        state: clearing.panelState,
        reason: clearing.runtimeLastBrief?.reason || '',
        buttonText: clearing.forceButtonText,
        stopVisible: clearing.stopButtonHidden === false,
        currentStepText: clearing.currentStepText
      },
      readyAfter: {
        state: readyAfter.panelState,
        reason: readyAfter.runtimeLastBrief?.reason || '',
        cards: readyAfter.cardRows,
        hostGenerateCalls: readyAfter.hostProbe?.generateCalls?.length || 0
      },
      stoppedAfter: {
        hostStopCalls: stoppedAfter.hostProbe?.stopCalls?.length || 0,
        hostGenerationActive: stoppedAfter.hostGenerationActive
      },
      screenshots: {
        readyBefore: readyScreenshot,
        clearing: clearingScreenshot,
        readyAfter: readyAfterScreenshot
      }
    }, null, 2));
  } finally {
    if (page) await restoreHostGenerationProbe(page).catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'fail',
    result: error.result || 'live-force-regenerate-error',
    error: error.message,
    details: error.details || null
  }, null, 2));
  process.exit(1);
});
