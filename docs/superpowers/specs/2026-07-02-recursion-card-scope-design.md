# Recursion Card Scope Design

## Purpose

Recursion needs a simple user-facing way to control which card work is available without turning V1 into a card-management tool. The agreed model keeps normal play automatic while giving users a clear Cards surface for focus and strict scope.

This design replaces the earlier visible `Semi-Auto` concept with a cleaner two-mode surface:

- `Auto`: Recursion chooses relevance.
- `Manual`: the user chooses the allowed card scope.

There is no user-facing `Semi-Auto` mode. Focused Auto behavior is derived from the Cards selection, not named as a separate mode.

## Visible Modes

### Auto

Auto is the default mode. All card families and sub-items are enabled by default, so all card work is on the table. Recursion decides which card families and sub-items are relevant for the current turn.

When the user disables some families or sub-items while still in Auto, the visible mode remains `Auto`. The reduced selection becomes a focus preference:

- Recursion should prioritize selected families and sub-items.
- Recursion may still add critical unselected continuity or safety work when needed to protect the next response.
- These critical exceptions should be visible in progress, brief, or diagnostics surfaces instead of hidden.

Auto therefore has two internal postures:

- unrestricted Auto: all families and sub-items enabled;
- focused Auto: at least one family or sub-item disabled, with critical exceptions still allowed.

The UI should not expose these as separate mode names.

### Manual

Manual is explicitly selected from the mode control. It uses the same Cards selection as Auto, but the selection is strict:

- Recursion still runs automatically on generation.
- Recursion may generate, reuse, select, compose, and inject only enabled families and sub-items.
- Unselected families and sub-items cannot be used as critical exceptions.
- Manual is manual card scope, not manual per-card review or editing.

Manual does not silently switch back to Auto when all cards are enabled. The user must choose Auto explicitly.

## Mode Control

The main mode control should offer only:

- `Auto`
- `Manual`

The mode control owns enforcement style, not detailed card selection. Card counts and selection details belong in the Cards surface.

The existing power button remains separate from mode. Power off disables Recursion work; Auto and Manual describe how Recursion behaves when powered on.

## Cards Button

The main bar should add a Cards button that opens the card-scope surface. This button owns the selected-card count and scope controls.

Compact labels:

- all enabled: `Cards`
- partial selection: enabled sub-items over total sub-items, such as `6/9`

The mode button should remain visually simple and should not show the selected-card count.

## Card Scope Tree

The Cards surface is a tree of fixed V1 card families and catalog-owned sub-items. The current V1 families are:

- Scene Frame
- Active Cast
- Character Motivation
- Dialogue/Relationship
- Continuity Risk
- Environment/Items
- Prose/Pacing
- Open Threads

Each family has:

- a family-level toggle;
- a short family description;
- one or more sub-item toggles for finer focus inside that family.

Sub-items are static, catalog-owned focus facets in V1. Users cannot create custom families or custom sub-items in this design.

Example shape:

```text
[on] Continuity Risk
     [on] fragile facts
     [on] spatial constraints
     [off] timeline/order risks

[mixed] Character Motivation
     [on] visible goals
     [off] inferred pressure
     [on] hesitation/posture
```

## Toggle Rules

Family toggles are coarse availability controls.

- Turning a family off disables the whole family and all of its sub-items for runtime.
- Turning a family back on turns all of that family's sub-items back on.
- A family is mixed only when the family is on and at least one, but not all, sub-items are enabled.
- Disabled families do not preserve hidden sub-item selections.

The Cards tree must prevent zero selection:

- At least one sub-item across the whole catalog must remain enabled.
- If the user tries to disable the final enabled sub-item or family, the UI blocks the action.
- The UI should show a short inline state such as `At least one card focus must remain enabled.`

## Runtime Interpretation

Runtime should treat the card scope as a filter and focus contract around the existing fixed catalog.

In Auto:

1. The Utility Arbiter receives the fixed catalog plus the selected family/sub-item scope.
2. Selected scope acts as a focus preference.
3. Runtime allows critical unselected continuity or safety card work when the Arbiter reports a bounded reason.
4. Any unselected-scope exception must be recorded in sanitized activity or diagnostics.

In Manual:

1. The Utility Arbiter receives only the enabled scope as the allowed catalog.
2. Runtime rejects or drops card jobs outside the enabled scope.
3. Prompt composition cannot select or inject disabled families or sub-items.
4. There is no critical exception lane.

Existing card generation still produces normal Recursion cards. Sub-items guide what a family should focus on; they do not require separate generated card instances in V1.

## Settings Shape

The primary persisted state should separate visible mode from card scope:

```ts
type RecursionMode = "auto" | "manual";

type CardScopeSettings = {
  mode: RecursionMode;
  families: Record<CardFamilyKey, {
    enabled: boolean;
    subItems: Record<CardSubItemKey, boolean>;
  }>;
};
```

Defaults:

- `mode: "auto"`
- every family enabled;
- every sub-item enabled.

Normalization must enforce:

- unknown families or sub-items are dropped;
- missing families or sub-items default to enabled;
- at least one sub-item remains enabled;
- enabling a disabled family through the family toggle restores all sub-items to enabled.

## UI Placement

The top bar should keep separate responsibilities:

- Power button: on/off.
- Mode button: Auto or Manual.
- Cards button: card family and sub-item scope.
- Progress pixels: current work.
- Last Brief dropdown: what Recursion actually used last turn.
- Options/settings: providers, advanced settings, and lower-frequency controls.

Cards is a primary play control and should not be buried under the generic settings menu. The Cards button is the natural place for the selected sub-item count and tree.

## Visibility And Trust

The Cards surface should explain current enforcement in compact copy:

- Auto: `Selected cards guide focus. Critical continuity and safety may still appear.`
- Manual: `Only selected cards can be used.`

Progress and brief surfaces should make exceptions understandable:

- Auto exception example: `Continuity Risk added as critical exception.`
- Manual omission example: `Prose/Pacing omitted: disabled in Manual.`

Diagnostics and journals must remain sanitized. They may record family keys, sub-item keys, omission reasons, exception reasons, and counts, but not raw provider responses, prompt text beyond existing safe surfaces, hidden reasoning, secrets, or full transcript text.

## Out Of Scope For This Feature

This design does not add:

- user-authored custom card families;
- user-authored custom sub-items;
- manual per-card approval before generation;
- per-card text editing;
- durable memory or cross-scene card pinning;
- a separate visible Semi-Auto mode;
- separate generated card instances for every sub-item.

## Acceptance Criteria

- The visible mode selector shows only Auto and Manual.
- New users start in Auto with every family and sub-item enabled.
- The Cards button opens a family/sub-item tree.
- Family off disables the family; family on restores all sub-items.
- Partial sub-item selection shows a mixed family state.
- The UI prevents disabling the final enabled sub-item.
- Auto treats partial selection as preferred focus, with unselected families still allowed when they have high relevance to continuity, scene coherence, or the current user message.
- Manual treats partial selection as a strict whitelist.
- Runtime never generates, selects, composes, or injects disabled scope in Manual.
- Sub-items guide family focus and do not require separate V1 card instances.
