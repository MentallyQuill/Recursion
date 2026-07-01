# Source Layout

Recursion source is organized around a small host-neutral scene compiler plus a SillyTavern adapter.

- `core.mjs` - Shared cloning, hashing, parsing, id, truncation, and redaction helpers.
- `settings.mjs` - Compact extension settings, provider preferences, and session-only API key handling.
- `storage.mjs` - Logical scene-cache and run-journal repository with bounded, redacted records.
- `activity.mjs` - User-safe activity reporter for the bar, ribbon, viewer, and diagnostics.
- `providers.mjs` - Utility/Reasoner provider lanes, structured JSON parsing, retries, batching, and diagnostics.
- `cards.mjs` - V1 card catalog, validation, lifecycle application, provider-result conversion, and hand selection.
- `prompt.mjs` - Prompt packet composition, optional Reasoner synthesis, validation, omission rules, and SillyTavern prompt blocks.
- `runtime.mjs` - Turn orchestration, Utility Arbiter planning, scene cache updates, prompt install/clear flow, settings/provider actions, and view model data.
- `ui.mjs` - Recursion Bar, Activity Ribbon, Actions menu, Last Hand dropdown, full viewer, high-level settings, and provider controls.
- `hosts/sillytavern/` - SillyTavern context, generation, prompt, settings, and file-storage adapters.
- `extension/index.js` - SillyTavern entrypoint, lifecycle hooks, and generation interceptor.
