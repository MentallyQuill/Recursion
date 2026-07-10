# Recursion Enhancements And Dialogue Enhancement Design

## Purpose

Replace the current single-purpose **Prose Enhancement** control with a broader **Enhancements** system for post-generation cleanup of SillyTavern assistant output.

The V1 expansion adds **Dialogue Enhancement** beside the existing Prose Enhancement pass. Dialogue Enhancement is a Utility-powered post-generation edit that repairs AI-ish speech, voice drift, fake agency, weak subtext, and unsupported trope dialogue while preserving scene events, character intent, narration structure, and host output recoverability.

This is not a Recast-style configurable pass editor. Recursion should expose one compact bar control with a small set of high-level choices:

- what to enhance;
- how to apply the result.

## Product Contract

### Enhancement Targets

`Off`

Recursion does no post-generation enhancement work. SillyTavern output appears normally.

`Prose`

Runs the existing Prose Enhancement behavior under the new Enhancements contract. It rewrites non-dialogue prose for rhythm, clarity, diction, texture, pacing, sentence structure, and slop cleanup while preserving dialogue except for explicit banned-slop cleanup already allowed by the current prose validator.

`Dialogue`

Runs one Dialogue Enhancement Utility call. The call has two ordered objectives inside the same prompt:

1. Anti-slop repair.
2. Natural and subtext-driven dialogue repair.

It should edit dialogue and only the smallest necessary dialogue-adjacent beat. It must not improve general prose, restructure the scene, add facts, change outcomes, resolve tension cleanly, or make a character warmer, more helpful, more articulate, more romantic, or more emotionally honest unless established character evidence supports that direction.

`Prose + Dialogue`

Runs Dialogue Enhancement first, then Prose Enhancement. The user sees one final enhanced result, not two visible edits. Dialogue runs first because Prose Enhancement already preserves dialogue. Prose then polishes narration around the repaired dialogue without changing the dialogue result.

### Application Modes

`As Swipe`

Recursion captures the latest assistant output, masks it while enhancement runs, keeps the original SillyTavern output as a sibling swipe, adds the enhanced output as a selected sibling swipe, then reveals the message. If the enhanced sibling for the same original hash and enhancement profile already exists, Recursion selects it instead of creating another.

`Replace`

Recursion captures the latest assistant output, masks it while enhancement runs, replaces the active assistant text with the final enhanced output, then reveals the message.

If enhancement fails validation, times out, is canceled, is stale, or the selected provider lane is unavailable, Recursion reveals the original output unchanged. Low and Medium use Utility. High and Ultra use Reasoner directly instead of falling back to Utility.

## User Experience

Bar control label: `Enhancements`.

The existing icon-only Prose Enhancement button becomes the icon-only Enhancements button. It stays in the same compact bar slot: immediately to the right of Cards and immediately to the left of Tense & PoV. It keeps the repo-local `assets/icons/upgrade.svg` mask icon unless a later approved icon refresh replaces it.

The bar button must not render visible text or badges. The accessible label and tooltip expose the current state:

- `Enhancements: Off`
- `Enhancements: Prose, As Swipe`
- `Enhancements: Dialogue, Replace`
- `Enhancements: Prose + Dialogue, As Swipe`

Visual state:

- `Off`: same muted grey disabled treatment as the existing Prose Enhancement off state.
- Any enabled target: normal enabled chrome.
- Running state: Hero Pixel Array and progress surfaces show activity; the button itself does not become a spinner.

### Dropdown

The dropdown remains a compact selector attached to the bar button. It should be wider than the current Prose menu but not full-width. Target width: `260..280px`, clamped to the mobile viewport.

Recommended layout:

```text
Enhancements
Utility post-generation cleanup

Apply
[ As Swipe ] [ Replace ]

Enhance
✓ Off
  Show SillyTavern output unchanged.

  Prose
  Rewrite narration while preserving dialogue.

  Dialogue
  Repair AI-ish speech, voice drift, fake agency, and weak subtext.

  Prose + Dialogue
  Repair dialogue first, then polish narration.
```

