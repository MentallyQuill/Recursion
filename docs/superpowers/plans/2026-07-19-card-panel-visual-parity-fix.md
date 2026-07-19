# Card Panel Visual Parity Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Pre-process Cards and Post-process Cards dropdowns use one enforced panel layout, fix the misplaced Pre-process card eyes, and preserve their intentional state and content differences.

**Architecture:** Replace the two parallel layout systems with shared structural classes and renderer primitives in `src/ui/cards-panel.mjs`. Keep phase-specific datasets, state transitions, authoring controls, and hook classes in `src/ui.mjs`, but render both phases through the same header, deck toolbar, category, card-row, state-marker, conditional action-rail, list-scroll, and footer geometry. Prove parity with DOM-contract assertions plus live computed-geometry checks instead of relying only on independent screenshots.

**Tech Stack:** JavaScript ES modules, DOM rendering in `src/ui.mjs`, shared view primitives in `src/ui/cards-panel.mjs`, SillyTavern theme-backed CSS, Node assertion scripts, Playwright live proof.

## Why This Corrective Plan Exists

The earlier plan, `docs/superpowers/plans/2026-07-19-card-panel-parity.md`, correctly repaired bundled-deck state persistence, bulk actions, and the paired main-bar icons. Its visual-parity task did not enforce a shared DOM or CSS contract:

- Pre-process still renders `recursion-card-deck-*` rows directly.
- Post-process still renders `recursion-post-process-*` rows through permissive wrappers.
- `renderDeckBar`, `renderDeckCategory`, and `renderDeckCard` accept arbitrary class families, so they do not make the panels structurally identical.
- Pre-process always reserves a `124px` action rail, even on the read-only Default deck where the rail is empty. Its eye therefore lands approximately `124px` left of the intended right inset.
- The separate visual proofs can both pass against separate baselines while the panels disagree with each other.

This document supersedes only the layout, styling, and parity-verification portion of the earlier plan. The implemented state overlays, binary versus three-state behavior, bulk actions, and directional bar icons remain authoritative.

## Global Constraints

- Recursion is pre-alpha; update the current V1 contract in place without compatibility shims.
- Read `DESIGN.md` and `docs/design/UI_SPEC.md` before changing visible UI.
- Both card phases must use the same structural panel classes and DOM order.
- Bundled deck names, category/card content, category/card order, and structural authoring remain read-only.
- Bundled operator state remains writable.
- Pre-process Auto cycles `off -> active -> priority -> off`.
- Pre-process Manual cycles `off -> active -> off`.
- Post-process categories and cards remain binary `on <-> off`.
- Post-process header order remains summary, global On/Off, Apply, Flow, open eye, slashed eye.
- Post-process card descriptions remain visible as a compact secondary line. Content-driven row height is allowed; shell geometry is not allowed to drift.
- `source cards` and `runnable cards` remain phase-specific wording.
- Post-process retains its category-level eye. Pre-process does not gain category enable/disable semantics.
- Structural action rails exist only when structural actions are rendered.
- On a row without structural actions, the state eye must use the shared right inset rather than reserving an empty rail.
- On an editable row, the state eye sits immediately left of the structural action rail.
- Both panels use list-only vertical scrolling; header, deck toolbar, and footer remain outside the scrolling list.
- Preserve unrelated dirty visual baselines and proof-harness changes already in the worktree.
- Do not update visual baselines until fresh screenshots have been inspected and approved.
- `default-user` is for the user's human verification. Sync and hash-check it, but do not drive an automated generation.

## Canonical DOM Contract

Both panels must render this structural shape. Phase-specific classes and datasets may be added, but none may replace the shared classes.

```html
<div class="recursion-cards-panel recursion-card-panel">
  <header class="recursion-card-panel-head">
    <span class="recursion-dropdown-title"></span>
    <span class="recursion-card-panel-head-actions">
      <span class="recursion-card-panel-summary"></span>
      <!-- phase-specific controls -->
    </span>
  </header>

  <div class="recursion-card-panel-deck-bar">
    <span class="recursion-card-panel-deck-selector">
      <select class="recursion-input recursion-select recursion-card-deck-select"></select>
    </span>
    <span class="recursion-card-panel-deck-actions"></span>
  </div>

  <div class="recursion-card-panel-list">
    <section class="recursion-card-panel-category is-expanded">
      <div class="recursion-card-panel-category-head" role="button" tabindex="0">
        <span class="recursion-card-panel-disclosure"></span>
        <span class="recursion-card-panel-category-copy"></span>
        <button class="recursion-card-panel-category-state"></button>
        <span class="recursion-card-panel-row-actions"></span>
      </div>
      <div class="recursion-card-panel-category-body">
        <div class="recursion-card-panel-card is-active">
          <button class="recursion-card-panel-card-main">
            <span class="recursion-card-panel-card-copy"></span>
            <span class="recursion-card-panel-state-marker"></span>
          </button>
          <span class="recursion-card-panel-row-actions"></span>
        </div>
      </div>
    </section>
  </div>

  <footer class="recursion-card-panel-foot"></footer>
</div>
```

Conditional class rules:

- Category head: `has-state` only when a category state control exists.
- Category head/card row: `has-actions` only when one or more structural actions exist.
- No empty `recursion-card-panel-row-actions` node is rendered.
- A Post-process category state control is the final column when `has-actions` is absent.
- A card main button spans the full row when `has-actions` is absent.

---

### Task 1: Lock the Shared Renderer Contract

**Files:**
- Modify: `src/ui/cards-panel.mjs`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Produces: `renderDeckPanelHeader(options) -> HTMLElement`
- Produces: `renderDeckToolbar(options) -> HTMLElement`
- Replaces: permissive `renderDeckBar(options)`
- Replaces: permissive `renderDeckCategory(options)` with the canonical category contract
- Replaces: permissive `renderDeckCard(options)` with the canonical card contract
- Preserves: phase-specific `className` and `dataset` hooks supplied by callers

- [ ] **Step 1: Add failing primitive-contract tests**

Replace the existing `renderDeckBar` import in `tools/scripts/test-ui.mjs` with `renderDeckPanelHeader` and `renderDeckToolbar`. Add a focused fake-DOM block beside the existing `cardsPanelState` assertions:

```js
const primitiveEl = (tagName, options = {}, children = []) => ({
  tagName,
  className: options.className || '',
  attrs: options.attrs || {},
  dataset: options.dataset || {},
  text: options.text || '',
  children: children.filter(Boolean)
});

const primitiveHeader = renderDeckPanelHeader({
  el: primitiveEl,
  title: 'Cards',
  summary: '3/3 active',
  controls: [primitiveEl('button', { dataset: { control: 'all-on' } })],
  className: 'phase-head'
});
assert(primitiveHeader.className.includes('recursion-card-panel-head'), 'deck header always owns the shared panel-head class');
assert(primitiveHeader.className.includes('phase-head'), 'deck header retains its phase hook class');
assertEqual(primitiveHeader.children[1].className, 'recursion-card-panel-head-actions', 'summary and controls share one right action cluster');
assertEqual(primitiveHeader.children[1].children[0].className, 'recursion-card-panel-summary', 'summary is the first right-cluster item');

const primitiveToolbar = renderDeckToolbar({
  el: primitiveEl,
  selector: primitiveEl('select'),
  actions: [primitiveEl('button')]
});
assertEqual(primitiveToolbar.className, 'recursion-card-panel-deck-bar', 'deck toolbar always owns the shared bar class');
assertEqual(primitiveToolbar.children[0].className, 'recursion-card-panel-deck-selector', 'selector uses the shared growable wrapper');
assertEqual(primitiveToolbar.children[1].className, 'recursion-card-panel-deck-actions', 'deck actions use the shared right cluster');

const readonlyCard = renderDeckCard({
  el: primitiveEl,
  card: { id: 'card-a' },
  copy: primitiveEl('span'),
  state: primitiveEl('span'),
  actions: []
});
assert(!readonlyCard.className.includes('has-actions'), 'rows without authoring controls do not reserve an action rail');
assertEqual(readonlyCard.children.length, 1, 'rows without authoring controls do not render an empty action node');

const editableCard = renderDeckCard({
  el: primitiveEl,
  card: { id: 'card-b' },
  copy: primitiveEl('span'),
  state: primitiveEl('span'),
  actions: [primitiveEl('button')]
});
assert(editableCard.className.includes('has-actions'), 'editable rows opt into the action rail');
assertEqual(editableCard.children.length, 2, 'editable rows render main and action regions');
```

