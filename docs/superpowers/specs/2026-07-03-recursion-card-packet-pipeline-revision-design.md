# Recursion Card Packet Pipeline Revision Design

## Purpose

Revise Recursion's Standard and Rapid pipelines so prompt injection preserves raw selected cards as first-class model-facing evidence, while provider-authored guidance gives the final story model direction for how to use that evidence. This replaces the current "brief as compressed substitute" contract with "guidance plus raw card packet."

The fix is necessary because the current Rapid warm artifact stores `conditionedSceneBrief` by joining selected `card.promptText` and slicing it to 1600 characters. That is not provider-composed guidance, and it can lose the subtext, constraint nuance, and interaction detail that made the raw cards valuable.

## Non-Negotiable Contract

- No deterministic semantic composer.
- Runtime may validate, serialize, order, install, and clear prompt blocks, but it must not rewrite card meaning into a local scene brief, turn brief, or guidance substitute.
- Raw selected cards remain prompt-facing evidence.
- Provider guidance is additive. It never replaces raw selected cards.
- If provider guidance is missing, invalid, stale, unsafe, or unavailable, Recursion may install a raw-card-only packet with a minimal static wrapper. It must not fabricate local guidance.
- Prompt length is not the primary optimization target. Loss of card detail is the failure mode this revision fixes.
- Pre-alpha contract changes update code, docs, schemas, tests, and examples in place. No compatibility shim for old packet or Rapid artifact shapes.

## Current Failure

Standard currently selects cards and calls `composePromptPacket(...)`, but the default utility path in `src/prompt.mjs` only buckets raw `promptText` into `Scene brief`, `Turn brief`, and `Guardrails` sections. It adds behavior-policy lines and static guardrails, then applies character caps. It does not call `briefUtilityComposer`, even though that provider role exists in `src/providers.mjs`.

Rapid currently warms a scene deck in the background, selects a hand, then builds:

```js
const conditionedSceneBrief = hand.cards
  .map((card) => card.promptText)
  .filter(Boolean)
  .join('\n')
  .slice(0, 1600);
```

That string is later treated as warm provider-generated scene guidance. It is actually locally joined raw card text with a hard truncation.

## Revised Artifact Model

### Prompt Packet V3

The model-facing packet becomes a card packet:

```js
{
  packetVersion: 3,
  packetKind: 'recursion.cardPacket.v1',
  snapshotHash: '...',
  chatId: '...',
  sceneFingerprint: '...',
  turnFingerprint: '...',
  pipelineMode: 'standard' | 'rapid',
  guidance: {
    schema: 'recursion.guidanceComposer.v1',
    status: 'used' | 'missing' | 'fallback-raw-only',
    providerLane: 'utility' | 'reasoner',
    text: 'Provider-authored direction for how the generation should use the cards.',
    sourceCardIds: ['card-...'],
    guardrailCardIds: ['card-...'],
    omittedCardIds: [{ id: 'card-...', reason: 'provider_dropped' }],
    diagnostics: []
  },
  cardEvidence: [
    {
      id: 'card-...',
      family: 'Scene Frame',
      promptText: 'Full selected raw card promptText.',
      emphasis: 'normal',
      detailProfile: 'standard',
      evidenceRefs: ['message:913']
    }
  ],
  packetGuardrails: {
    staticText: 'Honor player intent, visible facts, reveal boundaries, and hard card constraints.',
    sourceCardIds: ['card-...']
  },
  injectionPlan: [],
  diagnostics: {}
}
```

`cardEvidence[].promptText` is not summarized by runtime. It may be redacted for secrets and rejected for unsafe hidden-reasoning wording, but it must not be shortened by routine footprint budgets.

### Prompt Blocks

The installed prompt blocks become:

1. `recursion.guidance`
   - Provider-authored direction.
   - Explains how scene/generation should play out using the card evidence.
   - May include response posture, social subtext handling, hard priority notes, and how to reconcile card tensions.

2. `recursion.cardEvidence`
   - Full raw selected cards.
   - Grouped by family and priority for readability.
   - Includes family, emphasis when non-normal, and promptText.
   - Does not include private diagnostics or raw provider payloads.

3. `recursion.guardrails`
   - Minimal global wrapper plus raw hard-constraint card evidence references.
   - Static copy stays short.
   - Dynamic hard limits live primarily in raw `Scene Constraints` cards and guidance references, not in a lossy local rewrite.

