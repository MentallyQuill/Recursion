# Provider And Generation Spec

This document is the normative architecture for Recursion model calls. It applies to Utility, Reasoner, provider certification, Segmented card generation, Fused card generation, and model-backed Enhancement stages.

Related documents:

- [Model Calls And Provider Routing](../technical/MODEL_CALLS_AND_PROVIDER_ROUTING.md)
- [Provider Setup](../user/PROVIDER_SETUP.md)
- [Prompt Privacy And Safety](../user/PROMPT_PRIVACY_AND_SAFETY.md)
- [Storage And Diagnostics](../technical/STORAGE_AND_DIAGNOSTICS.md)

## Product Boundary

Recursion uses SillyTavern Connection Profiles for every Utility and Reasoner model call.

Recursion does not own:

- provider endpoints;
- credentials or authorization headers;
- model discovery;
- provider-specific transport configuration;
- the primary roleplay generation route;
- the currently selected chat model as an implicit fallback.

SillyTavern owns those concerns. Recursion stores only a selected Connection Profile id and generation policy for each lane.

A model stage cannot run unless its lane references a Connection Profile that SillyTavern exposes through the supported Connection Manager API. Missing or unsupported profile access is a configuration failure, not a retryable model failure.

## Provider Lanes

| Lane | Required | Typical work |
| --- | --- | --- |
| Utility | Yes | Arbiter planning, ordinary card stages, validation support, standard guidance, provider certification, and fail-soft fallback. |
| Reasoner | No | Policy-selected synthesis, high-priority cards, Fused bundles, and difficult editorial work. |

Reasoner is not a replacement Utility. It must not create durable lore, hidden motives, private chain-of-thought artifacts, or detached story output.

## Settings Contract

Each lane uses the following normalized shape:

```ts
type GenerationPolicy = {
  presetMode: "isolated" | "full-profile";
  instructMode: "auto" | "on" | "off";
  samplerMode: "profile" | "recursion";
  structuredOutputMode: "auto" | "native-schema" | "prompt-json";
};

type ProviderCertification = {
  status: "not-run" | "pass" | "partial" | "fail";
  configHash?: string;
  checkedAt?: string;
  completionMode?: "chat" | "text" | "unknown";
  structuredOutput?: "native-schema" | "prompt-json" | "unknown";
  checks?: {
    connectivity: "not-run" | "pass" | "fail";
    singleCard: "not-run" | "pass" | "fail";
    fusedCards: "not-run" | "pass" | "fail";
  };
  safeConcurrency?: 1;
  diagnosticCodes?: string[];
  compactError?: string;
};

type ProviderSettings = {
  lane: "utility" | "reasoner";
  connectionProfileId: string;
  generationPolicy: GenerationPolicy;
  samplerOverrides: {
    temperature: number;
    topP: number;
  };
  outputTokenCeiling: number;
  configRevision: number;
  certification: ProviderCertification;
};
```

Normalization is allowlist-based. Unknown fields are discarded. A material profile or policy change increments `configRevision` and resets certification to `not-run`. A certification write can change certification fields only and is accepted only when its configuration hash and revision still match.

The default policy is:

```json
{
  "presetMode": "isolated",
  "instructMode": "auto",
  "samplerMode": "profile",
  "structuredOutputMode": "auto"
}
```

## Independent Generation Policies

The generation policies are intentionally independent. No single Boolean controls prompt isolation, instruct formatting, samplers, and structured output.

### Behavioral Preset

`isolated` excludes the complete profile preset from Recursion analysis prompts.

`full-profile` imports the complete profile preset. It is an advanced opt-in because behavioral instructions, prose requirements, roleplay framing, or wrappers can invalidate structured responses.

### Instruct Formatting

`auto` enables instruct formatting for text-completion profiles and disables it for chat-completion profiles.

`on` always requests the profile instruct template. `off` suppresses it.

This permits local text-completion models to retain ChatML, Alpaca, or another framing template while the full behavioral preset remains isolated.

### Samplers

`profile` asks SillyTavern to materialize the selected generation preset and projects only allowlisted sampler fields.

The allowlist includes common temperature, top-p/top-k/min-p, repetition, dynamic temperature, Mirostat, DRY, XTC, seed, beam, and sampler-order controls. It excludes:

- messages and prompts;
- model or route selection;
- endpoint data and credentials;
- stop strings;
- reasoning controls;
- token-limit fields.

When sampler projection fails, Recursion uses its lane temperature and top-p overrides and records `profile-sampler-projection-failed`. It does not import the complete preset as a fallback.

`recursion` uses the lane overrides directly.

### Structured Output

`auto` uses the structured-output method established by current profile certification.

