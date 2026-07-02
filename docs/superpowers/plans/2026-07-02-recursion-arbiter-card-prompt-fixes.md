# Recursion Arbiter And Card Prompt Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Recursion card scope, Arbiter planning, card generation prompts, behavior policy, cache lifecycle, and UI hover help describe and enforce the same V1 contract.

**Architecture:** Put card-scope family and sub-item meaning in one source of truth, then feed that meaning into Arbiter prompts, card-generation prompts, UI tooltips, docs, and diagnostics. Keep semantic judgment in Utility/Reasoner calls; runtime only enforces mechanical policy, cache safety, scope filtering, card limits, footprint limits, and stale-result guards.

**Tech Stack:** JavaScript ES modules, SillyTavern extension host adapter, Recursion provider/router runtime, markdown docs, existing `node tools/scripts/test-*.mjs` deterministic test harness.

---

## Investigation Findings

These findings came from the current tree on 2026-07-02.

- `src/card-scope.mjs` has family descriptions and sub-item labels, but no sub-item descriptions. Terms such as `density` and `specificityShape` are therefore not defined in a model-facing or UI-facing source.
- `src/runtime.mjs` sends `Card scope:` and `Catalog:` into the Utility Arbiter prompt, so the Arbiter can see selected families and selected sub-items.
- `src/cards.mjs` puts selected sub-item keys into `request.cardScope.selectedSubItems`, but the prompt string sent to providers starts with `Create one compact <family> card...` and does not mention the selected sub-items.
- Provider paths use `request.prompt` or `request.messages` as model-visible content. `request.cardScope` is diagnostics/request metadata unless copied into `request.prompt`.
- `tools/scripts/test-cards.mjs` checks only that `request.cardScope.selectedSubItems` exists. It does not prove the provider model can see the focus facets.
- `src/runtime.mjs` now includes behavior policy plumbing, but existing runtime expectations still conflict around compact stored footprint versus Arbiter-requested rich footprint.
- The Arbiter is intended to decide reuse, refresh, create, stow, discard, regenerate, select, and emphasize; runtime must make those choices mechanically safe and explicit rather than infer semantic relevance itself.

## File Structure

- Modify `src/card-scope.mjs`: single source of truth for family descriptions, sub-item labels, sub-item descriptions, and catalog payloads sent to Arbiter/card generation/UI.
- Modify `src/cards.mjs`: model-visible card-generation prompt includes selected sub-item focus with labels and descriptions; card job metadata preserves refresh intent without leaking prompt text.
- Modify `src/runtime.mjs`: Arbiter prompt spells out plan/lifecycle/card-job contract; behavior policy uses stored and effective footprint distinctly; hand selection and composition receive the run policy consistently.
- Modify `src/settings-policy.mjs`: add an effective-run policy helper so diagnostics can report stored footprint and effective footprint without losing section budgets.
- Modify `src/ui.mjs`: Cards panel sub-item hover text uses `item.description`, not the raw label.
- Modify `tools/scripts/test-card-scope.mjs`: assert every sub-item has a useful description and catalog payload includes it.
- Modify `tools/scripts/test-cards.mjs`: assert selected sub-items appear in provider prompt text; assert disabled-focus exception prompt is explicit and safe.
- Modify `tools/scripts/test-runtime.mjs`: assert Arbiter prompt contract, footprint override rules, refresh/regenerate semantics, and policy diagnostics.
- Modify `tools/scripts/test-ui.mjs`: assert `density` hover help explains actual Prose focus.
- Modify docs: `docs/design/CARD_SYSTEM_SPEC.md`, `docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md`, `docs/design/UI_SPEC.md`, `docs/technical/CARD_DECK_AND_HAND.md`, `docs/technical/RUNTIME_TURN_SEQUENCE.md`, `docs/architecture/RUNTIME_ARCHITECTURE.md`, `docs/architecture/PROMPT_COMPOSITION_SPEC.md`, `docs/technical/PROMPT_PACKET_AND_INJECTION.md`, and `docs/DOCUMENTATION_INDEX.md` only if new doc anchors are added.

## Canonical Sub-Item Descriptions

Use these exact descriptions in `src/card-scope.mjs`. Keep text compact because it appears in Arbiter/card prompts and native browser tooltips.

