export const CARD_SCOPE_VERSION = 2;

export const CARD_SCOPE_CATALOG = Object.freeze([
  Object.freeze({
    family: 'Scene Frame',
    role: 'sceneFrameCard',
    description: 'Current location, situation, immediate direction, and hard beat boundary.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'locationSituation',
        label: 'location/situation',
        description: 'Current place and setup expanded into nearby routes, sightlines, social exposure, local pressure, and what is relevant now.'
      }),
      Object.freeze({
        key: 'immediateDirection',
        label: 'immediate direction',
        description: 'The next-beat vector the scene is pointing toward, without deciding future plot or skipping player agency.'
      }),
      Object.freeze({
        key: 'beatConstraint',
        label: 'beat constraint',
        description: 'Hard response boundary for this beat, such as answer now, hold before a reveal, avoid time skip, or do not skip a pending payoff.'
      })
    ])
  }),
  Object.freeze({
    family: 'Active Cast',
    role: 'activeCastCard',
    description: 'Who is present, visible state, and current conversational or physical role.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'presentCharacters',
        label: 'present characters',
        description: 'Who can act, observe, interrupt, be addressed, or be accidentally dropped from the next response.'
      }),
      Object.freeze({
        key: 'visibleState',
        label: 'visible state',
        description: 'Observable condition, posture, injury, mood, constraint, or capability that affects what a character can do now.'
      }),
      Object.freeze({
        key: 'speakerRoles',
        label: 'speaker roles',
        description: 'Who is speaking, addressed, listening, controlling the exchange, or unable to speak.'
      })
    ])
  }),
  Object.freeze({
    family: 'Character Motivation',
    role: 'characterMotivationCard',
    description: 'Observable or safely inferred motives, pressures, hesitations, and goals.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'visibleGoals',
        label: 'visible goals',
        description: 'Established visible goals phrased as behavior-facing pressure for the next response.'
      }),
      Object.freeze({
        key: 'pressures',
        label: 'pressures',
        description: 'External, social, tactical, or emotional pressures that plausibly shape behavior in this beat.'
      }),
      Object.freeze({
        key: 'hesitationPosture',
        label: 'hesitation/posture',
        description: 'Visible reluctance, guardedness, confidence, uncertainty, or restraint without private mind-reading.'
      })
    ])
  }),
  Object.freeze({
    family: 'Relationship',
    role: 'dialogueRelationshipCard',
    description: 'Current social tension, leverage, promises, conflicts, and speech constraints.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'tension',
        label: 'tension',
        description: 'Current friction, trust, leverage, intimacy, threat, or subtext that creates usable social affordances.'
      }),
      Object.freeze({
        key: 'promisesConflicts',
        label: 'promises/conflicts',
        description: 'Active promises, refusals, debts, threats, disagreements, or obligations that shape what can be said or done next.'
      }),
      Object.freeze({
        key: 'voiceConstraints',
        label: 'speech constraints',
        description: 'Scene-local address, formality, taboo wording, secrecy, or who can safely say what without replacing the preset.'
      })
    ])
  }),
  Object.freeze({
    family: 'Scene Constraints',
    role: 'sceneConstraintsCard',
    description: 'Hard limits, contradiction traps, timing, access, visibility, and plausibility constraints.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'hardLimits',
        label: 'hard limits',
        description: 'Injuries, locked routes, missing objects, stated choices, visible limits, or other constraints that would make the next response implausible if missed.'
      }),
      Object.freeze({
        key: 'spatialConstraints',
        label: 'spatial constraints',
        description: 'Movement, reach, visibility, blocked route, distance, and access limits that affect the next beat.'
      }),
      Object.freeze({
        key: 'timelineOrder',
        label: 'timeline/order',
        description: 'Immediate cause and effect, sequence, reveal order, and what has or has not happened yet.'
      })
    ])
  }),
  Object.freeze({
    family: 'Knowledge',
    role: 'knowledgeSecretsCard',
    description: 'Concealed facts, who knows or suspects them, mistaken beliefs, and reveal boundaries.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'concealedFacts',
        label: 'concealed facts',
        description: 'Hidden truths that may guide guardrails but should not be revealed as dialogue or narration unless earned.'
      }),
      Object.freeze({
        key: 'knowsSuspects',
        label: 'knows/suspects',
        description: 'Who knows, suspects, misunderstands, or should not know a fact.'
      }),
      Object.freeze({
        key: 'revealBoundaries',
        label: 'reveal boundaries',
        description: 'What the next response must not reveal, confirm, or imply too early.'
      })
    ])
  }),
  Object.freeze({
    family: 'Consequences',
    role: 'clocksConsequencesCard',
    description: 'Deadlines, countdowns, delayed consequences, and escalation triggers.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'deadlinesCountdowns',
        label: 'deadlines/countdowns',
        description: 'Time pressure, countdowns, scheduled events, or windows of opportunity still active.'
      }),
      Object.freeze({
        key: 'delayedConsequences',
        label: 'delayed consequences',
        description: 'Effects from earlier choices that should arrive later or remain pending.'
      }),
      Object.freeze({
        key: 'escalationTriggers',
        label: 'escalation triggers',
        description: 'Conditions that would make the scene worsen, shift phase, or demand action.'
      })
    ])
  }),
  Object.freeze({
    family: 'Environment',
    role: 'environmentAffordancesCard',
    description: 'Spatial layout, sensory texture, hazards, obstacles, exits, and usable environmental affordances.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'spatialLayout',
        label: 'spatial layout',
        description: 'Where important places, barriers, exits, cover, and actors are in relation to each other.'
      }),
      Object.freeze({
        key: 'sensoryTexture',
        label: 'sensory texture',
        description: 'Sensory signals that affect grounding, attention, danger, social context, or available action.'
      }),
      Object.freeze({
        key: 'hazardsAffordances',
        label: 'hazards/affordances',
        description: 'Usable objects, obstacles, threats, exits, cover, tools, and environmental opportunities.'
      })
    ])
  }),
  Object.freeze({
    family: 'Items',
    role: 'possessionsItemsCard',
    description: 'Important held, carried, worn, hidden, lost, stolen, or controlled objects and who has them.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'heldCarriedItems',
        label: 'held/carried items',
        description: 'Important objects currently held, worn, carried, hidden, missing, stolen, or controlled.'
      }),
      Object.freeze({
        key: 'itemLocationControl',
        label: 'location/control',
        description: 'Where an item is and who can realistically access, use, move, or withhold it.'
      }),
      Object.freeze({
        key: 'itemAffordancesRisks',
        label: 'affordances/risks',
        description: 'What an item can do now, what it enables, and what risk or limit it carries.'
      })
    ])
  }),
  Object.freeze({
    family: 'Open Threads',
    role: 'openThreadsCard',
    description: 'Unresolved questions, immediate promises, pending actions, and near-term pressures.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'unresolvedQuestions',
        label: 'unresolved questions',
        description: 'Questions raised by the scene that remain visible and may affect the next response.'
      }),
      Object.freeze({
        key: 'pendingActions',
        label: 'pending actions',
        description: 'Promised, attempted, interrupted, or requested actions that should not be forgotten.'
      }),
      Object.freeze({
        key: 'nearTermPressures',
        label: 'near-term pressures',
        description: 'Immediate obligations, looming problems, or choices that should shape the next beat.'
      })
    ])
  })
]);