`native-schema` explicitly requests native schema support. `prompt-json` relies on the prompt contract and Recursion's parser.

An unsupported native-schema response may downgrade to prompt JSON only when the current attempt directive allows that single change. Downgrade state is recorded as a fixed code, not raw provider text.

## Request Flow

```text
Utility/Reasoner stage
  -> selected Connection Profile
  -> generation policy resolver
  -> profile FIFO queue
  -> ConnectionManagerRequestService.sendRequest
  -> canonical response envelope
  -> structured-output parser
  -> role validator
  -> failure classifier and attempt directive
  -> durable checkpoint or explicit fallback artifact
```

The Connection Manager call uses the following behavioral contract:

```js
service.sendRequest(
  connectionProfileId,
  messages,
  maxTokens,
  {
    stream: false,
    signal,
    extractData: false,
    includePreset,
    includeInstruct
  },
  overridePayload
);
```

`extractData: false` is mandatory. Recursion receives the raw provider envelope so it can normalize visible content, recover bounded JSON candidates, validate role-specific contracts, and classify failures consistently. A host-side empty-object substitution is never accepted as successful structured output.

## Completion Mode

The profile adapter accepts only completion modes it can identify through SillyTavern's validated profile mapping:

- chat completion;
- text completion.

Unknown profile mappings are unsupported. The adapter does not silently redirect to another model route.

## Traffic Control

Every Connection Profile has an abort-aware FIFO queue with physical concurrency one.

Consequences:

- Segmented sibling stages can remain logically independent and checkpointable while their model calls execute one at a time on the same profile.
- Utility and Reasoner may overlap only when they use different profiles.
- An aborted queued request is removed before execution.
- An active request receives the runtime abort signal.
- A queue failure cannot strand later entries.

The queue boundary exists below all pipeline paths, so certification, Pre-process, Enhancement, and repair calls obey the same traffic policy.

## Output Budgets

The provider lane's `outputTokenCeiling` is a hard maximum, not the default for every request. Each role receives a smaller stage budget.

Representative budgets:

| Stage | Initial budget |
| --- | ---: |
| Connectivity certification | 128 |
| Single card | 900 |
| Utility Arbiter | 1,200 |
| Guidance Composer | 1,600 |
| Reasoner Composer | 1,800 |
| Fused bundle | Scales with requested family count and remains capped |
| Editorial stages | Derived from the specific editorial contract and lane ceiling |

A context-limit directive reduces only the current stage's output allowance, normally by 25 percent and never below its role floor. It does not also change samplers, prompt policy, profile, or structured-output method.

## Staged Profile Certification

`Test Profile` performs three checks:

1. Small connectivity JSON.
2. Representative compact single-card JSON.
3. Representative two-family Fused JSON.

Certification never stores the prompt, raw response, provider exception, profile object, endpoint data, or credentials.

Capability states are:

| State | Meaning |
| --- | --- |
| `unconfigured` | No selected available profile. |
| `uncertified` | Profile is configured but no current certification matches its configuration. |
| `segmented-ready` | Connectivity and single-card checks passed; Fused did not pass. |
| `fused-ready` | All three checks passed. |
| `unhealthy` | Connectivity or single-card compatibility failed. |

An uncertified configured profile can run Segmented with a visible caution. A partial certification is useful and enables Segmented. Fused is physically dispatched only for `fused-ready`.

Certification is single-flight per lane. A certification request does not cancel active production work. When the lane is busy, the test returns a stable busy result.

## Requested And Effective Pipeline Mode

The user's requested pipeline and the runtime's effective pipeline are distinct.

```ts
type PipelineDecision = {
  requestedMode: "segmented" | "fused";
  effectiveMode: "segmented" | "fused";
  reasonCode: "" | "profile-not-fused-certified";
};
```

Rules:

- A requested Segmented run remains Segmented.
- A requested Fused run remains Fused only when Utility is Fused-eligible under the current lane policy.
- Otherwise, it becomes Segmented before a Fused provider request is sent.
- The downgrade is shown once and stored as a fixed safe code.

## Compact Card Contracts

The model returns model-owned content only. Recursion attaches request-owned identity after validation.

Single-card response:

```json
{
  "promptText": "Track the immediate objective and obstruction.",
  "evidenceRefs": ["message:12"]
}
```

Fused response:

```json
{
  "items": [
    {
      "family": "Scene Frame",
      "promptText": "Track the immediate objective and obstruction.",
      "evidenceRefs": ["message:12"],
      "coveredSourceCardIds": []
    }
  ]
}
```

Recursion attaches:

- schema id;
- frozen snapshot hash;
- role id;
- normalized family;
- card id and provenance;
- detail profile and emphasis;
- source-card identity;
- token estimate.

