import { redact } from './core.mjs';

const PHASE_LABELS = Object.freeze({
  idle: '',
  started: 'Reading current turn...',
  activity: 'Recursion is working...',
  sceneChecking: 'Checking scene shift...',
  arbiterPlanning: 'Planning card pass...',
  cacheReusing: 'Reusing scene deck...',
  cardBatchRunning: 'Generating scene cards...',
  cardValidating: 'Validating cards...',
  deckUpdating: 'Updating scene deck...',
  handSelected: 'Selecting turn hand...',
  utilityComposing: 'Composing prompt packet with Utility...',
  reasonerComposing: 'Reasoner composing final brief...',
  promptInstalling: 'Installing Recursion prompt...',
  promptPacketBuilt: 'Recursion prompt ready.',
  storageSaving: 'Saving scene cache...',
  storageComplete: 'Scene cache saved.',
  promptClearing: 'Clearing Recursion prompt...',
  promptClearFailed: 'Prompt clear failed. Recursion skipped without clearing host prompt.',
  storageWarning: 'Recursion storage warning; continuing in memory.',
  cacheWarning: 'Ignored invalid cached Recursion cards.',
  settled: 'Recursion prompt ready.'
});

const VALID_SEVERITIES = new Set(['info', 'success', 'warning', 'error']);
const READY_PHASES = new Set(['idle', 'settled', '', undefined, null]);
const REASONER_ACTIVE_PHASES = new Set(['reasonerComposing']);
const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/ig;
const MODE_OPTIONS = Object.freeze([
  ['off', 'Off'],
  ['observe', 'Observe only'],
  ['auto', 'Auto']
]);
const STRENGTH_OPTIONS = Object.freeze([
  ['light', 'Light'],
  ['balanced', 'Balanced'],
  ['strong', 'Strong']
]);
const FOOTPRINT_OPTIONS = Object.freeze([
  ['compact', 'Compact'],
  ['normal', 'Normal'],
  ['rich', 'Rich']
]);
const FOCUS_OPTIONS = Object.freeze([
  ['balanced', 'Balanced'],
  ['character', 'Character'],
  ['continuity', 'Continuity'],
  ['prose', 'Prose'],
  ['plot', 'Plot']
]);
const REASONER_OPTIONS = Object.freeze([
  ['off', 'Off'],
  ['auto', 'Auto'],
  ['always', 'Always Compose']
]);
const PROVIDER_SOURCE_OPTIONS = Object.freeze([
  ['host-current-model', 'Current Host Model'],
  ['host-connection-profile', 'Host Connection Profile'],
  ['openai-compatible', 'OpenAI-Compatible Endpoint']
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function truncateText(value, limit = 900) {
  const text = String(value ?? '');
  const cap = Math.max(0, Math.floor(Number(limit)) || 0);
  if (text.length <= cap) return text;
  if (cap <= 3) return '.'.repeat(cap);
  return `${text.slice(0, cap - 3)}...`;
}

function safeText(value, limit = 900) {
  return truncateText(String(value ?? '').replace(SECRET_TEXT_PATTERN, '[redacted]'), limit);
}

function titleCase(value, fallback = '') {
  const text = cleanText(value, fallback).toLowerCase();
  if (!text) return fallback;
  return text
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function normalizeSeverity(value) {
  const severity = cleanText(value, 'info').toLowerCase();
  return VALID_SEVERITIES.has(severity) ? severity : 'info';
}

function normalizeChips(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const chips = [];
  for (const chip of value) {
    const normalized = cleanText(chip);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    chips.push(normalized);
  }
  return chips;
}

function laneLabel(value, fallback = 'Utility') {
  const lane = cleanText(value).toLowerCase();
  if (lane === 'reasoner') return 'Reasoner';
  if (lane === 'local') return 'Local';
  if (lane === 'utility') return 'Utility';
  return fallback;
}

function modeLabel(value) {
  const mode = cleanText(value, 'observe').toLowerCase();
  if (mode === 'off') return 'Off';
  if (mode === 'auto') return 'Auto';
  return 'Observe only';
}

function cardSummary(card) {
  const source = asObject(card);
  return cleanText(source.summary || source.promptText || source.text || source.id, 'Untitled card');
}

function cardFamily(card) {
  const source = asObject(card);
  return cleanText(source.family || source.type || source.kind, 'Card');
}

function reasonerState(view, activity) {
  const settings = asObject(view.settings);
  const reasoner = settings.providers && Object.prototype.hasOwnProperty.call(settings.providers, 'reasoner')
    ? asObject(settings.providers.reasoner)
    : null;
  if (reasoner?.enabled === false) return 'Disabled';
  if (REASONER_ACTIVE_PHASES.has(activity.phase) || activity.providerLane === 'reasoner' || activity.composerLane === 'reasoner') {
    return 'Composing';
  }
  if (!reasoner) return 'Unavailable';
  if (reasoner.lastTest?.status && !['ok', 'pass', 'passed', 'ready', 'not-run'].includes(cleanText(reasoner.lastTest.status).toLowerCase())) {
    return 'Issue';
  }
  return reasoner.enabled === true ? 'Available' : 'Unavailable';
}

export function activityLabel(activity = {}) {
  const source = asObject(activity);
  const explicitLabel = cleanText(source.label);
  if (explicitLabel) return explicitLabel;
  if (Object.prototype.hasOwnProperty.call(PHASE_LABELS, source.phase)) return PHASE_LABELS[source.phase];
  return 'Recursion is working...';
}

export function createRecursionViewModel(view = {}) {
  const source = asObject(view);
  const settings = asObject(source.settings);
  const activity = asObject(source.activity);
  const mode = cleanText(settings.mode, 'observe').toLowerCase();
  const cards = Array.isArray(source.lastHand?.cards) ? source.lastHand.cards : [];
  const composerLane = source.lastPacket?.diagnostics?.composerLane || activity.composerLane || activity.providerLane || 'utility';
  const ready = READY_PHASES.has(activity.phase);
  const activityChips = normalizeChips([
    ...(Array.isArray(activity.chips) ? activity.chips : []),
    activity.providerLane ? laneLabel(activity.providerLane) : '',
    activity.cardCounts?.selected ? `${activity.cardCounts.selected} cards` : ''
  ]);

  return {
    mode,
    modeLabel: modeLabel(mode),
    runtimeHealthLabel: ready ? 'Ready' : 'Working',
    handCount: cards.length,
    activityLabel: activityLabel(activity),
    activitySeverity: normalizeSeverity(activity.severity),
    activityChips,
    composerLabel: laneLabel(composerLane, 'Utility'),
    reasonerState: reasonerState(source, activity),
    reasonerLabel: `Reasoner ${reasonerState(source, activity).toLowerCase()}`,
    lastUpdatedAt: cleanText(source.updatedAt),
    cards
  };
}

function canUseDocument() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

function noopMount() {
  return {
    update() {},
    destroy() {}
  };
}

function el(tagName, { className = '', text = '', attrs = {}, dataset = {} } = {}, children = []) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text) node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, value);
  }
  for (const [key, value] of Object.entries(dataset)) {
    node.dataset[key] = value;
  }
  for (const child of children) {
    node.appendChild(child);
  }
  return node;
}

