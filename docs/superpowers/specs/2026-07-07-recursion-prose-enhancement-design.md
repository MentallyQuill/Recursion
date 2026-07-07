# Recursion Prose Enhancement Design

## Purpose

Add **Prose Enhancement** as a toggleable post-generation Utility pass for SillyTavern assistant output. The feature improves prose rhythm after the host model finishes a response, while preserving the original meaning, event order, dialogue, tense, and point of view.

This is not Recast's configurable multi-pass pipeline. Recursion should provide one focused V1 feature with three modes:

- `Off`
- `As Swipe`
- `Replace`

The feature uses the Utility provider, bounded recent scene context, and a strict structured response contract. It should feel invisible during normal play: when enabled, the player should first see the enhanced result, not watch the unpolished SillyTavern generation appear and then change.

## Product Contract

### Off

Recursion does no post-generation prose work. SillyTavern output appears normally.

### As Swipe

When an assistant generation, regeneration, continuation, or swipe lands, Recursion captures the latest assistant text, masks the visible message while the pass runs, then releases the message with two swipes:

1. Original SillyTavern output.
2. Enhanced output.

The enhanced swipe is selected automatically before the message becomes visible. The player can swipe back to the raw original if desired.

For every newly generated host swipe, the feature may create one matching enhanced sibling. It must not recursively enhance its own enhanced swipe, and it must not duplicate an enhanced sibling for the same original text hash.

If the Utility pass returns text that is byte-identical to the held original, Recursion treats the pass as unchanged: it reveals the original, creates no enhanced sibling, and keeps the original swipe selected. `As Swipe` must never append a duplicate swipe only to mark that a pass ran.

### Replace

When an assistant generation, regeneration, continuation, or swipe lands, Recursion captures the latest assistant text, masks the visible message while the pass runs, replaces the active assistant text with the enhanced text, then reveals the message.

If enhancement fails validation, times out, is canceled, or Utility is unavailable, Recursion reveals the original output unchanged.

If the Utility pass returns text that is byte-identical to the held original, Recursion treats the pass as unchanged and reveals the original without replacing the active text.

The capture path must not destructively blank the SillyTavern chat row. CSS owns the visual masking while the host adapter keeps the raw message text recoverable. If an older build or interrupted pass leaves a persisted `__recursionHeldText` marker with a blank active message, Recursion should restore the held original and clear the marker on bootstrap.

## User Experience

Bar control label: `Prose Enhancement`

The primary control is an icon-only bar button using the provided `upgrade.svg` glyph. It sits immediately to the right of the Cards button and before the Tense & PoV selector, matching the compact menu pattern used by Mode. It must not render a visible text label in the bar.

Dropdown options:

- `Off`
- `As Swipe`
- `Replace`

Advanced setting:

- `Context Messages`: integer `0..35`, default `13`.

The dropdown rows should match the Mode option pattern: icon/name column, selected state, and a short mini-description for each option. Suggested descriptions:

- `Off`: `Shows SillyTavern output unchanged.`
- `As Swipe`: `Keeps the original and selects one enhanced sibling swipe.`
- `Replace`: `Shows only the enhanced version when validation passes.`

When set to `Off`, the bar icon should grey out like the On/Off button's disabled treatment. When set to `As Swipe` or `Replace`, the icon uses normal enabled chrome, not a bright alert color.

`Context Messages` belongs in Advanced because normal play should use the compact bar dropdown, not a settings form.

Runtime status copy should be compact:

- `Enhancing prose...`
- `Prose enhanced.`
- `Prose enhancement skipped.`

These statuses may appear in the existing compact status/progress surfaces. They must not expose raw prompts, raw provider responses, hidden reasoning, or full chat transcript excerpts.

## Prompt Contract

Use the Prose Rhythm rules as the model-visible editing instruction, adapted to Recursion's structured response contract:

```text
You are a prose editor. Your only job is to improve how <text_to_transform> reads without changing what it says.
Rules:
- Do not change any dialogue. Not a single word.
- Exception: the banned AI slop list below can override this dialogue rule. If a dialogue span contains one of those exact banned phrases or an obvious direct variant, remove or neutralize only that phrase while preserving the character's intended meaning.
- Do not change what happens, what characters do, or the order of events.
- Do not add new actions, reactions, or details that were not there.
- Do not remove actions, reactions, or details that were there.
- Write in the verb tenses the original text is written, keeping the grammatical person as well.
- Prioritize avoiding repetition of descriptive words by changing the phrase or removing it altogether.

What you may change:
- Sentence length variation, break up monotonous rhythm, mix short and long.
- Eliminate repeated sentence structures, especially consecutive sentences starting the same way.
- Convert telling to showing, remove emotion labels and replace with physical behavior or action.
- Cut filler phrases that carry no meaning.
- Tighten overly wordy constructions without losing meaning.
- Favor flowing sentences connected by conjunctions over short stopped ones.
- Remove any unnecessary waiting at the end of dialogue, if that wait is already clear by the text or cannot be implemented naturally with something else.

Slop reduction:
- Apply the full banned AI slop and cliché list below. Do not reduce, summarize, or paraphrase the list in the implementation prompt.
- Do not replace one banned pattern with a neighboring cliché. If a phrase is empty atmosphere or filler, cut it rather than swapping in a synonym.
- Do not rename existing characters or add new names to avoid a cliché.

## Core banned AI slop and clichés

### Physical-impact metaphors

* felt it like a physical blow
* hit like a physical blow
* struck like a physical blow
* landed like a blow
* hit like a fist to the chest
* hit like ice water
* hit like a punch to the gut
* the words struck him
* the words landed
* the realization crashed over them
* the truth slammed into them
* the weight of his words settled
* the words hung in the air
* the silence settled over them
* the moment settled between them

### Breath, throat, chest, and heartbeat loops

* a breath she didn't know she was holding
* breath hitched
* breath caught
* drew in a breath
* let out a breath
* exhaled slowly
* inhaled sharply
* released a shaky breath
* swallowed thickly
* throat tightened
* chest tightened
* heart raced
* pulse quickened
* heart skipped a beat
* a shiver ran down her spine
* a jolt ran through him
* goosebumps rose on her skin
* caught her breath
* couldn't breathe
* forgot how to breathe

### Generic tension atmosphere

* time seemed to stop
* the tension was palpable
* the air grew thick
* the air crackled
* electricity crackled between them
* the silence spoke volumes
* a silence that spoke louder than words
* the world fell away
* everything else faded
* the room seemed smaller
* the moment stretched
* the moment hung suspended
* an unspoken understanding passed between them
* something shifted between them
* neither of them moved
* neither of them spoke
* for a long moment
* for what felt like forever

### Face, eyes, gaze, jaw

* eyes widened
* pupils dilated
* gaze softened
* gaze darkened
* gaze flickered
* gaze dropped
* searched their face for
* looked at him, really looked at him
* studied his face
* jaw clenched
* jaw tightened
* jaw set
* jaw worked
* jaw opened and closed
* lips parted
* lips twitched
* mouth opened, then closed
* brows furrowed
* expression unreadable
* something unreadable crossed his face
* eyes flashed with something

### Voice and delivery clichés

* voice dropped
* voice caught
* voice softened
* voice barely above a whisper
* voice turned low
* voice was rough
* voice was thick with emotion
* murmured
* whispered
* purred
* growled
* said softly
* said quietly
* said gently
* said, too casually
* the words came out before she could stop them
* before he could think better of it
* despite himself
* couldn't help but

### Micro-gesture loops

* fingers brushed
* fingers ghosted over
* traced lazy circles
* traced patterns on skin
* hand hovered
* hand lingered
* lingered a bit too long
* leaned against the doorframe
* leaned in close
* tilted his head
* cocked his head
* tucked a strand of hair behind her ear
* reached out, then stopped
* froze
* stiffened
* flinched
* knuckles whitened
* dug crescent moons into his palms
* nails bit into his palm
* lip caught between teeth
* bit her lip hard enough to draw blood
* heels clicked
* collarbones drew attention

### False-profundity sentence structures

* not just X, but Y
* not X. Not Y. Just Z.
* no words. No movement. Only X.
* for the first time
* and somehow, that was enough
* something almost like a laugh
* something not quite a smile
* a sound somewhere between X and Y
* the kind of X that Y
* as if X itself had Y
* as though the universe had narrowed to this
* a key turning in a lock
* a lock he didn't know existed
* a truth he wasn't ready to name
* an answer to a question she hadn't asked
* the weight of everything unsaid
* unspoken promise
* unspoken question
* unspoken challenge
* unspoken permission

### Emotional abstraction filler

* a mix of
* a mixture of
* a hint of
* a flicker of
* a flash of
* a trace of
* a spark of
* a pang of
* a wave of
* a rush of
* a surge of
* a storm of
* a cocktail of
* something like
* something close to
* something almost
* something unreadable
* something primal
* something ancient
* something dangerous
* something vulnerable
* something raw

### Forced romance / attraction clichés

* he was a man starved and she was a feast
* hungry gaze
* predatory gaze
* possessive growl
* feral need
* primal need
* ruin you
* ruin you for anyone else
* you're mine
* mark you
* claim you
* devour you
* worship you
* make you forget your own name
* kiss-swollen lips
* kissed hard enough to bruise
* bruising kiss
* dangerous game
* playing with fire
* you're going to be the death of me
* you menace
* be gentle
* I've never done anything like this before
* last chance to back out
* tell me what you want
* once I start, I won't stop

### Forced question endings and fake agency

* what do you say?
* what do you want?
* what now?
* your move
* the choice is yours
* do you want to X, or Y?
* are you going to X, or will you Y?
* will you X, or will you Y?
* or something else entirely
* what brings you here?
* what do you do for fun?
* what are your hobbies?
* what makes you tick?
* would you prefer this, or that?
* shall we continue?
* where do we go from here?

### Echoing and parroting

* repeats the user's exact phrase as a question
* restates the user's action before responding
* "So that's what we're calling it now?"
* "You really just said X."
* "You're either very X or very Y. Probably both."
* "No one ever X before."
* "Let's not get ahead of ourselves."
* "Just because you X, don't think Y."
* "Try not to X too much."
* "Don't X too hard."
* "You're enjoying this, aren't you?"
* "You have no idea what you're doing to me."

### Scene-setting slop

* dust motes
* golden light
* warm light
* dimly lit room
* neon glow
* scent of ozone
* ozone in the air
* metallic tang
* coppery tang
* smell of rain
* scent uniquely hers
* something distinctly him
* something distinctly you
* masculine scent
* feminine scent
* the city hummed outside
* somewhere, a dog barked
* somewhere, X happened
* outside, X; inside, Y
* the sun dipped below the horizon
* sunset arrived suddenly
* the room felt charged
* shadows danced

### Tsundere / defensive deflection slop

* it's not like I care
* don't get the wrong idea
* purely for research
* purely for educational purposes
* this is just tactical
* tactical retreat
* strategic maneuver
* adequate
* acceptable
* hmph
* idiot
* don't think this means anything
* I'm only doing this because
* you're impossible
* you're insufferable
* you're annoying, you know that?
* I hate that you're right

### Over-technical or out-of-character diction

* structural integrity
* assessing variables
* recalibrating
* hypothesis
* data point
* optimal
* inefficient
* adequate
* acceptable
* statistically
* biologically
* physiologically
* strategically
* tactically
* non-negotiable
* utterly
* completely
* quiet and efficient
* clinical precision
* predatory grace
* controlled chaos

Use the scene context only to match the established prose tone and style of the exchange. Do not drift from the register already set.
```

