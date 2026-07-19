# Recursion Post-process Cards Design

**Status:** Approved for implementation

**Date:** 2026-07-18

**Feature owner:** Recursion

**Replaces:** Generation Review, Enhancements, Dialogue Enhancement, Prose Enhancement, and Editorial Transformation

## Purpose

Recursion will replace its fixed, unreliable Enhancements feature with a user-authored Post-process Card system.

Recursion will have two independent card surfaces:

- **Pre-process Cards** produce evidence and guidance before the original SillyTavern response.
- **Post-process Cards** describe how to revise the completed response after generation.

Post-process Cards are organized into independently selectable decks, ordered categories, and ordered cards. Users can duplicate a bundled starter deck or create custom decks, categories, and cards. Enabled work runs from top to bottom.

The feature intentionally separates analysis from authorship:

1. Recursion's Utility or Reasoner lane synthesizes contextual post-process guidance.
2. SillyTavern's native generation path, using the user's active preset, character, lore, model, and normal host context, writes the revised response.

Recursion's sidecar provider must never become the prose writer.

## Product Vocabulary

These names are the visible and technical V1 vocabulary:

| Term | Meaning |
| --- | --- |
| Pre-process Cards | The existing card system used before the original host generation. |
| Post-process Cards | User-authored revision instructions applied after the original host generation. |
| Post-process Deck | An independently selected collection of ordered Post-process categories and cards. |
| Unified | Synthesize all enabled categories together and perform one host rewrite. |
| Progressive | Synthesize and rewrite one enabled category at a time, in deck order. |
| As Swipe | Append and select one final rewritten swipe. |
| Replace | Replace the selected assistant response only after complete success. |
| Guidance synthesis | Recursion's bounded sidecar call that converts selected cards and evidence into contextual revision guidance. |
| Host rewrite | SillyTavern's native, non-persisting quiet generation using the active host preset and context. |

Do not retain `Enhancement`, `Generation Review`, `Repair`, `Recompose`, `Redirect`, `Dialogue Enhancement`, or `Prose Enhancement` as current feature labels or runtime modes.

## Scope

### Included

- Rename the existing visible Cards surface to Pre-process Cards.
- Preserve the existing Pre-process Card behavior, including Off, Active, and Priority participation.
- Replace the Enhancements toolbar control, menus, settings, runtime, progress, diagnostics, and proof surface with Post-process Cards.
- Independent Post-process Deck selection and persistence.
- Bundled read-only starter Post-process Deck.
- Custom decks, categories, and cards.
- Category and card on/off controls.
- Category and card drag reordering.
- Unified and Progressive rewrite flows.
- As Swipe and Replace final application.
- Strict reasoning-level-to-lane routing.
- Same-lane retry once, then fail-soft behavior.
- Final-output-only chat persistence.
- Unit, contract, host-adapter, browser integration, and visual regression coverage.

### Excluded from V1

- Automatic card authoring.
- Import/export.
- Sharing or marketplace decks.
- Conditional card expressions.
- Per-card model or provider selection.
- Per-card host rewrite calls.
- Cross-lane fallback.
- Persisted Progressive intermediate drafts.
- A legacy Enhancements compatibility shim.

## Independent Deck Contract

The active Pre-process Deck and active Post-process Deck are independent settings. Selecting, duplicating, editing, deleting, or reordering one deck family cannot alter the other.

Post-process Decks use the following canonical V1 shape:

```js
{
  version: 1,
  activeDeckId: "starter-post-process",
  customDecks: {
    "post-process-1720000000000-1": {
      id: "post-process-1720000000000-1",
      name: "My Revision Deck",
      description: "",
      bundled: false,
      readonly: false,
      categoryOrder: ["natural-prose", "follow-through"],
      categories: {
        "natural-prose": {
          id: "natural-prose",
          name: "Natural Prose",
          description: "",
          enabled: true,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z"
        }
      },
      cardOrderByCategory: {
        "natural-prose": ["cut-echoes", "natural-diction", "land-the-ending"]
      },
      cards: {
        "natural-diction": {
          id: "natural-diction",
          categoryId: "natural-prose",
          name: "Natural Diction",
          description: "Replace unnecessary technical diction with direct character-appropriate wording.",
          promptText: "Review dialogue and character-facing narration...",
          enabled: true,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z"
        }
      },
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z"
    }
  }
}
```

### Participation

- Post-process categories and cards are binary: On or Off.
- Post-process cards never have Priority.
- A category that is Off contributes no cards.
- Turning a category Off does not rewrite the saved `enabled` values of its cards.
- Turning the category On restores the category's previously configured card participation.
- A card is runnable only when its category is On, the card is On, its name is nonempty, and its prompt is nonempty.
- Empty categories and categories with no runnable cards are skipped without a provider or host call.
- Deck/category/card order is authoritative execution order.

