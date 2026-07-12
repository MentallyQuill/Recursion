# Card Category Coverage Implementation Guide

## Scope

Implement the design in:

`docs/superpowers/specs/2026-07-12-recursion-card-category-coverage-design.md`

The current runtime already groups Card Deck cards by fixed catalog family. This guide extends that grouping with source-card identity, coverage status, nested progress, cache metadata, and explicit enhancement diagnostics.

## Current Integration Points

| Concern | File | Existing integration |
| --- | --- | --- |
| Deck source selection | `src/card-decks.mjs` | `activeCardDeckRuntimeScope`, `deckPriorityCardIds`, `activeCardDeckEligibility` |
| Standard requests | `src/cards.mjs` | `buildCardRequests`, `cardsFromProviderResult` |
| Fused requests | `src/cards.mjs` | `buildFusedCardBundleRequest`, `cardsFromFusedProviderResult` |
| Standard pipeline | `src/runtime/pipelines/standard.mjs` | one request per family |
| Fused pipeline | `src/runtime/pipelines/fused.mjs` | one bundle request, one output item per family |
| Card progress | `src/runtime.mjs` | `stageCardProgress`, `cardProgressDetail` |
| Progress tree model | `src/progress.mjs` | `childStepFromEvent`, `normalizeChildStep` |
| Progress rendering | `src/ui.mjs` | `renderProgressChildrenGroup` |
| Enhancements | `src/runtime.mjs` | `enhanceLatestAssistantMessageImpl` |
| Tests | `tools/scripts/test-cards.mjs`, `test-progress.mjs`, `test-runtime.mjs` | existing contracts |

## Phase 1: Build Source-Card Metadata

Add a grouped source-card helper in `src/card-decks.mjs`:

```js
export function activeCardDeckSourceCards(settings = {}) {
  const deck = getActiveCardDeck(settings);
  const grouped = {};
  for (const card of orderedDeckCardsAcrossCategories(deck)) {
    if (!getDeckCardStatus(card).runnable) continue;
    const family = String(card.builtinFamily || '').trim();
    if (!family) continue;
    (grouped[family] ||= []).push({
      id: card.id,
      name: card.name,
      promptText: card.promptText,
      selectionState: cardSelectionState(card),
      selectedSubItems: card.selectedSubItems || []
    });
  }
  return grouped;
}
```

Use this in `generatePlanCards` when building `requestContext`:

```js
const requestContext = {
  runId,
  snapshotHash: plan.snapshotHash || hashJson(snapshot),
  snapshot: providerSafeSnapshot(snapshot, settings.retention),
  cardScope,
  sourceCardsByFamily: activeCardDeckSourceCards(settings),
  storyForm: plan.storyForm || UNKNOWN_STORY_FORM
};
```

Do not include inactive cards. Priority remains metadata on the source card; it does not create an extra family request.

## Phase 2: Propagate IDs Into Standard Requests

Extend `buildCardRequests` in `src/cards.mjs`:

```js
const sourceCards = Array.isArray(context.sourceCardsByFamily?.[catalog.family])
  ? context.sourceCardsByFamily[catalog.family]
  : [];

return {
  // existing request fields
  sourceCards,
  metadata: {
    family: catalog.family,
    role: catalog.role,
    sourceCards,
    sourceCardIds: sourceCards.map((card) => card.id)
  }
};
```

Pass metadata into the parser from `src/runtime/pipelines/standard.mjs`:

```js
cardsFromProviderResult(result, {
  ...sourceContext,
  expectedSnapshotHash: requests[index]?.snapshotHash,
  expectedRole: requests[index]?.metadata?.role,
  expectedFamily: requests[index]?.metadata?.family,
  sourceCardIds: requests[index]?.metadata?.sourceCardIds || [],
  sourceCards: requests[index]?.metadata?.sourceCards || []
});
```

Attach source metadata after `normalizeCard`, because `normalizeCard` intentionally keeps the canonical generated-card fields:

