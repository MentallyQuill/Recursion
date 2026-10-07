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
| `src/providers/profile-request-queue.mjs` | Abort-aware FIFO dispatch keyed by profile id, bounded by current verified concurrency. |
| `src/providers/stage-output-budgets.mjs` | Role-specific output budgets and retry floors. |
| `src/providers/provider-response-normalizer.mjs` | Canonical response envelope. |
| `src/providers/structured-output-parser.mjs` | Bounded JSON extraction and recovery. |
| `src/providers/provider-errors.mjs` | Safe provider error taxonomy. |
| `src/providers/profile-certification.mjs` | Bounded profile compatibility and concurrency checks bound to live identity. |
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

The host adapter builds messages from either a request message array or the request's system/user prompt pair. Production requests default to the provider lane output ceiling. An explicit per-request response allowance is capped at that ceiling; certification probes can request smaller allowances. Utility requests explicitly disable reasoning, overriding role hints and inherited preset flags. Reasoner preserves its supplied reasoning intent. NanoGPT uses SillyTavern's `min` value, which the host maps to provider effort `none`; OpenRouter receives `minimal` for minimal reasoning and `none` when reasoning is disabled. Supported OpenAI models receive `none` when reasoning is disabled. Other models retain the host-supported minimum and report `reasoningDowngraded`; all chat calls requesting off also set `include_reasoning: false`. Hiding reasoning output alone is not evidence that reasoning computation stopped. Provider/model support must be verified by qualification and returned usage; a forced-thinking model may still reason. Utility qualification hashes include this policy so prior reasoning-enabled qualifications cannot be reused.

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
- Provider `auto` uses the method certified for matching settings and live profile identity, defaulting conservatively to Prompt JSON. Only Auto may downgrade an unsupported native attempt within budget; explicit Native Schema stops with a compatibility explanation.

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

- effective concurrency remains one until current qualification verifies a higher configured limit, at most three;
- queued operations preserve FIFO order;
- abort before start rejects and removes that entry;
- abort during execution propagates through the request signal;
- settlement starts the next non-aborted entry;
- an exception cannot deadlock the queue.

Different profile ids have independent queues. Utility and Reasoner selecting the same profile share its most conservative matching qualification. Stale or failed qualification restores one; queued calls do not launch hidden qualification probes.

## Stage Output Budgets

`outputBudgetForRequest()` uses the lane output ceiling as the default production allowance and hard upper bound, default 8192. An explicit per-request allowance can be smaller. `minimumOutputBudgetForRole()` defines safe floors for context-limit reductions.

Key properties:

- provider connectivity uses a very small response budget;
- production card, Arbiter, composer, Fused, and editorial calls inherit the lane ceiling unless their request supplies a smaller allowance;
- certification single-card and representative Fused checks request smaller bounded allowances;
- retry floors prevent reduction to unusable values.

`reduceOutputBudgetForContextLimit()` mutates only `responseLength`. It does not modify policy or profile settings.

## Certification

`certifyConnectionProfile()` receives a frozen provider settings snapshot, a safe profile record, and a generation callback.

Checks run in this order:

1. `providerTest`, 128 tokens.
2. `sceneFrameCard`, 900 tokens.
3. `fusedCardBundle`, bounded representative budget.
4. Observed concurrency when a higher configured limit is requested.

With structured-output policy `auto`, a native-schema incompatibility on the single-card check can trigger one prompt-JSON check. Other failures do not silently change the method.

Results:

- connectivity failure: `fail`;
- single-card failure: `fail`;
- single-card pass plus Fused failure: `partial`;
- all pass: `pass`.

The result binds to Recursion `configHash` and live `profileIdentityHash`; saving also checks the frozen configuration revision. The profile hash uses only ID, model, API, completion mode, preset, and instruct identity, excluding names, endpoints, and secrets. Same-ID profile drift makes saved qualification untested and prevents stale Auto native/concurrency use. Drift during a test prevents saving its result.

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

The shared structured parser:

1. accepts a direct object;
2. parses tool/function arguments;
3. parses visible text;
4. unwraps a one-object array;
5. scans strings, complete top-level objects, and duplicate keys before selecting a candidate;
6. applies local repair to complete candidates;
7. returns the candidate accepted by the expected role validator.

Duplicate same-object keys, including escaped spellings, and competing top-level objects are rejected as ambiguous. Quoted braces and punctuation remain inside their strings. Parsing is bounded to 262,144 characters, depth 64, and 40 complete bundle items. It does not close an unfinished card or invent missing fields. Every candidate passes the canonical role schema and semantic validation. Field issues contain only fixed rules/messages and schema-owned paths, with at most eight issues and paths capped at 160 characters. Invalid candidates are not copied into errors or diagnostics.

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

The scheduler applies one directive per attempt and checkpoints only the allowlisted action code. A corrected-output attempt rebuilds the original messages/prompts with bounded role-owned field feedback; rejected output and prior feedback are not accumulated. Model attempts default to two including the initial call. Rate-limit retries have a separate bound of eight and retryable transient retries a bound of three; the operation allowance can stop extra calls earlier. Request deadline defaults to 180 seconds and active operation deadline to 300 seconds, including queue/cooldown waits. Configuration and abort failures stop immediately. Resume preserves the active recovery budget; deliberate Retry/Reprocess opens a new window without bypassing inherited cooldown.

## Independent Card Target

Play persists one `cardsPerTurn` target, default 6, range 0..20. Low/Medium/High/Ultra and Fused/Segmented share that count; reasoning routes and Guidance strength/detail do not change it. Internal `plan.budgets.maxCards` remains a derived budget. Auto reserves Priority and Refinement before discretionary work. Manual reserves Refinement, then projects ordinary authored cards and generated family units in deck order into remaining slots without rewriting saved scope/states. Authored units count separately; sources sharing one generated family share its unit. Mandatory coverage may exceed the target.

## Pipeline Selection

`resolveEffectivePipelineMode()` honors the requested mode and records selected-lane capability for diagnostics.

- Segmented always stays Segmented.
- Explicit Fused stays Fused without a certification requirement.
- `fusedEligible` indicates complete route configuration; tests remain diagnostic.
- Runtime bundle validation and repair can still fall back to Segmented.

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

Complete items from eligible JSON parse/object/ambiguity, payload shape, or completion-token failures may be salvaged transiently. They pass the same normalization, duplicate-family, requested-family, source-coverage, instruction, and evidence checks as successful items. Missing or out-of-window evidence is rejected rather than replaced with the latest message. Validated siblings checkpoint before Segmented stages for `unresolvedFamilies` and are not regenerated by that repair wave.

If none survives bounded output recovery, the scheduler settles bundle exhaustion once and creates full Segmented fallback. Token/context capacity exhaustion may also narrow to individual families. Authentication, configuration, refusal/filter, cancellation, transient transport, stale-source, storage, and operation-budget failures do not authorize equivalent salvage/fallback calls. Required selected Scene Constraints, Manual, Priority, Refinement, and authored coverage blocks installation when unresolved; optional generated exhaustion can finish with amber omissions and a smaller validated hand.

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
- same-profile FIFO dispatch and effective verified concurrency.

Live validation should use:

1. A local text-completion profile with an instruct template and prompt JSON.
2. A chat-completion profile without native schema support.
3. A chat-completion profile with native schema support.
4. The same profile selected for Utility and Reasoner to confirm FIFO dispatch and the most conservative current verified concurrency limit.
