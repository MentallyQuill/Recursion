# Recursion Card Cost And Instruction Contract Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Recursion from paying for card generations that cannot reach the prompt, make generated card evidence instruction-shaped instead of prose-shaped, and persist guidance validation failures clearly.

**Architecture:** Runtime will enforce the effective hand budget before card provider calls, then hand selection becomes confirmation rather than a late discard pass. Card generation keeps the existing `promptText` field name but changes the V1 contract in place: `promptText` must contain compact instruction or constraint evidence lines, not narrative paragraphs. Prompt diagnostics and run journals will separate provider transport success from Recursion packet-validation success.

**Tech Stack:** JavaScript ES modules, SillyTavern extension host adapter, Recursion provider router, Node-based deterministic tests under `tools/scripts`, markdown docs.

---

## Investigation Findings

These findings came from `default-user`, chat `World - 2026-02-12@18h43m17s180ms`, latest run on 2026-07-04.

- Persisted settings were Auto, Standard pipeline, Strong strength, Medium reasoning, Rich footprint, `minCards=5`, `maxCards=12`.
- The run journal recorded 11 card provider calls, all successful: Scene Frame, Active Cast, Character Motivation, Relationship, Social Subtext, Scene Constraints, Knowledge, Consequences, Environment, Items, and Open Threads.
- The same run selected 6 prompt-hand cards and omitted 5 cards with reason `max-cards`.
- The selected prompt hand was Scene Frame, Scene Constraints, Active Cast, Knowledge, Consequences, and Character Motivation.
- The pasted prompt evidence matched those 6 selected cards, so the expensive waste happened before prompt installation.
- The selected card text was prompt-facing prose. The provider was asked for `promptText`, but the contract did not require terse instructions.
- The prompt showed `Guidance unavailable` while the journal showed `guidanceComposer success`; provider-call success did not mean the guidance result survived Recursion validation.

## File Structure

- Modify `src/cards.mjs`: add a reusable card-job budget helper; tighten card prompt text validation; update standard and fused card provider prompts to demand instruction-shaped card text.
- Modify `src/runtime.mjs`: apply card-job budgeting after plan shaping and scope reconciliation but before `generatePlanCards(...)`; include guidance validation status in persisted journal details.
- Modify `src/prompt.mjs`: render multi-line instruction card evidence cleanly and keep fallback diagnostics precise.
- Modify `tools/scripts/test-cards.mjs`: cover card-job budgeting, card prompt contract text, narrative rejection, and fused prompt contract text.
- Modify `tools/scripts/test-runtime.mjs`: cover the exact cost failure shape, Standard runtime pre-generation budgeting, Rapid warm pre-generation budgeting, and persisted guidance fallback diagnostics.
- Modify `tools/scripts/test-prompt.mjs`: update card evidence fixtures to instruction-shaped text and cover multi-line card evidence rendering.
- Modify docs: `docs/design/CARD_SYSTEM_SPEC.md`, `docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md`, `docs/technical/CARD_DECK_AND_HAND.md`, `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`, `docs/technical/PROMPT_PACKET_AND_INJECTION.md`, `docs/technical/RUNTIME_TURN_SEQUENCE.md`, `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, `docs/architecture/PROMPT_COMPOSITION_SPEC.md`, `docs/testing/TESTING_STRATEGY.md`, and `docs/user/RECURSION_OPERATOR_MANUAL.md`.

## Contract Decisions

- `cardJobs.length` must not exceed the effective prompt-hand budget after runtime policy and Manual forced-family floors are applied.
- Runtime still sends the budget into the Arbiter prompt, but runtime enforces it even when the Arbiter over-requests.
- Auto mode trims over-budget card jobs by the same family priority/focus ordering used by hand selection.
- Manual mode keeps forced selected families first and floors the generated-job budget to the forced-family count.
- Generated card `promptText` is still the prompt-facing field, but it must be instruction-shaped: short imperative or compact constraint lines that guide the next assistant message.
- Card evidence remains hidden from the final assistant output. The final model sees instructions as private evidence and must not mention Recursion labels.
- Provider-call journals continue to record transport/schema success. Prompt install or hand-selected journals record whether guidance was actually used or fell back.

## Task 1: Card-Job Budget Helper

**Files:**
- Modify: `src/cards.mjs`
- Modify: `tools/scripts/test-cards.mjs`

- [ ] **Step 1: Write the failing card-job budget test**

Update the import block in `tools/scripts/test-cards.mjs`:

```js
import {
  CARD_CATALOG,
  applyCardPlan,
  buildCardRequests,
  buildFusedCardBundleRequest,
  cardsFromFusedProviderResult,
  cardsFromProviderResult,
  limitCardJobsForHandBudget,
  normalizeCard,
  selectHand
} from '../../src/cards.mjs';
```

Add this test after the catalog assertions:

```js
const allCatalogCardJobs = CARD_CATALOG.map((entry) => ({
  family: entry.family,
  role: entry.role,
  reason: `Generate ${entry.family}.`
}));