| Family | Key | Label | Description |
| --- | --- | --- | --- |
| Scene Frame | `locationSituation` | `location/situation` | Current place, immediate setup, and active problem the next response must not drift away from. |
| Scene Frame | `presentParticipants` | `present participants` | Characters or groups visibly present in the scene and relevant to the next beat. |
| Scene Frame | `immediateDirection` | `immediate direction` | The near next action, pressure, or dramatic vector the response should continue. |
| Active Cast | `presentCharacters` | `present characters` | Who is in the scene now, including characters who should not be dropped or invented. |
| Active Cast | `visibleState` | `visible state` | Observable condition, posture, injury, mood, constraint, or capability that affects action. |
| Active Cast | `speakerRoles` | `speaker roles` | Who can speak, who is being addressed, and who currently drives the exchange. |
| Character Motivation | `visibleGoals` | `visible goals` | Goals shown or established in-scene, phrased as behavior-facing guidance. |
| Character Motivation | `pressures` | `pressures` | External, social, tactical, or emotional pressures shaping likely behavior. |
| Character Motivation | `hesitationPosture` | `hesitation/posture` | Visible reluctance, guardedness, confidence, uncertainty, or restraint without private mind-reading. |
| Relationship | `tension` | `tension` | Current conversational pressure, emotional friction, or unresolved subtext. |
| Relationship | `promisesConflicts` | `promises/conflicts` | Promises, refusals, disagreements, debts, threats, or relational obligations still active. |
| Relationship | `voiceConstraints` | `voice constraints` | Scene-local tone, address, or speech constraints that should guide dialogue without replacing the preset. |
| Continuity Risk | `fragileFacts` | `fragile facts` | Easy-to-break facts such as injuries, locked doors, missing items, stated choices, or visible constraints. |
| Continuity Risk | `spatialConstraints` | `spatial constraints` | Position, distance, blocked routes, visibility, reach, or movement limits that must stay consistent. |
| Continuity Risk | `timelineOrder` | `timeline/order` | Event order, cause and effect, reveal order, and what has or has not happened yet. |
| Knowledge | `concealedFacts` | `concealed facts` | Hidden truths that may guide guardrails but should not be revealed as dialogue or narration unless earned. |
| Knowledge | `knowsSuspects` | `knows/suspects` | Who knows, suspects, misunderstands, or should not know a fact. |
| Knowledge | `revealBoundaries` | `reveal boundaries` | What the next response must not reveal, confirm, or imply too early. |
| Consequences | `deadlinesCountdowns` | `deadlines/countdowns` | Time pressure, countdowns, scheduled events, or windows of opportunity still active. |
| Consequences | `delayedConsequences` | `delayed consequences` | Effects from earlier choices that should arrive later or remain pending. |
| Consequences | `escalationTriggers` | `escalation triggers` | Conditions that would make the scene worsen, shift phase, or demand action. |
| Environment | `spatialLayout` | `spatial layout` | Where important places, barriers, exits, cover, and actors are in relation to each other. |
| Environment | `sensoryTexture` | `sensory texture` | Concrete sensory details that ground prose without turning into decorative filler. |
| Environment | `hazardsAffordances` | `hazards/affordances` | Usable objects, obstacles, threats, exits, cover, tools, and environmental opportunities. |
| Items | `heldCarriedItems` | `held/carried items` | Important objects currently held, worn, carried, hidden, missing, stolen, or controlled. |
| Items | `itemLocationControl` | `location/control` | Where an item is and who can realistically access, use, move, or withhold it. |
| Items | `itemAffordancesRisks` | `affordances/risks` | What an item can do now, what it enables, and what risk or limit it carries. |
| Prose | `density` | `density` | How packed the next response should be with action, dialogue, description, and consequence. |
| Prose | `momentum` | `momentum` | Whether the response should advance the beat, hold tension, slow down, or avoid skipping necessary payoff. |
| Prose | `specificityShape` | `specificity/shape` | Concrete detail choice and response structure for this beat, avoiding generic prose and shapeless recap. |
| Open Threads | `unresolvedQuestions` | `unresolved questions` | Questions raised by the scene that remain visible and may affect the next response. |
| Open Threads | `pendingActions` | `pending actions` | Promised, attempted, interrupted, or requested actions that should not be forgotten. |
| Open Threads | `nearTermPressures` | `near-term pressures` | Immediate obligations, looming problems, or choices that should shape the next beat. |

## Task 1: Single-Source Card Scope Vocabulary

**Files:**
- Modify: `src/card-scope.mjs`
- Modify: `tools/scripts/test-card-scope.mjs`
- Modify: `docs/design/CARD_SYSTEM_SPEC.md`
- Modify: `docs/technical/CARD_DECK_AND_HAND.md`

- [ ] **Step 1: Write failing catalog-description tests**

Add this block after existing catalog shape assertions in `tools/scripts/test-card-scope.mjs`:

```js
for (const family of CARD_SCOPE_CATALOG) {
  assert(
    typeof family.description === 'string' && family.description.length >= 24,
    `${family.family} family has useful description`
  );
  for (const item of family.subItems) {
    assert(
      typeof item.description === 'string' && item.description.length >= 40,
      `${family.family}/${item.key} has useful sub-item description`
    );
    assert(!/\bTBD\b|\bTODO\b/i.test(item.description), `${family.family}/${item.key} description is final copy`);
  }
}

const prosePayload = scopePayloadForArbiter({ mode: 'auto', cardScope: defaultCardScope() })
  .availableCatalog.find((entry) => entry.family === 'Prose');
assert(
  prosePayload.subItems.find((item) => item.key === 'density').description.includes('packed'),
  'Arbiter catalog payload includes density description'
);
```

