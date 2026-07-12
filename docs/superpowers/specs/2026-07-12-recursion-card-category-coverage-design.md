# Recursion Card Category Aggregation and Coverage

## Status

Design specification. This document defines the next Card System improvement; it does not itself change runtime behavior.

## Problem

Card Decks expose individual cards, but runtime generation currently operates at the catalog-family level.

Example:

```text
Scene Frame
  location/situation
  immediate direction
  beat constraint
```

The selected cards are assembled into one `sceneFrameCard` request. The model returns one generated Scene Frame card. This is efficient, but it creates a coverage risk: as more source cards are combined, the model may blend, weaken, or omit some of them.

The user currently cannot reliably tell:

- Which source deck cards were eligible.
- Which source cards entered the category request.
- Whether the model reported covering each source card.
- Whether the result came from a provider call, cache, fallback, or repair.
- Why a source card or later enhancement pass was omitted.

## Goals

1. Keep category-level generation as the default cost and latency model.
2. Make source-card participation visible in the progress tree.
3. Distinguish source-card inclusion from actual provider-call identity.
4. Make Active, Priority, Inactive, Cached, Caution, and Failure states truthful.
5. Detect and report missing source-card coverage.
6. Allow targeted repair of missing source cards without immediately splitting every category into separate calls.
7. Preserve the existing Standard, Fused, Rapid, cache, and hand-selection architecture.

## Non-goals

- Do not make every deck card an independent model call by default.
- Do not treat generated cards as durable lore or memory.
- Do not replace the Utility Arbiter with deterministic semantic scoring.
- Do not silently claim that a source card was represented when the provider gave no coverage evidence.
- Do not change Card Deck editing, selection gestures, or visual state icons in this feature.

## Runtime Model

### Source cards

Source cards are the user-authored or bundled Card Deck units. Their selection state controls eligibility:

| State | Category request behavior |
| --- | --- |
| Inactive | Excluded entirely |
| Active | Included as normal source guidance |
| Priority | Included as forced source guidance and reported prominently |

If a category has no Active or Priority cards, it must not generate or enter the hand.

### Category request

The runtime groups eligible source cards by fixed catalog family:

```text
eligible deck cards -> category grouping -> one family request -> generated family card
```

Standard mode makes one provider call per requested family. Fused mode makes one bundle call containing one item per requested family. The source-card grouping remains the same in both modes.

### Priority semantics

Priority guarantees source inclusion and ordering pressure. It does not guarantee an independent generated card or unlimited output space.

For Fused mode, three prioritized Scene Frame cards still produce one fused Scene Frame item. The request must include all three source cards, and the progress tree must report all three beneath the Scene Frame family row.

## Coverage Contract

Every category request should carry source-card identity:

```js
{
  family: 'Scene Frame',
  sourceCards: [
    { id: 'scene-location', name: 'location/situation', state: 'active' },
    { id: 'scene-direction', name: 'immediate direction', state: 'priority' },
    { id: 'scene-beat', name: 'beat constraint', state: 'active' }
  ],
  coveragePolicy: 'every-source-card'
}
```

The preferred provider response adds:

```js
{
  family: 'Scene Frame',
  promptText: '...',
  coveredSourceCardIds: [
    'scene-location',
    'scene-direction',
    'scene-beat'
  ]
}
```

Coverage states:

| State | Meaning |
| --- | --- |
| Requested | Sent to the provider; no explicit coverage claim was returned |
| Covered | Provider explicitly reported the source card |
| Missing | Provider reported coverage, but omitted this source card |
| Cached | Reused from a cache artifact |
| Repairing | Targeted repair is being generated |
| Failed | The category request failed |

`Requested` must not be rendered as `Covered`. This distinction prevents false confidence.

## Progress UX

The progress dropdown should expose the runtime tree:

```text
Utility Card batch                         done
  Scene Frame                             generated
    location/situation                    included
    immediate direction                   priority / included
    beat constraint                       included
```

The parent family row represents the provider operation. Child rows represent the source deck cards that shaped that operation.

For a missing source:

```text
Utility Card batch                         caution
  Scene Frame                             caution
    location/situation                    covered
    immediate direction                   covered
    beat constraint                       missing
```

For a provider failure:

```text
Utility Card batch                         failure
  Scene Frame                             failure
    location/situation                    failure
    immediate direction                   failure
    beat constraint                       failure
```

Children inherit the provider failure when no category result exists. They receive individual `missing` or `covered` states when a result exists.

Source children should use the existing progress state language:

- Spinner: pending/running/repairing.
- Green: success, covered, or included.
- Purple: cached.
- Neutral included: requested without provider attribution in an otherwise successful category result.
- Yellow: explicit missing coverage, retrying, repaired output, or another actionable caution.
- Red: provider/validation failure.

The label must clarify the semantics. `included` is more truthful than `generated` for a source deck card that contributed to a family call.

## User Awareness

The Cards surface should show category source-card density:

```text
Scene Frame · 3 source cards
```

Expanded category help should explain:

> Active and Priority cards in this category are combined into one category generation. More source cards can dilute focus. Recursion reports coverage when the provider supplies it.

