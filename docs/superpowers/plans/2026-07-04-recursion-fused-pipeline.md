# Recursion Fused Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Fused pipeline: one structured foreground card-bundle call for all required provider-generated cards, followed by the existing deck, hand, guidance, packet, and prompt-install flow.

**Architecture:** Treat Fused as a Standard-derived foreground path. The Arbiter, scope filtering, Manual forced-family reconciliation, scene deck, hand selector, guidance composer, Reasoner composer, prompt packet, storage, and prompt install stay shared. Only card generation branches: Standard runs individual card requests through batch routing, while Fused builds one `fusedCardBundle` request and validates returned cards item by item.

**Tech Stack:** JavaScript ES modules, Recursion runtime/provider/card/settings/UI modules, SillyTavern extension DOM, deterministic Node test scripts, markdown architecture/user docs, optional live SillyTavern Playwright smoke.

---

## File Structure

- `src/settings.mjs` - accept `pipelineMode: "fused"` in normalization.
- `src/ui.mjs` - add Fused to the compact Pipeline selector, label helpers, icon rendering, tooltip copy, and force-regenerate copy.
- `src/providers.mjs` - add `fusedCardBundle` as a machine-JSON provider role with response schema `recursion.cardBundle.v1`.
- `src/reasoning-policy.mjs` - keep category `card`; no new category is required.
- `src/cards.mjs` - add fused bundle request construction and item-level fused response validation.
- `src/runtime.mjs` - branch card generation by `settings.pipelineMode === "fused"`, preserve Standard/Rapid behavior, and record fused diagnostics.
- `src/progress.mjs` - add Fused progress labels and preserve child rows for requested families.
- `src/activity.mjs` - no schema change expected; use existing sanitized activity events.
- `tools/scripts/test-settings.mjs` - pipeline normalization coverage.
- `tools/scripts/test-ui.mjs` - Pipeline selector and Fused icon/copy coverage.
- `tools/scripts/test-providers.mjs` - provider role/schema/lane/reasoning coverage.
- `tools/scripts/test-cards.mjs` - fused request and validation coverage.
- `tools/scripts/test-runtime.mjs` - Fused runtime happy path, partial path, Manual omission path, and fallback path.
- `tools/scripts/test-progress.mjs` - Fused progress row and child row coverage.
- `docs/RECURSION_EXTENSION_SPEC.md` - product and core flow update.
- `docs/architecture/RUNTIME_ARCHITECTURE.md` - third pipeline flow.
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md` - role/schema and failure behavior.
- `docs/technical/RECURSION_TECHNICAL_MANUAL.md` - operator technical summary.
- `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md` - provider routing table and model-fit guidance.
- `docs/design/UI_SPEC.md` - compact Pipeline selector third option and icon language.
- `docs/user/RECURSION_OPERATOR_MANUAL.md` - user-facing Fused explanation and model-fit guidance.
- `docs/testing/LIVE_SMOKE_TEST_PLAN.md` - proof that Fused uses one card-bundle call.

---

### Task 1: Pipeline Setting And UI Selector

**Files:**
- Modify: `src/settings.mjs`
- Modify: `src/ui.mjs`
- Modify: `tools/scripts/test-settings.mjs`
- Modify: `tools/scripts/test-ui.mjs`

- [ ] **Step 1: Write failing settings tests**

Add these assertions near the existing pipeline-mode assertions in `tools/scripts/test-settings.mjs`:

```js
assertEqual(normalizeSettings({ pipelineMode: 'fused' }).pipelineMode, 'fused', 'Fused pipeline mode is accepted');
assertEqual(normalizeSettings({ mode: 'manual', pipelineMode: 'fused' }).mode, 'manual', 'Fused does not replace Auto/Manual mode');
assertEqual(normalizeSettings({ pipelineMode: 'FUSED' }).pipelineMode, 'fused', 'Fused pipeline mode normalizes case-insensitively');
```

- [ ] **Step 2: Run failing settings test**

Run:

```powershell
node tools\scripts\test-settings.mjs
```

Expected: the first new assertion fails because `fused` normalizes back to `standard`.

- [ ] **Step 3: Accept the setting value**

Change the pipeline set in `src/settings.mjs`:

```js
const PIPELINE_MODES = new Set(['standard', 'rapid', 'fused']);
```

- [ ] **Step 4: Run settings test**

Run:

```powershell
node tools\scripts\test-settings.mjs
```

Expected: `[pass] settings`.

- [ ] **Step 5: Write failing UI selector tests**

Update the pipeline selector expectations in `tools/scripts/test-ui.mjs`:

```js
assertEqual(root.querySelectorAll('[data-recursion-pipeline-choice-icon]').length, 3, 'pipeline selector renders icons for Standard, Rapid, and Fused');
assertEqual(root.querySelectorAll('[data-recursion-pipeline-choice-tip]').length, 3, 'pipeline selector renders tips for Standard, Rapid, and Fused');
assert(root.querySelector('[data-recursion-pipeline-choice-fused]').querySelector('[data-recursion-pipeline-fused]'), 'Fused pipeline row uses the fused pipeline icon');
assertDeepEqual(
  root.querySelectorAll('[data-recursion-pipeline-choice]').map((choice) => choice.dataset.recursionPipelineChoice),
  ['standard', 'rapid', 'fused'],
  'pipeline selector uses the Standard/Rapid/Fused order'
);
```

Add selection behavior after the Rapid selection assertions:

```js
root.querySelector('[data-recursion-pipeline-button]').click();
root.querySelector('[data-recursion-pipeline-choice-fused]').querySelector('[data-recursion-pipeline-choice-name]').click();
assertDeepEqual(settingsUpdates.at(-1), { pipelineMode: 'fused' }, 'pipeline menu switches to Fused from nested row content clicks');
view = { ...view, settings: { ...view.settings, pipelineMode: 'fused' } };
ui.update();
assert(root.querySelector('[data-recursion-pipeline-icon]').querySelector('[data-recursion-pipeline-fused]'), 'Fused pipeline button uses the fused pipeline icon after selection');
assert(
  root.querySelector('[data-recursion-pipeline-button]').getAttribute('title').includes('Fused Pipeline'),
  'Fused pipeline tooltip explains current pipeline'
);
```

- [ ] **Step 6: Run failing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: failure because Fused is not rendered.

- [ ] **Step 7: Implement Fused UI option**

Update `src/ui.mjs`:

```js
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
  },
  {
    value: 'fused',
    label: 'Fused',
    title: 'Fused Pipeline',
    tip: 'Generates all requested cards in one structured model call before normal guidance.'
  }
]);
```

Replace `normalizePipelineMode`, `pipelineLabel`, and `pipelineIcon` with:

```js
function normalizePipelineMode(value) {
  const mode = cleanText(value, 'standard').toLowerCase();
  if (mode === 'rapid' || mode === 'fused') return mode;
  return 'standard';
}

