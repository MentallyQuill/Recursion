# Recursion Card System Design

Date: 2026-07-10

Status: Draft for review

Owner: Recursion

Related references:

- `DESIGN.md`
- `docs/design/UI_SPEC.md`
- `docs/design/CARD_SYSTEM_SPEC.md`
- `docs/architecture/PROMPT_COMPOSITION_SPEC.md`
- Saga Loredecks and Lorecards mobile interaction references
- Directive character creator wand-assist references

## Purpose

The Card System expands Recursion's current Cards surface from a fixed scope selector into a compact, editable card-deck system. Users can create and manage Card Decks, organize cards into categories, edit card names/descriptions/prompts, reorder cards and categories, and use a small authoring helper to improve card prompts for Recursion.

The system must remain Recursion-native:

- Compact, graphite-dark, and SillyTavern-native.
- Operational rather than dashboard-like.
- Mobile-first enough that touch interactions are not second-class.
- Clear about what runs, what is draft-only, and what is read-only.
- Integrated with the existing card runtime, prompt composition, and post-generation features.

## Naming

Use the Saga-inspired term **Card Decks**.

Do not call this feature "Card Library".

Core terms:

- **Card System**: the whole feature area.
- **Card Deck**: a named collection of categories and cards.
- **Default deck**: the bundled read-only deck that preserves the existing shipped Recursion behavior.
- **Category**: an organizational group inside a deck.
- **Card**: an individual runnable or draft card definition inside a category.
- **Draft card**: a saved card that is not eligible to run.
- **Authoring Assist**: the wand helper inside the card editor.

## Product Decisions

### Active Deck Is Global

The active Card Deck is a global setting, matching SillyTavern's Connection Profile style. Changing chats does not change the selected deck.

Rationale:

- Card Decks are part of how the user wants Recursion to behave, not a property of a single conversation.
- Users can switch decks intentionally when they want a different operating profile.
- This avoids hidden chat-local state that changes the Card menu unexpectedly.

### Default Deck Is Bundled And Read-Only

The bundled deck is named **Default**.

The Default deck is read-only:

- Users can select it.
- Users can inspect card and category content.
- Users cannot edit, reorder, add, or delete inside it.
- If a user tries to edit the Default deck, the UI prompts them to duplicate the deck or create a new deck.

The Default deck should preserve the existing shipped Card behavior as closely as the new model permits.

### Editable Decks Are User-Owned

Custom decks support:

- New deck.
- Rename deck.
- Duplicate deck.
- Delete deck.
- Add category.
- Rename category.
- Edit category description.
- Reorder category.
- Delete category.
- Add card.
- Rename card.
- Edit card description.
- Edit card prompt.
- Move card between categories.
- Reorder card within a category.
- Duplicate card.
- Delete card.
- Enable or disable card.

### Zero Active Cards Is Valid

Remove the old "at least one card must be active" rule.

A deck can have no runnable active cards. In that state:

- Recursion performs no card-generation calls.
- Recursion injects no card evidence.
- Recursion skips deck-card hand selection.
- Post-generation features such as Enhancements can still run.
- The Cards menu shows a compact neutral state: "No active cards".

This makes new blank decks valid and avoids forcing filler cards into the runtime.

### New Cards Are Drafts

New cards are created with:

- Name: `New Card`
- Empty description.
- Empty prompt.
- Enabled flag on by default.
- Draft state visible.

A draft card can be saved, moved, duplicated, and deleted, but it never runs.

A card is runnable only when all of these are true:

- It is enabled.
- Its name is not `New Card`.
- Its name is non-empty after trimming.
- Its prompt is non-empty after trimming.
- Its prompt passes Recursion card prompt validation.
- Its deck is the active deck.

The draft rule should not rely only on the card name. A lazy user might edit the prompt but leave the name unchanged; in that case the card still remains draft and shows a compact "needs name" state. This is intentional: a runnable card needs a meaningful label so prompt inspection, logs, and user review do not accumulate confusing `New Card` entries.

## Deck Model

### Deck Fields

```ts
type CardDeck = {
  id: string;
  name: string;
  description: string;
  bundled: boolean;
  readonly: boolean;
  categoryOrder: string[];
  categories: Record<string, CardCategory>;
  cardOrderByCategory: Record<string, string[]>;
  cards: Record<string, DeckCard>;
  createdAt: string;
  updatedAt: string;
};
```

### Category Fields

```ts
type CardCategory = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};
```

Categories are organizational. They are not injected into prompts and do not receive Authoring Assist.

### Card Fields

```ts
type DeckCard = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  promptText: string;
  enabled: boolean;
  kind: "generated" | "authored";
  builtinFamily?: string;
  builtinRoleId?: string;
  selectedSubItems?: string[];
  createdAt: string;
  updatedAt: string;
};
```

Card kinds:

- `generated`: requests an existing Recursion generated-card role. The Default deck uses this for shipped cards and maps current Card Scope sub-items into deck cards.
- `authored`: contributes user-authored card guidance directly as card evidence when runnable.

Custom user-created cards default to `authored`. The UI does not need to expose `kind` in the first version.

For a `generated` card, `promptText` is provider-facing request guidance for that generated card. It is not injected directly into the final prompt as card evidence. In the Default deck, this prompt text is seeded from the current Card Scope sub-item description and is read-only. In a duplicated deck, the user can edit that prompt text and the generated-card request uses the edited text.

For an `authored` card, `promptText` is the card evidence body that can be injected into the final prompt after validation.

## Runtime Semantics

The active deck produces a runtime deck view:

```ts
type RuntimeDeck = {
  deckId: string;
  deckName: string;
  generatedCards: RuntimeGeneratedCardRequest[];
  authoredCards: RuntimeAuthoredCard[];
  inactiveCards: RuntimeSkippedCard[];
};
```

Generated cards:

- Used by the existing provider-generated card pipeline.
- Default deck entries map to current Card Scope families, roles, and sub-items.
- Multiple active generated cards with the same `builtinRoleId` are grouped back into one provider request with combined deck prompt items.
- They run only when enabled and non-draft.

Authored cards:

- Inject as card evidence after validation.
- Use the user's `promptText` as the only prompt-facing card body.
- Never inject category names or descriptions.
- Never inject card descriptions.
- Are visible in prompt inspection as Card Evidence with deck/card metadata.

If `generatedCards.length === 0` and `authoredCards.length === 0`, Recursion skips all card-specific runtime work for that generation.

## Card Prompt Rules

The existing Recursion card prompt contract still applies:

- `promptText` is the only prompt-facing text on a card.
- Authored card prompt text must be instruction-shaped, specific, and useful to the current generation.
- Generated card prompt text must be safe provider-facing guidance and should be instruction-shaped where the wording permits it.
- Cards should not duplicate broad baseline style, permanent authorial voice, or global preset behavior.
- Cards should not contain hidden chain-of-thought requests, roleplay as the model, or unrelated prose.

Descriptions are UI-only. Category descriptions and card descriptions are never injected.

## Authoring Assist

Authoring Assist is a compact wand action inside the card editor.

It can run when creating a new card or editing an existing card. It accepts the current editor fields and returns suggested field replacements.

The assist can understand both:

- A sentence or two of rough user intent.
- An already-written card prompt that needs tightening.

It should help the user produce a stronger Recursion card by:

- Making the card specific.
- Making the card operational.
- Improving prompt clarity.
- Removing vague or low-value phrasing.
- Warning when a rule is broad enough that it may be low-value as a card.

The assist must not provide an action to move content to Author's Note or a preset. It may say a card is too broad or low-value, but the preview has only two outcomes:

- Accept checked suggested fields.
- Close the preview and apply nothing.

### Assist Preview

The preview is mobile-friendly and field-based.

Fields:

- Name.
- Description.
- Prompt.

Each suggested field has a checkbox enabled by default.

Accept behavior:

- Checked fields replace the editor value.
- Unchecked fields leave the existing editor value unchanged.
- The editor remains open after applying so the user can review and save.

Close behavior:

- Applies no changes.
- Returns to the editor.

### Assist States

Visual states:

- Idle wand button.
- Running.
- Preview ready.
- Failed with retry affordance.

The running state must not block closing the editor. If the editor closes, the result is discarded.

## Deck Controls UI

The Cards menu gets a compact deck selector in the header.

Recommended structure:

- Left: active deck selector.
- Right: deck action button.
- Below: categories and cards for the selected deck.

Avoid a double-nested dropdown for normal deck operations. Use a selector for choosing the deck and a compact action button for deck controls.

Deck action menu:

- New Deck.
- Rename Deck.
- Duplicate Deck.
- Delete Deck.

For the Default deck:

- Rename is disabled.
- Delete is disabled.
- Editing actions show "Duplicate to edit" or "New deck".

## Category UI

Desktop:

- Category header shows name, compact description indicator when a description exists, and an action button for editable decks.
- Hovering the description indicator shows category description.
- Category actions are compact: rename, edit description, move, delete.

Mobile:

- No hover behavior.
- Tap category header toggles collapse/expand if collapsing is supported.
- Press-hold opens category actions.
- Explicit move mode enables drag handles for category ordering.

Categories do not use Authoring Assist.

## Card UI

Card rows should remain dense.

Each card row should show:

- Enabled state.
- Name.
- Draft or warning state when applicable.
- Optional compact description indicator.
- Optional move handle in move mode.
- Optional action button when visible controls are needed.

Desktop:

- Hovering the description indicator shows card description.
- Click opens or toggles selection according to the existing Cards menu behavior.
- Edit is available through row action or double click if that remains discoverable.

Mobile:

