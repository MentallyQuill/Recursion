# Recursion Mixed POV Auto Design

## Purpose

Extend Recursion's story-form contract so Auto mode can handle intentionally hybrid POV, and so operators can force `Past Mixed` or `Present Mixed` when the automatic detector is wrong.

The immediate user failure is an Auto run on hybrid POV that produced exceptionally incorrect guidance. The current manual override list covers first, second, third-limited, and third-omniscient for past and present tense, but it has no forced choice for "this scene deliberately mixes viewpoint families." That missing option makes the UI correction path weaker than the underlying story-form schema, which already permits `pov: "mixed"`.

This feature is not a prose rewrite mode, a style preset, or a way to make Recursion more experimental. It is a prompt-contract correction for chats whose established narration intentionally alternates perspective.

## Definitions

`mixed` POV means recent assistant narration intentionally uses more than one narrative viewpoint family in scene prose.

Examples:

- Second-person player-facing narration mixed with third-person NPC or camera narration.
- First-person internal narration mixed with third-person external narration.
- Rotating limited viewpoints where recent assistant prose moves between multiple viewpoint holders.
- Third-person limited narration that occasionally opens into omniscient narration across recent assistant prose.

Non-examples:

- Dialogue containing `I`, `you`, `he`, or `she`.
- A pending user instruction written in first or second person.
- A single isolated pronoun in otherwise stable narration.
- A typo or one-off drift in the latest assistant message.
- A third-person-limited passage that mentions multiple characters without exposing multiple internal viewpoints.

Mixed POV is a POV value, not a tense value. `present + mixed` and `past + mixed` are common target forms. `tense: "mixed"` should remain reserved for material tense alternation in recent assistant narration.

## User-Facing Contract

The Tense & PoV selector adds two forced choices:

- `Past Mixed`, shorthand `PaM`
- `Present Mixed`, shorthand `PrM`

The full desktop labels should fit without clipping. On narrow/mobile viewports, forced labels use shorthand to preserve the compact bar. Accessible labels and tooltips expand the state as `Tense & PoV: Past Mixed` and `Tense & PoV: Present Mixed`.

Selecting `Auto` stores `storyFormOverride: "auto"`. Selecting either mixed option stores a high-confidence user override that feeds card prompts, guidance composition, Rapid metadata, cache signatures, and Prompt Packet diagnostics.

Because Recursion is pre-alpha, the override enum should be updated in place. Do not add compatibility aliases for old names.

## Story-Form Contract

The canonical story-form object remains:

```json
{
  "schema": "recursion.storyForm.v1",
  "tense": "present",
  "pov": "mixed",
  "confidence": "high",
  "evidenceRefs": ["message:42"],
  "reason": "Recent assistant narration mixes second-person player framing with third-person scene narration."
}
```

Allowed `tense` values stay:

- `past`
- `present`
- `mixed`
- `unknown`

Allowed `pov` values stay:

- `first-person`
- `second-person`
- `third-person-limited`
- `third-person-omniscient`
- `mixed`
- `unknown`

The forced override values expand to:

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

`past-mixed` normalizes to `{ tense: "past", pov: "mixed", confidence: "high" }`.

`present-mixed` normalizes to `{ tense: "present", pov: "mixed", confidence: "high" }`.

## Auto Mode Design

Auto mode must decide story form from recent assistant narration first. The pending user message must not be treated as primary style evidence unless no assistant narration exists in the bounded snapshot.

Detection should be evidence based and conservative:

- Extract narrative prose segments from recent assistant messages.
- Discount quoted dialogue before POV classification.
- Discount code blocks, markdown UI fragments, and OOC/control text when they can be separated from narration.
- Classify POV by segment, not by global pronoun counts.
- Preserve concrete tense when tense evidence is stable, even if POV is mixed.
- Return `pov: "mixed"` only when at least two POV families have meaningful narrative evidence.
- Return `unknown` or keep the dominant single POV when evidence is too thin.

Recommended mixed threshold:

- At least three POV-bearing narrative segments.
- At least two different POV families represented.
- The secondary POV family appears in at least two segments or at least 25% of POV-bearing segments.
- The dominant POV family is not above roughly 80-85% of POV-bearing segments.

These thresholds are guardrails, not a public contract. Tests should lock the intended examples and non-examples, not brittle numeric internals.

## Arbiter Prompt Requirements

The Arbiter contract should explicitly teach mixed POV as intentional alternation, not pronoun noise:

```text
Story form contract:
- Determine tense and POV from the latest visible assistant narration first.
- Ignore the pending user message's style unless no assistant narration exists.
- Treat mixed POV as intentional alternation between narrative viewpoint families in assistant prose.
- Do not infer mixed POV from dialogue pronouns, user instructions, or one-off wording.
- Prefer present+mixed or past+mixed when tense is stable but viewpoint family alternates.
- Use unknown with low confidence when the snapshot has no usable story prose.
- Return storyForm using schema "recursion.storyForm.v1".
```

Few-shot examples should include:

- Present mixed: assistant prose alternates second-person player framing and third-person scene narration.
- Past mixed: assistant prose alternates first-person recollection and third-person limited narration.
- Not mixed: dialogue contains first-person and second-person pronouns inside quotes while narration stays third-person past.
- Not mixed: pending user message says "I open the door" while latest assistant narration is third-person past.

