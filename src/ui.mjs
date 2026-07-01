import { redact } from './core.mjs';
import { packetToPromptBlocks } from './prompt.mjs';
import { createHeroPixelBlocks, createProgressRunModel } from './progress.mjs';
import { DEFAULT_RECURSION_SETTINGS } from './settings.mjs';

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
const REASONING_LEVEL_OPTIONS = Object.freeze([
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['ultra', 'Ultra']
]);
const REASONING_LEVELS = Object.freeze(REASONING_LEVEL_OPTIONS.map(([value]) => value));
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

function modeIcon(value) {
  const mode = cleanText(value, 'observe').toLowerCase();
  if (mode === 'off') return 'power';
  if (mode === 'auto') return 'cards';
  return 'eye';
}

function reasonerUseForReasoningLevel(value) {
  const level = cleanText(value, 'high').toLowerCase();
  if (level === 'low') return 'off';
  if (level === 'ultra') return 'always';
  return 'auto';
}

function normalizeReasoningLevel(value) {
  const level = cleanText(value, 'high').toLowerCase();
  return REASONING_LEVELS.includes(level) ? level : 'high';
}

function providerMark(providerLane) {
  return providerLane === 'reasoner' ? 'R' : 'U';
}

function cardSummary(card) {
  const source = asObject(card);
  return cleanText(source.summary || source.promptText || source.text || source.id, 'Untitled card');
}

function cardText(card) {
  const source = asObject(card);
  return cleanText(source.promptText || source.text || source.summary || '', '');
}

function cardFamily(card) {
  const source = asObject(card);
  return cleanText(source.family || source.type || source.kind, 'Card');
}

function cardFamilyIcon(family) {
  const normalized = cleanText(family, '').toLowerCase();
  if (normalized.includes('continuity')) return '!';
  if (normalized.includes('motivation')) return '?';
  if (normalized.includes('dialogue') || normalized.includes('relationship')) return '"';
  if (normalized.includes('thread')) return '...';
  if (normalized.includes('cast')) return '@';
  if (normalized.includes('environment') || normalized.includes('item')) return '+';
  if (normalized.includes('prose') || normalized.includes('pacing')) return '~';
  return '#';
}

