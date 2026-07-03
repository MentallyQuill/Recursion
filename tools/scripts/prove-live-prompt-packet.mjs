import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import {
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

const DEFAULT_TIMEOUT_MS = 180000;
const PIPELINES = new Set(['standard', 'rapid']);

function parseArgs(argv = []) {
  const args = { live: false, pipeline: 'standard' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') args.live = true;
    else if (arg === '--pipeline') {
      args.pipeline = String(argv[index + 1] || '').trim().toLowerCase() || args.pipeline;
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
  if (!PIPELINES.has(args.pipeline)) fail('invalid-pipeline', 'Use --pipeline standard or --pipeline rapid.', { pipeline: args.pipeline });
  if (!env.SILLYTAVERN_BASE_URL) fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  const user = String(env.RECURSION_SILLYTAVERN_USER || '').trim();
  const userResult = validateSoakUserHandle(user);
  if (!userResult.ok) {
    fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', {
      user,
      reason: userResult.reason
    });
  }
  return userResult.user;
}

async function waitForRoot(page, timeoutMs) {
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-pipeline-button]', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-mode-button]', { timeout: timeoutMs });
}

async function setPower(page, enabled, timeoutMs) {
  const button = page.locator('[data-recursion-power-toggle]').first();
  await button.waitFor({ timeout: timeoutMs });
  const pressed = async () => (await button.getAttribute('aria-pressed').catch(() => 'true')) !== 'false';
  if (await pressed() !== enabled) await button.click({ timeout: timeoutMs });
  await page.waitForFunction((expected) => {
    const node = document.querySelector('[data-recursion-power-toggle]');
    return Boolean(node) && ((node.getAttribute('aria-pressed') !== 'false') === expected);
  }, enabled, { timeout: timeoutMs });
}

async function selectPipeline(page, pipeline, timeoutMs) {
  const button = page.locator('[data-recursion-pipeline-button]').first();
  await button.click({ timeout: timeoutMs });
  await page.locator(`[data-recursion-pipeline-choice="${pipeline}"], [data-recursion-pipeline-choice-${pipeline}]`).first().click({ timeout: timeoutMs });
  await page.waitForFunction((expected) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const settings = context?.extensionSettings?.recursion || globalThis.extension_settings?.recursion || {};
    return String(settings.pipelineMode || '') === expected;
  }, pipeline, { timeout: timeoutMs });
}

async function selectMode(page, mode, timeoutMs) {
  const text = await page.evaluate(() => String(document.querySelector('[data-recursion-mode]')?.textContent || '').toLowerCase()).catch(() => '');
  if (!text.includes(mode)) {
    const button = page.locator('[data-recursion-mode-button]').first();
    await button.click({ timeout: timeoutMs });
    await page.locator(`[data-recursion-mode-choice="${mode}"], [data-recursion-mode-choice-${mode}]`).first().click({ timeout: timeoutMs });
  }
  await page.waitForFunction((expected) => {
    return String(document.querySelector('[data-recursion-mode]')?.textContent || '').toLowerCase().includes(expected);
  }, mode, { timeout: timeoutMs });
}

function installRawPromptRecorderScript() {
  return () => {
    const events = [];
    globalThis.__recursionPromptPacketProofEvents = events;
    const install = (context) => {
      if (!context || typeof context.setExtensionPrompt !== 'function') return false;
      if (context.__recursionPromptPacketProofInstalled) return true;
      const original = context.setExtensionPrompt.bind(context);
      context.__recursionPromptPacketProofOriginal = original;
      context.setExtensionPrompt = (...args) => {
        const key = String(args[0] || '');
        const text = String(args[1] || '');
        if (key.startsWith('recursion.')) {
          events.push({
            key,
            text,
            textLength: text.length,
            cleared: text.length === 0,
            position: String(args[2] || ''),
            depth: Number(args[3] || 0),
            role: String(args[5] || '')
          });
        }
        return original(...args);
      };
      context.__recursionPromptPacketProofInstalled = true;
      return true;
    };
    const current = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
    install(current);
    const wrap = (owner, key) => {
      if (!owner || typeof owner[key] !== 'function' || owner[`__recursionPromptPacketProofOriginal${key}`]) return;
      const original = owner[key].bind(owner);
      owner[`__recursionPromptPacketProofOriginal${key}`] = original;
      owner[key] = (...args) => {
        const context = original(...args);
        install(context);
        return context;
      };
    };
    wrap(globalThis.SillyTavern, 'getContext');
    wrap(globalThis, 'getContext');
    return install(current);
  };
}

