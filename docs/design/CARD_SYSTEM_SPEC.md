# Card System Spec

## Overview

The card system is Recursion's scene-local reasoning cache. Sidecar model calls generate and refresh small cards that expand what the active scene implies for the next response, then the runtime selects a turn hand from those cards for prompt composition.

Cards are cache artifacts, not memories. They are disposable, scene-local, and allowed to be regenerated, stowed, discarded, or replaced whenever the current scene, prompt budget, or turn need changes. They must not become durable lore, canon, hidden memory, continuity ledgers, or a replacement for extensions that own long-term recall.

The implemented operator layer now includes a read-only bundled Default Deck plus normalized custom decks. Custom decks contain ordered categories and authored or generated cards, while the runtime still maintains a separate disposable scene-local cache and rebuilds a bounded turn hand for each prompt event. Deck editing, card state, priority, and ordering are configuration controls; they do not turn the hand into durable memory.

Recursion is not a continuity extension. A card should not merely remember that a fact exists. It should use current scene evidence to derive useful next-turn implications: affordances, constraints, tensions, likely interruptions, reveal boundaries, access, social pressure, and relevance limits. The canonical card shape is:

```text
active scene evidence -> immediate implications for the next beat -> relevance boundary
```

Example: if Hermione is walking on the first floor of Hogwarts near the library, the Location/Situation focus should not just list "near the library" and should not dump general library lore. It should expand the current beat: high-traffic academic corridor, nearby routes and staircases, likely students or professors, muffled library/study atmosphere, sightlines, possible interruptions, and whether entering the library is actually relevant yet.

The Utility Arbiter is the primary decision engine for card utility. It makes model-mediated decisions about what to create, keep, stow, discard, regenerate, select, and emphasize. Runtime code may enforce schemas, token budgets, freshness caps, source ranges, and state transitions, but it should not replace the Arbiter with brittle deterministic semantic relevance scoring.

The Utility Arbiter also determines the active story form for the scene. Story form is the current tense and point of view inferred from the latest visible assistant narration first, with the pending user message used only when no assistant narration exists. Runtime validates that `storyForm` and passes it to card generation, guidance composition, and Rapid artifacts so raw card evidence does not introduce conflicting tense or POV.

Related design docs:

- [Product Scope](RECURSION_PRODUCT_SCOPE.md)
- [Behavior Settings Policy Spec](BEHAVIOR_SETTINGS_POLICY_SPEC.md)
- [Runtime Architecture](../architecture/RUNTIME_ARCHITECTURE.md)
- [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics](../architecture/STORAGE_AND_DIAGNOSTICS.md)
- [UI Spec](UI_SPEC.md)

## Card Families

V1 uses the audited fixed catalog below. The Arbiter receives this predetermined catalog as a menu and decides what is already represented, what is missing, and what should be generated for the current scene.

| Family | Purpose | Prompt Use |
| --- | --- | --- |
| Scene Frame | Current location, situation, immediate direction, and hard beat boundary. | Usually eligible for every turn hand while the scene is active. |
| Active Cast | Who is present, their visible state, and current conversational or physical role. | Helps prevent dropped characters and speaker confusion. |
| Character Motivation | Observable or safely inferred motives, pressures, hesitations, and goals. | Replaces raw internal-thought injection with bounded behavior guidance. |
| Relationship | Current conversational tension, relationship texture, promises, conflicts, and voice constraints. | Guides reply tone, subtext, and active relationship implications. |
| Social Subtext | Scene-observable implied social meaning such as humor, veiled pressure, invitation, boundaries, status, and face. | Helps prevent literal reads of deniable, indirect, or socially loaded cues. |
| Scene Constraints | Hard limits, contradiction traps, timing, access, visibility, and plausibility constraints. | High-priority safety lane for scene constraints. |
| Knowledge | Concealed facts, who knows or suspects them, mistaken beliefs, and reveal boundaries. | Guardrail lane for knowledge state and spoiler-safe reveal control. |
| Consequences | Deadlines, countdowns, delayed consequences, and escalation triggers. | Keeps near-term pressure visible without turning it into durable memory. |
| Environment | Spatial layout, sensory texture, hazards, obstacles, exits, and usable environmental affordances. | Keeps action grounded in the current scene. |
| Items | Important held, carried, worn, hidden, lost, stolen, or controlled objects and who has them. | Tracks item ownership and immediate object affordances. |
| Open Threads | Unresolved questions, immediate promises, pending actions, and near-term pressures. | Keeps the next response aware of visible story obligations. |