```js
const normalized = normalizeCard(input, context);
return [{
  ...normalized,
  ...(context.sourceCardIds?.length
    ? { sourceCardIds: context.sourceCardIds, sourceCoverage: 'requested' }
    : {}),
  ...(context.sourceCards?.length ? { sourceCards: context.sourceCards } : {})
}];
```

Preserve these fields in `normalizeDeckCard` so cache/application steps do not discard them.

## Phase 3: Propagate IDs Into Fused Requests

Extend each fused requested family:

```js
{
  family: request.metadata.family,
  role: request.metadata.role,
  sourceCards: request.metadata.sourceCards || [],
  sourceCardIds: request.metadata.sourceCardIds || []
}
```

Add explicit provider guidance:

```text
Each item should include coveredSourceCardIds listing every source deck card represented in the fused prompt.
```

Add source names to each family request block, but keep the actual prompt text bounded and redacted through existing provider-safe helpers.

Parse coverage:

```js
const expected = requested.get(catalog.family)?.sourceCardIds || [];
const covered = Array.isArray(item.coveredSourceCardIds)
  ? item.coveredSourceCardIds.map(String).filter(Boolean)
  : [];

const missing = covered.length
  ? expected.filter((id) => !covered.includes(id))
  : [];

if (missing.length) {
  diagnostics.push(`fused-source-missing:${catalog.family}:${missing.join(',')}`);
}
```

Use `sourceCoverage: 'reported'` only when the provider actually returns coverage. Otherwise use `sourceCoverage: 'requested'`, rendered as neutral `included` information rather than caution.

## Phase 4: Standard/Fused Progress Tree

Extend `cardProgressDetail`:

```js
return {
  parentStepId,
  roleId,
  family,
  source: progressSource,
  state,
  cardId: safeIdentifier(card.id, 'card', 160),
  sourceCards: (card.sourceCards || []).map((sourceCard) => ({
    id: safeIdentifier(sourceCard.id, 'source-card', 160),
    label: safeText(sourceCard.name || sourceCard.id, 120),
    selectionState: safeText(sourceCard.selectionState || 'active', 40),
    state: state === 'failed' ? 'failed' : state
  }))
};
```

The progress model should convert these into nested children:

```js
{
  id: 'scene-frame-card',
  label: 'Scene Frame',
  state: 'done',
  children: [
    { id: 'scene-location', label: 'location/situation', state: 'done' },
    { id: 'scene-direction', label: 'immediate direction', state: 'done' },
    { id: 'scene-beat', label: 'beat constraint', state: 'warning', reason: 'Coverage not reported.' }
  ]
}
```

The UI renderer must support nested child rows. Keep the same row component, state colors, tooltip behavior, and accessibility labels. Do not invent a separate progress visual language.

Recommended labels:

- `included` for source cards included in a request.
- `covered` when provider coverage is explicit.
- `requested` when coverage is unknown.
- `cached` for cache-origin source evidence.
- `missing` for explicit coverage omissions.

## Phase 5: Coverage Validation and Repair

Add a family-level validator after parsing:

```js
function sourceCoverageForCard(card, expectedIds = []) {
  const covered = new Set(card.coveredSourceCardIds || []);
  if (!expectedIds.length) return { status: 'none', missing: [] };
  if (!covered.size) return { status: 'requested', missing: [] };
  const missing = expectedIds.filter((id) => !covered.has(id));
  return { status: missing.length ? 'missing' : 'covered', missing };
}
```

Initial implementation should report missing coverage and preserve the result. A later repair pass can request only missing source cards:

```js
const repairSourceCards = expectedSourceCards.filter(
  (sourceCard) => missingSourceCardIds.includes(sourceCard.id)
);
```

Do not silently discard the whole family because one source card was missing. Preserve the useful result, mark the family yellow, and record the missing IDs.

## Phase 6: Cache and Last Brief

Persist source metadata with generated cards:

```js
{
  sourceCardIds,
  sourceCoverage: 'reported',
  coveredSourceCardIds,
  coverageDiagnostics: []
}
```

