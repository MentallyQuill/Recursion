# Recursion Product Scope

## Purpose

Recursion is a mostly turnkey SillyTavern extension for improving writing output quality during live roleplay and story generation. Its job is to improve the next model response by expanding reasoning over the current scene: what the active location, cast, relationships, objects, pressures, and reveal boundaries imply for the next beat.

Recursion is not a continuity extension, long-term memory, or lore authority. It complements Memory Books, Summaryception, VectFox, World Info, and similar extensions by compiling a current-scene prompt packet instead of owning durable canon.

Related specs:

- [CARD_SYSTEM_SPEC.md](CARD_SYSTEM_SPEC.md)
- [RUNTIME_ARCHITECTURE.md](../architecture/RUNTIME_ARCHITECTURE.md)
- [PROMPT_COMPOSITION_SPEC.md](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [UI_SPEC.md](UI_SPEC.md)
- [STORAGE_AND_DIAGNOSTICS.md](../architecture/STORAGE_AND_DIAGNOSTICS.md)
- [PROVIDER_AND_GENERATION_SPEC.md](../architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [IMPLEMENTATION_PLAN.md](../testing/IMPLEMENTATION_PLAN.md)

## Target User Experience

The default experience should feel invisible during play. A user enables Recursion, chooses basic provider behavior if needed, and keeps writing. The extension observes the active chat, understands the current scene at a high level, and installs a compact prompt packet before generation when doing so is useful.

The user should not need to manage a catalog of cards, tune semantic relevance rules, or manually edit prompt fragments turn by turn. The UI should explain what Recursion did, expose health and diagnostics, show live Hero Pixel Array progress feedback while invisible work is happening, and offer a few high-level controls such as enabled state, Reasoning Level, provider setup, and optional Reasoner use.

Advanced surfaces should support inspection and trust, not micromanagement.

## Core Promise

Recursion improves the next generated response by answering one narrow question: what compact current-scene reasoning would help the model notice the right implications for the next response?

A useful Recursion card is not a fact ledger. It starts from active scene evidence, expands the immediate affordances, constraints, tensions, or opportunities that follow from that evidence, and states a relevance boundary so the prompt packet does not drift into lore, summary, or generic writing advice.

The core runtime shape is:

1. Utility Arbiter evaluates the active chat and current turn.
2. Recursion maintains a cached scene deck and selects a turn hand from it.
3. Optional Reasoner Composer synthesizes the hand into sharper scene-reasoning guidance.
4. Runtime installs a compact prompt packet through controlled SillyTavern prompt integration.

The product promise is better next-turn scene reasoning, dialogue, emotional texture, and scene adhesion without adding a second campaign system, continuity database, lore database, or user-authored card workflow.

## V1 Scope

V1 should include the smallest complete loop that proves Recursion's value:

- Observe the active SillyTavern chat and current generation context.
- Detect or refresh the current scene boundary and scene fingerprint.
- Use a model-mediated Utility Arbiter for semantic relevance, lifecycle, and card selection decisions.
- Maintain a bounded, cached scene deck for the active scene.
- Select a compact turn hand from that deck for the next generation.
- Optionally run a Reasoner Composer when configured and available.
- Compose and install a compact prompt packet with clear token caps and omission behavior.
- Expose high-level UI status, Hero Pixel Array progress, enablement, Reasoning Level, provider health, and last-run diagnostics.
- Persist only settings, bounded scene cache, provider-safe metadata, and diagnostics needed to understand recent behavior.

Detailed behavior belongs in the companion specs:

- Card creation, lifecycle signals, and hand selection: [CARD_SYSTEM_SPEC.md](CARD_SYSTEM_SPEC.md)
- Runtime orchestration and SillyTavern hooks: [RUNTIME_ARCHITECTURE.md](../architecture/RUNTIME_ARCHITECTURE.md)
- Prompt packet shape, depth, roles, and budgets: [PROMPT_COMPOSITION_SPEC.md](../architecture/PROMPT_COMPOSITION_SPEC.md)
- Recursion Bar, Hero Pixel Array progress menu, Last Brief dropdown, status, and viewer surfaces: [UI_SPEC.md](UI_SPEC.md)
- Storage keys, journals, privacy, and diagnostics: [STORAGE_AND_DIAGNOSTICS.md](../architecture/STORAGE_AND_DIAGNOSTICS.md)
- Provider lanes, structured calls, schemas, and fallbacks: [PROVIDER_AND_GENERATION_SPEC.md](../architecture/PROVIDER_AND_GENERATION_SPEC.md)
- Build order and validation plan: [IMPLEMENTATION_PLAN.md](../testing/IMPLEMENTATION_PLAN.md)

## Explicit Non-Goals

V1 must not become a general memory or continuity platform. Specifically, it should not include:

- Long-term memory ownership.
- Continuity-extension ownership or durable canon arbitration.
- World Info replacement.
- Vector recall or embedding search.
- Transcript summarization as a durable source of truth.
- Campaign saves, campaign branching, or character database management.
- Custom user-authored card types.
- Per-card editing, pinning, merging, or approval workflows.
- Giant catalog, timeline, or lore browser UI.
- User-maintained semantic rules for card relevance.
- Deterministic semantic lifecycle rules that pretend string matching can decide story meaning.
- Hidden chain-of-thought storage or private story plans.
- Prompt bloat that competes with the active chat, Memory Books, Summaryception, VectFox, or World Info.

Pre-alpha status means Recursion can update internal structures in place. It does not need legacy compatibility layers for early experiments when a better V1 shape is clear.

## Complementing Other Extensions

Recursion should treat other context extensions as upstream or parallel owners, not rivals.

Memory Books and World Info own durable facts, lore, and authored background. Summaryception owns longer transcript compression. VectFox owns vector-style recall. Recursion should consume the current prompt environment and active chat context, then add only near-term scene-reasoning guidance that helps the next response stay grounded.

The prompt packet should be compact and explicitly current-scene oriented. If another extension already provides broad lore or memory, Recursion should avoid restating it unless that fact is immediately relevant to the scene and likely to improve the next response.

## Design Principles

Recursion should be model-mediated where semantic judgment matters and deterministic where runtime safety matters.

The Utility Arbiter should decide meaning-heavy questions such as relevance, scene adhesion, lifecycle, and which cards deserve the turn hand. Runtime code should enforce schemas, token caps, provider availability, cache invalidation, privacy boundaries, prompt install rules, and failure behavior.

Important principles:

- Turnkey first: the normal user path should require little setup and no card management.
- Scene implications over durable canon: Recursion optimizes what the next response can infer and use from the active scene, not the whole story database.
- Compact packets over exhaustive context: omission is a product feature when it protects focus.
- Observational UI over micromanagement: show decisions, diagnostics, and controls without asking users to operate the internals.
- Provider-aware execution: Utility and Reasoner work must degrade cleanly when providers are unavailable.
- Clear ownership boundaries: do not absorb memory, summary, vector, or World Info responsibilities.
- Structured outputs only: model-mediated decisions must pass runtime schemas and bounded validation.
- No hidden story steering: guidance should improve adherence and craft without inventing future plot or overriding the user.

## Success Criteria

Recursion V1 succeeds when a user can enable it in SillyTavern and see measurably better next-turn writing with minimal operational burden.

Practical success criteria:

- Generated responses better exploit the immediate scene: who is present, what the location affords, what objects and relationships enable, what should remain hidden, and which near-term pressures matter.
- The prompt packet stays compact, bounded, and inspectable.
- Utility Arbiter decisions are schema-valid, capped, and recoverable when provider calls fail.
- Optional Reasoner output improves composition without becoming mandatory or authoritative.
- The UI communicates current status, live invisible work, fallbacks, and recent decisions without exposing a card-management product.
- Recursion coexists cleanly with Memory Books, Summaryception, VectFox, and World Info.
- Storage remains minimal, privacy-preserving, and diagnostic rather than becoming a campaign save system.
- Implementation can be validated through focused runtime, prompt composition, provider, and UI tests described in [IMPLEMENTATION_PLAN.md](../testing/IMPLEMENTATION_PLAN.md).
