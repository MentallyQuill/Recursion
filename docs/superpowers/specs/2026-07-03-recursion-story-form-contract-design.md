# Recursion Story Form Contract Design

## Purpose

Add a story-form decision to Recursion's Arbiter and carry that decision through card generation, guidance composition, Rapid warm artifacts, and prompt packet diagnostics.

The problem is style drift inside generated cards. Recursion currently injects raw selected card `promptText` through `recursion.cardEvidence`. If a sidecar card is written in the wrong tense or POV, the final SillyTavern model sees conflicting story-style evidence and may mirror the wrong form in the next assistant message.

This revision makes tense and POV explicit runtime contract data rather than implicit prose style. The Arbiter determines the scene's story form, runtime validates the result, and downstream provider prompts require cards and guidance to preserve that form.

## Current Failure

The Arbiter plan shape in `src/runtime.mjs` decides action, scene status, card jobs, lifecycle, Reasoner use, budgets, and diagnostics. It does not carry a tense or POV field.

`src/cards.mjs` builds one-card provider prompts from the Arbiter card job, selected facets, snapshot, and schema requirements. The prompt asks for compact `promptText`, but does not say what tense or POV to use.

`src/prompt.mjs` injects raw selected card text as Card Evidence. The guidance section currently tells the final model to write "normal story prose/dialogue," which is too generic when the active chat is past tense third-person, present tense second-person, or first-person.

## Recommended Rule

Infer story form from the latest visible assistant narration first. Ignore the player's pending message style unless no assistant prose exists in the bounded snapshot.

Rationale:

- Assistant messages represent the story output style Recursion must preserve.
- User messages often contain commands, OOC instructions, fragments, quoted text, or first-person player intent that should not overwrite the narrator form.
- If no assistant narration exists, the Arbiter may use the latest visible message as weak evidence and set confidence to `low` or `medium`.

## Story Form Contract

The Arbiter emits a normalized `storyForm` object inside `recursion.utilityArbiter.v1`:

```json
{
  "storyForm": {
    "schema": "recursion.storyForm.v1",
    "tense": "past",
    "pov": "third-person-limited",
    "confidence": "high",
    "evidenceRefs": ["message:42"],
    "reason": "Latest assistant narration uses past-tense third-person prose."
  }
}
```

Allowed `tense` values:

- `past`
- `present`
- `mixed`
- `unknown`

Allowed `pov` values:

- `first-person`
- `second-person`
- `third-person-limited`
- `third-person-omniscient`
- `mixed`
- `unknown`

Allowed `confidence` values:

- `high`
- `medium`
- `low`

`evidenceRefs` must use message refs already accepted elsewhere in the card system, such as `message:42`. `reason` is compact diagnostic text and must not contain hidden reasoning, prompt instructions, secrets, or raw provider output.

`future` tense is intentionally not a V1 value. A future-tense sentence in the transcript is usually a local clause, not the story's narrative tense.

## Arbiter Prompt Change

The Utility Arbiter prompt gets a story-form task in addition to card planning:

```text
Story form contract:
- Determine tense and POV from the latest visible assistant narration first.
- Ignore the pending user message's style unless no assistant narration exists.
- Use "mixed" only when recent assistant narration truly alternates forms.
- Use "unknown" with low confidence when the snapshot has no usable story prose.
- Return storyForm using schema "recursion.storyForm.v1".
- Do not use storyForm to rewrite events, infer hidden thoughts, or add style coaching.
```

The Arbiter output contract lists `storyForm` as a required top-level field. Runtime may fall back to a local `unknown` story form only when Utility is unavailable or Arbiter output is rejected.

## Runtime Validation

Runtime validates `storyForm` before trusting it:

- schema must be `recursion.storyForm.v1`;
- tense, POV, and confidence must be allowed enum values;
- message evidence refs must be compact and safe;
- reason is sanitized and truncated;
- invalid or missing story form becomes `unknown` with diagnostic `story-form-fallback`;
- an invalid `storyForm` alone should not discard an otherwise valid Arbiter plan.

This is a soft semantic contract. Runtime should not use brittle regexes to reject cards for tense. The main enforcement is provider prompt conditioning plus packet-level visibility for tests and diagnostics.

## Card Generation Change

Every card request receives story form in safe metadata and in the model-visible prompt.

Card prompt block:

```text
Story form contract for card promptText:
- Target tense: past.
- Target POV: third-person-limited.
- Confidence: high.
- Write promptText in this same tense and POV when describing scene actions, narration, response posture, or likely next-beat implications.
- Prefer neutral constraint wording when the family is not narrative prose.
- Do not switch to first person, second person, or present tense unless storyForm requires it.
```

