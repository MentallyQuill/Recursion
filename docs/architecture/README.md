# Architecture Notes

Use this folder for implementation-facing diagrams, module boundaries, storage contracts, host integration notes, and prompt-injection contracts.

- [Runtime Architecture](RUNTIME_ARCHITECTURE.md)
- [Post-process Cards Runtime](POST_PROCESS_CARDS_RUNTIME.md)
- [Cache Use And Reuse Spec](CACHE_USE_AND_REUSE_SPEC.md)
- [Provider and Generation Spec](PROVIDER_AND_GENERATION_SPEC.md)
- [Prompt Composition Spec](PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics](STORAGE_AND_DIAGNOSTICS.md)

Behavior-control ownership for Guidance strength, Cards per turn, Focus, and Guidance detail is defined in [Behavior Settings Policy Spec](../design/BEHAVIOR_SETTINGS_POLICY_SPEC.md). The persisted `cardsPerTurn` target is independent of provider routing; required coverage can exceed it, while exhausted optional generated families can produce an explained smaller hand.

For release-facing technical manuals, use [Technical Manuals](../technical/README.md).
