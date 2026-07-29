# Recursion Resumable Pipeline Execution Design

**Status:** Approved behavior; written specification review pending

**Date:** 2026-07-29

**Feature owner:** Recursion

**Breaking V1 changes:** Retire Rapid, rename Standard to Segmented, replace
abort-and-discard operation handling with durable stage checkpoints

## Purpose

Recursion's Pre-process and Post-process flows depend on several model calls,
host operations, validations, and storage mutations succeeding in the correct
order. A late failure or user cancellation can currently discard useful work
that was already paid for and successfully completed. The cost is especially
high in Progressive Post-process runs and in Pre-process turns that generated
several cards before failing near prompt composition or installation.

This design makes a Recursion operation resumable. Each meaningful stage
commits a validated checkpoint before dependent work begins. Stop pauses the
operation at the last committed frontier. Retry resumes failed work. Completed
or cached stages can be queued for reprocessing on the next user-initiated
generation. Downstream reuse is determined from explicit dependency
fingerprints rather than broad all-or-nothing cache decisions.

The result should preserve Recursion's simple normal experience:

- users still send or swipe through SillyTavern;
- model calls may wait indefinitely by default, as SillyTavern generations do;
- automatic retries are bounded and configurable;
- successful work survives Stop, page reload, and chat switching;
- the progress tree exposes at most one contextual action per actionable row;
- users who never open progress controls do not acquire a new workflow.

## Design Drivers

The design follows these approved decisions:

1. The Utility Arbiter remains model-owned. Recursion must not replace its
   semantic planning with deterministic story heuristics.
2. Recursion imposes no default wall-clock timeout on a model call.
3. Automatic attempts are bounded per model step, not across the whole
   operation.
4. The default is two total attempts per model step, configurable from one to
   five.
5. Stop preserves committed work and pauses the operation.
6. Paused work remains resumable after a reload or chat switch.
7. Reprocessing a settled stage is queued for the next user-initiated
   generation; it does not start a generation immediately.
8. Queued reprocessing is dependency-aware. Unchanged downstream inputs retain
   their checkpoints.
9. Rapid is retired.
10. Standard is renamed **Segmented**.
11. Fused remains the one-call card-bundle pipeline.
12. Stage controls stay icon-first, contextual, compact, and mobile-safe.

## Goals

- Preserve every validated stage result that can safely be reused.
- Make Stop a recoverable pause instead of an expensive reset.
- Resume without repeating completed provider calls.
- Prevent stale artifacts from crossing chats, swipes, sources, settings,
  providers, card-deck revisions, or prompt/schema contracts.
- Keep the Arbiter as the semantic planning authority.
- Give local and unusually slow models unlimited time by default.
- Bound automatic repeat spending after actual failures.
- Make parallel Segmented card work independently recoverable.
- Make Progressive Post-process recoverable without duplicating successful
  category calls or final chat mutations.
- Keep the ordinary SillyTavern send/swipe interaction unchanged.
- Keep stage actions understandable through familiar icons, tooltips, focus
  labels, and touch feedback.

## Non-Goals

- Automatically deciding that a slow call is stalled.
- Adding a default latency timeout.
- Streaming partial provider output into checkpoints.
- Resuming an in-flight network request after reload.
- Removing or replacing the Utility Arbiter.
- Combining Arbiter, cards, guidance, and prompt installation into one call.
- Adding a visual pipeline editor.
- Adding per-card provider selection.
- Presenting every internal function as a user-actionable stage.
- Preserving compatibility aliases for the retired `standard` or `rapid`
  pipeline values.
- Automatically resuming work while the user is away.

## Product Vocabulary

| Term | Meaning |
| --- | --- |
| Operation | One Recursion-controlled Pre-process or Post-process execution associated with a frozen source identity. |
| Stage | A stable, named unit of work with declared inputs, dependencies, output validation, retry policy, and failure policy. |
| Model step | A stage attempt that invokes Utility, Reasoner, or SillyTavern's native quiet writer. |
| Checkpoint | A validated, committed stage artifact plus the metadata required to prove whether it is reusable. |
| Frontier | The earliest stage or independent branch that still needs work. |
| Attempt window | The configured number of automatic attempts available when a model step starts or is manually retried. |
| Paused | An operation has stopped at committed checkpoints and will not continue automatically. |
| Retry | Continue the same paused operation by rerunning its failed model step with a fresh attempt window. |
| Resume | Continue the same paused operation from its first incomplete frontier. |
| Reprocess | Deliberately rerun a completed or cached stage instead of accepting its checkpoint. |
| Queued | Reprocessing has been selected for the next eligible user-initiated generation. |
| Stale | A checkpoint's provenance or dependency fingerprint no longer matches the operation that wants to use it. |
| Segmented | The foreground pipeline that generates requested cards through separate, focused model steps. |
| Fused | The foreground pipeline that generates all requested cards through one structured bundle model step. |