function pipelineLabel(value) {
  const mode = normalizePipelineMode(value);
  if (mode === 'rapid') return 'Rapid Pipeline';
  if (mode === 'fused') return 'Fused Pipeline';
  return 'Standard Pipeline';
}

function pipelineIcon(value) {
  return normalizePipelineMode(value);
}
```

Add a Fused icon branch to `pipelineIconSvg(kind)` before the Standard return:

```js
if (kind === 'fused') {
  return el('svg', { attrs: { width: '17', height: '17', viewBox: '0 0 17 17', 'aria-hidden': 'true', 'data-recursion-pipeline-fused': '' } }, [
    el('path', { attrs: { d: 'M8.5 2.4 13.2 4.7 8.5 7 3.8 4.7 8.5 2.4Z', fill: 'currentColor', opacity: '.82' } }),
    el('path', { attrs: { d: 'M3.8 6.5 8.5 8.8 13.2 6.5 13.2 9.5 8.5 12 3.8 9.5 3.8 6.5Z', fill: 'currentColor', opacity: '.58' } }),
    el('path', { attrs: { d: 'M3.8 10.8 8.5 13.2 13.2 10.8 13.2 12.4 8.5 14.8 3.8 12.4 3.8 10.8Z', fill: 'currentColor', opacity: '.42' } }),
    el('path', { attrs: { d: 'M8.5 2.4 13.2 4.7 13.2 12.4 8.5 14.8 3.8 12.4 3.8 4.7 8.5 2.4Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.05', 'stroke-linejoin': 'round' } })
  ]);
}
```

Update force-regenerate copy:

```js
const FORCE_REGENERATE_TOOLTIP = 'Regenerate this turn fresh, ignoring cached cards, Rapid warm, Fused reuse, and swipe reuse.';
```

- [ ] **Step 8: Run UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: `[pass] ui`.

- [ ] **Step 9: Commit**

Run:

```powershell
git add src/settings.mjs src/ui.mjs tools/scripts/test-settings.mjs tools/scripts/test-ui.mjs
git commit -m "feat: add fused pipeline selector"
```

---

### Task 2: Provider Role And Reasoning Routing

**Files:**
- Modify: `src/providers.mjs`
- Modify: `tools/scripts/test-providers.mjs`

- [ ] **Step 1: Write failing provider role tests**

Update `responseSchemaForRole(roleId)` in `tools/scripts/test-providers.mjs`:

```js
if (roleId === 'fusedCardBundle') return 'recursion.cardBundle.v1';
```

Add `fusedCardBundle` to `expectedUtilityRoles` after `openThreadsCard` and before `rapidTurnDelta`:

```js
'fusedCardBundle',
```

Add assertions near existing role-lane assertions:

```js
assertEqual(roleLane('fusedCardBundle'), 'utility', 'fusedCardBundle defaults to utility lane');
```

Add a schema-routing test near other `machineJsonSchemaForRequest` coverage:

```js
const fusedSchemaStore = createStore();
const fusedSchemaRouter = createGenerationRouter({
  client: createProviderClient({
    settingsStore: fusedSchemaStore,
    host: {
      generation: {
        async generate(request) {
          const schema = request.responseSchema;
          assertEqual(schema, 'recursion.cardBundle.v1', 'Fused card bundle carries response schema metadata');
          return { text: responseTextForRole('fusedCardBundle', { snapshotHash: request.snapshotHash, items: [] }) };
        }
      }
    }
  })
});
const fusedSchemaResult = await fusedSchemaRouter.generate('fusedCardBundle', { snapshotHash: 'fused-snapshot', prompt: 'Fused card bundle.' });
assertEqual(fusedSchemaResult.ok, true, 'fusedCardBundle provider role validates');
assertEqual(fusedSchemaResult.data.schema, 'recursion.cardBundle.v1', 'fusedCardBundle response schema is accepted');
```

Add a Reasoner-lane override test:

```js
const fusedReasonerStore = createStore();
fusedReasonerStore.updateProvider('reasoner', { enabled: true, lastTest: { status: 'pass' } });
const fusedReasonerRouter = createGenerationRouter({
  client: createProviderClient({
    settingsStore: fusedReasonerStore,
    host: {
      generation: {
        async generate(request) {
          assertEqual(request.lane, 'reasoner', 'Fused bundle can route through Reasoner lane');
          assertEqual(request.reasoningCategory, 'card', 'Fused bundle uses card reasoning category');
          assertEqual(request.reasoningIntent, 'medium', 'Ultra Fused bundle uses medium card reasoning intent');
          return { text: responseTextForRole('fusedCardBundle', { snapshotHash: request.snapshotHash, items: [] }) };
        }
      }
    }
  })
});
const fusedReasonerResult = await fusedReasonerRouter.generate('fusedCardBundle', {
  lane: 'reasoner',
  reasoningCategory: 'card',
  reasoningIntent: 'medium',
  snapshotHash: 'fused-reasoner-snapshot',
  prompt: 'Reasoner Fused bundle.'
});
assertEqual(fusedReasonerResult.ok, true, 'Fused bundle accepts Reasoner lane override when healthy');
```

- [ ] **Step 2: Run failing provider test**

Run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: failure because `fusedCardBundle` is unsupported.

- [ ] **Step 3: Add the provider role**

Update `src/providers.mjs`:

```js
export const UTILITY_ROLE_IDS = Object.freeze([
  'utilityArbiter',
  'sceneFrameCard',
  'activeCastCard',
  'characterMotivationCard',
  'dialogueRelationshipCard',
  'socialSubtextCard',
  'sceneConstraintsCard',
  'knowledgeSecretsCard',
  'clocksConsequencesCard',
  'environmentAffordancesCard',
  'possessionsItemsCard',
  'openThreadsCard',
  'fusedCardBundle',
  'rapidTurnDelta',
  'guidanceComposer',
  'providerTest'
]);
```

Add the response schema:

```js
fusedCardBundle: 'recursion.cardBundle.v1',
```

Place it in `ROLE_RESPONSE_SCHEMAS` after `openThreadsCard`.

- [ ] **Step 4: Run provider test**

Run:

```powershell
node tools\scripts\test-providers.mjs
```

Expected: `[pass] providers`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/providers.mjs tools/scripts/test-providers.mjs
git commit -m "feat: add fused card bundle provider role"
```

---

