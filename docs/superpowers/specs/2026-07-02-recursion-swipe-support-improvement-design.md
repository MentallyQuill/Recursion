# Recursion Swipe Support Improvement Design

## Purpose

Recursion already treats SillyTavern swipes as source-message mutations: it subscribes to `MESSAGE_SWIPED`, clears Recursion-owned prompts, drops volatile runtime state, and marks the last active scene cache stale. That is enough to avoid leaving an old prompt installed after a swipe, but it is not yet a first-class swipe contract.

This pass makes swipe support explicit and testable. The goal is that a user can swipe assistant messages forward or backward, then send the next player message, and Recursion will condition the next generation from the active swipe state only. It must not reuse cards, hands, prompt packets, or source assumptions from an inactive swipe unless the cache can prove an exact active-source match.

## Current Behavior

The current host event path:

1. The extension subscribes to `MESSAGE_DELETED`, `MESSAGE_UPDATED`, and `MESSAGE_SWIPED`.
2. Each event calls `runtime.handleSourceChanged()`.
3. Runtime aborts active work, clears in-memory packet/hand/plan/snapshot state, best-effort marks the last saved scene cache stale with reason `source-changed`, clears Recursion prompt keys, and journals compact event metadata.
4. The next send or refresh captures a fresh SillyTavern snapshot from `context.chat`.

The current snapshot path reads the active message text from `mes`, `text`, or `content`. It does not explicitly carry SillyTavern `swipe_id`, `swipes.length`, or active swipe identity into runtime fingerprints. Cached cards are validated against visible message ids and source-window text hashes, which protects against most stale-text reuse, but it cannot distinguish two active swipes with identical text and different swipe identity.

The current tests cover generic source-change cleanup and extension subscription to `MESSAGE_SWIPED`, but there is no dedicated A/B/A swipe regression that proves:

- swipe A creates cards and prompt state;
- swipe to B clears A state and does not reuse A cards incorrectly;
- swipe back to A does not reuse B state;
- in-flight Utility or Reasoner work cannot install a late prompt after a swipe.

## Design Goals

- Treat the active SillyTavern swipe as part of Recursion's source revision.
- Preserve the current fail-soft cleanup behavior on swipe events.
- Keep raw swipe text out of journals and diagnostic artifacts except where card prompt text is already intentionally stored by the scene cache contract.
- Allow exact-match reuse when the user swipes back to a previous active source, but only through a bounded, fingerprinted cache variant.
- Keep V1 approachable: no user-facing swipe controls, no card editing, no persistent per-swipe management UI.
- Prove behavior with deterministic tests first, then a guarded live SillyTavern smoke path.

## Non-Goals

- Recursion will not create, delete, reorder, or edit SillyTavern swipes.
- Recursion will not store full `swipes[]` text arrays.
- Recursion will not expose swipe internals in the main UI.
- Recursion will not run Utility or Reasoner immediately on swipe. A swipe clears stale conditioning; the next send or explicit refresh compiles the new active state.
- Recursion will not try to preserve compatibility with old pre-alpha cache shapes.

## Approach Options

### Option A: Clear-Only Swipe Handling

Keep the current source-change cleanup and add tests around `MESSAGE_SWIPED`.

Strengths:

- Minimal implementation.
- Low risk of introducing new cache behavior.
- Prevents stale prompt installation.

Weaknesses:

- Does not make swipe identity part of source freshness.
- A/B/A swipe behavior is correct only by regeneration, not by exact-match cache reuse.
- Identical text in different swipes remains indistinguishable.

### Option B: Swipe-Aware Source Fingerprints

Add sanitized swipe identity to host snapshots and source-window fingerprints. Cache cards remain in the existing scene cache, but every cached card must match the active swipe-aware source fingerprint before reuse.

Strengths:

- Strong safety improvement with modest scope.
- Prevents inactive-swipe card reuse even when message text is identical.
- Fits the existing source-window validation model.

Weaknesses:

- Swiping back to an earlier swipe usually regenerates once the cache has been overwritten by a newer active source.
- The cache remains one active scene deck, not a set of source variants.

### Option C: Swipe-Aware Source Variants

Add Option B, then store a bounded set of source variants inside the scene cache. Each variant is keyed by a sanitized `sourceRevisionHash` and owns cards, latest hand metadata, and contract versions for that exact active source. Runtime can reuse a previous variant only when the current snapshot has the same source revision, compatible settings/provider contracts, and valid card source windows.

Strengths:

- Safest and most useful behavior for A/B/A swiping.
- Preserves Recursion's card/hand speed goal without allowing cross-swipe bleed.
- Gives deterministic diagnostics for whether a reused hand came from the active source revision.

