# Recursion Generation Review and Enhancement Design

## Status

**Approved direction.** This design supersedes the product direction of separate Prose and Dialogue enhancement controls. The implementation authority is [Generation Review and Enhancement Contract](../../architecture/ENHANCEMENT_REVIEW_AND_PATCH_CONTRACT.md), together with the shared [Structured Output Recovery Design](2026-07-13-recursion-structured-output-recovery-design.md). Generation Review has one visible operation and one shared correction budget, not an independent semantic retry layered on top of parser recovery.

## Product decision

Recursion exposes one user-facing **Enhancement** operation. It reviews the completed SillyTavern assistant response as a whole and creates a bounded enhanced result when it finds repairable defects.

Enhancement is not a generic rewriter and does not edit card decks. It is a card-aware quality review that uses the exact generation context to improve the response where that context supports a specific correction.

```text
Frozen turn hand + installed Prompt Packet + finished ST response
    -> Generation Review
    -> exact dialogue or prose revisions
    -> enhanced Replace or As Swipe result
```

The internal review domains are:

1. Turn fulfillment: does the reply engage the immediate user turn?
2. Card and scene fidelity: does it respect the relevant guidance that actually entered the Prompt Packet?
3. Narrative execution: character voice, dialogue, prose, pacing, subtext, staging, and causality.
4. Anti-slop: repeated, generic, unsupported, or contextually inappropriate language.

These are review dimensions, not separate user controls or separate paid model calls.

## User contract

### What Enhancement does

- Evaluates the generated response against the frozen generation context.
- Checks whether installed custom or bundled card guidance was honored when relevant.
- Identifies local, evidence-backed repairs in dialogue, prose, pacing, subtext, scene staging, and anti-slop.
- Applies only deterministic patches that Recursion can validate against the original response.
- Creates an enhanced swipe when configured for As Swipe, preserving the original reply.
- Reports the real result, including cache reuse, a partial failure, or a material issue that needs a new generation.

### What Enhancement does not do

- It does not require every selected card to be quoted or visibly restated.
- It does not judge a response against a deck edited after that response was generated.
- It does not silently edit a user-authored card, category, or deck.
- It does not invent missing scene outcomes or new facts to make a card appear satisfied.
- It does not call an output `enhanced` if no validated patch was applied.

## Frozen generation evidence

The review uses the generation-time snapshot, never live mutable settings:

```ts
type GenerationReviewSnapshot = {
  source: {
    messageId: number;
    swipeId: number;
    text: string;
    hash: string;
    sourceRevisionHash: string;
  };
  deck: {
    id: string;
    name: string;
    revisionHash: string;
  };
  installedHand: InstalledCardManifest[];
  promptPacket: PublicPromptPacket;
  lastBrief: PublicLastBrief;
  storyForm: StoryForm;
  context: BoundedEnhancementContext;
  antiSlopProfileVersion: string;
};

type InstalledCardManifest = {
  cardId: string;
  categoryId: string;
  name: string;
  description: string;
  promptText: string;
  kind: 'authored' | 'generated';
  selectionState: 'active' | 'priority';
  packetRefs: string[];
  sourceCardIds: string[];
};
```

Only an installed hand entry can become a card-review obligation. A draft, inactive, priority-overflow, Auto-omitted, or merely stored custom card is not a failure of the finished response.

## Custom deck support

Custom cards and bundled cards follow the same review rules. The reviewer does not infer meaning from category names, because custom categories are organization only. It evaluates each installed card by its stable ID, instruction-shaped `promptText`, placement in the installed packet, and source lineage.

Priority has stronger review attention than normal Active:

- `priority`: the card was forced ahead of Auto backfill. If relevant to the current beat, lack of influence is a meaningful finding.
- `active`: review only when it was selected into the installed hand.
- `off` or draft: excluded.

For Fused output, the manifest must preserve the source-card IDs that contributed to fused guidance. A successful fused category generation is not proof that every underlying custom card influenced the finished SillyTavern response.

Each applicable installed card receives one review outcome:

| Outcome | Meaning |
| --- | --- |
| `honored` | The response reflects relevant guidance. |
| `repaired` | A validated response patch restored relevant guidance. |
| `not-applicable` | The card was installed but correctly did not need visible expression this beat. |
| `partially-reflected` | A concrete concern remains after review. |
| `violated` | The response contradicts applicable guidance. |
| `requires-regeneration` | The defect is material and not safely repairable by a bounded patch. |