const mediumBudgetedJobs = limitCardJobsForHandBudget(allCatalogCardJobs, {
  maxCards: 6,
  behaviorPolicy: influencePolicyForSettings({
    strength: 'strong',
    focus: 'balanced',
    minCards: 5,
    maxCards: 12,
    promptFootprint: 'rich'
  })
});

assertDeepEqual(
  mediumBudgetedJobs.cardJobs.map((job) => job.family),
  ['Scene Frame', 'Scene Constraints', 'Active Cast', 'Knowledge', 'Consequences', 'Character Motivation'],
  'card job budget keeps the same families the hand selector would keep'
);
assertEqual(mediumBudgetedJobs.omitted.length, 5, 'over-budget card jobs are omitted before provider calls');
assert(mediumBudgetedJobs.omitted.every((entry) => entry.reason === 'max-cards'), 'card-job omissions use max-cards reason');
assertEqual(mediumBudgetedJobs.metadata.requestedCount, 11, 'budget metadata records requested job count');
assertEqual(mediumBudgetedJobs.metadata.keptCount, 6, 'budget metadata records kept job count');
assertEqual(mediumBudgetedJobs.metadata.maxCards, 6, 'budget metadata records effective max cards');

const forcedBudgetedJobs = limitCardJobsForHandBudget(allCatalogCardJobs, {
  maxCards: 1,
  forcedFamilies: ['Relationship', 'Open Threads'],
  behaviorPolicy: influencePolicyForSettings({ focus: 'balanced' })
});
assertDeepEqual(
  forcedBudgetedJobs.cardJobs.map((job) => job.family),
  ['Relationship', 'Open Threads'],
  'forced families floor the card job budget before provider calls'
);
```

- [ ] **Step 2: Run the failing card test**

Run:

```powershell
node tools\scripts\test-cards.mjs
```

Expected: FAIL with an import error or function-not-exported error for `limitCardJobsForHandBudget`.

- [ ] **Step 3: Implement `limitCardJobsForHandBudget(...)`**

In `src/cards.mjs`, add this helper after `effectiveMaxCardsForPolicy(...)`:

```js
function plannedCardForJob(job) {
  const source = asObject(job);
  const catalog = resolveCatalog({
    family: source.family,
    role: source.role ?? source.roleId
  }, { strict: false });
  if (!catalog) return null;
  return {
    job: {
      ...source,
      family: catalog.family,
      role: catalog.role
    },
    family: catalog.family,
    role: catalog.role,
    emphasis: validEnum(source.emphasis, EMPHASIS, 'normal'),
    tokenEstimate: numberInRange(source.tokenEstimate ?? source.tokenCost, estimateTokens(source.reason || catalog.description), 1, MAX_TOKEN_ESTIMATE),
    id: source.id || `planned-${safeId(catalog.family)}`
  };
}