The `Apply` row is a segmented control. It stores the application mode independently from the enhancement target. The operator may change `As Swipe` or `Replace` while target is `Off`; the stored mode applies the next time an enabled target is selected.

The enhancement rows are mutually exclusive. Selecting a target closes the menu, matching current compact selector behavior. Selecting an application mode updates the segmented control and keeps the menu open so the user can immediately choose the target.

### Advanced Settings

Rename the Advanced disclosure from `Prose Enhancement` to `Enhancements`.

V1 exposes one numeric setting:

- `Context Messages`: integer `0..35`, default `13`.

Dialogue and Prose share the context window in V1. Separate context budgets are out of scope until concrete evidence shows a need.

### Status Copy

Compact bar status:

- `Enhancing prose...`
- `Enhancing dialogue...`
- `Enhancing response...`
- `Enhancement skipped.`
- `Enhancement failed. Original kept.`

Progress menu rows:

- `Dialogue Enhancement`
- `Prose Enhancement`

For `Prose + Dialogue`, compact status should use `Enhancing response...`; the progress menu may show two child rows in order.

Status and diagnostics must not expose raw prompts, raw provider responses, hidden reasoning, secrets, or full transcript text.

## Dialogue Enhancement Behavior

Dialogue Enhancement should optimize for situated character speech, not prettier lines. It should repair the strongest dialogue slop candidates in this priority order:

1. Echoing and parroting.
2. Forced questions and fake agency.
3. Over-technical dialogue for "intelligent" characters.
4. Tsundere tropes and defensive deflection, unless established by character evidence.
5. Attraction cliches and lazy romance lines.

### Echoing And Parroting

Failure pattern:

- Repeating the user's exact wording as a question.
- Restating the user's action before responding.
- Template banter such as `"So that's what we're calling it now?"`.
- Responding to phrasing instead of scene pressure.

Correction strategy:

Dialogue should answer the pressure underneath the line rather than mirroring the wording. The repaired line may challenge, evade, refuse, concede, redirect, soften, threaten, stay silent, or act, depending on the character and scene.

### Forced Questions And Fake Agency

Failure pattern:

- `"What do you say?"`
- `"Your move."`
- `"The choice is yours."`
- `"Do you want X, or Y?"`
- `"Where do we go from here?"`
- Generic open-ended endings that hand authorship back to the user without an in-world reason.

Correction strategy:

Replace fake agency with character agency. Characters may ask concrete in-world questions when motivated, but they should not become a narrator offering a menu. Preferred repairs are action, refusal, narrowed options, consequences, or a specific grounded question.

### Over-Technical Dialogue For Intelligent Characters

Failure pattern:

The model signals intelligence with unsupported sterile diction: `variables`, `optimal`, `efficient`, `hypothesis`, `statistically`, `tactical`, `non-negotiable`, `calculated`, and similar generic "smart voice" filler.

Correction strategy:

Make intelligence visible through what the character notices, infers, withholds, or says precisely. Specialized diction is allowed when the character card, setting, occupation, or example dialogue supports it. Unsupported jargon should become exact, character-native speech.

### Tsundere Tropes And Defensive Deflection

Failure pattern:

- `"It's not like I care."`
- `"Don't get the wrong idea."`
- `"Idiot."`
- `"You're impossible."`
- `"I'm only doing this because..."`
- `"I hate that you're right."`

Correction strategy:

Preserve the defensive function when it fits, but remove the stock phrase. Repairs may change subject, issue a practical order, minimize the favor, insult the situation rather than the person, withhold thanks, or show help through action instead of confession.

### Attraction Cliches And Lazy Romance Lines

Failure pattern:

- `"You're mine."`
- `"Ruin you."`
- `"Devour you."`
- `"Claim you."`
- `"You're going to be the death of me."`
- `"Tell me what you want."`
- `"Last chance to back out."`
- Generic desire-as-danger without support from the character or scene.

Correction strategy:

