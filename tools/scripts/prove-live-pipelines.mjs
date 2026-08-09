import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import {
  createSillyTavernHttpSession,
  inspectRecursionPromptRequest,
  validateSoakUserHandle
} from './lib/sillytavern-live-harness.mjs';
import { createDefaultCardDeck } from '../../src/pre-process-decks.mjs';

const PIPELINES = new Set(['segmented', 'fused']);
const PLACEMENTS = new Set(['in_prompt', 'in_chat']);
const MODES = new Set(['auto', 'manual']);
const CARD_FAMILIES = new Set([
  'Scene Frame',
  'Scene Constraints',
  'Active Cast',
  'Knowledge',
  'Consequences',
  'Character Motivation',
  'Relationship',
  'Open Threads',
  'Environment',
  'Tone',
  'Continuity'
]);
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
    pipelines: ['segmented', 'fused'],
    placements: ['in_prompt', 'in_chat'],
    depth: 4,
    role: 'system',
    mode: 'auto',
    families: [],
    certifyOnly: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') {
      args.live = true;
    } else if (arg === '--certify-only') {
      args.certifyOnly = true;
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
    } else if (arg === '--mode') {
      args.mode = String(argv[index + 1] || '').trim().toLowerCase();
      index += 1;
    } else if (arg === '--families') {
      args.families = String(argv[index + 1] || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      index += 1;
    }
  }
  for (const placement of args.placements) {
    if (!PLACEMENTS.has(placement)) throw new Error(`Unknown placement "${placement}". Use in_prompt or in_chat.`);
  }
  if (!Number.isInteger(args.depth) || args.depth < 0 || args.depth > 10) {
    throw new Error('Injection depth must be an integer from 0 through 10.');
  }
  if (!MODES.has(args.mode)) throw new Error(`Unknown mode "${args.mode}". Use auto or manual.`);
  if (args.mode === 'manual' && args.families.length !== 2) {
    throw new Error('Manual live proof requires exactly two --families.');
  }
  if (args.mode === 'auto' && args.families.length) {
    throw new Error('Auto live proof does not accept --families.');
  }
  for (const family of args.families) {
    if (!CARD_FAMILIES.has(family)) throw new Error(`Unknown card family "${family}".`);
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

function familyStageSuffix(family) {
  return String(family || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function inspectMilestoneVerdict({ pipeline, mode, requestedFamilies = [], diagnostics = {} } = {}) {
  const errors = [];
  const settings = diagnostics?.settings || {};
  const runtime = diagnostics?.runtime || {};
  const execution = runtime.execution || {};
  const stages = Array.isArray(execution.stages) ? execution.stages : [];
  const cardStages = stages.filter((stage) => String(stage?.stageId || '').startsWith('preprocess.cards.'));
  const segmentedStages = cardStages.filter((stage) => String(stage.stageId).startsWith('preprocess.cards.segmented.'));
  const fusedStages = cardStages.filter((stage) => String(stage.stageId) === 'preprocess.cards.fused');
  const handFamilies = Array.isArray(runtime?.hand?.families) ? runtime.hand.families : [];
  const packetPipeline = String(runtime?.packet?.diagnostics?.pipelineMode || '');

  if (settings.mode !== mode) errors.push('settings-mode-mismatch');
  if (Number(settings.minCards) !== 2 || Number(settings.maxCards) !== 2) errors.push('two-card-budget-mismatch');
  if (execution.operationState !== 'completed') errors.push('operation-not-completed');
  if (packetPipeline !== pipeline) errors.push('effective-pipeline-mismatch');
  if (Number(runtime?.hand?.selectedCount) !== 2 || new Set(handFamilies).size !== 2) errors.push('hand-not-two-unique-families');
  if (stages.some((stage) => stage?.stageState !== 'completed')) errors.push('nonterminal-or-adverse-stage');
  if (new Set(stages.map((stage) => stage?.stageId)).size !== stages.length) errors.push('duplicate-stage');

  if (pipeline === 'fused') {
    if (fusedStages.length !== 1) errors.push('fused-stage-count');
    if (fusedStages[0]?.attemptCount !== 1) errors.push('fused-request-count');
    if (segmentedStages.length) errors.push('segmented-fallback-started');
  } else {
    if (fusedStages.length) errors.push('unexpected-fused-stage');
    if (segmentedStages.length !== 2) errors.push('segmented-stage-count');
  }

  if (mode === 'manual') {
    const expectedFamilies = [...new Set(requestedFamilies)];
    const expectedStageIds = expectedFamilies.map((family) => `preprocess.cards.segmented.${familyStageSuffix(family)}`).sort();
    const actualStageIds = segmentedStages.map((stage) => stage.stageId).sort();
    if (expectedFamilies.length !== 2) errors.push('manual-family-count');
    if (JSON.stringify([...handFamilies].sort()) !== JSON.stringify([...expectedFamilies].sort())) errors.push('manual-hand-scope-mismatch');
    if (JSON.stringify(actualStageIds) !== JSON.stringify(expectedStageIds)) errors.push('manual-stage-scope-mismatch');
  }

  return {
    ok: errors.length === 0,
    errors,
    operationId: String(execution.operationId || ''),
    pipeline: packetPipeline,
    mode: String(settings.mode || ''),
    cardStageIds: cardStages.map((stage) => stage.stageId),
    handFamilies
  };
}

const PRIVATE_REPORT_KEYS = /^(?:connectionProfileId|request|response|prompt|promptText|content|message|messages|transcript|reasoning|headers|cookie|authorization|apiKey|secret|excerpts|packet|promptPacketPreview|chat)$/i;

export function sanitizeLiveProofReport(value, key = '') {
  if (PRIVATE_REPORT_KEYS.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeLiveProofReport(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeLiveProofReport(entryValue, entryKey)
    ]));
  }
  return typeof value === 'string' ? value.slice(0, 500) : value;
}

export function inspectCertificationPreflight({ utility = {}, reasoner = {} } = {}) {
  const errors = [];
  const utilitySegmentedReady = utility.ok === true
    && ['partial', 'pass'].includes(utility.status)
    && utility.checks?.connectivity === 'pass'
    && utility.checks?.singleCard === 'pass';
  const reasonerFusedReady = reasoner.ok === true
    && reasoner.status === 'pass'
    && reasoner.checks?.fusedCards === 'pass';
  if (!utilitySegmentedReady) errors.push('utility-not-segmented-ready');
  if (!reasonerFusedReady) errors.push('reasoner-not-fused-ready');
  return {
    ok: errors.length === 0,
    effectiveFusedLane: reasonerFusedReady ? 'reasoner' : '',
    errors
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
    if (!PIPELINES.has(pipeline)) fail('invalid-pipeline', `Unknown pipeline "${pipeline}". Use segmented, fused, or a comma-separated subset.`);
  }
  for (const placement of args.placements) {
    if (!PLACEMENTS.has(placement)) fail('invalid-placement', `Unknown placement "${placement}". Use in_prompt, in_chat, or both.`);
  }
  return userResult.user;
}

export function contextChatSummaryScript() {
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

export function liveSnapshotScript() {
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

export async function waitForRoot(page, timeoutMs) {
  await page.waitForSelector('#recursion-root', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-pipeline-button]', { timeout: timeoutMs });
  await page.waitForSelector('[data-recursion-mode-button]', { timeout: timeoutMs });
}

export async function setPower(page, enabled, timeoutMs) {
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

export async function selectMode(page, mode, timeoutMs) {
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
  const expectedLabel = pipeline === 'fused' ? 'Fused' : 'Segmented';
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

export function configureSoakDeckFixture(decks = {}, { mode = 'auto', families = [] } = {}) {
  const source = decks && typeof decks === 'object' ? decks : {};
  const customDecks = source.customDecks && typeof source.customDecks === 'object' ? source.customDecks : {};
  const activeDeck = customDecks[source.activeDeckId];
  if (!activeDeck) {
    const defaultDeck = createDefaultCardDeck();
    const entries = Object.entries(defaultDeck.cards || {});
    const existingStates = source.defaultCardStates && typeof source.defaultCardStates === 'object'
      ? source.defaultCardStates
      : {};
    if (mode === 'auto' && entries.some(([id]) => existingStates[id] !== 'off')) {
      return { ...source, activeDeckId: 'default' };
    }
    const requested = new Set(Array.isArray(families) ? families : []);
    const defaultCardStates = Object.fromEntries(entries
      .filter(([, card], index) => mode === 'manual'
        ? !requested.has(card?.builtinFamily)
        : index >= 2)
      .map(([id]) => [id, 'off']));
    return { ...source, activeDeckId: 'default', defaultCardStates };
  }
  const entries = Object.entries(activeDeck.cards || {});
  if (mode === 'auto' && entries.some(([, card]) => card?.selectionState === 'active')) return source;
  const requested = new Set(Array.isArray(families) ? families : []);
  const cards = Object.fromEntries(entries.map(([id, card], index) => [id, {
    ...card,
    selectionState: mode === 'manual'
      ? (requested.has(card?.builtinFamily) ? 'active' : 'off')
      : (index < 2 ? 'active' : 'off')
  }]));
  return {
    ...source,
    customDecks: {
      ...customDecks,
      [activeDeck.id]: { ...activeDeck, cards }
    }
  };
}

export async function ensureRunnableDeckFixture(page, args, timeoutMs) {
  const currentDecks = await page.evaluate(() => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const settings = runtime?.view?.()?.settings;
    return settings?.preProcessDecks || null;
  });
  if (!currentDecks) return;
  const configuredDecks = configureSoakDeckFixture(currentDecks, args);
  await page.evaluate(async ({ mode, preProcessDecks }) => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    if (!runtime) return;
    await runtime.updateSettings({
      mode,
      minCards: 2,
      maxCards: 2,
      preProcessDecks
    });
  }, { mode: args.mode, preProcessDecks: configuredDecks });
  await page.waitForFunction(() => /Hand\s+\d+/.test(String(document.querySelector('[data-recursion-hand-count]')?.textContent || '')), null, { timeout: timeoutMs }).catch(() => {});
}

async function certifySelectedProfiles(page, timeoutMs) {
  const result = await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    if (!runtime || typeof runtime.testProvider !== 'function') return { ok: false, reason: 'runtime-provider-test-unavailable' };
    const utilityResult = await runtime.testProvider('utility');
    const reasonerResult = await runtime.testProvider('reasoner');
    const view = runtime.view?.() || {};
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const extensionSettings = context.extensionSettings || globalThis.extension_settings || {};
    const profiles = Array.isArray(extensionSettings.connectionManager?.profiles)
      ? extensionSettings.connectionManager.profiles
      : [];
    const labelFor = (profileId) => {
      const profile = profiles.find((entry) => entry?.id === profileId);
      return String(profile?.name || profile?.label || profile?.model || 'selected-profile').slice(0, 180);
    };
    const summary = (lane, testResult) => {
      const provider = view.settings?.providers?.[lane] || {};
      return {
        label: labelFor(provider.connectionProfileId),
        ok: testResult?.ok === true,
        status: String(provider.certification?.status || 'not-run'),
        checks: provider.certification?.checks || null,
        capability: String(view.settings?.providerCapabilities?.[lane]?.promptPacket?.state || '')
      };
    };
    const utility = summary('utility', utilityResult);
    const reasoner = summary('reasoner', reasonerResult);
    return { utility, reasoner };
  });
  const verdict = inspectCertificationPreflight(result);
  if (!verdict.ok) fail('selected-profile-certification-failed', 'Selected Utility and Reasoner profiles did not reach the required Segmented/Fused readiness.', { ...result, verdict });
  await page.waitForFunction(() => {
    const settings = globalThis.__recursionLiveHarnessRuntime?.view?.()?.settings || {};
    return ['partial', 'pass'].includes(settings.providers?.utility?.certification?.status)
      && settings.providers?.reasoner?.certification?.status === 'pass';
  }, null, { timeout: timeoutMs });
  return { ...result, verdict };
}

export function resolveExactUtilityProfile(profiles = [], requestedLabel = '') {
  const label = String(requestedLabel || '').trim();
  const matches = (Array.isArray(profiles) ? profiles : [])
    .map((profile, index) => ({ profile, index }))
    .filter(({ profile }) => String(profile?.name || profile?.label || '').trim() === label);
  if (matches.length === 0) {
    return { ok: false, reason: 'profile-not-found', requestedLabel: label };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'profile-label-ambiguous', requestedLabel: label };
  }
  const [{ profile, index }] = matches;
  return {
    ok: true,
    index,
    label: String(profile?.name || profile?.label || '').slice(0, 180),
    model: String(profile?.model || '').slice(0, 180)
  };
}