export function limitCardJobsForHandBudget(cardJobs = [], { maxCards = 6, behaviorPolicy = null, forcedFamilies = [] } = {}) {
  const policy = behaviorPolicyForHand(behaviorPolicy);
  const requestedCardLimit = numberInRange(maxCards, 6, 0, 64);
  const forcedOrder = forcedFamilyOrder(forcedFamilies);
  const cardLimit = Math.max(effectiveMaxCardsForPolicy(requestedCardLimit, policy), forcedOrder.size);
  const planned = (Array.isArray(cardJobs) ? cardJobs : [])
    .map((job, index) => {
      const card = plannedCardForJob(job);
      return card ? { ...card, index } : null;
    })
    .filter(Boolean);
  if (!planned.length || planned.length <= cardLimit) {
    return {
      cardJobs: planned.map((entry) => entry.job),
      omitted: [],
      metadata: {
        maxCards: cardLimit,
        requestedMaxCards: requestedCardLimit,
        requestedCount: planned.length,
        keptCount: planned.length,
        omittedCount: 0
      }
    };
  }
  const sorted = planned.slice().sort((a, b) => {
    const aForced = forcedOrder.has(a.family);
    const bForced = forcedOrder.has(b.family);
    if (aForced !== bForced) return aForced ? -1 : 1;
    if (aForced && bForced) return forcedOrder.get(a.family) - forcedOrder.get(b.family);
    return sortCardsForHand(a, b, policy);
  });
  const keptIndexes = new Set(sorted.slice(0, cardLimit).map((entry) => entry.index));
  const kept = sorted.filter((entry) => keptIndexes.has(entry.index));
  const omitted = sorted.filter((entry) => !keptIndexes.has(entry.index));
  return {
    cardJobs: kept.map((entry) => entry.job),
    omitted: omitted.map((entry) => ({
      family: entry.family,
      role: entry.role,
      reason: 'max-cards',
      tokenEstimate: entry.tokenEstimate
    })),
    metadata: {
      maxCards: cardLimit,
      requestedMaxCards: requestedCardLimit,
      requestedCount: planned.length,
      keptCount: kept.length,
      omittedCount: omitted.length,
      forcedFamilies: [...forcedOrder.keys()]
    }
  };
}
```

- [ ] **Step 4: Run the card test**

Run:

```powershell
node tools\scripts\test-cards.mjs
```

Expected: PASS with `[pass] cards`.

- [ ] **Step 5: Commit**

```bash
git add src/cards.mjs tools/scripts/test-cards.mjs
git commit -m "fix: budget card jobs before generation"
```

## Task 2: Runtime Pre-Generation Budgeting

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Write the failing Standard runtime cost test**

Update the `src/cards.mjs` import in `src/runtime.mjs` only after implementation. First add this test to `tools/scripts/test-runtime.mjs` near the existing all-generated-card test:

```js
{
  const requestedFamilies = CARD_CATALOG.map((entry) => entry.family);
  const generatedRoles = [];
  const guidancePrompts = [];
  const { runtime } = createRuntimeHarness({
    settings: {
      mode: 'auto',
      pipelineMode: 'standard',
      reasoningLevel: 'medium',
      reasonerUse: 'off',
      strength: 'strong',
      promptFootprint: 'rich',
      minCards: 5,
      maxCards: 12
    },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'rich',
              cardJobs: CARD_CATALOG.map((entry) => ({
                family: entry.family,
                role: entry.role,
                reason: `Generate ${entry.family}.`
              })),
              reasonerDecision: { mode: 'skip', reason: 'cost regression fixture', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              diagnostics: ['cost-regression-fixture']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          guidancePrompts.push(request.prompt);
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Keep the selected cards only.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['guidance-ok']
            }
          };
        }
        generatedRoles.push(roleId);
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: `Keep ${request.metadata.family} active for this turn; preserve only evidence-backed constraints.`,
              evidenceRefs: ['message:2'],
              tokenEstimate: 140
            }]
          }
        };
      },
      async batch(requests) {
        return Promise.all(requests.map((request) => this.generate(request.roleId, request)));
      }
    }
  });

  const result = await runtime.prepareForGeneration({ userMessage: 'Cost regression turn.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'cost regression run installs prompt');
  assertEqual(generatedRoles.length, 6, 'runtime does not call providers for card jobs beyond the hand budget');
  assertDeepEqual(
    view.lastHand.cards.map((card) => card.family),
    ['Scene Frame', 'Scene Constraints', 'Active Cast', 'Knowledge', 'Consequences', 'Character Motivation'],
    'runtime hand uses the budgeted high-priority generated families'
  );
  assertEqual(view.lastHand.omitted.filter((entry) => entry.reason === 'max-cards').length, 0, 'ungenerated over-budget cards are not later omitted from the hand');
  assert(view.lastPlan.diagnostics.includes('card-jobs-budgeted'), 'runtime records card job budgeting diagnostic');
  assert(guidancePrompts[0].includes('Character Motivation'), 'guidance sees the last kept selected family');
  for (const family of requestedFamilies.slice(6)) {
    assert(!guidancePrompts[0].includes(`Keep ${family} active`), `${family} was not generated for discarded evidence`);
  }
}
```

- [ ] **Step 2: Write the failing Rapid warm cost test**

Add this test near the existing Rapid warm tests:

```js
{
  const generatedRoles = [];
  const harness = createRuntimeHarness({
    settings: {
      mode: 'auto',
      pipelineMode: 'rapid',
      reasoningLevel: 'medium',
      reasonerUse: 'off',
      strength: 'strong',
      promptFootprint: 'rich',
      minCards: 5,
      maxCards: 12
    },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              sceneStatus: 'same-scene',
              promptFootprint: 'rich',
              cardJobs: CARD_CATALOG.map((entry) => ({
                family: entry.family,
                role: entry.role,
                reason: `Warm ${entry.family}.`
              })),
              reasonerDecision: { mode: 'skip', reason: 'rapid cost regression fixture', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 6 },
              diagnostics: ['rapid-cost-regression-fixture']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Keep the Rapid warm selected cards only.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['rapid-guidance-ok']
            }
          };
        }
        generatedRoles.push(roleId);
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: `Keep ${request.metadata.family} available for the Rapid warm packet.`,
              evidenceRefs: ['message:2'],
              tokenEstimate: 140
            }]
          }
        };
      },
      async batch(requests) {
        return Promise.all(requests.map((request) => this.generate(request.roleId, request)));
      }
    }
  });

  const warm = await harness.runtime.warmRapidScene({ reason: 'rapid-cost-regression' });
  assertEqual(warm.ok, true, 'Rapid cost regression warm succeeds');
  assertEqual(generatedRoles.length, 6, 'Rapid warm does not call providers for discarded card jobs');
  assertEqual(warm.hand.cards.length, 6, 'Rapid warm selected hand uses the budgeted card jobs');
  assert(warm.plan.diagnostics.includes('card-jobs-budgeted'), 'Rapid warm records card job budgeting diagnostic');
}
```

- [ ] **Step 3: Run the failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: FAIL because `generatedRoles.length` is 11 and the hand records max-card omissions.

- [ ] **Step 4: Import the helper**

In `src/runtime.mjs`, update the card import:

```js
import {
  CARD_CATALOG,
  applyCardPlan,
  buildCardRequests,
  limitCardJobsForHandBudget,
  normalizeCard,
  selectHand
} from './cards.mjs';
```

- [ ] **Step 5: Add runtime card-job budgeting helper**

Add this helper near `budgetOr(...)`:

```js
function budgetCardJobsForGeneration(plan, settings, behaviorPolicy, forcedFamilies = []) {
  const limited = limitCardJobsForHandBudget(plan?.cardJobs, {
    maxCards: budgetOr(plan?.budgets?.maxCards, 6),
    behaviorPolicy,
    forcedFamilies
  });
  if (!limited.omitted.length) {
    return {
      plan: {
        ...plan,
        cardJobs: limited.cardJobs
      },
      omitted: [],
      metadata: limited.metadata
    };
  }
  return {
    plan: {
      ...plan,
      cardJobs: limited.cardJobs,
      diagnostics: mergeDiagnostics(
        plan.diagnostics,
        ['card-jobs-budgeted'],
        limited.omitted.map((entry) => `card-job-budgeted:${entry.family}`)
      )
    },
    omitted: limited.omitted,
    metadata: limited.metadata
  };
}
```

- [ ] **Step 6: Apply budgeting in the Standard foreground path**

In `prepareForGeneration(...)`, after Manual reconciliation updates `plan` and before `lastPlan = plan`, add:

```js
const preGenerationBehaviorPolicy = runPolicyForEffectivePlan(settings, plan);
const cardJobBudget = budgetCardJobsForGeneration(plan, settings, preGenerationBehaviorPolicy, manualForcedFamilies);
plan = cardJobBudget.plan;
```

Keep the existing later `const behaviorPolicy = runPolicyForEffectivePlan(settings, plan);` so the final packet uses the final plan diagnostics.

- [ ] **Step 7: Apply budgeting in the Rapid warm path**

In `warmRapidSceneImpl(...)`, after Manual reconciliation updates `plan` and before `lastPlan = plan`, add the same budgeting block:

```js
const preGenerationBehaviorPolicy = runPolicyForEffectivePlan(settings, plan);
const cardJobBudget = budgetCardJobsForGeneration(plan, settings, preGenerationBehaviorPolicy, manualForcedFamilies);
plan = cardJobBudget.plan;
```

- [ ] **Step 8: Keep progress counts honest**

The existing `stageRuntimeActivity(...)` call for `cardBatchRunning` reads `plan.cardJobs?.length`. Confirm it executes after the budgeted `plan` assignment. If it does not, move that call below the budgeting block so the UI reports generated work, not Arbiter over-requested work.

- [ ] **Step 9: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: PASS with `[pass] runtime`.

- [ ] **Step 10: Commit**

```bash
git add src/runtime.mjs tools/scripts/test-runtime.mjs
git commit -m "fix: avoid discarded card generations"
```

## Task 3: Instruction-Shaped Card Text Contract

**Files:**
- Modify: `src/cards.mjs`
- Modify: `src/prompt.mjs`
- Modify: `tools/scripts/test-cards.mjs`
- Modify: `tools/scripts/test-prompt.mjs`

- [ ] **Step 1: Write failing card contract tests**

In `tools/scripts/test-cards.mjs`, change simple card fixtures from prose assertions to instruction-shaped text as they are touched. Add these assertions after the existing hidden-reasoning rejection tests:

```js
await assertRejects(
  async () => normalizeCard({
    family: 'Scene Frame',
    promptText: 'Jack Mercer had just landed at Capodichino Airport in Naples. The cargo hold smelled of hydraulic fluid. He was exhausted and unsure what came next.',
    evidenceRefs: ['message:10']
  }, { sceneId: 'scene-prose', snapshotHash: 'hash-prose' }),
  /instruction-shaped/,
  'narrative prose card text is rejected'
);