Ground attraction in the specific character, relationship, and immediate situation. The pass may reduce generic intensity while preserving desire, restraint, awkwardness, directness, evasion, or tension as supported by evidence.

## Natural And Subtext-Driven Dialogue

The prompt should force the editor to reason about the line in this order:

1. What does the character want right now?
2. What are they unwilling to say directly?
3. What are they protecting: pride, safety, leverage, affection, secrecy, status, control?
4. What did the other character visibly feel or imply?
5. How would this character respond without naming all of that?

Rules:

- Prefer indirect, motivated speech over explicit emotional explanation.
- Characters may dodge, understate, redirect, test, refuse, joke, threaten, soften, or act instead of confessing the obvious.
- Do not convert subtext into confession.
- Do not make evasive characters suddenly honest.
- Do not make guarded characters warmly reassuring.
- Do not make hostile characters explain their hostility.
- Do not turn uncertainty into a clean question.
- Do not make every line witty, sharp, or quotable.
- Preserve unresolved pressure unless character evidence supports resolution.

Example target:

```text
Bad:
"I understand that you're upset, and I want you to know I'm here for you. What do you want to do next?"

Better:
"Sit down before you fall over. We can argue after."
```

The better line shows concern, keeps friction, gives the character agency, and does not hand the scene back with fake choice.

## Prompt Contract

Dialogue Enhancement uses a new Utility role:

```text
dialogueEnhancer
```

Expected schema:

```text
recursion.dialogueEnhancer.v1
```

Response shape:

```json
{
  "schema": "recursion.dialogueEnhancer.v1",
  "text": "Full assistant message with repaired dialogue."
}
```

The prompt must instruct the model to return strict JSON only.

Dialogue Enhancement request inputs:

- target assistant text;
- bounded recent visible scene context;
- active character name and safe card fields when host access exists;
- example dialogue when host access exists;
- latest known story form;
- relevant Recursion context from `Dialogue/Relationship`, `Social Subtext`, `Character Motivation`, and `Knowledge/Secrets` cards when available as safe summaries;
- the dialogue-focused banned slop subset.

The request must not include raw prompt packets, raw provider responses, hidden reasoning, API keys, full unbounded transcript text, or private diagnostic dumps.

## Settings Contract

Replace the old `settings.proseEnhancement` contract with:

```js
enhancements: {
  target: 'off' | 'prose' | 'dialogue' | 'prose-dialogue',
  applyMode: 'as-swipe' | 'replace',
  contextMessages: 13
}
```

Defaults:

```js
enhancements: {
  target: 'off',
  applyMode: 'as-swipe',
  contextMessages: 13
}
```

Recursion is pre-alpha, so implementation should update code, docs, tests, schemas, and examples in place to this new contract rather than carrying a parallel legacy UI path.

## Validation

### Prose Target

Use the existing Prose Enhancement validation under the new setting and runtime names:

- schema is `recursion.proseEnhancer.v1`;
- text is non-empty;
- output length is capped;
- dialogue spans remain byte-identical except explicit banned-list cleanup.

### Dialogue Target

Before applying Dialogue Enhancement output:

- schema is `recursion.dialogueEnhancer.v1`;
- text is non-empty;
- output length is capped;
- dialogue span count and order remain stable unless a banned/fake-agency fragment is removed without changing scene meaning;
- non-dialogue outside dialogue-adjacent paragraphs remains byte-identical;
- dialogue-adjacent paragraphs may change only when the paragraph contains a changed dialogue span;
- no known secret, prompt, hidden-reasoning, or provider-diagnostic markers appear;
- output does not add new named entities, new decisions, new events, or new physical outcomes;
- duplicate enhanced siblings are keyed by chat id, message id, swipe id, original hash, target, apply mode, and pass sequence.

If validation cannot distinguish safe dialogue repair from scene mutation, Recursion should skip and reveal the original.

### Prose + Dialogue Target

Validation occurs after each pass:

1. Dialogue output must satisfy Dialogue validation against the original.
2. Prose output must satisfy Prose validation against the dialogue-enhanced text.
3. The final applied marker stores the original hash, dialogue hash, final hash, target, apply mode, and pass sequence.