- [ ] **Step 2: Run failing test**

Run: `node tools/scripts/test-card-scope.mjs`

Expected: FAIL because existing sub-items have `key` and `label` but no `description`.

- [ ] **Step 3: Add sub-item descriptions to `src/card-scope.mjs`**

For every existing sub-item in `CARD_SCOPE_CATALOG`, add the matching `description` from the "Canonical Sub-Item Descriptions" section. Example final shape:

```js
Object.freeze({
  family: 'Prose',
  role: 'prosePacingCard',
  description: 'Local craft guidance for density, momentum, specificity, and response shape.',
  subItems: Object.freeze([
    Object.freeze({
      key: 'density',
      label: 'density',
      description: 'How packed the next response should be with action, dialogue, description, and consequence.'
    }),
    Object.freeze({
      key: 'momentum',
      label: 'momentum',
      description: 'Whether the response should advance the beat, hold tension, slow down, or avoid skipping necessary payoff.'
    }),
    Object.freeze({
      key: 'specificityShape',
      label: 'specificity/shape',
      description: 'Concrete detail choice and response structure for this beat, avoiding generic prose and shapeless recap.'
    })
  ])
})
```

- [ ] **Step 4: Include descriptions in catalog payloads**

Replace the `subItems` line in `catalogPayload(entry, selected = null)` with:

```js
subItems: entry.subItems.map((item) => ({
  key: item.key,
  label: item.label,
  description: item.description
}))
```

- [ ] **Step 5: Document scope facets**

In `docs/design/CARD_SYSTEM_SPEC.md` and `docs/technical/CARD_DECK_AND_HAND.md`, add one short paragraph after the family matrix:

```markdown
Each family also exposes fixed scope facets. Facets do not create separate cards; they define what the Arbiter and card generator should emphasize inside that family. The facet labels and descriptions live in `src/card-scope.mjs` and are reused for Arbiter catalog payloads, card-generation prompt focus, UI hover help, and diagnostics.
```

- [ ] **Step 6: Verify task**

Run: `node tools/scripts/test-card-scope.mjs`

Expected: PASS with `[pass] card-scope`.

- [ ] **Step 7: Commit**

```bash
git add src/card-scope.mjs tools/scripts/test-card-scope.mjs docs/design/CARD_SYSTEM_SPEC.md docs/technical/CARD_DECK_AND_HAND.md
git commit -m "fix: define card scope facets"
```

## Task 2: Make Selected Sub-Items Model-Visible In Card Generation

**Files:**
- Modify: `src/cards.mjs`
- Modify: `tools/scripts/test-cards.mjs`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`

- [ ] **Step 1: Write failing provider-prompt test**

Extend the existing `scopedRequests` assertions in `tools/scripts/test-cards.mjs`:

```js
assert(scopedRequests[0].prompt.includes('Selected focus facets for Continuity Risk:'), 'card prompt includes selected focus header');
assert(scopedRequests[0].prompt.includes('fragileFacts (fragile facts)'), 'card prompt includes selected fragile facts facet');
assert(scopedRequests[0].prompt.includes('timelineOrder (timeline/order)'), 'card prompt includes selected timeline/order facet');
assert(scopedRequests[0].prompt.includes('Easy-to-break facts'), 'card prompt includes selected facet description');
assert(scopedRequests[0].prompt.includes('Event order, cause and effect'), 'card prompt includes timeline facet description');
assert(scopedRequests[0].prompt.includes('Do not create separate cards per facet.'), 'card prompt keeps one-card contract clear');
```

Add a second request case for disabled-focus Auto exceptions:

```js
const disabledFocusRequest = buildCardRequests({
  cardJobs: [{ family: 'Prose', role: 'prosePacingCard', reason: 'High relevance style risk.' }]
}, {
  runId: 'disabled-focus-run',
  snapshotHash: 'disabled-focus-hash',
  snapshot: {},
  cardScope: { selectedSubItemsByFamily: {} }
})[0];
assertDeepEqual(disabledFocusRequest.cardScope.selectedSubItems, [], 'disabled focus request still records empty selected facets');
assert(
  disabledFocusRequest.prompt.includes('Selected focus facets for Prose: none selected.'),
  'disabled focus request tells provider no facets were selected'
);
assert(
  disabledFocusRequest.prompt.includes('Generate this family only because the Arbiter requested it as high-relevance.'),
  'disabled focus request explains Auto exception behavior'
);
```

- [ ] **Step 2: Run failing cards test**

Run: `npm.cmd run test:cards`

Expected: FAIL because current prompt does not include selected sub-item focus text.

- [ ] **Step 3: Import scope catalog in `src/cards.mjs`**

Add:

```js
import { CARD_SCOPE_CATALOG } from './card-scope.mjs';
```

Add near catalog maps:

```js
const CARD_SCOPE_BY_FAMILY = new Map(CARD_SCOPE_CATALOG.map((entry) => [entry.family, entry]));
```

- [ ] **Step 4: Add prompt-block helpers**

Add these helpers above `buildCardRequests()`:

```js
function scopeCatalogForFamily(family) {
  return CARD_SCOPE_BY_FAMILY.get(String(family || '').trim()) || null;
}

