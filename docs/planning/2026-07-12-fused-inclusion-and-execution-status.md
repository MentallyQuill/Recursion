# Fused Inclusion and Execution Status Improvement

## Purpose

This document defines the Card System progress contract for Standard and Fused
pipelines. It fixes the current ambiguity where source cards are shown as
caution merely because a provider did not return optional coverage metadata.

The progress tree must answer two separate questions:

1. Was this source card included in the category generation?
2. What happened to the model call that generated the category result?

Those questions must not share one overloaded field.

## Problem

The current Fused path treats the presence of `coveredSourceCardIds` as proof
that coverage was reported. An empty array therefore becomes `reported`, and
the progress mapper marks every expected source card as caution because none
appears in the empty set.

That is incorrect when the provider simply omitted useful attribution
metadata. A successful fused call should not become a warning for every source
card because optional metadata was absent.

The opposite failure must also remain visible: if the provider explicitly
omits a requested source card or the category call fails, the user must see
that degraded outcome.

## Design Contract

### Inclusion state

Inclusion describes membership in the generation request:

```ts
type CardInclusionState = "included" | "omitted";
type CardInclusionEvidence =
  | "provider-confirmed"
  | "generation-contract"
  | "explicit-omission";
```

Missing provider metadata means `included` with
`generation-contract` evidence. It must not create a visible `Unverified`
state. A partial `coveredSourceCardIds` list is also treated as incomplete
optional attribution, not as proof that the remaining cards were omitted.
Only an explicit `omittedSourceCardIds` list may fail individual source rows.

### Execution state

Execution describes the model call that produced the category result:

```ts
type CardExecutionState =
  | "waiting"
  | "running"
  | "success"
  | "caution"
  | "failure"
  | "cached";
```

The existing progress vocabulary maps these to the established visual states:

| Execution state | Progress state | Color |
| --- | --- | --- |
| `waiting` | `waiting` | gray |
| `running` | `running` | cyan |
| `success` | `done` | green |
| `caution` | `warning` | yellow |
| `failure` | `failed` | red |
| `cached` | `cached` | purple |

Inclusion evidence changes the explanation, not the execution color.

## Result Shape

Normalized fused category results should carry both dimensions:

```js
{
  id: 'scene-frame',
  sourceCardIds: [
    'scene-frame:location-situation',
    'scene-frame:immediate-direction',
    'scene-frame:beat-constraint'
  ],
  sourceCards,
  inclusionState: 'included',
  inclusionEvidence: 'generation-contract',
  executionState: 'success'
}
```

When the provider returns coverage metadata:

```js
{
  inclusionState: 'included',
  inclusionEvidence: 'provider-confirmed',
  executionState: 'success',
  coveredSourceCardIds
}
```

When the provider explicitly reports an omission:

```js
{
  inclusionState: 'omitted',
  inclusionEvidence: 'explicit-omission',
  executionState: 'failure',
  omissionReason: 'Provider could not safely represent this card.'
}
```

## Standard Pipeline

Standard mode makes one model call per category. The category row is the
authoritative execution result. Its source-card children are the cards passed
to that call and inherit the category call outcome.

```text
Utility card batch
  Scene Frame          green  generated
    location/situation green  included
    immediate direction green included
    beat constraint    green  included
```

If the category call recovers damaged JSON:

```text
Scene Frame            yellow recovered
  location/situation   yellow included in recovered result
```

If the call fails:

```text
Scene Frame            red failed
  location/situation   red category generation failed
```

The child row does not imply a separate model call or separate charge. It
reports the source card's participation in the category call.

## Fused Pipeline

Fused mode makes one fused bundle call. The fused call and generated category
row are authoritative for execution state. Every requested source card remains
listed below its category.

```text
Utility card batch
  Fused card bundle      green  done
    Scene Frame           green  generated
      location/situation green  included
      immediate direction green included
      beat constraint     green  included
```

If the fused response is recovered:

```text
Fused card bundle        yellow recovered
  Scene Frame             yellow recovered
    location/situation    yellow included in recovered result
```

Missing or empty coverage metadata must not independently produce yellow
children. Explicit omission or an unusable fused result remains a failure.

## Implementation

### Normalize coverage metadata

In `src/cards.mjs`, preserve the distinction between absent metadata and an
actual non-empty provider report. An empty array is not evidence that all
source cards were omitted.

```js
const expectedSourceCardIds = requested.get(catalog.family)?.sourceCardIds || [];
const hasCoverageReport = Array.isArray(item.coveredSourceCardIds)
  && item.coveredSourceCardIds.map(String).filter(Boolean).length > 0;
const coveredSourceCardIds = hasCoverageReport
  ? item.coveredSourceCardIds.map(String).filter(Boolean)
  : [];

const inclusionEvidence = hasCoverageReport
  ? 'provider-confirmed'
  : 'generation-contract';

output.cards.push(...cards.map((card) => ({
  ...card,
  providerRole: 'fusedCardBundle',
  sourceCardIds: expectedSourceCardIds,
  sourceCards: requested.get(catalog.family).sourceCards,
  inclusionState: 'included',
  inclusionEvidence,
  sourceCoverage: hasCoverageReport ? 'provider-confirmed' : 'included',
  ...(hasCoverageReport ? { coveredSourceCardIds } : {})
})));
```

The existing `sourceCoverage: 'reported'` branch should not be selected merely
because the provider returned `[]`.

### Carry execution state separately

The runtime progress mapper should derive source-row state from the category
call, not from coverage metadata:

```js
function sourceProgressState(categoryResult, sourceCard) {
  const executionState = categoryResult.executionState || categoryResult.state;

  if (executionState === 'cached') {
    return {
      state: 'cached',
      reason: 'Included from cached category result.'
    };
  }

  if (executionState === 'failure') {
    return {
      state: 'failed',
      reason: categoryResult.executionReason || 'Category generation failed.'
    };
  }

  if (executionState === 'caution') {
    return {
      state: 'warning',
      reason: categoryResult.executionReason || 'Category result was recovered.'
    };
  }

  return {
    state: executionState === 'running' ? 'running' : 'done',
    reason: categoryResult.inclusionEvidence === 'provider-confirmed'
      ? 'Included and confirmed by provider.'
      : 'Included in category generation.'
  };
}
```

Use the same child builder for Standard and Fused results:

```js
const children = sourceCards.map((sourceCard) => {
  const progress = sourceProgressState(categoryResult, sourceCard);

  return {
    id: `card:${sourceCard.id}`,
    label: sourceCard.name,
    state: progress.state,
    reason: progress.reason,
    selectionState: sourceCard.selectionState
  };
});
```

### Handle explicit omissions

Explicit omission is the only source-card-specific coverage failure. A partial
coverage list may produce a private diagnostic, but must not synthesize an
omission list:

```js
const omittedIds = new Set(
  (categoryResult.omittedSourceCardIds || []).map(String)
);

const progress = omittedIds.has(String(sourceCard.id))
  ? {
      state: 'failed',
      reason: categoryResult.omissionReason ||
        'Provider explicitly omitted this source card.'
    }
  : sourceProgressState(categoryResult, sourceCard);
```

This prevents absent metadata from generating false cautions while preserving
real provider omissions.

## Prompt Contract

The fused prompt should require source-card representation while making the
coverage list optional:

```js
[
  'Every requested source card must be represented in the fused prompt.',
  'Do not omit a requested source card unless it cannot be safely represented.',
  'If coveredSourceCardIds is returned, it must list every represented card.',
  'If coverage metadata is omitted, the requested cards are still included by the generation contract.'
]
```

## Last Brief Contract

Last Brief should count requested source cards as included unless explicit
omissions were recorded:

```js
const sourceCardIds = new Set(
  cards.flatMap(card => Array.isArray(card.sourceCardIds)
    ? card.sourceCardIds
    : [])
);

const explicitlyOmitted = cards.reduce((count, card) => (
  count + (card.omittedSourceCardIds || []).length
), 0);

const coverageStatus = explicitlyOmitted > 0
  ? 'degraded'
  : sourceCardIds.size > 0
    ? 'included'
    : 'none';
```

No `requested` or `unverified` user-facing status should remain after this
contract is adopted.

## Tests

Add coverage for both state dimensions:

```js
it('marks requested source cards included when metadata is absent', () => {
  const result = normalizeFusedBundle(resultWithoutCoverage, context);

  expect(result.cards[0].inclusionState).toBe('included');
  expect(result.cards[0].inclusionEvidence)
    .toBe('generation-contract');
});
```

```js
it('does not caution children when coverage metadata is empty', () => {
  const result = normalizeFusedBundle({
    items: [{
      family: 'scene-frame',
      promptText: 'Fused prompt',
      coveredSourceCardIds: []
    }]
  }, context);

  const progress = buildCardProgress(result.cards[0]);

  expect(progress.children.every(child => child.state === 'done')).toBe(true);
});
```

```js
it('propagates Standard category caution to included child rows', () => {
  const progress = buildCategoryProgress({
    executionState: 'caution',
    executionReason: 'JSON repaired',
    sourceCards
  });

  expect(progress.children.every(child => child.state === 'warning')).toBe(true);
});
```

```js
it('fails only explicitly omitted source cards', () => {
  const progress = buildCategoryProgress({
    executionState: 'success',
    omittedSourceCardIds: ['scene-frame:beat-constraint'],
    sourceCards
  });

  expect(progress.children.at(-1).state).toBe('failed');
  expect(progress.children.slice(0, -1).every(child => child.state === 'done'))
    .toBe(true);
});
```

## Validation Plan

1. Run focused card normalization and progress tests.
2. Run the full `npm.cmd test` suite.
3. Sync the changed runtime/card/progress modules to the served
   `default-user` extension.
4. Run one Standard generation and verify each category row reports its own
   execution result with source children beneath it.
5. Run one Fused generation with provider coverage metadata absent and verify
   all source children are green when the fused call succeeds.
6. Run a recovered Fused response and verify the parent, category, and source
   rows are yellow for the recovery reason.
7. Run a partial-coverage case and verify source rows inherit the successful
   category state rather than becoming red.
8. Run an explicit omission case and verify only the omitted source row is red
   while other included rows retain the category execution result.
9. Verify a cached swipe renders purple at the category and source-card levels.
10. Capture desktop and mobile screenshots of the expanded progress tree.

## Acceptance Criteria

- Standard category calls can independently be green, yellow, red, running, or
  cached.
- Fused bundle and category calls can independently be green, yellow, red,
  running, or cached.
- Source cards are always listed when they were part of the request.
- Missing coverage metadata never creates a caution by itself.
- Source cards inherit the execution result of the call that used them.
- Explicit omissions remain visible as failures.
- No user-facing `Unverified` or `requested` status remains.
- Last Brief reports included source cards without claiming provider
  confirmation when that evidence does not exist.
