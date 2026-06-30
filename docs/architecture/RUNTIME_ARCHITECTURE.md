# Runtime Architecture

Recursion is a mostly automatic runtime layer for compiling current-scene writing context into a compact prompt packet for the next SillyTavern generation. It observes the active chat, uses the Utility Arbiter to decide what work is worth doing, updates a bounded scene card cache, selects a turn hand, optionally runs a Composer or Reasoner pass, installs prompt guidance, and records diagnostics.

Recursion should stay host-adapter based. SillyTavern is the first host, but runtime internals should remain host-neutral where that keeps the model, cache, and prompt-planning logic clean.

Related specs:

- Product scope: [RECURSION_PRODUCT_SCOPE.md](../design/RECURSION_PRODUCT_SCOPE.md)
- Card system: [CARD_SYSTEM_SPEC.md](../design/CARD_SYSTEM_SPEC.md)
- Provider and generation: [PROVIDER_AND_GENERATION_SPEC.md](PROVIDER_AND_GENERATION_SPEC.md)
- Prompt composition: [PROMPT_COMPOSITION_SPEC.md](PROMPT_COMPOSITION_SPEC.md)
- Storage and diagnostics: [STORAGE_AND_DIAGNOSTICS.md](STORAGE_AND_DIAGNOSTICS.md)
- Implementation plan: [IMPLEMENTATION_PLAN.md](../testing/IMPLEMENTATION_PLAN.md)

## System Boundary

Recursion owns the short-lived runtime loop that improves the next model response. It does not own durable story truth, campaign saves, transcript branching, player state, long-term memory, vector recall, World Info, or Summaryception-style history compression.

The runtime boundary is:

- Inbound: host chat state, current user message, generation lifecycle events, extension settings, provider availability, and stored Recursion cache metadata.
- Internal: turn snapshots, Utility Arbiter decisions, card job scheduling, scene cache maintenance, turn hand selection, prompt packet composition, and diagnostics.
- Outbound: prompt injection instructions, inspector/status data, bounded diagnostics, and storage writes for settings/cache metadata.

Pre-alpha status allows Recursion to replace internal schemas and cache layouts in place when the V1 shape improves. It should still keep explicit contracts between host adapters, runtime orchestration, provider calls, storage, and prompt injection so changes do not spread through the whole extension.

Recursion should not import Directive's campaign save engine, accepted-state model, state-delta journal, or branch mechanics. The useful lesson from Directive is runtime discipline: structured calls, clean provider lanes, prompt packet install/clear behavior, bounded diagnostics, and fail-soft orchestration.

## Component Map

```mermaid
flowchart TD
    Host["Host Adapter\nSillyTavern first"] --> Snapshot["Turn Snapshot"]
    Snapshot --> Arbiter["Utility Arbiter"]
    Arbiter --> Plan["Auto Control Plan"]
    Plan --> Jobs["Card Jobs\ncreate refresh stow discard select"]
    Jobs --> Cache["Scene Card Cache"]
    Cache --> Hand["Turn Hand"]
    Hand --> Composer["Composer / Reasoner\noptional"]
    Composer --> Packet["Prompt Packet"]
    Hand --> Packet
    Packet --> Inject["Host Prompt Injection"]
    Inject --> Diag["Diagnostics"]
    Diag --> Activity["Activity Reporter\nbar ribbon viewer"]
    Arbiter --> Diag
    Jobs --> Diag
    Cache --> Store["Storage"]
    Diag --> Store
```

Primary components:

- Host Adapter: translates host-specific chat, generation, prompt, storage, and UI events into Recursion interfaces.
- Runtime Coordinator: owns extension mode, lifecycle hooks, turn processing locks, cancellation, and sequencing.
- Snapshot Builder: captures a stable observe-time view of the active chat and pending turn.
- Utility Arbiter: returns an Auto Control Plan for cadence, scene sensitivity, prompt footprint, focus profile, lane selection, and Reasoner trigger reasons.
- Card Job Runner: executes the plan by creating, refreshing, stowing, discarding, and selecting scene cards according to Arbiter decisions.
- Scene Cache: stores bounded, per-chat and per-scene card state plus fingerprints and prompt-plan metadata.
- Hand Selector: selects the small card set that should influence the next generation.
- Composer: deterministic prompt assembly and optional model-mediated synthesis.
- Reasoner: optional deeper synthesis lane that is never required for generation to continue.
- Prompt Injector: installs, updates, and clears host prompt entries through the adapter.
- Diagnostics Recorder: records structured, sanitized runtime events for the status and inspector surfaces.
- Activity Reporter: aggregates runtime, provider, storage, and prompt events into concise user-visible phases for the Recursion Bar, Activity Ribbon, and Full Viewer.