const instructionCard = normalizeCard({
  family: 'Scene Frame',
  promptText: 'Keep Jack at Capodichino immediately after landing.\nPreserve his exhaustion, weak cover, and lack of field readiness.\nDo not skip the sergeant response beat.',
  evidenceRefs: ['message:10', 'message:11']
}, { sceneId: 'scene-instruction', snapshotHash: 'hash-instruction' });
assert(instructionCard.promptText.includes('Preserve his exhaustion'), 'instruction-shaped card text is accepted');

const instructionRequest = buildCardRequests({
  cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Need current scene frame.' }]
}, {
  snapshotHash: 'hash-instruction-prompt',
  snapshot: { latestMesId: 11, messages: [{ mesid: 11, role: 'user', text: 'Yes Sergeant.', visible: true }] }
})[0];
assert(instructionRequest.prompt.includes('promptText must be instruction-shaped'), 'card request prompt states instruction contract');
assert(instructionRequest.prompt.includes('Do not write narrative prose'), 'card request prompt forbids prose cards');

const fusedInstructionRequest = buildFusedCardBundleRequest({
  cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Need current scene frame.' }]
}, {
  snapshotHash: 'hash-fused-instruction',
  snapshot: { latestMesId: 11, messages: [{ mesid: 11, role: 'user', text: 'Yes Sergeant.', visible: true }] }
});
assert(fusedInstructionRequest.prompt.includes('promptText must be instruction-shaped'), 'fused card request prompt states instruction contract');
```

- [ ] **Step 2: Update prompt evidence fixture expectations**

In `tools/scripts/test-prompt.mjs`, replace marker hand card text with instruction-shaped marker text:

```js
promptText: 'Keep SCENE_FRAME_MARKER full office pressure and escort boundary.\nPreserve the immediate escort beat without broad recap.',
```

Use the same pattern for each marker card:

```js
promptText: 'Keep ACTIVE_CAST_MARKER Dumbledore in authority and Hermione as guide.\nPreserve Rhya fatigue as visible state.',
promptText: 'Respect SCENE_CONSTRAINT_MARKER Rhya cannot leave until escorted.\nDo not reopen the one-time breach.',
promptText: 'Use SOCIAL_SUBTEXT_MARKER courtesy as protective control and veiled pressure.\nAvoid naming the subtext in final prose.',
promptText: 'Track OPEN_THREADS_MARKER the rest request and Gryffindor escort.\nDo not start a new distant thread.',
```

Add this assertion after the existing card evidence assertions:

```js
assert(packet.sections.cardEvidence.includes('\n  Preserve the immediate escort beat without broad recap.'), 'multi-line card instructions render as one card evidence block');
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
node tools\scripts\test-cards.mjs
node tools\scripts\test-prompt.mjs
```

Expected: `test-cards.mjs` FAILS because narrative card text is still accepted and provider prompts do not include the instruction contract. `test-prompt.mjs` may FAIL until multi-line evidence rendering is updated.

- [ ] **Step 4: Add instruction contract helpers**

In `src/cards.mjs`, add these constants near `CARD_FORBIDDEN_PATTERNS`:

```js
const CARD_INSTRUCTION_LINE_START_PATTERN = /^(Keep|Preserve|Respect|Use|Avoid|Do not|Track|Hold|Maintain|Show|Withhold|Reveal only|Ensure|Treat|Anchor|Continue)\b/i;
const CARD_NARRATIVE_PROSE_PATTERN = /\b(?:had|was|were|stood|walked|looked|felt|smelled|tasted|sounded|realized|remembered|thought)\b[\s\S]{80,}[.!?]\s+[A-Z]/i;
```

Add these helpers near `assertCardPromptTextSafe(...)`:

```js
function instructionLines(promptText) {
  return String(promptText || '')
    .split(/\n+|;\s+/)
    .map((line) => cleanText(line.replace(/^[-*]\s*/, ''), TEXT_LIMIT))
    .filter(Boolean);
}

