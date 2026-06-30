# Recursion V1 Operator Guide

Recursion is a mostly automatic SillyTavern extension that reads the current scene, builds a compact prompt packet for the next response, and installs that packet when Auto mode is active. It is a current-scene prompt compiler, not a memory manager, lore database, summary engine, or card-editing workflow.

## Normal Use

1. Enable Recursion in SillyTavern extensions.
2. Set Recursion to `Observe` when you want inspection without prompt injection, or `Auto` when you want Recursion to prepare the next prompt.
3. Configure the Utility provider.
4. Optionally configure the Reasoner provider.
5. Send a message in chat.
6. Watch the Activity Ribbon below the Recursion Bar while Recursion works.
7. Open the Hand dropdown or Viewer when you want to inspect what Recursion used.

## Provider Defaults

- Utility is required, default, and used for normal Arbiter, card, and prompt-composition work.
- Reasoner is optional. It only assists when enabled, healthy, and useful for a crowded or conflicted hand.
- Utility remains the fallback composer when Reasoner is disabled or fails.
- OpenAI-compatible endpoint settings can use session API keys. These keys are session-only and are not saved to settings, cache records, prompt packets, journals, diagnostics, or exports.

## Activity Ribbon

The Activity Ribbon is the visible progress surface for work that would otherwise be invisible. It can show stages for:

- reading the current turn;
- planning the card pass;
- generating, refreshing, or reusing scene cards;
- selecting the turn hand;
- composing the prompt packet;
- installing the Recursion prompt;
- saving scene cache or diagnostics;
- provider fallback and warning states.

The ribbon uses user-facing stage text such as `Reading current turn...`, `Planning card pass...`, `Generating scene cards...`, `Composing prompt packet with Utility...`, `Reasoner composing final brief...`, `Installing Recursion prompt...`, and `Recursion prompt ready.`

Raw prompts and raw provider responses are not shown. Raw provider responses are not shown in normal diagnostics, Activity Ribbon entries, or smoke artifacts.

## Expected Fail-Soft Behavior

- If Utility fails, Recursion skips new work or uses valid cached scene data when it can.
- If a card refresh fails, valid sibling cards and the last good hand may still be used.
- If Reasoner fails, times out, is disabled, or returns invalid output, Recursion falls back to Utility composition.
- If prompt installation fails, normal SillyTavern generation continues without Recursion guidance.
- Warnings should be visible in the Recursion Bar, Activity Ribbon, or Viewer without exposing raw provider payloads or secrets.

## Live Smoke Checklist

Use this checklist for a practical manual pass in a real SillyTavern browser session:

1. Load SillyTavern with Recursion installed and enabled.
2. Confirm the Recursion Bar appears near the chat surface, below other chat top bars when possible.
3. Open the Actions menu and confirm the Activity Ribbon can render a clear status.
4. Set mode to `Observe`.
5. Send a safe short chat message.
6. Confirm Observe mode shows work, previews the hand when available, and does not inject a prompt.
7. Set mode to `Auto`.
8. Send a safe short chat message.
9. Confirm the Activity Ribbon reaches `Recursion prompt ready.` or shows a clear fail-soft fallback.
10. Open the Hand dropdown and confirm compact last-hand cards are visible.
11. Open the Viewer and confirm `Now`, `Deck`, `Activity`, `Prompt Packet`, `Settings`, and `Providers` sections are reachable.
12. Confirm Utility provider state is visible and can be tested or reviewed.
13. If Reasoner is configured, confirm Reasoner state is visible; then disable or misconfigure it and confirm Utility fallback is visible.
14. Disable Recursion or switch to Off mode and confirm Recursion prompt lanes are cleared or skipped.
15. Clear session keys or temporary provider settings and confirm cleanup leaves no saved API key.