export async function selectUtilityProfileByLabel(page, requestedLabel, timeoutMs) {
  const result = await page.evaluate(async (label) => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const extensionSettings = context.extensionSettings || globalThis.extension_settings || {};
    const profiles = Array.isArray(extensionSettings.connectionManager?.profiles)
      ? extensionSettings.connectionManager.profiles
      : [];
    const matches = profiles.filter((profile) => String(profile?.name || profile?.label || '').trim() === label);
    if (matches.length === 0) return { ok: false, reason: 'profile-not-found', requestedLabel: label };
    if (matches.length > 1) return { ok: false, reason: 'profile-label-ambiguous', requestedLabel: label };
    if (!runtime || typeof runtime.updateProviderConfig !== 'function') {
      return { ok: false, reason: 'runtime-provider-api-unavailable', requestedLabel: label };
    }
    const selected = matches[0];
    await runtime.updateProviderConfig('utility', { connectionProfileId: selected.id });
    return {
      ok: true,
      label: String(selected.name || selected.label || '').slice(0, 180),
      model: String(selected.model || '').slice(0, 180)
    };
  }, String(requestedLabel || '').trim());
  if (!result?.ok) {
    fail('utility-profile-selection-failed', 'Failed to select the requested Utility connection profile by exact label.', result || {});
  }
  await page.waitForFunction((expectedLabel) => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const extensionSettings = context.extensionSettings || globalThis.extension_settings || {};
    const profiles = Array.isArray(extensionSettings.connectionManager?.profiles)
      ? extensionSettings.connectionManager.profiles
      : [];
    const selectedId = runtime?.view?.()?.settings?.providers?.utility?.connectionProfileId;
    const selected = profiles.find((profile) => profile?.id === selectedId);
    return String(selected?.name || selected?.label || '').trim() === expectedLabel;
  }, result.label, { timeout: timeoutMs });
  return result;
}