function assertInstructionShapedCardText(promptText) {
  const lines = instructionLines(promptText);
  if (lines.length === 0) throw new Error('Card promptText must be instruction-shaped.');
  const instructionLineCount = lines.filter((line) => CARD_INSTRUCTION_LINE_START_PATTERN.test(line)).length;
  const proseLike = CARD_NARRATIVE_PROSE_PATTERN.test(lines.join(' '));
  if (proseLike && instructionLineCount === 0) {
    throw new Error('Card promptText must be instruction-shaped, not narrative prose.');
  }
}
```

Update `assertCardPromptTextSafe(...)`:

```js
function assertCardPromptTextSafe(catalog, promptText) {
  assertInstructionShapedCardText(promptText);
  for (const pattern of CARD_FORBIDDEN_PATTERNS) {
    if (pattern.test(promptText)) {
      throw new Error('Card promptText contains unsafe hidden-reasoning wording.');
    }
  }
  if (catalog.family !== 'Character Motivation') return;
  for (const pattern of CHARACTER_MOTIVATION_FORBIDDEN_PATTERNS) {
    if (pattern.test(promptText)) {
      throw new Error('Character Motivation promptText contains unsafe internal-thought wording.');
    }
  }
}
```

- [ ] **Step 5: Add provider prompt contract text**

In `src/cards.mjs`, add:

```js
function cardInstructionContractLine() {
  return [
    'promptText must be instruction-shaped private evidence for the next assistant message.',
    'Use 2-5 short lines. Start each line with an instruction verb such as Keep, Preserve, Respect, Use, Avoid, Do not, Track, Hold, Maintain, Show, Withhold, Reveal only, Ensure, Treat, Anchor, or Continue.',
    'Do not write narrative prose, sensory scene description, dialogue, mini-scenes, or recap paragraphs in promptText.',
    'Keep each line evidence-backed and immediately useful for the next response.'
  ].join('\n');
}
```

In `buildCardRequests(...)`, replace:

```js
'promptText is the only prompt-facing card text. inspectorNotes are private diagnostics for the Recursion inspector.',
```

with:

```js
'promptText is the only prompt-facing card text. inspectorNotes are private diagnostics for the Recursion inspector.',
cardInstructionContractLine(),
```

In `buildFusedCardBundleRequest(...)`, add `cardInstructionContractLine()` immediately after the existing `promptText is the only prompt-facing card text...` line.

- [ ] **Step 6: Render multi-line card evidence cleanly**

In `src/prompt.mjs`, replace `cardEvidenceLine(card)` with:

```js
function cardEvidenceLine(card) {
  const emphasis = card.emphasis === 'normal' ? '' : ` ${card.emphasis}`;
  const text = String(card.promptText || '').split(/\n+/).map((line) => safeText(line, MAX_CARD_TEXT)).filter(Boolean);
  if (text.length <= 1) return `- [${card.family || 'Card'}${emphasis}] ${text[0] || ''}`;
  return [
    `- [${card.family || 'Card'}${emphasis}] ${text[0]}`,
    ...text.slice(1).map((line) => `  ${line}`)
  ].join('\n');
}
```

- [ ] **Step 7: Update failing prose fixtures to instruction text**

Most compact one-sentence facts should continue to pass because they are constraint fragments. Update only fixtures that fail because they are multi-sentence prose. Use direct replacements such as:

```js
promptText: 'Mara appears guarded after the accusation.'
```

to:

```js
promptText: 'Preserve Mara guarded posture after the accusation.'
```

For marker strings, keep the marker token but start the line with an instruction verb.

- [ ] **Step 8: Run focused tests**

Run:

```powershell
node tools\scripts\test-cards.mjs
node tools\scripts\test-prompt.mjs
```

Expected: PASS with `[pass] cards` and `[pass] prompt`.

- [ ] **Step 9: Commit**

```bash
git add src/cards.mjs src/prompt.mjs tools/scripts/test-cards.mjs tools/scripts/test-prompt.mjs
git commit -m "fix: require instruction-shaped card evidence"
```

## Task 4: Runtime Guidance Validation Diagnostics

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-prompt.mjs`

