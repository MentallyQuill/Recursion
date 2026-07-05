import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  createRunId,
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

const DEFAULT_TIMEOUT_MS = 240000;

function parseArgs(argv = []) {
  const args = { live: false, providerProfile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') args.live = true;
    else if (arg === '--provider-profile' || arg === '--profile') {
      args.providerProfile = String(argv[index + 1] || '').trim();
      index += 1;
    }
  }
  return args;
}

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

function assertPreflight(args, env) {
  if (!args.live) fail('dry-run', 'Pass --live to mutate a dedicated SillyTavern user.');
  if (!env.SILLYTAVERN_BASE_URL) fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  const userResult = validateSoakUserHandle(env.RECURSION_SILLYTAVERN_USER);
  if (!userResult.ok) {
    fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', userResult);
  }
  return userResult.user;
}

async function waitForRoot(page, timeoutMs) {
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-fresh-next-generation]', { timeout: timeoutMs });
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
      name: 'Recursion Fresh Proof',
      mes: assistantMes,
      swipe_id: 0,
      swipes: [assistantMes]
    });
    context.chat.push({
      mesid: base + 1,
      is_user: true,
      name: 'Recursion Fresh Proof',
      mes: userMes,
      swipe_id: 0,
      swipes: [userMes]
    });
    globalThis.__recursionFreshNextProof = {
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

async function forceProviderProfile(page, profileName, timeoutMs) {
  const requestedProfile = String(profileName || '').trim();
  if (!requestedProfile) return null;
  const result = await page.evaluate(async (target) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const text = (value) => String(value ?? '').trim();
    const normalize = (value) => text(value).toLowerCase();
    const words = (value) => normalize(value).split(/[^a-z0-9._-]+/).filter(Boolean);
    const profileHaystack = (profile) => [
      profile.id,
      profile.name,
      profile.label,
      profile.model
    ].map((value) => normalize(value)).join(' ');
    const profileId = (profile = {}) => text(profile.id || profile.profileId || profile.name || profile.label || profile.key);
    const profileName = (profile = {}, id = '') => text(profile.name || profile.label || profile.displayName || profile.title || id);
    const profileModel = (profile = {}) => text(profile.model || profile.modelId || profile.model_id || profile.apiModel || profile.completionModel);
    const normalizeProfile = (profile = {}) => {
      const id = profileId(profile);
      if (!id) return null;
      const name = profileName(profile, id);
      const model = profileModel(profile);
      return {
        id,
        name,
        model,
        label: model ? `${name} / ${model}` : name
      };
    };
    const profiles = [];
    try {
      const detected = runtime?.listProviderConnectionProfiles?.() || [];
      profiles.push(...detected.map(normalizeProfile).filter(Boolean));
    } catch {}
    try {
      const service = context.ConnectionManagerRequestService || globalThis.ConnectionManagerRequestService;
      const supported = service?.getSupportedProfiles?.();
      const values = Array.isArray(supported) ? supported : (supported && typeof supported === 'object' ? Object.values(supported) : []);
      profiles.push(...values.map(normalizeProfile).filter(Boolean));
    } catch {}
    try {
      const module = await import('/scripts/extensions/third-party/Recursion/src/hosts/sillytavern/provider-profiles.mjs');
      const detected = module.listSillyTavernConnectionProfiles?.({ context, globals: globalThis }) || [];
      profiles.push(...detected.map(normalizeProfile).filter(Boolean));
    } catch {}
    const byId = new Map();
    for (const profile of profiles) {
      if (!byId.has(profile.id)) byId.set(profile.id, profile);
    }
    const candidates = [...byId.values()];
    const needle = normalize(target);
    const selected = candidates.find((profile) => [
      profile.id,
      profile.name,
      profile.label,
      profile.model
    ].some((value) => normalize(value) === needle))
      || candidates.find((profile) => [
        profile.id,
        profile.name,
        profile.label,
        profile.model
      ].some((value) => normalize(value).includes(needle)))
      || candidates.find((profile) => words(target).every((word) => profileHaystack(profile).includes(word)));
    if (!selected) {
      return {
        ok: false,
        reason: 'profile-not-detected',
        requested: target,
        profiles: candidates.map((profile) => profile.label || profile.id).slice(0, 20)
      };
    }
    if (!runtime || typeof runtime.updateSettings !== 'function' || typeof runtime.updateProvider !== 'function') {
      return {
        ok: false,
        reason: 'runtime-provider-api-unavailable',
        selected
      };
    }
    await runtime.updateSettings({ reasoningLevel: 'high' });
    const providerPatch = {
      enabled: true,
      source: 'host-connection-profile',
      hostConnectionProfileId: selected.id
    };
    await runtime.updateProvider('utility', providerPatch);
    await runtime.updateProvider('reasoner', providerPatch);
    const utilityTest = typeof runtime.testProvider === 'function'
      ? await runtime.testProvider('utility')
      : { ok: false, error: { code: 'testProvider-unavailable' } };
    const reasonerTest = typeof runtime.testProvider === 'function'
      ? await runtime.testProvider('reasoner')
      : { ok: false, error: { code: 'testProvider-unavailable' } };
    const view = runtime.view?.() || {};
    return {
      ok: utilityTest?.ok === true && reasonerTest?.ok === true,
      reason: utilityTest?.ok === true && reasonerTest?.ok === true ? '' : 'provider-test-failed',
      selected,
      utilityTestOk: utilityTest?.ok === true,
      reasonerTestOk: reasonerTest?.ok === true,
      settings: {
        reasoningLevel: view.settings?.reasoningLevel || '',
        utility: view.settings?.providers?.utility || null,
        reasoner: view.settings?.providers?.reasoner || null
      },
      utilityError: utilityTest?.ok === true ? null : (utilityTest?.error || null),
      reasonerError: reasonerTest?.ok === true ? null : (reasonerTest?.error || null)
    };
  }, requestedProfile);
  if (!result?.ok) {
    fail('provider-profile-setup-failed', 'Failed to configure requested SillyTavern connection profile.', result || {});
  }
  await page.waitForFunction((profileId) => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.()?.settings || {};
    return settings.reasoningLevel === 'high'
      && settings.providers?.utility?.source === 'host-connection-profile'
      && settings.providers?.reasoner?.source === 'host-connection-profile'
      && settings.providers?.utility?.hostConnectionProfileId === profileId
      && settings.providers?.reasoner?.hostConnectionProfileId === profileId
      && settings.providers?.utility?.lastTest?.status === 'pass'
      && settings.providers?.reasoner?.lastTest?.status === 'pass';
  }, result.selected.id, { timeout: timeoutMs });
  return result;
}