Custom-card text is model context, never executable authority over the reviewer schema, provider routing, or output format. It is passed in delimited data fields and remains subordinate to the review contract.

## Anti-slop design

The existing common slop list becomes a versioned **anti-slop taxonomy**, not a blind phrase blacklist.

| Review class | Examples from the existing list | Intervention rule |
| --- | --- | --- |
| Interaction traps | fake-choice endings, canned questions, parroting the user | Repair directly unless the user message itself requires that literal question. |
| Contextual voice failures | unsupported technical diction, tsundere deflection, stock romance language | Repair only when character, card, or genre evidence does not support it. |
| Repetition loops | breath, throat, gaze, jaw, pause, and micro-gesture loops | Repair when repeated, clustered, or used instead of visible scene action. |
| Empty atmosphere | generic tension, light, scent, and abstraction filler | Repair when it substitutes for staging, pressure, or concrete detail. |
| Intentional style | genre-specific or card-supported diction | Preserve when evidence shows it is purposeful. |

The review must never swap one phrase-list entry for a neighboring cliché. A repair should draw on the current scene, character behavior, or applicable card guidance.

```text
Weak:    "Her breath caught."
Grounded: "She stopped at the doorway, hand still on the frame."
```

## Revision scope

The reviewer has a bounded repair ladder:

| Scope | Use | Validation |
| --- | --- | --- |
| Line | Dialogue, wording, or local prose defect | Exact target ID and source text. |
| Sentence/paragraph | Repetition, staging, clarity, or local pacing defect | Exact contiguous target range. |
| Writable beat range | Not supported | Broad beat ranges are review-only because they overlap sentence targets; material beat defects become `requires-regeneration`. |
| Requires regeneration | Missing user response, major contradiction, or essential absent beat | No patch; explicit evidence result. |

A broad full-message rewrite is outside this feature. A material defect may later drive a deliberate corrective generation, but that is a separate, explicit operation.

## UI and progress contract

The compact Recursion bar exposes a single Enhancement control. During execution it reports concise state through the main bar:

```text
Reviewing generated response...
Checking active card influence...
Applying 3 grounded revisions...
Enhanced swipe ready.
```

The progress popover pre-creates stable rows once and updates them in place. It must never rebuild the tree on refresh heartbeats.

```text
Enhancing                         Reviewing generated response...

  cyan spinner  Capturing source response
  gray circle   Generation review
    gray circle   Turn fulfillment
    gray circle   Card and scene fidelity
    gray circle   Narrative execution
    gray circle   Anti-slop
  gray circle   Applying revisions
  gray circle   Enhanced swipe
```

Completed example:

```text
Ready                             Enhancement applied

  green circle  Captured source response                         done
  green circle  Generation review                                revised
    green circle  Turn fulfillment                              passed
    green circle  Card and scene fidelity                       4 honored, 1 repaired
      green circle  Scene Frame                                3 honored
      green circle  Relationship                               1 repaired
      gray circle   Environment                                not applicable
    green circle  Narrative execution                          2 revisions
    green circle  Anti-slop                                    2 grounded replacements
  green circle  Applying revisions                              done
  green circle  Enhanced swipe                                  added
```

State colors retain the existing Recursion contract:

- cyan: currently running only;
- green: a verified successful review, patch, or applied result;
- purple: a valid cached review result;
- yellow: an unresolved explicit caution with an inspectable reason;
- red: provider, validation, application, or material generation failure;
- gray: waiting, disabled, or not-applicable.

Rows retain gray text; indicators and status labels carry state. Mobile uses the same tree with fixed compact row height, internal scrolling, tap-to-expand details, and press-and-hold access to truncated reason text. The page must not shift as review states resolve.

## Success criteria

- One enhancement action assesses all review domains in one normal provider call.
- A custom card can be reviewed only when it was installed in the generation-time Prompt Packet.
- Active, Priority, omitted, draft, bundled, authored, Standard, and Fused card lineage is visible and correctly distinguished.
- Anti-slop repairs are contextual and card/character-aware rather than blind phrase substitution.
- Every visible success, cache, caution, or failure state is backed by deterministic runtime evidence.
- An enhanced swipe contains only validated, bounded changes and is not created for an unchanged source.
- Desktop and mobile progress menus remain compact, stable, and readable during live provider calls.
- A malformed result, schema mismatch, or incomplete card-outcome ledger spends at most one total correction request. A safe patch with unresolved card coverage is `partial-failed`, with red card children rather than a false green review.
