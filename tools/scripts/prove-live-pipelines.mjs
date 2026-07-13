import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import {
  createSillyTavernHttpSession,
  inspectRecursionPromptRequest,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';

const PIPELINES = new Set(['standard', 'rapid', 'fused']);
const PLACEMENTS = new Set(['in_prompt', 'in_chat']);
const PLACEMENT_POSITIONS = Object.freeze({ in_prompt: 0, in_chat: 1 });
const PROMPT_ROLE_VALUES = Object.freeze({ system: 0, user: 1, assistant: 2 });
const RECURSION_PROMPT_KEYS = Object.freeze([
  'recursion.guidance',
  'recursion.cardEvidence',
  'recursion.guardrails'
]);
const DEFAULT_TIMEOUT_MS = 120000;
const CHAT_STABLE_MS = 4000;

export function parseArgs(argv = []) {
  const args = {
    live: false,
    pipelines: ['standard', 'rapid', 'fused'],
    placements: ['in_prompt', 'in_chat'],
    depth: 4,
    role: 'system'
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
    } else if (arg === '--placement') {
      const value = String(argv[index + 1] || '').trim().toLowerCase();
      index += 1;
      args.placements = value ? [value] : args.placements;
    } else if (arg === '--placements') {
      const value = String(argv[index + 1] || '');
      index += 1;
      args.placements = value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    } else if (arg === '--depth') {
      args.depth = Number(argv[index + 1]);
      index += 1;
    }
  }
  for (const placement of args.placements) {
    if (!PLACEMENTS.has(placement)) throw new Error(`Unknown placement "${placement}". Use in_prompt or in_chat.`);
  }
  if (!Number.isInteger(args.depth) || args.depth < 0 || args.depth > 10) {
    throw new Error('Injection depth must be an integer from 0 through 10.');
  }
  return args;
}

export function inspectStoredRecursionPrompts(store = {}, settings = {}) {
  const placement = String(settings.placement || '').trim().toLowerCase();
  const role = String(settings.role || 'system').trim().toLowerCase();
  const expectedPosition = PLACEMENT_POSITIONS[placement];
  const expectedDepth = Number(settings.depth);
  const expectedRole = PROMPT_ROLE_VALUES[role];
  const blocks = RECURSION_PROMPT_KEYS.map((key) => {
    const entry = store?.[key] || {};
    const present = typeof entry.value === 'string' && entry.value.length > 0;
    const position = Number.isFinite(Number(entry.position)) ? Number(entry.position) : null;
    const depth = Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : null;
    const storedRole = Number.isFinite(Number(entry.role)) ? Number(entry.role) : null;
    return {
      key,
      present,
      position,
      depth,
      role: storedRole,
      valid: present
        && position === expectedPosition
        && depth === expectedDepth
        && storedRole === expectedRole
    };
  });
  return {
    placement,
    expectedPosition,
    expectedDepth,
    expectedRole,
    blocks,
    complete: blocks.every((block) => block.valid)
  };
}

export function inspectPacketInjectionMetadata(packet = {}, settings = {}) {
  const placement = String(settings.placement || '').trim().toLowerCase();
  const role = String(settings.role || 'system').trim().toLowerCase();
  const expectedPosition = PLACEMENT_POSITIONS[placement];
  const expectedDepth = Number(settings.depth);
  const expectedRole = PROMPT_ROLE_VALUES[role];
  const injectedBlocks = Array.isArray(packet?.injectedBlocks) ? packet.injectedBlocks : [];
  const blocks = RECURSION_PROMPT_KEYS.map((key) => {
    const block = injectedBlocks.find((entry) => String(entry?.promptKey || '') === key) || {};
    const blockPlacement = String(block.placement || '');
    const blockRole = String(block.role || '').toLowerCase();
    const position = PLACEMENT_POSITIONS[blockPlacement];
    const depth = Number.isFinite(Number(block.depth)) ? Number(block.depth) : null;
    const numericRole = PROMPT_ROLE_VALUES[blockRole];
    const present = Boolean(block.promptKey);
    return {
      key,
      present,
      placement: blockPlacement,
      position,
      depth,
      role: numericRole,
      valid: present
        && blockPlacement === placement
        && position === expectedPosition
        && depth === expectedDepth
        && numericRole === expectedRole
    };
  });
  return {
    source: 'validated-packet',
    placement,
    expectedPosition,
    expectedDepth,
    expectedRole,
    blocks,
    complete: blocks.every((block) => block.valid)
  };
}