export const CARD_SCOPE_TOTAL_SUB_ITEMS = CARD_SCOPE_CATALOG.reduce((sum, family) => sum + family.subItems.length, 0);

const CATALOG_BY_FAMILY = new Map(CARD_SCOPE_CATALOG.map((entry) => [entry.family, entry]));
const FAMILY_BY_ROLE = new Map(CARD_SCOPE_CATALOG.map((entry) => [entry.role, entry.family]));
const ZERO_SELECTION_RESULT = Object.freeze({ blocked: true, reason: 'zero-selection' });

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneScope(scope) {
  return {
    version: CARD_SCOPE_VERSION,
    families: Object.fromEntries(Object.entries(scope.families).map(([family, value]) => [
      family,
      {
        enabled: value.enabled === true,
        subItems: { ...value.subItems }
      }
    ]))
  };
}

function familyCatalog(family) {
  return CATALOG_BY_FAMILY.get(String(family || '')) || null;
}

function resolveFamily(input = {}) {
  if (CATALOG_BY_FAMILY.has(input.family)) return input.family;
  if (FAMILY_BY_ROLE.has(input.role)) return FAMILY_BY_ROLE.get(input.role);
  return String(input.family || '');
}

function selectedForFamily(scope, family) {
  const state = scope.families[family];
  if (!state) return [];
  const catalog = familyCatalog(family);
  if (!catalog) return [];
  return catalog.subItems
    .filter((item) => state.subItems[item.key] === true)
    .map((item) => item.key);
}

