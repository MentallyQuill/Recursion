# Recursion Rapid Pipeline Design

## Purpose

Rapid is a second Recursion pipeline for low-latency play. It keeps provider-generated scene conditioning ready in the background, then uses one small foreground Utility call on user send to adapt that ready context to the latest player message.

The goal is smarter-faster, not cheaper-worse. Rapid must not gain speed by replacing model work with brittle local cards, deterministic pseudo-reasoning, early hard cutoffs, or reduced prompt quality. Speed comes from precomputation, exact-source cache reuse, delta work, and hedged fast provider calls.

## Current Problem

The current Standard pipeline is foreground-first:

```text
Send -> Arbiter call -> card calls -> compose -> install -> Story generation
```

Even with true parallel card calls, the Arbiter remains a foreground gate. A slow Arbiter call can consume most of the user-visible wait before any card work or prompt install can happen.

Rapid changes the shape:

```text
Idle/background -> keep provider-generated scene deck warm
Send -> foreground turn-delta call -> assemble/install -> Story generation
```

If no warm deck exists, Rapid runs one provider-generated fast-start pack. That path degrades breadth, not source quality: the output is still model-generated guidance, just not a full warm deck.

## Design Goals

1. Preserve provider-generated guidance. Rapid never creates local fallback cards, local fallback plans, or deterministic local briefs.
2. Move full scene work out of the send path. Arbiter and card generation run in the background when the source is stable.
3. Keep foreground work tiny. Send-time work selects from a ready deck and writes a user-message delta.
4. Use exact-source freshness. Warm artifacts are keyed by source revision, settings, provider contract, card catalog, prompt contract, and Rapid pipeline version.
5. Respect swipes and edits. Source mutation invalidates only the affected active source revision and aborts stale background jobs.
6. Keep the UI honest. Budget misses are visible as Rapid misses, not hidden by local substitutes.
7. Preserve Standard as the reference path. Standard remains available when the user wants the full foreground pipeline or Rapid detects a mandatory gap.

## Non-Goals

- No local deterministic cards in Rapid.
- No local deterministic scene brief or turn brief in Rapid.
- No deep per-role routing UI for Rapid in V1.
- No attempt to generate multiple final Story replies.
- No broad compatibility shim for old pre-alpha cache shapes.
- No raw provider prompts, raw provider responses, API keys, hidden reasoning, or full chat text in diagnostics.

## Terms

**Standard Pipeline:** Current foreground pipeline: snapshot, Arbiter plan, card jobs, deck update, hand selection, compose, prompt install.

**Rapid Pipeline:** Background scene warming plus foreground turn-delta or fast-start provider call.

**Base source revision:** The exact visible chat source before the next user message is added. This is the source revision that background warming targets.

**Turn source revision:** The exact visible chat source after the pending user message is included for this generation attempt.

**Warm deck:** Provider-generated cards and selected candidate metadata for one base source revision.

**Conditioned scene brief:** Provider-generated compact scene conditioning derived from the warm deck. Rapid may assemble this into the final prompt packet locally because the semantic guidance is provider-authored.

**Turn delta:** A foreground provider output that adapts a warm deck to the new user message.

**Fast-start pack:** A foreground provider output used when no valid warm deck exists. It returns compact scene and turn guidance directly.

**Background refresh request:** A foreground model request for future background work. It never blocks the current Rapid turn unless marked mandatory.

**Mandatory gap:** A model-declared missing piece that must be resolved before safe/coherent prompt install. Rapid escalates to Standard for this turn when a mandatory gap exists.

## User-Facing Contract

Recursion adds a Pipeline selector to the compact bar:

```text
[power] [pipeline] [mode] [cards] | [Hero Pixel Array] ...
```

Pipeline is separate from Auto/Manual:

- **Auto/Manual** answers who controls card scope.
- **Standard/Rapid** answers when heavy scene work happens.

