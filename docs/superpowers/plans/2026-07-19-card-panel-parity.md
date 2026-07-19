# Card Panel Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Pre-process and Post-process Cards one panel language, functional bundled-deck state controls, bulk eye actions, and paired directional card icons.

**Architecture:** Keep bundled deck structure immutable while persisting operator-owned state overlays in each deck-settings object. Render both panels with the existing compact card-panel primitives, route all selection mutations through settings-aware helpers, and generate both main-bar icons from one inline composite SVG helper.

**Tech Stack:** JavaScript ES modules, DOM rendering in `src/ui.mjs`, CSS theme variables, Node assertion scripts, Playwright visual proof.

## Global Constraints

- Recursion is pre-alpha; update the current V1 contract in place without compatibility shims.
- Bundled deck names, categories, card content, and order remain read-only.
- Bundled Pre-process card selection and bundled Post-process enabled state are operator-editable.
- Pre-process Auto cycles `off -> active -> priority -> off`; Manual cycles `off -> active -> off`.
- Post-process state remains binary.
- Post-process header order is `On/Off`, Apply, Flow, open eye, slashed eye.
- The supplied arrow path is `M17,12,5,21V3Z`.
- Arrow stroke uses the SillyTavern foreground token and fill uses `--recursion-bg`.
- Preserve unrelated dirty proof-harness and visual-baseline changes already in the worktree.

---

### Task 1: Persist Bundled-deck State Overlays

**Files:**
- Modify: `src/pre-process-decks.mjs`
- Modify: `src/post-process-decks.mjs`
- Test: `tools/scripts/test-pre-process-decks.mjs`
- Test: `tools/scripts/test-post-process-decks.mjs`

**Interfaces:**
- Produces: `updateActivePreProcessDeckSelection(settings, nextDeck) -> normalized preProcessDecks`
- Produces: `setAllPostProcessCardsEnabled(settings, enabled) -> normalized postProcessDecks`
- Produces: bundled settings keys `defaultCardStates`, `starterCategoryStates`, and `starterCardStates`
- Consumes: existing `normalizeCardDeckSettings`, `normalizePostProcessDeckSettings`, and active-deck readers

- [ ] **Step 1: Write failing bundled Pre-process state tests**

Add assertions proving normalization preserves only known `off|active|priority`
overrides, the active bundled deck receives those overrides, and a next bundled
deck persists states without becoming a custom structural deck:

```js
const defaultWithPriority = getActiveCardDeck({
  preProcessDecks: normalizeCardDeckSettings({
    activeDeckId: DEFAULT_PRE_PROCESS_DECK_ID,
    defaultCardStates: { [firstCardId]: 'priority', missing: 'off' }
  })
});
assertEqual(defaultWithPriority.cards[firstCardId].selectionState, 'priority');

const defaultStateUpdate = updateActivePreProcessDeckSelection(
  { activeDeckId: DEFAULT_PRE_PROCESS_DECK_ID, customDecks: {} },
  updateCardSelectionState(defaultWithPriority, firstCardId, 'off')
);
assertEqual(defaultStateUpdate.defaultCardStates[firstCardId], 'off');
assertDeepEqual(defaultStateUpdate.customDecks, {});
```

- [ ] **Step 2: Write failing bundled Post-process state tests**

Add assertions proving starter category/card overlays are normalized, applied,
and changed by both bulk operations:

```js
const starterOff = setAllPostProcessCardsEnabled(
  { activeDeckId: STARTER_POST_PROCESS_DECK_ID, customDecks: {} },
  false
);
assert(Object.values(starterOff.starterCardStates).every((state) => state === false));
assert(
  Object.values(getActivePostProcessDeck(starterOff).cards)
    .every((card) => card.enabled === false)
);

const starterOn = setAllPostProcessCardsEnabled(starterOff, true);
assert(
  Object.values(getActivePostProcessDeck(starterOn).cards)
    .every((card) => card.enabled === true)
);
```

