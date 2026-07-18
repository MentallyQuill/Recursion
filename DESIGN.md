---
version: alpha
name: Recursion
description: SillyTavern-native graphite design system for the Recursion pre-alpha extension.
colors:
  primary: "#65d6e8"
  secondary: "#d8d8d8"
  tertiary: "#a78bfa"
  neutral: "#202020"
  surface: "#202020"
  surface-panel: "#242424"
  surface-elevated: "#161616"
  border: "#555555"
  on-surface: "#d8d8d8"
  on-muted: "#a8a8a8"
  state-running: "#65d6e8"
  state-success: "#7fcf8a"
  state-cached: "#a78bfa"
  state-warning: "#ffd479"
  state-error: "#ff8a8a"
  state-disabled: "#737373"
typography:
  chrome:
    fontFamily: 'var(--mainFontFamily, "Noto Sans", sans-serif)'
    fontSize: 12.5px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: 0px
  chrome-compact:
    fontFamily: 'var(--mainFontFamily, "Noto Sans", sans-serif)'
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: 0px
  helper:
    fontFamily: 'var(--mainFontFamily, "Noto Sans", sans-serif)'
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: 0px
  panel-title:
    fontFamily: 'var(--mainFontFamily, "Noto Sans", sans-serif)'
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0px
  packet-mono:
    fontFamily: 'Consolas, ui-monospace, SFMono-Regular, monospace'
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0px
rounded:
  none: 0px
  xs: 2px
  sm: 3px
  md: 5px
  lg: 6px
  panel: 8px
  full: 999px
spacing:
  micro: 2px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 12px
  row-compact: 24px
  row-normal: 30px
  panel-header: 34px
  hero-block: 4px
  hero-gap: 2px
components:
  recursion-root:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.chrome}"
    padding: 0px
  recursion-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.chrome}"
    rounded: "{rounded.none}"
    height: 30px
    padding: 0 8px 0 2px
  icon-button:
    backgroundColor: transparent
    textColor: "{colors.on-surface}"
    typography: "{typography.chrome}"
    rounded: "{rounded.md}"
    size: 24px
  popover:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-surface}"
    typography: "{typography.chrome}"
    rounded: "{rounded.panel}"
    padding: 0px
  tab-button:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-surface}"
    typography: "{typography.chrome}"
    rounded: "{rounded.md}"
    height: 24px
    padding: 4px 8px
  input:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.on-surface}"
    typography: "{typography.chrome}"
    rounded: "{rounded.md}"
    height: 24px
    padding: 3px 6px
  hero-block-empty:
    backgroundColor: transparent
    textColor: "{colors.on-muted}"
    rounded: "{rounded.none}"
    size: 4px
  hero-block-running:
    backgroundColor: "{colors.state-running}"
    textColor: "{colors.surface}"
    rounded: "{rounded.none}"
    size: 4px
  hero-block-success:
    backgroundColor: "{colors.state-success}"
    textColor: "{colors.surface}"
    rounded: "{rounded.none}"
    size: 4px
  hero-block-cached:
    backgroundColor: "{colors.state-cached}"
    textColor: "{colors.surface}"
    rounded: "{rounded.none}"
    size: 4px
  hero-block-warning:
    backgroundColor: "{colors.state-warning}"
    textColor: "{colors.surface}"
    rounded: "{rounded.none}"
    size: 4px
  hero-block-error:
    backgroundColor: "{colors.state-error}"
    textColor: "{colors.surface}"
    rounded: "{rounded.none}"
    size: 4px
---

# Recursion Design

