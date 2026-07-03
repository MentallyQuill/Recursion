# Recursion Manual Forced Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Manual mode force every selected card family, cap Manual family selection by `Max Cards`, and show a clear notice when the cap blocks selection.

**Architecture:** Keep the fixed V1 family/facet catalog. Add a mode-aware Manual selection cap at the card-scope/UI layer, then add runtime reconciliation after Arbiter planning so selected Manual families are satisfied by cache reuse or synthesized `cardJobs`. Preserve the existing one-card-per-family provider envelope and make forced omissions visible in diagnostics, Last Brief, and Prompt Packet metadata.

**Tech Stack:** JavaScript ES modules, Recursion runtime/card-scope/settings/UI modules, SillyTavern extension DOM, deterministic Node test scripts, markdown architecture/user docs, guarded live SillyTavern smoke.

---

## File Structure

- `src/card-scope.mjs` - Manual selected-family cap helpers, deterministic context-aware trimming, cap-block result shapes, family selection counts.
- `src/settings.mjs` - normalize Manual cap input from `maxCards`; keep pre-alpha in-place settings normalization.
- `src/cards.mjs` - preserve selected sub-item focus in one-card requests; no multi-card provider envelope.
- `src/runtime.mjs` - reconcile Manual selected families against Arbiter jobs/cache, synthesize missing jobs, floor hand budget, record forced diagnostics and omissions.
- `src/ui.mjs` - Cards dropdown Manual selected-family semantics, cap notices, mode copy, Settings tooltip copy.
- `styles/recursion.css` - compact notice and disabled/unselected family/facet treatment if existing styles are insufficient.
- `tools/scripts/test-card-scope.mjs` - cap/trim/helper unit tests.
- `tools/scripts/test-settings.mjs` - normalized cap and mode interactions.
- `tools/scripts/test-cards.mjs` - unchanged one-family request plus selected facet assertions.
- `tools/scripts/test-runtime.mjs` - forced Manual card coverage and failure paths.
- `tools/scripts/test-ui.mjs` - fake DOM tests for cap-blocked selection and copy.
- `tools/scripts/lib/sillytavern-live-harness.mjs` - optional live proof metadata for Manual forced selection.
- `docs/design/UI_SPEC.md` - visible Cards/Manual contract.
- `docs/design/CARD_SYSTEM_SPEC.md` - family vs facet semantics if stale.
- `docs/architecture/RUNTIME_ARCHITECTURE.md` - Manual mandatory coverage path.
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md` - forced job reconciliation and unchanged provider envelope.
- `docs/user/RECURSION_OPERATOR_MANUAL.md` - user-facing Manual behavior.
- `docs/testing/LIVE_SMOKE_TEST_PLAN.md` - live proof expectations if harness changes.

---

### Task 1: Card Scope Cap Contract

**Files:**
- Modify: `src/card-scope.mjs`
- Modify: `tools/scripts/test-card-scope.mjs`

- [ ] **Step 1: Add failing cap tests**

Add tests near current Manual scope assertions in `tools/scripts/test-card-scope.mjs`:

```js
import {
  CARD_SCOPE_CATALOG,
  manualSelectionCap,
  manualSelectedFamilies,
  rankManualSelectedFamilies,
  enforceManualSelectionCap,
  setFamilyEnabledWithCap
} from '../../src/card-scope.mjs';

const cappedAll = enforceManualSelectionCap(defaultCardScope(), { maxCards: 5 });
assertEqual(cappedAll.trimmed, true, 'Manual cap trims all-selected scope');
assertEqual(manualSelectedFamilies(cappedAll.scope).length, 5, 'Manual cap keeps exactly maxCards families');
assertDeepEqual(
  manualSelectedFamilies(cappedAll.scope),
  CARD_SCOPE_CATALOG.slice(0, 5).map((entry) => entry.family),
  'Manual cap falls back to catalog priority'
);
assertEqual(cappedAll.notice, 'Manual selection trimmed to Max Cards: 5.', 'Manual cap exposes trim notice');

const preferredTrim = enforceManualSelectionCap(defaultCardScope(), { maxCards: 3 }, {
  preferredFamilies: ['Open Threads', 'Environment']
});
assertDeepEqual(
  manualSelectedFamilies(preferredTrim.scope),
  ['Scene Frame', 'Environment', 'Open Threads'],
  'Manual cap keeps preferred current-scene families plus catalog fallback'
);
assertDeepEqual(
  rankManualSelectedFamilies(defaultCardScope(), { preferredFamilies: ['Open Threads', 'Environment'] }).slice(0, 3),
  ['Open Threads', 'Environment', 'Scene Frame'],
  'Manual ranking preserves preferred order before catalog fallback'
);

const capValue = manualSelectionCap({ maxCards: 0 });
assertEqual(capValue, 1, 'Manual selection cap floors to one selected family');

