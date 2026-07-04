# Recursion Force Regenerate Design

## Purpose

Give users a direct way to tell Recursion, "do this turn fresh." The control must immediately regenerate the current turn while bypassing cached cards, Rapid warm artifacts, and latest-assistant swipe packet reuse without deleting SillyTavern chat data or turning into a hidden persistent no-cache mode.

Force Regenerate is a normal play control. It is not the same as Reset Scene Cache:

- Force Regenerate: one-shot fresh prompt-packet run plus native SillyTavern regenerate for the current turn.
- Reset Scene Cache: destructive diagnostic cleanup that deletes the current scene cache, clears in-memory hand/packet state, and clears the host prompt.

## Current State

Recursion already has several reuse and cache paths:

- `runtime.refreshScene()` calls `prepareForGeneration({ refreshReason: 'user-refresh' })`, soft-invalidates the current scene cache, and reruns the normal preparation loop.
- `prepareForGeneration()` skips expensive work when it can reuse the last packet for the same snapshot.
- The latest-assistant swipe path marks a pending retry, clears Last Brief visually, and reinstalls the previous packet when the pre-swipe source still matches.
- Rapid Pipeline tries to use a ready Rapid warm artifact, may join a matching warm, and otherwise falls back to Standard.
- `resetSceneCache()` is already wired as an Advanced diagnostic action and intentionally deletes cache state.

The missing affordance is a fresh-run override that works across both ordinary sends and latest-assistant swipes. Users can currently reset the cache or hope the Arbiter chooses refresh work, but neither is the precise command they need when stale or overfit Recursion context is visible in Last Brief.

## Problem

The current optimized paths are correct most of the time but frustrating when the user can see stale or wrong context:

- A latest-assistant swipe can reinstall the same Recursion packet even when the user wants new card/guidance judgment for the alternate assistant response.
- A same-turn send can reinstall the prior packet instead of rebuilding it.
- Rapid can use warm guidance that is operationally valid but not what the user wants after inspecting Last Brief.
- Existing Reset Scene Cache is too broad; it deletes diagnostic state and clears prompt state instead of simply regenerating the current turn fresh.

The user intent is not "delete everything." It is "ignore the reuse/cached path for this generation."

## Goals

- Add a one-shot Force Regenerate action.
- Bypass latest-assistant swipe packet reuse for the current forced regeneration.
- Bypass same-turn packet reinstall for the current forced regeneration.
- Bypass Rapid warm artifact use for the current forced regeneration.
- Soft-invalidate the loaded scene cache with reason `user-force-regenerate`.
- Prevent cached cards from entering the forced hand.
- Run fresh provider work for Arbiter/card/guidance using the current snapshot.
- Preserve Last Brief clear/restore behavior: old cards disappear, preparing state shows, new cards appear after install.
- Surface clear progress/status text so the user can see Recursion is intentionally running fresh.
- Preserve diagnostics and old cache records when safe; do not delete SillyTavern messages.

## Non-Goals

- No persistent "always bypass cache" setting.
- No deterministic card relevance logic.
- No local semantic composer.
- No deletion of SillyTavern chat messages.
- No automatic reset of all Recursion storage.
- No per-card regenerate buttons in this pass.
- No backward-compatibility shims for old pre-alpha runtime view shapes.

## Selected Approach

Add a runtime-level one-shot force token consumed by `prepareForGeneration()`.

The force token has safe operational metadata:

```js
{
  id: 'force-regenerate-...',
  reason: 'user-force-regenerate',
  requestedAt: '2026-07-03T13:40:00.000Z',
  consumeByRunId: '',
  source: 'bar'
}
```

Calling `runtime.forceRegenerateNow()` sets a force token, clears Last Brief visually with reason `user-force-regenerate`, clears any pending latest-assistant swipe retry, immediately calls `prepareForGeneration({ hostGeneration: true })`, and starts SillyTavern native regenerate after the fresh packet installs. `runtime.forceRegenerateNext()` remains the lower-level one-shot token primitive.

