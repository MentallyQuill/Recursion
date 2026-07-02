# Recursion Card Facet Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Card System Spec facet audit by changing Recursion from a continuity/prose-flavored catalog to a scene-reasoning catalog.

**Architecture:** Replace the current 11-family, 33-facet catalog with a 10-family, 30-facet catalog. Remove `Prose`, rename `Continuity Risk` to `Scene Constraints`, merge `Scene Frame.presentParticipants` into `Active Cast`, and rehome the only useful Prose behavior into `Scene Frame.beatConstraint`. Update catalog code, provider roles, prompt composition, runtime fallback, settings focus policy, UI, tests, and docs in one coherent pre-alpha contract change.

**Tech Stack:** JavaScript ES modules, Node script tests, SillyTavern extension DOM UI, markdown docs, existing Recursion runtime/provider/prompt modules.

---

## Scope Check

This is one subsystem-level contract change: card catalog semantics. It touches many files because family names, role IDs, focus settings, prompt sections, progress labels, and tests all consume the same fixed catalog.

Pre-alpha rule applies: do not preserve old `Continuity Risk`, `Prose`, `continuityRiskCard`, or `prosePacingCard` compatibility aliases. Old settings/cache records should normalize into the new catalog through existing defaulting and catalog hash invalidation.

Before execution, run `git status --short`. Shared worktree may contain unrelated code/doc changes. Do not revert unrelated changes.

---

## Target Catalog

Final family order:

```js
[
  'Scene Frame',
  'Active Cast',
  'Character Motivation',
  'Relationship',
  'Scene Constraints',
  'Knowledge',
  'Consequences',
  'Environment',
  'Items',
  'Open Threads'
]
```

Final provider card roles:

```js
[
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'sceneConstraintsCard',
  'knowledgeSecretsCard',
  'clocksConsequencesCard',
  'environmentAffordancesCard',
  'possessionsItemsCard',
  'openThreadsCard'
]
```

Final facets:

```js
const TARGET_CARD_SCOPE_CATALOG = [
  {
    family: 'Scene Frame',
    role: 'sceneFrameCard',
    subItems: ['locationSituation', 'immediateDirection', 'beatConstraint']
  },
  {
    family: 'Active Cast',
    role: 'activeCastCard',
    subItems: ['presentCharacters', 'visibleState', 'speakerRoles']
  },
  {
    family: 'Character Motivation',
    role: 'characterMotivationCard',
    subItems: ['visibleGoals', 'pressures', 'hesitationPosture']
  },
  {
    family: 'Relationship',
    role: 'dialogueRelationshipCard',
    subItems: ['tension', 'promisesConflicts', 'voiceConstraints']
  },
  {
    family: 'Scene Constraints',
    role: 'sceneConstraintsCard',
    subItems: ['hardLimits', 'spatialConstraints', 'timelineOrder']
  },
  {
    family: 'Knowledge',
    role: 'knowledgeSecretsCard',
    subItems: ['concealedFacts', 'knowsSuspects', 'revealBoundaries']
  },
  {
    family: 'Consequences',
    role: 'clocksConsequencesCard',
    subItems: ['deadlinesCountdowns', 'delayedConsequences', 'escalationTriggers']
  },
  {
    family: 'Environment',
    role: 'environmentAffordancesCard',
    subItems: ['spatialLayout', 'sensoryTexture', 'hazardsAffordances']
  },
  {
    family: 'Items',
    role: 'possessionsItemsCard',
    subItems: ['heldCarriedItems', 'itemLocationControl', 'itemAffordancesRisks']
  },
  {
    family: 'Open Threads',
    role: 'openThreadsCard',
    subItems: ['unresolvedQuestions', 'pendingActions', 'nearTermPressures']
  }
];
```

Removed:

```js
[
  'Prose',
  'prosePacingCard',
  'density',
  'momentum',
  'specificityShape',
  'Continuity Risk',
  'continuityRiskCard',
  'fragileFacts',
  'presentParticipants'
]
```

Renamed/replaced:

```js
{
  'Continuity Risk': 'Scene Constraints',
  continuityRiskCard: 'sceneConstraintsCard',
  fragileFacts: 'hardLimits',
  'Prose/momentum': 'Scene Frame/beatConstraint'
}
```

---

## File Structure

