import { redact, stableStringify } from './core.mjs';
import {
  CARD_SCOPE_CATALOG,
  cardScopeCounts,
  cardScopeLabel,
  defaultCardScope,
  enabledSubItemsForFamily,
  familyState,
  normalizeCardScope,
  setFamilyEnabled,
  setSubItemEnabled
} from './card-scope.mjs';
import { packetToPromptBlocks } from './prompt.mjs';
import { createHeroPixelBlocks, createProgressRunModel } from './progress.mjs';
import {
  listProviderConnectionProfiles,
  providerModelStatus,
  providerRouteSummary
} from './providers.mjs';
import { DEFAULT_RECURSION_SETTINGS } from './settings.mjs';

const PHASE_LABELS = Object.freeze({
  idle: '',
  started: 'Reading current turn...',
  activity: 'Recursion is working...',
  sceneChecking: 'Checking scene shift...',
  arbiterPlanning: 'Planning card pass...',
  rapidWarming: 'Rapid warming scene deck...',
  rapidDeltaRunning: 'Rapid selecting turn delta...',
  rapidWarmMissStandard: 'Rapid warm miss; Standard...',
  rapidWarmReady: 'Rapid deck ready.',
  rapidWarmStale: 'Rapid deck stale.',
  cacheReusing: 'Reusing scene deck...',
  cardBatchRunning: 'Generating scene cards...',
  cardValidating: 'Validating cards...',
  deckUpdating: 'Updating scene deck...',
  handSelected: 'Selecting turn hand...',
  utilityComposing: 'Composing prompt packet with Utility...',
  reasonerComposing: 'Reasoner refining guidance...',
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
const STANDBY_STATUS_TIMEOUT_MS = 4000;
const SECRET_TEXT_PATTERN = /(private[-_\s]*secret|\bsk-[a-z0-9_-]+|\bbearer\s+[a-z0-9._-]+)/ig;
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'rect', 'path', 'circle']);
const MODE_MENU_OPTIONS = Object.freeze([
  {
    value: 'auto',
    label: 'Auto',
    title: 'Selects cards and injects composed prompt context automatically.',
    tip: 'Selects cards and injects composed prompt context automatically.'
  },
  {
    value: 'manual',
    label: 'Manual',
    title: 'Uses only selected card scope.',
    tip: 'Uses only selected card scope.'
  }
]);
const PIPELINE_MENU_OPTIONS = Object.freeze([
  {
    value: 'standard',
    label: 'Standard',
    title: 'Standard Pipeline',
    tip: 'Runs the full foreground Arbiter, card, compose, and install pipeline.'
  },
  {
    value: 'rapid',
    label: 'Rapid',
    title: 'Rapid Pipeline',
    tip: 'Uses provider-warmed card evidence and guidance plus a foreground turn delta.'
  }
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
  ['constraints', 'Constraints'],
  ['scene', 'Scene'],
  ['plot', 'Plot']
]);
const REASONING_LEVEL_OPTIONS = Object.freeze([
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['ultra', 'Ultra']
]);
const REASONING_LEVEL_TIPS = Object.freeze({
  low: 'Low: Utility-only, reduced cards.',
  medium: 'Medium: Utility checks, Reasoner guidance.',
  high: 'High: Reasoner Arbiter, priority cards, and guidance.',
  ultra: 'Ultra: Reasoner-heavy calls with a larger card bias.'
});
const REASONING_LEVELS = Object.freeze(REASONING_LEVEL_OPTIONS.map(([value]) => value));
const FOCUSABLE_SELECTORS = Object.freeze(['button', 'input', 'select', 'textarea', '[tabindex]']);
const PROVIDER_SOURCE_OPTIONS = Object.freeze([
  ['host-current-model', 'Current Host Model'],
  ['host-connection-profile', 'Host Connection Profile'],
  ['openai-compatible', 'OpenAI-Compatible Endpoint']
]);
const INJECTION_PLACEMENT_OPTIONS = Object.freeze([
  ['in_prompt', 'In Prompt'],
  ['in_chat', 'In Chat']
]);
const INJECTION_ROLE_OPTIONS = Object.freeze([
  ['system', 'System'],
  ['user', 'User'],
  ['assistant', 'Assistant']
]);
const INJECTION_DEPTH_OPTIONS = Object.freeze([
  ...Array.from({ length: 11 }, (_, index) => [String(index), String(index)])
]);
const SETTINGS_AUTOSAVE_DATASETS = Object.freeze([
  'recursionSettingStrength',
  'recursionSettingMinCards',
  'recursionSettingMaxCards',
  'recursionSettingFootprint',
  'recursionSettingFocus',
  'recursionSettingInjectionPlacement',
  'recursionSettingInjectionRole',
  'recursionSettingInjectionDepth',
  'recursionSettingTooltipsEnabled',
  'recursionSettingProgressChildLimit',
  'recursionSettingProgressListLimit',
  'recursionSettingJournalLimit',
  'recursionSettingIncludeExcerpts'
]);
const PROVIDER_AUTOSAVE_DATASETS = Object.freeze([
  'recursionProviderEnabled',
  'recursionProviderSource',
  'recursionProviderProfile',
  'recursionProviderBaseUrl',
  'recursionProviderModel',
  'recursionProviderModelList',
  'recursionProviderApiKey',
  'recursionProviderTemperature',
  'recursionProviderTopP',
  'recursionProviderMaxTokens'
]);
const SETTINGS_TOOLTIPS = Object.freeze({
  behavior: 'Controls how strongly Recursion shapes the next prompt packet. These settings affect card pressure, focus, and prompt size without changing provider credentials.',
  strength: 'Bias strength for the composed prompt packet. Light stays subtle, Balanced is the normal default, and Strong gives Recursion more room to steer scene adhesion.',
  minCards: 'Low Reasoning Level card target. Use fewer cards for faster, cheaper turns or more cards when sparse scenes need extra grounding.',
  maxCards: 'Ultra Reasoning Level card target. Medium and High use the average, so this also sets the upper range for busier scenes.',
  focus: 'Temporary creative priority for card selection and composition. It nudges Recursion toward character, constraints, scene, or plot without becoming a hard whitelist.',
  footprint: 'Prompt budget for the composed Recursion packet. Compact spends fewer tokens, Rich preserves more scene detail when the moment is complex.',
  injection: 'Compatibility controls for where the final composed Recursion packet lands in SillyTavern. These do not create per-card prompt controls.',
  injectionPlacement: 'Choose the SillyTavern prompt lane for the composed Recursion packet. In Prompt is the recommended default; In Chat can help presets that weight recent chat harder.',
  injectionRole: 'Role SillyTavern assigns to Recursion prompt blocks. System is safest for instruction-like scene guidance; User or Assistant exist for preset compatibility.',
  injectionDepth: 'Insertion depth for the composed packet. Lower values sit closer to generation; higher values sit farther back and usually feel less forceful.',
  ui: 'Display preferences for Recursion chrome. These affect local visibility and hover help only, not prompts or provider calls.',
  tooltips: 'Show hover help across Recursion. Turn off once the controls are familiar; hidden text never affects model calls.',
  progressChildLimit: 'Maximum visible sub-rows under one progress step before that child list scrolls. Useful when many card calls run in one turn.',
  progressListLimit: 'Maximum combined progress rows before the whole progress menu scrolls. Keeps long model-call runs readable without growing over the chat.',
  diagnostics: 'Local troubleshooting controls. Diagnostics are sanitized by default and are for understanding Recursion behavior, not feeding the model.',
  journalEntries: 'Maximum sanitized run-journal entries retained for inspection. Higher values help debugging but cost more local storage.',
  includeExcerpts: 'Include short sanitized excerpts in exported diagnostics. Leave off for privacy unless a bug report needs bounded text evidence.',
  resetSceneCache: 'Clear cached scene cards for the current chat so Recursion rebuilds its hand from fresh context.',
  clearRunJournal: 'Clear local Recursion activity history for this chat. This does not change cards, settings, or SillyTavern messages.',
  exportDiagnostics: 'Copy sanitized Recursion diagnostics for debugging. API keys, raw provider prompts, and hidden reasoning are excluded.',
  providerSource: 'Choose where this lane sends Recursion model calls. Current Host Model follows the active chat model; Host Connection Profile uses a saved SillyTavern profile; OpenAI-Compatible uses the endpoint fields below. Changes auto-save; hidden alternate-source fields keep their values.',
  providerProfile: 'Saved SillyTavern Connection Profile for this lane. Type to filter detected profiles; selection saves only when a listed profile is chosen. Profiles keep routing, preset, and keys in SillyTavern.',
  providerBaseUrl: 'Base /v1 URL for a direct OpenAI-compatible endpoint. Only used when Source is OpenAI-Compatible.',
  providerModel: 'Model id sent to the direct OpenAI-compatible endpoint. Only used with the OpenAI-Compatible source.',
  providerApiKey: 'Session-only key for the OpenAI-compatible endpoint. Recursion keeps it in memory and never writes it to settings or diagnostics.',
  providerMaxTokens: 'Maximum response tokens for structured Recursion calls on this lane. Raise only when valid JSON is being cut off.',
  providerTest: 'Send a small structured test call through this lane to verify routing, credentials, and JSON output before using it in chat.',
  providerClearKey: 'Remove the in-memory session key for this lane. Saved endpoint, model, and profile settings stay unchanged.'
});

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

