# Recursion Cache Use and Reuse Specification

## Purpose

This document defines the cache contract for the entire Recursion extension.
It distinguishes reusable generation work from persisted configuration,
diagnostics, host swipe variants, and UI state. It also defines the required
invalidation behavior, especially for interrupted SillyTavern swipes.

The goal is simple:

> Reuse valid work whenever the source and contracts still match; regenerate
> only the work that is stale, missing, explicitly bypassed, or unsafe.

## Current Problem

The current implementation has several valid reuse paths, but they are not
yet governed by one explicit contract. The most concerning sequence is:

```text
Fused generation succeeds
  -> user swipes
  -> user stops the swipe
  -> user swipes again
  -> prior retry marker is cleared
  -> active scene cache is invalidated
  -> cards and/or the Fused bundle regenerate
```

The current host-stop path calls both:

```js
clearPendingLatestAssistantSwipeRetry();
invalidateActiveSceneCacheBestEffort('host-generation-stopped', details);
```

That is too destructive when the stopped operation was an attempted swipe and
the previous completed packet and scene cache are still valid.

## Cache Taxonomy

### 1. Scene card cache

**Owner:** `src/runtime.mjs`, `src/storage.mjs`

Stores disposable, scene-local generated cards and the latest selected hand.
It is the primary reusable generation cache for Standard and Fused.

```js
{
  recordType: 'recursion.sceneCache',
  cacheState: 'active',
  activeSourceRevisionHash,
  variants: {
    [sourceRevisionHash]: {
      sourceRevisionHash,
      cards,
      latestHand,
      rapid
    }
  }
}
```

Scene cache cards are reusable only after source-range, evidence, fingerprint,
schema, catalog, provider, and prompt-contract validation.

### 2. Source-revision variants

Each scene may retain multiple source variants keyed by
`sourceRevisionHash`. Variants support source-history inspection, swipe A/B/A
behavior, and Rapid alternate-variant lookup.

Keeping a variant does not make it automatically active. Standard and Fused
must prefer the exact active source variant unless an explicit reuse policy
allows a validated alternate.

### 3. Latest-assistant swipe packet reuse

**Owner:** `src/runtime.mjs`, `src/runtime/run-state.mjs`

This is a complete prompt-packet reuse path, separate from scene-card cache.
When the latest assistant message is swiped and the source before that
assistant remains unchanged, Recursion may reinstall the previous packet and
hand without provider work.

```js
{
  reason: 'same-turn-swipe-retry',
  packet: lastPacket,
  hand: lastHand,
  reused: true
}
```

The reuse check must compare chat identity, scene identity, source revision,
scene fingerprint, turn fingerprint, snapshot hash, and the bounded source
window.

### 4. Standard and Fused card reuse

The Utility Arbiter may return:

```js
{ action: 'reuse-cache' }
```

The runtime then skips card provider calls:

```js
const reuseCacheOnly = !freshContext
  && action === 'reuse-cache'
  && cacheCards.length > 0;

const generatedCardResult = reuseCacheOnly
  ? { cards: [], diagnostics: [] }
  : await generatePlanCards(...);
```

Fused does not require a separate Fused-result cache. A valid scene card cache
is sufficient to avoid the Fused bundle call. Progress must show the reused
category and source cards as purple cached rows.

### 5. Rapid warm cache

**Owner:** `src/rapid-pipeline.mjs`, `src/rapid-warm-state.mjs`,
`src/runtime.mjs`

Rapid stores a warm provider-authored artifact in the scene cache. It contains
warm guidance, selected card IDs, and exact contract hashes.

```js
rapidWarmArtifactIsUsable(artifact, {
  baseSourceRevisionHash,
  settingsHash,
  providerContractHash,
  cardCatalogHash,
  promptContractHash,
  storyForm
});
```

Rapid may reuse an exact variant or a validated alternate variant. A warm miss
must visibly escalate to Standard rather than silently pretending that Rapid
was reused.

### 6. Same-turn prompt installation

Prompt installation can reuse `lastPacket` without model work when
`canReuseLastPacketForSnapshot()` succeeds. This is prompt reuse, not card
generation reuse, and should be reported separately in diagnostics and
progress.

### 7. Enhancement swipe deduplication

Generation Review outputs are stored in SillyTavern swipe variants. The
`generationReviewKey()` path prevents duplicate work only when the full frozen
review snapshot is identical, not merely the same chat, message, swipe, and
original-text hash.

This is host-output reuse, not scene-card cache reuse.

### 8. Last Brief

Last Brief is an in-memory representation of the most recent packet and hand.
It is an inspection surface and a source for same-turn packet reuse, but it is
not an independent generation cache.

The committed Last Brief remains reviewable until the next user-initiated host
generation is accepted. Repair, Recompose, Redirect, Enhancement-owned message
replacement or swipe selection, host save/reload events, Fresh Next arming,
and navigation among existing swipes do not consume it. Send, swipe generation,
and regenerate consume it at the `prepareForGeneration({ hostGeneration: true
})` boundary; the next successful prompt installation then atomically becomes
the new Last Brief. Explicit disable, scene-cache reset, chat change, teardown,
and page reload may clear the in-memory inspection snapshot.

### 9. Storage index and run journal

The storage index and run journal are diagnostic persistence. They record cache
hits, misses, invalidation reasons, and reuse provenance. They must never be
treated as prompt-generation input.

### 10. Card Decks and settings

Decks, cards, categories, active states, priorities, and settings are persisted
configuration. They are not cache records, but changes to them may invalidate
cached generated cards or warm artifacts.

### 11. Provider-side caching

Recursion does not currently own a provider-response cache. Provider-side
prompt caching is external and must not be confused with Recursion card or
packet reuse.

## Unified Cache Contract

Every reusable artifact should expose the following conceptual fields:

```ts
type CacheProvenance = {
  cacheKind:
    | 'scene-cards'
    | 'swipe-packet'
    | 'rapid-warm'
    | 'enhancement-swipe';
  sourceRevisionHash?: string;
  sceneFingerprint?: string;
  turnFingerprint?: string;
  snapshotHash?: string;
  settingsHash?: string;
  providerContractHash?: string;
  cardCatalogHash?: string;
  promptContractHash?: string;
  createdAt?: string;
  reusedAt?: string;
};

type CacheDecision =
  | 'hit'
  | 'miss'
  | 'stale'
  | 'invalid'
  | 'bypassed'
  | 'canceled';
```

A cache hit requires all mandatory identity and contract fields to match. A
missing field is a miss unless the specific cache contract explicitly allows
it.

## Message-Depth and Context Contract

Recursion reads messages for two different purposes: determining whether
scene-local cached work is still fresh, and supplying bounded context to
recursive card/guidance calls and the single Generation Review and Enhancement pass. These
purposes remain distinct but must be reported together.

### Current settings

| Setting | Current default | Role |
| --- | ---: | --- |
| `retention.sourceWindowMessages` | 20 | Recent visible messages used for source freshness and cache identity |
| `retention.sourceWindowCharacters` | 12000 | Character cap for the source freshness window |
| `retention.providerVisibleMessages` | 12 | Recent messages sent to Arbiter, Standard card, Fused card, and guidance calls |
| `enhancements.contextMessages` | 13 | Requested recent-message count for the Generation Review snapshot |

The source window walks backward from the latest visible non-system message
until the message cap or character budget is reached.

### Effective context

Enhancement context is bounded by the already-bounded source window:

```js
const effectiveEnhancementMessages = Math.min(
  settings.enhancements.contextMessages,
  snapshot.messages.length
);
```

The effective contract is:

```text
Source freshness: up to sourceWindowMessages and sourceWindowCharacters
Recursive providers: up to providerVisibleMessages from the source window
Enhancements: up to enhancements.contextMessages from the source window
```

These settings control Recursion analysis and Enhancement requests only. The
final story model context remains owned by SillyTavern.

### Shared context descriptor

Add one shared descriptor at the runtime boundary and pass it into cache,
provider, Enhancement, and diagnostics paths:

```js
function buildContextContract(snapshot = {}, settings = {}) {
  const retention = normalizeRetentionSettings(settings.retention);
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const requestedEnhancementMessages = Math.max(
    0,
    Math.min(35, Math.round(Number(settings.enhancements?.contextMessages) || 0))
  );

  return {
    sourceWindow: {
      configuredMessages: retention.sourceWindowMessages,
      configuredCharacters: retention.sourceWindowCharacters,
      actualMessages: messages.length,
      firstMesId: snapshot.sourceWindowFirstMesId,
      lastMesId: snapshot.sourceWindowLastMesId,
      truncated: snapshot.sourceWindowTruncated === true,
      limitReason: snapshot.sourceWindowLimitReason || ''
    },
    providerContext: {
      configuredMessages: retention.providerVisibleMessages,
      effectiveMessages: Math.min(retention.providerVisibleMessages, messages.length)
    },
    enhancementContext: {
      configuredMessages: requestedEnhancementMessages,
      effectiveMessages: Math.min(requestedEnhancementMessages, messages.length)
    }
  };
}
```

### Source identity and cache freshness

Scene cache identity must use the full bounded source window, not the smaller
provider or Enhancement window:

```js
const sourceRevisionHash = sourceWindowFingerprint(snapshot);
const cacheIdentity = {
  chatId: snapshot.chatId,
  sceneKey: snapshot.sceneKey,
  sourceRevisionHash,
  sourceWindowFirstMesId: snapshot.sourceWindowFirstMesId,
  sourceWindowLastMesId: snapshot.sourceWindowLastMesId,
  sourceWindowMessages: snapshot.messages.length
};
```

Changes inside this window invalidate scene-card reuse. Changes older than the
configured source window do not alter current-scene cache identity.

### Provider request context

Arbiter, Standard card, Fused card, and guidance requests should use the
provider slice and record its effective size:

```js
function providerSafeSnapshotWithContract(snapshot, settings) {
  const retention = normalizeRetentionSettings(settings.retention);
  const messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.map(providerSafeMessage).filter(Boolean)
      .slice(-retention.providerVisibleMessages)
    : [];

  return {
    snapshot: { ...snapshot, messages },
    context: {
      configuredMessages: retention.providerVisibleMessages,
      effectiveMessages: messages.length
    }
  };
}
```

### Enhancement request context

Generation Review uses the same bounded context builder as recursive work, then
adds the frozen generation-time packet and card evidence:

```js
const contract = buildContextContract(snapshot, settings);
const contextMessages = snapshot.messages.slice(
  -contract.enhancementContext.effectiveMessages
);

const request = buildGenerationReviewRequest({
  sourceText: snapshot.latestAssistant.text,
  sourceHash: snapshot.latestAssistant.hash,
  targets: buildEnhancementTargets(snapshot.latestAssistant.text),
  reviewSnapshot: buildGenerationReviewSnapshot({ packet, installedHand, pipeline }),
  contextMessages,
  contextMessageLimit: contract.enhancementContext.effectiveMessages,
  contextContract: contract
});
```

Enhancements should also enforce a total context-character budget:

```js
function boundEnhancementMessages(messages = [], maxMessages = 13, maxCharacters = 9000) {
  const selected = [];
  let characters = 0;
  for (const message of [...messages].reverse()) {
    const text = String(message?.text || '').slice(0, 1200);
    if (selected.length >= maxMessages || characters + text.length > maxCharacters) break;
    selected.unshift({ ...message, text });
    characters += text.length;
  }
  return { messages: selected, characters };
}
```

### Enhancement identity

The Generation Review key identifies the active message and original text plus
the complete frozen review snapshot. It must include the review-snapshot hash:

```js
const reviewSnapshot = buildGenerationReviewSnapshot({
  sourceRevisionHash: snapshot.sourceRevisionHash,
  contextMessages,
  configuredContextMessages: settings.enhancements?.contextMessages,
  installedHand,
  promptPacket: lastPacket,
  pipeline: settings.pipelineMode,
  antiSlopProfileVersion: ANTI_SLOP_PROFILE_VERSION,
  providerSignature: providerSettings.signature
});
const snapshotHash = generationReviewSnapshotHash(reviewSnapshot);

const enhancementKey = generationReviewKey({
  chatKey,
  messageId,
  swipeId,
  sourceHash: originalHash,
  snapshotHash
});
```