function directPrepareScript() {
  return (message) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || null;
    if (!context) throw new Error('SillyTavern context unavailable');
    const chat = Array.isArray(context.chat) ? context.chat.slice() : [];
    chat.push({
      mesid: chat.length,
      is_user: true,
      name: 'Recursion Prompt Packet Proof',
      mes: String(message || '')
    });
    if (typeof globalThis.recursionGenerationInterceptor !== 'function') {
      throw new Error('recursionGenerationInterceptor unavailable');
    }
    return globalThis.recursionGenerationInterceptor(chat);
  };
}

function readProofStateScript() {
  return () => {
    const events = Array.isArray(globalThis.__recursionPromptPacketProofEvents)
      ? globalThis.__recursionPromptPacketProofEvents.slice()
      : [];
    const installed = events.filter((event) => event && event.cleared === false);
    const cleared = events.filter((event) => event && event.cleared === true);
    const byKey = Object.fromEntries(installed.map((event) => [event.key, event]));
    const packetText = String(document.querySelector('[data-recursion-prompt-packet]')?.textContent || '').trim();
    let packet = null;
    try {
      packet = packetText ? JSON.parse(packetText) : null;
    } catch {
      packet = null;
    }
    return {
      events,
      installedKeys: [...new Set(installed.map((event) => event.key))],
      clearedKeys: [...new Set(cleared.map((event) => event.key))],
      guidance: byKey['recursion.guidance']?.text || '',
      cardEvidence: byKey['recursion.cardEvidence']?.text || '',
      guardrails: byKey['recursion.guardrails']?.text || '',
      packet: packet ? {
        packetId: String(packet.packetId || ''),
        handId: String(packet.handId || ''),
        selectedCardRefs: Array.isArray(packet.selectedCardRefs) ? packet.selectedCardRefs : [],
        diagnostics: packet.diagnostics || {},
        pipelineMode: String(packet.pipelineMode || '')
      } : null,
      handText: String(document.querySelector('[data-recursion-hand-count]')?.textContent || ''),
      statusText: String(document.querySelector('[data-recursion-status]')?.textContent || ''),
      ribbonText: String(document.querySelector('[data-recursion-ribbon-label]')?.textContent || '')
    };
  };
}

async function warmRapidDeck(page, timeoutMs) {
  await page.evaluate(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    if (Array.isArray(context.chat)) {
      context.chat.push({
        mesid: context.chat.length,
        is_user: false,
        name: 'Recursion Prompt Packet Proof',
        mes: `Recursion rapid warm proof assistant marker ${Date.now().toString(36)}.`
      });
    }
    const eventSource = context.eventSource || globalThis.eventSource;
    const payload = { source: 'recursion-prompt-packet-proof-rapid-warm' };
    if (typeof eventSource?.emit === 'function') eventSource.emit('generation_ended', payload);
    else if (typeof eventSource?.trigger === 'function') eventSource.trigger('generation_ended', payload);
    else if (typeof eventSource?.dispatchEvent === 'function') eventSource.dispatchEvent(new CustomEvent('generation_ended', { detail: payload }));
    else throw new Error('generation_ended event source unavailable');
  });
  await page.waitForFunction(() => {
    const text = [
      String(document.querySelector('[data-recursion-current-step]')?.textContent || ''),
      String(document.querySelector('[data-recursion-ribbon-label]')?.textContent || ''),
      String(document.querySelector('#recursion-root')?.textContent || '')
    ].join(' ');
    if (/Rapid deck stale\./i.test(text)) throw new Error('Rapid deck stale.');
    return /Rapid deck ready\./i.test(text);
  }, null, { timeout: timeoutMs });
}

