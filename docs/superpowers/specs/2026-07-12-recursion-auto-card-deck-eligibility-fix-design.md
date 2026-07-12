# Auto Card Deck Eligibility Fix

## Status

Design and implementation specification. No production code changes are included in this document.

## Problem

Auto mode currently treats Card Deck selection as a preference rather than an eligibility boundary. A user can mark cards Inactive, but the Utility Arbiter may still request cards from those families.

This contradicts the Card System contract:

```text
Auto candidates = Active cards + Priority cards
Inactive cards = never eligible
Priority cards = forced first, then Active cards backfill up to Max Cards
```

### Confirmed SG-1 evidence

The latest `default-user` SG-1 branch persisted:

- Active deck: `Test Deck`
- Total cards: `34`
- Active cards: `3`, all in `Scene Frame`
- Inactive cards: `31`
- Priority cards: `0`

The latest run journal recorded `selectedCount: 6` and selected:

- Scene Frame
- Scene Constraints
- Active Cast
- Knowledge
- Character Motivation
- Relationship

The hand was genuinely composed with six cards. This was not only a Last Brief display error.

The same journal records:

```text
Scene cache invalidated: contract-mismatch
reason: providerContractHash
```

Therefore the run did not reuse the prior scene cache. It generated a fresh fused card bundle and selected six cards.

Evidence sources inspected:

- `F:\SillyTavern\SillyTavern\data\default-user\settings.json`
- `F:\SillyTavern\SillyTavern\data\default-user\user\files\recursion-run-journal-SG-1---2025-11-17-15h46m05s---Branch-1.v1.json`
- `F:\SillyTavern\SillyTavern\data\default-user\user\files\recursion-scene-SG-1---2025-11-17-15h46m05s---Branch-1-SG-1---2025-11-17-15h46m05s---Branch-1-aae6bbd1.v1.json`

## Root cause

### Auto scope is explicitly non-strict

Current `src/card-scope.mjs` behavior:

```js
const mode = settings?.mode === 'manual' ? 'manual' : 'auto';
const strictWhitelist = mode === 'manual';
```

Auto then exposes every catalog family through `availableCatalog` and marks every family as an exception:

```js
autoExceptionFamilies: strictWhitelist
  ? []
  : CARD_SCOPE_CATALOG.map((entry) => entry.family)
```

The Arbiter receives this policy text from `src/runtime.mjs`:

```js
return 'Auto card scope policy: selected families and sub-items are the preferred focus, not a whitelist. Prefer selected scope when it can satisfy the turn; request unselected families only when they have high relevance to scene constraints, scene coherence, or the current user message.';
```

That policy is now invalid for Card Decks. It allows the Arbiter to select inactive families.

### Runtime filtering preserves Auto jobs

Current filtering intentionally bypasses Auto enforcement:

```js
export function filterCardJobsForScope(cardJobs, settings = {}) {
  const entries = Array.isArray(cardJobs) ? cardJobs : [];
  const scope = scopePayloadForArbiter(settings);
  if (!scope.strictWhitelist) {
    return { cardJobs: entries.slice(), omitted: [], scope };
  }
  // Manual filtering only...
}
```

This means an Arbiter plan containing disabled-family jobs passes through unchanged in Auto mode.

### Family scope is too coarse for Card Deck eligibility

`activeCardDeckRuntimeScope()` currently converts runnable deck cards into family/sub-item scope:

```js
for (const card of Object.values(deck.cards || {})) {
  if (!getDeckCardStatus(card).runnable) continue;
  enableCardScopeSubItems(scope, card.builtinFamily, card.selectedSubItems);
}
```

This is useful for prompt shaping, but it loses the exact card-ID boundary. Eligibility must be represented separately from family focus.

## Design

### Separate focus from eligibility

Keep family/sub-item scope for prompt guidance and catalog shaping. Add an exact Card Deck eligibility payload for runtime enforcement.

```js
{
  mode: 'auto',
  activeDeckId: 'deck-...',
  allowedCardIds: [
    'card-scene-frame-1',
    'card-scene-frame-2',
    'card-scene-frame-3'
  ],
  priorityCardIds: [],
  activeCardIds: [
    'card-scene-frame-1',
    'card-scene-frame-2',
    'card-scene-frame-3'
  ],
  selectedFamilies: ['Scene Frame'],
  selectedSubItemsByFamily: {
    'Scene Frame': ['location/situation', 'immediate direction', 'beat constraint']
  },
  strictWhitelist: true,
  source: 'active-card-deck'
}
```

