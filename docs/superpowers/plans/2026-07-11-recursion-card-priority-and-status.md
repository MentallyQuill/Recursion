# Recursion Card Priority And Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Card Deck Priority state and route Card System action feedback through the main Recursion bar status area.

**Architecture:** Store per-card selection as `selectionState: "off" | "active" | "priority"` in Card Deck records. UI cycles card rows through the mode-specific state machine and uses the existing transient bar status path for feedback. Runtime passes Auto Priority card ids into hand selection so they are selected before normal Active cards, with deterministic overflow diagnostics.

**Tech Stack:** JavaScript ES modules, SillyTavern extension UI DOM helpers, repo deterministic scripts, Playwright live proof.

## Global Constraints

- Priority applies only in Auto.
- Auto card row cycle is `Inactive -> Active -> Priority -> Inactive`.
- Manual card row cycle is `Inactive -> Active -> Inactive`.
- Priority uses bright cyan up-arrow and stronger cyan row treatment.
- Cards dropdown must not render transient yellow notice rows.
- Significant Card System actions route through the main Recursion bar status area and mobile status drawer.
- Priority overflow is allowed; runtime uses category/card order and reports `priority-card-cap` plus `priority-over-max-cards`.

---

### Task 1: Card Deck Selection State Model

**Files:**
- Modify: `src/card-decks.mjs`
- Test: `tools/scripts/test-card-decks.mjs`

**Interfaces:**
- Produces: `cardSelectionState(card): "off" | "active" | "priority"`
- Produces: `nextCardSelectionState(card, mode): "off" | "active" | "priority"`
- Produces: `updateCardSelectionState(deck, cardId, state)`
- Produces: `deckPriorityCardIds(deck, settings)`

- [ ] Write failing card-deck tests for normalization, state cycling, All behavior, and priority id ordering.
- [ ] Run `node tools\scripts\test-card-decks.mjs` and verify the new tests fail.
- [ ] Implement selection-state helpers and normalize legacy `enabled` input.
- [ ] Run `node tools\scripts\test-card-decks.mjs` and verify pass.

### Task 2: Hand Selection Priority

**Files:**
- Modify: `src/cards.mjs`
- Modify: `src/runtime.mjs`
- Test: `tools/scripts/test-runtime.mjs`

**Interfaces:**
- Consumes: `forcedCardIds: string[]` in `selectHand(...)`
- Produces: omitted reason `priority-over-max-cards`
- Produces: metadata diagnostics `priority-card-cap`

- [ ] Write failing runtime/card tests proving forced card ids select before normal cards and overflow records diagnostics.
- [ ] Run focused runtime tests and verify failure.
- [ ] Add `forcedCardIds` support to `selectHand(...)`.
- [ ] Pass active deck Priority ids from Auto runtime paths.
- [ ] Run focused runtime tests and verify pass.

### Task 3: Main-Bar Card System Status

**Files:**
- Modify: `src/ui/action-status.mjs`
- Modify: `src/ui.mjs`
- Modify: `styles/recursion.css`
- Test: `tools/scripts/test-ui.mjs`

**Interfaces:**
- Produces: `uiActionStatus.set(label, severity)`
- Produces: `showCardSystemStatus(label, severity)`
- Consumes: `currentStepTextForRender(...)` prefers active runtime work, then transient Card System status, then standby text.

- [ ] Write failing UI tests for no `.recursion-card-scope-notice`, three state row classes/icons, and main-bar status copy.
- [ ] Run `node tools\scripts\test-ui.mjs` and verify failure.
- [ ] Remove local notice rows and route Card System action copy through transient bar status.
- [ ] Implement inactive/active/priority CSS and icon/tooltip wiring.
- [ ] Run `node tools\scripts\test-ui.mjs` and verify pass.

### Task 4: Live Proof And Docs

**Files:**
- Modify: `docs/design/CARD_SYSTEM_SPEC.md`
- Modify: `docs/design/UI_SPEC.md`
- Modify: `docs/technical/CARD_DECK_AND_HAND.md`
- Modify: `tools/scripts/prove-card-system-ui.mjs`

**Interfaces:**
- Produces: Playwright proof for desktop/mobile state cycle and status routing.

- [ ] Update docs with implemented Priority and status contracts.
- [ ] Extend Playwright proof for Priority state cycle and status text.
- [ ] Run deterministic tests: `node tools\scripts\test-card-decks.mjs`, `node tools\scripts\test-ui.mjs`, focused runtime tests, and `npm.cmd test`.
- [ ] Sync served SillyTavern extension copy.
- [ ] Run live Card System proof with artifacts.
