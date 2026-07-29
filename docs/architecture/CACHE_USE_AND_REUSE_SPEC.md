# Cache Use And Reuse Spec

## Purpose

This is the current cache and resumable-execution contract for Recursion. Cache improves cost and continuity only when the stored work still proves that it belongs to the active chat state. It is disposable evidence, not story memory.

Recursion has four distinct reuse layers:

1. scene-card cache and bounded source variants;
2. volatile Prepared Generation Artifact for exact same-turn prompt reinstall;
3. durable stage checkpoints and isolated resume artifacts;
4. idempotent Post-process commit receipts.

The old background warm pipeline is retired. Unknown pre-alpha pipeline settings fall through normal enum validation to Segmented, and old warm fields are ignored when scene caches normalize.

## Scene-Card Cache

`recursion-scene-{chatKey}-{sceneKey}.v1.json` stores a bounded current-scene deck and safe latest-hand metadata. It may be deleted and rebuilt at any time.

A scene cache is eligible only when all relevant contracts match:

- chat and scene identity;
- active bounded source revision;
- selected swipe and visible-message hashes;
- character and group identity;
- settings and active deck revision;
- provider and prompt contract versions;
- card catalog and packet versions;
- each card's evidence/source validation.

Source variants support swipe A/B/A without treating inactive swipe text as current. Each scene retains a bounded `variantOrder`; runtime selects only the exact active revision.

Purple means validated cache reuse. Source mismatch or ordinary stale state is a neutral rebuild, not a warning. Invalid or unreadable storage becomes a sanitized warning only when it prevents safe use.

## Prepared Generation Artifact

`lastPreparedGeneration` is in-memory exact-packet reuse for a same-turn swipe or reinstall. It includes the committed packet and hand plus a strict basis:

- source revision and source-window contract hashes;
- visible message hashes and selected swipe;
- character/group identity;
- settings, deck, provider, prompt, and packet-input hashes;
- artifact integrity hash.

It has no wall-clock expiry. Reuse is a hit only when every required identity and contract still matches. A source mutation, reset, disable, teardown, or incompatible setting/provider change clears or rejects it.

Primary SillyTavern story generation is not cached or automatically retried by Recursion.

## Durable Stage Checkpoints

Every Pre-process run is a dependency graph:

```text
Snapshot
  -> Utility Arbiter
  -> Segmented card stages OR Fused card bundle
  -> Deck
  -> Hand
  -> Guidance
  -> Prompt Packet
  -> Prompt Install
```

Post-process uses either one Unified guidance/rewrite pair or ordered Progressive category guidance/rewrite pairs, followed by one host commit.

A checkpoint contains metadata only:

- operation and stage ids;
- stage version and state;
- input and output hashes;
- dependency output hashes;
- source/settings/provider/pipeline/prompt provenance;
- attempt counters and timestamps;
- logical artifact reference, hash, and byte count.

The snapshot, Arbiter JSON, cards, hand, packet, guidance, drafts, and commit receipt live only in isolated `recursion-pipeline-artifact-*` records. Manifests, activity, run journals, diagnostics, and chat markers must not copy those bodies.

### Reuse decision

A completed checkpoint is reusable only when:

1. the stage id and version match;
2. the stage input fingerprint matches;
3. every declared dependency checkpoint hash matches;
4. run provenance matches the current source, settings, provider, pipeline, and prompt versions;
5. the referenced artifact exists and its SHA-256 matches both reference and output hash;
6. the stage validator accepts the artifact again.

Any failure invalidates that stage and its descendants. Unrelated compatible checkpoints remain reusable.

### Artifact commit ordering

The scheduler writes and verifies an artifact before it commits the checkpoint manifest. A body without a checkpoint is not reusable. Running and paused current operations temporarily protect same-operation artifacts so repair cannot race a just-written artifact before its manifest update.

## Pipeline Cache Behavior

### Segmented

Segmented gives each requested card an independent model stage. A valid cached card/checkpoint skips only its own provider work. Sibling stages can still run or fail independently.

Segmented is the default and is suited to smaller, simpler, or locally hosted models that benefit from narrow requests.

### Fused

Fused makes one structured bundle call after the Arbiter. Each requested card becomes a validation outcome under the executable Fused parent. Valid siblings may be accepted even if other siblings fail.

If zero useful cards survive, Recursion records `fused-fallback-segmented` and runs the Segmented card stages. The Fused validation children are informational and never own Stop, Resume, Retry, or Reprocess.

## Attempts And Waiting

The canonical settings are:

```json
{
  "pipelineMode": "segmented",
  "modelAttemptsPerStep": 2
}
```

`Attempts per step` is the total automatic model-call window for each model stage, including the first call. Values are one through five. A transport failure may repeat the request; a validation failure may use a correction request. Local, storage, packet, validation, prompt-install, and commit stages do not consume this window.

Recursion sets no default generation timeout. A call can remain pending indefinitely until its provider returns, fails, or the user stops it. Slow work is not retried merely for being slow. Provider-owned deadlines can still surface as provider failures.

## Stop, Resume, And Retry

Stop aborts the active Recursion model call and pauses the operation. Every already committed checkpoint remains. A call that may have been charged by the provider but never returned cannot be reconstructed or refunded.

Resume validates provenance and continues from the earliest pending frontier. A reload converts an in-flight `running` stage back to pending and restores the operation as paused; it never assumes the interrupted call succeeded.

Retry is available only on the blocking failed executable stage. It opens a new attempt window for that stage, clears its failure, invalidates its descendants, and preserves unrelated valid checkpoints.