## Lifecycle

```text
Host generation starts
  -> Recursion reads settings.enhancements
  -> if target is enabled, arm output hold and owned mutation window
Assistant message lands
  -> capture message id, swipe id, original hash, raw text
  -> hold visible output
  -> run selected Utility pass sequence
       Prose: proseEnhancer
       Dialogue: dialogueEnhancer
       Prose + Dialogue: dialogueEnhancer, then proseEnhancer
  -> validate each pass
  -> As Swipe: append/select one enhanced sibling
  -> Replace: replace active text
  -> reveal message
  -> Rapid warm may proceed after enhancement barrier settles
```

Stop, delete, edit, swipe, chat change, teardown, and new generation must cancel or discard pending enhancement work. Late Recursion-owned message update and swipe events from the enhancement tail must not clear Last Brief or Prompt Packet state.

## Storage And Diagnostics

Persist compact metadata only:

```js
{
  target: 'dialogue',
  applyMode: 'as-swipe',
  messageId: 42,
  originalHash: '...',
  intermediateHash: '',
  finalHash: '...',
  status: 'applied',
  appliedAs: 'swipe',
  providerLane: 'utility',
  passSequence: ['dialogue'],
  latencyMs: 1234
}
```

Do not persist raw original text, enhanced text, provider prompt, provider response, full scene context, API keys, hidden reasoning, or transcript dumps in run journals.

## UI And Design Constraints

The UI must remain SillyTavern-native, compact, graphite-dark, and operational:

- one icon-only `Enhancements` button in the current Prose Enhancement bar slot;
- no standalone editor panel;
- no Recast-style pass list;
- no per-message diff viewer in V1;
- no accept/reject workflow beyond `As Swipe`;
- no decorative status treatment;
- no visible bar text or badges for the enhancement target;
- compact dropdown rows and segmented controls that match existing Recursion menu density.

## Documentation Updates

Implementation should update:

- `docs/RECURSION_EXTENSION_SPEC.md`
- `docs/architecture/RUNTIME_ARCHITECTURE.md`
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- `docs/design/UI_SPEC.md`
- `docs/user/RECURSION_OPERATOR_MANUAL.md`
- `docs/testing/LIVE_SMOKE_TEST_PLAN.md`

## Acceptance Criteria

- `settings.enhancements` normalizes as the only current enhancement settings contract.
- Default target is `off`, default apply mode is `as-swipe`, and default context message count is `13`.
- Compact bar renders one icon-only `Enhancements` button immediately right of Cards and left of Tense & PoV.
- Dropdown exposes `Apply` segmented control and `Off`, `Prose`, `Dialogue`, `Prose + Dialogue` target rows.
- Apply mode persists independently of target.
- `Off` greys the bar icon; enabled targets use normal enabled chrome.
- Utility provider role `dialogueEnhancer` validates schema `recursion.dialogueEnhancer.v1`.
- Existing `proseEnhancer` role continues to validate `recursion.proseEnhancer.v1` under the Enhancements pipeline.
- Dialogue prompt targets echoing, fake agency, unsupported smart jargon, unsupported tsundere tropes, lazy attraction lines, naturalness, and subtext.
- Dialogue validation prevents scene mutation and non-dialogue drift outside dialogue-adjacent paragraphs.
- `Prose + Dialogue` runs Dialogue first, then Prose, and applies one final result.
- Stop and stale-source behavior cancel all enhancement targets.
- Recursion-owned mutation windows protect Last Brief and Prompt Packet state for all enhancement targets.
- `As Swipe` creates or selects one enhanced sibling per enhancement profile.
- `Replace` mutates the active assistant text only after validation.
- Failure reveals the original unchanged.
- Deterministic tests cover settings, provider roles, prompt builders, validation, runtime lifecycle, UI, docs, and smoke event ordering.
- Live SillyTavern proof covers `Dialogue`, `Prose + Dialogue`, `As Swipe`, `Replace`, stale/cancel safety, and installed-copy freshness.
