# Recursion Operator Manual

Recursion is a pre-alpha SillyTavern extension that compiles compact, current-scene prompt guidance for the next roleplay generation. It observes the active chat, maintains a short-lived scene deck, selects a turn hand, and installs an inspectable prompt packet when Auto mode is active.

Recursion is not a memory manager, lore database, summary engine, vector recall layer, campaign save system, character database, or card-editing product. It does not own durable canon. It improves the next response by preparing a bounded writing brief from the scene in front of the user.

## Surface Matrix

<Render Needed>: assets/documentation/renders/recursion-operator-install-enable.png - Install and enable flow with SillyTavern extension list, Recursion enabled state, and mounted Recursion Bar.

<Render Needed>: assets/documentation/renders/recursion-operator-mode-controls.png - Mode controls showing Off, Observe only, Auto, Reasoning Level, and Off-mode cleanup behavior.

<Render Needed>: assets/documentation/renders/recursion-operator-bar-states.png - Recursion Bar ready, working, warning, disabled, provider issue, prompt-ready states, Hero Pixel Array, and current-step text.

<Render Needed>: assets/documentation/renders/recursion-operator-progress-menu-states.png - Hero Pixel Array progress menu showing snapshot, Utility planning, card generation child rows, cached rows, prompt composition, Reasoner pass or skip, prompt install, fallback, and settled states.

<Render Needed>: assets/documentation/renders/recursion-operator-options-menu.png - Options/settings menu with Play, Providers, Advanced, Reasoning Level, provider controls, diagnostics limits, disabled planned commands, and Full Viewer entry point.

<Render Needed>: assets/documentation/renders/recursion-operator-last-brief-states.png - Last Brief dropdown with compact selected cards, category glyphs, meta chips, expandable text, Prompt Packet button, empty brief, stale brief, and error state.

<Render Needed>: assets/documentation/renders/recursion-operator-full-viewer-sections.png - Full Viewer showing Now, Deck, Activity, Prompt Packet, Settings, Providers, and diagnostics sections.

<Render Needed>: assets/documentation/renders/recursion-operator-settings.png - Settings view showing Play, Providers, Advanced, Mode, Reasoning Level, Strength, Prompt Footprint, Focus, Utility provider setup, and Reasoner provider setup.

<Render Needed>: assets/documentation/renders/recursion-operator-provider-controls.png - Provider controls for Utility setup, Reasoner setup, session-only key state, test connection, Reasoner off, and fallback warning.

<Render Needed>: assets/documentation/renders/recursion-operator-prompt-packet-inspection.png - Prompt Packet inspection showing Scene Brief, Turn Brief, Guardrails, selected card refs, omissions, injection metadata, and redaction-safe diagnostics.

<Render Needed>: assets/documentation/renders/recursion-operator-fail-soft-states.png - Fail-soft states for Utility unavailable, Reasoner timeout, invalid structured output, storage write failure, injection failure, and stale async result.

<Render Needed>: assets/documentation/renders/recursion-operator-mobile-behavior.png - Mobile layout showing Recursion Bar wrap behavior, menu access, viewer layout, and touch-safe controls.

## Main Surfaces

### Recursion Bar

The Recursion Bar is the normal control surface. It sits near the chat surface and shows:

- runtime health: Ready, Working, Paused, Issue, or Off;
- `RECURSION` wordmark;
- icon-only mode control: Off, Observe only, or Auto;
- Hero Pixel Array plus current-step text;
- Reasoning Level chain;
- Last Brief dropdown arrow;
- ellipsis options/settings entry.

The bar should be stable. Status changes should not repeatedly resize the transcript or cover message input controls.

### Hero Pixel Array Progress Menu

The Hero Pixel Array and current-step text are the trust surface for invisible work. Clicking either opens the progress menu. The array shows one block per top-level progress row, with child rows visible inside the menu.

Expected stages include:

- `Reading current turn...`
- `Checking scene shift...`
- `Planning card pass...`
- `Generating scene cards...`
- `Selecting turn hand...`
- `Composing prompt packet with Utility...`
- `Reasoner composing final brief...`
- `Installing Recursion prompt...`
- `Recursion prompt ready.`
- `Observe mode: hand preview ready. No prompt injected.`

Fallback states should be equally direct, such as `Reasoner unavailable. Utility composed the packet.` or `Prompt install failed. Generation will continue without Recursion.`

