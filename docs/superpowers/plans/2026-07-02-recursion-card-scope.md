# Recursion Card Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the visible Semi-Auto concept with Auto/Manual mode plus a Cards button that controls fixed card-family and sub-item scope.

**Architecture:** Add one card-scope contract module beside the existing card catalog. Settings persist `mode: "auto" | "manual"` plus normalized card scope. Runtime sends scope to the Utility Arbiter, enforces Manual as a strict whitelist, treats Auto scope as focus with visible critical exceptions, and filters prompt composition inputs. UI adds a compact Cards dropdown tree and removes every user-facing Semi-Auto path.

**Tech Stack:** JavaScript ES modules, DOM APIs, SillyTavern extension UI, Node script tests, existing markdown design/technical docs, existing live harness.

---

## File Structure

- `src/card-scope.mjs` - new fixed family/sub-item catalog, normalization, toggle helpers, counts, Arbiter payload helpers, and runtime filtering helpers.
- `src/settings.mjs` - replace `semi-auto` with `manual`, add default/normalized `cardScope`.
- `src/cards.mjs` - attach scope focus to card requests.
- `src/runtime.mjs` - pass scope into Arbiter/card generation, enforce Manual, record Auto exceptions/Manual omissions, include scope in cache/settings signatures and safe views.
- `src/ui.mjs` - Auto/Manual mode menu, Cards button/dropdown tree, zero-selection guard, scope update patches.
- `styles/recursion.css` - compact Cards dropdown styling that matches the current bar/settings surfaces.
- `tools/scripts/test-card-scope.mjs` - new unit coverage for the card-scope contract.
- `tools/scripts/test-settings.mjs` - mode and card-scope persistence/normalization coverage.
- `tools/scripts/test-cards.mjs` - request focus payload coverage if `src/cards.mjs` changes.
- `tools/scripts/test-runtime.mjs` - Manual strict filtering, Auto focus/exception visibility, cache signature drift.
- `tools/scripts/test-ui.mjs` - fake DOM coverage for Auto/Manual and Cards controls.
- `tools/scripts/lib/sillytavern-live-harness.mjs` - replace Semi-Auto smoke assertions with Manual/card-scope assertions.
- `docs/design/UI_SPEC.md` - update visible control contract.
- `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md` - update copyable mock/reference markup.
- `docs/technical/RUNTIME_TURN_SEQUENCE.md` - update runtime mode and scope semantics.
- `docs/technical/STORAGE_AND_DIAGNOSTICS.md` - document sanitized scope diagnostics.
- `docs/technical/CARD_DECK_AND_HAND.md` - document family/sub-item focus and Manual filtering.
- `docs/superpowers/specs/2026-07-02-recursion-card-scope-design.md` - keep as the source design reference unless implementation discovers a necessary correction.

---

### Task 1: Card Scope Contract

**Files:**
- Create: `src/card-scope.mjs`
- Create: `tools/scripts/test-card-scope.mjs`

- [x] Add failing tests for the scope catalog, defaults, normalization, toggle helpers, counts, zero-selection guard, and runtime filters.

Use this initial test shape:

```js
import {
  CARD_SCOPE_CATALOG,
  cardScopeCounts,
  cardScopeLabel,
  defaultCardScope,
  filterCardJobsForScope,
  filterCardsForScope,
  normalizeCardScope,
  scopePayloadForArbiter,
  setFamilyEnabled,
  setSubItemEnabled
} from '../../src/card-scope.mjs';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

assertEqual(CARD_SCOPE_CATALOG.length, 8, 'scope catalog mirrors fixed V1 card families');
assert(CARD_SCOPE_CATALOG.every((family) => family.subItems.length >= 2), 'each family has sub-items');

const all = defaultCardScope();
const allCounts = cardScopeCounts(all);
assertEqual(allCounts.selectedSubItems, allCounts.totalSubItems, 'defaults select every sub-item');
assertEqual(cardScopeLabel(all), 'Cards', 'all-selected label is Cards');

const noScene = setFamilyEnabled(all, 'Scene Frame', false).scope;
assertEqual(noScene.families['Scene Frame'].enabled, false, 'family toggle off disables family');
assert(Object.values(noScene.families['Scene Frame'].subItems).every((value) => value === false), 'family off disables sub-items');

const restoredScene = setFamilyEnabled(noScene, 'Scene Frame', true).scope;
assertEqual(restoredScene.families['Scene Frame'].enabled, true, 'family toggle on enables family');
assert(Object.values(restoredScene.families['Scene Frame'].subItems).every((value) => value === true), 'family on restores all sub-items');

const mixed = setSubItemEnabled(all, 'Continuity Risk', 'timelineOrder', false).scope;
assertEqual(mixed.families['Continuity Risk'].enabled, true, 'partial sub-item keeps family enabled');
assertEqual(cardScopeCounts(mixed).selectedSubItems, allCounts.totalSubItems - 1, 'sub-item toggle changes count');
assertEqual(cardScopeLabel(mixed), `${allCounts.totalSubItems - 1}/${allCounts.totalSubItems}`, 'partial label is selected/total');

let oneLeft = all;
for (const family of CARD_SCOPE_CATALOG) {
  for (const item of family.subItems) {
    if (family.family === 'Open Threads' && item.key === 'pendingActions') continue;
    oneLeft = setSubItemEnabled(oneLeft, family.family, item.key, false).scope;
  }
}
const blocked = setSubItemEnabled(oneLeft, 'Open Threads', 'pendingActions', false);
assertEqual(blocked.blocked, true, 'final sub-item disable is blocked');
assertEqual(cardScopeCounts(blocked.scope).selectedSubItems, 1, 'zero-selection guard preserves last sub-item');

const normalized = normalizeCardScope({
  families: {
    Unknown: { enabled: false, subItems: { nope: false } },
    'Scene Frame': { enabled: true, subItems: { locationSituation: false } }
  }
});
assert(!normalized.families.Unknown, 'unknown family is dropped');
assertEqual(normalized.families['Scene Frame'].subItems.locationSituation, false, 'known sub-item persists');
assertEqual(normalized.families['Scene Frame'].subItems.immediateDirection, true, 'missing sub-item defaults on');

const manualPayload = scopePayloadForArbiter({ mode: 'manual', cardScope: noScene });
assertEqual(manualPayload.strictWhitelist, true, 'Manual payload is strict');
assert(!manualPayload.allowedCatalog.some((entry) => entry.family === 'Scene Frame'), 'Manual payload omits disabled family');

const autoPayload = scopePayloadForArbiter({ mode: 'auto', cardScope: noScene });
assertEqual(autoPayload.strictWhitelist, false, 'Auto payload is focus');
assert(autoPayload.availableCatalog.some((entry) => entry.family === 'Scene Frame'), 'Auto payload keeps full catalog available');

const manualJobs = filterCardJobsForScope([
  { family: 'Scene Frame', role: 'sceneFrameCard' },
  { family: 'Open Threads', role: 'openThreadsCard' }
], { mode: 'manual', cardScope: noScene });
assertDeepEqual(manualJobs.cardJobs.map((job) => job.family), ['Open Threads'], 'Manual drops disabled card jobs');
assertEqual(manualJobs.omitted.length, 1, 'Manual reports omitted job');

const manualCards = filterCardsForScope([
  { id: 'scene', family: 'Scene Frame', role: 'sceneFrameCard' },
  { id: 'thread', family: 'Open Threads', role: 'openThreadsCard' }
], { mode: 'manual', cardScope: noScene });
assertDeepEqual(manualCards.cards.map((card) => card.id), ['thread'], 'Manual drops disabled cards');

console.log('[pass] card-scope');
```

- [x] Implement `src/card-scope.mjs` with a static sub-item catalog over the existing fixed families.

Use these family/sub-item keys:

