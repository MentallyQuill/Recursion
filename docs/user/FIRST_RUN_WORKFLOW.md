# First Run Workflow

This guide walks through the first useful Recursion session in SillyTavern. It assumes Recursion is installed or served as an extension and that you are using the current V1 pre-alpha contract.

Recursion is a current-scene prompt compiler. It observes the active chat, builds a compact scene deck and turn hand, and installs a bounded prompt packet only when Auto mode is active. It is not a memory manager, lore database, summary engine, vector recall layer, campaign save system, or card-editing workflow.

## 1. Install And Enable

1. Install or serve Recursion as a SillyTavern extension.
2. Open SillyTavern extension settings.
3. Enable `Recursion`.
4. Return to the active chat and confirm the Recursion Bar appears near the chat surface.

<Render Needed>: assets/documentation/renders/recursion-first-run-install-enable.png - SillyTavern extension settings with Recursion enabled and the Recursion Bar mounted in the active chat.

The bar should expose mode, hand count, Utility status, Reasoner status, Actions, Last Hand, and Open controls on desktop. On narrow screens, extra details may collapse into a menu.

<Render Needed>: assets/documentation/renders/recursion-first-run-bar-mounted.png - Recursion Bar mounted below the SillyTavern chat header with ready status, mode control, provider chips, Actions, Hand, and Open controls visible.

## 2. Configure Utility

Utility is required. It is the default lane for Arbiter planning, card work, and normal prompt composition.

1. Open the Recursion Actions menu.
2. Choose `Open Settings`.
3. Configure the Utility provider source:
   - Current Host Model;
   - Host Connection Profile; or
   - OpenAI-Compatible Endpoint.
4. If using an OpenAI-compatible endpoint, enter base URL, model, and a session API key.
5. Run `Test Provider`.

Session API keys are memory-only for the browser session. Recursion may remember that a session key is present, but it must not save the key in settings, scene cache, prompt packets, journals, diagnostics, browser local storage, SillyTavern file storage, reports, or test artifacts.

## 3. Optionally Configure Reasoner

Reasoner is optional. Leave it disabled for the first pass unless you intentionally want the extra composer lane.

Reasoner is used only when enabled, healthy, and selected for a crowded, conflicted, or subtle hand. If Reasoner fails, times out, is disabled, or returns invalid output, Recursion falls back to Utility composition.

## 4. Start In Observe

Observe lets you inspect Recursion without installing a prompt packet.

1. Set mode to `Observe`.
2. Send or select a safe, ordinary chat turn.
3. Watch the Activity Ribbon.
4. Confirm the ribbon reports snapshot, planning, card, hand, or preview work.
5. Confirm the status says no prompt was injected.

<Render Needed>: assets/documentation/renders/recursion-first-run-observe-pass.png - Activity Ribbon during an Observe pass showing snapshot capture, Utility planning, hand preview, and no prompt injection.

Use Observe when you want to check what Recursion would do before letting it affect generation.

## 5. Run The First Auto Pass

Auto prepares and installs the next Recursion prompt packet.

1. Set mode to `Auto`.
2. Send a safe, ordinary chat message.
3. Watch the Activity Ribbon for visible progress.
4. Wait for `Recursion prompt ready.` or a clear fallback state.
5. Let SillyTavern generation continue normally.

<Render Needed>: assets/documentation/renders/recursion-first-run-auto-pass.png - Activity Ribbon during an Auto pass showing Utility planning, card generation, prompt composition, prompt install, and ready state.

A normal Auto pass may show stages such as reading the current turn, planning the card pass, generating or reusing scene cards, selecting the turn hand, composing the prompt packet, installing the Recursion prompt, saving cache, and ready state.

## 6. Inspect Last Hand And Viewer

After Observe or Auto has produced a hand:

1. Open `Hand` from the Recursion Bar.
2. Review compact selected cards, emphasis, omission hints, and composition route.
3. Use `View Prompt Packet` when available.
4. Open the Full Viewer.
5. Inspect `Now`, `Deck`, `Activity`, `Prompt Packet`, `Settings`, and `Providers`.

<Render Needed>: assets/documentation/renders/recursion-first-run-inspection.png - Last Hand dropdown and Full Viewer showing selected cards, Activity, Prompt Packet, Settings, and Providers after a first Auto pass.

The prompt packet should be bounded and inspectable. It should contain current-scene guidance, not raw provider output, hidden reasoning, broad lore, or transcript-scale summaries.

## 7. Clear Or Disable Safely

Use these controls when you want Recursion out of the next generation:

- Set mode to `Off` to stop Recursion and clear or skip Recursion-owned prompt lanes.
- Disable the extension if you want Recursion fully inactive.
- Clear session keys when you are finished with direct endpoint testing.

Prompt cleanup should remove stale Recursion prompt packets. If prompt cleanup fails, normal generation should continue without trusting stale Recursion guidance, and the UI should show a warning.

## First Run Pass Criteria

The first run is healthy when:

- Recursion Bar is mounted and stable.
- Utility provider can be configured and tested.
- Observe mode shows visible work without prompt injection.
- Auto mode reaches prompt ready or a clear fail-soft fallback.
- Last Hand and Full Viewer inspection are available.
- Prompt Packet inspection shows bounded current-scene guidance.
- Off mode or extension disable removes Recursion from the next prompt path.

Related docs:

- [Operator Manual](RECURSION_OPERATOR_MANUAL.md)
- [Provider Setup](PROVIDER_SETUP.md)
- [Prompt Privacy And Safety](PROMPT_PRIVACY_AND_SAFETY.md)
- [Live Smoke Test Plan](../testing/LIVE_SMOKE_TEST_PLAN.md)