### Editing

- The starter deck is bundled and structurally read-only.
- Its category and card enabled states remain operator-controllable.
- Users duplicate the starter deck to edit its structure or content.
- Users may create a blank custom deck.
- Custom decks support rename, duplicate, and typed-confirmation delete.
- Custom categories support create, rename, edit description, reorder, and delete with contained cards.
- Custom cards support create, edit name/description/prompt, duplicate, move within or across categories, reorder, toggle, and delete.
- Drag handles are the only drag start targets.
- Mobile drag begins after a short hold and supports edge auto-scroll, matching the Pre-process Card interaction.

## Settings Contract

Post-processing is off by default.

```js
{
  postProcess: {
    enabled: false,
    applyMode: "as-swipe",
    rewriteFlow: "unified",
    contextMessages: 13
  },
  postProcessDecks: {
    version: 1,
    activeDeckId: "starter-post-process",
    customDecks: {},
    starterCategoryStates: {},
    starterCardStates: {}
  }
}
```

Allowed values:

```js
const POST_PROCESS_APPLY_MODES = ["as-swipe", "replace"];
const POST_PROCESS_REWRITE_FLOWS = ["unified", "progressive"];
const POST_PROCESS_CONTEXT_RANGE = { min: 0, max: 35 };
```

`contextMessages` bounds only Recursion's guidance-synthesis evidence. It must not limit, replace, or reconstruct SillyTavern's writer context.

Because Recursion is pre-alpha, normalization accepts only this V1 contract. The implementation does not migrate or preserve old `enhancements` settings.

## Starter Post-process Deck

The first install includes one small read-only deck:

```text
Starter Post-process Deck
├─ Natural Prose
│  ├─ Cut Echoes
│  ├─ Natural Diction
│  └─ Land the Ending
└─ Follow Through
   ├─ Act on the Threat
   ├─ Close the Distance
   └─ Complete the Move
```

All starter categories and cards are On inside the deck, but the top-level Post-process feature is Off by default.

### Natural Prose

#### Cut Echoes

**Description:** Remove parroting, redundant restatement, and repeated dialogue beats.

**Prompt:**

> Review the draft for echoed information. Remove narration that merely restates dialogue, dialogue that paraphrases the immediately preceding line, repeated emotional labels, and repeated beats that do not change the scene. Preserve deliberate repetition used for rhythm, characterization, escalation, or clarity. Keep the strongest expression of each idea and preserve all consequential information.

#### Natural Diction

**Description:** Replace unnecessary clinical, tactical, statistical, or optimization-heavy language with direct character-appropriate wording. Preserve that register only for literal robots or androids whose canonical voice uses it.

**Prompt:**

> Review dialogue and character-facing narration for over-technical or pseudo-analytical diction such as “assessing variables,” “recalibrating,” “data point,” “optimal,” “inefficient,” “statistically,” “physiologically,” “strategically,” “tactically,” and “clinical precision.”
>
> For non-robotic characters, rewrite those expressions into direct, idiomatic phrasing that matches each character's established voice. Do not use technical language as shorthand for intelligence, emotional distance, dominance, or competence.
>
> Preserve this register only when the speaker is a literal robot or android whose canonical voice genuinely uses it. Preserve the intended meaning and do not flatten distinct character voices.

#### Land the Ending

**Description:** End on consequential movement instead of canned questions or fake choices.

**Prompt:**

> Review the ending. Remove canned questions, fake either-or choices, summary conclusions, and endings that hand responsibility back to the user without meaningful movement. End on the strongest concrete beat already supported by the scene: an action, consequence, revelation, sensory change, or decisive line. Do not invent a new plot turn solely to avoid a question.

### Follow Through

Every Follow Through card carries these hard boundaries:

> Do not invent intent, override consent, force unsupported escalation, or take control of the user's character. Act only on intent, reciprocity, capability, and immediacy already established by the draft and frozen context.

#### Act on the Threat

**Description:** Convert repeated immediate threats into supported action or consequence.

**Prompt:**

> When a character's immediate violent intent is already established and the draft repeats warnings, threats, preparations, or chances to back down, replace the repetition with the supported action or its immediate consequence. Preserve hesitation when it is itself meaningful characterization or when action is not yet supported.

#### Close the Distance

**Description:** Complete supported reciprocal physical or romantic contact.

**Prompt:**