function promptStoreSnapshotScript() {
  return (keys) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const prompts = context.extensionPrompts || context.extension_prompts || {};
    return Object.fromEntries(keys.map((key) => {
      const entry = prompts[key] || {};
      return [key, {
        value: typeof entry.value === 'string' && entry.value.length > 0 ? 'present' : '',
        position: entry.position,
        depth: entry.depth,
        role: entry.role
      }];
    }));
  };
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
    if (!PIPELINES.has(pipeline)) fail('invalid-pipeline', `Unknown pipeline "${pipeline}". Use standard, rapid, fused, or a comma-separated subset.`);
  }
  for (const placement of args.placements) {
    if (!PLACEMENTS.has(placement)) fail('invalid-placement', `Unknown placement "${placement}". Use in_prompt, in_chat, or both.`);
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

async function closeViewerIfOpen(page) {
  await page.evaluate(() => {
    const viewer = document.querySelector('[data-recursion-viewer]');
    if (!viewer) return false;
    if (viewer.open && typeof viewer.close === 'function') {
      viewer.close();
      return true;
    }
    if (viewer.hidden === false) {
      viewer.hidden = true;
      return true;
    }
    return false;
  }).catch(() => false);
}

export async function selectPipeline(page, pipeline, timeoutMs) {
  await closeViewerIfOpen(page);
  const pipelineButton = page.locator('[data-recursion-pipeline-button]').first();
  await pipelineButton.click({ timeout: timeoutMs });
  await page.locator(`[data-recursion-pipeline-choice="${pipeline}"], [data-recursion-pipeline-choice-${pipeline}]`).first().click({ timeout: timeoutMs });
  const expectedLabel = pipeline === 'rapid' ? 'Rapid Pipeline' : (pipeline === 'fused' ? 'Fused Pipeline' : 'Standard Pipeline');
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

async function ensureRunnableDeckFixture(page, timeoutMs) {
  await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const settings = runtime?.view?.()?.settings;
    if (!runtime || !settings?.cardDecks) return;
    const decks = settings.cardDecks;
    const activeDeck = decks.customCardDecks?.[decks.activeCardDeckId];
    if (activeDeck) {
      const cards = Object.fromEntries(Object.entries(activeDeck.cards || {}).map(([id, card]) => [id, {
        ...card,
        selectionState: 'active'
      }]));
      await runtime.updateSettings({
        cardDecks: {
          ...decks,
          customCardDecks: {
            ...decks.customCardDecks,
            [activeDeck.id]: { ...activeDeck, cards }
          }
        }
      });
      return;
    }
    const defaultEnabledState = structuredClone(decks.defaultEnabledState || settings.cardScope?.families || {});
    for (const family of Object.values(defaultEnabledState)) {
      if (!family || typeof family !== 'object') continue;
      family.enabled = true;
      for (const key of Object.keys(family.subItems || {})) family.subItems[key] = true;
    }
    await runtime.updateSettings({
      cardDecks: { ...decks, activeCardDeckId: 'default', defaultEnabledState }
    });
  });
  await page.waitForFunction(() => /Hand\s+\d+/.test(String(document.querySelector('[data-recursion-hand-count]')?.textContent || '')), null, { timeout: timeoutMs }).catch(() => {});
}