- `src/card-scope.mjs` - canonical fixed scope catalog, version, labels, descriptions, default scope, normalization, toggle helpers, Arbiter payloads, filters, summaries.
- `src/cards.mjs` - provider-facing card catalog, family/role resolution, request prompt text, card prompt safety, hand sorting.
- `src/providers.mjs` - utility role IDs, provider response schemas, provider contract hash/version.
- `src/progress.mjs` - model-call role labels and progress child rows.
- `src/prompt.mjs` - valid prompt families, section routing, guardrail families, safe-family fallback, static guardrails.
- `src/settings.mjs` - Focus enum defaults and invalid-value normalization.
- `src/settings-policy.mjs` - Focus boosted-family profiles and policy copy.
- `src/runtime.mjs` - local fallback Scene Frame/Scene Constraints cards, Auto exceptions, card-scope prompt copy, reason strings.
- `src/ui.mjs` - Cards dropdown, tooltips, settings Focus options, Last Brief labels.
- `styles/recursion.css` - only if removed/renamed labels expose spacing regressions.
- `tools/scripts/test-card-scope.mjs` - target catalog, scope counts, toggles, descriptions, Arbiter payload, filters.
- `tools/scripts/test-cards.mjs` - card catalog, role resolution, removed role rejection, request prompts.
- `tools/scripts/test-providers.mjs` - role allow-list/schema coverage.
- `tools/scripts/test-progress.mjs` - progress child role labels.
- `tools/scripts/test-prompt.mjs` - Scene Constraints guardrail routing and Prose removal.
- `tools/scripts/test-settings.mjs` - removed focus values normalize away.
- `tools/scripts/test-settings-policy.mjs` - new Focus profiles.
- `tools/scripts/test-runtime.mjs` - local fallback, Manual filtering, Auto exceptions, cache hash drift, Arbiter prompt copy.
- `tools/scripts/test-ui.mjs` - Cards dropdown family/facet render, removed Prose/facets absent, new settings Focus options.
- Docs: `README.md`, `docs/RECURSION_EXTENSION_SPEC.md`, `docs/design/CARD_SYSTEM_SPEC.md`, `docs/design/UI_SPEC.md`, `docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md`, `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md`, `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, `docs/architecture/PROMPT_COMPOSITION_SPEC.md`, `docs/architecture/RUNTIME_ARCHITECTURE.md`, `docs/technical/CARD_DECK_AND_HAND.md`, `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`, `docs/technical/PROMPT_PACKET_AND_INJECTION.md`, `docs/technical/RECURSION_TECHNICAL_MANUAL.md`, `docs/technical/RUNTIME_TURN_SEQUENCE.md`, `docs/user/RECURSION_OPERATOR_MANUAL.md`, `docs/testing/IMPLEMENTATION_PLAN.md`, `docs/planning/DOCUMENTATION_EXPANSION_PLAN.md`.

---

### Task 1: Lock Target Catalog In Failing Tests

**Files:**
- Modify: `tools/scripts/test-card-scope.mjs`
- Modify: `tools/scripts/test-cards.mjs`
- Modify: `tools/scripts/test-providers.mjs`
- Modify: `tools/scripts/test-progress.mjs`

- [ ] **Step 1: Update card-scope catalog expectation**

Replace `EXPECTED_SCOPE_CATALOG` in `tools/scripts/test-card-scope.mjs` with:

```js
const EXPECTED_SCOPE_CATALOG = Object.freeze([
  {
    family: 'Scene Frame',
    role: 'sceneFrameCard',
    subItems: ['locationSituation', 'immediateDirection', 'beatConstraint']
  },
  {
    family: 'Active Cast',
    role: 'activeCastCard',
    subItems: ['presentCharacters', 'visibleState', 'speakerRoles']
  },
  {
    family: 'Character Motivation',
    role: 'characterMotivationCard',
    subItems: ['visibleGoals', 'pressures', 'hesitationPosture']
  },
  {
    family: 'Relationship',
    role: 'dialogueRelationshipCard',
    subItems: ['tension', 'promisesConflicts', 'voiceConstraints']
  },
  {
    family: 'Scene Constraints',
    role: 'sceneConstraintsCard',
    subItems: ['hardLimits', 'spatialConstraints', 'timelineOrder']
  },
  {
    family: 'Knowledge',
    role: 'knowledgeSecretsCard',
    subItems: ['concealedFacts', 'knowsSuspects', 'revealBoundaries']
  },
  {
    family: 'Consequences',
    role: 'clocksConsequencesCard',
    subItems: ['deadlinesCountdowns', 'delayedConsequences', 'escalationTriggers']
  },
  {
    family: 'Environment',
    role: 'environmentAffordancesCard',
    subItems: ['spatialLayout', 'sensoryTexture', 'hazardsAffordances']
  },
  {
    family: 'Items',
    role: 'possessionsItemsCard',
    subItems: ['heldCarriedItems', 'itemLocationControl', 'itemAffordancesRisks']
  },
  {
    family: 'Open Threads',
    role: 'openThreadsCard',
    subItems: ['unresolvedQuestions', 'pendingActions', 'nearTermPressures']
  }
]);
```

Update count assertions:

```js
assertEqual(CARD_SCOPE_CATALOG.length, 10, 'scope catalog mirrors audited V1 scene-reasoning families');
assertEqual(CARD_SCOPE_TOTAL_SUB_ITEMS, 30, 'scope catalog exposes audited V1 focus count');
```

Add removed-item assertions after description checks:

```js
const serializedScopeCatalog = JSON.stringify(CARD_SCOPE_CATALOG);
for (const removed of ['Prose', 'prosePacingCard', 'density', 'momentum', 'specificityShape', 'Continuity Risk', 'continuityRiskCard', 'fragileFacts', 'presentParticipants']) {
  assert(!serializedScopeCatalog.includes(removed), `removed catalog item is absent: ${removed}`);
}
```

- [ ] **Step 2: Update scope behavior assertions**

Replace references to `Continuity Risk` and `timelineOrder` partial tests with:

```js
const mixed = setSubItemEnabled(all, 'Scene Constraints', 'timelineOrder', false).scope;
assertEqual(mixed.families['Scene Constraints'].enabled, true, 'partial sub-item keeps family enabled');
assertEqual(familyState(mixed, 'Scene Constraints'), 'mixed', 'partial family state is mixed');
assertEqual(cardScopeCounts(mixed).selectedSubItems, allCounts.totalSubItems - 1, 'sub-item toggle changes count');
assertEqual(cardScopeLabel(mixed), `${allCounts.totalSubItems - 1}/${allCounts.totalSubItems}`, 'partial label is selected/total');
```

Replace the one-left guard setup with:

```js
let oneLeft = all;
for (const family of CARD_SCOPE_CATALOG) {
  for (const item of family.subItems) {
    if (family.family === 'Open Threads' && item.key === 'pendingActions') continue;
    oneLeft = setSubItemEnabled(oneLeft, family.family, item.key, false).scope;
  }
}
const blocked = setSubItemEnabled(oneLeft, 'Open Threads', 'pendingActions', false);
assertEqual(blocked.blocked, true, 'final sub-item disable is blocked');
assertEqual(blocked.reason, 'zero-selection', 'zero-selection block reason is stable');
assertEqual(cardScopeCounts(blocked.scope).selectedSubItems, 1, 'zero-selection guard preserves last sub-item');
```

Add explicit removed-family normalization checks:

```js
const removedNormalized = normalizeCardScope({
  families: {
    Prose: { enabled: true, subItems: { density: true } },
    'Continuity Risk': { enabled: true, subItems: { fragileFacts: true } }
  }
});
assert(!removedNormalized.families.Prose, 'removed Prose family is dropped');
assert(!removedNormalized.families['Continuity Risk'], 'removed Continuity Risk family is dropped');
assertEqual(removedNormalized.families['Scene Constraints'].enabled, true, 'new Scene Constraints defaults on after old scope is dropped');
```

- [ ] **Step 3: Update card catalog expectation**

In `tools/scripts/test-cards.mjs`, replace `EXPECTED_CATALOG` with:

```js
const EXPECTED_CATALOG = Object.freeze([
  { family: 'Scene Frame', role: 'sceneFrameCard', priority: 100 },
  { family: 'Active Cast', role: 'activeCastCard', priority: 95 },
  { family: 'Scene Constraints', role: 'sceneConstraintsCard', priority: 98 },
  { family: 'Knowledge', role: 'knowledgeSecretsCard', priority: 92 },
  { family: 'Consequences', role: 'clocksConsequencesCard', priority: 90 },
  { family: 'Character Motivation', role: 'characterMotivationCard', priority: 88 },
  { family: 'Relationship', role: 'dialogueRelationshipCard', priority: 84 },
  { family: 'Items', role: 'possessionsItemsCard', priority: 78 },
  { family: 'Environment', role: 'environmentAffordancesCard', priority: 76 },
  { family: 'Open Threads', role: 'openThreadsCard', priority: 72 }
]);
```

Add removed-role rejections near existing identity tests:

```js
await assertRejects(
  async () => normalizeCard({ role: 'continuityRiskCard', promptText: 'Old risk role.' }, { sceneId: 'scene-removed' }),
  /Unknown card catalog/,
  'removed continuityRiskCard role is rejected'
);
await assertRejects(
  async () => normalizeCard({ family: 'Prose', promptText: 'Old prose card.' }, { sceneId: 'scene-removed' }),
  /Unknown card catalog/,
  'removed Prose family is rejected'
);
```

- [ ] **Step 4: Update provider/progress expectations**

In `tools/scripts/test-providers.mjs`, replace role-list expectations so utility roles include `sceneConstraintsCard` and omit `continuityRiskCard` and `prosePacingCard`.

Use exact expected list:

```js
const EXPECTED_UTILITY_ROLE_IDS = [
  'utilityArbiter',
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'sceneConstraintsCard',
  'knowledgeSecretsCard',
  'clocksConsequencesCard',
  'environmentAffordancesCard',
  'possessionsItemsCard',
  'openThreadsCard',
  'briefUtilityComposer',
  'providerTest'
];
```

In `tools/scripts/test-progress.mjs`, add or update assertions:

```js
assert(progressText.includes('Scene Constraints'), 'progress labels Scene Constraints card rows');
assert(!progressText.includes('Continuity Risk'), 'progress no longer labels Continuity Risk');
assert(!progressText.includes('Prose'), 'progress no longer labels Prose cards');
```

- [ ] **Step 5: Run focused tests and verify red**

Run:

```powershell
node tools\scripts\test-card-scope.mjs
node tools\scripts\test-cards.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-progress.mjs
```

Expected: FAIL. Failures should name missing `Scene Constraints`, old counts `11`/`33`, removed Prose still present, or missing `sceneConstraintsCard`.

- [ ] **Step 6: Commit failing tests**

```powershell
git add tools\scripts\test-card-scope.mjs tools\scripts\test-cards.mjs tools\scripts\test-providers.mjs tools\scripts\test-progress.mjs
git commit -m "test: lock audited card catalog"
```

---

### Task 2: Implement Catalog And Provider Role Contract

**Files:**
- Modify: `src/card-scope.mjs`
- Modify: `src/cards.mjs`
- Modify: `src/providers.mjs`
- Modify: `src/progress.mjs`

- [ ] **Step 1: Update `src/card-scope.mjs` version and catalog**

Set:

```js
export const CARD_SCOPE_VERSION = 2;
```

Replace `CARD_SCOPE_CATALOG` with the target 10-family catalog. Use this exact object content:

```js
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
        description: 'Observable reluctance, guardedness, confidence, uncertainty, or restraint without private mind-reading.'
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
        description: 'Scene-active hidden facts that shape behavior or guardrails without becoming spoiler storage.'
      }),
      Object.freeze({
        key: 'knowsSuspects',
        label: 'knows/suspects',
        description: 'Who knows, suspects, misunderstands, can infer, or should not know a relevant fact.'
      }),
      Object.freeze({
        key: 'revealBoundaries',
        label: 'reveal boundaries',
        description: 'What the next response must not reveal, confirm, imply, or over-explain too early.'
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
        description: 'Active time pressure, countdowns, scheduled interruptions, or windows of opportunity.'
      }),
      Object.freeze({
        key: 'delayedConsequences',
        label: 'delayed consequences',
        description: 'Near-term fallout from earlier choices that could reasonably arrive or remain pending in this scene.'
      }),
      Object.freeze({
        key: 'escalationTriggers',
        label: 'escalation triggers',
        description: 'Conditions that would worsen, shift, interrupt, or force action in the current scene.'
      })
    ])
  }),
  Object.freeze({
    family: 'Environment',
    role: 'environmentAffordancesCard',
    description: 'Spatial layout, sensory signals, hazards, obstacles, exits, and usable environmental affordances.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'spatialLayout',
        label: 'spatial layout',
        description: 'Local geometry, entrances, barriers, cover, distance, actor positions, and usable paths.'
      }),
      Object.freeze({
        key: 'sensoryTexture',
        label: 'sensory signals',
        description: 'Sensory signals that affect grounding, attention, danger, social context, or available action.'
      }),
      Object.freeze({
        key: 'hazardsAffordances',
        label: 'hazards/affordances',
        description: 'Obstacles, threats, exits, cover, tools, opportunities, and things the model might fail to use.'
      })
    ])
  }),
  Object.freeze({
    family: 'Items',
    role: 'possessionsItemsCard',
    description: 'Important objects, who controls them, where they are, and what they enable now.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'heldCarriedItems',
        label: 'held/carried items',
        description: 'Active objects where possession, absence, concealment, or readiness matters now.'
      }),
      Object.freeze({
        key: 'itemLocationControl',
        label: 'location/control',
        description: 'Where an object is, who controls it, who can reach it, and who can withhold or use it.'
      }),
      Object.freeze({
        key: 'itemAffordancesRisks',
        label: 'affordances/risks',
        description: 'What an item enables, blocks, threatens, exposes, or risks in the current beat.'
      })
    ])
  }),
  Object.freeze({
    family: 'Open Threads',
    role: 'openThreadsCard',
    description: 'Visible unresolved obligations, hooks, requested actions, and near-term choices.',
    subItems: Object.freeze([
      Object.freeze({
        key: 'unresolvedQuestions',
        label: 'unresolved questions',
        description: 'Questions that create visible next-turn pressure, uncertainty, or a decision point.'
      }),
      Object.freeze({
        key: 'pendingActions',
        label: 'pending actions',
        description: 'Attempted, requested, promised, interrupted, or awaited actions that should influence the next response.'
      }),
      Object.freeze({
        key: 'nearTermPressures',
        label: 'near-term pressures',
        description: 'Immediate obligations, looming problems, choices, or hooks that shape the next beat.'
      })
    ])
  })
]);
```

- [ ] **Step 2: Update `src/cards.mjs` catalog**

Replace `CARD_CATALOG` entries with:

```js
export const CARD_CATALOG = Object.freeze([
  catalogEntry({
    family: 'Scene Frame',
    role: 'sceneFrameCard',
    priority: 100,
    description: 'Current location, situation, immediate direction, and hard beat boundary.'
  }),
  catalogEntry({
    family: 'Active Cast',
    role: 'activeCastCard',
    priority: 95,
    description: 'Who is present, visible state, and current conversational or physical role.'
  }),
  catalogEntry({
    family: 'Scene Constraints',
    role: 'sceneConstraintsCard',
    priority: 98,
    description: 'Hard limits, contradiction traps, timing, access, visibility, and plausibility constraints.'
  }),
  catalogEntry({
    family: 'Knowledge',
    role: 'knowledgeSecretsCard',
    priority: 92,
    description: 'Concealed facts, who knows or suspects them, mistaken beliefs, and reveal boundaries.'
  }),
  catalogEntry({
    family: 'Consequences',
    role: 'clocksConsequencesCard',
    priority: 90,
    description: 'Deadlines, countdowns, delayed consequences, and escalation triggers.'
  }),
  catalogEntry({
    family: 'Character Motivation',
    role: 'characterMotivationCard',
    priority: 88,
    description: 'Observable or safely inferred motives, pressures, hesitations, and goals.'
  }),
  catalogEntry({
    family: 'Relationship',
    role: 'dialogueRelationshipCard',
    priority: 84,
    description: 'Current social tension, leverage, promises, conflicts, and speech constraints.'
  }),
  catalogEntry({
    family: 'Items',
    role: 'possessionsItemsCard',
    priority: 78,
    description: 'Important objects, who controls them, where they are, and what they enable now.'
  }),
  catalogEntry({
    family: 'Environment',
    role: 'environmentAffordancesCard',
    priority: 76,
    description: 'Spatial layout, sensory signals, hazards, obstacles, exits, and usable environmental affordances.'
  }),
  catalogEntry({
    family: 'Open Threads',
    role: 'openThreadsCard',
    priority: 72,
    description: 'Visible unresolved obligations, hooks, requested actions, and near-term choices.'
  })
]);
```

- [ ] **Step 3: Update provider role IDs and schemas**

In `src/providers.mjs`, set:

```js
export const PROVIDER_CONTRACT_VERSION = 2;
```

Replace utility role IDs with:

```js
export const UTILITY_ROLE_IDS = Object.freeze([
  'utilityArbiter',
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'sceneConstraintsCard',
  'knowledgeSecretsCard',
  'clocksConsequencesCard',
  'environmentAffordancesCard',
  'possessionsItemsCard',
  'openThreadsCard',
  'briefUtilityComposer',
  'providerTest'
]);
```

Replace role schema keys:

```js
const ROLE_RESPONSE_SCHEMAS = Object.freeze({
  utilityArbiter: 'recursion.utilityArbiter.v1',
  sceneFrameCard: 'recursion.card.v1',
  activeCastCard: 'recursion.card.v1',
  characterMotivationCard: 'recursion.card.v1',
  dialogueRelationshipCard: 'recursion.card.v1',
  sceneConstraintsCard: 'recursion.card.v1',
  knowledgeSecretsCard: 'recursion.card.v1',
  clocksConsequencesCard: 'recursion.card.v1',
  environmentAffordancesCard: 'recursion.card.v1',
  possessionsItemsCard: 'recursion.card.v1',
  openThreadsCard: 'recursion.card.v1',
  briefUtilityComposer: 'recursion.briefUtilityComposer.v1',
  reasonerComposer: 'recursion.reasonerComposer.v1',
  providerTest: 'recursion.providerTest.v1'
});
```

- [ ] **Step 4: Update progress role labels**

In `src/progress.mjs`, replace model-call roles:

```js
const MODEL_CALL_ROLE_IDS = new Set([
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'sceneConstraintsCard',
  'knowledgeSecretsCard',
  'clocksConsequencesCard',
  'environmentAffordancesCard',
  'possessionsItemsCard',
  'openThreadsCard'
]);
```

Replace labels:

```js
const CARD_ROLE_LABELS = Object.freeze({
  sceneFrameCard: 'Scene Frame',
  activeCastCard: 'Active Cast',
  characterMotivationCard: 'Character Motivation',
  dialogueRelationshipCard: 'Relationship',
  sceneConstraintsCard: 'Scene Constraints',
  knowledgeSecretsCard: 'Knowledge',
  clocksConsequencesCard: 'Consequences',
  environmentAffordancesCard: 'Environment',
  possessionsItemsCard: 'Items',
  openThreadsCard: 'Open Threads'
});
```

- [ ] **Step 5: Run focused tests and verify green**

Run:

```powershell
node tools\scripts\test-card-scope.mjs
node tools\scripts\test-cards.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-progress.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit catalog implementation**