This keeps the control ergonomic:

1. User opens Last Brief.
2. User sees stale or wrong cards.
3. User clicks Regenerate in the Recursion Bar command slot where Stop appears during active work.
4. Last Brief clears to the same preparing state used by send/swipe.
5. Normal Recursion progress/status appears while the forced path ignores reuse and cache.
6. New cards and packet install into Last Brief, then SillyTavern regenerates the current turn with the fresh packet installed.

If the user clicks Regenerate during a latest-assistant swipe window, the forced regeneration treats the current post-swipe source as the source of truth and does not call `reinstallLastPacketForSameTurn(...)`.

## Alternatives Considered

### Option A: Reuse Reset Scene Cache

Rename or repurpose Reset Scene Cache as the force-regenerate control.

Rejected. Reset Scene Cache deletes the current scene cache and clears prompt state. That is still useful as an Advanced diagnostic action, but it is too destructive and too buried for normal play.

### Option B: Persistent No-Cache Mode

Add a setting that always bypasses caches and Rapid warm.

Rejected for V1. It is expensive, easy to forget, and likely to make Rapid appear broken. A persistent debugging flag can be added later if needed, but it should not be the first user-facing design.

### Option C: One-Shot Fresh Run

Add a visible one-shot action that makes the current turn regenerate fresh.

Selected. It maps directly to user intent, keeps runtime cache machinery intact, preserves diagnostics, and gives the main bar an obvious fresh-run command.

## Runtime Contract

### New runtime API

```js
runtime.forceRegenerateNow({ source = 'bar' } = {})
runtime.forceRegenerateNext({ source = 'bar' } = {}) // lower-level token primitive
```

Return shape:

```js
{
  ok: true,
  forceRegenerate: {
    id: 'force-regenerate-...',
    reason: 'user-force-regenerate',
    requestedAt: '...',
    source: 'bar'
  }
}
```

If Recursion is disabled, the API still records no stale state and returns:

```js
{ ok: true, skipped: true, reason: 'disabled' }
```

### Runtime view

`runtime.view()` exposes:

```js
forceRegenerate: {
  pending: true,
  id: 'force-regenerate-...',
  reason: 'user-force-regenerate',
  requestedAt: '...',
  source: 'bar'
}
```

When no token exists:

```js
forceRegenerate: {
  pending: false,
  id: '',
  reason: '',
  requestedAt: '',
  source: ''
}
```

### `prepareForGeneration()` behavior

At the start of `prepareForGeneration()`:

1. Normalize `pendingUserMessage`.
2. Create `runId`.
3. Consume pending force token into `forceContext`.
4. Clear Last Brief with reason:
   - `user-force-regenerate` when forced,
   - `latest-assistant-swipe` when swipe reuse may apply,
   - existing generation reason otherwise.

When `forceContext` exists:

- Do not call `reusableSnapshotForLatestAssistantSwipeRetry(...)`.
- Do not call `canReuseLastPacketForSnapshot(...)`.
- Clear pending latest-assistant swipe retry.
- Treat Rapid foreground as unavailable for this run, even when `settings.pipelineMode === 'rapid'`.
- Best-effort soft-invalidate the current scene cache with reason `user-force-regenerate`.
- Load the cache only as stale evidence for Arbiter context, never as prompt-eligible cached cards.
- Force `reuseCacheOnly = false`.
- Filter `cacheCards` to an empty prompt-eligible set for hand selection.
- Add plan/runtime diagnostics:
  - `force-regenerate:user-force-regenerate`
  - `force-regenerate:cache-bypassed`
  - `force-regenerate:rapid-bypassed` when the stored pipeline is Rapid.

The Arbiter should see stale cache metadata so it can understand what is being replaced, but runtime must not let old cached `promptText` enter the installed packet for that forced hand.

### Storage behavior

