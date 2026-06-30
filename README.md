# Recursion

Recursion is a planned SillyTavern extension for improving roleplay generation quality through lightweight, scene-aware prompt compilation.

The extension is intended to run mostly invisibly. It will inspect the active story, scene, and characters, run fast Utility-model analysis in bounded batches, optionally use a stronger Reasoner pass, and inject compact writing guidance that improves prose, dialogue, continuity, and scene adhesion without becoming a replacement for Memory Books, Summaryception, VectFox, or other long-term context tools.

## Current Status

Recursion is in pre-alpha design. The repository currently contains the project structure and design notes only.

## Repository Layout

- `src/` - Extension source modules.
- `styles/` - Runtime and SillyTavern UI styling.
- `assets/` - Icons, branding, and static extension assets.
- `schemas/` - Structured contracts for generated briefs, scene state, and settings.
- `docs/` - Design notes, architecture docs, and user-facing manuals.
- `tests/` - Focused unit and integration checks.
- `tools/` - Local scripts for validation, packaging, and development utilities.

## Design Direction

The active design is captured in [docs/RECURSION_EXTENSION_SPEC.md](docs/RECURSION_EXTENSION_SPEC.md).

Focused specs:

- [Product Scope](docs/design/RECURSION_PRODUCT_SCOPE.md)
- [Card System Spec](docs/design/CARD_SYSTEM_SPEC.md)
- [UI Spec](docs/design/UI_SPEC.md)
- [Runtime Architecture](docs/architecture/RUNTIME_ARCHITECTURE.md)
- [Provider and Generation Spec](docs/architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [Prompt Composition Spec](docs/architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics](docs/architecture/STORAGE_AND_DIAGNOSTICS.md)
- [Implementation Plan](docs/testing/IMPLEMENTATION_PLAN.md)