Each family also exposes fixed scope facets. Facets do not create separate cards; they define what the Arbiter and card generator should emphasize inside that family. The facet labels and descriptions live in `src/card-scope.mjs` and are reused for Arbiter catalog payloads, card-generation prompt focus, UI hover help, and diagnostics.

In Manual mode, the selectable card unit is the family row, not the facet. A selected family counts as one forced Manual card and must be covered by valid cache reuse or provider generation unless that family fails validation. Facets remain per-family focus hints; toggling them never creates extra card jobs and never counts against `Max Cards`.

V1 should not support arbitrary user-defined card families. Custom families can wait until the fixed catalog proves insufficient.

## Card Family Audit

The implemented catalog follows this direction:

| Family | Decision | Reasoning-expansion target | Avoid |
| --- | --- | --- | --- |
| Scene Frame | Keep, reframe | Expand the active situation into usable next-beat context: location implications, immediate problem, nearby routes, current pressure, and what the scene is asking for next. | Flat scene summaries, broad setting lore, or restating the last message. |
| Active Cast | Keep | Expand who can plausibly act, speak, observe, interrupt, or be forgotten because they are silent but present. | Character roster recap or durable relationship tracking. |
| Character Motivation | Keep, safety-bound | Expand visible goals, pressures, hesitation, and likely behavior vectors from observable evidence. | Hidden thoughts, private plans, mind-reading, or future plot steering. |
| Relationship | Keep, reframe | Expand social affordances: leverage, tension, debts, promises, refusals, trust, threat, address, and what would escalate or soften the exchange. | Generic dialogue-tone advice or long relationship history. |
| Social Subtext | Add, safety-bound | Expand implied social meaning the next response could miss: dry humor, veiled pressure, flirtation or refusal cues, status moves, and face-saving dynamics. | Generic prose coaching, certainty about private desire, or turning subtext into blunt narration. |
| Scene Constraints | Keep | Use as scene constraints: hard limits, contradiction traps, cause/effect, timing, access, visibility, or state that would make the next response implausible if missed. | Continuity-extension posture, durable canon arbitration, or collecting facts just because they are true. |
| Knowledge | Keep | Expand knowledge asymmetry: who knows, suspects, misunderstands, can infer, must not learn, or can safely reveal something now. | Spoiler storage, secret-lore dumps, or revealing hidden facts as narration. |
| Consequences | Keep | Expand near-term pressures from choices already in motion: deadlines, delayed effects, escalation triggers, windows of opportunity, and likely fallout. | Long plot planning or future-story scripting. |
| Environment | Keep, core | Expand local affordances: sightlines, routes, exits, obstacles, hazards, sensory cues, usable objects, social exposure, and plausible interruptions. | Decorative description or encyclopedia detail unrelated to the current beat. |
| Items | Keep | Expand object affordances: who controls an item, where it is, who can reach it, what it enables, and what risk it creates right now. | Inventory management for its own sake. |
| Open Threads | Keep, reframe | Expand visible unresolved obligations and hooks: pending questions, requested actions, promises awaiting payoff, interrupted moves, and near-term choices. | Backlog/task-list behavior or duplicating Consequences without next-turn relevance. |

The highest-value Recursion cards are the ones that surface non-obvious next-response implications. Low-value cards are those that merely preserve facts, restate obvious context, teach the model broad lore, or provide generic prose coaching.

## Card Facet Audit

This is the implemented sub-item catalog for `src/card-scope.mjs`. Facets are not separate generated cards today, but they are the user-facing card-scope items and the prompt focus sent to the Arbiter/card generator. Future catalog changes should update these facets, labels, tests, UI hover copy, provider prompt focus, and docs together.