Use existing `storage.invalidateSceneCache(chatKey, sceneKey, options)`:

```js
{
  reason: 'user-force-regenerate',
  cacheState: 'stale',
  runId,
  details: {
    latestMesId,
    source: 'bar',
    forceRegenerateId
  }
}
```

No cache file is created when none exists. Missing cache is fail-soft. Storage errors are reported as existing storage warnings and do not block fresh generation.

### Last Brief lifecycle

Force Regenerate uses the same visual lifecycle as send/swipe:

- Immediately set `lastBrief.status = 'clearing'`.
- Use `lastBrief.reason = 'user-force-regenerate'`.
- Keep previous ids/counts in `previousPacketId`, `previousHandId`, `previousCardCount`.
- UI fades old rows if open.
- UI shows `Preparing fresh prompt packet.` after the fade.
- When the new packet installs, `lastBrief.status = 'ready'`.

The ready reason after install should be `force-regenerate-installed` or `force-regenerate-install-failed`.

## UI Contract

### Placement

Add a compact icon-only Regenerate control to the Recursion Bar command slot where the Stop generation button appears during active work.

The slot is mutually exclusive:

- Active prompt preparation or host generation: show Stop generation.
- Idle and Recursion enabled: show the Regenerate icon button.
- Force token pending before `activeRunId` is visible: show Stop generation.
- Recursion disabled: hide Regenerate and Stop.

Recommended desktop order:

```text
[power] [pipeline] [mode] [cards] | [Hero Pixel Array] Current step... [regenerate/stop] [reasoning] v | ...
```

The control is enabled when:

- Recursion is enabled.
- `runtime.forceRegenerateNow` exists.
- No active prompt-preparation or host-generation run needs the Stop button.

If a force token is pending, Stop owns the command slot even before `activeRunId` is visible. The Regenerate icon is hidden so the user has one clear action: cancel the in-flight forced regeneration.

### Copy

Accessible label:

```text
Regenerate this turn
```

Tooltip:

```text
Regenerate this turn fresh, ignoring cached cards, Rapid warm, and swipe reuse.
```

Preparing text:

```text
Preparing fresh prompt packet.
```

Progress label:

```text
Force regenerating Recursion packet...
```

Activity chips:

```text
Fresh
Cache
```

### Why Bar, not Last Brief or Advanced

The user often discovers this need while inspecting Last Brief, but the command itself belongs in the bar. Last Brief remains a read-only trust and inspection surface; the bar owns live generation commands. Advanced remains the right home for Reset Scene Cache, Clear Run Journal, and Export Diagnostics.

## Rapid Pipeline Behavior

Force Regenerate bypasses Rapid foreground for one run.

Rationale: Rapid warm is explicitly a reuse path. A user asking for fresh regeneration should get fresh Standard foreground card/guidance work even if Rapid is selected. The selected setting remains Rapid; future idle warm and future sends can use Rapid again.

Runtime diagnostics should record:

```text
force-regenerate:rapid-bypassed
```

The UI can still show the Pipeline button as Rapid. The progress/status should clarify that this single run is forced fresh.

## Swipe Behavior

If a latest-assistant swipe has just happened:

1. Existing swipe handler can still mark `pendingLatestAssistantSwipeRetry`.
2. User clicks Regenerate.
3. Runtime clears `pendingLatestAssistantSwipeRetry`.
4. Next `prepareForGeneration()` uses the current post-swipe snapshot.
5. Runtime does not reinstall the previous packet.
6. Runtime makes provider calls and installs a new packet.

This makes force regenerate a direct override for "do not reuse the same cards/package on this swipe."

## Failure Handling

