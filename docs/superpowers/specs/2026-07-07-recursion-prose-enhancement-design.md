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

When an assistant generation, regeneration, continuation, or swipe lands, Recursion temporarily holds the visible output, runs Prose Enhancement, then releases the message with two swipes:

1. Original SillyTavern output.
2. Enhanced output.

The enhanced swipe is selected automatically before the message becomes visible. The player can swipe back to the raw original if desired.

For every newly generated host swipe, the feature may create one matching enhanced sibling. It must not recursively enhance its own enhanced swipe, and it must not duplicate an enhanced sibling for the same original text hash.

### Replace

When an assistant generation, regeneration, continuation, or swipe lands, Recursion temporarily holds the visible output, runs Prose Enhancement, replaces the active assistant text with the enhanced text, then reveals the message.

If enhancement fails validation, times out, is canceled, or Utility is unavailable, Recursion reveals the original output unchanged.

## User Experience

Settings label: `Prose Enhancement`

Settings options:

- `Off`
- `As Swipe`
- `Replace`

Advanced setting:

- `Context Messages`: integer `0..35`, default `13`.

The control belongs in the Play tab because it changes normal play output, but it should stay compact and not become a pass editor. `Context Messages` may live in Advanced if the Play tab would become too dense.

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
- every dialogue span is byte-identical and appears in the same order;
- output has no known secret, prompt, hidden-reasoning, or provider-diagnostic markers;
- current latest assistant message/swipe still matches the source identity captured before the call;
- this source hash has not already produced an enhanced sibling for the same message/swipe.

Dialogue-span validation is mandatory. If it cannot parse the text confidently, Recursion should skip rather than risk changing dialogue.

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
- Play settings render the `Prose Enhancement` mode selector.
- Utility provider role `proseEnhancer` validates schema `recursion.proseEnhancer.v1`.
- Prose Enhancement uses bounded scene context and raw latest assistant text only.
- Dialogue spans must remain byte-identical before output is applied.
- Enabled mode hides or blanks raw host output before the player sees it.
- `As Swipe` creates original and enhanced swipes, then selects the enhanced swipe.
- `Replace` replaces the active assistant text with enhanced text.
- Duplicate enhanced siblings are not created for the same original hash.
- Failure or stale result reveals original output unchanged.
- Deterministic tests cover settings, provider role/schema, prompt builder, validation, host adapter methods, runtime lifecycle, UI settings, and docs.
- Live SillyTavern proof covers `As Swipe`, `Replace`, stale/cancel safety, and served-extension freshness.