> When reciprocal physical or romantic intent is already established, replace repeated hovering, near-touching, almost-kissing, interrupted-contact, or “giving one last chance” loops with the appropriate supported contact. Preserve boundaries, consent, character voice, and the scene's established intensity.

#### Complete the Move

**Description:** Carry repeated preparation or implication into the concrete next step.

**Prompt:**

> When a character repeatedly prepares, hints, reaches, starts, or almost acts, carry the established intention into the concrete next step. Do not manufacture a new intention or skip a necessary decision. Prefer an observable action or consequence over another statement of intent.

## Frozen Operation Snapshot

Every post-process operation captures one immutable snapshot before guidance synthesis begins:

```js
{
  operationId,
  chatKey,
  sourceMessageId,
  sourceSwipeId,
  sourceHash,
  originalDraft,
  reasoningLevel,
  lane,
  applyMode,
  rewriteFlow,
  activeDeckId,
  orderedCategories,
  supportingContext: {
    latestUserMessage,
    boundedPriorMessages,
    characterContext,
    preProcessPromptPacket,
    storyForm
  }
}
```

The operation is canceled as stale if the chat, source message, selected source swipe, source text hash, or active character/group changes before final commit.

Settings and deck edits made during a running operation affect only the next operation.

## Guidance Synthesis

Guidance synthesis receives:

- the frozen supporting context;
- the current writable draft;
- the enabled category or categories;
- ordered enabled card prompts;
- hard safety boundaries;
- source and snapshot hashes.

It returns a small structured envelope:

```js
{
  schema: "recursion.postProcessGuidance.v1",
  snapshotHash: "…",
  sourceHash: "…",
  guidanceText: "Contextual, actionable revision guidance."
}
```

The provider must not return the rewritten story. The prompt tells it to identify where and how the selected cards apply, preserve unsupported material, and give the host writer concise revision guidance.

### Lane routing

Lane routing is strict and frozen per operation:

| Recursion reasoning setting | Guidance role | Lane |
| --- | --- | --- |
| Low | `postProcessGuidanceUtility` | Utility |
| Medium | `postProcessGuidanceUtility` | Utility |
| High | `postProcessGuidanceReasoner` | Reasoner |
| Ultra | `postProcessGuidanceReasoner` | Reasoner |

There is no Utility-to-Reasoner or Reasoner-to-Utility fallback.

Guidance synthesis gets at most two attempts on the same role and lane: the initial call and one retry. If both attempts fail, that Unified operation or Progressive category fails soft.

## SillyTavern Host Writer Contract

The writer is SillyTavern's native generation function:

```js
await context.generate("quiet", {
  automatic_trigger: true,
  quiet_prompt: writerDirective,
  quietToLoud: true,
  signal
});
```

This is required because SillyTavern's `quiet` generation:

- assembles the user's active preset and normal chat context;
- retains character, lore, World Info, Author's Note, and host-managed context behavior;
- uses the user's active host model;
- returns generated text;
- exits before `saveReply`, so it does not add or replace a chat message.

The writer directive includes the current writable draft, ordered card instructions, the synthesized guidance, and immutable boundaries. The rewrite must return only the revised assistant response.

Do not use Recursion's `host.generation.generate`, `generateRaw`, a connection profile, Utility, or Reasoner as the prose writer.

Recursion's `contextMessages` cap does not apply to this call. SillyTavern remains authoritative for writer context assembly and token budgeting.

## Rewrite Flows

### Unified

Unified performs:

```text
all enabled categories/cards
  -> one guidance-synthesis call (with one same-lane retry)
  -> one SillyTavern quiet rewrite (with one host-only retry)
  -> one final commit
```

All enabled categories and cards are supplied in deck order. No provider or host call occurs when no card is runnable.

### Progressive

Progressive performs:

```text
frozen context + original draft + category 1
  -> category 1 guidance
  -> host rewrite 1
  -> latest valid draft

frozen context + latest valid draft + category 2
  -> category 2 guidance
  -> host rewrite 2
  -> latest valid draft

...

latest valid draft
  -> one final commit
```

Each category receives:

- the unchanged frozen supporting context;
- only the latest valid draft as its writable source;
- only that category's ordered enabled cards.

It does not receive a parallel copy of the original draft after a successful prior category.

Cards within a category are combined into one guidance packet and one host rewrite. Progressive is per category, never per card.

## Retry and Fail-soft Rules

The two call types have separate retry budgets.

### Guidance failure

1. Retry guidance synthesis once on the same assigned role and lane.
2. Never cross lanes.
3. On a second failure:
   - Unified stops and leaves the original response unchanged.
   - Progressive marks that category failed and continues with the last valid draft.

### Host rewrite failure