- [ ] **Step 1: Add prompt-level fallback reason assertion**

In `tools/scripts/test-prompt.mjs`, add this block after the valid guidance packet test:

```js
const badGuidancePacket = await composePromptPacket({
  runId: 'bad-guidance-run',
  hand: markerHand({ omitted: [] }),
  snapshot,
  settings: { promptFootprint: 'normal', reasonerUse: 'off' },
  generationRouter: {
    async generate() {
      return {
        ok: true,
        data: {
          schema: 'recursion.guidanceComposer.v1',
          snapshotHash: 'wrong-snapshot',
          guidanceText: 'This should be rejected.',
          sourceCardIds: ['scene-card'],
          guardrailCardIds: [],
          omittedCardIds: [],
          diagnostics: ['wrong-snapshot']
        }
      };
    }
  }
});

assertEqual(badGuidancePacket.diagnostics.guidanceStatus, 'fallback-raw-only', 'invalid guidance falls back to raw card evidence');
assertEqual(badGuidancePacket.diagnostics.guidanceFallbackReason, 'snapshot-mismatch', 'invalid guidance records exact fallback reason');
assert(badGuidancePacket.sections.guidance.includes('Guidance unavailable'), 'fallback guidance text is visible in guidance section');
```

- [ ] **Step 2: Add runtime journal diagnostics test**

In `tools/scripts/test-runtime.mjs`, add this block near other journal assertions:

```js
{
  const { runtime, storage } = createRuntimeHarness({
    settings: { mode: 'auto', reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'refresh-cards',
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Need a card.' }],
              budgets: { targetBriefTokens: 500, maxCards: 1 },
              reasonerDecision: { mode: 'skip', reason: 'journal fallback test', signals: [] },
              diagnostics: ['journal-fallback-test']
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: 'wrong-snapshot',
              guidanceText: 'Rejected guidance.',
              sourceCardIds: [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: ['wrong-snapshot']
            }
          };
        }
        return {
          ok: true,
          roleId,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: 'Keep the scene frame anchored to the current user action.',
              evidenceRefs: ['message:2']
            }]
          }
        };
      }
    }
  });

  const result = await runtime.prepareForGeneration({ userMessage: 'Persist guidance fallback reason.' });
  const journal = await storage.loadRunJournal(runtime.view().lastSnapshot.chatKey);
  const handEntry = journal.entries.find((entry) => entry.event === 'hand.selected' && entry.runId === result.packet.diagnostics.runId);
  assertEqual(result.packet.diagnostics.guidanceStatus, 'fallback-raw-only', 'runtime packet records guidance fallback');
  assertEqual(handEntry.details.guidanceStatus, 'fallback-raw-only', 'hand journal records guidance fallback status');
  assertEqual(handEntry.details.guidanceFallbackReason, 'snapshot-mismatch', 'hand journal records guidance fallback reason');
}
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
node tools\scripts\test-prompt.mjs
node tools\scripts\test-runtime.mjs
```

