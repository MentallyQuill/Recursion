# First Run Workflow

This guide walks through the first useful Recursion session in SillyTavern. It assumes Recursion is installed or served as an extension and that you are using the current V1 pre-alpha contract.

Recursion is a current-scene prompt compiler. It observes the active chat, builds a compact scene deck and turn hand, and installs a bounded prompt packet when Auto or Semi-Auto mode is active. It is not a memory manager, lore database, summary engine, vector recall layer, campaign save system, or card-editing workflow.

## 1. Install And Enable

1. Install or serve Recursion as a SillyTavern extension.
2. Open SillyTavern extension settings.
3. Enable `Recursion`.
4. Return to the active chat and confirm the Recursion Bar appears near the chat surface.

<Render Needed>: assets/documentation/renders/recursion-first-run-install-enable.png - SillyTavern extension settings with Recursion enabled and the Recursion Bar mounted in the active chat.

The bar should expose the power toggle, icon-only mode control, Hero Pixel Array plus current-step text, Reasoning Level chain, Last Brief dropdown arrow, and ellipsis options entry. On narrow screens, extra details may collapse into compact menus.

<Render Needed>: assets/documentation/renders/recursion-first-run-bar-mounted.png - Recursion Bar mounted below the SillyTavern chat header with power toggle, mode icon, Hero Pixel Array, Reasoning Level chain, Last Brief dropdown arrow, and options entry visible.

## 2. Configure Utility

Utility is required. It is the default lane for Arbiter planning, card work, and normal prompt composition.

1. Open the Recursion options menu from the ellipsis.
2. Choose the `Providers` tab.
3. Configure the Utility provider source:
   - Current Host Model;
   - Host Connection Profile; or
   - OpenAI-Compatible Endpoint.
4. If using an OpenAI-compatible endpoint, enter base URL, model, and a session API key.
5. Run `Test Provider`.

Session API keys are memory-only for the browser session. Recursion may remember that a session key is present, but it must not save the key in settings, scene cache, prompt packets, journals, diagnostics, browser local storage, SillyTavern file storage, reports, or test artifacts.

## 3. Optionally Configure Reasoner

Reasoner is optional. Leave it off for the first pass unless you intentionally want the extra composer lane.

Reasoner is used only when enabled, healthy, and selected for a crowded, conflicted, or subtle hand. If Reasoner fails, times out, is off, or returns invalid output, Recursion falls back to Utility composition.

## 4. Run The First Auto Pass

Auto prepares and installs the next Recursion prompt packet.

1. Confirm the power toggle is on.
2. Set mode to `Auto`.
3. Send a safe, ordinary chat message.
4. Watch the Hero Pixel Array progress menu for visible progress.
5. Wait for `Recursion prompt ready.` or a clear fallback state.
6. Let SillyTavern generation continue normally.

<Render Needed>: assets/documentation/renders/recursion-first-run-auto-pass.png - Hero Pixel Array progress menu during an Auto pass showing Utility planning, card generation, prompt composition, prompt install, and ready state.

Use the Last Brief dropdown and Prompt Packet panel when you want to inspect exactly what Recursion installed.

## 5. Try Semi-Auto

Semi-Auto is the V1 mode reserved for constraining card generation to selected card types. Until that backend selector lands, it follows the same prompt-install path as Auto.

1. Set mode to `Semi-Auto`.
2. Send a safe, ordinary chat message.
3. Confirm the Hero Pixel Array progresses and prompt readiness behaves like Auto.

<Render Needed>: assets/documentation/renders/recursion-first-run-semi-auto-pass.png - Hero Pixel Array progress menu during a Semi-Auto pass showing the same current V1 install path as Auto.

A normal Auto pass may show stages such as reading the current turn, planning the card pass, generating or reusing scene cards, selecting the turn hand, composing the prompt packet, installing the Recursion prompt, saving cache, and ready state.

## 6. Inspect Last Brief And Viewer

After Auto or Semi-Auto has produced a hand:

1. Open the Last Brief dropdown arrow from the Recursion Bar.
2. Review compact selected cards, emphasis, omission hints, and composition route.
3. Expand card rows when you need full card text.
4. Use `Prompt Packet` when available.
5. Open the Full Viewer from options/settings.
6. Inspect `Now`, `Deck`, `Activity`, `Prompt Packet`, `Settings`, and `Providers`.

<Render Needed>: assets/documentation/renders/recursion-first-run-inspection.png - Last Brief dropdown and Full Viewer showing selected cards, Activity, Prompt Packet, Settings, and Providers after a first Auto pass.

The prompt packet should be bounded and inspectable. It should contain current-scene guidance, not raw provider output, hidden reasoning, broad lore, or transcript-scale summaries.

## 7. Clear Or Disable Safely

Use these controls when you want Recursion out of the next generation:

- Click the power toggle off to stop Recursion and clear or skip Recursion-owned prompt lanes.
- Disable the extension if you want Recursion fully inactive.
- Clear session keys when you are finished with direct endpoint testing.

Prompt cleanup should remove stale Recursion prompt packets. If prompt cleanup fails, normal generation should continue without trusting stale Recursion guidance, and the UI should show a warning.

## First Run Pass Criteria

The first run is healthy when:

- Recursion Bar is mounted and stable.
- Utility provider can be configured and tested.
- Auto mode reaches prompt ready or a clear fail-soft fallback.
- Semi-Auto mode currently reaches the same prompt-ready path as Auto.
- Last Brief and Full Viewer inspection are available.
- Prompt Packet inspection shows bounded current-scene guidance.
- Power-off or extension disable removes Recursion from the next prompt path.

Related docs:

- [Operator Manual](RECURSION_OPERATOR_MANUAL.md)
- [Provider Setup](PROVIDER_SETUP.md)
- [Prompt Privacy And Safety](PROMPT_PRIVACY_AND_SAFETY.md)
- [Live Smoke Test Plan](../testing/LIVE_SMOKE_TEST_PLAN.md)