The Pipeline control is a small modern icon button immediately to the left of the Mode button. The icon changes to represent the selected pipeline, matching the Mode button pattern.

Pipeline icons:

- `Standard`: three large stacked layers, meaning Recursion runs the full foreground pipeline with broad scene coverage and detailed conditioning.
- `Rapid`: one compressed layer tapering into a forward spike, meaning Recursion uses warmed provider-generated scene guidance plus a foreground delta.

The icons should share a layer-based visual language so Rapid reads as the same system moving faster, not as a lower-quality shortcut. Do not use a lightning bolt, timer, or empty shortcut glyph for Rapid.

Clicking the Pipeline icon opens a compact dropdown with two rows:

- `Standard`: run full Arbiter, card, compose, and install work on send.
- `Rapid`: warm provider-generated scene guidance in the background and use a short provider delta on send.

Each row shows its icon, short name, and hover/focus tip with the longer explanation. The selected pipeline changes the compact button icon immediately after selection. The dropdown should mirror the Mode dropdown behavior: compact SillyTavern-native styling, close on selection, outside click, or `Esc`, and no visible text in the compact bar.

Standard row copy:

```text
Standard Pipeline: run full Arbiter, card, compose, and install work on send.
```

Rapid row copy:

```text
Rapid Pipeline: warm provider-generated scene guidance in the background and use a short provider delta on send.
```

Do not duplicate Pipeline in Settings. Settings may persist the value, but the user-facing selector belongs only in the compact bar. Do not add a Settings toggle, a second selector in Play, or a broad `Save Settings` style control for pipeline selection.

## Pipeline Selection

Add a persisted setting:

```js
pipelineMode: 'standard' | 'rapid'
```

Default:

```js
'standard'
```

Power off still wins over both pipelines. Manual card scope remains a strict whitelist in both pipelines. Auto card scope remains a preference/focus in both pipelines.

Reasoning Level applies differently:

- Standard uses the existing Reasoning Level route policy.
- Rapid background warming may use the existing route policy because it is off the send path.
- Rapid foreground turn-delta and fast-start use the Utility lane by default, even when Reasoner is configured. They are structured, small, latency-sensitive Utility jobs.

## Rapid Architecture

### Components

**RapidWarmCoordinator**

- Watches stable source states.
- Enqueues background warm jobs.
- Runs Arbiter and card work through provider lanes.
- Saves warm artifacts keyed to exact base source revision.
- Never installs prompt keys.

**RapidArtifactStore**

- Extends the scene cache variant shape.
- Stores warm artifact metadata, provider-generated cards, conditioned scene brief, source hashes, schema versions, and safe diagnostics.
- Preserves a bounded variant ring with the same exact-source rules used by swipe-aware cache variants.

**RapidForegroundRunner**

- Runs on user send when `pipelineMode === 'rapid'`.
- Loads the exact warm artifact for the base source revision.
- Calls `rapidTurnDelta` when warm context exists.
- Calls `rapidFastStartPack` when warm context is missing or invalid.
- Escalates to Standard only when provider output marks a mandatory gap.
- Assembles and installs the prompt packet from provider-generated scene guidance plus provider-generated turn delta.

**RapidHedger**

- Starts a primary fast Utility request.
- Starts a backup Utility request after a short delay, normally 3 to 5 seconds, when the primary has not returned.
- Accepts the first valid structured result.
- Aborts the losing request.
- Records sanitized hedge metadata and cost visibility.

## Background Warm Flow

Background warm work can start after:

- assistant message lands;
- source edit settles;
- swipe changes the active source revision;
- chat idle window opens;
- provider settings change;
- card scope, pipeline, behavior, or reasoning settings change;
- user explicitly refreshes the scene.

Warm work should be debounced so source changes that arrive together create one job. The debounce is scheduling hygiene, not a quality shortcut.

Flow:

```text
Source stable -> snapshot -> exact source key -> load cache -> background Arbiter -> card jobs -> hand/candidate selection -> conditioned scene brief -> save warm artifact
```

The background path can reuse existing Standard building blocks:

- snapshot normalization;
- source revision hashing;
- behavior policy;
- Utility/Reasoner routing for Arbiter and cards;
- card normalization and safety checks;
- source-aware cache variants;
- sanitized activity and journal events.

The background path must differ in two ways:

1. It never installs prompt keys.
2. It never blocks Story generation.

## Foreground Rapid Flow

On user send:

```text
T+0      start run, freeze base snapshot, add pending user message
T+0-2s   load exact warm artifact for base source revision
T+2-20s  run rapidTurnDelta or rapidFastStartPack
T+20-25s assemble and install prompt packet
T+25-30s Story generation starts when provider output is ready
```

The timing is a success target, not permission to install local substitute guidance. If a provider result misses the target, Rapid reports a budget miss and continues with the configured provider-quality path until the user cancels or the run is superseded.

### Warm Deck Path

Use this path when the exact base source revision has a ready warm artifact.

Provider request inputs:

- warm artifact id;
- base source revision hash;
- turn source revision hash;
- new user message text and hash;
- current source hashes;
- selected candidate cards;
- behavior policy;
- card scope summary;
- provider health summary;
- prompt packet budget;
- strict output contract.

Provider output:

```js
{
  schema: 'recursion.rapidTurnDelta.v1',
  snapshotHash: '...',
  baseSourceRevisionHash: '...',
  turnSourceRevisionHash: '...',
  selectedCardIds: ['card-...'],
  turnDeltaBrief: '...',
  packetInstructions: ['...'],
  guardrails: ['...'],
  backgroundRefreshRequests: [
    {
      family: 'Scene Constraints',
      role: 'sceneConstraintsCard',
      reason: 'Latest user action changes access constraints.',
      priority: 'soon'
    }
  ],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: ['rapid-warm-deck']
}
```

Runtime validates selected card ids against the warm artifact. It rejects unknown, stale, inactive, or wrong-source card ids. It assembles the prompt packet from provider-generated scene guidance, selected card prompt text, provider-generated turn delta, and validated guardrails.

### Fast-Start Path

Use this path when no exact warm artifact exists.

Provider output:

```js
{
  schema: 'recursion.rapidFastStartPack.v1',
  snapshotHash: '...',
  turnSourceRevisionHash: '...',
  sceneBrief: '...',
  turnBrief: '...',
  guardrails: ['...'],
  omissions: ['No warm scene deck was ready.'],
  backgroundRefreshRequests: [
    {
      family: 'Scene Frame',
      role: 'sceneFrameCard',
      reason: 'Warm full deck for the next turn.',
      priority: 'soon'
    }
  ],
  mandatoryMissingCards: [],
  escalateToStandard: false,
  diagnostics: ['rapid-fast-start']
}
```

Fast-start does not create durable cards by itself. It creates a turn artifact and schedules background warm work for the next stable source. That keeps the output provider-generated while avoiding fake card provenance.

### Mandatory Gap Escalation

Rapid must not pretend a missing mandatory card is fine.

If `rapidTurnDelta` or `rapidFastStartPack` returns:

```js
{
  escalateToStandard: true,
  mandatoryMissingCards: [
    {
      family: 'Knowledge',
      reason: 'The new user asks directly about a hidden reveal boundary.'
    }
  ]
}
```

runtime aborts the Rapid install path and runs Standard for this turn with the same pending user message and a diagnostic:

```text
rapid-escalated-standard:mandatory-gap
```

This is slower only when the foreground provider explicitly says quality would otherwise suffer.

## Optional Raw Delta Append

The alternate raw-append idea is allowed only in a narrow form:

- The appended material must be provider-generated.
- It must already pass the same source hash, schema, and safety validation as normal provider card output.
- It must not be local text.
- It must not bypass prompt packet redaction and guardrail checks.