Changing relevant context or Enhancement depth must prevent stale Enhancement
reuse while leaving unrelated scene-card cache intact.

Only a fully validated review ledger may enter this cache. Persist the applied
patch ledger hash, review-domain statuses, normalized card outcomes, final
outcome (`applied` only), and compact recovery metadata. Do not cache a raw
provider response, hidden reasoning, an unsafe patch result, or a
`partial-failed` review with unresolved card coverage. Re-running an unresolved
partial review must call the provider again unless the user explicitly sees and
accepts a future retained-partial feature.

### Context diagnostics

Every run and Enhancement pass should expose configured and effective depth:

```js
{
  sourceWindow: {
    configuredMessages: 20,
    configuredCharacters: 12000,
    actualMessages: 18,
    firstMesId: 7,
    lastMesId: 24,
    truncated: true,
    limitReason: 'message-cap'
  },
  providerContext: { configuredMessages: 12, effectiveMessages: 12 },
  enhancementContext: {
    configuredMessages: 13,
    effectiveMessages: 13,
    actualCharacters: 6840
  }
}
```

Concise UI labels may be:

```text
Source freshness: 18/20 messages
Provider context: 12 messages
Enhancement context: 13 messages
```

Raw transcript text must not enter normal diagnostics.

## Visual User Feedback Contract

Cache behavior must be visible without exposing raw prompts, transcript text,
provider payloads, or implementation terminology. The main Recursion bar is the
authoritative status surface. The progress dropdown provides the detailed
hierarchy. Settings and Last Brief provide bounded inspection context.

### Visual state language

Use only the established Recursion state colors:

| State | Color | Meaning |
| --- | --- | --- |
| Waiting / neutral | muted gray | Work has not started or has no exceptional outcome |
| Running | cyan | A provider, cache, or prompt operation is active |
| Success | green | Work completed successfully this turn |
| Cached | purple | Valid prior work was reused; no new model call occurred |
| Caution | yellow | Work completed with repair, fallback, retry, or degradation |
| Failure | red | Work failed or an explicit source/card omission occurred |

No additional blue, orange, or ambiguous status colors should be introduced.

### Main Recursion bar

The main bar must summarize the current cache decision in compact status text:

| Runtime condition | Main-bar status |
| --- | --- |
| No active run | `Scene deck standing by.` |
| Scene cache hit | `Reusing scene deck.` |
| Swipe packet hit | `Reusing swipe context.` |
| Rapid warm hit | `Rapid deck ready.` or `Rapid turn using warm deck.` |
| Cache miss | `Refreshing scene deck.` |
| Source mismatch | `Scene changed; refreshing cards.` |
| Contract mismatch | `Cache expired; rebuilding cards.` |
| Force Fresh | `Fresh generation requested.` |
| Stopped swipe preserved | `Swipe stopped; previous context preserved.` |
| Stopped run discarded | `Generation stopped.` |
| Cache/storage failure | `Cache unavailable; rebuilding from current context.` |

The main bar should not say only `done` or `generated` when cached work was
used. It must communicate that no new provider call was made.

### Main-bar cache indicator

The compact Hero Pixel Array may include one cache-state block:

```text
running  -> cyan animated block
hit      -> purple filled block
miss     -> gray completed inspection followed by generated green work
stale    -> yellow only when a repairable cache issue requires attention
invalid  -> red only when the cache operation failed, not merely because it was stale
```

A normal stale or source-mismatch cache should not make the entire run appear
failed. The user should see that Recursion is rebuilding normally.

### Progress dropdown hierarchy

The progress tree must show cache decisions at the level where they occurred:

```text
Reusing scene deck                         purple cached
  Fused card bundle                       purple cached
    Scene Frame                           purple cached
      location/situation                  purple cached
      immediate direction                 purple cached
      beat constraint                     purple cached
Reinstalling Recursion prompt              purple cached
Composing prompt packet                    green done
Recursion prompt ready                     green done
```

For a generated Fused run:

```text
Fused card bundle                         green generated
  Scene Frame                             green generated
    location/situation                    green included
```

For a cache miss caused by source change:

```text
Checking scene cache                      gray done
Scene cache stale                         gray done
Generating Fused card bundle              cyan running
Fused card bundle                         green generated
```

The stale/miss row should include a concise reason in its tooltip, not turn the
new successful generation yellow.

### Cache row metadata

Each cache-related progress row should expose a short metadata label:

```text
cached
reused
source changed
contract changed
fresh
preserved after stop
rebuilding
```

Recommended tooltip shape:

```text
Scene Frame
Cached from the current scene source.
Source window: 18/20 messages.
Provider call skipped.
```

For provider context:

```text
Fused card bundle
Generated for the current scene.
Provider context: 12 messages.
```

For Enhancement context:

```text
Generation Review and Enhancement
Context: 13 messages.
Source freshness window: 18 messages.
```

Tooltips must remain bounded and must not include transcript text or provider
responses.

### Cache miss and invalidation feedback

A cache miss is normal and should be described without alarming the user:

```text
Source changed; refreshing cards.
```

Use caution only when the miss involves a recoverable problem:

```text
Cached cards were stale and were discarded.
```

Use failure only when the operation itself failed:

```text
Scene cache could not be read. Rebuilding from current context.
```

The UI must distinguish:

```text
stale cache -> normal rebuild
missing cache -> normal first-build miss
invalid cache -> discarded and rebuilt
storage failure -> explicit caution/failure with reason
```

### Stop and swipe feedback

The stop-then-swipe sequence requires explicit state transitions:

```text
Swipe started                              cyan running
Swipe stopped                             gray canceled
Previous context preserved                 purple cached
Next swipe reuses prior context            purple cached
```

The main bar should say:

```text
Swipe stopped; previous context preserved.
```

The progress dropdown should show:

```text
Generation canceled                       gray canceled
Reusing swipe context                      purple cached
Reinstalling Recursion prompt              purple cached
```

