# Pre-process Card Descriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show concise, fully wrapped descriptions beneath every Pre-process card name.

**Architecture:** Keep runtime prompt text unchanged while introducing a bundled display-description map in `src/pre-process-decks.mjs`. The existing shared card-row renderer in `src/ui.mjs` will render `card.description` with the same shared class used by Post-process cards, so no second layout system is introduced.

**Tech Stack:** JavaScript ES modules, DOM renderer helpers, shared Recursion CSS, Node test scripts.

## Global Constraints

- Bundled descriptions contain 8–16 words and use plain-language sentences.
- Custom descriptions render unchanged; empty descriptions display `No description.`
- Description text wraps to natural height with no clamp, truncation, character cap, ellipsis, or nested scroll.
- Prompt text, runtime selection, state cycling, persistence, and Post-process behavior remain unchanged.
- Preserve all unrelated dirty work in the current worktree.
- Do not commit implementation files because they overlap the existing uncommitted card-panel feature.
- Sync every production change to `default-user` and the public served extension copy.

---

### Task 1: Decouple Concise Bundled Display Copy from Prompt Text

**Files:**
- Modify: `src/pre-process-decks.mjs:24-105`
- Test: `tools/scripts/test-pre-process-decks.mjs`

**Interfaces:**
- Consumes: `generatedCardId(roleId, subItemKey)` and `CARD_SCOPE_CATALOG`.
- Produces: `DEFAULT_PRE_PROCESS_CARD_DESCRIPTIONS`, keyed by generated card ID; `createDefaultCardDeck()` keeps `promptText: subItem.description` and uses mapped display copy for `description`.

- [ ] **Step 1: Write the failing deck contract**

Add assertions that every bundled card description is 8–16 words, differs from its unchanged prompt text when the source text is long, and includes representative approved copy:

```js
const bundled = createDefaultCardDeck({ now: fixedNow });
for (const card of Object.values(bundled.cards)) {
  const words = card.description.trim().split(/\s+/);
  assert(words.length >= 8 && words.length <= 16, `${card.id} description stays within 8-16 words`);
  const source = CARD_SCOPE_CATALOG
    .find((entry) => entry.family === card.builtinFamily)
    ?.subItems.find((item) => card.selectedSubItems.includes(item.key));
  assertEqual(card.promptText, source.description, `${card.id} keeps canonical prompt text`);
}
assertEqual(
  bundled.cards['sceneFrameCard:locationSituation'].description,
  'Tracks the current place, nearby routes, exposure, pressure, and immediate relevance.',
  'Default location card uses concise display copy'
);
```

- [ ] **Step 2: Run the deck test to verify RED**

Run:

```powershell
node tools/scripts/test-pre-process-decks.mjs
```

Expected: FAIL because bundled descriptions still mirror longer prompt text.

- [ ] **Step 3: Add the complete bundled display-description map**

Add this frozen map:

```js
export const DEFAULT_PRE_PROCESS_CARD_DESCRIPTIONS = Object.freeze({
  'sceneFrameCard:locationSituation': 'Tracks the current place, nearby routes, exposure, pressure, and immediate relevance.',
  'sceneFrameCard:immediateDirection': 'Shows where the next beat is heading without deciding future plot.',
  'sceneFrameCard:beatConstraint': 'Defines the hard response boundary, timing limit, or pending payoff.',
  'activeCastCard:presentCharacters': 'Tracks who can act, observe, interrupt, or receive attention now.',
  'activeCastCard:visibleState': 'Tracks observable conditions, posture, injuries, moods, constraints, and capabilities.',
  'activeCastCard:speakerRoles': 'Tracks who speaks, listens, is addressed, or controls the exchange.',
  'characterMotivationCard:visibleGoals': 'Turns established visible goals into pressure shaping the next response.',
  'characterMotivationCard:pressures': 'Tracks external, social, tactical, and emotional pressures shaping current behavior.',
  'characterMotivationCard:hesitationPosture': 'Tracks visible reluctance, confidence, uncertainty, guardedness, and restraint.',
  'dialogueRelationshipCard:tension': 'Tracks current friction, trust, leverage, intimacy, threats, and usable subtext.',
  'dialogueRelationshipCard:promisesConflicts': 'Tracks promises, refusals, debts, threats, disagreements, and active obligations.',
  'dialogueRelationshipCard:voiceConstraints': 'Tracks address, formality, secrecy, taboo wording, and who may speak.',
  'socialSubtextCard:humorIrony': 'Reads humor and irony as signals of intimacy, pressure, or deflection.',
  'socialSubtextCard:veiledPressure': 'Tracks implied threats, warnings, coercion, and consequences beneath polite language.',
  'socialSubtextCard:invitationBoundary': 'Tracks flirtation, permission, discomfort, refusal, and boundaries against further pressure.',
  'socialSubtextCard:statusFace': 'Tracks dominance, deference, rank, embarrassment, face-saving, and forced yielding.',
  'sceneConstraintsCard:hardLimits': 'Tracks injuries, blocked routes, missing objects, choices, and other plausibility limits.',
  'sceneConstraintsCard:spatialConstraints': 'Tracks movement, reach, visibility, distance, access, and blocked routes.',
  'sceneConstraintsCard:timelineOrder': 'Tracks cause, effect, sequence, reveal order, and what has happened.',
  'knowledgeSecretsCard:concealedFacts': 'Guards hidden truths from premature dialogue, narration, confirmation, or implication.',
  'knowledgeSecretsCard:knowsSuspects': 'Tracks who knows, suspects, misunderstands, or must remain unaware.',
  'knowledgeSecretsCard:revealBoundaries': 'Defines what the next response must not reveal, confirm, or imply.',
  'clocksConsequencesCard:deadlinesCountdowns': 'Tracks active time pressure, countdowns, scheduled events, and closing opportunities.',
  'clocksConsequencesCard:delayedConsequences': 'Tracks effects from earlier choices that remain pending or arrive later.',
  'clocksConsequencesCard:escalationTriggers': 'Tracks conditions that worsen the scene, shift its phase, or demand action.',
  'environmentAffordancesCard:spatialLayout': 'Tracks relative positions of actors, barriers, exits, cover, and key places.',
  'environmentAffordancesCard:sensoryTexture': 'Tracks sensory signals affecting grounding, attention, danger, context, and action.',
  'environmentAffordancesCard:hazardsAffordances': 'Tracks usable objects, obstacles, threats, exits, cover, tools, and opportunities.',
  'possessionsItemsCard:heldCarriedItems': 'Tracks important objects being held, worn, carried, hidden, missing, or controlled.',
  'possessionsItemsCard:itemLocationControl': 'Tracks where items are and who can access, use, move, or withhold them.',
  'possessionsItemsCard:itemAffordancesRisks': 'Tracks what items enable and the risks or limits they carry.',
  'openThreadsCard:unresolvedQuestions': 'Tracks visible questions that remain unanswered and may affect the next response.',
  'openThreadsCard:pendingActions': 'Tracks promised, attempted, interrupted, or requested actions still awaiting completion.',
  'openThreadsCard:nearTermPressures': 'Tracks immediate obligations, looming problems, and choices shaping the next beat.'
});
```

Change the generated-card construction to:

```js
description: DEFAULT_PRE_PROCESS_CARD_DESCRIPTIONS[cardId] || subItem.description,
promptText: subItem.description,
```

- [ ] **Step 4: Run the deck test to verify GREEN**

Run:

```powershell
node tools/scripts/test-pre-process-decks.mjs
```

Expected: `[pass] pre-process-decks`.

---

### Task 2: Render Fully Wrapped Pre-process Descriptions

**Files:**
- Modify: `src/ui.mjs:2393-2395`
- Modify: `DESIGN.md:221`
- Modify: `docs/design/UI_SPEC.md:159-198`
- Test: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Consumes: `card.description` from the active Pre-process deck and shared `.recursion-card-panel-card-description`.
- Produces: a second child in `.recursion-card-panel-card-copy`; no renderer-helper API changes.

- [ ] **Step 1: Write the failing mounted-UI contract**

After expanding the first Pre-process category, assert:

```js
const firstPreCard = root.querySelector('[data-recursion-card-id]');
const firstPreCopy = firstPreCard.children[0].children[0];
assert(
  firstPreCopy.children.some((child) => child.className?.includes('recursion-card-panel-card-description')),
  'Pre-process cards render the shared description element'
);
assert(
  fakeDocument.textTree(firstPreCard).includes('Tracks the current place, nearby routes, exposure, pressure, and immediate relevance.'),
  'Pre-process cards show concise bundled description copy'
);
```