## Turn Pipeline

The core pipeline is:

1. Observe chat and turn snapshot.
2. Run Utility Arbiter.
3. Execute card jobs and cache updates.
4. Select turn hand.
5. Optionally run Composer or Reasoner.
6. Build prompt packet.
7. Install through SillyTavern injection.
8. Emit user-visible activity updates for status, fallbacks, and prompt readiness.
9. Record diagnostics.

Mode controls change how much of the pipeline runs:

- Off: remove or avoid installing Recursion prompt entries. The runtime may keep minimal UI/provider status, but it should not inspect or influence active generations.
- Observe: build snapshots, run safe diagnostics, and optionally preview decisions. It must not inject prompt packets.
- Auto: run the full automatic pipeline and install prompt packets when the Auto Control Plan says a pass is useful.

The Runtime Coordinator should serialize work per chat/generation attempt. A newer turn snapshot supersedes older pending work. If a late provider result arrives after the active snapshot changed, the result is discarded or recorded as stale and must not overwrite the current prompt packet.

The injection point should be as close as practical to host generation start, after the snapshot and prompt packet are valid. If Recursion cannot complete optional work before generation, it should reuse a valid cache-backed packet or continue without injection rather than block the host indefinitely.

## Auto Control Plan

The Utility Arbiter returns an Auto Control Plan. Runtime code treats this as advice that must pass schema validation and safety limits before use.

Required control fields:

- `cadence`: one of `skip`, `light_pass`, `full_card_pass`, or `scene_refresh`.
- `sceneSensitivity`: one of `same_scene`, `soft_shift`, `hard_shift`, or `uncertain`.
- `promptFootprint`: requested size class and token budget for the next prompt packet.
- `focusProfile`: prioritized focus areas such as continuity risk, active cast, emotional posture, prose texture, dialogue cues, or open threads.
- `preprocessorLane`: provider lane or local path for card extraction and refresh jobs.
- `composerLane`: deterministic composer, Utility synthesis, or Reasoner synthesis.
- `reasonerTriggerReasons`: bounded reasons that justify an optional Reasoner pass.

The plan may also include omission priorities, cache invalidation hints, card lifecycle suggestions, and diagnostics labels. It must not include hidden plot plans, chain-of-thought, durable canon updates, or host-specific prompt instructions that bypass the Prompt Composer.

Runtime enforcement:

- Invalid plans fall back to `light_pass` or `skip`, depending on mode and cache state.
- Token and card count caps are enforced after the Arbiter returns.
- Provider lane choices are resolved through the provider spec, not trusted as raw endpoints.
- Reasoner triggers are advisory. If Reasoner is off, unavailable, too slow, or over budget, generation continues through the deterministic or Utility composer path.

## Job Cadence

Cadence controls runtime cost and cache churn.

`skip` means no new provider work for this turn. Auto mode may still install a valid existing packet if it is current for the scene and settings.

`light_pass` means update volatile turn-level facts and ask the Arbiter to review existing cards for the current hand. It should be the common path during a stable scene. It may add small cards for newly introduced immediate facts, but it should avoid broad scene reconstruction.

`full_card_pass` means run the full scene card job set against the current snapshot. It can create, refresh, stow, discard, and select cards, then build a new hand. It is appropriate when the cache is missing, stale, or materially incomplete.

`scene_refresh` means the current scene identity or frame is no longer trustworthy. The runtime should start a new scene cache segment or hard-invalidate the old one, depending on storage policy. A refresh should rebuild scene frame, active cast, continuity risks, open threads, and prompt plan metadata from the current snapshot.

Cadence should be automatic by default. User controls should stay high level, such as Off/Observe/Auto, refresh, intensity, provider setup, and optional Reasoner enablement.

## Scene Shift Handling

Scene sensitivity is the Arbiter's view of how much the active scene changed:

- `same_scene`: continue using the existing scene cache. Prefer `skip` or `light_pass`.
- `soft_shift`: keep the scene lineage but refresh affected cards. Examples include a new immediate objective, changed emotional posture, or a character entering the scene.
- `hard_shift`: begin a new scene cache segment and avoid carrying stale scene-frame cards forward. Examples include a location jump, time jump, cast reset, or clear narrative break.
- `uncertain`: use conservative behavior. Prefer a bounded validation pass, lower prompt footprint, and visible diagnostics rather than aggressive cache reuse or hard deletion.

Hard shifts should not erase useful diagnostics or previous bounded cache history, but they should prevent stale cards from entering the next turn hand. Soft shifts should preserve continuity risks and open threads only when they still apply to the visible scene.

When local heuristics and model judgment disagree, runtime safety wins. The runtime may ask the Utility Arbiter for a scene validation pass, but it should not install contradictory scene guidance while uncertainty is unresolved.

## Failure Modes

Recursion must be fail-soft. Provider, schema, storage, and injection failures should not corrupt prompt state or prevent normal SillyTavern generation.

Expected failure behavior:

- Utility provider unavailable: skip new Arbiter work, reuse a valid packet if safe, or clear Recursion injection and continue.
- Arbiter schema invalid: reject the plan, record diagnostics, and fall back to a conservative local cadence.
- Card job failure: keep the last valid cache segment, omit failed cards from the hand, and record omission reasons.
- Reasoner failure: continue with deterministic or Utility-composed prompt packets.
- Prompt composition over budget: trim by lane priority and record budget omissions.
- Injection failure: clear or leave untouched according to host adapter safety rules, then record the failed install attempt.
- Storage failure: keep in-memory runtime state for the current turn if possible, disable persistence-dependent reuse, and continue generation.
- Stale async result: record as stale and do not apply it to cache or prompt injection.

No failure path should write partial prompt packets that mix old and new scene identities. Prompt packet installation should be atomic from Recursion's perspective: either the adapter confirms the current packet metadata, or runtime treats the install as failed.

## Activity Reporting

Recursion must make invisible work visible without turning the UI into a log console. The Runtime Coordinator should expose one Activity Reporter interface that receives normalized events from the Arbiter, card jobs, provider router, cache repository, composer, prompt injector, and storage layer.

Recommended event shape:

```ts
type RecursionActivityEvent = {
  runId: string;
  phase: string;
  mode: "foreground" | "background" | "review";
  severity: "info" | "success" | "warning" | "error";
  label: string;
  detail?: string;
  chips?: string[];
  providerLane?: "utility" | "reasoner";
  composerLane?: "utility" | "reasoner" | "local";
  cardCounts?: {
    requested?: number;
    accepted?: number;
    omitted?: number;
    selected?: number;
  };
  fallbackReason?: string;
};
```

The Activity Reporter is not a persistence boundary by itself. It is a user-facing aggregation boundary:

- many internal events become one visible stage;
- foreground, background, and review activity render differently;
- stale run ids cannot update the current ribbon after a newer run starts;
- slow work reveals after a short delay, while quick no-op work may only update the bar chip;
- success settles briefly, while warning and error states persist until dismissed or superseded;
- activity text is friendly and bounded, while detailed sanitized records belong in the run journal.

Core activity phases should cover:

- snapshot capture and scene-shift review;
- Utility Arbiter planning;
- cache reuse, scene refresh, and card batch execution;
- hand selection;
- Utility and Reasoner composition;
- prompt packet build, install, skip, and clear;
- storage save, repair, and prune stages;
- retry, fallback, stale-result discard, and provider issue states.

Activity text must not expose raw provider prompts, raw provider responses, full transcript text, hidden reasoning, private story plans, physical file paths, or unbounded error text.

## Runtime State

Runtime state should be minimal, bounded, and inspectable.

In memory:

- active mode: Off, Observe, or Auto;
- active host and chat identifiers;
- current turn snapshot id and message fingerprint;
- scene fingerprint and scene sensitivity;
- active Auto Control Plan;
- pending run lock and cancellation marker;
- provider health and resolved lane status;
- last prompt packet metadata;
- last diagnostics summary.

Persisted:

- extension settings;
- provider settings without session-only secrets;
- bounded scene card cache;
- prompt plan/cache metadata;
- last successful prompt packet metadata;
- bounded diagnostics/run journal.

Runtime state should not store hidden chain-of-thought, direct endpoint API keys, durable story canon, branch history, or campaign state deltas. If state is expensive to validate or no longer matches the active chat fingerprint, the runtime should prefer refreshing it over building compatibility layers.

## Host Adapter Responsibilities