Default Rapid should prefer `rapidTurnDelta` because it lets one small provider call select and phrase the delta coherently. Raw append can be a later optimization for already-completed background refresh cards that land before foreground install.

## Cache Shape

Extend the scene cache active variant with Rapid metadata:

```js
{
  sourceRevisionHash: 'base-source-hash',
  cards: [],
  latestHand: null,
  rapid: {
    pipelineVersion: 1,
    status: 'ready',
    warmArtifactId: 'rapid-warm-...',
    conditionedSceneBrief: 'provider-generated brief',
    candidateCardIds: ['card-...'],
    cardIds: ['card-...'],
    baseSourceRevisionHash: 'base-source-hash',
    settingsHash: '...',
    providerContractHash: '...',
    cardCatalogHash: '...',
    promptContractHash: '...',
    builtAt: '2026-07-02T00:00:00.000Z',
    runId: 'run-...',
    diagnostics: ['rapid-warm-ready']
  }
}
```

Only sanitized metadata and provider-generated prompt-safe card text may persist. Raw provider request bodies, raw responses, hidden reasoning, API keys, inactive swipe text, and full prompt packets remain excluded.

## Invalidation

Rapid warm artifacts are valid only when all of these match:

- chat key;
- scene key;
- base source revision hash;
- card catalog hash;
- prompt packet version;
- Rapid pipeline version;
- settings hash relevant to card scope, behavior, footprint, reasoning, and providers;
- provider contract hash.

Source mutation behavior:

- Assistant message lands: enqueue warm for new base source.
- User edit: abort stale warm jobs and invalidate the affected source revision.
- Message delete: abort stale warm jobs and invalidate the affected source revision.
- Swipe: abort stale warm jobs and select only the active source revision variant.
- Chat change: abort all active foreground and background work.
- Provider/settings change: mark existing Rapid artifacts stale by contract mismatch.

Rapid may keep recent variants for A/B/A swipe reuse, but it must never use cards from an inactive source revision.

## Provider Roles

Add Utility roles:

```js
'rapidTurnDelta'
'rapidFastStartPack'
```

Schema ids:

```js
rapidTurnDelta: 'recursion.rapidTurnDelta.v1'
rapidFastStartPack: 'recursion.rapidFastStartPack.v1'
```

Rapid background warming can reuse existing Arbiter and card roles. If implementation proves that background warm needs a distinct Arbiter prompt, add `rapidWarmArbiter` only after the shared Standard Arbiter path is insufficient.

## Hedged Fast Utility

Foreground Rapid calls may hedge:

```text
T+0s    start primary Utility
T+3-5s  start backup Utility if no valid output yet
First valid structured output wins
Abort losing call
```

Rules:

- Hedging applies only to `rapidTurnDelta` and `rapidFastStartPack`.
- Both calls carry the same frozen snapshot hash and output schema.
- A syntactically valid but semantically invalid result does not win.
- If the primary returns invalid output, correction retry may run on the same lane before backup wins only when it does not block a valid backup result.
- Diagnostics record `hedged: true`, winner source, loser status, and latency.

## Prompt Assembly

Rapid prompt assembly is deterministic formatting over provider-generated guidance. It may create section headers, ordering, hashes, and injection metadata locally, but it must not invent semantic cards or summaries.

Allowed local assembly:

- section headings;
- selected provider card ordering;
- redaction-safe metadata;
- omission labels;
- packet hashes;
- prompt key installation.

Not allowed in Rapid:

- local fallback cards;
- local scene brief;
- local turn brief;
- local hidden-state inference;
- local replacement for invalid provider output.

## Failure Behavior