Expected: `test-runtime.mjs` FAILS because `hand.selected` journal details do not include guidance status and fallback reason.

- [ ] **Step 4: Persist guidance diagnostics in `appendHandSelectedJournal(...)`**

In `src/runtime.mjs`, inside `appendHandSelectedJournal(...)`, add:

```js
const packetDiagnostics = asObject(packet?.diagnostics);
```

Add these fields to `details`:

```js
guidanceStatus: safeText(packetDiagnostics.guidanceStatus || '', 80),
guidanceFallbackReason: safeText(packetDiagnostics.guidanceFallbackReason || '', 180),
guidanceInvalidSourceIdCount: Math.max(0, Math.round(numberOr(packetDiagnostics.guidanceInvalidSourceIdCount, 0))),
guidanceSourceCardCount: Array.isArray(packetDiagnostics.guidanceSourceCardIds)
  ? packetDiagnostics.guidanceSourceCardIds.length
  : 0,
guidanceGuardrailCardCount: Array.isArray(packetDiagnostics.guidanceGuardrailCardIds)
  ? packetDiagnostics.guidanceGuardrailCardIds.length
  : 0,
guidanceOmittedCardCount: Array.isArray(packetDiagnostics.guidanceOmittedCardIds)
  ? packetDiagnostics.guidanceOmittedCardIds.length
  : 0,
```

Keep raw guidance text, provider responses, and card prompt text out of the journal.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node tools\scripts\test-prompt.mjs
node tools\scripts\test-runtime.mjs
```

Expected: PASS with `[pass] prompt` and `[pass] runtime`.

- [ ] **Step 6: Commit**

```bash
git add src/runtime.mjs tools/scripts/test-runtime.mjs tools/scripts/test-prompt.mjs
git commit -m "fix: persist guidance fallback diagnostics"
```

## Task 5: Documentation Contract Update

**Files:**
- Modify: `docs/design/CARD_SYSTEM_SPEC.md`
- Modify: `docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md`
- Modify: `docs/technical/CARD_DECK_AND_HAND.md`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- Modify: `docs/technical/PROMPT_PACKET_AND_INJECTION.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/architecture/PROMPT_COMPOSITION_SPEC.md`
- Modify: `docs/testing/TESTING_STRATEGY.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`

- [ ] **Step 1: Document card-job budget enforcement**

In `docs/technical/RUNTIME_TURN_SEQUENCE.md`, update the card-generation sequence to state:

```markdown
After the Arbiter plan is normalized, scoped, and shaped by Reasoning Level plus behavior policy, runtime budgets `cardJobs` before any provider card calls. Over-budget card jobs are recorded as `card-jobs-budgeted` diagnostics and are not sent to Utility or Reasoner. Final hand selection should not normally omit fresh generated cards for `max-cards`; that reason indicates cache/manual/fallback competition, not routine provider over-generation.
```

In `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, add:

```markdown
The provider router only receives card jobs that can fit the effective hand budget. The Arbiter is instructed not to emit more `cardJobs` than `budgets.maxCards`, but runtime enforces this mechanically before provider calls because provider calls are the expensive boundary.
```

- [ ] **Step 2: Document instruction-shaped card text**

In `docs/design/CARD_SYSTEM_SPEC.md` and `docs/technical/CARD_DECK_AND_HAND.md`, add:

```markdown
`promptText` is instruction-shaped private evidence, not story prose. A generated card should contain short lines such as `Keep Jack at Capodichino immediately after landing`, `Preserve his weak cover and lack of field readiness`, and `Do not skip the sergeant response beat`. It must not contain mini-scenes, dialogue, sensory recap paragraphs, or decorative narration.
```

In `docs/technical/PROMPT_PACKET_AND_INJECTION.md`, add:

```markdown
The Card Evidence section serializes selected instruction-shaped card text verbatim, preserving line breaks under each card label. It does not rewrite cards into prose and it does not expose card labels as final-response content.
```

- [ ] **Step 3: Document guidance validation diagnostics**

In `docs/technical/PROMPT_PACKET_AND_INJECTION.md`, add:

```markdown
`guidanceComposer` provider-call success means the provider returned a response; it does not by itself mean Recursion used that response. Packet diagnostics expose `guidanceStatus` and `guidanceFallbackReason`. The run journal repeats those compact fields on `hand.selected` so operators can distinguish transport success from packet-validation fallback.
```

In `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`, add:

```markdown
Run journals record provider-call start/completion at the provider boundary. Prompt packet diagnostics record whether provider-authored guidance passed Recursion validation. A `guidanceComposer success` entry followed by `guidanceStatus: fallback-raw-only` means the model call completed but the guidance payload was rejected by schema, snapshot, source-id, hidden-reasoning, or empty-text validation.
```

- [ ] **Step 4: Update user-facing copy**

