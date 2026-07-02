import { normalizeCardBudgetSettings, normalizeSettings } from './settings.mjs';

export const FOOTPRINT_SECTION_BUDGETS = Object.freeze({
  compact: Object.freeze({ sceneBrief: 240, turnBrief: 240, guardrails: 520 }),
  normal: Object.freeze({ sceneBrief: 900, turnBrief: 900, guardrails: 900 }),
  rich: Object.freeze({ sceneBrief: 1600, turnBrief: 1600, guardrails: 1200 })
});

export const FOCUS_BOOSTED_FAMILIES = Object.freeze({
  balanced: Object.freeze([]),
  character: Object.freeze(['Active Cast', 'Character Motivation', 'Relationship', 'Social Subtext', 'Knowledge']),
  constraints: Object.freeze(['Scene Constraints', 'Items', 'Consequences', 'Scene Frame', 'Knowledge']),
  scene: Object.freeze(['Scene Frame', 'Environment', 'Items', 'Active Cast']),
  plot: Object.freeze(['Open Threads', 'Consequences', 'Knowledge', 'Scene Frame'])
});

const STRENGTH_POLICIES = Object.freeze({
  light: Object.freeze({
    level: 'light',
    cacheReuse: 'prefer',
    refreshPressure: 'low',
    selectionPressure: 'lean',
    composerAssertiveness: 'soft',
    arbiterLine: 'Strength: Light. Prefer valid cache, avoid churn, and refresh only when relevance or drift risk is clear. Do not drop critical scene constraints.',
    composerLine: 'Strength: Light. Use sparse, gentle current-turn guidance and keep non-critical support brief.'
  }),
  balanced: Object.freeze({
    level: 'balanced',
    cacheReuse: 'normal',
    refreshPressure: 'normal',
    selectionPressure: 'normal',
    composerAssertiveness: 'normal',
    arbiterLine: 'Strength: Balanced. Use normal refresh, lifecycle, and hand pressure for this scene.',
    composerLine: 'Strength: Balanced. Compose a concise normal Recursion brief.'
  }),
  strong: Object.freeze({
    level: 'strong',
    cacheReuse: 'cautious',
    refreshPressure: 'high',
    selectionPressure: 'full',
    composerAssertiveness: 'firm',
    arbiterLine: 'Strength: Strong. Prefer firm current-turn guidance and refresh weak/stale coverage when relevance is plausible. Do not increase footprint size.',
    composerLine: 'Strength: Strong. Phrase selected constraints firmly and preserve evidence-backed guardrails, while staying inside the chosen footprint.'
  })
});