- [ ] **Step 2: Run the UI test to verify RED**

Run:

```powershell
npm.cmd run test:ui
```

Expected: import failure for `renderDeckPanelHeader` or the first shared-class assertion fails.

- [ ] **Step 3: Replace the permissive primitives with canonical renderers**

Replace `renderDeckBar`, `renderDeckCategory`, and `renderDeckCard` in `src/ui/cards-panel.mjs` and add `renderDeckToolbar`:

```js
function classNames(...values) {
  return values
    .flatMap((value) => String(value || '').trim().split(/\s+/))
    .filter(Boolean)
    .join(' ');
}

function presentChildren(children = []) {
  return children.filter((child) => child !== null && child !== undefined);
}

export function renderDeckPanelHeader(options = {}) {
  const el = requireElementFactory(options);
  const {
    title = '',
    summary = '',
    controls = [],
    className = '',
    actionsClassName = '',
    dataset = {}
  } = options;
  return el('header', {
    className: classNames('recursion-card-panel-head', className),
    dataset
  }, [
    el('span', { className: 'recursion-dropdown-title', text: title }),
    el('span', {
      className: classNames('recursion-card-panel-head-actions', actionsClassName)
    }, [
      summary
        ? el('span', { className: 'recursion-card-panel-summary', text: summary })
        : null,
      ...controls
    ].filter(Boolean))
  ]);
}

export function renderDeckToolbar(options = {}) {
  const el = requireElementFactory(options);
  const {
    selector,
    actions = [],
    className = '',
    selectorClassName = '',
    actionsClassName = '',
    dataset = {}
  } = options;
  return el('div', {
    className: classNames('recursion-card-panel-deck-bar', className),
    dataset
  }, [
    el('span', {
      className: classNames('recursion-card-panel-deck-selector', selectorClassName)
    }, [selector]),
    el('span', {
      className: classNames('recursion-card-panel-deck-actions', actionsClassName)
    }, presentChildren(actions))
  ]);
}

export function renderDeckCategory(options = {}) {
  const el = requireElementFactory(options);
  const {
    className = '',
    category = {},
    expanded = true,
    disclosure,
    copy,
    state = null,
    actions = [],
    auxiliary = [],
    body = [],
    dataset = {},
    headerDataset = {},
    headerClassName = '',
    bodyClassName = '',
    headerTitle = ''
  } = options;
  const presentActions = presentChildren(actions);
  const headClassName = classNames(
    'recursion-card-panel-category-head',
    headerClassName,
    state ? 'has-state' : '',
    presentActions.length ? 'has-actions' : ''
  );
  return el('section', {
    className: classNames(
      'recursion-card-panel-category',
      expanded ? 'is-expanded' : 'is-collapsed',
      className
    ),
    attrs: {
      'data-category-id': String(category.id || ''),
      'aria-label': String(category.name || 'Card category')
    },
    dataset
  }, [
    el('div', {
      className: headClassName,
      attrs: {
        role: 'button',
        tabindex: '0',
        title: headerTitle,
        'aria-expanded': expanded ? 'true' : 'false'
      },
      dataset: headerDataset
    }, [
      el('span', {
        className: 'recursion-card-panel-disclosure',
        attrs: { 'aria-hidden': 'true' }
      }, [disclosure]),
      copy,
      state,
      presentActions.length
        ? el('span', { className: 'recursion-card-panel-row-actions' }, presentActions)
        : null
    ].filter(Boolean)),
    ...presentChildren(auxiliary),
    el('div', {
      className: classNames('recursion-card-panel-category-body', bodyClassName),
      attrs: expanded ? {} : { hidden: '' }
    }, presentChildren(body))
  ]);
}

export function renderDeckCard(options = {}) {
  const el = requireElementFactory(options);
  const {
    className = '',
    card = {},
    copy,
    state,
    actions = [],
    attrs = {},
    dataset = {},
    mainAttrs = {},
    mainDataset = {},
    mainClassName = '',
    actionsClassName = ''
  } = options;
  const presentActions = presentChildren(actions);
  return el('div', {
    className: classNames(
      'recursion-card-panel-card',
      presentActions.length ? 'has-actions' : '',
      className
    ),
    attrs: {
      ...attrs,
      'data-card-id': String(card.id || '')
    },
    dataset
  }, [
    el('button', {
      className: classNames('recursion-card-panel-card-main', mainClassName),
      attrs: { type: 'button', ...mainAttrs },
      dataset: mainDataset
    }, [copy, state].filter(Boolean)),
    presentActions.length
      ? el('span', {
        className: classNames('recursion-card-panel-row-actions', actionsClassName)
      }, presentActions)
      : null
  ].filter(Boolean));
}
```

Remove the now-unused `appendChildren` helper. Do not keep `renderDeckBar` as a compatibility alias; all callers are updated in Task 2.

- [ ] **Step 4: Run primitive tests to verify GREEN**

Run:

```powershell
npm.cmd run test:ui
```

Expected: the new primitive assertions pass. Later renderer-source assertions may still fail until Tasks 2 and 3 are complete.

---

### Task 2: Migrate the Panel Shells, Headers, Deck Toolbars, Lists, and Footers

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `tools/scripts/prove-post-process-cards-ui.mjs`

**Interfaces:**
- Consumes: `renderDeckPanelHeader` and `renderDeckToolbar` from Task 1
- Produces: shared classes on both live panels
- Preserves: existing phase-specific datasets used by event delegation and Playwright

- [ ] **Step 1: Add failing mounted-DOM assertions**

After both panels have rendered in the existing mounted UI test, add:

```js
const prePanel = root.querySelector('[data-recursion-cards-panel]');
const postPanel = root.querySelector('[data-recursion-post-process-panel]');
for (const panel of [prePanel, postPanel]) {
  assert(panel.className.includes('recursion-card-panel'), 'both phases use the shared panel shell');
  assert(panel.querySelector('.recursion-card-panel-head'), 'both phases use the shared header');
  assert(panel.querySelector('.recursion-card-panel-deck-bar'), 'both phases use the shared deck toolbar');
  assert(panel.querySelector('.recursion-card-panel-list'), 'both phases use the shared list');
  assert(panel.querySelector('.recursion-card-panel-foot'), 'both phases use the shared footer');
}

assertDeepEqual(
  root.querySelector('[data-recursion-post-process-header-actions]').children
    .map((child) => child.dataset?.recursionPostProcessControl)
    .filter(Boolean),
  ['enabled', 'apply', 'flow', 'activate-all', 'deactivate-all'],
  'Post-process phase controls remain in approved order after the shared summary'
);

const postDeckActions = root.querySelector('.recursion-post-process-deck-actions').children;
assertDeepEqual(
  postDeckActions.map((node) => (
    Object.keys(node.dataset || {}).find((key) => key.startsWith('recursionPostProcessDeck'))
  )),
  [
    'recursionPostProcessDeckNew',
    'recursionPostProcessDeckDuplicate',
    'recursionPostProcessDeckEdit',
    'recursionPostProcessDeckDelete'
  ],
  'Post-process deck actions match the Pre-process New, Duplicate, Rename, Delete order'
);

assert(
  root.querySelector('[data-recursion-post-process-deck-select]').className.includes('recursion-input')
  && root.querySelector('[data-recursion-post-process-deck-select]').className.includes('recursion-select'),
  'Post-process selector uses the same input skin as Pre-process'
);
assert(
  !root.querySelector('[data-recursion-post-process-header]').textContent.includes('structure read-only'),
  'read-only structure is communicated by disabled authoring controls rather than unique header copy'
);
```

- [ ] **Step 2: Run the UI test to verify RED**

Run:

```powershell
npm.cmd run test:ui
```

Expected: missing shared shell/header/deck/list/footer classes.

- [ ] **Step 3: Update imports and render the Pre-process shell through shared primitives**

Update the `src/ui.mjs` import to consume:

```js
import {
  renderDeckCard,
  renderDeckCategory,
  renderDeckPanelHeader,
  renderDeckToolbar
} from './ui/cards-panel.mjs';
```

Replace the hand-built Pre-process header and deck bar with:

```js
panel.appendChild(renderDeckPanelHeader({
  el,
  className: 'recursion-cards-head',
  actionsClassName: 'recursion-cards-head-actions',
  title: 'Cards',
  summary,
  controls: [
    cardSystemIconButton(
      'eye-active',
      activateAllTitle,
      { recursionCardDeckActivateAll: '' },
      { disabled: activateAllDisabled }
    ),
    cardSystemIconButton(
      'eye-inactive',
      deactivateAllTitle,
      { recursionCardDeckDeactivateAll: '' },
      { disabled: deactivateAllDisabled }
    )
  ],
  dataset: { recursionCardPanelHeader: 'pre' }
}));

panel.appendChild(renderDeckToolbar({
  el,
  className: 'recursion-card-deck-bar',
  selector: deckSelector,
  actions: deckActions,
  selectorClassName: 'recursion-card-deck-selector',
  actionsClassName: 'recursion-card-deck-actions',
  dataset: { recursionCardDeckBar: '' }
}));
```

Give the Pre-process list and footer both shared and phase-specific classes:

```js
const deckList = el('div', {
  className: 'recursion-card-panel-list recursion-card-deck-list',
  dataset: { recursionCardDeckList: '' }
});

panel.appendChild(el('footer', {
  className: 'recursion-card-panel-foot recursion-cards-foot'
}, [
  el('span', { text: 'Active Card Deck is global. Draft cards do not run.' }),
  el('span', { className: 'recursion-mini-chip', text: 'Esc' })
]));
```

- [ ] **Step 4: Render the Post-process shell through the same primitives**

Give the selector the same input classes:

```js
const selector = el('select', {
  className: 'recursion-input recursion-select recursion-card-deck-select',
  attrs: { 'aria-label': 'Post-process Deck' },
  dataset: { recursionPostProcessDeckSelect: '' }
}, decks.map((entry) => el('option', {
  text: entry.name,
  attrs: { value: entry.id, ...(entry.id === deck.id ? { selected: '' } : {}) }
})));
```

Render the Post-process header with the count-only summary and approved control order:

```js
panel.appendChild(renderDeckPanelHeader({
  el,
  className: 'recursion-post-process-head',
  actionsClassName: 'recursion-post-process-head-actions',
  title: 'Post-process Cards',
  summary: `${counts.active}/${counts.eligible} active`,
  controls: [
    enabledControl,
    applyControl,
    flowControl,
    activateAllButton,
    deactivateAllButton
  ],
  dataset: { recursionPostProcessHeader: '' },
  actionsDataset: { recursionPostProcessHeaderActions: '' }
}));
```

Because `recursionPostProcessHeaderActions` must identify the controls wrapper rather than the header, extend `renderDeckPanelHeader` with an `actionsDataset` option:

```js
export function renderDeckPanelHeader(options = {}) {
  const el = requireElementFactory(options);
  const {
    title = '',
    summary = '',
    controls = [],
    className = '',
    dataset = {},
    actionsDataset = {},
    actionsClassName = ''
  } = options;
  return el('header', {
    className: classNames('recursion-card-panel-head', className),
    dataset
  }, [
    el('span', { className: 'recursion-dropdown-title', text: title }),
    el('span', {
      className: classNames('recursion-card-panel-head-actions', actionsClassName),
      dataset: actionsDataset
    }, [
      summary
        ? el('span', { className: 'recursion-card-panel-summary', text: summary })
        : null,
      ...controls
    ].filter(Boolean))
  ]);
}
```

Call it with:

```js
dataset: { recursionPostProcessHeader: '' },
actionsDataset: { recursionPostProcessHeaderActions: '' }
```

Render the Post-process deck toolbar in the same action order as Pre-process:

```js
panel.appendChild(renderDeckToolbar({
  el,
  className: 'recursion-post-process-deck-row',
  selector,
  actions: [blankButton, duplicateButton, renameButton, deleteButton],
  selectorClassName: 'recursion-post-process-deck-selector',
  actionsClassName: 'recursion-post-process-deck-actions',
  dataset: { recursionPostProcessDeckBar: '' }
}));
```

Give the Post-process list and new footer shared classes:

```js
const list = el('div', {
  className: 'recursion-card-panel-list recursion-post-process-list',
  dataset: { recursionPostProcessList: '' }
});

panel.appendChild(el('footer', {
  className: 'recursion-card-panel-foot recursion-post-process-foot'
}, [
  el('span', { text: 'Active Post-process Deck is global. Structure-only changes require a custom deck.' }),
  el('span', { className: 'recursion-mini-chip', text: 'Esc' })
]));
```

Add `recursion-card-panel` to both roots in `buildRoot()`:

```js
const cardsPanel = el('div', {
  className: 'recursion-cards-panel recursion-card-panel',
  attrs: { 'aria-label': 'Pre-process Cards' },
  dataset: { recursionCardsPanel: '' }
});

const postProcessPanel = el('div', {
  className: 'recursion-cards-panel recursion-card-panel recursion-post-process-panel',
  attrs: { 'aria-label': 'Post-process Cards' },
  dataset: { recursionPostProcessPanel: '' }
});
```

- [ ] **Step 5: Establish one shell, header, toolbar, list, and footer CSS**

Add the shared rules and remove conflicting declarations from `.recursion-post-process-head`, `.recursion-post-process-deck-row`, `.recursion-cards-head`, `.recursion-card-deck-bar`, `.recursion-post-process-list`, `.recursion-card-deck-list`, and `.recursion-cards-foot`:

```css
.recursion-card-panel {
  backdrop-filter: blur(12px);
  display: flex;
  flex-direction: column;
  max-height: min(72vh, 620px);
  overflow: hidden;
  padding: 0;
}

.recursion-card-panel-head {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
  min-height: 34px;
  padding: 7px 9px;
}

.recursion-card-panel-head-actions {
  align-items: center;
  display: inline-flex;
  gap: 4px;
  justify-content: flex-end;
  margin-left: auto;
  min-width: 0;
}

.recursion-card-panel-summary {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 50%, transparent);
  font-size: 10.5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recursion-card-panel-deck-bar {
  align-items: center;
  border-top: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 7%, transparent);
  display: flex;
  flex: 0 0 auto;
  gap: 5px;
  min-width: 0;
  padding: 6px 9px;
}

.recursion-card-panel-deck-selector {
  align-items: center;
  display: inline-flex;
  flex: 1 1 auto;
  min-width: 0;
}

.recursion-card-panel-deck-selector > .recursion-card-deck-select {
  flex: 1 1 auto;
  min-width: 0;
}

.recursion-card-panel-deck-actions {
  align-items: center;
  display: inline-flex;
  flex: 0 0 auto;
  gap: 4px;
  justify-content: flex-end;
  margin-left: auto;
  min-width: 0;
}

.recursion-card-panel-list {
  border-top: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 7%, transparent);
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
}

.recursion-card-panel-foot {
  align-items: center;
  border-top: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 7%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 50%, transparent);
  display: flex;
  flex: 0 0 auto;
  font-size: 10.5px;
  gap: 8px;
  justify-content: space-between;
  min-height: 34px;
  padding: 7px 9px;
}
```

Delete the Post-process-only icon-button height override:

```css
.recursion-post-process-deck-actions .recursion-icon-button,
.recursion-post-process-row-actions .recursion-icon-button
```

The shared icon-button component remains the only sizing authority.

Replace the old `recursion-card-deck-actions` geometry assertions in
`tools/scripts/test-ui.mjs` with:

```js
assert(
  /renderDeckToolbar\(\{/.test(recursionUi)
    && /actionsClassName:\s*'recursion-card-deck-actions'/.test(recursionUi)
    && /actionsClassName:\s*'recursion-post-process-deck-actions'/.test(recursionUi),
  'both phases render through the shared deck toolbar while retaining phase hooks'
);
assert(
  /\.recursion-card-panel-deck-bar\s*\{[\s\S]*?flex-wrap:\s*nowrap;/.test(recursionCss)
    || /\.recursion-card-panel-deck-bar\s*\{[\s\S]*?display:\s*flex;/.test(recursionCss),
  'shared deck toolbar owns the structural layout'
);
assert(
  /\.recursion-card-panel-deck-actions\s*\{[\s\S]*?margin-left:\s*auto;/.test(recursionCss),
  'shared deck actions align to the right'
);
```

- [ ] **Step 6: Update the stale live-proof assertion**

In `tools/scripts/prove-post-process-cards-ui.mjs`, replace:

```js
check(/read-only/i.test(starter.summary), 'Starter Post-process Deck did not identify itself as read-only.');
```

with:

```js
check(
  starter.summary.includes('6/6 active') && !/read-only/i.test(starter.summary),
  'Starter Post-process header must use the shared count-only summary.'
);
check(
  await page.locator('[data-recursion-post-process-deck-edit]').first().isDisabled()
    && await page.locator('[data-recursion-post-process-deck-delete]').first().isDisabled(),
  'Starter structural read-only state must be expressed by disabled authoring controls.'
);
```

- [ ] **Step 7: Run the focused UI test**

Run:

```powershell
npm.cmd run test:ui
```

Expected: shell/header/deck/list/footer assertions pass.

---

### Task 3: Migrate Categories, Cards, State Markers, and Conditional Action Rails

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: canonical `renderDeckCategory` and `renderDeckCard` from Task 1
- Produces: full-row Pre/Post card state targets
- Produces: full-row Pre/Post category disclosure targets
- Produces: right-inset state eyes when no structural actions exist
- Preserves: Pre-process mode-specific cycles and Post-process binary state

- [ ] **Step 1: Add failing mounted-DOM and interaction assertions**

Add these assertions while the bundled Default and Starter decks are active:

```js
const preReadonlyRow = root.querySelector('[data-recursion-card-id]');
const postReadonlyRow = root.querySelector('[data-recursion-post-process-card]');
for (const row of [preReadonlyRow, postReadonlyRow]) {
  assert(row.className.includes('recursion-card-panel-card'), 'both phases use the shared card shell');
  assert(!row.className.includes('has-actions'), 'bundled rows do not reserve empty structural action rails');
  assertEqual(row.querySelector('.recursion-card-panel-row-actions'), null, 'bundled rows render no empty action node');
  assert(row.querySelector('.recursion-card-panel-card-main'), 'both phases expose one full-row state target');
  assert(row.querySelector('.recursion-card-panel-state-marker'), 'both phases use the shared state marker');
}

const preCategory = root.querySelector('[data-recursion-card-deck-category]');
const postCategory = root.querySelector('[data-recursion-post-process-category]');
for (const category of [preCategory, postCategory]) {
  assert(category.className.includes('recursion-card-panel-category'), 'both phases use the shared category shell');
  assert(category.querySelector('.recursion-card-panel-disclosure svg'), 'both phases use the shared chevron disclosure');
  assert(category.querySelector('.recursion-card-panel-category-body'), 'both phases use the shared category body grid');
}

assertEqual(
  postCategory.querySelector('.recursion-post-process-expander'),
  null,
  'Post-process no longer renders a separate plus/minus expander button'
);

const postCardToggle = postReadonlyRow.querySelector('[data-recursion-post-process-card-toggle]');
assert(postCardToggle.className.includes('recursion-card-panel-card-main'), 'Post-process binary toggle owns the full card main region');
const beforePostPressed = postCardToggle.getAttribute('aria-pressed');
postCardToggle.click();
assert(
  root.querySelector('[data-recursion-post-process-card-toggle]').getAttribute('aria-pressed') !== beforePostPressed,
  'Post-process full-row click toggles binary card state'
);
```

After duplicating each deck in the existing tests, assert:

```js
assert(
  root.querySelector('[data-recursion-card-id]').className.includes('has-actions'),
  'editable Pre-process cards opt into the shared action rail'
);
assert(
  root.querySelector('[data-recursion-post-process-card]').className.includes('has-actions'),
  'editable Post-process cards opt into the shared action rail'
);
```

- [ ] **Step 2: Run the UI test to verify RED**

Run:

```powershell
npm.cmd run test:ui
```

Expected: first missing shared card/category class or plus/minus expander assertion fails.

- [ ] **Step 3: Render Pre-process categories through the canonical primitive**

Replace the hand-built Pre-process section with:

```js
const categoryCopy = el('span', {
  className: 'recursion-card-panel-category-copy recursion-card-deck-category-copy'
}, [
  el('strong', { text: category.name }),
  el('span', {
    text: `${runnableCategoryCards.length} source card${runnableCategoryCards.length === 1 ? '' : 's'}${priorityCategoryCards.length ? ` - ${priorityCategoryCards.length} priority` : ''}${categoryDensityWarning ? ' - focus may be diluted' : ''}`
  }),
  ...(category.description ? [el('span', { text: category.description })] : [])
]);

const categoryBody = [];
if (categoryExpanded) {
  for (const card of categoryCards) {
    const cardDeletePending = deleteConfirmFor(deleteState, 'card', activeDeck.id, card.id);
    const presentation = cardDeckCardStatePresentation(card, normalizeMode(view.settings?.mode));
    const cardActions = !activeDeck.readonly ? [
      cardSystemIconButton('pencil', 'Edit card', { recursionCardEdit: card.id }),
      cardSystemIconButton('copy', 'Duplicate card', { recursionCardDuplicate: card.id }),
      deleteActionSlot('card', card.id, cardDeletePending),
      cardDragHandle('card', card.id, 'Drag to reorder card or move to another category', {
        disabled: cardDeletePending
      })
    ] : [];
    const cardCopy = el('span', {
      className: 'recursion-card-panel-card-copy recursion-card-deck-card-copy'
    }, [
      el('span', {
        className: 'recursion-card-panel-card-name recursion-card-deck-card-name',
        text: card.name || NEW_CARD_NAME
      })
    ]);
    const stateMarker = el('span', {
      className: 'recursion-card-panel-state-marker recursion-card-deck-card-status',
      attrs: { title: presentation.title, 'aria-label': presentation.label }
    }, [cardSystemIconSvg(presentation.icon)]);
    const cardRow = renderDeckCard({
      el,
      className: `recursion-card-deck-card ${presentation.className} ${cardDeletePending ? 'is-delete-pending' : ''}`,
      card,
      copy: cardCopy,
      state: stateMarker,
      actions: cardActions,
      attrs: { title: card.description || presentation.title },
      dataset: { recursionCardId: card.id },
      mainAttrs: {
        title: presentation.title,
        'aria-label': `${presentation.label}. ${presentation.title}`
      },
      mainDataset: { recursionCardToggleRow: card.id },
      mainClassName: 'recursion-card-deck-card-main',
      actionsClassName: 'recursion-card-deck-card-actions'
    });
    categoryBody.push(cardRow);
    const inlineEditor = renderCardEditorInline(activeDeck, card, editorState);
    if (inlineEditor) categoryBody.push(inlineEditor);
  }
}
const categoryEditor = renderCategoryEditorInline(activeDeck, category, categoryEditorState);

const section = renderDeckCategory({
  el,
  className: `recursion-card-deck-category ${categoryDeletePending ? 'is-delete-pending' : ''}`,
  category,
  expanded: categoryExpanded,
  disclosure: cardSystemIconSvg(categoryExpanded ? 'chevron-up' : 'chevron-down'),
  copy: categoryCopy,
  actions: categoryActions,
  dataset: {
    recursionCardCategory: category.id,
    recursionCardDeckCategory: category.id,
    recursionCardCategoryExpanded: categoryExpanded ? 'true' : 'false'
  },
  headerDataset: { recursionCardCategoryToggle: category.id },
  headerClassName: 'recursion-card-deck-category-head',
  bodyClassName: 'recursion-card-deck-category-body',
  headerTitle: categoryExpanded ? 'Collapse category' : 'Expand category',
  auxiliary: categoryEditor ? [categoryEditor] : [],
  body: categoryBody
});
```

Category editors stay directly below the header, while card editors stay
directly after their owning row in the body.

- [ ] **Step 4: Render Pre-process cards through the canonical primitive**

Replace the hand-built card row with:

```js
const cardCopy = el('span', {
  className: 'recursion-card-panel-card-copy recursion-card-deck-card-copy'
}, [
  el('span', {
    className: 'recursion-card-panel-card-name recursion-card-deck-card-name',
    text: card.name || NEW_CARD_NAME
  })
]);

const stateMarker = el('span', {
  className: 'recursion-card-panel-state-marker recursion-card-deck-card-status',
  attrs: { title: presentation.title, 'aria-label': presentation.label }
}, [cardSystemIconSvg(presentation.icon)]);

const cardRow = renderDeckCard({
  el,
  className: `recursion-card-deck-card ${presentation.className} ${cardDeletePending ? 'is-delete-pending' : ''}`,
  card,
  copy: cardCopy,
  state: stateMarker,
  actions: cardActions,
  attrs: { title: card.description || presentation.title },
  dataset: { recursionCardId: card.id },
  mainAttrs: {
    title: presentation.title,
    'aria-label': `${presentation.label}. ${presentation.title}`
  },
  mainDataset: { recursionCardToggleRow: card.id },
  mainClassName: 'recursion-card-deck-card-main',
  actionsClassName: 'recursion-card-deck-card-actions'
});
```

- [ ] **Step 5: Render Post-process categories with the same disclosure and head grid**

Remove the literal plus/minus `expander` button. Do not add a category state control; category activity is derived from child-card state:

```js
const categoryEnabled = cards.some((card) => card.enabled !== false);

const categoryCopy = el('span', {
  className: 'recursion-card-panel-category-copy recursion-post-process-category-copy'
}, [
  el('strong', {
    className: 'recursion-post-process-category-name',
    text: category.name
  }),
  el('span', {
    className: 'recursion-post-process-category-meta',
    text: `${runnableCount} runnable card${runnableCount === 1 ? '' : 's'}`
  }),
  ...(category.description
    ? [el('span', {
      className: 'recursion-post-process-category-description',
      text: category.description
    })]
    : [])
]);

list.appendChild(renderDeckCategory({
  el,
  className: `recursion-post-process-category ${categoryEnabled ? 'is-active' : 'is-inactive'}`,
  category,
  expanded,
  disclosure: cardSystemIconSvg(expanded ? 'chevron-up' : 'chevron-down'),
  copy: categoryCopy,
  actions: categoryActions,
  body: cardRows,
  dataset: { recursionPostProcessCategory: category.id },
  headerDataset: { recursionPostProcessCategoryExpand: category.id },
  headerClassName: 'recursion-post-process-category-head',
  bodyClassName: 'recursion-post-process-category-body',
  headerTitle: `${expanded ? 'Collapse' : 'Expand'} ${category.name}`
}));
```

- [ ] **Step 6: Render Post-process cards as full-row binary controls**

Replace the separate boxed eye button and reordered copy with:

```js
const cardCopy = el('span', {
  className: 'recursion-card-panel-card-copy recursion-post-process-card-copy'
}, [
  el('span', {
    className: 'recursion-card-panel-card-name recursion-post-process-card-name',
    text: card.name || 'Unnamed card'
  }),
  el('span', {
    className: 'recursion-card-panel-card-description recursion-post-process-card-description',
    text: card.description || 'No description.'
  })
]);

const stateMarker = el('span', {
  className: 'recursion-card-panel-state-marker recursion-post-process-card-status',
  attrs: {
    title: cardToggleLabel,
    'aria-label': card.enabled === false ? 'Off' : 'On',
    'data-effective-state': effectiveOn ? 'on' : 'off'
  }
}, [cardSystemIconSvg(card.enabled === false ? 'eye-off' : 'eye')]);

return renderDeckCard({
  el,
  className: `recursion-post-process-card ${effectiveOn ? 'is-active' : 'is-inactive'}`,
  card,
  copy: cardCopy,
  state: stateMarker,
  actions,
  dataset: { recursionPostProcessCard: card.id },
  mainAttrs: {
    title: cardToggleLabel,
    'aria-label': cardToggleLabel,
    'aria-pressed': card.enabled === false ? 'false' : 'true',
    'data-effective-state': effectiveOn ? 'on' : 'off'
  },
  mainDataset: { recursionPostProcessCardToggle: card.id },
  mainClassName: 'recursion-post-process-card-main',
  actionsClassName: 'recursion-post-process-row-actions'
});
```