```powershell
git add src\card-scope.mjs src\cards.mjs src\providers.mjs src\progress.mjs tools\scripts\test-card-scope.mjs tools\scripts\test-cards.mjs tools\scripts\test-providers.mjs tools\scripts\test-progress.mjs
git commit -m "feat: apply audited card catalog"
```

---

### Task 3: Update Prompt Composition And Card Requests

**Files:**
- Modify: `src/cards.mjs`
- Modify: `src/prompt.mjs`
- Modify: `tools/scripts/test-cards.mjs`
- Modify: `tools/scripts/test-prompt.mjs`

- [ ] **Step 1: Add failing request-prompt assertions**

In `tools/scripts/test-cards.mjs`, replace scoped request test with:

```js
const scopedRequests = buildCardRequests({
  schema: 'recursion.utilityArbiterPlan.v1',
  snapshotHash: 'scope-test',
  cardJobs: [{ family: 'Scene Constraints', role: 'sceneConstraintsCard' }],
  budgets: { targetBriefTokens: 500, maxCards: 4 }
}, {
  runId: 'scope-run',
  snapshotHash: 'scope-test',
  snapshot: {},
  cardScope: {
    selectedSubItemsByFamily: {
      'Scene Constraints': ['hardLimits', 'timelineOrder']
    }
  }
});
assertDeepEqual(scopedRequests[0].cardScope.selectedSubItems, ['hardLimits', 'timelineOrder'], 'card request carries selected sub-item focus');
assert(scopedRequests[0].prompt.includes('Selected focus facets for Scene Constraints:'), 'card prompt includes selected focus header');
assert(scopedRequests[0].prompt.includes('hardLimits (hard limits)'), 'card prompt includes hard limits facet');
assert(scopedRequests[0].prompt.includes('timelineOrder (timeline/order)'), 'card prompt includes timeline/order facet');
assert(scopedRequests[0].prompt.includes('would make the next response implausible'), 'card prompt includes hard limits description');
assert(scopedRequests[0].prompt.includes('Immediate cause and effect'), 'card prompt includes timeline facet description');
assert(scopedRequests[0].prompt.includes('active scene evidence -> immediate implications -> relevance boundary'), 'card prompt states Recursion card shape');
assert(scopedRequests[0].prompt.includes('Do not create separate cards per facet.'), 'card prompt keeps one-card contract clear');
```

