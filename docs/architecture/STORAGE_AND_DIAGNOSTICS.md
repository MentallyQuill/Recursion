# Storage And Diagnostics

This is the implementation-facing V1 storage, retention, privacy, and diagnostics contract.

Fused execution summaries and diagnostics retain original per-family rejection codes, accepted/unresolved families, and whether individual repair was scheduled. The `stages[].fused` projection is normalized by `src/fused-recovery.mjs`; only catalog families, fixed codes, and bounded lists are exported. Repair stages remain separate durable checkpoints, so saved/reloaded progress can distinguish original rejection, active repair, recovered completion, and unresolved failure without retaining rejected model prose. Fused stage version 2 invalidates earlier checkpoints that omitted source instructions or rejection metadata.

## Principles

1. SillyTavern chat is authority for story state.
2. Recursion-generated work is scoped to one exact turn operation.
3. Manifests contain metadata; resumable bodies live in isolated artifacts.
4. Last Brief is historical display data, never generation authority.
5. Secrets, raw model I/O, and full transcript archives are forbidden in settings, manifests, journals, diagnostics, and reports.

## Current Logical Records

| Record | Purpose | Lifecycle |
| --- | --- | --- |
| `recursion-settings.v1.json` | Normalized extension settings without session-only keys. | Durable. |
| `recursion-system-index.v1.json` | Bounded index of known journals, operations, and artifacts. | Durable but rebuildable. |
| `recursion-last-brief-{chatKey}.v1.json` | Display-only packet and hand summary for the UI. | Historical; never read for generation. |
| `recursion-run-journal-{chatKey}.v1.json` | Sanitized lifecycle events and retained Post-process outcomes. | Events bounded by `runJournalEntries`; latest 12 terminal outcomes retained independently. |
| `recursion-pipeline-run-{chatKey}.v2.json` | One active or latest V2 operation manifest for a chat. | Turn-scoped. |
| `recursion-pipeline-artifact-{chatKey}-{operationId}-{artifactId}.v2.json` | Isolated stage output required for Resume or validated same-turn reuse. | Protected only while referenced and authoritative. |
| `recursion-queued-reprocess-{chatKey}.v2.json` | One-shot Pre-process or Post-process next-swipe intent. | Consumed once, canceled, or revoked with the turn. |

Pre-V2 generated record filenames may still be detected by the private retired-record pruning pass. No public repository method can load them as generation input.

## Settings

The retention contract contains exactly:

```json
{
  "sourceWindowMessages": 20,
  "sourceWindowCharacters": 12000,
  "providerVisibleMessages": 12,
  "runJournalEntries": 100
}
```

The first three values bound source construction and provider analysis. The final value bounds sanitized journal history. Generated operation artifacts are governed by manifest references and automatic pruning, not operator-tuned lifetime controls.

Recursion stores no provider endpoint or credential. Reset Defaults preserves Connection Profile selections and policies, custom decks and scope, compact-bar settings, and viewer visibility. It updates normalized settings, pauses incompatible work, and clears Recursion prompt lanes without deleting chat.

## V2 Manifest

A manifest records:

- operation id, graph version, phase, state, and revision;
- chat key, turn-key hash, source-band hash, and safe source identity;
- native generation type and whether the operation is host-owned;
- normalized provenance hashes;
- queued stage ids and frontier ids;
- per-stage state, attempts, failure class, diagnostic codes, and checkpoint metadata.

It does not contain prompt text, card bodies, provider JSON, hidden reasoning, transcript text, Post-process drafts, or final prose.

## Isolated Artifacts

Stage bodies are written before checkpoint commit. A checkpoint references one artifact id, key, content hash, and byte count. Loading validates record kind, operation binding, artifact id, and content hash.

Missing, corrupt, orphaned, or provenance-incompatible artifacts are never treated as successful work. The scheduler invalidates the checkpoint and recomputes or pauses at the earliest safe frontier.