function button(label, selectorName, ariaLabel = label) {
  return el('button', {
    className: 'recursion-button',
    text: label,
    attrs: { type: 'button', 'aria-label': ariaLabel },
    dataset: { [selectorName]: '' }
  });
}

function controlRow(label, control, note = '') {
  const row = el('label', { className: 'recursion-control-row' }, [
    el('span', { className: 'recursion-control-label', text: label }),
    control
  ]);
  if (note) row.appendChild(el('span', { className: 'recursion-control-note', text: note }));
  return row;
}

function selectControl({ value, options, dataset, ariaLabel }) {
  const select = el('select', {
    className: 'recursion-input recursion-select',
    attrs: { 'aria-label': ariaLabel },
    dataset
  });
  for (const [optionValue, label] of options) {
    const option = el('option', { text: label, attrs: { value: optionValue } });
    option.value = optionValue;
    if (optionValue === value) option.selected = true;
    select.appendChild(option);
  }
  select.value = value;
  return select;
}

function inputControl({ value = '', type = 'text', dataset, ariaLabel, min = null, max = null, step = null, placeholder = '' }) {
  const attrs = { type, 'aria-label': ariaLabel };
  if (min !== null) attrs.min = String(min);
  if (max !== null) attrs.max = String(max);
  if (step !== null) attrs.step = String(step);
  if (placeholder) attrs.placeholder = placeholder;
  const input = el('input', {
    className: 'recursion-input',
    attrs,
    dataset
  });
  input.value = String(value ?? '');
  return input;
}

