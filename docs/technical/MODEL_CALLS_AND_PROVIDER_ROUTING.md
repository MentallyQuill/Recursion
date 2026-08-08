# Model Calls And Provider Routing

This document describes the implementation of the profile-only provider boundary. The normative architecture is [Provider And Generation Spec](../architecture/PROVIDER_AND_GENERATION_SPEC.md).

## Component Map

| Component | Responsibility |
| --- | --- |
| `src/settings.mjs` | Profile-only provider settings, revisions, and certification persistence. |
| `src/provider-capability.mjs` | Configuration, certification, Segmented eligibility, and Fused eligibility. |
| `src/providers/generation-policy.mjs` | Independent preset, instruct, sampler, and structured-output resolution. |
| `src/hosts/sillytavern/provider-profiles.mjs` | Supported Connection Manager capability check and safe profile listing. |
| `src/hosts/sillytavern/profile-samplers.mjs` | Allowlisted sampler projection from a profile preset. |
| `src/hosts/sillytavern/host.mjs` | One Connection Profile request path. |
| `src/providers/profile-request-queue.mjs` | Abort-aware FIFO serialization keyed by profile id. |
| `src/providers/stage-output-budgets.mjs` | Role-specific output budgets and retry floors. |
| `src/providers/provider-response-normalizer.mjs` | Canonical response envelope. |
| `src/providers/structured-output-parser.mjs` | Bounded JSON extraction and recovery. |
| `src/providers/provider-errors.mjs` | Safe provider error taxonomy. |
| `src/providers/profile-certification.mjs` | Three-stage profile certification. |
| `src/execution/attempt-policy.mjs` | One-action retry directives. |
| `src/execution/scheduler.mjs` | Attempts, checkpoints, queues, and exhaustion settlement. |
| `src/runtime/pipeline-policy.mjs` | Requested/effective pipeline selection. |
| `src/runtime/preprocess-graph.mjs` | Fused artifacts and unresolved-family repair contract. |
| `src/providers.mjs` | Role catalog, request enrichment, validation, and router facade. |
| `src/runtime.mjs` | Runtime orchestration, certification UI action, repair scheduling, and diagnostics. |

## Route Invariant

Every Utility or Reasoner request must resolve to a selected SillyTavern Connection Profile.

```text
stage
  -> provider settings snapshot
  -> capability check
  -> safe profile lookup
  -> generation policy
  -> profile queue
  -> Connection Manager
  -> canonical response
  -> parser and role validator
  -> attempt directive
  -> checkpoint
```

There is no alternate model route in the provider client. A missing Connection Manager method, missing profile, unsupported profile mapping, or empty profile id returns a stable non-retryable configuration failure.

## Safe Profile Listing

`listSillyTavernConnectionProfiles()` requires these Connection Manager methods:

```js
[
  'getSupportedProfiles',
  'getProfile',
  'validateProfile',
  'sendRequest'
]
```

Only supported chat- or text-completion profiles are exposed. The UI-safe profile record contains:

```ts
type SafeProfile = {
  id: string;
  name: string;
  model: string;
  label: string;
  api: string;
  completionMode: "chat" | "text";
  presetName: string;
  instructName: string;
};
```

Endpoint values, secret references, headers, and complete preset bodies are not returned.

## Request Construction

The host adapter builds messages from either a request message array or the request's system/user prompt pair. It calculates the effective max token value as the minimum of:

- the provider lane output ceiling;
- the role-specific response budget.

The Connection Manager call is:

```js
const raw = await service.sendRequest(
  profileId,
  messages,
  effectiveMaxTokens,
  {
    stream: false,
    signal: request.signal ?? null,
    extractData: false,
    includePreset: policy.includePreset,
    includeInstruct: policy.includeInstruct
  },
  overridePayload
);
```

The adapter never silently switches to another generation API.

## Generation Policy Resolution

`resolveGenerationPolicy()` receives:

```js
{
  provider,
  completionMode,
  request
}
```

It returns:

```js
{
  includePreset,
  includeInstruct,
  samplerMode,
  structuredOutputMethod
}
```

Resolution rules:

- `full-profile` sets `includePreset: true`; `isolated` sets it false.
- Instruct `auto` sets `includeInstruct: true` only for text completion.
- Request-level structured-output method, when present, takes precedence for a bounded retry.
- Otherwise explicit provider policy wins.
- Provider `auto` uses the certified method, defaulting conservatively to prompt JSON.

## Sampler Projection

When sampler mode is `profile` and the complete preset is isolated, the host adapter materializes the selected profile preset using SillyTavern's completion service and copies only `SAFE_PROFILE_SAMPLER_FIELDS`.

Examples of retained fields:

```text
temperature, top_p, top_k, min_p, typical_p,
repetition_penalty, frequency_penalty, presence_penalty,
mirostat_mode, dynatemp_range, dry_multiplier,
xtc_threshold, sampler_priority, seed
```

Anything not in the allowlist is dropped. In particular, the projection cannot copy prompts, messages, model routing, stop strings, token limits, reasoning controls, URLs, or credentials.

Projection failure produces Recursion temperature/top-p values and `profile-sampler-projection-failed`.

## Queue Semantics

`createProfileRequestQueue()` is keyed by profile id.

For each key:

- at most one operation is active;
- queued operations preserve FIFO order;
- abort before start rejects and removes that entry;
- abort during execution propagates through the request signal;
- settlement starts the next non-aborted entry;
- an exception cannot deadlock the queue.