Create a custom card without a description and assert its rendered row contains `No description.`.

Add source/CSS assertions:

```js
assert(/card\.description \|\| 'No description\.'/.test(recursionUi), 'Pre-process cards use the shared empty-description fallback');
assert(!/\.recursion-card-panel-card-description\s*\{[^}]*(?:line-clamp|max-height|overflow:\s*(?:auto|scroll)|text-overflow:\s*ellipsis)/.test(recursionCss), 'shared card descriptions wrap without clamping or nested scrolling');
```

- [ ] **Step 2: Run the UI test to verify RED**

Run:

```powershell
npm.cmd run test:ui
```

Expected: FAIL because Pre-process rows only render the card name.

- [ ] **Step 3: Render the shared description node**

Change the Pre-process `cardCopy` construction to:

```js
const cardCopy = el('span', { className: 'recursion-card-panel-card-copy recursion-card-deck-card-copy' }, [
  el('span', { className: 'recursion-card-panel-card-name recursion-card-deck-card-name', text: card.name || NEW_CARD_NAME }),
  el('span', {
    className: 'recursion-card-panel-card-description recursion-card-deck-card-description',
    text: card.description || 'No description.'
  })
]);
```

Do not add phase-specific description geometry to `styles/recursion.css`; the existing shared rule already provides natural wrapping.

- [ ] **Step 4: Update the design contract**

Add to `DESIGN.md` and `docs/design/UI_SPEC.md`:

```markdown
Pre-process and Post-process card rows show a concise description beneath the card name. Descriptions wrap to natural height without line clamps, ellipsis, per-card scrolling, or tooltip-only disclosure. Bundled Pre-process display descriptions are concise UI copy; their canonical prompt text remains unchanged.
```

- [ ] **Step 5: Run focused tests to verify GREEN**

Run:

```powershell
node tools/scripts/test-pre-process-decks.mjs
npm.cmd run test:ui
node tools/scripts/test-post-process-playwright-contract.mjs
```

Expected: all three commands pass.

---

### Task 3: Review, Full Verification, and Live Sync

**Files:**
- Review: `src/pre-process-decks.mjs`
- Review: `src/ui.mjs`
- Review: `tools/scripts/test-pre-process-decks.mjs`
- Review: `tools/scripts/test-ui.mjs`
- Sync: production `src` files to both SillyTavern copies.

**Interfaces:**
- Consumes: completed Tasks 1–2.
- Produces: verified repository and byte-matching `default-user`/public copies.

- [ ] **Step 1: Review the focused diff**

Run:

```powershell
git diff -- src/pre-process-decks.mjs src/ui.mjs tools/scripts/test-pre-process-decks.mjs tools/scripts/test-ui.mjs DESIGN.md docs/design/UI_SPEC.md
git diff --check
```

Expected: only intended description data/rendering/docs/tests are added; `git diff --check` exits 0.

- [ ] **Step 2: Run the complete suite**

Run:

```powershell
npm.cmd test
```

Expected: all repository test scripts pass.

- [ ] **Step 3: Sync production files**

Copy only `src/pre-process-decks.mjs` and `src/ui.mjs` from this worktree to:

```text
F:\SillyTavern\SillyTavern\data\default-user\extensions\Recursion\src
F:\SillyTavern\SillyTavern\public\scripts\extensions\third-party\Recursion\src
```

- [ ] **Step 4: Verify installed and served parity**

Run:

```powershell
node tools/scripts/verify-installed-copy.mjs --user default-user --sillytavern-root F:\SillyTavern\SillyTavern
```

Expected: `[pass] installed copy matches 73 production files`.

Hash `src/pre-process-decks.mjs` and `src/ui.mjs` in the repository and public served copy. Expected: both SHA-256 pairs match.

- [ ] **Step 5: Perform a no-generation live UI check**

Open the Pre-process dropdown in the live `default-user` host, expand `Scene Frame`, and verify:

- `location/situation` shows its concise description.
- The description is fully visible and wraps naturally.
- The state eye remains at the shared right inset.
- Clicking the row still cycles state, then restore its original state.
- The final summary is restored to its starting value.
