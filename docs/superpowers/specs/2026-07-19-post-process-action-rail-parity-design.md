# Post-process Action Rail Parity Design

**Date:** 2026-07-19
**Status:** Approved design, awaiting written-spec review

## Goal

Make Post-process category headers and editable action rails follow the same visual geometry as the corresponding Pre-process controls.

## Scope

- Remove the per-category visibility-eye control from Post-process category headers.
- Keep Post-process card-level visibility eyes. Cards remain individually enabled or disabled from their rows.
- Preserve the persisted Post-process category-enabled data contract and runtime behavior. This change removes only the category-header control; it does not migrate or discard saved state.
- Align editable Post-process category actions with Pre-process in this order:
  1. Create a new card in the category.
  2. Edit the category.
  3. Delete the category.
  4. Drag the category.
- Align editable Post-process card actions with Pre-process in this order:
  1. Edit the card.
  2. Duplicate the card.
  3. Delete the card.
  4. Drag the card.
- Use the shared `124px` action-rail geometry and the same reserved spacing before category/card drag handles so corresponding buttons occupy the same horizontal positions in both phases.

## Implementation Shape

The Post-process category renderer will stop passing a `state` node to the shared category renderer. The shared renderer will therefore use the same disclosure/copy/action grid as Pre-process.

Post-process category and card action rails will retain their existing datasets and click behavior. Their drag handles will receive the same reserved separation used by Pre-process delete slots, completing the shared `124px` rail instead of right-aligning a narrower `116px` group.

No fixed coordinates or phase-specific absolute positioning will be introduced. The shared deck-category and deck-card renderers remain the layout authority.

## Interaction Contract

- Clicking a Post-process category header still expands or collapses it.
- Clicking a Post-process card eye still changes that card's saved On/Off state.
- Category descriptions remain tooltip/accessibility text rather than visible header copy.
- Read-only Starter deck structure continues to hide authoring actions.
- Custom decks continue to expose all authoring and drag controls.
- Removing the category eye must not make category-action clicks toggle disclosure.

## Testing

The UI regression test will prove:

- No Post-process category visibility-eye control is rendered.
- Post-process cards still render their visibility-eye controls.
- Custom Post-process category actions use the same ordered control set as Pre-process.
- Custom Post-process card actions use the same ordered control set as Pre-process.
- Post-process action rails use the same reserved drag-handle spacing and `124px` width contract as Pre-process.

After the focused test passes, run the complete test suite. Then sync the production files to both the `default-user` extension and the public served extension, verify hashes, and inspect the live dropdown at desktop width.

## Non-goals

- Removing or migrating persisted Post-process category-enabled state.
- Changing card-level On/Off behavior.
- Changing Pre-process card selection behavior.
- Redesigning deck, category, card, or drag-and-drop data contracts.
- Altering read-only structure rules.