function catalogPayload(entry, selected = null) {
  const base = {
    family: entry.family,
    role: entry.role,
    description: entry.description,
    subItems: entry.subItems.map((item) => ({
      key: item.key,
      label: item.label,
      description: item.description
    }))
  };
  return Array.isArray(selected) ? { ...base, selectedSubItems: selected.slice() } : base;
}

function omissionFor(entry) {
  const family = resolveFamily(entry);
  return {
    family,
    role: String(entry?.role || CATALOG_BY_FAMILY.get(family)?.role || ''),
    reason: `manual-scope-omitted:${family}`
  };
}

export function defaultCardScope() {
  return {
    version: CARD_SCOPE_VERSION,
    families: Object.fromEntries(CARD_SCOPE_CATALOG.map((family) => [
      family.family,
      {
        enabled: true,
        subItems: Object.fromEntries(family.subItems.map((item) => [item.key, true]))
      }
    ]))
  };
}

export function normalizeCardScope(value = {}) {
  const source = isObject(value) ? value : {};
  const sourceFamilies = isObject(source.families) ? source.families : {};
  const families = {};
  let selectedTotal = 0;

  for (const catalog of CARD_SCOPE_CATALOG) {
    const sourceFamily = isObject(sourceFamilies[catalog.family]) ? sourceFamilies[catalog.family] : null;
    const sourceSubItems = isObject(sourceFamily?.subItems) ? sourceFamily.subItems : {};
    const disabledFamily = sourceFamily?.enabled === false;
    const subItems = {};
    let selectedFamily = 0;

    for (const item of catalog.subItems) {
      const selected = disabledFamily ? false : sourceSubItems[item.key] !== false;
      subItems[item.key] = selected;
      if (selected) selectedFamily += 1;
    }

    families[catalog.family] = {
      enabled: selectedFamily > 0,
      subItems
    };
    selectedTotal += selectedFamily;
  }

  if (selectedTotal === 0) return defaultCardScope();
  return { version: CARD_SCOPE_VERSION, families };
}

export function cardScopeCounts(scope) {
  const normalized = normalizeCardScope(scope);
  let selectedFamilies = 0;
  let selectedSubItems = 0;
  for (const family of CARD_SCOPE_CATALOG) {
    const selected = selectedForFamily(normalized, family.family);
    if (selected.length > 0) selectedFamilies += 1;
    selectedSubItems += selected.length;
  }
  return {
    selectedFamilies,
    totalFamilies: CARD_SCOPE_CATALOG.length,
    selectedSubItems,
    totalSubItems: CARD_SCOPE_TOTAL_SUB_ITEMS
  };
}

export function cardScopeLabel(scope) {
  const counts = cardScopeCounts(scope);
  return counts.selectedSubItems === counts.totalSubItems
    ? 'Cards'
    : `${counts.selectedSubItems}/${counts.totalSubItems}`;
}

export function setFamilyEnabled(scope, family, enabled) {
  const normalized = normalizeCardScope(scope);
  const catalog = familyCatalog(family);
  if (!catalog) return { scope: normalized, blocked: false };
  const next = cloneScope(normalized);
  const selected = selectedForFamily(next, catalog.family);
  const counts = cardScopeCounts(next);
  if (enabled !== true && selected.length === counts.selectedSubItems) {
    return { scope: normalized, ...ZERO_SELECTION_RESULT };
  }
  next.families[catalog.family] = {
    enabled: enabled === true,
    subItems: Object.fromEntries(catalog.subItems.map((item) => [item.key, enabled === true]))
  };
  return { scope: normalizeCardScope(next), blocked: false };
}