```js
export const CARD_SCOPE_CATALOG = Object.freeze([
  {
    family: 'Scene Frame',
    role: 'sceneFrameCard',
    description: 'Current location, situation, participants, and immediate dramatic direction.',
    subItems: [
      { key: 'locationSituation', label: 'location/situation' },
      { key: 'presentParticipants', label: 'present participants' },
      { key: 'immediateDirection', label: 'immediate direction' }
    ]
  },
  {
    family: 'Active Cast',
    role: 'activeCastCard',
    description: 'Who is present, visible state, and current conversational or physical role.',
    subItems: [
      { key: 'presentCharacters', label: 'present characters' },
      { key: 'visibleState', label: 'visible state' },
      { key: 'speakerRoles', label: 'speaker roles' }
    ]
  },
  {
    family: 'Character Motivation',
    role: 'characterMotivationCard',
    description: 'Observable or safely inferred motives, pressures, hesitations, and goals.',
    subItems: [
      { key: 'visibleGoals', label: 'visible goals' },
      { key: 'pressures', label: 'pressures' },
      { key: 'hesitationPosture', label: 'hesitation/posture' }
    ]
  },
  {
    family: 'Dialogue/Relationship',
    role: 'dialogueRelationshipCard',
    description: 'Current conversational tension, relationship texture, promises, conflicts, and voice constraints.',
    subItems: [
      { key: 'tension', label: 'tension' },
      { key: 'promisesConflicts', label: 'promises/conflicts' },
      { key: 'voiceConstraints', label: 'voice constraints' }
    ]
  },
  {
    family: 'Continuity Risk',
    role: 'continuityRiskCard',
    description: 'Facts likely to be contradicted if omitted from the next response.',
    subItems: [
      { key: 'fragileFacts', label: 'fragile facts' },
      { key: 'spatialConstraints', label: 'spatial constraints' },
      { key: 'timelineOrder', label: 'timeline/order' }
    ]
  },
  {
    family: 'Environment/Items',
    role: 'environmentItemsCard',
    description: 'Spatial constraints, sensory details, relevant objects, tools, hazards, and nearby affordances.',
    subItems: [
      { key: 'spatialLayout', label: 'spatial layout' },
      { key: 'relevantObjects', label: 'relevant objects' },
      { key: 'hazardsAffordances', label: 'hazards/affordances' }
    ]
  },
  {
    family: 'Prose/Pacing',
    role: 'prosePacingCard',
    description: 'Local craft guidance for density, momentum, specificity, and response shape.',
    subItems: [
      { key: 'density', label: 'density' },
      { key: 'momentum', label: 'momentum' },
      { key: 'specificityShape', label: 'specificity/shape' }
    ]
  },
  {
    family: 'Open Threads',
    role: 'openThreadsCard',
    description: 'Unresolved questions, immediate promises, pending actions, and near-term pressures.',
    subItems: [
      { key: 'unresolvedQuestions', label: 'unresolved questions' },
      { key: 'pendingActions', label: 'pending actions' },
      { key: 'nearTermPressures', label: 'near-term pressures' }
    ]
  }
]);
```

Required exported API:

```js
export const CARD_SCOPE_VERSION = 1;
export const CARD_SCOPE_CATALOG;
export const CARD_SCOPE_TOTAL_SUB_ITEMS;

export function defaultCardScope();
export function normalizeCardScope(value = {});
export function cardScopeCounts(scope);
export function cardScopeLabel(scope);
export function setFamilyEnabled(scope, family, enabled);
export function setSubItemEnabled(scope, family, subItem, enabled);
export function familyState(scope, family);
export function enabledSubItemsForFamily(scope, family);
export function scopePayloadForArbiter(settings);
export function filterCardJobsForScope(cardJobs, settings);
export function filterCardsForScope(cards, settings);
export function cardScopeSummary(scope);
```

Behavior details:

- `defaultCardScope()` returns a fresh mutable object; exports/constants stay frozen.
- `normalizeCardScope()` drops unknown families/sub-items, fills missing catalog entries as enabled, turns empty enabled families off, and falls back to all-enabled if the input would select zero sub-items.
- `setFamilyEnabled(scope, family, true)` restores all sub-items in that family to `true`.
- `setFamilyEnabled(scope, family, false)` turns all sub-items in that family to `false` unless that would leave zero selected; then return `{ scope: normalizeCardScope(scope), blocked: true, reason: 'zero-selection' }`.
- `setSubItemEnabled(scope, family, subItem, false)` blocks the final selected sub-item the same way.
- `familyState()` returns `'on'`, `'mixed'`, or `'off'`.
- `scopePayloadForArbiter({ mode, cardScope })` returns:
  - `mode`
  - `strictWhitelist`
  - `selectedCounts`
  - `selectedFamilies`
  - `selectedSubItemsByFamily`
  - `availableCatalog` with all families for Auto
  - `allowedCatalog` with enabled families only for Manual
  - `autoExceptionFamilies: ['Continuity Risk']` for Auto and `[]` for Manual
- `filterCardJobsForScope()` and `filterCardsForScope()` enforce strict filtering only when `mode === 'manual'`; Auto returns original entries plus scope metadata so Arbiter remains responsible for relevance.

- [x] Verify the new contract test fails before implementation and passes after implementation.

Commands:

```powershell
node tools/scripts/test-card-scope.mjs
```

Expected output after implementation:

```text
[pass] card-scope
```

- [x] Commit this slice.

Commands:

```powershell
git add src/card-scope.mjs tools/scripts/test-card-scope.mjs
git commit -m "feat(cards): add card scope contract"
```

---

### Task 2: Settings Contract

**Files:**
- Modify: `src/settings.mjs`
- Modify: `tools/scripts/test-settings.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-runtime.mjs`
- Modify: `tools/scripts/test-live-harness.mjs`

- [x] Update settings tests before implementation.

Required assertions:

```js
import {
  CARD_SCOPE_TOTAL_SUB_ITEMS,
  cardScopeCounts,
  defaultCardScope
} from '../../src/card-scope.mjs';

assertEqual(normalizeSettings({ mode: 'manual' }).mode, 'manual', 'manual mode is valid');
assertEqual(normalizeSettings({ mode: 'semi-auto' }).mode, 'auto', 'removed semi-auto normalizes to auto');
assertEqual(normalizeSettings({ mode: 'observe' }).mode, 'auto', 'invalid mode normalizes to auto');

const normalizedDefaultScope = normalizeSettings({}).cardScope;
assertEqual(cardScopeCounts(normalizedDefaultScope).selectedSubItems, CARD_SCOPE_TOTAL_SUB_ITEMS, 'settings default enables all card scope');

const partialScope = defaultCardScope();
partialScope.families['Prose/Pacing'].enabled = false;
for (const key of Object.keys(partialScope.families['Prose/Pacing'].subItems)) {
  partialScope.families['Prose/Pacing'].subItems[key] = false;
}
const normalizedPartial = normalizeSettings({ mode: 'manual', cardScope: partialScope });
assertEqual(normalizedPartial.mode, 'manual', 'manual mode survives card-scope normalization');
assertEqual(normalizedPartial.cardScope.families['Prose/Pacing'].enabled, false, 'disabled family persists');
```

- [x] Change `MODES` from `auto/semi-auto` to `auto/manual`.

Required implementation pattern:

```js
import { defaultCardScope, normalizeCardScope } from './card-scope.mjs';

const MODES = new Set(['auto', 'manual']);

export const DEFAULT_RECURSION_SETTINGS = deepFreeze({
  enabled: true,
  mode: 'auto',
  cardScope: defaultCardScope(),
  ...
});

export function normalizeSettings(value = {}, secretStore = null) {
  const source = value && typeof value === 'object' ? value : {};
  const reasoningLevel = enumValue(source.reasoningLevel, REASONING_LEVELS, DEFAULT_RECURSION_SETTINGS.reasoningLevel);
  return {
    enabled: source.enabled !== false,
    mode: enumValue(source.mode, MODES, DEFAULT_RECURSION_SETTINGS.mode),
    cardScope: normalizeCardScope(source.cardScope),
    ...
  };
}
```

- [x] Ensure partial updates preserve existing `cardScope` through `mergePlainObjects()`.
- [x] Do not add a compatibility alias for `semi-auto`; invalid/removed modes normalize to `auto` because Recursion is pre-alpha.
- [x] Run settings tests.

Commands:

```powershell
npm.cmd run test:settings
```

Expected output:

```text
[pass] settings
```

- [x] Commit this slice.

Commands:

```powershell
git add src/settings.mjs tools/scripts/test-settings.mjs src/runtime.mjs tools/scripts/test-runtime.mjs tools/scripts/test-live-harness.mjs docs/superpowers/plans/2026-07-02-recursion-card-scope.md
git commit -m "feat(settings): persist card scope"
```

---

### Task 3: Card Requests And Runtime Enforcement

**Files:**
- Modify: `src/cards.mjs`
- Modify: `src/runtime.mjs`
- Modify: `tools/scripts/test-cards.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [x] Add or update `tools/scripts/test-cards.mjs` coverage if `buildCardRequests()` receives scope focus.

Required behavior:

```js
const scopedRequests = buildCardRequests({
  schema: 'recursion.utilityArbiterPlan.v1',
  snapshotHash: 'scope-test',
  cardJobs: [{ family: 'Continuity Risk', role: 'continuityRiskCard' }],
  budgets: { targetBriefTokens: 500, maxCards: 4 }
}, {
  runId: 'scope-run',
  snapshotHash: 'scope-test',
  snapshot: {},
  cardScope: {
    selectedSubItemsByFamily: {
      'Continuity Risk': ['fragileFacts', 'timelineOrder']
    }
  }
});