- Tap keeps the primary lightweight action.
- Press-hold opens edit/actions, inspired by Saga Lorecards.
- Haptic feedback uses `navigator.vibrate(10)` when available.
- Move mode exposes drag handles and allows card movement between categories.
- A visible action button remains available as an accessibility fallback.

## Move Mode

Move mode is explicit on mobile and available on desktop.

Reasons:

- Dragging inside a compact SillyTavern panel is error-prone when always active.
- Press-hold already has edit/action meaning.
- Explicit move mode gives clear state and prevents accidental reordering.

Move mode behavior:

- Cards show drag handles.
- Categories show drag handles.
- Destination categories highlight during drag.
- Empty categories show a compact drop target.
- Leaving move mode saves order.
- Failed save restores previous order and shows a compact error.

## Visual Feedback

The Card System needs visible states without becoming visually heavy.

Required states:

- Read-only Default deck.
- Editable custom deck.
- Draft card.
- Needs name.
- Needs prompt.
- Invalid prompt.
- Enabled card.
- Disabled card.
- Active deck.
- Zero active cards.
- Dirty editor.
- Saving.
- Saved.
- Save failed.
- Assist running.
- Assist preview ready.
- Assist failed.
- Move mode.
- Drag target.
- Delete confirmation.

Use compact chips, icons, disabled states, aria labels, and short inline messages. Avoid large cards, marketing-style panels, and instructional copy inside the app.

## Delete Rules

Deck delete:

- Default deck cannot be deleted.
- Active custom deck can be deleted only after confirmation.
- If the active deck is deleted, active deck falls back to Default.

Category delete:

- Empty category can be deleted after confirmation.
- Non-empty category requires an explicit "delete category and cards" confirmation.

Card delete:

- Requires confirmation.
- Does not affect runtime until saved.

## Storage Contract

Settings should store:

```ts
type CardDeckSettings = {
  activeCardDeckId: string;
  customCardDecks: Record<string, CardDeck>;
};
```

The Default deck is bundled code/data, not user-owned saved data.

Settings normalization guarantees:

- `activeCardDeckId` always resolves to Default or a custom deck.
- Custom deck ids are unique.
- Category and card order arrays reference existing ids only.
- Cards reference existing category ids.
- Read-only cannot be set on custom decks by user data.

Because Recursion is pre-alpha, this should replace the old card-scope shape in place rather than preserving legacy compatibility shims.

## Integration With Existing Features

### Cards Menu

The existing Cards dropdown becomes the Card System surface. It still opens from the compact bar.

The menu should show:

- Deck selector.
- Deck actions.
- Category list.
- Card rows.
- Move mode toggle for touch and dense layouts.
- Last Brief or current card output area where it already exists.

### Runtime Generation

When active runnable cards exist:

- Generated cards continue through the existing card sidecar paths.
- Authored cards are normalized into card evidence.
- The final prompt packet includes card evidence using the existing prompt composition path.

When no active runnable cards exist:

- Runtime records a zero-card reason.
- Card sidecar calls are skipped.
- Prompt packet has no Card Evidence block.
- Enhancements and other non-card post-generation features remain available.

### Prompt Inspection

Prompt inspection must show:

- Active deck name.
- Runnable card count.
- Draft/skipped count when relevant.
- Authored card evidence as card evidence, not as notes or presets.
- Generated card evidence as existing generated card evidence.

Descriptions remain absent from prompt-facing output.

### Enhancements

Enhancements must not depend on active cards. If a user runs with an empty deck, Enhancements still run according to their own settings.

### Manual Mode

Manual mode should display deck and card evidence truthfully:

- Empty deck: no card evidence.
- Authored card: user-authored card evidence.
- Generated card: generated card evidence.

Manual mode should not synthesize card content to satisfy old minimum-card assumptions.

## Considered Alternatives

### Per-Chat Active Deck

Rejected for this design. It would make Card behavior too hidden and would not match the Connection Profile style the user wants.

### Double-Nested Deck Dropdown

Rejected as the primary control. It is compact but awkward, especially on mobile. The preferred pattern is one deck selector plus one deck action button.

### Name-Only Draft Detection

Rejected. A card named `New Card` should remain draft, but prompt/name validation should also determine runnability.

### Author's Note Or Preset Move Action

Rejected. The assist can warn about low-value or overly broad cards, but the preview only supports accepting checked field changes or closing.

### Always-On Dragging

Rejected for mobile. Move mode is clearer and avoids accidental reorder while scrolling or press-holding.

## Open Review Points

These are the main product calls to confirm before implementation:

- Whether custom cards should always be `authored` in V1, with no UI for `generated` custom cards.
- Whether category collapse should ship in the first implementation.
- Whether duplicate deck should automatically select the new duplicate.
- Whether delete confirmation should use the existing compact modal pattern or an inline confirmation row.
- Whether card editor save should auto-enable a card when it becomes runnable or preserve the user's enabled flag exactly.