## Heuristic Cross-Check Requirements

The local heuristic must not erase a valid mixed Arbiter result solely because one POV family is more common. It should only downgrade or normalize when there is clear contradiction.

Heuristic behavior:

- If the Arbiter returns `pov: "mixed"` with medium or high confidence and local segment evidence also sees multiple POV families, keep mixed.
- If the Arbiter returns a single POV with high confidence but local segment evidence strongly supports mixed, downgrade confidence or normalize to mixed according to the same policy used for existing cross-checks.
- If local evidence is thin, keep the Arbiter result rather than forcing mixed.
- If only dialogue or pending user text produces apparent plurality, do not mark mixed.

## Prompt And Guidance Requirements

Prompt output should preserve a hybrid viewpoint pattern without turning that into style coaching.

For mixed POV, card and guidance prompts should say:

```text
Preserve the established mixed POV pattern. Do not collapse the reply into a single viewpoint family unless the chat itself has shifted.
```

The prompt must still enforce Recursion's normal boundaries:

- Do not infer hidden thoughts unless established by the active narrative viewpoint.
- Do not add events, secrets, or plot knowledge only because POV is mixed.
- Do not rewrite user intent.
- Do not treat mixed POV as permission to address every character's internal state.

For `tense: "present", pov: "mixed"`, guidance should name `present tense, mixed POV`. For `tense: "past", pov: "mixed"`, guidance should name `past tense, mixed POV`.

## UI Requirements

The selector remains in the compact bar immediately to the right of Prose Enhancement and before the Hero Pixel Array separator. It follows the same dropdown behavior as Pipeline, Mode, Cards, and Prose Enhancement:

- Opens on button click.
- Closes on selection.
- Closes on outside click.
- Closes on `Esc`.
- Closes competing popovers when opened.
- Keeps selected row state visible in the menu.

Menu order:

1. `Auto`
2. `Past 1st`
3. `Past 2nd`
4. `Past 3rd Limited`
5. `Past 3rd Omni`
6. `Past Mixed`
7. `Present 1st`
8. `Present 2nd`
9. `Present 3rd Limited`
10. `Present 3rd Omni`
11. `Present Mixed`

Mobile shorthand:

- `Auto`
- `Pa1`
- `Pa2`
- `Pa3L`
- `Pa3O`
- `PaM`
- `Pr1`
- `Pr2`
- `Pr3L`
- `Pr3O`
- `PrM`

## Runtime And Cache Requirements

`storyFormOverride` must be included anywhere settings identity affects behavior:

- settings normalization
- `safeSettingsView()`
- Standard cache settings signature
- Rapid warm settings signature
- prompt packet diagnostics
- Rapid warm metadata

The new mixed override values must invalidate stale artifacts because the prompt contract changes.

## Testing Strategy

Focused tests:

- `STORY_FORM_OVERRIDE_OPTIONS` includes `past-mixed` and `present-mixed`.
- `forcedStoryForm("past-mixed")` returns past tense, mixed POV, high confidence.
- `forcedStoryForm("present-mixed")` returns present tense, mixed POV, high confidence.
- `normalizeStoryFormWithHeuristic()` preserves Arbiter mixed when local evidence supports multiple POV families.
- Auto detection does not mark mixed from dialogue pronouns alone.
- Auto detection ignores pending user-message pronouns when assistant narration is available.
- Auto detection returns present mixed for present-tense hybrid narration.
- Auto detection returns past mixed for past-tense hybrid narration.
- Runtime carries mixed override through Standard and Rapid paths.
- UI renders `Past Mixed` and `Present Mixed` menu choices.
- UI renders `PaM` and `PrM` on compact/mobile viewports.
- CSS prevents long labels from clipping and keeps the separator aligned after the expanded button.

Gates:

- `node tools\scripts\test-story-form.mjs`
- `node tools\scripts\test-runtime.mjs`
- `node tools\scripts\test-ui.mjs`
- `npm.cmd test`
- `git diff --check`

If the change is being validated in a live SillyTavern install, sync the served extension copy and verify the actual bar/menu, not only the repo checkout.

## Acceptance Criteria

- Users can choose `Past Mixed` or `Present Mixed` from the Tense & PoV dropdown.
- Auto mode can represent stable-tense mixed POV without falling back to a wrong single POV.
- Dialogue and pending user input do not cause false mixed detection.
- Cards, guidance, Prompt Packet diagnostics, and Rapid artifacts all receive the same normalized mixed story form.
- Desktop labels fit without clipping.
- Mobile labels use shorthand.
- Tests cover both forced mixed and Auto mixed behavior.

## Non-Goals

- No per-character POV editor.
- No story-form memory outside normal scene cache and Rapid artifact behavior.
- No grammatical rewrite pass.
- No broad prompt preset system.
- No UI copy that presents mixed POV as a creative style filter.

## Self-Review

- Placeholder scan: no placeholders remain.
- Scope check: one bounded story-form feature spanning contract, Auto detection, UI choices, runtime flow, and tests.
- Ambiguity check: mixed POV means meaningful narrative alternation across POV families, not pronouns in dialogue or user text.
- Contract check: forced values, Auto inference, prompt wording, cache identity, and UI labels are specified.
