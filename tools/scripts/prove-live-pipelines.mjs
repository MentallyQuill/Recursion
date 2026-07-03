import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import {
  createSillyTavernHttpSession,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

const PIPELINES = new Set(['standard', 'rapid']);
const DEFAULT_TIMEOUT_MS = 120000;

function parseArgs(argv = []) {
  const args = {
    live: false,
    pipelines: ['standard', 'rapid']
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') {
      args.live = true;
    } else if (arg === '--pipeline') {
      const value = String(argv[index + 1] || '').trim().toLowerCase();
      index += 1;
      args.pipelines = value ? [value] : args.pipelines;
    } else if (arg === '--pipelines') {
      const value = String(argv[index + 1] || '');
      index += 1;
      args.pipelines = value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    }
  }
  return args;
}

function passwordEnvKey(user) {
  return `RECURSION_SILLYTAVERN_PASSWORD_${String(user).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function passwordForUser(user, env) {
  return env[passwordEnvKey(user)] ?? env.RECURSION_SILLYTAVERN_PASSWORD ?? '';
}

function fail(result, message, details = {}) {
  const error = new Error(message);
  error.result = result;
  error.details = details;
  throw error;
}

function assertPreflight(args, env) {
  if (!args.live) fail('dry-run', 'Pass --live to mutate a dedicated SillyTavern user.');
  if (!env.SILLYTAVERN_BASE_URL) fail('missing-base-url', 'SILLYTAVERN_BASE_URL is required.');
  const user = String(env.RECURSION_SILLYTAVERN_USER || '').trim();
  const userResult = validateSoakUserHandle(user);
  if (!userResult.ok) fail('unsafe-user', 'RECURSION_SILLYTAVERN_USER must be a dedicated recursion-soak-* user.', { user, reason: userResult.reason });
  for (const pipeline of args.pipelines) {
    if (!PIPELINES.has(pipeline)) fail('invalid-pipeline', `Unknown pipeline "${pipeline}". Use standard, rapid, or both.`);
  }
  return userResult.user;
}

function contextChatSummaryScript() {
  return () => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const chat = Array.isArray(context.chat) ? context.chat : [];
    return {
      length: chat.length,
      assistantCount: chat.filter((message) => message && message.is_user === false).length,
      userCount: chat.filter((message) => message && message.is_user === true).length,
      lastIsUser: chat.length ? chat[chat.length - 1]?.is_user === true : null,
      chatId: String(context.chatId || context.currentChatId || '')
    };
  };
}

function liveSnapshotScript() {
  return () => {
    const text = (selector) => String(document.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
    const attr = (selector, name) => String(document.querySelector(selector)?.getAttribute(name) || '');
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const value = node.getBoundingClientRect();
      return {
        left: Math.round(value.left),
        right: Math.round(value.right),
        top: Math.round(value.top),
        bottom: Math.round(value.bottom),
        width: Math.round(value.width),
        height: Math.round(value.height)
      };
    };
    let packet = null;
    try {
      const raw = String(document.querySelector('[data-recursion-prompt-packet]')?.textContent || '').trim();
      packet = raw ? JSON.parse(raw) : null;
    } catch {
      packet = null;
    }
    let promptPacketPreview = null;
    try {
      const raw = String(document.querySelector('[data-recursion-viewer] [data-recursion-prompt-packet]')?.textContent || '').trim();
      promptPacketPreview = raw ? JSON.parse(raw) : null;
    } catch {
      promptPacketPreview = null;
    }
    return {
      rootMounted: Boolean(document.querySelector('#recursion-root')),
      settingsPipelineMode: String((globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {})?.extensionSettings?.recursion?.pipelineMode || globalThis.extension_settings?.recursion?.pipelineMode || ''),
      powerPressed: attr('[data-recursion-power-toggle]', 'aria-pressed') !== 'false',
      statusText: text('[data-recursion-status]'),
      modeText: text('[data-recursion-mode]'),
      pipelineButtonLabel: attr('[data-recursion-pipeline-button]', 'aria-label'),
      modeButtonLabel: attr('[data-recursion-mode-button]', 'aria-label'),
      pipelineButtonRect: rect('[data-recursion-pipeline-button]'),
      modeButtonRect: rect('[data-recursion-mode-button]'),
      settingsPipelineControls: document.querySelectorAll('[data-recursion-setting-pipeline], [data-recursion-settings-panel] [name*="pipeline" i], [data-recursion-settings-panel] [id*="pipeline" i]').length,
      ribbonText: text('[data-recursion-ribbon-label]'),
      handText: text('[data-recursion-hand-count]'),
      packet,
      promptPacketPreview,
      bodyIssueText: /recursion\s+(skipped|failed)|\b(skip|skipped|failed|failure|warning|caution)\b/i.test(text('#recursion-root'))
    };
  };
}

async function waitForRoot(page, timeoutMs) {
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-pipeline-button]', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-mode-button]', { timeout: timeoutMs });
}

async function setPower(page, enabled, timeoutMs) {
  const selector = '[data-recursion-power-toggle]';
  const button = page.locator(selector).first();
  await button.waitFor({ timeout: timeoutMs });
  const pressed = async () => (await button.getAttribute('aria-pressed').catch(() => 'true')) !== 'false';
  if (await pressed() !== enabled) {
    await button.click({ timeout: timeoutMs });
  }
  await page.waitForFunction((expected) => {
    const node = document.querySelector('[data-recursion-power-toggle]');
    return Boolean(node) && ((node.getAttribute('aria-pressed') !== 'false') === expected);
  }, enabled, { timeout: timeoutMs });
}

async function selectMode(page, mode, timeoutMs) {
  const currentMode = await page.evaluate(() => String(document.querySelector('[data-recursion-mode]')?.textContent || '').toLowerCase()).catch(() => '');
  if (currentMode.includes(mode)) return;
  const modeButton = page.locator('[data-recursion-mode-button]').first();
  await modeButton.click({ timeout: timeoutMs });
  await page.locator(`[data-recursion-mode-choice="${mode}"], [data-recursion-mode-choice-${mode}]`).first().click({ timeout: timeoutMs });
  await page.waitForFunction((expected) => {
    const text = String(document.querySelector('[data-recursion-mode]')?.textContent || '').toLowerCase();
    return text.includes(expected);
  }, mode, { timeout: timeoutMs });
}

async function selectPipeline(page, pipeline, timeoutMs) {
  const pipelineButton = page.locator('[data-recursion-pipeline-button]').first();
  await pipelineButton.click({ timeout: timeoutMs });
  await page.locator(`[data-recursion-pipeline-choice="${pipeline}"], [data-recursion-pipeline-choice-${pipeline}]`).first().click({ timeout: timeoutMs });
  const expectedLabel = pipeline === 'rapid' ? 'Rapid Pipeline' : 'Standard Pipeline';
  await page.waitForFunction((expected) => {
    const button = document.querySelector('[data-recursion-pipeline-button]');
    return String(button?.getAttribute('aria-label') || '').includes(expected);
  }, expectedLabel, { timeout: timeoutMs });
  await page.waitForFunction((expected) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const settings = context?.extensionSettings?.recursion || globalThis.extension_settings?.recursion || {};
    return String(settings.pipelineMode || '') === expected;
  }, pipeline, { timeout: timeoutMs });
}

async function findSendSurface(page, timeoutMs) {
  const inputSelectors = [
    '#send_textarea',
    'textarea#send_textarea',
    'textarea[name="send_textarea"]',
    '[contenteditable="true"]#send_textarea'
  ];
  const buttonSelectors = [
    '#send_but',
    'button#send_but'
  ];
  let input = null;
  for (const selector of inputSelectors) {
    const candidate = page.locator(selector).first();
    if (await candidate.count().catch(() => 0)) {
      await candidate.waitFor({ timeout: Math.min(timeoutMs, 10000) }).catch(() => {});
      if (await candidate.isVisible().catch(() => false)) {
        input = candidate;
        break;
      }
    }
  }
  let button = null;
  for (const selector of buttonSelectors) {
    const candidate = page.locator(selector).first();
    if (await candidate.count().catch(() => 0)) {
      await candidate.waitFor({ timeout: Math.min(timeoutMs, 10000) }).catch(() => {});
      if (await candidate.isVisible().catch(() => false)) {
        button = candidate;
        break;
      }
    }
  }
  if (!input || !button) fail('visible-send-unavailable', 'Visible SillyTavern send controls were not available.');
  return { input, button };
}

async function fillSendInput(input, text, timeoutMs) {
  await input.click({ timeout: timeoutMs });
  const filled = await input.fill(text, { timeout: Math.min(timeoutMs, 10000) }).then(() => true).catch(() => false);
  if (filled) return;
  await input.evaluate((node, value) => {
    node.focus?.();
    if ('value' in node) {
      node.value = value;
    } else {
      node.textContent = value;
    }
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
}

async function sendAndWait(page, message, { requirePrompt, timeoutMs }) {
  const before = await page.evaluate(contextChatSummaryScript());
  const surface = await findSendSurface(page, timeoutMs);
  await fillSendInput(surface.input, message, timeoutMs);
  await surface.button.click({ timeout: timeoutMs });
  await page.waitForFunction((input) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const userIndex = chat.findIndex((entry) => {
      const text = String(entry?.mes || entry?.message || entry?.text || '');
      return entry && entry.is_user === true && text.includes(input.message);
    });
    const assistantObserved = userIndex >= 0 && chat.slice(userIndex + 1).some((entry) => entry && entry.is_user === false);
    const promptInstalled = Array.isArray(globalThis.__recursionSmokePromptEvents)
      ? globalThis.__recursionSmokePromptEvents.some((entry) => entry && entry.cleared === false && String(entry.key || '').startsWith('recursion.'))
      : true;
    return userIndex >= 0
      && assistantObserved
      && (!input.requirePrompt || promptInstalled || Boolean(document.querySelector('[data-recursion-hand-count]')?.textContent || '').match(/\bHand\s+[1-9]\d*/i));
  }, { message, requirePrompt }, { timeout: timeoutMs });
  const after = await page.evaluate(contextChatSummaryScript());
  const messageProof = await page.evaluate((expected) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const userIndex = chat.findIndex((entry) => {
      const text = String(entry?.mes || entry?.message || entry?.text || '');
      return entry && entry.is_user === true && text.includes(expected);
    });
    return {
      message: expected,
      userIndex,
      assistantAfter: userIndex >= 0 && chat.slice(userIndex + 1).some((entry) => entry && entry.is_user === false),
      chatId: String(context.chatId || context.currentChatId || '')
    };
  }, message);
  return { before, after, messageProof };
}

async function triggerRapidWarm(page, timeoutMs) {
  const emitted = await page.evaluate(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const eventSource = context.eventSource || globalThis.eventSource;
    if (!eventSource) return false;
    const payload = { source: 'recursion-live-pipeline-proof' };
    if (typeof eventSource.emit === 'function') {
      eventSource.emit('generation_ended', payload);
      return true;
    }
    if (typeof eventSource.trigger === 'function') {
      eventSource.trigger('generation_ended', payload);
      return true;
    }
    if (typeof eventSource.dispatchEvent === 'function') {
      eventSource.dispatchEvent(new CustomEvent('generation_ended', { detail: payload }));
      return true;
    }
    return false;
  });
  if (!emitted) fail('rapid-warm-event-unavailable', 'Unable to emit host generation-ended event for Rapid warm proof.');
  await page.waitForFunction(() => {
    const text = String(document.querySelector('[data-recursion-current-step]')?.textContent || '')
      || String(document.querySelector('#recursion-root')?.textContent || '');
    return /Rapid deck ready\./i.test(text);
  }, null, { timeout: timeoutMs });
}

async function openViewer(page, timeoutMs) {
  const actions = page.locator('[data-recursion-actions]').first();
  if (await actions.count().catch(() => 0)) {
    await actions.click({ timeout: timeoutMs }).catch(() => {});
  }
  const viewerToggle = page.locator('[data-recursion-viewer-toggle]').first();
  if (await viewerToggle.count().catch(() => 0)) {
    await viewerToggle.click({ timeout: timeoutMs }).catch(() => {});
  } else {
    await page.evaluate(() => document.querySelector('[data-recursion-viewer-toggle]')?.click?.()).catch(() => {});
  }
  await page.waitForFunction(() => {
    const viewer = document.querySelector('[data-recursion-viewer]');
    return Boolean(viewer && (viewer.open || viewer.hidden === false));
  }, null, { timeout: Math.min(timeoutMs, 10000) }).catch(() => {});
}

async function exportDiagnosticsSnapshot(page, timeoutMs) {
  await page.evaluate(() => {
    globalThis.__recursionProofClipboard = '';
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard && clipboard.__recursionProofPatched !== true) {
      const original = typeof clipboard.writeText === 'function' ? clipboard.writeText.bind(clipboard) : null;
      clipboard.writeText = async (text) => {
        globalThis.__recursionProofClipboard = String(text || '');
        if (original) {
          try {
            await original(text);
          } catch {
            // Capturing the diagnostics text is sufficient for live proof.
          }
        }
      };
      clipboard.__recursionProofPatched = true;
    }
    document.querySelector('[data-recursion-export-diagnostics]')?.click?.();
  }).catch(() => {});
  const raw = await page.waitForFunction(() => globalThis.__recursionProofClipboard || '', null, {
    timeout: Math.min(timeoutMs, 10000)
  }).then((handle) => handle.jsonValue()).catch(() => '');
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return { parseError: true, raw: String(raw || '').slice(0, 500) };
  }
}

function compactIssue(message) {
  return {
    type: message.type,
    text: String(message.text || '').slice(0, 500),
    url: String(message.url || '').slice(0, 300)
  };
}

function assertPipelineProof(pipeline, proof, issues) {
  const snapshot = proof.snapshot || {};
  if (!snapshot.rootMounted) fail(`${pipeline}-root-missing`, 'Recursion root was not mounted.', { snapshot });
  if (!snapshot.powerPressed) fail(`${pipeline}-power-off`, 'Recursion was not enabled for pipeline proof.', { snapshot });
  const expectedLabel = pipeline === 'rapid' ? 'Rapid Pipeline' : 'Standard Pipeline';
  if (!String(snapshot.pipelineButtonLabel || '').includes(expectedLabel)) {
    fail(`${pipeline}-pipeline-not-selected`, 'Pipeline button did not expose the expected selected pipeline.', { expectedLabel, snapshot });
  }
  if (!String(snapshot.modeText || '').toLowerCase().includes('auto')) {
    fail(`${pipeline}-mode-not-auto`, 'Mode button did not expose Auto mode.', { snapshot });
  }
  const pipelineRect = snapshot.pipelineButtonRect;
  const modeRect = snapshot.modeButtonRect;
  if (!pipelineRect || !modeRect || pipelineRect.left >= modeRect.left) {
    fail(`${pipeline}-pipeline-position`, 'Pipeline button was not to the left of the Mode button.', { snapshot });
  }
  if (snapshot.settingsPipelineControls !== 0) {
    fail(`${pipeline}-settings-toggle-found`, 'Pipeline controls appeared in settings instead of only the compact bar.', { snapshot });
  }
  if (proof.send?.messageProof?.userIndex < 0) {
    fail(`${pipeline}-user-message-not-observed`, 'Visible send did not leave the proof user message in the active chat.', { proof });
  }
  if (proof.send?.messageProof?.assistantAfter !== true) {
    fail(`${pipeline}-assistant-not-observed`, 'Visible send did not observe an assistant message after the proof user message.', { proof });
  }
  const rapidPacketDiagnostics = snapshot.packet?.diagnostics || snapshot.promptPacketPreview?.diagnostics || {};
  const rapidPacketReady = pipeline === 'rapid'
    && rapidPacketDiagnostics.pipelineMode === 'rapid'
    && Boolean(snapshot.packet?.packetId || snapshot.promptPacketPreview?.packetId)
    && (Array.isArray(snapshot.packet?.injectedBlocks) ? snapshot.packet.injectedBlocks.length > 0 : true);
  if (!rapidPacketReady && !/\bHand\s+[1-9]\d*/i.test(String(snapshot.handText || ''))) {
    fail(`${pipeline}-hand-not-ready`, 'Recursion did not expose a ready hand after generation.', { snapshot, diagnosticsExport: proof.diagnosticsExport });
  }
  if (pipeline === 'rapid') {
    const diagnostics = rapidPacketDiagnostics;
    if (diagnostics.pipelineMode !== 'rapid') {
      fail(`${pipeline}-diagnostics-missing`, 'Rapid proof did not expose Rapid packet diagnostics.', { snapshot, diagnosticsExport: proof.diagnosticsExport });
    }
    if (diagnostics.rapidPath !== 'warm-v2') {
      fail(`${pipeline}-path-missing`, 'Rapid proof did not expose a valid Rapid foreground path.', { snapshot, diagnosticsExport: proof.diagnosticsExport });
    }
  }
  if (/skipped|failed|failure|warning|caution/i.test(String(snapshot.ribbonText || ''))) {
    fail(`${pipeline}-visible-warning`, 'Recursion ribbon exposed skip/fail/warning/caution text.', { snapshot });
  }
  if (issues.console.length || issues.page.length) {
    fail(`${pipeline}-browser-issues`, 'Browser console/page issues were observed during pipeline proof.', issues);
  }
}

function proofMessageFor(pipeline, runId) {
  return [
    `Recursion ${pipeline} pipeline proof ${runId}:`,
    'I push open the rain-soaked archive door with my shoulder, keep the candle low,',
    'and ask Mara what she remembers about the missing captain before the guards hear us.'
  ].join(' ');
}

async function provePipeline(page, pipeline, timeoutMs, runId) {
  let phase = 'power-on';
  try {
    await setPower(page, true, timeoutMs);
    phase = 'pipeline-select';
    await selectPipeline(page, pipeline, timeoutMs);
    phase = 'mode-select';
    await selectMode(page, 'auto', timeoutMs);
    let primer = null;
    if (pipeline === 'rapid') {
      phase = 'rapid-primer-send';
      primer = await sendAndWait(page, proofMessageFor('rapid warm primer', runId), {
        requirePrompt: true,
        timeoutMs
      });
      phase = 'rapid-warm';
      await triggerRapidWarm(page, timeoutMs);
    }
    phase = 'pipeline-send';
    const send = await sendAndWait(page, proofMessageFor(pipeline, runId), {
      requirePrompt: true,
      timeoutMs
    });
    phase = 'viewer-open';
    await openViewer(page, timeoutMs);
    phase = 'diagnostics-export';
    const diagnosticsExport = await exportDiagnosticsSnapshot(page, timeoutMs);
    phase = 'snapshot';
    const snapshot = await page.evaluate(liveSnapshotScript());
    return { pipeline, primer, send, snapshot, diagnosticsExport };
  } catch (error) {
    const snapshot = await page.evaluate(liveSnapshotScript()).catch(() => null);
    const chat = await page.evaluate(contextChatSummaryScript()).catch(() => null);
    error.result = error.result || `${pipeline}-${phase}-failed`;
    error.details = {
      ...(error.details || {}),
      pipeline,
      phase,
      snapshot,
      chat
    };
    throw error;
  }
}

export async function runLivePipelineProof({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  const user = assertPreflight(args, env);
  const timeoutMs = Number(env.RECURSION_LIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const headless = env.RECURSION_SILLYTAVERN_HEADLESS !== '0';
  const runId = `pipeline-${Date.now().toString(36)}`;
  const session = createSillyTavernHttpSession({
    baseUrl: env.SILLYTAVERN_BASE_URL,
    user,
    password: passwordForUser(user, env)
  });
  await session.init();
  await session.login();

  const browser = await chromium.launch({ headless });
  const consoleIssues = [];
  const pageIssues = [];
  const proofs = [];
  try {
    const context = await browser.newContext();
    await context.addCookies(session.playwrightCookies());
    const page = await context.newPage();
    page.on('console', (message) => {
      if (['warning', 'error'].includes(message.type())) {
        consoleIssues.push(compactIssue({ type: message.type(), text: message.text(), url: message.location()?.url }));
      }
    });
    page.on('pageerror', (error) => {
      pageIssues.push({ message: String(error?.message || error).slice(0, 500) });
    });
    await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForRoot(page, timeoutMs);
    for (const pipeline of args.pipelines) {
      const issueStart = { console: consoleIssues.length, page: pageIssues.length };
      const proof = await provePipeline(page, pipeline, timeoutMs, runId);
      const issues = {
        console: consoleIssues.slice(issueStart.console),
        page: pageIssues.slice(issueStart.page)
      };
      assertPipelineProof(pipeline, proof, issues);
      proofs.push({
        pipeline,
        chatBefore: proof.send.before.length,
        chatAfter: proof.send.after.length,
        assistantBefore: proof.send.before.assistantCount,
        assistantAfter: proof.send.after.assistantCount,
        messageProof: proof.send.messageProof,
        rapidPath: proof.snapshot.packet?.diagnostics?.rapidPath || proof.snapshot.promptPacketPreview?.diagnostics?.rapidPath || '',
        planDiagnostics: Array.isArray(proof.diagnosticsExport?.plan?.diagnostics)
          ? proof.diagnosticsExport.plan.diagnostics
          : [],
        pipelineButtonLabel: proof.snapshot.pipelineButtonLabel,
        modeText: proof.snapshot.modeText,
        ribbonText: proof.snapshot.ribbonText,
        handText: proof.snapshot.handText
      });
    }
    return {
      status: 'pass',
      result: 'live-pipeline-proof-pass',
      user,
      runId,
      proofs,
      consoleIssues,
      pageIssues
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runLivePipelineProof();
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      status: error?.result === 'dry-run' ? 'skipped' : 'fail',
      result: error?.result || 'live-pipeline-proof-failed',
      error: String(error?.message || error),
      details: error?.details || null
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'skipped' ? 0 : 1;
  }
}
