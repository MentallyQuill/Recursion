# Recursion Force Regenerate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-shot Force Regenerate control that makes the next Recursion generation bypass cached cards, Rapid warm, and swipe/same-turn packet reuse while preserving Reset Scene Cache as a destructive diagnostic action.

**Architecture:** Add a runtime-owned force token and consume it inside `prepareForGeneration()` before reuse decisions. A forced run soft-invalidates cache, treats cached cards as non-eligible evidence only, forces fresh provider work, exposes pending state through `runtime.view()`, and adds an idle Recursion Bar command in the same slot where Stop appears during active work.

**Tech Stack:** JavaScript ES modules, Recursion runtime/settings/storage, SillyTavern extension UI, deterministic Node test scripts, guarded Playwright live proof.

## Files To Modify

- `src/runtime.mjs`
- `src/ui.mjs`
- `src/styles.css` if the existing bar command-button styles cannot cover the new control
- `tools/scripts/test-runtime.mjs`
- `tools/scripts/test-ui.mjs`
- `tools/scripts/test-storage.mjs` if cache invalidation details need expanded assertions
- `tools/scripts/prove-live-force-regenerate.mjs` or an existing guarded live proof script
- `docs/design/UI_SPEC.md`
- `docs/architecture/RUNTIME_ARCHITECTURE.md`
- `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- `docs/user/RECURSION_OPERATOR_MANUAL.md`

## Contract

Runtime API:

```js
runtime.forceRegenerateNext({ source = 'bar' } = {})
```

Success return:

```js
{
  ok: true,
  forceRegenerate: {
    id,
    reason: 'user-force-regenerate',
    requestedAt,
    source
  }
}
```

Disabled/no-op return:

```js
{
  ok: true,
  skipped: true,
  reason: 'disabled'
}
```

Runtime view:

```js
{
  forceRegenerate: {
    pending: true,
    id,
    reason: 'user-force-regenerate',
    requestedAt,
    source
  }
}
```

Forced `prepareForGeneration()` behavior:

- Consume the force token once per preparation run.
- Skip latest-assistant swipe packet reinstall.
- Skip same-turn packet reuse.
- Clear any pending latest-assistant swipe retry.
- Soft-invalidate current scene cache with reason `user-force-regenerate`.
- Do not delete cache records.
- Do not admit cached cards into the forced prompt-eligible hand.
- Bypass Rapid foreground warm for this run only.
- Run fresh provider Arbiter/card/guidance calls against the current snapshot.
- Install a fresh packet and restore Last Brief with ready cards.

## Task 1: Runtime Red Tests

- [ ] Add focused runtime tests before implementation.
- [ ] Assert `forceRegenerateNext()` exposes a pending `runtime.view().forceRegenerate`.
- [ ] Assert the next `prepareForGeneration()` consumes the pending force token.
- [ ] Assert same-turn packet reuse is bypassed when force is pending.
- [ ] Assert latest-assistant swipe packet reinstall is bypassed when force is pending.
- [ ] Assert provider call counters increase for a forced run.
- [ ] Assert the fresh installed packet id differs from the previous packet id.
- [ ] Assert Rapid mode bypasses ready warm for one forced run and then returns to normal Rapid behavior.
- [ ] Assert cached cards are not prompt-eligible in a forced hand.
- [ ] Run `node tools\scripts\test-runtime.mjs` and confirm the new assertions fail for the expected missing implementation reasons.

Implementation notes:

- Reuse existing fake provider counters around `prepareForGeneration()`.
- Reuse the latest-assistant swipe retry harness already covering packet reinstall.
- Keep assertions on observable runtime outputs and installed packet diagnostics rather than private helper names.

## Task 2: Runtime Force Token

- [ ] Add `pendingForceRegenerate = null` to runtime state in `src/runtime.mjs`.
- [ ] Add helper to create force tokens with ids, timestamp, reason, and source.
- [ ] Add helper to expose a sanitized force view.
- [ ] Add helper to consume the token once and stamp `consumeByRunId`.
- [ ] Add helper to clear force state on disable/source reset/chat reset.
- [ ] Export `forceRegenerateNext({ source } = {})` from the runtime object.
- [ ] Return the disabled/no-op shape when Recursion is disabled.
- [ ] Clear Last Brief with reason `user-force-regenerate` when a token is queued.
- [ ] Clear pending latest-assistant swipe retry when a token is queued.
- [ ] Update `runtime.view()` to include `forceRegenerate`.
- [ ] Re-run `node tools\scripts\test-runtime.mjs` and confirm the force-token tests now reach `prepareForGeneration()` behavior failures.

## Task 3: Prepare Pipeline Integration

- [ ] Consume the force token near the start of `prepareForGeneration()` after the run id exists and before any reuse decision.
- [ ] Gate `reusableSnapshotForLatestAssistantSwipeRetry()` behind `!forceContext`.
- [ ] Gate `canReuseLastPacketForSnapshot()` behind `!forceContext`.
- [ ] Use `user-force-regenerate` as the active refresh/invalidation reason when force is consumed.
- [ ] Call `invalidateActiveSceneCacheBestEffort()` with force details including `forceRegenerateId`, `source`, and `latestMesId`.
- [ ] Mark any loaded scene cache as stale for this run.
- [ ] Keep stale cache metadata available to Arbiter context if useful.
- [ ] Set prompt-eligible `cacheCards` to `[]` when force is consumed.
- [ ] Ensure `reuseCacheOnly` cannot become true during a forced run.
- [ ] Bypass Rapid foreground warm with `settings.pipelineMode === 'rapid' && !forceContext`.
- [ ] Add diagnostics such as `force-regenerate:user-force-regenerate`, `force-regenerate:cache-bypassed`, and `force-regenerate:rapid-bypassed`.
- [ ] Ensure the installed Last Brief uses a ready reason such as `force-regenerate-installed`.
- [ ] Re-run `node tools\scripts\test-runtime.mjs` until the new runtime tests pass.

## Task 4: UI Red Tests

- [ ] Add UI tests for a Recursion Bar Regenerate control in the Stop command slot.
- [ ] Assert the bar renders Regenerate when Recursion is enabled, idle, and runtime supports `forceRegenerateNext`.
- [ ] Assert the bar renders Stop instead of Regenerate during active prompt preparation or host generation.
- [ ] Assert clicking Regenerate calls `runtime.forceRegenerateNext({ source: 'bar' })`.
- [ ] Assert the button is disabled or pending when `runtime.view().forceRegenerate.pending` is true.
- [ ] Assert the empty Last Brief text reads `Preparing fresh prompt packet.` for `user-force-regenerate`.
- [ ] Assert the control does not call Reset Scene Cache.
- [ ] Run `node tools\scripts\test-ui.mjs` and confirm these assertions fail for expected missing UI wiring.

## Task 5: Bar UI Implementation

- [ ] Add a tooltip entry for Force Regenerate in `SETTINGS_TOOLTIPS` or the relevant UI tooltip map.
- [ ] Add a compact Regenerate button to the Recursion Bar command slot currently occupied by Stop during active work.
- [ ] Preserve Stop priority: active prompt preparation or host generation must show Stop and hide Regenerate.
- [ ] Use label text `Regenerate` or a refresh-style icon+tooltip if the existing bar command slot uses icon-first conventions.
- [ ] Wire the click handler to `runtime.forceRegenerateNext({ source: 'bar' })`.
- [ ] Refresh the UI after the runtime call resolves.
- [ ] Render pending state as `Regenerating` or a disabled button with equivalent accessible text.
- [ ] Show `Preparing fresh prompt packet.` while Last Brief is cleared for `user-force-regenerate`.
- [ ] Keep Reset Scene Cache in Advanced settings unchanged.
- [ ] Re-run `node tools\scripts\test-ui.mjs` until the new UI tests pass.

## Task 6: Storage And Diagnostics Checks

- [ ] Review `invalidateActiveSceneCacheBestEffort()` and storage invalidation details.
- [ ] Add storage assertions only if current tests do not prove the force invalidation reason/details are persisted.
- [ ] Ensure force invalidation is soft: cache records are stale, not deleted.
- [ ] Confirm `resetSceneCache()` tests still prove destructive reset behavior separately.
- [ ] Run `node tools\scripts\test-storage.mjs` if storage assertions were changed.

## Task 7: Documentation Updates

- [ ] Update `docs/design/UI_SPEC.md` with Recursion Bar Regenerate placement, pending state, Stop priority, and distinction from Reset Scene Cache.
- [ ] Update `docs/architecture/RUNTIME_ARCHITECTURE.md` with the force token and one-shot consumption behavior.
- [ ] Update `docs/technical/RUNTIME_TURN_SEQUENCE.md` with the forced branch in `prepareForGeneration()`.
- [ ] Update `docs/user/RECURSION_OPERATOR_MANUAL.md` with when to use Regenerate vs Reset Scene Cache.
- [ ] Search docs for old wording that implies Reset Scene Cache is the only user-facing way to force a fresh run.

## Task 8: Guarded Live Proof

- [ ] Add or extend a guarded Playwright proof for the served SillyTavern extension.
- [ ] Use a dedicated soak user and the actual served extension path.
- [ ] Generate or load a ready Last Brief.
- [ ] Capture current packet id and card count.
- [ ] Click Regenerate in the Recursion Bar command slot.
- [ ] Assert the Last Brief visually clears to the fresh preparing state.
- [ ] Trigger generation through the visible send/swipe path or a guarded runtime hook.
- [ ] Assert provider calls occurred.
- [ ] Assert no `same-turn-swipe-retry` reinstall diagnostic is emitted for the forced run.
- [ ] Assert the new packet id differs from the old packet id.
- [ ] Assert Last Brief restores with ready cards.

Suggested live command shape:

```powershell
$env:SILLYTAVERN_BASE_URL='http://127.0.0.1:8000'
$env:RECURSION_SILLYTAVERN_USER='recursion-soak-a'
$env:RECURSION_SILLYTAVERN_HEADLESS='1'
node tools\scripts\prove-live-force-regenerate.mjs --live
```

## Task 9: Verification Gate

- [ ] Run `node tools\scripts\test-runtime.mjs`.
- [ ] Run `node tools\scripts\test-ui.mjs`.
- [ ] Run `node tools\scripts\test-storage.mjs` if touched.
- [ ] Run `node tools\scripts\run-alpha-gate.mjs`.
- [ ] Run the guarded live proof when SillyTavern is available.
- [ ] Record exact commands and results in the final implementation handoff.

## Task 10: Completion Review

- [ ] Review `git diff --check`.
- [ ] Review the final diff for accidental compatibility shims or unrelated refactors.
- [ ] Confirm no force token can persist across disabled/source-reset states.
- [ ] Confirm Rapid mode setting is unchanged after a forced run.
- [ ] Confirm latest-assistant swipe reuse still works when Force Regenerate is not pending.
- [ ] Confirm Reset Scene Cache remains destructive and separate.
- [ ] Commit only the intended implementation, tests, and docs when requested.

## Acceptance Checklist

- [ ] Force Regenerate queues a one-shot fresh run.
- [ ] Force Regenerate bypasses latest-assistant swipe packet reinstall.
- [ ] Force Regenerate bypasses same-turn packet reuse.
- [ ] Force Regenerate bypasses Rapid warm only for the forced run.
- [ ] Force Regenerate soft-invalidates cache instead of deleting it.
- [ ] Cached cards cannot enter the forced prompt hand.
- [ ] Last Brief clears with a visible fresh-preparing state and restores with a new ready packet.
- [ ] UI makes Regenerate distinct from Reset Scene Cache.
- [ ] Deterministic runtime and UI tests pass.
- [ ] Alpha gate passes.
- [ ] Live proof confirms the behavior on the served SillyTavern extension.