This file follows the [google-labs-code DESIGN.md format](https://github.com/google-labs-code/design.md): front matter contains machine-readable design tokens, and the markdown body explains how to apply them. When tokens and prose disagree, the tokens are the precise values and the prose explains intent.

## Overview

Recursion is a SillyTavern extension, so its interface should feel native to SillyTavern before it feels branded. The visual identity is compact, graphite-dark, technical, and restrained. It should sit close to the chat surface as quiet operational chrome: useful when inspected, mostly invisible during normal play.

The product should never read as a standalone SaaS dashboard, landing page, or decorative web app. Recursion's UI exists to answer what is active, what the last response used, and which broad behavior settings are available without asking the user to micromanage cards.

Manual mode is still broad control, not card editing. It may let users force selected card families up to `Max Cards`, but it should not become a per-card writing, ranking, review, or accept/reject workflow.

Use this file together with `docs/design/UI_SPEC.md`, `docs/design/CARD_SYSTEM_SPEC.md`, and `styles/recursion.css`. Update this file whenever the visible design contract changes.

## Colors

Recursion inherits SillyTavern theme variables for the real background, foreground, borders, inputs, buttons, popups, hover states, and typography wherever practical. The hex colors above are the stable Recursion signal colors and dark fallback values used when a host theme variable is unavailable.

- **Primary (#65d6e8):** cyan for active system signals, running work, focus outlines, selected settings, and subtle Recursion identity.
- **Secondary (#d8d8d8):** inherited foreground for normal chrome, labels, icons, and reasoning controls.
- **Tertiary (#a78bfa):** cached-state purple for card or deck rows reused from cache. It is a state color, not a decorative brand gradient.
- **Neutral (#202020):** graphite fallback surface for the root bar and viewer background.
- **Success (#7fcf8a):** ready, done, passing provider checks, and completed Hero Pixel Array blocks.
- **Warning (#ffd479):** review, fallback, repair, retry, or attention states that are not hard failures. Routine cache inspection after source changes is not a warning by itself.
- **Error (#ff8a8a):** provider failures, blocked states, and prompt-install failures.

Warning and error colors apply to the corresponding user-facing status message
text as well as Hero Pixel Array blocks and progress dots. This includes the
desktop current-step text, mobile status drawer, progress header, and affected
progress-row labels. Do not recolor normal chrome or assistant prose.

Keep the bar itself mostly neutral. Let the Hero Pixel Array and disclosed menus carry state color. Avoid broad cyan washes, neon styling, purple-blue gradient dominance, and orange status treatment that competes with SillyTavern dialogue.

## Typography

Use the active SillyTavern font family through `--mainFontFamily` whenever available. Recursion chrome uses explicit compact sizing so it does not balloon when the host chat theme uses large prose text.

- **Chrome:** 12.5px for the bar, menus, settings, controls, and default panel text.
- **Chrome compact:** 11.5px for current-step text, mode-choice names, progress rows, and compact card text.
- **Helper:** 10px for subdued tips, chip labels, status metadata, provider marks, and keyboard hints.
- **Panel title:** 12px semi-bold for popover titles and settings group headings.
- **Packet mono:** 11px monospace for copied or inspected prompt packet text.

Do not use viewport-scaled type. Keep letter spacing at `0px` unless a host-native element already requires otherwise.

## Layout

Recursion uses compact, stable, host-attached layouts. Prefer one dense row, disclosed popovers, and inspector surfaces over persistent dashboards.

The Recursion Bar should stay around 30 to 38px high. Icon buttons and compact controls should be 24 to 28px tall. The Hero Pixel Array uses 4px blocks, 2px gaps, three rows, and deterministic top-to-bottom column filling. Popovers attach to the bar, align predictably, and should not resize the transcript repeatedly during status changes.

Use small spacing steps: 2px for pixel/grid gaps, 4px for micro-adjustments, 6px for adjacent controls, 8px for standard panel padding, 10px to 12px when text needs breathing room. Avoid large gutters, oversized hero sections, marketing composition, and cards inside cards.

On narrow viewports, preserve the power toggle, pipeline icon, mode icon, card scope icon, Hero Pixel Array, active stop button when visible, last-brief arrow, and ellipsis first. Do not let current-step text wrap the bar; mobile moves that text into a compact status drawer below the bar while the Hero Pixel Array remains the progress trigger. Collapse details into menus and keep the bar away from SillyTavern message input controls. Expanding panels should use the visible mobile viewport, clamp below the bar, keep headers and footers visible, and switch dense grids to one-column layout without changing panel content.

## Elevation & Depth

Depth is quiet and functional. Use SillyTavern-like hairline borders, dark translucent panels, and modest popover shadows. The root bar should not look like a floating card. The Last Brief dropdown, progress menu, mode menu, settings menu, and viewer may use subtle elevation to separate themselves from chat content.

Use color, borders, row grouping, and compact state indicators before heavy shadows. Avoid glowing panels. Glow is acceptable only as a small active-state affordance around running Hero Pixel blocks, focus outlines, or selected controls.

## Shapes

The shape language is compact and engineered.

- Use square 4px Hero Pixel Array blocks with no rounding.
- Use 5px radius for icon buttons, chips, tabs, small inputs, and compact controls.
- Use 6px radius for standard inputs and viewer cards.
- Use 8px radius only for popover bottoms, viewer shells, and larger framed surfaces.
- Use full rounding only for circular status dots, scroll thumbs, or native pill-like indicators.

Do not introduce large rounded cards or soft marketing panels. Keep cards at 8px radius or less.

## Components

**Recursion Bar:** One compact chat-attached row with power, pipeline selector, mode, icon-only card scope, Hero Pixel Array/current step, active-only Stop generation button, idle Regenerate icon button in the same command slot, reasoning chain, Last Brief arrow, and options ellipsis. The Pipeline selector is an icon-only button immediately left of Mode with a compact Standard/Rapid/Fused dropdown. Fused uses a thick combined-layer icon, almost cube-like, as if multiple card layers have been compressed into one bundle. The Stop generation button appears while Recursion owns an active prompt-preparation or host-generation turn, including immediate Force Regenerate runs; it uses a square stop icon and calls the unified stop path that stops SillyTavern generation, aborts Recursion work, and clears Recursion prompt lanes. The idle Regenerate icon starts a fresh regeneration for the current turn, then immediately yields the slot to Stop while normal progress/status feedback runs. When no work is active, the current-step slot may show quiet punctuated standby copy such as `Ready for Recursion.`, `Recursion prompt ready.`, `Scene deck standing by.`, or `Manual scope armed.` for roughly four seconds; this is display-only and must not create Hero Pixel Array blocks or progress rows. On mobile, the current-step slot is hidden in the bar and mirrored into a compact status drawer below it so controls remain on one row. The bar is neutral graphite chrome; it should not become a message strip or dashboard.

**Icon buttons:** Familiar controls should be icon-first, 24px square, with accessible labels and tooltips. Power, pipeline, mode, and idle Regenerate use muted foreground, not bright brand color. Active Stop generation may use a muted error tint, but it must stay compact and chrome-like rather than becoming a large alert.

**Hero Pixel Array:** The primary state indicator. Running is cyan, done is green, cached is purple, warning is amber, failed is red, pending is empty muted. Respect reduced-motion preferences and never rely on animation alone.

**Progress menu:** A compact Codex-like task list attached to the Hero Pixel Array. Rows update in place, support nested card-generation children, and share the same normalized `progressRun.steps[]` model as the pixel array. Warning and failed rows include one wrapped, sanitized reason subline in the matching amber or red state color; a tooltip is supplementary, never the only explanation. For Fused, the bundle call is the parent row only; child rows represent actual accepted, repaired, cached, fallback, warning, or failed card-family outcomes, not the bundle role itself or speculative requested-card placeholders.

**Last Brief dropdown:** A read-only trust surface. Collapsed rows use category icons, compact one-line card text, and subtle metachips. Expanded rows show the full card text at natural height with no character cap, ellipsis, or nested card scroll; the dropdown/list remains the single scroll surface. Priority is the only strong chip color.

**Settings panel:** Three tabs: Play, Providers, Advanced. Keep normal-play controls high level in a Play Behavior disclosure, provider lanes collapsible, and Advanced grouped into Injection, UI, and Diagnostics disclosures. Provider lanes show compact derived capability labels (`Ready`, `Untested`, `Unhealthy`, or `Configure`), never a separate enable switch. Provider field commits autosave only the changed field and preserve the open disclosure. Disable advanced commands that have no V1 runtime handler instead of showing fake working controls.

**Full viewer:** An observatory, not a play surface. Use it for Now, Deck, Activity, Prompt Packet, Settings, and Providers. It can be larger than the bar menus, but it should remain utilitarian and dismissible.

## Do's and Don'ts

- Do inherit SillyTavern theme variables before inventing local styling.
- Do keep Recursion chrome compact, stable, and readable at toolbar density.
- Do use cyan only for active system identity, running work, selection, or focus.
- Do use amber for repairable attention, green for success, purple for cached, and red only for blocked or failed states.
- Do keep progress, packet, and card inspection surfaces privacy-safe and free of raw provider output, secrets, hidden reasoning, stack traces, and unrelated diagnostics.
- Do make every icon-only control keyboard reachable and ARIA-labeled.
- Do preserve reduced-motion behavior for all progress and block animations.
- Don't build a standalone dashboard, landing page, decorative hero, or marketing-style interface.
- Don't expose per-card micromanagement in V1.
- Don't add decorative gradient blobs, broad purple-blue gradients, neon-heavy cyberpunk styling, ornate fantasy styling, or orange status branding.
- Don't put cards inside cards or make page sections look like floating cards.
- Don't let compact button text, chip text, row labels, or prompt packet text overflow their containers on mobile.