1. Cache the successful guidance packet in operation memory.
2. Retry only the SillyTavern host rewrite once with the identical packet.
3. Do not rerun guidance synthesis.
4. On a second failure:
   - Unified stops and leaves the original response unchanged.
   - Progressive marks that category failed and continues with the last valid draft.

An empty, exact-no-op, stale, or canceled host result is unusable and consumes the host retry budget.

### Progressive result states

| Outcome | Final behavior |
| --- | --- |
| Every runnable category succeeds | Complete final result. |
| At least one succeeds and at least one fails | Partial final result. |
| Every runnable category fails | No final mutation; original remains selected. |
| User stops operation | No final mutation; original remains selected. |
| Source becomes stale | No final mutation; original remains selected. |

The progress UI must identify failed categories and show that later categories continued from the last valid draft.

## Final Application

Only one final result may be committed.

### As Swipe

- Append exactly one swipe.
- Select the appended swipe.
- Persist one Post-process marker on that swipe.
- Never append a duplicate when the final text equals the currently selected source.

### Replace

- Allowed only when every runnable stage succeeds.
- Replace the selected source text in place.
- Preserve swipe count.
- Persist one Post-process marker on the replaced message/swipe.

### Partial result safety

A partial Progressive result is always committed As Swipe, even when the saved setting is Replace. The status must say that Replace was withheld because at least one category failed.

## Persisted Marker

The final result stores structural evidence only:

```js
{
  schema: "recursion.postProcessMarker.v1",
  operationId: "post-process-…",
  sourceHash: "…",
  candidateHash: "…",
  deckId: "…",
  rewriteFlow: "progressive",
  requestedApplyMode: "replace",
  committedApplyMode: "as-swipe",
  lane: "reasoner",
  partial: true,
  categories: [
    {
      categoryId: "natural-prose",
      status: "success",
      guidanceAttempts: 1,
      hostAttempts: 1
    },
    {
      categoryId: "follow-through",
      status: "failed",
      failureStage: "guidance",
      guidanceAttempts: 2,
      hostAttempts: 0
    }
  ]
}
```

Do not persist raw prompts, guidance text, provider output, transcript excerpts, intermediate drafts, hidden reasoning, or provider secrets.

## Runtime Ownership and Cancellation

Post-processing is armed during `prepareForGeneration` and begins only after the original assistant response has fully landed.

While the native quiet writer is running:

- internal generation events are owned by the active Post-process operation;
- they must not arm or recursively start another Post-process operation;
- ordinary pre-process cleanup must still settle safely;
- host controls remain locked;
- the unified Stop action aborts the active guidance request or quiet generation;
- the transient Post-process prompt key is cleared in `finally`;
- no stale result may commit after stop, chat change, edit, delete, swipe, or character/group change.

## Progress and Status

### Unified

```text
Post-processing response
├─ Synthesizing Unified guidance       Utility|Reasoner
├─ Rewriting with SillyTavern          Host
└─ Adding Post-process swipe|Replacing response
```

### Progressive

```text
Post-processing response
├─ Natural Prose
│  ├─ Synthesizing guidance            Utility|Reasoner
│  └─ Rewriting with SillyTavern       Host
├─ Follow Through
│  ├─ Synthesizing guidance            Utility|Reasoner
│  └─ Rewriting with SillyTavern       Host
└─ Adding Post-process swipe|Replacing response
```

State colors follow the existing Recursion grammar:

- cyan: running;
- green: complete;
- amber: retry, recovered host call, or partial final result;
- red: failed category or failed Unified operation;
- muted: skipped or user-canceled.

A failed Progressive category makes that category red but does not make later successful categories look failed. The final parent is amber when the committed result is partial.

## UI Design

The visual contract remains SillyTavern-native, compact, graphite-dark, and operational.

### Bar

```text
[power] [pipeline] [mode] [pre cards] [post cards] [form] | [progress] ... [reasoning] v | ...
```

- The existing Cards icon becomes the Pre-process Cards control.
- The existing Enhancements slot becomes the Post-process Cards control.
- Both are icon-only 24px controls with accessible names and tooltips.
- The Post-process icon uses neutral chrome when Off, cyan active treatment when On, amber while the last result is partial, and red only for a terminal failure.
- The bar does not show `Unified` or `Progressive` as permanent text.

### Post-process panel

The panel reuses the Pre-process Card panel's geometry, deck bar, category rows, card rows, editor treatment, delete confirmations, drag handles, mobile clamping, and status routing.

The header order is:

```text
Post-process Cards [summary] [Off/On] [As Swipe|Replace] [Unified|Progressive] [eye] [eye-off]
[active deck selector]                 [deck actions]
---------------------------------------------------
ordered categories and cards
```