## Queued Reprocess

Reprocess is deferred to the next generation so the user does not need to catch a short-lived active row.

Selecting a completed/cached eligible row stores a chat-scoped intent:

```json
{
  "schema": "recursion.queued-reprocess.v1",
  "mode": "stage",
  "stageIds": ["preprocess.cards.segmented.character"]
}
```

The intent includes the selected executable owner and its dependents. On the next matching phase, runtime binds it to the new graph, invalidates those checkpoints, preserves compatible ancestors and unrelated siblings, and consumes each queued stage as it starts. A second click cancels the selected queued stage. Inapplicable stage ids are rejected with `stage-reprocess-inapplicable`.

Pre-process and Post-process stage ids can coexist in one intent. Starting Pre-process must not discard a Post-process intent that belongs to the later phase.

## Full Fresh

Full fresh is also queued for the next send or swipe:

```json
{
  "schema": "recursion.queued-reprocess.v1",
  "mode": "full-fresh",
  "stageIds": []
}
```

The button's idle accessible label is `Queue a full fresh generation`; its selected state is `Full fresh generation: Queued`. Clicking again cancels it.

Full fresh starts no provider or host work by itself. The next generation consumes it once, bypasses the Prepared Generation Artifact and reusable scene/stage cache for that operation, then returns future generations to normal Segmented or Fused behavior.

Full fresh differs from Reset Scene Cache:

- full fresh is one-shot and preserves stored cache records for later validated use;
- Reset Scene Cache immediately deletes all current-chat scene and execution cache state.

## Stale Operations

Source, selected swipe, character/group, settings, provider, pipeline, prompt version, stage version, dependency, or artifact-integrity drift makes incompatible work stale. A stale run cannot Resume or commit late output.

The earliest meaningful executable row may offer queued Reprocess. Starting a fresh compatible operation supersedes the stale work. Stale artifact bodies are removed during repair/retention, while bounded metadata may remain long enough to explain why reuse was refused.

## Post-process Reuse And Commit

Post-process freezes the completed response, bounded evidence, active deck, settings, and source identity before work.

Unified checkpoints source, guidance, rewrite, and host commit. Progressive checkpoints each category guidance/rewrite pair, carrying the last valid draft forward.

The host commit stage uses a stable commit id, final artifact hash, source identity, and Recursion marker. Resume first checks whether that mutation is already present. `resume-commit-already-applied` completes without appending a duplicate swipe or replacing twice.

After successful commit:

- delete source-snapshot and guidance artifacts;
- delete earlier Progressive drafts;
- retain the final accepted draft and commit receipt;
- keep only hashes, counts, outcomes, and stable codes in marker/diagnostics.

## Retention And Repair

`repairIndex()` rebuilds the index from valid Recursion records and removes pipeline artifacts not owned by the authoritative current manifest or referenced by a reusable terminal checkpoint. It preserves unreadable records instead of guessing.

Ordinary retention:

- protects the active scene;
- protects all artifacts for a running or paused current operation;
- preserves reusable completed Pre-process checkpoints;
- removes intermediate successful Post-process artifacts;
- removes stale artifact bodies;
- removes abandoned manifests and artifacts;
- bounds scene caches, source variants, and journals.

Old warm fields are neither migrated nor interpreted. Normal record normalization drops them, and bounded cache retention eventually removes their containing retired variants.

## Reset Scene Cache

For the current chat, Reset Scene Cache immediately:

1. abandons active execution;
2. deletes the scene cache;
3. deletes the execution manifest;
4. deletes all operation artifacts;
5. deletes queued Reprocess/full-fresh intent;
6. clears in-memory packet, hand, plan, and execution state;
7. clears installed Recursion prompt lanes.

It never deletes or rewrites SillyTavern messages.

## Progress And Actions

Cached rows remain purple; completed generated rows remain green. Only the contextual action button is cyan.

| State | Eligible owner action |
| --- | --- |
| running frontier | Stop |
| paused frontier | Resume |
| blocking failed | Retry |
| completed/cached | Reprocess |
| queued | Cancel queued reprocess |
| stale | Reprocess on earliest meaningful owner |
| pending/blocked/skipped | none |

Every row reserves one 24px action slot and renders at most one icon button. Actions are direct and do not depend on expanding a row. Tooltips and ARIA labels are concise and exact. Narrow layouts truncate reason/meta before shrinking the action target.

## Diagnostics

Execution diagnostics are allowlist-only:

- operation id, phase, and state;
- stage id and state;
- attempt count;
- elapsed milliseconds;
- failure class;
- artifact hash and byte count;
- stale field names;
- stable bounded lifecycle codes.

Forbidden everywhere outside dedicated artifact reads: raw prompt/model bodies, Arbiter JSON, card/reference bodies, packet/hand bodies, Post-process guidance, progressive drafts, and final prose copied only for resume.

## Acceptance

Deterministic coverage must prove:

- exact scene and Prepared Generation Artifact hits;
- Segmented sibling checkpoint reuse;
- Fused zero-useful-card fallback;
- Stop preserves committed work;
- reload restores as paused;
- Resume skips valid ancestors;
- Retry reruns the blocking stage and descendants only;
- queued Reprocess binds and consumes once;
- full fresh consumes once;
- source/settings/provider drift makes work stale;
- missing/hash-invalid artifacts are rejected;
- terminal Post-process purge and idempotent commit;
- repair removes orphans;
- Reset Scene Cache clears all current-chat execution state;
- canary bodies appear only in dedicated artifact storage.