assertDeepEqual(scopedRequests[0].cardScope.selectedSubItems, ['fragileFacts', 'timelineOrder'], 'card request carries selected sub-item focus');
```

- [x] Update `buildCardRequests(plan, context)` so every request includes safe scope focus for that family when `context.cardScope` is supplied.

Required request field:

```js
cardScope: {
  family: catalog.family,
  selectedSubItems: Array.isArray(context.cardScope?.selectedSubItemsByFamily?.[catalog.family])
    ? context.cardScope.selectedSubItemsByFamily[catalog.family]
    : []
}
```

- [x] Add runtime tests for Manual strict filtering.

Required scenarios:

- Manual with `Scene Frame` disabled:
  - Arbiter prompt payload has `strictWhitelist: true`.
  - Arbiter allowed catalog omits `Scene Frame`.
  - A returned `Scene Frame` card job is omitted before generation.
  - Cached `Scene Frame` cards are not selected into the hand.
  - Local fallback does not add disabled `Scene Frame`.
  - `lastPlan.diagnostics` or activity history includes a sanitized omission marker such as `manual-scope-omitted:Scene Frame`.
- Manual with `Continuity Risk` disabled:
  - No critical exception is allowed.
  - Prompt packet selected refs do not contain `Continuity Risk`.

Test helper outline:

```js
function scopeWithFamilyDisabled(family) {
  const next = defaultCardScope();
  return setFamilyEnabled(next, family, false).scope;
}

const manualNoScene = scopeWithFamilyDisabled('Scene Frame');
const runtime = createRecursionRuntime({
  settings: { mode: 'manual', cardScope: manualNoScene, reasonerUse: 'off' },
  generationRouter: {
    async generate(roleId, request) {
      if (roleId === 'utilityArbiter') {
        assert(request.prompt.includes('"strictWhitelist":true'), 'Manual Arbiter prompt is strict');
        assert(!request.prompt.includes('"family":"Scene Frame"'), 'Manual allowed catalog omits disabled family');
        return {
          ok: true,
          data: {
            schema: 'recursion.utilityArbiterPlan.v1',
            action: 'compose-brief',
            sceneStatus: 'same-scene',
            cardJobs: [
              { family: 'Scene Frame', role: 'sceneFrameCard' },
              { family: 'Open Threads', role: 'openThreadsCard' }
            ],
            budgets: { targetBriefTokens: 500, maxCards: 4 }
          }
        };
      }
      assertEqual(roleId, 'openThreadsCard', 'disabled Scene Frame request is never generated');
      return {
        ok: true,
        data: {
          family: 'Open Threads',
          role: 'openThreadsCard',
          promptText: 'Keep pending action visible.',
          summary: 'Pending action.'
        }
      };
    }
  }
});
```

- [x] Add runtime tests for Auto focus payload.

Required behavior:

- Auto with `Scene Frame` disabled sends full catalog as `availableCatalog`.
- Auto payload still exposes selected scope as preference.
- Auto does not hard reject disabled-family card jobs in `filterCardJobsForScope()`.
- If runtime records an Auto exception, the event/journal stores family/sub-item keys and reason only, not prompt text.

- [x] Add cache drift coverage.

Required assertion:

```js
assertNotEqual(
  cacheContractVersions({ mode: 'auto', cardScope: defaultCardScope() }).settingsHash,
  cacheContractVersions({ mode: 'manual', cardScope: scopeWithFamilyDisabled('Prose/Pacing') }).settingsHash,
  'card scope participates in scene cache contract'
);
```

- [x] Implement runtime scope integration.

Required import shape:

```js
import {
  cardScopeSummary,
  filterCardJobsForScope,
  filterCardsForScope,
  scopePayloadForArbiter
} from './card-scope.mjs';
```

Required changes:

- `cacheSettingsSignature(settings)` includes `normalized.cardScope`.
- `arbiterSafeSettings(settings)` and `safeSettingsView(settings)` include `cardScope: cardScopeSummary(source.cardScope)`.
- `askUtilityArbiter()` builds `const cardScope = scopePayloadForArbiter(settings)` and prompt lines include:

```js
`Card scope: ${JSON.stringify(cardScope)}`,
`Catalog: ${JSON.stringify(cardScope.strictWhitelist ? cardScope.allowedCatalog : cardScope.availableCatalog)}`,
`Catalog hash: ${hashJson(cardScope.strictWhitelist ? cardScope.allowedCatalog : cardScope.availableCatalog)}`
```

- After Arbiter merge, apply `filterCardJobsForScope(plan.cardJobs, settings)` and merge omissions into `plan.diagnostics`.
- Pass `cardScope: scopePayloadForArbiter(settings)` into `buildCardRequests()`.
- Before deck creation, filter cached, provider, and fallback cards with `filterCardsForScope(cards, settings)`.
- During `rebaseCardsForSnapshot()` and every later `selectHand()` call, preserve the already filtered deck and do not reintroduce disabled Manual families.
- Manual omission diagnostics use compact strings:

```text
manual-scope-omitted:<family>
```

- Auto exception diagnostics use compact strings:

```text
auto-scope-exception:<family>
```

- [x] Replace user-facing runtime copy and chips:

```js
const modeChip = settings.mode === 'manual' ? 'Manual' : 'Auto';
```

- [x] Run focused tests.

Commands:

```powershell
npm.cmd run test:cards
npm.cmd run test:runtime
```

Expected output:

```text
[pass] cards
[pass] runtime
```

- [x] Commit this slice.

Commands:

```powershell
git add src/settings.mjs tools/scripts/test-settings.mjs src/cards.mjs src/runtime.mjs tools/scripts/test-cards.mjs tools/scripts/test-runtime.mjs tools/scripts/test-live-harness.mjs docs/superpowers/plans/2026-07-02-recursion-card-scope.md
git commit -m "feat(runtime): enforce manual card scope"
```

---

### Task 4: Auto/Manual UI And Cards Surface

**Files:**
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Modify: `tools/scripts/test-ui.mjs`

- [x] Update fake DOM tests for mode menu.

Required assertions:

```js
assertDeepEqual(
  Array.from(root.querySelectorAll('[data-recursion-mode-choice-name]')).map((node) => node.textContent),
  ['Auto', 'Manual'],
  'mode menu shows only Auto and Manual'
);