function checkboxControl({ checked = false, dataset, ariaLabel, disabled = false }) {
  const input = el('input', {
    className: 'recursion-checkbox',
    attrs: { type: 'checkbox', 'aria-label': ariaLabel },
    dataset
  });
  input.checked = Boolean(checked);
  input.disabled = Boolean(disabled);
  if (disabled) input.setAttribute('disabled', 'disabled');
  return input;
}

function controlValue(root, selector) {
  return String(root.querySelector(selector)?.value ?? '').trim();
}

function controlNumber(root, selector, fallback) {
  const value = Number(controlValue(root, selector));
  return Number.isFinite(value) ? value : fallback;
}

function controlChecked(root, selector) {
  return root.querySelector(selector)?.checked === true;
}

function providerStatusText(provider) {
  const source = asObject(provider);
  const status = cleanText(source.lastTest?.status, 'not-run');
  const model = cleanText(source.resolvedModelLabel || source.openAICompatible?.model);
  const key = source.openAICompatible?.sessionApiKeyPresent ? 'session key loaded' : '';
  return [titleCase(status, 'Not Run'), model, key].filter(Boolean).join(' - ');
}

function setText(root, selector, text) {
  const target = root.querySelector(selector);
  if (target) target.textContent = text;
}

function renderChipList(container, chips) {
  container.replaceChildren();
  for (const chip of chips) {
    container.appendChild(el('span', { className: 'recursion-mini-chip', text: chip }));
  }
}

function renderHandDropdown(panel, view, model) {
  panel.replaceChildren();
  const cards = model.cards;
  panel.appendChild(el('div', {
    className: 'recursion-dropdown-title',
    text: `Last Hand - ${cards.length} card${cards.length === 1 ? '' : 's'} - composed by ${model.composerLabel}`
  }));
  if (!cards.length) {
    panel.appendChild(el('p', { className: 'recursion-empty', text: 'No hand has been composed for this chat.' }));
    return;
  }
  for (const card of cards) {
    const source = asObject(card);
    const row = el('button', {
      className: 'recursion-hand-row',
      attrs: { type: 'button' }
    }, [
      el('span', { className: 'recursion-hand-emphasis', text: titleCase(source.emphasis, 'Normal') }),
      el('span', { className: 'recursion-hand-family', text: cardFamily(source) }),
      el('span', { className: 'recursion-hand-summary', text: cardSummary(source) })
    ]);
    panel.appendChild(row);
  }
}

function renderActionMenu(panel, view, model) {
  const wasHidden = panel.hidden;
  panel.replaceChildren();
  const nextMode = model.mode === 'auto' ? 'observe' : 'auto';
  panel.appendChild(el('div', {
    className: 'recursion-dropdown-title',
    text: 'Actions'
  }));
  panel.appendChild(button('Refresh Scene', 'recursionActionRefresh', 'Refresh Recursion scene'));
  panel.appendChild(button(
    nextMode === 'observe' ? 'Switch to Observe only' : 'Switch to Auto',
    'recursionActionModeToggle',
    nextMode === 'observe' ? 'Switch Recursion to Observe only' : 'Switch Recursion to Auto'
  ));
  const copyButton = button('Copy Last Prompt Packet', 'recursionCopyPromptPacket', 'Copy last Recursion prompt packet');
  copyButton.disabled = !view.lastPacket;
  if (copyButton.disabled) copyButton.setAttribute('disabled', 'disabled');
  panel.appendChild(copyButton);
  panel.appendChild(button('Open Settings', 'recursionSettingsToggle', 'Open Recursion settings'));
  panel.appendChild(button('Open Viewer', 'recursionViewerToggle', 'Open Recursion viewer'));
  panel.hidden = wasHidden;
}

function settingsSelectRow(label, datasetName, value, options) {
  return controlRow(label, selectControl({
    value,
    options,
    dataset: { [datasetName]: '' },
    ariaLabel: label
  }));
}