Add removed Prose request rejection:

```js
await assertRejects(
  async () => buildCardRequests({ cardJobs: [{ family: 'Prose', role: 'prosePacingCard' }] }, { runId: 'removed', snapshotHash: 'hash' }),
  /Unknown card catalog/,
  'removed Prose card jobs are rejected'
);
```

- [ ] **Step 2: Add failing prompt composition assertions**

In `tools/scripts/test-prompt.mjs`, replace guardrail and Prose examples:

```js
const packet = await composePromptPacket({
  selectedCards: [
    { id: 'c1', family: 'Scene Frame', promptText: 'Hermione is near the first-floor library corridor; nearby traffic and portraits can interrupt.', emphasis: 'normal', tokenEstimate: 20 },
    { id: 'c2', family: 'Scene Constraints', promptText: 'The side door is locked; no one should pass through it without unlocking it first.', emphasis: 'emphasized', tokenEstimate: 18 },
    { id: 'c3', family: 'Open Threads', promptText: 'Hermione still has not answered the whispered question.', emphasis: 'normal', tokenEstimate: 16 }
  ],
  settings: { promptFootprint: 'normal', reasonerUse: 'off' }
});
assert(packet.sections.guardrails.includes('side door is locked'), 'Scene Constraints becomes guardrail');
assert(packet.sections.turnBrief.includes('whispered question'), 'Open Threads remains turn-facing');
assert(!JSON.stringify(packet).includes('Prose'), 'prompt packet no longer contains Prose family output');
```