- `Apply` and `Rewrite Flow` use compact segmented controls in the upper-right header immediately before the bulk eyes.
- The open eye enables all runnable cards; the slashed eye disables all runnable cards.
- The feature-level On/Off control is explicit and keyboard reachable.
- Starter-deck structural edit actions are disabled with a tooltip directing the user to Duplicate; state controls remain enabled.
- Category and card state uses open-eye/slashed-eye icons only; no eye-plus state.
- Category rows show their effective runnable-card count.
- Card rows show name and concise description; the full prompt appears in the editor.
- Successful actions route through the main Recursion status text/mobile drawer rather than inserting temporary notice rows.
- Outside click and Escape close the panel unless an editor or destructive confirmation is active.

### Accessibility

- Every icon button has an `aria-label` and matching tooltip.
- Segmented controls expose `aria-pressed`.
- Category expanders expose `aria-expanded`.
- Toggles expose saved and effective state.
- Drag handles have descriptive labels and keyboard move controls.
- Focus returns to the launching control after panel close.
- All status changes are announced through the existing polite live region.
- Reduced motion disables animated running treatments.

### Stable browser selectors

At minimum:

```text
data-recursion-pre-process-cards-button
data-recursion-post-process-cards-button
data-recursion-post-process-panel
data-recursion-post-process-enabled
data-recursion-post-process-deck-select
data-recursion-post-process-deck-duplicate
data-recursion-post-process-deck-new
data-recursion-post-process-deck-edit
data-recursion-post-process-deck-delete
data-recursion-post-process-apply-as-swipe
data-recursion-post-process-apply-replace
data-recursion-post-process-flow-unified
data-recursion-post-process-flow-progressive
data-recursion-post-process-category
data-recursion-post-process-category-toggle
data-recursion-post-process-category-drag-handle
data-recursion-post-process-card
data-recursion-post-process-card-toggle
data-recursion-post-process-card-drag-handle
data-recursion-post-process-card-editor
data-recursion-post-process-card-prompt
data-recursion-post-process-progress
```

## Diagnostics and Privacy

Safe diagnostics may contain:

- operation/run ids;
- active deck/category/card ids;
- hashes and lengths;
- frozen reasoning setting and selected lane;
- attempt counts;
- stage states and failure codes;
- requested and committed apply modes;
- final partial flag;
- host generation source `context.generate:quiet`.

Diagnostics must not contain raw card prompts, synthesized guidance, source/candidate prose, transcript excerpts, character secrets, World Info, private notes, cookies, or provider credentials.

Generation-enabled Playwright runs must not capture screenshots or traces.

## Acceptance Criteria

The feature is complete only when all of the following are proven:

1. Enhancements no longer exists as a current UI, settings, runtime, provider, progress, or diagnostics contract.
2. Pre-process and Post-process deck selections are independent.
3. The starter Post-process Deck contains exactly the two approved categories and six approved cards.
4. Post-process categories and cards are binary On/Off.
5. Unified performs one guidance synthesis and one native host rewrite.
6. Progressive performs one guidance synthesis and one native host rewrite per runnable category.
7. Each Progressive category receives the latest valid prior rewrite plus the same frozen supporting context.
8. Low/Medium use Utility; High/Ultra use Reasoner.
9. Guidance synthesis never crosses lanes.
10. Guidance and host calls each retry once under their separate budgets.
11. A successful guidance packet is reused for the host retry.
12. A failed Progressive category fails soft and later categories continue.
13. SillyTavern's native `quiet` generation is the writer.
14. The writer uses the active host preset/context and does not use Recursion's bounded guidance context as a replacement host context.
15. Intermediate rewrites never enter chat persistence.
16. Exactly one final swipe or replacement is committed.
17. Partial results are marked partial and forced to As Swipe.
18. Stop, stale source, or total failure leaves the original response unchanged.
19. Desktop and compact UI visual baselines pass.
20. A live dedicated-user proof verifies installed bytes, outbound Post-process prompt presence, native writer ownership, final mutation, marker binding, and absence of intermediate chat mutations.

## Supersession

This approved design supersedes all prior current-state design statements that describe:

- a single Enhancements mode selector;
- Repair, Recompose, or Redirect;
- Generation Review as the post-generation feature;
- dialogue/prose enhancement targets;
- fixed pre-canned enhancement behavior;
- Utility fallback for a failed Reasoner post-generation pass.

Historical documents may remain in Git history, but the implementation pass must update current documentation to this contract and remove obsolete executable paths rather than maintaining parallel behavior.