It must not show a false new Fused or Standard generation if the previous
packet was reused.

### Force Fresh feedback

Force Fresh must be visibly distinct from an ordinary cache miss:

```text
Fresh generation requested.                cyan or gray armed state
Rebuilding scene deck                      cyan running
Fused card bundle                          green generated
```

The fresh control should show a pressed/armed state until consumed or canceled.
Its tooltip should state:

```text
Force the next send or swipe to bypass cached cards, warm decks, and same-turn packet reuse.
```

### Last Brief feedback

Last Brief should show provenance per category/card without adding a second
status system:

```text
Scene Frame
  location/situation       cached
  immediate direction      cached
```

Recommended compact chips:

```text
cached
generated
retried
fallback
fresh
```

The Last Brief header should expose a bounded summary:

```text
Cards: 6
Source: 18 messages
Provider context: 12 messages
Enhancement context: 13 messages
Reused: 6 cards
```

If no cache was used, omit the `Reused` line rather than displaying
`Reused: 0`.

### Settings feedback

Retention and Enhancement depth controls must explain their distinct scopes
with tooltips and compact helper text:

```text
Source Messages
Controls how far back Recursion checks scene freshness and card cache validity.

Source Text Budget
Caps the total text used for scene freshness. This does not delete chat messages.

Provider Messages
Controls how many recent messages Recursion sends to card and guidance calls.

Enhancement Context
Controls how many recent messages Prose and Dialogue passes inspect.
```

After a setting changes, the main bar should report the consequence:

```text
Source window changed; cached cards will rebuild on the next run.
Provider context changed; cached cards may be re-evaluated.
Enhancement context changed; next Enhancement pass uses the new depth.
```

Changing Enhancement context must not claim that the scene card cache was
reset. Changing source-window or provider-depth settings may legitimately
invalidate scene-card cache contracts.

### Mobile behavior

Mobile feedback must preserve the same semantics without relying on hover:

- Use the same state colors and icon language.
- Keep cache state visible in the row without requiring a tooltip.
- Allow long-press or tap on a progress row to open bounded details.
- Keep the progress dropdown full-width and vertically scrollable.
- Preserve expanded category/card nesting while the heartbeat refreshes.
- Do not collapse the dropdown when cache progress updates arrive.
- Keep the cache reason available through an accessible label or detail sheet.
- Ensure the purple cached indicator is visible against the graphite background.

Mobile row detail should read naturally as a compact sentence:

```text
Scene Frame  cached
Included from the current scene cache.
```

### Accessibility and tooltip contract

Every cache indicator and cache-related icon must expose:

```js
{
  ariaLabel: 'Scene Frame cached',
  title: 'Scene Frame was reused from the current scene cache.',
  state: 'cached'
}
```

The accessible label must identify:

- what was reused;
- whether it was cached, generated, running, cautioned, or failed;
- the bounded reason when the state is not ordinary success.

### Visual acceptance matrix

The visual test suite must cover:

| Scenario | Main bar | Progress rows | Expected colors |
| --- | --- | --- | --- |
| Standard first generation | Refreshing scene deck | Generated categories/cards | cyan then green |
| Standard cached swipe | Reusing scene deck | Cached categories/cards | purple |
| Fused first generation | Generating Fused bundle | Nested generated source cards | cyan then green |
| Fused cached swipe | Reusing scene deck | Cached Fused/category/card rows | purple |
| Rapid warm hit | Rapid deck ready | Warm and foreground rows | purple/cyan/green |
| Rapid warm miss | Rapid warm missed; Standard started | Standard rows | yellow/gray then green |
| Stopped swipe | Previous context preserved | canceled then cached reuse | gray/purple |
| Force Fresh | Fresh generation requested | New provider calls | cyan then green |
| Storage failure | Cache unavailable; rebuilding | explicit failure reason | yellow/red then green if recovered |
| Enhancement context change | Enhancement depth updated | pass shows actual context count | existing pass state |

### Settings hashes and invalidation

Source-window and provider-context settings alter cache freshness or provider
evidence and must remain in the scene-cache settings signature:

```js
function cacheSettingsSignature(settings = {}) {
  return {
    ...existingCacheSettingsSignature(settings),
    retention: {
      sourceWindowMessages: settings.retention.sourceWindowMessages,
      sourceWindowCharacters: settings.retention.sourceWindowCharacters,
      providerVisibleMessages: settings.retention.providerVisibleMessages
    }
  };
}
```

Enhancement context depth should not invalidate scene-card cache, but must be
included in the Enhancement context hash.

### Swipe identity and depth

Latest-assistant swipe reuse should compare the bounded source window before
the swiped assistant:

```js
const reusable = hashJson(sourceWindowMessages(currentBeforeAssistant))
  === hashJson(sourceWindowMessages(previousBeforeAssistant))
  && currentBeforeAssistant.sourceRevisionHash
    === previousBeforeAssistant.sourceRevisionHash;
```

Stopping a swipe must preserve the last known-good packet and cache when this
identity still matches. It must not convert cancellation into source
invalidation.

### Documentation reconciliation

The active implementation defaults are:

```js
{
  sourceWindowMessages: 20,
  sourceWindowCharacters: 12000,
  providerVisibleMessages: 12,
  enhancements: { contextMessages: 13 }
}
```

Older design material describes larger source-window defaults. Those documents
must be updated or marked historical so the UI, operator manual, architecture
documents, and tests describe the same active contract.

## Reuse Decision Order

Generation preparation should evaluate reuse in this order:

```text
1. Explicit Force Fresh token?
   yes -> bypass all reusable work

2. Latest-assistant swipe retry with unchanged source?
   yes -> reinstall last packet; do not call providers

3. Valid same-turn packet snapshot?
   yes -> reinstall last packet; do not call providers

4. Rapid pipeline with valid warm artifact?
   yes -> run Rapid foreground delta

5. Arbiter returns reuse-cache with valid scene cards?
   yes -> reuse cached cards; skip card calls

6. Otherwise -> run the selected Standard or Fused card pipeline
```