`Armed` is not user-facing or canonical runtime vocabulary for this design.
Existing fresh-next-generation language and state should be renamed to
`Queued` terminology when the execution contract is implemented.
Visible `Queued` is reserved for deliberate user-selected reprocessing.
Ordinary work waiting on a dependency remains `Pending`.

## Pipeline Product Contract

### Segmented

Segmented replaces Standard as the default pipeline.

```text
Snapshot
  -> Utility Arbiter
  -> separate requested-card model steps
  -> deck update
  -> hand selection
  -> guidance composition
  -> prompt packet
  -> prompt installation
  -> SillyTavern generation
```

Each requested card is an independently validated child stage. The scheduler
may run independent card stages concurrently. A completed sibling commits its
checkpoint even when another sibling fails or the operation is later stopped.
Resume schedules only incomplete or stale children.

Segmented is the recommended pipeline for small, local, fast, inexpensive, or
instruction-limited models because each model request has one narrow job.

Canonical setting value:

```js
pipelineMode: "segmented"
```

### Fused

Fused keeps its approved scope:

```text
Snapshot
  -> Utility Arbiter
  -> one structured card-bundle model step
  -> item-level validation
  -> deck update
  -> hand selection
  -> guidance composition
  -> prompt packet
  -> prompt installation
  -> SillyTavern generation
```

Arbiter planning, guidance composition, and prompt installation remain
separate. Valid bundle items survive invalid or omitted siblings. If Fused
exhausts its attempt window without one useful card, it may fall back once to
the Segmented card branch for the same validated Arbiter plan. The fallback is
visible in progress and diagnostics. It does not rerun the Arbiter.
The Fused bundle consumes its own attempt window; each Segmented child started
by the fallback receives its own configured attempt window.

Fused is recommended for stronger reasoning models that can maintain
cross-card coherence in one structured response.

Canonical setting value:

```js
pipelineMode: "fused"
```

### Rapid retirement

Rapid, its background warming, warm artifacts, delta role, settings state,
progress states, tests, and current operator documentation are removed.

The V1 pipeline enum becomes:

```js
["segmented", "fused"]
```

Because Recursion is pre-alpha, there is no legacy adapter. An unknown stored
pipeline value, including `standard` or `rapid`, follows ordinary enum
normalization to the default `segmented` value and is saved canonically on the
next settings write. Retired Rapid artifacts are ignored and pruned through
normal bounded-storage cleanup.

## Execution Architecture

The runtime should separate five responsibilities that are currently coupled
across broad orchestration paths.

### Stage registry

The stage registry declares what a stage does without executing it:

```js
{
  id: "preprocess.arbiter",
  version: 1,
  kind: "model",
  dependencies: ["preprocess.snapshot"],
  checkpoint: "durable",
  failurePolicy: "pause",
  run: runArbiter,
  validate: validateArbiterPlan
}
```

Each stage declaration owns:

- stable stage id and contract version;
- dependency ids;
- whether it is local, model, host, storage, or commit work;
- whether its output is durable, referenced, or non-checkpointable;
- the input-fingerprint builder;
- output validation;
- retry classification for model work;
- failure policy;
- sanitized progress metadata.

Stage ids are durable contracts. Display labels can change without invalidating
stored checkpoints; stage versions change when the executable contract or
artifact shape changes.

### Execution scheduler

The scheduler:

- builds the graph for the selected pipeline and enabled features;
- resolves the first incomplete or stale frontier;
- runs dependency-ready stages;
- runs independent Segmented children concurrently when supported;
- opens a configured attempt window for each model step;
- commits only validated results;
- pauses on Stop or a blocking failure;
- continues independent or explicitly skippable branches;
- rejects late results after pause, supersession, or source drift;
- records enough state to restore the operation after reload.

It does not interpret story semantics. The Arbiter and model roles retain that
responsibility.

### Checkpoint store

The checkpoint store persists run manifests and stage artifacts through
logical storage keys. It is separate from the diagnostic journal.

It must support:

- atomic stage commit;
- load by chat and operation id;
- one nonterminal resumable operation per chat;
- dependency and provenance validation;
- superseding an older nonterminal operation for the same chat;
- bounded pruning through Recursion's existing storage maintenance;
- explicit purge when Recursion cache is cleared;
- privacy-safe inspection metadata without exposing artifact bodies.

Large artifacts already stored in the scene cache may be referenced by logical
key plus hash instead of duplicated.

### Progress projection

The progress model is a projection of execution state. It does not own retry,
pause, queue, or checkpoint truth.

It maps stable stage records into:

- Hero Pixel Array blocks;
- progress rows and child rows;
- one contextual row action;
- compact current-step status;
- accessible labels and touch confirmation;
- bounded warning or error explanations.

### Host adapter