Unlike Recast, Recursion should not ask the model to return bare rewritten text. The provider response must be a JSON object.

## Provider Role

Add one Utility role:

```text
proseEnhancer
```

Expected schema:

```text
recursion.proseEnhancer.v1
```

Response shape:

```json
{
  "schema": "recursion.proseEnhancer.v1",
  "sourceMessageHash": "same source message hash",
  "rewrittenText": "Enhanced assistant text.",
  "diagnostics": []
}
```

The role is Utility-only. Reasoner routing is intentionally not used in V1 because Prose Enhancement is latency-sensitive, post-output polish. If Utility is unavailable, the feature skips and reveals the original host output.

## Request Shape

The request should include:

- `sourceMessageHash`: hash of the raw assistant text.
- `messageId`: latest assistant message id.
- `swipeId`: active swipe id when available.
- `contextMessages`: normalized setting.
- `sceneContext`: bounded visible recent messages before the target output, excluding hidden/system messages.
- `textToTransform`: raw assistant output.
- `storyForm`: latest known Recursion story form if available, otherwise a conservative local inference or `unknown`.

The request must not include raw prompt packets, card inspector notes, API keys, hidden reasoning, or full unbounded transcript text.

## Validation

Before applying provider output, runtime must validate:

- top-level `schema` is `recursion.proseEnhancer.v1`;
- `sourceMessageHash` matches the original source hash;
- `rewrittenText` is non-empty;
- output length is within a sane ratio of the original, default `0.55..1.75`;
- every dialogue span is byte-identical and appears in the same order, except exact or obvious direct variants from the banned AI slop list may be removed or neutralized;
- output has no known secret, prompt, hidden-reasoning, or provider-diagnostic markers;
- current latest assistant message/swipe still matches the source identity captured before the call;
- this source hash has not already produced an enhanced sibling for the same message/swipe.

Dialogue-span validation is mandatory. If it cannot parse the text confidently, Recursion should skip rather than risk changing dialogue, except when the only detected dialogue change is removal or neutralization of listed banned slop.

