# Pre-/Post-process Card Panel Parity Design

**Date:** 2026-07-19

**Status:** Approved design

## Goal

Make the Pre-process Cards and Post-process Cards dropdowns read as two phases
of one card system. They use the same compact SillyTavern-native panel
composition, deck controls, category structure, card-row treatment, bulk state
controls, and paired main-bar icon language.

This is a focused UI and interaction repair. It does not merge the independent
Pre-process and Post-process deck data contracts or change their runtime
semantics.

## Panel Structure

Both dropdowns use the Pre-process Cards panel as the visual reference:

1. compact title/header strip;
2. deck selector and deck actions;
3. category rows with disclosure, summary, and edit actions;
4. full-width card rows;
5. one panel-owned vertical scroll surface.

Post-process Cards must stop using its separate settings-form/list
composition. Shared rendering primitives may be extracted where that reduces
drift, but Pre-process and Post-process actions must continue writing only to
their own stores.

## Post-process Header Controls

The Post-process header orders its controls from left to right as:

```text
Post-process Cards  [deck summary]  [Off/On] [As Swipe | Replace] [Unified | Progressive] [eye] [eye-off]
```

- `Off/On` remains the global Post-process feature gate.
- `As Swipe | Replace` is a compact paired segmented toggle.
- `Unified | Progressive` is a compact paired segmented toggle.
- Both groups expose accessible group labels and pressed state.
- The open-eye bulk action enables every runnable card in the active
  Post-process Deck.
- The slashed-eye bulk action disables every runnable card in the active
  Post-process Deck.
- Bulk actions are disabled when they would make no change.
- The bundled starter deck remains read-only. Its bulk actions explain that
  the deck must be duplicated before editing.
- The global feature gate, Apply, Flow, and both bulk eye actions stay in the
  upper-right action cluster.

Post-process cards retain their current binary enabled/disabled contract. This
design does not introduce Pre-process Priority semantics into Post-process
Cards.

## Card and Category Layout

Post-process category and card rows adopt the corresponding Pre-process
geometry and styling:

- the category disclosure affordance occupies the same leading column;
- category name and runnable-card summary use the same text hierarchy;
- editable action clusters align to the right;
- expanded cards render as full-width rows beneath the category;
- card names and descriptions use the same compact typography and spacing;
- enabled/disabled state remains visible through the eye glyph and row state;
- editable category/card ordering retains mouse, touch-hold, and keyboard
  support.

## Pre-process Interaction Repair

The integration must restore these existing behaviors:

- Auto mode card click cycles `off -> active -> priority -> off`.
- Manual mode card click cycles `off -> active -> off`.
- The header open-eye action sets all runnable cards to normal Active and
  clears Priority.
- The header slashed-eye action sets all runnable cards Off.
- Category disclosure remains independent from category action controls.

The repair must address the integration root cause rather than bypassing the
shared event or settings path with panel-local compatibility code.

## Main-bar Card Icons

Pre-process Cards and Post-process Cards use one shared composite icon:

1. the existing 17-by-17 stacked-card outline;
2. the supplied arrow path `M17,12,5,21V3Z`, scaled into the foremost card;
3. right-facing orientation for Post-process;
4. the same arrow rotated 180 degrees for Pre-process.

The arrow outline uses the active SillyTavern grey-white foreground token. The
arrow fill uses the Recursion bar background token (`--recursion-bg`) so the
arrow remains legible inside the card outlines without becoming a solid accent
shape.

The composite remains inside the existing 24-by-24 button hit area. Accessible
labels remain `Pre-process Cards` and `Post-process Cards: On|Off`; direction is
never conveyed by the graphic alone.

## Responsive and Accessibility Contract

- The header action cluster may wrap or compact below the existing mobile
  breakpoint, but the two segmented groups and both eye actions remain
  reachable.
- Icon-only actions retain matching `title` and `aria-label` copy.
- Focus-visible treatment remains consistent with the Recursion bar and deck
  panels.
- Theme variables, rather than fixed light/dark colors, control the composite
  icon.

## Testing

Automated UI coverage must prove:

1. Post-process header control order and paired-toggle state.
2. Post-process bulk enable and bulk disable behavior.
3. No-op bulk actions render disabled.
4. Starter-deck bulk actions remain read-only.
5. Pre-process three-state and Manual two-state card cycles work after the
   Post-process integration.
6. Pre-process bulk eye actions work after the store rename.
7. Both main-bar buttons render the shared stacked-card geometry.
8. Pre-process renders the rotated left arrow and Post-process renders the
   right arrow.
9. Arrow stroke and fill use theme-backed values.
10. Desktop and compact visual proofs show panel parity without clipping.

## Acceptance Criteria

- The two dropdowns visibly belong to the same card-panel system.
- Apply and Flow occupy the upper-right header immediately before two bulk eye
  actions.
- Post-process bulk eye actions enable or disable all runnable cards.
- Pre-process card rows and bulk eye actions are interactive again.
- The bar icons share stacked cards and differ only by arrow direction.
- Focus, mobile layout, theme adaptation, and independent settings stores
  remain intact.
