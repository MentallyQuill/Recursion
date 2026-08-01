# Turn-Scoped Reuse And Host-Owned Resume Design

**Status:** Approved behavior; written specification review pending

**Date:** 2026-08-01

**Feature owner:** Recursion

**Breaking V1 changes:** Replace long-lived generated scene-card reuse with
exact turn-scoped reuse, make queued Reprocess swipe-only, and route paused
Resume through SillyTavern native generation

## Purpose

Recursion's resumable pipeline currently treats a compatible completed or
paused manifest as reusable whenever its broad provenance still matches. This
created two live failures in SillyTavern `default-user`:

- stopping `Planning Card Pass` paused Recursion without preserving native
  SillyTavern generation ownership, so SillyTavern could continue without a
  Recursion prompt and manual Resume ran while the native Send control looked
  idle;
- a completed operation could be accepted again by a later generation attempt,
  causing Recursion to skip a new Planning Card Pass and go directly to native
  SillyTavern generation.

The broader cache contract also relied on generated scene cards surviving
across user turns until a semantic refresh decision declared them stale. A
roleplay scene has no authoritative lifetime signal in SillyTavern. A model or
heuristic controller can recognize a transition late, allowing stale location,
cast, object, pressure, or continuity artifacts to leak into the next scene.

This design replaces inferred scene lifetime with an exact turn identity:

- unchanged swipes and retries within one turn can reuse all validated work;
- a new user message always starts a new Pre-process operation;
- generated cards, checkpoints, hand, guidance, and packet never cross that
  user-turn boundary;
- persistent deck definitions and user settings remain global configuration,
  not generated reasoning cache;
- Stop and Resume always re-enter through SillyTavern's native generation
  lifecycle when the operation belongs to a host generation.

The result is a deliberately simple V1 rule: **generated reasoning is reusable
only for the exact same turn source.**

## Design Drivers

1. A swipe asks SillyTavern for another roll from the same Recursion work when
   the configured source band has not changed.
2. A newly sent user message is a new turn even when its text happens to match
   an older message.
3. Editing any message inside the configured source band invalidates same-turn
   reuse.
4. Generated card artifacts must not rely on a semantic scene-change
   controller for refresh timing.
5. `Reprocess from Here` is declarative. It changes the next swipe and never
   starts provider or host generation at click time.
6. Full Fresh is the root-level version of queued swipe reprocessing.
7. Stop during host-owned work must stop both Recursion and SillyTavern.
8. Resume must not run Recursion as detached background work while SillyTavern
   appears idle.
9. Recursion is pre-alpha. Retired cross-turn cache shapes are replaced in
   place rather than preserved through compatibility shims.

## Goals

- Make exact same-turn swipe reuse a zero-model-call path when no reprocess
  intent is queued.
- Guarantee that each new user message runs a new Utility Arbiter plan and any
  card stages it requests; no generated-card result from an older turn can
  satisfy the new turn.
- Remove semantic scene-lifetime inference from cache eligibility.
- Preserve committed checkpoints across Stop, reload, and explicit Resume for
  the same turn.
- Make progress-tree Reprocess predictable and source-bound.
- Keep SillyTavern's native generation state, Send/Stop controls, transcript
  mutation, and Post-process lifecycle authoritative.
- Fail closed when source identity, storage, or host-generation seams are
  unavailable.

## Non-Goals

- Reusing generated cards across adjacent user turns.
- Guessing whether two user turns belong to the same narrative scene.
- Adding a turn-count TTL, wall-clock TTL, or model-owned scene cache lease.
- Automatically starting a generation when Reprocess or Full Fresh is clicked.
- Automatically restarting a generation after Stop.
- Treating Last Brief as reusable pipeline input.
- Preserving old scene-cache records or compatibility aliases.
- Changing persistent custom deck definitions, card definitions, or user
  settings into turn-scoped data.

## Product Vocabulary