let fiveSelected = enforceManualSelectionCap(defaultCardScope(), { maxCards: 5 }).scope;
const sixthFamily = CARD_SCOPE_CATALOG[5].family;
const blockedSixth = setFamilyEnabledWithCap(fiveSelected, sixthFamily, true, { mode: 'manual', maxCards: 5 });
assertEqual(blockedSixth.blocked, true, 'Manual cap blocks sixth family selection');
assertEqual(blockedSixth.reason, 'manual-card-cap', 'Manual cap block has stable reason');
assertEqual(blockedSixth.notice, 'Max Cards is 5. Change it in Settings to select more.', 'Manual cap block names Max Cards');
assertEqual(manualSelectedFamilies(blockedSixth.scope).length, 5, 'Blocked Manual cap does not mutate selection');

const subItemChange = setSubItemEnabled(fiveSelected, CARD_SCOPE_CATALOG[0].family, CARD_SCOPE_CATALOG[0].subItems[0].key, false);
assertEqual(subItemChange.blocked, false, 'Manual cap does not block sub-item focus changes');
assertEqual(manualSelectedFamilies(subItemChange.scope).length, 5, 'Sub-item focus change does not change selected family count');
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
node tools\scripts\test-card-scope.mjs
```

Expected: fail on missing exports such as `manualSelectionCap`.

- [ ] **Step 3: Implement cap helpers**

Add these exports to `src/card-scope.mjs` near existing scope helpers:

```js
export function manualSelectionCap(settings = {}) {
  const raw = Math.round(Number(settings?.maxCards));
  const normalized = Number.isFinite(raw) ? raw : 10;
  return Math.max(1, Math.min(20, normalized));
}

export function manualSelectedFamilies(scope = {}) {
  const normalized = normalizeCardScope(scope);
  return CARD_SCOPE_CATALOG
    .filter((entry) => selectedForFamily(normalized, entry.family).length > 0)
    .map((entry) => entry.family);
}

function orderedKnownFamilies(values = []) {
  const known = new Set(CARD_SCOPE_CATALOG.map((entry) => entry.family));
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const family = String(value || '');
    if (known.has(family) && !seen.has(family)) {
      seen.add(family);
      output.push(family);
    }
  }
  return output;
}

export function rankManualSelectedFamilies(scope = {}, context = {}) {
  const selected = new Set(manualSelectedFamilies(scope));
  const preferred = orderedKnownFamilies(context.preferredFamilies).filter((family) => selected.has(family));
  const seen = new Set(preferred);
  const fallback = CARD_SCOPE_CATALOG
    .map((entry) => entry.family)
    .filter((family) => selected.has(family) && !seen.has(family));
  return [...preferred, ...fallback];
}

function disabledFamilyState(catalog) {
  return {
    enabled: false,
    subItems: Object.fromEntries(catalog.subItems.map((item) => [item.key, false]))
  };
}

function enabledFamilyState(catalog) {
  return {
    enabled: true,
    subItems: Object.fromEntries(catalog.subItems.map((item) => [item.key, true]))
  };
}

export function enforceManualSelectionCap(scope = {}, settings = {}, context = {}) {
  const cap = manualSelectionCap(settings);
  const normalized = normalizeCardScope(scope);
  const selected = rankManualSelectedFamilies(normalized, context);
  if (selected.length <= cap) {
    return { scope: normalized, trimmed: false, cap, notice: '' };
  }
  const keep = new Set(selected.slice(0, cap));
  const next = cloneScope(normalized);
  for (const catalog of CARD_SCOPE_CATALOG) {
    if (!keep.has(catalog.family)) {
      next.families[catalog.family] = disabledFamilyState(catalog);
    }
  }
  return {
    scope: next,
    trimmed: true,
    cap,
    notice: `Manual selection trimmed to Max Cards: ${cap}.`
  };
}

export function setFamilyEnabledWithCap(scope = {}, family, enabled, settings = {}) {
  const mode = settings?.mode === 'manual' ? 'manual' : 'auto';
  const normalized = normalizeCardScope(scope);
  const catalog = familyCatalog(family);
  if (!catalog) return { scope: normalized, blocked: false, reason: 'unknown-family', notice: '' };
  if (mode !== 'manual' || enabled !== true) {
    const result = setFamilyEnabled(normalized, family, enabled);
    return { ...result, notice: result.blocked ? 'Keep at least one card focus enabled.' : '' };
  }
  const selected = manualSelectedFamilies(normalized);
  const alreadySelected = selected.includes(catalog.family);
  const cap = manualSelectionCap(settings);
  if (!alreadySelected && selected.length >= cap) {
    return {
      scope: normalized,
      blocked: true,
      reason: 'manual-card-cap',
      cap,
      notice: `Max Cards is ${cap}. Change it in Settings to select more.`
    };
  }
  const next = cloneScope(normalized);
  next.families[catalog.family] = enabledFamilyState(catalog);
  return { scope: next, blocked: false, reason: '', cap, notice: '' };
}
```

- [ ] **Step 4: Run cap tests**

Run:

```powershell
node tools\scripts\test-card-scope.mjs
```

Expected: `[pass] card-scope`.

- [ ] **Step 5: Commit**

```powershell
git add src/card-scope.mjs tools/scripts/test-card-scope.mjs
git commit -m "feat: add manual card selection cap"
```

---

### Task 2: Settings Normalization And Safe View

**Files:**
- Modify: `src/settings.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-settings.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Add failing settings tests**