`strictWhitelist` should describe runtime eligibility, not legacy Manual-vs-Auto behavior. Auto and Manual both require hard eligibility filtering. Their difference is selection policy:

- Manual: user-selected families/cards are forced subject to Manual rules.
- Auto: Active cards are candidates; Priority cards are forced first; no Inactive card is eligible.

### Card states

```text
Inactive  -> excluded from Arbiter catalog, plan jobs, cache reuse, and final hand
Active    -> eligible for Auto backfill
Priority  -> eligible and forced before Active backfill in Auto
```

Priority must not create a second unrestricted candidate path. It only changes ordering and force semantics inside the allowed set.

### Auto selection algorithm

```js
const eligible = activeDeckCards.filter((card) => {
  const state = cardSelectionState(card);
  return state === 'active' || state === 'priority';
});

const priority = eligible.filter((card) => cardSelectionState(card) === 'priority');
const active = eligible.filter((card) => cardSelectionState(card) === 'active');

const orderedCandidates = [
  ...priority,
  ...rankActiveCardsForAuto(active, context)
];

const hand = selectUpToMaxCards(orderedCandidates, settings.maxCards);
```

If priority count exceeds `Max Cards`, the runtime should preserve deterministic priority ordering and record a visible diagnostic such as `priority-card-cap`. Inactive cards remain excluded regardless of budget pressure.

## Proposed implementation

### 1. Build exact deck eligibility

Add a helper in `src/card-decks.mjs`:

```js
export function activeCardDeckEligibility(settings = {}) {
  const deck = getActiveCardDeck(settings);
  const cards = orderedDeckCardsAcrossCategories(deck)
    .filter((card) => getDeckCardStatus(card).runnable);

  const activeCardIds = cards
    .filter((card) => cardSelectionState(card) === 'active')
    .map((card) => card.id);

  const priorityCardIds = cards
    .filter((card) => cardSelectionState(card) === 'priority')
    .map((card) => card.id);

  return {
    activeDeckId: deck.id,
    activeCardIds,
    priorityCardIds,
    allowedCardIds: [...priorityCardIds, ...activeCardIds]
  };
}
```

The helper must return no cards for `off`, draft, unnamed, or empty-prompt cards.

### 2. Add eligibility to runtime scope

Extend `settingsWithRuntimeCardScope()` or its returned runtime metadata:

```js
function settingsWithRuntimeCardScope(settings = {}, options = {}) {
  const source = options.normalize === true ? normalizeSettings(settings) : asObject(settings);
  const cardDecks = normalizeCardDeckSettings(source.cardDecks);
  const normalized = { ...source, cardDecks };

  return {
    ...normalized,
    cardScope: source.cardDecks
      ? activeCardDeckRuntimeScope(normalized)
      : normalizeCardScope(source.cardScope),
    cardEligibility: source.cardDecks
      ? activeCardDeckEligibility(normalized)
      : null
  };
}
```

Keep `cardScope` for family/sub-item focus. Do not overload it with card-ID eligibility.

### 3. Make Arbiter catalog strict in both modes

Replace the current Auto exception policy with an exact eligible catalog. The Arbiter should receive only eligible card entries as selectable candidates.

```js
function eligibleCatalogForSettings(settings = {}) {
  const eligibility = settings.cardEligibility || activeCardDeckEligibility(settings);
  const allowed = new Set(eligibility.allowedCardIds);
  const deck = getActiveCardDeck(settings);

  return orderedDeckCardsAcrossCategories(deck)
    .filter((card) => allowed.has(card.id))
    .map((card) => deckCardCatalogPayload(card));
}
```

The Arbiter prompt should state:

```text
Card eligibility is a hard whitelist.
Only cards in allowedCardIds may be selected or generated for this turn.
Inactive cards are unavailable, even if their family appears in the general catalog.
Priority cards must be considered before normal Active cards.
```

The fixed family catalog may remain available as non-selectable reference material for prompt semantics, but it must not be presented as an unrestricted job catalog.

