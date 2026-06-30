# Recursion Turn Context Compiler Seed Note

This file is retained as historical context from the first Recursion design pass. It is superseded by the current interconnected spec set.

Current source of truth:

- [Recursion Extension Spec](../RECURSION_EXTENSION_SPEC.md)
- [Product Scope](RECURSION_PRODUCT_SCOPE.md)
- [Card System Spec](CARD_SYSTEM_SPEC.md)
- [UI Spec](UI_SPEC.md)
- [Runtime Architecture](../architecture/RUNTIME_ARCHITECTURE.md)
- [Provider and Generation Spec](../architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics](../architecture/STORAGE_AND_DIAGNOSTICS.md)
- [Implementation Plan](../testing/IMPLEMENTATION_PLAN.md)

The important decisions that replaced this seed note:

- The UI is a chat-attached Recursion Bar with dropdowns and a full viewer, not a Directive/Saga shelf.
- Semantic card lifecycle decisions are model-mediated through the Utility Arbiter, not driven by deterministic relevance scoring.
- Cards are scene-local cache artifacts, not memories.
- The selected hand is normally composed into one prompt packet, not injected as raw card fragments.
- The Reasoner is optional and used for composition only when justified, not as a default second pass.
- Storage is minimal, bounded, and cache-oriented.