The Post-process state marker is now an unboxed glyph inside the same full-row button as its copy. The event handler continues to find `recursionPostProcessCardToggle` through delegation.

- [ ] **Step 7: Make Post-process category disclosure keyboard-equivalent**

Extract the existing expansion mutation into:

```js
function togglePostProcessCategoryExpansion(id) {
  if (expandedPostProcessCategoryKeys === null) {
    expandedPostProcessCategoryKeys = new Set(
      orderedPostProcessCategories(
        getActivePostProcessDeck(currentView().settings?.postProcessDecks)
      ).map((category) => category.id)
    );
  }
  if (expandedPostProcessCategoryKeys.has(id)) expandedPostProcessCategoryKeys.delete(id);
  else expandedPostProcessCategoryKeys.add(id);
  postProcessPanelRenderKey = '';
  renderPostProcessPanelForView(currentView());
}
```

Use it from the click handler:

```js
const postCategoryExpand = control('recursionPostProcessCategoryExpand');
const postCategoryAction = control('recursionPostProcessCategoryToggle')
  || control('recursionPostProcessCategoryEdit')
  || control('recursionPostProcessCategoryDelete')
  || control('recursionPostProcessCategoryDragHandle');
if (postCategoryExpand && !postCategoryAction) {
  consumeClickEvent(event);
  togglePostProcessCategoryExpansion(
    postCategoryExpand.dataset.recursionPostProcessCategoryExpand
  );
  return;
}
```

Add keyboard support before drag-handle handling in the Post-process keydown listener:

```js
const categoryHead = closestDatasetElement(
  event?.target,
  'recursionPostProcessCategoryExpand',
  postProcessPanel
);
if (categoryHead && ['Enter', ' '].includes(event?.key)) {
  consumeClickEvent(event);
  togglePostProcessCategoryExpansion(
    categoryHead.dataset.recursionPostProcessCategoryExpand
  );
  return;
}
```

- [ ] **Step 8: Replace parallel category/card CSS with shared geometry**

Add:

```css
.recursion-card-panel-category {
  border-top: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 6%, transparent);
  display: grid;
  gap: 4px;
  padding: 7px 9px;
}

.recursion-card-panel-category-head {
  align-items: center;
  cursor: pointer;
  display: grid;
  gap: 6px;
  grid-template-columns: 24px minmax(0, 1fr);
  min-width: 0;
}

.recursion-card-panel-category-head.has-state {
  grid-template-columns: 24px minmax(0, 1fr) 24px;
}

.recursion-card-panel-category-head.has-actions {
  grid-template-columns: 24px minmax(0, 1fr) var(--recursion-card-action-rail-width, 124px);
}

.recursion-card-panel-category-head.has-state.has-actions {
  grid-template-columns: 24px minmax(0, 1fr) 24px var(--recursion-card-action-rail-width, 124px);
}

.recursion-card-panel-category-head:hover,
.recursion-card-panel-category-head:focus-visible {
  background: color-mix(in srgb, var(--recursion-panel) 80%, var(--recursion-hover));
  outline: none;
}

.recursion-card-panel-disclosure {
  align-items: center;
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 58%, transparent);
  display: inline-flex;
  height: 22px;
  justify-content: center;
  justify-self: center;
  width: 22px;
}

.recursion-card-panel-disclosure svg {
  display: block;
  height: 18px;
  width: 18px;
}

.recursion-card-panel-category-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.recursion-card-panel-category-copy strong {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 76%, transparent);
  font-size: 11px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recursion-card-panel-category-copy > span {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 42%, transparent);
  font-size: 10px;
  line-height: 1.15;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recursion-card-panel-category-state {
  align-items: center;
  appearance: none;
  background: transparent;
  border: 0;
  color: color-mix(in srgb, var(--recursion-accent) 68%, transparent);
  display: inline-flex;
  height: 24px;
  justify-content: center;
  padding: 0;
  width: 24px;
}

.recursion-card-panel-category-state.is-off {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 38%, transparent);
}

.recursion-card-panel-category-body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.recursion-card-panel-card {
  --recursion-card-action-rail-width: 124px;
  align-items: center;
  background: color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 8%, transparent);
  border-radius: 5px;
  color: inherit;
  display: grid;
  font: inherit;
  gap: 6px;
  grid-template-columns: minmax(0, 1fr);
  min-height: 26px;
  padding: 3px 4px;
  text-align: left;
}

.recursion-card-panel-card.has-actions {
  grid-template-columns: minmax(0, 1fr) var(--recursion-card-action-rail-width);
}

.recursion-card-panel-card-main {
  align-items: center;
  appearance: none;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: grid;
  gap: 6px;
  grid-template-columns: minmax(0, 1fr) 16px;
  min-width: 0;
  padding: 1px 2px;
  text-align: left;
}

.recursion-card-panel-card-main:hover,
.recursion-card-panel-card-main:focus-visible {
  background: color-mix(in srgb, var(--recursion-panel) 80%, var(--recursion-hover));
  outline: none;
}

.recursion-card-panel-card-copy {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.recursion-card-panel-card-name {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 72%, transparent);
  font-size: 11px;
  line-height: 1.15;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recursion-card-panel-card-description {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 42%, transparent);
  font-size: 10px;
  line-height: 1.15;
  min-width: 0;
  overflow-wrap: anywhere;
}

.recursion-card-panel-state-marker {
  align-items: center;
  display: inline-flex;
  height: 16px;
  justify-content: center;
  justify-self: end;
  width: 16px;
}

.recursion-card-panel-state-marker svg {
  display: block;
  height: 15px;
  width: 15px;
}

.recursion-card-panel-row-actions {
  align-items: center;
  display: inline-flex;
  flex-wrap: nowrap;
  gap: 4px;
  justify-content: flex-end;
  width: var(--recursion-card-action-rail-width, 124px);
}

.recursion-card-panel-card.is-active {
  border-color: color-mix(in srgb, var(--recursion-accent) 28%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--recursion-accent) 68%, transparent);
}

.recursion-card-panel-card.is-active .recursion-card-panel-state-marker {
  color: color-mix(in srgb, var(--recursion-accent) 68%, transparent);
}

.recursion-card-panel-card.is-inactive {
  border-color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 7%, transparent);
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 58%, transparent);
}

.recursion-card-panel-card.is-inactive .recursion-card-panel-state-marker {
  color: color-mix(in srgb, var(--SmartThemeBodyColor, #ddd) 38%, transparent);
}

.recursion-card-panel-card.is-priority {
  border-color: color-mix(in srgb, #8eefff 46%, transparent);
  box-shadow:
    inset 3px 0 0 #8eefff,
    inset 0 0 0 1px color-mix(in srgb, #8eefff 22%, transparent);
}

.recursion-card-panel-card.is-priority .recursion-card-panel-card-name,
.recursion-card-panel-card.is-priority .recursion-card-panel-state-marker {
  color: #8eefff;
}
```

Retain phase-specific selectors only for phase-specific behavior: editor/delete/drag visuals, Post-process category-off effective-state opacity, and Priority icon alignment. Delete the duplicated structural declarations for:

- `.recursion-post-process-category`
- `.recursion-post-process-category-head`
- `.recursion-post-process-expander`
- `.recursion-post-process-card`
- `.recursion-card-deck-category`
- `.recursion-card-deck-category-head`
- `.recursion-card-deck-category-arrow`
- `.recursion-card-deck-card`
- `.recursion-card-deck-card-main`
- `.recursion-card-deck-card-actions`

