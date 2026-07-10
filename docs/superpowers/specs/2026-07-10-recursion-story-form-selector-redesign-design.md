# Recursion Story Form Selector Redesign

## Purpose

Redesign the compact Tense & PoV dropdown from a flat list of combined story-form choices into a small two-axis selector. The current menu is complete, but it asks users to scan every tense/POV combination now that the surface includes past, present, first person, second person, third-person limited, third-person omniscient, and mixed POV.

The new design keeps the existing runtime contract: `storyFormOverride` remains one persisted value such as `auto`, `past-third-limited`, or `present-mixed`. The UI changes how the user chooses that value. It does not add partial story-form overrides, a prose style preset, a rewrite mode, or a per-character POV editor.

## User-Facing Contract

The bar button stays in the same location: immediately right of Enhancements and immediately left of the Hero Pixel Array separator. The closed button remains compact and stateful:

- `Auto` when story-form detection is automatic.
- `Pa1`, `Pa2`, `Pa3L`, `Pa3O`, `PaM`, `Pr1`, `Pr2`, `Pr3L`, `Pr3O`, or `PrM` on compact/mobile widths.
- Full labels such as `Past 3rd Limited` or `Present Mixed` when the viewport has room.

The button tooltip and accessible label expand the state as `Tense & PoV: Auto`, `Tense & PoV: Past 3rd Limited`, `Tense & PoV: Present Mixed`, and equivalent labels.

Opening the button shows one compact popover:

```text
Auto
  Let Recursion infer tense and POV from recent assistant narration.

Tense
  Past    Present

Point of View
  1st
  2nd
  3rd Ltd
  3rd Omni
  Mixed
```

The menu uses compact SillyTavern-native chrome: no large cards, no nested cards, no marketing copy, no colorful dashboard styling. Section labels are quiet helper text. Choices are segmented button rows or tight button grids, not native `<select>` controls.

## Selection Model

`Auto` is a complete mode. Selecting it clears the forced story-form override by saving `storyFormOverride: "auto"`.

Forced mode is always a complete pair. Recursion does not support "force tense but auto POV" or "force POV but auto tense" in V1. This keeps the prompt contract explicit and avoids hidden mixed authority between UI and Arbiter detection.

When the current value is forced and the user clicks one axis, the other axis is preserved:

- Current `past-third-limited` + click `Present` -> `present-third-limited`.
- Current `present-mixed` + click `Past` -> `past-mixed`.
- Current `past-second-person` + click `3rd Omni` -> `past-third-omniscient`.

When the current value is `auto` and the user clicks one forced axis, the missing axis uses the default forced pair:

- Click `Past` from `Auto` -> `past-third-limited`.
- Click `Present` from `Auto` -> `present-third-limited`.
- Click `1st` from `Auto` -> `past-first-person`.
- Click `Mixed` from `Auto` -> `past-mixed`.

The default forced pair is `past-third-limited`, matching Recursion's conservative story-form fallback and common SillyTavern narration shape.

Every click commits immediately through `runtime.updateSettings({ storyFormOverride })`. There is no Apply button. The popover stays open after forced-axis clicks so users can adjust both axes without reopening the menu. Selecting `Auto`, pressing `Esc`, or clicking outside closes the popover.

## Menu State

The menu always shows exactly one selected state:

- If `storyFormOverride` is `auto`, `Auto` is selected and no forced axis appears selected.
- If forced, `Auto` is not selected; exactly one tense and one POV are selected.

The current forced pair is also summarized in the popover header or selected-state affordance using the full label, for example `Past 3rd Limited`.

The `Mixed` POV choice must be framed as a POV axis choice, not a style choice. Its helper copy should be:

```text
Preserve established viewpoint alternation.
```

Avoid copy like `hybrid style`, `experimental`, `creative mode`, or `omniscient mixed`.

## Runtime Contract