A provider must not be required to echo values Recursion already knows. Returned identity fields, when present in a supported envelope, may be used only if they agree with the frozen request.

## Canonical Response Envelope

All profile responses are normalized before parsing.

The canonical envelope may contain:

- visible content;
- a direct structured value;
- reasoning-present Boolean, never reasoning text;
- finish reason;
- bounded usage;
- model label;
- provider label;
- response-shape classification.

Supported source shapes include:

- chat message content;
- text-completion text;
- direct structured objects;
- parsed message objects;
- tool-call function arguments;
- legacy function-call arguments;
- supported response-output arrays;
- singleton arrays containing one object.

Raw provider responses are not retained in the canonical diagnostics object.

## Structured Parsing And Recovery

The bounded parser sequence is:

1. Direct structured object.
2. Tool or function arguments.
3. Visible response content.
4. Singleton-array unwrap.
5. Balanced-object candidates.
6. Common local JSON repair.
7. Role schema and semantic validation.

The parser continues after a wrong top-level candidate instead of treating the first parseable value as authoritative. When multiple candidates exist, the expected role contract determines which candidate is usable.

Parser and validation errors contain stable codes, bounded lengths, and structural metadata only. They do not contain response excerpts.

## Failure Classification And Attempt Directives

Each failed attempt receives one action.

| Failure class | Directive |
| --- | --- |
| Native schema unsupported | Downgrade structured output to prompt JSON. |
| Context limit | Reduce only the stage output budget. |
| Invalid structured or semantic output | Send one bounded correction prompt when the role allows it. |
| 429, timeout, or transient transport failure | Retry with bounded delay. |
| Missing profile, unsupported host API, or configuration mismatch | Stop without retry. |
| Abort | Stop immediately and do not start queued work. |

One retry never combines schema downgrade, budget reduction, sampler changes, and prompt changes. The scheduler records only allowlisted action and diagnostic codes.

Automatic attempts apply only to Recursion model stages. They do not retry SillyTavern's primary story generation.

## Partial Fused Recovery

Fused validation is item-scoped.

- Valid requested items are accepted and checkpointed.
- Duplicate, unrequested, or invalid items are rejected independently.
- Accepted families and unresolved families are explicit artifact fields.
- When at least one item is useful, only unresolved families receive Segmented repair stages.
- Accepted Fused cards are not regenerated.
- When no useful item survives and attempts are exhausted, the scheduler invokes the stage's explicit exhaustion settlement hook once and starts the full Segmented path.

The exhaustion hook may settle an artifact but may not launch provider calls or mutate the graph directly.

## Reasoning-Level Routing

| Level | Arbiter | Cards | Guidance |
| --- | --- | --- | --- |
| Low | Utility | Utility | Utility |
| Medium | Utility | Utility | Reasoner when eligible |
| High | Reasoner when eligible | Reasoner for priority families, Utility otherwise | Reasoner when eligible |
| Ultra | Reasoner when eligible | Reasoner-heavy | Reasoner when eligible |

Ordinary Pre-process work falls back to Utility when Reasoner is unavailable. Post-process contracts that explicitly require Reasoner remain lane-sticky and fail soft rather than silently crossing lanes.

## Durable State And Diagnostics

A stage checkpoint may retain:

- stage id and version;
- state and attempt counters;
- output hash and artifact reference;
- allowlisted diagnostic codes;
- one allowlisted last-attempt action;
- bounded timestamps and size metadata.

It must not retain:

- raw profile ids;
- endpoints or credentials;
- prompts or raw responses;
- hidden reasoning;
- transcript bodies;
- provider exceptions or stack traces.

Safe provider diagnostics may include a non-reversible bounded profile hash, completion mode, structured-output method, sampler source, preset/instruct Booleans, stage budget, finish reason, bounded usage, and fixed codes.

## Operator Rules

1. Create one or two SillyTavern Connection Profiles.
2. Select a profile for Utility and Reasoner.
3. Keep Behavioral Preset on Isolated unless the complete profile preset is intentionally trusted.
4. Keep Instruct Formatting on Auto for text-completion compatibility.
5. Keep Samplers on Connection Profile to inherit sampler settings without importing prompt fields.
6. Run Test Profile. Segmented may run after a single-card pass; Fused requires a Fused-card pass.
7. Uncertified or partially certified Fused requests automatically use Segmented.

## Non-Goals

The provider layer does not implement:

- endpoint or credential ownership;
- model discovery;
- provider-specific direct HTTP requests;
- hidden fallback to the current chat model;
- detached primary story generation;
- persistence of raw prompts, outputs, or reasoning;
- arbitrary user-authored provider chains;
- unbounded concurrency.