export const FOOTPRINT_POLICIES = Object.freeze({
  compact: Object.freeze({
    level: 'compact',
    allowedProfiles: Object.freeze(['compact']),
    preferredProfile: 'compact',
    detailPressure: 'compact',
    arbiterLine: 'Prompt Footprint: Compact. Keep compact unless a safety or hard scene-constraint reason requires temporary expansion.',
    composerLine: 'Prompt Footprint: Compact. Keep packet sections terse and avoid repetitive detail.'
  }),
  normal: Object.freeze({
    level: 'normal',
    allowedProfiles: Object.freeze(['compact', 'normal']),
    preferredProfile: 'normal',
    detailPressure: 'normal',
    arbiterLine: 'Prompt Footprint: Normal. Compact or Normal are allowed freely; Rich requires a high-risk reason.',
    composerLine: 'Prompt Footprint: Normal. Use balanced packet detail and omit lower-priority repetition.'
  }),
  rich: Object.freeze({
    level: 'rich',
    allowedProfiles: Object.freeze(['compact', 'normal', 'rich']),
    preferredProfile: 'rich',
    detailPressure: 'rich',
    arbiterLine: 'Prompt Footprint: Rich. Use Rich when useful, but still permit Normal or Compact for simple turns.',
    composerLine: 'Prompt Footprint: Rich. Use more scene and turn detail when relevant, without becoming broad lore recap or distant-story planning.'
  })
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function focusPolicyFor(level) {
  const focus = Object.prototype.hasOwnProperty.call(FOCUS_BOOSTED_FAMILIES, level) ? level : 'balanced';
  const boostedFamilies = [...FOCUS_BOOSTED_FAMILIES[focus]];
  return {
    level: focus,
    boostedFamilies,
    arbiterLine: focus === 'balanced'
      ? 'Focus: Balanced. Do not boost a family; prefer the Arbiter-selected current turn relevance.'
      : `Focus: ${focus[0].toUpperCase()}${focus.slice(1)}. Prefer ${boostedFamilies.join(', ')} when relevant; do not ignore critical non-${focus} scene constraints.`,
    composerLine: focus === 'balanced'
      ? 'Focus: Balanced. Compose in Arbiter priority order.'
      : `Focus: ${focus[0].toUpperCase()}${focus.slice(1)}. Keep boosted-family guidance earlier under budget pressure when evidence supports it.`
  };
}

function effectiveFootprintLevel(value, fallback) {
  const level = String(value ?? '').trim();
  return Object.prototype.hasOwnProperty.call(FOOTPRINT_POLICIES, level) ? level : fallback;
}

function footprintOverrideReason(plan) {
  const diagnostics = Array.isArray(plan?.diagnostics) ? plan.diagnostics : [];
  return diagnostics
    .map((entry) => String(entry ?? '').trim())
    .find((entry) => /^footprint-.+-override$/.test(entry)) || '';
}

export function influencePolicyForSettings(settings = {}) {
  const normalized = normalizeSettings(settings);
  const strength = STRENGTH_POLICIES[normalized.strength] || STRENGTH_POLICIES.balanced;
  const footprint = FOOTPRINT_POLICIES[normalized.promptFootprint] || FOOTPRINT_POLICIES.normal;
  const cardBudget = normalizeCardBudgetSettings(normalized);
  return {
    strength: clone(strength),
    focus: focusPolicyFor(normalized.focus),
    footprint: {
      ...clone(footprint),
      sectionBudgets: { ...FOOTPRINT_SECTION_BUDGETS[footprint.level] }
    },
    cardBudget,
    reasoningLevel: normalized.reasoningLevel,
    injection: clone(normalized.injection)
  };
}

export function runPolicyForEffectivePlan(settings = {}, plan = {}) {
  const policy = influencePolicyForSettings(settings);
  const effectiveLevel = effectiveFootprintLevel(plan?.promptFootprint, policy.footprint.level);
  const effectiveFootprint = FOOTPRINT_POLICIES[effectiveLevel] || FOOTPRINT_POLICIES[policy.footprint.level] || FOOTPRINT_POLICIES.normal;
  return {
    ...policy,
    footprint: {
      ...policy.footprint,
      effectiveLevel,
      effectivePolicy: clone(effectiveFootprint),
      detailPressure: effectiveFootprint.detailPressure,
      sectionBudgets: { ...FOOTPRINT_SECTION_BUDGETS[effectiveLevel] },
      maxCardsTarget: effectiveFootprint.maxCardsTarget,
      maxCardsCeiling: effectiveFootprint.maxCardsCeiling,
      composerLine: effectiveFootprint.composerLine,
      footprintOverrideReason: footprintOverrideReason(plan)
    }
  };
}

export function behaviorPolicyPromptLines(policy) {
  const source = policy || influencePolicyForSettings({});
  return [
    'Behavior policy:',
    `- ${source.strength?.arbiterLine || STRENGTH_POLICIES.balanced.arbiterLine}`,
    `- ${source.focus?.arbiterLine || focusPolicyFor('balanced').arbiterLine}`,
    `- ${source.footprint?.arbiterLine || FOOTPRINT_POLICIES.normal.arbiterLine}`
  ].join('\n');
}

export function behaviorComposerLines(policy) {
  const source = policy || influencePolicyForSettings({});
  return [
    source.strength?.composerLine || STRENGTH_POLICIES.balanced.composerLine,
    source.focus?.composerLine || focusPolicyFor('balanced').composerLine,
    source.footprint?.composerLine || FOOTPRINT_POLICIES.normal.composerLine
  ];
}

export function summarizeBehaviorPolicyForDiagnostics(policy, context = {}) {
  const source = policy || influencePolicyForSettings({});
  const boostedFamilies = uniqueStrings(source.focus?.boostedFamilies);
  const selectedFamilies = uniqueStrings(context.selectedFamilies);
  const boosted = new Set(boostedFamilies);
  return {
    strength: source.strength?.level || 'balanced',
    focus: source.focus?.level || 'balanced',
    storedFootprint: source.footprint?.level || 'normal',
    effectiveFootprint: String(context.effectiveFootprint || source.footprint?.effectiveLevel || source.footprint?.level || 'normal'),
    footprintOverrideReason: String(context.footprintOverrideReason || source.footprint?.footprintOverrideReason || ''),
    boostedFamilies,
    selectedBoostedCards: selectedFamilies.filter((family) => boosted.has(family)).length,
    planShaping: uniqueStrings(context.planShaping).slice(0, 12)
  };
}
