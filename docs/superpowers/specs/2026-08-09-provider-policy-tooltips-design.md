# Provider Policy Tooltips Design

**Status:** Approved by the repository owner on 2026-08-09.

**Target:** `refactor`.

## Goal

Make the Behavioral Preset, Instruct Formatting, and Structured Output controls explain what they change, what every option does, and how the two Auto modes reach a real runtime decision.

## Product Contract

The controls remain compact, SillyTavern-native selects. Each select receives one comprehensive native hover tooltip so a user can understand all choices before changing the current value. Option-level tooltips are excluded because browser support for hovering native `option` elements is inconsistent, and dynamic selected-value tooltips would hide the meaning of unselected choices.

Behavioral Preset remains an explicit safety decision with no Auto option:

- `Isolated` excludes the Connection Profile's complete behavioral preset, including behavioral prompts, style instructions, and wrappers. Sampler behavior remains controlled separately.
- `Full Profile` includes the complete preset and is intended only for presets known to be compatible with Recursion's JSON-oriented requests.

Instruct Formatting keeps its runtime Auto policy:

- `Auto` applies instruct formatting to detected text-completion profiles and skips it for detected chat-completion profiles.
- `On` always applies the selected instruct template.
- `Off` never applies it and is appropriate when the backend or preset already frames prompts.

Structured Output keeps its certification-backed Auto policy:

- `Auto` uses Prompt JSON before the current profile and policy are certified. It uses Native Schema only after current certification records native-schema support.
- `Native Schema` always sends the role schema and does not silently downgrade as a persisted operator choice.
- `Prompt JSON` omits native-schema transport metadata and relies on explicit prompt instructions followed by Recursion's parser and validators.

## Approved Tooltip Copy

### Behavioral Preset

> Controls whether Recursion includes the Connection Profile's complete generation preset in model calls. Isolated (recommended) excludes its behavioral prompts, style instructions, and wrappers, reducing interference with structured responses. Full Profile includes the entire preset; use it only when the preset is known to be compatible with Recursion's JSON-oriented requests.

### Instruct Formatting

> Controls whether SillyTavern applies the profile's instruct template. Auto (recommended) enables it for text-completion profiles and disables it for chat-completion profiles using the detected completion mode. On always applies the template. Off never applies it; use Off when the backend or preset already formats prompts and another template would duplicate the framing.

### Structured Output

> Controls how Recursion requests machine-readable JSON. Auto (recommended) uses Prompt JSON before certification, then uses Native Schema only after the current profile passes native-schema certification. Native Schema always sends the schema and does not silently downgrade. Prompt JSON omits native-schema metadata and relies on explicit prompt instructions plus Recursion's parser and validation.

## Implementation Boundaries

- Update the three provider tooltip constants in `src/ui.mjs`; do not add new controls, custom tooltip chrome, styles, or persistence fields.
- Preserve the existing provider policy resolver and certification architecture.
- Add UI regression assertions against the rendered select controls rather than searching source text.
- Add resolver coverage for text versus chat Instruct Auto and uncertified versus native-certified Structured Output Auto.
- Assert from the rendered Behavioral Preset select that Auto is absent.

## Verification

The focused UI and profile transport tests must fail before the tooltip copy and missing policy cases are implemented, then pass after the minimal production change. The full offline suite and alpha release gate must pass before the change is pushed to `refactor`.