Add assertions to `tools/scripts/test-settings.mjs`:

```js
const zeroMaxManual = normalizeSettings({ mode: 'manual', maxCards: 0 });
assertEqual(zeroMaxManual.maxCards, 0, 'stored Max Cards can remain zero for existing card budget semantics');
assert(zeroMaxManual.cardScope, 'manual settings still normalize card scope');

const highMax = normalizeSettings({ mode: 'manual', maxCards: 50 });
assertEqual(highMax.maxCards, 20, 'Max Cards remains capped at twenty');
```

Add runtime safe-view assertion near existing card scope view tests in `tools/scripts/test-runtime.mjs`:

```js
{
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', maxCards: 5, reasonerUse: 'off' }
  });
  const view = runtime.view();
  assertEqual(view.settings.maxCards, 5, 'runtime view exposes current Max Cards for Manual cap UI');
  assert(view.settings.cardScopeSummary.counts.selectedFamilies >= 1, 'runtime view keeps at least one selected family');
}
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
node tools\scripts\test-settings.mjs
node tools\scripts\test-runtime.mjs
```

Expected: settings test should pass if current normalization already matches; runtime test may pass. Keep these assertions as contract coverage.

- [ ] **Step 3: Wire cap helpers where settings patches apply**

In `src/runtime.mjs`, wherever UI settings patches are normalized before saving, ensure Manual card scope patches pass through `enforceManualSelectionCap(...)` before persistence. Use the existing settings update seam rather than adding a parallel settings store. Build trim preference from current runtime state so Auto-to-Manual keeps the most intuitive cards.

Add helper near safe view helpers:

```js
function manualTrimPreferenceFamiliesForRuntime(settings = {}) {
  const fromLastHand = Array.isArray(lastHand?.cards)
    ? lastHand.cards.map((card) => card.family).filter(Boolean)
    : [];
  const focusFamilies = influencePolicyForSettings(settings).focus?.boostedFamilies || [];
  return [...fromLastHand, ...focusFamilies];
}
```

Use this pattern at the update seam:

```js
const normalized = normalizeSettings(nextSettings, providerSecretStore);
const manualScoped = normalized.mode === 'manual'
  ? enforceManualSelectionCap(normalized.cardScope, normalized, {
      preferredFamilies: manualTrimPreferenceFamiliesForRuntime(normalized)
    })
  : { scope: normalized.cardScope, trimmed: false, notice: '' };
const finalSettings = {
  ...normalized,
  cardScope: manualScoped.scope
};
```

Import:

```js
import {
  cardScopeSummary,
  enforceManualSelectionCap,
  filterCardJobsForScope,
  filterCardsForScope,
  normalizeCardScope,
  scopePayloadForArbiter
} from './card-scope.mjs';
```

If the runtime settings store does not expose notices, keep notice handling in UI Task 3 and keep this step to normalization only.

- [ ] **Step 4: Run tests**

Run:

```powershell
node tools\scripts\test-settings.mjs
node tools\scripts\test-runtime.mjs
```

Expected: `[pass] settings` and `[pass] runtime`.

- [ ] **Step 5: Commit**

```powershell
git add src/settings.mjs src/runtime.mjs tools/scripts/test-settings.mjs tools/scripts/test-runtime.mjs
git commit -m "feat: normalize manual card cap"
```

---

### Task 3: Cards Dropdown Manual Cap UI

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-ui.mjs`

- [ ] **Step 1: Add failing UI tests**

Add fake DOM coverage near existing Cards dropdown tests in `tools/scripts/test-ui.mjs`:

```js
view = {
  ...view,
  settings: {
    ...view.settings,
    mode: 'manual',
    maxCards: 2,
    cardScope: defaultCardScope()
  }
};
root = renderMounted(view);
root.querySelector('[data-recursion-cards-button]').click();
const cardsPanel = root.querySelector('[data-recursion-cards-panel]');
assert(fakeDocument.textTree(cardsPanel).includes('2/2 cards selected'), 'Manual Cards header shows selected card cap');
const thirdFamily = CARD_SCOPE_CATALOG[2].family;
cardsPanel
  .querySelector(`[data-recursion-card-scope-family-name="${thirdFamily}"] [data-recursion-card-scope-family-toggle]`)
  .click();
assert(fakeDocument.textTree(root.querySelector('[data-recursion-cards-panel]')).includes('Max Cards is 2. Change it in Settings to select more.'), 'Manual cap block notice appears');
assertEqual(settingsUpdates.length, previousSettingsUpdateCount, 'blocked Manual cap does not write settings');
```

Add sub-item assertion:

```js
const firstFamily = CARD_SCOPE_CATALOG[0].family;
const firstFacet = CARD_SCOPE_CATALOG[0].subItems[0].key;
root
  .querySelector(`[data-recursion-card-scope-family-name="${firstFamily}"] [data-recursion-card-scope-sub-item="${firstFacet}"]`)
  .click();