Running and paused operations protect every referenced resume artifact. Completed Pre-process operations protect only artifacts needed for exact same-turn swipe reuse. Completed Post-process operations keep the accepted final artifact and idempotent host-commit receipt; intermediate drafts are disposable. Stale, abandoned, and superseded operations protect no artifact bodies.

## Post-process Comparisons

Comparison records are separate from execution manifests and normal diagnostics. They bind the immutable original, candidate text/hash, current writable target, writer/scope metadata, review state, and receipt. At most ten completed comparisons are retained per chat; pending review is protected. Stale or rejected records discard retry-only inputs. Missing or corrupt comparison data is unavailable, never reconstructed from another swipe.

Comparison persistence must precede automatic application so Replace cannot destroy the only retained original. Reset Turn Cache and chat cleanup remove the corresponding comparison bodies without changing host messages. Retained original/final prose is for the comparison viewer, not diagnostic exports.

## Last Brief Isolation

Last Brief storage exposes only UI-oriented load/save/clear operations. The runtime may hydrate it for inspection after reload, but Pre-process planning, card selection, packet construction, and reuse never read from it.

A new turn can leave the previous Last Brief visible until new work commits. That visual persistence does not extend generation authority.

## Queued Intent Storage

A queued intent binds:

- chat key;
- phase;
- turn-key hash;
- selected executable stage ids or full-rebuild mode;
- queued timestamp.

Only the next matching swipe may consume it. A new user turn, changed source band, chat change, Reset Turn Cache, or explicit cancellation removes it. Post-process intents additionally bind to the assistant response identity.

## Automatic Pruning

`maintainRetention()` repairs the system index, invokes retired generated-record deletion, removes orphan artifacts, and drops artifacts from stale, abandoned, superseded, or no-longer-authoritative prior turns. It protects the current running or paused operation and any artifact awaiting manifest commit.

`pruneRetiredGeneratedRecords()` is deletion-only. Its private legacy-key matcher is not a compatibility layer and cannot return data to runtime planning.

## Reset Turn Cache

Reset Turn Cache:

1. pauses or revokes the active turn operation;
2. deletes its manifest and generated artifacts;
3. clears queued Pre-process and Post-process intents;
4. clears prepared in-memory packet, hand, and execution views;
5. clears Recursion-owned SillyTavern prompt lanes.

It does not delete SillyTavern messages, character data, World Info, or another extension's records.

## Run Journal

Guidance omissions remain `{ id, reason }` records through composition, Last Brief persistence/reload, and diagnostics (`guidance.omittedCardIds` and `guidanceOmittedCardIds`). Reasons are `duplicate`, `lower-priority`, `unsupported`, or `unsafe`; invalid entries are discarded and IDs are deduplicated. A Guidance omission describes composer treatment of selected evidence. It is distinct from `hand.omitted` and its `omittedCount`, which describe hand selection. Neither count proves that narration ignored a card.

Host-stop events with no supplied failure preserve an explicit reason (`host-stop-cause-unavailable` when unknown, or `recursion-requested-stop` when Recursion requested it). They do not manufacture an internal failure. Supplied structured errors remain failures. Guidance provider journal entries retain bounded field/type errors, `stageAttempt` when supplied by the scheduler, and `semanticNormalization: guidance-request-envelope` when missing request identifiers were locally bound. `retryCount` describes router retries, not scheduler attempts. No returned prose is needed for this evidence.

Guidance semantic failures carry an optional `validationRule` through attempt classification, durable stage failure records, normalization/reload, and `runtime.execution.stages[]` diagnostic exports. Only `model-reasoning`, `character-interiority`, and `unrevealed-story` are accepted; arbitrary values are omitted at each boundary. The field identifies the rejected wording category without retaining a matched phrase or rejected response body. Successful corrections clear the active failure record, preserve normal completion UI, and do not add extra provider attempts.

