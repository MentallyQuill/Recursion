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

Progress retains provider capacity failures as provider failures. Fused children show a bundle rejection only when a recorded validation rejection exists; missing rejection details never imply `invalid-card`. Cooldown recovery uses existing progress rows and Stop/Resume controls.

Paused repairs use amber `paused` rows, retaining the current provider cause instead of claiming active repair. An operation time limit offers Retry for unfinished work with a fresh time window; accepted cards remain saved. Ordinary Stop/Resume preserves the existing time budget.

Execution details stay in the existing Progress footer and Last Brief: show the actual pipeline and selected lane, and an explicit requested-to-effective transition when Fused qualification is missing. Provider settings show requested and effective concurrency; time limits remain under Advanced → Execution. These use existing compact control rows and helper text without additional bar badges or notifications.

Recursion is a SillyTavern extension, so its interface should feel native to SillyTavern before it feels branded. The visual identity is compact, graphite-dark, technical, and restrained. It should sit close to the chat surface as quiet operational chrome: useful when inspected, mostly invisible during normal play.

The product should never read as a standalone SaaS dashboard, landing page, or decorative web app. Recursion's UI exists to answer what is active, what the last response used, and which broad behavior settings are available without asking the user to micromanage cards.

Manual mode is still broad control, not card editing. It may let users force selected card families up to `Max Cards`; Refinement cards are mandatory even beyond that cap. Refinement requests automatic scene-analysis review, not a per-card human accept/reject workflow.

Progress explains total hand inclusion with compact authored/generated counts on the hand-selection row. A card-count shortfall is amber with a plain-language reason. Fused family outcomes remain inspectable after reload and stale-run transitions; grouping provider work must never hide delivered card counts.

Use this file together with `docs/design/UI_SPEC.md`, `docs/design/CARD_SYSTEM_SPEC.md`, and `styles/recursion.css`. Update this file whenever the visible design contract changes.

## Colors

Recursion inherits SillyTavern theme variables for the real background, foreground, borders, inputs, buttons, popups, hover states, and typography wherever practical. The hex colors above are the stable Recursion signal colors and dark fallback values used when a host theme variable is unavailable.