assert(settingsUpdates.at(-1).cardScope, 'Manual sub-item focus change writes settings under cap');
```

- [ ] **Step 2: Run failing UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: fail because header/cap behavior still uses focus item counts.

- [ ] **Step 3: Update view model and copy**

In `src/ui.mjs`, import cap helpers:

```js
import {
  CARD_SCOPE_CATALOG,
  cardScopeCounts,
  cardScopeLabel,
  defaultCardScope,
  enabledSubItemsForFamily,
  enforceManualSelectionCap,
  familyState,
  manualSelectedFamilies,
  manualSelectionCap,
  normalizeCardScope,
  setFamilyEnabled,
  setFamilyEnabledWithCap,
  setSubItemEnabled
} from './card-scope.mjs';
```

Change Manual mode menu copy:

```js
{
  value: 'manual',
  label: 'Manual',
  title: 'Uses selected cards only and forces each selected card into the next hand.',
  tip: 'Uses selected cards only and forces each selected card into the next hand.'
}
```

Change Max Cards tooltip:

```js
maxCards: 'Upper Manual card-selection cap and Ultra Reasoning Level card target. Medium and High use the average, so this also sets the upper range for busier scenes.'
```

- [ ] **Step 4: Update Cards panel header**

In `renderCardsPanel(...)`, compute Manual summary separately:

```js
const isManual = view.settings?.mode === 'manual';
const cap = manualSelectionCap(view.settings || {});
const selectedFamilies = manualSelectedFamilies(scope);
const summary = isManual
  ? `${selectedFamilies.length}/${cap} cards selected`
  : (counts.selectedSubItems === counts.totalSubItems
      ? 'All card focus enabled'
      : `${counts.selectedSubItems}/${counts.totalSubItems} focus items enabled`);
```

Change `All` title by mode:

```js
const allButtonAttrs = {
  type: 'button',
  'aria-label': isManual ? 'Select maximum Manual cards' : 'Select all card focus items',
  title: isManual
    ? `Select up to ${cap} Manual cards.`
    : (allSelected ? 'All card focus items are already selected.' : 'Select all card focus items.')
};
```

Manual `allSelected` should mean `selectedFamilies.length >= cap`, not all focus items.

Add a UI preference builder so Auto-to-Manual trimming keeps what the user just saw:

```js
function manualTrimPreferenceFamilies(view = {}) {
  const fromHand = Array.isArray(view.lastHand?.cards)
    ? view.lastHand.cards.map((card) => card.family).filter(Boolean)
    : [];
  const focus = String(view.settings?.focus || 'balanced');
  const focusFamilies = FOCUS_BOOSTED_FAMILIES[focus] || [];
  return [...fromHand, ...focusFamilies];
}
```

If `FOCUS_BOOSTED_FAMILIES` is not exported to UI, add a small local mapping that mirrors `src/settings-policy.mjs` and add a test that keeps it in sync, or export a read-only helper from `src/settings-policy.mjs`.

- [ ] **Step 5: Update family toggle handler**

Where family toggles apply `setFamilyEnabled(...)`, use:

```js
const result = setFamilyEnabledWithCap(currentScope, familyName, nextEnabled, {
  mode: currentView().settings?.mode,
  maxCards: currentView().settings?.maxCards
});
applyCardScopeResult(result);
```

Ensure `applyCardScopeResult(...)` displays `result.notice` when present and does not call settings update when `result.blocked === true`.

- [ ] **Step 6: Update Manual All action**

For the Cards `All` button:

```js
const next = currentView().settings?.mode === 'manual'
  ? enforceManualSelectionCap(defaultCardScope(), currentView().settings || {}, {
      preferredFamilies: manualTrimPreferenceFamilies(currentView())
    })
  : { scope: defaultCardScope(), blocked: false, notice: '' };