| Term | Meaning |
| --- | --- |
| Source band | The configured bounded set of visible messages Recursion scans for the current turn. |
| Turn source | The source band plus the pending or committed user message that asks for the next assistant response. |
| Turn key | A deterministic identity for one turn source and all contracts that affect generated Recursion work. |
| Same-turn reroll | A SillyTavern swipe or equivalent retry whose turn key is unchanged. |
| New user turn | A committed or pending user message with a new message identity, producing a new turn key. |
| Turn cache | Generated cards, checkpoints, hand, guidance, packet, and install evidence eligible only for one turn key. |
| Persistent configuration | Custom decks, card definitions, settings, provider selections, and UI preferences. |
| Reprocess intent | A one-shot, source-bound stage invalidation consumed by the next matching swipe. |
| Full Fresh intent | A one-shot, source-bound invalidation of all generated Recursion work for the next matching swipe. |
| Host-owned operation | A Recursion operation running inside a SillyTavern native generation interceptor. |

`Scene cache` is no longer canonical vocabulary for generated model artifacts.
The UI may continue to describe the current generated card collection as a
deck, but its reuse authority is the turn key, not an inferred scene lifetime.

## Turn Identity

### Turn key inputs

The turn key is content-addressed from:

- chat identity;
- the configured scan-band size and the exact ordered visible messages inside
  that band;
- message ids, roles, selected swipe ids, and active text hashes;
- the pending or committed user message id and text hash;
- active character and group identity;
- pipeline mode and model-attempt settings;
- active Pre-process deck and card-eligibility revision;
- provider configuration and provider-contract hashes;
- prompt, card, checkpoint, and packet schema versions.

Message identity is part of the key. Sending the same text twice still creates
two turns.

### Swipe basis

For a latest-assistant swipe, the assistant response being replaced is not part
of the Pre-process turn source. Recursion reconstructs the source immediately
before that assistant response, including its originating user message. All
swipes for that assistant turn therefore share one turn key unless an earlier
message in the configured band changes.

Each generated assistant swipe receives its own Post-process response identity.
Post-process artifacts never cross response identities even when the
Pre-process turn key is shared.

### Edits and configuration changes

An edit inside the configured scan band changes the turn key. An edit outside
the band does not affect that turn's reuse decision. Changing the scan-band
setting, character/group, deck, provider, pipeline, or prompt contract also
changes the key.

Runtime compares exact identity and contract values. It does not ask a model or
heuristic whether the narrative scene is still semantically similar.

## Cache Ownership

### Same-turn reuse

An unchanged same-turn swipe with no queued intent may reuse:

- the completed operation manifest;
- validated stage checkpoints and artifacts;
- generated cards and turn deck;
- selected hand;
- guidance and prompt packet;
- prepared prompt-install evidence.

The preferred path reinstalls the prepared packet and hand without Utility,
Reasoner, Segmented, or Fused model calls. SillyTavern then generates the new
assistant swipe using its active preset and normal host context. Post-process
runs against the new assistant response when enabled.

### New user turn

At the first authoritative observation of a new pending or committed user
message, runtime must atomically make the previous turn ineligible before any
new provider work begins:

1. supersede or abandon the previous operation;
2. clear the prepared generation artifact, hand, guidance, and packet;
3. clear installed Recursion prompt lanes from the previous turn;
4. invalidate all generated card and checkpoint reuse from the previous turn;
5. cancel queued Reprocess and Full Fresh intents bound to the previous turn;
6. start a new snapshot and Utility Arbiter operation for the new turn key.

Artifact-body deletion may finish through bounded storage cleanup after
eligibility has been revoked. A deletion failure may produce a storage warning,
but it must never make old artifacts eligible again.

Persistent custom deck/card definitions and settings remain available. They are
configuration used to generate the new turn, not cached model output.

### Last Brief

Last Brief may continue to display the most recently committed hand and packet
summary for operator inspection. Once a new turn begins, that display data is
historical and cannot be read as a generation checkpoint, card candidate,
prompt packet, or fallback input.

### Reload and reopen

A reload or chat reopen may restore running or paused work only when its turn
key still exactly matches the active turn source. The normal reload conversion
from `running` to `paused` remains. A mismatched operation becomes stale or
abandoned and exposes no Resume action.

## Generation Classification

Every non-quiet SillyTavern generation is classified before pipeline reuse:

| Classification | Required behavior |
| --- | --- |
| New user turn | Revoke prior turn cache and start a new operation. |
| Unchanged latest-assistant swipe | Reuse the prepared turn result unless a queued intent requires reprocessing. |
| Edited-band swipe | Reject reuse, cancel queued intent, and start a new operation for the changed source. |
| Compatible paused same turn | Resume the saved operation inside the active host generation. |
| Incompatible paused operation | Mark stale/abandoned and start a new operation when the host request is otherwise valid. |
| Quiet/internal generation | Bypass Pre-process interception under the existing host contract. |

Empty assistant placeholders must not hide a preceding pending user message.
Payload normalization skips suppressed or empty non-user placeholders while
finding the authoritative pending user input.

## Reprocess From Here

### Click behavior

An eligible completed, cached, or stale progress owner exposes the canonical
action:

`Reprocess from here on the next swipe`

Clicking it:

- starts no provider call;
- installs no prompt;
- starts no SillyTavern generation;
- stores a chat-, phase-, turn-, and stage-bound one-shot intent;
- changes the row to the queued state;
- exposes `Cancel queued reprocess` as the row action.

The intent records the selected executable owner. Dependency normalization
includes its descendants and collapses redundant descendants when an ancestor
is selected. Pre-process and Post-process selections remain phase-scoped.

### Swipe consumption

On the next unchanged swipe:

1. validate the bound turn key and all current contracts;
2. invalidate the selected stage and dependency descendants;
3. preserve validated ancestors and unrelated sibling checkpoints;
4. rerun from the earliest invalid executable frontier;
5. install the resulting prompt packet;
6. allow the same native SillyTavern swipe to continue;
7. run Post-process against the new assistant response when enabled;
8. consume the intent once.

A Post-process selection remains queued until the newly generated assistant
response establishes its response identity. Source-bound Post-process
dependencies are always rebuilt for that new response; no prior response body
or rewrite crosses the response boundary.

### Cancellation

The intent is canceled without provider work when:

- the user clicks its cancel action;
- a new user message starts a new turn;
- any message inside the configured source band changes;
- the active character/group, deck, provider, pipeline, or prompt contract
  changes;
- the selected stage no longer exists in the active graph.

Source-change cancellation is neutral, not a provider failure. Diagnostics
retain a bounded lifecycle code explaining why the intent was not consumed.

## Full Fresh

Full Fresh becomes the root-level form of queued swipe reprocessing.

Canonical idle action:

`Rebuild all Recursion work on the next swipe`

It is bound to the current turn key, starts no work on click, and makes the next
unchanged swipe bypass all prepared, checkpoint, generated-card, hand,
guidance, packet, and prompt-install reuse for that turn. A second click
cancels it.

A new user message cancels the intent because every new user turn is already
fresh by contract. Full Fresh no longer claims to affect the next send.

## Stop And Resume

### Unified Stop

The contextual Stop action for a host-owned Pre-process or Post-process
operation routes through the unified runtime stop path:

1. pause the durable operation and preserve committed checkpoints;
2. abort the active provider or quiet-writer call;
3. request SillyTavern native generation Stop;
4. clear Recursion-owned prompt lanes;
5. cancel pending Post-process work;
6. settle the visible operation as paused/canceled without marking it failed.

The UI click and SillyTavern `GENERATION_STOPPED` event may both arrive.
Runtime collapses them onto one cleanup promise, one prompt clear, and one
journaled stop request.

Standalone Recursion maintenance operations that are not attached to host
generation may use scheduler pause without claiming that SillyTavern was
stopped.

### Resume ownership

A host-owned paused manifest stores safe metadata for its originating native
generation type: `normal`, `swipe`, or `regenerate`.

Clicking the progress-row Resume action does not call the scheduler directly.
It asks the host adapter to start the stored SillyTavern native generation
type. The normal generation interceptor then:

- validates the same turn key;
- claims the paused operation;
- resumes its earliest incomplete frontier;
- keeps SillyTavern's native Send/Stop controls and generation state active;
- installs the prompt before native prose generation continues;
- runs Post-process normally after the assistant response lands.