## Host Integration

Add host-neutral post-message methods instead of mutating SillyTavern chat/DOM inside runtime:

```js
host.messages.holdAssistantMessage(messageId)
host.messages.revealAssistantMessage(messageId)
host.messages.replaceAssistantMessageText(messageId, text, options)
host.messages.appendAssistantMessageSwipe(messageId, text, options)
host.messages.activeAssistantMessageIdentity()
```

SillyTavern adapter implementation may use `context.chat`, `updateMessageBlock`, `saveChat`, and swipe arrays, but that detail stays inside `src/hosts/sillytavern/host.mjs`.

`holdAssistantMessage` should blank or hide the visible text as early as possible after generation starts or when the assistant DOM node appears. If the hold path fails, Prose Enhancement should skip for that turn rather than showing raw output and replacing it late.

## Lifecycle

```text
Host generation starts
  -> Recursion notes Prose Enhancement mode
  -> if enabled, arm output hold
Assistant message lands
  -> capture message id, active swipe id, source hash, raw text
  -> hold visible output
  -> call Utility proseEnhancer
  -> validate output against source identity and dialogue invariants
  -> As Swipe: ensure original + enhanced sibling, select enhanced, reveal
  -> Replace: replace active text, reveal
  -> failure: reveal original unchanged
```

The pass should run after normal Recursion prompt cleanup/host-generation-ended handling. Rapid warm may still run after assistant landing, but Prose Enhancement should not depend on Rapid and should not consume Rapid warm artifacts.

## Stale, Cancel, And Failure Behavior

- If the user deletes, edits, swipes, changes chat, or starts a new generation while enhancement is running, abort or discard the enhancement result and reveal the current host state safely.
- If the Utility call fails, times out, or returns invalid structured output, reveal the original.
- If validation fails, reveal the original and record `prose-enhancement-validation-failed`.
- If the hold path cannot safely hide the output before the player sees it, skip enhancement for that message.
- If a duplicate enhanced sibling already exists for the same original hash, select it in `As Swipe` mode instead of creating another sibling.

Timeout default should be shorter than card generation, recommended `45000` ms.

## Storage And Diagnostics

Persist only compact metadata:

```js
{
  mode: 'as-swipe',
  messageId: 42,
  originalHash: '...',
  enhancedHash: '...',
  sourceRevisionHash: '...',
  status: 'applied',
  appliedAs: 'swipe',
  providerLane: 'utility',
  latencyMs: 1234
}
```

Do not persist raw original text, enhanced text, provider prompt, provider response, full scene context, API keys, hidden reasoning, or transcript dumps in run journals.

## UI And Design Constraints

The UI must remain SillyTavern-native, compact, graphite-dark, and operational:

- one icon-only `upgrade.svg` bar control to the right of Cards;
- dropdown behavior and row descriptions similar to the Mode setting dropdown;
- greyed-out icon treatment when mode is `Off`;
- no standalone editor panel;
- no Recast-style pass list;
- no diff viewer in V1;
- no per-message visible accept/reject workflow;
- no decorative status treatment.

The `As Swipe` mode is the review surface because the raw host output remains available as a sibling swipe.

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

- `proseEnhancement.mode` normalizes as `off | as-swipe | replace`.
- `proseEnhancement.contextMessages` normalizes as integer `0..35`, default `13`.
- Compact bar renders the icon-only `Prose Enhancement` button to the right of Cards.
- Prose Enhancement button uses `upgrade.svg`, opens an Off/As Swipe/Replace dropdown, and greys out when `Off`.
- Utility provider role `proseEnhancer` validates schema `recursion.proseEnhancer.v1`.
- Prose Enhancement uses bounded scene context and raw latest assistant text only.
- Dialogue spans must remain byte-identical before output is applied, except exact or obvious direct variants from the full banned AI slop list may be removed or neutralized.
- Prompt includes the full banned AI slop and clichés list intact, not reduced or paraphrased.
- Enabled mode hides or blanks raw host output before the player sees it.
- `As Swipe` creates original and enhanced swipes, then selects the enhanced swipe.
- `Replace` replaces the active assistant text with enhanced text.
- Duplicate enhanced siblings are not created for the same original hash.
- Failure or stale result reveals original output unchanged.
- Deterministic tests cover settings, provider role/schema, prompt builder, validation, host adapter methods, runtime lifecycle, bar UI, Advanced context setting, and docs.
- Live SillyTavern proof covers `As Swipe`, `Replace`, stale/cancel safety, and served-extension freshness.
