# Source Layout

Recursion source is organized around a small host-neutral scene compiler plus a SillyTavern adapter.

- `core.mjs` - Shared cloning, hashing, parsing, id, truncation, and redaction helpers.
- `settings.mjs` - Compact extension settings, Connection Profile policy, derived Reasoner-use state, injection settings, UI limits, and staged profile certification.
- `settings-policy.mjs` - Source-backed Strength, Focus, Prompt Footprint, card-budget, and behavior-policy derivation used by runtime, prompt composition, and diagnostics.
- `storage.mjs` - Logical scene-cache, execution-manifest, isolated checkpoint-artifact, queued-intent, and run-journal repository with bounded, redacted metadata.
- `activity.mjs` - User-safe activity reporter for the bar, Hero Pixel Array progress menu, viewer, and diagnostics.
- `providers.mjs` - Utility/Reasoner Connection Profile routing, policy resolution, queued generation, structured response validation, retries, certification, batching, and privacy-safe diagnostics.
- `cards.mjs` - V1 card catalog, validation, lifecycle application, provider-result conversion, and hand selection.
- `card-scope.mjs` - Fixed V1 card-scope catalog, Auto preference filtering, Manual whitelist enforcement, and scope validation.
- `progress.mjs` - Hero Pixel Array and progress-menu model builder that turns runtime/activity/provider events into stable visual rows.
- `prompt.mjs` - Prompt packet composition, optional Reasoner synthesis, validation, omission rules, and SillyTavern prompt blocks.
- `runtime.mjs` - Turn orchestration, Utility Arbiter planning, behavior-policy application, scene cache updates, prompt install/clear flow, cancellation cleanup, settings/provider actions, and view model data.
- `execution/` - Durable stage graph, checkpoint, provenance, attempt-window, queued-reprocess, and scheduler contracts.
- `runtime/` - Runtime conductor support modules: run state, prompt install, diagnostics, execution graph projection, and pipeline runners.
- `runtime/pipelines/` - Segmented per-card and Fused bundle provider-generation paths.
- `ui.mjs` - Recursion Bar, icon-only mode/card controls, Hero Pixel Array progress menu, options menu, Last Brief dropdown, full viewer, autosaving settings, Connection Profile selection, policy controls, and staged profile certification.
- `ui/` - Pure UI presenters and provider/action helpers used by `ui.mjs`.
- `safe-values.mjs` - Shared text/object safety helpers for diagnostics and host/provider normalization.
- `guidance-omissions.mjs` - Typed Guidance omission records shared by persistence and diagnostics.
- `hosts/sillytavern/` - SillyTavern context, generation, prompt, settings, and file-storage adapters.
- `hosts/sillytavern/provider-profiles.mjs` - SillyTavern connection-profile discovery owned by the host adapter.
- `extension/index.js` - SillyTavern entrypoint, lifecycle hooks, and generation interceptor.