function selectedScopeFacetRows(family, selectedSubItems = []) {
  const scope = scopeCatalogForFamily(family);
  const selected = new Set((Array.isArray(selectedSubItems) ? selectedSubItems : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean));
  if (!scope || selected.size === 0) return [];
  return scope.subItems
    .filter((item) => selected.has(item.key))
    .map((item) => ({
      key: cleanProviderPromptText(item.key, 80),
      label: cleanProviderPromptText(item.label, 120),
      description: cleanProviderPromptText(item.description, 260)
    }));
}

function cardScopePromptBlock(catalog, selectedSubItems = []) {
  const family = cleanProviderPromptText(catalog.family, 120);
  const rows = selectedScopeFacetRows(family, selectedSubItems);
  if (!rows.length) {
    return [
      `Selected focus facets for ${family}: none selected.`,
      'Generate this family only because the Arbiter requested it as high-relevance.',
      'Do not create separate cards per facet.'
    ].join('\n');
  }
  return [
    `Selected focus facets for ${family}:`,
    ...rows.map((item) => `- ${item.key} (${item.label}): ${item.description}`),
    'Use these facets to shape this one family card.',
    'Do not create separate cards per facet.'
  ].join('\n');
}
```

- [ ] **Step 5: Insert focus block into provider prompt**

In `buildCardRequests()`, insert this line immediately after `Create one compact...`:

```js
cardScopePromptBlock(catalog, selectedSubItems),
```

The prompt section should become:

```js
prompt: [
  `Create one compact ${catalog.family} card for the current scene.`,
  cardScopePromptBlock(catalog, selectedSubItems),
  'Return one JSON object only. Do not wrap it in markdown.',
  ...
]
```

- [ ] **Step 6: Update runtime docs**

Replace the existing sentence in `docs/technical/RUNTIME_TURN_SEQUENCE.md`:

```markdown
Card requests are built from the Arbiter plan, the frozen snapshot, and the selected sub-item focus for each requested family. Sub-items guide what the provider should emphasize inside a family; they do not create separate card instances.
```

with:

```markdown
Card requests are built from the Arbiter plan, the frozen snapshot, and the selected sub-item focus for each requested family. The selected focus facets are copied into the model-visible card-generation prompt with their labels and descriptions, while also remaining in safe request metadata for diagnostics. Sub-items guide what the provider should emphasize inside a family; they do not create separate card instances.
```

- [ ] **Step 7: Verify task**

Run:

```powershell
npm.cmd run test:cards
```

Expected: PASS with `[pass] cards`.

- [ ] **Step 8: Commit**

```bash
git add src/cards.mjs tools/scripts/test-cards.mjs docs/technical/RUNTIME_TURN_SEQUENCE.md
git commit -m "fix: send card scope facets to providers"
```

## Task 3: Align Effective Behavior Policy With Stored Footprint Diagnostics

**Files:**
- Modify: `src/settings-policy.mjs`
- Modify: `src/runtime.mjs`
- Modify: `src/prompt.mjs`
- Modify: `tools/scripts/test-settings-policy.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-prompt.mjs`
- Modify: `docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/PROMPT_COMPOSITION_SPEC.md`

- [ ] **Step 1: Write failing policy helper tests**

In `tools/scripts/test-settings-policy.mjs`, update imports:

```js
import {
  FOOTPRINT_SECTION_BUDGETS,
  FOCUS_BOOSTED_FAMILIES,
  influencePolicyForSettings,
  runPolicyForEffectivePlan,
  summarizeBehaviorPolicyForDiagnostics
} from '../../src/settings-policy.mjs';
```

Add:

```js
const compactStoredRichEffective = runPolicyForEffectivePlan({
  promptFootprint: 'compact',
  focus: 'prose',
  strength: 'strong'
}, {
  promptFootprint: 'rich',
  diagnostics: ['footprint-risk-override'],
  budgets: { targetBriefTokens: 900, maxCards: 9 }
});
assertEqual(compactStoredRichEffective.footprint.level, 'compact', 'run policy preserves stored footprint level');
assertEqual(compactStoredRichEffective.footprint.effectiveLevel, 'rich', 'run policy records effective footprint level');
assertDeepEqual(compactStoredRichEffective.footprint.sectionBudgets, FOOTPRINT_SECTION_BUDGETS.rich, 'run policy uses effective rich budgets');
assert(compactStoredRichEffective.footprint.composerLine.includes('Rich'), 'run policy uses effective footprint composer line');