function cardMetaChips(card) {
  const source = asObject(card);
  const chips = [
    source.status,
    source.source,
    source.provenance,
    source.detailProfile,
    source.target,
    source.sceneKey ? 'scene' : '',
    source.turnId ? 'turn' : ''
  ].map((entry) => cleanText(entry, ''))
    .filter(Boolean);
  return [...new Set(chips)].slice(0, 5);
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
  const progressRun = createProgressRunModel(source);
  const heroPixelBlocks = createHeroPixelBlocks(progressRun);
  const defaultUi = DEFAULT_RECURSION_SETTINGS.ui;
  const progressChildVisibleLimit = integerInRange(settings.ui?.progressChildVisibleLimit, defaultUi.progressChildVisibleLimit, 1, 20);
  const progressListVisibleLimit = integerInRange(settings.ui?.progressListVisibleLimit, defaultUi.progressListVisibleLimit, 5, 80);
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
    progressRun,
    currentStepText: progressRun.currentStepText,
    heroPixelBlocks,
    heroPixelColumnCount: heroPixelBlocks.at(-1)?.columnCount || 0,
    progressChildVisibleLimit,
    progressListVisibleLimit,
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

function integerInRange(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
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

function renderHeroPixelArray(container, blocks = []) {
  if (!container) return;
  const columnCount = blocks.at(-1)?.columnCount || 0;
  for (const target of [container.parentNode, container]) {
    target?.style?.setProperty?.('--columns', String(columnCount));
    target?.style?.setProperty?.('--block-count', String(blocks.length));
  }
  const visibleIds = new Set(blocks.map((block, index) => block.id || `hero-block-${index}`));
  for (const node of [...container.querySelectorAll('[data-recursion-hero-block]')]) {
    if (!visibleIds.has(node.dataset.recursionHeroBlockId || '')) node.remove();
  }
  blocks.forEach((block, index) => {
    const blockId = block.id || `hero-block-${index}`;
    let node = [...container.querySelectorAll('[data-recursion-hero-block]')]
      .find((candidate) => candidate.dataset.recursionHeroBlockId === blockId);
    if (!node) {
      node = el('span', {
        attrs: { 'aria-hidden': 'true' },
        dataset: {
          recursionHeroBlock: '',
          recursionHeroBlockId: blockId
        }
      });
    }
    const state = block.state || 'pending';
    const className = block.className || `hero-block ${state}`;
    if (node.className !== className) node.className = className;
    node.dataset.recursionHeroBlockState = state;
    node.style?.setProperty?.('--block-index', String(index));
    node.style.gridRow = String((Number(block.row) || 0) + 1);
    node.style.gridColumn = String((Number(block.column) || 0) + 1);
    const before = container.children[index] || null;
    if (before !== node) {
      if (node.parentNode === container) node.remove();
      container.insertBefore(node, before);
    }
  });
}

function renderProgressRow(step, child = false) {
  const row = el('div', {
    className: `recursion-step-row ${child ? 'child-row ' : ''}${step.state || 'pending'}`,
    dataset: {
      recursionProgressRow: '',
      recursionProgressStepId: step.id || '',
      recursionProgressProvider: step.providerLane || 'utility'
    }
  }, [
    el('span', { className: 'recursion-provider-mark', text: providerMark(step.providerLane) }),
    el('span', { className: 'recursion-step-separator', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'recursion-step-icon', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'recursion-step-label', text: step.label || 'Step' }),
    el('span', { className: 'recursion-step-meta', text: step.meta || '' })
  ]);
  return row;
}

function syncScrollableChildFade(group) {
  if (!group) return;
  const scrollTop = Number(group.scrollTop || 0);
  const scrollHeight = Number(group.scrollHeight || 0);
  const clientHeight = Number(group.clientHeight || 0);
  const atEnd = scrollHeight > 0 && clientHeight > 0 && scrollTop + clientHeight >= scrollHeight - 1;
  const base = 'recursion-step-children is-scrollable';
  group.className = atEnd ? `${base} is-at-end` : base;
}

function renderProgressPopover(panel, progressRun, model) {
  const previousList = typeof panel.querySelector === 'function'
    ? panel.querySelector('[data-recursion-progress-list]')
    : null;
  const previousScrollTop = Number(previousList?.scrollTop || 0);
  const previousChildScrollTops = new Map(Array.from(panel.querySelectorAll?.('[data-recursion-progress-children]') || [])
    .map((group) => [group.dataset?.recursionProgressParentStep, Number(group.scrollTop || 0)])
    .filter(([id]) => Boolean(id)));
  panel.replaceChildren();
  panel.appendChild(el('div', { className: 'recursion-status-head' }, [
    el('span', { className: 'recursion-status-title', text: progressRun.title || 'Generating' }),
    el('span', { className: 'recursion-status-subtitle', text: progressRun.subtitle || model.currentStepText || '' })
  ]));
  const list = el('div', {
    className: 'recursion-status-list',
    dataset: { recursionProgressList: '' }
  });
  list.style = list.style || {};
  list.style.setProperty?.('--recursion-progress-list-limit', String(model.progressListVisibleLimit || 15));
  for (const step of progressRun.steps || []) {
    list.appendChild(renderProgressRow(step));
    if (Array.isArray(step.children) && step.children.length) {
      const childLimit = model.progressChildVisibleLimit || 5;
      const scrollable = step.children.length > childLimit;
      const group = el('div', {
        className: `recursion-step-children${scrollable ? ' is-scrollable' : ''}`,
        dataset: {
          recursionProgressChildren: '',
          recursionProgressParentStep: step.id || '',
          recursionProgressChildCount: String(step.children.length)
        }
      });
      group.style = group.style || {};
      group.style.setProperty?.('--recursion-progress-child-limit', String(childLimit));
      for (const child of step.children) group.appendChild(renderProgressRow(child, true));
      const previousChildScrollTop = previousChildScrollTops.get(step.id || '');
      if (previousChildScrollTop > 0) group.scrollTop = previousChildScrollTop;
      if (scrollable) {
        group.addEventListener?.('scroll', () => syncScrollableChildFade(group));
        syncScrollableChildFade(group);
      }
      list.appendChild(group);
    }
  }
  if (previousScrollTop > 0) list.scrollTop = previousScrollTop;
  panel.appendChild(list);
  panel.appendChild(el('div', { className: 'recursion-status-foot' }, [
    el('span', { text: `${model.modeLabel} - ${model.composerLabel} lane` }),
    el('span', { className: 'recursion-mini-chip', text: 'Live' })
  ]));
}

function renderReasoningChain(root, reasoningLevel) {
  const level = normalizeReasoningLevel(reasoningLevel);
  const selectedIndex = REASONING_LEVELS.indexOf(level);
  const chain = root.querySelector('[data-recursion-reasoning-chain]');
  if (chain) chain.dataset.recursionReasoningSelected = level;
  for (const [index, candidate] of REASONING_LEVELS.entries()) {
    const node = root.querySelector(`[data-recursion-reasoning-level-${candidate}]`);
    if (!node) continue;
    const selected = candidate === level;
    node.className = [
      'recursion-reasoning-node',
      index <= selectedIndex ? 'is-lit' : '',
      selected ? 'is-selected' : ''
    ].filter(Boolean).join(' ');
    node.setAttribute('aria-checked', selected ? 'true' : 'false');
  }
}

function briefCardDomId(card, index) {
  const source = asObject(card);
  return cleanText(source.id || source.cardId || source.refId || `${cardFamily(source)}-${index}`, `card-${index}`);
}

function renderHandDropdown(panel, view, model) {
  const packetPanelWasOpen = panel.querySelector?.('[data-recursion-prompt-packet-panel]')?.hidden === false;
  const previousBriefScrollTop = Number(panel.querySelector?.('[data-recursion-brief-scroll]')?.scrollTop || 0);
  const previousPacketScrollTop = Number(panel.querySelector?.('[data-recursion-prompt-packet-preview]')?.scrollTop || 0);
  const expandedCards = new Set(Array.from(panel.querySelectorAll?.('[data-recursion-brief-card-id]') || [])
    .filter((row) => row.getAttribute?.('aria-expanded') === 'true')
    .map((row) => row.dataset?.recursionBriefCardId)
    .filter(Boolean));
  panel.replaceChildren();
  const cards = model.cards;
  const packetButton = el('button', {
    className: 'recursion-prompt-packet-button',
    text: 'Prompt Packet',
    attrs: { type: 'button', 'aria-label': 'Open last prompt packet', 'aria-expanded': packetPanelWasOpen ? 'true' : 'false' },
    dataset: { recursionPromptPacketButton: '' }
  });
  if (!view.lastPacket) {
    packetButton.disabled = true;
    packetButton.setAttribute('disabled', 'disabled');
    packetButton.setAttribute('title', 'No prompt packet has been composed yet.');
  }
  panel.appendChild(el('div', { className: 'recursion-brief-head' }, [
    el('span', {
      className: 'recursion-dropdown-title',
      text: `Last brief - ${cards.length} card${cards.length === 1 ? '' : 's'}`
    }),
    el('span', { className: 'recursion-brief-summary', text: `composed by ${model.composerLabel}` }),
    packetButton
  ]));
  const packetPanel = el('section', {
    className: 'recursion-prompt-packet-panel',
    attrs: { 'aria-label': 'Injected prompt packet' },
    dataset: { recursionPromptPacketPanel: '' }
  }, [
    el('div', { className: 'recursion-packet-head' }, [
      el('span', { text: 'Injected prompt packet' }),
      button('Copy', 'recursionCopyPromptPacket', 'Copy last Recursion prompt packet')
    ]),
    el('pre', { className: 'recursion-packet-text', text: safeJson(promptPacketPreview(view.lastPacket, view.lastHand), { maxString: 5000 }), dataset: { recursionPromptPacketPreview: '' } })
  ]);
  packetPanel.hidden = !packetPanelWasOpen || !view.lastPacket;
  const packetText = packetPanel.querySelector?.('[data-recursion-prompt-packet-preview]');
  if (previousPacketScrollTop > 0 && packetText) packetText.scrollTop = previousPacketScrollTop;
  packetButton.addEventListener?.('click', () => {
    if (!view.lastPacket) return;
    packetPanel.hidden = !packetPanel.hidden;
    packetButton.setAttribute('aria-expanded', packetPanel.hidden ? 'false' : 'true');
  });
  panel.appendChild(packetPanel);
  if (!cards.length) {
    panel.appendChild(el('p', { className: 'recursion-empty', text: 'No hand has been composed for this chat.' }));
    return;
  }
  const scroll = el('div', { className: 'recursion-brief-scroll', dataset: { recursionBriefScroll: '' } });
  for (const [index, card] of cards.entries()) {
    const source = asObject(card);
    const cardDomId = briefCardDomId(source, index);
    const expanded = expandedCards.has(cardDomId);
    const family = cardFamily(source);
    const metaChips = cardMetaChips(source);
    const row = el('button', {
      className: 'recursion-hand-row recursion-brief-card',
      attrs: { type: 'button', 'aria-expanded': expanded ? 'true' : 'false' },
      dataset: { recursionBriefCardId: cardDomId }
    }, [
      el('span', {
        className: 'recursion-hand-icon',
        text: cardFamilyIcon(family),
        attrs: { title: family, 'aria-hidden': 'true' }
      }),
      el('span', { className: 'recursion-hand-emphasis', text: titleCase(source.emphasis, 'Normal') }),
      el('span', { className: 'recursion-hand-family', text: family }),
      el('span', { className: 'recursion-hand-summary', text: cardSummary(source) }),
      el('span', { className: 'recursion-brief-detail', text: cardText(source) || cardSummary(source) }),
      el('span', { className: 'recursion-brief-meta' }, metaChips.map((chip) => el('span', { className: 'recursion-mini-chip', text: chip })))
    ]);
    row.addEventListener?.('click', () => {
      const next = row.getAttribute('aria-expanded') !== 'true';
      row.setAttribute('aria-expanded', next ? 'true' : 'false');
    });
    scroll.appendChild(row);
  }
  panel.appendChild(scroll);
  if (previousBriefScrollTop > 0) scroll.scrollTop = previousBriefScrollTop;
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
  group.appendChild(settingsSelectRow('Reasoning Level', 'recursionSettingReasoningLevel', normalizeReasoningLevel(settings.reasoningLevel), REASONING_LEVEL_OPTIONS));
  group.appendChild(settingsSelectRow('Strength', 'recursionSettingStrength', cleanText(settings.strength, 'balanced'), STRENGTH_OPTIONS));
  group.appendChild(settingsSelectRow('Prompt Footprint', 'recursionSettingFootprint', cleanText(settings.promptFootprint, 'normal'), FOOTPRINT_OPTIONS));
  group.appendChild(settingsSelectRow('Focus', 'recursionSettingFocus', cleanText(settings.focus, 'balanced'), FOCUS_OPTIONS));
  panel.appendChild(group);
}

function renderAdvancedSettings(panel, settings) {
  const group = el('section', { className: 'recursion-settings-group' });
  const ui = asObject(settings.ui);
  const diagnostics = asObject(settings.diagnostics);
  const defaultUi = DEFAULT_RECURSION_SETTINGS.ui;
  group.appendChild(el('h3', { text: 'Advanced' }));
  group.appendChild(controlRow('Sub-tier Rows', inputControl({
    value: integerInRange(ui.progressChildVisibleLimit, defaultUi.progressChildVisibleLimit, 1, 20),
    type: 'number',
    min: 1,
    max: 20,
    step: 1,
    dataset: { recursionSettingProgressChildLimit: '' },
    ariaLabel: 'Visible sub-tier progress rows'
  })));
  group.appendChild(controlRow('Progress Rows', inputControl({
    value: integerInRange(ui.progressListVisibleLimit, defaultUi.progressListVisibleLimit, 5, 80),
    type: 'number',
    min: 5,
    max: 80,
    step: 1,
    dataset: { recursionSettingProgressListLimit: '' },
    ariaLabel: 'Visible progress rows before scrolling'
  })));
  group.appendChild(controlRow('Journal Entries', inputControl({
    value: integerInRange(diagnostics.maxJournalEntries, 100, 10, 500),
    type: 'number',
    min: 10,
    max: 500,
    step: 10,
    dataset: { recursionSettingJournalLimit: '' },
    ariaLabel: 'Maximum diagnostic journal entries'
  })));
  group.appendChild(controlRow('Include Excerpts', checkboxControl({
    checked: diagnostics.includeExcerpts === true,
    dataset: { recursionSettingIncludeExcerpts: '' },
    ariaLabel: 'Include sanitized excerpts in diagnostics'
  })));
  const unavailableActions = [
    button('Reset Scene Cache', 'recursionResetSceneCache', 'Reset Recursion scene cache'),
    button('Clear Run Journal', 'recursionClearRunJournal', 'Clear Recursion run journal'),
    button('Export Diagnostics', 'recursionExportDiagnostics', 'Export sanitized Recursion diagnostics')
  ];
  for (const action of unavailableActions) {
    action.disabled = true;
    action.setAttribute('disabled', 'disabled');
    action.setAttribute('title', 'Planned diagnostic command; not wired in this V1 surface yet.');
  }
  group.appendChild(el('div', { className: 'recursion-provider-actions' }, unavailableActions));
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

function renderSettingsPanel(panel, view, activeTab = 'play') {
  panel.replaceChildren();
  const settings = asObject(view.settings);
  panel.appendChild(el('div', { className: 'recursion-settings-header' }, [
    el('h2', { text: 'Settings' }),
    button('x', 'recursionSettingsClose', 'Close Recursion settings')
  ]));
  panel.appendChild(el('div', { className: 'recursion-settings-tabs', dataset: { recursionSettingsTabs: '' } }, [
    ...['play', 'providers', 'advanced'].map((tab) => el('button', {
      className: `recursion-tab-button${activeTab === tab ? ' is-selected' : ''}`,
      text: titleCase(tab),
      attrs: { type: 'button' },
      dataset: {
        recursionSettingsTab: tab,
        [`recursionSettingsTab${titleCase(tab)}`]: ''
      }
    }))
  ]));
  const playPane = el('div', { className: 'recursion-settings-pane', dataset: { recursionSettingsPlay: '' } });
  const providersPane = el('div', { className: 'recursion-settings-pane', dataset: { recursionSettingsProviders: '' } });
  const advancedPane = el('div', { className: 'recursion-settings-pane', dataset: { recursionSettingsAdvanced: '' } });
  renderHighLevelSettings(playPane, settings);
  renderProviderSettings(providersPane, 'utility', settings.providers?.utility || {});
  renderProviderSettings(providersPane, 'reasoner', settings.providers?.reasoner || {});
  renderAdvancedSettings(advancedPane, settings);
  playPane.hidden = activeTab !== 'play';
  providersPane.hidden = activeTab !== 'providers';
  advancedPane.hidden = activeTab !== 'advanced';
  panel.appendChild(playPane);
  panel.appendChild(providersPane);
  panel.appendChild(advancedPane);
  panel.appendChild(el('div', { className: 'recursion-settings-footer' }, [
    button('Open Viewer', 'recursionViewerToggle', 'Open Recursion viewer'),
    button('Save Settings', 'recursionSettingsSave', 'Save Recursion settings')
  ]));
}

function appendViewerSection(viewer, title, data, options = {}) {
  const section = el('section', { className: 'recursion-viewer-section' });
  section.appendChild(el('h3', { text: title }));
  const pre = el('pre', { dataset: asObject(options).dataset || {} });
  pre.textContent = safeJson(data, { maxString: options.maxString || 900 });
  section.appendChild(pre);
  viewer.appendChild(section);
}

function safeJson(value, options = {}) {
  const visiting = new WeakSet();
  const maxString = Number(options.maxString) > 0 ? Number(options.maxString) : 900;
  try {
    return JSON.stringify(safeViewerValue(redact(value, { maxString }), visiting, 0, maxString), null, 2);
  } catch {
    return JSON.stringify({ unavailable: true }, null, 2);
  }
}

function safeViewerValue(value, visiting, depth = 0, maxString = 900) {
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return safeText(value, maxString);
  if (!value || typeof value !== 'object') return value;
  if (visiting.has(value)) return '[Circular]';
  if (depth >= 6) return '[Truncated]';
  visiting.add(value);
  try {
    if (Array.isArray(value)) return value.slice(0, 50).map((entry) => safeViewerValue(entry, visiting, depth + 1, maxString));
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      if (isSensitiveViewerKey(key)) {
        output[key] = '[redacted]';
        continue;
      }
      output[key] = safeViewerValue(child, visiting, depth + 1, maxString);
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
  let blocks = [];
  try {
    blocks = packetToPromptBlocks(source);
  } catch {
    blocks = [];
  }
  const injectedText = blocks.length
    ? blocks.map((block) => `## ${block.title}\n${block.text}`).join('\n\n')
    : '';
  return {
    packetId: source.packetId || '',
    handId: source.handId || handSource.handId || '',
    chatId: source.chatId || '',
    sceneKey: source.sceneKey || '',
    composerLane: source.diagnostics?.composerLane || '',
    sourceCardCount: Array.isArray(source.selectedCardRefs) ? source.selectedCardRefs.length : 0,
    injectedText,
    injectedBlocks: blocks.map((block) => ({
      promptKey: block.promptKey,
      title: block.title,
      placement: block.placement,
      depth: block.depth,
      role: block.role,
      sourceIds: block.sourceIds,
      text: block.text,
      hash: block.hash
    })),
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
    dataset: { recursionPromptPacket: '' },
    maxString: 5000
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
    el('button', {
      className: 'recursion-brand-stage',
      attrs: { type: 'button', 'aria-label': 'Open Recursion progress', 'aria-expanded': 'false' },
      dataset: { recursionBrandStage: '' }
    }, [
      el('strong', { className: 'recursion-brand', text: 'RECURSION' })
    ]),
    el('span', { className: 'recursion-bar-separator', attrs: { 'aria-hidden': 'true' } }),
    el('div', { className: 'recursion-mode-cluster' }, [
      el('button', {
        className: 'recursion-mode-button',
        attrs: { type: 'button', 'aria-label': 'Mode', 'aria-expanded': 'false' },
        dataset: { recursionModeButton: '', recursionModeKind: 'observe' }
      }, [
        el('span', { className: 'recursion-mode-icon', attrs: { 'aria-hidden': 'true' }, dataset: { recursionModeIcon: '' } }),
        el('span', { className: 'recursion-mode-text', dataset: { recursionMode: '' } })
      ]),
      el('div', { className: 'recursion-mode-menu', dataset: { recursionModeMenu: '' } }, [
        el('button', { className: 'recursion-mode-choice', text: 'Observe only', attrs: { type: 'button', title: 'Observe only prepares inspection surfaces without injecting prompt text.' }, dataset: { recursionModeChoice: 'observe', recursionModeChoiceObserve: '' } }),
        el('button', { className: 'recursion-mode-choice', text: 'Auto', attrs: { type: 'button', title: 'Auto selects cards, composes the prompt packet, and injects it when ready.' }, dataset: { recursionModeChoice: 'auto', recursionModeChoiceAuto: '' } }),
        el('button', { className: 'recursion-mode-choice', text: 'Off', attrs: { type: 'button', title: 'Off disables Recursion prompt work.' }, dataset: { recursionModeChoice: 'off', recursionModeChoiceOff: '' } })
      ])
    ]),
    el('span', { className: 'recursion-bar-separator', attrs: { 'aria-hidden': 'true' } }),
    el('button', {
      className: 'recursion-activity-trigger',
      attrs: { type: 'button', 'aria-label': 'Open Recursion progress', 'aria-expanded': 'false' },
      dataset: { recursionStatusTrigger: '' }
    }, [
      el('span', { className: 'recursion-hero-pixel-array', dataset: { recursionHeroArray: '' } }),
      el('span', {
        className: 'recursion-current-step',
        attrs: { role: 'status', 'aria-live': 'polite' },
        dataset: { recursionCurrentStep: '' }
      }),
      el('span', { className: 'recursion-status-text', dataset: { recursionStatus: '' } })
    ]),
    el('span', { className: 'recursion-chip recursion-legacy-hand-count', dataset: { recursionHandCount: '' } }),
    el('span', { className: 'recursion-chip recursion-legacy-composer', dataset: { recursionComposer: '' } }),
    el('span', { className: 'recursion-chip recursion-reasoner-chip', dataset: { recursionReasoner: '' } }),
    el('div', { className: 'recursion-right-tools' }, [
      el('div', { className: 'recursion-reasoning-chain', attrs: { role: 'radiogroup', 'aria-label': 'Reasoning level' }, dataset: { recursionReasoningChain: '' } }, [
        el('span', { className: 'recursion-reasoning-line-fill', attrs: { 'aria-hidden': 'true' } }),
        ...REASONING_LEVEL_OPTIONS.map(([level, label]) => el('button', {
          className: 'recursion-reasoning-node',
          attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', title: `${label} reasoning` },
          dataset: {
            recursionReasoningLevelNode: level,
            [`recursionReasoningLevel${titleCase(level)}`]: ''
          }
        }))
      ]),
      el('button', { className: 'recursion-icon-button recursion-brief-arrow', text: 'v', attrs: { type: 'button', 'aria-label': 'Open last brief preview', 'aria-expanded': 'false' }, dataset: { recursionHandToggle: '', recursionBriefArrow: '' } }),
      el('button', { className: 'recursion-icon-button recursion-options-button', text: '...', attrs: { type: 'button', 'aria-label': 'Open Recursion options', 'aria-expanded': 'false' }, dataset: { recursionActions: '', recursionOptionsButton: '' } })
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

  const hand = el('div', {
    className: 'recursion-hand-dropdown',
    attrs: { 'aria-label': 'Last brief cards dropdown' },
    dataset: { recursionHandDropdown: '', recursionHand: '' }
  });
  hand.hidden = true;

  const settingsPanel = el('div', {
    className: 'recursion-settings-panel',
    attrs: { 'aria-label': 'Recursion options' },
    dataset: { recursionSettingsPanel: '', recursionSettingsPopover: '' }
  });
  settingsPanel.hidden = true;

  const statusPopover = el('div', {
    className: 'recursion-status-popover',
    attrs: { 'aria-label': 'Generation status steps' },
    dataset: { recursionStatusPopover: '' }
  });
  statusPopover.hidden = true;

  const viewer = el('dialog', {
    className: 'recursion-viewer',
    attrs: { 'aria-label': 'Recursion Viewer' },
    dataset: { recursionViewer: '' }
  }, [
    button('Close', 'recursionViewerClose', 'Close Recursion viewer')
  ]);
  viewer.hidden = true;

  root.appendChild(bar);
  root.appendChild(statusPopover);
  root.appendChild(ribbon);
  root.appendChild(hand);
  root.appendChild(settingsPanel);
  root.appendChild(viewer);
  root.querySelector('[data-recursion-mode-menu]').hidden = true;
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
  const handPanel = root.querySelector('[data-recursion-hand-dropdown]');
  const settingsPanel = root.querySelector('[data-recursion-settings-panel]');
  const statusPopover = root.querySelector('[data-recursion-status-popover]');
  const actionsButton = root.querySelector('[data-recursion-actions]');
  const brandButton = root.querySelector('[data-recursion-brand-stage]');
  const handButton = root.querySelector('[data-recursion-hand-toggle]');
  const modeButton = root.querySelector('[data-recursion-mode-button]');
  const statusButton = root.querySelector('[data-recursion-status-trigger]');
  const modeMenu = root.querySelector('[data-recursion-mode-menu]');
  const viewer = root.querySelector('[data-recursion-viewer]');
  const ribbon = root.querySelector('[data-recursion-activity-ribbon]');
  let settingsPanelRendered = false;
  let settingsTab = 'play';
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

  function setFixedPanelGeometry(element, { left, top, width, zIndex = 10000 } = {}) {
    if (!element?.style) return;
    element.style.position = 'fixed';
    element.style.left = `${Math.round(left)}px`;
    element.style.right = 'auto';
    element.style.top = `${Math.round(top)}px`;
    element.style.width = `${Math.round(width)}px`;
    element.style.zIndex = String(zIndex);
    element.style.maxHeight = `calc(100vh - ${Math.round(top + 10)}px)`;
  }

  function syncFloatingPanelGeometry() {
    const bar = root.querySelector('[data-recursion-bar]');
    if (!bar || typeof bar.getBoundingClientRect !== 'function') return;
    const rect = bar.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const viewportWidth = Math.max(320, Number(globalThis.innerWidth || document.documentElement?.clientWidth || rect.right || 0));
    const rootLeft = Math.max(0, rect.left);
    const rootRight = Math.min(viewportWidth, rect.right);
    const rootWidth = Math.max(280, rootRight - rootLeft);
    const top = rect.bottom + 1;
    const progressWidth = Math.min(352, rootWidth);
    const gutter = 8;
    const settingsFitsBesideProgress = rootWidth >= progressWidth + gutter + 300;
    const settingsLeft = settingsFitsBesideProgress ? rootLeft + progressWidth + gutter : rootLeft;
    const settingsWidth = Math.max(280, rootRight - settingsLeft);

    setFixedPanelGeometry(statusPopover, { left: rootLeft, top, width: progressWidth, zIndex: 10020 });
    setFixedPanelGeometry(handPanel, { left: rootLeft, top, width: rootWidth, zIndex: 10010 });
    setFixedPanelGeometry(settingsPanel, { left: settingsLeft, top, width: settingsWidth, zIndex: 10012 });
    if (modeMenu?.style) {
      const modeRect = root.querySelector('[data-recursion-mode-button]')?.getBoundingClientRect?.();
      if (modeRect) setFixedPanelGeometry(modeMenu, {
        left: Math.min(modeRect.left, viewportWidth - 222),
        top,
        width: 222,
        zIndex: 10018
      });
    }
  }

  function setModeMenuOpen(open) {
    if (!modeMenu) return;
    modeMenu.hidden = !open;
    modeButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setProgressPopoverOpen(open) {
    statusPopover.hidden = !open;
    brandButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    statusButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncFloatingPanelGeometry();
  }

  function setHandPanelOpen(open) {
    handPanel.hidden = !open;
    handButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncFloatingPanelGeometry();
  }

  function setSettingsPanelOpen(open) {
    settingsPanel.hidden = !open;
    actionsButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      setHandPanelOpen(false);
      setModeMenuOpen(false);
      settingsPanelRendered = false;
      update();
    }
    syncFloatingPanelGeometry();
  }

  actionsButton?.addEventListener('click', () => {
    setSettingsPanelOpen(settingsPanel.hidden);
  });
  handButton?.addEventListener('click', () => {
    setHandPanelOpen(handPanel.hidden);
  });
  modeButton?.addEventListener('click', () => {
    setModeMenuOpen(modeMenu?.hidden !== false);
    syncFloatingPanelGeometry();
  });
  brandButton?.addEventListener('click', () => {
    setProgressPopoverOpen(statusPopover.hidden);
  });
  statusButton?.addEventListener('click', () => {
    setProgressPopoverOpen(statusPopover.hidden);
  });
  root.addEventListener('click', (event) => {
    const dataset = event?.target?.dataset || {};
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionViewerClose')) {
      if (typeof viewer.close === 'function' && viewer.open) viewer.close();
      viewer.hidden = true;
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionViewerToggle')) {
      openViewer();
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionSettingsClose')) {
      setSettingsPanelOpen(false);
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionCopyPromptPacket')) {
      const view = currentView();
      const packetText = safeJson(promptPacketPreview(view.lastPacket, view.lastHand), { maxString: 5000 });
      runAction(globalThis.navigator?.clipboard?.writeText?.(packetText));
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionModeChoice')) {
      runAction(runtime?.updateSettings?.({ mode: dataset.recursionModeChoice }));
      setModeMenuOpen(false);
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionReasoningLevelNode')) {
      const reasoningLevel = normalizeReasoningLevel(dataset.recursionReasoningLevelNode);
      runAction(runtime?.updateSettings?.({
        reasoningLevel,
        reasonerUse: reasonerUseForReasoningLevel(reasoningLevel)
      }));
    }
    if (Object.prototype.hasOwnProperty.call(dataset, 'recursionSettingsTab')) {
      settingsTab = ['play', 'providers', 'advanced'].includes(dataset.recursionSettingsTab)
        ? dataset.recursionSettingsTab
        : 'play';
      renderSettingsPanel(settingsPanel, currentView(), settingsTab);
      settingsPanelRendered = true;
      syncFloatingPanelGeometry();
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
    viewer.hidden = false;
    if (typeof viewer.showModal === 'function') {
      if (!viewer.open) viewer.showModal();
      return;
    }
  }

  function providerLaneFromDataset(dataset) {
    return dataset.recursionProviderLane === 'reasoner' ? 'reasoner' : 'utility';
  }

  function readSettingsPatch(sourceRoot) {
    const defaultUi = DEFAULT_RECURSION_SETTINGS.ui;
    const reasoningLevel = normalizeReasoningLevel(controlValue(sourceRoot, '[data-recursion-setting-reasoning-level]'));
    return {
      mode: controlValue(sourceRoot, '[data-recursion-setting-mode]'),
      reasoningLevel,
      strength: controlValue(sourceRoot, '[data-recursion-setting-strength]'),
      promptFootprint: controlValue(sourceRoot, '[data-recursion-setting-footprint]'),
      focus: controlValue(sourceRoot, '[data-recursion-setting-focus]'),
      reasonerUse: reasonerUseForReasoningLevel(reasoningLevel),
      ui: {
        progressChildVisibleLimit: integerInRange(
          controlNumber(sourceRoot, '[data-recursion-setting-progress-child-limit]', defaultUi.progressChildVisibleLimit),
          defaultUi.progressChildVisibleLimit,
          1,
          20
        ),
        progressListVisibleLimit: integerInRange(
          controlNumber(sourceRoot, '[data-recursion-setting-progress-list-limit]', defaultUi.progressListVisibleLimit),
          defaultUi.progressListVisibleLimit,
          5,
          80
        )
      },
      diagnostics: {
        maxJournalEntries: integerInRange(
          controlNumber(sourceRoot, '[data-recursion-setting-journal-limit]', 100),
          100,
          10,
          500
        ),
        includeExcerpts: controlChecked(sourceRoot, '[data-recursion-setting-include-excerpts]')
      }
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
    setText(root, '[data-recursion-current-step]', model.currentStepText || '');
    setText(root, '[data-recursion-mode-icon]', '');
    const modeButton = root.querySelector('[data-recursion-mode-button]');
    if (modeButton) modeButton.dataset.recursionModeKind = modeIcon(model.mode);
    setText(root, '[data-recursion-hand-count]', `Hand ${model.handCount}`);
    setText(root, '[data-recursion-composer]', model.composerLabel);
    setText(root, '[data-recursion-reasoner]', model.reasonerLabel);
    setText(root, '[data-recursion-ribbon-label]', model.activityLabel);
    ribbon.dataset.recursionSeverity = model.activitySeverity;
    updateRibbonVisibility(view, model);
    renderChipList(root.querySelector('[data-recursion-ribbon-chips]'), model.activityChips);
    renderHeroPixelArray(root.querySelector('[data-recursion-hero-array]'), model.heroPixelBlocks);
    renderProgressPopover(statusPopover, model.progressRun, model);
    renderReasoningChain(root, normalizeReasoningLevel(view.settings?.reasoningLevel));
    renderHandDropdown(handPanel, view, model);
    if (!settingsPanel.hidden && !settingsPanelRendered) {
      renderSettingsPanel(settingsPanel, view, settingsTab);
      settingsPanelRendered = true;
    }
    renderViewer(viewer, view, model);
    syncFloatingPanelGeometry();
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