The progress menu must not show raw prompts, raw provider responses, stack traces, provider secrets, hidden reasoning, or private story plans.

### Options Menu

The ellipsis opens the integrated settings/options menu. It is configuration-first, not a command drawer.

Main controls:

- Play: Mode, Reasoning Level, Strength, Prompt Footprint, and Focus.
- Providers: Utility and Reasoner provider setup, test controls, and session key controls.
- Advanced: progress row limits, diagnostics settings, disabled planned maintenance commands, and the Full Viewer entry point.

The dropdown arrow opens Last Brief. The ellipsis opens options. The Hero Pixel Array or current-step status opens progress.

### Last Brief

Last Brief is the compact inspection surface for what Recursion used last. It opens from the dropdown arrow in the bar. It shows selected card families, category glyphs, emphasis, concise one-line summaries, bounded meta chips, and a Prompt Packet button.

Cards expand in place to show the full card text. The Prompt Packet button opens the final injected packet text plus route metadata, omitted items, source card refs, and copy control.

Rows are read-only. Recursion V1 is not a card editor.

### Full Viewer

The Full Viewer is the complete observatory. It should include:

- `Now`: current mode, active run, latest hand, and prompt packet summary.
- `Deck`: scene-local card state, emphasis, detail profile, provider source, and freshness.
- `Activity`: bounded sanitized runtime, provider, storage, and prompt-install timeline.
- `Prompt Packet`: Scene Brief, Turn Brief, Guardrails, selected refs, omissions, and injection metadata.
- `Settings`: broad behavior controls.
- `Providers`: Utility and Reasoner setup and test controls.

## Modes

### Off

Off stops Recursion from preparing prompt packets. It should clear or skip Recursion-owned prompt lanes so stale packets do not affect generation.

### Observe Only

Observe only lets Recursion inspect the active chat and preview hand or prompt decisions without installing a prompt packet. Use it for first-run validation, provider checks, or when you want visibility without influence.

### Auto

Auto lets Recursion compile and install the next prompt packet. It should finish, reuse valid cache, or fail soft before the next Recursion packet is trusted.

## Settings

Operator settings should stay broad:

- Mode: Off, Observe only, Auto.
- Reasoning Level: Low, Medium, High, Ultra.
- Strength: Light, Balanced, Strong.
- Prompt Footprint: Compact, Normal, Rich.
- Focus: Balanced, Character, Continuity, Prose, Plot.
- Utility and Reasoner provider setup in the settings panel.

Users should not need to manage per-turn action, card families, relevance rules, or prompt depths turn by turn.

## Provider Controls

Recursion has two provider lanes:

- Utility: required, default, and used for Arbiter planning, structured card work, and normal prompt composition.
- Reasoner: optional, used only for eligible crowded, conflicted, or subtle composition work.

Each lane may support:

- Current Host Model;
- Host Connection Profile;
- OpenAI-Compatible Endpoint;
- base URL, model, temperature, top-p, and max token controls;
- session API key field for direct endpoints;
- Save Provider;
- Test Provider;
- Clear Session Key;
- status and resolved model labels.

Utility must be configured for normal operation. Reasoner can remain off. See [Provider Setup](PROVIDER_SETUP.md).

## First Run

Use this first-run path:

1. Enable Recursion and confirm the bar mounts.
2. Configure Utility.
3. Leave Reasoner off unless you need it.
4. Set mode to Observe only.
5. Send or select a safe ordinary turn.
6. Confirm the Hero Pixel Array progress menu shows work and no prompt was injected.
7. Set mode to Auto.
8. Send a safe ordinary turn.
9. Confirm progress reaches prompt ready or a clear fallback.
10. Inspect Last Brief and Prompt Packet.
11. Use Off to verify prompt cleanup.

See [First Run Workflow](FIRST_RUN_WORKFLOW.md) for the shorter checklist.

## Normal Operation

During normal play:

1. Keep Recursion in Auto when you want current-scene prompt help.
2. Watch the Hero Pixel Array and current-step text while work runs.
3. Use Last Brief when output quality suggests the wrong scene pressure was selected.
4. Open Prompt Packet when you need to inspect exact model-facing Recursion guidance.
5. Use the progress menu or Full Viewer when you need diagnostic detail.
6. Use Off when you want an unassisted generation or prompt cleanup.