export async function certifyUtilityProfile(page, timeoutMs) {
  const result = await page.evaluate(async () => {
    const runtime = globalThis.__recursionLiveHarnessRuntime;
    if (!runtime || typeof runtime.testProvider !== 'function') {
      return { ok: false, reason: 'runtime-provider-test-unavailable' };
    }
    const testResult = await runtime.testProvider('utility');
    const view = runtime.view?.() || {};
    const provider = view.settings?.providers?.utility || {};
    const context = globalThis.SillyTavern?.getContext?.() || globalThis.getContext?.() || {};
    const extensionSettings = context.extensionSettings || globalThis.extension_settings || {};
    const profiles = Array.isArray(extensionSettings.connectionManager?.profiles)
      ? extensionSettings.connectionManager.profiles
      : [];
    const selected = profiles.find((profile) => profile?.id === provider.connectionProfileId);
    return {
      ok: testResult?.ok === true,
      label: String(selected?.name || selected?.label || 'selected-profile').slice(0, 180),
      model: String(selected?.model || '').slice(0, 180),
      status: String(provider.certification?.status || 'not-run'),
      checks: provider.certification?.checks || null,
      capability: String(view.settings?.providerCapabilities?.utility?.promptPacket?.state || '')
    };
  });
  const segmentedReady = result?.ok === true
    && ['partial', 'pass'].includes(result.status)
    && result.checks?.connectivity === 'pass'
    && result.checks?.singleCard === 'pass';
  if (!segmentedReady) {
    fail('utility-profile-certification-failed', 'Utility profile did not pass connectivity and single-card certification.', result || {});
  }
  await page.waitForFunction(() => {
    const certification = globalThis.__recursionLiveHarnessRuntime?.view?.()?.settings?.providers?.utility?.certification;
    return ['partial', 'pass'].includes(certification?.status)
      && certification?.checks?.connectivity === 'pass'
      && certification?.checks?.singleCard === 'pass';
  }, null, { timeout: timeoutMs });
  return result;
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

async function registerHostGenerationEnded(page) {
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
    if (!eventSource || names.length === 0) return { id, registered: false };
    const handler = (eventName) => {
      globalThis.__recursionProofGenerationEnded = { id, seen: true, eventName, at: Date.now() };
    };
    for (const name of names) {
      if (typeof eventSource.on === 'function') eventSource.on(name, () => handler(name));
      else if (typeof eventSource.addEventListener === 'function') eventSource.addEventListener(name, () => handler(name));
    }
    return { id, registered: true };
  }).catch(() => ({ id: '', registered: false }));
}