export function setSubItemEnabled(scope, family, subItem, enabled) {
  const normalized = normalizeCardScope(scope);
  const catalog = familyCatalog(family);
  if (!catalog || !catalog.subItems.some((item) => item.key === subItem)) return { scope: normalized, blocked: false };
  const next = cloneScope(normalized);
  const currentlySelected = next.families[catalog.family].subItems[subItem] === true;
  const counts = cardScopeCounts(next);
  if (enabled !== true && currentlySelected && counts.selectedSubItems === 1) {
    return { scope: normalized, ...ZERO_SELECTION_RESULT };
  }
  next.families[catalog.family].subItems[subItem] = enabled === true;
  next.families[catalog.family].enabled = selectedForFamily(next, catalog.family).length > 0;
  return { scope: normalizeCardScope(next), blocked: false };
}

export function familyState(scope, family) {
  const normalized = normalizeCardScope(scope);
  const catalog = familyCatalog(family);
  if (!catalog) return 'off';
  const selected = selectedForFamily(normalized, catalog.family).length;
  if (selected === 0) return 'off';
  if (selected === catalog.subItems.length) return 'on';
  return 'mixed';
}

export function enabledSubItemsForFamily(scope, family) {
  return selectedForFamily(normalizeCardScope(scope), String(family || ''));
}

export function scopePayloadForArbiter(settings = {}) {
  const mode = settings?.mode === 'manual' ? 'manual' : 'auto';
  const strictWhitelist = mode === 'manual';
  const scope = normalizeCardScope(settings?.cardScope);
  const selectedSubItemsByFamily = Object.fromEntries(CARD_SCOPE_CATALOG.map((entry) => [
    entry.family,
    selectedForFamily(scope, entry.family)
  ]).filter(([, selected]) => selected.length > 0));
  const selectedFamilies = Object.keys(selectedSubItemsByFamily);
  const availableCatalog = CARD_SCOPE_CATALOG.map((entry) => catalogPayload(entry, selectedSubItemsByFamily[entry.family] || []));
  const allowedCatalog = CARD_SCOPE_CATALOG
    .filter((entry) => selectedSubItemsByFamily[entry.family]?.length > 0)
    .map((entry) => catalogPayload(entry, selectedSubItemsByFamily[entry.family]));
  return {
    mode,
    strictWhitelist,
    selectedCounts: cardScopeCounts(scope),
    selectedFamilies,
    selectedSubItemsByFamily,
    availableCatalog,
    allowedCatalog,
    autoExceptionFamilies: strictWhitelist ? [] : CARD_SCOPE_CATALOG.map((entry) => entry.family)
  };
}

export function filterCardJobsForScope(cardJobs, settings = {}) {
  const entries = Array.isArray(cardJobs) ? cardJobs : [];
  const scope = scopePayloadForArbiter(settings);
  if (!scope.strictWhitelist) return { cardJobs: entries.slice(), omitted: [], scope };
  const allowed = new Set(scope.selectedFamilies);
  const cardJobsResult = [];
  const omitted = [];
  for (const entry of entries) {
    const family = resolveFamily(entry);
    if (allowed.has(family)) cardJobsResult.push(entry);
    else omitted.push(omissionFor(entry));
  }
  return { cardJobs: cardJobsResult, omitted, scope };
}

export function filterCardsForScope(cards, settings = {}) {
  const entries = Array.isArray(cards) ? cards : [];
  const scope = scopePayloadForArbiter(settings);
  if (!scope.strictWhitelist) return { cards: entries.slice(), omitted: [], scope };
  const allowed = new Set(scope.selectedFamilies);
  const cardsResult = [];
  const omitted = [];
  for (const entry of entries) {
    const family = resolveFamily(entry);
    if (allowed.has(family)) cardsResult.push(entry);
    else omitted.push({ ...omissionFor(entry), id: String(entry?.id || '') });
  }
  return { cards: cardsResult, omitted, scope };
}

export function cardScopeSummary(scope) {
  const normalized = normalizeCardScope(scope);
  const counts = cardScopeCounts(normalized);
  return {
    version: CARD_SCOPE_VERSION,
    label: cardScopeLabel(normalized),
    counts,
    selectedFamilies: CARD_SCOPE_CATALOG
      .filter((entry) => selectedForFamily(normalized, entry.family).length > 0)
      .map((entry) => entry.family)
  };
}