function renderHighLevelSettings(panel, settings) {
  const group = el('section', { className: 'recursion-settings-group' });
  group.appendChild(el('h3', { text: 'Behavior' }));
  group.appendChild(settingsSelectRow('Mode', 'recursionSettingMode', cleanText(settings.mode, 'observe'), MODE_OPTIONS));
  group.appendChild(settingsSelectRow('Strength', 'recursionSettingStrength', cleanText(settings.strength, 'balanced'), STRENGTH_OPTIONS));
  group.appendChild(settingsSelectRow('Prompt Footprint', 'recursionSettingFootprint', cleanText(settings.promptFootprint, 'normal'), FOOTPRINT_OPTIONS));
  group.appendChild(settingsSelectRow('Focus', 'recursionSettingFocus', cleanText(settings.focus, 'balanced'), FOCUS_OPTIONS));
  group.appendChild(settingsSelectRow('Reasoner Use', 'recursionSettingReasoner', cleanText(settings.reasonerUse, 'auto'), REASONER_OPTIONS));
  group.appendChild(button('Save Settings', 'recursionSettingsSave', 'Save Recursion settings'));
  panel.appendChild(group);
}

function providerDataset(name, lane) {
  const suffix = titleCase(lane).replace(/\s+/g, '');
  return { [`recursionProvider${name}${suffix}`]: '' };
}

function providerSelector(name, lane) {
  return `[data-recursion-provider-${name}-${lane}]`;
}

function renderProviderSettings(panel, lane, provider) {
  const source = asObject(provider);
  const title = lane === 'reasoner' ? 'Reasoner Provider' : 'Utility Provider';
  const group = el('section', {
    className: 'recursion-settings-group recursion-provider-card',
    dataset: { recursionProviderLane: lane }
  });
  group.appendChild(el('h3', { text: title }));
  group.appendChild(controlRow(
    'Enabled',
    checkboxControl({
      checked: lane === 'utility' ? true : source.enabled === true,
      disabled: lane === 'utility',
      dataset: providerDataset('Enabled', lane),
      ariaLabel: `${title} enabled`
    }),
    lane === 'utility' ? 'Utility stays on for fallback planning.' : ''
  ));
  group.appendChild(controlRow('Source', selectControl({
    value: cleanText(source.source, 'host-current-model'),
    options: PROVIDER_SOURCE_OPTIONS,
    dataset: providerDataset('Source', lane),
    ariaLabel: `${title} source`
  })));
  group.appendChild(controlRow('Profile', inputControl({
    value: source.hostConnectionProfileId || '',
    dataset: providerDataset('Profile', lane),
    ariaLabel: `${title} host connection profile`,
    placeholder: 'Host profile id'
  })));
  group.appendChild(controlRow('Base URL', inputControl({
    value: source.openAICompatible?.baseUrl || '',
    dataset: providerDataset('BaseUrl', lane),
    ariaLabel: `${title} OpenAI-compatible base URL`,
    placeholder: 'https://host/v1'
  })));
  group.appendChild(controlRow('Model', inputControl({
    value: source.openAICompatible?.model || '',
    dataset: providerDataset('Model', lane),
    ariaLabel: `${title} model`,
    placeholder: 'model'
  })));
  group.appendChild(controlRow('Session Key', inputControl({
    value: '',
    type: 'password',
    dataset: providerDataset('ApiKey', lane),
    ariaLabel: `${title} session API key`,
    placeholder: source.openAICompatible?.sessionApiKeyPresent ? 'Session key loaded' : 'Session API key'
  }), 'Session-only; never saved to settings.'));
  group.appendChild(controlRow('Temperature', inputControl({
    value: source.temperature ?? '',
    type: 'number',
    min: 0,
    max: 2,
    step: 0.1,
    dataset: providerDataset('Temperature', lane),
    ariaLabel: `${title} temperature`
  })));
  group.appendChild(controlRow('Top P', inputControl({
    value: source.topP ?? '',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    dataset: providerDataset('TopP', lane),
    ariaLabel: `${title} top p`
  })));
  group.appendChild(controlRow('Max Tokens', inputControl({
    value: source.maxTokens ?? '',
    type: 'number',
    min: 64,
    step: 64,
    dataset: providerDataset('MaxTokens', lane),
    ariaLabel: `${title} max tokens`
  })));
  group.appendChild(el('div', { className: 'recursion-provider-actions' }, [
    el('button', {
      className: 'recursion-button',
      text: 'Save Provider',
      attrs: { type: 'button', 'aria-label': `Save ${title}` },
      dataset: {
        recursionProviderSave: '',
        [`recursion${titleCase(lane)}ProviderSave`]: '',
        recursionProviderLane: lane
      }
    }),
    el('button', {
      className: 'recursion-button',
      text: 'Test Provider',
      attrs: { type: 'button', 'aria-label': `Test ${title}` },
      dataset: {
        recursionProviderTest: '',
        [`recursion${titleCase(lane)}ProviderTest`]: '',
        recursionProviderLane: lane
      }
    }),
    el('button', {
      className: 'recursion-button',
      text: 'Clear Session Key',
      attrs: { type: 'button', 'aria-label': `Clear ${title} session key` },
      dataset: {
        recursionProviderClearKey: '',
        [`recursion${titleCase(lane)}ProviderClearKey`]: '',
        recursionProviderLane: lane
      }
    })
  ]));
  group.appendChild(el('p', {
    className: 'recursion-provider-status',
    text: providerStatusText(source),
    dataset: providerDataset('Status', lane)
  }));
  panel.appendChild(group);
}

