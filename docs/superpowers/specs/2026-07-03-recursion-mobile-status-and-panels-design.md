# Recursion Mobile Status And Panels Design

## Purpose

Recursion's desktop bar can afford a compact current-step phrase beside the Hero Pixel Array. Mobile cannot: the status text competes with the stop button, reasoning controls, Last Brief arrow, and options button, and it can push the right-side controls onto a second row.

This design keeps one Recursion UI across desktop and mobile while changing mobile presentation rules. Desktop keeps the inline current-step text. Mobile keeps the same controls and panel content, but moves glanceable status into a compact drawer below the bar and makes all expanding panels obey mobile viewport, typography, and one-column layout constraints.

## Goals

- Keep desktop behavior visually unchanged.
- Keep mobile users on the same conceptual UI: same controls, same panels, same content, same triggers.
- Prevent mobile bar wrapping caused by inline status text.
- Preserve the Hero Pixel Array as the primary compact state signal.
- Show current-step text on mobile without making the bar a message strip.
- Make progress, Last Brief, Cards, Settings, Pipeline, and Mode panels fit mobile viewports without clipped headers, footers, or right edges.
- Respect `visualViewport` offset and size when browser chrome shifts.
- Preserve reduced-motion behavior.

## Non-Goals

- No content redesign for Progress, Last Brief, Cards, Settings, Pipeline, or Mode.
- No new desktop layout.
- No new status model, activity model, or runtime event shape.
- No mobile-only feature fork that teaches a different workflow.
- No automatic full progress popover for normal work.

## Recommended Approach

Use a mobile-only status drawer plus shared responsive panel shell rules.

Desktop keeps:

```text
[power] [pipeline] [mode] [cards] | [Hero Pixel Array] Current step... [stop] [reasoning] v | ...
```

Mobile becomes:

```text
[power] [pipeline] [mode] [cards] | [Hero Pixel Array] [stop] [reasoning if fits] v | ...
[Current step drawer when active]
```

The mobile drawer renders the same text that desktop renders in `.recursion-current-step`. It is presentation only: no new runtime state, no new progress rows, and no new Hero Pixel Array blocks.

## Bar Contract

At `max-width: 720px`, `.recursion-bar` must stay one row and must not wrap.

The mobile bar should preserve, in order of importance:

1. Power.
2. Pipeline.
3. Mode.
4. Cards.
5. Hero Pixel Array.
6. Active Stop generation button.
7. Last Brief arrow.
8. Options ellipsis.
9. Reasoning chain, if the viewport can fit it without wrapping.

The inline `.recursion-current-step` remains in the DOM for desktop and accessibility continuity, but it is visually hidden on mobile. The activity trigger stays a button around the Hero Pixel Array so tapping the array still opens the full progress popover.

If the reasoning chain cannot fit on very narrow widths, CSS may compress its footprint. Relocating the reasoning chain behind another surface is out of scope for this pass because it would teach a different mobile control path.

## Mobile Status Drawer

The drawer is a compact region below the bar, inside `.recursion-root`, with a dedicated selector such as `[data-recursion-mobile-status-drawer]`.

Behavior:

- Hidden on desktop.
- Hidden on mobile when there is no current-step or standby text.
- Shows on mobile when `currentStepTextForRender(view, model)` returns text and no major panel is open.
- Mirrors active work text such as `Installing Recursion prompt...`.
- May show transient control acknowledgments such as `Reasoning Level: High` using the existing two-second transient path.
- Uses existing standby timeout behavior for idle phrases such as `Recursion prompt ready.`.
- Collapses when text clears, work settles, the standby timer expires, or a major panel opens.
- Warning/error current-step text may remain until superseded if the underlying text remains available.

Interaction:

- The drawer is not a button and does not replace the Hero Pixel Array trigger.
- Tapping the Hero Pixel Array opens the full progress popover as it does today.
- Opening Progress, Last Brief, Cards, Settings, Pipeline, or Mode hides the drawer to avoid stacked mobile chrome.
- Closing a panel lets the drawer reappear on the next render if current status text is still active.

Motion:

- Default animation is a short slide/fade from the bar, around 140-180 ms.
- `prefers-reduced-motion: reduce` disables animation and transition.

Visual:

- Neutral graphite surface, hairline top border, no broad state color.
- 11px to 11.5px text.
- One line with ellipsis for long text.
- No large alert styling.
- Red/amber should remain in Hero Pixel Array or disclosed menus, not become drawer background.

Accessibility:

- The drawer should use polite status semantics only if it does not create duplicate announcements with the existing current-step live region.
- Preferred implementation: keep one live region source by moving or mirroring `role="status"` carefully. If both inline and drawer text are present in DOM, mobile CSS must not cause duplicate screen-reader announcements.
- The visible mobile drawer text must match the accessible status text.

## Panel Shell Contract

All mobile panels should use the same geometry contract:

- `position: fixed`.
- Left edge clamped to `visualViewport.offsetLeft`.
- Top edge clamped below the bar and at least `visualViewport.offsetTop`.
- Width clamped to visible viewport width and the Recursion bar width.
- Max height clamped to visible viewport bottom minus a small gutter.
- Header and footer remain visible when a panel has them.
- The main body/list becomes the scroll surface.
- `-webkit-overflow-scrolling: touch` on scrollable lists.
- Opening one major panel closes competing panels.

Major panels:

- Progress popover.
- Last Brief dropdown.
- Cards panel.
- Settings panel.

