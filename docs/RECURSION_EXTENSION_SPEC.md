# Recursion Extension Spec

This is the top-level design and implementation contract for Recursion, a SillyTavern extension that improves roleplay writing quality by compiling a compact, current-scene prompt packet for the next generation.

Recursion's core design is:

```text
Utility Arbiter -> Scene Deck -> Turn Hand -> Optional Reasoner Composer -> Prompt Packet -> SillyTavern Injection
```

The extension should be mostly automatic. It should improve prose, dialogue, emotional continuity, and scene adhesion without becoming a memory manager, lore database, summary engine, vector recall layer, campaign save system, or card-editing product.

## Document Map

Start here, then follow the focused specs:

- [Product Scope](design/RECURSION_PRODUCT_SCOPE.md): product promise, V1 scope, non-goals, success criteria.
- [Card System Spec](design/CARD_SYSTEM_SPEC.md): scene-local cards, card families, lifecycle, Utility Arbiter responsibilities, turn hand.
- [Runtime Architecture](architecture/RUNTIME_ARCHITECTURE.md): host boundary, turn pipeline, Auto Control Plan, failure behavior, implementation slices.
- [Provider and Generation Spec](architecture/PROVIDER_AND_GENERATION_SPEC.md): Utility and Reasoner lanes, structured calls, validation, session-only secrets, model-call journal.
- [Prompt Composition Spec](architecture/PROMPT_COMPOSITION_SPEC.md): prompt packet contract, Utility/Reasoner composition, injection lanes, footprint profiles, omissions.
- [Storage and Diagnostics](architecture/STORAGE_AND_DIAGNOSTICS.md): settings, logical JSON records, scene cache, run journal, redaction, invalidation.
- [UI Spec](design/UI_SPEC.md): Recursion Bar, Actions menu, Last Hand dropdown, full viewer, high-level settings, graphite-dark visual system.
- [Implementation Plan](testing/IMPLEMENTATION_PLAN.md): staged build order and verification gates.

The older [Turn Context Compiler seed note](design/RECURSION_TURN_CONTEXT_COMPILER.md) is retained only as historical context and is superseded by this spec set.

## Product Boundary

Recursion owns a narrow short-lived writing-context loop:

- observe the active chat and current generation context;
- ask the Utility Arbiter what current-scene work matters;
- maintain a cached scene deck of disposable cards;
- select a compact turn hand;
- optionally use a Reasoner Composer to fuse complex hands;
- compose and install a prompt packet;
- show the last hand, prompt packet, and diagnostics in a mostly read-only UI.

Recursion does not own:

- durable canon;
- long-term memory;
- transcript summarization;
- vector recall;
- World Info or Memory Books;
- character databases;
- campaign saves or branches;
- user-authored card catalogs;
- hidden internal-thought storage.

## Core Runtime Flow

1. The SillyTavern host adapter captures a stable turn snapshot.
2. The Utility Arbiter receives the snapshot, current scene cache metadata, fixed V1 card catalog, provider status, and prompt budget context.
3. The Arbiter returns an Auto Control Plan: cadence, scene sensitivity, prompt footprint, focus profile, card lifecycle decisions, composer lane, and Reasoner trigger reasons.
4. Runtime validates the plan, enforces schema and budget caps, and executes requested card jobs from one frozen snapshot.
5. The scene deck is updated with generated, refreshed, stowed, discarded, or stale cards.
6. The Arbiter-selected turn hand is passed to prompt composition.
7. Utility Composer builds the prompt packet, or Reasoner Composer assists when enabled, available, and justified.
8. Runtime validates the packet and installs it through Recursion-owned SillyTavern prompt keys.
9. The UI and storage layers receive sanitized diagnostics and latest-hand metadata.

If any optional step fails, Recursion should degrade gracefully. Normal SillyTavern generation should continue.

## Auto Decisions

The Utility Arbiter is the semantic decision point. It decides meaning-heavy questions such as:

- whether the current scene is the same scene, a soft shift, a hard shift, or uncertain;
- whether to skip, run a light pass, run a full card pass, or refresh the scene;
- which card families are already represented, missing, stale, or no longer relevant;
- which cards belong in the next turn hand;
- which cards deserve more emphasis or detail;
- whether the Reasoner Composer is worth using this turn.

Runtime code is deterministic for safety, not semantic judgment. It validates schemas, caps token budgets, enforces source/fingerprint checks, rejects unsafe fields, handles provider failures, and prevents stale results from mutating the current prompt state.

## V1 Card Catalog

V1 uses a fixed internal catalog:

- Scene Frame
- Active Cast
- Character Motivation
- Dialogue / Relationship
- Continuity Risk
- Environment / Items
- Prose / Pacing
- Open Threads

The catalog is not a visible checklist and not a user-authored card system. The Arbiter receives it as a menu and decides which cards need to exist for the current scene.

Character Motivation cards replace raw internal-thought dumps. They may express visible motivation, likely pressure, or behavior-facing guidance, but private diagnostic notes must never be injected.

## Prompt Packet

The model-facing artifact is a composed prompt packet, not a pile of raw cards.

The packet has three primary sections:

- Scene Brief: reusable scene context while the scene remains valid.
- Turn Brief: immediate next-response guidance.
- Guardrails: compact constraints that prevent contradictions, hidden-thought leakage, spoilers, or user-message rewriting.

Prompt footprint can be compact, normal, or rich. Even rich packets must stay bounded, current-scene oriented, and inspectable.

## UI Shape

The primary UI is a Recursion Bar attached to the chat surface:

```text
Recursion   Ready - Auto   Hand 5   Utility   Reasoner idle   [Actions] [Hand] [Open]
```

It replaces the earlier shelf/drawer idea. The bar is thin, stable, mostly observational, and paired with:

- an Actions menu for high-level commands;
- a Last Hand dropdown for recent card visibility;
- a full viewer for deck/activity/prompt/settings/provider inspection;
- provider settings for Utility and Reasoner lanes;
- a small set of broad behavior controls.

Users should not need to edit cards, tune individual card weights, or maintain relevance rules.

## Storage Shape

Storage is cache-oriented:

- `extension_settings.recursion`: compact control plane and provider settings without secrets.
- `recursion-system-index.v1.json`: rebuildable index of Recursion records.
- `recursion-scene-{chatKey}-{sceneKey}.v1.json`: bounded scene deck and latest hand metadata.
- `recursion-run-journal-{chatKey}.v1.json`: bounded sanitized diagnostics.
- optional user-triggered debug export.

Cards are cache artifacts, not memories. Records can be invalidated aggressively on chat changes, hard scene shifts, source edits/deletes, provider/settings changes, or schema/catalog changes.

## Provider Shape

Recursion has two provider lanes:

- Utility: default, fast, cheap, structured, batch-friendly.
- Reasoner: optional composer/synthesis lane for complex, crowded, conflicted, or subtle scenes.

Provider sources:

- current host model;
- host connection profile;
- OpenAI-compatible endpoint.

API keys for direct endpoints are session-only. They must not persist to settings, scene cache, prompt packet, run journal, diagnostics, or debug export.

## Implementation Strategy

The implementation should proceed in vertical slices:

1. Contracts and skeleton runtime.
2. Storage and settings.
3. Provider lanes and structured calls.
4. Utility Arbiter and card deck.
5. Batched card generation.
6. Prompt composition and injection.
7. Recursion Bar and viewer.
8. SillyTavern integration smoke.

Each slice should preserve the product boundary: current-scene prompt compilation, fail-soft behavior, no durable memory ownership, no card micromanagement, and no campaign-save architecture.

## Current Source Of Truth

When docs conflict, prefer this order:

1. This top-level extension spec.
2. The focused spec for the relevant subsystem.
3. The implementation plan.
4. Historical seed notes.

Because Recursion is pre-alpha, incompatible early docs or prototypes should be updated in place to the current contract instead of preserving legacy behavior.
