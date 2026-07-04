# Recursion Fused Pipeline Design

## Purpose

Add **Fused** as Recursion's third foreground pipeline. Fused keeps the Utility Arbiter, scene deck, turn hand, and prompt packet contracts intact, but changes card generation from many independent card-role calls into one structured card-bundle call.

Fused is variant 1 from the brainstorm: **bulk cards only**. It does not combine Arbiter planning, card generation, guidance composition, or final prompt installation into one model call. The Arbiter still decides what card work matters. Runtime still validates cards, updates the scene deck, selects the turn hand, and calls `guidanceComposer` or `reasonerComposer` exactly as the selected reasoning level requires.

## Product Position

The Pipeline selector becomes:

- **Standard**: foreground Arbiter, individual card jobs, hand selection, guidance, prompt install. Best default for fast and cheap utility models.
- **Rapid**: background warm card packet plus foreground turn delta. Best when precomputation can hide latency.
- **Fused**: foreground Arbiter, one provider card-bundle call, hand selection, guidance, prompt install. Best when one stronger model can reason across the whole requested card set better than several cheaper isolated calls.

Fused should be documented as a quality-oriented and coherence-oriented pipeline for stronger reasoning models. Good candidates are current reasoning-focused DeepSeek, GLM, MiniMax, Kimi, MiMo, Qwen, and similar model families when the operator has configured them as Utility or Reasoner providers. Standard remains the better fit for fast, cheap, smaller utility-class models, including 500B-and-lower parameter models and families such as Nemotron, GPT-OSS, Gemma, and similar.

This guidance is operator-facing, not a hardcoded vendor allowlist. Recursion must not block Fused based on model names, provider labels, or parameter counts. The runtime should expose diagnostics and documentation that make the tradeoff clear.

## Non-Negotiable Contract

- Fused is a first-class `settings.pipelineMode` value: `standard | rapid | fused`.
- Fused is not a Rapid warm artifact and does not prewarm.
- Fused is not a local summary or local scene brief.
- Fused keeps Arbiter planning separate.
- Fused keeps provider guidance separate.
- Fused sends all required provider-generated card jobs for the current pass in one model call.
- Fused returns raw card artifacts, not final prompt prose.
- Fused validates returned cards item by item.
- One malformed or missing item must not discard valid sibling cards.
- Manual selected-family coverage remains mandatory where cache or valid provider output can satisfy it; failed Fused Manual items produce explicit omissions.
- The final prompt packet still contains provider-authored guidance plus full selected raw card evidence.
- All provider prompts, responses, diagnostics, journals, and UI rows remain privacy-safe: no raw provider text, secrets, hidden reasoning, stack traces, or raw transcript dumps in persisted diagnostics.

## Flow

```text
Send
  -> Snapshot with pending user message
  -> Utility Arbiter
  -> Scope filtering and Manual forced-family reconciliation
  -> Fused card bundle call for required provider card jobs
  -> Item-level card validation
  -> Scene deck update
  -> Turn hand selection
  -> Guidance Composer / Reasoner Composer according to Reasoning Level
  -> Prompt Packet V3
  -> SillyTavern prompt install
```

The flow is intentionally the Standard flow with one changed card-generation step. This keeps the pipeline easy to reason about and limits implementation blast radius.

## Provider Role

Add one provider role:

```text
fusedCardBundle
```

Expected response schema:

```text
recursion.cardBundle.v1
```

Default lane is Utility, but runtime may set `request.lane = "reasoner"` when the current Reasoning Level maps the Fused bundle to Reasoner. Provider routing should treat `fusedCardBundle` like other machine-JSON roles: it carries `responseSchema`, `machineJson: true`, `snapshotHash`, reasoning metadata, timeout handling, structured-output retry, activity, and sanitized journal entries.

## Request Shape

The Fused request is built from the same normalized `plan.cardJobs` that Standard already consumes after scope filtering and Manual reconciliation.

```js
{
  roleId: 'fusedCardBundle',
  runId: 'run-...',
  lane: 'utility' | 'reasoner',
  snapshotHash: '...',
  cardScope: {
    mode: 'auto' | 'manual',
    strictWhitelist: true | false,
    selectedSubItemsByFamily: {
      'Scene Frame': ['location-situation', 'beat-boundary']
    }
  },
  storyForm: {
    schema: 'recursion.storyForm.v1',
    tense: 'past',
    pov: 'third-person-limited',
    confidence: 'high',
    evidenceRefs: ['message:920'],
    reason: '...'
  },
  requestedCards: [
    {
      family: 'Scene Frame',
      role: 'sceneFrameCard',
      priority: 100,
      reason: 'Arbiter request reason.',
      selectedSubItems: ['location-situation', 'beat-boundary'],
      refreshOfCardId: '',
      forcedBy: ''
    }
  ],
  prompt: '...provider-safe instructions...',
  metadata: {
    requestedCount: 1,
    requestedFamilies: ['Scene Frame']
  }
}
```