const effectiveDiagnostics = summarizeBehaviorPolicyForDiagnostics(compactStoredRichEffective, {
  selectedFamilies: ['Prose']
});
assertEqual(effectiveDiagnostics.storedFootprint, 'compact', 'diagnostics preserve stored footprint');
assertEqual(effectiveDiagnostics.effectiveFootprint, 'rich', 'diagnostics expose effective footprint');
assertEqual(effectiveDiagnostics.footprintOverrideReason, 'footprint-risk-override', 'diagnostics expose footprint override reason');
```

- [ ] **Step 2: Run failing policy test**

Run: `node tools/scripts/test-settings-policy.mjs`

Expected: FAIL because `runPolicyForEffectivePlan` does not exist.

- [ ] **Step 3: Add effective-run policy helper**

In `src/settings-policy.mjs`, export footprint policies:

```js
export const FOOTPRINT_POLICIES = Object.freeze({
  compact: Object.freeze({
    level: 'compact',
    allowedProfiles: Object.freeze(['compact']),
    preferredProfile: 'compact',
    maxCardsTarget: 3,
    maxCardsCeiling: 4,
    arbiterLine: 'Prompt Footprint: Compact. Keep compact unless a safety or hard continuity reason requires temporary expansion.',
    composerLine: 'Prompt Footprint: Compact. Prefer the smallest useful hand and terse packet sections.'
  }),
  normal: Object.freeze({
    level: 'normal',
    allowedProfiles: Object.freeze(['compact', 'normal']),
    preferredProfile: 'normal',
    maxCardsTarget: 6,
    maxCardsCeiling: 6,
    arbiterLine: 'Prompt Footprint: Normal. Compact or Normal are allowed freely; Rich requires a high-risk reason.',
    composerLine: 'Prompt Footprint: Normal. Use balanced packet detail and omit lower-priority repetition.'
  }),
  rich: Object.freeze({
    level: 'rich',
    allowedProfiles: Object.freeze(['compact', 'normal', 'rich']),
    preferredProfile: 'rich',
    maxCardsTarget: 9,
    maxCardsCeiling: 10,
    arbiterLine: 'Prompt Footprint: Rich. Use Rich when useful, but still permit Normal or Compact for simple turns.',
    composerLine: 'Prompt Footprint: Rich. Use more scene and turn detail when relevant, without becoming broad lore recap or distant-story planning.'
  })
});
```

Add:

```js
function footprintPolicyFor(level) {
  return FOOTPRINT_POLICIES[level] || FOOTPRINT_POLICIES.normal;
}

function normalizedFootprintLevel(value, fallback = 'normal') {
  const level = String(value || '').trim();
  return Object.prototype.hasOwnProperty.call(FOOTPRINT_POLICIES, level) ? level : fallback;
}