- [ ] **Step 9: Replace stale CSS-source assertions**

Replace assertions in `tools/scripts/test-ui.mjs` that require phase-specific
selectors to own structural geometry. Use the shared selectors:

```js
assert(
  /\.recursion-card-panel\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow:\s*hidden;/.test(recursionCss),
  'both card panels use one fixed-shell layout'
);
assert(
  /\.recursion-card-panel-category-head\s*\{[\s\S]*?cursor:\s*pointer;[\s\S]*?grid-template-columns:\s*24px minmax\(0,\s*1fr\);/.test(recursionCss),
  'shared category headers expose a full-row disclosure target'
);
assert(
  /\.recursion-card-panel-card\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/.test(recursionCss)
  && /\.recursion-card-panel-card\.has-actions\s*\{[\s\S]*?var\(--recursion-card-action-rail-width\)/.test(recursionCss),
  'shared card rows allocate the structural action rail only when actions exist'
);
assert(
  /\.recursion-card-panel-card\.is-active \.recursion-card-panel-state-marker\s*\{[\s\S]*?var\(--recursion-accent\)/.test(recursionCss),
  'shared active state markers use the same toned cyan as the active rail'
);
assert(
  /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.recursion-card-panel-category-head\.has-actions\s*\{[\s\S]*?grid-template-columns:\s*24px minmax\(0,\s*1fr\)\s+auto;/.test(recursionCss),
  'mobile shared category rows keep disclosure and actions attached'
);
```

Update the existing mounted assertion for
`recursion-post-process-category-head` to require both the shared class and the
retained phase hook:

```js
const postCategoryHead = root.querySelector('[data-recursion-post-process-category]').children[0];
assert(postCategoryHead.className.includes('recursion-card-panel-category-head'));
assert(postCategoryHead.className.includes('recursion-post-process-category-head'));
```

- [ ] **Step 10: Run the UI test to verify GREEN**

Run:

```powershell
npm.cmd run test:ui
```

Expected: `[pass] ui`.

---

### Task 4: Unify Responsive Behavior and Add Computed-Geometry Proof