The SillyTavern adapter continues to own:

- source and chat identity;
- send, swipe, generation-started, generation-ended, and generation-stopped
  events;
- native generation Stop;
- transient prompt installation and clearing;
- native quiet Post-process rewriting;
- chat mutation and final swipe/replace commit.

The execution scheduler must not import new SillyTavern globals directly.

## Run And Checkpoint Contracts

### Run manifest

The durable manifest should use one canonical V1 shape:

```js
{
  schema: "recursion.pipelineRun.v1",
  operationId: "operation-...",
  graphVersion: 1,
  phase: "preprocess", // preprocess | postprocess
  pipelineMode: "segmented", // segmented | fused
  chatKey: "...",
  sourceIdentity: {
    sourceRevisionHash: "...",
    latestMessageId: "...",
    selectedSwipeId: "...",
    characterHash: "...",
    groupHash: "..."
  },
  state: "paused", // running | paused | completed | stale | abandoned
  pauseReason: "user-stop",
  frontierStageIds: ["preprocess.cards.open-threads"],
  queuedStageIds: [],
  stageRecords: {},
  createdAt: "...",
  updatedAt: "..."
}
```

Only one manifest per chat may be nonterminal. Starting an incompatible new
operation marks the older one `abandoned` after retaining any scene-cache
artifacts that remain independently valid.

### Canonical execution states

Operation state is:

```text
running | paused | completed | stale | abandoned
```

Stage execution state is:

```text
pending | running | completed | failed | skipped | stale
```

`Cached` and `Recovered` are progress projections of a completed stage's
artifact source and attempt history, not additional execution states.
`Queued` is a separate next-generation intent. `Paused` belongs to the
operation; the active frontier row projects the operation's paused state.

When Stop, reload, or chat switching interrupts a running stage, that stage
returns to `pending` with bounded interrupted-attempt metadata. No partial
result is represented as a distinct reusable state.

### Stage checkpoint

```js
{
  schema: "recursion.stageCheckpoint.v1",
  operationId: "operation-...",
  stageId: "preprocess.arbiter",
  stageVersion: 1,
  state: "completed",
  inputHash: "...",
  outputHash: "...",
  dependencyHashes: {
    "preprocess.snapshot": "..."
  },
  provenance: {
    chatKey: "...",
    sourceRevisionHash: "...",
    pipelineMode: "segmented",
    settingsHash: "...",
    providerContractHash: "...",
    deckRevisionHash: "...",
    promptContractHash: "..."
  },
  attempts: {
    window: 1,
    limit: 2,
    used: 1,
    total: 1
  },
  artifactRef: {
    kind: "inline", // inline | logical-storage
    key: "...",
    hash: "..."
  },
  completedAt: "..."
}
```

The exact provenance fields vary by stage. A stage includes only the inputs
that can affect its output. This is what permits an unrelated settings or
parallel-branch change to leave a valid checkpoint reusable.

`attempts.window` increments when explicit Resume or Retry grants a fresh
window. `used` counts requests in that window, and `total` remains monotonic
for diagnostics and cost inspection across the operation.

### Atomic commit rule

A stage result becomes reusable only after:

1. its model or local work completes;
2. its output passes the stage validator;
3. current run ownership and source identity are rechecked;
4. the artifact and stage record commit atomically;
5. the manifest frontier advances.

Partial streaming text, partially parsed JSON, unvalidated bundle items, and
late responses after Stop do not become checkpoints.

## Dependency-Aware Reuse

A checkpoint is reusable only when all of the following match:

- stage id and stage version;
- declared source identity;
- declared settings and deck revisions;
- provider and prompt/schema contract hashes where relevant;
- every dependency output hash;
- artifact hash and storage integrity;
- the stage is not explicitly queued for reprocessing.

Reprocessing uses a dependency-aware cascade:

1. The selected stage always reruns.
2. Its old validated checkpoint remains intact until a replacement commits.
3. The new output hash is compared with the old output hash.
4. A downstream checkpoint remains reusable when all effective dependency
   hashes remain identical.
5. A changed output invalidates only dependent descendants.
6. Independent parallel siblings remain reusable.

If several stages are queued, the scheduler reduces them to a minimal set of
roots. A queued ancestor subsumes its queued descendants. Independent queued
branches remain independent.

This rule avoids both stale reuse and reflexive downstream recomputation.

## Queued Reprocessing

Reprocess is a next-generation policy, not an immediate generation command.

When the user invokes Reprocess on a completed or cached row:

- Recursion records the stable stage id in a chat-scoped queued-intent record;
- no provider or host call starts;
- the current checkpoint remains visible and usable until the next eligible
  generation consumes the intent;
- the action changes to a selected state with the tooltip
  `Cancel queued reprocess`;