- [ ] **Step 3: Run deck tests to verify RED**

Run:

```powershell
node tools/scripts/test-pre-process-decks.mjs
node tools/scripts/test-post-process-decks.mjs
```

Expected: imports or assertions fail because the settings-aware mutation
helpers and bundled overlays do not exist.

- [ ] **Step 4: Implement Pre-process bundled selection overlays**

Normalize `defaultCardStates` against the IDs from `createDefaultCardDeck()`.
Overlay them in `getAllCardDecks()`. Persist custom decks normally and bundled
selection through the settings map:

```js
export function updateActivePreProcessDeckSelection(settings = {}, nextDeck = {}) {
  const source = normalizeCardDeckSettings(settings);
  if (nextDeck?.id !== DEFAULT_PRE_PROCESS_DECK_ID) {
    return upsertCustomCardDeck({ preProcessDecks: source }, nextDeck);
  }
  const bundled = createDefaultCardDeck();
  const defaultCardStates = Object.fromEntries(
    Object.keys(bundled.cards).map((id) => [
      id,
      cardSelectionState(nextDeck.cards?.[id] || bundled.cards[id])
    ])
  );
  return normalizeCardDeckSettings({ ...source, defaultCardStates });
}
```

Keep `readonly: true`; only state mutation uses this helper.

- [ ] **Step 5: Implement Post-process starter state overlays and bulk helper**

Normalize `starterCategoryStates` and `starterCardStates` against starter IDs,
overlay them in `getActivePostProcessDeck()`, and persist custom/starter decks
through one settings-aware helper. `setAllPostProcessCardsEnabled(settings,
true)` enables every structurally runnable starter/custom card and its category;
`false` disables every structurally runnable card.

```js
export function setAllPostProcessCardsEnabled(settings = {}, enabled = true) {
  const source = normalizePostProcessDeckSettings(settings);
  const deck = getActivePostProcessDeck(source);
  const next = clone(deck);
  for (const category of Object.values(next.categories)) {
    const eligible = Object.values(next.cards).filter((card) =>
      card.categoryId === category.id
      && normalizePostProcessName(card.name)
      && String(card.promptText || '').trim()
    );
    if (enabled && eligible.length) category.enabled = true;
    for (const card of eligible) card.enabled = enabled;
  }
  return updateActivePostProcessDeckState(source, next);
}
```

- [ ] **Step 6: Run deck tests to verify GREEN**

Run the two commands from Step 3.

Expected: both scripts print their `[pass]` lines.

### Task 2: Repair Interactions and Align the Post-process Panel

**Files:**
- Modify: `src/ui.mjs`
- Modify: `src/ui/cards-panel.mjs`
- Modify: `styles/recursion.css`
- Test: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: Task 1 settings-aware helpers
- Produces: Post-process selectors `recursionPostProcessActivateAll` and `recursionPostProcessDeactivateAll`
- Produces: shared compact header/action and category/card layout

- [ ] **Step 1: Replace outdated UI assertions with failing bundled-state tests**

Change the tests that currently expect the Default deck eye controls and card
rows to be read-only. Prove the Default row cycles three states without
creating a custom deck and both eyes write `preProcessDecks.defaultCardStates`.

Add Post-process assertions proving:

```js
assert(root.querySelector('[data-recursion-post-process-activate-all]'));
assert(root.querySelector('[data-recursion-post-process-deactivate-all]'));
root.querySelector('[data-recursion-post-process-deactivate-all]').click();
assert(
  Object.values(settingsUpdates.at(-1).postProcessDecks.starterCardStates)
    .every((state) => state === false)
);
root.querySelector('[data-recursion-post-process-activate-all]').click();
assert(
  Object.values(settingsUpdates.at(-1).postProcessDecks.starterCardStates)
    .every((state) => state === true)
);
```

Also assert header DOM order:

```js
const controls = root.querySelector('[data-recursion-post-process-head-actions]').children;
assertDeepEqual(
  controls.map((node) => node.dataset.recursionPostProcessControl),
  ['enabled', 'apply', 'flow', 'activate-all', 'deactivate-all']
);
```

