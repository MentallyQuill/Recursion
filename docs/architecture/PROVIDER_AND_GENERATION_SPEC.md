# Provider and Generation Spec

## Purpose

This spec defines how Recursion selects providers, runs generation jobs, validates structured outputs, and records diagnostics for the SillyTavern extension.

Recursion borrows the Directive-style two-lane provider model, but keeps the surface smaller: Utility is the default worker for fast structured jobs, and Reasoner is an optional synthesis pass for difficult prompt-composition cases. Recursion is pre-alpha, so implementations should update old or provisional code in place to match this contract rather than preserve incompatible legacy behavior.

Related documents:

- [Product Scope](../design/RECURSION_PRODUCT_SCOPE.md)
- [Runtime Architecture](RUNTIME_ARCHITECTURE.md)
- [Card System Spec](../design/CARD_SYSTEM_SPEC.md)
- [Prompt Composition Spec](PROMPT_COMPOSITION_SPEC.md)
- [Storage and Diagnostics](STORAGE_AND_DIAGNOSTICS.md)
- [UI Spec](../design/UI_SPEC.md)

## Provider Lanes

Recursion has two provider lanes.

| Lane | Default use | Expected behavior | User-facing posture |
| --- | --- | --- | --- |
| Utility | Arbiter, scene/card extraction, card generation, lifecycle support, structured diagnostics | Fast, cheap, bounded, JSON-first, tolerant of being batched | Always configured, always the default |
| Reasoner | Optional composition/fusion of crowded, ambiguous, or conflicted card hands | Slower, smarter, synthesis-oriented, still evidence-bound | Off or conservative by default |

Utility is the operational backbone. It should handle the initial Arbiter call and normal card generation without needing a Reasoner handoff.

Reasoner is not a better default Utility. It is a narrow composer lane used when Recursion already has structured Utility outputs and needs a sharper compact brief from a crowded or conflicted hand. Reasoner must not create new lore, hidden motives, durable canon, or private chain-of-thought artifacts.

## Provider Settings Contract

Each lane stores one provider settings object. The settings shape should remain small enough to map directly to the provider cards described in [UI Spec](../design/UI_SPEC.md).

```ts
type RecursionProviderLane = "utility" | "reasoner";

type RecursionProviderSource =
  | "host-current-model"
  | "host-connection-profile"
  | "openai-compatible";

type RecursionProviderSettings = {
  lane: RecursionProviderLane;
  enabled: boolean;
  source: RecursionProviderSource;
  hostConnectionProfileId?: string;
  openAICompatible?: {
    baseUrl: string;
    model: string;
    sessionApiKeyPresent: boolean;
  };
  temperature: number;
  topP: number;
  maxTokens: number;
  resolvedProviderLabel?: string;
  resolvedModelLabel?: string;
  lastTest?: {
    status: "pass" | "fail" | "not-run";
    checkedAt?: string;
    compactError?: string;
  };
};
```

Source options:

- `host-current-model`: use the model currently active in SillyTavern.
- `host-connection-profile`: use a named SillyTavern connection profile.
- `openai-compatible`: use a direct OpenAI-compatible endpoint with base URL, model, session API key, temperature, top-p, and max token controls.

Utility must always have an enabled settings object. If Utility is misconfigured or unhealthy, Recursion degrades to cached/local behavior and does not block the user's normal SillyTavern generation.

Reasoner may be disabled. Disabled Reasoner means all auto decisions must resolve to Utility-only composition, even when the Arbiter reports conflict or crowding.

## Session Secret Boundary

OpenAI-compatible API keys are session-only secrets.

The implementation must not persist API keys in:

- extension settings;
- scene cache;
- card cache;
- prompt plan cache;
- prompt packets;
- model-call journal entries;
- diagnostics exports;
- browser local storage or SillyTavern file storage.

Persisted settings may record only `sessionApiKeyPresent: true | false` so the UI can show that the current browser session has a key loaded. Clearing a session key must remove it from memory and immediately mark the lane untestable until a key is re-entered.

Provider requests may receive the key through an in-memory provider runtime object. The key must not be copied into request hashes, error text, telemetry payloads, or thrown exceptions.

## Generation Roles

Generation roles describe why a model call exists. They are not the same thing as provider lanes. Each role declares its default lane, output schema, and failure behavior.