| Family | Facet | Decision | Target meaning | Avoid |
| --- | --- | --- | --- | --- |
| Scene Frame | `locationSituation` | Keep | Expand current location and situation into nearby routes, sightlines, social exposure, local pressure, and what is relevant now. | Listing place names, broad setting lore, or unrelated room detail. |
| Scene Frame | `immediateDirection` | Keep | Identify the next-beat vector the scene is pointing toward without deciding future plot. | Plot planning, railroading, or summarizing the last message. |
| Scene Frame | `beatConstraint` | Keep | Preserve hard response boundaries such as answer now, hold before a reveal, avoid time skip, or do not skip a pending payoff. | Generic pacing coaching. |
| Active Cast | `presentCharacters` | Keep | Track who can act, observe, interrupt, be addressed, or be accidentally dropped from the next response. | Durable cast lists or inventing absent characters. |
| Active Cast | `visibleState` | Keep | Surface observable condition, posture, injury, constraint, mood, or capability that changes what the character can do now. | Private feelings or generic mood tags. |
| Active Cast | `speakerRoles` | Keep, reframe | Clarify who is speaking, addressed, listening, controlling the exchange, or unable to speak. | Dialogue formatting advice detached from the scene. |
| Character Motivation | `visibleGoals` | Keep | Express established visible goals as behavior-facing pressure for the next response. | Secret goals or hidden plans as fact. |
| Character Motivation | `pressures` | Keep | Expand external, social, tactical, and emotional pressures that plausibly shape behavior. | Unfounded psychology or omniscient motive claims. |
| Character Motivation | `hesitationPosture` | Keep, reframe | Capture observable reluctance, guardedness, confidence, uncertainty, or restraint. | Mind-reading or first-person internal monologue. |
| Relationship | `tension` | Keep | Expand current friction, trust, leverage, intimacy, threat, or subtext into usable social affordances. | Generic tone labels. |
| Relationship | `promisesConflicts` | Keep | Preserve active promises, refusals, debts, threats, disagreements, and obligations because they shape what can be said or done next. | Long relationship history or continuity ledger behavior. |
| Relationship | `voiceConstraints` | Conditional, reframe | Keep only as scene-local address/speech constraints, such as formality, taboo wording, secrecy, or who can safely say what. | Replacing the preset, generic style coaching, or broad voice imitation. |
| Social Subtext | `humorIrony` | Keep | Capture dry humor, sarcasm, teasing, understatement, or gallows humor when it signals deflection, intimacy, contempt, nervousness, or pressure relief. | Making the response generically funnier or explaining every joke. |
| Social Subtext | `veiledPressure` | Keep | Capture polite threats, friendly warnings, coercion, intimidation, or consequences carried through implication instead of open hostility. | Flattening indirect danger into blunt threats or inventing intent. |
| Social Subtext | `invitationBoundary` | Keep | Capture flirtation, charged compliments, testing interest, permission seeking, discomfort, soft refusal, or cues not to push further. | Claiming private desire as fact or escalating beyond observable consent cues. |
| Social Subtext | `statusFace` | Keep | Capture dominance, deference, rank assertion, saving face, public embarrassment, or who is being made to yield in the exchange. | Generic power-level summaries or unrelated relationship history. |
| Scene Constraints | `hardLimits` | Keep | Treat as hard scene constraints and plausibility traps: injuries, locked routes, missing objects, stated choices, or visible limits. | Collecting facts merely because they are true. |
| Scene Constraints | `spatialConstraints` | Keep | Preserve movement, reach, visibility, blocked route, distance, and access limits that affect the next beat. | General map summary better handled by Environment. |
| Scene Constraints | `timelineOrder` | Keep | Track immediate cause/effect, sequence, reveal order, and what has not happened yet. | Long timeline management or durable canon arbitration. |
| Knowledge | `concealedFacts` | Conditional, reframe | Use only for scene-active hidden facts that shape behavior or guardrails. | Secret-lore storage or spoiler dumps. |
| Knowledge | `knowsSuspects` | Keep | Clarify who knows, suspects, misunderstands, can infer, or should not know a relevant fact. | Omniscient narration or private knowledge leakage. |
| Knowledge | `revealBoundaries` | Keep | Define what the next response must not reveal, confirm, imply, or over-explain too early. | Turning hidden facts into narration. |
| Consequences | `deadlinesCountdowns` | Keep | Surface active time pressure, windows of opportunity, scheduled interruptions, and countdowns. | Long calendar tracking. |
| Consequences | `delayedConsequences` | Conditional, reframe | Keep near-term fallout from earlier choices that could reasonably arrive or remain pending in this scene. | Broad future plotting. |
| Consequences | `escalationTriggers` | Keep | Capture conditions that would worsen, shift, interrupt, or force action in the current scene. | Punishing the player or scripting outcomes. |
| Environment | `spatialLayout` | Keep, core | Expand local geometry, entrances, barriers, cover, distance, actor positions, and usable paths. | World map or lore overview. |
| Environment | `sensoryTexture` | Conditional, reframe | Keep sensory signals that affect grounding, attention, danger, social context, or available action. | Decorative prose filler. |
| Environment | `hazardsAffordances` | Keep, core | Surface obstacles, threats, exits, cover, tools, opportunities, and things the model might fail to use. | Generic ambience. |
| Items | `heldCarriedItems` | Conditional, reframe | Track active objects only when possession, absence, concealment, or readiness matters now. | Inventory management for its own sake. |
| Items | `itemLocationControl` | Keep, core | Clarify where the object is, who controls it, who can reach it, and who can withhold or use it. | Ownership lists without scene effect. |
| Items | `itemAffordancesRisks` | Keep, core | Expand what an item enables, blocks, threatens, exposes, or risks in the current beat. | Generic item descriptions. |
| Open Threads | `unresolvedQuestions` | Conditional, reframe | Keep questions only when they create visible next-turn pressure, uncertainty, or a decision point. | Backlog of every question raised. |
| Open Threads | `pendingActions` | Keep | Preserve attempted, requested, promised, interrupted, or awaited actions that should influence the next response. | Task-list behavior detached from the scene. |
| Open Threads | `nearTermPressures` | Keep | Capture immediate obligations, looming problems, choices, or hooks that shape the next beat. | Duplicating Consequences without added next-turn value. |