- [ ] **Step 2: Run focused UI test to verify RED**

Run: `npm.cmd run test:ui`

Expected: failure at the new bundled-state or Post-process bulk-action
assertion.

- [ ] **Step 3: Route Pre-process selection through the settings-aware helper**

Keep structural edit guards for bundled decks. Remove `readonly` from only the
row-state and bulk-state guards. Replace `upsertCustomCardDeck(...)` in those
three handlers with:

```js
applyCardDeckSettings(
  updateActivePreProcessDeckSelection(
    view.settings?.preProcessDecks,
    updateCardSelectionState(deck, card.id, nextState)
  ),
  cardSelectionResultStatus(nextState)
);
```

Use the same helper after `activateAllRunnableDeckCards(deck)` and
`deactivateAllRunnableDeckCards(deck)`.

- [ ] **Step 4: Render the Post-process header action cluster**

Move global On/Off, Apply, Flow, and both bulk eye controls into
`recursion-post-process-head-actions`. Keep paired labels visible:

```js
const headActions = el('span', {
  className: 'recursion-cards-head-actions recursion-post-process-head-actions',
  dataset: { recursionPostProcessHeadActions: '' }
}, [
  postProcessEnabledControl(),
  postProcessSegmentGroup('apply', ...),
  postProcessSegmentGroup('flow', ...),
  cardSystemIconButton('eye-active', activateTitle, {
    recursionPostProcessActivateAll: '',
    recursionPostProcessControl: 'activate-all'
  }, { disabled: activateDisabled }),
  cardSystemIconButton('eye-inactive', deactivateTitle, {
    recursionPostProcessDeactivateAll: '',
    recursionPostProcessControl: 'deactivate-all'
  }, { disabled: deactivateDisabled })
]);
```

Remove the former two full-width options rows.

- [ ] **Step 5: Render Post-process categories/cards with Pre-process geometry**

Use the same disclosure column, copy column, and action column class family as
Pre-process while retaining Post-process-specific datasets and binary state.
Do not merge stores or introduce Priority.

- [ ] **Step 6: Wire Post-process bulk handlers**

Both handlers call `setAllPostProcessCardsEnabled(current settings, boolean)`
through `applyPostProcessDeckSettings`. They remain functional on the bundled
starter deck; only structural authoring controls remain read-only.

- [ ] **Step 7: Implement compact responsive CSS**

Match Pre-process header heights, row borders, typography, and full-width card
rows. Allow the header action cluster to wrap below 720px without hiding
controls. Remove obsolete `.recursion-post-process-options` and
`.recursion-post-process-option-row` layout rules.

- [ ] **Step 8: Run UI tests to verify GREEN**

Run: `npm.cmd run test:ui`

Expected: `[pass] ui`.

### Task 3: Add Shared Directional Card Icons

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Test: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Produces: `processCardsIconSvg(direction) -> SVGElement`
- Consumes: supplied arrow geometry and existing stacked-card rectangles

- [ ] **Step 1: Add failing icon structure and theme tests**

Assert both buttons own three stacked-card rectangles and one arrow path, the
Pre-process arrow has the left transform, the Post-process arrow does not, and
CSS assigns theme-backed stroke/fill:

```js
const preIcon = root.querySelector('[data-recursion-pre-process-cards-icon]');
const postIcon = root.querySelector('[data-recursion-post-process-cards-icon]');
assertEqual(preIcon.querySelectorAll('rect').length, 3);
assertEqual(postIcon.querySelectorAll('rect').length, 3);
assertEqual(
  preIcon.querySelector('[data-recursion-process-arrow]').getAttribute('transform'),
  'rotate(180 11 6)'
);
assertEqual(
  postIcon.querySelector('[data-recursion-process-arrow]').getAttribute('transform'),
  null
);
```

- [ ] **Step 2: Run UI test to verify RED**

Run: `npm.cmd run test:ui`