async function emitGenerationStopped(page, timeoutMs) {
  await page.evaluate(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const eventSource = context.eventSource || globalThis.eventSource;
    const payload = { source: 'recursion-prompt-packet-proof' };
    if (typeof eventSource?.emit === 'function') eventSource.emit('generation_stopped', payload);
    else if (typeof eventSource?.trigger === 'function') eventSource.trigger('generation_stopped', payload);
    else if (typeof eventSource?.dispatchEvent === 'function') eventSource.dispatchEvent(new CustomEvent('generation_stopped', { detail: payload }));
    else throw new Error('generation_stopped event source unavailable');
  });
  await page.waitForFunction(() => {
    const events = Array.isArray(globalThis.__recursionPromptPacketProofEvents)
      ? globalThis.__recursionPromptPacketProofEvents
      : [];
    return ['recursion.guidance', 'recursion.cardEvidence', 'recursion.guardrails']
      .every((key) => events.some((event) => event.key === key && event.cleared === true));
  }, null, { timeout: timeoutMs });
}

function assertPacketState(state, { afterStop = false, pipeline = 'standard' } = {}) {
  const requiredKeys = ['recursion.guidance', 'recursion.cardEvidence', 'recursion.guardrails'];
  for (const key of requiredKeys) {
    if (!state.installedKeys.includes(key)) fail('prompt-key-missing', `Missing installed prompt key ${key}.`, { state });
  }
  if (!state.packet?.packetId || !state.packet?.handId || !state.packet.selectedCardRefs.length) {
    fail('prompt-packet-metadata-missing', 'Prompt packet metadata was not visible.', { state });
  }
  const diagnostics = state.packet?.diagnostics || {};
  if (pipeline === 'rapid') {
    if (diagnostics.pipelineMode !== 'rapid' || diagnostics.rapidPath !== 'warm-v2') {
      fail('rapid-warm-v2-missing', 'Rapid packet did not expose warm-v2 diagnostics.', { diagnostics, state });
    }
  } else if (diagnostics.pipelineMode && diagnostics.pipelineMode !== 'standard') {
    fail('standard-pipeline-diagnostics-mismatch', 'Standard packet diagnostics did not report standard pipeline.', { diagnostics, state });
  }
  if (!/Private Recursion guidance for the next assistant message\./.test(state.guidance)) {
    fail('guidance-framing-missing', 'Guidance block did not include private response framing.', { guidance: state.guidance });
  }
  if (!/Write the next reply as normal story prose\/dialogue\./.test(state.guidance)) {
    fail('guidance-output-shape-missing', 'Guidance block did not instruct normal story output.', { guidance: state.guidance });
  }
  if (!/Private Recursion card evidence for the next assistant message\./.test(state.cardEvidence)) {
    fail('card-evidence-framing-missing', 'Card evidence block did not include private response framing.', { cardEvidence: state.cardEvidence });
  }
  if (!/Use these cards silently as evidence\./.test(state.cardEvidence)) {
    fail('card-evidence-silent-use-missing', 'Card evidence block did not instruct silent use.', { cardEvidence: state.cardEvidence });
  }
  if (!/- \[[^\]]+\] .{20,}/.test(state.cardEvidence)) {
    fail('raw-card-evidence-missing', 'Card evidence block did not include raw selected card text.', { cardEvidence: state.cardEvidence });
  }
  if (!/Write only the next assistant message; keep Recursion cards, labels, and guidance invisible\./.test(state.guardrails)) {
    fail('guardrail-output-boundary-missing', 'Guardrails did not keep Recursion internals out of output.', { guardrails: state.guardrails });
  }
  const serialized = `${state.guidance}\n${state.cardEvidence}\n${state.guardrails}`;
  if (/Scene brief:|Turn brief:|conditionedSceneBrief|rapidFastStartPack/.test(serialized)) {
    fail('legacy-brief-text-leaked', 'Legacy brief or fast-start text leaked into prompt blocks.', { serialized });
  }
  if (afterStop) {
    for (const key of requiredKeys) {
      if (!state.clearedKeys.includes(key)) fail('prompt-clear-missing', `Prompt key ${key} was not cleared after generation stop.`, { state });
    }
    if (!/\bHand\s+[1-9]\d*/i.test(state.handText)) {
      fail('last-brief-lost-after-stop', 'Last Brief hand was not preserved after generation stop.', { state });
    }
  }
}