applyCardScopeResult({
  scope: next.scope,
  blocked: false,
  notice: next.trimmed ? `Selected ${next.cap} cards. Max Cards limits Manual selection.` : ''
});
```

- [ ] **Step 7: Add compact notice styling**

If existing `.recursion-card-scope-notice` is not enough, add to `styles/recursion.css`:

```css
.recursion-card-scope-notice {
  min-height: 18px;
  padding: 4px 9px;
  color: var(--recursion-warning, #ffd479);
  font-size: 10px;
  line-height: 1.25;
}

.recursion-card-scope-family.is-off .recursion-card-scope-subitems {
  opacity: .55;
}
```

- [ ] **Step 8: Run UI test**

Run:

```powershell
node tools\scripts\test-ui.mjs
```

Expected: `[pass] ui`.

- [ ] **Step 9: Commit**

```powershell
git add src/ui.mjs styles/recursion.css tools/scripts/test-ui.mjs
git commit -m "feat: cap manual card selection in UI"
```

---

### Task 4: Runtime Manual Forced Job Reconciliation

**Files:**
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Add failing runtime test for Arbiter omission**

Add test near existing Manual scoped run tests in `tools/scripts/test-runtime.mjs`:

```js
{
  const manualScope = scopeWithOnlyFamilies(['Scene Frame', 'Open Threads']);
  const routerCalls = [];
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', maxCards: 2, cardScope: manualScope, reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        routerCalls.push(roleId);
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [{ family: 'Open Threads', role: 'openThreadsCard', reason: 'Arbiter picked only threads.' }],
              budgets: { targetBriefTokens: 500, maxCards: 1 },
              diagnostics: ['manual-forced-test']
            }
          };
        }
        throw new Error(`Expected batch for card jobs, got generate ${roleId}`);
      },
      async batch(requests) {
        routerCalls.push(...requests.map((request) => request.roleId));
        assertDeepEqual(
          requests.map((request) => request.metadata.family).sort(),
          ['Open Threads', 'Scene Frame'].sort(),
          'Manual runtime synthesizes missing selected family job'
        );
        return requests.map((request) => ({
          ok: true,
          data: {
            schema: 'recursion.card.v1',
            role: request.metadata.role,
            family: request.metadata.family,
            snapshotHash: request.snapshotHash,
            items: [{
              promptText: `${request.metadata.family} forced card.`,
              evidenceRefs: ['message:2'],
              tokenEstimate: 18
            }]
          }
        }));
      }
    }
  });
  const result = await runtime.prepareForGeneration({ userMessage: 'Manual force selected cards.' });
  const view = runtime.view();
  assertEqual(result.ok, true, 'manual forced run installs prompt');
  assert(routerCalls.includes('sceneFrameCard'), 'manual forced run generates Arbiter-omitted selected Scene Frame');
  assert(view.lastHand.cards.some((card) => card.family === 'Scene Frame'), 'manual forced hand includes Scene Frame');
  assert(view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'manual forced hand includes Open Threads');
  assertEqual(view.lastHand.metadata.maxCards >= 2, true, 'manual forced hand floors budget to selected family count');
  assert(JSON.stringify(view.lastPlan).includes('manual-forced-card:Scene Frame'), 'manual forced diagnostic records synthesized card');
}
```

Add helper near existing test helpers:

```js
function scopeWithOnlyFamilies(families = []) {
  const selected = new Set(families);
  const scope = defaultCardScope();
  for (const catalog of CARD_SCOPE_CATALOG) {
    const enabled = selected.has(catalog.family);
    scope.families[catalog.family].enabled = enabled;
    for (const item of catalog.subItems) {
      scope.families[catalog.family].subItems[item.key] = enabled;
    }
  }
  return scope;
}
```

- [ ] **Step 2: Run failing runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: fail because only Arbiter-selected `Open Threads` is generated.

- [ ] **Step 3: Add reconciliation helper**

In `src/runtime.mjs`, add helper near scope/card helpers:

```js
function resolveCatalogForFamily(family) {
  return CARD_CATALOG.find((entry) => entry.family === family) || null;
}

function activeCardFamilies(cards = []) {
  return new Set((Array.isArray(cards) ? cards : [])
    .filter((card) => card?.status === 'active' && card.family)
    .map((card) => card.family));
}

function reconcileManualForcedCardJobs({ plan, settings, cacheCards = [], forceContext = null } = {}) {
  const scope = scopePayloadForArbiter(settings);
  const entries = Array.isArray(plan?.cardJobs) ? plan.cardJobs : [];
  if (!scope.strictWhitelist) {
    return {
      cardJobs: entries,
      diagnostics: [],
      forcedFamilies: [],
      reusedFamilies: [],
      synthesizedFamilies: [],
      omitted: []
    };
  }
  const selectedFamilies = scope.selectedFamilies || [];
  const reusableFamilies = forceContext ? new Set() : activeCardFamilies(cacheCards);
  const jobsByFamily = new Map();
  for (const job of entries) {
    const catalog = resolveCatalogForFamily(job.family) || CARD_CATALOG.find((entry) => entry.role === job.role || entry.role === job.roleId);
    if (catalog && selectedFamilies.includes(catalog.family) && !jobsByFamily.has(catalog.family)) {
      jobsByFamily.set(catalog.family, { ...job, family: catalog.family, role: catalog.role });
    }
  }
  const diagnostics = [];
  const synthesizedFamilies = [];
  const reusedFamilies = [];
  for (const family of selectedFamilies) {
    if (jobsByFamily.has(family)) continue;
    if (reusableFamilies.has(family)) {
      reusedFamilies.push(family);
      diagnostics.push(`manual-forced-cache:${family}`);
      continue;
    }
    const catalog = resolveCatalogForFamily(family);
    if (!catalog) continue;
    synthesizedFamilies.push(family);
    diagnostics.push(`manual-forced-card:${family}`);
    jobsByFamily.set(family, {
      family: catalog.family,
      role: catalog.role,
      reason: 'Manual selected this card; runtime forced coverage because the Arbiter omitted it.',
      forcedBy: 'manual-selection'
    });
  }
  return {
    cardJobs: [...jobsByFamily.values()],
    diagnostics,
    forcedFamilies: selectedFamilies.slice(),
    reusedFamilies,
    synthesizedFamilies,
    omitted: []
  };
}
```

- [ ] **Step 4: Call reconciliation in Standard path**

In `prepareForGeneration(...)`, load active cache before finalizing card jobs. Replace the existing `filterCardJobsForScope(...)`-only block with this sequence after `initialCache` exists:

```js
const scopedCardJobs = filterCardJobsForScope(plan.cardJobs, settings);
const activeCacheForManual = activeSceneCacheVariant(initialCache, snapshot);
const manualReconciled = reconcileManualForcedCardJobs({
  plan: { ...plan, cardJobs: scopedCardJobs.cardJobs },
  settings,
  cacheCards: cardsWithOrigin(sanitizedCacheCards(runId, snapshot, activeCacheForManual.cards), 'cache'),
  forceContext,
  snapshot
});
plan = {
  ...plan,
  cardJobs: manualReconciled.cardJobs,
  budgets: settings.mode === 'manual'
    ? {
        ...plan.budgets,
        maxCards: Math.max(budgetOr(plan.budgets?.maxCards, 6), manualReconciled.forcedFamilies.length)
      }
    : plan.budgets,
  diagnostics: mergeDiagnostics(
    plan.diagnostics,
    scopeOmissionReasons(scopedCardJobs.omitted),
    autoScopeExceptionReasons(scopedCardJobs.cardJobs, settings),
    manualReconciled.diagnostics
  )
};
```

Keep later `activeCache` calculation unchanged, or reuse the same variable if scope makes that clearer.

- [ ] **Step 5: Call reconciliation in Rapid warm path**

Apply the same helper in `warmRapidScene(...)` after `filterCardJobsForScope(...)` and before `generatePlanCards(...)`. Use the warm cache cards and no foreground force context unless the warm path already carries one.

- [ ] **Step 6: Run runtime test**

Run:

```powershell
node tools\scripts\test-runtime.mjs
```

Expected: `[pass] runtime`.

- [ ] **Step 7: Commit**

```powershell
git add src/runtime.mjs tools/scripts/test-runtime.mjs
git commit -m "feat: force selected manual card jobs"
```

---

### Task 5: Manual Hand Selection And Forced Omissions

**Files:**
- Modify: `src/cards.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-cards.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [ ] **Step 1: Add failing forced-first hand test**