Recursion should not require card editing or repeated manual tuning.

## Fail-Soft Behavior

Recursion should degrade itself, not the chat.

Expected behavior:

- Utility unavailable: skip new work, reuse valid cache when safe, or avoid injection.
- Utility invalid output: reject unsafe structured output and use conservative fallback.
- Card failure: omit failed cards and keep valid siblings.
- Reasoner off or failed: compose with Utility.
- Storage write failure: continue with memory state when safe and report a warning.
- Prompt install failure: allow SillyTavern generation to continue without Recursion guidance.
- Chat, settings, or source change during a run: abort or discard stale results.

Warnings should be visible in the bar, ribbon, viewer, or provider controls without leaking raw provider payloads or secrets.

## Prompt Packet Inspection

The Prompt Packet is the complete model-facing Recursion artifact for one generation attempt. It should be inspectable and bounded.

Main sections:

- Scene Brief: stable current-scene context while the scene remains valid.
- Turn Brief: immediate next-response guidance.
- Guardrails: compact constraints that prevent contradictions, hidden-thought leakage, spoilers, or user-message rewriting.

Inspection should also show selected card refs, omissions, footprint, token estimate, injection metadata, composer route, and fallback path.

The packet should not contain raw provider responses, hidden chain-of-thought, broad plot plans, durable lore, transcript-scale summaries, or provider secrets.

## Diagnostics

Diagnostics are for explaining recent behavior. Normal diagnostics may include:

- provider lane and source type;
- resolved model label;
- status category;
- duration and token counts;
- card ids, families, statuses, and token estimates;
- source message id ranges and hashes;
- prompt packet hashes;
- omission and fallback reasons;
- cache hit, stale, and prune events.

Normal diagnostics must not include API keys, authorization headers, cookies, raw provider prompts, raw provider responses, full transcript text, hidden reasoning, private notes, or unbounded excerpts.

## Storage Ownership

Recursion storage is cache-oriented. The runtime owns scene cache, run journal, prompt metadata, redaction, pruning, and prompt-lane cleanup. Current operator controls are:

- Off mode cleanup;
- Clear Session Key for each provider lane;
- diagnostics row-limit and excerpt settings;
- disabled planned maintenance commands until runtime handlers exist;
- extension disable when Recursion should be fully inactive.

These controls must touch only Recursion-owned settings, scene caches, journals, prompt lanes, and diagnostics. They must not delete SillyTavern chats, character data, World Info, Memory Books, Summaryception data, VectFox data, or other extension records.

## Mobile Behavior

On narrow viewports:

- mode and hand count should remain visible;
- provider and status details may collapse into a menu;
- the viewer should use one-column sections;
- controls should be touch-safe;
- wide tables should be avoided;
- the bar and ribbon must not cover message input or generation controls.

## Live Smoke Checklist

Use this checklist for a practical browser pass:

1. Load SillyTavern with Recursion installed and enabled.
2. Confirm the Recursion Bar appears near the chat surface.
3. Open the Hero Pixel Array progress menu, Last Brief dropdown, Settings, and Full Viewer.
4. Visit Play, Providers, Advanced, Prompt Packet, and Viewer sections.
5. Configure and test Utility when provider work is intended.
6. Set Off and confirm prompt lanes are absent or cleared.
7. Set Observe only and confirm no prompt packet is installed.
8. Set Auto and confirm Recursion is ready to compile.
9. Run a safe Auto pass only when provider and live mutation are intended.
10. Confirm Activity reaches ready or a clear fallback.
11. Inspect Last Brief and the final Prompt Packet text.
12. Clear prompt or return to Off and confirm cleanup.
13. Clear session keys before screenshots or exports that might show provider setup.

Automated live evidence must use dedicated `recursion-soak-*` users and must reject `default-user` before mutation. See [Live Smoke Test Plan](../testing/LIVE_SMOKE_TEST_PLAN.md).

## Related Docs

- [First Run Workflow](FIRST_RUN_WORKFLOW.md)
- [Provider Setup](PROVIDER_SETUP.md)
- [Prompt Privacy And Safety](PROMPT_PRIVACY_AND_SAFETY.md)
- [UI Spec](../design/UI_SPEC.md)
- [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage And Diagnostics](../architecture/STORAGE_AND_DIAGNOSTICS.md)