- invoking it again removes the queued intent;
- a short status confirmation says `<Stage> queued for reprocessing.`;
- the next user send or swipe binds the queued intent to that operation;
- cancellation before the selected stage begins leaves the intent queued;
- beginning the selected stage consumes the intent regardless of that stage's
  eventual result;
- failure after consumption is recovered through Retry or Resume rather than
  silently queuing another future operation;
- the checkpoint selected for replacement is not admitted to that operation
  as a fallback if reprocessing fails;
- an inapplicable stage id is cleared with a bounded notice rather than mapped
  to a different stage.

The intent belongs to the chat, not to the currently open UI. Switching chats
does not transfer it. Reloading or returning to the chat restores it.

The existing full fresh-next-generation control becomes the operation-wide
form of the same mechanism. It queues a one-shot bypass for every
cache-eligible Pre-process stage needed by the next generation and uses
`Queued` terminology. Unlike dependency-aware per-stage reprocessing, full
fresh does not reuse descendants merely because a regenerated upstream hash is
unchanged. It does not immediately invoke SillyTavern generation and does not
destroy the last valid artifacts before replacements exist.

## Stop, Pause, Resume, And Retry

### Stop

Stop is operation-scoped even when invoked from a stage row.

It:

1. records cancellation intent against the active operation;
2. calls SillyTavern's native Stop path when host generation or native quiet
   rewriting is active;
3. aborts all Recursion-owned in-flight provider requests;
4. prevents responses that arrive after the stop boundary from committing;
5. clears transient Recursion prompt lanes when required;
6. waits for checkpoint writes already inside their atomic commit section;
7. persists the manifest as `paused`;
8. leaves validated checkpoints and independently persisted cache artifacts
   intact.

The unfinished request body or partial provider response is discarded. A
completed result survives only if its validated atomic checkpoint committed
before the stop boundary.

Stop does not automatically retry, skip, or resume anything.

### Resume

Resume is available on a paused operation. It:

- restores the manifest and checkpoint graph;
- captures current host identity;
- validates the frozen source and every checkpoint needed by the frontier;
- resumes only incomplete or stale stages;
- preserves valid completed and sibling stages;
- starts a fresh attempt window for a model step interrupted by Stop, reload,
  or chat switching;
- starts a fresh attempt window when Resume enters a model step that had not
  begun.

Resume never occurs automatically.

### Retry

Retry is available when a blocking model step exhausted its attempt window.
It:

- keeps the same operation and frozen source;
- starts a fresh configured attempt window for that failed stage;
- preserves all valid dependencies and independent siblings;
- invalidates descendants only if the new stage output changes;
- returns to `paused` if the fresh window is exhausted.

### Reload and chat switching

A page reload can recover only the last atomically committed frontier. Any
request that was in flight at unload is treated as unfinished.

Switching away from a chat pauses an active operation for that chat, aborts
in-flight work, and clears transient prompt state. Returning restores its
paused progress tree. It does not resume work.

Before Resume or Retry, Recursion validates:

- chat identity;
- source message existence, text hash, and selected swipe;
- active character or group;
- relevant deck and card revisions;
- relevant settings;
- provider and schema contracts;
- dependency hashes.

If the original operation can no longer be continued safely, the progress tree
marks it stale. It does not offer Resume. The earliest stage that remains
meaningful may offer Reprocess for the next generation; other stale rows have
no action.

## Attempt And Latency Policy

### No default Recursion timeout

Recursion does not impose a wall-clock deadline on Utility, Reasoner, or
SillyTavern native model work. A call may remain running until:

- the provider returns;
- the provider or host reports a terminal failure;
- SillyTavern terminates it;
- the user invokes Stop;
- the operation is superseded by an incompatible host event.

This preserves compatibility with slow local models and matches SillyTavern's
ordinary generation expectations. Recursion may display bounded elapsed-wait
metadata, but elapsed time alone never starts a retry.

Provider libraries and remote services may still enforce their own limits.
Recursion treats those returned failures as terminal attempt results; it does
not pretend to override an upstream limit.

### Automatic attempts

Add one normalized setting:

```js
modelAttemptsPerStep: 2
```

Contract:

- minimum: `1`;
- maximum: `5`;
- default: `2`;
- the value counts the initial call;
- the value applies independently to each Recursion-owned model step;
- one manual Retry creates a fresh window with the configured value.

The setting applies to Arbiter, card generation, Fused bundle generation,
guidance composition, Post-process guidance synthesis, and native quiet
Post-process rewriting. It does not automatically retry the user's primary
SillyTavern story generation.

A new model request used for structured-output correction counts as another
attempt. Deterministic parsing, extraction, validation, and normalization do
not.

The scheduler is the sole owner of Recursion-issued model retries. Role
modules, Post-process helpers, and the provider router must not hide additional
model-call loops beneath one scheduler attempt. Provider SDK transport retries
should be disabled where the adapter supports it. An unavoidable upstream
transport retry is reported as provider behavior and is never mislabeled as a
Recursion retry.

