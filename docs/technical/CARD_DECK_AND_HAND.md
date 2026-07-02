# Card Deck And Hand

The card system is Recursion's scene-local prompt cache. It is implemented by `src/cards.mjs`, coordinated by `src/runtime.mjs`, persisted by `src/storage.mjs`, and inspected through `src/ui.mjs`.

Cards are disposable cache artifacts. They are not memories, lore, canon, or user-authored prompt fragments.

## Fixed V1 Card Families

| Family | Provider role | Purpose | Prompt use |
| --- | --- | --- | --- |
| Scene Frame | `sceneFrameCard` | Current location, situation, participants, and dramatic direction. | Usually eligible while the scene is active. |
| Active Cast | `activeCastCard` | Who is present, visible state, and conversational or physical role. | Prevents dropped characters and speaker confusion. |
| Character Motivation | `characterMotivationCard` | Observable or safely inferred motives, pressures, hesitations, and goals. | Behavior-facing guidance without private thought injection. |
| Relationship | `dialogueRelationshipCard` | Current tension, relationship texture, promises, conflicts, and voice constraints. | Guides tone, subtext, and relational continuity. |
| Continuity Risk | `continuityRiskCard` | Facts likely to be contradicted if omitted. | High-priority safety guidance. |
| Knowledge | `knowledgeSecretsCard` | Concealed facts, who knows or suspects them, mistaken beliefs, and reveal boundaries. | Guardrail guidance for knowledge state and spoiler-safe reveals. |
| Consequences | `clocksConsequencesCard` | Deadlines, countdowns, delayed consequences, and escalation triggers. | Keeps near-term pressure visible. |
| Environment | `environmentAffordancesCard` | Spatial layout, sensory texture, hazards, obstacles, exits, and environmental affordances. | Grounds action and prose. |
| Items | `possessionsItemsCard` | Important held, carried, worn, hidden, lost, stolen, or controlled objects and who has them. | Tracks object ownership and immediate item use. |
| Prose | `prosePacingCard` | Local craft guidance for density, momentum, specificity, and response shape. | Low-volume style guidance. |
| Open Threads | `openThreadsCard` | Unresolved questions, promises, pending actions, and near-term pressures. | Keeps the next response aware of visible obligations. |

Each family also exposes fixed scope facets. Facets do not create separate cards; they define what the Arbiter and card generator should emphasize inside that family. The facet labels and descriptions live in `src/card-scope.mjs` and are reused for Arbiter catalog payloads, card-generation prompt focus, UI hover help, and diagnostics.

## Card Scope

Card scope is the user-facing focus control over the fixed V1 catalog. It has two modes:

- Auto: selected families and sub-items are the preferred focus, but not a whitelist. The Utility Arbiter still sees the full catalog and may request unselected families when they have high relevance to continuity, scene coherence, or the current user message. Runtime records visible compact `auto-scope-exception:<family>` diagnostics for any unselected family that enters the plan or hand.
- Manual: selected families and sub-items are a strict whitelist. Runtime removes disabled-family card jobs before provider generation and filters disabled cached, provider, and fallback cards before deck and hand selection.

Sub-items are focus facets inside a family, such as `fragileFacts` under Continuity Risk or `pendingActions` under Open Threads. They guide the prompt for that family card and appear in safe diagnostics, but they do not create separate generated cards, separate deck records, or separate prompt-injection lanes.

## Card Data Contract

A normalized card contains:

- `id`
- `schemaVersion`
- `family`
- `role`
- `sceneId`
- `catalogKey`
- `status`
- `source`
- `promptText`
- `summary`
- `evidenceRefs`
- `tokenEstimate`
- `detailProfile`
- `emphasis`
- `freshness`
- `arbiter`
- optional `inspectorNotes`

`promptText` is the only card text eligible for prompt composition. `summary` supports scanning. `inspectorNotes` are diagnostics and must never be injected.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Candidate
    Candidate --> Active: accepted
    Active --> Stowed: Arbiter stow
    Active --> Stale: regenerate requested
    Active --> Discarded: Arbiter discard
    Stowed --> Active: selected later
    Stale --> Active: refreshed
    Stale --> Discarded: obsolete or unsafe
    Discarded --> [*]
```

![Card lifecycle visual](../../assets/documentation/renders/recursion-card-lifecycle.png)

Runtime normalizes cards, enforces text and evidence limits, validates catalog membership, caps token estimates, and rejects malformed records. The Utility Arbiter owns semantic utility decisions such as which families matter, which cards are stale, and which cards belong in the next hand.

## Arbiter Decisions

The Arbiter can request:

- create or refresh card jobs
- select or emphasize cards for the turn
- stow cards that remain valid but low value
- discard cards that are obsolete, duplicative, misleading, or outside the scene
- use or skip Reasoner composition

Runtime applies these decisions only after schema and safety checks. If an explicit selection exists, cards not touched by the selection are stowed for that hand.

## Scene Deck Vs Turn Hand

The scene deck is the cached set of cards for one scene. It can contain active, stowed, stale, and discarded cards. Only active cards can enter the turn hand.

The turn hand is a compact selection for one prompt packet. It is rebuilt each generation attempt and sorted by emphasis, catalog priority, and id. It is capped by max-card and token budgets.

```mermaid
flowchart LR
    Snapshot["Turn snapshot"] --> Arbiter["Utility Arbiter"]
    Arbiter --> Jobs["Card jobs and lifecycle"]
    Jobs --> Deck["Scene deck"]
    Deck --> Active["Active cards"]
    Deck --> Stowed["Stowed/stale/diagnostic cards"]
    Active --> Hand["Turn hand"]
    Hand --> Packet["Prompt packet"]
```

## Invalidation And Refresh

Hard invalidation retires or replaces the deck when chat identity, scene fingerprint, source hashes, schema versions, catalog versions, or prompt composition contracts no longer match.

Soft invalidation marks the deck stale for Arbiter review when manual scene refresh is invoked, provider settings change, the source window advances, the prompt budget changes, or runtime rejects cards for schema, size, freshness, or safety reasons. Manual refresh uses reason `user-refresh` and rechecks the current host snapshot without adding synthetic chat content.

Pre-alpha storage can invalidate old experimental records instead of carrying compatibility layers.

## Character Motivation Safety

Character Motivation cards may include visible goals, established pressures, observable emotional posture, and behavior-facing uncertainty. Safe phrasing uses terms such as "appears", "seems", "is under pressure to", or "is likely guarding" when motivation is inferred.

They must not include first-person internal monologue, secret thoughts as truth, hidden plans, spoilers, instructions to reveal inner thoughts, or diagnostic speculation copied into prompt text.

The card runner enforces this twice: Motivation card requests include the safety instruction, and normalized Motivation cards with obvious internal-thought wording are rejected before they can enter the scene deck or prompt hand.

## Inspector Visibility

The UI can show:

- latest hand card families, emphasis, and summaries
- selected and omitted counts
- deck states through the viewer
- source refs and token estimates
- Arbiter reasons
- validation warnings and regeneration requests
- inspector-only notes as non-injected diagnostics

The inspector is read-oriented. V1 actions stay broad: refresh scene, copy prompt packet metadata, open settings, test providers, clear session keys, and inspect diagnostics.

![Card family matrix](../../assets/documentation/renders/recursion-card-family-matrix.png)