root.querySelector('[data-recursion-mode-choice-manual]').click();
assertDeepEqual(settingsUpdates.at(-1), { mode: 'manual' }, 'mode menu updates Manual');
assert(!root.textContent.includes('Semi-Auto'), 'UI does not render Semi-Auto');
```

- [x] Update fake DOM tests for the Cards button and dropdown.

Required assertions:

```js
assert(root.querySelector('[data-recursion-cards-button]'), 'Cards button renders');
assertEqual(root.querySelector('[data-recursion-cards-label]').textContent, 'Cards', 'all-selected Cards label renders');

root.querySelector('[data-recursion-cards-button]').click();
assertEqual(root.querySelector('[data-recursion-cards-panel]').hidden, false, 'Cards panel opens');
assertEqual(root.querySelectorAll('[data-recursion-card-family]').length, 8, 'Cards panel renders fixed family tree');

const proseFamily = root.querySelector('[data-recursion-card-family="Prose/Pacing"]');
proseFamily.querySelector('[data-recursion-card-family-toggle]').click();
assert(settingsUpdates.at(-1).cardScope, 'family toggle sends cardScope patch');

const allButOne = makeViewWithOneSelectedSubItem();
mount.update(allButOne);
root.querySelector('[data-recursion-card-subitem-toggle]').click();
assertEqual(root.querySelector('[data-recursion-card-scope-error]').textContent, 'At least one card focus must remain enabled.', 'zero-selection guard explains blocked action');
```

- [x] Update `MODE_OPTIONS` and `MODE_MENU_OPTIONS`.

Required values:

```js
const MODE_OPTIONS = Object.freeze([
  ['auto', 'Auto'],
  ['manual', 'Manual']
]);

const MODE_MENU_OPTIONS = Object.freeze([
  {
    value: 'auto',
    label: 'Auto',
    title: 'Recursion chooses relevant card work.',
    tip: 'Recursion chooses relevant card work.'
  },
  {
    value: 'manual',
    label: 'Manual',
    title: 'Only selected cards can be used.',
    tip: 'Only selected cards can be used.'
  }
]);
```

- [x] Add card-scope imports and model fields.

Required import shape:

```js
import {
  CARD_SCOPE_CATALOG,
  cardScopeCounts,
  cardScopeLabel,
  familyState,
  normalizeCardScope,
  setFamilyEnabled,
  setSubItemEnabled
} from './card-scope.mjs';
```

Required view model additions:

```js
const cardScope = normalizeCardScope(settings.cardScope);
const cardScopeCountsValue = cardScopeCounts(cardScope);
const cardScopeModeCopy = settings.mode === 'manual'
  ? 'Only selected cards can be used.'
  : 'Selected cards guide focus. Critical continuity may still appear.';