export function runPolicyForEffectivePlan(settings = {}, plan = {}) {
  const base = influencePolicyForSettings(settings);
  const storedLevel = normalizedFootprintLevel(base.footprint.level, 'normal');
  const effectiveLevel = normalizedFootprintLevel(plan?.promptFootprint, storedLevel);
  const effectivePolicy = footprintPolicyFor(effectiveLevel);
  const overrideReason = Array.isArray(plan?.diagnostics)
    ? plan.diagnostics.find((entry) => /^footprint-|^behavior-footprint/.test(String(entry || ''))) || ''
    : '';
  return {
    ...base,
    footprint: {
      ...base.footprint,
      level: storedLevel,
      effectiveLevel,
      effectivePolicy: clone(effectivePolicy),
      sectionBudgets: { ...FOOTPRINT_SECTION_BUDGETS[effectiveLevel] },
      maxCardsTarget: effectivePolicy.maxCardsTarget,
      maxCardsCeiling: effectivePolicy.maxCardsCeiling,
      composerLine: effectivePolicy.composerLine,
      footprintOverrideReason: overrideReason
    }
  };
}
```

- [ ] **Step 4: Update composer and diagnostics helpers**

In `behaviorComposerLines(policy)`, use effective footprint composer line through existing `source.footprint?.composerLine`. In `summarizeBehaviorPolicyForDiagnostics()`, change footprint fields:

```js
storedFootprint: source.footprint?.level || 'normal',
effectiveFootprint: String(context.effectiveFootprint || source.footprint?.effectiveLevel || source.footprint?.level || 'normal'),
footprintOverrideReason: String(context.footprintOverrideReason || source.footprint?.footprintOverrideReason || ''),
```

- [ ] **Step 5: Thread run policy through runtime**

In `src/runtime.mjs`, update import:

```js
import { behaviorPolicyPromptLines, influencePolicyForSettings, runPolicyForEffectivePlan } from './settings-policy.mjs';
```

Replace:

```js
const behaviorPolicy = influencePolicyForSettings(effectiveSettings);
```

with:

```js
const behaviorPolicy = runPolicyForEffectivePlan(settings, plan);
```

Keep `effectiveSettings` for `settingsForPlan(settings, plan)` because Reasoner eligibility and packet footprint still need the effective run settings.

- [ ] **Step 6: Fix runtime footprint tests**

In `tools/scripts/test-runtime.mjs`, update the compact stored footprint scenario that currently expects Arbiter rich to survive without high-risk evidence.

Use these expectations for the non-risk case:

```js
assertEqual(view.lastPlan.promptFootprint, 'compact', 'compact stored footprint clamps non-risk rich Arbiter request');
assertEqual(view.lastPacket.footprint, 'compact', 'last packet stays compact after non-risk rich Arbiter request');
assert(!routerCalls.includes('reasonerComposer'), 'non-risk rich Arbiter request does not invoke Reasoner after compact clamp');
assertEqual(view.lastPacket.diagnostics.behaviorPolicy.storedFootprint, 'compact', 'diagnostics preserve stored compact footprint');
assertEqual(view.lastPacket.diagnostics.behaviorPolicy.effectiveFootprint, 'compact', 'diagnostics record compact effective footprint');
```

Add a separate high-risk override scenario:

```js
{
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: healthyReasonerSettings({ mode: 'auto', promptFootprint: 'compact', reasonerUse: 'auto' }),
    generationRouter: {
      async generate(roleId, request = {}) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              promptFootprint: 'rich',
              reasonerDecision: { mode: 'use', reason: 'high-risk continuity contradiction needs synthesis', signals: ['continuity-risk'] },
              budgets: { targetBriefTokens: 900, maxCards: 9 },
              diagnostics: ['footprint-risk-override']
            }
          };
        }
        if (roleId === 'reasonerComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.reasonerComposer.v1',
              snapshotHash: parseReasonerPromptSnapshotHash(request.prompt),
              instructionPatch: 'Use richer synthesis only for the high-risk continuity conflict.',
              keptCardIds: [],
              droppedCardIds: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Resolve the continuity contradiction.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'high-risk footprint override installs');
  assertEqual(view.lastPlan.promptFootprint, 'rich', 'high-risk Arbiter request can temporarily use rich footprint');
  assertEqual(view.lastPacket.footprint, 'rich', 'packet uses effective rich footprint for high-risk override');
  assert(routerCalls.includes('reasonerComposer'), 'high-risk rich override can invoke Reasoner');
  assertEqual(view.lastPacket.diagnostics.behaviorPolicy.storedFootprint, 'compact', 'diagnostics preserve stored compact footprint during override');
  assertEqual(view.lastPacket.diagnostics.behaviorPolicy.effectiveFootprint, 'rich', 'diagnostics record effective rich footprint during override');
}
```

- [ ] **Step 7: Update docs**

In `docs/architecture/RUNTIME_ARCHITECTURE.md`, replace old wording that says any valid Arbiter footprint overrides current turn. Use:

```markdown
`promptFootprint` is sanitized to `compact`, `normal`, or `rich`, then resolved through the user's stored Prompt Footprint policy. Compact may expand only for safety or hard-continuity evidence, Normal may use Rich only for high-risk evidence, and Rich may still choose smaller effective packets for simple turns. The effective footprint applies only to this run and never mutates stored settings.
```

In `docs/architecture/PROMPT_COMPOSITION_SPEC.md` and `docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md`, make sure examples distinguish `storedFootprint` from `effectiveFootprint`.

- [ ] **Step 8: Verify task**

Run:

```powershell
node tools/scripts/test-settings-policy.mjs
npm.cmd run test:prompt
npm.cmd run test:runtime
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/settings-policy.mjs src/runtime.mjs src/prompt.mjs tools/scripts/test-settings-policy.mjs tools/scripts/test-runtime.mjs tools/scripts/test-prompt.mjs docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md docs/architecture/RUNTIME_ARCHITECTURE.md docs/architecture/PROMPT_COMPOSITION_SPEC.md
git commit -m "fix: align behavior policy footprint flow"
```

## Task 4: Make Arbiter Card Lifecycle And Refresh Intent Explicit

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `src/cards.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-cards.mjs`
- Modify: `docs/design/CARD_SYSTEM_SPEC.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`

- [ ] **Step 1: Write failing Arbiter prompt contract test**

In the runtime test that captures `arbiterPrompts`, add:

```js
assert(
  arbiterPrompts[0].includes('Card job contract:'),
  'Arbiter prompt includes card job contract'
);
assert(
  arbiterPrompts[0].includes('To create or refresh a card, emit a cardJobs entry.'),
  'Arbiter prompt explains create/refresh card job requirement'
);
assert(
  arbiterPrompts[0].includes('Lifecycle regenerate marks an old cached card stale; it does not create a replacement without cardJobs.'),
  'Arbiter prompt explains regenerate without replacement behavior'
);
```

- [ ] **Step 2: Write failing refresh metadata test**

In `tools/scripts/test-cards.mjs`, add:

```js
const refreshRequest = buildCardRequests({
  cardJobs: [{
    family: 'Continuity Risk',
    role: 'continuityRiskCard',
    refreshOfCardId: 'cached-risk-1',
    reason: 'Cached risk is stale after source drift.'
  }]
}, {
  runId: 'refresh-run',
  snapshotHash: 'refresh-hash',
  snapshot: {}
})[0];
assertEqual(refreshRequest.metadata.refreshOfCardId, 'cached-risk-1', 'refresh request metadata preserves safe old card id');
assert(refreshRequest.prompt.includes('Refreshes cached card: cached-risk-1'), 'refresh request prompt tells provider this replaces stale cached card');
assert(!refreshRequest.prompt.includes('promptText'), 'refresh request does not expose old card prompt text by id');
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
npm.cmd run test:cards
npm.cmd run test:runtime
```

Expected: FAIL because current Arbiter prompt lacks explicit job/lifecycle contract and `refreshOfCardId` is not preserved.

- [ ] **Step 4: Preserve refresh metadata in card jobs**

In `src/runtime.mjs`, update `normalizePlanCardJobs(value)` to preserve safe refresh ids:

```js
refreshOfCardId: safeIdentifier(source.refreshOfCardId ?? source.replacesCardId ?? '', '', 160)
```

Keep existing `family`, `role`, and `reason` fields unchanged. Empty `refreshOfCardId` should be omitted from the normalized job.

- [ ] **Step 5: Add Arbiter prompt contract block**

Add this helper in `src/runtime.mjs` near `cardScopePolicyLine()`:

```js
function arbiterCardJobContractLine() {
  return [
    'Card job contract:',
    '- To create or refresh a card, emit a cardJobs entry with family or role.',
    '- For refreshes, include refreshOfCardId when replacing a cached card.',
    '- Use lifecycle actions only for cached or accepted card ids: select, emphasize, stow, discard, regenerate.',
    '- Lifecycle regenerate marks an old cached card stale; it does not create a replacement without cardJobs.',
    '- Do not include raw prompt text, hidden reasoning, provider endpoints, or host prompt instructions in plan fields.'
  ].join('\n');
}
```

Insert `arbiterCardJobContractLine()` in the Arbiter prompt after `cardScopePolicyLine(cardScope)`.

- [ ] **Step 6: Preserve refresh metadata in card requests**

In `src/cards.mjs`, add:

```js
const refreshOfCardId = cleanProviderPromptText(source.refreshOfCardId ?? source.replacesCardId ?? '', 160);
```

Add this prompt line after `cardScopePromptBlock(...)`:

```js
refreshOfCardId ? `Refreshes cached card: ${refreshOfCardId}` : '',
```

Add this metadata field:

```js
...(refreshOfCardId ? { refreshOfCardId } : {})
```

- [ ] **Step 7: Add lifecycle transition test**

In `tools/scripts/test-cards.mjs`, add a direct `applyCardPlan()` assertion:

```js
const refreshedDeck = applyCardPlan([
  deckCard('Continuity Risk', 'Old risk.', { id: 'cached-risk-1', tokenEstimate: 10 })
], {
  acceptedCards: [
    deckCard('Continuity Risk', 'New risk.', { id: 'fresh-risk-1', tokenEstimate: 10 })
  ],
  lifecycle: [
    { action: 'regenerate', cardId: 'cached-risk-1', reason: 'source drift' },
    { action: 'select', cardId: 'fresh-risk-1', reason: 'fresh replacement' }
  ]
});
assertEqual(refreshedDeck.cards.find((card) => card.id === 'cached-risk-1').status, 'stale', 'regenerate marks old cached card stale');
assertEqual(refreshedDeck.cards.find((card) => card.id === 'fresh-risk-1').status, 'active', 'fresh replacement remains active');
```

- [ ] **Step 8: Update docs**

In `docs/design/CARD_SYSTEM_SPEC.md` and `docs/technical/RUNTIME_TURN_SEQUENCE.md`, add:

```markdown
Refresh is a two-part contract. The Arbiter requests new work through `cardJobs`, optionally naming `refreshOfCardId` for the cached card being replaced. Lifecycle `regenerate` marks the old cached card stale; by itself it does not create a replacement card. This keeps generation work explicit and prevents runtime from inventing semantic refreshes.
```

- [ ] **Step 9: Verify task**

Run:

```powershell
npm.cmd run test:cards
npm.cmd run test:runtime
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/runtime.mjs src/cards.mjs tools/scripts/test-runtime.mjs tools/scripts/test-cards.mjs docs/design/CARD_SYSTEM_SPEC.md docs/technical/RUNTIME_TURN_SEQUENCE.md
git commit -m "fix: clarify arbiter refresh contract"
```

## Task 5: Align Card Scope Hover Help With Canonical Facets

**Files:**
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `docs/design/UI_SPEC.md`

- [ ] **Step 1: Write failing UI tooltip test**

In `tools/scripts/test-ui.mjs`, after opening the Cards panel, add:

```js
const proseDensity = root.querySelectorAll('[data-recursion-card-scope-sub-item-toggle]')
  .find((node) => node.dataset.recursionCardScopeFamilyName === 'Prose'
    && node.dataset.recursionCardScopeSubItem === 'density');