This is an informational cue, not a warning on every category. A caution is appropriate only when coverage is unknown, missing, or repaired.

## Coverage Dilution Policy

The initial policy is request-level coverage plus targeted repair:

1. Include all eligible source cards.
2. Request explicit `coveredSourceCardIds`.
3. Validate the returned IDs.
4. Mark missing source cards yellow.
5. Repair only missing source cards when practical.
6. Merge repaired guidance into the family result.

If a category exceeds a future source-card density threshold, the runtime may warn or request a more structured response. It should not silently drop cards.

## Cache Contract

Cached generated cards must retain:

```js
{
  sourceCardIds: ['scene-location', 'scene-direction'],
  sourceCoverage: 'reported',
  coveredSourceCardIds: ['scene-location', 'scene-direction']
}
```

Changing any eligible source card, its selection state, or the active deck must invalidate the relevant cache eligibility signature. A cache that lacks source-card metadata is `requested` or legacy-unknown, never `covered`.

## Enhancement Parallel

Enhancement passes use the same transparency model:

```text
Enhancements
  Dialogue Enhancement                    success
  Prose Enhancement                       not run
    reason: previous dialogue pass failed validation
```

The main Recursion bar must show explicit caution/failure reasons, not only `Needs attention`.

Required pass states:

- `started`
- `retrying`
- `success`
- `unchanged`
- `provider-failed`
- `validation-failed`
- `not-run`
- `applied`
- `original-kept`

## Acceptance Criteria

- Standard shows one family provider operation with source-card children.
- Fused shows one bundle operation, family children, and source-card grandchildren.
- Active and Priority source cards are all visible beneath their family.
- Inactive cards never appear as included source children.
- Cached source cards show cached state.
- Provider failure propagates to family source children.
- Missing provider coverage produces a named caution.
- Enhancement cautions identify the pass, reason, retry count, and skipped dependent passes.
- Last Brief and scene cache retain source-card IDs and coverage metadata.
- No UI claims that each source card received an independent model call unless it actually did.

## Additional UX and Reliability Requirements

### Category Density

The Cards surface should show source-card density without blocking the user:

```text
Scene Frame · 6 source cards
Focus may be diluted
```

This is an advisory cue. The user may keep the configuration, but the runtime should never silently discard cards because a category is crowded.

### Coverage Confidence

The UI and diagnostics must distinguish these events:

```text
Included in request
Confirmed covered by provider
Coverage unknown
Missing from provider result
```

`Included` is not proof of provider coverage. A provider response without coverage IDs is `requested` or `unknown`, rendered as neutral `included`, not as caution and not as `covered`.

### Priority Clarity

Priority source cards should retain their bright visual state beneath the family row and use a tooltip such as:

> Priority: forced into this category generation before normal active cards.

Multiple Priority cards in one family remain one category request. The UI must not imply independent provider calls.

### Generated Result Inspection

Last Brief and Prompt Packet inspection should expose the category result:

```text
Scene Frame
Sources: 3
Coverage: 2/3 confirmed
Missing: beat constraint
```

The inspection surface should link the result back to source-card names and IDs without exposing provider secrets or hidden reasoning.

### Cache Transparency

Cached results should identify their origin and source compatibility:

```text
Scene Frame · cached
Sources from previous generation
Coverage: reported
```

Eligibility and source-card metadata changes must invalidate incompatible cached results. A cache created before a source-card change must not appear fully current.

### Provider Response Validation

Validate coverage responses for:

- Missing source IDs.
- Duplicate source IDs.
- Unknown source IDs.
- Unrequested families.
- Empty or generic generated prompt text.
- Coverage claims that do not match the request.

Invalid coverage should produce a named caution or targeted repair, never silent success.

### Explicit Error Detail

Every yellow or red state must provide:

- Failed category or enhancement pass.
- Failure or caution reason.
- Retry count.
- Whether original content was preserved.
- Whether dependent work was skipped.

Example:

```text
Prose Enhancement · not run
Reason: Dialogue validation failed after retry.
Original response preserved.
```

### Mobile Progress Behavior

Nested progress must remain usable on narrow screens:

- Preserve indentation without horizontal overflow.
- Truncate long names with accessible details.
- Keep child rows large enough to tap.
- Allow category-level child groups to collapse.
- Preserve scroll position while progress updates.
- Avoid layout jumps when children appear or change state.

### Accessibility

Each progress child needs an accessible label containing its category, source-card name, state, and reason where applicable:

```text
Scene Frame, beat constraint, missing coverage, provider did not report this source card
```

Visual color must never be the only state signal.

### Persistence

Source IDs, selection states, coverage, and omission reasons should survive the live progress view in:

- Scene cache metadata.
- `hand.selected` journal entries.
- Last Brief metadata.
- Prompt Packet diagnostics.

The user should be able to inspect what happened after the progress dropdown closes.

### Semantic State Separation

The implementation must keep these events separate:

```text
source-card inclusion
provider coverage
generated category result
cache reuse
final hand selection
prompt installation
```

They may share a visual family, but they must not collapse into one generic `done` state.