The host adapter hides SillyTavern-specific APIs behind stable Recursion interfaces.

Responsibilities:

- Observe active chat identity, messages, current character/group context, and generation lifecycle events.
- Build host-neutral turn snapshots with stable message ids or fingerprints.
- Read host prompt environment only as needed to avoid conflicts and understand available insertion points.
- Install, update, and clear Recursion prompt packets with metadata that lets the runtime detect stale entries.
- Expose host generation/provider options needed by Utility and Reasoner lanes.
- Provide storage primitives for settings, cache, and diagnostics through Recursion's logical keys.
- Report UI events such as mode changes, manual refresh, inspector open, and settings updates.
- Surface adapter errors as diagnostics without throwing host-specific failures through the runtime.

The SillyTavern adapter may use host-specific prompt APIs, extension settings, and event hooks. The rest of Recursion should depend on adapter contracts rather than importing SillyTavern globals directly.

## Diagnostics Events

Diagnostics should explain what Recursion did without storing sensitive provider payloads or hidden reasoning.

Core event types:

- `runtime.mode_changed`: Off, Observe, or Auto changed.
- `turn.snapshot_captured`: chat id, snapshot id, message fingerprint, and size metadata.
- `arbiter.plan_requested`: provider lane, snapshot id, and cache fingerprint.
- `arbiter.plan_received`: cadence, scene sensitivity, prompt footprint, focus profile, and trigger labels.
- `arbiter.plan_rejected`: schema or safety reason.
- `scene.shift_detected`: previous and next scene fingerprints plus sensitivity.
- `card.job_started`: job type, cadence, and target cache segment.
- `card.job_completed`: created, refreshed, stowed, discarded, selected, and omitted counts.
- `hand.selected`: card ids, lanes, token estimate, and omission counts.
- `composer.completed`: composer lane, token estimate, and reasoner trigger labels.
- `prompt.packet_built`: packet id, footprint, lanes, and token estimate.
- `prompt.install_succeeded`: packet id, host insertion metadata, and snapshot id.
- `prompt.install_failed`: packet id and sanitized adapter error.
- `activity.stage_changed`: phase, mode, severity, visible label, and compact chips.
- `activity.settled`: outcome, visible summary, and fallback path when present.
- `provider.failed`: lane, job type, sanitized error class, and fallback path.
- `runtime.stale_result_discarded`: job id and superseded snapshot id.
- `storage.write_failed`: logical key and sanitized error class.

Diagnostics should support the UI's Status and Inspector surfaces, automated tests, and bug reports. They should be capped, sanitized, and safe to persist.

## V1 Implementation Slices

V1 should be built in small vertical slices that preserve the end-to-end loop.

1. Host adapter skeleton and modes
   - Implement SillyTavern lifecycle hooks, Off/Observe/Auto mode state, snapshot capture, activity event contract, and no-op prompt clear/install methods.

2. Snapshot and diagnostics foundation
   - Add stable snapshot ids, message fingerprints, bounded diagnostics events, and inspector-ready last-run summaries.

3. Provider lanes and Utility Arbiter contract
   - Implement Utility provider routing, structured Auto Control Plan schema validation, provider failure fallback, and sanitized call diagnostics.

4. Scene cache and card job runner
   - Add bounded scene card cache, card create/refresh/stow/discard/select jobs, cache invalidation, and cadence enforcement.

5. Turn hand selection
   - Select compact hand candidates by focus profile, scene relevance, token caps, and omission rules.

6. Prompt composition and injection
   - Build prompt packets from the turn hand, enforce footprint budgets, install through the SillyTavern adapter, clear stale packet metadata, and report prompt-ready/install/fallback activity.

7. Optional Composer/Reasoner lane
   - Add Reasoner trigger handling, timeout/failure fallback, and deterministic composer fallback.

8. Storage hardening
   - Persist settings, cache metadata, last packet metadata, and bounded diagnostics using logical keys and privacy-safe records.

9. UI integration and smoke validation
   - Connect the Recursion Bar, Activity Ribbon, status, refresh, provider health, mode controls, and inspector diagnostics. Validate Off, Observe, Auto, provider failure, scene refresh, storage activity, prompt install, and stale-result behavior.

Each slice should keep generation usable if it fails. The first complete proof is not perfect card intelligence; it is a reliable loop from observe -> Arbiter -> card jobs/cache -> hand -> prompt packet -> host injection -> diagnostics.