If the user activates SillyTavern's native generation control instead of the
Recursion Resume button, the interceptor follows the same compatible-resume
path.

Stop never automatically restarts generation. Resume and native host
generation are explicit user actions.

### Resume failure

If SillyTavern native generation cannot start:

- leave the manifest paused;
- run no provider calls;
- install no prompt;
- show a readable warning on the paused frontier;
- retain a bounded diagnostic code.

If Resume discovers source or contract drift, mark the operation stale and do
not start detached work. The user may swipe or send through SillyTavern to
start the appropriate current operation.

## Component Boundaries

### Extension interceptor

- Normalize pending user input without being fooled by empty assistant
  placeholders.
- Classify new turn, same-turn swipe, and compatible resume before invoking the
  runtime.
- Keep quiet/internal generation bypass unchanged.

### Runtime

- Compute the turn key and own turn-boundary invalidation.
- Separate public host-owned Resume from internal scheduler continuation.
- Bind and consume Reprocess/Full Fresh only on matching swipes.
- Expose sanitized turn and queued-intent state to the UI.

### Execution scheduler

- Continue to validate stage inputs, dependencies, provenance, artifacts, and
  execution tokens.
- Treat the turn key as mandatory provenance for generated Pre-process work.
- Remain unaware of SillyTavern UI controls; host ownership stays in runtime.

### SillyTavern host adapter

- Keep `generation.stop()` as the native stop seam.
- Use `generation.start()` for Resume with the validated native generation
  type.
- Report unavailable or failed starts without mutating scheduler state.

### Storage

- Store turn-key provenance on manifests, checkpoints, artifacts, and queued
  intents.
- Remove cross-turn generated-card reuse authority.
- Prune prior-turn artifact bodies after they become ineligible.
- Preserve only bounded journal/diagnostic metadata needed to explain lifecycle
  decisions.

### UI

- Keep one compact contextual action slot per row.
- Route host-owned Stop through the unified stop action.
- Route Resume through native host generation.
- Replace next-generation Reprocess wording with next-swipe wording.
- Treat Full Fresh as a queued whole-turn rebuild for the next swipe.
- Preserve SillyTavern-native compact graphite styling and existing icon
  vocabulary.

## Storage And Migration

This is a pre-alpha contract replacement:

- existing generated scene-cache records are not migrated into turn caches;
- normalization rejects them as reuse authority;
- repair/retention removes retired generated artifact bodies;
- persistent deck definitions, card definitions, and settings remain;
- schemas, examples, fixtures, diagnostics, and docs update in place;
- no legacy compatibility shim or fallback reads old generated scene caches.

The storage schema must distinguish reusable turn artifacts from historical
Last Brief display metadata so UI inspection cannot accidentally restore old
generation input.

## Diagnostics

Allowlisted lifecycle evidence includes:

- turn-key hash, never raw message text;
- source-band size and first/last message ids;
- generation classification;
- operation id, phase, state, and native generation type;
- queued Reprocess/Full Fresh stage ids and bound turn-key hash;
- checkpoint reuse and invalidation counts;
- stable reasons such as `new-user-turn`, `same-turn-swipe`,
  `source-band-edited`, `queued-reprocess-consumed`,
  `queued-reprocess-canceled-new-turn`, `operation-paused-user-stop`, and
  `host-resume-start-failed`.

Diagnostics must not persist raw transcript text, provider output, generated
card bodies, hand/packet bodies, hidden reasoning, keys, or stack traces.

## Failure Handling

- Turn-boundary cleanup failure: revoke eligibility first, continue the new
  operation, and surface a bounded storage warning.
- Missing or invalid same-turn artifact: reject reuse and recompute from the
  earliest invalid stage.
- Host Stop unavailable: pause and abort Recursion, clear prompts, report that
  SillyTavern could not be stopped, and never claim success.
- Host Resume start unavailable: remain paused and run no pipeline work.
- Queued intent becomes inapplicable: cancel it neutrally and continue the
  normal swipe path.
- Late provider completion after Stop or turn change: fail current-operation
  ownership checks and commit nothing.