- Provider unavailable: follow existing fail-soft provider behavior; do not preserve the old packet as if force succeeded.
- Storage invalidation failed: continue in memory and show storage warning.
- Prompt install failed: show existing install failure warning, with Last Brief ready metadata only if a packet exists.
- User clicks Regenerate while idle: start the forced regeneration immediately.
- User clicks Stop during forced prompt preparation: abort provider work, prevent prompt install, and clear owned prompt lanes.
- User clicks Stop after forced prompt install while SillyTavern is regenerating: call SillyTavern stop and run host-stop cleanup.
- Chat/source changes before or during forced generation: clear stale force token with source-change cleanup.
- Recursion disabled before or during forced generation: clear force token and Last Brief as disabled path already does.

## Privacy And Diagnostics

Force Regenerate metadata must never include:

- raw provider prompts,
- raw provider responses,
- hidden reasoning,
- API keys,
- full chat text,
- full card prompt text in journal entries.

Safe diagnostics can include:

- force token id,
- reason code,
- source label,
- run id,
- latest message id,
- packet id hash,
- selected card count,
- whether Rapid/cache/reuse were bypassed.

## Test Strategy

### Deterministic Runtime Tests

Add tests proving:

- `runtime.forceRegenerateNow()` starts prompt preparation immediately and uses the pending force view only as a short-lived command-slot state.
- The next `prepareForGeneration()` consumes the token.
- Same-turn reuse is skipped and provider calls increase.
- Latest-assistant swipe reuse is skipped when force is pending.
- Rapid foreground is bypassed once and Standard generation runs.
- Cache is invalidated with `user-force-regenerate`.
- Cached cards do not enter the forced hand.
- Last Brief clears with `user-force-regenerate` and becomes ready after install.

### UI Tests

Add tests proving:

- Recursion Bar command slot renders an icon-only Regenerate control when idle.
- Recursion Bar command slot renders Stop instead of Regenerate during active work or pending force state.
- Click calls `runtime.forceRegenerateNow()`.
- Button disables while pending.
- Clearing text uses `Preparing fresh prompt packet.`
- Last Brief remains an inspection surface, not the primary command location.
- Existing Prompt Packet behavior remains intact.

### Storage Tests

Existing `invalidateSceneCache` coverage should be enough for soft invalidation. Add runtime-level assertions for reason/details rather than duplicating storage internals.

### Live Proof

Extend or add a guarded Playwright proof using dedicated `recursion-soak-*` user:

1. Generate a ready Last Brief.
2. Capture packet id and card count.
3. Click Regenerate in the Recursion Bar command slot.
4. Confirm visual clearing state.
5. Trigger generation through runtime or visible send path.
6. Confirm provider calls occurred.
7. Confirm new packet id differs from the old packet id.
8. Confirm Last Brief restores with ready cards.

For latest-assistant swipe proof:

1. Generate ready packet.
2. Add/mark latest assistant swipe.
3. Click Regenerate.
4. Confirm runtime does not report `same-turn-swipe-retry`.
5. Confirm provider calls occur and packet id changes.

## Documentation Updates

Update:

- `docs/design/UI_SPEC.md`: Recursion Bar Regenerate command slot, pending state, and distinction from Stop and Reset Scene Cache.
- `docs/architecture/RUNTIME_ARCHITECTURE.md`: force token and bypass behavior.
- `docs/technical/RUNTIME_TURN_SEQUENCE.md`: forced generation branch.
- `docs/user/RECURSION_OPERATOR_MANUAL.md`: when to use Regenerate vs Reset Scene Cache.

## Acceptance Criteria

- A user can click Regenerate from the Recursion Bar and the current turn regenerates fresh.
- Latest-assistant swipe reuse is bypassed when force is pending.
- Same-turn packet reuse is bypassed when force is pending.
- Rapid warm is bypassed only for the forced run.
- Cache is soft-invalidated, not deleted.
- Cached cards are not eligible for the forced hand.
- Last Brief visually clears and restores with a new ready packet.
- Existing Reset Scene Cache remains available and semantically unchanged.
- `node tools\scripts\run-alpha-gate.mjs` passes.
- Live Playwright proof confirms the ready -> force clear -> fresh ready flow on the served SillyTavern extension.