Net facet direction: every implemented sub-item must act as an implication expander. Broad craft guidance belongs to the user's preset and behavior settings; hard beat constraints live under Scene Frame. The riskiest keeps are `voiceConstraints` and Social Subtext facets, which must remain scene-local speech/address or observable subtext constraints rather than a style-preset substitute.

## Card Data Contract

Cards should have a compact structured shape. The exact schema can evolve, but V1 cards should carry only what runtime, prompt composition, storage diagnostics, and the inspector need.

```ts
type RecursionCard = {
  id: string;
  schemaVersion: number;
  family: CardFamily;
  sceneId: string;
  catalogKey: string;
  status: "candidate" | "active" | "stowed" | "stale" | "discarded";
  source: {
    chatId: string;
    firstMesId: number;
    lastMesId: number;
    fingerprint: string;
  };
  promptText: string;
  summary: string;
  evidenceRefs: string[];
  tokenEstimate: number;
  detailProfile: "compact" | "standard" | "expanded";
  emphasis: "normal" | "emphasized" | "muted";
  origin?: "cache" | "generated" | "fallback";
  freshness: {
    generatedAt: string;
    sourceFingerprint: string;
    expiresAfterMesId?: number;
  };
  arbiter: {
    lastDecisionId: string;
    reason: string;
  };
  inspectorNotes?: string;
};
```

Contract rules:

- `promptText` is the only card text eligible for injection.
- `promptText` is instruction-shaped private evidence, not story prose. A generated card should contain short lines such as `Keep Jack at Capodichino immediately after landing`, `Preserve his weak cover and lack of field readiness`, and `Do not skip the sergeant response beat`. It must not contain mini-scenes, dialogue, sensory recap paragraphs, or decorative narration.
- `inspectorNotes` is diagnostic-only and must never be sent to prompt composition.
- `evidenceRefs` should point to source turns or extracted facts, not create new canon.
- `summary` is for UI scanning and diagnostics, not a second prompt body.
- `tokenEstimate` is an estimate used for budgeting; prompt composition may recalculate.
- Runtime may reject, truncate, or mark cards stale when schema, size, or source checks fail.

## Card Lifecycle

The lifecycle is intentionally short:

1. Runtime captures the current turn snapshot, scene fingerprint, active deck, and fixed card catalog.
2. The Utility Arbiter reviews the catalog menu against the current scene deck.
3. The Arbiter decides which card slots are already represented, missing, stale, overrepresented, or newly important.
4. Runtime budgets requested `cardJobs` before sidecar generation, so provider calls are made only for card jobs that can fit the effective turn hand.
5. Runtime validates schema, token estimates, source ranges, status transitions, and freshness metadata.
6. The Arbiter may stow, discard, regenerate, select, or emphasize cards after seeing the validated deck.
7. Runtime builds a turn hand and passes it to prompt composition.
8. Cards remain in the scene deck until they become stale, are discarded, or the scene invalidates.

Card states:

- `candidate`: generated but not yet accepted for the scene deck.
- `active`: eligible for turn hand selection.
- `stowed`: retained for the scene but not currently useful.
- `stale`: source or freshness checks indicate that the card needs Arbiter review.
- `discarded`: removed from prompt eligibility and kept only as bounded diagnostic history if diagnostics are enabled.