In `docs/user/RECURSION_OPERATOR_MANUAL.md`, update the Behavior Controls section:

```markdown
Max Cards controls the maximum selected-card hand. Recursion also uses it to avoid unnecessary card model calls: if the Arbiter asks for more card jobs than the effective hand can use, Recursion trims those jobs before generation and records a compact diagnostic.
```

Add a short card evidence note:

```markdown
Cards shown in Last Brief are operational instructions, not draft prose. They should read like private constraints and anchors for the next response. If a card reads like a mini-scene, that is a provider-contract failure rather than the intended card format.
```

- [ ] **Step 5: Run documentation checks**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors.

Then run the repo doc checks already used for Recursion docs refreshes:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: PASS. If alpha gate is too broad for the current branch, run the focused tests from Tasks 1-4 plus `git diff --check` and record the skipped gate reason in the final handoff.

- [ ] **Step 6: Commit**

```bash
git add docs/design/CARD_SYSTEM_SPEC.md docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md docs/technical/CARD_DECK_AND_HAND.md docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md docs/technical/PROMPT_PACKET_AND_INJECTION.md docs/technical/RUNTIME_TURN_SEQUENCE.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/architecture/PROMPT_COMPOSITION_SPEC.md docs/testing/TESTING_STRATEGY.md docs/user/RECURSION_OPERATOR_MANUAL.md
git commit -m "docs: clarify card budget and instruction contract"
```

## Task 6: End-To-End Verification And Live Proof

**Files:**
- Modify only if verification exposes a defect from earlier tasks.

- [ ] **Step 1: Run focused deterministic tests**

Run:

```powershell
node tools\scripts\test-cards.mjs
node tools\scripts\test-prompt.mjs
node tools\scripts\test-runtime.mjs
```

Expected: all three scripts PASS.

- [ ] **Step 2: Run provider and packet regression tests**

Run:

```powershell
node tools\scripts\test-providers.mjs
node tools\scripts\test-runtime-card-packet.mjs
```

Expected: both scripts PASS.

- [ ] **Step 3: Run alpha gate**

Run:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: PASS.

- [ ] **Step 4: Prove the specific failure shape is gone with a deterministic fixture**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: the new cost regression block proves `generatedRoles.length === 6` when the Arbiter requests all 11 families with `budgets.maxCards=6`.

- [ ] **Step 5: Optional live SillyTavern proof on a dedicated user**

Use a `recursion-soak-*` user, not `default-user`, for mutation proof. Configure the same visible settings shape: Auto, Standard, Strong, Medium reasoning, Rich footprint, `minCards=5`, `maxCards=12`. Generate a turn that asks for broad scene support. Verify in the persisted run journal that the provider card call count is not greater than the selected hand count.

Expected persisted evidence:

```json
{
  "providerCardCalls": 6,
  "handSelected": {
    "selectedCount": 6,
    "omittedCount": 0
  },
  "planDiagnosticsIncludes": "card-jobs-budgeted",
  "cardEvidenceShape": "instruction-shaped"
}
```

- [ ] **Step 6: Commit verification-only fixes if needed**

If a focused or alpha test failure requires a code or docs correction, make the smallest correction, rerun the failing command, and commit:

```bash
git add src/cards.mjs src/runtime.mjs src/prompt.mjs tools/scripts/test-cards.mjs tools/scripts/test-prompt.mjs tools/scripts/test-runtime.mjs docs/design/CARD_SYSTEM_SPEC.md docs/design/BEHAVIOR_SETTINGS_POLICY_SPEC.md docs/technical/CARD_DECK_AND_HAND.md docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md docs/technical/PROMPT_PACKET_AND_INJECTION.md docs/technical/RUNTIME_TURN_SEQUENCE.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/architecture/PROMPT_COMPOSITION_SPEC.md docs/testing/TESTING_STRATEGY.md docs/user/RECURSION_OPERATOR_MANUAL.md
git commit -m "fix: stabilize card cost regression"
```

## Final Verification Checklist

- [ ] `node tools\scripts\test-cards.mjs`
- [ ] `node tools\scripts\test-prompt.mjs`
- [ ] `node tools\scripts\test-runtime.mjs`
- [ ] `node tools\scripts\test-providers.mjs`
- [ ] `node tools\scripts\test-runtime-card-packet.mjs`
- [ ] `node tools\scripts\run-alpha-gate.mjs`
- [ ] `git diff --check`

## Rollback Notes

- If card-job budgeting breaks Manual forced-card coverage, revert only Task 2 and keep Task 1 tests as the required behavior target. The helper contract should remain.
- If instruction validation rejects too many legitimate compact cards, loosen `CARD_INSTRUCTION_LINE_START_PATTERN` by adding explicit verbs used in valid cards. Do not remove narrative-prose rejection.
- If live provider models still produce prose, the provider prompt contract should become stricter before validation is loosened.
- If guidance fallback diagnostics expose frequent snapshot mismatch, debug prompt snapshot hashing separately; do not hide the fallback reason.
