# Recursion

Recursion is a pre-alpha SillyTavern extension for improving roleplay generation quality through lightweight, scene-aware prompt compilation.

The extension runs mostly invisibly. It inspects the active story, scene, and characters, runs fast Utility-model analysis in bounded batches, optionally uses a stronger Reasoner pass, and injects compact writing guidance that improves prose, dialogue, continuity, and scene adhesion without becoming a replacement for Memory Books, Summaryception, VectFox, or other long-term context tools.

## Current Status

Recursion V1 is implemented as a pre-alpha extension loop: settings, provider lanes, scene cards, runtime coordination, SillyTavern host adapter, prompt packet composition/injection, native-feeling UI, and focused automated tests are present. Live SillyTavern automation requires a dedicated `recursion-soak-*` user and rejects `default-user`.

Run the maintained local gate:

```powershell
npm test
node tools\scripts\run-alpha-gate.mjs
```

Optional live smoke scripts:

```powershell
node tools\scripts\check-playwright-readiness.mjs --write-artifacts
node tools\scripts\check-sillytavern-soak-users.mjs --live --write-artifacts
node tools\scripts\smoke-sillytavern-live.mjs --live --write-artifacts --strict
```

## Repository Layout

- `src/` - Extension source modules.
- `styles/` - Runtime and SillyTavern UI styling.
- `schemas/` - Placeholder for future standalone schemas; current contracts live in source modules and docs.
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