The decision and reason must be recorded once per run:

```js
{
  cacheDecision: 'hit',
  cacheKind: 'swipe-packet',
  reason: 'same-turn-source-unchanged',
  providerCallsSkipped: ['utilityArbiter', 'fusedCardBundle', 'guidanceComposer']
}
```

## Invalidation Contract

### Hard invalidation

Hard invalidation removes or retires reusable data when contracts cannot be
trusted:

- storage schema mismatch;
- runtime cache contract mismatch;
- card catalog mismatch;
- provider contract mismatch;
- prompt contract mismatch;
- corrupt or unsafe record;
- explicit Reset Scene Cache;
- explicit Force Fresh.

### Source invalidation

Source invalidation applies when the truth being conditioned on changes:

- chat changes;
- source message edit;
- source message deletion;
- older-message swipe;
- active deck or card prompt changes;
- category/card active-state changes;
- relevant settings or provider changes.

### Cancellation

Cancellation is not automatically invalidation.

When a host generation stops, Recursion should cancel the active attempt while
preserving the last known-good packet and scene cache unless the source changed
or the active artifact was partially committed and unsafe.

For a swipe attempt specifically:

```text
Preserve previous packet: yes
Preserve previous hand: yes
Preserve previous scene cache: yes
Preserve swipe retry eligibility: yes, if source identity is unchanged
Mark current attempt: canceled
```

The next swipe may then reuse the previous work.

## Stop-Then-Swipe Contract

The current problematic path is:

```js
async function handleHostGenerationStopped(details = {}) {
  return clearForHostEvent({
    reason: 'host-generation-stopped',
    clearVolatileState: false
  });
}
```

`clearForHostEvent()` currently clears the pending swipe marker and invalidates
the active scene cache. That behavior should be split:

```js
function stopInvalidationPolicy({ activeAttempt, sourceChanged }) {
  if (sourceChanged) return 'invalidate-source';
  if (activeAttempt?.kind === 'swipe') return 'preserve-last-known-good';
  return 'preserve-last-known-good';
}
```

Then stop handling should record cancellation without destroying reusable
previous work:

```js
await cancelActiveAttempt({
  runId,
  reason: 'host-generation-stopped'
});

if (stopInvalidationPolicy({ activeAttempt, sourceChanged }) === 'invalidate-source') {
  await invalidateActiveSceneCacheBestEffort('source-changed', details);
}

rearmSwipeReuseIfSourceMatches(lastPacket, currentSnapshot);
```

The exact implementation should use a run-owned attempt record rather than a
global boolean so a stopped swipe cannot accidentally clear a newer attempt.

## Required Runtime Diagnostics

Each generation should expose:

```js
{
  cacheDecision: 'hit',
  cacheKind: 'scene-cards',
  cacheReason: 'arbiter-reuse-cache',
  cacheVariant: 'exact',
  reusedCardIds: ['scene-location', 'scene-direction'],
  providerCallsSkipped: ['sceneFrameCard', 'fusedCardBundle'],
  invalidationReason: ''
}
```

For a miss:

```js
{
  cacheDecision: 'miss',
  cacheKind: 'scene-cards',
  cacheReason: 'source-fingerprint-mismatch',
  rejectedCardCount: 3,
  providerCallsSkipped: []
}
```

For cancellation:

```js
{
  cacheDecision: 'canceled',
  cacheKind: 'swipe-packet',
  cacheReason: 'host-generation-stopped',
  preservedLastKnownGood: true
}
```

## Progress UI Contract

Progress must distinguish cache types:

```text
Reusing swipe prompt packet       purple cached
Reusing scene card cache          purple cached
Fused card bundle                 purple cached
Scene Frame                       purple cached
Rapid warm ready                  purple cached/ready
Generation canceled               gray skipped or canceled
```

The UI must not show a green generated row when no model call occurred, and it
must not show a new provider call when a cache hit skipped that call.

For source-card children:

```text
Parent category call success     children green
Parent category call caution     children yellow
Parent category call failure     children red
Parent category cached           children purple
```

## Testing and Validation

### Unit and contract tests

Add or maintain tests for:

- exact scene-cache hit;
- source-fingerprint mismatch;
- source-range mismatch;
- evidence-message deletion;
- settings hash drift;
- provider contract drift;
- card catalog drift;
- prompt contract drift;
- alternate source variants;
- cache retention and protected active scene;
- Standard `reuse-cache` skipping provider calls;
- Fused `reuse-cache` skipping the bundle call;
- Rapid warm exact hit;
- Rapid warm miss and Standard escalation;
- Force Fresh bypassing all reuse;
- same-turn packet reuse;
- source edit invalidating packet reuse;
- swipe retry reuse without provider work;
- stop-then-swipe preserving the last known-good cache;
- explicit source change after stop invalidating reuse;
- enhancement swipe deduplication;
- cache provenance in Last Brief and diagnostics.

Example contract test:

```js
const result = await runtime.prepareForGeneration({
  userMessage: 'Try the next swipe.'
});

assertEqual(result.reused, true, 'same-turn swipe reuses the prior packet');
assertDeepEqual(providerCalls, [], 'same-turn swipe makes no provider calls');
assertEqual(result.reason, 'same-turn-swipe-retry', 'reuse reason is explicit');
```

### Standard and Fused model-call tests

For each pipeline:

```text
First generation:
  provider call occurs
  scene cache is saved

Second unchanged swipe:
  provider call does not occur
  source cards are cached
  progress rows are purple

Edited source:
  cache is rejected
  provider call occurs
  rejection reason is visible

Force Fresh:
  cache is bypassed
  provider call occurs
```

Fused additionally requires:

- no Fused bundle call on a valid scene-cache hit;
- nested source cards under cached Fused categories;
- no false red/yellow source rows from missing coverage metadata.

### Playwright live validation

The live matrix must use a dedicated `recursion-soak-*` user and real provider
calls. It must inspect both network behavior and visible progress.

For each Standard and Fused run:

1. Open the named chat.
2. Enable the selected pipeline.
3. Perform a real generation.
4. Capture the request roles and runtime diagnostics.
5. Open the progress dropdown while the run is active and after settlement.
6. Assert category and source-card rows are nested correctly.
7. Assert generated rows are green and cached rows are purple.
8. Assert the provider call count matches the cache decision.

The swipe sequence must include:

```text
A. Generate normally.
B. Swipe without stopping.
C. Verify cached reuse.
D. Swipe again, stop the attempt.
E. Swipe again.
F. Verify prior valid cards or packet are reused.
G. Press Force Fresh.
H. Verify all relevant provider calls run again.
```

The Playwright assertion should inspect real rows:

```js
const rows = await page.locator(
  '[data-recursion-status-popover] [data-recursion-progress-row]'
).evaluateAll((nodes) => nodes.map((row) => ({
  label: row.querySelector('[data-recursion-progress-label]')?.textContent?.trim(),
  state: row.dataset.recursionProgressState,
  meta: row.querySelector('[data-recursion-progress-meta]')?.textContent?.trim()
})));

expect(rows.some((row) => row.label === 'Scene Frame' && row.state === 'cached')).toBe(true);
expect(rows.some((row) => row.label === 'location/situation' && row.state === 'cached')).toBe(true);
```

The live proof must fail if:

- a cache hit produces a provider call;
- a cache miss is presented as cached;
- a stopped swipe destroys a valid previous cache;
- the progress dropdown omits cached source cards;
- the Fused bundle regenerates unnecessarily;
- the UI shows false caution or success states;
- console errors or page errors occur.

### Visual coverage

Capture desktop and mobile screenshots for:

- Standard generated;
- Standard cached swipe;
- Fused generated;
- Fused cached swipe;
- stopped swipe followed by cached swipe;
- Force Fresh regeneration;
- cache miss with explicit invalidation reason.

Screenshots must show the progress dropdown, nested category/card rows, cache
colors, and the main status bar without overlapping chat content.

## Module Integration Snippets

The following snippets define the minimum implementation shape across the
extension. They are intentionally close to the current module boundaries so
the implementation can be applied without inventing a parallel cache layer.

### Runtime attempt ownership

Add an attempt record to `src/runtime/run-state.mjs`:

```js
let activeAttempt = null;

function beginAttempt(input = {}) {
  activeAttempt = {
    runId: String(input.runId || ''),
    kind: ['normal', 'swipe', 'fresh'].includes(input.kind)
      ? input.kind
      : 'normal',
    sourceRevisionHash: String(input.sourceRevisionHash || ''),
    packetId: String(input.packetId || ''),
    startedAt: new Date().toISOString(),
    canceled: false
  };
  return activeAttempt;
}

function cancelAttempt(runId, reason = 'host-generation-stopped') {
  if (!activeAttempt || activeAttempt.runId !== String(runId || '')) return null;
  activeAttempt.canceled = true;
  activeAttempt.cancelReason = reason;
  return activeAttempt;
}

function currentAttempt() {
  return activeAttempt ? { ...activeAttempt } : null;
}
```

The runtime should begin the attempt after the snapshot is known:

```js
const attempt = beginAttempt({
  runId,
  kind: freshContext ? 'fresh' : (hasSwipeRetry ? 'swipe' : 'normal'),
  sourceRevisionHash: activeSourceRevisionHash(snapshot),
  packetId: lastPacket?.packetId
});
```

### Central cache decision helper

Add one decision helper in `src/runtime.mjs` rather than duplicating reuse
conditions across Standard, Fused, and Rapid:

```js
function cacheDecision(input = {}) {
  const source = input.source || {};
  const expected = input.expected || {};
  const reasons = [];

  if (input.forceFresh) {
    return { decision: 'bypassed', kind: input.kind, reason: 'force-fresh' };
  }
  if (source.chatId !== expected.chatId) reasons.push('chat-mismatch');
  if (source.sceneFingerprint !== expected.sceneFingerprint) reasons.push('scene-mismatch');
  if (source.sourceRevisionHash !== expected.sourceRevisionHash) reasons.push('source-mismatch');
  if (input.settingsHash && source.settingsHash !== input.settingsHash) reasons.push('settings-mismatch');
  if (input.contractHash && source.contractHash !== input.contractHash) reasons.push('contract-mismatch');

  return reasons.length
    ? { decision: 'miss', kind: input.kind, reason: reasons[0], reasons }
    : { decision: 'hit', kind: input.kind, reason: 'identity-and-contracts-match' };
}
```

Record the result once and reuse it downstream:

```js
const decision = cacheDecision({
  kind: 'scene-cards',
  source: activeCache?.source,
  expected: {
    chatId: snapshot.chatId,
    sceneFingerprint: snapshot.sceneFingerprint,
    sourceRevisionHash: activeSourceRevisionHash(snapshot)
  },
  forceFresh: Boolean(freshContext)
});

recordCacheDecision(runId, {
  ...decision,
  variant: activeVariant.exact ? 'exact' : 'alternate'
});
```

### Scene cache load and validation

`loadSceneCacheSafe()` should return both data and the decision reason:

```js
async function loadValidatedSceneCache(runId, snapshot, settings) {
  const raw = await storage.loadSceneCache(snapshot.chatKey, snapshot.sceneKey);
  if (!raw) {
    return { cache: null, decision: { decision: 'miss', kind: 'scene-cards', reason: 'record-missing' } };
  }

  const status = cacheContractStatus(raw, settings);
  if (status.status === 'invalid') {
    await invalidateLoadedSceneCache(runId, snapshot, status, 'invalid');
    return { cache: null, decision: { decision: 'invalid', kind: 'scene-cards', reason: status.reason } };
  }

  const variant = activeSceneCacheVariant(raw, snapshot);
  const rejectionReasons = [];
  const cards = sanitizedCacheCards(runId, snapshot, variant.cards, { rejectionReasons });
  if (!cards.length) {
    return {
      cache: raw,
      decision: {
        decision: 'miss',
        kind: 'scene-cards',
        reason: rejectionReasons[0] || 'no-valid-cards'
      }
    };
  }
  return {
    cache: raw,
    cards,
    decision: { decision: 'hit', kind: 'scene-cards', reason: 'valid-active-variant' }
  };
}
```