### Task 3: Fused Card Request Builder And Validator

**Files:**
- Modify: `src/cards.mjs`
- Modify: `tools/scripts/test-cards.mjs`

- [ ] **Step 1: Write failing request-builder tests**

Add imports in `tools/scripts/test-cards.mjs`:

```js
import {
  buildFusedCardBundleRequest,
  cardsFromFusedProviderResult
} from '../../src/cards.mjs';
```

Add request-builder assertions:

```js
const fusedPlan = {
  snapshotHash: 'snapshot-fused-1',
  storyForm: {
    schema: 'recursion.storyForm.v1',
    tense: 'past',
    pov: 'third-person-limited',
    confidence: 'high',
    evidenceRefs: ['message:8'],
    reason: 'Assistant narration is past tense.'
  },
  cardJobs: [
    { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Frame the blocked exit.' },
    { family: 'Character Motivation', role: 'characterMotivationCard', reason: 'Bound motive safely.', forcedBy: 'manual-selection' }
  ]
};
const fusedRequest = buildFusedCardBundleRequest(fusedPlan, {
  runId: 'run-fused-cards',
  snapshotHash: 'snapshot-fused-1',
  snapshot: { messages: [{ mesid: 8, role: 'assistant', text: 'The door stayed shut.' }] },
  cardScope: {
    mode: 'manual',
    strictWhitelist: true,
    selectedSubItemsByFamily: {
      'Scene Frame': ['location-situation'],
      'Character Motivation': ['observable-pressure']
    }
  },
  storyForm: fusedPlan.storyForm
});
assertEqual(fusedRequest.roleId, 'fusedCardBundle', 'Fused request uses fusedCardBundle role');
assertEqual(fusedRequest.snapshotHash, 'snapshot-fused-1', 'Fused request carries snapshot hash');
assertEqual(fusedRequest.requestedCards.length, 2, 'Fused request carries all requested cards');
assert(fusedRequest.prompt.includes('Return one JSON object only.'), 'Fused prompt requires one JSON object');
assert(fusedRequest.prompt.includes('schema "recursion.cardBundle.v1"'), 'Fused prompt names bundle schema');
assert(fusedRequest.prompt.includes('Character Motivation'), 'Fused prompt includes requested family blocks');
assert(fusedRequest.prompt.includes('Do not include first-person internal monologue'), 'Fused prompt includes family safety instructions');
```

- [ ] **Step 2: Write failing validator tests**

Add validation assertions:

```js
const fusedCardContext = {
  chatId: 'chat-fused',
  sceneId: 'scene-fused',
  sceneKey: 'scene-fused',
  sourceRevisionHash: 'source-fused',
  firstMesId: 8,
  lastMesId: 8,
  expectedSnapshotHash: 'snapshot-fused-1',
  requestedCards: fusedRequest.requestedCards
};
const fusedProviderResult = {
  ok: true,
  roleId: 'fusedCardBundle',
  lane: 'reasoner',
  diagnostics: { retryCount: 0 },
  data: {
    schema: 'recursion.cardBundle.v1',
    snapshotHash: 'snapshot-fused-1',
    items: [
      {
        schema: 'recursion.card.v1',
        family: 'Scene Frame',
        role: 'sceneFrameCard',
        promptText: 'The blocked door is the immediate boundary.',
        evidenceRefs: ['message:8'],
        tokenEstimate: 24
      },
      {
        schema: 'recursion.card.v1',
        family: 'Character Motivation',
        role: 'characterMotivationCard',
        promptText: 'She appears under pressure to keep the exit sealed.',
        evidenceRefs: ['message:8'],
        tokenEstimate: 31
      },
      {
        schema: 'recursion.card.v1',
        family: 'Items',
        role: 'possessionsItemsCard',
        promptText: 'This unrequested item should be rejected.',
        evidenceRefs: ['message:8'],
        tokenEstimate: 18
      }
    ],
    omitted: [{ family: 'Items', role: 'possessionsItemsCard', reason: 'provider-skipped' }]
  }
};
const fusedParsed = cardsFromFusedProviderResult(fusedProviderResult, fusedCardContext);
assertEqual(fusedParsed.cards.length, 2, 'Fused validator accepts valid requested siblings');
assertDeepEqual(fusedParsed.cards.map((card) => card.family), ['Scene Frame', 'Character Motivation'], 'Fused validator rejects unrequested items');
assertEqual(fusedParsed.cards[0].providerRole, 'fusedCardBundle', 'Fused cards retain provider role metadata');
assertEqual(fusedParsed.cards[0].providerLane, 'reasoner', 'Fused cards retain provider lane metadata');
assert(fusedParsed.diagnostics.includes('fused-item-rejected:Items'), 'Fused validator records rejected unrequested item');

const fusedMismatch = cardsFromFusedProviderResult({
  ok: true,
  data: { schema: 'recursion.cardBundle.v1', snapshotHash: 'wrong', items: [] }
}, fusedCardContext);
assertEqual(fusedMismatch.cards.length, 0, 'Fused snapshot mismatch accepts no cards');
assert(fusedMismatch.diagnostics.includes('fused-bundle-snapshot-mismatch'), 'Fused snapshot mismatch records diagnostic');
```

- [ ] **Step 3: Run failing card tests**

Run:

```powershell
node tools\scripts\test-cards.mjs
```

Expected: fail because the Fused exports do not exist.

- [ ] **Step 4: Implement request builder**

In `src/cards.mjs`, add:

```js
const CARD_BUNDLE_RESPONSE_SCHEMA = 'recursion.cardBundle.v1';
```

Add `buildFusedCardBundleRequest(plan, context)` after `buildCardRequests`:

