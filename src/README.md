# Source Layout

Recursion source code will be organized around a small scene-compiler runtime.

- `context/` - Relevance scoring, scene prompt planning, and brief compilation.
- `generation/` - Provider roles, request builders, and response parsing.
- `hosts/` - Host adapters. The initial target is SillyTavern.
- `runtime/` - Extension lifecycle, orchestration, and scene-cache coordination.
- `storage/` - Logical keys, indexes, and persisted settings/cache helpers.
- `ui/` - Minimal shelf, drawer, settings, and inspector surfaces.
- `utils/` - Shared small helpers.
