# Source Layout

Recursion source is organized around a small host-neutral scene compiler plus a SillyTavern adapter.

- `core.mjs` - Shared cloning, hashing, parsing, id, truncation, and redaction helpers.
- `settings.mjs` - Compact extension settings, provider preferences, and session-only API key handling.
- `storage.mjs` - Logical scene-cache and run-journal repository with bounded, redacted records.
- `activity.mjs` - User-safe activity reporter for the bar, Hero Pixel Array progress menu, viewer, and diagnostics.
- `providers.mjs` - Utility/Reasoner provider lanes, structured JSON parsing, retries, batching, and diagnostics.
- `cards.mjs` - V1 card catalog, validation, lifecycle application, provider-result conversion, and hand selection.
- `card-scope.mjs` - Fixed V1 card-scope catalog, Auto preference filtering, Manual whitelist enforcement, and scope validation.
- `progress.mjs` - Hero Pixel Array and progress-menu model builder that turns runtime/activity/provider events into stable visual rows.
- `prompt.mjs` - Prompt packet composition, optional Reasoner synthesis, validation, omission rules, and SillyTavern prompt blocks.
- `runtime.mjs` - Turn orchestration, Utility Arbiter planning, scene cache updates, prompt install/clear flow, settings/provider actions, and view model data.
- `ui.mjs` - Recursion Bar, Hero Pixel Array progress menu, options menu, Last Brief dropdown, full viewer, high-level settings, and provider controls.
- `hosts/sillytavern/` - SillyTavern context, generation, prompt, settings, and file-storage adapters.
- `extension/index.js` - SillyTavern entrypoint, lifecycle hooks, and generation interceptor.
