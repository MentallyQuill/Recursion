# Recursion UI Spec

## UI Goals

Recursion should feel mostly invisible during normal play. The interface exists to answer three questions quickly:

- Is Recursion active?
- What did it use for the last response?
- What high-level behavior can I adjust without managing cards by hand?

The UI should be modern, compact, and graphite-dark. It should read as a technical status/control surface, not a campaign dashboard, lore editor, or prompt workbench.

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

Visible status fields:

- Runtime status: ready, observing, compiling, paused, provider issue, disabled.
- Mode: off, observe, auto.
- Last hand count.
- Current provider lane for active work.
- Reasoner state: idle, composing, unavailable, disabled.
- Last run freshness when useful.

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
- Activity: bounded run journal, errors, refreshes, reasoner trigger reasons.
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
- Reasoner Use: Off, Auto, Always Compose.
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

The visual direction is a graphite control panel:

- Dark neutral greys as the base.
- Hairline borders and subtle elevation.
- Compact rows and segmented controls.
- Teal/cyan for active system signals.
- Amber for attention.
- Green for ready/success.
- Red for provider failures or blocked states.

Avoid:

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

The first UI should build trust by showing what Recursion did, not by making users operate it manually.
