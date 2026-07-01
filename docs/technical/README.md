# Recursion Technical Manuals

These manuals explain how Recursion works behind the SillyTavern UI. They are release-facing technical docs grounded in the V1 source modules, design specs, architecture specs, and testing contracts.

## Manual Set

| Manual | Purpose |
| --- | --- |
| [Recursion Technical Manual](RECURSION_TECHNICAL_MANUAL.md) | System overview, boundaries, runtime spine, component ownership, UI observability, fail-soft invariants, evidence, and non-goals. |
| [Runtime Turn Sequence](RUNTIME_TURN_SEQUENCE.md) | Off, Observe, and Auto lifecycle from snapshot capture through Arbiter decisions, cards, composition, injection, storage, cancellation, and failure branches. |
| [Card Deck And Hand](CARD_DECK_AND_HAND.md) | Fixed V1 card families, card contract, deck lifecycle, hand selection, invalidation, Character Motivation safety, and inspector visibility. |
| [Prompt Packet And Injection](PROMPT_PACKET_AND_INJECTION.md) | Scene Brief, Turn Brief, Guardrails, composer inputs, Utility/Reasoner composition, budgets, omissions, injection lanes, cleanup, and privacy guardrails. |
| [Model Calls And Provider Routing](MODEL_CALLS_AND_PROVIDER_ROUTING.md) | Utility and Reasoner lanes, provider sources, generation roles, structured output validation, retries, fallbacks, journals, secrets, aborts, and provider status. |
| [Storage And Diagnostics](STORAGE_AND_DIAGNOSTICS.md) | Release-facing storage and diagnostic guide with links back to the architecture storage spec. |
| [Host Integration Manual](HOST_INTEGRATION_MANUAL.md) | SillyTavern adapter responsibilities, entrypoint lifecycle, generation interceptor, prompt/storage/settings/generation adapters, UI mount, tests, and host boundary. |

## Source References

- [Extension Spec](../RECURSION_EXTENSION_SPEC.md)
- [Product Scope](../design/RECURSION_PRODUCT_SCOPE.md)
- [Card System Spec](../design/CARD_SYSTEM_SPEC.md)
- [UI Spec](../design/UI_SPEC.md)
- [Runtime Architecture](../architecture/RUNTIME_ARCHITECTURE.md)
- [Provider and Generation Spec](../architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics Spec](../architecture/STORAGE_AND_DIAGNOSTICS.md)
- [Source Layout](../../src/README.md)
- [Testing Strategy](../testing/TESTING_STRATEGY.md)
- [Artifact Contract](../testing/ARTIFACT_CONTRACT.md)