```

- [x] Add Cards button to `buildRoot()` inside `.recursion-right-tools`, before Last Brief.

Required data attributes:

```js
dataset: { recursionCardsButton: '' }
dataset: { recursionCardsLabel: '' }
dataset: { recursionCardsPanel: '' }
dataset: { recursionCardFamily: family.family }
dataset: { recursionCardFamilyToggle: family.family }
dataset: { recursionCardSubitemToggle: item.key, recursionCardFamilyKey: family.family }
dataset: { recursionCardScopeError: '' }
```

- [x] Render `renderCardsPanel(panel, view)` with:
  - one compact header line with Auto/Manual enforcement copy;
  - family rows with checkbox, family name, mixed/on/off state, description;
  - sub-item checkbox rows under each family;
  - blocked zero-selection message;
  - no custom family creation;
  - no per-card text editor.

- [x] Wire panel open/close behavior:
  - clicking Cards closes mode menu, progress popover, Last Brief, and settings;
  - outside click and `Esc` close Cards;
  - `aria-expanded` mirrors panel visibility;
  - updates rerender the panel if open.

- [x] Wire scope updates:

```js
function applyCardScopeUpdate(nextResult) {
  if (nextResult.blocked) {
    setCardScopeError('At least one card focus must remain enabled.');
    renderCardsPanel(cardsPanel, currentView());
    return;
  }
  clearCardScopeError();
  runAction(runtime?.updateSettings?.({ cardScope: nextResult.scope }));
}
```

- [x] Keep settings mode row if still useful, but it must show only Auto/Manual. Do not duplicate card selection controls in settings.
- [x] Update CSS with compact dark menu classes:

```css
.recursion-cards-panel {
  position: absolute;
  z-index: 1000;
  min-width: min(360px, calc(100vw - 24px));
  max-height: min(520px, calc(100vh - 96px));
  overflow: auto;
}

.recursion-card-family-row,
.recursion-card-subitem-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}
```

Use existing color tokens and typography from `.recursion-settings-panel` and `.recursion-hand-dropdown`; avoid a new visual theme.

- [x] Run UI tests.

Commands:

```powershell
npm.cmd run test:ui
```

Expected output:

```text
[pass] ui
```

- [x] Commit this slice.

Commands:

```powershell
git add src/ui.mjs styles/recursion.css tools/scripts/test-ui.mjs
git commit -m "feat(ui): add card scope controls"
```

---

### Task 5: Docs, Reference Mock, And Live Harness Cleanup

**Files:**
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md`
- Modify: `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- Modify: `docs/technical/STORAGE_AND_DIAGNOSTICS.md`
- Modify: `docs/technical/CARD_DECK_AND_HAND.md`
- Modify: `tools/scripts/lib/sillytavern-live-harness.mjs`
- Modify: `tools/scripts/test-ui.mjs`
- Modify: `tools/scripts/test-runtime.mjs`

- [x] Replace every visible `Semi-Auto`/`semi-auto` reference with the new Auto/Manual contract.

Required search:

```powershell
rg -n "Semi-Auto|semi-auto" src tools docs/design docs/technical
```

Expected after cleanup:

```text
No output.
```

- [x] Update `docs/design/UI_SPEC.md`:
  - mode selector only `Auto`, `Manual`;
  - Cards button owns selected scope count;
  - all-enabled label is `Cards`, partial label is `selected/total`;
  - family toggle on restores all sub-items;
  - zero selection is blocked;
  - Auto focus exceptions must be visible;
  - Manual is strict and still auto-runs.

- [x] Update `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md`:
  - remove `data-mode="semi-auto"`;
  - add `data-mode="manual"`;
  - add Cards button and sample Cards menu markup;
  - update settings row from Auto/Semi-Auto to Auto/Manual if the row remains;
  - update test assertions in `tools/scripts/test-ui.mjs` that parse this reference.

- [x] Update technical docs:
  - `RUNTIME_TURN_SEQUENCE.md`: Auto focus vs Manual strict whitelist.
  - `STORAGE_AND_DIAGNOSTICS.md`: safe scope counts, family keys, sub-item keys, omission/exception reasons.
  - `CARD_DECK_AND_HAND.md`: sub-items are focus facets, not separate generated V1 card instances.

- [x] Update live harness mode smoke:
  - mode sequence becomes `disabled|auto|manual|disabled`;
  - generation smoke selects Manual with a narrowed scope and proves disabled family cards are not installed;
  - old Semi-Auto prompt-install proof is removed.

Required harness strings:

```js
for (const mode of ['disabled', 'auto', 'manual', 'disabled']) {
  ...
}