Weaknesses:

- More storage shape work.
- Requires clear pruning rules.
- Needs broader tests than Option B.

Recommended approach: **Option C in a bounded form**. Implement swipe-aware source fingerprints first, then store only a small variant ring per scene cache. If variant support proves larger than expected during planning, Option B is the fallback V1 scope.

## Source Revision Contract

Runtime should treat each snapshot as having a `sourceRevision` derived from visible source messages. The revision is not user-visible prose; it is a sanitized identity and freshness contract.

Each normalized message should include these optional fields when SillyTavern exposes them:

```ts
type NormalizedMessage = {
  id: string;
  mesid: number;
  index: number;
  role: 'user' | 'assistant' | 'system';
  visible: boolean;
  sender: string;
  text: string;
  swipeId?: number;
  swipeCount?: number;
  activeSwipeTextHash?: string;
};
```

Rules:

- `swipeId` comes from `message.swipe_id` when it is a finite number.
- `swipeCount` is `message.swipes.length` when `swipes` is an array.
- `activeSwipeTextHash` hashes the active swipe text when `swipes[swipe_id]` exists; otherwise it hashes the displayed message text.
- Runtime does not persist full `swipes[]`.
- If SillyTavern exposes no swipe metadata, Recursion falls back to the current text-hash behavior.

The source revision hash should be derived from visible messages only:

```ts
type SourceRevisionMessage = {
  mesid: number;
  role: 'user' | 'assistant' | 'system';
  textHash: string;
  swipeId?: number;
  swipeCount?: number;
  activeSwipeTextHash?: string;
};
```

`sourceWindowFingerprint()` should hash this revision shape instead of text hash alone. That makes two swipes with identical displayed text but different active `swipe_id` distinct.

## Event Cleanup Contract

`MESSAGE_SWIPED` should remain a prompt-safe cleanup event, not a generation trigger.

On swipe:

1. Extension receives `MESSAGE_SWIPED` and extracts compact event details.
2. Runtime aborts active Recursion work.
3. Runtime clears volatile packet, hand, plan, and snapshot state.
4. Runtime clears Recursion prompt keys.
5. Runtime marks the previously active scene cache stale with reason `source-changed`.
6. Runtime records compact details: event name, message id, and, when cheaply available, current source revision hash and active swipe id.
7. Runtime updates activity with a user-visible status such as `Source messages changed. Recursion prompt cleared.`

The cleanup must remain fail-soft. If reading the current snapshot fails while processing the event, prompt clearing and volatile-state cleanup still proceed.

## Cache Variant Contract

Scene cache should move from one implicit active deck to a bounded source-variant shape:

```ts
type SceneCacheV2 = {
  cacheState: 'active' | 'stale' | 'retired' | 'invalid';
  versions: object;
  source: object;
  activeSourceRevisionHash: string;
  variants: Record<string, SceneCacheVariant>;
  variantOrder: string[];
};

type SceneCacheVariant = {
  sourceRevisionHash: string;
  source: {
    chatIdHash: string;
    firstMesId: number;
    lastMesId: number;
    latestMesId: number;
    sceneFingerprint: string;
    sourceWindowHash: string;
  };
  cards: SceneCard[];
  latestHand: object | null;
  updatedAt: string;
};
```

Pruning rules:

- Keep at most four variants per scene cache.
- Always keep the active variant.
- Prefer keeping the most recently used variants.
- Drop variants whose contract versions are hard-invalid.
- Do not migrate older pre-alpha shapes; normalize them into the new shape when first saved.

Reuse rules:

- Runtime may reuse cards only from the active source revision variant.
- Runtime may show stale variants to the Arbiter only as compact metadata, not as candidate cards.
- If no exact variant exists, runtime regenerates or falls back locally.
- If a user swipes A -> B -> A, variant A may be reused only if its source revision hash exactly matches the current active snapshot and all card source-window checks pass.

## Prompt Install Freshness

Prompt installation should continue to re-read the host snapshot before writing prompt keys. The freshness check should compare the swipe-aware visible source revision, not just chat key and visible text hashes.

If the user swipes while Utility or Reasoner calls are still running:

- the run receives an aborted signal where possible;
- late provider results are treated as superseded;
- late prompt installation is skipped with reason `stale-snapshot`;
- no prompt generated for the inactive swipe is installed.

## Diagnostics And UI Feedback

The main UI does not need new swipe controls. It should already show activity state; this pass should ensure swipe events produce clear operational feedback.

Recommended activity labels:

- event start: `Clearing Recursion prompt after source message change...`
- event success: `Source messages changed. Recursion prompt cleared.`
- stale cache warning: `Ignored stale cached Recursion cards.`
- late install skip: `Prompt install skipped because the host turn changed before write.`