No runtime schema change is required. The UI maps tense and POV axis selections into the existing `STORY_FORM_OVERRIDE_OPTIONS` values:

- `auto`
- `past-first-person`
- `past-second-person`
- `past-third-limited`
- `past-third-omniscient`
- `past-mixed`
- `present-first-person`
- `present-second-person`
- `present-third-limited`
- `present-third-omniscient`
- `present-mixed`

The existing normalization, cache signature, Rapid warm signature, Prompt Packet diagnostics, and safe settings view behavior remain authoritative. The redesign should not add a new settings shape such as `{ tense, pov }`.

## Accessibility

The popover must be keyboard reachable:

- The opener is a button with `aria-expanded`.
- `Auto`, tense choices, and POV choices are buttons.
- Selected choices use `aria-pressed="true"` or `aria-current="true"` consistently with adjacent Recursion menus.
- Section labels are visible text and may be connected with `aria-labelledby` where practical.
- `Esc` closes the popover.
- Outside click closes the popover.

The popover must close competing popovers when opened, matching Pipeline, Mode, Cards, Enhancements, Progress, Last Brief, and Settings behavior.

## Visual Requirements

The menu should remain compact enough for the top bar:

- Width target: about `230px` to `260px`.
- Section padding: `7px` to `9px`.
- Choice height: `24px` to `28px`.
- Border radius: `5px` for buttons, `8px` for popover bottom corners.
- No nested cards.
- No broad cyan fills; selected state may use the same subtle cyan inset/fill treatment as other Recursion selectors.

The Tense row has two side-by-side choices. The POV section has five stacked list rows:

```text
1st
2nd
3rd Ltd
3rd Omni
Mixed
```

This asymmetry is deliberate. Tense is a short binary choice and benefits from direct comparison. POV labels are longer and more numerous, so a vertical list gives each option stable tap area on mobile and prevents `3rd Ltd`, `3rd Omni`, and `Mixed` from being squeezed into a dense grid. Text must not clip. `3rd Omni` and `3rd Ltd` are the visible button labels; full copy lives in tooltips/accessible labels.

## Testing Strategy

Focused UI tests should prove:

- The menu renders `Auto`, `Tense`, `Past`, `Present`, `Point of View`, `1st`, `2nd`, `3rd Ltd`, `3rd Omni`, and `Mixed`.
- The old flat list is not rendered as eleven equal peer rows.
- Tense renders as the two-button segmented row, while POV renders as a five-row vertical list.
- Clicking `Present` from `past-third-limited` saves `present-third-limited`.
- Clicking `Mixed` from `present-third-limited` saves `present-mixed`.
- Clicking `Mixed` from `auto` saves `past-mixed`.
- Clicking `Auto` saves `auto` and closes the menu.
- Forced-axis clicks keep the menu open.
- The selected state marks one tense and one POV when forced.
- Mobile shorthand labels still render `PaM` and `PrM`.

Docs tests should update `docs/design/UI_SPEC.md` so the canonical design describes the axis selector rather than the flat list.

## Acceptance Criteria

- Users can choose Auto from the top of the Tense & PoV popover.
- Users can choose tense and POV separately without scanning every combined pair.
- The persisted setting remains the existing single `storyFormOverride` string.
- Forced mode always produces a complete tense + POV pair.
- The UI does not introduce partial override states.
- The compact bar button remains stable on desktop and mobile.
- Tests cover the mapping rules and selected-state behavior.

## Non-Goals

- No new story-form schema.
- No partial override mode.
- No separate settings panel control.
- No per-character POV editor.
- No prompt rewrite, prose enhancement, or style preset behavior.
- No runtime cache migration.

## Self-Review

- Placeholder scan: no placeholders remain.
- Scope check: one bounded UI redesign over the existing story-form override contract.
- Ambiguity check: forced mode is complete-pair only, with `past-third-limited` as the default missing-axis pair.
- Contract check: runtime remains unchanged except for UI mapping into existing override strings.