Replace unsafe family fallback expectations:

```js
assertEqual(hostilePacket.selectedCardRefs[0].family, 'Scene Frame', 'unsafe card family falls back to safe family');
assertEqual(hostilePacket.omissions[0].family, 'Scene Frame', 'unsafe omission family falls back');
```

- [ ] **Step 3: Update card request prompt shape**

In `src/cards.mjs`, update `cardScopePromptBlock()` to append the card-shape contract in both selected and unselected branches:

```js
function cardScopePromptBlock(catalog, selectedSubItems = []) {
  const family = cleanProviderPromptText(catalog.family, 120);
  const rows = selectedScopeFacetRows(family, selectedSubItems);
  const cardShapeLine = 'Card shape: active scene evidence -> immediate implications -> relevance boundary.';
  if (!rows.length) {
    return [
      `Selected focus facets for ${family}: none selected.`,
      'Generate this family only because the Arbiter requested it as high-relevance.',
      cardShapeLine,
      'Do not create separate cards per facet.'
    ].join('\n');
  }
  return [
    `Selected focus facets for ${family}:`,
    ...rows.map((item) => `- ${item.key} (${item.label}): ${item.description}`),
    'Use these facets to shape this one family card.',
    cardShapeLine,
    'Do not create separate cards per facet.'
  ].join('\n');
}
```

- [ ] **Step 4: Update prompt family sets**

In `src/prompt.mjs`, bump:

```js
export const PROMPT_PACKET_VERSION = 2;
```

Replace family sets:

```js
const SCENE_BRIEF_FAMILIES = new Set(['Scene Frame', 'Active Cast', 'Environment', 'Items']);
const GUARDRAIL_FAMILIES = new Set(['Scene Constraints', 'Knowledge']);
const VALID_FAMILIES = new Set([
  'Scene Frame',
  'Active Cast',
  'Character Motivation',
  'Relationship',
  'Scene Constraints',
  'Knowledge',
  'Consequences',
  'Environment',
  'Items',
  'Open Threads'
]);
```

Replace static guardrail line:

```js
const STATIC_GUARDRAILS = Object.freeze([
  'Respect the player message: preserve stated player intent, spoken content, and choices.',
  'Keep out-of-character analysis, unrevealed information, and future story plans out of the response.',
  'Resolve conflicts by preserving hard scene constraints before softer response suggestions.'
]);
```

Replace `safeFamily()` fallback:

```js
function safeFamily(value) {
  const family = cleanText(value, 120);
  return VALID_FAMILIES.has(family) ? family : 'Scene Frame';
}
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node tools\scripts\test-cards.mjs
node tools\scripts\test-prompt.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit prompt composition changes**

```powershell
git add src\cards.mjs src\prompt.mjs tools\scripts\test-cards.mjs tools\scripts\test-prompt.mjs
git commit -m "feat: route audited card prompt families"
```

---

### Task 4: Update Settings Focus Policy

**Files:**
- Modify: `src/settings.mjs`
- Modify: `src/settings-policy.mjs`
- Modify: `tools/scripts/test-settings.mjs`
- Modify: `tools/scripts/test-settings-policy.mjs`

- [ ] **Step 1: Add failing settings tests**

In `tools/scripts/test-settings.mjs`, update focus expectations:

```js
assertEqual(normalizeSettings({ focus: 'constraints' }).focus, 'constraints', 'constraints focus is accepted');
assertEqual(normalizeSettings({ focus: 'scene' }).focus, 'scene', 'scene focus is accepted');
assertEqual(normalizeSettings({ focus: 'continuity' }).focus, 'balanced', 'removed continuity focus normalizes to balanced');
assertEqual(normalizeSettings({ focus: 'prose' }).focus, 'balanced', 'removed prose focus normalizes to balanced');
```

Replace removed-family persistence check:

```js
const partialScope = defaultCardScope();
partialScope.families['Open Threads'].enabled = false;
for (const key of Object.keys(partialScope.families['Open Threads'].subItems)) {
  partialScope.families['Open Threads'].subItems[key] = false;
}
const normalizedPartial = normalizeSettings({ mode: 'manual', cardScope: partialScope });
assertEqual(normalizedPartial.cardScope.families['Open Threads'].enabled, false, 'disabled current family persists');
```

- [ ] **Step 2: Add failing settings-policy tests**

In `tools/scripts/test-settings-policy.mjs`, replace focus checks:

```js
assertDeepEqual(
  influencePolicyForSettings({ focus: 'constraints' }).focus.boostedFamilies,
  ['Scene Constraints', 'Items', 'Consequences', 'Scene Frame', 'Knowledge'],
  'constraints focus boosts expected families'
);
assertDeepEqual(
  influencePolicyForSettings({ focus: 'scene' }).focus.boostedFamilies,
  ['Scene Frame', 'Environment', 'Items', 'Active Cast'],
  'scene focus boosts expected families'
);
assert(!Object.prototype.hasOwnProperty.call(FOCUS_BOOSTED_FAMILIES, 'prose'), 'removed prose focus has no policy');
assert(!Object.prototype.hasOwnProperty.call(FOCUS_BOOSTED_FAMILIES, 'continuity'), 'removed continuity focus has no policy');
```

Update diagnostic sample:

```js
const diagnostics = summarizeBehaviorPolicyForDiagnostics({
  focus: 'character',
  footprintOverrideReason: 'high-scene-constraint-risk',
  selectedFamilies: ['Active Cast', 'Scene Constraints', 'Character Motivation']
});
```

- [ ] **Step 3: Update settings enum**

In `src/settings.mjs`, replace:

```js
const FOCUS = new Set(['balanced', 'character', 'constraints', 'scene', 'plot']);
```

Do not add aliases for `continuity` or `prose`.

- [ ] **Step 4: Update policy profiles**

In `src/settings-policy.mjs`, replace `FOCUS_BOOSTED_FAMILIES`:

```js
export const FOCUS_BOOSTED_FAMILIES = Object.freeze({
  balanced: Object.freeze([]),
  character: Object.freeze(['Active Cast', 'Character Motivation', 'Relationship', 'Knowledge']),
  constraints: Object.freeze(['Scene Constraints', 'Items', 'Consequences', 'Scene Frame', 'Knowledge']),
  scene: Object.freeze(['Scene Frame', 'Environment', 'Items', 'Active Cast']),
  plot: Object.freeze(['Open Threads', 'Consequences', 'Knowledge', 'Scene Frame'])
});
```

Replace strength and footprint copy:

```js
arbiterLine: 'Strength: Light. Prefer valid cache, avoid churn, and refresh only when relevance or drift risk is clear. Do not drop critical scene constraints.',
```

```js
arbiterLine: 'Prompt Footprint: Compact. Keep compact unless a safety or hard scene-constraint reason requires temporary expansion.',
```

Replace focus arbiter line builder:

```js
arbiterLine: focus === 'balanced'
  ? 'Focus: Balanced. Do not boost a family; prefer the Arbiter-selected current turn relevance.'
  : `Focus: ${focus[0].toUpperCase()}${focus.slice(1)}. Prefer ${boostedFamilies.join(', ')} when relevant; do not ignore critical non-${focus} scene constraints.`,
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node tools\scripts\test-settings.mjs
node tools\scripts\test-settings-policy.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit settings policy**

```powershell
git add src\settings.mjs src\settings-policy.mjs tools\scripts\test-settings.mjs tools\scripts\test-settings-policy.mjs
git commit -m "feat: align focus policy with scene reasoning"
```

---

### Task 5: Update Runtime Planning, Fallback, And Cache Behavior

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Add failing runtime tests for fallback cards**

In `tools/scripts/test-runtime.mjs`, replace local fallback assertions that expect `Continuity Risk` with `Scene Constraints`:

```js
assert(cache.cards.some((card) => card.family === 'Scene Constraints'), 'local fallback adds Scene Constraints card');
assert(!cache.cards.some((card) => card.family === 'Continuity Risk'), 'local fallback does not add removed Continuity Risk card');
assert(view.lastHand.cards.some((card) => card.family === 'Scene Constraints'), 'fallback hand includes Scene Constraints card');
```

Where provider role calls are inspected, expect:

```js
assert(routerCalls.some((call) => call.roleId === 'sceneConstraintsCard'), 'Scene Constraints card role is routed');
assert(!routerCalls.some((call) => call.roleId === 'continuityRiskCard'), 'removed continuityRiskCard role is not routed');
```

- [ ] **Step 2: Add failing runtime tests for Manual and Auto scope**

Replace Auto disabled continuity scope tests with:

```js
const autoNoConstraints = scopeWithFamilyDisabled('Scene Constraints');
const runtime = createRuntimeHarness({
  settings: { mode: 'auto', cardScope: autoNoConstraints, reasonerUse: 'off' },
  router: async (roleId, request) => {
    if (roleId === 'utilityArbiter') {
      const cardScope = parsePromptJsonSection(request.prompt, 'Card scope');
      assertEqual(cardScope.strictWhitelist, false, 'Auto Arbiter prompt is focus, not strict');
      assert(cardScope.availableCatalog.some((entry) => entry.family === 'Scene Constraints'), 'Auto catalog keeps disabled-focus Scene Constraints available');
      assertDeepEqual(cardScope.selectedSubItemsByFamily['Scene Constraints'], undefined, 'Auto preference omits disabled Scene Constraints sub-items');
      return {
        ok: true,
        data: {
          schema: 'recursion.utilityArbiter.v1',
          snapshotHash: request.snapshotHash,
          action: 'refresh-cards',
          sceneStatus: 'same-scene',
          cardJobs: [{ family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'Hard scene constraint exception.' }],
          lifecycle: [],
          reasonerDecision: { mode: 'skip', reason: 'test' },
          budgets: { targetBriefTokens: 500, maxCards: 4 },
          diagnostics: []
        }
      };
    }
    if (roleId === 'sceneConstraintsCard') return cardProviderResponse(request, 'Scene Constraints', 'The hatch remains sealed until opened.', ['message:1']);
    return cardProviderResponse(request, 'Scene Frame', 'Fallback scene.', ['message:1']);
  }
});
const result = await runtime.prepareForGeneration({ userMessage: 'Try the hatch.' });
assertEqual(result.ok, true, 'auto scoped constraints exception installs');
const view = runtime.getViewModel();
assert(view.lastHand.cards.some((card) => card.family === 'Scene Constraints'), 'auto scoped hand can include critical disabled-focus exception');
assert(JSON.stringify(view.lastPlan).includes('auto-scope-exception:Scene Constraints'), 'auto scoped diagnostics record compact exception family');
```