### Scene cache write provenance

Every successful card or packet write should preserve provenance:

```js
const payload = sceneCachePayload(snapshot, deck, hand, plan, packet, settings, previousCache);
payload.lastCacheDecision = {
  decision: 'write',
  kind: 'scene-cards',
  sourceRevisionHash: activeSourceRevisionHash(snapshot),
  reusedCardIds: cacheCards.map((card) => card.id),
  generatedCardIds: providerCards.map((card) => card.id),
  writtenAt: new Date().toISOString()
};
await storage.saveSceneCache(snapshot.chatKey, snapshot.sceneKey, payload);
```

### Standard and Fused routing

The card stage should make the reuse boundary explicit:

```js
const cacheCards = validCacheCardsForSnapshot(...);
const reuseCacheOnly = !freshContext
  && planAction(plan) === 'reuse-cache'
  && cacheCards.length > 0;

const generated = reuseCacheOnly
  ? { cards: [], diagnostics: ['cache-hit:card-generation-skipped'] }
  : await generatePlanCards({
      runId,
      plan,
      snapshot: sceneSnapshot,
      settings,
      signal
    });

recordCacheDecision(runId, {
  decision: reuseCacheOnly ? 'hit' : 'miss',
  kind: 'scene-cards',
  reason: reuseCacheOnly ? 'arbiter-reuse-cache' : 'card-generation-required',
  providerCallsSkipped: reuseCacheOnly
    ? settings.pipelineMode === 'fused'
      ? ['utilityArbiter', 'fusedCardBundle', 'guidanceComposer']
      : ['utilityArbiter', 'standardCardCalls', 'guidanceComposer']
    : []
});
```

Fused must not make a second bundle call when the scene cache is valid:

```js
const fusedResult = reuseCacheOnly
  ? { cards: cacheCards, reused: true, diagnostics: ['fused-bundle-skipped-cache-hit'] }
  : await runFusedCardPipeline({ ...pipelineInput });
```

### Rapid warm validation and fallback

Rapid must expose whether it used warm work or escalated:

```js
const warmDecision = rapidWarmArtifactIsUsable(rapidArtifact, expectedContracts)
  ? { decision: 'hit', kind: 'rapid-warm', reason: 'contracts-match' }
  : { decision: 'miss', kind: 'rapid-warm', reason: rapidWarmMiss.reasonCode };

recordCacheDecision(runId, warmDecision);

if (warmDecision.decision !== 'hit') {
  return {
    ok: false,
    escalateToStandard: true,
    diagnostics: [`rapid-warm-miss:${warmDecision.reason}`]
  };
}

return runRapidForegroundPipeline({
  ...input,
  selectedWarmCards,
  warmArtifact: rapidArtifact
});
```

### Swipe retry preservation on stop

Host-stop handling must cancel the active attempt without treating stop as a
source change:

```js
async function handleHostGenerationStopped(details = {}) {
  const attempt = runState.currentAttempt?.();
  const currentSnapshot = lastSnapshot;
  const sourceChanged = Boolean(details.sourceChanged || details.edited || details.deleted);

  runState.cancelAttempt?.(attempt?.runId, 'host-generation-stopped');
  cancelActiveProviderWork();

  if (sourceChanged) {
    clearPendingLatestAssistantSwipeRetry();
    await invalidateActiveSceneCacheBestEffort('source-changed', details);
  } else if (attempt?.kind === 'swipe' && lastPacket && lastHand) {
    rearmLatestAssistantSwipeRetry({
      sourceRevisionHash: activeSourceRevisionHash(currentSnapshot),
      reason: 'stopped-swipe-preserve-last-known-good'
    });
  }

  await clearPromptBestEffort(host);
  return {
    ok: true,
    canceled: true,
    preservedLastKnownGood: !sourceChanged && Boolean(lastPacket && lastHand)
  };
}
```

The event adapter should pass source-change information only for actual
message edits, deletions, or older-message swipes:

```js
if (details.swiped && details.latestAssistant) {
  return invokeRuntimeCleanup('handleLatestAssistantSwipeRetry', 'Swipe marker failed.', details);
}

if (details.edited || details.deleted || details.olderMessageSwipe) {
  return invokeRuntimeCleanup('handleSourceChanged', 'Source change cleanup failed.', details);
}
```

### Progress and diagnostics integration

Centralize cache progress events:

```js
function recordCacheDecision(runId, decision = {}) {
  stageRuntimeActivity({
    runId,
    phase: decision.decision === 'hit' ? 'cacheReusing' : 'cacheDecision',
    severity: decision.decision === 'miss' ? 'info' : 'success',
    label: cacheDecisionLabel(decision),
    detail: {
      cacheKind: decision.kind,
      cacheDecision: decision.decision,
      cacheReason: decision.reason,
      variant: decision.variant,
      reusedCardIds: decision.reusedCardIds || [],
      providerCallsSkipped: decision.providerCallsSkipped || []
    },
    chips: ['Cache', decision.kind]
  });
}
```

Source-card progress must inherit the category execution state while retaining
cache provenance:

```js
function sourceProgressRow(categoryState, sourceCard, cacheDecision) {
  return {
    id: sourceCard.id,
    label: sourceCard.name,
    state: cacheDecision?.decision === 'hit' ? 'cached' : categoryState,
    source: cacheDecision?.decision === 'hit' ? 'cache' : 'generated',
    reason: cacheDecision?.decision === 'hit'
      ? 'Included from valid cached category result.'
      : 'Included in category generation.'
  };
}
```

### Last Brief provenance

Last Brief should expose reuse without implying a new provider call:

```js
lastBrief = {
  ...lastBrief,
  cacheDecision: decision.decision,
  cacheKind: decision.kind,
  cacheReason: decision.reason,
  reusedCardCount: decision.reusedCardIds?.length || 0,
  providerCallsSkipped: decision.providerCallsSkipped || []
};
```

### Storage and retention

Cache writes must remain bounded and protect only the active scene:

