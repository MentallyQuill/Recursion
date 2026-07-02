# Card System Spec

## Overview

The card system is Recursion's scene-local prompt cache. Sidecar model calls generate and refresh small cards that describe the current scene, then the runtime selects a turn hand from those cards for prompt composition.

Cards are cache artifacts, not memories. They are disposable, scene-local, and allowed to be regenerated, stowed, discarded, or replaced whenever the current scene, prompt budget, or turn need changes. They must not become durable lore, canon, hidden memory, or a replacement for extensions that own long-term recall.

The Utility Arbiter is the primary decision engine for card utility. It makes model-mediated decisions about what to create, keep, stow, discard, regenerate, select, and emphasize. Runtime code may enforce schemas, token budgets, freshness caps, source ranges, and state transitions, but it should not replace the Arbiter with brittle deterministic semantic relevance scoring.

Related design docs:

- [Product Scope](RECURSION_PRODUCT_SCOPE.md)
- [Behavior Settings Policy Spec](BEHAVIOR_SETTINGS_POLICY_SPEC.md)
- [Runtime Architecture](../architecture/RUNTIME_ARCHITECTURE.md)
- [Prompt Composition Spec](../architecture/PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics](../architecture/STORAGE_AND_DIAGNOSTICS.md)
- [UI Spec](UI_SPEC.md)

## Card Families

V1 should use the full fixed catalog below. The Arbiter receives this predetermined catalog as a menu and decides what is already represented, what is missing, and what should be generated for the current scene. Implementation tests may use smaller fixtures, but the shipped V1 product should expose the full catalog to the Arbiter.

| Family | Purpose | Prompt Use |
| --- | --- | --- |
| Scene Frame | Current location, situation, participants, and immediate dramatic direction. | Usually eligible for every turn hand while the scene is active. |
| Active Cast | Who is present, their visible state, and current conversational or physical role. | Helps prevent dropped characters and speaker confusion. |
| Character Motivation | Observable or safely inferred motives, pressures, hesitations, and goals. | Replaces raw internal-thought injection with bounded writing guidance. |
| Dialogue/Relationship | Current conversational tension, relationship texture, promises, conflicts, and voice constraints. | Guides reply tone, subtext, and relational continuity. |
| Continuity Risk | Facts likely to be contradicted if omitted from the next response. | High-priority safety lane for fragile scene facts. |
| Knowledge/Secrets | Concealed facts, who knows or suspects them, mistaken beliefs, and reveal boundaries. | Guardrail lane for knowledge state and spoiler-safe reveal control. |
| Clocks/Consequences | Deadlines, countdowns, delayed consequences, and escalation triggers. | Keeps near-term pressure visible without turning it into durable memory. |
| Environment/Affordances | Spatial layout, sensory texture, hazards, obstacles, exits, and usable environmental affordances. | Keeps action grounded in the current scene. |
| Possessions/Items | Important held, carried, worn, hidden, lost, stolen, or controlled objects and who has them. | Tracks item ownership and immediate object affordances. |
| Prose/Pacing | Local craft guidance for density, momentum, specificity, and response shape. | Low-volume style guidance, not a replacement for the user's preset. |
| Open Threads | Unresolved questions, immediate promises, pending actions, and near-term pressures. | Keeps the next response aware of visible story obligations. |

V1 should not support arbitrary user-defined card families. Custom families can wait until the fixed catalog proves insufficient.

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
4. Sidecar generation creates or refreshes only the requested cards.
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
- `regenerate`: replace a stale or low-quality card.
- `select`: include a card in the next turn hand.
- `emphasize`: give a selected card higher priority or stronger prompt placement.

The Arbiter also decides whether a catalog slot is already represented by existing cards. For example, it should avoid generating a separate Dialogue/Relationship card if the relevant relationship pressure is already captured cleanly in Active Cast or Character Motivation.

Runtime support is allowed but bounded. Deterministic code may deduplicate by ID, enforce maximum card counts, reject malformed outputs, cap tokens, and mark old cards stale. It should not be the primary semantic relevance judge.

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
4. Prompt composition installs the resulting brief.
5. Diagnostics record what was selected, omitted, and why.

A card can exist in the deck without appearing in the hand. A hand can omit a valid card because the current turn does not need it or the prompt budget is better spent elsewhere.

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
- card family, status, detail profile, and emphasis;
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
- complex manual deck management;
- broad character database extraction.

The first version should prove the core loop: generate small scene-local cards, let the Utility Arbiter manage utility decisions from a fixed catalog, select a compact turn hand, and feed prompt composition without turning cards into memories.