async function openLastBrief(page, timeoutMs) {
  await dismissBlockingOverlays(page);
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

async function dismissBlockingOverlays(page) {
  await page.evaluate(() => {
    const blockingSelectors = [
      '#directive-preset-update-dialog',
      '.directive-preset-update-dialog-overlay'
    ];
    for (const selector of blockingSelectors) {
      for (const node of document.querySelectorAll(selector)) {
        node.remove();
      }
    }
    const directiveRoot = document.querySelector('#directive-overlay-root');
    if (directiveRoot && !directiveRoot.children.length) directiveRoot.remove();
  }).catch(() => {});
}

function readDomStateScript() {
  return () => {
    const panel = document.querySelector('[data-recursion-hand-dropdown]');
    const runtimeView = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    const freshButton = document.querySelector('[data-recursion-fresh-next-generation]');
    const stopButton = document.querySelector('[data-recursion-stop-generation]');
    return {
      panelText: String(panel?.textContent || '').replace(/\s+/g, ' ').trim(),
      panelState: String(panel?.dataset?.recursionLastBriefState || ''),
      cardRows: document.querySelectorAll('[data-recursion-brief-card]').length,
      freshButtonHidden: freshButton?.hidden === true,
      freshButtonDisabled: freshButton?.disabled === true,
      freshButtonPressed: String(freshButton?.getAttribute('aria-pressed') || ''),
      freshButtonText: String(freshButton?.textContent || '').replace(/\s+/g, ' ').trim(),
      freshButtonAriaLabel: String(freshButton?.getAttribute('aria-label') || ''),
      freshButtonHasRestartIcon: Boolean(freshButton?.querySelector('[data-recursion-fresh-next-generation-icon]')),
      stopButtonHidden: stopButton?.hidden === true,
      stopButtonDisabled: stopButton?.disabled === true,
      currentStepText: String(document.querySelector('[data-recursion-current-step]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      runtimeLastBrief: runtimeView.lastBrief || null,
      freshNextGeneration: runtimeView.freshNextGeneration || null,
      activeRunId: String(runtimeView.activeRunId || ''),
      hostGenerationActive: runtimeView.hostGenerationActive === true,
      progressRun: runtimeView.progressRun || null,
      packetId: String(runtimeView.lastPacket?.packetId || ''),
      packetDiagnostics: runtimeView.lastPacket?.diagnostics || null,
      probe: globalThis.__recursionFreshNextProof?.probe || null
    };
  };
}

async function installGenerationProbe(page, timeoutMs) {
  await page.evaluate(() => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    if (typeof runtime?.prepareForGeneration !== 'function') {
      throw new Error('Recursion runtime prepareForGeneration unavailable');
    }
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    if (!globalThis.__recursionFreshNextProof) globalThis.__recursionFreshNextProof = {};
    const originalPrepareForGeneration = runtime.prepareForGeneration.bind(runtime);
    const originalGenerate = typeof context.generate === 'function'
      ? context.generate.bind(context)
      : null;
    const probe = {
      prepareCalls: [],
      generateCalls: []
    };
    runtime.prepareForGeneration = async (details = {}) => {
      probe.prepareCalls.push({
        hostGeneration: details?.hostGeneration === true,
        hasUserMessage: details?.userMessage !== undefined && details?.userMessage !== null
      });
      return await originalPrepareForGeneration(details);
    };
    if (originalGenerate) {
      context.generate = async (type, options = {}) => {
        probe.generateCalls.push({ type: String(type || ''), options });
        return { ok: true, intercepted: true };
      };
    }
    globalThis.__recursionFreshNextProof.probe = probe;
    globalThis.__recursionFreshNextProof.restoreProbe = () => {
      runtime.prepareForGeneration = originalPrepareForGeneration;
      if (originalGenerate) context.generate = originalGenerate;
    };
  });
  await page.waitForFunction(() => Boolean(globalThis.__recursionFreshNextProof?.probe), null, { timeout: timeoutMs });
}

async function restoreGenerationProbe(page) {
  await page.evaluate(() => {
    globalThis.__recursionFreshNextProof?.restoreProbe?.();
  }).catch(() => {});
}

async function endHostGeneration(page, timeoutMs) {
  await page.evaluate(async () => {
    await globalThis.__recursionLiveHarnessRuntime?.handleHostGenerationEnded?.();
  });
  await page.waitForFunction(() => {
    const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
    return view.hostGenerationActive !== true && !view.activeRunId;
  }, null, { timeout: timeoutMs });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const user = assertPreflight(args, env);
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const runId = createRunId('fresh-next-generation-proof');
  const artifactDir = resolve('artifacts', 'live-fresh-next-generation', runId);
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
    const providerProfileResult = await forceProviderProfile(page, args.providerProfile, timeoutMs);
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
    await page.waitForFunction(() => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      const freshButton = document.querySelector('[data-recursion-fresh-next-generation]');
      const stopButton = document.querySelector('[data-recursion-stop-generation]');
      return view.lastBrief?.status === 'ready'
        && !view.activeRunId
        && view.hostGenerationActive !== true
        && freshButton?.hidden === false
        && freshButton?.disabled !== true
        && stopButton?.hidden === true;
    }, null, { timeout: timeoutMs });
    await openLastBrief(page, timeoutMs);
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      return panel?.hidden === false
        && panel?.dataset?.recursionLastBriefState === 'ready'
        && document.querySelectorAll('[data-recursion-brief-card]').length > 0;
    }, null, { timeout: timeoutMs });
    const readyBefore = await page.evaluate(readDomStateScript());
    if (readyBefore.freshButtonHidden || !readyBefore.stopButtonHidden || !readyBefore.packetId) {
      fail('idle-command-slot-mismatch', 'Fresh-next Regenerate was not visible in the idle bar command slot.', { readyBefore });
    }
    if (!readyBefore.freshButtonHasRestartIcon || readyBefore.freshButtonText || readyBefore.freshButtonAriaLabel !== 'Force next generation fresh') {
      fail('idle-regenerate-icon-mismatch', 'Idle fresh-next command was not an icon-only restart button.', { readyBefore });
    }
    const readyScreenshot = await screenshotPanel(page, artifactDir, '01-ready-before-fresh-next', timeoutMs);

    await installGenerationProbe(page, timeoutMs);
    await dismissBlockingOverlays(page);
    await page.locator('[data-recursion-fresh-next-generation]').first().click({ timeout: timeoutMs });
    await page.waitForFunction(() => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      const stopButton = document.querySelector('[data-recursion-stop-generation]');
      const freshButton = document.querySelector('[data-recursion-fresh-next-generation]');
      const probe = globalThis.__recursionFreshNextProof?.probe;
      return view.freshNextGeneration?.pending === true
        && view.lastBrief?.status === 'ready'
        && panel?.dataset?.recursionLastBriefState === 'ready'
        && document.querySelectorAll('[data-recursion-brief-card]').length > 0
        && !/Next generation will be fresh\./.test(String(panel?.textContent || ''))
        && stopButton?.hidden === true
        && freshButton?.hidden === false
        && freshButton?.getAttribute('aria-pressed') === 'true'
        && Array.isArray(probe?.prepareCalls)
        && probe.prepareCalls.length === 0
        && Array.isArray(probe?.generateCalls)
        && probe.generateCalls.length === 0;
    }, null, { timeout: timeoutMs });
    const armed = await page.evaluate(readDomStateScript());
    if (armed.runtimeLastBrief?.status !== 'ready' || armed.freshNextGeneration?.pending !== true || armed.cardRows <= 0) {
      fail('fresh-not-armed', 'Regenerate click did not arm a fresh-next token.', { armed });
    }
    if (armed.stopButtonHidden !== true || armed.freshButtonHidden || armed.freshButtonPressed !== 'true') {
      fail('fresh-command-slot-mismatch', 'Armed fresh-next state did not keep Regenerate visible and Stop hidden.', { armed });
    }
    if (armed.probe?.prepareCalls?.length || armed.probe?.generateCalls?.length) {
      fail('fresh-click-started-generation', 'Regenerate click started generation instead of arming the next run.', { armed });
    }
    const armedScreenshot = await screenshotPanel(page, artifactDir, '02-armed-fresh-next', timeoutMs);

    const second = await page.evaluate(() => globalThis.__recursionLiveHarnessRuntime.prepareForGeneration({
      userMessage: null,
      hostGeneration: true
    }));
    if (!second?.ok || !second?.packet?.packetId) fail('second-prepare-failed', 'Fresh-next host-generation prepare failed.', { second });
    await page.waitForFunction((oldPacketId) => {
      const view = globalThis.__recursionLiveHarnessRuntime?.view?.() || {};
      const probe = globalThis.__recursionFreshNextProof?.probe;
      const hostPrepareCalls = Array.isArray(probe?.prepareCalls)
        ? probe.prepareCalls.filter((call) => call.hostGeneration === true)
        : [];
      return hostPrepareCalls.length === 1
        && view.freshNextGeneration?.pending === false
        && view.lastBrief?.status === 'ready'
        && view.lastBrief?.reason === 'fresh-next-generation-installed'
        && view.lastPacket?.packetId
        && view.lastPacket.packetId !== oldPacketId;
    }, readyBefore.packetId, { timeout: timeoutMs });
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-recursion-hand-dropdown]');
      return panel?.dataset?.recursionLastBriefState === 'ready'
        && document.querySelectorAll('[data-recursion-brief-card]').length > 0;
    }, null, { timeout: timeoutMs });
    const readyAfter = await page.evaluate(readDomStateScript());
    const hostPrepareCalls = Array.isArray(readyAfter.probe?.prepareCalls)
      ? readyAfter.probe.prepareCalls.filter((call) => call.hostGeneration === true)
      : [];
    if (hostPrepareCalls.length !== 1 || readyAfter.probe?.generateCalls?.length) {
      fail('fresh-generation-count-mismatch', 'Fresh-next run did not consume on exactly one host-generation prepare.', { readyAfter });
    }
    if (readyAfter.packetId === readyBefore.packetId || readyAfter.runtimeLastBrief?.reason !== 'fresh-next-generation-installed') {
      fail('fresh-ready-mismatch', 'Fresh-next run did not restore Last Brief with a fresh packet.', { readyBefore, readyAfter });
    }
    const packetText = JSON.stringify(readyAfter.packetDiagnostics || {});
    if (!packetText.includes('fresh-next-generation:cache-bypassed')) {
      fail('fresh-diagnostics-missing', 'Fresh-next packet did not record cache-bypass diagnostics.', { packetDiagnostics: readyAfter.packetDiagnostics });
    }
    const readyAfterScreenshot = await screenshotPanel(page, artifactDir, '03-ready-after-fresh-next', timeoutMs);

    await endHostGeneration(page, timeoutMs);
    const stoppedAfter = await page.evaluate(readDomStateScript());

    console.log(JSON.stringify({
      status: 'pass',
      result: 'live-fresh-next-generation-pass',
      user,
      runId,
      providerProfile: providerProfileResult?.selected || null,
      first: { ok: first.ok === true, packetId: readyBefore.packetId },
      second: {
        packetId: readyAfter.packetId,
        hostGenerationPrepareCalls: hostPrepareCalls.length,
        nativeGenerateCalls: readyAfter.probe?.generateCalls?.length || 0
      },
      armed: {
        state: armed.panelState,
        reason: armed.runtimeLastBrief?.reason || '',
        buttonPressed: armed.freshButtonPressed,
        stopVisible: armed.stopButtonHidden === false,
        prepareCalls: armed.probe?.prepareCalls?.length || 0
      },
      readyAfter: {
        state: readyAfter.panelState,
        reason: readyAfter.runtimeLastBrief?.reason || '',
        cards: readyAfter.cardRows
      },
      stoppedAfter: {
        hostGenerationActive: stoppedAfter.hostGenerationActive
      },
      screenshots: {
        readyBefore: readyScreenshot,
        armed: armedScreenshot,
        readyAfter: readyAfterScreenshot
      }
    }, null, 2));
  } finally {
    if (page) await restoreGenerationProbe(page).catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'fail',
    result: error.result || 'live-fresh-next-generation-error',
    error: error.message,
    details: error.details || null
  }, null, 2));
  process.exit(1);
});