## Utility Arbiter Responsibilities

The Utility Arbiter owns semantic utility decisions. It receives:

- the fixed V1 card catalog;
- the current scene deck;
- source turn snapshot and scene fingerprint;
- current user message or generation trigger;
- prompt budget and detail profile targets;
- freshness and validation metadata from runtime;
- recent Arbiter decisions when available.

The Arbiter outputs structured decisions:

- `create`: request a missing card from a catalog slot.
- `stow`: keep a card in the scene deck but remove it from likely hand selection.
- `discard`: remove a card that is obsolete, duplicative, misleading, or outside the scene.
- `regenerate`: mark a stale or low-quality cached card as stale.
- `select`: include a card in the next turn hand.
- `emphasize`: give a selected card higher priority or stronger prompt placement.

The Arbiter also decides whether a catalog slot is already represented by existing cards. For example, it should avoid generating a separate Relationship card if the relevant relationship pressure is already captured cleanly in Active Cast or Character Motivation.

Runtime support is allowed but bounded. Deterministic code may deduplicate by ID, enforce maximum card counts, reject malformed outputs, cap tokens, and mark old cards stale. It should not be the primary semantic relevance judge.

Manual mode is the exception where deterministic runtime support enforces user intent: after the Arbiter returns, runtime reconciles selected Manual families against filtered Arbiter jobs and valid cache cards. Missing selected families receive synthesized one-family `cardJobs` with `forcedBy: "manual-selection"`. The provider envelope remains unchanged: one `recursion.card.v1` response item for the requested family.

Refresh is a two-part contract. The Arbiter requests new work through `cardJobs`, optionally naming `refreshOfCardId` for the cached card being replaced. Lifecycle `regenerate` marks the old cached card stale; by itself it does not create a replacement card. This keeps generation work explicit and prevents runtime from inventing semantic refreshes.

## Emphasis and Detail Profiles

Emphasis and detail are separate.

Detail profile controls how much text a card may carry:

- `compact`: one or two tight sentences for frequent inclusion.
- `standard`: default V1 shape for scene-local cards.
- `expanded`: only for cards the Arbiter expects to matter across several near turns.

Emphasis controls prompt priority:

- `normal`: eligible for selection under the current budget.
- `emphasized`: preferred for the turn hand and placed in a stronger prompt lane when budget allows.
- `muted`: retained in the deck but unlikely to enter the hand unless the scene changes.

Emphasis is not truth. It is a runtime hint about immediate usefulness. A muted card may still be valid, and an emphasized card may be dropped if it fails schema, freshness, or token-budget checks.

The Arbiter should use emphasis sparingly. V1 should prefer a small hand of high-utility cards over many lightly relevant cards.

## Character Motivation Safety

Character Motivation replaces raw internal-thought injection. Its job is to guide writing without pretending Recursion has privileged access to a character's private mind.

Allowed prompt text:

- visible or previously established goals;
- likely pressures expressed as uncertainty, not hidden fact;
- observable emotional posture;
- relationship friction that affects dialogue or action;
- concise guidance for how motivation should shape behavior.

Disallowed prompt text:

- first-person internal monologue;
- secret thoughts presented as known truth;
- spoilers, hidden plans, or private facts not present in the scene;
- instructions to reveal inner thoughts directly;
- diagnostic speculation copied into the prompt.

Safe phrasing should prefer language such as "appears," "seems," "is under pressure to," or "is likely guarding" when motivation is inferred from behavior. Private diagnostic notes may exist for the inspector to explain an Arbiter decision, but those notes must remain outside prompt composition.

Runtime rejects obvious Character Motivation prompt text that presents first-person internal monologue, secret thoughts, or reveal-inner-thought instructions. Provider prompts also state this rule up front so bad Motivation cards are prevented when possible and dropped when necessary.

## Scene Deck and Turn Hand

The scene deck is the current cache of cards for one scene. It may include active, stowed, and stale cards, but only active cards can be selected for injection.

The turn hand is the selected subset of cards for one prompt composition event. It is rebuilt for each generation trigger and should not be treated as durable state. The hand contains card IDs, family labels, prompt text, token estimates, emphasis, and any lane hints needed by [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md).

Expected flow:

1. Scene deck holds the disposable scene-local cache.
2. Utility Arbiter selects a hand from the deck.
3. Runtime applies token and schema checks.
4. Prompt composition installs the resulting V3 packet.
5. Diagnostics record what was selected, omitted, and why.

A card can exist in the deck without appearing in the hand. A hand can omit a valid card because the current turn does not need it or the prompt budget is better spent elsewhere.

## Card Deck Selection State

Editable Card Deck cards use one explicit selection field:

```ts
type CardSelectionState = "off" | "active" | "priority";
```

- `off`: the card is inactive and does not contribute to runtime scope or hand selection.
- `active`: the card is eligible for normal Auto backfill or Manual forcing.
- `priority`: in Auto, the card is forced ahead of normal Active cards; in Manual, it is treated as Active because Manual already forces selected cards directly.

Auto row clicks cycle `off -> active -> priority -> off`. Manual row clicks cycle `off -> active -> off`.

The Card Deck header exposes two bulk state actions for editable decks:

- open eye: set every runnable card to normal `active`, clearing all `priority` states;
- slashed eye: set every runnable card to `off`.

Draft cards are unchanged by both actions. The bundled Default deck is read-only, so these controls are disabled until the user duplicates it.

Card state icons use the supplied eye family: slashed eye for Inactive, open eye for Active, and eye-plus for Priority. Check and X remain confirm/cancel/delete-confirm language and must not be used as card-state icons.

Priority overflow is allowed. If the user marks more Priority cards than the effective `Max Cards` budget, Recursion uses deck category/card order, selects the top cards, records `priority-card-cap`, and omits the rest with `priority-over-max-cards`.

## Card Deck Organization

Editable Card Deck organization is direct manipulation. Category rows and card rows use compact grip handles instead of up/down buttons or a separate move mode.

- Category handles reorder categories by writing `categoryOrder`.
- Card handles reorder within a category or move a card to another category by writing `cardOrderByCategory` and the card's `categoryId`.
- Dropping a card onto a category header appends it to that category.
- The bundled Default deck is read-only and does not render organization handles.
- Category expand/collapse and card state cycling remain row interactions; dragging starts only from the grip handle.

Organization changes affect deck order and runtime selection priority, but they do not create a second visible runtime scope selector. Runtime scope derives from the active deck's card states and order.

## Invalidation/Refresh Rules

Runtime should distinguish hard invalidation from refresh requests.

Hard invalidation discards or retires the scene deck:

- chat identity changes;
- scene fingerprint changes sharply;
- active cast, location, or immediate situation changes enough to define a new scene;
- source transcript edit or deletion invalidates the card source range;
- schema version changes;
- prompt composition contract changes in a way that makes existing cards unsafe.

Refresh requests keep the deck but ask the Arbiter to review it:

- freshness cap reached;
- source window moved beyond the card's evidence range;
- user manually requests refresh;
- provider or model settings change;
- detail profile or prompt budget changes;
- Arbiter detects missing catalog coverage;
- runtime marks a card stale after validation or source checks.

The runtime may mark cards stale automatically. The Arbiter decides whether stale cards should be regenerated, stowed, discarded, or left alone after review.

## Inspector Visibility

The inspector should make the system understandable without making cards feel like user-managed memory.

V1 inspector visibility should include:

- current scene deck;
- current or latest turn hand;
- card family, status, detail profile, emphasis, and origin;
- source message range and freshness status;
- token estimate and budget outcome;
- Arbiter decision reason;
- cards omitted from the hand and the omission reason;
- validation errors and regeneration requests;
- private diagnostic notes clearly labeled as inspector-only.

Inspector actions should stay minimal in V1: refresh scene cards, discard a card, and copy diagnostics. Stow, force-emphasize, or custom card editing can wait unless the UI spec requires them.

## V1 Cuts

V1 should explicitly exclude:

- durable memory, lore, canon, or vector recall ownership;
- cross-scene card persistence;
- arbitrary user-authored card families;
- deterministic semantic relevance scoring as the primary decision engine;
- raw internal-thought injection;
- hidden chain-of-thought storage;
- large prompt-chain authoring UI;
- card marketplaces, plugins, or family packs;
- automatic permanent pinning;
- complex deck marketplaces or external pack management;
- broad character database extraction.

The first version should prove the core loop: generate small scene-local cards, let the Utility Arbiter manage utility decisions from a fixed catalog, select a compact turn hand, and feed prompt composition without turning cards into memories.