export async function selectInjectionSettings(page, settings, timeoutMs) {
  const panel = page.locator('[data-recursion-settings-panel]').first();
  const panelOpen = await panel.evaluate((node) => node.hidden === false).catch(() => false);
  if (!panelOpen) {
    await page.locator('[data-recursion-actions]').first().click({ timeout: timeoutMs });
  }
  await panel.waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('[data-recursion-settings-tab="advanced"]').first().click({ timeout: timeoutMs });
  const controls = [
    ['[data-recursion-setting-injection-role]', settings.role, 'role'],
    ['[data-recursion-setting-injection-depth]', String(settings.depth), 'depth'],
    ['[data-recursion-setting-injection-placement]', settings.placement, 'placement']
  ];
  for (const [selector, value, key] of controls) {
    await page.locator(selector).first().selectOption(value, { timeout: timeoutMs });
    await page.waitForFunction(({ expected, settingKey }) => {
      const injection = globalThis.__recursionLiveHarnessRuntime?.view?.()?.settings?.injection || {};
      return String(injection[settingKey] ?? '') === String(expected);
    }, { expected: value, settingKey: key }, { timeout: timeoutMs });
  }
  await page.waitForFunction((expected) => {
    const injection = globalThis.__recursionLiveHarnessRuntime?.view?.()?.settings?.injection || {};
    return String(injection.placement || '') === expected.placement
      && String(injection.role || '') === expected.role
      && Number(injection.depth) === expected.depth;
  }, settings, { timeout: timeoutMs });
  if (await panel.evaluate((node) => node.hidden === false).catch(() => false)) {
    await page.locator('[data-recursion-actions]').first().click({ timeout: timeoutMs });
  }
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
  const surfaceDiagnostics = async () => page.evaluate((selectors) => {
    const describe = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return { selector, present: false };
      const rect = node.getBoundingClientRect();
      const style = globalThis.getComputedStyle?.(node);
      return {
        selector,
        present: true,
        disabled: node.disabled === true,
        hidden: node.hidden === true,
        ariaHidden: node.getAttribute('aria-hidden') || '',
        display: style?.display || '',
        visibility: style?.visibility || '',
        opacity: style?.opacity || '',
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    };
    return {
      location: String(location.href || ''),
      activeElement: document.activeElement ? {
        tag: document.activeElement.tagName,
        id: document.activeElement.id || '',
        className: String(document.activeElement.className || '').slice(0, 120)
      } : null,
      openDialogs: [...document.querySelectorAll('dialog[open]')].map((node) => ({
        className: String(node.className || '').slice(0, 120),
        label: String(node.getAttribute('aria-label') || '').slice(0, 120)
      })),
      inputs: selectors.inputSelectors.map(describe),
      buttons: selectors.buttonSelectors.map(describe)
    };
  }, { inputSelectors, buttonSelectors }).catch(() => null);
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
  if (!input || !button) {
    fail('visible-send-unavailable', 'Visible SillyTavern send controls were not available.', await surfaceDiagnostics());
  }
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

async function armHostGenerationEnded(page) {
  return page.evaluate(() => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const eventSource = context.eventSource || globalThis.eventSource;
    const eventTypes = context.event_types || context.eventTypes || globalThis.event_types || globalThis.eventTypes || {};
    const names = [...new Set([
      eventTypes.GENERATION_ENDED,
      eventTypes.MESSAGE_RECEIVED,
      'generation_ended',
      'message_received'
    ].filter(Boolean))];
    const id = `generation-ended-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    globalThis.__recursionProofGenerationEnded = { id, seen: false, eventName: '', at: 0 };
    if (!eventSource || names.length === 0) return { id, armed: false };
    const handler = (eventName) => {
      globalThis.__recursionProofGenerationEnded = { id, seen: true, eventName, at: Date.now() };
    };
    for (const name of names) {
      if (typeof eventSource.on === 'function') eventSource.on(name, () => handler(name));
      else if (typeof eventSource.addEventListener === 'function') eventSource.addEventListener(name, () => handler(name));
    }
    return { id, armed: true };
  }).catch(() => ({ id: '', armed: false }));
}

async function waitForHostGenerationEnded(page, armed, timeoutMs) {
  if (!armed?.armed || !armed.id) return;
  await page.waitForFunction((id) => {
    const state = globalThis.__recursionProofGenerationEnded || {};
    return state.id === id && state.seen === true;
  }, armed.id, { timeout: timeoutMs });
}

async function waitForChatSettled(page, { message = '', requirePrompt = false, timeoutMs }) {
  await page.waitForFunction((input) => {
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const textFor = (entry) => String(entry?.mes || entry?.message || entry?.text || '');
    const userIndex = input.message
      ? chat.findIndex((entry) => entry && entry.is_user === true && textFor(entry).includes(input.message))
      : -1;
    const assistantAfter = input.message
      ? chat.slice(userIndex + 1).filter((entry) => entry && entry.is_user === false)
      : chat.filter((entry) => entry && entry.is_user === false);
    const assistantObserved = input.message ? userIndex >= 0 && assistantAfter.length > 0 : true;
    const promptInstalled = Array.isArray(globalThis.__recursionSmokePromptEvents)
      ? globalThis.__recursionSmokePromptEvents.some((entry) => entry && entry.cleared === false && String(entry.key || '').startsWith('recursion.'))
      : true;
    const handReady = /\bHand\s+[1-9]\d*/i.test(String(document.querySelector('[data-recursion-hand-count]')?.textContent || ''));
    if ((input.message && userIndex < 0) || !assistantObserved || (input.requirePrompt && !promptInstalled && !handReady)) {
      globalThis.__recursionProofChatStable = { key: '', since: 0, message: input.message };
      return false;
    }
    const latest = chat.length ? chat[chat.length - 1] : null;
    const latestAssistant = assistantAfter.length ? assistantAfter[assistantAfter.length - 1] : null;
    const key = JSON.stringify({
      length: chat.length,
      userIndex,
      latestRole: latest?.is_user === true ? 'user' : (latest?.is_user === false ? 'assistant' : ''),
      latestText: textFor(latest),
      latestAssistantText: textFor(latestAssistant),
      sendDisabled: document.querySelector('#send_but')?.disabled === true
    });
    const now = Date.now();
    const previous = globalThis.__recursionProofChatStable || {};
    if (previous.message !== input.message || previous.key !== key) {
      globalThis.__recursionProofChatStable = { key, since: now, message: input.message };
      return false;
    }
    return now - Number(previous.since || 0) >= input.stableMs;
  }, { message, requirePrompt, stableMs: CHAT_STABLE_MS }, { timeout: timeoutMs });
}

async function sendAndWait(page, message, { requirePrompt, timeoutMs }) {
  const before = await page.evaluate(contextChatSummaryScript());
  const surface = await findSendSurface(page, timeoutMs);
  const generationEnded = await armHostGenerationEnded(page);
  await fillSendInput(surface.input, message, timeoutMs);
  await surface.button.click({ timeout: timeoutMs });
  await waitForHostGenerationEnded(page, generationEnded, timeoutMs).catch(() => {});
  await waitForChatSettled(page, { message, requirePrompt, timeoutMs });
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
  let warm = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    warm = await page.evaluate(async () => {
      const runtime = globalThis.__recursionLiveHarnessRuntime;
      if (!runtime || typeof runtime.warmRapidScene !== 'function') {
        return { ok: false, reason: 'runtime-unavailable' };
      }
      return runtime.warmRapidScene({ reason: 'live-pipeline-proof' });
    }).catch((error) => ({ ok: false, reason: 'runtime-error', message: String(error?.message || error) }));
    if (warm?.ok === true && warm?.skipped !== true && warm?.rapid?.status === 'ready') break;
    if (!warm?.superseded) break;
    await page.waitForTimeout(750);
  }
  if (warm?.ok !== true || warm?.skipped === true || warm?.rapid?.status !== 'ready') {
    fail('rapid-warm-unavailable', 'Rapid warm did not produce a ready warm deck before foreground proof.', { warm });
  }
  await page.waitForFunction(async (expectedRunId) => {
    const exported = await globalThis.__recursionLiveHarnessRuntime?.exportDiagnostics?.();
    const warm = exported?.diagnostics?.runtime?.rapidWarm || null;
    if (!warm || warm.status !== 'ready' || !warm.runId || !warm.warmArtifactId) return false;
    if (expectedRunId && warm.runId !== expectedRunId) return false;
    return true;
  }, warm.rapid.runId, { timeout: timeoutMs });
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

function isBenignConsoleIssue(issue = {}) {
  const text = String(issue.text || '');
  const url = String(issue.url || '');
  return (issue.type === 'warning' && /^Stream stats:\s+\d+\s+tokens\b/i.test(text))
    // A stale SillyTavern browser cache can request an old, non-Recursion toolbar image.
    // It does not affect Recursion's loaded modules or the visual surface under test.
    || (issue.type === 'error' && /Failed to load resource:.*404/i.test(text) && /\/img\/recursion\.svg$/i.test(url));
}

function assertPipelineProof(pipeline, proof, issues) {
  const snapshot = proof.snapshot || {};
  if (proof.storedPromptEvidence?.complete !== true) {
    fail(`${pipeline}-${proof.placement}-stored-prompt-mismatch`, 'Stored SillyTavern prompt metadata did not match the selected Recursion injection settings.', {
      storedPromptEvidence: proof.storedPromptEvidence
    });
  }
  if (proof.outboundPromptEvidence?.systemInjected !== true) {
    fail(`${pipeline}-${proof.placement}-outbound-system-prompt-missing`, 'Final SillyTavern request omitted Recursion system-prompt content.', {
      outboundPromptEvidence: proof.outboundPromptEvidence
    });
  }
  if (!snapshot.rootMounted) fail(`${pipeline}-root-missing`, 'Recursion root was not mounted.', { snapshot });
  if (!snapshot.powerPressed) fail(`${pipeline}-power-off`, 'Recursion was not enabled for pipeline proof.', { snapshot });
  const expectedLabel = pipeline === 'rapid' ? 'Rapid Pipeline' : (pipeline === 'fused' ? 'Fused Pipeline' : 'Standard Pipeline');
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
  } else if (pipeline === 'fused') {
    const diagnostics = rapidPacketDiagnostics;
    if (diagnostics.pipelineMode !== 'fused') {
      fail(`${pipeline}-diagnostics-missing`, 'Fused proof did not expose Fused packet diagnostics.', { snapshot, diagnosticsExport: proof.diagnosticsExport });
    }
  }
  if (/skipped|failed|failure|warning|caution/i.test(String(snapshot.ribbonText || ''))) {
    fail(`${pipeline}-visible-warning`, 'Recursion ribbon exposed skip/fail/warning/caution text.', { snapshot });
  }
  if (issues.console.length || issues.page.length) {
    fail(`${pipeline}-browser-issues`, 'Browser console/page issues were observed during pipeline proof.', issues);
  }
}

function proofMessageFor(pipeline, placement, runId) {
  return [
    `Recursion ${pipeline} ${placement} pipeline proof ${runId}:`,
    'I push open the rain-soaked archive door with my shoulder, keep the candle low,',
    'and ask Mara what she remembers about the missing captain before the guards hear us.'
  ].join(' ');
}

async function provePipeline(page, pipeline, placement, depth, role, timeoutMs, runId) {
  let phase = 'power-on';
  try {
    await setPower(page, true, timeoutMs);
    phase = 'pipeline-select';
    await selectPipeline(page, pipeline, timeoutMs);
    phase = 'mode-select';
    await selectMode(page, 'auto', timeoutMs);
    phase = 'injection-settings';
    const injection = { placement, depth, role };
    await selectInjectionSettings(page, injection, timeoutMs);
    if (pipeline === 'rapid') {
      phase = 'rapid-base-settle';
      await waitForChatSettled(page, { timeoutMs });
      phase = 'rapid-warm';
      await triggerRapidWarm(page, timeoutMs);
    }
    phase = 'pipeline-send';
    const send = await sendAndWait(page, proofMessageFor(pipeline, placement, runId), {
      requirePrompt: true,
      timeoutMs
    });
    phase = 'viewer-open';
    await openViewer(page, timeoutMs);
    phase = 'diagnostics-export';
    const diagnosticsExport = await exportDiagnosticsSnapshot(page, timeoutMs);
    phase = 'snapshot';
    const snapshot = await page.evaluate(liveSnapshotScript());
    return { pipeline, placement, depth, role, send, snapshot, diagnosticsExport };
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
    for (const placement of args.placements) {
      const context = await browser.newContext();
      const serializedPromptRequests = [];
      try {
        await context.addInitScript(() => {
          globalThis.__recursionLiveHarness = true;
        });
        await context.addCookies(session.playwrightCookies());
        const page = await context.newPage();
        page.on('console', (message) => {
          if (['warning', 'error'].includes(message.type())) {
            const issue = compactIssue({ type: message.type(), text: message.text(), url: message.location()?.url });
            if (!isBenignConsoleIssue(issue)) consoleIssues.push(issue);
          }
        });
        page.on('pageerror', (error) => {
          pageIssues.push({ message: String(error?.message || error).slice(0, 500) });
        });
        page.on('request', (request) => {
          if (!String(request.url?.() || '').includes('/api/backends/chat-completions/generate')) return;
          const promptStore = page.evaluate(promptStoreSnapshotScript(), RECURSION_PROMPT_KEYS).catch(() => ({}));
          try {
            serializedPromptRequests.push({
              evidence: inspectRecursionPromptRequest(JSON.parse(String(request.postData?.() || ''))),
              promptStore
            });
          } catch {
            serializedPromptRequests.push({ evidence: inspectRecursionPromptRequest({}), promptStore });
          }
        });
        await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await waitForRoot(page, timeoutMs);
        await ensureRunnableDeckFixture(page, timeoutMs);
        for (const pipeline of args.pipelines) {
          const issueStart = { console: consoleIssues.length, page: pageIssues.length };
          const requestStart = serializedPromptRequests.length;
          const proof = await provePipeline(page, pipeline, placement, args.depth, args.role, timeoutMs, runId);
          const pipelineRequests = serializedPromptRequests.slice(requestStart);
          const selectedRequest = [...pipelineRequests].reverse().find((entry) => entry.evidence.complete)
            || pipelineRequests.at(-1)
            || { evidence: inspectRecursionPromptRequest({}), promptStore: Promise.resolve({}) };
          proof.outboundPromptEvidence = selectedRequest.evidence;
          const requestTimeStoreEvidence = inspectStoredRecursionPrompts(
            await selectedRequest.promptStore,
            { placement, depth: args.depth, role: args.role }
          );
          proof.storedPromptEvidence = requestTimeStoreEvidence.complete
            ? { source: 'request-time-store', ...requestTimeStoreEvidence }
            : inspectPacketInjectionMetadata(
              proof.snapshot.packet || proof.snapshot.promptPacketPreview || {},
              { placement, depth: args.depth, role: args.role }
            );
          const issues = {
            console: consoleIssues.slice(issueStart.console),
            page: pageIssues.slice(issueStart.page)
          };
          assertPipelineProof(pipeline, proof, issues);
          proofs.push({
            pipeline,
            placement,
            configuredDepth: args.depth,
            configuredRole: args.role,
            chatBefore: proof.send.before.length,
            chatAfter: proof.send.after.length,
            assistantBefore: proof.send.before.assistantCount,
            assistantAfter: proof.send.after.assistantCount,
            messageProof: proof.send.messageProof,
            rapidPath: proof.snapshot.packet?.diagnostics?.rapidPath || proof.snapshot.promptPacketPreview?.diagnostics?.rapidPath || '',
            planDiagnostics: Array.isArray(proof.diagnosticsExport?.runtime?.plan?.diagnostics)
              ? proof.diagnosticsExport.runtime.plan.diagnostics
              : [],
            storedPromptEvidence: proof.storedPromptEvidence,
            outboundPromptEvidence: proof.outboundPromptEvidence,
            pipelineButtonLabel: proof.snapshot.pipelineButtonLabel,
            modeText: proof.snapshot.modeText,
            ribbonText: proof.snapshot.ribbonText,
            handText: proof.snapshot.handText
          });
        }
      } finally {
        await context.close().catch(() => {});
      }
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
