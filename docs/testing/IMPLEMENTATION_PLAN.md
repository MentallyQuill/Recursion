# Recursion Implementation Plan

This plan turns the design docs into a staged pre-alpha implementation path. Recursion is still pre-alpha, so implementation can update contracts in place as long as docs, schemas, and tests move together.

Primary specs:

- [Product Scope](../design/RECURSION_PRODUCT_SCOPE.md)
- [Card System Spec](../design/CARD_SYSTEM_SPEC.md)
- [Runtime Architecture](../architecture/RUNTIME_ARCHITECTURE.md)
- [Provider and Generation Spec](../architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics](../architecture/STORAGE_AND_DIAGNOSTICS.md)
- [UI Spec](../design/UI_SPEC.md)
- [Testing Strategy](TESTING_STRATEGY.md)
- [SillyTavern Playwright Harness](SILLYTAVERN_PLAYWRIGHT_HARNESS.md)
- [Live Smoke Test Plan](LIVE_SMOKE_TEST_PLAN.md)
- [Artifact Contract](ARTIFACT_CONTRACT.md)
- [Documentation Render Tracking](DOCUMENTATION_RENDER_TRACKING.md)

## Stage 1: Contracts And Skeleton Runtime

Goal: establish the stable seams before model calls or UI complexity.

Build:

- Extension lifecycle entrypoint.
- Host adapter interface for SillyTavern context, chat snapshot, prompt injection, settings, and file storage.
- Runtime event bus or small coordinator.
- Core type/schema files for cards, hands, auto control plan, prompt packets, provider settings, scene cache, and run journal.
- Minimal diagnostics channel.
- Activity event contract for the Recursion Bar, Hero Pixel Array progress menu, and Full Viewer.

Tests:

- Schema normalization tests.
- Host adapter fake tests.
- Runtime starts/stops without touching prompt injection.
- Disabled mode performs no work.
- Activity events normalize without raw prompts, raw responses, or transcript text.

Exit criteria:

- Recursion can initialize in a fake host and SillyTavern without provider calls.
- Settings can load/save compact control-plane state.

## Stage 2: Storage And Settings

Goal: make cache persistence boring, bounded, and inspectable.

Build:

- Logical storage key mapper.
- SillyTavern file adapter.
- Recursion storage repository.
- `recursion-system-index.v1.json`.
- Scene cache read/write.
- Bounded run journal read/write.
- Storage diagnostics and cleanup.
- Provider settings store with session-only secret handling.

Tests:

- Logical key/path validation.
- Read/create/update cache.
- Bounded journal pruning.
- Missing/corrupt payload diagnostics.
- API key never persists to settings, cache, journals, diagnostics, or artifacts.

Exit criteria:

- Scene cache and journal survive reload.
- Diagnostics can list cache status without reading every payload.

## Stage 3: Provider Lanes And Structured Calls

Goal: support Utility and Reasoner lanes before building the card system on top.

Build:

- Provider lane config.
- Current host model route.
- Host connection profile route if available.
- OpenAI-compatible endpoint route.
- `briefUtilityComposer` and `reasonerComposer` role contracts.
- Test Provider action.
- Sanitized model-call journal.
- JSON response parser and validator.

Tests:

- Provider settings normalize.
- Role resolves to expected lane.
- Structured output validation rejects malformed results.
- Failure returns a safe diagnostic without blocking host generation.

Exit criteria:

- Utility and Reasoner can be tested independently.
- Utility is the default composer path.
- Reasoner can compose a packet and fall back to Utility on failure.
- Model-call telemetry is useful and redacted.

## Stage 4: Utility Arbiter And Card Deck

Goal: implement the core model-mediated card lifecycle.

Build:

- Turn snapshot builder.
- Card catalog.
- Utility Arbiter prompt and schema.
- Arbiter auto control plan.
- Card lifecycle application: create, stow, discard, regenerate, refresh, select.
- Scene deck and turn hand cache updates.
- Emphasis and detail profiles.

Tests:

- Arbiter output validation.
- Lifecycle transitions.
- Scene deck update from structured result.
- Invalid card family/state/action rejection.
- Character Motivation diagnostic notes never enter injection-safe fields.

Exit criteria:

- Given a fake Arbiter result, Recursion updates a scene deck and selects a turn hand.
- No deterministic semantic scoring is required for card relevance.

## Stage 5: Batched Card Generation

Goal: fill cards from a single scene/turn snapshot without serial Stepped-Thinking behavior.

Build:

- Utility batch request planner.
- Card generation workers for V1 families.
- Shared snapshot and source refs.
- Per-card structured output validation.
- Cache reuse and regeneration rules.
- Bounded fallback when batch support is unavailable.

Tests:

- Batch planner groups requested card jobs.
- Workers receive the same snapshot id.
- Failed card jobs do not poison the whole hand.
- Cache reuse avoids unnecessary generation.

Exit criteria:

- A full card pass can generate or refresh the requested scene deck families.

## Stage 6: Prompt Composition And Injection

Goal: turn selected cards into one compact, inspectable prompt packet.

Build:

- Utility composition path, with `briefUtilityComposer` reserved for model-routed Utility composition.
- Optional Reasoner Composer through `reasonerComposer`.
- Prompt packet schema.
- Footprint profiles: compact, normal, rich.
- Omission reasons.
- Conditioned final prompt injection settings contract: placement `default | in_prompt | in_chat`, role `system | user | assistant`, and depth `default | 0..10`.
- Prompt injection adapter.
- Prompt clear/replace behavior.

Tests:

- Packet composition from selected hand.
- Reasoner composition cannot add unsupported lore fields.
- Reasoner timeout, provider failure, or invalid schema falls back to Utility composition.
- Explicit conditioned final-prompt injection settings override packet block placement, role, and depth after Utility/Reasoner composition.
- Injection installs, replaces, and clears by Recursion-owned key.
- Manual mode remains selectable and enforces selected card scope as a strict whitelist before prompt installation.

Exit criteria:

- Recursion can compile and inject a prompt packet for the next generation.

## Stage 7: Recursion Bar, Hero Pixel Array Progress Menu, And Viewer

Goal: make Recursion visible enough to trust without turning it into a workbench.

Build:

- Recursion Bar.
- Hero Pixel Array progress menu with foreground, background, review, success, fallback, and error states.
- Options/settings menu.
- Last Brief dropdown.
- Full viewer: Now, Deck, Activity, Prompt Packet, Settings, Providers.
- High-level settings controls.
- Advanced conditioned final-prompt injection controls for placement, role, and depth, defaulted to `in_prompt`, `system`, depth `4`.
- Provider controls.
- Cards scope selector with fixed family and sub-item focus controls.
- SillyTavern-native graphite styling.

Tests:

- Bar renders in ready, compiling, paused, disabled, provider issue states.
- Hero Pixel Array progress menu renders Arbiter, card batch, composition, prompt install, storage, fallback, and provider issue stages.
- Quick operations do not flicker the progress surface.
- Warning/error states persist until dismissed or superseded.
- Last Brief shows used cards from the prior run.
- Cards scope selector prevents zero selected focus items and updates Manual/Auto behavior without exposing card-editing workflows.
- Viewer handles empty/corrupt diagnostics gracefully.
- Settings save persists conditioned final-prompt injection placement, role, and depth without exposing card-level micromanagement.
- Mobile/narrow layout does not overlap chat controls.

Exit criteria:

- Users can see what Recursion is doing, what it did, and adjust high-level behavior.

## Stage 8: SillyTavern Integration Smoke

Goal: prove the actual extension works in the host.

Build:

- Installed extension manifest/assets if not already present.
- Host event wiring around player send/generation timing.
- Prompt injection timing guard.
- Stop/disable cleanup where applicable.
- Playwright live harness helpers for browser launch, auth, served-extension checks, storage probes, no-generation screenshots/traces, runtime snapshots, and redaction.
- Offline Playwright readiness script.
- Dedicated soak-user isolation script.
- Focused live SillyTavern smoke script.
- Documentation render register and promoted render asset directory.

Tests:

- Offline Playwright readiness: browser launch, role-locator click, desktop/phone screenshots, trace, and report writing without contacting SillyTavern.
- Dedicated user preflight rejects `default-user` and proves `recursion-soak-*` storage isolation.
- Live SillyTavern smoke: initialize, configure Utility, Auto mode, Manual mode, prompt packet install, prompt packet clear, and power-off cleanup.
- Chat change invalidates active scene cache.
- Provider failure falls back without blocking generation.
- Hero Pixel Array progress menu visibly reports model work, cache use, storage progress, prompt readiness, and fallbacks.
- Live artifacts include sanitized `report.json`, `summary.md`, `live-log.jsonl`, no-generation screenshots/traces, prompt packet metadata, storage probe results, and redaction checks.
- Documentation render gaps are inventoried with visible markers and final assets promote only into `assets/documentation/renders/`.

Exit criteria:

- Recursion works in a real SillyTavern chat with visible UI state and prompt packet diagnostics.
- Automated live evidence comes from dedicated `recursion-soak-*` users, never `default-user`.

## Cross-Stage Rules

- Keep docs and schemas updated with implementation changes.
- Prefer fake-host deterministic tests before live smoke.
- Do not persist provider secrets.
- Do not store durable lore or long-term memory.
- Do not expose low-level card editing unless the product scope changes.
- Keep user-visible errors short and actionable.