assert(proseDensity, 'Prose density sub-item exists');
assert(
  proseDensity.getAttribute('title').includes('How packed the next response should be'),
  'density tooltip explains actual Prose density focus'
);
assert(
  proseDensity.getAttribute('title').includes('action, dialogue, description, and consequence'),
  'density tooltip explains why density matters'
);
```

- [ ] **Step 2: Run failing UI test**

Run: `npm.cmd run test:ui`

Expected: FAIL because current tooltip is only `density`.

- [ ] **Step 3: Use sub-item descriptions in `src/ui.mjs`**

In `renderCardsPanel()`, replace:

```js
...tooltipAttrs(model.tooltipsEnabled, lastSelected ? 'Keep at least one card focus enabled.' : item.label)
```

with:

```js
...tooltipAttrs(model.tooltipsEnabled, lastSelected
  ? 'Keep at least one card focus enabled.'
  : `${item.label}: ${item.description}`)
```

- [ ] **Step 4: Update UI spec**

In `docs/design/UI_SPEC.md`, update Card Scope tooltip guidance:

```markdown
Card scope family rows use the family description as hover/focus help. Sub-item rows use the canonical sub-item label and description from `src/card-scope.mjs`; they must explain what the focus asks Recursion to emphasize, not repeat the raw label.
```

- [ ] **Step 5: Verify task**

Run: `npm.cmd run test:ui`

Expected: PASS with `[pass] ui`.

- [ ] **Step 6: Commit**

```bash
git add src/ui.mjs tools/scripts/test-ui.mjs docs/design/UI_SPEC.md
git commit -m "fix: explain card scope hover help"
```

## Task 6: Final Contract Sweep And Gates

**Files:**
- Modify docs listed in earlier tasks only when searches find stale contract language.

- [ ] **Step 1: Search for stale or contradictory wording**

Run:

```powershell
rg -n "selected sub-item focus|Sub-items guide|valid Arbiter footprint|broader Strength/Focus behavior policy remains a target|regenerate without|density\"\\)" src docs tools
```

Expected: any results are current wording or tests. No doc should say sub-items are only metadata. No doc should say any valid Arbiter footprint always overrides stored footprint. No doc should imply lifecycle `regenerate` creates a card without a `cardJobs` entry.

- [ ] **Step 2: Run focused tests**

Run:

```powershell
node tools/scripts/test-card-scope.mjs
node tools/scripts/test-settings-policy.mjs
npm.cmd run test:cards
npm.cmd run test:prompt
npm.cmd run test:runtime
npm.cmd run test:ui
```

Expected: all PASS.

- [ ] **Step 3: Run repo gate**

Run:

```powershell
npm.cmd test
node tools/scripts/run-alpha-gate.mjs
```

Expected: both PASS. If `npm.cmd test` fails before runtime due an unrelated currently dirty test, capture exact failing script and fix it only if it contradicts this plan's contracts.

- [ ] **Step 4: Record live-proof boundary**

If deterministic gates pass but live SillyTavern is not configured, do not claim live proof. Add this note to the implementation summary:

```text
Deterministic Arbiter/card/prompt/UI contracts pass. Live SillyTavern proof still requires configured SILLYTAVERN_BASE_URL and a dedicated recursion-soak-* user.
```

- [ ] **Step 5: Commit final docs/test alignment**

```bash
git add docs src tools
git commit -m "test: lock arbiter card prompt contracts"
```

## Self-Review

Spec coverage:

- Sub-item tooltip issue: covered by Tasks 1, 2, and 5.
- Arbiter must select cards and decide cache/new/regenerate: covered by Tasks 3 and 4.
- Card prompts must properly reflect selected card focus: covered by Task 2.
- Behavior policy and footprint drift: covered by Task 3.
- Robust verification: covered by Task 6.

Placeholder scan:

- No `TBD`, `TODO`, `fill in`, or open-ended implementation steps remain in this plan.
- Every code-changing task includes the target file, failing test, implementation shape, verification command, and commit command.

Type consistency:

- `selectedSubItemsByFamily` remains the settings/scope payload map.
- `selectedSubItems` remains per-card request metadata.
- `description` is added to each sub-item object.
- `refreshOfCardId` is the canonical refresh job field; `replacesCardId` may be accepted as input alias but should normalize to `refreshOfCardId`.
- `storedFootprint` and `effectiveFootprint` are diagnostics fields; `footprint.level` stores user baseline and `footprint.effectiveLevel` stores run-level footprint.

## Execution Handoff

Plan complete. Recommended implementation path: use `superpowers:subagent-driven-development`, one subagent per task, with main-thread review after each task. Inline execution is viable because files are already localized, but runtime tests are long enough that task-level checkpoints are safer.