Expected: missing composite icon selector or arrow assertion failure.

- [ ] **Step 3: Implement one composite SVG helper**

Build both icons from the existing `17 17` card geometry and the supplied path.
Place the arrow in a nested transform scaled into the foremost card:

```js
function processCardsIconSvg(direction = 'post') {
  const arrowTransform = direction === 'pre'
    ? 'rotate(180 11 6)'
    : undefined;
  return el('svg', {
    attrs: { width: '17', height: '17', viewBox: '0 0 17 17', 'aria-hidden': 'true' },
    dataset: { [`recursion${direction === 'pre' ? 'Pre' : 'Post'}ProcessCardsIcon`]: '' }
  }, [
    ...stackedCardRects(),
    el('g', { attrs: { transform: 'translate(8.2 3.1) scale(.24)' } }, [
      el('path', {
        attrs: { d: 'M17,12,5,21V3Z', transform: arrowTransform },
        dataset: { recursionProcessArrow: direction }
      })
    ])
  ]);
}
```

Tune only the translate/scale values during visual verification; retain the
source path and direction contract.

- [ ] **Step 4: Apply theme colors**

```css
.recursion-process-cards-icon [data-recursion-process-arrow] {
  fill: var(--recursion-bg);
  stroke: var(--SmartThemeBodyColor, #d8d8d8);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}
```

Both icon containers remain 15-by-15 inside 24-by-24 buttons.

- [ ] **Step 5: Run UI test to verify GREEN**

Run: `npm.cmd run test:ui`

Expected: `[pass] ui`.

### Task 4: Align Contracts and Verify

**Files:**
- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Modify: `docs/superpowers/specs/2026-07-19-pre-post-process-card-panel-parity-design.md`
- Verify without modifying: `tools/scripts/prove-card-system-ui.mjs`
- Verify without modifying: `tools/scripts/prove-post-process-cards-ui.mjs`

**Interfaces:**
- Consumes: Tasks 1-3
- Produces: current V1 documentation and fresh verification evidence

- [ ] **Step 1: Update the visible contract**

Document that bundled decks are structurally read-only but their operator state
is mutable. Replace the outdated requirement to duplicate before using bulk
state actions. Record the shared directional icon and Post-process header
control order.

- [ ] **Step 2: Run focused tests**

```powershell
node tools/scripts/test-pre-process-decks.mjs
node tools/scripts/test-post-process-decks.mjs
npm.cmd run test:ui
```

Expected: all three print `[pass]`.

- [ ] **Step 3: Run broader regression tests**

```powershell
npm.cmd test
```

Expected: exit code `0` and no failing script.

- [ ] **Step 4: Run non-promoting browser proofs**

Run the existing Pre-process and Post-process UI proofs without any
baseline-update environment variable:

```powershell
npm.cmd run prove:card-system-ui
npm.cmd run prove:post-process-ui
```

Expected: functional scenarios pass. If visual comparison reports the intended
layout delta, inspect the newly produced artifact screenshots without staging
or modifying the user's existing baseline changes.

- [ ] **Step 5: Inspect final screenshots**

Confirm at desktop and compact widths:

- matching panel structure;
- Apply/Flow before two Post-process eye buttons;
- legible left/right arrows inside the same stacked-card glyph;
- no clipped header controls;
- no new dashboard-like spacing.

- [ ] **Step 6: Review the complete diff**

Run:

```powershell
git diff --check
git status --short
git diff -- src/pre-process-decks.mjs src/post-process-decks.mjs src/ui.mjs styles/recursion.css DESIGN.md docs/design/UI_SPEC.md docs/user/RECURSION_OPERATOR_MANUAL.md tools/scripts/test-pre-process-decks.mjs tools/scripts/test-post-process-decks.mjs tools/scripts/test-ui.mjs
```

Expected: no whitespace errors; only task-owned source, tests, and docs are
reported in the scoped diff. Existing user-owned proof/baseline modifications
remain unaltered.