| Role | Default lane | Purpose | Failure behavior |
| --- | --- | --- | --- |
| `utilityArbiter` | Utility | Decide whether Recursion should skip, reuse cache, refresh cards, compose a brief, and optionally invoke Reasoner | Conservative local fallback: reuse valid cache or skip Recursion injection |
| `sceneFrameCard` | Utility | Produce compact current-scene frame data | Omit card with diagnostic |
| `continuityRiskCard` | Utility | Identify likely contradictions or fragile facts for the next generation | Omit card with diagnostic |
| `characterLensCard` | Utility | Capture visible posture, relationship tension, and voice cues for active characters | Omit card with diagnostic |
| `environmentTextureCard` | Utility | Capture sensory, spatial, and staging constraints | Omit card with diagnostic |
| `openThreadsCard` | Utility | Capture immediate unresolved pressures and promises visible in play | Omit card with diagnostic |
| `briefUtilityComposer` | Utility | Compose the normal compact prompt brief from accepted cards and budgets | Compose from available cards; omit invalid cards |
| `reasonerComposer` | Reasoner | Fuse crowded or conflicted card hands into a compact instruction patch | Fall back to Utility-only composition |
| `providerTest` | Selected lane | Validate lane connectivity and structured response capability | Mark lane test failed with compact error |

Card names should align with [Card System Spec](../design/CARD_SYSTEM_SPEC.md). Prompt installation and depth decisions belong to [Prompt Composition Spec](PROMPT_COMPOSITION_SPEC.md), not provider routing.

## Utility Arbiter Call

The Utility Arbiter is the first model call when Recursion needs model help for a turn. Its job is to make the run plan, not to write prose.

Inputs:

- one immutable runtime snapshot;
- snapshot hash;
- current chat/message fingerprint;
- current settings hash;
- known scene cache metadata;
- available card types and token budgets;
- Reasoner enabled/disabled state and health summary.

The Arbiter should return every auto decision it can in the initial call. Recursion should not spend a separate model call just to decide whether to use Reasoner unless a later version has a concrete, measured reason to do so.

Required output shape:

```json
{
  "schema": "recursion.utilityArbiter.v1",
  "snapshotHash": "string",
  "action": "skip | reuse-cache | refresh-cards | compose-brief",
  "sceneStatus": "same-scene | soft-shift | hard-shift | unknown",
  "cardJobs": [
    {
      "role": "sceneFrameCard",
      "priority": 0.94,
      "reason": "string"
    }
  ],
  "reasonerDecision": {
    "mode": "skip | use",
    "reason": "string",
    "signals": ["crowded-hand", "conflicting-cards"]
  },
  "budgets": {
    "targetBriefTokens": 450,
    "maxCards": 6
  },
  "diagnostics": ["string"]
}
```

The Arbiter is allowed to choose `reasonerDecision.mode: "use"` only when Reasoner is enabled and healthy. If Reasoner is disabled, unhealthy, or missing a provider secret, the Arbiter must select `skip` and explain the reason compactly.

## Batched Card Calls

Utility card calls should run from one snapshot. The batch boundary is part of the correctness contract: all card jobs in a run must see the same chat state, settings hash, scene cache metadata, and prompt budget.

The preferred execution shape is:

1. Arbiter returns a `cardJobs` list.
2. Runtime freezes a `snapshotHash`.
3. Utility card jobs are submitted as one batch when the host/provider supports batching.
4. If batching is unavailable, jobs may run sequentially, but they must still use the same frozen snapshot and shared run id.
5. Each card returns structured JSON with its own schema id and compact evidence references.
6. Runtime validates and accepts, repairs locally where safe, or omits each card independently.

Card calls must not depend on sibling card outputs from the same batch. Fusion happens later in the Utility composer or Reasoner composer.

Common card output envelope:

```json
{
  "schema": "recursion.card.v1",
  "role": "sceneFrameCard",
  "snapshotHash": "string",
  "items": [
    {
      "id": "string",
      "text": "string",
      "evidence": ["message:42"],
      "confidence": 0.87,
      "tokenCost": 18
    }
  ],
  "warnings": ["string"]
}
```

Cards should be concise, observable, and player-message-adjacent. They must not include hidden character thoughts, private chain-of-thought, or broad plot plans.

## Reasoner Composer Call

The Reasoner Composer receives accepted Utility cards, budget metadata, conflict markers, and the same snapshot hash. It returns a compact instruction patch for prompt composition.

Reasoner is appropriate when:

- accepted cards exceed the normal prompt budget;
- Utility cards conflict or overlap in a way bounded runtime validation cannot cleanly resolve;
- multiple active characters have tense or subtle visible posture that needs careful fusion;
- the Arbiter selected Reasoner in its initial response and the lane is enabled and healthy.

Reasoner is not appropriate when:

- the hand is small and non-conflicting;
- Utility produced invalid or insufficient card data;
- the user disabled Reasoner;
- the Reasoner lane is missing a provider secret or failed its last connectivity test.

Required output shape:

```json
{
  "schema": "recursion.reasonerComposer.v1",
  "snapshotHash": "string",
  "instructionPatch": "string",
  "keptCardIds": ["string"],
  "droppedCardIds": [
    {
      "id": "string",
      "reason": "duplicate | lower-priority | budget-exceeded | unsupported"
    }
  ],
  "conflictResolutions": [
    {
      "summary": "string",
      "basis": ["message:42", "card:continuity-risk-1"]
    }
  ],
  "warnings": ["string"]
}
```