Different profile ids have independent queues. This means the same local model route is protected even when Utility and Reasoner both select it.

## Stage Output Budgets

`stageOutputBudget()` maps roles and workload size to bounded values. The lane ceiling remains the hard upper bound.

Key properties:

- provider connectivity uses a very small response budget;
- one card is capped near one thousand tokens;
- Arbiter and composer roles have distinct budgets;
- Fused scales by requested family count but remains capped;
- editorial stages use contract-specific budgets;
- retry floors prevent reduction to unusable values.

`reduceOutputBudgetForContextLimit()` mutates only `responseLength`. It does not modify policy or profile settings.

## Certification

`certifyConnectionProfile()` receives a frozen provider settings snapshot, a safe profile record, and a generation callback.

Checks run in this order:

1. `providerTest`, 128 tokens.
2. `sceneFrameCard`, 900 tokens.
3. `fusedCardBundle`, bounded representative budget.

With structured-output policy `auto`, a native-schema incompatibility on the single-card check can trigger one prompt-JSON check. Other failures do not silently change the method.

Results:

- connectivity failure: `fail`;
- single-card failure: `fail`;
- single-card pass plus Fused failure: `partial`;
- all pass: `pass`.

The settings store binds the result to both `configHash` and `configRevision`. Stale completion cannot certify newer settings.

## Compact Card Validation

Single-card validators require only:

```js
{
  promptText: nonEmptyString,
  evidenceRefs: nonEmptyStringArray
}
```

Fused validators require:

```js
{
  items: [
    {
      family: requestedFamily,
      promptText: nonEmptyString,
      evidenceRefs: nonEmptyStringArray,
      coveredSourceCardIds?: string[]
    }
  ]
}
```

The runtime attaches schema and frozen request identity after validation. Conflicting returned identity is rejected; missing request-owned identity is not treated as model failure.

## Response Normalization

`normalizeProviderResponse()` extracts bounded metadata and one of:

- `structuredValue`;
- `visibleContent`.

It recognizes direct structured objects, chat/text fields, parsed message content, tool/function arguments, and supported output arrays. It records reasoning presence only as a Boolean. It does not retain reasoning text or a response sample.

## Parser Recovery

The structured parser:

1. accepts a direct object;
2. parses tool/function arguments;
3. parses visible text;
4. unwraps a one-object array;
5. scans balanced objects;
6. applies local repair to complete candidates;
7. returns the candidate accepted by the expected role validator.

A top-level array that is not directly usable does not prevent later object candidates from being examined. Invalid candidates are not copied into errors or diagnostics.

## Failure Taxonomy

Provider failures normalize to fixed categories such as:

```text
configuration
abort
rate-limit
transient-transport
timeout
context-limit
structured-output-unsupported
validation
provider
```

The normalized error contains a stable code, bounded safe message, retryable Boolean, and optional bounded metadata. Original provider bodies, URLs, headers, and stack traces are discarded.

## Attempt Policy

`attemptDirectiveForFailure()` produces one of:

```text
stop
retry-delay
downgrade-structured-output
reduce-output-budget
correct-output
```

The scheduler applies one directive per attempt and checkpoints only the allowlisted action code. A corrected-output attempt receives a role-owned correction prompt. A delayed retry remains bounded by the stage's attempt window. Configuration and abort failures stop immediately.

## Pipeline Selection

`resolveEffectivePipelineMode()` uses requested mode and current Utility capability.

- Segmented always stays Segmented.
- Fused stays Fused only when `fusedEligible` is true.
- Otherwise effective mode is Segmented with `profile-not-fused-certified`.

Runtime stores requested and effective mode separately in safe packet diagnostics.

## Fused Repair

A Fused artifact contains:

```ts
type FusedArtifact = {
  cards: Record<string, Card>;
  outcomes: Record<string, unknown>;
  acceptedFamilies: string[];
  unresolvedFamilies: string[];
  fallback: null | {
    mode: "segmented";
    reason: "unresolved-fused-families" | "zero-useful-fused-cards";
    families: string[];
  };
};
```

When some cards pass, runtime creates Segmented stages only for `unresolvedFamilies`. When none pass after attempts are exhausted, the scheduler invokes `settleExhausted()` exactly once and creates a full Segmented fallback artifact.

## Diagnostics Contract

Effective provider diagnostics may include:

```js
{
  profileHash,
  completionMode,
  effectivePolicy: {
    includePreset,
    includeInstruct,
    samplerSource,
    structuredOutputMethod
  },
  responseLength,
  finishReason,
  usage,
  diagnosticCodes
}
```

`profileHash` is bounded and non-reversible. Raw profile ids, prompts, outputs, endpoints, credentials, authorization headers, and hidden reasoning are prohibited.

Execution checkpoints and progress views accept only allowlisted diagnostic and attempt-action codes. Arbitrary provider strings cannot enter durable or user-visible state.

## Verification Matrix

Offline fixtures cover:

- chat content;
- text completion;
- direct structured objects;
- parsed objects;
- tool and function arguments;
- singleton arrays;
- malformed and truncated JSON;
- reasoning-only responses;
- empty-object responses;
- native-schema rejection;
- context-limit failure;
- transient transport failure;
- abort;
- partial Fused output;
- same-profile serialization.

Live validation should use:

1. A local text-completion profile with an instruct template and prompt JSON.
2. A chat-completion profile without native schema support.
3. A chat-completion profile with native schema support.
4. The same profile selected for Utility and Reasoner to confirm FIFO serialization.