sequence.join('|') === 'disabled|auto|manual|disabled'
```

- [x] Run doc/reference-related tests.

Commands:

```powershell
npm.cmd run test:ui
npm.cmd run test:runtime
npm.cmd run test:live-harness
```

Expected output:

```text
[pass] ui
[pass] runtime
[pass] live-harness
```

- [x] Commit this slice.

Commands:

```powershell
git add docs/design/UI_SPEC.md docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md docs/technical/RUNTIME_TURN_SEQUENCE.md docs/technical/STORAGE_AND_DIAGNOSTICS.md docs/technical/CARD_DECK_AND_HAND.md tools/scripts/lib/sillytavern-live-harness.mjs tools/scripts/test-ui.mjs tools/scripts/test-runtime.mjs
git commit -m "docs: document card scope controls"
```

---

### Task 6: Full Verification And Review

**Files:**
- No planned edits unless verification finds defects.

- [ ] Run focused tests first.

Commands:

```powershell
node tools/scripts/test-card-scope.mjs
npm.cmd run test:settings
npm.cmd run test:cards
npm.cmd run test:runtime
npm.cmd run test:ui
npm.cmd run test:live-harness
```

Expected output includes:

```text
[pass] card-scope
[pass] settings
[pass] cards
[pass] runtime
[pass] ui
[pass] live-harness
```

- [ ] Run the full deterministic suite.

Command:

```powershell
npm.cmd test
```

Expected output:

```text
[pass] test-*.mjs ...
[pass] <number> test scripts
```

- [ ] Run alpha gate if deterministic suite is green.

Command:

```powershell
npm.cmd run test:alpha
```

Expected output:

```text
[pass] alpha gate
```

If the exact alpha output differs, preserve the command output in the final implementation report.

- [ ] Run Playwright readiness if UI/reference changed.

Command:

```powershell
npm.cmd run check:playwright
```

Expected output should report ready browser/runtime state or the exact missing dependency.

- [ ] If a live SillyTavern host is available, run the live smoke after deterministic tests.

Command:

```powershell
npm.cmd run smoke:sillytavern
```

Expected proof:

- mode smoke proves disabled/Auto/Manual/disabled cleanup;
- Manual narrowed card scope prevents disabled-family cards from reaching the installed prompt;
- Auto all-enabled still produces normal prompt install.

- [ ] Final stale-reference scan.

Commands:

```powershell
rg -n "Semi-Auto|semi-auto" src tools docs/design docs/technical
rg -n "manual" src/settings.mjs src/ui.mjs src/runtime.mjs tools/scripts/test-settings.mjs tools/scripts/test-ui.mjs tools/scripts/test-runtime.mjs
```

Expected:

- first command has no output;
- second command shows intentional Auto/Manual implementation and tests.

- [ ] Review sanitized diagnostics manually:
  - no raw provider prompts;
  - no prompt text in scope omission/exception records;
  - no secrets;
  - no transcript excerpts introduced by scope diagnostics.

- [ ] Review `git diff --stat` and `git diff --check`.

Commands:

```powershell
git diff --stat
git diff --check
```

Expected output from `git diff --check`:

```text
No output.
```

---

## Acceptance Checklist

- [ ] Visible mode selector shows only Auto and Manual.
- [ ] New/default settings start in Auto with every family and sub-item enabled.
- [ ] Cards button opens a family/sub-item tree for the eight fixed V1 families.
- [ ] Cards button label is `Cards` when all sub-items are enabled.
- [ ] Cards button label is `selected/total` when partial.
- [ ] Family off disables all sub-items.
- [ ] Family on restores all sub-items.
- [ ] Partial sub-item selection shows mixed family state.
- [ ] UI prevents disabling the final selected sub-item.
- [ ] Auto sends full catalog and selected scope preference to Utility Arbiter.
- [ ] Auto critical unselected continuity exceptions are visible when they happen.
- [ ] Manual sends only enabled scope to Utility Arbiter.
- [ ] Manual filters generated, cached, fallback, selected, composed, and injected cards to enabled scope.
- [ ] Sub-items guide family focus and do not create separate generated card instances.
- [ ] `Semi-Auto` and `semi-auto` are gone from source, tests, product design/technical docs, and harness.
- [ ] Deterministic test suite is green.
- [ ] Live smoke is run or explicitly reported as not run with reason.

---

## Implementation Notes

- Recursion is pre-alpha. Update contracts in place; do not preserve legacy `semi-auto` compatibility.
- Do not put card-scope controls under generic settings. Cards is a primary play control.
- Do not add custom family/sub-item authoring.
- Do not add manual per-card approval or editing.
- Keep Cards UI SillyTavern-native, compact, graphite-dark, and consistent with the existing bar.
- Use family/sub-item keys in diagnostics, not card prompt text or provider output.
- Any prompt-affecting `cardScope` update should clear/supersede the current prompt through existing `updateSettings()` behavior.

---

## Self-Review Before Execution

- [ ] Every task names exact files to edit.
- [ ] Every behavior change has a test target.
- [ ] Manual strictness is enforced in runtime, not only requested from the Arbiter.
- [ ] Auto focus keeps full catalog available and records exceptions visibly.
- [ ] UI zero-selection guard exists in both helper tests and fake DOM tests.
- [ ] Docs, tests, runtime, settings, UI, and live harness remove Semi-Auto together.
- [ ] Verification commands are concrete and use `npm.cmd` for Windows PowerShell.