Turn timing additionally records nullable `hostRequestReadyAt` from `CHAT_COMPLETION_SETTINGS_READY` only for explicitly typed `normal`, `swipe`, `continue`, or `regenerate` requests. Derived milliseconds distinguish `preparedToRequestReadyMs`, `requestReadyToFirstVisibleTokenMs`, `postPreparationMs`, and `visibleStreamingMs`. Missing boundaries stay null. Quiet/raw work, untyped events, pre-preparation events, duplicates, invalidated attempts and late milestones after visible output cannot fill these fields. The event does not establish actual network dispatch: other handlers and host work can still run before fetch. Untyped `GENERATE_AFTER_DATA` and text-completion settings events cannot safely identify primary work and are not used. These observations describe the current active generation; the host supplies no request ID to disambiguate overlapping primary invocations, and they must not be interpreted as server-side timing.

Journal entries use bounded enums and safe identifiers. Useful events include:

- operation started, paused, resumed, completed, stale, or abandoned;
- stage started, attempted, checkpointed, reused, failed, retried, or invalidated;
- queued reprocess created, canceled, consumed, or rejected;
- prompt installed, install failed, or prompt cleared;
- host generation started or stopped;
- Post-process response identity captured, rewritten, committed, or rejected;
- storage repaired or pruned.

Entries may include hashes, counts, ids, attempt numbers, failure classes, and stable diagnostic codes. They must not include raw message text, prompts, response bodies, provider endpoints with credentials, bearer tokens, API keys, cookies, stack traces, or hidden reasoning.

## Diagnostics

Diagnostics export normalized settings, provider capability summaries, safe activity history, execution metadata, artifact counts and hashes, Last Brief summaries, and journal entries. Optional excerpts are bounded and sanitized. Default reports use hashes and counts only.

Actual failures expose a structured code, stage, category, readable message, retryability, attempted recovery, and suggested action. Host-stop warnings without an underlying error retain cancellation/unknown-cause metadata rather than an invented failure. Secret-bearing thrown errors are converted to fixed safe copy before reaching activity, journal, or caller surfaces.

Provider failure records retain `status` only for numeric HTTP errors (400–599) and `transportCode` only for recognized transport failures. Failed connection-profile calls also retain the configured `model`, `providerSource`, and timing metadata. These fields identify the failing connection and response class without copying arbitrary upstream error codes, messages, URLs, or bodies.

## Failure Handling

Host storage can fall back to memory when a write fails. The repository reports `persisted: false` and a sanitized warning; UI must not claim durable persistence. Manifest and artifact writes used for Resume remain integrity-checked even in memory.

Prompt-clear failure does not roll back a settings change or Stop request, but it remains a visible bounded warning. Host mutation failure never promotes an uninstalled packet or uncommitted Post-process body into successful state.

## Required Tests

Tests cover record normalization, artifact integrity, write-before-checkpoint ordering, orphan pruning, Last Brief isolation, queued-intent binding, retired-record deletion, journal bounds, diagnostics redaction, memory fallback, and Reset Turn Cache ownership.

## Retained Post-process Outcomes

Each terminal Post-process outcome is appended as `postprocess.outcome` and retained in the same chat journal's `postProcessOutcomes` list (maximum 12), independently of ordinary event eviction. A subsequent Pre-process manifest cannot overwrite this history. Append and clear operations serialize per chat to prevent concurrent lost writes. Clearing the journal removes both events and retained outcomes.

`runtime.postProcessStatus` exposes the current chat's active or last terminal outcome; `runtime.postProcessHistory` in exported diagnostics restores the retained history after reload. Export resolves the host's current chat, and chat changes reload only that chat's outcomes. Records contain operation/chat identity, status, timestamps and elapsed time, writer mode/profile/model, apply mode, hashes, bounded category counts/codes, and a bounded failure stage/code/message/class/retryability. They exclude drafts, candidates, request/response bodies, endpoints and credentials even when excerpts are enabled. Writer failures use authored safe descriptions rather than provider response text.