### 4. Filter Arbiter output by exact card/family eligibility

Add a runtime enforcement pass after Arbiter output normalization and before card generation:

```js
function filterPlanForCardEligibility(plan, settings = {}) {
  const eligibility = settings.cardEligibility || activeCardDeckEligibility(settings);
  const allowedIds = new Set(eligibility.allowedCardIds);
  const acceptedJobs = [];
  const omitted = [];

  for (const job of Array.isArray(plan?.cardJobs) ? plan.cardJobs : []) {
    const requestedId = String(job.cardId || job.refreshOfCardId || '');
    const family = String(job.family || '');
    // Card Deck jobs must carry an exact card id. Family-only jobs are
    // ambiguous when a deck contains multiple cards in one family.
    const allowed = Boolean(requestedId) && allowedIds.has(requestedId);

    if (allowed) acceptedJobs.push(job);
    else omitted.push({
      cardId: requestedId,
      family,
      reason: 'inactive-card-ineligible'
    });
  }

  return {
    plan: { ...plan, cardJobs: acceptedJobs },
    omitted,
    diagnostics: omitted.map((entry) => `card-eligibility-rejected:${entry.family || entry.cardId}`)
  };
}
```

Family-only jobs need deterministic handling. Custom Card Deck jobs must carry exact card IDs. A family-only job may be resolved only when the active deck contains exactly one eligible card for that family; otherwise reject it as `card-id-required`. This prevents an inactive card from entering through a family-level alias.

### 5. Filter cache cards before Arbiter and final hand selection

Current cache cards can outlive deck-state changes. Add a single helper used at every cache boundary:

```js
function filterCacheCardsForEligibility(cards = [], settings = {}) {
  const eligibility = settings.cardEligibility || activeCardDeckEligibility(settings);
  const allowedIds = new Set(eligibility.allowedCardIds);
  return (Array.isArray(cards) ? cards : []).filter((card) => {
    if (card.cardId && allowedIds.has(card.cardId)) return true;
    if (card.id && allowedIds.has(card.id)) return true;
    return false;
  });
}
```

Use it in:

- `compactSceneCacheForArbiter()` input preparation.
- Rapid warm-card reuse.
- Fused card bundle reuse.
- Final `selectHand()` input.
- Last Brief hand reconstruction if the hand predates the current deck state.

Filtering at final hand selection is mandatory defense in depth even if earlier stages are correct.

### 6. Include eligibility state in cache contracts

Add a stable selection signature to `cacheContractVersions()`:

```js
function cardEligibilitySignature(settings = {}) {
  const eligibility = activeCardDeckEligibility(settings);
  return hashJson({
    activeDeckId: eligibility.activeDeckId,
    activeCardIds: [...eligibility.activeCardIds].sort(),
    priorityCardIds: [...eligibility.priorityCardIds].sort()
  });
}

export function cacheContractVersions(settings = {}) {
  return {
    // existing contract fields...
    cardEligibilityHash: cardEligibilitySignature(settings)
  };
}
```

The cache becomes stale when any card changes between Inactive, Active, or Priority, when a deck changes, or when a card is added, deleted, or moved across categories.

### 7. Correct diagnostics and Last Brief semantics

Record the eligibility boundary in run metadata:

```js
{
  activeDeckId,
  eligibleCardCount,
  activeCardCount,
  priorityCardCount,
  rejectedInactiveJobCount,
  rejectedInactiveCacheCount,
  selectedCardIds
}
```

Last Brief should display only the final filtered hand. It must not display raw Arbiter requests, stale cache cards, or pre-filter generated candidates.

The progress menu should distinguish:

```text
Using cached hand: 2 cards
Generated eligible cards: 3
Rejected inactive requests: 4
```

If no cache was used because of a contract mismatch, show the actual reason rather than implying a normal fresh run.

## Compatibility and migration

No legacy compatibility shim is required. Recursion is pre-alpha.

Existing family scope data can remain normalized. New runtime eligibility is derived from the active deck on every run. Existing scene caches should be filtered or invalidated when their `cardEligibilityHash` is missing.

The bundled Default Deck remains read-only. Its legacy `defaultEnabledState` should be converted into the same exact eligibility representation when active, rather than bypassing the new filter.