async function waitForHostGenerationEnded(page, registration, timeoutMs) {
  if (!registration?.registered || !registration.id) return;
  await page.waitForFunction((id) => {
    const state = globalThis.__recursionProofGenerationEnded || {};
    return state.id === id && state.seen === true;
  }, registration.id, { timeout: timeoutMs });
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

export async function sendAndWait(page, message, { requirePrompt, timeoutMs }) {
  const before = await page.evaluate(contextChatSummaryScript());
  const surface = await findSendSurface(page, timeoutMs);
  const generationEnded = await registerHostGenerationEnded(page);
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

export async function exportDiagnosticsSnapshot(page, timeoutMs) {
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
  const expectedLabel = pipeline === 'fused' ? 'Fused' : 'Segmented';
  if (!String(snapshot.pipelineButtonLabel || '').includes(expectedLabel)) {
    fail(`${pipeline}-pipeline-not-selected`, 'Pipeline button did not expose the expected selected pipeline.', { expectedLabel, snapshot });
  }
  if (!String(snapshot.modeText || '').toLowerCase().includes(proof.mode)) {
    fail(`${pipeline}-mode-not-selected`, 'Mode button did not expose the requested mode.', { expectedMode: proof.mode, snapshot });
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
  const packetDiagnostics = snapshot.packet?.diagnostics || snapshot.promptPacketPreview?.diagnostics || {};
  const packetReady = packetDiagnostics.pipelineMode === pipeline
    && Boolean(snapshot.packet?.packetId || snapshot.promptPacketPreview?.packetId)
    && (Array.isArray(snapshot.packet?.injectedBlocks) ? snapshot.packet.injectedBlocks.length > 0 : true);
  if (!packetReady && !/\bHand\s+[1-9]\d*/i.test(String(snapshot.handText || ''))) {
    fail(`${pipeline}-hand-not-ready`, 'Recursion did not expose a ready hand after generation.', { snapshot, diagnosticsExport: proof.diagnosticsExport });
  }
  if (packetDiagnostics.pipelineMode !== pipeline) {
    fail(`${pipeline}-diagnostics-missing`, `${expectedLabel} proof did not expose matching packet diagnostics.`, { snapshot, diagnosticsExport: proof.diagnosticsExport });
  }
  if (/skipped|failed|failure|warning|caution/i.test(String(snapshot.ribbonText || ''))) {
    fail(`${pipeline}-visible-warning`, 'Recursion ribbon exposed skip/fail/warning/caution text.', { snapshot });
  }
  if (issues.console.length || issues.page.length) {
    fail(`${pipeline}-browser-issues`, 'Browser console/page issues were observed during pipeline proof.', issues);
  }
  const milestoneVerdict = inspectMilestoneVerdict({
    pipeline,
    mode: proof.mode,
    requestedFamilies: proof.requestedFamilies,
    diagnostics: proof.diagnosticsExport
  });
  if (!milestoneVerdict.ok) {
    fail(`${pipeline}-milestone-contract`, 'Current operation did not satisfy the live soak milestone contract.', { milestoneVerdict });
  }
  return milestoneVerdict;
}

function proofMessageFor(pipeline, placement, runId) {
  return [
    `Recursion ${pipeline} ${placement} pipeline proof ${runId}:`,
    'I push open the rain-soaked archive door with my shoulder, keep the candle low,',
    'and ask Mara what she remembers about the missing captain before the guards hear us.'
  ].join(' ');
}

async function provePipeline(page, pipeline, placement, depth, role, mode, requestedFamilies, timeoutMs, runId) {
  let phase = 'power-on';
  try {
    await setPower(page, true, timeoutMs);
    phase = 'pipeline-select';
    await selectPipeline(page, pipeline, timeoutMs);
    phase = 'mode-select';
    await selectMode(page, mode, timeoutMs);
    phase = 'injection-settings';
    const injection = { placement, depth, role };
    await selectInjectionSettings(page, injection, timeoutMs);
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
    return { pipeline, placement, depth, role, mode, requestedFamilies, send, snapshot, diagnosticsExport };
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
    if (args.certifyOnly) {
      const context = await browser.newContext();
      try {
        await context.addInitScript(() => {
          globalThis.__recursionLiveHarness = true;
        });
        await context.addCookies(session.playwrightCookies());
        const page = await context.newPage();
        await page.goto(env.SILLYTAVERN_BASE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await waitForRoot(page, timeoutMs);
        const certification = await certifySelectedProfiles(page, timeoutMs);
        return {
          status: 'pass',
          result: 'selected-profile-certification-pass',
          user,
          runId,
          certification
        };
      } finally {
        await context.close().catch(() => {});
      }
    }
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
        await ensureRunnableDeckFixture(page, args, timeoutMs);
        for (const pipeline of args.pipelines) {
          const issueStart = { console: consoleIssues.length, page: pageIssues.length };
          const requestStart = serializedPromptRequests.length;
          const proof = await provePipeline(page, pipeline, placement, args.depth, args.role, args.mode, args.families, timeoutMs, runId);
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
          const milestoneVerdict = assertPipelineProof(pipeline, proof, issues);
          proofs.push({
            pipeline,
            mode: args.mode,
            requestedFamilies: args.families,
            milestoneVerdict,
            placement,
            configuredDepth: args.depth,
            configuredRole: args.role,
            chatBefore: proof.send.before.length,
            chatAfter: proof.send.after.length,
            assistantBefore: proof.send.before.assistantCount,
            assistantAfter: proof.send.after.assistantCount,
            messageProof: proof.send.messageProof,
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
    console.log(JSON.stringify(sanitizeLiveProofReport(report), null, 2));
  } catch (error) {
    const report = {
      status: error?.result === 'dry-run' ? 'skipped' : 'fail',
      result: error?.result || 'live-pipeline-proof-failed',
      error: String(error?.message || error),
      details: error?.details || null
    };
    console.log(JSON.stringify(sanitizeLiveProofReport(report), null, 2));
    process.exitCode = report.status === 'skipped' ? 0 : 1;
  }
}