Retryable attempt outcomes include:

- transport or provider failure;
- rejected or unusable structured output;
- mismatched schema or frozen-source hash;
- required empty output;
- exact no-op when the stage contract requires a changed result;
- native quiet rewrite failure.

User Stop and source supersession do not consume another attempt and do not
trigger an automatic retry. An attempt is recorded when its model request
starts, but an explicit Resume grants the interrupted step a fresh window
because the user has chosen to continue.

There is no separate operation-wide attempt cap. The selected pipeline and
enabled stages determine the number of model steps; the user setting bounds
automatic repetition of each step.

### Exhaustion behavior

Each stage declares one failure policy:

- `pause`: required work cannot safely continue;
- `continue`: independent or optional work may fail while useful siblings
  continue;
- `fallback`: a declared alternate branch may run without repeating valid
  upstream work.

Mandatory Arbiter and required composition failures pause. Segmented card
siblings may continue independently. Progressive Post-process may continue
later categories from the latest valid draft under its existing partial-result
contract. Fused may fall back to Segmented only after its bundle produces no
useful validated item.

No deterministic semantic substitute may replace a failed Arbiter.

## Pre-process Checkpoint Graph

The canonical checkpointable flow is:

```text
preprocess.snapshot
  -> preprocess.arbiter
  -> preprocess.cards.segmented.<family>...
     OR preprocess.cards.fused
  -> preprocess.deck
  -> preprocess.hand
  -> preprocess.guidance
  -> preprocess.packet
  -> preprocess.install
```

Rules:

- Snapshot is a frozen source artifact.
- Arbiter output is validated structured data and checkpointable.
- Segmented child cards checkpoint independently.
- A Fused bundle checkpoints accepted items and the bundle summary
  independently enough to preserve valid items.
- Deck and hand stages reference the existing scene cache where practical.
- Guidance and packet artifacts are reusable only under their exact dependency
  hashes.
- Prompt installation is idempotent but host-bound; Resume revalidates host
  prompt state before deciding whether installation must run again.
- The user's primary SillyTavern generation is a host boundary, not an
  automatically retried Recursion model step.

The Arbiter may itself reuse a validated checkpoint only when its complete
semantic input fingerprint matches and it has not been queued. Runtime must not
manufacture a deterministic replacement plan after an Arbiter failure.

## Post-process Checkpoint Graph

### Unified

```text
postprocess.snapshot
  -> postprocess.unified.guidance
  -> postprocess.unified.rewrite
  -> postprocess.commit
```

### Progressive

```text
postprocess.snapshot
  -> postprocess.category.<id>.guidance
  -> postprocess.category.<id>.rewrite
  -> next enabled category
  -> postprocess.commit
```

Rules:

- The operation snapshot remains immutable.
- Validated guidance is checkpointed separately from the rewrite so a failed
  host rewrite does not repeat a successful guidance call.
- Each successful Progressive category draft becomes the validated input
  checkpoint for the next category.
- Failed Progressive categories retain the latest prior valid draft and follow
  the existing partial-result policy.
- The final chat mutation is a separate idempotent commit stage.
- Resume must prove whether the intended swipe or replacement already exists
  before mutating chat.
- A duplicated resume or repeated terminal event cannot create a second swipe
  or apply the same replacement twice.

The existing rule that Progressive intermediate drafts remain only in memory
is superseded for paused operations. Durable resume requires the latest valid
draft and any successful guidance packet needed by the unfinished frontier.

## Durable Artifact Privacy

Resume artifacts are operational state, not diagnostics.

The checkpoint store may persist the minimum content required to resume:

- validated machine-readable Arbiter output;
- validated generated cards or references to scene-cache cards;
- selected hand and prompt packet artifacts;
- validated Post-process guidance;
- the latest valid Progressive draft;
- hashes and host mutation receipts required for idempotence.

Artifact bodies must not be copied into:

- activity rows;
- ordinary diagnostics;
- run-journal summaries;
- chat markers;
- bug-report exports;
- tooltips.

Diagnostics retain only sanitized codes, hashes, counts, lanes, stage ids,
attempt counts, latencies, and state transitions.

Storage remains bounded:

- at most one nonterminal resumable operation per chat;
- a newer incompatible operation abandons the older manifest;
- terminal completion purges intermediate Post-process drafts and guidance
  after the final mutation receipt is durable;
- stale records are pruned through normal storage maintenance;
- explicit Recursion cache clearing purges resumable operation artifacts;
- scene-cache artifacts that remain valid follow the scene-cache retention
  contract rather than being duplicated in run storage.

## Progress And Interaction Contract

### One action slot

Every actionable progress row has one fixed-width 24px icon slot. There is no
secondary row expansion, safety flap, overflow action menu, or confirmation
dialog for ordinary stage actions.