```js
export function buildFusedCardBundleRequest(plan = {}, context = {}) {
  const cardScope = context.cardScope || {};
  const storyForm = normalizeStoryForm(context.storyForm || plan.storyForm || UNKNOWN_STORY_FORM);
  const snapshotHash = cleanProviderPromptText(context.snapshotHash ?? plan.snapshotHash ?? '', TEXT_LIMIT);
  const requestedCards = buildCardRequests(plan, context).map((request) => ({
    family: request.metadata.family,
    role: request.metadata.role,
    priority: request.metadata.priority,
    reason: request.metadata.reason || '',
    selectedSubItems: request.cardScope.selectedSubItems,
    refreshOfCardId: request.metadata.refreshOfCardId || '',
    forcedBy: String((plan.cardJobs || []).find((job) => String(job?.family || '') === request.metadata.family)?.forcedBy || '')
  }));
  if (!requestedCards.length) return null;
  const requestLines = requestedCards.flatMap((card, index) => {
    const catalog = resolveCatalog({ family: card.family, role: card.role }, { strict: true });
    return [
      `Requested card ${index + 1}:`,
      `- family: ${catalog.family}`,
      `- role: ${catalog.role}`,
      `- catalog priority: ${catalog.priority}`,
      card.reason ? `- Arbiter reason: ${card.reason}` : '- Arbiter reason: none provided',
      card.refreshOfCardId ? `- Refreshes cached card: ${card.refreshOfCardId}` : '- Refreshes cached card: none',
      card.forcedBy ? `- Forced by: ${card.forcedBy}` : '- Forced by: none',
      cardScopePromptBlock(catalog, card.selectedSubItems),
      cardPromptSafetyInstruction(catalog)
    ].filter(Boolean).join('\n');
  });
  return {
    roleId: 'fusedCardBundle',
    runId: cleanProviderPromptText(context.runId ?? '', TEXT_LIMIT),
    snapshotHash,
    cardScope,
    storyForm,
    requestedCards,
    prompt: [
      'Generate all requested Recursion scene cards in one structured card bundle.',
      'Return one JSON object only. Do not wrap it in markdown.',
      'The JSON object must use schema "recursion.cardBundle.v1".',
      snapshotHash ? `Top-level snapshotHash must be "${snapshotHash}".` : '',
      'Top-level items must be an array. Each item is one card object for one requested family.',
      'Each item must include schema "recursion.card.v1", family, role, promptText, and evidenceRefs.',
      'Return at most one item per requested family. Do not generate unrequested families.',
      'If a requested card cannot be safely generated, omit it from items and add an omitted entry with family, role, and reason.',
      'promptText is the only prompt-facing card text. inspectorNotes are private diagnostics for the Recursion inspector.',
      storyFormPromptBlock(storyForm),
      requestLines.join('\n\n'),
      `Snapshot hash: ${snapshotHash}`,
      `Snapshot:\n${stringifyForPrompt(context.snapshot ?? {})}`
    ].filter(Boolean).join('\n\n'),
    metadata: {
      requestedCount: requestedCards.length,
      requestedFamilies: requestedCards.map((card) => card.family)
    }
  };
}
```

- [ ] **Step 5: Implement validator**

Add `cardsFromFusedProviderResult(result, context)` after `cardsFromProviderResult`:

```js
export function cardsFromFusedProviderResult(result, context = {}) {
  const output = { cards: [], omissions: [], diagnostics: [] };
  if (!result?.ok) {
    output.diagnostics.push('fused-bundle-provider-failed');
    return output;
  }
  const data = asObject(result.data);
  if (data.schema !== CARD_BUNDLE_RESPONSE_SCHEMA) {
    output.diagnostics.push('fused-bundle-schema-mismatch');
    return output;
  }
  if (!providerSnapshotMatches(data, context)) {
    output.diagnostics.push('fused-bundle-snapshot-mismatch');
    return output;
  }
  const requested = new Map((Array.isArray(context.requestedCards) ? context.requestedCards : [])
    .map((card) => {
      const catalog = resolveCatalog({ family: card.family, role: card.role }, { strict: false });
      return catalog ? [catalog.family, catalog] : null;
    })
    .filter(Boolean));
  const seen = new Set();
  const items = Array.isArray(data.items) ? data.items : [];
  for (const rawItem of items) {
    const item = asObject(rawItem);
    const catalog = resolveCatalog({ family: item.family, role: item.role ?? item.roleId }, { strict: false });
    if (!catalog || !requested.has(catalog.family) || seen.has(catalog.family)) {
      output.diagnostics.push(`fused-item-rejected:${cleanOptionalText(item.family || item.role || 'unknown', 80)}`);
      continue;
    }
    const singleResult = {
      ok: true,
      data: {
        schema: CARD_RESPONSE_SCHEMA,
        snapshotHash: data.snapshotHash,
        family: catalog.family,
        role: catalog.role,
        items: [item]
      }
    };
    const cards = cardsFromProviderResult(singleResult, {
      ...context,
      expectedFamily: catalog.family,
      expectedRole: catalog.role
    });
    if (!cards.length) {
      output.diagnostics.push(`fused-item-invalid:${catalog.family}`);
      continue;
    }
    seen.add(catalog.family);
    output.cards.push(...cards.map((card) => ({
      ...card,
      providerRole: 'fusedCardBundle',
      providerLane: result.lane || context.providerLane || 'utility',
      fusedBundleId: result.diagnostics?.runId || result.diagnostics?.requestHash || ''
    })));
  }
  for (const omission of Array.isArray(data.omitted) ? data.omitted : []) {
    const family = cleanOptionalText(omission?.family || '', 120);
    const role = cleanOptionalText(omission?.role || omission?.roleId || '', 120);
    const reason = cleanOptionalText(omission?.reason || 'provider-skipped', 120);
    if (family || role) output.omissions.push({ family, role, reason });
  }
  for (const family of requested.keys()) {
    if (!seen.has(family)) output.diagnostics.push(`fused-item-missing:${family}`);
  }
  return output;
}
```

- [ ] **Step 6: Run card tests**

Run:

```powershell
node tools\scripts\test-cards.mjs
```

