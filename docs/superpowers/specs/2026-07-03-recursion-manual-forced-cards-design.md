# Recursion Manual Forced Cards Design

## Purpose

Manual mode should mean the user can force Recursion to use the card families they picked. The current behavior is not intuitive enough: Manual scope is a strict whitelist, but the Utility Arbiter can still choose no jobs inside that whitelist. A user can therefore select cards and receive no generated coverage for those selections.

This design changes Manual from "Arbiter-limited inside user scope" to "user-selected mandatory card coverage inside a settings cap."

## Current State

The current Cards surface is a fixed family and sub-item tree:

- Families are card categories such as `Scene Frame`, `Active Cast`, `Scene Constraints`, and `Open Threads`.
- Sub-items are focus facets inside a family.
- Auto treats selected scope as preference.
- Manual treats selected scope as a strict whitelist.

Runtime asks the Utility Arbiter for a plan. The plan may include `cardJobs`. Runtime filters `cardJobs` through Manual scope, then generates only the surviving jobs. If the Arbiter omits selected Manual families, runtime does not synthesize replacement jobs.

That means Manual selection is currently permission, not intent.

## Problem

Users read Manual as a direct control:

```text
I selected these cards, so Recursion should generate or use these cards.
```

Current runtime reads Manual as:

```text
The Arbiter may use only these cards, but may still use none of them.
```

This mismatch creates bad trust behavior:

- The user cannot force a family the Arbiter underweights.
- The Cards panel looks like a direct selector but behaves like an allowed-catalog filter.
- A user can select many cards and still see fewer cards generated or injected with no obvious reason.
- The Max Cards setting limits final hand selection late, not what the user can select up front.

## Goals

- Make Manual selection mandatory and legible.
- Treat card families as the selectable Manual card unit.
- Keep sub-items as per-family focus facets, not generated cards.
- Enforce the Manual selectable-card cap in the Cards UI before runtime.
- Use the existing `Max Cards` setting as the Manual selection cap.
- Notify the user immediately when the cap prevents another selection.
- Preserve Auto as Arbiter-directed focus.
- Keep the V1 product compact and avoid per-card editing or review workflows.
- Record sanitized diagnostics when forced Manual coverage is synthesized, reused, generated, omitted, or failed.

## Non-Goals

- No custom card families.
- No user-authored card text.
- No per-card accept/reject queue.
- No drag ordering.
- No separate manual review mode.
- No compatibility shim for old pre-alpha over-cap Manual states.
- No combined multi-card provider prompt in this change.

## Selected Approach

Manual mode becomes:

```text
Strict whitelist plus mandatory selected-family coverage.
```

The Cards panel keeps one family row per generated card family. Family selection is the Manual "card" selection. Sub-items remain detail focus within a selected family.

Manual selection is capped by normalized `settings.maxCards`:

- If Max Cards is `5`, Manual can select at most 5 card families.
- If the user attempts to select a 6th family, the UI leaves it off and shows a short notice.
- The notice should name the setting: `Max Cards is 5. Change it in Settings to select more.`
- Sub-item toggles do not count against the cap.

Runtime guarantees selected-family coverage:

1. Ask Arbiter for normal plan.
2. Filter Arbiter `cardJobs` through Manual scope.
3. Reconcile filtered plan against selected Manual families.
4. Reuse usable selected-family cached cards when valid.
5. Synthesize missing selected-family `cardJobs` when no usable card exists or when cache is bypassed.
6. Generate one card request per surviving or synthesized family job.
7. Select forced Manual cards into the hand before any lower-priority optional cards.
8. Report visible omissions if a forced family cannot produce a valid card.

## Alternatives Considered

### Option A: Leave Manual As Whitelist Only

Rejected. It preserves Arbiter freedom, but does not match the UI or user intent.

### Option B: Add A Separate "Force" Toggle

Rejected for V1. It adds another control and forces users to learn the difference between selected, allowed, and forced. Manual should already be the force mode.

### Option C: Make Every Focus Facet A Generated Card

Rejected. Facets are not separate card schemas. Generating per facet would multiply provider calls, weaken card coherence, and conflict with the current one-family-card contract.

### Option D: Manual Mandatory Families With Cap

Selected. It matches the user's model, keeps the existing card family catalog, and makes cost/card-count control visible through Max Cards.

## User-Facing Contract

### Auto

Auto remains Arbiter-directed. Cards selection acts as focus preference:

- Selected families/facets are preferred.
- Unselected families can still be requested when relevant to scene coherence, constraints, or current user message.
- The final hand remains budgeted by reasoning level and behavior settings.

### Manual

Manual means selected families are mandatory:

- Runtime may use only selected families.
- Runtime must cover every selected family by cache reuse or provider generation unless that family fails.
- Runtime must not silently omit selected families because the Arbiter did not choose them.
- Runtime must not include unselected families.
- Final hand budget must floor to selected-family count, capped by `Max Cards`.