The card schema stays `recursion.card.v1`. Cards do not gain a separate narrative body. `promptText` remains the only prompt-facing card text, but it must be generated under the story-form contract.

## Guidance Composer Change

The guidance composer receives the same `storyForm` object. Its prompt tells the provider to preserve tense and POV while writing guidance, and the installed guidance section names the target form:

```text
Write the next reply in past tense, third-person-limited POV.
```

When `storyForm` is `unknown`, guidance falls back to:

```text
Write the next reply in the active chat's established story form.
```

This replaces the current generic line about "normal story prose/dialogue."

## Prompt Packet Change

Prompt Packet V3 gains `storyForm` as packet metadata and diagnostics:

```js
{
  packetVersion: 3,
  packetKind: 'recursion.cardPacket.v1',
  storyForm: {
    schema: 'recursion.storyForm.v1',
    tense: 'past',
    pov: 'third-person-limited',
    confidence: 'high',
    evidenceRefs: ['message:42'],
    reason: 'Latest assistant narration uses past-tense third-person prose.'
  },
  diagnostics: {
    storyFormTense: 'past',
    storyFormPov: 'third-person-limited',
    storyFormConfidence: 'high'
  }
}
```

The installed prompt keys do not add a fourth prompt block. Story form is folded into existing `recursion.guidance`, `recursion.cardEvidence` generation instructions, and `recursion.guardrails` only if a future test proves the guardrail layer needs it.

## Rapid Pipeline Change

Rapid warm artifacts store the story form used when the warm packet was built:

```js
{
  pipelineVersion: 2,
  status: 'ready',
  storyForm: {
    schema: 'recursion.storyForm.v1',
    tense: 'past',
    pov: 'third-person-limited',
    confidence: 'high',
    evidenceRefs: ['message:42'],
    reason: 'Latest assistant narration uses past-tense third-person prose.'
  }
}
```

Rapid foreground `rapidTurnDelta.v2` receives warm story form, selected raw cards, warm guidance, and the pending user message. It must write turn guidance in the same story form.

Rapid warm artifacts become unusable when the stored story form is invalid. If the current foreground snapshot changes the latest assistant narration enough to alter story form, Rapid escalates to Standard. A pending user message alone should not invalidate a warm story form.

## Cache And Contract Versioning

This is a prompt/provider contract change, not a storage-shape compatibility exercise. Because Recursion is pre-alpha, update the active contract in place:

- bump provider or prompt contract hash inputs so stale caches built without `storyForm` are not trusted as current;
- include `storyForm` in Rapid artifact validation;
- keep old artifact shapes invalid instead of adding compatibility shims.

## Testing Strategy

Focused tests:

- story-form normalization accepts valid Arbiter output and clamps invalid values to `unknown`;
- Arbiter prompt asks for latest-assistant-first tense/POV inference;
- valid Arbiter output carries `storyForm` into `result.plan` and `runtime.view().lastPlan`;
- `buildCardRequests()` prompt includes the story-form block and metadata;
- `composePromptPacket()` prompt and installed guidance include target tense/POV;
- fallback guidance avoids the generic "normal story prose/dialogue" line;
- Rapid warm artifacts persist and validate story form;
- Rapid foreground prompt includes warm story form.

Gates:

- `node tools/scripts/test-story-form.mjs`
- `node tools/scripts/test-cards.mjs`
- `node tools/scripts/test-prompt.mjs`
- `node tools/scripts/test-rapid-pipeline.mjs`
- `node tools/scripts/test-runtime.mjs`
- `node tools/scripts/run-tests.mjs`

## Documentation Updates

Update:

- `docs/design/CARD_SYSTEM_SPEC.md`
- `docs/technical/RUNTIME_TURN_SEQUENCE.md`
- `docs/technical/PROMPT_PACKET_AND_INJECTION.md`
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- `docs/architecture/PROMPT_COMPOSITION_SPEC.md`

Docs should describe story form as a prompt-contract consistency layer, not a user-facing style setting and not a replacement for presets.

## Non-Goals

- No UI controls for choosing tense or POV.
- No deterministic rewrite pass that edits provider cards after generation.
- No brittle grammatical validator that rejects cards based on regex tense guesses.
- No long-term memory of story form across scenes beyond normal scene cache and Rapid artifact validity.
- No compatibility shim for old Arbiter plans or Rapid artifacts.

## Self-Review

- Placeholder scan: no placeholders remain.
- Scope check: one bounded runtime/provider prompt contract revision; no independent UI subsystem.
- Ambiguity check: latest assistant narration is the primary source; pending user style is ignored unless no assistant narration exists.
- Contract check: story form flows Arbiter -> plan -> card request -> guidance prompt -> packet diagnostics -> Rapid artifact.