Expected: `[pass] cards`.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/cards.mjs tools/scripts/test-cards.mjs
git commit -m "feat: add fused card bundle contract"
```

---

### Task 4: Runtime Fused Card Generation

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Write failing runtime happy-path test**

In `tools/scripts/test-runtime.mjs`, add a new block near Standard pipeline runtime tests:

```js
{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'fused', mode: 'auto', reasoningLevel: 'high' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: 'recursion.utilityArbiter.v1',
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              storyForm: { schema: 'recursion.storyForm.v1', tense: 'past', pov: 'third-person-limited', confidence: 'high', evidenceRefs: ['message:2'], reason: 'Assistant narration.' },
              cardJobs: [
                { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Frame the scene.' },
                { family: 'Scene Constraints', role: 'sceneConstraintsCard', reason: 'Keep the door blocked.' }
              ],
              reasonerDecision: { mode: 'skip', reason: 'unit fused', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: ['fused-unit-plan']
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          assertEqual(request.requestedCards.length, 2, 'Fused runtime sends both card jobs in one request');
          return {
            ok: true,
            roleId,
            lane: request.lane || 'reasoner',
            diagnostics: { runId: 'provider-fused-unit' },
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [
                { schema: 'recursion.card.v1', family: 'Scene Frame', role: 'sceneFrameCard', promptText: 'The door remains the scene boundary.', evidenceRefs: ['message:2'], tokenEstimate: 22 },
                { schema: 'recursion.card.v1', family: 'Scene Constraints', role: 'sceneConstraintsCard', promptText: 'Do not let the exit open without a new action.', evidenceRefs: ['message:2'], tokenEstimate: 24 }
              ],
              omitted: []
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: {
              schema: 'recursion.guidanceComposer.v1',
              snapshotHash: request.snapshotHash,
              guidanceText: 'Use both fused cards directly.',
              sourceCardIds: request.cards?.map((card) => card.id) || [],
              guardrailCardIds: [],
              omittedCardIds: [],
              diagnostics: []
            }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      },
      async batch() {
        throw new Error('Fused runtime should not call batch for card jobs');
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Try the door.' });
  assertEqual(result.ok, true, 'Fused generation completes');
  assert(roleCalls.includes('fusedCardBundle'), 'Fused runtime calls fusedCardBundle');
  assert(!roleCalls.includes('sceneFrameCard'), 'Fused runtime does not call individual Scene Frame card role');
  assert(!roleCalls.includes('sceneConstraintsCard'), 'Fused runtime does not call individual Scene Constraints card role');
  assertEqual(result.packet.diagnostics.pipelineMode, 'fused', 'Fused prompt packet records pipeline mode');
  assert(result.hand.cards.some((card) => card.providerRole === 'fusedCardBundle'), 'Fused cards carry provider role metadata');
}
```

- [ ] **Step 2: Run failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: failure because runtime still calls individual card roles or normalizes Fused to Standard.

- [ ] **Step 3: Import Fused card helpers**

Update the card imports in `src/runtime.mjs`:

```js
import {
  CARD_CATALOG,
  applyCardPlan,
  buildCardRequests,
  buildFusedCardBundleRequest,
  cardsFromFusedProviderResult,
  cardsFromProviderResult,
  localCards,
  normalizeCard,
  selectHand
} from './cards.mjs';
```

Preserve the existing imported names and add only `buildFusedCardBundleRequest` and `cardsFromFusedProviderResult`.

- [ ] **Step 4: Add Fused lane helper**

Add this helper near `applyReasoningLaneToCardRequest`:

```js
function fusedBundleLaneForSettings(settings = {}) {
  const level = String(settings.reasoningLevel || '').toLowerCase();
  if (level === 'high' || level === 'ultra') return 'reasoner';
  return 'utility';
}
```

Use existing Reasoner availability enforcement by catching `RECURSION_REASONER_DISABLED` result from provider routing and falling back to Utility.

- [ ] **Step 5: Refactor card generation result shape**

Replace callers that expect an array from `generatePlanCards(...)` with:

```js
const generatedCardResult = await generatePlanCards({ runId, plan, snapshot: sceneSnapshot, settings, signal });
const providerCards = reuseCacheOnly ? [] : filterScopedCards(
  cardsWithOrigin(generatedCardResult.cards.map(sanitizeGeneratedCard), 'generated')
);
if (generatedCardResult.diagnostics.length) {
  plan = {
    ...plan,
    diagnostics: mergeDiagnostics(plan.diagnostics, generatedCardResult.diagnostics)
  };
  lastPlan = plan;
}
```

Update the Rapid warm caller similarly:

```js
const warmGenerated = await generatePlanCards({ runId, plan, snapshot, settings, signal });
const providerCards = cardsWithOrigin(warmGenerated.cards.map(sanitizeGeneratedCard), 'generated');
```

Rapid uses `settings.pipelineMode === 'rapid'`, so the helper should stay on the existing Standard card path there.

- [ ] **Step 6: Implement Fused branch**

Change `generatePlanCards` to return `{ cards, diagnostics }` and branch before Standard batch generation:

```js
async function generatePlanCards({ runId, plan, snapshot, settings, signal }) {
  const empty = { cards: [], diagnostics: [] };
  if (!generationRouter) return empty;
  const cardScope = scopePayloadForArbiter(settings);
  const context = {
    runId,
    snapshotHash: plan.snapshotHash || hashJson(snapshot),
    snapshot: providerSafeSnapshot(snapshot, settings.retention),
    cardScope,
    storyForm: plan.storyForm || UNKNOWN_STORY_FORM
  };
  const requests = buildCardRequests(plan, context).map((request) => applyReasoningLaneToCardRequest(request, settings));
  if (!requests.length) return empty;
  if (settings.pipelineMode === 'fused' && typeof generationRouter.generate === 'function') {
    return generateFusedPlanCards({ runId, plan, snapshot, settings, signal, context, standardRequests: requests });
  }
  return generateStandardPlanCards({ runId, snapshot, settings, signal, requests });
}
```

Move the existing body into `generateStandardPlanCards(...)` and return `{ cards, diagnostics: [] }`.

Add `generateFusedPlanCards(...)`:

```js
async function generateFusedPlanCards({ runId, plan, snapshot, settings, signal, context, standardRequests }) {
  const request = buildFusedCardBundleRequest(plan, context);
  if (!request) return { cards: [], diagnostics: [] };
  const desiredLane = fusedBundleLaneForSettings(settings);
  const fusedRequest = {
    ...request,
    lane: desiredLane,
    signal,
    ...reasoningRequestMetadata(settings, 'card')
  };
  stageRuntimeActivity({
    runId,
    phase: 'fusedCardBundleRunning',
    label: 'Fusing scene cards...',
    cardCounts: { requested: request.requestedCards.length },
    providerLane: desiredLane,
    chips: ['Fused', String(request.requestedCards.length), desiredLane === 'reasoner' ? 'Reasoner' : 'Utility']
  });
  let result = null;
  try {
    result = await generationRouter.generate('fusedCardBundle', fusedRequest, { runId, signal, isCurrent: () => isRuntimeRunCurrent(runId) });
  } catch {
    result = { ok: false, error: { code: 'RECURSION_FUSED_PROVIDER_THROWN' } };
  }
  if (!result?.ok && desiredLane === 'reasoner') {
    const utilityResult = await generationRouter.generate('fusedCardBundle', { ...fusedRequest, lane: 'utility' }, { runId, signal, isCurrent: () => isRuntimeRunCurrent(runId) });
    result = utilityResult;
  }
  const parsed = cardsFromFusedProviderResult(result, {
    ...cardSourceContext(snapshot),
    expectedSnapshotHash: request.snapshotHash,
    requestedCards: request.requestedCards,
    providerLane: result?.lane || fusedRequest.lane
  });
  const cards = parsed.cards.map((card) => {
    const retryCount = progressRetryCount(result?.diagnostics?.retryCount);
    return {
      ...card,
      providerLane: result?.lane || fusedRequest.lane,
      ...(retryCount ? {
        providerRetryCount: retryCount,
        providerProgressReason: providerCardRetryReason(retryCount, false)
      } : {})
    };
  });
  if (cards.length) {
    return { cards, diagnostics: mergeDiagnostics(parsed.diagnostics, ['fused-card-bundle:partial-or-complete']) };
  }
  return generateStandardPlanCards({
    runId,
    snapshot,
    settings,
    signal,
    requests: standardRequests,
    diagnosticsPrefix: 'fused-escalated-standard:empty-bundle'
  });
}
```

- [ ] **Step 7: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: `[pass] runtime`.

- [ ] **Step 8: Commit**

Run:

```powershell
git add src/runtime.mjs tools/scripts/test-runtime.mjs
git commit -m "feat: route fused card bundle pipeline"
```

---

### Task 5: Partial, Manual, And Fallback Runtime Coverage

**Files:**
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `src/runtime.mjs` if the tests expose missing diagnostics

- [ ] **Step 1: Add partial Fused test**

Add a runtime test where `fusedCardBundle` returns one valid item and one invalid item:

```js
{
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'fused', mode: 'auto' },
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: 'recursion.utilityArbiter.v1',
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              storyForm: { schema: 'recursion.storyForm.v1', tense: 'past', pov: 'third-person-limited', confidence: 'high', evidenceRefs: ['message:2'], reason: 'Assistant narration.' },
              cardJobs: [
                { family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Valid.' },
                { family: 'Social Subtext', role: 'socialSubtextCard', reason: 'Invalid missing evidence.' }
              ],
              reasonerDecision: { mode: 'skip', reason: 'partial fused', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: []
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          return {
            ok: true,
            roleId,
            lane: 'utility',
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [
                { schema: 'recursion.card.v1', family: 'Scene Frame', role: 'sceneFrameCard', promptText: 'Valid frame.', evidenceRefs: ['message:2'], tokenEstimate: 12 },
                { schema: 'recursion.card.v1', family: 'Social Subtext', role: 'socialSubtextCard', promptText: 'Invalid because evidence is absent.', evidenceRefs: [], tokenEstimate: 12 }
              ]
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: { schema: 'recursion.guidanceComposer.v1', snapshotHash: request.snapshotHash, guidanceText: 'Use valid fused cards.', sourceCardIds: [], guardrailCardIds: [], omittedCardIds: [], diagnostics: [] }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Continue.' });
  assertEqual(result.ok, true, 'Fused partial result still completes');
  assert(result.hand.cards.some((card) => card.family === 'Scene Frame'), 'Fused partial accepts valid sibling card');
  assert(result.plan.diagnostics.some((entry) => entry.includes('fused-item-invalid:Social Subtext') || entry.includes('fused-item-missing:Social Subtext')), 'Fused partial records invalid or missing sibling');
}
```

- [ ] **Step 2: Add Manual omission test**

Add a test with `mode: 'manual'`, selected families, and a missing Fused item:

```js
{
  const harness = createRuntimeHarness({
    settings: {
      pipelineMode: 'fused',
      mode: 'manual',
      maxCards: 2,
      cardScope: {
        families: {
          'Scene Frame': { enabled: true, subItems: {} },
          'Items': { enabled: true, subItems: {} }
        }
      }
    },
    generationRouter: {
      async generate(roleId, request = {}) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: 'recursion.utilityArbiter.v1',
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              storyForm: { schema: 'recursion.storyForm.v1', tense: 'past', pov: 'third-person-limited', confidence: 'high', evidenceRefs: ['message:2'], reason: 'Assistant narration.' },
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Arbiter only requested frame.' }],
              reasonerDecision: { mode: 'skip', reason: 'manual fused', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 1 },
              diagnostics: []
            }
          };
        }
        if (roleId === 'fusedCardBundle') {
          assert(request.requestedCards.some((card) => card.family === 'Items'), 'Manual reconciliation adds missing selected family to Fused bundle');
          return {
            ok: true,
            roleId,
            lane: 'utility',
            data: {
              schema: 'recursion.cardBundle.v1',
              snapshotHash: request.snapshotHash,
              items: [{ schema: 'recursion.card.v1', family: 'Scene Frame', role: 'sceneFrameCard', promptText: 'Manual frame card.', evidenceRefs: ['message:2'], tokenEstimate: 12 }],
              omitted: [{ family: 'Items', role: 'possessionsItemsCard', reason: 'not-enough-evidence' }]
            }
          };
        }
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: { schema: 'recursion.guidanceComposer.v1', snapshotHash: request.snapshotHash, guidanceText: 'Use available manual card.', sourceCardIds: [], guardrailCardIds: [], omittedCardIds: [], diagnostics: [] }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Continue.' });
  assertEqual(result.ok, true, 'Manual Fused result completes with omission');
  assert(result.hand.omitted.some((entry) => entry.family === 'Items'), 'Manual Fused missing selected family is visible as omission');
}
```

- [ ] **Step 3: Add whole-bundle fallback test**

Add a runtime test where `fusedCardBundle` fails and Standard card roles are called once:

```js
{
  const roleCalls = [];
  const harness = createRuntimeHarness({
    settings: { pipelineMode: 'fused', mode: 'auto' },
    generationRouter: {
      async generate(roleId, request = {}) {
        roleCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: 'recursion.utilityArbiter.v1',
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              sceneStatus: 'same-scene',
              promptFootprint: 'normal',
              storyForm: { schema: 'recursion.storyForm.v1', tense: 'past', pov: 'third-person-limited', confidence: 'high', evidenceRefs: ['message:2'], reason: 'Assistant narration.' },
              cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard', reason: 'Fallback.' }],
              reasonerDecision: { mode: 'skip', reason: 'fallback fused', signals: [] },
              budgets: { targetBriefTokens: 500, maxCards: 4 },
              diagnostics: []
            }
          };
        }
        if (roleId === 'fusedCardBundle') return { ok: false, error: { code: 'RECURSION_PROVIDER_TIMEOUT' } };
        if (roleId === 'sceneFrameCard') return cardProviderResponse(roleId, request);
        if (roleId === 'guidanceComposer') {
          return {
            ok: true,
            data: { schema: 'recursion.guidanceComposer.v1', snapshotHash: request.snapshotHash, guidanceText: 'Fallback Standard card used.', sourceCardIds: [], guardrailCardIds: [], omittedCardIds: [], diagnostics: [] }
          };
        }
        throw new Error(`unexpected role ${roleId}`);
      },
      async batch(requests = [], options = {}) {
        return Promise.all(requests.map((request) => this.generate(request.roleId, request, options)));
      }
    }
  });
  const result = await harness.runtime.prepareForGeneration({ userMessage: 'Continue.' });
  assertEqual(result.ok, true, 'Fused whole-bundle failure escalates to Standard');
  assert(roleCalls.includes('fusedCardBundle'), 'Fused fallback first tries bundle');
  assert(roleCalls.includes('sceneFrameCard'), 'Fused fallback uses Standard card role');
  assert(result.plan.diagnostics.some((entry) => String(entry).includes('fused-escalated-standard')), 'Fused fallback records escalation diagnostic');
}
```

- [ ] **Step 4: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: failures identify any missing partial, Manual omission, or fallback diagnostics.

- [ ] **Step 5: Patch runtime diagnostics**

If missing, merge Fused diagnostics into `plan.diagnostics` before hand selection:

```js
plan = {
  ...plan,
  diagnostics: mergeDiagnostics(plan.diagnostics, generatedCardResult.diagnostics)
};
lastPlan = plan;
```

Ensure fallback adds one of:

```js
'fused-escalated-standard:provider-unavailable'
'fused-escalated-standard:invalid-bundle'
'fused-escalated-standard:empty-bundle'
```

- [ ] **Step 6: Run runtime test again**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: `[pass] runtime`.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/runtime.mjs tools/scripts/test-runtime.mjs
git commit -m "test: cover fused runtime failure paths"
```

---

### Task 6: Fused Progress Model

**Files:**
- Modify: `src/progress.mjs`
- Modify: `tools/scripts/test-progress.mjs`
- Modify: `src/ui.mjs` if compact phase text needs explicit mapping
- Modify: `tools/scripts/test-ui.mjs` if compact phase text changes

- [ ] **Step 1: Write failing progress tests**

Add to `tools/scripts/test-progress.mjs`:

```js
const fusedProgress = createProgressRunModel({
  activityHistory: [
    { runId: 'run-fused-progress', phase: 'fusedCardBundleRunning', label: 'Fusing scene cards...', providerLane: 'reasoner', cardCounts: { requested: 2 }, recordedAt: '1' },
    { runId: 'run-fused-progress', phase: 'cardProgress', label: 'Scene Frame generated.', providerLane: 'reasoner', detail: { parentStepId: 'fused-card-bundle', roleId: 'sceneFrameCard', family: 'Scene Frame', source: 'generated', state: 'done' }, recordedAt: '2' },
    { runId: 'run-fused-progress', phase: 'cardProgress', label: 'Items omitted.', providerLane: 'reasoner', severity: 'warning', detail: { parentStepId: 'fused-card-bundle', roleId: 'possessionsItemsCard', family: 'Items', source: 'generated', state: 'warning', reason: 'not-enough-evidence' }, recordedAt: '3' }
  ],
  activity: { runId: 'run-fused-progress', phase: 'fusedCardBundleRunning', label: 'Fusing scene cards...', providerLane: 'reasoner', cardCounts: { requested: 2 }, recordedAt: '1' },
  lastPlan: { cardJobs: [{ family: 'Scene Frame', role: 'sceneFrameCard' }, { family: 'Items', role: 'possessionsItemsCard' }] }
});
const fusedStep = fusedProgress.steps.find((step) => step.id === 'fused-card-bundle');
assert(fusedStep, 'Fused card bundle renders a progress row');
assertEqual(fusedStep.label, 'Fused card bundle', 'Fused progress row has compact label');
assertEqual(fusedStep.providerLane, 'reasoner', 'Fused progress row preserves provider lane');
assert(fusedStep.children.some((child) => child.label === 'Scene Frame'), 'Fused progress row has Scene Frame child');
assert(fusedStep.children.some((child) => child.label === 'Items' && child.state === 'warning'), 'Fused progress row has warning child for omitted item');
```

- [ ] **Step 2: Run failing progress test**

Run:

```powershell
node tools\scripts\test-progress.mjs
```

Expected: failure because `fusedCardBundleRunning` and `fused-card-bundle` are unknown.

- [ ] **Step 3: Add progress definitions**

In `src/progress.mjs`, add `fused-card-bundle` to the step id list and definitions:

```js
'fused-card-bundle',
```

```js
'fused-card-bundle': { label: 'Fused card bundle', providerLane: 'utility' },
```

Add phase mapping:

```js
fusedCardBundleRunning: 'fused-card-bundle',
```

Update `roleStepId(event)`:

```js
if (roleId === 'fusedCardBundle') return 'fused-card-bundle';
```

Update `roleLabel(roleId, fallback)`:

```js
if (id === 'fusedCardBundle') return 'Fused card bundle';
```

Update pending child seeding to use the current parent row. If `source.activity.phase === 'fusedCardBundleRunning'`, use `fused-card-bundle`; otherwise use `utility-card-batch`.

- [ ] **Step 4: Add compact current-step copy**

In `src/ui.mjs`, extend `PHASE_LABELS`:

```js
fusedCardBundleRunning: 'Fusing scene cards...',
fusedCardValidating: 'Validating fused cards...',
```

- [ ] **Step 5: Run progress and UI tests**

Run:

```powershell
node tools\scripts\test-progress.mjs
node tools\scripts\test-ui.mjs
```

Expected: both pass.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/progress.mjs src/ui.mjs tools/scripts/test-progress.mjs tools/scripts/test-ui.mjs
git commit -m "feat: show fused card bundle progress"
```

---

### Task 7: Documentation Updates

**Files:**
- Modify: `docs/RECURSION_EXTENSION_SPEC.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- Modify: `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md`
- Modify: `docs/DOCUMENTATION_INDEX.md` only if a new linked Fused-specific doc is added

- [ ] **Step 1: Update product and architecture docs**

Update the Standard/Rapid language to Standard/Rapid/Fused:

```markdown
Pipeline selection is separate from Auto/Manual. Standard is the default full foreground path. Rapid warms a provider-generated card packet in the background and uses foreground Utility `rapidTurnDelta` when that warm packet is exact-source valid. Fused is a foreground quality path that keeps Arbiter planning separate but generates all required provider cards through one structured `fusedCardBundle` call before normal hand selection and guidance composition.
```

Add the Fused flow:

```text
Send -> snapshot -> Arbiter -> Fused card bundle -> item-level validation -> deck -> hand -> guidance -> prompt install
```

- [ ] **Step 2: Update provider docs**

Add provider role row:

```markdown
| `fusedCardBundle` | Utility by default; Reasoner at High/Ultra when healthy | Generate all requested card jobs in one structured card-bundle response. | Accept valid item siblings, omit invalid/missing items, escalate to Standard when no useful bundle is recoverable. |
```

Add schema sentence:

```markdown
Fused card bundle uses `recursion.cardBundle.v1`; each accepted item inside the bundle still validates as one `recursion.card.v1` card.
```

- [ ] **Step 3: Update Reasoning Level docs**

Add this Fused-specific note:

```markdown
Fused respects Reasoning Level rather than adding a separate route selector. Low and Medium route the card bundle through Utility. High and Ultra route the bundle through Reasoner when the lane is healthy, falling back to Utility when Reasoner is unavailable. Fused uses the existing `card` reasoning category: High keeps minimal card reasoning intent, while Ultra raises card reasoning intent to medium.
```

- [ ] **Step 4: Add model-fit guidance**

Add this operator-facing copy in the technical and user manuals:

```markdown
Fused is designed for stronger reasoning models that can hold several card families in one structured pass and avoid duplicated or contradictory cards. Good candidates are current reasoning-focused DeepSeek, GLM, MiniMax, Kimi, MiMo, Qwen, and similar model families when configured as Recursion providers. Standard is usually a better fit for fast and cheap utility-class models, including 500B-and-lower parameter models and families such as Nemotron, GPT-OSS, Gemma, and similar. These examples are guidance, not a runtime allowlist.
```

- [ ] **Step 5: Update UI docs**

Change the Pipeline selector section in `docs/design/UI_SPEC.md` from two choices to three choices:

```markdown
- Three stacked layer icon, `Standard`: runs the full foreground Arbiter, card, compose, and install path on send.
- Tapered layer spike icon, `Rapid`: warms a provider-generated card packet in the background and uses a short provider delta on send.
- Thick combined-layer icon, `Fused`: generates all requested cards in one structured model call before normal hand selection and guidance.
```

Add:

```markdown
Fused uses the same layer-based visual language. It should look like a thick combined layer, almost a small cube, as if multiple card layers have merged into one solid bundle. It should not look like a magic, lightning, or speed shortcut icon.
```

- [ ] **Step 6: Run documentation checks**

Run:

```powershell
git diff --check
```

Expected: no trailing whitespace or patch whitespace warnings.

- [ ] **Step 7: Commit**

Run:

```powershell
git add docs/RECURSION_EXTENSION_SPEC.md docs/architecture/RUNTIME_ARCHITECTURE.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/technical/RECURSION_TECHNICAL_MANUAL.md docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md docs/design/UI_SPEC.md docs/user/RECURSION_OPERATOR_MANUAL.md docs/testing/LIVE_SMOKE_TEST_PLAN.md
git commit -m "docs: describe fused pipeline"
```

---

### Task 8: Focused Gates And Alpha Gate

**Files:**
- No source edits expected unless a gate exposes a missed contract.

- [ ] **Step 1: Run focused deterministic tests**

Run:

```powershell
node tools\scripts\test-settings.mjs
node tools\scripts\test-ui.mjs
node tools\scripts\test-providers.mjs
node tools\scripts\test-cards.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-progress.mjs
```

Expected: each script prints its `[pass] ...` line.

- [ ] **Step 2: Run alpha gate**

Run:

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: alpha gate completes without failures.

- [ ] **Step 3: Commit test fixes if needed**

If a gate exposes a missed contract, patch the relevant file and commit:

```powershell
git add src tools docs
git commit -m "fix: complete fused pipeline gate coverage"
```

Do not commit if no files changed.

---

### Task 9: Live Fused Smoke Proof

**Files:**
- Modify: `tools/scripts/smoke-sillytavern-live.mjs` or `tools/scripts/prove-live-pipelines.mjs`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md` if the command or artifact name changes

- [ ] **Step 1: Add live proof assertions**

Extend the existing live pipeline proof so it can select Fused and assert model-call shape from sanitized journal/activity:

```js
assertEqual(view.settings.pipelineMode, 'fused', 'live smoke selected Fused pipeline');
assert(journalEntries.some((entry) => entry.roleId === 'fusedCardBundle'), 'Fused live smoke records one fusedCardBundle provider call');
assert(!journalEntries.some((entry) => CARD_ROLE_IDS.has(entry.roleId)), 'Fused live smoke does not record individual card-role calls for the Fused card pass');
assert(view.lastPacket?.diagnostics?.pipelineMode === 'fused', 'Fused live smoke installs a Fused prompt packet');
```

Use the repo's existing card-role list or a local `CARD_ROLE_IDS` set that matches `src/providers.mjs`.

- [ ] **Step 2: Run live readiness check**

Run:

```powershell
node tools\scripts\check-playwright-readiness.mjs
```

Expected: readiness check passes or reports the exact missing SillyTavern/live-harness prerequisite.

- [ ] **Step 3: Run live Fused proof**

Run the live smoke command with the dedicated soak user and Fused pipeline flag used by the chosen script. Example shape:

```powershell
$env:RECURSION_LIVE_PIPELINE='fused'; node tools\scripts\prove-live-pipelines.mjs
```

Expected evidence:

- served extension copy is fresh;
- Recursion settings show `pipelineMode: fused`;
- one `fusedCardBundle` provider call is recorded for card generation;
- no individual card-role provider calls are recorded for that Fused card pass;
- prompt packet installs successfully;
- final host generation is not blocked by Recursion.

- [ ] **Step 4: Commit live smoke updates**

Run:

```powershell
git add tools/scripts/smoke-sillytavern-live.mjs tools/scripts/prove-live-pipelines.mjs docs/testing/LIVE_SMOKE_TEST_PLAN.md
git commit -m "test: prove fused pipeline live"
```

Only include files that changed.

---

## Self-Review Checklist

- [ ] Fused is documented as `pipelineMode: "fused"` and does not replace Auto/Manual.
- [ ] Fused keeps Arbiter planning separate from card generation.
- [ ] Fused keeps provider guidance separate from card generation.
- [ ] Fused has a single provider role: `fusedCardBundle`.
- [ ] Fused response schema is `recursion.cardBundle.v1`.
- [ ] Accepted Fused items still validate as `recursion.card.v1`.
- [ ] Fused validates items independently and accepts valid siblings.
- [ ] Fused records missing/invalid Manual forced families as omissions.
- [ ] Fused can escalate to Standard when no useful bundle is recoverable.
- [ ] Reasoning Level controls Fused lane choice and reasoning metadata.
- [ ] Docs mention stronger reasoning model fit for Fused and fast/cheap model fit for Standard.
- [ ] The UI remains compact, icon-first, SillyTavern-native, and does not add a Settings duplicate for Pipeline.
- [ ] Focused tests and alpha gate are run before claiming implementation complete.
