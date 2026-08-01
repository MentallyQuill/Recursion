# Recursion Extension Spec

This is the top-level V1 contract for Recursion, a SillyTavern extension that compiles bounded, turn-local reasoning into an inspectable prompt packet for native host generation.

```text
Utility Arbiter -> Turn Deck -> Turn Hand -> Optional Reasoner Composer -> Prompt Packet -> SillyTavern Injection
```

Recursion is mostly automatic. It improves prose, dialogue, emotional texture, and scene adhesion by expanding the immediate implications of the active turn. It is not a continuity extension, memory manager, lore database, summary engine, vector-recall layer, campaign save system, or detached story generator.

## Document Map

- [Product Scope](design/RECURSION_PRODUCT_SCOPE.md)
- [Card System](design/CARD_SYSTEM_SPEC.md)
- [Behavior Settings](design/BEHAVIOR_SETTINGS_POLICY_SPEC.md)
- [Runtime Architecture](architecture/RUNTIME_ARCHITECTURE.md)
- [Cache Use And Reuse](architecture/CACHE_USE_AND_REUSE_SPEC.md)
- [Provider And Generation](architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [Prompt Composition](architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage And Diagnostics](architecture/STORAGE_AND_DIAGNOSTICS.md)
- [UI Spec](design/UI_SPEC.md)
- [Testing Strategy](testing/TESTING_STRATEGY.md)

The older [Turn Context Compiler seed note](design/RECURSION_TURN_CONTEXT_COMPILER.md) is historical context only.

## Locked V1 Decisions

- SillyTavern owns chat state, native generation, visible story output, and native Stop/Start behavior.
- Recursion installs and clears only its own prompt lanes.
- Every Pre-process operation is bound to one exact turn key derived from the current bounded source band and relevant runtime contracts.
- A new user message always creates a new turn key and runs fresh Arbiter/card work. There is no semantic lease or time-to-live heuristic.
- An unchanged swipe of the same turn may reinstall a validated completed packet with zero Recursion model calls.
- An edit, delete, selected-swipe change inside the bounded source band, character/group change, settings change, provider change, or contract change rejects incompatible reuse.
- `Reprocess from here on the next swipe` and Full Rebuild are turn-bound, one-shot, next-swipe-only actions. Clicking either starts no provider or host work.
- Stop has one runtime owner. Resume requests the matching native SillyTavern action and never executes provider work on a detached path.
- Post-process work is bound to the exact assistant response identity, including the selected swipe and response content.
- Durable V2 manifests contain checkpoint metadata; isolated artifacts contain the minimum bodies needed for Resume and validated reuse.
- Last Brief is display-only state and never authorizes reuse.
- Generated work from prior turns is disposable and pruned automatically. Users configure journal retention only.
- Direct-provider API keys remain session-only and never enter durable records or diagnostics.
- Automated live tests use dedicated soak users; intentional acceptance testing may verify the exact reported `default-user` chats.

## Product Boundary

Recursion owns:

- reading a bounded snapshot of the active chat;
- deriving an exact turn identity;
- planning and generating fixed-catalog card work;
- selecting a compact turn hand;
- composing, validating, installing, and clearing a prompt packet;
- optional identity-bound Post-process rewriting;
- durable resumability, bounded diagnostics, and an operational UI.

Recursion does not own durable canon, transcript history, World Info, Memory Books, character databases, campaign branches, or primary story generation.

## Turn Identity And Classification

The turn key includes the chat key, latest user message identity and content hash, bounded visible source-band hash, selected swipe identity when relevant, character/group identity, and all settings/provider/pipeline/deck/prompt/stage contracts that can change output.

Before any provider call, runtime classifies the request:

- **New turn:** a new user message or different turn key. Build fresh work unconditionally.
- **Unchanged swipe:** the same turn key with a validated completed packet. Reinstall it and let SillyTavern roll another response.
- **Changed source:** an edit, delete, or relevant swipe/source change. Reject incompatible work and rebuild.
- **Queued next-swipe action:** consume the matching one-shot Reprocess or Full Rebuild intent, then execute the requested invalidation scope.
- **Paused operation:** request native host generation; continue only when the interceptor re-enters with the matching source.

No clock, inferred scene boundary, or semantic similarity decides whether generated work survives.

## Core Runtime Flow

1. The host adapter freezes the bounded source snapshot and generation kind.
2. Runtime computes the turn key and classifies the invocation.
3. Valid unchanged-swipe reuse reinstalls the prepared packet without model work; all other accepted paths create or resume a V2 operation.
4. The Utility Arbiter plans the required card families from the frozen snapshot.
5. Segmented runs independently checkpointed card stages; Fused validates one multi-card bundle and repairs or falls back through Segmented as required.
6. Runtime validates card evidence, builds the turn deck, and selects the bounded hand.
7. Utility or policy-selected Reasoner composition produces guidance while preserving selected raw card evidence.
8. Runtime validates and installs the packet through Recursion-owned host prompt keys.
9. SillyTavern performs primary generation.
10. Optional Post-process work freezes the landed assistant response identity, generates a guarded rewrite, and commits once through the host.

Optional failures fail soft. A failed Recursion preparation must not strand the host send path.

## Card Catalog And Prompt Packet

V1 provides a fixed internal catalog:

- Scene Frame
- Active Cast
- Character Motivation
- Relationship
- Scene Constraints
- Knowledge
- Consequences
- Environment
- Items
- Open Threads

Cards expand current implications rather than merely restating facts. Operator-authored cards inside custom decks are configuration, not durable memory.

The installed packet contains:

- **Guidance:** provider-authored direction for using the selected evidence;
- **Card Evidence:** validated selected-card `promptText`;
- **Guardrails:** compact constraints against contradiction, hidden-thought leakage, spoilers, and rewriting the user's message.

Prompt footprint remains bounded and inspectable. Advanced injection placement, role, and depth apply to the composed packet, not individual cards.

## Durable Execution

```json
{
  "pipelineMode": "segmented",
  "modelAttemptsPerStep": 2
}
```

Model stages receive one through five total automatic attempts. Local validation, persistence, composition, and host mutation do not consume attempts. Recursion sets no default model-call timeout and never automatically retries SillyTavern's primary generation.

Accepted stages commit integrity-bound isolated artifacts before the V2 manifest advances. Resume and reuse require matching source, turn, settings, provider, pipeline, stage, dependency, and artifact hashes.

Stop pauses the graph, aborts active Recursion calls, requests native host Stop, clears prompt lanes, and waits for Post-process settlement. Resume requests the stored native Send, Swipe, or Regenerate action and does zero direct provider work. Retry resets only the blocking failed stage and its descendants.

Reprocess invalidates one eligible stage and its dependency closure on the next matching swipe. Full Rebuild bypasses all reusable Pre-process checkpoints on the next matching swipe. A new user message, source-band edit, or turn mismatch cancels either queued intent.

`Reset Turn Cache` removes Recursion-generated work for the active turn, its queued intent, prepared packet, and owned prompt state without changing SillyTavern messages.

## Storage Shape

- `extension_settings.recursion`: persisted controls and provider configuration without secrets.
- `recursion-system-index.v1.json`: rebuildable index and V2-authority marker.
- `recursion-pipeline-run-{chatKey}.v2.json`: current metadata-only operation manifest.
- `recursion-pipeline-artifact-{chatKey}-{operationId}-{artifactId}.v2.json`: isolated resumable artifact.
- `recursion-queued-reprocess-{chatKey}.v2.json`: one-shot next-swipe intent.
- `recursion-run-journal-{chatKey}.v1.json`: bounded sanitized diagnostics.

V1 generated-record formats are retired input. On V2 activation, Recursion deletes retired generated records instead of migrating them into authority. Prior-turn artifacts are pruned as soon as they stop protecting the active operation or exact same-turn reuse path.

## UI Contract

The compact Recursion Bar exposes Power, Pipeline, Mode, card scope, Hero Pixel Array progress, current status, Reasoning Level, Last Brief, and Options. It remains SillyTavern-native and operational.

Progress rows expose at most one contextual action:

- `Stop and pause this operation`
- `Resume from saved checkpoint`
- `Retry this stage`
- `Reprocess from here on the next swipe`
- `Cancel queued reprocess`

When idle, the shared action slot exposes `Rebuild all Recursion work on the next swipe`; its queued label is `Full rebuild on next swipe: Queued`.

Advanced Storage Retention exposes Journal Entries only. Diagnostics exposes `Reset Turn Cache`, whose tooltip is `Delete Recursion's generated work for the active turn without changing SillyTavern messages.`

## Provider And Privacy Contract

Utility is required; Reasoner is optional and policy-selected. Each lane can use the current host model, a host connection profile, or an OpenAI-compatible endpoint. All machine jobs validate their visible structured output before runtime trusts it.

Raw provider prompts, raw responses, hidden reasoning, transcript bodies, and direct-provider secrets are excluded from normal journals, diagnostics, and proof reports. Diagnostic proof uses hashes, bounded statuses, mutation counts, and lifecycle counters.

## Current Source Of Truth

When current documents conflict, prefer:

1. this top-level extension spec;
2. the focused subsystem spec;
3. current implementation and executable contract tests;
4. historical notes only for context.

Recursion is pre-alpha. Update contracts in place; do not add compatibility shims for retired generated-state models.