function terminalStatusText(value) {
  const text = cleanText(value);
  if (!text) return '';
  if (/[.!?]$|\.{3}$/.test(text)) return text;
  return `${text}.`;
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

function datasetSuffix(value, fallback = '') {
  return titleCase(value, fallback).replace(/\s+/g, '');
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
  if (lane === 'guidance') return 'Guidance';
  if (lane === 'local') return 'Local';
  if (lane === 'utility') return 'Utility';
  return fallback;
}

function modeLabel(value) {
  const mode = cleanText(value, 'auto').toLowerCase();
  if (mode === 'manual') return 'Manual';
  if (mode === 'auto') return 'Auto';
  return 'Auto';
}

function normalizePipelineMode(value) {
  return cleanText(value, 'standard').toLowerCase() === 'rapid' ? 'rapid' : 'standard';
}

function pipelineLabel(value) {
  return normalizePipelineMode(value) === 'rapid' ? 'Rapid Pipeline' : 'Standard Pipeline';
}

function normalizeMode(value) {
  return cleanText(value, 'auto').toLowerCase() === 'manual' ? 'manual' : 'auto';
}

function modeIcon(value) {
  const mode = normalizeMode(value);
  if (mode === 'manual') return 'manual';
  return 'auto';
}

function pipelineIcon(value) {
  return normalizePipelineMode(value);
}

function pipelineIconSvg(kind) {
  if (kind === 'rapid') {
    return el('svg', { attrs: { width: '17', height: '17', viewBox: '0 0 17 17', 'aria-hidden': 'true', 'data-recursion-pipeline-rapid': '' } }, [
      el('path', { attrs: { d: 'M2.8 5.1 7.5 3.2 14.4 8.5 7.5 13.8 2.8 11.9 7.1 8.5 2.8 5.1Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linejoin': 'round' } }),
      el('path', { attrs: { d: 'M4.2 6.5 7.7 5.1M4.2 10.5 7.7 11.9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: '.65' } })
    ]);
  }
  return el('svg', { attrs: { width: '17', height: '17', viewBox: '0 0 17 17', 'aria-hidden': 'true', 'data-recursion-pipeline-standard': '' } }, [
    el('path', { attrs: { d: 'M8.5 2.3 14 4.8 8.5 7.3 3 4.8 8.5 2.3Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linejoin': 'round' } }),
    el('path', { attrs: { d: 'M8.5 5.8 14 8.3 8.5 10.8 3 8.3 8.5 5.8Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linejoin': 'round' } }),
    el('path', { attrs: { d: 'M8.5 9.3 14 11.8 8.5 14.3 3 11.8 8.5 9.3Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linejoin': 'round' } })
  ]);
}

function modeIconSvg(kind) {
  if (kind === 'auto') {
    return el('svg', { attrs: { width: '17', height: '17', viewBox: '0 0 17 17', 'aria-hidden': 'true', 'data-recursion-mode-arrow-fan': '' } }, [
      el('path', { attrs: { d: 'M3.2 8.5 11.8 3.4M9.2 2.8 11.8 3.4 10.5 5.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-recursion-mode-arrow': '' } }),
      el('path', { attrs: { d: 'M3.2 8.5h9.6M10.7 6.4 12.8 8.5 10.7 10.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-recursion-mode-arrow': '' } }),
      el('path', { attrs: { d: 'M3.2 8.5 11.8 13.6M10.5 11.2 11.8 13.6 9.2 14.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-recursion-mode-arrow': '' } })
    ]);
  }
  if (kind === 'manual') {
    return el('svg', { attrs: { width: '17', height: '17', viewBox: '0 0 17 17', 'aria-hidden': 'true', 'data-recursion-mode-arrow-parallel': '' } }, [
      el('path', { attrs: { d: 'M3.2 5.1h9.6M10.7 3 12.8 5.1 10.7 7.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-recursion-mode-arrow': '' } }),
      el('path', { attrs: { d: 'M3.2 8.5h9.6M10.7 6.4 12.8 8.5 10.7 10.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-recursion-mode-arrow': '' } }),
      el('path', { attrs: { d: 'M3.2 11.9h9.6M10.7 9.8 12.8 11.9 10.7 14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-recursion-mode-arrow': '' } })
    ]);
  }
  if (kind === 'cards') {
    return el('svg', { attrs: { width: '17', height: '17', viewBox: '0 0 17 17', 'aria-hidden': 'true' } }, [
      el('rect', { attrs: { x: '3', y: '5', width: '8', height: '9', rx: '1.7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', opacity: '.45' } }),
      el('rect', { attrs: { x: '5', y: '3', width: '8', height: '9', rx: '1.7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', opacity: '.70' } }),
      el('rect', { attrs: { x: '7', y: '1.5', width: '8', height: '9', rx: '1.7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25' } })
    ]);
  }
  if (kind === 'power') {
    return el('svg', { attrs: { width: '16', height: '16', viewBox: '0 0 16 16', 'aria-hidden': 'true' } }, [
      el('path', { attrs: { d: 'M8 1.7v6', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' } }),
      el('path', { attrs: { d: 'M5 3.8a5 5 0 1 0 6 0', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round' } })
    ]);
  }
  if (kind === 'stop') {
    return el('svg', { attrs: { width: '16', height: '16', viewBox: '0 0 16 16', 'aria-hidden': 'true', 'data-recursion-stop-icon': '' } }, [
      el('rect', { attrs: { x: '4.25', y: '4.25', width: '7.5', height: '7.5', rx: '1.2', fill: 'currentColor' } })
    ]);
  }
  return el('svg', { attrs: { width: '16', height: '16', viewBox: '0 0 16 16', 'aria-hidden': 'true' } }, [
    el('path', { attrs: { d: 'M1.6 8s2.4-4 6.4-4 6.4 4 6.4 4-2.4 4-6.4 4-6.4-4-6.4-4Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25' } }),
    el('circle', { attrs: { cx: '8', cy: '8', r: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25' } })
  ]);
}

function renderModeIcon(container, kind) {
  if (!container) return;
  if (container.dataset.recursionRenderedModeKind === kind) return;
  container.dataset.recursionRenderedModeKind = kind;
  container.replaceChildren(modeIconSvg(kind));
}

function renderPipelineIcon(container, kind) {
  if (!container) return;
  if (container.dataset.recursionRenderedPipelineKind === kind) return;
  container.dataset.recursionRenderedPipelineKind = kind;
  container.replaceChildren(pipelineIconSvg(kind));
}

function pipelineMenuChoice(option) {
  const kind = pipelineIcon(option.value);
  return el('button', {
    className: 'recursion-pipeline-choice',
    attrs: {
      type: 'button',
      title: option.title,
      'aria-current': 'false'
    },
    dataset: {
      recursionPipelineChoice: option.value,
      [`recursionPipelineChoice${datasetSuffix(option.value)}`]: '',
      recursionPipelineKind: kind
    }
  }, [
    el('span', {
      className: 'recursion-pipeline-choice-icon',
      attrs: { 'aria-hidden': 'true' },
      dataset: { recursionPipelineChoiceIcon: '' }
    }, [pipelineIconSvg(kind)]),
    el('span', { className: 'recursion-pipeline-choice-copy' }, [
      el('span', {
        className: 'recursion-pipeline-choice-name',
        text: option.label,
        dataset: { recursionPipelineChoiceName: '' }
      }),
      el('span', {
        className: 'recursion-pipeline-choice-tip',
        text: option.tip,
        dataset: { recursionPipelineChoiceTip: '' }
      })
    ])
  ]);
}

function modeMenuChoice(option) {
  const kind = modeIcon(option.value);
  return el('button', {
    className: 'recursion-mode-choice',
    attrs: {
      type: 'button',
      title: option.title,
      'aria-current': 'false'
    },
    dataset: {
      recursionModeChoice: option.value,
      [`recursionModeChoice${datasetSuffix(option.value)}`]: '',
      recursionModeKind: kind
    }
  }, [
    el('span', {
      className: 'recursion-mode-choice-icon',
      attrs: { 'aria-hidden': 'true' },
      dataset: { recursionModeChoiceIcon: '' }
    }, [modeIconSvg(kind)]),
    el('span', { className: 'recursion-mode-choice-copy' }, [
      el('span', {
        className: 'recursion-mode-choice-name',
        text: option.label,
        dataset: { recursionModeChoiceName: '' }
      }),
      el('span', {
        className: 'recursion-mode-choice-tip',
        text: option.tip,
        dataset: { recursionModeChoiceTip: '' }
      })
    ])
  ]);
}

function reasonerUseForReasoningLevel(value) {
  const level = cleanText(value, 'high').toLowerCase();
  if (level === 'low') return 'off';
  if (level === 'medium' || level === 'high' || level === 'ultra') return 'always';
  return 'auto';
}

function normalizeReasoningLevel(value) {
  const level = cleanText(value, 'high').toLowerCase();
  return REASONING_LEVELS.includes(level) ? level : 'high';
}

function reasoningLevelLabel(value) {
  const level = normalizeReasoningLevel(value);
  return REASONING_LEVEL_OPTIONS.find(([candidate]) => candidate === level)?.[1] || titleCase(level, 'High');
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
  if (normalized.includes('constraint')) return '!';
  if (normalized.includes('knowledge') || normalized.includes('secret')) return '*';
  if (normalized.includes('clock') || normalized.includes('consequence')) return '>';
  if (normalized.includes('motivation')) return '?';
  if (normalized.includes('dialogue') || normalized.includes('relationship')) return '"';
  if (normalized.includes('thread')) return '...';
  if (normalized.includes('cast')) return '@';
  if (normalized.includes('possession') || normalized.includes('item')) return '$';
  if (normalized.includes('environment') || normalized.includes('affordance')) return '+';
  return '#';
}

function cardPriority(card) {
  const source = asObject(card);
  const priorityText = cleanText(`${source.priority || ''} ${source.emphasis || ''} ${source.status || ''}`).toLowerCase();
  if (priorityText.includes('critical') || priorityText.includes('guard')) return 'critical';
  if (priorityText.includes('strong') || priorityText.includes('emphasized') || priorityText.includes('high')) return 'strong';
  if (priorityText.includes('support') || priorityText.includes('light')) return 'support';
  return 'normal';
}

function briefChipClass(chip, priority = '') {
  const normalized = cleanText(chip).toLowerCase();
  if (normalized === 'critical' || priority === 'critical' && normalized === 'guard') return 'recursion-mini-chip recursion-brief-chip critical';
  if (normalized === 'strong' || priority === 'strong' && normalized === 'emphasized') return 'recursion-mini-chip recursion-brief-chip strong';
  if (['cached', 'fallback', 'retried', 'reasoner', 'focus', 'manual', 'guardrail'].includes(normalized)) {
    return 'recursion-mini-chip recursion-brief-chip state';
  }
  return 'recursion-mini-chip recursion-brief-chip';
}

function cardFamilyIconSvg(family) {
  const normalized = cleanText(family, '').toLowerCase();
  const svgAttrs = { class: 'recursion-cat-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true' };
  if (normalized.includes('constraint') || normalized.includes('risk')) {
    return el('svg', { attrs: svgAttrs }, [
      el('path', { attrs: { d: 'M8 2 14 13H2L8 2Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25' } }),
      el('path', { attrs: { d: 'M8 6v3.2M8 11.8h.01', stroke: 'currentColor', 'stroke-width': '1.45', 'stroke-linecap': 'round' } })
    ]);
  }
  if (normalized.includes('knowledge') || normalized.includes('secret')) {
    return el('svg', { attrs: svgAttrs }, [
      el('path', { attrs: { d: 'M2.2 8s2-3.4 5.8-3.4S13.8 8 13.8 8s-2 3.4-5.8 3.4S2.2 8 2.2 8Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.15', 'stroke-linejoin': 'round' } }),
      el('circle', { attrs: { cx: '8', cy: '8', r: '1.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.15' } }),
      el('path', { attrs: { d: 'M11.8 3.2 4.2 12.8', stroke: 'currentColor', 'stroke-width': '1.1', 'stroke-linecap': 'round' } })
    ]);
  }
  if (normalized.includes('clock') || normalized.includes('consequence')) {
    return el('svg', { attrs: svgAttrs }, [
      el('circle', { attrs: { cx: '8', cy: '8', r: '5.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2' } }),
      el('path', { attrs: { d: 'M8 4.9v3.3l2.4 1.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }),
      el('path', { attrs: { d: 'M4.1 2.6 2.8 4M11.9 2.6 13.2 4', stroke: 'currentColor', 'stroke-width': '1.05', 'stroke-linecap': 'round' } })
    ]);
  }
  if (normalized.includes('motivation')) {
    return el('svg', { attrs: svgAttrs }, [
      el('circle', { attrs: { cx: '8', cy: '8', r: '5.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2' } }),
      el('circle', { attrs: { cx: '8', cy: '8', r: '2.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2' } }),
      el('path', { attrs: { d: 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2', stroke: 'currentColor', 'stroke-width': '1.1', 'stroke-linecap': 'round' } })
    ]);
  }
  if (normalized.includes('relationship') || normalized.includes('dialogue') || normalized.includes('cast')) {
    return el('svg', { attrs: svgAttrs }, [
      el('circle', { attrs: { cx: '5', cy: '7', r: '2.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2' } }),
      el('circle', { attrs: { cx: '11', cy: '7', r: '2.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2' } }),
      el('path', { attrs: { d: 'M6.9 8.4 9.1 8.4M3.2 12.8c.8-1.3 2-2 3.3-2M12.8 12.8c-.8-1.3-2-2-3.3-2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.1', 'stroke-linecap': 'round' } })
    ]);
  }
  if (normalized.includes('objective') || normalized.includes('thread') || normalized.includes('plot')) {
    return el('svg', { attrs: svgAttrs }, [
      el('path', { attrs: { d: 'M4 14V3M4 3h7l-1 2 1 2H4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } })
    ]);
  }
  if (normalized.includes('possession') || normalized.includes('item')) {
    return el('svg', { attrs: svgAttrs }, [
      el('path', { attrs: { d: 'M4.2 3.2h5.6l3 3v6.6H4.2V3.2Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.15', 'stroke-linejoin': 'round' } }),
      el('path', { attrs: { d: 'M9.8 3.2v3h3M6.1 8.4h4.2M6.1 10.8h3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.05', 'stroke-linecap': 'round' } })
    ]);
  }
  if (normalized.includes('environment') || normalized.includes('affordance')) {
    return el('svg', { attrs: svgAttrs }, [
      el('path', { attrs: { d: 'M2.7 11.5 6.4 4.2l2.3 4 1.3-2.1 3.3 5.4H2.7Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.15', 'stroke-linejoin': 'round' } }),
      el('path', { attrs: { d: 'M3.4 13.3h9.2M5.6 9.2h4.8', stroke: 'currentColor', 'stroke-width': '1.05', 'stroke-linecap': 'round' } })
    ]);
  }
  if (normalized.includes('memory') || normalized.includes('echo')) {
    return el('svg', { attrs: svgAttrs }, [
      el('path', { attrs: { d: 'M5 4H3V2M3.2 4A5.5 5.5 0 1 1 2.6 9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }),
      el('path', { attrs: { d: 'M8 5.3v3.1l2.2 1.2', stroke: 'currentColor', 'stroke-width': '1.1', 'stroke-linecap': 'round' } })
    ]);
  }
  if (normalized.includes('safety') || normalized.includes('guard')) {
    return el('svg', { attrs: svgAttrs }, [
      el('path', { attrs: { d: 'M8 2.3 13 4v3.8c0 3-1.9 5-5 6-3.1-1-5-3-5-6V4l5-1.7Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linejoin': 'round' } }),
      el('path', { attrs: { d: 'M5.8 8 7.3 9.5 10.5 6.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } })
    ]);
  }
  return el('svg', { attrs: svgAttrs }, [
    el('path', { attrs: { d: 'M3 6.2 8 3l5 3.2v5.6L8 14l-5-2.2V6.2Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.15' } }),
    el('path', { attrs: { d: 'M3.2 6.4 8 8.7l4.8-2.3M8 8.7V14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.05' } })
  ]);
}

function cardDisplayOrigin(card) {
  const source = asObject(card);
  const candidates = [
    source.origin,
    source.sourceType,
    typeof source.source === 'string' ? source.source : '',
    source.provenance
  ].map((entry) => cleanText(entry).toLowerCase());
  if (candidates.some((entry) => entry === 'cache' || entry === 'cached')) return 'cache';
  if (candidates.some((entry) => entry === 'fallback' || entry === 'local' || entry === 'local-fallback')) return 'fallback';
  if (candidates.some((entry) => entry === 'generated' || entry === 'provider')) return 'generated';
  return '';
}

function cardMetaChips(card) {
  const source = asObject(card);
  const chips = [];
  const origin = cardDisplayOrigin(source);
  if (origin === 'cache') chips.push('cached');
  if (origin === 'fallback') chips.push('fallback');
  if (Number(source.providerRetryCount || source.retryCount || 0) > 0) chips.push('retried');
  if (cleanText(source.providerLane || source.composerLane).toLowerCase() === 'reasoner') chips.push('reasoner');
  const selectionTag = cleanText(source.selectionTag || source.scopeTag || source.selectionSource).toLowerCase();
  if (['focus', 'manual', 'guardrail'].includes(selectionTag)) chips.push(selectionTag);
  return [...new Set(chips)];
}

function compactBriefChips(chips, maxVisible = 4) {
  const normalized = normalizeChips(chips);
  const limit = Math.max(1, Number(maxVisible) || 4);
  if (normalized.length <= limit) {
    return normalized.map((chip) => ({ text: chip, title: chip }));
  }
  const visibleLimit = Math.max(1, limit - 1);
  const visible = normalized.slice(0, visibleLimit)
    .map((chip) => ({ text: chip, title: chip }));
  const hidden = normalized.slice(visibleLimit);
  visible.push({
    text: `+${hidden.length}`,
    title: `More metadata: ${hidden.join(', ')}`
  });
  return visible;
}

function briefCardTooltip(card, family, chips) {
  const source = asObject(card);
  const parts = [
    `${family} card`,
    cardSummary(source),
    cleanText(source.selectedReason || source.selectionReason || source.whySelected)
      ? `Included: ${cleanText(source.selectedReason || source.selectionReason || source.whySelected)}`
      : '',
    cleanText(source.omittedReason || source.omissionReason || source.whyOmitted)
      ? `Omitted: ${cleanText(source.omittedReason || source.omissionReason || source.whyOmitted)}`
      : '',
    chips.length ? `Meta: ${chips.join(', ')}` : ''
  ].filter(Boolean);
  return parts.join(' - ');
}

function briefChipTooltip(chip) {
  const normalized = cleanText(chip).toLowerCase();
  if (normalized.startsWith('+')) return '';
  if (normalized === 'cached') return 'Read from valid scene cache for this brief.';
  if (normalized === 'fallback') return 'Local fallback card used because provider cards were unavailable.';
  if (normalized === 'retried') return 'Provider retry was needed before this card completed.';
  if (normalized === 'reasoner') return 'Reasoner lane shaped this card or selection.';
  if (normalized === 'focus') return 'Selected because it matched the current focus policy.';
  if (normalized === 'manual') return 'Selected inside the current Manual card scope.';
  if (normalized === 'guardrail') return 'Selected as a guardrail for scene safety or plausibility.';
  if (normalized === 'strong') return 'High priority for this turn.';
  if (normalized === 'critical') return 'Critical guardrail or scene-constraint priority.';
  return chip;
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

function collectProviderLanesFromSteps(steps, lanes = new Set()) {
  if (!Array.isArray(steps)) return lanes;
  for (const step of steps) {
    const lane = cleanText(asObject(step).providerLane).toLowerCase();
    if (lane === 'utility' || lane === 'reasoner') lanes.add(lane);
    collectProviderLanesFromSteps(step?.children, lanes);
  }
  return lanes;
}

function progressFooterLabel(modelSource, progressRun, composerLane) {
  const lanes = collectProviderLanesFromSteps(progressRun?.steps);
  const fallbackLane = cleanText(composerLane, 'utility').toLowerCase();
  if (!lanes.size && (fallbackLane === 'utility' || fallbackLane === 'reasoner')) lanes.add(fallbackLane);
  const mode = modeLabel(cleanText(modelSource.settings?.mode, 'auto').toLowerCase());
  if (lanes.has('utility') && lanes.has('reasoner')) return `${mode} - Utility and Reasoner lanes`;
  if (lanes.has('reasoner')) return `${mode} - Reasoner lane`;
  return `${mode} - Utility lane`;
}

export function activityLabel(activity = {}) {
  const source = asObject(activity);
  const explicitLabel = cleanText(source.label);
  if (explicitLabel) return explicitLabel;
  if (Object.prototype.hasOwnProperty.call(PHASE_LABELS, source.phase)) return PHASE_LABELS[source.phase];
  return 'Recursion is working...';
}

function runtimeHealthLabel(activity, progressRun) {
  if (!READY_PHASES.has(activity.phase)) return 'Working';
  const severity = normalizeSeverity(activity.severity);
  if (severity === 'error') return 'Issue';
  if (severity === 'warning') return 'Needs attention';
  if (progressRun?.title === 'Issue') return 'Issue';
  if (progressRun?.title === 'Needs attention') return 'Needs attention';
  return 'Ready';
}

function standbyStatusText(activity, progressRun, enabled, mode, pipelineMode, cards) {
  if (!enabled) return terminalStatusText('Recursion off');
  if (progressRun?.currentStepText) return '';
  const severity = normalizeSeverity(activity.severity);
  if (severity === 'error') return terminalStatusText('Needs attention');
  if (severity === 'warning') return terminalStatusText('Needs attention');
  const phase = cleanText(activity.phase, 'idle');
  if (phase === 'rapidWarmReady') return terminalStatusText('Rapid deck ready');
  if (phase === 'rapidWarmStale') return terminalStatusText('Rapid deck stale');
  const label = cleanText(activity.label).replace(/\.+$/g, '');
  if (phase === 'settled' || phase === 'promptPacketBuilt') {
    if (/recursion prompt ready/i.test(label)) return terminalStatusText('Recursion prompt ready');
    if (/generation canceled/i.test(label)) return terminalStatusText('Generation canceled');
    return terminalStatusText(label || 'Ready for next turn');
  }
  if (!READY_PHASES.has(activity.phase)) return '';
  if (mode === 'manual') return terminalStatusText('Manual scope armed');
  if (pipelineMode === 'rapid' && Array.isArray(cards) && cards.length > 0) return terminalStatusText('Rapid deck standing by');
  if (Array.isArray(cards) && cards.length > 0) return terminalStatusText('Scene deck standing by');
  return terminalStatusText('Ready for Recursion');
}

export function createRecursionViewModel(view = {}) {
  const source = asObject(view);
  const settings = asObject(source.settings);
  const activity = asObject(source.activity);
  const enabled = settings.enabled !== false;
  const mode = normalizeMode(settings.mode);
  const pipelineMode = normalizePipelineMode(settings.pipelineMode);
  const cardScope = normalizeCardScope(settings.cardScope || defaultCardScope());
  const cards = Array.isArray(source.lastHand?.cards) ? source.lastHand.cards : [];
  const composerLane = source.lastPacket?.diagnostics?.composerLane || activity.composerLane || activity.providerLane || 'utility';
  const progressRun = createProgressRunModel(source);
  const heroPixelBlocks = createHeroPixelBlocks(progressRun);
  const generationStopVisible = enabled && (
    Boolean(cleanText(source.activeRunId))
    || source.hostGenerationActive === true
    || Number(progressRun.activeCount || 0) > 0
  );
  const defaultUi = DEFAULT_RECURSION_SETTINGS.ui;
  const progressChildVisibleLimit = integerInRange(settings.ui?.progressChildVisibleLimit, defaultUi.progressChildVisibleLimit, 1, 20);
  const progressListVisibleLimit = integerInRange(settings.ui?.progressListVisibleLimit, defaultUi.progressListVisibleLimit, 5, 80);
  const tooltipsEnabled = settings.ui?.tooltipsEnabled !== false;
  const activityChips = normalizeChips([
    ...(Array.isArray(activity.chips) ? activity.chips : []),
    activity.providerLane ? laneLabel(activity.providerLane) : '',
    activity.cardCounts?.selected ? `${activity.cardCounts.selected} cards` : ''
  ]);

  return {
    mode,
    pipelineMode,
    enabled,
    modeLabel: modeLabel(mode),
    pipelineLabel: pipelineLabel(pipelineMode),
    cardScope,
    cardScopeLabel: cardScopeLabel(cardScope),
    cardScopeCounts: cardScopeCounts(cardScope),
    runtimeHealthLabel: enabled ? runtimeHealthLabel(activity, progressRun) : 'Off',
    handCount: cards.length,
    activityLabel: activityLabel(activity),
    activitySeverity: normalizeSeverity(activity.severity),
    activityChips,
    progressRun,
    generationStopVisible,
    currentStepText: progressRun.currentStepText,
    standbyStatusText: standbyStatusText(activity, progressRun, enabled, mode, pipelineMode, cards),
    heroPixelBlocks,
    heroPixelColumnCount: heroPixelBlocks.at(-1)?.columnCount || 0,
    progressChildVisibleLimit,
    progressListVisibleLimit,
    tooltipsEnabled,
    composerLabel: laneLabel(composerLane, 'Utility'),
    progressFooterLabel: progressFooterLabel(source, progressRun, composerLane),
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
  const node = SVG_TAGS.has(tagName) && typeof document.createElementNS === 'function'
    ? document.createElementNS(SVG_NS, tagName)
    : document.createElement(tagName);
  if (className) node.setAttribute('class', className);
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

function removeAttribute(node, name) {
  if (!node) return;
  if (typeof node.removeAttribute === 'function') {
    node.removeAttribute(name);
    return;
  }
  if (node.attributes) delete node.attributes[name];
}

function setTooltip(node, enabled, text) {
  if (!node) return;
  const tip = cleanText(text);
  if (!enabled || !tip) {
    removeAttribute(node, 'title');
    return;
  }
  node.setAttribute('title', tip);
}

function tooltipAttrs(enabled, text) {
  const tip = cleanText(text);
  return enabled && tip ? { title: tip } : {};
}

function isHiddenFromFocus(node) {
  let current = node;
  while (current) {
    if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return true;
    current = current.parentNode;
  }
  return false;
}

function isFocusableNode(node) {
  if (!node || node.disabled || isHiddenFromFocus(node)) return false;
  if (node.getAttribute?.('aria-disabled') === 'true') return false;
  if (String(node.type || '').toLowerCase() === 'hidden') return false;
  const tabIndex = node.getAttribute?.('tabindex');
  if (tabIndex !== null && Number(tabIndex) < 0) return false;
  return typeof node.focus === 'function';
}

function focusNode(node) {
  if (!node || typeof node.focus !== 'function') return;
  try {
    node.focus({ preventScroll: true });
  } catch {
    try {
      node.focus();
    } catch {
      // Ignore focus failures in host/fake DOMs.
    }
  }
}

function focusPanel(panel) {
  if (!panel) return;
  const seen = new Set();
  const focusable = [];
  for (const selector of FOCUSABLE_SELECTORS) {
    for (const node of panel.querySelectorAll?.(selector) || []) {
      if (seen.has(node)) continue;
      seen.add(node);
      focusable.push(node);
    }
  }
  const firstFocusable = focusable.find(isFocusableNode);
  if (firstFocusable) {
    focusNode(firstFocusable);
    return;
  }
  if (!panel.getAttribute?.('tabindex')) panel.setAttribute?.('tabindex', '-1');
  focusNode(panel);
}

function isSettingsAutoSaveControl(node) {
  const dataset = asObject(node?.dataset);
  return SETTINGS_AUTOSAVE_DATASETS.some((key) => Object.prototype.hasOwnProperty.call(dataset, key));
}

function isProviderAutoSaveControl(node) {
  const dataset = asObject(node?.dataset);
  const keys = Object.keys(dataset);
  return PROVIDER_AUTOSAVE_DATASETS.some((key) => (
    keys.includes(`${key}Utility`) || keys.includes(`${key}Reasoner`)
  ));
}

function mergeObjectPatch(base, patch) {
  const result = { ...asObject(base) };
  for (const [key, value] of Object.entries(asObject(patch))) {
    const existing = result[key];
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      && existing && typeof existing === 'object' && !Array.isArray(existing)
      ? mergeObjectPatch(existing, value)
      : value;
  }
  return result;
}

function viewWithSettingsPatch(view, patch) {
  const source = asObject(view);
  return {
    ...source,
    settings: mergeObjectPatch(source.settings, patch)
  };
}

function clearTooltips(node) {
  if (!node) return;
  removeAttribute(node, 'title');
  for (const child of node.children || []) clearTooltips(child);
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

function disclosureDataset(prefix, id) {
  return { [`${prefix}${datasetSuffix(id)}`]: '' };
}

function settingsDisclosureSection(id, title, children, { defaultOpen = true, tooltip = '', tooltipsEnabled = true } = {}) {
  const open = Boolean(defaultOpen);
  const section = el('section', {
    className: `recursion-settings-disclosure${open ? ' is-open' : ''}`,
    dataset: {
      recursionSettingsSection: id,
      ...disclosureDataset('recursionSettingsSection', id)
    }
  });
  const header = el('button', {
    className: 'recursion-settings-disclosure-toggle',
    text: title,
    attrs: {
      type: 'button',
      'aria-expanded': open ? 'true' : 'false',
      ...tooltipAttrs(tooltipsEnabled, tooltip)
    },
    dataset: {
      recursionSettingsSectionToggle: id,
      ...disclosureDataset('recursionSettingsSectionToggle', id)
    }
  });
  const body = el('div', {
    className: 'recursion-settings-disclosure-body',
    dataset: {
      recursionSettingsSectionBody: id,
      ...disclosureDataset('recursionSettingsSectionBody', id)
    }
  }, children);
  body.hidden = !open;
  section.appendChild(header);
  section.appendChild(body);
  return section;
}

function hiddenCheckedControl({ checked, dataset, ariaLabel }) {
  const input = checkboxControl({ checked, dataset, ariaLabel });
  input.hidden = true;
  return input;
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

function dispatchControlChange(control) {
  if (!control || typeof control.dispatchEvent !== 'function') return;
  if (typeof Event === 'function') {
    control.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    control.dispatchEvent({ type: 'change', target: control });
  }
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

function datasetHas(dataset, key) {
  return Object.prototype.hasOwnProperty.call(dataset || {}, key);
}

function closestDatasetElement(target, key, stopAt = null) {
  let node = target;
  while (node) {
    if (datasetHas(node.dataset, key)) return node;
    if (node === stopAt) break;
    node = node.parentNode;
  }
  return null;
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

function progressRowClass(step, child = false, transientClass = '') {
  return [
    'recursion-step-row',
    child ? 'child-row' : '',
    step.state || 'pending',
    transientClass
  ].filter(Boolean).join(' ');
}

function createProgressRowShell(step, child = false) {
  return el('div', {
    className: progressRowClass(step, child, 'is-entering'),
    dataset: {
      recursionProgressRow: '',
      recursionProgressStepId: step.id || ''
    }
  }, [
    el('span', {
      className: 'recursion-provider-mark',
      text: providerMark(step.providerLane),
      dataset: { recursionProgressProviderMark: '' }
    }),
    el('span', { className: 'recursion-step-separator', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'recursion-step-icon', attrs: { 'aria-hidden': 'true' } }),
    el('span', {
      className: 'recursion-step-label',
      text: step.label || 'Step',
      dataset: { recursionProgressLabel: '' }
    }),
    el('span', {
      className: 'recursion-step-meta',
      text: step.meta || '',
      dataset: { recursionProgressMeta: '' }
    })
  ]);
}

function progressStepTooltip(step, child = false) {
  const provider = laneLabel(step.providerLane, 'Utility');
  const state = titleCase(step.state || 'pending', 'Pending');
  const meta = cleanText(step.meta);
  const label = cleanText(step.label, 'Step');
  const reason = cleanText(step.reason);
  const parts = [
    `${label}: ${state}`,
    `${provider} provider`,
    meta && meta.toLowerCase() !== state.toLowerCase() ? meta : '',
    reason ? `Reason: ${reason}` : '',
    child ? 'Sub-step' : 'Top-level progress item'
  ].filter(Boolean);
  return parts.join(' - ');
}

function updateProgressRow(row, step, child = false, tooltipsEnabled = true) {
  const label = step.label || 'Step';
  const meta = step.meta || '';
  const state = step.state || 'pending';
  const providerLane = step.providerLane || 'utility';
  const reason = step.reason || '';
  const firstRender = row.dataset.recursionProgressRendered !== 'true';
  const changed = !firstRender && (
    row.dataset.recursionProgressState !== state
    || row.dataset.recursionProgressLabel !== label
    || row.dataset.recursionProgressMeta !== meta
    || row.dataset.recursionProgressReason !== reason
    || row.dataset.recursionProgressProvider !== providerLane
  );
  row.className = progressRowClass(step, child, firstRender ? 'is-entering' : (changed ? 'is-updating' : ''));
  row.dataset.recursionProgressRendered = 'true';
  row.dataset.recursionProgressStepId = step.id || '';
  row.dataset.recursionProgressState = state;
  row.dataset.recursionProgressLabel = label;
  row.dataset.recursionProgressMeta = meta;
  row.dataset.recursionProgressReason = reason;
  row.dataset.recursionProgressProvider = providerLane;
  setText(row, '[data-recursion-progress-provider-mark]', providerMark(providerLane));
  setText(row, '[data-recursion-progress-label]', label);
  setText(row, '[data-recursion-progress-meta]', meta);
  setTooltip(row, tooltipsEnabled, progressStepTooltip({ ...step, label, meta, state, providerLane }, child));
  setTooltip(row.querySelector?.('[data-recursion-progress-provider-mark]'), tooltipsEnabled, `${laneLabel(providerLane)} provider`);
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

function findProgressRow(container, stepId) {
  return [...container.querySelectorAll('[data-recursion-progress-row]')]
    .find((row) => row.dataset.recursionProgressStepId === stepId && row.parentNode === container);
}

function findProgressChildRow(group, stepId) {
  return [...group.querySelectorAll('[data-recursion-progress-row]')]
    .find((row) => row.dataset.recursionProgressStepId === stepId);
}

function findProgressChildrenGroup(list, parentStepId) {
  return [...list.querySelectorAll('[data-recursion-progress-children]')]
    .find((group) => group.dataset.recursionProgressParentStep === parentStepId);
}

function insertAt(container, node, index) {
  const before = container.children[index] || null;
  if (before === node) return;
  if (node.parentNode === container) node.remove();
  container.insertBefore(node, before);
}

function renderProgressChildrenGroup(group, step, model, previousChildScrollTops) {
  const children = Array.isArray(step.children) ? step.children : [];
  const childLimit = model.progressChildVisibleLimit || 5;
  const scrollable = children.length > childLimit;
  group.className = `recursion-step-children${scrollable ? ' is-scrollable' : ''}`;
  group.dataset.recursionProgressParentStep = step.id || '';
  group.dataset.recursionProgressChildCount = String(children.length);
  group.style = group.style || {};
  group.style.setProperty?.('--recursion-progress-child-limit', String(childLimit));

  const visibleIds = new Set(children.map((child, index) => child.id || `progress-child-${index}`));
  for (const row of [...group.querySelectorAll('[data-recursion-progress-row]')]) {
    if (!visibleIds.has(row.dataset.recursionProgressStepId || '')) row.remove();
  }
  children.forEach((child, index) => {
    const childId = child.id || `progress-child-${index}`;
    const childStep = { ...child, id: childId };
    let row = findProgressChildRow(group, childId);
    if (!row) row = createProgressRowShell(childStep, true);
    updateProgressRow(row, childStep, true, model.tooltipsEnabled);
    insertAt(group, row, index);
  });

  const previousChildScrollTop = previousChildScrollTops.get(step.id || '');
  if (previousChildScrollTop > 0 && Number(group.scrollTop || 0) === 0) group.scrollTop = previousChildScrollTop;
  if (scrollable) {
    if (group.dataset.recursionScrollBound !== 'true') {
      group.addEventListener?.('scroll', () => syncScrollableChildFade(group));
      group.dataset.recursionScrollBound = 'true';
    }
    syncScrollableChildFade(group);
  } else {
    delete group.dataset.recursionScrollBound;
  }
}

function ensureProgressPopoverShell(panel) {
  let head = panel.querySelector?.('[data-recursion-progress-head]');
  let list = panel.querySelector?.('[data-recursion-progress-list]');
  let foot = panel.querySelector?.('[data-recursion-progress-foot]');
  if (head && list && foot) return { head, list, foot };

  head = el('div', { className: 'recursion-status-head', dataset: { recursionProgressHead: '' } }, [
    el('span', { className: 'recursion-status-title', dataset: { recursionProgressTitle: '' } }),
    el('span', { className: 'recursion-status-subtitle', dataset: { recursionProgressSubtitle: '' } })
  ]);
  list = el('div', {
    className: 'recursion-status-list',
    dataset: { recursionProgressList: '' }
  });
  foot = el('div', { className: 'recursion-status-foot', dataset: { recursionProgressFoot: '' } }, [
    el('span', { dataset: { recursionProgressFootText: '' } }),
    el('span', { className: 'recursion-mini-chip', text: 'Live' })
  ]);
  panel.replaceChildren(head, list, foot);
  return { head, list, foot };
}

function renderProgressPopover(panel, progressRun, model) {
  const previousList = typeof panel.querySelector === 'function'
    ? panel.querySelector('[data-recursion-progress-list]')
    : null;
  const previousScrollTop = Number(previousList?.scrollTop || 0);
  const previousChildScrollTops = new Map(Array.from(panel.querySelectorAll?.('[data-recursion-progress-children]') || [])
    .map((group) => [group.dataset?.recursionProgressParentStep, Number(group.scrollTop || 0)])
    .filter(([id]) => Boolean(id)));
  const { list } = ensureProgressPopoverShell(panel);
  setText(panel, '[data-recursion-progress-title]', progressRun.title || 'Generating');
  setText(panel, '[data-recursion-progress-subtitle]', progressRun.subtitle || model.currentStepText || '');
  setText(panel, '[data-recursion-progress-foot-text]', model.progressFooterLabel);
  list.style = list.style || {};
  list.style.setProperty?.('--recursion-progress-list-limit', String(model.progressListVisibleLimit || 15));

  const steps = Array.isArray(progressRun.steps) ? progressRun.steps : [];
  const visibleTopIds = new Set(steps.map((step, index) => step.id || `progress-step-${index}`));
  for (const node of [...list.children]) {
    const rowId = node.dataset?.recursionProgressStepId;
    const groupId = node.dataset?.recursionProgressParentStep;
    if (rowId && !visibleTopIds.has(rowId)) node.remove();
    if (groupId && !visibleTopIds.has(groupId)) node.remove();
  }

  let insertIndex = 0;
  steps.forEach((step, index) => {
    const stepId = step.id || `progress-step-${index}`;
    const stepModel = { ...step, id: stepId };
    let row = findProgressRow(list, stepId);
    if (!row) row = createProgressRowShell(stepModel);
    updateProgressRow(row, stepModel, false, model.tooltipsEnabled);
    insertAt(list, row, insertIndex++);

    const children = Array.isArray(step.children) ? step.children : [];
    let group = findProgressChildrenGroup(list, stepId);
    if (children.length) {
      if (!group) {
        group = el('div', {
          className: 'recursion-step-children',
          dataset: {
            recursionProgressChildren: '',
            recursionProgressParentStep: stepId
          }
        });
      }
      renderProgressChildrenGroup(group, stepModel, model, previousChildScrollTops);
      insertAt(list, group, insertIndex++);
    } else if (group) {
      group.remove();
    }
  });

  if (previousScrollTop > 0) list.scrollTop = previousScrollTop;
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
    node.setAttribute('tabindex', selected ? '0' : '-1');
  }
}

function syncStaticTooltips(root, model) {
  if (!model.tooltipsEnabled) {
    clearTooltips(root);
    root.dataset.recursionTooltips = 'off';
    return;
  }
  root.dataset.recursionTooltips = 'on';
  setTooltip(root.querySelector('[data-recursion-pipeline-button]'), true, `Pipeline: ${model.pipelineLabel}`);
  setTooltip(root.querySelector('[data-recursion-mode-button]'), true, `Mode: ${model.modeLabel}`);
  setTooltip(root.querySelector('[data-recursion-cards-button]'), true, 'Open card scope selector. Auto treats scope as preference; Manual uses scope as a strict whitelist.');
  setTooltip(root.querySelector('[data-recursion-status-trigger]'), true, 'Open generation progress');
  setTooltip(root.querySelector('[data-recursion-hand-toggle]'), true, 'Open last brief preview');
  setTooltip(root.querySelector('[data-recursion-options-button]'), true, 'Open Recursion settings');
  for (const option of MODE_MENU_OPTIONS) {
    const node = root.querySelector(`[data-recursion-mode-choice-${option.value}]`);
    setTooltip(node, true, option.title);
  }
  for (const option of PIPELINE_MENU_OPTIONS) {
    const node = root.querySelector(`[data-recursion-pipeline-choice-${option.value}]`);
    setTooltip(node, true, option.title);
  }
  for (const [level, label] of REASONING_LEVEL_OPTIONS) {
    setTooltip(root.querySelector(`[data-recursion-reasoning-level-${level}]`), true, REASONING_LEVEL_TIPS[level] || `${label} reasoning`);
  }
  setTooltip(root.querySelector('[data-recursion-prompt-packet-button]'), true, 'Open injected prompt packet');
  setTooltip(root.querySelector('[data-recursion-reset-scene-cache]'), true, 'Reset the current scene cache so Recursion rebuilds cards from the active chat.');
  setTooltip(root.querySelector('[data-recursion-clear-run-journal]'), true, 'Clear the local Recursion run journal.');
  setTooltip(root.querySelector('[data-recursion-export-diagnostics]'), true, 'Copy sanitized Recursion diagnostics.');
}

function briefCardDomId(card, index) {
  const source = asObject(card);
  return cleanText(source.id || source.cardId || source.refId || `${cardFamily(source)}-${index}`, `card-${index}`);
}

function handDropdownRenderKey(view, model, cards, packetText, packetMeta) {
  return stableStringify({
    tooltipsEnabled: model.tooltipsEnabled,
    hasPacket: Boolean(view.lastPacket),
    packetId: cleanText(view.lastPacket?.packetId || ''),
    packetText,
    packetMeta,
    composedAt: cleanText(view.lastPacket?.composedAt || ''),
    cards: cards.map((card, index) => {
      const source = asObject(card);
      const family = cardFamily(source);
      const priority = cardPriority(source);
      const metaChips = cardMetaChips(source);
      return {
        id: briefCardDomId(source, index),
        family,
        priority,
        text: cardText(source) || cardSummary(source),
        chips: [
          ['critical', 'strong'].includes(priority) ? priority : '',
          ...metaChips
        ].map((chip) => cleanText(chip, '')).filter(Boolean),
        selectedReason: cleanText(source.selectedReason || source.selectionReason || source.whySelected),
        omittedReason: cleanText(source.omittedReason || source.omissionReason || source.whyOmitted)
      };
    })
  });
}

function renderHandDropdown(panel, view, model) {
  const cards = model.cards;
  const packetPreview = promptPacketPreview(view.lastPacket, view.lastHand);
  const packetText = promptPacketText(view.lastPacket, view.lastHand);
  const packetMeta = promptPacketMeta(packetPreview);
  const renderKey = handDropdownRenderKey(view, model, cards, packetText, packetMeta);
  if (panel.hidden === false && panel.dataset?.recursionHandRenderKey === renderKey) return;

  const packetPanelWasOpen = panel.querySelector?.('[data-recursion-prompt-packet-panel]')?.hidden === false;
  const previousPacketPreviewNode = panel.querySelector?.('[data-recursion-prompt-packet-preview]');
  const previousBriefScrollTop = Number(panel.querySelector?.('[data-recursion-brief-scroll]')?.scrollTop || 0);
  const previousPacketScrollTop = Number(previousPacketPreviewNode?.scrollTop || 0);
  const expandedCards = new Set(Array.from(panel.querySelectorAll?.('[data-recursion-brief-card-id]') || [])
    .filter((row) => row.getAttribute?.('aria-expanded') === 'true')
    .map((row) => row.dataset?.recursionBriefCardId)
    .filter(Boolean));
  panel.replaceChildren();
  const packetTextUnchanged = previousPacketPreviewNode?.textContent === packetText;
  const packetButton = el('button', {
    className: 'recursion-prompt-packet-button',
    text: 'Prompt Packet',
    attrs: { type: 'button', 'aria-label': 'Open last prompt packet', 'aria-expanded': packetPanelWasOpen ? 'true' : 'false' },
    dataset: { recursionPromptPacketButton: '' }
  });
  if (!view.lastPacket) {
    packetButton.disabled = true;
    packetButton.setAttribute('disabled', 'disabled');
  }
  setTooltip(packetButton, model.tooltipsEnabled, view.lastPacket ? 'Open injected prompt packet' : 'No prompt packet has been composed yet.');
  panel.appendChild(el('div', { className: 'recursion-brief-head' }, [
    el('span', {
      className: 'recursion-dropdown-title',
      text: 'Last brief'
    }),
    el('span', {
      className: 'recursion-brief-summary',
      text: cards.length
        ? `${cards.length} card${cards.length === 1 ? '' : 's'} - click row to expand - priority color only`
        : '0 cards - waiting for composed hand'
    }),
    packetButton
  ]));
  const packetPreviewNode = previousPacketPreviewNode || el('pre', {
    className: 'recursion-packet-text',
    dataset: { recursionPromptPacketPreview: '' }
  });
  packetPreviewNode.className = 'recursion-packet-text';
  if (packetPreviewNode.dataset) packetPreviewNode.dataset.recursionPromptPacketPreview = '';
  if (!packetTextUnchanged) packetPreviewNode.textContent = packetText;

  const packetPanel = el('section', {
    className: 'recursion-prompt-packet-panel',
    attrs: { 'aria-label': 'Injected prompt packet' },
    dataset: { recursionPromptPacketPanel: '' }
  }, [
    el('div', { className: 'recursion-packet-head' }, [
      el('span', { text: 'Injected prompt packet' }),
      el('span', { className: 'recursion-packet-meta' }, [
        ...packetMeta.map((chip) => el('span', { className: 'recursion-mini-chip', text: chip })),
        button('Copy', 'recursionCopyPromptPacket', 'Copy last Recursion prompt packet')
      ])
    ]),
    packetPreviewNode
  ]);
  packetPanel.hidden = !packetPanelWasOpen || !view.lastPacket;
  const nextPacketScrollTop = packetTextUnchanged ? previousPacketScrollTop : 0;
  packetButton.addEventListener?.('click', () => {
    if (!view.lastPacket) return;
    packetPanel.hidden = !packetPanel.hidden;
    packetButton.setAttribute('aria-expanded', packetPanel.hidden ? 'false' : 'true');
  });
  panel.appendChild(packetPanel);
  packetPreviewNode.scrollTop = nextPacketScrollTop;
  if (!cards.length) {
    panel.appendChild(el('p', { className: 'recursion-empty', text: 'No hand has been composed for this chat.' }));
    panel.appendChild(el('div', { className: 'recursion-brief-foot' }, [
      el('span', { text: 'Waiting for first composed brief' }),
      el('span', { className: 'recursion-mini-chip', text: 'Esc' })
    ]));
    panel.dataset.recursionHandRenderKey = renderKey;
    return;
  }
  const scroll = el('div', { className: 'recursion-brief-scroll', dataset: { recursionBriefScroll: '' } });
  for (const [index, card] of cards.entries()) {
    const source = asObject(card);
    const cardDomId = briefCardDomId(source, index);
    const expanded = expandedCards.has(cardDomId);
    const family = cardFamily(source);
    const priority = cardPriority(source);
    const metaChips = cardMetaChips(source);
    const priorityLabel = ['critical', 'strong'].includes(priority) ? priority : '';
    const rawChips = [
      priorityLabel,
      ...metaChips
    ].map((chip) => cleanText(chip, '')).filter(Boolean);
    const visibleChips = compactBriefChips(rawChips, 4);
    const row = el('button', {
      className: 'recursion-brief-card',
      attrs: {
        type: 'button',
        'aria-expanded': expanded ? 'true' : 'false',
        'data-priority': priority,
        ...tooltipAttrs(model.tooltipsEnabled, briefCardTooltip(source, family, rawChips))
      },
      dataset: {
        recursionBriefCard: '',
        recursionBriefCardId: cardDomId,
        recursionPriority: priority
      }
    }, [
      el('div', { className: 'recursion-card-kind' }, [
        el('span', {
          className: 'recursion-cat-icon-wrap',
          attrs: tooltipAttrs(model.tooltipsEnabled, `${family} card family`),
          dataset: { recursionBriefCardIcon: '' }
        }, [cardFamilyIconSvg(family)]),
        el('span', { className: 'recursion-kind-label', text: family, dataset: { recursionBriefCardFamily: '' } }),
        el('span', { className: 'recursion-expand-glyph', attrs: { 'aria-hidden': 'true' } })
      ]),
      el('div', { className: 'recursion-card-body' }, [
        el('p', {
          className: 'recursion-card-text',
          text: cardText(source) || cardSummary(source),
          dataset: { recursionBriefCardText: '' }
        }),
        el('div', {
          className: 'recursion-meta-row',
          dataset: { recursionBriefCardMeta: '' }
        }, visibleChips.map((chip) => el('span', {
          className: briefChipClass(chip.text, priority),
          text: chip.text,
          attrs: tooltipAttrs(model.tooltipsEnabled, chip.title || briefChipTooltip(chip.text))
        })))
      ])
    ]);
    row.addEventListener?.('click', () => {
      const next = row.getAttribute('aria-expanded') !== 'true';
      row.setAttribute('aria-expanded', next ? 'true' : 'false');
    });
    scroll.appendChild(row);
  }
  panel.appendChild(scroll);
  if (previousBriefScrollTop > 0) scroll.scrollTop = previousBriefScrollTop;
  panel.appendChild(el('div', { className: 'recursion-brief-foot' }, [
    el('span', {
      text: view.lastPacket?.composedAt
        ? `Generated ${safeText(view.lastPacket.composedAt, 80)}`
        : 'Generated for last composed brief'
    }),
    el('span', { className: 'recursion-mini-chip', text: 'Esc' })
  ]));
  panel.dataset.recursionHandRenderKey = renderKey;
}

function cardScopeSelectedCount(scope, family) {
  return enabledSubItemsForFamily(scope, family).length;
}

function renderCardsPanel(panel, view, model, notice = '') {
  panel.replaceChildren();
  const scope = model.cardScope || normalizeCardScope(view.settings?.cardScope || defaultCardScope());
  const counts = model.cardScopeCounts || cardScopeCounts(scope);
  const summary = counts.selectedSubItems === counts.totalSubItems
    ? 'All card focus enabled'
    : `${counts.selectedSubItems}/${counts.totalSubItems} focus items enabled`;
  const allSelected = counts.selectedSubItems === counts.totalSubItems;
  const allButtonAttrs = {
    type: 'button',
    'aria-label': 'Select all card focus items',
    title: allSelected ? 'All card focus items are already selected.' : 'Select all card focus items.'
  };
  if (allSelected) allButtonAttrs.disabled = 'disabled';

  panel.appendChild(el('div', { className: 'recursion-cards-head' }, [
    el('span', { className: 'recursion-dropdown-title', text: 'Cards' }),
    el('span', { className: 'recursion-cards-head-actions' }, [
      el('span', { className: 'recursion-cards-summary', text: summary }),
      el('button', {
        className: 'recursion-cards-all-button',
        text: 'All',
        attrs: allButtonAttrs,
        dataset: { recursionCardScopeAll: '' }
      })
    ])
  ]));
  const noticeNode = el('div', {
    className: 'recursion-card-scope-notice',
    text: notice,
    attrs: { role: 'status' },
    dataset: { recursionCardScopeError: '' }
  });
  noticeNode.hidden = !notice;
  panel.appendChild(noticeNode);

  const list = el('div', { className: 'recursion-card-scope-list', dataset: { recursionCardScopeList: '' } });
  for (const family of CARD_SCOPE_CATALOG) {
    const state = familyState(scope, family.family);
    const selected = cardScopeSelectedCount(scope, family.family);
    const row = el('section', {
      className: `recursion-card-scope-family is-${state}`,
      dataset: {
        recursionCardScopeFamily: '',
        recursionCardScopeFamilyName: family.family
      }
    });
    row.appendChild(el('button', {
      className: 'recursion-card-scope-family-toggle',
      attrs: {
        type: 'button',
        'aria-pressed': state === 'mixed' ? 'mixed' : (state === 'on' ? 'true' : 'false'),
        ...tooltipAttrs(model.tooltipsEnabled, family.description)
      },
      dataset: {
        recursionCardScopeFamilyToggle: '',
        recursionCardScopeFamilyName: family.family
      }
    }, [
      el('span', {
        className: 'recursion-card-scope-icon',
        attrs: { 'aria-hidden': 'true' }
      }, [cardFamilyIconSvg(family.family)]),
      el('span', { className: 'recursion-card-scope-family-name', text: family.family }),
      el('span', { className: 'recursion-card-scope-family-count', text: `${selected}/${family.subItems.length}` })
    ]));

    row.appendChild(el('div', { className: 'recursion-card-scope-subitems' }, family.subItems.map((item) => {
      const on = enabledSubItemsForFamily(scope, family.family).includes(item.key);
      const lastSelected = on && counts.selectedSubItems === 1;
      return el('button', {
        className: `recursion-card-scope-subitem${on ? ' is-on' : ' is-off'}${lastSelected ? ' is-required' : ''}`,
        attrs: {
          type: 'button',
          'aria-pressed': on ? 'true' : 'false',
          ...tooltipAttrs(model.tooltipsEnabled, lastSelected
            ? 'Keep at least one card focus enabled.'
            : `${item.label}: ${item.description}`)
        },
        dataset: {
          recursionCardScopeSubItemToggle: '',
          recursionCardScopeFamilyName: family.family,
          recursionCardScopeSubItem: item.key
        }
      }, [
        el('span', { className: 'recursion-card-scope-check', attrs: { 'aria-hidden': 'true' } }),
        el('span', { text: item.label })
      ]);
    })));
    list.appendChild(row);
  }
  panel.appendChild(list);
  panel.appendChild(el('div', { className: 'recursion-cards-foot' }, [
    el('span', { text: 'Auto treats scope as preference. Manual uses scope as a strict whitelist.' }),
    el('span', { className: 'recursion-mini-chip', text: 'Esc' })
  ]));
}

function settingsSelectRow(label, datasetName, value, options, tooltip = '', tooltipsEnabled = true) {
  const control = selectControl({
    value,
    options,
    dataset: { [datasetName]: '' },
    ariaLabel: label
  });
  setTooltip(control, tooltipsEnabled, tooltip);
  return controlRow(label, control);
}

function settingsNumberRow(label, datasetName, value, { min = 0, max = 20, step = 1, tooltip = '', tooltipsEnabled = true } = {}) {
  const control = inputControl({
    value,
    type: 'number',
    dataset: { [datasetName]: '' },
    ariaLabel: label,
    min,
    max,
    step
  });
  setTooltip(control, tooltipsEnabled, tooltip);
  return controlRow(label, control);
}

function renderHighLevelSettings(panel, settings) {
  const group = el('section', { className: 'recursion-settings-group' });
  const tooltipsEnabled = asObject(settings.ui).tooltipsEnabled !== false;
  group.appendChild(settingsDisclosureSection('play-behavior', 'Behavior', [
    settingsSelectRow('Strength', 'recursionSettingStrength', cleanText(settings.strength, 'balanced'), STRENGTH_OPTIONS, SETTINGS_TOOLTIPS.strength, tooltipsEnabled),
    settingsNumberRow('Min Cards', 'recursionSettingMinCards', integerInRange(settings.minCards, DEFAULT_RECURSION_SETTINGS.minCards, 0, 20), { tooltip: SETTINGS_TOOLTIPS.minCards, tooltipsEnabled }),
    settingsNumberRow('Max Cards', 'recursionSettingMaxCards', integerInRange(settings.maxCards, DEFAULT_RECURSION_SETTINGS.maxCards, 0, 20), { tooltip: SETTINGS_TOOLTIPS.maxCards, tooltipsEnabled }),
    settingsSelectRow('Focus', 'recursionSettingFocus', cleanText(settings.focus, 'balanced'), FOCUS_OPTIONS, SETTINGS_TOOLTIPS.focus, tooltipsEnabled),
    settingsSelectRow('Prompt Footprint', 'recursionSettingFootprint', cleanText(settings.promptFootprint, 'normal'), FOOTPRINT_OPTIONS, SETTINGS_TOOLTIPS.footprint, tooltipsEnabled)
  ], { tooltip: SETTINGS_TOOLTIPS.behavior, tooltipsEnabled }));
  panel.appendChild(group);
}

function renderAdvancedSettings(panel, settings, capabilities = {}) {
  const group = el('section', { className: 'recursion-settings-group' });
  const ui = asObject(settings.ui);
  const diagnostics = asObject(settings.diagnostics);
  const injection = asObject(settings.injection);
  const defaultUi = DEFAULT_RECURSION_SETTINGS.ui;
  const defaultInjection = DEFAULT_RECURSION_SETTINGS.injection;
  const tooltipsEnabled = ui.tooltipsEnabled !== false;
  group.appendChild(el('h3', { text: 'Advanced' }));
  const resetSceneCache = button('Reset Scene Cache', 'recursionResetSceneCache', 'Reset Recursion scene cache');
  if (asObject(capabilities).resetSceneCache !== true) {
    resetSceneCache.disabled = true;
    resetSceneCache.setAttribute('disabled', 'disabled');
    resetSceneCache.setAttribute('title', 'Planned diagnostic command; not wired in this V1 surface yet.');
  } else {
    setTooltip(resetSceneCache, tooltipsEnabled, SETTINGS_TOOLTIPS.resetSceneCache);
  }
  group.appendChild(settingsDisclosureSection('injection', 'Injection', [
    settingsSelectRow(
      'Placement',
      'recursionSettingInjectionPlacement',
      cleanText(injection.placement, defaultInjection.placement),
      INJECTION_PLACEMENT_OPTIONS,
      SETTINGS_TOOLTIPS.injectionPlacement,
      tooltipsEnabled
    ),
    settingsSelectRow(
      'Role',
      'recursionSettingInjectionRole',
      cleanText(injection.role, defaultInjection.role),
      INJECTION_ROLE_OPTIONS,
      SETTINGS_TOOLTIPS.injectionRole,
      tooltipsEnabled
    ),
    settingsSelectRow(
      'Depth',
      'recursionSettingInjectionDepth',
      String(injection.depth ?? defaultInjection.depth),
      INJECTION_DEPTH_OPTIONS,
      SETTINGS_TOOLTIPS.injectionDepth,
      tooltipsEnabled
    )
  ], { tooltip: SETTINGS_TOOLTIPS.injection, tooltipsEnabled }));
  const tooltipsControl = checkboxControl({
    checked: ui.tooltipsEnabled !== false,
    dataset: { recursionSettingTooltipsEnabled: '' },
    ariaLabel: 'Enable hover tooltips'
  });
  setTooltip(tooltipsControl, tooltipsEnabled, SETTINGS_TOOLTIPS.tooltips);
  const progressChildControl = inputControl({
    value: integerInRange(ui.progressChildVisibleLimit, defaultUi.progressChildVisibleLimit, 1, 20),
    type: 'number',
    min: 1,
    max: 20,
    step: 1,
    dataset: { recursionSettingProgressChildLimit: '' },
    ariaLabel: 'Visible sub-tier progress rows'
  });
  setTooltip(progressChildControl, tooltipsEnabled, SETTINGS_TOOLTIPS.progressChildLimit);
  const progressListControl = inputControl({
    value: integerInRange(ui.progressListVisibleLimit, defaultUi.progressListVisibleLimit, 5, 80),
    type: 'number',
    min: 5,
    max: 80,
    step: 1,
    dataset: { recursionSettingProgressListLimit: '' },
    ariaLabel: 'Visible progress rows before scrolling'
  });
  setTooltip(progressListControl, tooltipsEnabled, SETTINGS_TOOLTIPS.progressListLimit);
  group.appendChild(settingsDisclosureSection('ui', 'UI', [
    controlRow('Tooltips', tooltipsControl),
    controlRow('Sub-tier Rows', progressChildControl),
    controlRow('Progress Rows', progressListControl)
  ], { tooltip: SETTINGS_TOOLTIPS.ui, tooltipsEnabled }));
  const journalLimitControl = inputControl({
    value: integerInRange(diagnostics.maxJournalEntries, 100, 10, 500),
    type: 'number',
    min: 10,
    max: 500,
    step: 10,
    dataset: { recursionSettingJournalLimit: '' },
    ariaLabel: 'Maximum diagnostic journal entries'
  });
  setTooltip(journalLimitControl, tooltipsEnabled, SETTINGS_TOOLTIPS.journalEntries);
  const excerptsControl = checkboxControl({
    checked: diagnostics.includeExcerpts === true,
    dataset: { recursionSettingIncludeExcerpts: '' },
    ariaLabel: 'Include sanitized excerpts in diagnostics'
  });
  setTooltip(excerptsControl, tooltipsEnabled, SETTINGS_TOOLTIPS.includeExcerpts);
  group.appendChild(settingsDisclosureSection('diagnostics', 'Diagnostics', [
    controlRow('Journal Entries', journalLimitControl),
    controlRow('Include Excerpts', excerptsControl),
    el('div', { className: 'recursion-provider-actions' }, [
      resetSceneCache,
      button('Clear Run Journal', 'recursionClearRunJournal', SETTINGS_TOOLTIPS.clearRunJournal),
      button('Export Diagnostics', 'recursionExportDiagnostics', SETTINGS_TOOLTIPS.exportDiagnostics)
    ])
  ], { tooltip: SETTINGS_TOOLTIPS.diagnostics, tooltipsEnabled }));
  panel.appendChild(group);
}

function providerDataset(name, lane) {
  const suffix = titleCase(lane).replace(/\s+/g, '');
  return { [`recursionProvider${name}${suffix}`]: '' };
}

function providerSelector(name, lane) {
  return `[data-recursion-provider-${name}-${lane}]`;
}

function providerStatusClass(text) {
  const status = cleanText(text).toLowerCase();
  return status === 'not run' || status === 'ok' || status === 'pass' || status === 'passed' || status === 'ready'
    ? 'recursion-provider-status pass'
    : 'recursion-provider-status';
}

function renderProviderHiddenDefaults(group, lane, provider) {
  const source = asObject(provider);
  group.appendChild(inputControl({
    value: source.temperature ?? (lane === 'reasoner' ? 0.4 : 0.1),
    type: 'hidden',
    dataset: providerDataset('Temperature', lane),
    ariaLabel: `${laneLabel(lane)} provider temperature`
  }));
  group.appendChild(inputControl({
    value: source.topP ?? 0.95,
    type: 'hidden',
    dataset: providerDataset('TopP', lane),
    ariaLabel: `${laneLabel(lane)} provider top p`
  }));
}

function providerField(label, control, options = {}) {
  const lane = cleanText(options.lane);
  const context = cleanText(options.context);
  const sourceTypes = Array.isArray(options.sourceTypes) ? options.sourceTypes.map((entry) => cleanText(entry)).filter(Boolean) : [];
  const dataset = {};
  if (context) {
    Object.assign(dataset, {
      recursionProviderContext: context,
      recursionProviderLane: lane,
      recursionProviderSourceTypes: sourceTypes.join(' '),
      ...providerDataset(`Context${datasetSuffix(context)}`, lane)
    });
  }
  return el('label', { className: 'recursion-provider-field', dataset }, [
    el('span', { text: label }),
    control
  ]);
}

function normalizeProviderSource(value) {
  const source = cleanText(value, 'host-current-model').toLowerCase();
  return PROVIDER_SOURCE_OPTIONS.some(([candidate]) => candidate === source) ? source : 'host-current-model';
}

function listConnectionProfiles(profiles = null) {
  const source = Array.isArray(profiles) ? profiles : listProviderConnectionProfiles();
  return source.map((profile) => ({
    id: profile.id,
    label: profile.label
  }));
}

function connectionProfileEntries(selectedId = '', profiles = null) {
  const selected = cleanText(selectedId);
  const availableProfiles = listConnectionProfiles(profiles);
  const entries = availableProfiles.map((profile) => ({
    id: cleanText(profile.id),
    label: cleanText(profile.label || profile.id)
  })).filter((profile) => profile.id);
  if (selected && !availableProfiles.some((profile) => profile.id === selected)) {
    entries.push({ id: selected, label: `${selected} (saved)` });
  }
  return entries;
}

function connectionProfileLabel(profileId = '', profiles = []) {
  const selected = cleanText(profileId);
  if (!selected) return '';
  return profiles.find((profile) => profile.id === selected)?.label || selected;
}

function profileMatchesQuery(profile, query = '') {
  const needle = cleanText(query).toLowerCase();
  if (!needle) return true;
  return [profile.label, profile.id].some((value) => cleanText(value).toLowerCase().includes(needle));
}

function renderConnectionProfileCombobox({ selectedId = '', profiles = [], lane, title, tooltipsEnabled = true, disabled = false, onCommit = null } = {}) {
  const entries = Array.isArray(profiles) ? profiles : [];
  const selected = cleanText(selectedId);
  const selectedLabel = connectionProfileLabel(selected, entries);
  const listId = `recursion-provider-profile-list-${lane}`;
  const hidden = inputControl({
    value: selected,
    type: 'hidden',
    dataset: providerDataset('Profile', lane),
    ariaLabel: `${title} committed host connection profile`
  });
  const input = inputControl({
    value: selectedLabel,
    dataset: providerDataset('ProfileFilter', lane),
    ariaLabel: `${title} host connection profile`,
    placeholder: entries.length ? 'Select Profile' : 'No connection profiles found'
  });
  input.setAttribute('role', 'combobox');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);
  input.className = `${input.className} recursion-provider-profile-search`;
  if (disabled) {
    input.disabled = true;
    input.setAttribute('disabled', 'disabled');
  }
  setTooltip(input, tooltipsEnabled, SETTINGS_TOOLTIPS.providerProfile);

  const list = el('div', {
    className: 'recursion-provider-profile-list',
    attrs: { id: listId, role: 'listbox' },
    dataset: providerDataset('ProfileList', lane)
  });
  list.hidden = true;

  const setExpanded = (open) => {
    const shouldOpen = Boolean(open) && !disabled;
    list.hidden = !shouldOpen;
    input.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  };

  const commitProfile = (profile) => {
    if (!profile?.id) return;
    hidden.value = profile.id;
    input.value = profile.label;
    setExpanded(false);
    onCommit?.();
    dispatchControlChange(hidden);
  };

  const activeSearchQuery = () => {
    const committedLabel = connectionProfileLabel(hidden.value, entries);
    return cleanText(input.value) === cleanText(committedLabel) ? '' : input.value;
  };

  const renderMatches = () => {
    const matches = entries.filter((profile) => profileMatchesQuery(profile, activeSearchQuery()));
    if (!matches.length) {
      list.replaceChildren(el('div', {
        className: 'recursion-provider-profile-empty',
        text: entries.length ? 'No matching profiles' : 'No connection profiles found',
        attrs: { role: 'option', 'aria-disabled': 'true' }
      }));
      return matches;
    }
    list.replaceChildren(...matches.map((profile) => {
      const option = el('div', {
        className: `recursion-provider-profile-option${profile.id === hidden.value ? ' is-selected' : ''}`,
        text: profile.label,
        attrs: {
          role: 'option',
          tabindex: '-1',
          'aria-selected': profile.id === hidden.value ? 'true' : 'false'
        },
        dataset: { recursionProviderProfileOption: profile.id }
      });
      option.addEventListener?.('click', (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        commitProfile(profile);
      });
      return option;
    }));
    return matches;
  };

  input.addEventListener?.('focus', () => {
    renderMatches();
    setExpanded(true);
  });
  input.addEventListener?.('click', () => {
    renderMatches();
    setExpanded(true);
  });
  input.addEventListener?.('input', () => {
    renderMatches();
    setExpanded(true);
  });
  input.addEventListener?.('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      input.value = connectionProfileLabel(hidden.value, entries);
      setExpanded(false);
      return;
    }
    if (event.key === 'Enter') {
      const matches = renderMatches();
      const exact = matches.find((profile) => cleanText(profile.label).toLowerCase() === cleanText(input.value).toLowerCase());
      const selectedMatch = exact || matches[0];
      if (selectedMatch) {
        event.preventDefault?.();
        commitProfile(selectedMatch);
      }
    }
  });
  renderMatches();

  return el('div', { className: 'recursion-provider-profile-combobox' }, [
    hidden,
    input,
    list
  ]);
}

function syncProviderSourceVisibility(container, lane) {
  const selected = normalizeProviderSource(container?.querySelector?.(providerSelector('source', lane))?.value);
  for (const field of container?.querySelectorAll?.('[data-recursion-provider-context]') || []) {
    if (field.dataset.recursionProviderLane !== lane) continue;
    const sourceTypes = cleanText(field.dataset.recursionProviderSourceTypes).split(/\s+/).filter(Boolean);
    field.hidden = !sourceTypes.includes(selected);
  }
}

function providerReadinessLabel(provider, options = {}) {
  const status = providerModelStatus(provider, options);
  if (!status.ready) {
    return {
      ready: false,
      text: `${status.sourceLabel}: ${status.message}`
    };
  }
  const parts = [`Source: ${status.sourceLabel}`];
  if (status.source === 'host-current-model') {
    if (status.model) parts.push(`Host model: ${status.model}`);
  } else if (status.source === 'host-connection-profile') {
    const profile = cleanText(status.profileLabel || status.label);
    if (profile && profile !== status.sourceLabel) parts.push(`Profile: ${profile}`);
    if (status.model) parts.push(`Model: ${status.model}`);
  } else if (status.source === 'openai-compatible') {
    if (status.model) parts.push(`Model: ${status.model}`);
  } else if (status.label) {
    parts.push(status.label);
  }
  return {
    ready: true,
    text: parts.join(' - ')
  };
}

function providerReadinessNode(provider, lane, options = {}) {
  const label = providerReadinessLabel(provider, options);
  return el('div', {
    className: `recursion-provider-readiness${label.ready ? ' is-ready' : ' is-missing'}`,
    dataset: providerDataset('Readiness', lane)
  }, [
    el('span', { text: label.text })
  ]);
}

function providerFromControls(container, lane, savedProvider = {}) {
  const saved = asObject(savedProvider);
  return {
    ...saved,
    source: controlValue(container, providerSelector('source', lane)) || saved.source || 'host-current-model',
    hostConnectionProfileId: controlValue(container, providerSelector('profile', lane)) || saved.hostConnectionProfileId || '',
    openAICompatible: {
      ...asObject(saved.openAICompatible),
      baseUrl: controlValue(container, providerSelector('base-url', lane)) || saved.openAICompatible?.baseUrl || '',
      model: controlValue(container, providerSelector('model', lane)) || saved.openAICompatible?.model || '',
      sessionApiKeyPresent: Boolean(controlValue(container, providerSelector('api-key', lane)))
        || saved.openAICompatible?.sessionApiKeyPresent === true
    }
  };
}

function syncProviderReadiness(container, lane, savedProvider = {}, options = {}) {
  const target = container?.querySelector?.(providerSelector('readiness', lane));
  if (!target) return;
  const label = providerReadinessLabel(providerFromControls(container, lane, savedProvider), options);
  target.className = `recursion-provider-readiness${label.ready ? ' is-ready' : ' is-missing'}`;
  target.replaceChildren(el('span', { text: label.text }));
}

function fetchedModelOptions(models = []) {
  const normalized = Array.isArray(models) ? models : [];
  return [
    ['', normalized.length ? 'Select fetched model' : 'Fetch models first'],
    ...normalized.map((model) => [cleanText(model.id), cleanText(model.label || model.id)])
      .filter(([id]) => id)
  ];
}

function renderProviderSettings(panel, lane, provider, tooltipsEnabled = true, options = {}) {
  const source = asObject(provider);
  const fetchState = asObject(asObject(options).modelFetchState);
  const connectionProfiles = Array.isArray(options.connectionProfiles) ? options.connectionProfiles : null;
  const readinessOptions = connectionProfiles ? { profiles: connectionProfiles } : {};
  const title = lane === 'reasoner' ? 'Reasoner Provider' : 'Utility Provider';
  const statusText = lane === 'reasoner' && source.enabled !== true
    ? 'optional'
    : providerStatusText(source).toLowerCase();
  const open = lane === 'utility' || source.openAICompatible?.sessionApiKeyPresent === true || Boolean(source.openAICompatible?.model);
  const group = el('section', {
    className: `recursion-provider-section${open ? ' is-open' : ''}`,
    dataset: { recursionProviderSection: '', recursionProviderLane: lane }
  });
  group.appendChild(el('button', {
    className: 'recursion-provider-card',
    attrs: {
      type: 'button',
      'aria-expanded': open ? 'true' : 'false',
      ...tooltipAttrs(tooltipsEnabled, `${title} settings. Choose the model source for this lane, then save and test it before relying on it during generation. Current status: ${statusText}.`)
    },
    dataset: {
      recursionProviderToggle: lane,
      recursionProviderLane: lane,
      ...providerDataset('Toggle', lane)
    }
  }, [
    el('span', { className: 'recursion-provider-card-title', text: title }),
    el('span', {
      className: providerStatusClass(statusText),
      text: statusText,
      dataset: providerDataset('Status', lane)
    })
  ]));
  const body = el('div', {
    className: 'recursion-provider-body',
    dataset: {
      recursionProviderBody: lane,
      ...providerDataset('Body', lane)
    }
  });
  body.hidden = !open;
  renderProviderHiddenDefaults(body, lane, source);
  body.appendChild(hiddenCheckedControl({
    checked: lane === 'utility' ? true : source.enabled === true,
    dataset: providerDataset('Enabled', lane),
    ariaLabel: `${title} enabled`
  }));
  body.appendChild(providerReadinessNode(source, lane, readinessOptions));
  const grid = el('div', { className: 'recursion-provider-grid', dataset: { recursionProviderGrid: '' } });
  const sourceControl = selectControl({
      value: cleanText(source.source, 'host-current-model'),
      options: PROVIDER_SOURCE_OPTIONS,
      dataset: providerDataset('Source', lane),
      ariaLabel: `${title} source`
  });
  setTooltip(sourceControl, tooltipsEnabled, SETTINGS_TOOLTIPS.providerSource);
  const syncSourceControls = () => {
    syncProviderSourceVisibility(body, lane);
    syncProviderReadiness(body, lane, source, readinessOptions);
  };
  sourceControl.addEventListener?.('change', syncSourceControls);
  grid.appendChild(providerField('Source', sourceControl));
  const profileEntries = connectionProfileEntries(source.hostConnectionProfileId, connectionProfiles);
  const profileControl = renderConnectionProfileCombobox({
    selectedId: source.hostConnectionProfileId,
    profiles: profileEntries,
    lane,
    title,
    tooltipsEnabled,
    disabled: profileEntries.length <= 0 && !source.hostConnectionProfileId,
    onCommit: () => syncProviderReadiness(body, lane, source, readinessOptions)
  });
  grid.appendChild(providerField('Profile', profileControl, {
      lane,
      context: 'profile',
      sourceTypes: ['host-connection-profile']
    }));
  const baseUrlControl = inputControl({
    value: source.openAICompatible?.baseUrl || '',
    dataset: providerDataset('BaseUrl', lane),
    ariaLabel: `${title} OpenAI-compatible base URL`,
    placeholder: 'https://host/v1'
  });
  setTooltip(baseUrlControl, tooltipsEnabled, SETTINGS_TOOLTIPS.providerBaseUrl);
  baseUrlControl.addEventListener?.('input', () => syncProviderReadiness(body, lane, source, readinessOptions));
  baseUrlControl.addEventListener?.('change', () => syncProviderReadiness(body, lane, source, readinessOptions));
  const modelControl = inputControl({
    value: source.openAICompatible?.model || '',
    dataset: providerDataset('Model', lane),
    ariaLabel: `${title} model`,
    placeholder: 'model'
  });
  setTooltip(modelControl, tooltipsEnabled, SETTINGS_TOOLTIPS.providerModel);
  modelControl.addEventListener?.('input', () => syncProviderReadiness(body, lane, source, readinessOptions));
  modelControl.addEventListener?.('change', () => syncProviderReadiness(body, lane, source, readinessOptions));
  const modelListControl = selectControl({
    value: '',
    options: fetchedModelOptions(fetchState.models),
    dataset: providerDataset('ModelList', lane),
    ariaLabel: `${title} fetched model list`
  });
  modelListControl.addEventListener?.('change', () => {
    if (modelListControl.value) {
      modelControl.value = modelListControl.value;
      syncProviderReadiness(body, lane, source, readinessOptions);
    }
  });
  const fetchModelsButton = el('button', {
    className: 'recursion-button',
    text: 'Fetch Models',
    attrs: {
      type: 'button',
      'aria-label': `Fetch ${title} models`
    },
    dataset: {
      recursionProviderFetchModels: '',
      recursionProviderLane: lane,
      ...providerDataset('FetchModels', lane)
    }
  });
  const fetchStatus = el('span', {
    className: 'recursion-provider-model-fetch-status',
    text: cleanText(fetchState.status),
    dataset: providerDataset('ModelFetchStatus', lane)
  });
  const modelStack = el('div', { className: 'recursion-provider-model-stack' }, [
    modelControl,
    el('div', { className: 'recursion-provider-model-tools' }, [
      modelListControl,
      fetchModelsButton
    ]),
    fetchStatus
  ]);
  const apiKeyControl = inputControl({
    value: '',
    type: 'password',
    dataset: providerDataset('ApiKey', lane),
    ariaLabel: `${title} session API key`,
    placeholder: source.openAICompatible?.sessionApiKeyPresent ? 'Session key loaded' : 'Session API key'
  });
  setTooltip(apiKeyControl, tooltipsEnabled, SETTINGS_TOOLTIPS.providerApiKey);
  apiKeyControl.addEventListener?.('input', () => syncProviderReadiness(body, lane, source, readinessOptions));
  apiKeyControl.addEventListener?.('change', () => syncProviderReadiness(body, lane, source, readinessOptions));
  const openAiFields = el('div', {
    className: 'recursion-provider-context-fields recursion-provider-openai-fields',
    dataset: {
      recursionProviderContext: 'open-ai',
      recursionProviderLane: lane,
      recursionProviderSourceTypes: 'openai-compatible',
      ...providerDataset('ContextOpenAi', lane)
    }
  }, [
    providerField('Base URL', baseUrlControl),
    providerField('Model', modelStack),
    providerField('Session Key', apiKeyControl)
  ]);
  grid.appendChild(openAiFields);
  const maxTokensControl = inputControl({
      value: source.maxTokens ?? '',
      type: 'number',
      min: 64,
      step: 64,
      dataset: providerDataset('MaxTokens', lane),
      ariaLabel: `${title} max tokens`
  });
  setTooltip(maxTokensControl, tooltipsEnabled, SETTINGS_TOOLTIPS.providerMaxTokens);
  grid.appendChild(providerField('Max Tokens', maxTokensControl));
  syncProviderSourceVisibility(grid, lane);
  body.appendChild(grid);
  body.appendChild(el('div', { className: 'recursion-provider-actions' }, [
    el('button', {
      className: 'recursion-button',
      text: 'Test Provider',
      attrs: {
        type: 'button',
        'aria-label': `Test ${title}`,
        ...tooltipAttrs(tooltipsEnabled, SETTINGS_TOOLTIPS.providerTest)
      },
      dataset: {
        recursionProviderTest: '',
        [`recursion${titleCase(lane)}ProviderTest`]: '',
        recursionProviderLane: lane
      }
    }),
    el('button', {
      className: 'recursion-button',
      text: 'Clear Session Key',
      attrs: {
        type: 'button',
        'aria-label': `Clear ${title} session key`,
        ...tooltipAttrs(tooltipsEnabled, SETTINGS_TOOLTIPS.providerClearKey)
      },
      dataset: {
        recursionProviderClearKey: '',
        [`recursion${titleCase(lane)}ProviderClearKey`]: '',
        recursionProviderLane: lane,
        recursionProviderContext: 'clear-key',
        recursionProviderSourceTypes: 'openai-compatible'
      }
    })
  ]));
  syncProviderSourceVisibility(body, lane);
  group.appendChild(body);
  panel.appendChild(group);
}

function renderSettingsPanel(panel, view, activeTab = 'play', runtime = null, providerModelFetchState = {}) {
  panel.replaceChildren();
  const settings = asObject(view.settings);
  const tooltipsEnabled = asObject(settings.ui).tooltipsEnabled !== false;
  const tabTooltips = {
    play: 'Everyday behavior controls for card pressure, focus, and prompt size.',
    providers: 'Configure Utility and Reasoner model lanes, sources, connection profiles, endpoints, and session keys.',
    advanced: 'Compatibility, display, and diagnostics controls that most users only touch when tuning a setup.'
  };
  panel.appendChild(el('div', { className: 'recursion-settings-header' }, [
    el('h2', { text: 'Settings' }),
    button('Open Viewer', 'recursionViewerToggle', 'Open Recursion viewer')
  ]));
  panel.appendChild(el('div', { className: 'recursion-settings-tabs', dataset: { recursionSettingsTabs: '' } }, [
    ...['play', 'providers', 'advanced'].map((tab) => el('button', {
      className: `recursion-tab-button${activeTab === tab ? ' is-selected' : ''}`,
      text: titleCase(tab),
      attrs: { type: 'button', ...tooltipAttrs(tooltipsEnabled, tabTooltips[tab]) },
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
  const route = providerRouteSummary(settings);
  providersPane.appendChild(el('div', {
    className: 'recursion-provider-route-summary',
    attrs: {
      title: 'Reasoning Level controls routing. Deep per-role provider routing is not a V1 settings surface.'
    },
    dataset: { recursionProviderRouteSummary: '' }
  }, [
    el('span', { text: route.text })
  ]));
  const connectionProfiles = listProviderConnectionProfiles();
  renderProviderSettings(providersPane, 'utility', settings.providers?.utility || {}, tooltipsEnabled, {
    modelFetchState: providerModelFetchState.utility,
    connectionProfiles
  });
  renderProviderSettings(providersPane, 'reasoner', settings.providers?.reasoner || {}, tooltipsEnabled, {
    modelFetchState: providerModelFetchState.reasoner,
    connectionProfiles
  });
  renderAdvancedSettings(advancedPane, settings, {
    resetSceneCache: typeof runtime?.resetSceneCache === 'function'
  });
  playPane.hidden = activeTab !== 'play';
  providersPane.hidden = activeTab !== 'providers';
  advancedPane.hidden = activeTab !== 'advanced';
  panel.appendChild(playPane);
  panel.appendChild(providersPane);
  panel.appendChild(advancedPane);
}

function appendViewerSection(viewer, title, data, options = {}) {
  const section = el('section', { className: 'recursion-viewer-section' });
  section.appendChild(el('h3', { text: title }));
  const pre = el('pre', { dataset: asObject(options).dataset || {} });
  pre.textContent = safeJson(data, { maxString: options.maxString || 900 });
  section.appendChild(pre);
  viewer.appendChild(section);
}

function viewerChip(text, className = '') {
  const label = safeText(cleanText(text), 140);
  if (!label) return null;
  return el('span', { className: `recursion-mini-chip${className ? ` ${className}` : ''}`, text: label });
}

function appendViewerChips(container, values, className = '') {
  for (const value of values) {
    const chip = viewerChip(value, className);
    if (chip) container.appendChild(chip);
  }
}

function compactEvidenceRef(ref) {
  if (typeof ref === 'string') return safeText(ref, 160);
  const source = asObject(ref);
  return safeText(source.id || source.hash || source.ref || source.source || safeJson(source, { maxString: 160 }), 160);
}

function cardLifecycle(card) {
  const source = asObject(card);
  const history = Array.isArray(source.lifecycle)
    ? source.lifecycle
    : Array.isArray(source.lifecycleHistory)
      ? source.lifecycleHistory
      : Array.isArray(source.history)
        ? source.history
        : [];
  return history.slice(0, 6);
}

function appendViewerDeckSection(viewer, hand) {
  const source = asObject(hand);
  const cards = Array.isArray(source.cards) ? source.cards.slice(0, 20) : [];
  const section = el('section', { className: 'recursion-viewer-section recursion-viewer-deck', dataset: { recursionViewerDeck: '' } });
  section.appendChild(el('h3', { text: 'Deck' }));
  if (!cards.length) {
    section.appendChild(el('p', { className: 'recursion-empty', text: 'No cards are active in the current hand.' }));
    viewer.appendChild(section);
    return;
  }

  const list = el('div', { className: 'recursion-viewer-card-list' });
  for (const [index, card] of cards.entries()) {
    const cardSource = asObject(card);
    const family = cardFamily(cardSource);
    const metaChips = [
      cardSource.status,
      cardSource.emphasis,
      cardSource.detailProfile,
      cardSource.origin || cardSource.source || cardSource.provider || cardSource.provenance,
      cardSource.updatedAt,
      cardSource.role || cardSource.target
    ].map((entry) => cleanText(entry, '')).filter(Boolean);
    const evidenceRefs = Array.isArray(cardSource.evidenceRefs) ? cardSource.evidenceRefs.map(compactEvidenceRef).filter(Boolean).slice(0, 8) : [];
    const selectedReason = cleanText(cardSource.selectedReason || cardSource.selectionReason || cardSource.whySelected || '');
    const omittedReason = cleanText(cardSource.omittedReason || cardSource.omissionReason || cardSource.whyOmitted || '');
    const notes = cleanText(cardSource.inspectorNotes || cardSource.inspectorNote || '');
    const lifecycle = cardLifecycle(cardSource);
    const article = el('article', {
      className: 'recursion-viewer-card',
      attrs: { 'aria-label': `${family} card detail` },
      dataset: { recursionViewerCard: cardSource.id || `card-${index + 1}` }
    });

    const header = el('div', { className: 'recursion-viewer-card-head' }, [
      el('span', { className: 'recursion-hand-icon', text: cardFamilyIcon(family), attrs: { 'aria-hidden': 'true' } }),
      el('div', { className: 'recursion-viewer-card-title' }, [
        el('strong', { text: family }),
        el('span', { text: safeText(cardSource.id || cardSource.role || `card-${index + 1}`, 120) })
      ])
    ]);
    const meta = el('div', { className: 'recursion-viewer-card-meta' });
    appendViewerChips(meta, [...new Set(metaChips)]);
    article.appendChild(header);
    if (meta.children.length) article.appendChild(meta);
    article.appendChild(el('p', {
      className: 'recursion-viewer-card-summary',
      text: safeText(cardSummary(cardSource), 260)
    }));
    article.appendChild(el('p', {
      className: 'recursion-viewer-card-text',
      text: safeText(cardText(cardSource) || cardSummary(cardSource), 900),
      dataset: { recursionViewerCardText: '' }
    }));

    if (selectedReason || omittedReason) {
      const reasons = el('div', { className: 'recursion-viewer-card-reasons' });
      if (selectedReason) reasons.appendChild(el('p', { text: `Selected: ${safeText(selectedReason, 260)}` }));
      if (omittedReason) reasons.appendChild(el('p', { text: `Omitted: ${safeText(omittedReason, 260)}` }));
      article.appendChild(reasons);
    }
    if (evidenceRefs.length) {
      const evidence = el('div', { className: 'recursion-viewer-card-evidence' }, [
        el('span', { className: 'recursion-viewer-label', text: 'Evidence' })
      ]);
      appendViewerChips(evidence, evidenceRefs, 'recursion-viewer-ref-chip');
      article.appendChild(evidence);
    }
    if (notes) {
      article.appendChild(el('p', {
        className: 'recursion-viewer-inspector-note',
        text: `Inspector-only: ${safeText(notes.replace(/^inspector-only:\s*/i, ''), 360)}`
      }));
    }
    if (lifecycle.length) {
      const lifecycleList = el('ol', { className: 'recursion-viewer-lifecycle' });
      for (const entry of lifecycle) {
        const item = asObject(entry);
        const label = [
          item.state || item.status || item.event || 'event',
          item.reason || item.summary || item.detail || '',
          item.at || item.recordedAt || item.updatedAt || ''
        ].map((part) => safeText(part, 180)).filter(Boolean).join(' - ');
        lifecycleList.appendChild(el('li', { text: label }));
      }
      article.appendChild(lifecycleList);
    }
    list.appendChild(article);
  }
  section.appendChild(list);
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
  return [
    'sections',
    'prompt',
    'prompttext',
    'rawprompt',
    'rawresponse',
    'providerprompt',
    'providerresponse',
    'hiddenreasoning',
    'stack',
    'stacktrace',
    'trace',
    'traceback',
    'errorstack',
    'apikey',
    'authorization',
    'cookie',
    'password',
    'secret'
  ].includes(normalized);
}

function fallbackPromptBlocksFromPacket(packet) {
  const source = asObject(packet);
  const sections = asObject(source.sections);
  const plan = Array.isArray(source.injectionPlan) ? source.injectionPlan.map(asObject) : [];
  return plan
    .map((entry) => {
      const sectionKey = cleanText(entry.section || entry.id);
      const text = safeText(sections[sectionKey], 5000);
      if (!sectionKey || !text) return null;
      return {
        promptKey: entry.promptKey || sectionKey,
        title: cleanText(entry.title, titleCase(sectionKey)),
        placement: entry.placement || '',
        depth: entry.depth ?? null,
        role: entry.role || '',
        sourceIds: Array.isArray(entry.sourceIds) ? entry.sourceIds : [],
        text,
        hash: ''
      };
    })
    .filter(Boolean);
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
  if (!blocks.length) blocks = fallbackPromptBlocksFromPacket(source);
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

function promptPacketText(packet, hand = {}) {
  const preview = promptPacketPreview(packet, hand);
  return preview.injectedText
    ? safeText(preview.injectedText, Infinity).trim()
    : safeJson(preview, { maxString: 5000 });
}

function promptPacketMeta(preview) {
  const lane = cleanText(preview.composerLane);
  const cardCount = Number(preview.sourceCardCount || 0);
  return [
    lane ? `${laneLabel(lane)} composed` : '',
    cardCount ? `${cardCount} card${cardCount === 1 ? '' : 's'}` : ''
  ].filter(Boolean);
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
  appendViewerDeckSection(viewer, view.lastHand ?? { cards: [] });
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
    attrs: { id: 'recursion-root' },
    dataset: { recursionRoot: '' }
  });

  const bar = el('div', {
    className: 'recursion-bar',
    attrs: { role: 'toolbar', 'aria-label': 'Recursion' },
    dataset: { recursionBar: '' }
  }, [
    el('button', {
      className: 'recursion-power-toggle',
      attrs: { type: 'button', 'aria-label': 'Turn Recursion off', 'aria-pressed': 'true', title: 'Turn Recursion off' },
      dataset: { recursionPowerToggle: '' }
    }, [
      el('span', { className: 'recursion-power-icon', attrs: { 'aria-hidden': 'true' }, dataset: { recursionPowerIcon: '' } }, [
        modeIconSvg('power')
      ])
    ]),
    el('div', { className: 'recursion-pipeline-cluster' }, [
      el('button', {
        className: 'recursion-pipeline-button',
        attrs: { type: 'button', 'aria-label': 'Pipeline', 'aria-expanded': 'false' },
        dataset: { recursionPipelineButton: '', recursionPipelineKind: 'standard' }
      }, [
        el('span', { className: 'recursion-pipeline-icon', attrs: { 'aria-hidden': 'true' }, dataset: { recursionPipelineIcon: '' } }, [pipelineIconSvg('standard')])
      ]),
      el('div', { className: 'recursion-pipeline-menu', attrs: { 'aria-label': 'Recursion pipeline selector' }, dataset: { recursionPipelineMenu: '' } },
        PIPELINE_MENU_OPTIONS.map(pipelineMenuChoice))
    ]),
    el('div', { className: 'recursion-mode-cluster' }, [
      el('button', {
        className: 'recursion-mode-button',
        attrs: { type: 'button', 'aria-label': 'Mode', 'aria-expanded': 'false' },
        dataset: { recursionModeButton: '', recursionModeKind: 'cards' }
      }, [
        el('span', { className: 'recursion-mode-icon', attrs: { 'aria-hidden': 'true' }, dataset: { recursionModeIcon: '' } }, [modeIconSvg('auto')]),
        el('span', { className: 'recursion-mode-text', dataset: { recursionMode: '' } })
      ]),
      el('div', { className: 'recursion-mode-menu', attrs: { 'aria-label': 'Recursion mode selector' }, dataset: { recursionModeMenu: '' } },
        MODE_MENU_OPTIONS.map(modeMenuChoice))
    ]),
    el('button', {
      className: 'recursion-cards-button',
      attrs: { type: 'button', 'aria-label': 'Open card scope selector', 'aria-expanded': 'false', title: 'Open card scope selector' },
      dataset: { recursionCardsButton: '' }
    }, [
      el('span', { className: 'recursion-cards-button-icon', attrs: { 'aria-hidden': 'true' } }, [modeIconSvg('cards')])
    ]),
    el('span', { className: 'recursion-bar-separator', attrs: { 'aria-hidden': 'true' } }),
    el('button', {
      className: 'recursion-activity-trigger',
      attrs: { type: 'button', 'aria-label': 'Open Recursion progress', 'aria-expanded': 'false', title: 'Open generation progress' },
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
    el('button', {
      className: 'recursion-stop-generation',
      attrs: { type: 'button', 'aria-label': 'Stop generation', title: 'Stop generation' },
      dataset: { recursionStopGeneration: '' }
    }, [
      el('span', { className: 'recursion-stop-generation-icon', attrs: { 'aria-hidden': 'true' } }, [
        modeIconSvg('stop')
      ])
    ]),
    el('span', { className: 'recursion-chip recursion-legacy-hand-count', dataset: { recursionHandCount: '' } }),
    el('span', { className: 'recursion-chip recursion-legacy-composer', dataset: { recursionComposer: '' } }),
    el('span', { className: 'recursion-chip recursion-reasoner-chip', dataset: { recursionReasoner: '' } }),
    el('div', { className: 'recursion-right-tools' }, [
      el('div', { className: 'recursion-reasoning-chain', attrs: { role: 'radiogroup', 'aria-label': 'Reasoning level' }, dataset: { recursionReasoningChain: '' } }, [
        el('span', { className: 'recursion-reasoning-line-fill', attrs: { 'aria-hidden': 'true' } }),
        ...REASONING_LEVEL_OPTIONS.map(([level, label]) => el('button', {
          className: 'recursion-reasoning-node',
          attrs: {
            type: 'button',
            role: 'radio',
            'aria-checked': 'false',
            'aria-label': `${label} reasoning level. ${REASONING_LEVEL_TIPS[level] || `${label} reasoning`}`,
            tabindex: '-1',
            title: REASONING_LEVEL_TIPS[level] || `${label} reasoning`
          },
          dataset: {
            recursionReasoningLevelNode: level,
            [`recursionReasoningLevel${titleCase(level)}`]: ''
          }
        }))
      ]),
      el('button', {
        className: 'recursion-icon-button recursion-brief-arrow',
        attrs: { type: 'button', 'aria-label': 'Open last brief preview', 'aria-expanded': 'false', title: 'Open last brief preview' },
        dataset: { recursionHandToggle: '', recursionBriefArrow: '' }
      }, [
        el('span', { className: 'recursion-arrow-down', attrs: { 'aria-hidden': 'true' }, dataset: { recursionArrowDown: '' } })
      ]),
      el('button', {
        className: 'recursion-icon-button recursion-options-button',
        attrs: { type: 'button', 'aria-label': 'Open Recursion options', 'aria-expanded': 'false', title: 'Open Recursion settings' },
        dataset: { recursionActions: '', recursionOptionsButton: '' }
      }, [
        el('span', { className: 'recursion-ellipsis', attrs: { 'aria-hidden': 'true' }, dataset: { recursionEllipsis: '' } }, [
          el('span'),
          el('span'),
          el('span')
        ])
      ])
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

  const cardsPanel = el('div', {
    className: 'recursion-cards-panel',
    attrs: { 'aria-label': 'Card scope selector' },
    dataset: { recursionCardsPanel: '' }
  });
  cardsPanel.hidden = true;

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
  const hiddenViewerToggle = button('Open Viewer', 'recursionViewerToggle', 'Open Recursion viewer');
  hiddenViewerToggle.className = 'recursion-visually-hidden';
  hiddenViewerToggle.setAttribute('tabindex', '-1');
  hiddenViewerToggle.setAttribute('aria-hidden', 'true');

  root.appendChild(bar);
  root.appendChild(statusPopover);
  root.appendChild(ribbon);
  root.appendChild(hand);
  root.appendChild(cardsPanel);
  root.appendChild(settingsPanel);
  root.appendChild(hiddenViewerToggle);
  root.appendChild(viewer);
  root.querySelector('[data-recursion-pipeline-menu]').hidden = true;
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

function targetWithin(target, elements) {
  let node = target;
  while (node) {
    if (elements.includes(node)) return true;
    node = node.parentNode;
  }
  return false;
}

function eventWithin(event, elements) {
  const path = typeof event?.composedPath === 'function' ? event.composedPath() : null;
  if (Array.isArray(path) && path.length) {
    return elements.some((element) => element && path.includes(element));
  }
  return targetWithin(event?.target, elements);
}

function consumeClickEvent(event) {
  event?.preventDefault?.();
  event?.stopImmediatePropagation?.();
  event?.stopPropagation?.();
}

export function mountRecursionUi({ runtime, mountPoint = null } = {}) {
  if (!canUseDocument()) return noopMount();

  const root = buildRoot();
  insertRoot(root, mountPoint);
  const handPanel = root.querySelector('[data-recursion-hand-dropdown]');
  const cardsPanel = root.querySelector('[data-recursion-cards-panel]');
  const settingsPanel = root.querySelector('[data-recursion-settings-panel]');
  const statusPopover = root.querySelector('[data-recursion-status-popover]');
  const actionsButton = root.querySelector('[data-recursion-actions]');
  const powerButton = root.querySelector('[data-recursion-power-toggle]');
  const handButton = root.querySelector('[data-recursion-hand-toggle]');
  const cardsButton = root.querySelector('[data-recursion-cards-button]');
  const pipelineButton = root.querySelector('[data-recursion-pipeline-button]');
  const modeButton = root.querySelector('[data-recursion-mode-button]');
  const statusButton = root.querySelector('[data-recursion-status-trigger]');
  const stopGenerationButton = root.querySelector('[data-recursion-stop-generation]');
  const reasoningChain = root.querySelector('[data-recursion-reasoning-chain]');
  const pipelineMenu = root.querySelector('[data-recursion-pipeline-menu]');
  const modeMenu = root.querySelector('[data-recursion-mode-menu]');
  const viewer = root.querySelector('[data-recursion-viewer]');
  const ribbon = root.querySelector('[data-recursion-activity-ribbon]');
  let settingsPanelRendered = false;
  let settingsTab = 'play';
  const panelRerenderClickEvents = typeof WeakSet === 'function' ? new WeakSet() : null;
  let ribbonVisible = false;
  let ribbonRevealTimer = null;
  let ribbonSuccessTimer = null;
  let ribbonSuccessTimerKey = '';
  let collapsedSuccessKey = '';
  let transientCurrentStepText = '';
  let transientCurrentStepStatusKey = '';
  let transientCurrentStepTimer = null;
  let standbyStatusKey = '';
  let expiredStandbyStatusKey = '';
  let standbyStatusTimer = null;
  let cardScopeNotice = '';
  let pendingCardScope = null;
  const focusOriginByPanel = typeof WeakMap === 'function' ? new WeakMap() : new Map();
  const providerModelFetchState = {
    utility: { models: [], status: '' },
    reasoner: { models: [], status: '' }
  };

  function rememberPanelFocus(panel, trigger) {
    if (!panel) return;
    if (trigger) focusOriginByPanel.set(panel, trigger);
    focusPanel(panel);
  }

  function restorePanelFocus(panel, fallback = null) {
    const target = focusOriginByPanel.get(panel) || fallback;
    focusOriginByPanel.delete(panel);
    if (target) focusNode(target);
  }

  function clearRibbonRevealTimer() {
    if (ribbonRevealTimer !== null && typeof clearTimeout === 'function') clearTimeout(ribbonRevealTimer);
    ribbonRevealTimer = null;
  }

  function clearRibbonSuccessTimer() {
    if (ribbonSuccessTimer !== null && typeof clearTimeout === 'function') clearTimeout(ribbonSuccessTimer);
    ribbonSuccessTimer = null;
    ribbonSuccessTimerKey = '';
  }

  function clearTransientCurrentStepText({ updateView = false } = {}) {
    if (transientCurrentStepTimer !== null && typeof clearTimeout === 'function') clearTimeout(transientCurrentStepTimer);
    transientCurrentStepTimer = null;
    transientCurrentStepText = '';
    transientCurrentStepStatusKey = '';
    if (updateView) update();
  }

  function clearStandbyStatusTimer() {
    if (standbyStatusTimer !== null && typeof clearTimeout === 'function') clearTimeout(standbyStatusTimer);
    standbyStatusTimer = null;
  }

  function statusFingerprint(view, model) {
    const activity = asObject(view.activity);
    return [
      model.currentStepText || '',
      model.standbyStatusText || '',
      model.runtimeHealthLabel || '',
      activity.runId || '',
      activity.recordedAt || '',
      activity.phase || '',
      activity.label || '',
      model.progressRun?.runId || '',
      model.progressRun?.heroPixelState || '',
      model.progressRun?.activeCount ?? ''
    ].map((entry) => String(entry)).join('|');
  }

  function standbyStatusFingerprint(view, model) {
    const activity = asObject(view.activity);
    return [
      model.standbyStatusText || '',
      model.enabled ? 'on' : 'off',
      model.mode || '',
      model.pipelineMode || '',
      model.handCount ?? '',
      cleanText(view.lastHand?.handId),
      cleanText(view.lastPacket?.packetId),
      cleanText(view.lastSnapshot?.chatKey || view.lastSnapshot?.chatId),
      cleanText(view.lastSnapshot?.sceneKey),
      activity.runId || '',
      activity.recordedAt || '',
      activity.phase || '',
      activity.severity || '',
      activity.label || ''
    ].map((entry) => String(entry)).join('|');
  }

  function standbyStatusTextForRender(view, model) {
    if (!model.standbyStatusText || model.currentStepText) {
      clearStandbyStatusTimer();
      standbyStatusKey = '';
      expiredStandbyStatusKey = '';
      return '';
    }
    const key = standbyStatusFingerprint(view, model);
    if (key !== standbyStatusKey) {
      clearStandbyStatusTimer();
      standbyStatusKey = key;
      expiredStandbyStatusKey = '';
    }
    if (expiredStandbyStatusKey === key) return '';
    if (standbyStatusTimer === null && typeof setTimeout === 'function') {
      standbyStatusTimer = setTimeout(() => {
        standbyStatusTimer = null;
        expiredStandbyStatusKey = key;
        update();
      }, STANDBY_STATUS_TIMEOUT_MS);
    }
    return model.standbyStatusText;
  }

  function currentStepTextForRender(view, model) {
    if (!transientCurrentStepText) return model.currentStepText || standbyStatusTextForRender(view, model);
    if (statusFingerprint(view, model) !== transientCurrentStepStatusKey) {
      clearTransientCurrentStepText();
      return model.currentStepText || standbyStatusTextForRender(view, model);
    }
    return transientCurrentStepText;
  }

  function showTransientCurrentStepText(text) {
    const view = currentView();
    const model = createRecursionViewModel(view);
    clearTransientCurrentStepText();
    transientCurrentStepText = cleanText(text);
    transientCurrentStepStatusKey = statusFingerprint(view, model);
    if (typeof setTimeout === 'function') {
      transientCurrentStepTimer = setTimeout(() => {
        clearTransientCurrentStepText({ updateView: true });
      }, 2000);
    }
    update();
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
    const viewportTop = Number(globalThis.visualViewport?.offsetTop) || 0;
    const viewportHeight = Number(globalThis.visualViewport?.height)
      || Number(globalThis.innerHeight)
      || Number(document.documentElement?.clientHeight)
      || 0;
    const viewportBottom = viewportTop + viewportHeight;
    const bottomGutter = 14;
    const resolvedTop = Math.max(viewportTop, Number(top) || 0);
    const maxHeight = Math.max(0, Math.floor(viewportBottom - resolvedTop - bottomGutter));
    element.style.position = 'fixed';
    element.style.left = `${Math.round(left)}px`;
    element.style.right = 'auto';
    element.style.top = `${Math.round(resolvedTop)}px`;
    element.style.width = `${Math.round(width)}px`;
    element.style.zIndex = String(zIndex);
    element.style.maxHeight = `${maxHeight}px`;
  }

  function syncFloatingPanelGeometry() {
    const bar = root.querySelector('[data-recursion-bar]');
    if (!bar || typeof bar.getBoundingClientRect !== 'function') return;
    const rect = bar.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const viewportLeft = Number(globalThis.visualViewport?.offsetLeft) || 0;
    const viewportTop = Number(globalThis.visualViewport?.offsetTop) || 0;
    const viewportWidth = Math.max(0, Number(globalThis.visualViewport?.width || globalThis.innerWidth || document.documentElement?.clientWidth || rect.right || 0));
    const viewportRight = viewportLeft + viewportWidth;
    const rootLeft = Math.max(viewportLeft, rect.left);
    const rootRight = Math.min(viewportRight, rect.right);
    const rootWidth = Math.max(0, rootRight - rootLeft);
    const progressTop = Math.max(viewportTop, rect.bottom + 3);
    const settingsTop = Math.max(viewportTop, rect.bottom + 5);
    const progressWidth = Math.min(352, rootWidth);
    setFixedPanelGeometry(statusPopover, { left: rootLeft, top: progressTop, width: progressWidth, zIndex: 10020 });
    setFixedPanelGeometry(handPanel, { left: rootLeft, top: settingsTop, width: rootWidth, zIndex: 10010 });
    setFixedPanelGeometry(cardsPanel, { left: rootLeft, top: settingsTop, width: rootWidth, zIndex: 10016 });
    setFixedPanelGeometry(settingsPanel, { left: rootLeft, top: settingsTop, width: rootWidth, zIndex: 10022 });
    if (pipelineMenu?.style) {
      const pipelineRect = root.querySelector('[data-recursion-pipeline-button]')?.getBoundingClientRect?.();
      if (pipelineRect) setFixedPanelGeometry(pipelineMenu, {
        left: Math.max(viewportLeft, Math.min(pipelineRect.left + 6, viewportRight - 222)),
        top: progressTop,
        width: Math.min(222, viewportWidth),
        zIndex: 10018
      });
    }
    if (modeMenu?.style) {
      const modeRect = root.querySelector('[data-recursion-mode-button]')?.getBoundingClientRect?.();
      if (modeRect) setFixedPanelGeometry(modeMenu, {
        left: Math.max(viewportLeft, Math.min(modeRect.left + 6, viewportRight - 222)),
        top: progressTop,
        width: Math.min(222, viewportWidth),
        zIndex: 10018
      });
    }
  }

  function setModeMenuOpen(open) {
    if (!modeMenu) return;
    modeMenu.hidden = !open;
    modeButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) rememberPanelFocus(modeMenu, modeButton);
    else restorePanelFocus(modeMenu, modeButton);
  }

  function setPipelineMenuOpen(open) {
    if (!pipelineMenu) return;
    pipelineMenu.hidden = !open;
    pipelineButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) rememberPanelFocus(pipelineMenu, pipelineButton);
    else restorePanelFocus(pipelineMenu, pipelineButton);
  }

  function renderPipelineMenuSelection(pipelineMode) {
    const selectedPipeline = normalizePipelineMode(pipelineMode);
    for (const choice of root.querySelectorAll('[data-recursion-pipeline-choice]')) {
      const selected = cleanText(choice.dataset.recursionPipelineChoice).toLowerCase() === selectedPipeline;
      choice.className = selected ? 'recursion-pipeline-choice is-selected' : 'recursion-pipeline-choice';
      choice.setAttribute('aria-current', selected ? 'true' : 'false');
    }
  }

  function renderModeMenuSelection(mode) {
    const selectedMode = normalizeMode(mode);
    for (const choice of root.querySelectorAll('[data-recursion-mode-choice]')) {
      const selected = cleanText(choice.dataset.recursionModeChoice).toLowerCase() === selectedMode;
      choice.className = selected ? 'recursion-mode-choice is-selected' : 'recursion-mode-choice';
      choice.setAttribute('aria-current', selected ? 'true' : 'false');
    }
  }

  function setProgressPopoverOpen(open) {
    if (open) setModeMenuOpen(false);
    if (open) setPipelineMenuOpen(false);
    if (open && settingsPanel.hidden === false) setSettingsPanelOpen(false);
    if (open && cardsPanel.hidden === false) setCardsPanelOpen(false);
    statusPopover.hidden = !open;
    statusButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) rememberPanelFocus(statusPopover, statusButton);
    else restorePanelFocus(statusPopover, statusButton);
    syncFloatingPanelGeometry();
  }

  function setHandPanelOpen(open) {
    if (open) {
      if (cardsPanel.hidden === false) setCardsPanelOpen(false);
      setModeMenuOpen(false);
      setPipelineMenuOpen(false);
    }
    handPanel.hidden = !open;
    handButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) rememberPanelFocus(handPanel, handButton);
    else restorePanelFocus(handPanel, handButton);
    syncFloatingPanelGeometry();
  }

  function setSettingsPanelOpen(open) {
    if (open && statusPopover.hidden === false) setProgressPopoverOpen(false);
    if (open && cardsPanel.hidden === false) setCardsPanelOpen(false);
    settingsPanel.hidden = !open;
    actionsButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      setHandPanelOpen(false);
      setModeMenuOpen(false);
      setPipelineMenuOpen(false);
      settingsPanelRendered = false;
      update();
      rememberPanelFocus(settingsPanel, actionsButton);
    } else {
      restorePanelFocus(settingsPanel, actionsButton);
    }
    syncFloatingPanelGeometry();
  }

  function setCardsPanelOpen(open) {
    if (open) {
      setProgressPopoverOpen(false);
      setHandPanelOpen(false);
      setSettingsPanelOpen(false);
      setModeMenuOpen(false);
      setPipelineMenuOpen(false);
    }
    cardsPanel.hidden = !open;
    cardsButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) cardScopeNotice = '';
    if (open) {
      renderCardsPanelForView(currentView());
      rememberPanelFocus(cardsPanel, cardsButton);
    } else {
      restorePanelFocus(cardsPanel, cardsButton);
    }
    syncFloatingPanelGeometry();
  }

  function viewWithPendingCardScope(view) {
    if (!pendingCardScope) return view;
    const viewScope = normalizeCardScope(asObject(asObject(view).settings).cardScope || defaultCardScope());
    if (cardScopeKey(viewScope) === cardScopeKey(pendingCardScope)) {
      pendingCardScope = null;
      return view;
    }
    const source = asObject(view);
    return {
      ...source,
      settings: {
        ...asObject(source.settings),
        cardScope: pendingCardScope
      }
    };
  }

  function cardScopeKey(scope) {
    return stableStringify(normalizeCardScope(scope || defaultCardScope()));
  }

  function clearPendingCardScope(scope) {
    if (pendingCardScope && cardScopeKey(pendingCardScope) === cardScopeKey(scope)) pendingCardScope = null;
  }

  function renderCardsPanelForView(view, notice = cardScopeNotice) {
    const effectiveView = viewWithPendingCardScope(view);
    renderCardsPanel(cardsPanel, effectiveView, createRecursionViewModel(effectiveView), notice);
  }

  function applyCardScopeResult(result) {
    if (result?.blocked) {
      cardScopeNotice = 'Keep at least one card focus enabled.';
      renderCardsPanelForView(currentView());
      return;
    }
    cardScopeNotice = '';
    const nextScope = normalizeCardScope(result?.scope || defaultCardScope());
    pendingCardScope = nextScope;
    renderCardsPanelForView(currentView());
    const action = runtime?.updateSettings?.({ cardScope: nextScope });
    if (!action) return;
    runAction(Promise.resolve(action).catch(() => {
      clearPendingCardScope(nextScope);
      renderCardsPanelForView(currentView());
    }), () => update());
  }

  function setDisclosureOpen(toggle, body, section, open) {
    if (!toggle || !body) return;
    const nextOpen = Boolean(open);
    toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    body.hidden = !nextOpen;
    section?.classList?.toggle?.('is-open', nextOpen);
  }

  function replaceSelectOptions(select, options = []) {
    if (!select) return;
    select.replaceChildren(...options.map(([value, label]) => el('option', { text: label, attrs: { value } })));
    select.value = '';
  }

  function setProviderModelFetchStatus(lane, status) {
    const resolvedLane = lane === 'reasoner' ? 'reasoner' : 'utility';
    providerModelFetchState[resolvedLane] = {
      ...providerModelFetchState[resolvedLane],
      status: cleanText(status)
    };
    setText(root, providerSelector('model-fetch-status', resolvedLane), providerModelFetchState[resolvedLane].status);
  }

  function applyProviderModelFetchResult(lane, result) {
    const resolvedLane = lane === 'reasoner' ? 'reasoner' : 'utility';
    if (result?.ok === false) {
      const message = cleanText(result.error?.message, 'Model fetch failed.');
      providerModelFetchState[resolvedLane] = { models: [], status: message };
      replaceSelectOptions(root.querySelector(providerSelector('model-list', resolvedLane)), fetchedModelOptions([]));
      setText(root, providerSelector('model-fetch-status', resolvedLane), message);
      return result;
    }
    const models = Array.isArray(result?.models) ? result.models : [];
    providerModelFetchState[resolvedLane] = {
      models,
      status: models.length ? `${models.length} models` : 'No models returned.'
    };
    replaceSelectOptions(root.querySelector(providerSelector('model-list', resolvedLane)), fetchedModelOptions(models));
    setText(root, providerSelector('model-fetch-status', resolvedLane), providerModelFetchState[resolvedLane].status);
    return result;
  }

  function applyReasoningLevel(reasoningLevel, { focus = false } = {}) {
    const normalized = normalizeReasoningLevel(reasoningLevel);
    runAction(runtime?.updateSettings?.({
      reasoningLevel: normalized,
      reasonerUse: reasonerUseForReasoningLevel(normalized)
    }));
    if (focus) focusNode(root.querySelector(`[data-recursion-reasoning-level-${normalized}]`));
    showTransientCurrentStepText(`Reasoning Level: ${reasoningLevelLabel(normalized)}`);
  }

  function handleReasoningKeydown(event) {
    const target = closestDatasetElement(event?.target, 'recursionReasoningLevelNode', reasoningChain);
    if (!target) return;
    const currentIndex = REASONING_LEVELS.indexOf(normalizeReasoningLevel(target.dataset.recursionReasoningLevelNode));
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event?.key === 'ArrowRight' || event?.key === 'ArrowDown') nextIndex = Math.min(REASONING_LEVELS.length - 1, currentIndex + 1);
    else if (event?.key === 'ArrowLeft' || event?.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
    else if (event?.key === 'Home') nextIndex = 0;
    else if (event?.key === 'End') nextIndex = REASONING_LEVELS.length - 1;
    else return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    applyReasoningLevel(REASONING_LEVELS[nextIndex], { focus: true });
  }

  actionsButton?.addEventListener('click', (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (event?.isTrusted === false && !settingsPanel.hidden) {
      setSettingsPanelOpen(true);
      return;
    }
    setSettingsPanelOpen(settingsPanel.hidden);
  });
  handButton?.addEventListener('click', () => {
    setHandPanelOpen(handPanel.hidden);
  });
  cardsButton?.addEventListener('click', () => {
    setCardsPanelOpen(cardsPanel.hidden);
  });
  pipelineButton?.addEventListener('click', (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    panelRerenderClickEvents?.add(event);
    const open = pipelineMenu?.hidden !== false;
    if (open) {
      setProgressPopoverOpen(false);
      setHandPanelOpen(false);
      setSettingsPanelOpen(false);
      setCardsPanelOpen(false);
      setModeMenuOpen(false);
    }
    setPipelineMenuOpen(open);
    syncFloatingPanelGeometry();
  });
  modeButton?.addEventListener('click', (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    panelRerenderClickEvents?.add(event);
    const open = modeMenu?.hidden !== false;
    if (open) {
      setProgressPopoverOpen(false);
      setHandPanelOpen(false);
      setSettingsPanelOpen(false);
      setCardsPanelOpen(false);
      setPipelineMenuOpen(false);
    }
    setModeMenuOpen(open);
    syncFloatingPanelGeometry();
  });
  powerButton?.addEventListener('click', () => {
    const view = currentView();
    runAction(runtime?.updateSettings?.({ enabled: view.settings?.enabled === false }));
  });
  statusButton?.addEventListener('click', () => {
    setProgressPopoverOpen(statusPopover.hidden);
  });
  stopGenerationButton?.addEventListener('click', (event) => {
    consumeClickEvent(event);
    setProgressPopoverOpen(false);
    const action = runtime?.stopGeneration?.({ source: 'recursion-ui' });
    update();
    runAction(action, () => update());
  });
  reasoningChain?.addEventListener('keydown', handleReasoningKeydown);
  const handleSettingsAutoSave = (event) => {
    const target = event?.target;
    if (!isSettingsAutoSaveControl(target)) return;
    const patch = readSettingsPatch(root);
    const rerenderSettings = Object.prototype.hasOwnProperty.call(asObject(target.dataset), 'recursionSettingTooltipsEnabled');
    if (rerenderSettings) {
      settingsPanelRendered = false;
      update(viewWithSettingsPatch(currentView(), patch));
    }
    const action = runtime?.updateSettings?.(patch);
    if (rerenderSettings && action === undefined) return;
    runAction(action, () => {
      if (rerenderSettings) settingsPanelRendered = false;
      update();
    });
  };
  const handleProviderAutoSave = (event) => {
    const target = event?.target;
    if (!isProviderAutoSaveControl(target)) return;
    const lane = providerLaneFromDataset(target.dataset);
    runAction(runtime?.updateProvider?.(lane, readProviderPatch(root, lane)), () => {
      settingsPanelRendered = false;
      update();
    });
  };
  settingsPanel.addEventListener?.('input', handleSettingsAutoSave);
  settingsPanel.addEventListener?.('change', handleSettingsAutoSave);
  settingsPanel.addEventListener?.('change', handleProviderAutoSave);
  root.addEventListener('click', (event) => {
    const target = event?.target;
    const control = (key) => closestDatasetElement(target, key, root);
    if (control('recursionViewerClose')) {
      if (typeof viewer.close === 'function' && viewer.open) viewer.close();
      viewer.hidden = true;
      restorePanelFocus(viewer);
    }
    const viewerToggle = control('recursionViewerToggle');
    if (viewerToggle) {
      consumeClickEvent(event);
      setProgressPopoverOpen(false);
      setHandPanelOpen(false);
      setCardsPanelOpen(false);
      setSettingsPanelOpen(false);
      setModeMenuOpen(false);
      setPipelineMenuOpen(false);
      openViewer(viewerToggle);
    }
    if (control('recursionCopyPromptPacket')) {
      const view = currentView();
      const packetText = promptPacketText(view.lastPacket, view.lastHand);
      runAction(globalThis.navigator?.clipboard?.writeText?.(packetText));
    }
    const settingsDisclosure = control('recursionSettingsSectionToggle');
    if (settingsDisclosure) {
      const id = cleanText(settingsDisclosure.dataset.recursionSettingsSectionToggle);
      const body = id ? root.querySelector(`[data-recursion-settings-section-body-${id}]`) : null;
      const section = id ? root.querySelector(`[data-recursion-settings-section-${id}]`) : null;
      setDisclosureOpen(settingsDisclosure, body, section, body?.hidden === true);
    }
    const providerDisclosure = control('recursionProviderToggle');
    if (providerDisclosure) {
      const lane = providerLaneFromDataset(providerDisclosure.dataset);
      const body = root.querySelector(`[data-recursion-provider-body-${lane}]`);
      const section = closestDatasetElement(providerDisclosure, 'recursionProviderSection', root);
      setDisclosureOpen(providerDisclosure, body, section, body?.hidden === true);
    }
    if (control('recursionResetSceneCache')) {
      runAction(runtime?.resetSceneCache?.(), () => {
        settingsPanelRendered = false;
        update();
      });
    }
    if (control('recursionClearRunJournal')) {
      runAction(runtime?.clearRunJournal?.(), () => {
        settingsPanelRendered = false;
        update();
      });
    }
    if (control('recursionExportDiagnostics')) {
      runAction(Promise.resolve(runtime?.exportDiagnostics?.()).then((result) => {
        const payload = result?.diagnostics || result || {};
        return globalThis.navigator?.clipboard?.writeText?.(safeJson(payload, { maxString: 5000 }));
      }));
    }
    const modeChoice = control('recursionModeChoice');
    if (modeChoice) {
      runAction(runtime?.updateSettings?.({ mode: modeChoice.dataset.recursionModeChoice }));
      setModeMenuOpen(false);
    }
    const pipelineChoice = control('recursionPipelineChoice');
    if (pipelineChoice) {
      runAction(runtime?.updateSettings?.({ pipelineMode: normalizePipelineMode(pipelineChoice.dataset.recursionPipelineChoice) }));
      setPipelineMenuOpen(false);
    }
    const familyToggle = control('recursionCardScopeFamilyToggle');
    if (familyToggle) {
      panelRerenderClickEvents?.add(event);
      const view = viewWithPendingCardScope(currentView());
      const scope = normalizeCardScope(view.settings?.cardScope || defaultCardScope());
      const family = familyToggle.dataset.recursionCardScopeFamilyName;
      applyCardScopeResult(setFamilyEnabled(scope, family, familyState(scope, family) !== 'on'));
    }
    const subItemToggle = control('recursionCardScopeSubItemToggle');
    if (subItemToggle) {
      panelRerenderClickEvents?.add(event);
      const view = viewWithPendingCardScope(currentView());
      const scope = normalizeCardScope(view.settings?.cardScope || defaultCardScope());
      const family = subItemToggle.dataset.recursionCardScopeFamilyName;
      const subItem = subItemToggle.dataset.recursionCardScopeSubItem;
      const enabled = subItemToggle.getAttribute('aria-pressed') !== 'true';
      applyCardScopeResult(setSubItemEnabled(scope, family, subItem, enabled));
    }
    const cardScopeAll = control('recursionCardScopeAll');
    if (cardScopeAll && cardScopeAll.disabled !== true) {
      panelRerenderClickEvents?.add(event);
      applyCardScopeResult({ scope: defaultCardScope(), blocked: false });
    }
    const reasoningNode = control('recursionReasoningLevelNode');
    if (reasoningNode) {
      applyReasoningLevel(reasoningNode.dataset.recursionReasoningLevelNode, { focus: true });
    }
    const settingsTabControl = control('recursionSettingsTab');
    if (settingsTabControl) {
      panelRerenderClickEvents?.add(event);
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      event?.stopPropagation?.();
      settingsTab = ['play', 'providers', 'advanced'].includes(settingsTabControl.dataset.recursionSettingsTab)
        ? settingsTabControl.dataset.recursionSettingsTab
        : 'play';
      const view = currentView();
      renderSettingsPanel(settingsPanel, view, settingsTab, runtime, providerModelFetchState);
      settingsPanelRendered = true;
      syncStaticTooltips(root, createRecursionViewModel(view));
      syncFloatingPanelGeometry();
    }
    const providerFetchModels = control('recursionProviderFetchModels');
    if (providerFetchModels) {
      consumeClickEvent(event);
      const lane = providerLaneFromDataset(providerFetchModels.dataset);
      setProviderModelFetchStatus(lane, 'Fetching models...');
      runAction(Promise.resolve(runtime?.fetchProviderModels?.(lane, readProviderPatch(root, lane)))
        .then((result) => applyProviderModelFetchResult(lane, result || {
          ok: false,
          error: { message: 'Model fetch is unavailable.' }
        })));
    }
    const providerTest = control('recursionProviderTest');
    if (providerTest) {
      consumeClickEvent(event);
      const lane = providerLaneFromDataset(providerTest.dataset);
      runAction(runtime?.testProvider?.(lane), () => {
        settingsPanelRendered = false;
        update();
      });
    }
    const providerClearKey = control('recursionProviderClearKey');
    if (providerClearKey) {
      consumeClickEvent(event);
      const lane = providerLaneFromDataset(providerClearKey.dataset);
      runAction(runtime?.clearProviderKey?.(lane));
      settingsPanelRendered = false;
      update();
    }
  });

  function handleDocumentClick(event) {
    const target = event?.target;
    if (!target) return;
    if (panelRerenderClickEvents?.has(event)) return;

    if (statusPopover.hidden === false && !eventWithin(event, [
      statusPopover,
      statusButton,
      powerButton,
      pipelineButton,
      pipelineMenu,
      handButton,
      handPanel,
      cardsButton,
      cardsPanel,
      actionsButton,
      settingsPanel
    ])) {
      setProgressPopoverOpen(false);
    }
    if (modeMenu?.hidden === false && !eventWithin(event, [modeMenu, modeButton])) {
      setModeMenuOpen(false);
    }
    if (pipelineMenu?.hidden === false && !eventWithin(event, [pipelineMenu, pipelineButton])) {
      setPipelineMenuOpen(false);
    }
    if (handPanel.hidden === false && !eventWithin(event, [handPanel, handButton, statusPopover])) {
      setHandPanelOpen(false);
    }
    if (cardsPanel.hidden === false && !eventWithin(event, [cardsPanel, cardsButton])) {
      setCardsPanelOpen(false);
    }
    if (settingsPanel.hidden === false && !eventWithin(event, [
      settingsPanel,
      actionsButton,
      statusPopover,
      statusButton,
      powerButton,
      cardsButton,
      cardsPanel
    ])) {
      setSettingsPanelOpen(false);
    }
  }

  function handleDocumentKeydown(event) {
    if (event?.key !== 'Escape') return;
    setModeMenuOpen(false);
    setPipelineMenuOpen(false);
    setProgressPopoverOpen(false);
    setHandPanelOpen(false);
    setCardsPanelOpen(false);
    setSettingsPanelOpen(false);
  }

  document.addEventListener?.('click', handleDocumentClick);
  document.addEventListener?.('keydown', handleDocumentKeydown);
  const handleViewportChange = () => syncFloatingPanelGeometry();
  globalThis.visualViewport?.addEventListener?.('resize', handleViewportChange);
  globalThis.visualViewport?.addEventListener?.('scroll', handleViewportChange);
  globalThis.addEventListener?.('resize', handleViewportChange);
  globalThis.addEventListener?.('orientationchange', handleViewportChange);

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

  function openViewer(trigger = null) {
    viewer.hidden = false;
    if (typeof viewer.showModal === 'function') {
      if (!viewer.open) viewer.showModal();
    }
    rememberPanelFocus(viewer, trigger);
  }

  function providerLaneFromDataset(dataset) {
    if (dataset.recursionProviderLane === 'reasoner') return 'reasoner';
    for (const key of Object.keys(asObject(dataset))) {
      if (/Reasoner$/.test(key)) return 'reasoner';
      if (/Utility$/.test(key)) return 'utility';
    }
    return 'utility';
  }

  function readSettingsPatch(sourceRoot) {
    const defaultUi = DEFAULT_RECURSION_SETTINGS.ui;
    const defaultInjection = DEFAULT_RECURSION_SETTINGS.injection;
    const injectionDepth = controlValue(sourceRoot, '[data-recursion-setting-injection-depth]');
    return {
      strength: controlValue(sourceRoot, '[data-recursion-setting-strength]'),
      minCards: integerInRange(
        controlNumber(sourceRoot, '[data-recursion-setting-min-cards]', DEFAULT_RECURSION_SETTINGS.minCards),
        DEFAULT_RECURSION_SETTINGS.minCards,
        0,
        20
      ),
      maxCards: integerInRange(
        controlNumber(sourceRoot, '[data-recursion-setting-max-cards]', DEFAULT_RECURSION_SETTINGS.maxCards),
        DEFAULT_RECURSION_SETTINGS.maxCards,
        0,
        20
      ),
      promptFootprint: controlValue(sourceRoot, '[data-recursion-setting-footprint]'),
      focus: controlValue(sourceRoot, '[data-recursion-setting-focus]'),
      ui: {
        tooltipsEnabled: controlChecked(sourceRoot, '[data-recursion-setting-tooltips-enabled]'),
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
      },
      injection: {
        placement: controlValue(sourceRoot, '[data-recursion-setting-injection-placement]') || defaultInjection.placement,
        role: controlValue(sourceRoot, '[data-recursion-setting-injection-role]') || defaultInjection.role,
        depth: integerInRange(injectionDepth, defaultInjection.depth, 0, 10)
      }
    };
  }

  function readProviderPatch(sourceRoot, lane) {
    const apiKey = controlValue(sourceRoot, providerSelector('api-key', lane));
    const providerDefaults = DEFAULT_RECURSION_SETTINGS.providers[lane] || DEFAULT_RECURSION_SETTINGS.providers.utility;
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
      maxTokens: controlNumber(sourceRoot, providerSelector('max-tokens', lane), providerDefaults.maxTokens)
    };
    if (apiKey) patch.apiKey = apiKey;
    return patch;
  }

  function currentView() {
    try {
      return typeof runtime?.view === 'function' ? runtime.view() : {};
    } catch (error) {
      return {
        settings: { enabled: true, mode: 'auto' },
        activity: {
          phase: 'runtimeViewFailed',
          severity: 'error',
          label: cleanText(error?.message || error, 'Recursion view unavailable.')
        }
      };
    }
  }

  function update(viewOverride = null) {
    const view = viewOverride || currentView();
    const model = createRecursionViewModel(view);
    setText(root, '[data-recursion-status]', model.runtimeHealthLabel);
    setText(root, '[data-recursion-mode]', model.modeLabel);
    setText(root, '[data-recursion-current-step]', currentStepTextForRender(view, model));
    const pipelineButton = root.querySelector('[data-recursion-pipeline-button]');
    if (pipelineButton) {
      const pipelineKind = pipelineIcon(model.pipelineMode);
      const pipelineTitle = `Pipeline: ${model.pipelineLabel}`;
      pipelineButton.dataset.recursionPipelineKind = pipelineKind;
      pipelineButton.setAttribute('aria-label', pipelineTitle);
      setTooltip(pipelineButton, model.tooltipsEnabled, pipelineTitle);
      renderPipelineIcon(root.querySelector('[data-recursion-pipeline-icon]'), pipelineKind);
    }
    const modeButton = root.querySelector('[data-recursion-mode-button]');
    if (modeButton) {
      const modeKind = modeIcon(model.mode);
      const modeLabel = `Mode: ${model.modeLabel}`;
      modeButton.dataset.recursionModeKind = modeKind;
      modeButton.setAttribute('aria-label', modeLabel);
      setTooltip(modeButton, model.tooltipsEnabled, modeLabel);
      renderModeIcon(root.querySelector('[data-recursion-mode-icon]'), modeKind);
    }
    const powerButton = root.querySelector('[data-recursion-power-toggle]');
    if (powerButton) {
      const powerTip = model.enabled ? 'Turn Recursion off' : 'Turn Recursion on';
      powerButton.setAttribute('aria-pressed', model.enabled ? 'true' : 'false');
      powerButton.setAttribute('aria-label', powerTip);
      setTooltip(powerButton, model.tooltipsEnabled, powerTip);
      powerButton.className = model.enabled ? 'recursion-power-toggle is-on' : 'recursion-power-toggle is-off';
    }
    if (stopGenerationButton) {
      stopGenerationButton.hidden = !model.generationStopVisible;
      stopGenerationButton.disabled = !model.generationStopVisible;
      stopGenerationButton.setAttribute('aria-hidden', model.generationStopVisible ? 'false' : 'true');
      stopGenerationButton.setAttribute('tabindex', model.generationStopVisible ? '0' : '-1');
      setTooltip(stopGenerationButton, model.tooltipsEnabled, 'Stop generation');
    }
    renderPipelineMenuSelection(model.pipelineMode);
    renderModeMenuSelection(model.mode);
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
    if (!cardsPanel.hidden) renderCardsPanelForView(view);
    if (!settingsPanel.hidden && !settingsPanelRendered) {
      renderSettingsPanel(settingsPanel, view, settingsTab, runtime, providerModelFetchState);
      settingsPanelRendered = true;
    }
    renderViewer(viewer, view, model);
    syncStaticTooltips(root, model);
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
      clearTransientCurrentStepText();
      clearStandbyStatusTimer();
      document.removeEventListener?.('click', handleDocumentClick);
      document.removeEventListener?.('keydown', handleDocumentKeydown);
      globalThis.visualViewport?.removeEventListener?.('resize', handleViewportChange);
      globalThis.visualViewport?.removeEventListener?.('scroll', handleViewportChange);
      globalThis.removeEventListener?.('resize', handleViewportChange);
      globalThis.removeEventListener?.('orientationchange', handleViewportChange);
      root.remove();
    }
  };
}