Reasoner output is advisory to prompt composition. It does not write durable cards, mutate scene state directly, or override explicit source evidence.

## Auto Lane Selection

Auto lane selection follows this order:

1. Local runtime checks decide whether Recursion is disabled, no-op, or able to reuse cache.
2. Utility Arbiter decides the run action, card jobs, and Reasoner use where possible.
3. Utility card calls generate the structured hand.
4. Runtime validation accepts or omits cards, while the Utility Arbiter owns semantic hand selection.
5. Reasoner runs only if the Arbiter selected it, the lane is enabled, the lane is healthy, and accepted card data is sufficient.
6. Prompt composition installs the Utility-only or Reasoner-assisted brief.

Auto must be Utility-first. Enabling Reasoner only makes Reasoner eligible; it must not cause every run to use Reasoner.

Advanced job routing may expose `Default`, `Utility Provider`, and `Reasoner Provider` for internal roles, but v1 should keep that surface secondary to the main Utility and Reasoner provider cards.

## Structured Output and Validation

All provider-owned Recursion jobs must request structured JSON and validate before use.

Validation requirements:

- parse JSON, including safe recovery from fenced JSON wrappers when needed;
- verify `schema`, `role`, `snapshotHash`, enum values, string lengths, numeric ranges, and required arrays;
- reject outputs that include raw hidden reasoning, chain-of-thought, private motives, or unsupported durable lore;
- reject outputs that cite evidence outside the frozen snapshot;
- clamp confidence and token estimates to valid ranges;
- mark each accepted card or composer patch with schema version and source role.

Invalid Utility Arbiter output should fall back to conservative local behavior: reuse valid cache or skip Recursion injection for the turn.

Invalid card output should omit only that card. One bad card must not poison the whole batch.

Invalid Reasoner output should fall back to Utility-only composition.

Prompt composition should consume only accepted structured data. It should not parse useful facts from rejected raw provider text.

## Telemetry/Model Call Journal

Recursion keeps a sanitized model-call journal for diagnostics and UI status. The journal is bounded, compact, and safe to persist as described in [Storage and Diagnostics](STORAGE_AND_DIAGNOSTICS.md).

Journal entries may include:

- timestamp;
- run id and optional batch id;
- role;
- lane;
- source type;
- provider label;
- model label;
- status: `success`, `validation-failed`, `provider-failed`, `aborted`, `skipped`;
- latency in milliseconds;
- snapshot hash;
- request hash;
- response hash;
- schema id;
- retry count;
- compact error code and compact error message.

Journal entries must not include:

- raw prompts;
- raw provider responses;
- API keys or bearer tokens;
- full SillyTavern messages;
- full prompt packets;
- private chain-of-thought;
- user-authored text except through hashes or short non-reversible labels.

The Inspector may show the latest calls and validation status, but raw prompt/response capture is out of scope by default.

## Provider Failure Behavior

Provider failures must degrade Recursion, not the chat.

Utility failure:

- do not block normal SillyTavern generation;
- reuse a still-valid installed prompt packet only if its snapshot/settings hashes match;
- otherwise clear or skip Recursion injection for the turn;
- record a sanitized journal entry and visible lane status.

Card failure:

- accept valid sibling cards;
- omit failed cards with omission reasons;
- continue composition if enough accepted cards remain.

Reasoner failure:

- fall back to Utility-only composition;
- do not retry with Utility as a second hidden composer unless the Utility composer was already part of the normal plan;
- record a compact reason such as auth failure, timeout, validation failure, or provider error.

OpenAI-compatible authentication failure:

- mark the lane unhealthy for the current session;
- preserve non-secret settings;
- keep the API key out of error messages;
- require the user to re-enter or clear the session key before another direct-endpoint test.

Timeouts and aborts:

- provider calls must receive an abort signal from the runtime;
- user disable, chat change, settings change, and host generation stop should abort in-flight Recursion calls when their output would be stale;
- aborted calls should not install prompt packets.

## V1 Cuts

V1 intentionally excludes:

- persisted API keys;
- raw prompt or raw response logging by default;
- arbitrary user-authored prompt-call chains;
- a Directive-sized role-routing matrix;
- Reasoner as a default always-on lane;
- separate model calls just to decide whether Reasoner should run;
- multi-provider racing or quorum voting;
- durable lore, vector recall, transcript summarization, or character database ownership;
- hidden-thought storage on chat messages;
- automatic migration support for incompatible pre-alpha provider settings;
- accepting unstructured prose as a successful generation-role result.

Because Recursion is pre-alpha, incompatible provisional code should be replaced in place with this v1 contract. The implementation should favor one clear provider/runtime path over compatibility shims.