function renderSettingsPanel(panel, view) {
  panel.replaceChildren();
  const settings = asObject(view.settings);
  panel.appendChild(el('div', { className: 'recursion-settings-header' }, [
    el('h2', { text: 'Recursion Settings' }),
    button('Close', 'recursionSettingsClose', 'Close Recursion settings')
  ]));
  renderHighLevelSettings(panel, settings);
  renderProviderSettings(panel, 'utility', settings.providers?.utility || {});
  renderProviderSettings(panel, 'reasoner', settings.providers?.reasoner || {});
}

function appendViewerSection(viewer, title, data, options = {}) {
  const section = el('section', { className: 'recursion-viewer-section' });
  section.appendChild(el('h3', { text: title }));
  const pre = el('pre', { dataset: asObject(options).dataset || {} });
  pre.textContent = safeJson(data);
  section.appendChild(pre);
  viewer.appendChild(section);
}

function safeJson(value) {
  const visiting = new WeakSet();
  try {
    return JSON.stringify(safeViewerValue(redact(value, { maxString: 900 }), visiting), null, 2);
  } catch {
    return JSON.stringify({ unavailable: true }, null, 2);
  }
}

function safeViewerValue(value, visiting, depth = 0) {
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return safeText(value);
  if (!value || typeof value !== 'object') return value;
  if (visiting.has(value)) return '[Circular]';
  if (depth >= 6) return '[Truncated]';
  visiting.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, 50).map((entry) => safeViewerValue(entry, visiting, depth + 1));
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      if (isSensitiveViewerKey(key)) {
        output[key] = '[redacted]';
        continue;
      }
      output[key] = safeViewerValue(child, visiting, depth + 1);
    }
    return output;
  } finally {
    visiting.delete(value);
  }
}

function isSensitiveViewerKey(key) {
  const normalized = String(key || '').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
  return ['sections', 'prompt', 'prompttext', 'rawprompt', 'rawresponse', 'apikey', 'authorization', 'cookie', 'password', 'secret'].includes(normalized);
}

function promptPacketPreview(packet, hand = {}) {
  const source = asObject(packet);
  const handSource = asObject(hand);
  return {
    packetId: source.packetId || '',
    handId: source.handId || handSource.handId || '',
    chatId: source.chatId || '',
    sceneKey: source.sceneKey || '',
    selectedCardRefs: source.selectedCardRefs || [],
    omissions: source.omissions || [],
    injectionPlan: source.injectionPlan || [],
    diagnostics: source.diagnostics || null,
    composedAt: source.composedAt || ''
  };
}

function renderViewer(viewer, view, model) {
  viewer.replaceChildren();
  const header = el('div', { className: 'recursion-viewer-header' }, [
    el('h2', { text: 'Recursion Viewer' }),
    button('Close', 'recursionViewerClose', 'Close Recursion viewer')
  ]);
  viewer.appendChild(header);
  appendViewerSection(viewer, 'Now', {
    status: model.runtimeHealthLabel,
    mode: model.modeLabel,
    composer: model.composerLabel,
    reasoner: model.reasonerState,
    activity: model.activityLabel
  });
  appendViewerSection(viewer, 'Deck', view.lastHand ?? { cards: [] });
  appendViewerSection(viewer, 'Activity', view.activity ?? null);
  appendViewerSection(viewer, 'Prompt Packet', promptPacketPreview(view.lastPacket, view.lastHand), {
    dataset: { recursionPromptPacket: '' }
  });
  appendViewerSection(viewer, 'Settings', view.settings ?? null);
  appendViewerSection(viewer, 'Providers', view.settings?.providers ?? null);
}