The provider prompt must include:

- the frozen provider-safe snapshot once;
- the frozen `snapshotHash`;
- the normalized `storyForm`;
- one requested-card block per job;
- each card family, provider role, catalog description, selected facets, refresh target, Manual forced marker, and Arbiter reason;
- a strict instruction to return one bundle object;
- the normal family-specific safety instructions, especially Character Motivation and Social Subtext constraints.

## Response Shape

```json
{
  "schema": "recursion.cardBundle.v1",
  "snapshotHash": "same frozen snapshot hash",
  "items": [
    {
      "schema": "recursion.card.v1",
      "family": "Scene Frame",
      "role": "sceneFrameCard",
      "promptText": "Full prompt-facing card text.",
      "summary": "Optional compact inspector summary.",
      "evidenceRefs": ["message:920"],
      "tokenEstimate": 95,
      "detailProfile": "standard",
      "emphasis": "normal",
      "inspectorNotes": "Optional private diagnostics."
    }
  ],
  "omitted": [
    {
      "family": "Items",
      "role": "possessionsItemsCard",
      "reason": "not-enough-evidence"
    }
  ],
  "diagnostics": []
}
```

`items[]` is an array of card objects. Each item must identify its family and role. The bundle envelope is not allowed to contain prompt-facing guidance for the final story model.

Valid omission reasons:

- `not-enough-evidence`
- `duplicate-coverage`
- `unsafe`
- `out-of-scope`
- `provider-skipped`

Runtime may normalize unknown omission reasons to `provider-skipped`.

## Validation

Validation is two-tiered.

Bundle-level validation:

- top-level `schema` must be `recursion.cardBundle.v1`;
- top-level `snapshotHash` must match the request;
- top-level `items` must be an array;
- top-level `items.length` must be at most the requested-card count;
- top-level diagnostics and omitted entries must be sanitized and bounded.

Item-level validation:

- each item family/role must resolve to a requested card job;
- each requested family may produce at most one accepted card;
- each item must validate through the same card normalization path as `recursion.card.v1`;
- each item must have at least one valid `message:N` evidence reference;
- each item must pass Character Motivation and other card safety checks;
- each item must inherit the current source context, source revision, scene id, and card id construction rules;
- invalid items are dropped with a sanitized omission reason.

Fused must accept valid siblings after dropping invalid siblings. A partial Fused result is still useful.

## Failure Behavior

Fused failure should fail soft.

- If no card jobs are required, Fused does not call `fusedCardBundle`; runtime reuses cache and proceeds like Standard.
- If the bundle call fails, times out, aborts, returns no parseable JSON, returns the wrong schema, or returns the wrong snapshot hash, Fused may escalate to Standard card generation for the same Arbiter plan once.
- If the bundle call returns at least one valid card, runtime accepts those cards and does not rerun missing optional cards through Standard.
- If a Manual forced family is missing or invalid after a partial Fused bundle, runtime records a visible forced omission instead of silently shrinking the hand.
- If no provider cards and no cache cards survive, existing local fallback card behavior may run only through the same bounded fallback rules Standard uses today.

Escalation diagnostics:

- `fused-escalated-standard:provider-unavailable`
- `fused-escalated-standard:invalid-bundle`
- `fused-escalated-standard:snapshot-mismatch`
- `fused-escalated-standard:empty-bundle`
- `fused-partial:item-invalid:<family>`
- `fused-partial:item-missing:<family>`
- `fused-manual-forced-missing:<family>`

The fallback is a reliability path, not the normal promise. The UI should show that Fused fell back rather than pretending it was an ordinary Standard run.

## Reasoning Level Contract

Fused must respect the existing Reasoning Level feature. It should not add a separate pipeline-specific route selector.

Fused lane selection:

| Reasoning Level | Fused bundle lane | Reasoning metadata | Card pressure |
| --- | --- | --- | --- |
| Low | Utility | `reasoningCategory: "card"`, `reasoningIntent: "minimal"` | Cap positive `maxCards` at Min Cards. |
| Medium | Utility | `reasoningCategory: "card"`, `reasoningIntent: "minimal"` | Cap positive `maxCards` at Normal Cards. |
| High | Reasoner when healthy, otherwise Utility fallback | `reasoningCategory: "card"`, `reasoningIntent: "minimal"` | Cap positive `maxCards` at Normal Cards. |
| Ultra | Reasoner when healthy, otherwise Utility fallback | `reasoningCategory: "card"`, `reasoningIntent: "medium"` | Raise and cap positive `maxCards` at Max Cards. |

This preserves the existing card-generation reasoning policy: High uses stronger route selection without increasing the provider reasoning-control field for card work, while Ultra increases card-work reasoning intent to medium. Guidance composition after card generation remains unchanged: Medium and above still prefer Reasoner composition when healthy.

If Reasoner is selected but unavailable, Fused must fall back to Utility for the bundle and record a compact diagnostic. The UI should keep the selected Reasoning Level rather than blocking generation.

## UI Contract

The compact Pipeline menu adds a third option:

- **Fused**: `Generates all requested cards in one structured model call before normal guidance.`

The button remains icon-only. The dropdown remains compact and SillyTavern-native. Fused should use the same layer-based visual language as Standard and Rapid, but its icon should read heavier than both: a thick combined layer, almost a small cube, as if multiple card layers have merged into one solid bundle. It should not use a lightning bolt, magic symbol, decorative gradient, or large text.

The Pipeline selector is still not duplicated in Settings. Settings may persist `pipelineMode: "fused"`, but there is no separate Fused settings panel.

Standby copy may remain `Scene deck standing by.` because Fused has no warm deck state. Current-step text while running should be short:

- `Fusing scene cards...`
- `Validating fused cards...`

Progress menu should show one top-level Fused card bundle row with child rows for requested families. Child rows can start as pending and settle as generated, warning, failed, cached, or fallback. Since the provider response arrives as one bundle, child rows may settle together after validation rather than streaming one-by-one.

## Storage And Diagnostics

No new scene-cache family is required. Accepted Fused cards enter the same scene deck as generated cards with `origin: "generated"`.

Recommended card metadata additions:

```js
{
  providerLane: 'utility' | 'reasoner',
  providerRole: 'fusedCardBundle',
  fusedBundleId: 'provider run id or request hash',
  fusedItemStatus: 'accepted'
}
```

Run journal entries may include:

- provider role: `fusedCardBundle`;
- lane;
- schema;
- latency;
- retry count;
- requested count;
- accepted count;
- invalid count;
- omitted count;
- fallback or escalation code;
- request hash and response hash.

Run journal entries must not include raw prompt text, raw response text, full cards, secrets, hidden reasoning, or raw transcript text.

## Documentation Updates

Implementation should update:

- `docs/RECURSION_EXTENSION_SPEC.md`
- `docs/architecture/RUNTIME_ARCHITECTURE.md`
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- `docs/technical/RECURSION_TECHNICAL_MANUAL.md`
- `docs/technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md`
- `docs/design/UI_SPEC.md`
- `docs/user/RECURSION_OPERATOR_MANUAL.md`
- `docs/testing/LIVE_SMOKE_TEST_PLAN.md`

Docs should state that Fused is intended for stronger reasoning models and Standard remains a better fit for fast and cheap models. Docs should also state that model-family examples are guidance, not a runtime allowlist.

## Acceptance Criteria

- `pipelineMode: "fused"` normalizes, persists, and renders in the compact Pipeline selector.
- Fused leaves Auto/Manual semantics unchanged.
- Fused leaves Reasoning Level semantics intact.
- Fused runs Arbiter first.
- Fused sends one `fusedCardBundle` call for required provider card jobs when generation is needed.
- Fused validates bundle items independently and accepts valid siblings.
- Fused records explicit omissions for missing or invalid requested families.
- Fused Manual omissions are visible when a forced selected family fails.
- Fused proceeds through the same deck, hand, guidance, packet, prompt install, storage, and diagnostics contracts as Standard.
- Fused failure can escalate to Standard once when no useful bundle is recoverable.
- Deterministic tests cover settings, provider role/schema routing, card request and validation, runtime happy path, runtime partial path, runtime fallback path, UI selector, progress rows, docs model-positioning copy, and alpha gate.
- Live smoke can prove one bundle call replaces multiple card-role calls for the same Arbiter plan.