Compact menus:

- Pipeline menu.
- Mode menu.

Progress should be full-width on mobile instead of capped to 352px. On desktop, progress keeps the 352px width.

Pipeline and Mode remain compact anchored menus when they fit. When the visual viewport is narrower than the menu, they clamp to the viewport width and keep the same content.

## Mobile Typography

Mobile panels should reduce chrome density without changing content:

- Root/panel default: 11.5px.
- Helper/meta/chips: 10px.
- Panel titles and disclosure toggles: 11.5px to 12px.
- Prompt packet monospace: 10.5px to 11px.

No viewport-scaled type. Letter spacing remains `0`.

## Mobile Layout Rules

Cards panel:

- Desktop keeps two-column family/sub-item rows.
- Mobile uses one-column family rows: family toggle first, sub-items below.
- Header can wrap; `Cards`, selected summary, and `All` stay visible.
- Sub-item labels and descriptions wrap naturally.

Last Brief:

- Desktop keeps category/kind column plus card text column.
- Mobile uses one-column rows: kind/category line first, card text and chips below.
- Expanded full text remains natural height with the dropdown/list as the only scroll surface.
- Prompt Packet panel stays inside the Last Brief surface and remains scrollable.

Settings:

- Existing Play, Providers, Advanced tabs remain.
- Field grids collapse to one column.
- Provider profile lists and fetched model selectors stay inside the provider lane flow.
- Footer remains visible when present.
- Autosave behavior does not change.

Progress:

- Header title/subtitle may wrap.
- Footer remains visible.
- Step labels can ellipsize on one line; explanatory reason remains tooltip/title or metadata, not extra bar text.
- Child rows keep their existing capped scroll behavior.

Pipeline and Mode:

- Same row content.
- Minimum touch target remains about 34px high.
- Width clamps to viewport on very narrow screens.

## Data Flow

The existing flow stays authoritative:

```text
runtime.view()
  -> createRecursionViewModel(view)
  -> progressRun.currentStepText / standbyStatusText
  -> currentStepTextForRender(view, model)
  -> desktop inline current-step text
  -> mobile status drawer text
```

The drawer must not read raw runtime activity directly. It consumes the same rendered text as the desktop current-step slot so transient acknowledgments, standby timeout, and active progress wording stay synchronized.

Panel geometry continues to flow through `syncFloatingPanelGeometry()`. The implementation should centralize mobile width and height calculations there rather than duplicating viewport math per panel.

## Error Handling And Edge Cases

- If `visualViewport` is missing, fall back to `innerWidth`, `innerHeight`, and document client size.
- If the bar rect is unavailable or has zero width, leave existing CSS fallback in place.
- If status text is empty, drawer is hidden and removed from focus order.
- If a panel is open, drawer is hidden even if current status text exists.
- If a status string is long, drawer uses ellipsis and the full progress popover remains available.
- If browser chrome changes viewport offset while a panel is open, geometry resyncs on `visualViewport.resize` and `visualViewport.scroll`.
- Reduced motion disables drawer and panel transition effects.
- Existing desktop tests around current-step text should keep passing.

## Testing Requirements

Focused tests should cover:

- Mobile bar does not wrap at 640px and 320px visual viewport widths.
- Mobile inline current-step is visually hidden while drawer shows the same text.
- Drawer hides when status text clears.
- Drawer hides while Progress, Last Brief, Cards, Settings, Pipeline, or Mode is open.
- Progress popover is full-width on mobile and remains 352px on desktop.
- Last Brief, Cards, and Settings clamp to mobile `visualViewport` width and height.
- Cards panel has mobile one-column CSS rules.
- Last Brief rows have mobile one-column CSS rules.
- Settings/provider grids have mobile one-column CSS rules.
- `prefers-reduced-motion` disables drawer animation.

Suggested verification commands:

```powershell
node tools/scripts/test-ui.mjs
npm.cmd test
```

If live proof is needed, use a mobile-width Playwright smoke after the served SillyTavern extension copy contains the change.

## Documentation Updates

Implementation should update:

- `DESIGN.md`: mobile drawer and responsive panel contract.
- `docs/design/UI_SPEC.md`: normative mobile behavior, panel geometry, typography, and drawer semantics.
- `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md`: only if the reference preview or tests assert the old mobile inline status layout.

## Implementation Scope

Expected implementation files:

- `src/ui.mjs`: mobile drawer DOM, shared current-step rendering, panel-open drawer hiding, mobile progress width in geometry sync.
- `styles/recursion.css`: mobile no-wrap bar, drawer styles, mobile panel typography/layout rules, one-column panel grids.
- `tools/scripts/test-ui.mjs`: focused regression coverage for drawer and mobile panels.
- `DESIGN.md`, `docs/design/UI_SPEC.md`, and possibly `docs/design/RECURSION_BAR_IMPLEMENTATION_REFERENCE.md`: docs/spec alignment.

## Acceptance Criteria

- Desktop bar remains unchanged in behavior and visual hierarchy.
- Mobile bar stays a single row without status text pushing controls down.
- Mobile users still see current status through the drawer.
- The Hero Pixel Array remains the progress entry point.
- Expanding panels fit the visible mobile viewport and do not clip headers/footers.
- Panel content remains the same as desktop content, with only responsive typography and layout adjustments.
- Reduced-motion users do not receive drawer animation.
- Tests prove the mobile layout contract.