function buildRoot() {
  const root = el('section', {
    className: 'recursion-root',
    attrs: { id: 'recursion-root' }
  });

  const bar = el('div', {
    className: 'recursion-bar',
    attrs: { role: 'toolbar', 'aria-label': 'Recursion' },
    dataset: { recursionBar: '' }
  }, [
    el('strong', { className: 'recursion-brand', text: 'Recursion' }),
    el('span', { className: 'recursion-status recursion-chip', dataset: { recursionStatus: '' } }),
    el('span', { className: 'recursion-chip recursion-mode-chip', dataset: { recursionMode: '' } }),
    el('span', { className: 'recursion-chip', dataset: { recursionHandCount: '' } }),
    el('span', { className: 'recursion-chip', dataset: { recursionComposer: '' } }),
    el('span', { className: 'recursion-chip recursion-reasoner-chip', dataset: { recursionReasoner: '' } }),
    el('div', { className: 'recursion-actions' }, [
      button('Actions', 'recursionActions', 'Refresh Recursion scene'),
      button('Hand', 'recursionHandToggle', 'Toggle last hand'),
      button('Open', 'recursionViewerToggle', 'Open Recursion viewer')
    ])
  ]);

  const ribbon = el('div', {
    className: 'recursion-activity-ribbon',
    attrs: { role: 'status', 'aria-live': 'polite' },
    dataset: { recursionActivityRibbon: '', recursionRibbon: '' }
  }, [
    el('span', { className: 'recursion-pulse', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'recursion-ribbon-label', dataset: { recursionRibbonLabel: '' } }),
    el('span', { className: 'recursion-ribbon-chips', dataset: { recursionRibbonChips: '' } })
  ]);

  const actionMenu = el('div', {
    className: 'recursion-action-menu',
    dataset: { recursionActionMenu: '' }
  });
  actionMenu.hidden = true;

  const hand = el('div', {
    className: 'recursion-hand-dropdown',
    dataset: { recursionHandDropdown: '', recursionHand: '' }
  });
  hand.hidden = true;

  const settingsPanel = el('div', {
    className: 'recursion-settings-panel',
    dataset: { recursionSettingsPanel: '' }
  });
  settingsPanel.hidden = true;

  const viewer = el('dialog', {
    className: 'recursion-viewer',
    attrs: { 'aria-label': 'Recursion Viewer' },
    dataset: { recursionViewer: '' }
  }, [
    button('Close', 'recursionViewerClose', 'Close Recursion viewer')
  ]);

  root.appendChild(bar);
  root.appendChild(ribbon);
  root.appendChild(actionMenu);
  root.appendChild(hand);
  root.appendChild(settingsPanel);
  root.appendChild(viewer);
  return root;
}

function insertionParent(mountPoint) {
  if (mountPoint) return mountPoint;
  const chat = document.getElementById?.('chat');
  return chat?.parentElement || document.body;
}

function insertRoot(root, mountPoint) {
  const parent = insertionParent(mountPoint);
  if (!parent) return;
  const chat = document.getElementById?.('chat');
  if (chat && chat.parentElement === parent) {
    parent.insertBefore(root, chat);
    return;
  }
  parent.insertBefore(root, parent.firstChild ?? null);
}