| Condition | Rapid behavior |
| --- | --- |
| Utility provider unavailable | Clear/avoid Recursion prompt install and show `Utility provider is not ready.` No local Rapid substitute. |
| No warm deck | Run `rapidFastStartPack`. |
| Fast-start unavailable or invalid | Retry once through structured correction when safe; otherwise skip Recursion injection with a visible provider failure. |
| Warm artifact stale | Ignore it and use fast-start. |
| Delta selects unknown card id | Reject delta output and retry/correct; do not install. |
| Delta marks mandatory gap | Escalate to Standard for this turn. |
| Hedge primary loses | Abort primary and use first valid backup result. |
| Budget target missed | Show Rapid budget miss; do not install local substitute guidance. |
| User cancels generation | Abort foreground and background work for that run; clear prompt keys. |
| Background warm fails | Keep Standard available, leave Rapid state as not ready, and try again on next stable source. |

## Activity And UI States

Add progress phases:

- `rapidWarmQueued`
- `rapidWarming`
- `rapidWarmReady`
- `rapidWarmStale`
- `rapidDeltaRunning`
- `rapidFastStartRunning`
- `rapidHedgedBackup`
- `rapidEscalatingStandard`
- `rapidBudgetMiss`

The Hero Pixel Array should show foreground Rapid work. Background warming can appear in Activity and the full viewer, but it should not spam compact pixels during normal chat unless the user opens the progress menu or the warm state affects the current send path.

Visible examples:

```text
Rapid warming scene deck...
Rapid deck ready.
Rapid selecting turn delta...
Rapid fast-start pack...
Rapid escalated to Standard: mandatory context gap.
Rapid missed target; waiting for provider output.
```

## Diagnostics

Rapid diagnostics should answer:

- Was Rapid or Standard selected?
- Was a warm deck ready?
- Which source revision was warm?
- Did the turn use warm deck, fast-start, or Standard escalation?
- Did a hedge run?
- Which provider result won?
- Did Rapid meet the 30 second target?
- Which background refresh requests were queued?

Persist only sanitized fields:

- role id;
- schema id;
- run id;
- source revision hashes;
- warm artifact id;
- request hash;
- response hash;
- selected card ids;
- card families;
- latency;
- hedge metadata;
- compact diagnostics;
- status.

## Relationship To Fast Batch Work

The fast-batch design improves Standard and Rapid background warming. It does not solve the Arbiter foreground gate by itself.

Recommended order:

1. Land truthful batch/concurrency diagnostics if not already complete.
2. Add Rapid settings, schemas, and pure helper tests.
3. Add background warm cache.
4. Add foreground Rapid turn-delta and fast-start paths.
5. Add UI and live proof.

## Acceptance Criteria

Deterministic:

- Settings can persist `pipelineMode: 'standard' | 'rapid'`.
- UI exposes a compact Standard/Rapid pipeline selector button with a dropdown.
- Rapid background warm writes exact-source provider-generated artifacts without prompt install.
- Rapid foreground with a warm deck calls `rapidTurnDelta`, installs from provider-generated guidance, and does not call the full Arbiter on send.
- Rapid foreground with no warm deck calls `rapidFastStartPack`.
- Rapid never creates local fallback cards.
- Rapid rejects stale warm artifacts after edits, deletes, swipes, provider setting changes, catalog changes, or prompt contract changes.
- Rapid escalates to Standard only when provider output marks a mandatory gap.
- Hedged foreground calls accept the first valid structured output and abort the loser.
- Prompt install still rechecks active source revision immediately before writing host prompt keys.
- `npm.cmd test` passes.
- `node tools/scripts/run-alpha-gate.mjs` passes.

Live:

- Installed Recursion copy contains the Rapid files.
- With Rapid enabled, an assistant message landing creates a background warm attempt.
- A subsequent user send with an exact warm deck starts Story generation after only the foreground delta and prompt install.
- The run journal proves no local Rapid fallback cards or local Rapid briefs were used.
- A swipe between warm and send invalidates the stale warm artifact.
- A slow foreground Utility call shows Rapid budget miss instead of silently installing fake guidance.
