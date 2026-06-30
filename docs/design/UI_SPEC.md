# Recursion UI Spec

## UI Goals

Recursion should feel mostly invisible during normal play. The interface exists to answer three questions quickly:

- Is Recursion active?
- What did it use for the last response?
- What high-level behavior can I adjust without managing cards by hand?

The UI should look native to SillyTavern first. Recursion can have a modern graphite-dark technical personality, but it should feel like an extension panel that belongs inside the active SillyTavern theme, not a separate web app embedded in the page.

Recursion should inherit SillyTavern typography, spacing expectations, menu behavior, border treatment, input styling, and theme variables wherever practical. Custom styling should be restrained and limited to the Recursion Bar, status chips, card-state accents, and viewer organization.

Recursion should avoid low-level card micromanagement in V1. Users can inspect what happened and adjust broad behavior, but the Arbiter owns card selection, refresh, stow, discard, and regeneration.

Related docs:

- [Product Scope](RECURSION_PRODUCT_SCOPE.md)
- [Card System Spec](CARD_SYSTEM_SPEC.md)
- [Runtime Architecture](../architecture/RUNTIME_ARCHITECTURE.md)
- [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [Provider and Generation Spec](../architecture/PROVIDER_AND_GENERATION_SPEC.md)
- [Storage and Diagnostics](../architecture/STORAGE_AND_DIAGNOSTICS.md)

## Recursion Bar

Recursion should use its own chat-attached top bar instead of adopting the Directive/Saga shelf pattern. It may learn from the placement of Chat Top Bar, but it should not depend on TopInfoBar as a component.

Default desktop shape:

```text
Recursion   Ready - Auto   Hand 5   Utility   Reasoner idle   [Actions] [Hand] [Open]
```

Narrow/mobile shape:

```text
Recursion - Ready   Hand 5   [Menu]
```

The bar should sit near the chat surface, preferably above the transcript or below the chat header. It should be thin, stable, and not draggable. It should not resize the transcript repeatedly during status changes.

When SillyTavern has multiple chat top bars, Recursion should mount as the lowest bar in that stack when the host DOM makes that placement reliable. If exact stack placement cannot be guaranteed, the adapter should fall back to the closest stable chat-surface mount point above the transcript. Recursion must not depend on Chat Top Bar or TopInfoBar internals.

The bar should visually align with nearby SillyTavern chrome. Its height, border radius, hover states, dropdown shadows, and icon/button sizing should resemble native SillyTavern controls rather than a detached toolbar.

Visible status fields:

- Runtime status: ready, observing, compiling, paused, provider issue, disabled.
- Mode: off, observe, auto.
- Last hand count.
- Current provider lane for active work.
- Reasoner state: idle, composing, unavailable, disabled.
- Last run freshness when useful.

## Activity Ribbon

The Activity Ribbon is the primary trust surface for invisible Recursion work. It drops down directly below the Recursion Bar while Recursion is operating, then collapses when the work settles.

The ribbon replaces popup-style progress for normal operation. It should show live status for model calls, card lifecycle decisions, scene cache work, prompt packet composition, prompt installation, and fallback behavior without becoming a verbose log.

Default behavior:

- Hidden while idle.
- Reveals after a short delay, roughly 300-400ms, so quick no-op passes do not flicker.
- Uses a restrained slide/fade animation and stable height when expanded.
- Holds success states briefly, roughly 1.5-3 seconds, then collapses.
- Holds warning and error states until dismissed, superseded, or resolved.
- Uses `role="status"` and polite live-region behavior.
- Remains compact on mobile and never covers message input controls.

Default shape:

```text
[pulse] Generating scene cards...   Utility - 3 cards - Cache fresh - Auto
```

Expanded shape:

```text
Recursion is preparing the next response

Reading current turn        done
Planning card pass          done
Generating scene cards      running
Composing prompt packet     queued

[Open Activity] [Open Viewer]
```

Visible elements:

- animated pulse, spinner, or thin shimmer;
- primary stage label;
- compact detail line with run lane, card count, cache status, or Auto decision;
- chips for Utility, Reasoner, Cards, Hand, Cache, Prompt, and Observe when relevant;
- optional chevron to reveal the current run mini timeline;
- review action only when the state needs attention.

The ribbon should use friendly stage text, not internal event names. Recommended V1 stage labels:

- `Reading current turn...`
- `Checking scene shift...`
- `Planning card pass...`
- `Reusing scene deck...`
- `Generating scene cards...`
- `Validating cards...`
- `Updating scene deck...`
- `Selecting turn hand...`
- `Composing prompt packet with Utility...`
- `Reasoner composing final brief...`
- `Installing Recursion prompt...`
- `Recursion prompt ready.`
- `Saving scene cache...`
- `Scene cache saved.`
- `Observe mode: hand preview ready. No prompt injected.`

Fallback and review labels should be equally explicit:

- `Reasoner unavailable. Utility composed the packet.`
- `Utility timed out. Using cached scene brief.`
- `Card refresh failed. Using last good hand.`
- `Recursion skipped: provider unavailable.`
- `Prompt install failed. Generation will continue without Recursion.`

The ribbon should expose Auto decisions in compact language:

- `Auto chose Utility: scene is stable.`
- `Auto escalated to Reasoner: hard scene shift.`
- `Auto skipped refresh: current hand still applies.`
- `Auto requested compact footprint: prompt is crowded.`
- `Auto requested rich footprint: continuity risk is high.`

Activity modes:

- Foreground: Recursion work must finish, reuse cache, or fail soft before the next prompt packet is installed. This mode gets the clearest visible ribbon treatment.
- Background: Recursion is refreshing cache or writing diagnostics after the prompt path is already safe. This mode should be quieter and should not imply the user is waiting.
- Review: Provider setup, storage, validation, or prompt install needs attention. This mode may persist until dismissed or opened in the viewer.

The ribbon must not show raw prompts, raw provider responses, stack traces, unbounded provider error text, hidden reasoning, private story plans, or per-card debug spam. The Full Viewer can show bounded sanitized activity details.

## Actions Menu

The Actions menu contains high-level commands. It should not expose raw card operations.

V1 actions:

- Refresh Scene.
- Regenerate Next Brief.
- Toggle Observe Only / Auto.
- Pause Recursion.
- Copy Last Prompt Packet.
- Open Settings.
- Open Full Viewer.

Provider issue actions:

- Retry Utility.
- Use Utility Only This Turn.
- Open Provider Settings.

Actions should be disabled with clear tooltip copy when unavailable. For example, Refresh Scene is disabled when Recursion is off, and Copy Last Prompt Packet is disabled when no packet has been composed.

## Last Hand Dropdown

The Hand dropdown is the lightweight trust surface. It shows the compact cards used for the last generated assistant message and the composition path that produced the prompt packet.

Example:

```text
Last Hand - 5 cards - composed by Reasoner

[Critical] Continuity Risk - doorway blocked, lamp broken
[Strong] Character Motivation - Mara wants to keep control without escalating
[Normal] Environment / Items - rain noise masks quiet movement
[Normal] Dialogue / Relationship - tension after prior accusation
[Light] Prose / Pacing - keep motion concrete and response-length moderate

[View Prompt Packet] [Open Full Viewer]
```

Rows should be read-only. A row can open its full card detail in the full viewer, but the dropdown should not become an editor.

Each row should show:

- Card type.
- Target, when applicable.
- Emphasis.
- One-line summary.
- State when not active, such as stowed or regenerated.

## Full Viewer

The full viewer is an observatory, not a primary play surface. It should open as a full-window panel or modal that can be dismissed quickly.

Recommended sections:

- Now: current Auto Control Plan, last run, active hand, prompt packet summary.
- Deck: scene deck, card states, emphasis, detail profile, provider, updated time.
- Activity: bounded run journal, current Activity Ribbon timeline, errors, refreshes, reasoner trigger reasons, fallback paths.
- Prompt Packet: final injected packet, omitted reasons, source card ids.
- Settings: high-level behavior settings.
- Providers: Utility and Reasoner provider controls.

Card detail view should include:

- Card type and target.
- State: active, stowed, discarded, regeneration requested, refreshed.
- Emphasis and detail profile.
- Why selected or why omitted.
- Source evidence refs or hashes.
- Injection-safe text.
- Inspector-only notes, clearly labeled and never injected.
- Lifecycle history.

## Settings

Settings should be few, powerful, and understandable.

Primary controls:

- Mode: Off, Observe, Auto.
- Reasoner Use: Off, Auto, Always Compose. Utility remains the default composer and fallback path.
- Strength: Light, Balanced, Strong.
- Prompt Footprint: Compact, Normal, Rich.
- Focus: Balanced, Character, Continuity, Prose, Plot.

Most internal Auto settings should not be exposed as controls. The UI can display Auto decisions for inspection, but users should not have to manage cadence, scene sensitivity, reasoner trigger rules, or individual card families.

Advanced controls can exist behind a compact disclosure if needed:

- Reset scene cache.
- Export sanitized diagnostics.
- Clear run journal.
- Copy storage diagnostics.

## Provider Controls

Provider controls should follow the smaller Directive-style lane model:

- Utility Provider.
- Reasoner Provider.

Each provider card should support:

- Source: Current Host Model, Host Connection Profile, OpenAI-Compatible Endpoint.
- Connection profile selector when using host profiles.
- Base URL and model for OpenAI-compatible endpoints.
- Session API key field.
- Temperature, top-p, max tokens.
- Save Provider.
- Test Provider.
- Clear Session Key.
- Status and resolved model.

API keys are session-only. They must not be written to extension settings, scene caches, prompt packets, run journals, debug exports, or diagnostics.

## Visual System

The visual direction is SillyTavern-native graphite:

- Use SillyTavern theme variables for base background, text, borders, inputs, buttons, popups, and hover states wherever available.
- Let the active SillyTavern theme remain dominant; Recursion should adapt to the host theme instead of forcing a separate palette.
- Use dark neutral greys as a restrained Recursion accent layer when the current theme supports dark mode.
- Use hairline borders and subtle elevation that match SillyTavern popups and extension panels.
- Use compact rows and segmented controls that match SillyTavern control density.
- Teal/cyan for active system signals.
- Amber for attention.
- Green for ready/success.
- Red for provider failures or blocked states.

Avoid:

- A standalone SaaS/dashboard look.
- Neon-heavy cyberpunk styling.
- Purple/blue gradient dominance.
- Ornate fantasy treatment.
- Directive-sized operational density.
- Large decorative cards.
- Cards inside cards.
- Marketing/landing-page composition.

## Empty, Error, And Provider States

Empty states should be short and action-oriented.

Examples:

- No hand yet: `No hand has been composed for this chat.`
- Observe mode: `Observing only. Recursion will not inject prompts.`
- Provider missing: `Utility provider is not ready.`
- Reasoner disabled: `Reasoner disabled. Utility will compose compact packets.`

Provider failures should fail soft. The UI should show the issue, preserve any usable cached scene state, and allow the main generation to continue without Recursion when needed.

Provider fallback states should appear in both the Recursion Bar and Activity Ribbon. Examples:

- `Reasoner failed. Utility composed.`
- `Utility unavailable. Recursion skipped.`
- `Using cached hand.`
- `Provider test failed. Check session key.`

## Mobile Behavior

On narrow viewports:

- Collapse provider/status details into a single menu.
- Keep the mode and hand count visible.
- Prefer one-column viewer layouts.
- Keep buttons icon-first where meaning is familiar, with tooltips or accessible labels.
- Avoid wide tables in the full viewer.

The bar should not cover message input controls, generation controls, or SillyTavern native navigation.

## Accessibility

V1 should support:

- Keyboard-reachable menus and viewer close controls.
- ARIA labels for icon buttons.
- Visible focus states.
- Sufficient contrast for graphite-dark styling.
- Text that does not rely on color alone for state.
- Stable row heights where possible.

## V1 Cuts

Do not ship these in V1:

- Per-card editing.
- User accept/reject workflows for each card.
- Custom user-defined card types.
- Full visible card catalog management.
- Drag-and-drop card ordering.
- A timeline workbench.
- A large always-open dashboard.
- Deep role routing UI for every internal job.
- Popup-based progress spam for normal invisible work.

The first UI should build trust by showing what Recursion did, not by making users operate it manually.
