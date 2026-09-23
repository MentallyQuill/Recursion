# First Run Workflow

Recursion compiles bounded, turn-local guidance for SillyTavern's native generation. It builds a disposable turn deck and hand, installs an inspectable prompt packet, and can optionally refine the landed assistant response. It is not a memory manager or detached story generator.

## 1. Configure Utility

1. Create a SillyTavern Connection Profile for the model Recursion should use.
2. Open a SillyTavern chat and turn Recursion on.
3. Open Options, then Providers.
4. Select the profile for Utility.
5. Keep Behavioral Preset on Isolated, Instruct Formatting on Auto, Samplers on Connection Profile, and Structured Output on Auto.
6. Run Test Profile.
7. Confirm Utility reports Segmented or Fused.

Test Profile has a bounded diagnostic deadline. Normal model stages may remain pending until the Connection Profile returns, fails, or you stop the operation.

## 2. Start With Segmented Auto

1. Select Segmented from the Pipeline control.
2. Select Auto mode.
3. Leave Tense & PoV on Auto.
4. Send a user message.
5. Watch the progress tree reach `Recursion prompt ready` or a clear fail-soft outcome.

Segmented gives each requested card family a narrow structured call. Fused asks a capable model for one larger bundle and repairs damaged siblings through Segmented work.

SillyTavern always owns the primary story generation. Recursion prepares context and then returns control to the host.

## 3. Understand Turn-Scoped Reuse

Every sent user message starts a new Recursion turn and runs fresh planning/card work. Recursion does not guess whether the story is still in the same semantic scene and does not keep generated work alive with a timer.

When you swipe the assistant response without changing anything in Recursion's configured source band, Recursion may reinstall the already validated packet with zero model calls. This lets SillyTavern roll another response from the same reasoning context.

An edit, delete, relevant selected-swipe change, character/group change, settings/provider change, or other turn-key mismatch rejects that reuse and rebuilds safely.

## 4. Use Progress Actions

Each eligible row exposes at most one action:

| State | Action | Effect |
| --- | --- | --- |
| Active | Stop | Pause Recursion, stop the host when applicable, and preserve accepted checkpoints. |
| Paused | Resume | Ask SillyTavern to repeat the matching native action; continue only when the host interceptor returns. |
| Retryable failure | Retry Stage | Reset the failed stage and its dependent work. |
| Completed or stale | Reprocess from here on the next swipe | Queue one turn-bound rebuild boundary. |
| Queued | Cancel queued reprocess | Cancel the pending one-shot action. |

Stop and Resume never generate a detached story response. Resume does not call a provider by itself; the normal SillyTavern generation path re-enters Recursion.

## 5. Reprocess On A Swipe

Use `Reprocess from here on the next swipe` when a specific stage and its dependents should be rebuilt for another roll.

1. Click the action on an eligible progress row.
2. Confirm the row changes to `Cancel queued reprocess`.
3. Swipe the current assistant response.
4. Recursion consumes the intent once, rebuilds from that stage, installs the new packet, and lets SillyTavern generate the swipe.

Clicking the row does not immediately run a provider or start host generation. Sending a new user message cancels the queued swipe action and starts a fresh turn.

## 6. Request A Full Rebuild

When Recursion is idle, the Stop slot becomes `Rebuild all Recursion work on the next swipe`.

1. Click it once.
2. Confirm its state is `Full rebuild on next swipe: Queued`.
3. Swipe the current assistant response.

The matching swipe consumes the intent once and bypasses all reusable Pre-process checkpoints. Clicking the queued control again cancels it. A new user message never inherits or consumes it.

## 7. Tune Attempts And Pipelines

Advanced Execution exposes `Attempts per step`:

- default: 2;
- range: 1 through 5;
- applies only to dispatched Recursion model calls.

Local validation, persistence, packet composition, and host mutations do not consume attempts. Recursion never automatically retries SillyTavern's story generation.

Try Manual mode to restrict runnable cards to your selected family/sub-item scope. Fused can be selected without a profile test; malformed bundles retain automatic repair and fallback.

## 8. Enable Post-process Carefully

Post-process freezes the landed assistant response identity and bounded evidence before work begins. Unified produces one guarded rewrite; Progressive applies categories in order.

- Stop leaves the original response intact.
- Resume continues through native host re-entry and reuses valid checkpoints.
- A changed response body or selected swipe has a different identity and cannot reuse another response's rewrite.
- A host-commit receipt prevents duplicate swipe append or replacement.
- Failed or stale work never mutates the visible response.

## 9. Inspect And Reset

Last Brief shows the last committed packet and cards for review. It is display-only: it never decides whether runtime work can be reused.

Use `Reset Turn Cache` when you want to delete Recursion-generated work for the active turn without changing SillyTavern messages. The reset also clears the active turn's queued intent, prepared packet, and Recursion-owned prompt state.

Storage Retention exposes Journal Entries only. Generated prior-turn artifacts are pruned automatically; there is no scene-retention tuning surface.

## First-Run Success Checklist

- Utility reports Segmented or Fused.
- A new user message performs fresh Arbiter/card work.
- An unchanged swipe can reuse the packet without Recursion model calls.
- An edit inside the configured source band rejects reuse.
- Reprocess and Full Rebuild wait for the next matching swipe and consume once.
- Stop leaves a coherent paused state and requests native host Stop once.
- Resume requests native host Start and makes no detached provider call.
- Last Brief remains inspectable but does not authorize reuse.
- Diagnostics contain no profile id, endpoint, credential, raw prompt, raw response, or hidden reasoning.