In `tools/scripts/test-cards.mjs`, add:

```js
const forcedHand = selectHand([
  normalizeCard({ family: 'Open Threads', promptText: 'Threads', evidenceRefs: ['message:1'], tokenEstimate: 10 }),
  normalizeCard({ family: 'Scene Frame', promptText: 'Frame', evidenceRefs: ['message:1'], tokenEstimate: 10 }),
  normalizeCard({ family: 'Environment', promptText: 'Environment', evidenceRefs: ['message:1'], tokenEstimate: 10 })
], {
  maxCards: 2,
  maxTokens: 20,
  forcedFamilies: ['Environment', 'Open Threads']
});
assertDeepEqual(forcedHand.cards.map((card) => card.family), ['Open Threads', 'Environment'], 'forced families are selected before non-forced priority cards');
```

- [ ] **Step 2: Run failing cards test**

Run:

```powershell
node tools\scripts\test-cards.mjs
```

Expected: fail because `selectHand(...)` ignores `forcedFamilies`.

- [ ] **Step 3: Extend `selectHand(...)` options**

In `src/cards.mjs`, update signature:

```js
export function selectHand(cards = [], { maxCards = 6, maxTokens = 700, behaviorPolicy = null, forcedFamilies = [] } = {}) {
```

Add forced ordering:

```js
function forcedFamilySet(values = []) {
  return new Set((Array.isArray(values) ? values : []).map((value) => String(value || '')).filter(Boolean));
}

function sortCardsForHandWithForced(a, b, policy, forced) {
  const aForced = forced.has(a.family) ? 1 : 0;
  const bForced = forced.has(b.family) ? 1 : 0;
  if (aForced !== bForced) return bForced - aForced;
  return sortCardsForHand(a, b, policy);
}
```

Use it:

```js
const forced = forcedFamilySet(forcedFamilies);
for (const card of active.slice().sort((a, b) => sortCardsForHandWithForced(a, b, policy, forced))) {
```

Add metadata:

```js
forcedFamilies: [...forced],
```

- [ ] **Step 4: Pass forced families from runtime**

In both Standard and Rapid hand selection calls in `src/runtime.mjs`, compute:

```js
const manualForcedFamilies = settings.mode === 'manual'
  ? scopePayloadForArbiter(settings).selectedFamilies
  : [];
```

Pass:

```js
forcedFamilies: manualForcedFamilies
```

to every `selectHand(...)` call for the run.

- [ ] **Step 5: Add forced failure test**

In `tools/scripts/test-runtime.mjs`, add a Manual selected family provider failure test:

```js
{
  const manualScope = scopeWithOnlyFamilies(['Scene Frame', 'Open Threads']);
  const { runtime } = createRuntimeHarness({
    settings: { mode: 'manual', maxCards: 2, cardScope: manualScope, reasonerUse: 'off' },
    generationRouter: {
      async generate(roleId, request) {
        if (roleId === 'utilityArbiter') {
          return {
            ok: true,
            data: {
              schema: UTILITY_ARBITER_SCHEMA,
              snapshotHash: request.snapshotHash,
              action: 'compose-brief',
              cardJobs: [],
              budgets: { targetBriefTokens: 500, maxCards: 2 }
            }
          };
        }
        throw new Error(`Expected batch, got ${roleId}`);
      },
      async batch(requests) {
        return requests.map((request) => request.metadata.family === 'Scene Frame'
          ? { ok: false, error: { code: 'TEST_FORCED_FAILURE' } }
          : {
              ok: true,
              data: {
                schema: 'recursion.card.v1',
                role: request.metadata.role,
                family: request.metadata.family,
                snapshotHash: request.snapshotHash,
                items: [{ promptText: 'Threads card.', evidenceRefs: ['message:2'], tokenEstimate: 18 }]
              }
            });
      }
    }
  });
  await runtime.prepareForGeneration({ userMessage: 'Manual forced failure.' });
  const view = runtime.view();
  assert(view.lastHand.cards.some((card) => card.family === 'Open Threads'), 'valid forced family remains selected');
  assert(JSON.stringify(view.lastPacket).includes('Scene Frame') || JSON.stringify(view.lastPlan).includes('manual-forced-card:Scene Frame'), 'failed forced family is diagnosable');
}
```

- [ ] **Step 6: Run tests**

Run:

```powershell
node tools\scripts\test-cards.mjs
node tools\scripts\test-runtime.mjs
```

Expected: `[pass] cards` and `[pass] runtime`.

- [ ] **Step 7: Commit**

```powershell
git add src/cards.mjs src/runtime.mjs tools/scripts/test-cards.mjs tools/scripts/test-runtime.mjs
git commit -m "feat: prioritize forced manual hand cards"
```

---

### Task 6: Docs Integration