- [ ] **Step 3: Update runtime local fallback**

Find the local fallback builder that creates `Continuity Risk`. Replace it with:

```js
const constraints = normalizeCard({
  family: 'Scene Constraints',
  role: 'sceneConstraintsCard',
  promptText: 'Respect hard scene constraints from the visible turn: do not contradict stated access, timing, object state, or visible limits.',
  summary: 'Hard scene constraints from latest visible turn.',
  evidenceRefs,
  emphasis: 'emphasized'
}, context);
return [scene, constraints];
```

Use existing local variables for `evidenceRefs` and `context`; do not introduce new snapshot reads.

- [ ] **Step 4: Update runtime prompt copy and diagnostics**

Replace runtime strings:

```js
'Auto card scope policy: selected families and sub-items are the preferred focus, not a whitelist. Prefer selected scope when it can satisfy the turn; request unselected families only when they have high relevance to scene constraints, scene coherence, or the current user message.'
```

Replace tests and comments that say `Continuity still matters.` with:

```js
'Scene constraints still matter.'
```

- [ ] **Step 5: Run focused runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit runtime changes**

```powershell
git add src\runtime.mjs tools\scripts\test-runtime.mjs
git commit -m "feat: use scene constraints in runtime"
```

---

### Task 6: Update UI Cards Scope And Settings Surfaces

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css` if spacing changes
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md`

- [ ] **Step 1: Add failing UI tests for Cards dropdown**

In `tools/scripts/test-ui.mjs`, replace cards dropdown assertions:

```js
assertEqual(root.querySelectorAll('[data-recursion-card-scope-family]').length, 10, 'Cards dropdown renders audited V1 families');
const cardScopeText = fakeDocument.textTree(root.querySelector('[data-recursion-cards-panel]'));
for (const familyName of ['Scene Frame', 'Active Cast', 'Scene Constraints', 'Knowledge', 'Consequences', 'Environment', 'Items', 'Open Threads']) {
  assert(cardScopeText.includes(familyName), `Cards dropdown renders ${familyName}`);
}
for (const removed of ['Prose', 'Continuity Risk', 'density', 'specificity/shape', 'present participants']) {
  assert(!cardScopeText.includes(removed), `Cards dropdown omits removed label ${removed}`);
}
assert(cardScopeText.includes('beat constraint'), 'Cards dropdown renders rehomed beat constraint');
assert(cardScopeText.includes('hard limits'), 'Cards dropdown renders hard limits facet');
```

Replace old density tooltip assertions with:

```js
const beatConstraint = [...root.querySelectorAll('[data-recursion-card-scope-sub-item]')]
  .find((node) => node.dataset.recursionCardScopeFamilyName === 'Scene Frame'
    && node.dataset.recursionCardScopeSubItem === 'beatConstraint');
assert(beatConstraint, 'Scene Frame beatConstraint sub-item exists');
assert(
  beatConstraint.getAttribute('title').includes('avoid time skip'),
  'beatConstraint tooltip explains hard beat boundary'
);
```

- [ ] **Step 2: Add failing UI tests for Focus setting**

In settings panel test section, assert:

```js
const settingsText = fakeDocument.textTree(root.querySelector('[data-recursion-settings-panel]'));
assert(settingsText.includes('Constraints'), 'settings Focus includes Constraints option');
assert(settingsText.includes('Scene'), 'settings Focus includes Scene option');
assert(!settingsText.includes('Continuity'), 'settings Focus omits old Continuity option');
assert(!settingsText.includes('Prose'), 'settings Focus omits old Prose option');
```

- [ ] **Step 3: Update UI logic only if tests expose hardcoded labels**

If `src/ui.mjs` already renders from `CARD_SCOPE_CATALOG`, no catalog UI code change is needed for Cards dropdown. If it hardcodes icons per family, update maps:

```js
const CARD_SCOPE_ICON_BY_FAMILY = Object.freeze({
  'Scene Frame': 'map',
  'Active Cast': 'users',
  'Character Motivation': 'gauge',
  Relationship: 'message-circle',
  'Scene Constraints': 'shield-alert',
  Knowledge: 'eye-off',
  Consequences: 'timer',
  Environment: 'route',
  Items: 'package',
  'Open Threads': 'list-checks'
});
```

If settings Focus options are hardcoded, replace with:

```js
const FOCUS_OPTIONS = [
  ['balanced', 'Balanced'],
  ['character', 'Character'],
  ['constraints', 'Constraints'],
  ['scene', 'Scene'],
  ['plot', 'Plot']
];
```

- [ ] **Step 4: Update implementation reference mock**

In `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md`, replace old Cards/Prose examples:

```html
<span class="kind-label">Scene Constraints</span>
```

```html
<span class="kind-label">Scene Frame</span>
<span class="sub-label">beat constraint</span>
```

Remove any rendered `Prose pacing` row and remove `Continuity Risk` labels from card examples. Keep old strings only if explicitly describing removed legacy behavior.

- [ ] **Step 5: Run focused UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit UI changes**

```powershell
git add src\ui.mjs styles\recursion.css tools\scripts\test-ui.mjs docs\design\RECURSION_BAR_IMPLEMENTATION_REFERENCE.md
git commit -m "feat: update card scope UI catalog"
```

---

### Task 7: Update Docs And Render Tracking

**Files:**
- Modify: `README.md`
- Modify: `docs/RECURSION_EXTENSION_SPEC.md`
- Modify: `docs/design/CARD_SYSTEM_SPEC.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/architecture/PROMPT_COMPOSITION_SPEC.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/technical/CARD_DECK_AND_HAND.md`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- Modify: `docs/technical/PROMPT_PACKET_AND_INJECTION.md`
- Modify: `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/testing/IMPLEMENTATION_PLAN.md`
- Modify: `docs/planning/DOCUMENTATION_EXPANSION_PLAN.md`