| Stage condition | Action | Icon family | Result |
| --- | --- | --- | --- |
| Pending, blocked, skipped, or non-checkpointable | None | None | The row communicates state only. |
| Running operation frontier | Stop | Square | Pause the whole operation at committed checkpoints. |
| Paused operation frontier | Resume | Play | Continue from the first incomplete frontier. |
| Blocking retryable failure | Retry | Circular arrow | Start a fresh attempt window for that failed stage. |
| Completed or cached executable checkpoint | Reprocess | Circular arrow | Queue this stage for the next eligible generation. |
| Earliest meaningful stale stage | Reprocess | Circular arrow | Queue a fresh replacement path for the next eligible generation. |
| Reprocessing queued | Cancel queued reprocess | Selected circular arrow | Remove the queued intent. |

Retry and Reprocess may share a circular-arrow glyph because they both mean
"run again." Their row state, tooltip, accessible label, and resulting feedback
must distinguish them.

Only independently executable stages own actions. In Segmented, an individual
card child is executable and may own Retry or Reprocess after it settles. In
Fused, bundle-item child rows are validation outcomes from one model call, so
the Fused parent owns Stop, Retry, and Reprocess. Unified Post-process follows
the same parent-owned rule; Progressive category stages are independently
executable.

When several Segmented children run concurrently, their shared running parent
owns the visible Stop action. Running child rows remain status-only. This avoids
duplicating one operation-scoped Stop across several rows.

### Visual states

- Running remains cyan.
- Completed remains green.
- Cached remains purple.
- Retry or recovered attention remains amber.
- Failed remains red.
- Paused uses a restrained amber attention treatment because user action is
  required.
- Queuing does not recolor a valid cached or completed artifact. The row keeps
  its green or purple result color while the action gains the normal selected
  cyan treatment.

This preserves the meaning of Recursion's established purple cache color:
queued work has not destroyed or invalidated the current cached artifact.

### Labels and feedback

Canonical tooltips and accessible labels:

- `Stop and pause this operation`
- `Resume from saved checkpoint`
- `Retry this step`
- `Reprocess from here on the next generation`
- `Cancel queued reprocess`

Canonical confirmations:

- `<Stage> queued for reprocessing.`
- `Queued reprocessing canceled.`
- `Operation paused. Completed work was saved.`
- `Resuming from <Stage>.`

Desktop uses hover and focus tooltips. Keyboard users receive the same
accessible name. Touch receives immediate compact status or toast feedback.
The action never depends on hover to be understandable.

### Persistence and mobile behavior

Actions remain available while the displayed run and its provenance remain
current. A stale run exposes only its earliest meaningful Reprocess action.
Actions do not appear for only the few seconds that a call is active.

On narrow viewports:

- the action slot remains 24px;
- row labels truncate before the action slot;
- no action text is added inline;
- the existing mobile status drawer carries confirmation text;
- the progress menu never grows a second action column.

The main Recursion Bar Stop remains available during active owned work and
routes to the same operation-level pause path as the progress-row Stop.

## Cache Clearing And Fresh Work

Three concepts remain distinct:

1. **Resume** continues a paused operation from valid checkpoints.
2. **Queued Reprocess** reruns a selected stage on the next generation while
   retaining the old checkpoint until replacement.
3. **Clear Recursion Cache** explicitly removes reusable scene and resumable
   operation artifacts.

The compact stage action uses Queued Reprocess, not destructive clearing.
Global fresh-next-generation queues an operation-wide cache bypass once.
The existing Advanced `Reset Scene Cache` command remains the destructive
current-chat cleanup action. It also abandons that chat's paused operation,
deletes its resume artifacts, clears its queued reprocess intents, and clears
the installed Recursion prompt. It is not duplicated in the progress tree.

## Failure And Recovery Matrix

| Failure | Recovery |
| --- | --- |
| Arbiter call exhausts attempts | Pause at Arbiter. Preserve snapshot. Expose Retry. Do not invent a deterministic semantic plan. |
| One Segmented card exhausts attempts | Preserve completed siblings. Continue when the remaining hand is valid; otherwise pause at the missing required card. |
| Fused returns some valid items | Commit valid items. Record missing or invalid items. Do not discard siblings. |
| Fused returns no useful item | After its attempt window, fall back once to Segmented using the same Arbiter checkpoint. |
| Guidance exhausts attempts | Preserve cards, deck, and hand. Pause at guidance. |
| Prompt installation fails | Preserve the packet checkpoint, clear any partial install, warn, and let the primary SillyTavern generation continue without Recursion injection. If the operation was paused before installation settled, Resume rechecks host prompt state before attempting installation. |
| User stops during provider work | Abort in-flight calls, discard uncommitted output, persist paused frontier. |
| User stops during native host generation | Use native Stop, clear transient prompt state, retain committed Pre-process checkpoints. |
| User stops during Post-process rewrite | Abort quiet generation, keep successful guidance and prior valid draft, persist paused frontier. |
| Reload during work | Restore last committed frontier as paused. Never assume the in-flight call succeeded. |
| Chat switch during work | Pause the original chat's operation and restore it only when that chat returns. |
| Source or selected swipe changed | Mark incompatible operation stale. Never commit or resume against the changed source. |
| Duplicate terminal event or resume | Consult mutation receipt and source hash; do not create a duplicate swipe or replacement. |
| Storage write fails before checkpoint commit | The stage is not reusable. Keep the prior checkpoint and report a bounded storage failure. |