## Testing plan

### Unit tests

Add tests to `tools/scripts/test-card-decks.mjs`:

```js
const settings = {
  mode: 'auto',
  cardDecks: makeDeckSettings({
    cards: {
      activeOne: makeCard({ selectionState: 'active' }),
      activeTwo: makeCard({ selectionState: 'active' }),
      priorityOne: makeCard({ selectionState: 'priority' }),
      inactiveOne: makeCard({ selectionState: 'off' })
    }
  })
};

const eligibility = activeCardDeckEligibility(settings);
assertDeepEqual(
  eligibility.allowedCardIds.sort(),
  ['activeOne', 'activeTwo', 'priorityOne'].sort(),
  'Auto eligibility excludes inactive cards'
);
```

### Runtime tests

Add tests to `tools/scripts/test-runtime.mjs`:

```js
const plan = {
  cardJobs: [
    { cardId: 'active-card', family: 'Scene Frame' },
    { cardId: 'inactive-card', family: 'Active Cast' }
  ]
};

const filtered = filterPlanForCardEligibility(plan, autoSettings);
assertEqual(filtered.plan.cardJobs.length, 1, 'Auto rejects inactive Arbiter jobs');
assertEqual(filtered.omitted[0].reason, 'inactive-card-ineligible', 'Auto records inactive rejection reason');
```

Add cache tests:

```js
const oldVersions = cacheContractVersions(settingsWithThreeActiveCards);
const changedVersions = cacheContractVersions(settingsWithOneActiveCard);
assert(oldVersions.cardEligibilityHash !== changedVersions.cardEligibilityHash, 'card state changes invalidate cache eligibility');
```

### Regression scenario

Reproduce the SG-1 state exactly:

1. Active deck contains three Active Scene Frame cards.
2. All other cards are Inactive.
3. Mode is Auto.
4. Max Cards is at least six.
5. Run a fresh turn with no usable cache.

Required result:

```text
Selected hand contains only the three Scene Frame card IDs.
No Active Cast, Knowledge, Relationship, Character Motivation, or other inactive card appears.
```

Then repeat with:

- One Priority card plus three Active cards.
- More Priority cards than Max Cards.
- A cached hand containing cards that were later made Inactive.
- A card changed from Active to Inactive while the deck remains selected.
- A custom deck with multiple cards sharing one family.

### Live Playwright validation

The live proof should assert the actual active deck state and final hand:

```js
const runtime = await page.evaluate(() => globalThis.__recursionLiveHarnessRuntime?.view?.());
const deck = runtime.settings.cardDecks.customCardDecks[runtime.settings.cardDecks.activeCardDeckId];
const allowed = Object.values(deck.cards)
  .filter((card) => card.selectionState === 'active' || card.selectionState === 'priority')
  .map((card) => card.id);

const hand = runtime.lastHand?.cards || [];
assert(hand.every((card) => allowed.includes(card.id)), 'live hand contains only eligible deck cards');
```

The proof must also inspect progress metadata and confirm that cache reuse is reported accurately.

## Implementation sequence

1. Add `activeCardDeckEligibility()` and unit tests.
2. Add eligibility metadata to runtime settings and cache signatures.
3. Replace Auto’s advisory catalog with an eligible-card catalog plus separate family focus metadata.
4. Add exact Arbiter plan filtering and inactive rejection diagnostics.
5. Filter cache inputs and final hand inputs.
6. Update Last Brief and progress metadata to use the filtered hand and explicit cache reason.
7. Add SG-1 regression coverage to runtime tests.
8. Add live Playwright coverage for three-active-card Auto mode and Priority backfill.
9. Verify served `default-user` extension copy before declaring the fix complete.

## Acceptance criteria

- Auto cannot select or generate Inactive cards.
- Priority cards are forced before Active backfill.
- Active cards are the only normal Auto candidates.
- Final hand, Last Brief, prompt packet, and cache reuse all agree.
- Cache state changes when active, inactive, or priority states change.
- Progress reports fresh generation, cache reuse, and rejected inactive requests accurately.
- Manual mode remains a strict whitelist and does not regress.
- Empty eligibility produces no card-related calls while post-generation enhancements remain available.
- SG-1 three-active-card reproduction passes on the real default-user host.