- [ ] **Step 1: Update canonical docs**

In `docs/design/CARD_SYSTEM_SPEC.md`, replace the current audit note that says implementation may still expose legacy family names. After implementation, it should say:

```md
V1 uses the audited fixed catalog below. The Arbiter receives this predetermined catalog as a menu and decides what is already represented, what is missing, and what should be generated for the current scene.
```

Update family table to list:

```md
| Scene Constraints | Hard limits, contradiction traps, timing, access, visibility, and plausibility constraints. | High-priority safety lane for scene constraints. |
```

Remove the `Prose` row. Keep a short migration note:

```md
The earlier Prose family was removed from the V1 catalog. Broad density and specificity guidance belongs to the user's preset and behavior settings; hard beat constraints now live under Scene Frame.
```

- [ ] **Step 2: Update UI and operator docs**

Replace Cards scope lists in `docs/design/UI_SPEC.md` and `docs/user/RECURSION_OPERATOR_MANUAL.md` with:

```md
- Scene Frame
- Active Cast
- Character Motivation
- Relationship
- Scene Constraints
- Knowledge
- Consequences
- Environment
- Items
- Open Threads
```

Replace Focus lists:

```md
- Balanced
- Character
- Constraints
- Scene
- Plot
```

- [ ] **Step 3: Update architecture and technical docs**

Replace role lists in provider/model-call docs with:

```md
`sceneFrameCard`, `activeCastCard`, `characterMotivationCard`, `dialogueRelationshipCard`, `sceneConstraintsCard`, `knowledgeSecretsCard`, `clocksConsequencesCard`, `environmentAffordancesCard`, `possessionsItemsCard`, and `openThreadsCard`
```

Replace prompt composition mapping:

```md
- Scene Brief: Scene Frame, Active Cast, Environment, Items
- Guardrails: Scene Constraints, Knowledge, plus static guardrails
- Turn Brief: Character Motivation, Relationship, Consequences, Open Threads, and other turn-facing guidance
```

- [ ] **Step 4: Run stale-string scan**

Run:

```powershell
rg -n "Continuity Risk|continuityRiskCard|Prose|prosePacingCard|density|specificityShape|presentParticipants|fragileFacts|prose focus|Continuity focus" README.md docs src tools
```

Expected: no matches except historical plan/spec files under `docs/superpowers/` when they explicitly describe previous implementation. If matches appear in active code, tests, or current docs, update them.

- [ ] **Step 5: Commit docs**

```powershell
git add README.md docs\RECURSION_EXTENSION_SPEC.md docs\design\CARD_SYSTEM_SPEC.md docs\design\UI_SPEC.md docs\design\BEHAVIOR_SETTINGS_POLICY_SPEC.md docs\architecture\PROVIDER_AND_GENERATION_SPEC.md docs\architecture\PROMPT_COMPOSITION_SPEC.md docs\architecture\RUNTIME_ARCHITECTURE.md docs\technical\CARD_DECK_AND_HAND.md docs\technical\MODEL_CALLS_AND_PROVIDER_ROUTING.md docs\technical\PROMPT_PACKET_AND_INJECTION.md docs\technical\RECURSION_TECHNICAL_MANUAL.md docs\technical\RUNTIME_TURN_SEQUENCE.md docs\user\RECURSION_OPERATOR_MANUAL.md docs\testing\IMPLEMENTATION_PLAN.md docs\planning\DOCUMENTATION_EXPANSION_PLAN.md
git commit -m "docs: document audited card catalog"
```

---

### Task 8: Full Verification Gate

**Files:**
- No planned source edits.

- [ ] **Step 1: Run focused lane tests**

Run:

```powershell
node tools\scripts\test-card-scope.mjs
node tools\scripts\test-cards.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-progress.mjs
node tools\scripts\test-prompt.mjs
node tools\scripts\test-settings.mjs
node tools\scripts\test-settings-policy.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-ui.mjs
```

Expected: all PASS.

- [ ] **Step 2: Run repo test suite**

Run:

```powershell
npm.cmd test
```

Expected: PASS.

- [ ] **Step 3: Run alpha gate**

Run:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: PASS. If unrelated shared-worktree failures appear, record exact failing script and line in final handoff before touching unrelated files.

- [ ] **Step 4: Run stale-string gate**

Run:

```powershell
rg -n "Continuity Risk|continuityRiskCard|Prose|prosePacingCard|density|specificityShape|presentParticipants|fragileFacts|prose focus|Continuity focus" src tools README.md docs\RECURSION_EXTENSION_SPEC.md docs\design docs\architecture docs\technical docs\user docs\testing docs\planning
```

Expected: no active-code/current-doc matches. Matches in old `docs/superpowers/plans/` are allowed only if command scope includes them; this command does not.

- [ ] **Step 5: Review worktree diff**

Run:

```powershell
git diff --stat
git diff --check
```

Expected: `git diff --check` exits 0. `git diff --stat` shows only files expected by this plan plus any pre-existing unrelated files that were present before execution.

- [ ] **Step 6: Final commit if previous task commits were skipped**

If implementation used per-task commits, skip this step. If implementation was done as one changeset, run:

```powershell
git add src tools README.md docs
git commit -m "feat: implement audited card catalog"
```

---

## Self-Review Checklist

- [ ] Card System Spec audit implemented at facet level, not only family level.
- [ ] `Prose`, `prosePacingCard`, `density`, `momentum`, and `specificityShape` absent from active code/tests/docs.
- [ ] `Continuity Risk`, `continuityRiskCard`, and `fragileFacts` absent from active code/tests/docs.
- [ ] `Scene Constraints`, `sceneConstraintsCard`, and `hardLimits` present in catalog, provider roles, progress labels, prompt routing, runtime fallback, tests, and docs.
- [ ] `Scene Frame.beatConstraint` present in catalog, UI, request prompt, tests, and docs.
- [ ] `Scene Frame.presentParticipants` removed and Active Cast remains responsible for present characters.
- [ ] Focus options are `balanced`, `character`, `constraints`, `scene`, `plot`.
- [ ] Old stored settings/cache are not supported with compatibility aliases; they normalize/drop through current pre-alpha contract.
- [ ] Full local gate passes or any unrelated shared-worktree failure is reported with exact file/line.