```js
await storage.pruneSceneCaches({
  maxPerChat: settings.retention.sceneCachesPerChat,
  maxTotal: settings.retention.sceneCachesTotal,
  protectedKeys: [sceneCacheKey(snapshot.chatKey, snapshot.sceneKey)]
});
```

Retention must never delete SillyTavern chat messages or enhancement swipe
variants. It may delete old Recursion scene-cache records and journals.

### Playwright provider-call and visual assertions

Instrument real model requests by role:

```js
const calls = [];
page.on('request', (request) => {
  if (!request.url().includes('/api/backends/chat-completions/generate')) return;
  const body = JSON.parse(request.postData() || '{}');
  calls.push({ role: body?.recursion?.roleId || body?.roleId || '' });
});
```

After the first generation and second swipe:

```js
expect(calls.filter((call) => call.role === 'fusedCardBundle')).toHaveLength(1);

const cachedRows = await page.locator(
  '[data-recursion-status-popover] [data-recursion-progress-row]'
).evaluateAll((rows) => rows
  .filter((row) => row.dataset.recursionProgressState === 'cached')
  .map((row) => row.querySelector('[data-recursion-progress-label]')?.textContent?.trim()));

expect(cachedRows).toContain('Scene Frame');
expect(cachedRows).toContain('location/situation');
```

For the interrupted swipe:

```js
await triggerSwipe(page);
await page.locator('[data-recursion-stop]').click();
await waitForGenerationSettled(page);

const callsBeforeRetry = calls.length;
await triggerSwipe(page);
await waitForGenerationSettled(page);

expect(calls.length).toBe(callsBeforeRetry);
expect(await progressHasCachedSourceCards(page)).toBe(true);
```

For Force Fresh:

```js
await page.locator('[data-recursion-fresh-next-generation]').click();
await triggerSwipe(page);
await waitForGenerationSettled(page);

expect(calls.length).toBeGreaterThan(callsBeforeRetry);
expect(await progressHasGeneratedSourceCards(page)).toBe(true);
```

## Implementation Plan

### Phase 1: Instrument current decisions

1. Add a run-owned cache decision record.
2. Record hit, miss, stale, invalid, bypassed, and canceled states.
3. Include cache kind, reason, variant, reused IDs, and skipped provider roles.
4. Expose the record through runtime diagnostics and the run journal.

### Phase 2: Repair stop and swipe semantics

1. Introduce an explicit active-attempt record with `kind: normal | swipe | fresh`.
2. Separate cancellation from source invalidation.
3. Preserve the last known-good packet and scene cache on host stop.
4. Preserve or re-arm swipe reuse when the source identity still matches.
5. Clear reuse only on source change, Force Fresh, contract mismatch, or unsafe
   partial commit.

### Phase 3: Unify cache decision boundaries

1. Centralize source identity validation.
2. Centralize contract-hash validation.
3. Route Standard, Fused, and Rapid through one cache decision model.
4. Make exact versus alternate variant selection explicit.
5. Ensure Fused uses cached category results without making a redundant bundle
   call.
6. Add `buildContextContract()` as the shared source/provider/Enhancement
   depth descriptor.
7. Make source freshness use the full bounded source window while provider
   requests use `providerVisibleMessages`.
8. Make Prose and Dialogue use the effective Enhancement context from the
   bounded source window.
9. Add a total Enhancement context-character budget.
10. Include Enhancement context identity in Enhancement deduplication keys.
11. Include source-window and provider-depth settings in scene-cache contract
    hashes.
12. Keep Enhancement context-depth changes isolated from scene-card cache
    invalidation.

### Phase 4: Make progress authoritative

1. Emit one cache decision event per run.
2. Emit cache provenance on category and source-card rows.
3. Make purple cached rows authoritative for skipped provider work.
4. Keep cache diagnostics separate from caution/failure caused by provider or
   validation problems.
5. Preserve progress rows through refresh heartbeats without flicker.

### Phase 5: Add regression coverage

1. Add deterministic cache contract tests.
2. Add Standard/Fused provider-call-count tests.
3. Add Rapid warm exact/miss tests.
4. Add stop-then-swipe tests.
5. Add Force Fresh bypass tests.
6. Add Playwright live progress-row inspection.
7. Add desktop/mobile screenshot assertions and artifact reports.
8. Test source-window message-cap truncation and character-budget truncation.
9. Test provider context never exceeds `providerVisibleMessages`.
10. Test Enhancement context never exceeds the bounded source window.
11. Test Enhancement context-character limits and actual request counts.
12. Test changing Enhancement depth changes the Enhancement identity but does
    not invalidate scene-card cache.
13. Test changing source-window or provider-depth settings invalidates the
    scene-cache contract.
14. Test diagnostics report configured and effective depths without transcript
    text.

### Phase 6: Validate the served host

1. Sync every changed module to the served `default-user` extension.
2. Hash-compare repository and served files.
3. Reload SillyTavern so stale browser modules cannot mask the fix.
4. Run the Standard/Fused live swipe matrix.
5. Inspect the exact run journal, provider call evidence, progress snapshot,
   and screenshots before declaring cache reuse complete.

## Acceptance Criteria

- Every reusable artifact has a named cache kind and provenance.
- Cache hits and misses have explicit reasons.
- Standard and Fused reuse valid scene cards without unnecessary provider calls.
- Fused cached rows are purple at bundle, category, and source-card levels.
- Rapid warm hits and misses are visible and correctly routed.
- Force Fresh bypasses all reusable generation work.
- Stopping a swipe does not destroy the last known-good cache.
- The next swipe after a stopped swipe reuses valid prior work.
- Source edits and contract changes correctly invalidate reuse.
- Source freshness, provider context, and Enhancement context use explicit,
  separately reported depth contracts.
- Enhancement reuse changes when its relevant context changes.
- Scene-card cache is invalidated by source/provider depth contract changes,
  while Enhancement depth changes remain isolated to Enhancement identity.
- No provider or Enhancement request exceeds its effective message or
  character budget.
- Playwright proves both network/provider behavior and visible progress rows.
- Desktop and mobile screenshots confirm the cache state users actually see.