- **Primary (#65d6e8):** cyan for active system signals, running work, focus outlines, selected settings, and subtle Recursion identity.
- **Secondary (#d8d8d8):** inherited foreground for normal chrome, labels, icons, and reasoning controls.
- **Tertiary (#a78bfa):** cached-state purple for card or deck rows reused from cache. It is a state color, not a decorative brand gradient.
- **Neutral (#202020):** graphite fallback surface for the root bar and viewer background.
- **Success (#7fcf8a):** ready, done, passing provider checks, and completed Hero Pixel Array blocks.
- **Warning (#ffd479):** review, fallback, repair, retry, or attention states that are not hard failures. Routine cache inspection and successful automatic retries are not warnings by themselves.
- **Error (#ff8a8a):** provider failures, blocked states, and prompt-install failures.

The Pre-process guidance row is labeled `Guidance` regardless of provider lane. A completed stage that falls back to raw card evidence remains amber with a visible explanation. A stale-chat prompt-install failure states that the chat changed before installation.

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

**Recursion Bar:** One compact chat-attached row with power, pipeline selector, mode, adjacent icon-only Pre-process Cards and Post-process Cards controls, Hero Pixel Array/current step, active-only Stop generation button, idle full-rebuild icon button in the same command slot, reasoning chain, Last Brief arrow, and options ellipsis. Both card controls use the same stacked-card outline. A small arrow inset into the front card points left for Pre-process and right for Post-process; its outline uses the theme body color and its fill matches the bar background. Their concise tooltips explain that Pre-process Cards guide the response before generation and Post-process Cards rewrite the response after generation. The Pipeline selector is an icon-only button immediately left of Mode with a compact Segmented/Fused dropdown. Segmented represents independent simple card calls; Fused uses a thick combined-layer icon, almost cube-like, as if multiple card layers have been compressed into one bundle. The Stop generation button appears while Recursion owns an active prompt-preparation or host-generation turn; it uses a square stop icon and pauses durable Recursion work after aborting the active call, while the same unified stop path also stops SillyTavern generation and clears Recursion prompt lanes. The idle full-rebuild icon queues a one-shot rebuild for the next swipe without starting work. Its accessible state changes from `Rebuild all Recursion work on the next swipe` to `Full rebuild on next swipe: Queued`, and a second press cancels it. When no work is active, the current-step slot may show quiet punctuated standby copy such as `Ready for Recursion.`, `Recursion prompt ready.`, `Turn work standing by.`, or `Manual scope ready.` for roughly four seconds; this is display-only and must not create Hero Pixel Array blocks or progress rows. On mobile, the current-step slot is hidden in the bar and mirrored into a compact status drawer below it so controls remain on one row. The bar is neutral graphite chrome; it should not become a message strip or dashboard.

**Contextual progress actions:** Every progress row reserves one 24px action slot and renders at most one direct icon button. A running executable owner shows Stop; a paused frontier shows Resume; a blocking failed owner shows Retry; completed, cached, or the earliest meaningful stale owner shows Reprocess; and a queued owner shows cancel. Pending, blocked, skipped, validation-only Fused children, and Unified child-detail rows show no button. Segmented card children, the Fused parent, the Unified Post-process parent, and Progressive category parents own their respective actions. Concurrent Segmented work exposes only one Stop. The control is cyan, while the row keeps its normal green completed, purple cached, red failed, or other state color.

The action is never hidden behind row expansion, a confirmation flap, or a second menu. The icon vocabulary is square for Stop, play for Resume, rotate for Retry, branching refresh for Reprocess, and x for cancel. Every action has a matching `title`, `aria-label`, visible keyboard focus, and touch-safe behavior. On narrow screens, reason and metadata text truncate before the fixed action slot can shrink; mobile does not add labels or competing buttons.

**Post-process writing and comparison:** Keep Writer, Editing scope, Review before applying, and Deck Style inside the existing Post-process panel. Reveal profile output/sampling under Advanced. Use compact native graphite inputs, visible validation, and Copy to edit for bundled style. Comparison uses readable original/revised text, optional highlighted changes, plain writer/scope/state labels, and source-bound actions. Preserve keyboard focus and chat scroll; make stale actions unavailable with a concise reason. Waiting for review releases generation controls and adds no dashboard or extra top-level toolbar.

**Pre-process and Post-process Cards dropdowns:** Treat both phases as one compact deck-editor family. The Pre-process panel title is `Pre-Process Cards`. They share header, deck-selector, category, card-row, disclosure, state-marker, and action-rail geometry. Both card-row types show a concise description beneath the card name. Card descriptions wrap to natural height without line clamps, ellipsis, per-card scrolling, or tooltip-only disclosure. Category descriptions never occupy visible header space; expose them as hover titles when tooltips are enabled and retain them in accessible disclosure labels. Bundled Pre-process card descriptions are concise display copy while their canonical prompt text remains unchanged. Post-process keeps its binary card state, while Pre-process keeps its Auto four-state and Manual three-state cycles. Post-process category headers have no visibility eye or state-marker column; card-row eyes and the two header bulk eyes own visible On/Off control. The Post-process global On/Off control is an icon-only power symbol matching the main bar's power language. When globally Off, the header summary reads `Off` rather than describing preserved card selections as active. The compact Apply and Flow segmented controls sit beside it immediately before the open-eye and slashed-eye bulk actions, and every segment has a visible graphite hover/focus highlight. Editable Post-process decks use the same `Categories` plus row, per-category create-card action, and distinct category/card drag handles as Pre-process. Their category and card action rails use the same ordering, fixed width, and pre-drag spacing as Pre-process. Both phases use the same deck-delete confirmation: the action rail to the right of the selector becomes an inline input, `type delete` hint, disabled-until-valid confirm icon, and cancel icon; the accepted confirmation is the word `delete`, case-insensitively. Bundled deck structure remains read-only, but operator card state and both bulk eyes remain interactive without first duplicating the deck. Active deck selection, card/category state, and per-deck category disclosure are global extension settings that survive dropdown closure, chat changes, remounts, and page reloads.

Both card phases bind one shared pointer-drag engine for mouse, pen, and short-hold touch gestures. Do not add a phase-specific native HTML drag or touch controller.

Refinement uses a 15px outlined faceted gem, with a distinct silhouette from Priority's eye-plus. Refinement shares Priority's bright-cyan title, icon, border, and inset highlight. Its short label is `Refinement`; tooltip: `Always included. Reviews and improves this card's scene analysis before narration.` Auto cycles Off, Active, Priority, Refinement; Manual cycles Off, Active, Refinement. Counts distinguish Priority and Refinement while both count as active. Bulk enable clears both to Active. No new provider or dashboard surface is added.

**Icon buttons:** Familiar controls should be icon-first, 24px square, with accessible labels and tooltips. Power, pipeline, mode, and idle Regenerate use muted foreground, not bright brand color. Active Stop generation may use a muted error tint, but it must stay compact and chrome-like rather than becoming a large alert.

**Hero Pixel Array:** The primary state indicator. Running is cyan, done is green, cached is purple, warning is amber, failed is red, pending is empty muted. Respect reduced-motion preferences and never rely on animation alone.

**Progress menu:** A compact Codex-like task list attached to the Hero Pixel Array. Rows update in place, support nested card-generation children, and share the same normalized `progressRun.steps[]` model as the pixel array. Warning and failed rows include one compact explanation block: a wrapped, sanitized reason in the matching amber or red state color, followed by an optional subdued `Try:` line when the failure descriptor contains a meaningful user action. Reason and action are visible without hover. Tooltips and accessibility text repeat them but are supplementary. Stable internal failure codes remain available in diagnostics and do not appear in ordinary progress copy. For Fused, the bundle call is the parent row only; child rows represent actual accepted, repaired, cached, fallback, warning, or failed card-family outcomes, not the bundle role itself or speculative requested-card placeholders.

Selected authored Pre-process cards appear by their saved names as child rows under `Selecting turn hand`. These rows read `included`, carry no provider mark or action, and come only from the current execution's completed or reused hand checkpoint. A new pending hand must not display the previous hand's cards. Authored rows do not add Hero Pixel Array blocks or pretend to be model calls.

**Last Brief dropdown:** A read-only trust surface. Collapsed rows use category icons, compact one-line card text, and subtle metachips. Expanded rows show the full card text at natural height with no character cap, ellipsis, or nested card scroll; the dropdown/list remains the single scroll surface. Priority is the only strong chip color.

**Settings panel:** Three tabs: Play, Providers, Advanced. Keep normal-play controls high level in a Play Behavior disclosure, provider lanes collapsible, and Advanced grouped into Injection, UI, and Diagnostics disclosures. Provider lanes show compact derived capability labels (`Ready`, `Untested`, `Unhealthy`, or `Configure`), never a separate enable switch. Provider field commits autosave only the changed field and preserve the open disclosure. Disable advanced commands that have no V1 runtime handler instead of showing fake working controls.

Play Behavior places `Selection variety` (Off, Low, Medium, High; default Low) and `Card cooldown (turns)` (0..10; default 0) beside the card budgets. Reuse compact control rows and one subdued helper: Auto only, Manual ignores these settings, Priority and Refinement cards are exempt, zero disables cooldown, and shortages produce smaller hands. Tooltips explain that variety changes at most one optional slot among relevant alternatives. Keep selection details in existing inspection surfaces; add no permanent bar badge.

**Full viewer:** An observatory, not a play surface. Use it for Now, Deck, Card selection, Activity, Prompt Packet, Settings, and Providers. It can be larger than the bar menus, but it should remain utilitarian and dismissible. Deck details display the complete stored card summary and body at natural height without display character caps or added ellipses; secret redaction remains active. Show the body once; render a separate summary only when it is present and differs from the displayed body after whitespace trimming and secret redaction.

Each completed Refinement target keeps its outcome and revision count in the existing Deck detail. Beneath it, show the final `Satisfied` or `Not applicable` assessment as subdued plain text (up to 400 characters), with up to three message references and three supporting card IDs in existing compact reference rows. These inspector details wrap naturally and update when only the assessment changes. Keep raw review findings out of the Viewer and keep Last Brief limited to its compact outcome chip.

## Do's and Don'ts

- Do inherit SillyTavern theme variables before inventing local styling.
- Do keep Recursion chrome compact, stable, and readable at toolbar density.
- Do use cyan only for active system identity, running work, selection, or focus.
- Do use amber for repairable attention, green for success, purple for cached, and red only for blocked or failed states.
- Do reconcile Fused family rows with individual repair stages. Successful repairs and retries read as normal completion (or cached reuse), without recovery labels, historical rejection text, retry suggestions, or recovery counters in the progress menu. Keep recovery accounting and allowlisted rejection codes in diagnostics. Unresolved failures, pending repairs, and degraded results retain their relevant state and explanation; successful recovery must not leave the parent or Hero Pixel Array amber or red.
- Do keep progress, packet, and card inspection surfaces privacy-safe and free of raw provider output, secrets, hidden reasoning, stack traces, and unrelated diagnostics.
- Do make every icon-only control keyboard reachable and ARIA-labeled.
- Do preserve reduced-motion behavior for all progress and block animations.
- Don't build a standalone dashboard, landing page, decorative hero, or marketing-style interface.
- Don't expose per-card micromanagement in V1.
- Don't add decorative gradient blobs, broad purple-blue gradients, neon-heavy cyberpunk styling, ornate fantasy styling, or orange status branding.
- Don't put cards inside cards or make page sections look like floating cards.
- Don't let compact button text, chip text, row labels, or prompt packet text overflow their containers on mobile.

Export Diagnostics downloads a timestamped `recursion-diagnostics-*.json` file on desktop and mobile. It exports the runtime-sanitized payload without clipboard access or operating-system-specific behavior. The browser controls where the file is saved.


Post-process retains its latest source-bound outcome in the existing writing panel even after Pre-process activity begins. Distinguish preparing, writing, awaiting review, applied, no change, canceled, and failed. A failed outcome preserves a concise safe reason and directs the user to Progress for retry; it does not leave running activity behind or expose provider bodies. Awaiting review points to Compare / Review revisions. In the comparison dialog, explain that Use revision adds and selects a new swipe while the original remains available, or replaces the selected response when Replace is selected. Keep these as compact helper lines, with error red and awaiting-review amber; add no dashboard or permanent notification.