This replaces `recursion.sceneBrief` and `recursion.turnBrief` as primary model-facing concepts. The product language should shift from "Last Brief" toward "Last Packet" or "Prompt Packet" where docs need precision, though compact UI labels may remain short if user-facing readability demands it.

## Provider Guidance Composer

Rename the provider role from `briefUtilityComposer` to `guidanceComposer` in the current pre-alpha contract. Response schema:

```js
{
  schema: 'recursion.guidanceComposer.v1',
  snapshotHash: 'same frozen snapshot hash',
  guidanceText: '...',
  sourceCardIds: ['card-...'],
  guardrailCardIds: ['card-...'],
  omittedCardIds: [{ id: 'card-...', reason: 'duplicate | lower-priority | unsupported | unsafe' }],
  diagnostics: []
}
```

Prompt intent:

```text
Write response guidance, not a summary.
Use the raw selected cards as evidence.
Preserve card nuance, subtext, hard constraints, and social posture.
Do not replace or compress the raw cards; the raw cards will be injected after this guidance.
Do not invent hidden motives, future plot, unrevealed facts, or out-of-character analysis.
```

The guidance composer receives all selected raw cards, selected-card metadata, omitted hand candidates for context, behavior policy, footprint preference, and snapshot hashes. It does not receive private diagnostics, raw provider secrets, or unbounded chat text.

Validation:

- schema must match;
- snapshot hash must match;
- referenced card ids must exist in the selected hand;
- `guidanceText` must pass the same hidden-thought, future-plot, and secret redaction checks as packet text;
- invalid guidance yields raw-card-only packet, not local guidance;
- invalid source ids are dropped and counted in diagnostics;
- omitted reasons are normalized to a safe enum.

## Standard Pipeline Revision

Standard remains the reference quality path.

Flow:

```text
Send -> snapshot with pending user message -> Arbiter -> generate/reuse cards -> select hand -> guidanceComposer -> build card packet -> install -> Story generation
```

Standard packet content:

- raw selected cards always injected through `recursion.cardEvidence`;
- provider guidance injected through `recursion.guidance` when valid;
- minimal guardrail wrapper injected through `recursion.guardrails`;
- no deterministic scene brief or turn brief;
- Reasoner composition, when enabled, may replace the guidance composer lane or add a second provider-authored guidance pass, but raw cards still remain.

Failure behavior:

- Arbiter/card failure follows existing skip or cache policy.
- Guidance composer failure does not drop raw cards.
- If selected raw cards exist, install raw-card-only packet with guidance status `fallback-raw-only`.
- If no selected raw cards exist, skip Recursion prompt install and report the provider/cache gap.

## Rapid Pipeline Revision

Rapid becomes "warm card packet plus foreground delta," not "local conditionedSceneBrief plus delta."

### Rapid Warm V2

Background warm flow:

```text
Source stable -> snapshot -> Arbiter -> generate/reuse cards -> select hand -> guidanceComposer -> save warm packet artifact
```

Warm artifact shape:

```js
{
  pipelineVersion: 2,
  status: 'ready',
  warmArtifactId: 'rapid-warm-artifact-...',
  baseSourceRevisionHash: '...',
  baseSnapshotHash: '...',
  selectedCardIds: ['card-...'],
  cardIds: ['card-...'],
  guidance: {
    schema: 'recursion.guidanceComposer.v1',
    status: 'used',
    text: 'Provider-authored scene guidance for the warmed card packet.',
    sourceCardIds: ['card-...'],
    guardrailCardIds: ['card-...'],
    diagnostics: []
  },
  settingsHash: '...',
  providerContractHash: '...',
  cardCatalogHash: '...',
  promptContractHash: '...',
  builtAt: '...',
  runId: '...',
  diagnostics: []
}
```

The warm artifact does not store `conditionedSceneBrief`. Existing `conditionedSceneBrief` cache artifacts become invalid when `RAPID_PIPELINE_VERSION` changes to `2`.

Warm storage may rely on the scene cache's stored card list for full raw card text, keyed by `selectedCardIds`. It must not store a separate truncated string copy as authoritative guidance.

### Rapid Foreground Warm Path

On send:

```text
Load exact warm artifact -> call rapidTurnDelta.v2 -> build card packet from warm guidance + selected raw cards + turn delta -> install
```

`rapidTurnDelta.v2` receives:

- warm artifact metadata;
- provider-authored warm guidance;
- full raw selected warm cards, not summaries only;
- pending user message;
- base and turn source revision hashes;
- behavior policy and card scope summary.

Output:

```js
{
  schema: 'recursion.rapidTurnDelta.v2',
  snapshotHash: 'turn snapshot hash',
  baseSourceRevisionHash: '...',
  turnSourceRevisionHash: '...',
  selectedCardIds: ['card-...'],
  turnGuidanceText: 'Provider-authored direction for this user message.',
  guardrailCardIds: ['card-...'],
  packetInstructions: [],
  backgroundRefreshRequests: [],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: []
}
```

Foreground packet content:

- `recursion.guidance`: warm guidance plus turn guidance;
- `recursion.cardEvidence`: full raw cards selected by `rapidTurnDelta.v2`;
- `recursion.guardrails`: minimal wrapper plus selected guardrail card references;
- no local concatenated scene brief.

### Rapid Warm Miss

First implementation should remove summary-only fast-start from the quality path. If no exact warm card packet exists, Rapid escalates to Standard for the turn. That makes quality behavior honest and avoids a second weak summary product.

A later `rapidFastStartPack.v2` may be added only if it returns provider-authored ephemeral raw cards plus guidance in the same card-packet contract. It must not return only `sceneBrief`, `turnBrief`, and `guardrails`.

## Footprint And Budgets

Prompt Footprint changes selection pressure and guidance verbosity. It does not truncate raw selected card `promptText` in normal operation.

- Compact: fewer selected cards and shorter provider guidance.
- Normal: default selected-card count and normal provider guidance.
- Rich: more selected cards and richer provider guidance.

Hard safety caps remain allowed to prevent runaway packets, but hitting those caps is a diagnostic quality event, not routine compression. If a selected card cannot fit due to an absolute host limit, diagnostics must show which card was omitted and why.

## UI And Diagnostics

Current inspection surfaces must show:

- guidance status: used, fallback-raw-only, missing, invalid, stale;
- raw selected cards exactly as injected;
- prompt packet text for all installed blocks;
- source card ids used by guidance;
- Rapid path: warm-v2, warm-miss-standard, invalid-warm-standard.

The dropdown may keep the short "Last Brief" label temporarily, but docs and full viewer should call the artifact a prompt packet or card packet. The core trust surface is: "what raw cards did Recursion inject, and what provider guidance did it add?"

## Documentation Updates

Update in place:

- `docs/technical/PROMPT_PACKET_AND_INJECTION.md`
- `docs/architecture/PROMPT_COMPOSITION_SPEC.md`
- `docs/architecture/PROVIDER_AND_GENERATION_SPEC.md`
- `docs/architecture/RUNTIME_ARCHITECTURE.md`
- `docs/user/RECURSION_OPERATOR_MANUAL.md`
- `docs/user/FIRST_RUN_WORKFLOW.md`
- `docs/design/UI_SPEC.md` only where labels/inspection contract change
- release notes if the checkpoint describes prompt packet shape

## Test Contract

Required proof:

- Standard packet includes full raw `Scene Frame`, `Active Cast`, `Scene Constraints`, `Social Subtext`, and `Open Threads` card text.
- Guidance composer receives all selected raw cards.
- Valid guidance is injected in `recursion.guidance`.
- Invalid guidance falls back to raw-card-only packet.
- No deterministic scene/turn brief appears in Standard packet output.
- Rapid warm artifact version 2 stores provider guidance and selected card ids, not `conditionedSceneBrief`.
- Rapid foreground passes full raw selected cards to `rapidTurnDelta.v2`.
- Rapid warm miss escalates to Standard.
- Prompt Packet/Full Viewer inspection shows raw cards and guidance.

## Open Follow-Up

After implementation, run a live SillyTavern prompt-packet capture on a dense turn like the Rhya/Dumbledore example and compare:

- raw generated card text;
- installed card evidence block;
- installed guidance block;
- final model response quality.

Success means raw-card nuance remains visible in the installed packet, and guidance adds directional interpretation without replacing the raw evidence.