- Post-process source changes: cancel stale work and preserve the selected
  native assistant response.

## Verification Strategy

### Deterministic tests

1. **Writer Stop regression**
   - begin host-owned Planning Card Pass;
   - activate the contextual Stop;
   - assert one scheduler pause, one provider abort, one native host stop, one
     prompt clear, and a paused manifest;
   - assert no late packet or card commit.

2. **Writer Resume regression**
   - Resume the paused operation;
   - assert native `generation.start()` is called once with the stored type;
   - assert the generation interceptor resumes the same operation;
   - assert committed checkpoints are reused;
   - assert no provider call starts before native generation ownership exists.

3. **SG-1 same-turn swipe reuse**
   - complete one turn;
   - swipe without editing the configured band;
   - assert Utility, Reasoner, Segmented, and Fused call counts stay unchanged;
   - assert the prepared packet is reinstalled and native swipe continues.

4. **New user turn isolation**
   - submit a new user message, including text identical to a prior message;
   - assert a new turn key and operation id;
   - assert the Utility Arbiter and requested card pipeline run;
   - assert no generated card, hand, guidance, packet, or checkpoint from the
     prior turn is accepted.

5. **Source-band edit invalidation**
   - edit each boundary case inside and outside the configured band;
   - assert inside-band edits invalidate reuse and queued intent;
   - assert outside-band edits do not alter the exact current turn key.

6. **Queued Reprocess**
   - select a completed Pre-process stage;
   - assert no calls occur on click;
   - swipe and assert the selected stage plus descendants rerun while valid
     ancestors/siblings remain reused;
   - assert one-shot consumption.

7. **Queued cancellation**
   - queue stage and Full Fresh intents;
   - assert explicit cancel works;
   - assert new user input, band edit, and contract drift cancel them without
     provider work.

8. **Full Fresh swipe**
   - queue Full Fresh on a completed turn;
   - assert the next unchanged swipe reruns all generated Recursion work;
   - assert the following unchanged swipe returns to exact prepared reuse.

9. **Reload recovery**
   - reload a paused same-turn operation;
   - assert it restores paused and Resume uses native host generation;
   - change the turn key and assert Resume becomes unavailable.

10. **Empty assistant placeholder**
    - place an empty assistant placeholder after the authoritative pending user
      row;
    - assert the interceptor still classifies the new user turn correctly.

11. **Post-process lifecycle**
    - verify resumed and reprocessed swipes run configured Post-process exactly
      once against the new response identity;
    - assert old response artifacts never cross.

### Live SillyTavern proof

Use a dedicated Recursion soak profile for automated mutation and preserve
`default-user` for human testing. The live proof must demonstrate:

- native Send/Stop controls show generation ownership throughout Resume;
- contextual Stop halts both Recursion and SillyTavern;
- same-turn swipe reuse makes zero Recursion model calls;
- queued Reprocess waits for and is consumed by the next swipe;
- a new user message visibly starts Planning Card Pass again;
- Post-process runs once when enabled;
- installed, served, and source extension files match before judging behavior.

Inspect the resulting chat transcript, run journal, turn manifest, and artifact
inventory rather than relying only on DOM status.

## Acceptance Criteria

- The Writer Stop/Resume sequence cannot produce detached Recursion work.
- SillyTavern generation controls remain authoritative during Resume.
- The SG-1 second-generation regression is covered by exact classification
  tests for swipe and new user input.
- An unchanged swipe reuses the complete prepared turn with zero model calls.
- A new user message always runs a new Arbiter and any card stages it requests;
  no prior generated-card result satisfies the turn.
- No generated card or checkpoint is reused across user turns.
- No scene-change classifier, TTL, or heuristic lease participates in cache
  eligibility.
- Reprocess and Full Fresh start no work on click and affect only the next
  matching swipe.
- Edits inside the configured band invalidate reuse and queued intents.
- Stop cleanup is idempotent and late work cannot commit.
- Resume failures leave the operation paused and readable.
- Code, schemas, docs, tests, fixtures, examples, installed-copy verification,
  and live SillyTavern proof agree on the same contract.