## Settings Contract

The relevant V1 settings become:

```js
{
  pipelineMode: "segmented",
  modelAttemptsPerStep: 2
}
```

UI:

- Pipeline remains an icon-only Recursion Bar selector with Segmented and
  Fused options.
- Attempts belongs in Advanced behavior settings as a compact numeric control
  labeled `Attempts per step`.
- Helper copy: `Total automatic model attempts for each Recursion step. Slow calls are not retried unless they fail.`
- Allowed values are one through five.
- There is no default latency-budget control in this implementation.

Changing either setting supersedes incompatible active work through the normal
pause/stale rules and clears transient prompt state. A compatible checkpoint
is reused only if its declared setting fingerprint remains equal.

## Diagnostics

Add bounded events or equivalent stage records for:

- operation created, paused, resumed, retried, completed, abandoned, and stale;
- stage started, attempt failed, retrying, checkpoint committed, reused,
  invalidated, and queued;
- queued reprocess added, canceled, consumed, or found inapplicable;
- checkpoint storage or integrity failure;
- Fused-to-Segmented fallback;
- resume source validation and idempotent commit detection.

Recommended stable codes:

- `operation-paused:user-stop`
- `operation-paused:chat-changed`
- `operation-stale:source-changed`
- `stage-attempt-exhausted`
- `stage-checkpoint-reused`
- `stage-checkpoint-invalidated`
- `stage-reprocess-queued`
- `stage-reprocess-canceled`
- `stage-reprocess-consumed`
- `stage-reprocess-inapplicable`
- `resume-checkpoint-restored`
- `resume-artifact-missing`
- `resume-commit-already-applied`
- `fused-fallback-segmented`

Diagnostics must not include artifact bodies, provider responses, transcript
text, intermediate drafts, raw guidance, secrets, stack traces, or physical
paths.

## Implementation Boundaries

The implementation should introduce focused modules rather than adding another
large control path to `runtime.mjs` or `post-process-runtime.mjs`.

Recommended ownership:

- `src/execution/stage-registry.mjs`: stable stage definitions.
- `src/execution/scheduler.mjs`: dependency scheduling and failure policy.
- `src/execution/attempt-policy.mjs`: attempt windows and failure
  classification.
- `src/execution/checkpoints.mjs`: manifest and checkpoint contracts.
- `src/execution/provenance.mjs`: stage input and dependency fingerprints.
- `src/execution/queued-reprocess.mjs`: chat-scoped next-generation intents.
- `src/runtime/pipelines/segmented.mjs`: renamed and adapted Standard card
  branch.
- `src/runtime/pipelines/fused.mjs`: Fused adapter to the shared stage engine.
- `src/post-process-runtime.mjs`: Post-process graph construction and host
  mutation boundaries, not a second scheduler.
- `src/progress.mjs`: projection of execution stages into visible progress.
- `src/ui.mjs`: contextual action rendering and dispatch only.
- `src/storage.mjs`: logical persistence and pruning primitives.
- `src/hosts/sillytavern/host.mjs`: source validation, native Stop, quiet
  rewrite, and idempotent mutation receipts.

Exact file boundaries may be adjusted during implementation planning when a
smaller existing module is the clearer owner. The architectural constraint is
that execution state, persistence, progress projection, and host mutation do
not remain one coupled runtime concern.

## Documentation Migration

Implementation must update current authority in place:

- `DESIGN.md`
- `docs/RECURSION_EXTENSION_SPEC.md`
- `docs/architecture/RUNTIME_ARCHITECTURE.md`
- `docs/architecture/CACHE_USE_AND_REUSE_SPEC.md`
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- `docs/architecture/POST_PROCESS_CARDS_RUNTIME.md`
- `docs/design/UI_SPEC.md`
- `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- `docs/technical/RECURSION_COST_RESEARCH.md`
- `docs/user/RECURSION_OPERATOR_MANUAL.md`
- `docs/testing/TESTING_STRATEGY.md`
- `docs/testing/LIVE_SMOKE_TEST_PLAN.md`
- current documentation indexes and release-facing pipeline descriptions

Current docs must use Segmented/Fused vocabulary and remove Rapid from current
product claims. Historical design and implementation records may remain as
history, but indexes must identify them as superseded rather than presenting
them as current authority.

## Testing Strategy

### Deterministic contract tests

Prove:

- canonical Segmented/Fused settings normalization;
- retired Standard/Rapid values normalize to Segmented without runtime aliases;
- stage graph dependency ordering;
- atomic checkpoint commit;
- late-result rejection across Stop and supersession;
- independent Segmented sibling checkpointing;
- Fused valid-sibling retention and zero-useful fallback;
- dependency-aware downstream reuse;
- queued ancestor/descendant coalescing;
- independent queued branches;
- queue persistence across reload and chat switch;
- one-through-five attempt normalization;
- two-attempt default;
- no elapsed-time-driven retry;
- correction model calls consume attempts;
- user Stop does not consume or restart an attempt;
- manual Retry receives a fresh attempt window;
- paused manifest restoration;
- source, swipe, character, group, deck, settings, provider, and contract drift
  invalidation;
- Progressive Post-process guidance and draft restoration;
- idempotent As Swipe and Replace commits;
- artifact-body exclusion from diagnostics and progress.

Use fake clocks or controllable promises to prove that Recursion does not
timeout a call. Do not make the test suite actually wait for a slow local model.

### UI tests

Prove the action matrix:

- no action for pending, blocked, skipped, stale, or non-checkpointable rows;
- Stop for the running frontier;
- Resume for paused work;
- Retry for an exhausted blocking step;
- Reprocess for completed or cached work;
- selected Reprocess action and cancel behavior while Queued;
- one fixed action slot at desktop and mobile widths;
- hover, focus, ARIA, and touch feedback;
- green and purple result colors remain visible while reprocessing is Queued;
- the main bar and row Stop call the same pause path.

### Host and live tests

Live SillyTavern proof must cover:

- a deliberately delayed provider call that remains active until manually
  stopped;
- Stop during Pre-process, followed by Resume without repeating completed
  calls;
- reload and return to the same chat, followed by Resume;
- switch to another chat and back, without cross-chat state leakage;
- Segmented parallel cards with one failed child and preserved siblings;
- Fused bundle failure falling back to Segmented without repeating Arbiter;
- queued stage reprocessing consumed by the next send or swipe;
- unchanged regenerated output preserving downstream checkpoints;
- changed regenerated output recomputing only descendants;
- Stop during Progressive Post-process and resume from the latest valid draft;
- final swipe or replacement committed exactly once;
- served-extension files matching the tested source.

Broad verification remains `npm.cmd test`, the alpha gate, whitespace checks,
and the repo's live installed-copy proof.

## Rollout Order

Implementation planning should preserve a working extension through these
vertical slices:

1. Add stage, manifest, checkpoint, provenance, and attempt-policy contracts
   behind deterministic tests.
2. Adapt Pre-process Segmented execution and rename Standard.
3. Adapt Fused execution and fallback.
4. Add durable Stop, pause, Resume, Retry, and reload/chat restoration.
5. Adapt Post-process guidance, rewrite, intermediate draft, and idempotent
   commit stages.
6. Add queued per-stage reprocessing and global fresh-next integration.
7. Add contextual progress-row controls and mobile/accessibility behavior.
8. Remove Rapid and reconcile settings, caches, diagnostics, tests, and docs.
9. Run complete deterministic, live host, installed-copy, and documentation
   verification.

Rapid removal should occur only after Segmented and Fused use the shared
execution engine, so the extension retains a functioning pipeline throughout
the refactor.

## Acceptance Criteria

- The Utility Arbiter remains a required model-owned semantic stage.
- No Recursion-owned model call has a default wall-clock timeout.
- `modelAttemptsPerStep` defaults to two and accepts one through five.
- Exhausted blocking work pauses instead of discarding committed progress.
- Stop preserves every checkpoint committed before its cancellation boundary.
- Resume repeats no valid completed stage.
- A paused operation survives page reload and chat switching without
  auto-resuming.
- Stale source or dependency state cannot be resumed or committed.
- Segmented card children checkpoint independently.
- Fused keeps valid items and can fall back to Segmented without repeating the
  Arbiter.
- Progressive Post-process can resume from its latest valid draft.
- Final chat mutation is idempotent.
- Completed or cached rows expose Reprocess persistently while current.
- Reprocess queues work for the next user-initiated generation.
- Queued work is reversible and uses the canonical term `Queued`.
- Dependency-equal descendants remain reusable after reprocessing.
- Unrelated parallel siblings are never invalidated by association.
- Every actionable row shows at most one contextual icon action.
- Mobile progress retains one fixed action slot and accessible feedback.
- Current product surfaces expose only Segmented and Fused.
- Current documentation contains no active Rapid product claim.
- Diagnostics and progress expose no raw checkpoint artifact content.
