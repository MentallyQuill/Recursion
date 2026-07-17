# Recursion Technical Manuals

These manuals explain how Recursion works behind the SillyTavern UI. They are release-facing technical docs grounded in the V1 source modules, design specs, architecture specs, and testing contracts.

## Manual Set

| Manual | Purpose |
| --- | --- |
| [Recursion Technical Manual](RECURSION_TECHNICAL_MANUAL.md) | System overview, boundaries, runtime spine, Standard/Rapid/Fused pipelines, component ownership, UI observability, fail-soft invariants, evidence, and non-goals. |
| [Runtime Turn Sequence](RUNTIME_TURN_SEQUENCE.md) | Power toggle, Auto/Manual lifecycle, Standard foreground flow, Rapid warm/delta flow, card scope, injection, storage, cancellation, and failure branches. |
| [Generation Review and Enhancement Contract](../architecture/ENHANCEMENT_REVIEW_AND_PATCH_CONTRACT.md) | Frozen post-generation review, bounded Repair/Recompose/Redirect patches, card-outcome coverage, verification, settlement, and shared recovery. |
| [Card Deck And Hand](CARD_DECK_AND_HAND.md) | Fixed V1 card families, card contract, deck lifecycle, hand selection, invalidation, Character Motivation safety, and inspector visibility. |
| [Prompt Packet And Injection](PROMPT_PACKET_AND_INJECTION.md) | Guidance, Card Evidence, Guardrails, composer inputs, Utility/Reasoner composition, budgets, omissions, injection lanes, cleanup, and privacy guardrails. |
| [Model Calls And Provider Routing](MODEL_CALLS_AND_PROVIDER_ROUTING.md) | Utility and Reasoner lanes, provider sources, machine-JSON schema metadata, generation roles, structured output validation, retries, fallbacks, journals, secrets, aborts, and provider status. |
| [Recursion Cost Research](RECURSION_COST_RESEARCH.md) | Planning reference for provider call counts, token-budget ranges, prompt-packet size, pipeline cost levers, and external multiplier caveats. |
| [Storage And Diagnostics](STORAGE_AND_DIAGNOSTICS.md) | Release-facing storage and diagnostic guide with links back to the architecture storage spec. |
| [Host Integration Manual](HOST_INTEGRATION_MANUAL.md) | SillyTavern adapter responsibilities, entrypoint lifecycle, generation interceptor, prompt/storage/settings/generation adapters, UI mount, tests, and host boundary. |

## Source References

- [Extension Spec](../RECURSION_EXTENSION_SPEC.md)
- [Product Scope](../design/RECURSION_PRODUCT_SCOPE.md)
- [Card System Spec](../design/CARD_SYSTEM_SPEC.md)
- [Behavior Settings Policy Spec](../design/BEHAVIOR_SETTINGS_POLICY_SPEC.md)
- [UI Spec](../design/UI_SPEC.md)
- [Runtime Architecture](../architecture/RUNTIME_ARCHITECTURE.md)
- [Provider and Generation Spec](../architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics Spec](../architecture/STORAGE_AND_DIAGNOSTICS.md)
- [Source Layout](../../src/README.md)
- [Testing Strategy](../testing/TESTING_STRATEGY.md)
- [Artifact Contract](../testing/ARTIFACT_CONTRACT.md)

## Module Coverage Map

| Source Area | Primary Manual |
| --- | --- |
| `src/runtime.mjs`, `src/card-decks.mjs`, `src/editorial-transform.mjs`, `src/failures.mjs`, `src/progress.mjs` | [Runtime Turn Sequence](RUNTIME_TURN_SEQUENCE.md), [Card Deck And Hand](CARD_DECK_AND_HAND.md), and [Generation Review Contract](../architecture/ENHANCEMENT_REVIEW_AND_PATCH_CONTRACT.md) |
| `src/cards.mjs`, `src/card-scope.mjs` | [Card Deck And Hand](CARD_DECK_AND_HAND.md) and [Behavior Settings Policy Spec](../design/BEHAVIOR_SETTINGS_POLICY_SPEC.md) |
| `src/prompt.mjs` | [Prompt Packet And Injection](PROMPT_PACKET_AND_INJECTION.md) and [Behavior Settings Policy Spec](../design/BEHAVIOR_SETTINGS_POLICY_SPEC.md) |
| `src/providers.mjs`, provider settings in `src/settings.mjs`, `src/settings-policy.mjs`, `src/retention-policy.mjs` | [Model Calls And Provider Routing](MODEL_CALLS_AND_PROVIDER_ROUTING.md) and [Recursion Cost Research](RECURSION_COST_RESEARCH.md) |
| `src/storage.mjs`, diagnostic journal surfaces | [Storage And Diagnostics](STORAGE_AND_DIAGNOSTICS.md) |
| `src/hosts/sillytavern/`, `src/extension/index.js` | [Host Integration Manual](HOST_INTEGRATION_MANUAL.md) |
| `src/ui.mjs`, `styles/recursion.css` | [UI Spec](../design/UI_SPEC.md) and operator docs |