Diagnostics may include:

- `eventName`;
- `messageId`;
- `sourceRevisionHash`;
- `activeSwipeId`;
- `variantReused: true | false`;
- `variantReason: exact-source-match | source-mismatch | missing-variant | contract-invalid`.

Diagnostics must not include raw swipe text, raw provider output, hidden reasoning, stack traces, API keys, bearer tokens, session ids, or full `swipes[]`.

## Test Plan

### Host Snapshot Tests

Add deterministic host adapter tests proving:

- a message with `swipe_id: 0` and two `swipes` records `swipeId: 0`, `swipeCount: 2`, and a stable active swipe hash;
- changing `swipe_id` to `1` changes the snapshot source revision and turn fingerprint;
- changing only inactive swipe text does not affect active source revision;
- adding or deleting a swipe changes `swipeCount` and therefore changes the source revision;
- missing swipe metadata falls back to current text-hash behavior.

### Runtime Source-Change Tests

Add runtime tests proving:

- `handleSourceChanged({ eventName: 'message_swiped', messageId })` aborts in-flight work, clears prompt keys, clears volatile state, and marks the previous active cache stale;
- a late provider result after swipe cannot install a prompt;
- source-change journal entries include compact event metadata and no raw text.

### A/B/A Cache Tests

Add an explicit swipe regression:

1. Prepare snapshot A with assistant message `mesid: 2`, `swipeId: 0`, and text A.
2. Run Recursion and save variant A.
3. Emit `message_swiped` and switch the host snapshot to swipe B.
4. Run Recursion and prove A cards are not candidate cards for B.
5. Save variant B.
6. Emit `message_swiped` and switch back to swipe A.
7. Run Recursion and prove B cards are not candidate cards for A.
8. If variant A remains within the variant limit, prove A can be reused as an exact source match. If it was pruned, prove Recursion regenerates instead of using B.

### Extension Smoke Tests

Extend extension smoke so the fake SillyTavern event source emits `message_swiped`, not only `message_updated`, and verify:

- subscription count for `message_swiped`;
- prompt keys are cleared after the event;
- event details preserve numeric message id;
- teardown unsubscribes the swipe listener.

### Live SillyTavern Proof

Add a guarded live smoke scenario for dedicated `recursion-soak-*` users:

- create or load a test chat with an assistant message that has at least two swipes;
- run Recursion on swipe A;
- use SillyTavern's actual swipe UI or command path to switch to swipe B;
- verify the Recursion activity ribbon reports source-message cleanup;
- send the next player message and verify prompt metadata was generated from B, not A;
- switch back to A and verify no B-derived card or prompt metadata is injected.

The live proof must remain separate from deterministic release gates. A missing dedicated user or missing `SILLYTAVERN_BASE_URL` is a skipped live-proof report, not evidence that swipe support passed.

## Documentation Updates

When implemented, update:

- `docs/technical/RUNTIME_TURN_SEQUENCE.md` to describe swipe-aware source revision and A/B/A behavior;
- `docs/technical/STORAGE_AND_DIAGNOSTICS.md` to document source variants, pruning, and diagnostic redaction;
- `docs/technical/HOST_INTEGRATION_MANUAL.md` to document `MESSAGE_SWIPED` event details;
- `docs/testing/TESTING_STRATEGY.md` and `docs/testing/LIVE_SMOKE_TEST_PLAN.md` to include deterministic and live swipe scenarios.

## Acceptance Criteria

- A swipe event clears any installed Recursion prompt before the next generation.
- A swipe event aborts or supersedes in-flight Recursion work.
- Runtime source fingerprints include active swipe identity when available.
- Cards generated for inactive swipe B cannot be reused when active swipe A is selected.
- Cards generated for inactive swipe A cannot be reused when active swipe B is selected.
- Swiping back to A either reuses exact-match A variant cards or regenerates; it never uses B cards.
- Prompt install is skipped if the active swipe changes between snapshot capture and prompt write.
- Journals and artifacts contain compact hashes and ids, not raw inactive swipe text.
- Deterministic tests prove A/B/A behavior.
- Live SillyTavern smoke proves the behavior through the real `MESSAGE_SWIPED` path.

## Open Implementation Notes

- `sourceRevisionHash` belongs on both the normalized snapshot root and each persisted card source: snapshot root for run-level checks, card source for cache validation.
- The variant cache should be implemented only after swipe-aware source fingerprints are green, so the safety invariant exists before optimization.
- Because Recursion is pre-alpha, old cache shapes should be replaced in place rather than supported through compatibility shims.