Cache eligibility must continue to invalidate when Active/Priority source cards change. A cache without source metadata is `requested` or `unknown`, never `covered`.

Expose source IDs in `hand.selected` journal entries so Last Brief and diagnostics can explain the family result.

## Phase 7: Enhancement Diagnostics

Record pass lifecycle events in `enhanceLatestAssistantMessageImpl`:

```js
await appendJournalSafe(runId, identity.chatKey, {
  event: 'enhancement.pass',
  severity: status === 'success' ? 'info' : 'warn',
  summary: `${pass} enhancement ${status}.`,
  runId,
  sceneKey,
  details: {
    pass,
    status,
    attempt,
    reasonCode,
    reason
  }
});
```

When Dialogue fails, record dependent Prose as not run:

```js
{
  pass: 'prose',
  status: 'not-run',
  reasonCode: 'previous-pass-failed',
  reason: 'Dialogue output failed validation.'
}
```

Pass results should be returned and placed into the enhancement marker:

```js
return {
  ok: false,
  target,
  error,
  passResults
};
```

Pass the same reason into `settleRuntimeActivity({ detail })` so the main Recursion bar and progress dropdown show the reason without requiring journal inspection.

## Tests

### Card request tests

- Active and Priority source cards propagate into Standard metadata.
- Inactive source cards do not propagate.
- Fused requests preserve source IDs and names.
- Provider coverage produces `covered` state.
- Missing provider coverage produces named diagnostics.

### Progress tests

- Family rows contain source-card children.
- Children inherit provider failure.
- Cached source cards use purple/cached state.
- Missing coverage uses yellow/caution state and reason text.
- Nested rows render on desktop and mobile without clipping.

### Enhancement tests

- Successful Dialogue + Prose reports two successful passes.
- Dialogue retry reports `retrying`.
- Dialogue unchanged reports `unchanged`.
- Prose reports `not-run` when Dialogue fails.
- Main activity detail includes reason code and human-readable reason.
- Original assistant text remains preserved on failed passes.

### Live Playwright checks

1. Configure three Scene Frame source cards as Active/Priority.
2. Run Standard.
3. Open the progress dropdown.
4. Assert the hierarchy:

```text
Utility Card batch
  Scene Frame
    location/situation
    immediate direction
    beat constraint
```

5. Repeat in Fused and confirm the family call remains one bundle operation.
6. Force a missing coverage response in the harness and assert yellow child state plus reason.
7. Trigger Dialogue validation failure and assert:

```text
Dialogue Enhancement · caution
Prose Enhancement · not run
Reason: previous pass failed validation
```

## Rollout Order

1. Add source-card metadata and unit tests.
2. Add Standard/Fused parser propagation.
3. Add progress child state and nested rendering.
4. Add provider coverage parsing.
5. Add cache and journal persistence.
6. Add enhancement pass diagnostics.
7. Run full tests.
8. Sync served default-user extension.
9. Run Standard and Fused SG-1 Playwright proofs.

## Completion Criteria

The implementation is complete when source-card identity survives from Deck settings through provider request, generated/cache card, hand journal, progress tree, and Last Brief. Every caution/failure has a visible reason, and no UI label implies independent model calls when the runtime made a family-level request.

## UX and Reliability Hardening

### Category Density Feedback

Add a compact source-card count to category rows:

```js
const densityLabel = `${sourceCards.length} source cards`;
```

When the count exceeds the configured advisory threshold, expose a tooltip or secondary metadata label:

```text
Focus may be diluted when many cards share one category generation.
```

Do not block the request or silently reduce the source list.

### Coverage State Mapping

Keep source-card state separate from provider-call state:

```js
function sourceCoverageState({ requestedIds = [], coveredIds = [], providerFailed = false }) {
  if (providerFailed) return requestedIds.map(() => 'failed');
  if (!coveredIds.length) return requestedIds.map(() => 'requested');
  const covered = new Set(coveredIds);
  return requestedIds.map((id) => covered.has(id) ? 'covered' : 'missing');
}
```