**Files:**
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/prove-post-process-cards-ui.mjs`
- Modify: `tools/scripts/test-post-process-playwright-contract.mjs`

**Interfaces:**
- Consumes: shared DOM classes from Tasks 1-3
- Produces: desktop and compact geometry invariants
- Preserves: existing screenshot artifact and baseline behavior

- [ ] **Step 1: Add the shared responsive CSS**

Replace phase-specific mobile category/card grid overrides with:

```css
@media (max-width: 720px) {
  .recursion-card-panel {
    max-height: min(72dvh, calc(100dvh - 46px));
    width: min(100%, 100dvw);
  }

  .recursion-card-panel-head {
    flex-wrap: wrap;
  }

  .recursion-post-process-head .recursion-card-panel-head-actions {
    flex: 1 0 100%;
    margin-left: 0;
  }

  .recursion-card-panel-deck-bar {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .recursion-card-panel-deck-selector {
    flex-basis: 100%;
  }

  .recursion-card-panel-category-head.has-actions {
    grid-template-columns: 24px minmax(0, 1fr) auto;
  }

  .recursion-card-panel-category-head.has-state.has-actions {
    grid-template-columns: 24px minmax(0, 1fr) 24px auto;
  }

  .recursion-card-panel-row-actions {
    width: auto;
  }
}
```

Pre-process may keep title, count, and bulk eyes on one line when they fit. Post-process may wrap its larger action cluster to a second line. The shared deck/category/card geometry must not diverge.

- [ ] **Step 2: Add a computed-geometry helper to the Post-process live proof**

Add:

```js
async function readCardPanelGeometry(page, panelSelector) {
  return page.locator(panelSelector).first().evaluate((panel) => {
    const boxValue = (box) => box ? {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      right: box.right,
      bottom: box.bottom
    } : null;
    const rect = (selector) => {
      const node = panel.querySelector(selector);
      return boxValue(node?.getBoundingClientRect());
    };
    const style = (selector) => {
      const node = panel.querySelector(selector);
      if (!node) return null;
      const computed = getComputedStyle(node);
      return {
        display: computed.display,
        gridTemplateColumns: computed.gridTemplateColumns,
        overflowY: computed.overflowY,
        padding: computed.padding,
        gap: computed.gap
      };
    };
    return {
      panel: boxValue(panel.getBoundingClientRect()),
      header: rect('.recursion-card-panel-head'),
      deckBar: rect('.recursion-card-panel-deck-bar'),
      deckSelect: rect('.recursion-card-deck-select'),
      list: rect('.recursion-card-panel-list'),
      categoryHead: rect('.recursion-card-panel-category-head'),
      disclosure: rect('.recursion-card-panel-disclosure'),
      card: rect('.recursion-card-panel-card'),
      cardMain: rect('.recursion-card-panel-card-main'),
      state: rect('.recursion-card-panel-state-marker'),
      listStyle: style('.recursion-card-panel-list'),
      cardStyle: style('.recursion-card-panel-card'),
      hasEmptyActionRail: Boolean(
        panel.querySelector('.recursion-card-panel-card:not(.has-actions) .recursion-card-panel-row-actions')
      )
    };
  });
}

function near(left, right, tolerance = 1.5) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function assertSharedPanelGeometry(pre, post, viewportName) {
  for (const key of ['deckBar', 'deckSelect']) {
    check(
      near(pre[key]?.height, post[key]?.height),
      `${viewportName}: ${key} height differs between Pre-process and Post-process.`
    );
  }
  if (viewportName === 'desktop') {
    check(
      near(pre.header?.height, post.header?.height),
      `${viewportName}: header height differs between Pre-process and Post-process.`
    );
  }
  check(
    near(pre.disclosure?.x - pre.categoryHead?.x, post.disclosure?.x - post.categoryHead?.x),
    `${viewportName}: disclosure left inset differs between phases.`
  );
  check(
    near(pre.card?.x - pre.list?.x, post.card?.x - post.list?.x)
      && near(pre.list?.right - pre.card?.right, post.list?.right - post.card?.right),
    `${viewportName}: card shells do not share list-relative left/right insets.`
  );
  check(
    near(pre.card?.right - pre.state?.right, post.card?.right - post.state?.right),
    `${viewportName}: bundled state eyes do not share the right inset.`
  );
  check(!pre.hasEmptyActionRail && !post.hasEmptyActionRail, `${viewportName}: bundled row rendered an empty action rail.`);
  check(/auto|scroll/.test(pre.listStyle?.overflowY || ''), `${viewportName}: Pre-process list is not the scroll surface.`);
  check(/auto|scroll/.test(post.listStyle?.overflowY || ''), `${viewportName}: Post-process list is not the scroll surface.`);
}
```

- [ ] **Step 3: Measure the two panels sequentially**

In the desktop and compact viewport flow, measure the bundled panels before creating custom decks:

```js
await closePostProcess(page);
await openPreProcess(page);
const firstPreCategory = page.locator('[data-recursion-card-category-toggle]').first();
if ((await firstPreCategory.getAttribute('aria-expanded')) !== 'true') {
  await firstPreCategory.click();
}
await page.locator('[data-recursion-card-id]').first().waitFor({ state: 'visible', timeout: TIMEOUT_MS });
const preGeometry = await readCardPanelGeometry(page, '[data-recursion-cards-panel]');
await closePreProcess(page);

await openPostProcess(page);
await selectPostDeck(page, STARTER_DECK_ID);
for (const name of ['Natural Prose', 'Follow Through']) {
  await expandCategory(page, name, true);
}
const postGeometry = await readCardPanelGeometry(page, '[data-recursion-post-process-panel]');
assertSharedPanelGeometry(preGeometry, postGeometry, viewport.name);
```

Ensure the first Pre-process category is expanded before measuring its first card. Do not compare Post-process card height to Pre-process card height because Post-process intentionally renders descriptions.

- [ ] **Step 4: Update the Playwright contract test**

Add source assertions that the proof:

- opens and measures both panels;
- compares shared header, deck toolbar, selector, disclosure, card left/right, and state-eye inset geometry;
- rejects empty bundled action rails;
- does not compare content-driven card heights;
- retains the existing non-generating safety gate.

Use concrete assertions:

```js
assert(/async function readCardPanelGeometry\(page,\s*panelSelector\)/.test(source), 'parity proof measures both panel families');
assert(/function assertSharedPanelGeometry\(pre,\s*post,\s*viewportName\)/.test(source), 'parity proof compares shared geometry');
assert(/bundled state eyes do not share the right inset/.test(source), 'parity proof checks the eye inset');
assert(/bundled row rendered an empty action rail/.test(source), 'parity proof rejects empty action rails');
assert(!/near\(pre\.card\?\.height,\s*post\.card\?\.height/.test(source), 'parity proof permits content-driven Post-process row height');
```

- [ ] **Step 5: Run focused contract tests**

Run:

```powershell
npm.cmd run test:ui
node tools/scripts/test-post-process-playwright-contract.mjs
```

Expected: both print their pass markers.

- [ ] **Step 6: Run live non-promoting visual proof**

Run without `UPDATE_VISUAL_BASELINES`:

```powershell
npm.cmd run prove:post-process-ui
npm.cmd run prove:card-system-ui
```

Expected:

- functional cases pass;
- computed parity checks pass at desktop and compact widths;
- no generation request is sent;
- screenshots are retained as artifacts;
- existing baselines are not rewritten.

Inspect the artifacts before any baseline promotion.

---

### Task 5: Documentation, Regression, Installed-copy Sync, and Human Handoff

**Files:**
- Modify: `DESIGN.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/superpowers/specs/2026-07-19-pre-post-process-card-panel-parity-design.md`
- Modify: `docs/user/RECURSION_OPERATOR_MANUAL.md`
- Verify: all task-owned source/tests
- Sync: `F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion`

**Interfaces:**
- Consumes: Tasks 1-4
- Produces: current V1 documentation, repository proof, installed-copy identity, and a safe human verification handoff

- [ ] **Step 1: Tighten the design contract**

Record these exact requirements in the design sources:

```text
Pre-process and Post-process Cards render through one shared structural class
family. Shared geometry includes panel height and scrolling, header, summary,
deck selector and actions, category disclosure and copy, card shell and state
marker, conditional structural action rail, and footer. Phase-specific hook
classes may add semantics but must not redefine those dimensions.

Bundled rows do not render empty structural action rails. Their state marker is
right-inset within the full-width main row. Editable rows place the same state
marker immediately left of the structural action rail.
```

Delete any language that treats count-only header summaries as insufficient or requires a visible `read-only` label. Structural read-only status is carried by disabled Rename/Delete/Edit/Drag controls and their accessible explanations.

- [ ] **Step 2: Run focused tests**

```powershell
npm.cmd run test:ui
node tools/scripts/test-post-process-playwright-contract.mjs
node tools/scripts/test-pre-process-decks.mjs
node tools/scripts/test-post-process-decks.mjs
```

Expected: all four commands exit `0`.

- [ ] **Step 3: Run the complete repository suite**

```powershell
npm.cmd test
```

Expected: exit code `0`; no failing test script.

- [ ] **Step 4: Run whitespace and scoped-diff checks**

```powershell
git diff --check
git status --short
git diff -- src/ui/cards-panel.mjs src/ui.mjs styles/recursion.css tools/scripts/test-ui.mjs tools/scripts/prove-post-process-cards-ui.mjs tools/scripts/test-post-process-playwright-contract.mjs DESIGN.md docs/design/UI_SPEC.md docs/superpowers/specs/2026-07-19-pre-post-process-card-panel-parity-design.md docs/user/RECURSION_OPERATOR_MANUAL.md
```

Expected:

- no whitespace errors;
- task-owned files contain only the parity repair;
- unrelated dirty baseline/proof changes remain intact.

- [ ] **Step 5: Sync the verified checkout to `default-user`**

From the verified checkout:

```powershell
$source = (Resolve-Path -LiteralPath '.').Path
$destination = 'F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion'
robocopy $source $destination /E /XD .git node_modules artifacts .tmp tests .agents .codex /XF debug.log
if ($LASTEXITCODE -gt 7) { exit $LASTEXITCODE }
```

This sync is authorized only after the repository suite and non-promoting Playwright proofs pass.

- [ ] **Step 6: Verify installed and served identity**

```powershell
node tools/scripts/verify-installed-copy.mjs --user default-user
```

Expected: repository, installed extension, and served production files hash-match. If the served copy is separate, update it through the existing verifier-supported workflow and rerun the identity check.

- [ ] **Step 7: Hand off human verification**

Ask the user to reload SillyTavern and verify:

1. Default Pre-process card eyes are at the right inset.
2. Starter Post-process card eyes use the same inset and unboxed glyph treatment.
3. Both deck selectors and deck-action rows have matching height and spacing.
4. Both category disclosures use the same chevron, placement, and full-row target.
5. Active rows in both phases use the same cyan rail/border treatment.
6. Post-process descriptions remain visible without changing the common shell insets.
7. Post-process On/Off, Apply, Flow, and bulk eyes remain in the approved header order.
8. Bundled card/category state remains interactive while structural authoring remains disabled.
9. Editable decks show structural actions without pushing the state marker into an arbitrary middle position.
10. Desktop and compact layouts have no clipped controls or overlapping scrollbars.

Do not drive a model generation on `default-user` for this UI-only proof.

## Completion Criteria

The repair is complete only when all of the following are true:

- Both panels contain the canonical shared structural classes.
- No parallel phase CSS redefines shared header, selector, category, card, state, action-rail, list, or footer geometry.
- Bundled Pre-process and Post-process rows contain no empty action rail.
- Bundled Pre-process and Post-process state eyes have the same computed right inset.
- Editable rows place the state eye immediately left of the structural action rail.
- Pre-process row cycles and both bulk eyes still work on the Default deck.
- Post-process category/card toggles and both bulk eyes still work on the Starter deck.
- Post-process header controls remain summary, On/Off, Apply, Flow, open eye, slashed eye.
- Both selectors use the same input skin and deck-action order.
- Category disclosure works by pointer and keyboard in both phases.
- Both lists are the only vertical scroll surfaces.
- Post-process descriptions remain visible and content-driven.
- Focus-visible, ARIA labels, `aria-expanded`, and `aria-pressed` remain correct.
- Focused tests, full repository tests, and both live UI proofs pass.
- Fresh desktop and compact screenshots have been inspected.
- The `default-user` installed/served copies hash-match the verified checkout.