### Selected Unit

Family rows are the selected Manual card unit:

```text
[on] Scene Constraints       counts as 1 selected Manual card
     [on] hard limits        focus facet, does not count against cap
     [off] timeline/order    focus facet, does not count against cap
```

Sub-item rules:

- A selected family must keep at least one selected sub-item.
- Turning all sub-items off deselects the family only if doing so does not violate the zero-selection guard.
- Turning a family on restores its default selected sub-items unless previous same-session sub-item choices are still available in the open panel model.
- Sub-items shape that family card prompt with `Selected focus facets for <family>`.

### Cap Rule

Manual selection cap:

```js
manualSelectionCap = Math.max(1, Math.min(20, settings.maxCards))
```

`Max Cards` remains the setting users change. The Manual Cards dropdown should show the current count and cap:

```text
5/5 cards selected
```

When below cap:

```text
4/5 cards selected
```

When the user tries to exceed cap:

```text
Max Cards is 5. Change it in Settings to select more.
```

### Auto To Manual Over-Cap Transition

Never trim randomly. When Auto scope contains more selected families than Manual can force, Recursion should keep the most user-relevant selected families by a stable ranking:

1. Families present in the current Last Brief hand, preserving hand order.
2. Active current-scene cache families already loaded in runtime/view state, with emphasized cards before normal cards.
3. Families boosted by the current Focus setting.
4. Remaining selected families in `CARD_CATALOG` priority order.

This matches what the user most recently saw Recursion use, then what the current scene already has in memory, then the user's broad Focus setting, then the catalog's default safety/coherence priority. The mode switch should not perform storage reads just to rank overflow selections. If no Last Brief or loaded cache context exists, the result falls back to Focus and catalog priority.

If stored settings contain an over-cap Manual selection, normalize in place with that ranking, dropping the rest, and showing:

```text
Manual selection trimmed to Max Cards: 5.
```

This is acceptable because Recursion is pre-alpha. No compatibility shim is required.

### Default And All Behavior

Auto `All` selects every family and every sub-item.

Manual `All` selects up to `manualSelectionCap` families using the same over-cap ranking and selects every sub-item within those families. If the cap is below the catalog size, show:

```text
Selected 5 cards. Max Cards limits Manual selection.
```

This avoids a default over-cap Manual state when the catalog has more families than the default Max Cards value. The selection should feel like Recursion kept the most relevant current cards, not like it removed arbitrary rows.

## Runtime Contract

### New Manual Coverage Helper

Runtime should use a deterministic helper after Arbiter planning and before card generation:

```js
reconcileManualForcedCardJobs({
  plan,
  settings,
  cacheCards,
  forceContext,
  snapshot
})
```

Return shape:

```js
{
  cardJobs: [],
  forcedFamilies: [],
  reusedFamilies: [],
  synthesizedFamilies: [],
  omitted: [],
  diagnostics: []
}
```

Responsibilities:

- Read selected Manual families from `scopePayloadForArbiter(settings).selectedFamilies`.
- Deduplicate jobs by resolved family.
- Preserve Arbiter jobs for selected families.
- Add synthetic jobs for selected families that have no usable cache and no job.
- Do not add jobs for unselected families.
- Respect force-regenerate/cache-bypass state by treating cache cards as not reusable for this run.
- Emit compact diagnostics such as `manual-forced-card:Scene Constraints`.

Synthetic job shape:

```js
{
  family: 'Scene Constraints',
  role: 'sceneConstraintsCard',
  reason: 'Manual selected this card; runtime forced coverage because the Arbiter omitted it.',
  forcedBy: 'manual-selection'
}
```

### Cache Reuse

Manual selected families may be satisfied by cache only when all are true:

- Card family is selected.
- Card status is `active`.
- Card source matches current scene snapshot freshness rules.
- Card is not stale.
- Current run is not force-regenerate/cache-bypass.

If cache satisfies a selected family, no provider call is required for that family. The hand must still include that card unless it fails final freshness or prompt install checks.

### Generation

`generatePlanCards(...)` keeps the existing one-card-per-request contract:

- One selected family maps to at most one card request.
- Selected sub-items are included in the request focus block.
- Provider response must remain `schema: "recursion.card.v1"` with exactly one item.
- Multi-card combined prompt is out of scope.

### Hand Selection

Manual hand selection changes from priority-only to forced-first:

1. Include every valid selected-family card.
2. Preserve catalog priority ordering among selected families unless runtime already has stronger explicit emphasis.
3. If a forced family failed, add an omission reason instead of silently shrinking the hand.
4. Apply token budget after selected-family inclusion, but do not drop forced cards for `maxCards`.
5. If token budget is exceeded, packet metadata records `tokenBudgetExceeded: true`; it does not silently remove forced Manual cards.

Runtime must floor effective `plan.budgets.maxCards` to selected-family count in Manual:

```js
effectiveMaxCards = Math.max(plan.budgets.maxCards, selectedManualFamilyCount)
```

The UI cap prevents this from exceeding `settings.maxCards`.

### Failure And Omission Reasons

Forced Manual omissions must be visible in Last Brief/Prompt Packet metadata and diagnostics:

- `manual-forced-provider-failed:<family>`
- `manual-forced-invalid-card:<family>`
- `manual-forced-stale-snapshot:<family>`
- `manual-forced-token-over-budget:<family>` only when the packet still includes the card but budget metadata warns.

The runtime should not fabricate arbitrary local fallback cards for every family. Existing local fallback remains limited to the current fallback families and must still pass Manual scope.

## UI Contract

### Cards Dropdown

Cards dropdown header in Manual:

```text
Cards    4/10 cards selected
```

Cards dropdown header in Auto:

```text
Cards    31/34 focus items enabled
```

Manual family rows should read as selected cards. Auto rows can keep focus wording.

When Manual is active:

- Family toggle off removes one selected Manual card.
- Family toggle on adds one selected Manual card if below cap.
- Family toggle on is blocked if selected count equals cap.
- Sub-item toggles remain available inside selected families.
- Disabled/unselected family sub-items are visually muted and not independently selectable until the family is selected.

Blocked cap notice:

```text
Max Cards is 5. Change it in Settings to select more.
```

Zero-selection notice:

```text
Keep at least one Manual card selected.
```

### Mode Menu Copy

Manual row copy should change from whitelist language to force language:

```text
Uses selected cards only and forces each selected card into the next hand.
```

Auto row copy remains:

```text
Selects cards and injects composed prompt context automatically.
```

### Settings Copy

`Max Cards` tooltip should mention Manual:

```text
Upper Manual card-selection cap and Ultra Reasoning Level card target.
```

`Min Cards` remains Low Reasoning Level pressure, not Manual selection cap.

## Settings And Schema

Keep one normalized `cardScope` shape. Do not add a second Manual-only settings object for V1.

Normalization must become mode-aware at the point of update:

- In Auto, family/facet scope can include all families and sub-items.
- In Manual, selected families must be clamped to `manualSelectionCap` by the over-cap ranking.
- Unknown families and sub-items are dropped.
- At least one family and one sub-item must remain selected.

Because persisted settings do not need legacy compatibility in pre-alpha, over-cap state can be corrected in place on the next Manual settings update.

## Documentation Updates

Implementation must update:

- `DESIGN.md` for the visible Manual contract if the current wording changes.
- `docs/design/UI_SPEC.md` for Cards dropdown cap behavior and Manual copy.
- `docs/design/CARD_SYSTEM_SPEC.md` for family-vs-facet semantics if current text is stale.
- `docs/architecture/RUNTIME_ARCHITECTURE.md` for Manual mandatory coverage.
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md` for forced coverage reconciliation and unchanged one-card provider envelope.
- `docs/user/RECURSION_OPERATOR_MANUAL.md` for user-facing Manual behavior.
- `docs/testing/LIVE_SMOKE_TEST_PLAN.md` if live Manual smoke should prove forced selected card coverage.

## Testing Contract

Required deterministic coverage:

- Manual cap blocks selecting one more family.
- Manual cap notice names Max Cards.
- Manual over-cap state trims deterministically by Last Brief hand, active cache, Focus boosts, then catalog priority.
- Manual `All` selects only up to cap.
- Auto `All` still selects all focus items.
- Sub-item toggles do not count against Manual cap.
- Arbiter omission of selected Manual family causes synthetic `cardJob`.
- Selected Manual cache card can satisfy coverage without provider call.
- Force-regenerate bypasses cache satisfaction and generates selected families.
- Final hand includes every valid selected Manual family.
- Final hand records visible omission for failed selected family.
- Auto behavior remains Arbiter-directed and not mandatory.

Required live proof:

- Dedicated `recursion-soak-*` user only.
- Set Max Cards to 2.
- Select two Manual families.
- Attempt third family and observe cap notice.
- Run Manual generation where Arbiter omits one selected family.
- Verify Last Brief/Prompt Packet metadata shows both selected families covered or one covered plus explicit forced omission.

## Acceptance Criteria

- User cannot select more Manual card families than Max Cards permits.
- Over-cap attempts do not mutate settings.
- User sees a concise notice when the cap blocks selection.
- Manual selected families are mandatory at runtime.
- Arbiter cannot silently omit selected Manual families.
- Sub-items remain prompt focus facets, not generated card units.
- Final hand includes forced selected-family cards unless provider/cache validation fails.
- Every forced failure has sanitized omission metadata.
- Auto behavior is unchanged except for any shared copy/docs clarifications.
- No raw provider prompts, raw provider responses, hidden reasoning, secrets, or chat text leak into diagnostics.