The progress renderer should map these to the existing state language:

```js
const sourceState = {
  requested: 'info',
  covered: 'done',
  missing: 'warning',
  failed: 'failed',
  cached: 'cached'
};
```

Use labels such as `included`, `covered`, `missing`, and `cached`; do not label source children `generated` unless they had an independent provider call.

### Priority Metadata

Carry selection state through every trace object:

```js
{
  id: sourceCard.id,
  label: sourceCard.name,
  selectionState: sourceCard.selectionState,
  tooltip: sourceCard.selectionState === 'priority'
    ? 'Priority: forced into this category generation before active backfill.'
    : 'Active: eligible source guidance.'
}
```

### Prompt and Last Brief Inspection

Add a compact category coverage summary to packet diagnostics:

```js
{
  family: 'Scene Frame',
  requestedSourceCount: 3,
  coveredSourceCount: 2,
  missingSourceCardIds: ['scene-beat'],
  coverageStatus: 'missing'
}
```

Render the same summary in Last Brief. Keep provider secrets, raw hidden reasoning, and unsafe prompt material out of the UI.

### Cache Compatibility

Extend cache validation beyond the eligibility hash when source coverage is introduced:

```js
const sourceMetadataHash = hashJson({
  sourceCardIds,
  sourceCoverage,
  coveredSourceCardIds
});
```

If source-card IDs or selection state change, invalidate the affected family cache. If source metadata is absent, classify the cache as `unknown` or `requested`, never `covered`.

### Response Validation

Add deterministic checks before accepting provider coverage:

```js
const expected = new Set(requestedSourceCardIds);
const covered = new Set(Array.isArray(item.coveredSourceCardIds)
  ? item.coveredSourceCardIds.map(String)
  : []);
const unknown = [...covered].filter((id) => !expected.has(id));
const missing = [...expected].filter((id) => !covered.has(id));
```

Unknown IDs, duplicates, unrequested families, empty prompt text, and malformed coverage should create diagnostics. Preserve a useful family result when possible; mark it yellow only when the output is actually damaged or a source is explicitly missing. Lack of attribution alone remains neutral.

### Mobile and Accessibility Checks

Add Playwright assertions for:

- Nested rows fit at 390px width.
- Child labels do not overlap state markers.
- Category child groups can collapse without losing scroll position.
- Progress updates do not jump the scroll container.
- Long source names truncate with accessible labels/tooltips.
- State meaning is available without relying on color alone.

Example assertion:

```js
await expect(page.locator('[data-recursion-progress-row]'))
  .toHaveAttribute('aria-label', /Scene Frame.*beat constraint.*missing/);
```

### Explicit Enhancement Diagnostics

Enhancement status must expose pass dependencies:

```js
{
  pass: 'prose',
  status: 'not-run',
  reasonCode: 'previous-pass-failed',
  reason: 'Dialogue validation failed after retry.',
  originalKept: true
}
```

Send the same reason through `settleRuntimeActivity({ detail })`, the journal, the enhancement marker, and Last Brief diagnostics. This prevents the main bar from collapsing a meaningful failure into only `Needs attention`.

## Additional Test Matrix

| Scenario | Expected result |
| --- | --- |
| One Active source card | Family request contains one source; child is included/covered/requested |
| Active plus Priority cards | All source children appear; Priority metadata remains visible |
| Inactive source card | Card absent from request and progress children |
| Six source cards in one family | Count shown; no silent drop; density advisory available |
| Provider omits one source ID | Family and child caution; missing ID shown |
| Provider returns unknown source ID | Coverage validation caution; unknown ID diagnostic |
| Cached family result | Purple cached state with source compatibility metadata |
| Family provider failure | Parent and all source children red |
| Dialogue retry succeeds | Retry visible; Prose runs afterward |
| Dialogue retry fails | Prose explicitly `not-run` with dependency reason |
| Mobile progress update | Nested layout remains stable and scrollable |
