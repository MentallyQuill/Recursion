# Pre-process Card Descriptions Design

**Date:** 2026-07-19
**Status:** Approved for implementation

## Goal

Show useful descriptions beneath Pre-process card names in the Cards dropdown, matching the established Post-process card-row treatment without making the panel unnecessarily dense.

## Visible Contract

- Every expanded Pre-process card row renders its description directly beneath its name.
- Descriptions use the shared `.recursion-card-panel-card-description` presentation already used by Post-process cards.
- Description text wraps naturally to its full height.
- The UI must not line-clamp, truncate, ellipsize, cap by character count, or add a per-card scroll surface.
- The Cards panel list remains the only vertical scroll surface.
- Card state markers stay right-aligned.
- Editable card action rails retain their existing width and behavior.
- Card-row clicks continue to cycle the existing Pre-process states; description text is part of that same full-row target.

## Copy Contract

- Bundled Default Deck card descriptions are rewritten in place as concise, plain-language sentences.
- Each bundled description should normally contain 8–16 words.
- A description explains what the card contributes without repeating its name or exposing prompt-instruction wording.
- Custom card descriptions are displayed unchanged and wrap naturally; Recursion does not automatically rewrite operator-authored text.
- Empty custom descriptions use the same neutral fallback as Post-process cards: `No description.`

## Responsive Behavior

- Desktop and mobile use the same wrapping behavior.
- Narrow viewports may produce additional lines; the description remains fully readable.
- No mobile-only clamp or tooltip-only fallback is introduced.

## Data and Runtime Scope

- Bundled description copy changes in `src/pre-process-decks.mjs`.
- Rendering changes in the existing Pre-process branch of `src/ui.mjs`.
- Shared card primitives and state-transition logic do not change.
- Prompt text, runtime card selection, deck persistence, and Post-process behavior do not change.

## Verification

- Deck tests assert that every bundled description is present, concise, and within the approved word range.
- UI tests assert that Pre-process card rows render the shared description element and fallback copy.
- CSS contract tests assert that shared descriptions are not clamped or assigned their own scroll container.
- Existing Pre-process state-cycle and bulk-eye interaction tests remain green.
- The full repository suite passes.
- Production files are synced to both the `default-user` extension and the public served extension copy, then verified for parity.