export function mountRecursionUi({ runtime, mountPoint = null } = {}) {
  if (!canUseDocument()) return noopMount();

  const root = buildRoot();
  insertRoot(root, mountPoint);
  const actionMenu = root.querySelector('[data-recursion-action-menu]');
  const handPanel = root.querySelector('[data-recursion-hand-dropdown]');
  const settingsPanel = root.querySelector('[data-recursion-settings-panel]');
  const viewer = root.querySelector('[data-recursion-viewer]');
  const ribbon = root.querySelector('[data-recursion-activity-ribbon]');
  let settingsPanelRendered = false;
  let ribbonVisible = false;
  let ribbonRevealTimer = null;
  let ribbonSuccessTimer = null;
  let ribbonSuccessTimerKey = '';
  let collapsedSuccessKey = '';

  function clearRibbonRevealTimer() {
    if (ribbonRevealTimer !== null && typeof clearTimeout === 'function') clearTimeout(ribbonRevealTimer);
    ribbonRevealTimer = null;
  }

  function clearRibbonSuccessTimer() {
    if (ribbonSuccessTimer !== null && typeof clearTimeout === 'function') clearTimeout(ribbonSuccessTimer);
    ribbonSuccessTimer = null;
    ribbonSuccessTimerKey = '';
  }

  function setRibbonVisible(nextVisible) {
    ribbonVisible = Boolean(nextVisible);
    ribbon.hidden = !ribbonVisible;
  }

  function ribbonActivityKey(view, model) {
    const activity = view.activity || {};
    const chips = Array.isArray(activity.chips) ? activity.chips.join(',') : '';
    return [
      activity.runId || '',
      activity.recordedAt || '',
      activity.phase || '',
      model.activitySeverity || '',
      model.activityLabel || '',
      chips
    ].map((entry) => String(entry)).join('|');
  }

  function updateRibbonVisibility(view, model) {
    const phase = view.activity?.phase;
    const severity = model.activitySeverity;
    const hasLabel = model.activityLabel !== '';
    const idle = !hasLabel || phase === 'idle';

    if (idle) {
      clearRibbonRevealTimer();
      clearRibbonSuccessTimer();
      collapsedSuccessKey = '';
      setRibbonVisible(false);
      return;
    }

    if (severity === 'warning' || severity === 'error') {
      clearRibbonRevealTimer();
      clearRibbonSuccessTimer();
      collapsedSuccessKey = '';
      setRibbonVisible(true);
      return;
    }

    if (severity === 'success' || phase === 'settled') {
      const successKey = ribbonActivityKey(view, model);
      clearRibbonRevealTimer();
      if (collapsedSuccessKey === successKey) {
        clearRibbonSuccessTimer();
        setRibbonVisible(false);
        return;
      }
      setRibbonVisible(true);
      if (ribbonSuccessTimerKey !== successKey) clearRibbonSuccessTimer();
      if (ribbonSuccessTimer === null && typeof setTimeout === 'function') {
        ribbonSuccessTimerKey = successKey;
        ribbonSuccessTimer = setTimeout(() => {
          ribbonSuccessTimer = null;
          ribbonSuccessTimerKey = '';
          collapsedSuccessKey = successKey;
          setRibbonVisible(false);
        }, 2000);
      }
      return;
    }

    collapsedSuccessKey = '';
    clearRibbonSuccessTimer();
    if (ribbonVisible || ribbonRevealTimer !== null) return;
    setRibbonVisible(false);
    if (typeof setTimeout !== 'function') return;
    ribbonRevealTimer = setTimeout(() => {
      ribbonRevealTimer = null;
      setRibbonVisible(true);
    }, 350);
  }

  root.querySelector('[data-recursion-actions]')?.addEventListener('click', () => {
    actionMenu.hidden = !actionMenu.hidden;
  });
  root.querySelector('[data-recursion-hand-toggle]')?.addEventListener('click', () => {
    handPanel.hidden = !handPanel.hidden;
  });
  root.addEventListener('click', (event) => {
    const dataset = event?.target?.dataset || {};
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionViewerClose')) {
      if (typeof viewer.close === 'function') viewer.close();
      else viewer.hidden = true;
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionViewerToggle')) {
      openViewer();
      actionMenu.hidden = true;
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionSettingsClose')) {
      settingsPanel.hidden = true;
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionActionRefresh')) {
      runAction(runtime?.refreshScene?.());
      actionMenu.hidden = true;
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionActionModeToggle')) {
      const mode = cleanText(currentView().settings?.mode, 'observe').toLowerCase();
      runAction(runtime?.updateSettings?.({ mode: mode === 'auto' ? 'observe' : 'auto' }));
      actionMenu.hidden = true;
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionCopyPromptPacket')) {
      const view = currentView();
      const packetText = safeJson(promptPacketPreview(view.lastPacket, view.lastHand));
      runAction(globalThis.navigator?.clipboard?.writeText?.(packetText));
      actionMenu.hidden = true;
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionSettingsToggle')) {
      settingsPanel.hidden = !settingsPanel.hidden;
      if (!settingsPanel.hidden) {
        settingsPanelRendered = false;
        update();
      }
      actionMenu.hidden = true;
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionSettingsSave')) {
      runAction(runtime?.updateSettings?.(readSettingsPatch(root)));
      settingsPanelRendered = false;
      update();
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionProviderSave')) {
      const lane = providerLaneFromDataset(dataset);
      runAction(runtime?.updateProvider?.(lane, readProviderPatch(root, lane)));
      settingsPanelRendered = false;
      update();
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionProviderTest')) {
      const lane = providerLaneFromDataset(dataset);
      runAction(runtime?.testProvider?.(lane), () => {
        settingsPanelRendered = false;
        update();
      });
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionProviderClearKey')) {
      const lane = providerLaneFromDataset(dataset);
      runAction(runtime?.clearProviderKey?.(lane));
      settingsPanelRendered = false;
      update();
    }
  });

  function runAction(result, after = null) {
    if (result && typeof result.then === 'function') {
      result.then(() => after?.()).catch(() => {});
      return;
    }
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
      return;
    }
    after?.();
  }

  function openViewer() {
    if (typeof viewer.showModal === 'function') {
      if (!viewer.open) viewer.showModal();
      return;
    }
    if (viewer.hidden === false) return;
    viewer.hidden = false;
  }

  function providerLaneFromDataset(dataset) {
    return dataset.recursionProviderLane === 'reasoner' ? 'reasoner' : 'utility';
  }

  function readSettingsPatch(sourceRoot) {
    return {
      mode: controlValue(sourceRoot, '[data-recursion-setting-mode]'),
      strength: controlValue(sourceRoot, '[data-recursion-setting-strength]'),
      promptFootprint: controlValue(sourceRoot, '[data-recursion-setting-footprint]'),
      focus: controlValue(sourceRoot, '[data-recursion-setting-focus]'),
      reasonerUse: controlValue(sourceRoot, '[data-recursion-setting-reasoner]')
    };
  }

  function readProviderPatch(sourceRoot, lane) {
    const apiKey = controlValue(sourceRoot, providerSelector('api-key', lane));
    const patch = {
      enabled: lane === 'utility' ? true : controlChecked(sourceRoot, providerSelector('enabled', lane)),
      source: controlValue(sourceRoot, providerSelector('source', lane)),
      hostConnectionProfileId: controlValue(sourceRoot, providerSelector('profile', lane)),
      openAICompatible: {
        baseUrl: controlValue(sourceRoot, providerSelector('base-url', lane)),
        model: controlValue(sourceRoot, providerSelector('model', lane))
      },
      temperature: controlNumber(sourceRoot, providerSelector('temperature', lane), lane === 'reasoner' ? 0.4 : 0.1),
      topP: controlNumber(sourceRoot, providerSelector('top-p', lane), 0.95),
      maxTokens: controlNumber(sourceRoot, providerSelector('max-tokens', lane), 4096)
    };
    if (apiKey) patch.apiKey = apiKey;
    return patch;
  }

  function currentView() {
    try {
      return typeof runtime?.view === 'function' ? runtime.view() : {};
    } catch (error) {
      return {
        settings: { mode: 'observe' },
        activity: {
          phase: 'runtimeViewFailed',
          severity: 'error',
          label: cleanText(error?.message || error, 'Recursion view unavailable.')
        }
      };
    }
  }

  function update() {
    const view = currentView();
    const model = createRecursionViewModel(view);
    setText(root, '[data-recursion-status]', model.runtimeHealthLabel);
    setText(root, '[data-recursion-mode]', model.modeLabel);
    setText(root, '[data-recursion-hand-count]', `Hand ${model.handCount}`);
    setText(root, '[data-recursion-composer]', model.composerLabel);
    setText(root, '[data-recursion-reasoner]', model.reasonerLabel);
    setText(root, '[data-recursion-ribbon-label]', model.activityLabel);
    ribbon.dataset.recursionSeverity = model.activitySeverity;
    updateRibbonVisibility(view, model);
    renderChipList(root.querySelector('[data-recursion-ribbon-chips]'), model.activityChips);
    renderActionMenu(actionMenu, view, model);
    renderHandDropdown(handPanel, view, model);
    if (!settingsPanel.hidden && !settingsPanelRendered) {
      renderSettingsPanel(settingsPanel, view);
      settingsPanelRendered = true;
    }
    renderViewer(viewer, view, model);
  }

  update();
  const timer = typeof setInterval === 'function' ? setInterval(update, 500) : null;
  return {
    root,
    update,
    destroy() {
      if (timer !== null && typeof clearInterval === 'function') clearInterval(timer);
      clearRibbonRevealTimer();
      clearRibbonSuccessTimer();
      root.remove();
    }
  };
}