**Files:**
- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/design/CARD_SYSTEM_SPEC.md`
- Modify: `docs/architecture/RUNTIME_ARCHITECTURE.md`
- Modify: `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/testing/LIVE_SMOKE_TEST_PLAN.md`

- [ ] **Step 1: Update design docs**

In `DESIGN.md`, update the "Don't expose per-card micromanagement" language to preserve the distinction:

```markdown
- Don't expose per-card editing or review queues in V1. Manual may force selected fixed card families, but users should not author, reorder, or approve individual card text.
```

In `docs/design/UI_SPEC.md`, replace Manual scope copy with:

```markdown
- Parallel arrows icon, `Manual`: Recursion uses selected card families only, forces each selected family into the next hand by cache reuse or generation, and caps selectable families by Max Cards.
```

Add Cards dropdown cap copy:

```markdown
In Manual, family rows are selected cards and sub-items are focus facets. The dropdown header shows selected families against the Max Cards cap, such as `4/10 cards selected`. If the user tries to select another family at the cap, the row remains off and the panel shows `Max Cards is 10. Change it in Settings to select more.` Auto keeps focus-item counting because Auto scope remains preference rather than mandatory coverage.
```

- [ ] **Step 2: Update architecture docs**

In `docs/architecture/RUNTIME_ARCHITECTURE.md`, update Manual mode:

```markdown
- Manual: selected card families are a strict whitelist and mandatory coverage target. Runtime reconciles the Arbiter plan against selected families, reuses valid selected-family cache cards, synthesizes missing selected-family card jobs, and floors the hand budget to the selected-family count within Max Cards.
```

In `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`, add under Batched Card Calls:

```markdown
Manual forced coverage does not change the provider envelope. Runtime may synthesize missing selected-family jobs after Arbiter planning, but each job still produces one `recursion.card.v1` response with exactly one item. Selected sub-items remain focus guidance inside that family prompt.
```

- [ ] **Step 3: Update user manual**

In `docs/user/RECURSION_OPERATOR_MANUAL.md`, update Manual section:

```markdown
Manual uses the Cards selector as a force list. Selected card families are covered by valid cache reuse or fresh generation unless a provider or validation failure is reported. Max Cards caps how many Manual card families can be selected; when the cap blocks another selection, the Cards dropdown tells you to raise Max Cards in Settings.
```

- [ ] **Step 4: Update testing docs**

In `docs/testing/LIVE_SMOKE_TEST_PLAN.md`, expand Manual pass:

```markdown
- Set Manual with Max Cards at 2.
- Select two card families.
- Attempt a third family and verify the cap notice appears without mutating settings.
- Run a Manual pass and verify selected families appear in Last Brief/Prompt Packet metadata or as explicit forced omissions.
```

- [ ] **Step 5: Commit**

```powershell
git add DESIGN.md docs/design/UI_SPEC.md docs/design/CARD_SYSTEM_SPEC.md docs/architecture/RUNTIME_ARCHITECTURE.md docs/architecture/PROVIDER_AND_GENERATION_SPEC.md docs/user/RECURSION_OPERATOR_MANUAL.md docs/testing/LIVE_SMOKE_TEST_PLAN.md
git commit -m "docs: specify manual forced card behavior"
```

---

### Task 7: Live Harness Proof

**Files:**
- Modify: `tools/scripts/lib/sillytavern-live-harness.mjs`
- Modify: `tools/scripts/test-live-harness.mjs`
- Modify: `docs/testing/SILLYTAVERN_PLAYWRIGHT_HARNESS.md`

- [ ] **Step 1: Add fake harness test**

In `tools/scripts/test-live-harness.mjs`, extend the generation fixture so Manual proof can report:

```js
manualForcedProof: {
  requested: true,
  maxCards: 2,
  selectedFamilies: ['Scene Frame', 'Open Threads'],
  capBlocked: true,
  capNotice: 'Max Cards is 2. Change it in Settings to select more.',
  coveredFamilies: ['Scene Frame', 'Open Threads'],
  forcedOmissions: []
}
```

Assert report metadata:

```js
assertEqual(report.browser.snapshot.generation.manualForcedProof?.capBlocked, true, 'manual forced proof records cap block');
assertDeepEqual(report.browser.snapshot.generation.manualForcedProof?.coveredFamilies, ['Scene Frame', 'Open Threads'], 'manual forced proof records covered selected families');
```

- [ ] **Step 2: Implement browser proof script**

In `tools/scripts/lib/sillytavern-live-harness.mjs`, add a `manualForcedProofScript()` that:

1. Sets Manual mode.
2. Sets Max Cards to `2` through the Settings UI or direct safe extension API used by existing smoke setup.
3. Opens Cards dropdown.
4. Selects two families.
5. Attempts a third family.
6. Reads the cap notice.
7. Runs the existing Manual proof generation.
8. Reads sanitized Last Brief/Prompt Packet metadata for selected families and forced omissions.

Return only sanitized labels, counts, booleans, and ids:

```js
{
  requested: true,
  maxCards: 2,
  selectedFamilies,
  capBlocked,
  capNotice,
  coveredFamilies,
  forcedOmissions,
  error: ''
}
```

- [ ] **Step 3: Run harness tests**

Run:

```powershell
node tools\scripts\test-live-harness.mjs
```

Expected: `[pass] live-harness`.

- [ ] **Step 4: Commit**

```powershell
git add tools/scripts/lib/sillytavern-live-harness.mjs tools/scripts/test-live-harness.mjs docs/testing/SILLYTAVERN_PLAYWRIGHT_HARNESS.md
git commit -m "test: prove manual forced card selection live"
```

---

### Task 8: Final Verification

**Files:**
- No source edits unless verification exposes a bug.

- [ ] **Step 1: Run focused deterministic tests**

```powershell
node tools\scripts\test-card-scope.mjs
node tools\scripts\test-settings.mjs
node tools\scripts\test-cards.mjs
node tools\scripts\test-runtime.mjs
node tools\scripts\test-ui.mjs
```

Expected:

```text
[pass] card-scope
[pass] settings
[pass] cards
[pass] runtime
[pass] ui
```

- [ ] **Step 2: Run broader repo gate**

Use `npm.cmd`, not `npm`, on this Windows machine:

```powershell
npm.cmd test
```

Expected: all configured deterministic tests pass.

- [ ] **Step 3: Run alpha gate if available**

```powershell
node tools\scripts\run-alpha-gate.mjs
```

Expected: gate passes or reports only known unrelated live-host/documentation-render gaps.

- [ ] **Step 4: Optional live smoke**

Run only with dedicated soak user and provider setup:

```powershell
node tools\scripts\smoke-sillytavern-live.mjs --strict
```

Expected:

- served extension freshness passes;
- Manual cap proof passes;
- Manual selected families are covered or explicitly omitted;
- no screenshots/traces are written during generation-enabled proof.

- [ ] **Step 5: Final commit**

If verification required follow-up fixes:

```powershell
git add <changed-files>
git commit -m "fix: complete manual forced card behavior"
```

If no follow-up fixes were needed, no extra commit is required.

---

## Implementation Notes

- Use `rg` first for locating existing helper seams.
- Do not rewrite the card catalog.
- Do not add legacy compatibility for old pre-alpha settings shapes.
- Keep one-card-per-family provider generation.
- Keep raw provider prompts/responses out of diagnostics.
- Do not touch unrelated dirty files when executing this plan.
- If current worktree already has user edits in design docs or UI files, read and patch around them rather than reverting.

## Plan Self-Review

Spec coverage:

- Manual selected families mandatory: Tasks 4 and 5.
- Max Cards selection cap: Tasks 1 and 3.
- Cap notice: Task 3.
- Family vs facet semantics: Tasks 1, 3, and 6.
- Cache reuse or generation: Task 4.
- Forced-first final hand: Task 5.
- Docs and live proof: Tasks 6 and 7.

Open-ended marker scan:

- No unfinished markers or open-ended implementation gaps are intentionally present.

Type consistency:

- `manualSelectionCap`, `manualSelectedFamilies`, `enforceManualSelectionCap`, and `setFamilyEnabledWithCap` are introduced in Task 1 and reused by later tasks.
- Runtime helper `reconcileManualForcedCardJobs(...)` returns `forcedFamilies`, `reusedFamilies`, `synthesizedFamilies`, and `diagnostics`, all consumed in Task 4.