export async function runLivePromptPacketProof({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  const user = assertPreflight(args, env);
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const headless = env.RECURSION_SILLYTAVERN_HEADLESS !== '0';
  const session = createSillyTavernHttpSession({
    baseUrl: env.SILLYTAVERN_BASE_URL,
    user,
    password: passwordForUser(user, env)
  });
  await session.init();
  await session.login();
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext();
    await context.addCookies(session.playwrightCookies());
    const page = await context.newPage();
    await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForRoot(page, timeoutMs);
    await page.evaluate(installRawPromptRecorderScript());
    await setPower(page, true, timeoutMs);
    await selectPipeline(page, args.pipeline, timeoutMs);
    await selectMode(page, 'auto', timeoutMs);
    if (args.pipeline === 'rapid') await warmRapidDeck(page, timeoutMs);
    const message = `Recursion ${args.pipeline} prompt packet proof ${Date.now().toString(36)}: keep the archive door scene coherent.`;
    await page.evaluate(directPrepareScript(), message);
    await page.waitForFunction(() => {
      const state = (() => {
        const events = Array.isArray(globalThis.__recursionPromptPacketProofEvents)
          ? globalThis.__recursionPromptPacketProofEvents
          : [];
        const keys = new Set(events.filter((event) => event.cleared === false).map((event) => event.key));
        const packetText = String(document.querySelector('[data-recursion-prompt-packet]')?.textContent || '').trim();
        let packet = null;
        try {
          packet = packetText ? JSON.parse(packetText) : null;
        } catch {
          packet = null;
        }
        return { keys, packet };
      })();
      return ['recursion.guidance', 'recursion.cardEvidence', 'recursion.guardrails'].every((key) => state.keys.has(key))
        && Boolean(state.packet?.packetId && state.packet?.handId && Array.isArray(state.packet?.selectedCardRefs) && state.packet.selectedCardRefs.length);
    }, null, { timeout: timeoutMs });
    const beforeStop = await page.evaluate(readProofStateScript());
    assertPacketState(beforeStop, { pipeline: args.pipeline });
    await emitGenerationStopped(page, timeoutMs);
    const afterStop = await page.evaluate(readProofStateScript());
    assertPacketState(afterStop, { afterStop: true, pipeline: args.pipeline });
    return {
      status: 'pass',
      result: 'live-prompt-packet-proof-pass',
      pipeline: args.pipeline,
      user,
      packetId: beforeStop.packet.packetId,
      selectedCardCount: beforeStop.packet.selectedCardRefs.length,
      installedKeys: beforeStop.installedKeys,
      clearedKeys: afterStop.clearedKeys,
      textLengths: {
        guidance: beforeStop.guidance.length,
        cardEvidence: beforeStop.cardEvidence.length,
        guardrails: beforeStop.guardrails.length
      },
      diagnostics: beforeStop.packet.diagnostics
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runLivePromptPacketProof();
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      status: error?.result === 'dry-run' ? 'skipped' : 'fail',
      result: error?.result || 'live-prompt-packet-proof-failed',
      error: String(error?.message || error),
      details: error?.details || null
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'skipped' ? 0 : 1;
  }
}
